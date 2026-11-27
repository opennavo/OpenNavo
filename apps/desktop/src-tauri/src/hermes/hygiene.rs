//! Runtime tree hygiene and backend ownership.
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
//! This module also owns the only safe form of backend cleanup: Hermes allows one
//! `serve`/`dashboard` per host, and a backend left behind by a previous app session
//! keeps the old runtime code bound to the host (the next spawn exits 78). A
//! `HERMES_HOME`-scoped `serve --stop` would also kill a backend the user started
//! manually for the same home, so every backend OpenNavo spawns is recorded in a small
//! ledger with its pid and process start time. The next session terminates exactly the
//! recorded processes whose identity still matches; an unrecorded backend is never
//! touched.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// AppleDouble companions share this prefix on every macOS volume.
const APPLE_DOUBLE_PREFIX: &str = "._";
/// Archive metadata directory written by Finder/Archive Utility.
const MACOSX_DIR: &str = "__MACOSX";

const LEDGER_DIR: &str = ".opennavo";
const LEDGER_FILE: &str = "hermes-backends.json";
const LEDGER_VERSION: u32 = 1;

/// Per-process identity for the app session that spawned a backend. A record with the
/// current id belongs to a live server; every other record is a leftover candidate.
fn session_id() -> &'static str {
    static SESSION: OnceLock<String> = OnceLock::new();
    SESSION.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

/// Repair runs once per app process, and every concurrent caller awaits that same scan.
/// A plain "started" flag would let the second status request probe the runtime (and
/// release the tools pane) while the first one is still stripping `._*` files.
fn tree_repair() -> &'static tokio::sync::OnceCell<()> {
    static CELL: OnceLock<tokio::sync::OnceCell<()>> = OnceLock::new();
    CELL.get_or_init(tokio::sync::OnceCell::new)
}

/// Serializes every read/write of the backend ledger. The file is tiny and every
/// critical section is short (orphan termination runs in a blocking task).
/// Serialize one ledger file, not every ledger in the process. Parallel tests (and a future
/// multi-root app) have independent temp roots; one root's slow reap must not make another
/// lease's drop skip its cleanup.
#[cfg(unix)]
type LedgerGuard = nix::fcntl::Flock<std::fs::File>;

#[cfg(not(unix))]
type LedgerGuard = std::sync::MutexGuard<'static, ()>;

#[cfg(not(unix))]
fn ledger_lock(_path: &Path) -> Option<LedgerGuard> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    Some(
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    )
}

#[cfg(not(unix))]
fn ledger_try_lock(_path: &Path) -> Option<LedgerGuard> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.try_lock().ok()
}

#[cfg(unix)]
fn ledger_file(path: &Path) -> Option<std::fs::File> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("json.lock"))
        .ok()
}

#[cfg(test)]
const LEDGER_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(50);
#[cfg(not(test))]
const LEDGER_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(unix)]
fn ledger_lock(path: &Path) -> Option<LedgerGuard> {
    ledger_lock_with_timeout(path, LEDGER_LOCK_TIMEOUT)
}

