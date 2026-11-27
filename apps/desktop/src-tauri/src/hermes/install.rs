//! Optional Hermes runtime installer.
//!
//! The app no longer bundles the ~330 MB runtime. A release build points
//! `HERMES_RUNTIME_URL` at the pinned tarball (or the default CDN path);
//! development can point `HERMES_RUNTIME_SOURCE` at the prepared directory
//! or tarball. Everything is installed under the single OpenNavoData root.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use super::{
    AppError, HermesRuntimeState, HermesRuntimeStatus, RuntimePluginPin, data_root, hermes_home,
    panel_sessions_forget, runtime_manifest, runtime_root, status, stop_local, verify_runtime_bin,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesInstallProgress {
    pub phase: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: u8,
}

#[derive(Debug)]
struct PluginUpdate {
    target: PathBuf,
    staged: PathBuf,
    backup: PathBuf,
    had_previous: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PluginCatalogState {
    Current,
    Stale,
    Unmanaged,
}

#[derive(Debug)]
struct ActivatedRuntime {
    runtime: PathBuf,
    backup: PathBuf,
    had_previous: bool,
    stale: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RollbackOutcome {
    Restored,
    Removed,
    NotRestored,
}

impl ActivatedRuntime {
    fn commit(&self) {
        let _ = std::fs::remove_dir_all(&self.backup);
        for path in &self.stale {
            let _ = std::fs::remove_dir_all(path);
        }
        cleanup_preserved_runtimes(&self.runtime);
        cleanup_preserved_runtimes(&self.backup);
    }

    fn rollback(&self) -> Result<RollbackOutcome, AppError> {
        if self.runtime.exists() {
            std::fs::remove_dir_all(&self.runtime)?;
        }
        if self.had_previous && self.backup.exists() {
            std::fs::rename(&self.backup, &self.runtime)?;
            for path in &self.stale {
                let _ = std::fs::remove_dir_all(path);
            }
            Ok(RollbackOutcome::Restored)
        } else if self.had_previous {
            Ok(RollbackOutcome::NotRestored)
        } else {
            Ok(RollbackOutcome::Removed)
        }
    }
}

fn preserved_runtime_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("runtime");
    path.with_file_name(format!("{name}.preserved-{}", uuid::Uuid::new_v4()))
}

fn cleanup_preserved_runtimes(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let prefix = format!("{name}.preserved-");
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn emit(app: &AppHandle, phase: &str, downloaded: u64, total: Option<u64>, percent: u8) {
    let _ = app.emit(
        "hermes-install-progress",
        HermesInstallProgress {
            phase: phase.to_owned(),
            downloaded,
            total,
            percent,
        },
    );
}

/// Holds the runtime lifecycle slot and the `installing` fast-rejection flag for the whole
/// operation. Dropping it (normal return, error, or a cancelled command future) restores the
/// state, so an interrupted install cannot leave every later chat rejected.
struct RuntimeLifecycle<'a> {
    state: &'a HermesRuntimeState,
    _guard: tokio::sync::MutexGuard<'a, ()>,
}

impl Drop for RuntimeLifecycle<'_> {
    fn drop(&mut self) {
        self.state.installing.store(false, Ordering::SeqCst);
    }
}

fn begin_lifecycle(state: &HermesRuntimeState) -> Result<RuntimeLifecycle<'_>, AppError> {
    let guard = state.lifecycle.try_lock().map_err(|_| {
        AppError::new(
            "E_HERMES_INSTALLING",
            "Hermes is already being installed or removed.",
        )
    })?;
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(AppError::new(
            "E_HERMES_INSTALLING",
            "Hermes is already being installed.",
        ));
    }
    Ok(RuntimeLifecycle {
        state,
        _guard: guard,
    })
}

/// One install's private staging directory. The abort signal fires as soon as the command
/// future is dropped; the directory is removed when the last detached worker releases it.
struct StagingInner {
    root: PathBuf,
    cancelled: std::sync::Arc<AtomicBool>,
}

impl Drop for StagingInner {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct InstallStaging {
    inner: std::sync::Arc<StagingInner>,
    cancelled: std::sync::Arc<AtomicBool>,
}

impl InstallStaging {
    fn new(root: PathBuf) -> Self {
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        Self {
            inner: std::sync::Arc::new(StagingInner {
                root,
                cancelled: cancelled.clone(),
            }),
            cancelled,
        }
    }

    fn root(&self) -> &Path {
        &self.inner.root
    }

