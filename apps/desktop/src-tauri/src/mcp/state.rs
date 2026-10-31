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
    /// Write-tool switch. Only meaningful while `enabled`; off by default.
    #[serde(default)]
    pub write_enabled: bool,
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
            write_enabled: state.enabled && state.write_enabled,
        })
        .unwrap_or_default()
}

/// Persist the master switch with the write switch off.
pub fn save(data_dir: &Path, enabled: bool) -> io::Result<()> {
    save_state(
        data_dir,
        State {
            enabled,
            write_enabled: false,
        },
    )
}

/// Persist both switches atomically as `mcp/state.json` with mode `0600`.
/// The write switch is never stored on while the master switch is off.
pub fn save_state(data_dir: &Path, state: State) -> io::Result<()> {
    let state = State {
        enabled: state.enabled,
        write_enabled: state.enabled && state.write_enabled,
    };
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
        let body = serde_json::to_vec_pretty(&state).map_err(io::Error::other)?;
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

/// Create or verify a directory that contains private state and the socket.
///
/// Ancestors are walked one component at a time instead of `create_dir_all`:
/// a missing component is created with `mkdir(0700)`, and every existing one
/// must be a directory owned by root or the current user that is not writable
/// by group/others (unless sticky, like `/tmp`). A symlink ancestor is only
/// followed when root owns it (macOS `/tmp`, `/var`); any other symlink is
/// refused. The final component is created with `mkdir(0700)`, opened with
/// `O_DIRECTORY | O_NOFOLLOW` and checked through that descriptor: it must be
/// owned by the current user with mode exactly `0700`. A symlink, another
/// user's directory, or a directory with broader permissions is refused
/// rather than repaired.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        ensure_trusted_ancestors(parent)?;
    }
    mkdir_private(path)?;
    verify_private_dir(path)
}

/// Verify, without creating or repairing anything, that `path` is a real
/// directory (not a symlink) owned by the current effective uid with mode
/// `0700`. Used by the CLI before it connects to the broker socket.
pub fn verify_private_dir(path: &Path) -> io::Result<()> {
    let raw = c_path(path)?;
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
            Some(code) if code == nix::libc::ELOOP || code == nix::libc::ENOTDIR => {
                denied("MCP directory is not a directory")
            }
            _ => error,
        });
    }
    let result = (|| {
        let mut stat: nix::libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { nix::libc::fstat(fd, &mut stat) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if (stat.st_mode & nix::libc::S_IFMT) != nix::libc::S_IFDIR {
            return Err(denied("MCP directory is not a directory"));
        }
        if stat.st_uid != unsafe { nix::libc::geteuid() } {
            return Err(denied("MCP directory is owned by another user"));
        }
        #[allow(clippy::unnecessary_cast)]
        let mode = stat.st_mode as u32;
        if mode & 0o7777 != 0o700 {
            return Err(denied("MCP directory permissions are too broad"));
        }
        Ok(())
    })();
    unsafe { nix::libc::close(fd) };
    result
}

fn ensure_trusted_ancestors(parent: &Path) -> io::Result<()> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    let uid = unsafe { nix::libc::geteuid() };
    let mut current = PathBuf::new();
    for component in parent.components() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                mkdir_private(&current)?;
                fs::symlink_metadata(&current)?
            }
            Err(error) => return Err(error),
        };
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            if metadata.uid() != 0 {
                return Err(denied("MCP directory ancestor is a symlink"));
            }
            continue;
        }
        if !file_type.is_dir() || file_type.is_socket() {
            return Err(denied("MCP directory ancestor is not a directory"));
        }
        if metadata.uid() != 0 && metadata.uid() != uid {
            return Err(denied("MCP directory ancestor is owned by another user"));
        }
        let mode = metadata.mode();
        if mode & 0o022 != 0 && mode & 0o1000 == 0 {
            return Err(denied("MCP directory ancestor is writable by others"));
        }
    }
    Ok(())
}

/// `mkdir(0700)` and, when this call created the directory, force the mode to
/// exactly `0700` through an `O_NOFOLLOW` descriptor. A umask that only clears
/// group/other bits is repaired this way; one that also clears the owner's
/// read bit makes the `open` fail, and then the directory this call just
/// created is removed again (`rmdir`, so only while still empty) instead of
/// being left behind unusable. An existing directory is left untouched (and is
/// verified by the caller).
fn mkdir_private(path: &Path) -> io::Result<()> {
    let raw = c_path(path)?;
    if unsafe { nix::libc::mkdir(raw.as_ptr(), 0o700) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(nix::libc::EEXIST) {
            return Ok(());
        }
        return Err(error);
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
        unsafe { nix::libc::rmdir(raw.as_ptr()) };
        return Err(error);
    }
    let result = if unsafe { nix::libc::fchmod(fd, 0o700) } != 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    };
    unsafe { nix::libc::close(fd) };
    if result.is_err() {
        unsafe { nix::libc::rmdir(raw.as_ptr()) };
    }
    result
}

fn c_path(path: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "MCP directory path"))
}