#[cfg(unix)]
fn ledger_lock_with_timeout(path: &Path, timeout: std::time::Duration) -> Option<LedgerGuard> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(guard) = ledger_try_lock(path) {
            return Some(guard);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn ledger_try_lock(path: &Path) -> Option<LedgerGuard> {
    let file = ledger_file(path)?;
    nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock).ok()
}

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
/// Concurrent callers await the same scan; a caller arriving after it finishes returns
/// immediately.
pub(crate) async fn repair_runtime_tree_once(app: &AppHandle) {
    let Ok(root) = super::runtime_root(app) else {
        return;
    };
    if !root.is_dir() {
        return;
    }
    tree_repair()
        .get_or_init(|| async move {
            match tokio::task::spawn_blocking(move || strip_apple_double(&root)).await {
                Ok(Ok(0)) => {}
                Ok(Ok(removed)) => {
                    log::warn!("Hermes runtime repair: removed {removed} AppleDouble entries")
                }
                Ok(Err(error)) => log::warn!("Hermes runtime repair failed: {error}"),
                Err(error) => log::warn!("Hermes runtime repair task failed: {error}"),
            }
        })
        .await;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct BackendChild {
    pid: u32,
    /// Kernel start time, same format as [`process_info`].
    started: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackendRecord {
    pid: u32,
    /// Kernel process start time. Empty means unverifiable, never a kill.
    started: String,
    home: String,
    profile: String,
    /// App-session id that spawned it (see [`session_id`]).
    owner: String,
    /// Children snapshotted before the first signal. They are reparented to launchd when
    /// the backend exits, so they cannot be discovered from the process tree afterwards.
    #[serde(default)]
    children: Vec<BackendChild>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct BackendLedger {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    backends: Vec<BackendRecord>,
}

fn ledger_path(root_home: &Path) -> PathBuf {
    // Inside HERMES_HOME: the runtime directory is replaced on update, the home is not.
    // Keeping it here also means a test/development home is self-contained.
    root_home.join(LEDGER_DIR).join(LEDGER_FILE)
}

fn read_ledger(path: &Path) -> BackendLedger {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return BackendLedger::default();
    };
    serde_json::from_str(&raw).unwrap_or_else(|error| {
        log::warn!(
            "Hermes backend ledger is unreadable ({}): {error}",
            path.display()
        );
        BackendLedger::default()
    })
}

fn write_ledger(path: &Path, ledger: &BackendLedger) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(ledger).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, data)?;
    std::fs::rename(tmp, path)
}

/// A live backend's ledger record. Dropping the lease removes the record once neither the
/// backend nor any child it snapshotted is alive; the process itself is stopped by
/// `GatewayServer`'s own drop.
pub(crate) struct BackendLease {
    path: PathBuf,
    pid: u32,
    started: String,
}

impl BackendLease {
    /// `true` only while the pid still names the process this lease recorded. A reused pid
    /// is never signalled.
    pub(crate) fn identity_matches(&self) -> bool {
        identity_matches(self.pid, &self.started)
    }

    /// Snapshot descendants **before** the first signal. Once the backend exits its
    /// children are reparented to launchd and cannot be found from its process tree, so
    /// the snapshot is the only way a later reap can still stop them.
    pub(crate) fn snapshot_children(&self) {
        if !identity_matches(self.pid, &self.started) {
            return;
        }
        let children = descendant_snapshot(self.pid);
        if children.is_empty() {
            return;
        }
        // Never block a runtime worker on the ledger; a reap that holds it snapshots the
        // same tree before its own signal.
        let Some(_guard) = ledger_try_lock(&self.path) else {
            log::warn!("Could not snapshot Hermes backend children: ledger busy");
            return;
        };
        let mut ledger = read_ledger(&self.path);
        let Some(record) = ledger
            .backends
            .iter_mut()
            .find(|entry| entry.pid == self.pid && entry.started == self.started)
        else {
            return;
        };
        let mut changed = false;
        for child in children {
            if !record
                .children
                .iter()
                .any(|known| known.pid == child.pid && known.started == child.started)
            {
                record.children.push(child);
                changed = true;
            }
        }
        let before = record.children.len();
        record
            .children
            .retain(|child| identity_matches(child.pid, &child.started));
        changed |= record.children.len() != before;
        if changed && let Err(error) = write_ledger(&self.path, &ledger) {
            log::warn!("Could not snapshot Hermes backend children: {error}");
        }
    }
}

impl Drop for BackendLease {
    fn drop(&mut self) {
        // Keep the record while the root **or a recorded child** is still alive: a child
        // can outlive its parent and keep `state.db-wal` open.
        if identity_matches(self.pid, &self.started) {
            return;
        }
        // Never block a runtime worker on the ledger: if a reap is running it will prune
        // this record once the processes are gone.
        let Some(_guard) = ledger_try_lock(&self.path) else {
            return;
        };
        let mut ledger = read_ledger(&self.path);
        let Some(index) = ledger
            .backends
            .iter()
            .position(|entry| entry.pid == self.pid && entry.started == self.started)
        else {
            return;
        };
        let children_alive = ledger.backends[index]
            .children
            .iter()
            .any(|child| identity_matches(child.pid, &child.started));
        if children_alive {
            return;
        }
        ledger.backends.remove(index);
        if let Err(error) = write_ledger(&self.path, &ledger) {
            log::warn!("Could not remove Hermes backend record: {error}");
        }
    }
}