    fn worker(&self) -> std::sync::Arc<StagingInner> {
        self.inner.clone()
    }
}

impl Drop for InstallStaging {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

pub async fn install(
    app: AppHandle,
    state: &HermesRuntimeState,
) -> Result<HermesRuntimeStatus, AppError> {
    let _lifecycle = begin_lifecycle(state)?;
    state.install_cancel.store(false, Ordering::SeqCst);
    install_inner(&app, state).await
}

async fn install_inner(
    app: &AppHandle,
    state: &HermesRuntimeState,
) -> Result<HermesRuntimeStatus, AppError> {
    if std::env::consts::ARCH != "aarch64" {
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            "This Hermes runtime build is for Apple Silicon (arm64).",
        ));
    }
    // An update replaces the local runtime only; Panel turns keep their own cards.
    let _ = stop_local(state, None).await;
    let pinned = runtime_manifest()?;
    let expected_version = pinned.hermes.version.clone();
    let root = data_root(app)?;
    let runtime = runtime_root(app)?;
    // A unique staging directory: if this command's future is dropped, a detached extract /
    // AppleDouble worker keeps writing here instead of a path a retry or uninstall reuses.
    let staging =
        InstallStaging::new(root.join(format!("runtime.tmp-{}", uuid::Uuid::new_v4().simple())));
    let temp = staging.root().to_path_buf();
    std::fs::create_dir_all(&temp)?;
    emit(app, "preparing", 0, None, 1);

    if let Some(source) = std::env::var_os("HERMES_RUNTIME_SOURCE") {
        let source = PathBuf::from(source);
        if source.is_dir() {
            emit(app, "copying", 0, None, 10);
            copy_directory(&source, &temp)?;
        } else if source.is_file() {
            emit(app, "extracting", 0, None, 35);
            extract_tar(&source, staging.worker()).await?;
        } else {
            return Err(AppError::new(
                "E_HERMES_INSTALL",
                "HERMES_RUNTIME_SOURCE does not exist.",
            ));
        }
    } else {
        let default_url = format!(
            "https://github.com/{}/releases/download/{}/{}",
            pinned.release.repository, pinned.release.tag, pinned.release.asset
        );
        let url = std::env::var("HERMES_RUNTIME_URL").unwrap_or(default_url);
        let archive = temp.join("runtime.tar.gz");
        download(Some(app), &url, &archive, &state.install_cancel).await?;
        emit(app, "verifying", 0, None, 80);
        let expected = std::env::var("HERMES_RUNTIME_SHA256")
            .unwrap_or_else(|_| pinned.release.sha256.clone());
        if expected.trim().is_empty() {
            let _ = std::fs::remove_file(&archive);
            return Err(AppError::new(
                "E_HERMES_INSTALL",
                "This build has no pinned Hermes runtime checksum.",
            )
            .with_detail("Run hermes:package and rebuild the desktop app."));
        }
        let actual = sha256_file(&archive).await?;
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            let _ = std::fs::remove_file(&archive);
            return Err(AppError::new(
                "E_HERMES_INSTALL",
                "Hermes runtime checksum does not match.",
            ));
        }
        emit(app, "extracting", 0, None, 85);
        extract_tar(&archive, staging.worker()).await?;
        let _ = std::fs::remove_file(&archive);
    }

    // A runtime copied from a legacy archive/Finder round-trip can carry `._*` AppleDouble
    // stubs. Python's tool discovery globs `tools/*.py` and decodes every match, so those
    // stubs make the CLI (and agent turns) fail before the runtime ever runs. The tree is
    // ours: strip them once, here, whichever source produced it.
    let repair_root = temp.clone();
    match tokio::task::spawn_blocking(move || super::hygiene::strip_apple_double(&repair_root))
        .await
    {
        Ok(Ok(0)) => {}
        Ok(Ok(removed)) => log::warn!("Hermes install: removed {removed} AppleDouble entries"),
        Ok(Err(error)) => log::warn!("Hermes install: AppleDouble cleanup failed: {error}"),
        Err(error) => log::warn!("Hermes install: AppleDouble cleanup task failed: {error}"),
    }

    if let Err(error) = cancel_checkpoint(state) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(error);
    }

    let wrapper = temp.join("bin").join("hermes");
    if !wrapper.is_file() {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            "The Hermes package does not contain bin/hermes.",
        ));
    }
    if let Err(error) = cancel_checkpoint(state) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(error);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755));
    }

    if let Err(error) = verify_runtime_bin(&wrapper, &expected_version).await {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            "The Hermes package is not the pinned runtime.",
        )
        .with_detail(error.detail.unwrap_or(error.message)));
    }

    let home = hermes_home(app)?;
    std::fs::create_dir_all(home.join("plugins"))?;
    if let Err(error) = cancel_checkpoint(state) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(error);
    }
    let plugin_updates = match stage_managed_plugins(&temp, &home, &pinned.plugins, &root) {
        Ok(updates) => updates,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&temp);
            cleanup_plugin_staging(&root);
            return Err(error);
        }
    };

    if let Err(error) = cancel_checkpoint(state) {
        let _ = std::fs::remove_dir_all(&temp);
        cleanup_plugin_staging(&root);
        return Err(error);
    }
    let activation = match activate_runtime(
        &temp,
        &runtime,
        &root.join("runtime.old"),
        &expected_version,
    )
    .await
    {
        Ok(activation) => activation,
        Err(error) => {
            cleanup_plugin_staging(&root);
            return Err(error);
        }
    };

    // Activation has swapped directories but not committed: cancelling here restores the
    // previous runtime instead of leaving an unverified one in place.
    if state.install_cancel.load(Ordering::SeqCst) {
        return Err(cancel_after_activation(&activation, &root));
    }
    if let Err(error) = apply_plugin_updates(&plugin_updates) {
        let rollback = activation.rollback();
        cleanup_plugin_staging(&root);
        let message = match rollback {
            Ok(RollbackOutcome::Restored) => {
                "Could not update the bundled Hermes plugins; the previous runtime was restored."
            }
            Ok(RollbackOutcome::Removed) => {
                "Could not update the bundled Hermes plugins; the new runtime was removed."
            }
            Ok(RollbackOutcome::NotRestored) => {
                "Could not update the bundled Hermes plugins or restore the previous runtime."
            }
            Err(_) if activation.had_previous => {
                "Could not update the bundled Hermes plugins or restore the previous runtime."
            }
            Err(_) => "Could not update the bundled Hermes plugins or remove the new runtime.",
        };
        return Err(AppError::new("E_HERMES_INSTALL", message)
            .with_detail(error.detail.unwrap_or(error.message)));
    }

    // The plugin swap is part of the same transaction; a cancel here must undo both.
    if state.install_cancel.load(Ordering::SeqCst) {
        rollback_plugin_updates(&plugin_updates);
        return Err(cancel_after_activation(&activation, &root));
    }
    // Past this point the new runtime is committed; a late cancel is ignored. The phase
    // tells the UI to retire the cancel button instead of pretending it still works.
    emit(app, "finishing", 0, None, 95);
    activation.commit();
    finish_plugin_sync(&root);
    // A backend from an earlier app session keeps the old runtime code bound to this host,
    // and Hermes refuses to bind a second one for the same home (exit 78). `ensure_server`
    // is blocked while `installing` is set, but a request that passed that check just
    // before the flag was set may still be spawning. Hold the same gateway slot, stop the
    // backend it uses, and reap the backends this app recorded in earlier sessions. A
    // user-started backend is not in that ledger and is never touched.
    let mut gateway = state.gateway.lock().await;
    if let Some(server) = gateway.take() {
        server.stop();
    }
    let report = super::hygiene::reap_owned_backends(&home, None, true).await;
    drop(gateway);
    // A backend that is not in OpenNavo's ledger (an older build's orphan, or one the user
    // started manually) is never stopped automatically. Report it: otherwise the upgrade
    // claims success and the first message is where the occupied profile surfaces.
    let failed_pids: std::collections::HashSet<u32> =
        report.failed.iter().map(|(_, pid, _)| *pid).collect();
    let mut occupied: Vec<(String, Vec<u32>)> = Vec::new();
    let mut unverified: Vec<String> = Vec::new();
    if let Some(bin) = super::runtime_bin(app) {
        for (profile, path) in super::hygiene::profile_homes(&home) {
            match super::hygiene::scan_backend_pids(&bin, &path).await {
                super::hygiene::BackendScan::Pids(pids) => {
                    let pids: Vec<u32> = pids
                        .into_iter()
                        .filter(|pid| !failed_pids.contains(pid))
                        .collect();
                    if !pids.is_empty() {
                        occupied.push((profile, pids));
                    }
                }
                // A probe that failed is not evidence that the profile is free.
                super::hygiene::BackendScan::Unavailable => unverified.push(profile),
            }
        }
    }
    emit(app, "done", 0, None, 100);
    let mut updated = status(app.clone()).await?;
    let mut warnings = Vec::new();
    if !report.failed.is_empty() {
        let failures = report
            .failed
            .iter()
            .map(|(profile, pid, reason)| format!("{profile} (PID {pid}: {reason})"))
            .collect::<Vec<_>>()
            .join(", ");
        warnings.push(format!("could not stop {failures}"));
    }
    if !occupied.is_empty() {
        let names = occupied
            .iter()
            .map(|(profile, pids)| {
                let pids = pids
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{profile} (PID {pids})")
            })
            .collect::<Vec<_>>()
            .join("; ");
        warnings.push(format!("another Hermes backend still owns {names}"));
    }
    if !unverified.is_empty() {
        warnings.push(format!(
            "could not verify whether these profiles are free: {}",
            unverified.join(", ")
        ));
    }
    if !warnings.is_empty() {
        updated.message = Some(format!(
            "Hermes was updated, but {}. Stop any backend that still owns a profile before the next message (use `hermes --profile <name> serve --stop` with the same HERMES_HOME, or close the dashboard that owns it).",
            warnings.join("; ")
        ));
    }
    Ok(updated)
}