fn denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.to_owned())
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

    #[test]
    fn symlinked_directory_is_refused() {
        let dir = tempdir();
        let target = dir.path().join("target");
        fs::create_dir(&target).expect("target");
        std::os::unix::fs::symlink(&target, mcp_dir(dir.path())).expect("symlink");
        let error = ensure_private_dir(&mcp_dir(dir.path())).expect_err("symlink leaf");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(save(dir.path(), true).is_err());
        assert!(!target.join("state.json").exists());
    }

    #[test]
    fn symlinked_ancestor_owned_by_user_is_refused() {
        let dir = tempdir();
        let target = dir.path().join("target");
        fs::create_dir(&target).expect("target");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        let error = ensure_private_dir(&link.join("mcp")).expect_err("symlink ancestor");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("mcp").exists());
    }

    #[test]
    fn broad_permissions_are_refused_not_repaired() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir();
        let mcp = mcp_dir(dir.path());
        fs::create_dir(&mcp).expect("mcp");
        fs::set_permissions(&mcp, fs::Permissions::from_mode(0o755)).expect("chmod");
        let error = ensure_private_dir(&mcp).expect_err("broad mode");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            fs::metadata(&mcp).expect("meta").permissions().mode() & 0o777,
            0o755
        );
        assert!(verify_private_dir(&mcp).is_err());
    }

    #[test]
    fn sticky_or_setgid_leaf_is_refused_not_repaired() {
        use std::os::unix::fs::PermissionsExt;

        for mode in [0o1700, 0o2700] {
            let dir = tempdir();
            let mcp = mcp_dir(dir.path());
            fs::create_dir(&mcp).expect("mcp");
            fs::set_permissions(&mcp, fs::Permissions::from_mode(mode)).expect("chmod");
            let actual = fs::metadata(&mcp).expect("meta").permissions().mode() & 0o7777;
            if actual != mode {
                // The filesystem dropped the special bit (e.g. setgid on some
                // mounts); nothing to check for this mode.
                continue;
            }
            let error = ensure_private_dir(&mcp).expect_err("special bit");
            assert_eq!(
                error.kind(),
                io::ErrorKind::PermissionDenied,
                "mode {mode:o}"
            );
            assert!(verify_private_dir(&mcp).is_err(), "mode {mode:o}");
            assert_eq!(
                fs::metadata(&mcp).expect("meta").permissions().mode() & 0o7777,
                mode,
                "mode {mode:o} must not be repaired"
            );
        }
    }

    #[test]
    fn write_switch_requires_master_switch() {
        let dir = tempdir();
        save_state(
            dir.path(),
            State {
                enabled: true,
                write_enabled: true,
            },
        )
        .expect("save");
        assert_eq!(
            load(dir.path()),
            State {
                enabled: true,
                write_enabled: true
            }
        );
        save_state(
            dir.path(),
            State {
                enabled: false,
                write_enabled: true,
            },
        )
        .expect("save");
        assert_eq!(load(dir.path()), State::default());
        fs::write(
            state_path(dir.path()),
            br#"{"enabled":false,"writeEnabled":true}"#,
        )
        .expect("write");
        assert!(!load(dir.path()).write_enabled);
        save(dir.path(), true).expect("save");
        assert!(!load(dir.path()).write_enabled, "save keeps writes off");
    }

    /// A umask that clears the owner's read bit makes the created directory
    /// unopenable; it must be removed again rather than left behind. Runs in
    /// a child process because the umask is process-wide.
    #[test]
    fn unopenable_new_directory_is_removed() {
        if let Some(root) = std::env::var_os("OPENNAVO_UMASK_RMDIR_CHILD_DIR") {
            unsafe { nix::libc::umask(0o477) };
            let leaf = PathBuf::from(root).join("mcp");
            assert!(mkdir_private(&leaf).is_err());
            assert!(fs::symlink_metadata(&leaf).is_err(), "leaf left behind");
            return;
        }
        // Root can open any directory, so the failure cannot be provoked.
        if unsafe { nix::libc::geteuid() } == 0 {
            return;
        }
        let dir = tempdir();
        let status = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args([
                "--exact",
                "mcp::state::tests::unopenable_new_directory_is_removed",
                "--test-threads=1",
            ])
            .env("OPENNAVO_UMASK_RMDIR_CHILD_DIR", dir.path())
            .status()
            .expect("spawn child");
        assert!(status.success());
    }

    #[test]
    fn group_writable_ancestor_is_refused() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir();
        let shared = dir.path().join("shared");
        fs::create_dir(&shared).expect("shared");
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).expect("chmod");
        let error = ensure_private_dir(&shared.join("mcp")).expect_err("writable ancestor");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!shared.join("mcp").exists());
    }

    #[test]
    fn foreign_owned_directory_is_refused() {
        // Root owns `/` on every supported platform; when tests run as root
        // there is no foreign owner to check.
        if unsafe { nix::libc::geteuid() } == 0 {
            return;
        }
        let error = verify_private_dir(Path::new("/")).expect_err("root-owned");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn missing_ancestors_are_created_private() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir();
        let nested = dir.path().join("a/b/mcp");
        ensure_private_dir(&nested).expect("nested");
        for path in [dir.path().join("a"), dir.path().join("a/b"), nested] {
            assert_eq!(
                fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
                0o700
            );
        }
    }

    /// Runs in a child process because the umask is process-wide and would
    /// race with other tests in this binary.
    #[test]
    fn created_directories_are_0700_under_a_strict_umask() {
        use std::os::unix::fs::PermissionsExt;

        if let Some(root) = std::env::var_os("OPENNAVO_UMASK_CHILD_DIR") {
            unsafe { nix::libc::umask(0o277) };
            let nested = PathBuf::from(root).join("a/mcp");
            ensure_private_dir(&nested).expect("ensure under strict umask");
            for path in [nested.parent().expect("parent").to_path_buf(), nested] {
                assert_eq!(
                    fs::metadata(&path).expect("meta").permissions().mode() & 0o7777,
                    0o700
                );
            }
            return;
        }
        let dir = tempdir();
        let status = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args([
                "--exact",
                "mcp::state::tests::created_directories_are_0700_under_a_strict_umask",
                "--test-threads=1",
            ])
            .env("OPENNAVO_UMASK_CHILD_DIR", dir.path())
            .status()
            .expect("spawn child");
        assert!(status.success());
        assert!(dir.path().join("a/mcp").is_dir());
    }
}