/// Record a backend OpenNavo just spawned, so a later session can identify and stop it
/// without touching a backend the user started. Returns `None` when the process identity
/// cannot be read; an unverifiable backend is never recorded (and so never reaped).
pub(crate) fn record_backend(
    root_home: &Path,
    home: &Path,
    profile: &str,
    pid: u32,
) -> Option<BackendLease> {
    if pid == 0 {
        return None;
    }
    let Some(started) = process_start_time(pid) else {
        log::warn!("Could not record Hermes backend {pid}: process identity unavailable");
        return None;
    };
    let path = ledger_path(root_home);
    let record = BackendRecord {
        pid,
        started: started.clone(),
        home: home.display().to_string(),
        profile: profile.to_owned(),
        owner: session_id().to_owned(),
        children: Vec::new(),
    };
    let Some(_lease_guard) = ledger_lock(&path) else {
        log::warn!("Could not record Hermes backend {pid}: ledger lock unavailable");
        return None;
    };
    let mut ledger = read_ledger(&path);
    ledger.version = LEDGER_VERSION;
    ledger.backends.retain(|entry| entry.pid != pid);
    ledger.backends.push(record);
    if let Err(error) = write_ledger(&path, &ledger) {
        log::warn!("Could not record Hermes backend {pid}: {error}");
        return None;
    }
    Some(BackendLease { path, pid, started })
}

#[derive(Debug, Default)]
pub(crate) struct ReapReport {
    /// Profiles whose leftover backend was stopped.
    pub(crate) reaped: Vec<String>,
    /// `(profile, pid, reason)` for leftovers that survived the stop.
    pub(crate) failed: Vec<(String, u32, String)>,
}

#[derive(Debug, PartialEq, Eq)]
enum ReapDecision {
    Keep,
    Drop,
    Stop,
}

/// Decide what to do with one ledger record.
///
/// * Neither the backend nor any recorded child still matches its process identity:
///   the record is stale and is dropped. A reused pid is an unrelated process, so it is
///   never signalled.
/// * A record owned by the current app session is the live managed backend: keep it,
///   unless the caller is reaping everything (the installer stopped the slot first).
/// * Otherwise stop the backend (if alive) and every recorded child.
fn reap_decision(
    root_alive: bool,
    children_alive: bool,
    same_session: bool,
    include_current: bool,
) -> ReapDecision {
    if !root_alive && !children_alive {
        return ReapDecision::Drop;
    }
    if same_session && !include_current {
        return ReapDecision::Keep;
    }
    ReapDecision::Stop
}

/// Reap backends recorded by earlier app sessions. `home_filter` limits the sweep to one
/// profile home; `include_current` also stops backends from this session (used by the
/// installer after it has taken and stopped the gateway slot).
pub(crate) async fn reap_owned_backends(
    root_home: &Path,
    home_filter: Option<&Path>,
    include_current: bool,
) -> ReapReport {
    let path = ledger_path(root_home);
    let filter = home_filter.map(|home| home.display().to_string());
    tokio::task::spawn_blocking(move || reap_sync(&path, filter.as_deref(), include_current))
        .await
        .unwrap_or_default()
}

