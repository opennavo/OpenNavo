//! Provider credentials and panel sessions for the built-in Hermes runtime.
//!
//! Provider API keys live in `<HERMES_HOME>/.env`, exactly where the official Hermes CLI
//! and dashboard keep them: `hermes_cli/config.py` `save_env_value()` writes `KEY=value`
//! lines with an atomic replace and `0600`, and `agent/secret_scope.py` `load_env_file()`
//! is the only reader. Mirroring that format is what lets the app and the `hermes` CLI
//! share one credential store instead of fighting over two.
//!
//! Panel sessions live in `<data_root>/.opennavo/session.json`, outside `HERMES_HOME` so
//! they cannot be mistaken for a profile identity marker by upstream.
//!
//! Both files are plaintext and owner-only: no encryption and no Keychain, at the same
//! permissions upstream uses, because the `hermes` CLI reads the same file.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::AppError;

/// Directory holding app-owned Hermes state that is not upstream configuration.
const SESSION_DIR: &str = ".opennavo";
const SESSION_FILE: &str = "session.json";
const SESSION_VERSION: u64 = 1;
/// Upper bound for a single stored value; panel sessions and API keys are far smaller.
const MAX_VALUE_BYTES: usize = 8 * 1024;
const LOCK_TIMEOUT: Duration = Duration::from_secs(15);

fn storage_error(message: &str, detail: impl ToString) -> AppError {
    AppError::new("E_HERMES_CREDENTIAL", message).with_detail(detail.to_string())
}