/// Roll back a provisional activation and report honestly when the previous runtime could
/// not be restored (the backup directory is kept for manual recovery).
fn cancel_after_activation(activation: &ActivatedRuntime, root: &Path) -> AppError {
    let outcome = activation.rollback();
    cleanup_plugin_staging(root);
    match outcome {
        Ok(RollbackOutcome::Restored) | Ok(RollbackOutcome::Removed) => install_cancelled(),
        Ok(RollbackOutcome::NotRestored) => AppError::new(
            "E_HERMES_INSTALL",
            "Hermes install was cancelled, but the previous runtime could not be restored.",
        ),
        Err(error) => AppError::new(
            "E_HERMES_INSTALL",
            "Hermes install was cancelled, and restoring the previous runtime failed.",
        )
        .with_detail(error.detail.unwrap_or(error.message)),
    }
}

/// Restores the previous runtime if activation is abandoned (future dropped) before the
/// verification await returns.
struct ActivationGuard {
    runtime: PathBuf,
    backup: PathBuf,
    had_previous: bool,
    stale: Vec<PathBuf>,
    active: bool,
}

impl Drop for ActivationGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let _ = std::fs::remove_dir_all(&self.runtime);
        if self.had_previous
            && self.backup.exists()
            && let Err(error) = std::fs::rename(&self.backup, &self.runtime)
        {
            log::warn!(
                "Hermes activation was abandoned and the previous runtime could not be restored from {}: {error}",
                self.backup.display()
            );
        }
        for path in &self.stale {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

async fn activate_runtime(
    staged: &Path,
    runtime: &Path,
    backup: &Path,
    expected_version: &str,
) -> Result<ActivatedRuntime, AppError> {
    if let Some(parent) = runtime.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut stale = Vec::new();
    let had_previous = runtime.exists() || backup.exists();
    if runtime.exists() && backup.exists() {
        // `runtime` is an uncommitted candidate; `runtime.old` is the last known runtime.
        // Keep both until the new package has passed verification.
        let preserved = preserved_runtime_path(runtime);
        std::fs::rename(runtime, &preserved).map_err(|error| {
            AppError::new(
                "E_HERMES_INSTALL",
                "Could not preserve the uncommitted Hermes runtime.",
            )
            .with_detail(error.to_string())
        })?;
        stale.push(preserved);
    } else if runtime.exists() {
        std::fs::rename(runtime, backup).map_err(|error| {
            AppError::new(
                "E_HERMES_INSTALL",
                "Could not back up the previous Hermes runtime.",
            )
            .with_detail(error.to_string())
        })?;
    }
    if let Err(error) = std::fs::rename(staged, runtime) {
        if let Some(preserved) = stale.first() {
            let _ = std::fs::rename(preserved, runtime);
        } else if had_previous && backup.exists() {
            let _ = std::fs::rename(backup, runtime);
        }
        return Err(
            AppError::new("E_HERMES_INSTALL", "Could not activate the Hermes runtime.")
                .with_detail(error.to_string()),
        );
    }

    // Until verification finishes the swap is provisional. A dropped command future during
    // the await must not leave an unverified runtime in place: the guard restores the backup.
    let mut activation_guard = ActivationGuard {
        runtime: runtime.to_path_buf(),
        backup: backup.to_path_buf(),
        had_previous,
        stale: stale.clone(),
        active: true,
    };
    if let Err(error) =
        verify_runtime_bin(&runtime.join("bin").join("hermes"), expected_version).await
    {
        let removed = std::fs::remove_dir_all(runtime).is_ok();
        let restored =
            removed && had_previous && backup.exists() && std::fs::rename(backup, runtime).is_ok();
        if restored {
            for preserved in &stale {
                let _ = std::fs::remove_dir_all(preserved);
            }
        }
        activation_guard.active = false;
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            if restored {
                "The new Hermes runtime failed verification; the previous runtime was restored."
            } else if had_previous {
                "The new Hermes runtime failed verification and the previous runtime could not be restored."
            } else {
                "The new Hermes runtime failed verification."
            },
        )
        .with_detail(error.detail.unwrap_or(error.message)));
    }

    activation_guard.active = false;
    Ok(ActivatedRuntime {
        runtime: runtime.to_path_buf(),
        backup: backup.to_path_buf(),
        had_previous,
        stale,
    })
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), AppError> {
    let status = std::process::Command::new("ditto")
        .arg(source)
        .arg(destination)
        .status()
        .map_err(|error| {
            AppError::new("E_HERMES_INSTALL", "Could not copy the Hermes runtime.")
                .with_detail(error.to_string())
        })?;
    if !status.success() {
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            "Could not copy the Hermes runtime.",
        ));
    }
    Ok(())
}