fn reap_sync(path: &Path, home_filter: Option<&str>, include_current: bool) -> ReapReport {
    let Some(_guard) = ledger_lock(path) else {
        // Never signal without the ledger lock: the next launch could not verify the stop.
        let mut report = ReapReport::default();
        report
            .failed
            .push(("unknown".to_owned(), 0, "backend ledger is busy".to_owned()));
        return report;
    };
    let ledger = read_ledger(path);
    let original_len = ledger.backends.len();
    let session = session_id();
    let mut report = ReapReport::default();
    let mut kept = Vec::new();
    let mut to_stop = Vec::new();
    for entry in ledger.backends {
        if let Some(filter) = home_filter
            && entry.home != filter
        {
            kept.push(entry);
            continue;
        }
        let root_alive = identity_matches(entry.pid, &entry.started);
        let children_alive = entry
            .children
            .iter()
            .any(|child| identity_matches(child.pid, &child.started));
        match reap_decision(
            root_alive,
            children_alive,
            entry.owner == session,
            include_current,
        ) {
            ReapDecision::Keep => kept.push(entry),
            ReapDecision::Drop => {}
            ReapDecision::Stop => to_stop.push(entry),
        }
    }

    for entry in &mut to_stop {
        // Discover and persist the descendants before the first signal. The parent is about
        // to exit and reparent them, so if this process dies mid-reap (or the reap crashes)
        // an unsnapshotted child would be unidentifiable forever.
        snapshot_children_before_signal(entry);
    }
    if !to_stop.is_empty() {
        // The pre-signal write keeps the verified snapshot durable before any process can
        // disappear. The final write below then records what actually stopped.
        let mut before_signal = kept.clone();
        before_signal.extend(to_stop.iter().cloned());
        if let Err(error) = write_ledger(
            path,
            &BackendLedger {
                version: LEDGER_VERSION,
                backends: before_signal,
            },
        ) {
            log::warn!("Could not record Hermes backend children before stopping: {error}");
            // No trusted snapshot means no signal: a crash here must not lose verification.
            let mut report = ReapReport::default();
            for entry in &to_stop {
                report.failed.push((
                    entry.profile.clone(),
                    entry.pid,
                    "children could not be recorded before stopping".to_owned(),
                ));
            }
            return report;
        }
    }

    for entry in &to_stop {
        match terminate(entry.pid, &entry.started, &entry.children) {
            None => report.reaped.push(entry.profile.clone()),
            Some(survivors) => {
                report.failed.push((
                    entry.profile.clone(),
                    entry.pid,
                    "the backend or one of its children is still running".to_owned(),
                ));
                let mut kept_entry = entry.clone();
                kept_entry.children = survivors;
                kept.push(kept_entry);
            }
        }
    }

    // One write at the end: a crash mid-stop leaves the old file, so the next launch
    // retries the same records instead of losing an orphan.
    if original_len != kept.len() || !to_stop.is_empty() {
        let updated = BackendLedger {
            version: LEDGER_VERSION,
            backends: kept,
        };
        if let Err(error) = write_ledger(path, &updated) {
            log::warn!("Could not update Hermes backend ledger: {error}");
        }
    }
    report
}

/// Record the live descendants of a backend that is about to be signalled.
///
/// This runs before any signal: after the parent exits the children are reparented to
/// launchd and can no longer be discovered from its tree, so the ledger must hold their
/// verified identities first. A stale record (pid reused) contributes nothing.
fn snapshot_children_before_signal(entry: &mut BackendRecord) {
    if !identity_matches(entry.pid, &entry.started) {
        return;
    }
    for child in descendant_snapshot(entry.pid) {
        if !entry
            .children
            .iter()
            .any(|known| known.pid == child.pid && known.started == child.started)
        {
            entry.children.push(child);
        }
    }
    entry
        .children
        .retain(|child| identity_matches(child.pid, &child.started));
}

/// Result of the post-install occupancy scan. `Unavailable` is deliberately distinct from
/// an empty pid list: a failed probe must not be reported as "no backend".
pub(crate) enum BackendScan {
    Pids(Vec<u32>),
    Unavailable,
}

