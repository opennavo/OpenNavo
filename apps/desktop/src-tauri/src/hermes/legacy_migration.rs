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

use super::{env_store, provider_key_env};

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

fn migrate(hermes_home: &Path) {
    for provider in MIGRATED_PROVIDERS {
        let variable = provider_key_env(provider);
        // Never overwrite a value the user (or the official CLI) already set.
        if env_store::env_has(hermes_home, variable) {
            continue;
        }
        let Some(key) = read_keychain(provider) else {
            continue;
        };
        if env_store::set_env_value(hermes_home, variable, &key).is_ok() {
            delete_keychain(provider);
        }
    }
}

/// Run the migration once, on a detached thread, without blocking the caller.
pub fn spawn(data_root: PathBuf, hermes_home: PathBuf) {
    if already_migrated(&data_root) {
        return;
    }
    std::thread::spawn(move || {
        migrate(&hermes_home);
        if let Err(error) = write_marker(&data_root) {
            log::warn!("Hermes credential migration marker: {error}");
        }
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
    fn skips_a_key_that_is_already_in_dot_env() {
        let dir = tempfile::tempdir().unwrap();
        env_store::set_env_value(dir.path(), "OPENAI_API_KEY", "sk-cli").unwrap();
        // No Keychain entry exists in a unit test, so the run must be a no-op that
        // still leaves the user's value untouched.
        migrate(dir.path());
        assert_eq!(
            env_store::env_value(dir.path(), "OPENAI_API_KEY").as_deref(),
            Some("sk-cli")
        );
    }
}