fn plugin_catalog_state(target: &Path, plugin: &RuntimePluginPin) -> PluginCatalogState {
    let Ok(raw) = std::fs::read_to_string(target.join(".hermes-catalog.json")) else {
        return PluginCatalogState::Unmanaged;
    };
    let Ok(catalog) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return PluginCatalogState::Unmanaged;
    };
    let Some(name) = catalog.get("catalog_name").and_then(|value| value.as_str()) else {
        return PluginCatalogState::Unmanaged;
    };
    let Some(repository) = catalog.get("repo").and_then(|value| value.as_str()) else {
        return PluginCatalogState::Unmanaged;
    };
    if name != plugin.name || repository != plugin.repository {
        return PluginCatalogState::Unmanaged;
    }
    match catalog.get("sha").and_then(|value| value.as_str()) {
        Some(installed) if installed == plugin.sha => PluginCatalogState::Current,
        Some(_) => PluginCatalogState::Stale,
        None => PluginCatalogState::Unmanaged,
    }
}

fn validate_plugin_dir(path: &Path) -> Result<(), AppError> {
    let manifest = path.join("plugin.yaml");
    let catalog = path.join(".hermes-catalog.json");
    if !manifest.is_file() || !catalog.is_file() {
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            "The Hermes package contains an incomplete bundled plugin.",
        )
        .with_detail(format!(
            "missing plugin.yaml or .hermes-catalog.json in {}",
            path.display()
        )));
    }
    Ok(())
}