/// Ask the pinned runtime which `serve`/`dashboard` processes belong to `home`.
///
/// This is the official dashboard's own scan, so it resolves each process's `HERMES_HOME`
/// (including profile re-homing) exactly like the backend does. It is used after an
/// install to report a backend that is not in OpenNavo's ledger (for example one left by
/// a build that predates the ledger, or one the user started manually). The probe never
/// stops anything; a runtime without these helpers exits non-zero and is reported as
/// unavailable.
pub(crate) async fn scan_backend_pids(bin: &Path, home: &Path) -> BackendScan {
    const SCAN: &str = r#"
import json, sys
from hermes_cli.dashboard_procs import _scan_dashboard_processes, _pids_owned_by_hermes_home
pids = sorted(_pids_owned_by_hermes_home([p for p, _ in _scan_dashboard_processes()], sys.argv[1]))
print(json.dumps(pids))
"#;
    let Some(python) = super::runtime_python(bin) else {
        return BackendScan::Unavailable;
    };
    let Some(root) = bin.parent().and_then(Path::parent) else {
        return BackendScan::Unavailable;
    };
    let mut command = tokio::process::Command::new(python);
    super::apply_runtime_environment(&mut command);
    command
        .arg("-c")
        .arg(SCAN)
        .arg(home)
        .env("PYTHONPATH", root.join("site"))
        .env("HERMES_HOME", home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        // A timeout drops the `output()` future; this makes that drop kill and reap the
        // probe instead of leaving it running against a slow profile.
        .kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(15), command.output()).await {
        Ok(Ok(output)) if output.status.success() => match serde_json::from_slice(&output.stdout) {
            Ok(pids) => BackendScan::Pids(pids),
            Err(error) => {
                log::warn!("Hermes backend scan returned invalid JSON: {error}");
                BackendScan::Unavailable
            }
        },
        Ok(Ok(output)) => {
            log::warn!("Hermes backend scan exited {:?}", output.status.code());
            BackendScan::Unavailable
        }
        Ok(Err(error)) => {
            log::warn!("Hermes backend scan failed: {error}");
            BackendScan::Unavailable
        }
        Err(_) => {
            log::warn!("Hermes backend scan timed out");
            BackendScan::Unavailable
        }
    }
}

/// `(profile, home)` for the root and every named profile under it.
pub(crate) fn profile_homes(root_home: &Path) -> Vec<(String, PathBuf)> {
    let mut homes = vec![("default".to_owned(), root_home.to_path_buf())];
    let Ok(entries) = std::fs::read_dir(root_home.join("profiles")) else {
        return homes;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if super::profiles::name_ok(&name) {
            homes.push((name, entry.path()));
        }
    }
    homes
}

/// Grace the backend gets to exit cleanly before SIGKILL. Matches Hermes' own
/// `_POSIX_TERM_GRACE_SECONDS`; a shorter window cuts off its database teardown.
const TERM_GRACE: Duration = Duration::from_secs(10);
/// Wait for SIGKILL to take effect.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// Grace for dashboard children that outlived their backend.
const DESCENDANT_GRACE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// A process's kernel-verified parent and start time, read in one syscall.
struct ProcessInfo {
    ppid: u32,
    started: String,
}

/// Stable process identity: the kernel's process start time as `seconds.microseconds`.
///
/// `ps -o lstart` prints local time, so a timezone change between recording and reaping
/// made the same live process look stale. `proc_pidinfo` returns the kernel's UTC start
/// time and is precise enough that a reused pid cannot collide by accident. The parent is
/// returned by the same call so a tree walk never pairs one process's parent with
/// another process's start time.
#[cfg(target_os = "macos")]
fn process_info(pid: u32) -> Option<ProcessInfo> {
    use std::mem::MaybeUninit;
    if pid == 0 {
        return None;
    }
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    // SAFETY: proc_pidinfo writes at most `size` bytes into the buffer we provide and
    // returns the number written; the buffer is sized for proc_bsdinfo.
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as libc::c_int,
        )
    };
    if read != size as libc::c_int {
        return None;
    }
    // SAFETY: the call filled the whole struct, as checked above.
    let info = unsafe { info.assume_init() };
    if info.pbi_status == libc::SZOMB {
        return None;
    }
    Some(ProcessInfo {
        ppid: info.pbi_ppid,
        started: format!("{}.{:06}", info.pbi_start_tvsec, info.pbi_start_tvusec),
    })
}

