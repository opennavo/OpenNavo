//! One-time migration of credentials that older builds kept in the macOS Keychain.
//!
//! Older builds stored provider keys, panel sessions and remote tokens as generic
//! passwords under `com.opennavo.desktop.hermes`. They now live in `<HERMES_HOME>/.env`
//! and `<data_root>/.opennavo/session.json`, so the
//! old items are read once, copied over, and deleted.
//!
//! TODO(remove after one release): this is the only module under `hermes/` that may
//! mention the Keychain. Delete it together with `migrated.json` handling once builds
//! without the Keychain have shipped.
//!
//! The migration is best effort and never blocks startup: it runs on a detached thread,
//! `security` may ask the user for approval once, and every failure is skipped (the user
//! simply re-enters the key).

use std::path::{Path, PathBuf};

use std::sync::atomic::{AtomicBool, Ordering};

use super::{env_store, provider_key_env};

/// Set before an uninstall deletes the data root; the detached migration must not recreate it.
static SUSPENDED: AtomicBool = AtomicBool::new(false);
/// Serializes the migration's key+marker commit with `suspend()`: an uninstall cannot remove
/// the root between the .env write and the marker write.
static MIGRATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn suspend() {
    let _guard = MIGRATION_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    SUSPENDED.store(true, Ordering::SeqCst);
}

fn suspended() -> bool {
    SUSPENDED.load(Ordering::SeqCst)
}

const SERVICE: &str = "com.opennavo.desktop.hermes";
const MARKER_DIR: &str = ".opennavo";
const MARKER_FILE: &str = "migrated.json";
const MARKER_VERSION: u64 = 1;

/// Providers whose old credential was an API key. OAuth / CLI-backed providers
/// (`codex`, `claude-code`, `copilot`) are skipped on purpose: writing
/// `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for them would preempt the login that
/// upstream is meant to use.
const MIGRATED_PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "nous",
    "local",
    "custom",
    "opencode",
    "opencode-go",
];

fn marker_path(data_root: &Path) -> PathBuf {
    data_root.join(MARKER_DIR).join(MARKER_FILE)
}

fn already_migrated(data_root: &Path) -> bool {
    let Ok(bytes) = std::fs::read(marker_path(data_root)) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| value.get("version").and_then(serde_json::Value::as_u64))
        .is_some_and(|version| version >= MARKER_VERSION)
}

fn write_marker(data_root: &Path) -> Result<(), crate::AppError> {
    let mut body = serde_json::json!({
        "version": MARKER_VERSION,
        "at": chrono::Utc::now().to_rfc3339(),
    });
    body["providers"] = serde_json::json!(MIGRATED_PROVIDERS);
    let mut bytes = serde_json::to_vec_pretty(&body)?;
    bytes.push(b'\n');
    env_store::atomic_write(&marker_path(data_root), &bytes)
}

/// Read one generic password. `None` on any failure, including the user declining the
/// Keychain prompt, a locked Keychain, or a missing item.
fn read_keychain(account: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        (!value.is_empty()).then_some(value)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        None
    }
}

fn delete_keychain(account: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", account])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
    }
}

/// The Keychain read happens outside the file lock (it may prompt); the write then checks
/// under the lock whether a newer key appeared, so a manual save is never overwritten.
#[cfg(test)]
fn migrate_with(
    hermes_home: &Path,
    read: impl Fn(&str) -> Option<String>,
    mut delete: impl FnMut(&str),
    paused: impl Fn() -> bool,
) {
    for provider in MIGRATED_PROVIDERS {
        if paused() {
            return;
        }
        let variable = provider_key_env(provider);
        let Some(key) = read(provider) else {
            continue;
        };
        // Existing value, suspended uninstall, or a failed write keeps the old entry.
        if let Ok(true) = env_store::set_env_value_if_absent(hermes_home, variable, &key, &paused) {
            delete(provider);
        }
    }
}