fn stage_managed_plugins(
    runtime: &Path,
    home: &Path,
    plugins: &[RuntimePluginPin],
    root: &Path,
) -> Result<Vec<PluginUpdate>, AppError> {
    let staging = root.join("plugins.tmp");
    let backups = root.join("plugins.old");
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&backups);
    std::fs::create_dir_all(&staging)?;
    std::fs::create_dir_all(home.join("plugins"))?;

    let mut updates = Vec::new();
    for plugin in plugins {
        let source = runtime.join("plugins").join(&plugin.name);
        validate_plugin_dir(&source)?;
        let target = home.join("plugins").join(&plugin.name);
        let had_previous = target.exists();
        if target.exists() {
            match plugin_catalog_state(&target, plugin) {
                PluginCatalogState::Current => continue,
                PluginCatalogState::Stale => {}
                PluginCatalogState::Unmanaged => {
                    log::warn!(
                        "Preserving user-managed Hermes plugin {} at {}",
                        plugin.name,
                        target.display()
                    );
                    continue;
                }
            }
        }

        let staged = staging.join(&plugin.name);
        copy_directory(&source, &staged)?;
        validate_plugin_dir(&staged)?;
        updates.push(PluginUpdate {
            target,
            staged,
            backup: backups.join(&plugin.name),
            had_previous,
        });
    }
    Ok(updates)
}

fn rollback_plugin_updates(updates: &[PluginUpdate]) {
    for update in updates.iter().rev() {
        let _ = std::fs::remove_dir_all(&update.target);
        if update.had_previous && update.backup.exists() {
            let _ = std::fs::rename(&update.backup, &update.target);
        }
    }
}

fn apply_plugin_updates(updates: &[PluginUpdate]) -> Result<(), AppError> {
    for (applied, update) in updates.iter().enumerate() {
        if let Some(parent) = update.backup.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if update.had_previous
            && let Err(error) = std::fs::rename(&update.target, &update.backup)
        {
            rollback_plugin_updates(&updates[..applied]);
            return Err(AppError::new(
                "E_HERMES_INSTALL",
                "Could not back up a bundled Hermes plugin.",
            )
            .with_detail(error.to_string()));
        }
        if let Err(error) = std::fs::rename(&update.staged, &update.target) {
            if update.had_previous && update.backup.exists() {
                let _ = std::fs::rename(&update.backup, &update.target);
            }
            rollback_plugin_updates(&updates[..applied]);
            return Err(AppError::new(
                "E_HERMES_INSTALL",
                "Could not activate a bundled Hermes plugin.",
            )
            .with_detail(error.to_string()));
        }
    }
    Ok(())
}

fn cleanup_plugin_staging(root: &Path) {
    let _ = std::fs::remove_dir_all(root.join("plugins.tmp"));
}

fn finish_plugin_sync(root: &Path) {
    cleanup_plugin_staging(root);
    let _ = std::fs::remove_dir_all(root.join("plugins.old"));
}

/// How often a network wait re-checks the cancel flag. A chunk that never arrives would
/// otherwise keep the install alive until the socket itself times out.
const DOWNLOAD_POLL: std::time::Duration = std::time::Duration::from_millis(100);
/// A single connect/read/write step that makes no progress this long is treated as stalled.
const DOWNLOAD_STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn install_cancelled() -> AppError {
    AppError::new("E_HERMES_INSTALL_CANCELLED", "Hermes install cancelled.")
}

/// Cancellation is honored until the commit boundary. Every awaited phase checks it so the
/// button remains effective through verification and activation, not only the download.
fn cancel_checkpoint(state: &HermesRuntimeState) -> Result<(), AppError> {
    if state.install_cancel.load(Ordering::SeqCst) {
        Err(install_cancelled())
    } else {
        Ok(())
    }
}

/// Await one download step while watching the cancel flag and an idle deadline. `tokio`'s
/// own socket timeout only fires per request, so a stuck body would still ignore a cancel
/// until the next chunk; polling here revokes promptly and bounds each wait.
async fn step_or_cancel<T>(
    cancel: &AtomicBool,
    future: impl std::future::Future<Output = T>,
) -> Result<T, AppError> {
    tokio::pin!(future);
    let deadline = tokio::time::Instant::now() + DOWNLOAD_STEP_TIMEOUT;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(install_cancelled());
        }
        tokio::select! {
            value = &mut future => return Ok(value),
            _ = tokio::time::sleep_until(deadline) => {
                return Err(AppError::new(
                    "E_HERMES_INSTALL",
                    "The Hermes runtime download stalled.",
                ));
            }
            _ = tokio::time::sleep(DOWNLOAD_POLL) => {}
        }
    }
}