#[cfg(not(target_os = "macos"))]
fn process_info(pid: u32) -> Option<ProcessInfo> {
    if pid == 0 {
        return None;
    }
    // `TZ` keeps the text stable across timezone changes on platforms without proc_pidinfo.
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=,lstart=,stat=", "-p", &pid.to_string()])
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let ppid: u32 = parts.next()?.parse().ok()?;
    let started: Vec<&str> = parts.by_ref().take(5).collect();
    let state = parts.next()?;
    if started.len() != 5 || state.starts_with('Z') {
        return None;
    }
    Some(ProcessInfo {
        ppid,
        started: started.join(" "),
    })
}

pub(crate) fn process_identity(pid: u32) -> Option<String> {
    process_start_time(pid)
}

pub(crate) fn identity_matches_pid(pid: u32, started: &str) -> bool {
    identity_matches(pid, started)
}

fn process_start_time(pid: u32) -> Option<String> {
    process_info(pid).map(|info| info.started)
}

fn identity_matches(pid: u32, started: &str) -> bool {
    !started.is_empty() && process_start_time(pid).as_deref() == Some(started)
}

/// Signal only while the pid still names the verified process.
///
/// The check and `kill` are not atomic (macOS has no pidfd), but re-checking immediately
/// before every signal keeps the reuse window at the syscall boundary instead of the
/// reaper's multi-second wait.
fn signal_verified(pid: u32, started: &str, signal: libc::c_int) -> bool {
    if !identity_matches(pid, started) {
        return false;
    }
    // SAFETY: kill(2) with a signal number and a pid has no memory-safety requirements.
    unsafe {
        libc::kill(pid as libc::c_int, signal);
    }
    true
}