/// Commit keys and the marker under the same short lock `suspend()` takes. Keychain reads
/// still happen outside it. A paused (uninstalling) run creates neither the home nor `.opennavo`.
fn commit_migration(
    data_root: &Path,
    hermes_home: &Path,
    read: impl Fn(&str) -> Option<String>,
    mut delete: impl FnMut(&str),
    paused: impl Fn() -> bool,
) {
    // Keychain reads (which can prompt or block) happen before the short commit fence.
    let mut keys: Vec<(&str, String)> = Vec::new();
    for provider in MIGRATED_PROVIDERS {
        // Stop asking the Keychain as soon as an uninstall starts; a prompt/read can block.
        if paused() {
            break;
        }
        if env_store::env_has(hermes_home, provider_key_env(provider)) {
            continue;
        }
        if let Some(key) = read(provider) {
            keys.push((*provider, key));
        }
    }
    let mut inserted = Vec::new();
    {
        let _guard = MIGRATION_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if paused() {
            return;
        }
        for (provider, key) in &keys {
            if paused() {
                break;
            }
            let variable = provider_key_env(provider);
            if let Ok(true) =
                env_store::set_env_value_if_absent(hermes_home, variable, key, &paused)
            {
                inserted.push(*provider);
            }
        }
        if paused() {
            return;
        }
        if let Err(error) = write_marker(data_root) {
            log::warn!("Hermes credential migration marker: {error}");
        }
    }
    // Deletes can also block in `security`; they run after the fence is released.
    for provider in inserted {
        delete(provider);
    }
}
/// Run the migration once, on a detached thread, without blocking the caller.
pub fn spawn(data_root: PathBuf, hermes_home: PathBuf) {
    if already_migrated(&data_root) {
        return;
    }
    std::thread::spawn(move || {
        commit_migration(
            &data_root,
            &hermes_home,
            read_keychain,
            delete_keychain,
            suspended,
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_once_per_data_root() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!already_migrated(dir.path()));
        write_marker(dir.path()).unwrap();
        assert!(already_migrated(dir.path()));
        // The marker file is owner-only, like every other credential-adjacent file.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(marker_path(dir.path()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn a_manual_key_that_lands_during_the_keychain_read_wins() {
        let dir = tempfile::tempdir().unwrap();
        env_store::set_env_value(dir.path(), "OPENAI_API_KEY", "sk-manual").unwrap();
        let mut deleted = false;
        migrate_with(
            dir.path(),
            |provider| (provider == "openai").then(|| "sk-old-keychain".to_owned()),
            |_| deleted = true,
            || false,
        );
        assert_eq!(
            env_store::env_value(dir.path(), "OPENAI_API_KEY").as_deref(),
            Some("sk-manual")
        );
        assert!(!deleted, "the skipped Keychain entry must be kept");
    }

    #[test]
    fn inserts_an_absent_key_and_removes_the_old_entry() {
        let dir = tempfile::tempdir().unwrap();
        let mut deleted = Vec::new();
        migrate_with(
            dir.path(),
            |provider| (provider == "openai").then(|| "sk-from-keychain".to_owned()),
            |provider| deleted.push(provider.to_owned()),
            || false,
        );
        assert_eq!(
            env_store::env_value(dir.path(), "OPENAI_API_KEY").as_deref(),
            Some("sk-from-keychain")
        );
        assert_eq!(deleted, vec!["openai".to_owned()]);
    }

    #[test]
    fn a_suspended_write_does_not_recreate_the_home() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let inserted =
            env_store::set_env_value_if_absent(&home, "OPENAI_API_KEY", "sk-old", || true).unwrap();
        assert!(!inserted);
        assert!(!home.join(".env").exists());
    }

    #[test]
    fn skips_a_key_that_is_already_in_dot_env() {
        let dir = tempfile::tempdir().unwrap();
        env_store::set_env_value(dir.path(), "OPENAI_API_KEY", "sk-cli").unwrap();
        // Inject the reader so a unit test never queries the real Keychain.
        let mut deleted = false;
        migrate_with(
            dir.path(),
            |provider| (provider == "openai").then(|| "sk-keychain-old".to_owned()),
            |_| deleted = true,
            || false,
        );
        assert_eq!(
            env_store::env_value(dir.path(), "OPENAI_API_KEY").as_deref(),
            Some("sk-cli")
        );
        assert!(!deleted);
    }

    /// `suspend()` must not wait for a Keychain read that is already blocking; after it
    /// returns, the commit fence must refuse to create the data root.
    #[test]
    fn suspend_completes_while_a_keychain_read_is_blocked() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let data_root = dir.path().join("data");
        let home = data_root.join("hermes");
        let paused = std::sync::Arc::new(AtomicBool::new(false));
        let commit_paused = paused.clone();
        let suspend_paused = paused.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (suspended_tx, suspended_rx) = std::sync::mpsc::channel::<()>();
        let thread_root = data_root.clone();
        let thread_home = home.clone();
        std::thread::scope(|scope| {
            let commit = scope.spawn(move || {
                commit_migration(
                    &thread_root,
                    &thread_home,
                    |provider| {
                        if provider == "openai" {
                            // Only the commit thread holds the sender; a paused provider is
                            // not "started", so this recv can be bounded.
                            let _ = started_tx.send(());
                            let _ = release_rx.recv();
                            return Some("sk-blocked-read".to_owned());
                        }
                        None
                    },
                    |_| {},
                    move || commit_paused.load(Ordering::SeqCst),
                );
            });
            // Wait for the reader to actually start before letting suspend compete.
            let started = started_rx.recv_timeout(std::time::Duration::from_secs(2));
            if started.is_err() {
                let _ = release_tx.send(());
                commit.join().unwrap();
                panic!("the mock Keychain read never started");
            }
            let suspender = scope.spawn(move || {
                // Same lock boundary `suspend()` uses, but a local paused flag keeps the
                // process-global migration state out of parallel tests.
                let _guard = MIGRATION_LOCK
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                suspend_paused.store(true, Ordering::SeqCst);
                let _ = suspended_tx.send(());
            });
            let outcome = suspended_rx.recv_timeout(std::time::Duration::from_secs(1));
            let suspend_was_fast = outcome.is_ok();
            // Always release the blocked read so a regression cannot wedge the test process.
            let _ = release_tx.send(());
            commit.join().unwrap();
            suspender.join().unwrap();
            assert!(
                suspend_was_fast,
                "suspend waited on the blocked Keychain read"
            );
        });
        assert!(!data_root.exists(), "paused commit recreated the data root");
    }

    #[test]
    fn a_paused_migration_creates_neither_the_home_nor_the_marker() {
        let dir = tempfile::tempdir().unwrap();
        let data_root = dir.path().join("data");
        let home = data_root.join("hermes");
        commit_migration(
            &data_root,
            &home,
            |provider| (provider == "openai").then(|| "sk-old".to_owned()),
            |_| {},
            || true,
        );
        assert!(
            !data_root.exists(),
            "a paused migration must not create its root"
        );
        assert!(!home.exists());
        assert!(!marker_path(&data_root).exists());
    }
}