async fn download(
    app: Option<&AppHandle>,
    url: &str,
    archive: &Path,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let client = reqwest::Client::builder()
        .connect_timeout(DOWNLOAD_STEP_TIMEOUT)
        .build()
        .map_err(|error| {
            AppError::new("E_HERMES_INSTALL", "Could not prepare the Hermes download.")
                .with_detail(error.to_string())
        })?;
    let response = step_or_cancel(cancel, client.get(url).send())
        .await?
        .map_err(|error| {
            AppError::new("E_HERMES_INSTALL", "Could not download the Hermes runtime.")
                .with_detail(error.to_string())
        })?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            format!(
                "Hermes runtime download failed with HTTP {}.",
                response.status()
            ),
        ));
    }
    let total = response.content_length();
    let mut file = tokio::fs::File::create(archive).await?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0_u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = file.flush().await;
            let _ = std::fs::remove_file(archive);
            return Err(install_cancelled());
        }
        // A cancelled stream must also drop its half-written archive; every early return
        // below therefore removes the file before reporting.
        let next = step_or_cancel(cancel, stream.next())
            .await
            .inspect_err(|_| {
                let _ = std::fs::remove_file(archive);
            })?;
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|error| {
            let _ = std::fs::remove_file(archive);
            AppError::new("E_HERMES_INSTALL", "Hermes download interrupted.")
                .with_detail(error.to_string())
        })?;
        step_or_cancel(cancel, file.write_all(&chunk))
            .await
            .inspect_err(|_| {
                let _ = std::fs::remove_file(archive);
            })?
            .map_err(|error| {
                let _ = std::fs::remove_file(archive);
                AppError::from(error)
            })?;
        downloaded += chunk.len() as u64;
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| ((downloaded.saturating_mul(100) / total).min(79)) as u8)
            .unwrap_or(20);
        if let Some(app) = app {
            emit(app, "downloading", downloaded, total, percent);
        }
    }
    file.flush().await?;
    Ok(())
}

async fn extract_tar(
    archive: &Path,
    staging: std::sync::Arc<StagingInner>,
) -> Result<(), AppError> {
    let archive = archive.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        // The closure owns the Arc, so a dropped install future cannot remove the staging
        // directory while this worker is still writing into it.
        let staging = staging;
        let file = std::fs::File::open(&archive)?;
        let decoder = GzDecoder::new(file);
        let mut tar = tar::Archive::new(decoder);
        // Per-entry loop instead of one `unpack`: a cancelled install stops writing promptly,
        // and a staging directory removed by uninstall is not recreated wholesale.
        for entry in tar.entries()? {
            // A dropped install or an uninstall that removed the root must not be recreated
            // by the next tar entry.
            if staging.cancelled.load(Ordering::SeqCst) || !staging.root.exists() {
                return Err(install_cancelled());
            }
            let mut entry = entry?;
            entry.unpack_in(&staging.root)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| {
        AppError::new("E_HERMES_INSTALL", "Hermes extraction failed.")
            .with_detail(error.to_string())
    })?
}
async fn sha256_file(path: &Path) -> Result<String, AppError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String, AppError> {
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|error| {
        AppError::new("E_HERMES_INSTALL", "Hermes checksum failed.").with_detail(error.to_string())
    })?
}

pub fn cancel(state: &HermesRuntimeState) {
    state.install_cancel.store(true, Ordering::SeqCst);
}