/// Create `dir` owner-only. Mirrors upstream `ensure_hermes_home()`.
pub fn ensure_dir(dir: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn temp_beside(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    path.with_file_name(format!(".{name}.opennavo.tmp"))
}

/// Replace `path` atomically with `bytes`, `0600` for a new file. An existing file keeps
/// its mode, matching upstream `_write_env_lines(preserve_mode=...)` for mounted volumes.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| storage_error("Could not write the Hermes credential file.", "no parent"))?;
    ensure_dir(parent)?;
    #[cfg(unix)]
    let existing_mode = {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .ok()
            .map(|meta| meta.permissions().mode() & 0o777)
    };
    let tmp = temp_beside(path);
    let _ = std::fs::remove_file(&tmp);
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|error| storage_error("Could not write the Hermes credential file.", error))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = existing_mode.unwrap_or(0o600);
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(windows)]
    {
        // std::fs::rename does not replace an existing file on Windows.
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path)
        .map_err(|error| storage_error("Could not store the Hermes credential file.", error))?;
    #[cfg(unix)]
    {
        // Persist the rename itself, not just the file contents.
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

/// Serialize a `.env` read-modify-write cycle against other processes.
///
/// Upstream takes the same lock file (`<env>.lock`) through `_env_write_lock()`, so a
/// running gateway, the CLI and this app cannot silently drop each other's keys.
fn with_env_lock<T>(
    home: &Path,
    body: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    #[cfg(unix)]
    {
        use nix::errno::Errno;
        use nix::fcntl::{Flock, FlockArg};

        ensure_dir(home)?;
        let lock_path = home.join(".env.lock");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&lock_path)?;
        let deadline = std::time::Instant::now() + LOCK_TIMEOUT;
        let guard = loop {
            match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
                Ok(guard) => break guard,
                Err((returned, error)) if error == Errno::EWOULDBLOCK || error == Errno::EAGAIN => {
                    if std::time::Instant::now() >= deadline {
                        return Err(AppError::new(
                            "E_HERMES_CREDENTIAL",
                            "The Hermes credential store is busy. Try again in a moment.",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                    file = returned;
                }
                Err((_, error)) => {
                    return Err(storage_error(
                        "Could not lock the Hermes credential store.",
                        error,
                    ));
                }
            }
        };
        let result = body();
        drop(guard);
        result
    }
    #[cfg(not(unix))]
    {
        body()
    }
}

/// `true` when `line` assigns `key`, including the `export KEY=value` and `KEY = value`
/// shapes. Must stay identical to upstream `_env_line_defines_key()`: a shape the writer
/// does not recognise becomes a duplicate line, and a shape the remover does not
/// recognise resurrects a deleted key on the next load.
pub fn env_line_defines_key(line: &str, key: &str) -> bool {
    let stripped = line.trim();
    let stripped = stripped.strip_prefix("export ").unwrap_or(stripped);
    let stripped = stripped.trim_start();
    match stripped.split_once('=') {
        Some((name, _)) => name.trim() == key.trim(),
        None => false,
    }
}

/// Quote a value the way upstream `_quote_env_value()` does, so `set -a; . .env` and
/// Hermes' own tokenizer both read back the exact bytes.
pub fn quote_env_value(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let needs_quotes = value.contains('#')
        || value.contains('"')
        || value.contains('\'')
        || value.chars().any(char::is_whitespace);
    if !needs_quotes {
        return value.to_owned();
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Reverse of [`quote_env_value`], mirroring upstream `_parse_env_value()`: bare,
/// `'single'`, or `"double"` with `\"` and `\\` escapes.
pub fn parse_env_value(raw: &str) -> String {
    let value = raw.trim();
    let bytes: Vec<char> = value.chars().collect();
    if bytes.len() >= 2 && bytes[0] == '"' && bytes[bytes.len() - 1] == '"' {
        let inner = &bytes[1..bytes.len() - 1];
        let mut parsed = String::new();
        let mut index = 0;
        while index < inner.len() {
            let escaped =
                inner[index] == '\\' && matches!(inner.get(index + 1), Some('"') | Some('\\'));
            if escaped {
                parsed.push(inner[index + 1]);
                index += 2;
            } else {
                parsed.push(inner[index]);
                index += 1;
            }
        }
        return parsed;
    }
    if bytes.len() >= 2 && bytes[0] == '\'' && bytes[bytes.len() - 1] == '\'' {
        return inner_string(&bytes);
    }
    value.to_owned()
}

fn inner_string(chars: &[char]) -> String {
    chars[1..chars.len() - 1].iter().collect()
}

/// Strip a dotenv inline comment, mirroring upstream `_strip_inline_comment()`.
fn strip_inline_comment(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = value.chars().collect();
    if matches!(chars[0], '"' | '\'') {
        let quote = chars[0];
        let mut index = 1;
        while index < chars.len() {
            let ch = chars[index];
            if quote == '"' && ch == '\\' {
                index += 2;
                continue;
            }
            if ch == quote {
                let rest: String = chars[index + 1..].iter().collect();
                let closed: String = chars[..=index].iter().collect();
                return if rest.trim_start().starts_with('#') {
                    closed
                } else {
                    value.to_owned()
                };
            }
            index += 1;
        }
        return value.to_owned();
    }
    let mut index = 0;
    while index + 1 < chars.len() {
        if chars[index].is_whitespace() && chars[index + 1] == '#' {
            return chars[..index].iter().collect::<String>().trim().to_owned();
        }
        index += 1;
    }
    value.to_owned()
}

fn read_env_text(home: &Path) -> Option<String> {
    let bytes = std::fs::read(home.join(".env")).ok()?;
    // Upstream strips a BOM and falls back to latin-1 rather than dropping the file.
    let bytes = bytes
        .strip_prefix(b"\xef\xbb\xbf".as_slice())
        .unwrap_or(&bytes);
    Some(match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes.iter().map(|byte| char::from(*byte)).collect(),
    })
}

/// Read one variable out of `<HERMES_HOME>/.env`, the same way Hermes does.
pub fn env_value(home: &Path, key: &str) -> Option<String> {
    let text = read_env_text(home)?;
    let mut found = None;
    for raw_line in text.split('\n') {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        // Last assignment wins, matching a dict built by iterating the file.
        found = Some(parse_env_value(&strip_inline_comment(value)));
    }
    found.filter(|value| !value.is_empty())
}

pub fn env_has(home: &Path, key: &str) -> bool {
    env_value(home, key).is_some()
}

/// Write `key=value` into `<HERMES_HOME>/.env`, replacing any existing assignment.
pub fn set_env_value(home: &Path, key: &str, value: &str) -> Result<(), AppError> {
    let value = value.replace(['\n', '\r'], "");
    if value.len() > MAX_VALUE_BYTES {
        return Err(AppError::new(
            "E_HERMES_CREDENTIAL",
            "That value is too long to store.",
        ));
    }
    let serialized = format!("{key}={}\n", quote_env_value(&value));
    with_env_lock(home, || {
        let mut lines: Vec<String> = match read_env_text(home) {
            Some(text) => text.split('\n').map(str::to_owned).collect(),
            None => Vec::new(),
        };
        if lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        // `env_value` applies the last assignment, so replacing only the first would leave a
        // later duplicate in force. Keep one assignment at the first position instead.
        let mut replaced = false;
        let mut next = Vec::with_capacity(lines.len() + 1);
        for line in lines {
            if !env_line_defines_key(&line, key) {
                next.push(line);
            } else if !replaced {
                next.push(serialized.trim_end().to_owned());
                replaced = true;
            }
        }
        if !replaced {
            next.push(serialized.trim_end().to_owned());
        }
        let mut body = next.join("\n");
        body.push('\n');
        atomic_write(&home.join(".env"), body.as_bytes())
    })
}

/// Remove every assignment of `key` from `<HERMES_HOME>/.env`. Returns whether the file
/// changed. The file is deleted when nothing else is left in it.
pub fn remove_env_value(home: &Path, key: &str) -> Result<bool, AppError> {
    let path = home.join(".env");
    if !path.exists() {
        return Ok(false);
    }
    with_env_lock(home, || {
        let Some(text) = read_env_text(home) else {
            return Ok(false);
        };
        let kept: Vec<&str> = text
            .split('\n')
            .filter(|line| !env_line_defines_key(line, key))
            .collect();
        let mut changed = kept.len() != text.split('\n').count();
        let mut body = kept.join("\n");
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        if body.trim().is_empty() {
            if changed {
                let _ = std::fs::remove_file(&path);
            }
            changed = true;
            return Ok(changed);
        }
        if changed {
            atomic_write(&path, body.as_bytes())?;
        }
        Ok(changed)
    })
}

/// Path of the panel-session store for a given app data root.
pub fn session_path(data_root: &Path) -> PathBuf {
    data_root.join(SESSION_DIR).join(SESSION_FILE)
}

/// Serializes the session read-modify-write inside this process. There is no
/// cross-process lock: only this app writes the file.
fn session_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn poisoned() -> AppError {
    AppError::new(
        "E_HERMES_CREDENTIAL",
        "The panel session store is unavailable.",
    )
}

fn read_sessions(data_root: &Path) -> Result<serde_json::Value, AppError> {
    let empty = serde_json::json!({"version": SESSION_VERSION, "panel": {}});
    let path = session_path(data_root);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty),
        Err(error) => {
            return Err(storage_error(
                "Could not read the panel session store.",
                error,
            ));
        }
    };
    let value = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|error| storage_error("The panel session store is not valid JSON.", error))?;
    if !value.is_object() {
        return Err(storage_error(
            "The panel session store is not a JSON object.",
            "unexpected shape",
        ));
    }
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(SESSION_VERSION) {
        return Err(AppError::new(
            "E_HERMES_CREDENTIAL",
            "The panel session store was written by a different version. Remove it and sign in again.",
        ));
    }
    Ok(value)
}

