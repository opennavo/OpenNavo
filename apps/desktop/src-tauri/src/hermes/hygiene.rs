//! Runtime tree hygiene.
//!
//! The Hermes runtime is a plain directory tree that Python imports directly. macOS
//! materialises extended attributes as `._*` AppleDouble siblings on filesystems that
//! cannot store them, and a copied-in runtime can therefore carry thousands of those
//! stubs. They are not Python modules, but `tools/registry.py` globs `tools/*.py` when
//! discovering built-in toolsets and reads every match as UTF-8, so a single
//! `._foo.py` aborts `hermes tools list` (and any agent turn that imports
//! `model_tools`) with a `UnicodeDecodeError`. The tree belongs to OpenNavo, so strip
//! the metadata instead of leaving the runtime unstartable.
//!
//! The same module owns the one piece of Hermes backend lifecycle OpenNavo has to do
//! itself: only one `hermes serve`/`dashboard` backend may own a host, and a backend
//! left behind by a previous app session keeps the old runtime code alive and makes
//! the next spawn exit 78 ("this host is already served"). Hermes exposes the scoped
//! `hermes serve --stop` for exactly this; run it before taking over the host.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use tokio::time::timeout;

use super::{profiles, runtime_command};

/// AppleDouble companions share this prefix on every macOS volume.
const APPLE_DOUBLE_PREFIX: &str = "._";
/// Archive metadata directory written by Finder/Archive Utility.
const MACOSX_DIR: &str = "__MACOSX";
/// `hermes serve --stop` runs upstream's full shutdown path: SIGTERM with a 10 s grace,
/// SIGKILL survivors, then a 2 s wait per signal for dashboard-owned descendants
/// (`_POSIX_TERM_GRACE_SECONDS` / `_POSIX_DESCENDANT_GRACE_SECONDS`), plus interpreter
/// startup and a `ps` scan. A shorter deadline would abandon the stop mid-grace and let
/// the next `serve` race a backend that still owns the home. The command keeps running
/// if this deadline expires, so the stop still completes in the background.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);

/// Repair runs at most once per app process: scanning a 60k-file runtime on every
/// settings open would be wasted work (installs strip the tree themselves).
static TREE_REPAIR_STARTED: AtomicBool = AtomicBool::new(false);

/// Remove `._*` files and `__MACOSX` directories below `root`.
///
/// Best effort by design: a file we cannot remove must not fail a runtime install or
/// block startup, so unreadable entries are skipped. Symlinks are never followed.
pub(crate) fn strip_apple_double(root: &Path) -> std::io::Result<usize> {
    if !root.is_dir() {
        return Ok(0);
    }
    let mut removed = 0;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                if name == MACOSX_DIR {
                    if std::fs::remove_dir_all(&path).is_ok() {
                        removed += 1;
                    }
                } else {
                    pending.push(path);
                }
                continue;
            }
            if name.starts_with(APPLE_DOUBLE_PREFIX) && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Repair a runtime tree left dirty by an earlier install/copy, once per app process.
pub(crate) async fn repair_runtime_tree_once(app: &AppHandle) {
    if TREE_REPAIR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(root) = super::runtime_root(app) else {
        return;
    };
    if !root.is_dir() {
        return;
    }
    match tokio::task::spawn_blocking(move || strip_apple_double(&root)).await {
        Ok(Ok(0)) => {}
        Ok(Ok(removed)) => {
            log::warn!("Hermes runtime repair: removed {removed} AppleDouble entries")
        }
        Ok(Err(error)) => log::warn!("Hermes runtime repair failed: {error}"),
        Err(error) => log::warn!("Hermes runtime repair task failed: {error}"),
    }
}

