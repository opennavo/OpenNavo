//! Who is on the other end of a Local MCP connection.
//!
//! The socket gives the broker the pid of the `mcp` subprocess. Its direct
//! parent is the process that launched it (an AI app, or a shell or helper
//! acting for one): that parent's executable is what the confirmation dialog
//! names, with its code signature checked by the app. The nearest `.app`
//! further up the process tree is shown separately and marked unverified,
//! because a parent can be re-parented and pids can be reused.
//!
//! Tauri-free so the ancestry walk can be tested with a fake process table.

use std::path::{Component, Path, PathBuf};

/// Longest ancestry walk; a real tree is far shallower.
const MAX_DEPTH: usize = 32;

/// One process as seen by the broker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: i32,
    pub ppid: i32,
    pub path: Option<PathBuf>,
}

/// Process lookups, injectable for tests.
pub trait ProcessTable {
    fn info(&self, pid: i32) -> Option<ProcessInfo>;
}

/// The caller as far as the process tree tells.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallerProcess {
    /// Direct parent of the `mcp` subprocess.
    pub parent_pid: Option<i32>,
    pub parent_path: Option<PathBuf>,
    /// Nearest `.app` bundle above the parent, when it is not the parent's
    /// own bundle. Unverified.
    pub may_come_from: Option<PathBuf>,
}

/// Resolve the parent and the nearest `.app` ancestor of `peer_pid`.
pub fn resolve(table: &dyn ProcessTable, peer_pid: Option<i32>) -> CallerProcess {
    let Some(peer) = peer_pid.and_then(|pid| table.info(pid)) else {
        return CallerProcess::default();
    };
    if peer.ppid <= 1 {
        return CallerProcess::default();
    }
    let Some(parent) = table.info(peer.ppid) else {
        return CallerProcess {
            parent_pid: Some(peer.ppid),
            ..CallerProcess::default()
        };
    };
    let own_bundle = parent.path.as_deref().and_then(app_bundle);
    let mut may_come_from = None;
    let mut current = parent.clone();
    for _ in 0..MAX_DEPTH {
        if current.ppid <= 1 || current.ppid == current.pid {
            break;
        }
        let Some(next) = table.info(current.ppid) else {
            break;
        };
        if let Some(bundle) = next.path.as_deref().and_then(app_bundle) {
            if own_bundle.as_ref() != Some(&bundle) {
                may_come_from = Some(bundle);
            }
            break;
        }
        current = next;
    }
    CallerProcess {
        parent_pid: Some(parent.pid),
        parent_path: parent.path,
        may_come_from,
    }
}

/// The outermost `*.app` directory in `path`, if any.
pub fn app_bundle(path: &Path) -> Option<PathBuf> {
    let mut bundle = PathBuf::new();
    for component in path.components() {
        bundle.push(component);
        if let Component::Normal(name) = component
            && Path::new(name)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        {
            return Some(bundle);
        }
    }
    None
}

/// Display name of a bundle path: `Claude` for `/Applications/Claude.app`.
pub fn bundle_name(bundle: &Path) -> String {
    bundle
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| bundle.to_string_lossy().into_owned())
}

/// The real process table.
pub struct SystemProcesses;

impl ProcessTable for SystemProcesses {
    #[cfg(target_os = "macos")]
    fn info(&self, pid: i32) -> Option<ProcessInfo> {
        use nix::libc;
        if pid <= 0 {
            return None;
        }
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if read != size {
            return None;
        }
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let length =
            unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        let path = (length > 0).then(|| {
            use std::os::unix::ffi::OsStrExt;
            buffer.truncate(length as usize);
            PathBuf::from(std::ffi::OsStr::from_bytes(&buffer))
        });
        Some(ProcessInfo {
            pid,
            ppid: info.pbi_ppid as i32,
            path,
        })
    }

    #[cfg(not(target_os = "macos"))]
    fn info(&self, pid: i32) -> Option<ProcessInfo> {
        if pid <= 0 {
            return None;
        }
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The command name is parenthesised and may contain spaces.
        let after = stat.rsplit_once(')')?.1;
        let ppid = after.split_whitespace().nth(1)?.parse().ok()?;
        let path = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
        Some(ProcessInfo { pid, ppid, path })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Table(HashMap<i32, ProcessInfo>);

    impl Table {
        fn new(rows: &[(i32, i32, &str)]) -> Self {
            Self(
                rows.iter()
                    .map(|(pid, ppid, path)| {
                        (
                            *pid,
                            ProcessInfo {
                                pid: *pid,
                                ppid: *ppid,
                                path: (!path.is_empty()).then(|| PathBuf::from(path)),
                            },
                        )
                    })
                    .collect(),
            )
        }
    }

    impl ProcessTable for Table {
        fn info(&self, pid: i32) -> Option<ProcessInfo> {
            self.0.get(&pid).cloned()
        }
    }

    #[test]
    fn app_parent_has_no_separate_origin() {
        let table = Table::new(&[
            (
                30,
                20,
                "/Applications/OpenNavo.app/Contents/MacOS/opennavo-desktop",
            ),
            (20, 1, "/Applications/Claude.app/Contents/MacOS/Claude"),
        ]);
        let caller = resolve(&table, Some(30));
        assert_eq!(caller.parent_pid, Some(20));
        assert_eq!(
            caller.parent_path.as_deref(),
            Some(Path::new("/Applications/Claude.app/Contents/MacOS/Claude"))
        );
        assert_eq!(caller.may_come_from, None);
    }

    #[test]
    fn helper_parent_points_to_nearest_app_ancestor() {
        let table = Table::new(&[
            (
                40,
                30,
                "/Applications/OpenNavo.app/Contents/MacOS/opennavo-desktop",
            ),
            (30, 20, "/opt/homebrew/bin/node"),
            (20, 10, "/bin/zsh"),
            (10, 1, "/Applications/Cursor.app/Contents/MacOS/Cursor"),
        ]);
        let caller = resolve(&table, Some(40));
        assert_eq!(
            caller.parent_path.as_deref(),
            Some(Path::new("/opt/homebrew/bin/node"))
        );
        assert_eq!(
            caller.may_come_from.as_deref(),
            Some(Path::new("/Applications/Cursor.app"))
        );
        assert_eq!(
            bundle_name(caller.may_come_from.as_deref().unwrap()),
            "Cursor"
        );
    }

    #[test]
    fn nested_helper_bundle_uses_outermost_app() {
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper"
            )),
            Some(PathBuf::from("/Applications/Claude.app"))
        );
        assert_eq!(app_bundle(Path::new("/usr/bin/python3")), None);
    }

    #[test]
    fn unknown_or_orphaned_peers_resolve_to_nothing() {
        let table = Table::new(&[(30, 1, "/x/mcp")]);
        assert_eq!(resolve(&table, None), CallerProcess::default());
        assert_eq!(resolve(&table, Some(99)), CallerProcess::default());
        assert_eq!(resolve(&table, Some(30)), CallerProcess::default());
    }

    #[test]
    fn cycles_and_deep_trees_terminate() {
        let table = Table::new(&[(3, 2, "/a"), (2, 4, "/b"), (4, 2, "/c")]);
        let caller = resolve(&table, Some(3));
        assert_eq!(caller.parent_pid, Some(2));
        assert_eq!(caller.may_come_from, None);
    }

    #[test]
    fn system_table_reads_this_process() {
        let me = SystemProcesses
            .info(std::process::id() as i32)
            .expect("own process");
        assert!(me.ppid > 0);
        assert!(me.path.is_some_and(|path| path.is_absolute()));
    }
}