fn write_sessions(data_root: &Path, store: &serde_json::Value) -> Result<(), AppError> {
    let mut bytes = serde_json::to_vec_pretty(store)?;
    bytes.push(b'\n');
    atomic_write(&session_path(data_root), &bytes)
}

/// Read one panel session. `None` when absent, unreadable, or written by another version.
pub fn session_get(data_root: &Path, profile_id: &str) -> Option<serde_json::Value> {
    read_sessions(data_root)
        .ok()?
        .get("panel")?
        .get(profile_id)
        .filter(|value| value.is_object())
        .cloned()
}

pub fn session_set(
    data_root: &Path,
    profile_id: &str,
    session: serde_json::Value,
) -> Result<(), AppError> {
    let _guard = session_lock().lock().map_err(|_| poisoned())?;
    // Refuse to treat an unreadable store as empty: writing one session back would erase
    // every other panel cookie that is still in the file.
    let mut store = read_sessions(data_root)?;
    let panel = store
        .get_mut("panel")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| storage_error("Could not store the panel session.", "no panel map"))?;
    panel.insert(profile_id.to_owned(), session);
    write_sessions(data_root, &store)
}

pub fn session_delete(data_root: &Path, profile_id: &str) -> Result<(), AppError> {
    let _guard = session_lock().lock().map_err(|_| poisoned())?;
    let mut store = read_sessions(data_root)?;
    let Some(panel) = store
        .get_mut("panel")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Ok(());
    };
    if panel.remove(profile_id).is_none() {
        return Ok(());
    }
    if panel.is_empty() {
        let path = session_path(data_root);
        let _ = std::fs::remove_file(&path);
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
        return Ok(());
    }
    write_sessions(data_root, &store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn writes_a_plain_assignment_with_owner_only_permissions() {
        let dir = tempfile::tempdir().unwrap();
        set_env_value(dir.path(), "OPENAI_API_KEY", "sk-plain").unwrap();
        let path = dir.path().join(".env");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "OPENAI_API_KEY=sk-plain\n"
        );
        assert_eq!(mode(&path), 0o600);
        assert_eq!(
            env_value(dir.path(), "OPENAI_API_KEY").as_deref(),
            Some("sk-plain")
        );
    }

    #[test]
    fn quotes_values_dotenv_cannot_read_bare() {
        let dir = tempfile::tempdir().unwrap();
        set_env_value(dir.path(), "K", "with space # hash \"q\" \\ slash").unwrap();
        let raw = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert!(raw.starts_with("K=\""));
        assert_eq!(
            env_value(dir.path(), "K").as_deref(),
            Some("with space # hash \"q\" \\ slash")
        );
    }

    #[test]
    fn replaces_in_place_and_keeps_unmanaged_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "# comment\nexport OLD_KEY=keep\nOPENAI_API_KEY=sk-old\nLAST=1\n",
        )
        .unwrap();
        set_env_value(dir.path(), "OPENAI_API_KEY", "sk-new").unwrap();
        let body = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert_eq!(body.matches("OPENAI_API_KEY").count(), 1);
        assert!(body.contains("OPENAI_API_KEY=sk-new"));
        assert!(body.contains("# comment"));
        assert!(body.contains("export OLD_KEY=keep"));
        assert!(body.contains("LAST=1"));
    }

    #[test]
    fn replaces_duplicate_assignments_so_the_new_value_wins() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "OPENAI_API_KEY=sk-old\nKEEP=1\nOPENAI_API_KEY=sk-older\n",
        )
        .unwrap();
        set_env_value(dir.path(), "OPENAI_API_KEY", "sk-new").unwrap();
        let body = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert_eq!(body.matches("OPENAI_API_KEY").count(), 1);
        assert!(body.contains("OPENAI_API_KEY=sk-new"));
        assert!(body.contains("KEEP=1"));
        assert_eq!(
            env_value(dir.path(), "OPENAI_API_KEY").as_deref(),
            Some("sk-new")
        );
    }

    #[test]
    fn recognises_the_export_and_spaced_shapes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "export KEY_A = \"sk-a\"\n").unwrap();
        assert_eq!(env_value(dir.path(), "KEY_A").as_deref(), Some("sk-a"));
        set_env_value(dir.path(), "KEY_A", "sk-b").unwrap();
        let body = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert_eq!(body.matches("KEY_A").count(), 1);
    }

    #[test]
    fn removes_the_key_and_deletes_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        set_env_value(dir.path(), "ONLY", "v").unwrap();
        assert!(remove_env_value(dir.path(), "ONLY").unwrap());
        assert!(!dir.path().join(".env").exists());
        assert!(!remove_env_value(dir.path(), "ONLY").unwrap());
    }

    #[test]
    fn keeps_other_keys_when_removing_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "A=1\nB=2\n").unwrap();
        assert!(remove_env_value(dir.path(), "A").unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".env")).unwrap(),
            "B=2\n"
        );
    }

    #[test]
    fn ignores_comments_and_blank_lines_when_reading() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "# OPENAI_API_KEY=sk-commented\n\n  \nOPENAI_API_KEY=sk-real # inline\n",
        )
        .unwrap();
        assert_eq!(
            env_value(dir.path(), "OPENAI_API_KEY").as_deref(),
            Some("sk-real")
        );
    }

    #[test]
    fn tolerates_a_bom_and_crlf() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), b"\xef\xbb\xbfA=1\r\nB=2\r\n").unwrap();
        assert_eq!(env_value(dir.path(), "A").as_deref(), Some("1"));
        assert_eq!(env_value(dir.path(), "B").as_deref(), Some("2"));
    }

    #[test]
    fn rejects_oversized_values() {
        let dir = tempfile::tempdir().unwrap();
        let huge = "x".repeat(MAX_VALUE_BYTES + 1);
        assert!(set_env_value(dir.path(), "K", &huge).is_err());
    }

    #[test]
    fn round_trips_panel_sessions_and_clears_the_file() {
        let dir = tempfile::tempdir().unwrap();
        session_set(
            dir.path(),
            "panel-1",
            serde_json::json!({"baseUrl": "https://x"}),
        )
        .unwrap();
        assert_eq!(
            session_get(dir.path(), "panel-1").unwrap()["baseUrl"],
            "https://x"
        );
        assert_eq!(mode(&session_path(dir.path())), 0o600);
        session_delete(dir.path(), "panel-1").unwrap();
        assert!(session_get(dir.path(), "panel-1").is_none());
        assert!(!session_path(dir.path()).exists());
    }

    #[test]
    fn refuses_to_overwrite_a_corrupt_session_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = session_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        assert!(session_get(dir.path(), "panel-1").is_none());
        assert!(
            session_set(
                dir.path(),
                "panel-1",
                serde_json::json!({"baseUrl": "https://y"})
            )
            .is_err()
        );
        // The unreadable file is still there, untouched: the next attempt can recover it.
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
    }

    #[test]
    fn refuses_to_overwrite_a_newer_session_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = session_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original =
            serde_json::json!({"version": 99, "panel": {"p": {"baseUrl": "x"}}}).to_string();
        std::fs::write(&path, &original).unwrap();
        assert!(session_get(dir.path(), "p").is_none());
        assert!(session_set(dir.path(), "p", serde_json::json!({"baseUrl": "https://y"})).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn keeps_other_panel_sessions_when_one_is_written() {
        let dir = tempfile::tempdir().unwrap();
        session_set(dir.path(), "a", serde_json::json!({"baseUrl": "https://a"})).unwrap();
        session_set(dir.path(), "b", serde_json::json!({"baseUrl": "https://b"})).unwrap();
        assert_eq!(
            session_get(dir.path(), "a").unwrap()["baseUrl"],
            "https://a"
        );
        assert_eq!(
            session_get(dir.path(), "b").unwrap()["baseUrl"],
            "https://b"
        );
    }
}