/// Stop backend processes that still own `home` (same scoped cleanup as `hermes update`).
///
/// `home` is the runtime's resolved `HERMES_HOME`: the root home for the default
/// profile, `<root>/profiles/<name>` otherwise. *profile* must name the same identity
/// the backend was launched with: on the root home the runtime follows the sticky
/// `<root>/active_profile` when no explicit flag is passed, so a bare `serve --stop`
/// could target a named profile and leave the default backend owning the host.
/// Hermes fails closed for processes whose home it cannot read, so another install's
/// backend is never a target.
///
/// Returns `false` when the stop command was still running at [`STOP_TIMEOUT`]. The
/// command itself is left running (no `kill_on_drop`): it is the official shutdown
/// path, and killing it mid-grace would leave the old backend alive. Callers deciding
/// whether to bind a new gateway must not do so while this returns `false`.
pub(crate) async fn stop_stale_backends(bin: &Path, home: &Path, profile: Option<&str>) -> bool {
    let Ok(mut command) = runtime_command(bin) else {
        return true;
    };
    profiles::pin_default_profile(&mut command, profile);
    command
        .args(["serve", "--stop"])
        .env("HERMES_HOME", home)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match timeout(STOP_TIMEOUT, command.status()).await {
        Ok(Ok(status)) if status.success() => {
            log::info!(
                "Hermes backend sweep: stopped stale backends for {}",
                home.display()
            );
            true
        }
        Ok(Ok(status)) => {
            log::warn!(
                "Hermes backend sweep: exited {:?} for {}",
                status.code(),
                home.display()
            );
            true
        }
        Ok(Err(error)) => {
            log::warn!(
                "Hermes backend sweep failed for {}: {error}",
                home.display()
            );
            true
        }
        Err(_) => {
            log::warn!(
                "Hermes backend sweep timed out for {}; it keeps stopping in the background",
                home.display()
            );
            false
        }
    }
}

/// Sweep every profile home the runtime can have a backend for.
///
/// Called after a runtime activation: the previous version's `serve` keeps old Python
/// code in memory, and Hermes refuses to start a second backend for the same host until
/// that process is gone.
pub(crate) async fn stop_stale_backends_for_all_profiles(app: &AppHandle) {
    let Some(bin) = super::runtime_bin(app) else {
        return;
    };
    let Ok(root_home) = super::hermes_home(app) else {
        return;
    };
    stop_stale_backends(&bin, &root_home, Some("default")).await;
    for (name, home) in profile_homes(&root_home) {
        stop_stale_backends(&bin, &home, Some(&name)).await;
    }
}

fn profile_homes(root_home: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root_home.join("profiles")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let name = entry.file_name().to_str().map(str::to_owned)?;
            profiles::name_ok(&name).then(|| (name, entry.path()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_apple_double_files_and_macosx_dirs() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("site/tools")).unwrap();
        std::fs::create_dir_all(root.path().join("site/nested/__MACOSX")).unwrap();
        std::fs::write(root.path().join("site/tools/approval.py"), b"print(1)\n").unwrap();
        std::fs::write(
            root.path().join("site/tools/._approval.py"),
            b"\x00\x05\x16\x07",
        )
        .unwrap();
        std::fs::write(root.path().join("site/._main.py"), b"\x00\x05\x16\x07").unwrap();
        std::fs::write(root.path().join("site/nested/__MACOSX/._x"), b"junk").unwrap();
        std::fs::write(root.path().join("site/nested/keep.py"), b"x = 1\n").unwrap();

        assert_eq!(strip_apple_double(root.path()).unwrap(), 3);
        assert!(root.path().join("site/tools/approval.py").is_file());
        assert!(root.path().join("site/nested/keep.py").is_file());
        assert!(!root.path().join("site/tools/._approval.py").exists());
        assert!(!root.path().join("site/._main.py").exists());
        assert!(!root.path().join("site/nested/__MACOSX").exists());
        // Idempotent: a clean tree is left alone.
        assert_eq!(strip_apple_double(root.path()).unwrap(), 0);
    }

    #[test]
    fn leaves_a_missing_tree_alone() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("not-installed");
        assert_eq!(strip_apple_double(&missing).unwrap(), 0);
    }
}
