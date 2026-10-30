//! Persisted Local MCP master-switch state.
//!
//! The GUI resolves its application data directory through Tauri. The `mcp`
//! subprocess must resolve the same directory without starting Tauri, so the
//! default below mirrors Tauri's macOS `app_data_dir` layout
//! (`~/Library/Application Support/<bundle identifier>`).
//!
//! The state file is deliberately small and tolerant: a missing, unreadable or
//! malformed file means "off". Only an explicit `"enabled": true` turns the
//! broker on.

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// Bundle identifier from `tauri.conf.json`.
pub const BUNDLE_ID: &str = "com.opennavo.desktop";

/// Persisted shape of `mcp/state.json`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub enabled: bool,
}

/// Resolve the application data directory used by the GUI.
///
/// `OPENNAVO_MCP_DATA_DIR` is test-only and intentionally unavailable in
/// release builds.
pub fn data_dir() -> Result<PathBuf, io::Error> {
    #[cfg(any(debug_assertions, test))]
    if let Some(path) = std::env::var_os("OPENNAVO_MCP_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }

    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
    let home = PathBuf::from(home);

    #[cfg(target_os = "macos")]
    {
        Ok(home.join("Library/Application Support").join(BUNDLE_ID))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // The shipping app is macOS-only. This branch keeps the Tauri-free
        // modules testable on Linux and matches the usual XDG location.
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|path| !path.is_empty()) {
            Ok(PathBuf::from(xdg).join(BUNDLE_ID))
        } else {
            Ok(home.join(".local/share").join(BUNDLE_ID))
        }
    }
}

/// Directory that contains `state.json` and the socket.
pub fn mcp_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("mcp")
}

/// Persisted state path.
pub fn state_path(data_dir: &Path) -> PathBuf {
    mcp_dir(data_dir).join("state.json")
}

/// Load the master switch. Anything except an explicit `true` means off.
pub fn load(data_dir: &Path) -> State {
    let path = state_path(data_dir);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
        _ => return State::default(),
    };
    if metadata.len() > 64 * 1024 {
        return State::default();
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return State::default(),
    };
    serde_json::from_slice::<State>(&bytes)
        .map(|state| State {
            enabled: state.enabled,
        })
        .unwrap_or_default()
}

/// Persist the master switch atomically as `mcp/state.json` with mode `0600`.
pub fn save(data_dir: &Path, enabled: bool) -> io::Result<()> {
    let dir = mcp_dir(data_dir);
    ensure_private_dir(&dir)?;
    let path = dir.join("state.json");
    let temporary = dir.join(format!(
        ".state-{}-{}.tmp",
        std::process::id(),
        monotonic_nonce()
    ));

    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let body = serde_json::to_vec_pretty(&State { enabled }).map_err(io::Error::other)?;
        file.write_all(&body)?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Create or harden a directory that contains private state and the socket.
///
/// The final path component is created with `mkdir(0700)` (never recursive),
/// then opened with `O_DIRECTORY | O_NOFOLLOW`. Ownership and mode are checked
/// and fixed through that descriptor (`fstat`/`fchmod`), so a symlink or other
/// object swapped in at the path is refused instead of followed.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    let raw = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "MCP directory path"))?;

    if unsafe { nix::libc::mkdir(raw.as_ptr(), 0o700) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(nix::libc::EEXIST) {
            return Err(error);
        }
    }

    let fd = unsafe {
        nix::libc::open(
            raw.as_ptr(),
            nix::libc::O_RDONLY
                | nix::libc::O_DIRECTORY
                | nix::libc::O_NOFOLLOW
                | nix::libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return Err(match error.raw_os_error() {
            Some(code) if code == nix::libc::ELOOP || code == nix::libc::ENOTDIR => io::Error::new(
                io::ErrorKind::PermissionDenied,
                "MCP directory is not a directory",
            ),
            _ => error,
        });
    }
    let result = (|| {
        let mut stat: nix::libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { nix::libc::fstat(fd, &mut stat) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if (stat.st_mode & nix::libc::S_IFMT) != nix::libc::S_IFDIR {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "MCP directory is not a directory",
            ));
        }
        if stat.st_uid != unsafe { nix::libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "MCP directory is owned by another user",
            ));
        }
        #[allow(clippy::unnecessary_cast)]
        let mode = stat.st_mode as u32;
        if mode & 0o777 != 0o700 && unsafe { nix::libc::fchmod(fd, 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    unsafe { nix::libc::close(fd) };
    result
}

#[cfg(test)]
pub(crate) fn prepare_enabled_for_test(data_dir: &Path) {
    save(data_dir, true).expect("enable test state");
}

fn monotonic_nonce() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn missing_state_is_off() {
        let dir = tempdir();
        assert!(!load(dir.path()).enabled);
    }

    #[test]
    fn only_explicit_true_is_enabled() {
        let dir = tempdir();
        save(dir.path(), true).expect("save");
        assert!(load(dir.path()).enabled);

        for body in [r#"{"enabled":false}"#, "{}", "not json", "[]", "null"] {
            fs::write(state_path(dir.path()), body).expect("write state");
            assert!(!load(dir.path()).enabled, "body {body}");
        }
    }

    #[test]
    fn state_file_and_directory_are_private() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let dir = tempdir();
        save(dir.path(), true).expect("save");
        let directory = fs::metadata(mcp_dir(dir.path())).expect("dir metadata");
        let file = fs::metadata(state_path(dir.path())).expect("file metadata");
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
        assert_eq!(directory.uid(), unsafe { nix::libc::geteuid() });
    }
}
