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
    panel_sessions_forget, runtime_manifest, runtime_root, status, stop, verify_runtime_bin,
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

pub async fn install(
    app: AppHandle,
    state: &HermesRuntimeState,
) -> Result<HermesRuntimeStatus, AppError> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(AppError::new(
            "E_HERMES_INSTALLING",
            "Hermes is already being installed.",
        ));
    }
    state.install_cancel.store(false, Ordering::SeqCst);
    let result = install_inner(&app, state).await;
    state.installing.store(false, Ordering::SeqCst);
    result
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
    let _ = stop(state).await;
    let pinned = runtime_manifest()?;
    let expected_version = pinned.hermes.version.clone();
    let root = data_root(app)?;
    let runtime = runtime_root(app)?;
    let temp = root.join("runtime.tmp");
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp)?;
    emit(app, "preparing", 0, None, 1);

    if let Some(source) = std::env::var_os("HERMES_RUNTIME_SOURCE") {
        let source = PathBuf::from(source);
        if source.is_dir() {
            emit(app, "copying", 0, None, 10);
            copy_directory(&source, &temp)?;
        } else if source.is_file() {
            emit(app, "extracting", 0, None, 35);
            extract_tar(&source, &temp).await?;
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
        let archive = root.join("runtime.tar.gz");
        download(app, &url, &archive, &state.install_cancel).await?;
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
        extract_tar(&archive, &temp).await?;
        let _ = std::fs::remove_file(&archive);
    }

    if state.install_cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(AppError::new(
            "E_HERMES_INSTALL_CANCELLED",
            "Hermes install cancelled.",
        ));
    }

    let wrapper = temp.join("bin").join("hermes");
    if !wrapper.is_file() {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(AppError::new(
            "E_HERMES_INSTALL",
            "The Hermes package does not contain bin/hermes.",
        ));
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
    let plugin_updates = match stage_managed_plugins(&temp, &home, &pinned.plugins, &root) {
        Ok(updates) => updates,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&temp);
            cleanup_plugin_staging(&root);
            return Err(error);
        }
    };

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

    activation.commit();
    finish_plugin_sync(&root);
    emit(app, "done", 0, None, 100);
    let _ = state;
    status(app.clone()).await
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
    let mut applied = 0;
    for update in updates {
        if let Some(parent) = update.backup.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if update.had_previous {
            if let Err(error) = std::fs::rename(&update.target, &update.backup) {
                rollback_plugin_updates(&updates[..applied]);
                return Err(AppError::new(
                    "E_HERMES_INSTALL",
                    "Could not back up a bundled Hermes plugin.",
                )
                .with_detail(error.to_string()));
            }
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
        applied += 1;
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

async fn download(
    app: &AppHandle,
    url: &str,
    archive: &Path,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
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
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            let _ = file.flush().await;
            let _ = std::fs::remove_file(archive);
            return Err(AppError::new(
                "E_HERMES_INSTALL_CANCELLED",
                "Hermes install cancelled.",
            ));
        }
        let chunk = chunk.map_err(|error| {
            AppError::new("E_HERMES_INSTALL", "Hermes download interrupted.")
                .with_detail(error.to_string())
        })?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| ((downloaded.saturating_mul(100) / total).min(79)) as u8)
            .unwrap_or(20);
        emit(app, "downloading", downloaded, total, percent);
    }
    file.flush().await?;
    Ok(())
}

async fn extract_tar(archive: &Path, destination: &Path) -> Result<(), AppError> {
    let archive = archive.to_path_buf();
    let destination = destination.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let file = std::fs::File::open(&archive)?;
        let decoder = GzDecoder::new(file);
        let mut tar = tar::Archive::new(decoder);
        tar.unpack(&destination)?;
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
    stop(state).await?;
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
        extract_tar(&archive, destination.path()).await.unwrap();
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
}