pub async fn uninstall(
    app: AppHandle,
    state: &HermesRuntimeState,
) -> Result<HermesRuntimeStatus, AppError> {
    // The same slot install takes: chat/model reads are rejected while the runtime directory
    // is being removed, and an install cannot start swapping files halfway through a delete.
    let _lifecycle = begin_lifecycle(state)?;
    // The startup credential migration runs on a detached thread; it must not recreate the
    // data root while this uninstall removes it.
    super::legacy_migration::suspend();
    // Removing the local runtime must not cancel cards a Panel host is waiting on.
    stop_local(state, None).await?;
    // The gateway slot may be empty while a recorded backend this app started earlier still
    // owns the directory. Stop those too, and refuse to delete files a live runtime holds.
    let home = hermes_home(&app)?;
    let report = super::hygiene::reap_owned_backends(&home, None, true).await;
    if !report.failed.is_empty() {
        let failures = report
            .failed
            .iter()
            .map(|(profile, pid, _)| format!("{profile} (PID {pid})"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            "A running Hermes backend could not be stopped; nothing was removed.",
        )
        .with_detail(format!("Still running: {failures}")));
    }
    let root = data_root(&app)?;
    if root.exists() {
        std::fs::remove_dir_all(&root)?;
    }
    // `.env` (provider keys) and `.opennavo/session.json` (panel sessions) live under
    // the data root that was just removed; drop the in-process cache as well.
    panel_sessions_forget();
    status(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_a_prepared_runtime_directory() {
        let source = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("bin")).unwrap();
        std::fs::write(source.path().join("bin").join("hermes"), "#!/bin/sh\n").unwrap();
        let destination = tempfile::tempdir().unwrap();
        copy_directory(source.path(), destination.path()).unwrap();
        assert!(destination.path().join("bin").join("hermes").is_file());
    }

    #[tokio::test]
    async fn extracts_a_runtime_tarball() {
        let source = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("bin")).unwrap();
        std::fs::write(source.path().join("bin").join("hermes"), "#!/bin/sh\n").unwrap();
        let archive = source.path().join("runtime.tar.gz");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            builder.append_dir_all(".", source.path()).unwrap();
            builder.finish().unwrap();
        }
        let destination = tempfile::tempdir().unwrap();
        let staging = InstallStaging::new(destination.path().to_path_buf());
        extract_tar(&archive, staging.worker()).await.unwrap();
        assert!(destination.path().join("bin").join("hermes").is_file());
    }

    #[cfg(unix)]
    fn write_versioned_runtime(root: &Path, version: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::create_dir_all(root.join("bin")).unwrap();
        let wrapper = root.join("bin").join("hermes");
        std::fs::write(
            &wrapper,
            format!("#!/bin/sh\nprintf 'Hermes Agent v{version} · stable\\n'\n"),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn activation_verifies_and_commits_the_new_runtime() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("staged");
        let runtime = root.path().join("runtime");
        let backup = root.path().join("runtime.old");
        write_versioned_runtime(&staged, "0.23.1");
        write_versioned_runtime(&runtime, "0.23.0");

        let activation = activate_runtime(&staged, &runtime, &backup, "0.23.1")
            .await
            .unwrap();
        assert!(backup.exists());
        activation.commit();

        let wrapper = std::fs::read_to_string(runtime.join("bin").join("hermes")).unwrap();
        assert!(wrapper.contains("0.23.1"));
        assert!(!backup.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_activation_restores_the_previous_runtime() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("staged");
        let runtime = root.path().join("runtime");
        let backup = root.path().join("runtime.old");
        write_versioned_runtime(&staged, "0.23.0");
        write_versioned_runtime(&runtime, "0.22.9");

        let error = activate_runtime(&staged, &runtime, &backup, "0.23.1")
            .await
            .unwrap_err();

        assert!(error.message.contains("previous runtime was restored"));
        let wrapper = std::fs::read_to_string(runtime.join("bin").join("hermes")).unwrap();
        assert!(wrapper.contains("0.22.9"));
        assert!(!staged.exists());
        assert!(!backup.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_activation_restores_the_backup_when_an_uncommitted_runtime_exists() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("staged");
        let runtime = root.path().join("runtime");
        let backup = root.path().join("runtime.old");
        write_versioned_runtime(&staged, "0.23.0");
        write_versioned_runtime(&runtime, "0.23.0-rc");
        write_versioned_runtime(&backup, "0.22.9");

        let error = activate_runtime(&staged, &runtime, &backup, "0.23.1")
            .await
            .unwrap_err();

        assert!(error.message.contains("previous runtime was restored"));
        let wrapper = std::fs::read_to_string(runtime.join("bin").join("hermes")).unwrap();
        assert!(wrapper.contains("0.22.9"));
        assert!(!staged.exists());
        assert!(!backup.exists());
        let preserved = std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("runtime.preserved-")
            })
            .count();
        assert_eq!(preserved, 0);
    }

    #[test]
    fn rollback_without_a_previous_runtime_reports_removal() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let activation = ActivatedRuntime {
            runtime,
            backup: root.path().join("runtime.old"),
            had_previous: false,
            stale: Vec::new(),
        };

        assert_eq!(activation.rollback().unwrap(), RollbackOutcome::Removed);
        assert!(!activation.runtime.exists());
    }

    #[test]
    fn rollback_with_a_previous_runtime_reports_restoration() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        let backup = root.path().join("runtime.old");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(backup.join("marker.txt"), "previous").unwrap();
        let activation = ActivatedRuntime {
            runtime: runtime.clone(),
            backup: backup.clone(),
            had_previous: true,
            stale: Vec::new(),
        };

        assert_eq!(activation.rollback().unwrap(), RollbackOutcome::Restored);
        assert_eq!(
            std::fs::read_to_string(runtime.join("marker.txt")).unwrap(),
            "previous"
        );
        assert!(!backup.exists());
    }

    fn write_plugin(root: &Path, name: &str, repository: &str, sha: &str, marker: &str) {
        let plugin = root.join("plugins").join(name);
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("plugin.yaml"), format!("name: {name}\n")).unwrap();
        std::fs::write(
            plugin.join(".hermes-catalog.json"),
            serde_json::json!({
                "catalog_name": name,
                "repo": repository,
                "sha": sha
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(plugin.join("marker.txt"), marker).unwrap();
    }

    #[test]
    fn plugin_sync_replaces_a_stale_managed_copy() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        let home = root.path().join("home");
        let repository = "https://github.com/NousResearch/hermes-labs-plugins";
        write_plugin(&runtime, "github-copilot", repository, "new-sha", "new");
        write_plugin(&home, "github-copilot", repository, "old-sha", "old");
        let pins = [RuntimePluginPin {
            name: "github-copilot".to_owned(),
            repository: repository.to_owned(),
            sha: "new-sha".to_owned(),
        }];

        let updates = stage_managed_plugins(&runtime, &home, &pins, root.path()).unwrap();
        assert_eq!(updates.len(), 1);
        assert!(updates[0].had_previous);
        apply_plugin_updates(&updates).unwrap();

        let plugin = home.join("plugins").join("github-copilot");
        assert_eq!(
            std::fs::read_to_string(plugin.join("marker.txt")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(
                root.path()
                    .join("plugins.old")
                    .join("github-copilot")
                    .join("marker.txt")
            )
            .unwrap(),
            "old"
        );
        finish_plugin_sync(root.path());
        assert!(!root.path().join("plugins.old").exists());
    }

    #[test]
    fn plugin_sync_preserves_user_managed_copies() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        let home = root.path().join("home");
        let repository = "https://github.com/NousResearch/hermes-labs-plugins";
        write_plugin(&runtime, "github-copilot", repository, "new-sha", "new");
        write_plugin(
            &home,
            "github-copilot",
            "https://github.com/example/custom-copilot",
            "custom-sha",
            "custom",
        );
        let pins = [RuntimePluginPin {
            name: "github-copilot".to_owned(),
            repository: repository.to_owned(),
            sha: "new-sha".to_owned(),
        }];

        let updates = stage_managed_plugins(&runtime, &home, &pins, root.path()).unwrap();
        assert!(updates.is_empty());
        assert_eq!(
            std::fs::read_to_string(
                home.join("plugins")
                    .join("github-copilot")
                    .join("marker.txt")
            )
            .unwrap(),
            "custom"
        );
    }

    #[test]
    fn plugin_sync_skips_an_up_to_date_managed_copy() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        let home = root.path().join("home");
        let repository = "https://github.com/NousResearch/hermes-labs-plugins";
        write_plugin(
            &runtime,
            "github-copilot",
            repository,
            "same-sha",
            "bundled",
        );
        write_plugin(&home, "github-copilot", repository, "same-sha", "user");
        let pins = [RuntimePluginPin {
            name: "github-copilot".to_owned(),
            repository: repository.to_owned(),
            sha: "same-sha".to_owned(),
        }];

        let updates = stage_managed_plugins(&runtime, &home, &pins, root.path()).unwrap();
        assert!(updates.is_empty());
        assert_eq!(
            std::fs::read_to_string(
                home.join("plugins")
                    .join("github-copilot")
                    .join("marker.txt")
            )
            .unwrap(),
            "user"
        );
    }

    #[test]
    fn abandoning_activation_restores_the_previous_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        let backup = dir.path().join("runtime.old");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(runtime.join("new"), b"new").unwrap();
        std::fs::write(backup.join("old"), b"old").unwrap();
        {
            let _guard = ActivationGuard {
                runtime: runtime.clone(),
                backup: backup.clone(),
                had_previous: true,
                stale: Vec::new(),
                active: true,
            };
        }
        assert!(runtime.join("old").exists(), "the previous runtime is back");
        assert!(!runtime.join("new").exists());
        assert!(!backup.exists());
    }

    #[test]
    fn a_dropped_install_staging_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("runtime.tmp-test");
        {
            let staging = InstallStaging::new(root.clone());
            std::fs::create_dir_all(staging.root()).unwrap();
            std::fs::write(staging.root().join("partial"), b"x").unwrap();
        }
        assert!(
            !root.exists(),
            "staging must not leak after an error/cancel"
        );
    }

    /// The lifecycle slot is reentrant-safe: a second install/uninstall is refused while one
    /// runs, and a dropped future (command cancellation) restores the flag that chat checks.
    #[tokio::test]
    async fn a_cancelled_lifecycle_owner_restores_the_installing_flag() {
        let state = HermesRuntimeState::default();
        let guard = begin_lifecycle(&state).unwrap();
        assert!(state.installing.load(Ordering::SeqCst));
        let error = match begin_lifecycle(&state) {
            Ok(_) => panic!("a second lifecycle owner must be refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, "E_HERMES_INSTALLING");
        drop(guard);
        assert!(!state.installing.load(Ordering::SeqCst));

        // Polling this future once acquires the slot; the timeout then drops it, exactly like
        // a cancelled Tauri command, and the Drop restores the flag.
        let cancelled = tokio::time::timeout(std::time::Duration::from_millis(20), async {
            let _guard = begin_lifecycle(&state).unwrap();
            std::future::pending::<()>().await;
        })
        .await;
        assert!(cancelled.is_err());
        assert!(!state.installing.load(Ordering::SeqCst));
        assert!(begin_lifecycle(&state).is_ok());
    }

    /// A body that stalls after its headers must not hold the install forever: the poll loop
    /// sees the cancel flag, returns the cancellation error and removes the partial archive.
    #[tokio::test]
    async fn cancelling_a_stalled_download_removes_the_partial_archive() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = socket.read(&mut buffer).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\nfirst")
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("runtime.tgz");
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let task_cancel = cancel.clone();
        let task_archive = archive.clone();
        let download = tokio::spawn(async move {
            download(
                None,
                &format!("http://{addr}/runtime.tgz"),
                &task_archive,
                &task_cancel,
            )
            .await
        });

        // Give the request a chance to receive the headers and first chunk, then revoke it.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        cancel.store(true, Ordering::SeqCst);
        let error = download.await.unwrap().unwrap_err();
        assert_eq!(error.code, "E_HERMES_INSTALL_CANCELLED");
        assert!(
            !archive.exists(),
            "the interrupted download must not leave a partial archive"
        );
        server.abort();
    }
}