/// Wait until the verified process is gone. A reused pid counts as gone: the recorded
/// process no longer exists and must never be signalled.
fn wait_identity_gone(pid: u32, started: &str, grace: Duration) -> bool {
    let deadline = std::time::Instant::now() + grace;
    loop {
        if !identity_matches(pid, started) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn process_table() -> Vec<(u32, u32)> {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,ppid="])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .collect()
}

/// Snapshot descendants with their identities before signalling the root: once the root
/// exits they are reparented and can no longer be discovered from the process tree.
fn descendant_snapshot(root: u32) -> Vec<BackendChild> {
    let table = process_table();
    let mut found: Vec<BackendChild> = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for (pid, ppid) in &table {
            if *ppid != parent || *pid == root || found.iter().any(|child| child.pid == *pid) {
                continue;
            }
            // `process_info` returns parent + start in one kernel read. Confirm the parent
            // matches the topology snapshot, so a pid reused between the two reads cannot
            // pair the old relation with the new process's identity.
            let Some(info) = process_info(*pid) else {
                continue;
            };
            if info.ppid != *ppid {
                continue;
            }
            found.push(BackendChild {
                pid: *pid,
                started: info.started,
            });
            frontier.push(*pid);
        }
    }
    found
}

fn wait_all_gone(processes: &[BackendChild], grace: Duration) -> Vec<BackendChild> {
    let deadline = std::time::Instant::now() + grace;
    loop {
        let alive: Vec<BackendChild> = processes
            .iter()
            .filter(|child| identity_matches(child.pid, &child.started))
            .cloned()
            .collect();
        if alive.is_empty() || std::time::Instant::now() >= deadline {
            return alive;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Stop the verified backend and every child recorded before the first signal.
///
/// `recorded_children` matters when the backend already exited: its children were
/// reparented to launchd, so a fresh tree walk cannot find them anymore. Returns `None`
/// when the root and all children are gone; otherwise the children that survived, which
/// the caller keeps for the next attempt.
fn terminate(
    pid: u32,
    started: &str,
    recorded_children: &[BackendChild],
) -> Option<Vec<BackendChild>> {
    let root_alive = identity_matches(pid, started);
    let mut children: Vec<BackendChild> = recorded_children
        .iter()
        .filter(|child| identity_matches(child.pid, &child.started))
        .cloned()
        .collect();
    if root_alive {
        for child in descendant_snapshot(pid) {
            if !children
                .iter()
                .any(|known| known.pid == child.pid && known.started == child.started)
            {
                children.push(child);
            }
        }
        signal_verified(pid, started, libc::SIGTERM);
    }
    for child in &children {
        signal_verified(child.pid, &child.started, libc::SIGTERM);
    }

    if root_alive && !wait_identity_gone(pid, started, TERM_GRACE) {
        signal_verified(pid, started, libc::SIGKILL);
        let _ = wait_identity_gone(pid, started, KILL_GRACE);
    }

    let mut survivors = wait_all_gone(&children, DESCENDANT_GRACE);
    for child in &survivors {
        signal_verified(child.pid, &child.started, libc::SIGKILL);
    }
    survivors = wait_all_gone(&survivors, KILL_GRACE);
    let root_gone = !identity_matches(pid, started);
    if root_gone && survivors.is_empty() {
        None
    } else {
        Some(survivors)
    }
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

    #[test]
    fn reap_decision_keeps_a_record_while_the_root_or_a_child_is_alive() {
        // Neither the root nor a child matches: forget the record.
        assert_eq!(
            reap_decision(false, false, false, false),
            ReapDecision::Drop
        );
        // A child can outlive its root; the record must survive until it is gone too.
        assert_eq!(reap_decision(false, true, false, false), ReapDecision::Stop);
        // Our own live backend is kept unless an install explicitly reaps the session.
        assert_eq!(reap_decision(true, false, true, false), ReapDecision::Keep);
        assert_eq!(reap_decision(true, false, true, true), ReapDecision::Stop);
        // A backend from a previous session is stopped.
        assert_eq!(reap_decision(true, false, false, false), ReapDecision::Stop);
        assert_eq!(reap_decision(false, true, true, true), ReapDecision::Stop);
    }

    /// A ledger held elsewhere is not entered on a guess; the caller must skip the operation.
    #[cfg(unix)]
    #[test]
    fn a_busy_ledger_returns_no_guard() {
        let dir = tempfile::tempdir().unwrap();
        let path = ledger_path(dir.path());
        let held = ledger_lock(&path).expect("first lock");
        assert!(ledger_lock_with_timeout(&path, std::time::Duration::from_millis(20)).is_none());
        drop(held);
        assert!(ledger_lock_with_timeout(&path, std::time::Duration::from_millis(20)).is_some());
    }

    /// A busy ledger must not publish a backend record: the caller cannot manage that child.
    #[cfg(unix)]
    #[test]
    fn a_busy_ledger_refuses_to_record_a_backend() {
        let dir = tempfile::tempdir().unwrap();
        let root_home = dir.path().join("hermes");
        std::fs::create_dir_all(&root_home).unwrap();
        let path = ledger_path(&root_home);
        let held = ledger_lock(&path).expect("first lock");
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        assert!(record_backend(&root_home, &root_home, "default", child.id()).is_none());
        let _ = child.kill();
        let _ = child.wait();
        drop(held);
        assert!(read_ledger(&path).backends.is_empty());
    }

    #[test]
    fn records_and_forgets_a_backend_lease() {
        let data_root = tempfile::tempdir().unwrap();
        let root_home = data_root.path().join("hermes");
        std::fs::create_dir_all(&root_home).unwrap();

        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let lease = record_backend(&root_home, &root_home, "default", child.id()).expect("lease");
        let path = ledger_path(&root_home);
        let ledger = read_ledger(&path);
        assert_eq!(ledger.backends.len(), 1);
        assert_eq!(ledger.backends[0].profile, "default");

        // A live process keeps its record: a later reap must still be able to verify it.
        drop(lease);
        assert_eq!(read_ledger(&path).backends.len(), 1);

        // Once the process is gone, dropping the lease removes the record.
        let lease = record_backend(&root_home, &root_home, "default", child.id()).expect("lease");
        child.kill().unwrap();
        let _ = child.wait();
        drop(lease);
        assert!(read_ledger(&path).backends.is_empty());
    }

    #[test]
    fn terminate_never_signals_a_pid_whose_identity_changed() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id();
        // A stale identity returns without signalling: this pid may now be someone else.
        assert!(terminate(pid, "0.000000", &[]).is_none());
        assert!(process_start_time(pid).is_some());

        let started = process_start_time(pid).expect("identity");
        assert!(terminate(pid, &started, &[]).is_none());
        let _ = child.wait();
        assert!(process_start_time(pid).is_none());
    }

    #[tokio::test]
    async fn reaps_a_recorded_backend_from_a_previous_session() {
        let data_root = tempfile::tempdir().unwrap();
        let root_home = data_root.path().join("hermes");
        std::fs::create_dir_all(&root_home).unwrap();

        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id();
        let started = process_start_time(pid).expect("process identity");
        let path = ledger_path(&root_home);
        write_ledger(
            &path,
            &BackendLedger {
                version: LEDGER_VERSION,
                backends: vec![BackendRecord {
                    pid,
                    started,
                    home: root_home.display().to_string(),
                    profile: "default".to_owned(),
                    owner: "previous-session".to_owned(),
                    children: Vec::new(),
                }],
            },
        )
        .unwrap();

        let report = reap_owned_backends(&root_home, None, false).await;
        assert_eq!(report.reaped, vec!["default".to_owned()]);
        assert!(report.failed.is_empty());
        let _ = child.wait();
        assert!(process_start_time(pid).is_none());
        assert!(read_ledger(&path).backends.is_empty());
    }

    #[tokio::test]
    async fn reaps_recorded_children_after_their_parent_exits() {
        let data_root = tempfile::tempdir().unwrap();
        let root_home = data_root.path().join("hermes");
        std::fs::create_dir_all(&root_home).unwrap();

        // A stand-in backend with one long-lived child.
        let mut parent = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .spawn()
            .unwrap();
        let parent_pid = parent.id();
        let parent_started = process_start_time(parent_pid).expect("parent identity");
        let mut children = Vec::new();
        for _ in 0..50 {
            children = descendant_snapshot(parent_pid);
            if !children.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!children.is_empty(), "shell child did not start");

        // The backend exits first. Its child is reparented to launchd, so a fresh tree
        // walk can no longer find it — only the recorded identity can.
        let _ = parent.kill();
        let _ = parent.wait();
        assert!(descendant_snapshot(parent_pid).is_empty());

        let path = ledger_path(&root_home);
        write_ledger(
            &path,
            &BackendLedger {
                version: LEDGER_VERSION,
                backends: vec![BackendRecord {
                    pid: parent_pid,
                    started: parent_started,
                    home: root_home.display().to_string(),
                    profile: "default".to_owned(),
                    owner: "previous-session".to_owned(),
                    children,
                }],
            },
        )
        .unwrap();

        let report = reap_owned_backends(&root_home, None, false).await;
        assert_eq!(report.reaped, vec!["default".to_owned()]);
        assert!(report.failed.is_empty());
        assert!(read_ledger(&path).backends.is_empty());
    }

    /// The snapshot a reap persists must exist before the first signal: once the parent is
    /// gone a fresh tree walk finds nothing. A stale identity must not contribute a child.
    #[test]
    fn snapshots_children_before_the_first_signal() {
        let mut parent = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let pid = parent.id();
        let started = process_start_time(pid).expect("parent identity");
        let mut record = BackendRecord {
            pid,
            started: started.clone(),
            home: "/tmp/hermes".into(),
            profile: "default".into(),
            owner: "session".into(),
            children: Vec::new(),
        };
        snapshot_children_before_signal(&mut record);
        assert!(
            !record.children.is_empty(),
            "the live child must be recorded before the parent is signalled"
        );
        let children = record.children.clone();

        // A reused pid is not this record's process: it contributes no children.
        record.started = "0.000000".into();
        record.children.clear();
        snapshot_children_before_signal(&mut record);
        assert!(record.children.is_empty());

        let _ = terminate(pid, &started, &children);
        let _ = parent.wait();
    }
}
