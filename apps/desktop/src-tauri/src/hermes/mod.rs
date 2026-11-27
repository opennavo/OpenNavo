//! Hermes Agent sidecar discovery, configuration, and one-shot chat execution.
//!
//! Release builds bundle the runtime under `Resources/resources/hermes/`; development
//! builds can point `HERMES_RUNTIME_BIN` at a prepared runtime or use the checked-in
//! resources directory after `pnpm --filter @opennavo/desktop hermes:prepare`.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::timeout;
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader, yaml::Hash};

use crate::AppError;

pub(crate) mod diagnostics;
pub(crate) mod env_store;
pub(crate) mod gateway;
pub(crate) mod hygiene;
pub(crate) mod install;
pub(crate) mod legacy_migration;
pub(crate) mod login;
pub(crate) mod login_session;
pub(crate) mod media;
mod media_proxy;
pub(crate) mod model_catalog;
pub mod panel;
pub(crate) mod permissions;
pub mod profiles;
pub(crate) mod test_connection;
pub(crate) mod window;
use gateway::GatewayServer;

#[allow(dead_code)]
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const DATA_ROOT_DIR: &str = "OpenNavoData";
const RUNTIME_DIR: &str = "runtime/hermes";
const HERMES_HOME_DIR: &str = "hermes";
const AUDIT_FILE: &str = "audit.jsonl";
const COMPOSER_PASTES_DIR: &str = "composer-pastes";
const COMPOSER_IMAGES_DIR: &str = "composer-images";
const MAX_PASTED_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_PASTED_TEXT_BYTES: usize = 50 * 1024 * 1024;
const RUNTIME_MANIFEST_JSON: &str = include_str!("../../../hermes/runtime.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    hermes: RuntimeHermesPin,
    #[serde(default)]
    plugins: Vec<RuntimePluginPin>,
    release: RuntimeReleasePin,
}

#[derive(Debug, Deserialize)]
struct RuntimeHermesPin {
    version: String,
}

#[derive(Debug, Deserialize)]
struct RuntimePluginPin {
    name: String,
    repository: String,
    #[serde(rename = "ref")]
    sha: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReleasePin {
    repository: String,
    tag: String,
    asset: String,
    sha256: String,
}

/// App data root, cached so panel-session helpers work without an `AppHandle`.
static DATA_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesRuntimeStatus {
    pub ready: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub expected_version: String,
    pub path: Option<String>,
    pub data_path: Option<String>,
    pub computer_use: bool,
    pub outdated: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct HermesAuxAssignment {
    pub task: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesChatInput {
    pub prompt: String,
    pub request_id: String,
    pub session_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub fast: bool,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub cwd: Option<String>,
    pub attachments: Vec<String>,
    pub auxiliary: Vec<HermesAuxAssignment>,
    pub force_aux_vision: bool,
    pub gateway_url: Option<String>,
    pub profile_id: Option<String>,
    pub profile: Option<String>,
    pub panel_auth: bool,
    pub mac_enabled: bool,
    pub control_level: String,
    pub mac_terminal: bool,
    pub mac_screen: bool,
    pub mac_files: bool,
    pub mac_cron: bool,
    pub confirm_writes: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesAuditEntry {
    pub at: String,
    pub provider: String,
    pub model: String,
    pub toolsets: String,
    pub control_level: String,
    pub prompt_chars: u64,
    pub outcome: String,
    pub session_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesAttachmentInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_image: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesRemoteTest {
    pub ok: bool,
    pub latency_ms: u64,
    pub models: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesChatReply {
    pub text: String,
    pub session_id: Option<String>,
    pub live_session_id: Option<String>,
    pub usage: Option<HermesUsage>,
    /// The gateway ended the turn with `message.complete` status `interrupted`.
    /// The text already streamed stays; this is not a finished answer.
    pub interrupted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum HermesSteerStatus {
    Queued,
    Redirected,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesSteerResult {
    pub status: HermesSteerStatus,
    /// Only set to `false` when Hermes confirms no live agent saw the correction. A plain
    /// `rejected` may follow delivery (for example, a Codex steer whose ACK timed out), so it
    /// carries no `delivered` field and must never be re-sent as the next prompt.
    pub delivered: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct HermesUsage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub total: Option<u64>,
    pub context_used: Option<u64>,
    pub context_max: Option<u64>,
    pub context_percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct HermesModelOptions {
    pub providers: Vec<HermesModelProvider>,
    pub model: Option<String>,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct HermesModelProvider {
    pub slug: String,
    pub name: String,
    pub is_current: bool,
    pub is_user_defined: bool,
    pub models: Vec<String>,
    pub total_models: u32,
    pub source: Option<String>,
    pub authenticated: bool,
    pub auth_type: Option<String>,
    pub key_env: Option<String>,
    pub warning: Option<String>,
    pub base_url: Option<String>,
    pub capabilities: std::collections::BTreeMap<String, HermesModelCapability>,
    pub pricing: std::collections::BTreeMap<String, HermesModelPricing>,
    pub free_tier: Option<bool>,
    pub unavailable_models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct HermesModelCapability {
    pub fast: bool,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct HermesModelPricing {
    pub input: Option<String>,
    pub output: Option<String>,
    pub cache: Option<String>,
    pub free: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesModelOptionsInput {
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub fast: bool,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub refresh: bool,
    pub include_unconfigured: bool,
    pub gateway_url: Option<String>,
    pub profile_id: Option<String>,
    pub profile: Option<String>,
    pub panel_auth: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesChunk {
    pub request_id: String,
    pub delta: String,
}

/// One answer the renderer gave to a server→client request (`approval`, `clarify`, `sudo`/`secret`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HermesAskReply {
    /// `scope` is one of the `choices` the runtime offered: once / session / always / deny.
    Approval { choice: String },
    /// `cancelled` answers "the user dismissed the card", which the runtime reads as cancel-all.
    Clarify {
        answers: Vec<HermesClarifyAnswer>,
        cancelled: bool,
    },
    /// One masked string (sudo password, env secret, vault unlock, one-time code). `""` means skipped.
    Secret { value: String },
    /// A login the agent may save to the vault (`vault.save_login`), answered as a JSON credential.
    VaultSaveLogin {
        identifier: String,
        password: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesClarifyAnswer {
    pub qid: String,
    /// `None` is a skipped question (`clarify`'s `null` answer).
    pub answer: Option<String>,
}

/// A reply routed to the turn that is waiting on it, matched by the request id the card carried.
#[derive(Debug, Clone)]
pub(crate) struct AskAnswer {
    pub request_id: String,
    pub reply: HermesAskReply,
}

/// One live turn's card channel. Answers are routed by the chat request id the turn was
/// started with, so two windows (or a Panel and a local turn) never consume each other's
/// cards, and a stop only cancels the turn it names.
pub(crate) struct TurnAskChannel {
    pub(crate) sender: UnboundedSender<AskAnswer>,
    pub(crate) cancel: std::sync::Arc<TurnCancel>,
    /// The live gateway session this turn owns; older callers name this id.
    pub(crate) live_session_id: String,
    /// A Panel turn's card wait lives here but its gateway is not this process's to stop.
    pub(crate) remote: bool,
    /// Panel login this turn was prepared under. Late interrupt/steer/model reads use it to
    /// prove they still act on the same sign-in.
    pub(crate) panel_login: Option<String>,
}

/// A cancellation that is also a stored state: `notify_waiters` alone loses the signal if
/// it fires before the stream reaches its select or while it is handling another frame.
pub(crate) struct TurnCancel {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl TurnCancel {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub(crate) fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Race-free wait: a cancel that lands between the flag check and the waiter registration
    /// is caught by the second check after `enable()`, and the loop covers repeated waits.
    pub(crate) async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            if self.is_cancelled() {
                return;
            }
        }
    }
}

#[derive(Default)]
pub struct HermesRuntimeState {
    pid: Mutex<Option<u32>>,
    gateway: tokio::sync::Mutex<Option<std::sync::Arc<GatewayServer>>>,
    /// Serializes install, uninstall and anything else that owns the runtime directory.
    /// `installing` stays the fast rejection flag chat reads, while this mutex keeps the
    /// operations from interleaving with each other.
    pub(crate) lifecycle: tokio::sync::Mutex<()>,
    /// Answers from the renderer for the requests each running turn is parked on, keyed by
    /// that turn's chat request id. One channel per turn: answering or stopping one turn
    /// must not reach the cards another window is waiting on.
    pub(crate) asks: Mutex<std::collections::HashMap<String, TurnAskChannel>>,
    /// Test seam: fires when a live server request becomes an open card, so the stalled-turn
    /// regression test can wait for registration instead of guessing with yields.
    #[cfg(test)]
    pub(crate) ask_opened: tokio::sync::Notify,
    installing: AtomicBool,
    pub(crate) install_cancel: AtomicBool,
}

fn ask_lock(
    state: &HermesRuntimeState,
) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, TurnAskChannel>> {
    state
        .asks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl HermesRuntimeState {
    /// Register this turn's answer channel before its first card can be shown.
    pub(crate) fn register_turn_asks(
        &self,
        turn: &str,
        live_session_id: &str,
        remote: bool,
        sender: UnboundedSender<AskAnswer>,
    ) -> std::sync::Arc<TurnCancel> {
        let cancel = std::sync::Arc::new(TurnCancel::new());
        ask_lock(self).insert(
            turn.to_owned(),
            TurnAskChannel {
                sender,
                cancel: cancel.clone(),
                live_session_id: live_session_id.to_owned(),
                remote,
                panel_login: None,
            },
        );
        cancel
    }

    /// Remove only the registration this turn created. The cancel handle identifies it, so
    /// a guard for a superseded turn cannot drop a newer registration that reused the id.
    pub(crate) fn unregister_turn_asks(&self, turn: &str, cancel: &std::sync::Arc<TurnCancel>) {
        let mut asks = ask_lock(self);
        if asks
            .get(turn)
            .is_some_and(|channel| std::sync::Arc::ptr_eq(&channel.cancel, cancel))
        {
            asks.remove(turn);
        }
    }

    /// Bind the live session and Panel login as soon as the async setup learns them. The
    /// cancellation identity exists before this, so a stop during session creation is not lost.
    pub(crate) fn bind_turn_scope(
        &self,
        turn: &str,
        cancel: &std::sync::Arc<TurnCancel>,
        live_session_id: &str,
        panel_login: Option<&str>,
    ) {
        let mut asks = ask_lock(self);
        if let Some(channel) = asks.get_mut(turn)
            && std::sync::Arc::ptr_eq(&channel.cancel, cancel)
        {
            channel.live_session_id = live_session_id.to_owned();
            if let Some(login) = panel_login {
                channel.panel_login = Some(login.to_owned());
            }
        }
    }

    /// Panel login a running turn was prepared under, if any.
    pub(crate) fn turn_panel_login(&self, turn: Option<&str>) -> Option<String> {
        let turn = turn.map(str::trim).filter(|value| !value.is_empty())?;
        ask_lock(self)
            .get(turn)
            .and_then(|channel| channel.panel_login.clone())
    }

    /// Whether a **local** turn id is currently registered. A Panel turn id must never
    /// authorize taking/stopping this process's gateway slot.
    pub(crate) fn is_local_turn_registered(&self, turn: &str) -> bool {
        ask_lock(self)
            .get(turn)
            .is_some_and(|channel| !channel.remote)
    }

    /// Whether a local turn other than `except` is still registered. A late hard stop for one
    /// turn must not kill a gateway another local turn is using.
    pub(crate) fn has_other_local_turns(&self, except: Option<&str>) -> bool {
        ask_lock(self)
            .iter()
            .any(|(turn, channel)| !channel.remote && except != Some(turn.as_str()))
    }

    /// The sender for a turn. `None` keeps the old single-turn callers working only while
    /// exactly one turn is live; with several live turns the answer has to name its turn.
    pub(crate) fn turn_ask_sender(&self, turn: Option<&str>) -> Option<UnboundedSender<AskAnswer>> {
        let asks = ask_lock(self);
        match turn {
            Some(turn) => asks.get(turn).map(|channel| channel.sender.clone()),
            None if asks.len() == 1 => asks.values().next().map(|channel| channel.sender.clone()),
            None => None,
        }
    }

    /// Cancel one turn: by its request id when known, else by live session. `local_only`
    /// keeps a local gateway stop from refusing cards owned by a Panel host. Two Panel hosts
    /// can reuse a session id, which is why the request id wins when supplied.
    pub(crate) fn cancel_turn_asks(
        &self,
        turn: Option<&str>,
        live_session_id: Option<&str>,
        local_only: bool,
    ) {
        let turn = turn.map(str::trim).filter(|value| !value.is_empty());
        let session = live_session_id
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if turn.is_none() && session.is_none() {
            return;
        }
        for (registered, channel) in ask_lock(self).iter() {
            if local_only && channel.remote {
                continue;
            }
            let matches = match turn {
                Some(turn) => registered == turn,
                None => session.is_some_and(|session| channel.live_session_id == session),
            };
            if matches {
                channel.cancel.cancel();
            }
        }
    }

    /// Install/uninstall stops every local card wait, leaving Panel turns untouched.
    pub(crate) fn cancel_local_turn_asks(&self) {
        for channel in ask_lock(self).values() {
            if !channel.remote {
                channel.cancel.cancel();
            }
        }
    }

    /// Shutdown cancels every parked card: the runtime is going away, so no turn can settle
    /// its card on the socket.
    pub(crate) fn cancel_all_turn_asks(&self) {
        let mut asks = ask_lock(self);
        for channel in asks.values() {
            channel.cancel.cancel();
        }
        asks.clear();
    }
}

fn installing_error() -> AppError {
    AppError::new(
        "E_HERMES_INSTALLING",
        "Hermes is being updated. Try again when it finishes.",
    )
}

fn data_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| {
            AppError::new("E_HERMES_HOME", "hermes_home").with_detail(error.to_string())
        })?
        .join(DATA_ROOT_DIR);
    std::fs::create_dir_all(&root)?;
    let _ = DATA_ROOT.set(root.clone());
    Ok(root)
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(data_root(app)?.join(RUNTIME_DIR))
}

pub(crate) fn runtime_bin(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("HERMES_RUNTIME_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let installed = runtime_root(app).ok()?.join("bin").join("hermes");
    installed.is_file().then_some(installed)
}

pub(crate) fn hermes_home(app: &AppHandle) -> Result<PathBuf, AppError> {
    let home = data_root(app)?.join(HERMES_HOME_DIR);
    // Consolidate the pre-OpenNavoData home from earlier builds.
    if !home.exists()
        && let Ok(app_data) = app.path().app_data_dir()
    {
        let legacy = app_data.join(HERMES_HOME_DIR);
        if legacy.is_dir() {
            if let Some(parent) = home.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let _ = std::fs::rename(legacy, &home);
        }
    }
    std::fs::create_dir_all(&home)?;
    Ok(home)
}

fn clean_output(value: &str) -> String {
    let ansi = regex::Regex::new(r"\x1b\[[0-9;]*m").expect("static ANSI regex");
    ansi.replace_all(value, "").trim().to_owned()
}

#[allow(dead_code)]
fn clean_response(value: &str) -> String {
    clean_output(value)
        .lines()
        .filter(|line| !line.contains("tirith security scanner enabled but not available"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

#[allow(dead_code)]
fn session_id(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("session_id:")
                .map(|value| value.trim().to_owned())
        })
        .filter(|value| !value.is_empty())
}

fn provider_id(provider: &str) -> &str {
    match provider {
        "openai" => "openai-api",
        "anthropic" => "anthropic",
        "google" => "gemini",
        "openrouter" => "openrouter",
        "nous" => "nous",
        "codex" => "openai-codex",
        "claude-code" => "anthropic",
        "copilot" => "copilot",
        "opencode" => "opencode-zen",
        "opencode-go" => "opencode-go",
        "custom" | "local" => "openavoo-custom",
        other => other,
    }
}

fn provider_key_env(provider: &str) -> &str {
    match provider {
        "openai" | "codex" => "OPENAI_API_KEY",
        "anthropic" | "claude-code" => "ANTHROPIC_API_KEY",
        "google" => "GOOGLE_API_KEY",
        "openrouter" => "OPENROUTER_API_KEY",
        "nous" => "NOUS_API_KEY",
        "copilot" => "GITHUB_TOKEN",
        "opencode" => "OPENCODE_ZEN_API_KEY",
        "opencode-go" => "OPENCODE_GO_API_KEY",
        "custom" | "local" => "OPENNAVO_CUSTOM_API_KEY",
        _ => "OPENAI_API_KEY",
    }
}

fn toolsets(input: &HermesChatInput) -> String {
    if !input.mac_enabled || input.control_level == "open" {
        return "safe".to_owned();
    }
    let mut selected = Vec::new();
    if input.mac_terminal {
        selected.push("terminal");
    }
    if input.mac_files {
        selected.push("file");
    }
    if input.mac_screen {
        selected.push("computer_use");
    }
    if input.mac_cron {
        selected.push("cronjob");
    }
    if selected.is_empty() {
        "safe".to_owned()
    } else {
        selected.join(",")
    }
}

fn runtime_manifest() -> Result<RuntimeManifest, AppError> {
    serde_json::from_str(RUNTIME_MANIFEST_JSON).map_err(|error| {
        AppError::new(
            "E_HERMES_RUNTIME_MANIFEST",
            "The pinned Hermes runtime metadata is invalid.",
        )
        .with_detail(error.to_string())
    })
}

fn expected_runtime_version() -> Result<String, AppError> {
    let version = runtime_manifest()?.hermes.version;
    let valid = regex::Regex::new(r"^\d+\.\d+\.\d+$")
        .expect("static Hermes version regex")
        .is_match(&version);
    if !valid {
        return Err(AppError::new(
            "E_HERMES_RUNTIME_MANIFEST",
            "The pinned Hermes runtime version is invalid.",
        ));
    }
    Ok(version)
}

fn runtime_version_from_output(value: &str) -> Option<String> {
    let pattern = regex::Regex::new(r"(?m)^Hermes Agent v?(\d+\.\d+\.\d+)\b")
        .expect("static Hermes version output regex");
    pattern
        .captures(value)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_owned())
}

#[cfg(test)]
fn runtime_version_matches(version: &str, expected: &str) -> bool {
    runtime_version_from_output(version).as_deref() == Some(expected)
}

fn reasoning_effort(effort: &str) -> Option<&str> {
    match effort {
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" => Some(effort),
        _ => None,
    }
}

fn history_path(app: &AppHandle, profile: Option<&str>) -> Result<PathBuf, AppError> {
    let home = hermes_home(app)?;
    let profile = profile
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "default");
    Ok(match profile {
        Some(name)
            if name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            home.join(format!("history-{name}.json"))
        }
        Some(_) => {
            return Err(AppError::new(
                "E_HERMES_HISTORY",
                "Invalid profile name for history.",
            ));
        }
        None => home.join("history.json"),
    })
}

pub fn history_load(app: &AppHandle, profile: Option<&str>) -> Result<Option<String>, AppError> {
    const MAX_HISTORY_BYTES: u64 = 20 * 1024 * 1024;
    let path = history_path(app, profile)?;
    if !path.is_file() {
        return Ok(None);
    }
    // Bound the read itself: checking the length after `read_to_string` had already buffered
    // an arbitrarily large file.
    let mut file = std::fs::File::open(&path)?;
    let mut raw = String::new();
    use std::io::Read;
    if (&mut file)
        .take(MAX_HISTORY_BYTES + 1)
        .read_to_string(&mut raw)?
        > MAX_HISTORY_BYTES as usize
    {
        return Err(AppError::new(
            "E_HERMES_HISTORY",
            "Hermes history is too large.",
        ));
    }
    Ok(Some(raw))
}

fn read_history_limited(path: &Path) -> Result<Option<String>, AppError> {
    const MAX_HISTORY_BYTES: u64 = 20 * 1024 * 1024;
    if !path.is_file() {
        return Ok(None);
    }
    let mut file = std::fs::File::open(path)?;
    let mut raw = String::new();
    use std::io::Read;
    if (&mut file)
        .take(MAX_HISTORY_BYTES + 1)
        .read_to_string(&mut raw)?
        > MAX_HISTORY_BYTES as usize
    {
        return Err(AppError::new(
            "E_HERMES_HISTORY",
            "Hermes history is too large.",
        ));
    }
    Ok(Some(raw))
}

fn merge_history_ops(path: &Path, incoming: &serde_json::Value) -> Result<(), AppError> {
    let home = path
        .parent()
        .ok_or_else(|| AppError::new("E_HERMES_HISTORY", "Hermes history path is invalid."))?;
    env_store::with_home_lock(home, || {
        let mut document = match read_history_limited(path)? {
            Some(raw) => serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| {
                AppError::new("E_HERMES_HISTORY", "Hermes history is unreadable.")
                    .with_detail(error.to_string())
            })?,
            None => serde_json::json!({"version": 3, "conversations": []}),
        };
        let root = document
            .as_object_mut()
            .ok_or_else(|| AppError::new("E_HERMES_HISTORY", "Hermes history is not an object."))?;
        let conversations = root
            .entry("conversations")
            .or_insert_with(|| serde_json::json!([]));
        let Some(rows) = conversations.as_array_mut() else {
            return Err(AppError::new(
                "E_HERMES_HISTORY",
                "Hermes history conversations are not a list.",
            ));
        };
        let deleted: std::collections::HashSet<&str> = incoming
            .get("deletes")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .collect();
        if !deleted.is_empty() {
            rows.retain(|row| {
                row.get("id")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|id| !deleted.contains(id))
            });
        }
        for row in incoming
            .get("upserts")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = row.get("id").and_then(serde_json::Value::as_str) else {
                continue;
            };
            rows.retain(|existing| {
                existing.get("id").and_then(serde_json::Value::as_str) != Some(id)
            });
            rows.push(row.clone());
        }
        if let Some(active) = incoming.get("activeId") {
            root.insert("activeId".to_owned(), active.clone());
        }
        root.insert("version".to_owned(), serde_json::json!(3));
        let body = serde_json::to_vec(&document).map_err(|error| {
            AppError::new("E_HERMES_HISTORY", "Could not encode history.")
                .with_detail(error.to_string())
        })?;
        if body.len() > 20 * 1024 * 1024 {
            return Err(AppError::new(
                "E_HERMES_HISTORY",
                "Hermes history is too large.",
            ));
        }
        env_store::atomic_write(path, &body)
    })
}

pub fn history_save(app: &AppHandle, json: &str, profile: Option<&str>) -> Result<(), AppError> {
    const MAX_HISTORY_BYTES: usize = 20 * 1024 * 1024;
    if json.len() > MAX_HISTORY_BYTES {
        return Err(AppError::new(
            "E_HERMES_HISTORY",
            "Hermes history is too large.",
        ));
    }
    let value = serde_json::from_str::<serde_json::Value>(json).map_err(|error| {
        AppError::new("E_HERMES_HISTORY", "Hermes history is not valid JSON.")
            .with_detail(error.to_string())
    })?;
    let path = history_path(app, profile)?;
    // New writers send explicit upserts/deletes derived from their loaded baseline. Merging
    // them under the file lock keeps two windows from overwriting each other's conversations
    // and prevents a stale snapshot from resurrecting a deleted row.
    if value
        .get("upserts")
        .and_then(serde_json::Value::as_array)
        .is_some()
    {
        return merge_history_ops(&path, &value);
    }
    // Two windows can save the same profile at once. A fixed `.json.tmp` lets one write the
    // other's rename source; a per-write name keeps each rename pair private.
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<(), AppError> {
        std::fs::write(&tmp, json)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Move one profile's history with the profile itself. A local rename used to leave
/// `history-<old>.json` behind, and recreating that name later resurrected the old chat list.
fn move_profile_history(from: &Path, to: &Path) -> Result<bool, AppError> {
    if !from.is_file() {
        return Ok(false);
    }
    if to.exists() {
        // Never overwrite history a profile with the target name already owns.
        return Ok(false);
    }
    std::fs::rename(from, to)?;
    Ok(true)
}

fn remove_profile_history(path: &Path) {
    let _ = std::fs::remove_file(path);
}

pub fn attachment_preview(path: &str) -> Result<Option<String>, AppError> {
    let path_ref = std::path::Path::new(path);
    let ext = path_ref
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" | "heif" => "image/heic",
        "bmp" => "image/bmp",
        "tiff" => "image/tiff",
        _ => return Ok(None),
    };
    let metadata = match std::fs::metadata(path_ref) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };
    if metadata.len() > 8 * 1024 * 1024 {
        return Ok(None);
    }
    let bytes = std::fs::read(path_ref)?;
    use base64::Engine;
    Ok(Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

pub fn clipboard_image(app: &AppHandle) -> Result<Option<String>, AppError> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| {
        AppError::new("E_HERMES_CLIPBOARD", "Could not open the clipboard.")
            .with_detail(error.to_string())
    })?;
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(_) => return Ok(None),
    };
    let dir = data_root(app)?.join("clipboard");
    std::fs::create_dir_all(&dir)?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(86_400);
        for entry in entries.flatten() {
            if entry
                .metadata()
                .and_then(|meta| meta.modified())
                .map(|modified| modified < cutoff)
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let path = dir.join(format!("clipboard-{}.png", uuid::Uuid::new_v4()));
    image::save_buffer(
        &path,
        &image.bytes,
        image.width as u32,
        image.height as u32,
        image::ColorType::Rgba8,
    )
    .map_err(|error| {
        AppError::new("E_HERMES_CLIPBOARD", "Could not save the clipboard image.")
            .with_detail(error.to_string())
    })?;
    Ok(Some(path.display().to_string()))
}

pub fn attachment_info(paths: Vec<String>) -> Vec<HermesAttachmentInfo> {
    paths
        .into_iter()
        .map(|path| {
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            let is_image = gateway::attachment_is_image(std::path::Path::new(&path));
            HermesAttachmentInfo {
                path,
                name,
                size,
                is_image,
            }
        })
        .collect()
}

/// Persist a large plain-text paste as a `.txt` the composer can attach. The renderer never
/// chooses the path: the file lands in the runtime home alongside Hermes' own composer-pastes,
/// matching the official desktop so a local gateway and a panel can both read it.
pub fn save_pasted_text(app: &AppHandle, text: &str) -> Result<HermesAttachmentInfo, AppError> {
    let dir = hermes_home(app)?.join(COMPOSER_PASTES_DIR);
    std::fs::create_dir_all(&dir)?;
    save_pasted_text_in(&dir, text)
}

fn save_pasted_text_in(dir: &Path, text: &str) -> Result<HermesAttachmentInfo, AppError> {
    if text.is_empty() {
        return Err(AppError::new("E_HERMES_PASTE", "The pasted text is empty."));
    }
    // Refuse before writing: an oversized paste must not leave a file nothing can attach.
    if text.len() > MAX_PASTED_TEXT_BYTES {
        return Err(AppError::new(
            "E_HERMES_PASTE",
            "Pasted text is limited to 50 MB.",
        ));
    }
    let name = format!(
        "pasted_content_{}_{}.txt",
        chrono::Utc::now().format("%Y%m%d_%H%M%S"),
        uuid::Uuid::new_v4().simple()
    );
    let path = dir.join(&name);
    std::fs::write(&path, text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Pasted material can be sensitive; keep it owner-only like Hermes' own config.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(HermesAttachmentInfo {
        path: path.display().to_string(),
        name,
        size: text.len() as u64,
        is_image: false,
    })
}

/// Save a pasted image (a `data:image/...;base64,` payload from the renderer) so it becomes a
/// regular attachment the existing image/file pipeline can send in both local and panel modes.
pub fn save_pasted_image(
    app: &AppHandle,
    data_url: &str,
    name: Option<&str>,
) -> Result<HermesAttachmentInfo, AppError> {
    let dir = data_root(app)?.join(COMPOSER_IMAGES_DIR);
    std::fs::create_dir_all(&dir)?;
    save_pasted_image_in(&dir, data_url, name)
}

fn pasted_image_extension(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        "image/svg+xml" => Some("svg"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        _ => None,
    }
}

fn pasted_image_stem(name: Option<&str>) -> String {
    let raw = name
        .unwrap_or_default()
        .split(['/', '\\'])
        .next_back()
        .unwrap_or_default();
    let stem = raw.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(raw);
    let cleaned: String = stem
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed: String = cleaned
        .trim_matches(['.', '_', '-'])
        .chars()
        .take(80)
        .collect();
    if trimmed.is_empty() {
        "pasted-image".to_owned()
    } else {
        trimmed
    }
}

fn save_pasted_image_in(
    dir: &Path,
    data_url: &str,
    name: Option<&str>,
) -> Result<HermesAttachmentInfo, AppError> {
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| AppError::new("E_HERMES_PASTE", "The pasted image is not a data URL."))?;
    let header = header.trim();
    if !header.starts_with("data:") || !header.to_ascii_lowercase().contains(";base64") {
        return Err(AppError::new(
            "E_HERMES_PASTE",
            "The pasted image is not a base64 data URL.",
        ));
    }
    let mime = header
        .trim_start_matches("data:")
        .split(';')
        .next()
        .unwrap_or_default();
    let extension = pasted_image_extension(mime)
        .ok_or_else(|| AppError::new("E_HERMES_PASTE", "Unsupported pasted image type."))?;
    // Base64 decodes to 3/4 of its encoded length (minus padding). Check that estimate before
    // allocating the decoded buffer so an absurd payload never becomes 25 MB+ of image in memory.
    let encoded = payload.trim();
    let padding = encoded
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count();
    if encoded.len() / 4 * 3 > MAX_PASTED_IMAGE_BYTES + padding {
        return Err(AppError::new(
            "E_HERMES_PASTE",
            "Pasted images are limited to 25 MB.",
        ));
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|error| {
            AppError::new("E_HERMES_PASTE", "The pasted image is not valid base64.")
                .with_detail(error.to_string())
        })?;
    if bytes.is_empty() {
        return Err(AppError::new(
            "E_HERMES_PASTE",
            "The pasted image is empty.",
        ));
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err(AppError::new(
            "E_HERMES_PASTE",
            "Pasted images are limited to 25 MB.",
        ));
    }
    let name = format!(
        "{}_{}.{}",
        pasted_image_stem(name),
        uuid::Uuid::new_v4().simple(),
        extension
    );
    let path = dir.join(&name);
    std::fs::write(&path, &bytes)?;
    Ok(HermesAttachmentInfo {
        path: path.display().to_string(),
        name,
        size: bytes.len() as u64,
        is_image: gateway::attachment_is_image(&path),
    })
}

/// Whether `path` resolves inside one of the composer-owned paste directories. Canonicalizing
/// both sides means a symlink cannot make a user file look managed.
fn is_managed_composer_path(path: &Path, pastes_dir: &Path, images_dir: &Path) -> bool {
    let Ok(target) = path.canonicalize() else {
        return false;
    };
    [pastes_dir, images_dir].iter().any(|dir| {
        dir.canonicalize()
            .map(|dir| target.starts_with(dir))
            .unwrap_or(false)
    })
}

fn discard_managed_file(path: &Path, pastes_dir: &Path, images_dir: &Path) -> Result<(), AppError> {
    // Idempotent: a chip removed twice, or a file already cleaned up, is not an error.
    if !path.exists() {
        return Ok(());
    }
    if !is_managed_composer_path(path, pastes_dir, images_dir) {
        return Err(AppError::new(
            "E_HERMES_PASTE",
            "Refusing to delete a file the composer did not create.",
        ));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

/// Remove a paste file when its chip is removed or its attachment was refused. Only files under
/// `composer-pastes` / `composer-images` qualify; picker and drag attachments are never touched.
pub fn discard_attachment(app: &AppHandle, path: &str) -> Result<(), AppError> {
    let pastes_dir = hermes_home(app)?.join(COMPOSER_PASTES_DIR);
    let images_dir = data_root(app)?.join(COMPOSER_IMAGES_DIR);
    discard_managed_file(Path::new(path), &pastes_dir, &images_dir)
}

/// Only stable local classifications reach the durable audit. Upstream error text can carry
/// prompts, provider bodies or credentials; it stays in the transient AppError, not this file.
const AUDIT_DETAIL_CODES: &[&str] = &[
    "gateway_error",
    "gateway_timeout",
    "runtime_error",
    "provider_error",
    "stream_error",
];

fn audit_detail(detail: Option<&str>) -> Option<&str> {
    detail.filter(|value| AUDIT_DETAIL_CODES.contains(value))
}

fn append_audit(
    home: &Path,
    input: &HermesChatInput,
    outcome: &str,
    session: Option<&str>,
    detail: Option<&str>,
) {
    let entry = serde_json::json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "provider": input.provider,
        "model": input.model,
        "effort": input.effort,
        "toolsets": toolsets(input),
        "controlLevel": input.control_level,
        "promptChars": input.prompt.chars().count(),
        "outcome": outcome,
        "sessionId": session,
        "detail": audit_detail(detail)
    });
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // New files are owner-only from creation; existing files are tightened below.
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(home.join(AUDIT_FILE)) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        let _ = writeln!(file, "{entry}");
    }
}

fn audit_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(hermes_home(app)?.join(AUDIT_FILE))
}

pub async fn logout(
    app: &AppHandle,
    provider: &str,
    profile: Option<&str>,
) -> Result<(), AppError> {
    let Some(bin) = runtime_bin(app) else {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime is not installed.",
        ));
    };
    // Log out of the profile whose `auth.json` actually holds the login.
    let home = profiles::resolve_home(&hermes_home(app)?, profile)?;
    let hermes_provider = provider_id(provider);
    let mut command = runtime_command(&bin)?;
    profiles::pin_default_profile(&mut command, profile);
    command
        .arg("auth")
        .arg("logout")
        .arg(hermes_provider)
        .env("HERMES_HOME", &home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| AppError::new("E_HERMES_TIMEOUT", "Hermes logout timed out."))?
        .map_err(|error| {
            AppError::new("E_HERMES_RUNTIME", "Hermes logout could not start.")
                .with_detail(error.to_string())
        })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(300)
            .collect::<String>();
        return Err(AppError::new("E_HERMES_RUNTIME", "Hermes logout failed.").with_detail(detail));
    }
    Ok(())
}

pub async fn mcp_action(
    app: &AppHandle,
    action: &str,
    name: &str,
    url: &str,
    profile: Option<&str>,
    connection_id: Option<&str>,
    gateway_url: Option<&str>,
) -> Result<String, AppError> {
    let name = name.trim();
    if !matches!(action, "list" | "add" | "remove") {
        return Err(AppError::new("E_HERMES_INPUT", "Unknown MCP action."));
    }
    if action != "list" && (name.is_empty() || name.starts_with('-') || name.len() > 128) {
        return Err(AppError::new(
            "E_HERMES_INPUT",
            "A valid MCP server name is required.",
        ));
    }
    let url = url.trim();
    if action == "add" && !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::new(
            "E_HERMES_INPUT",
            "MCP URL must start with http:// or https://.",
        ));
    }
    if let Some(connection_id) = diagnostics::remote_connection(connection_id, gateway_url) {
        return diagnostics::mcp_action(connection_id, profile, action, name, url).await;
    }
    let Some(bin) = runtime_bin(app) else {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime is not installed.",
        ));
    };
    let root = hermes_home(app)?;
    profiles::ensure_local_profile(&root, profile)?;
    let home = profiles::resolve_home(&root, profile)?;
    let mut command = runtime_command(&bin)?;
    profiles::pin_default_profile(&mut command, profile);
    command.arg("mcp");
    match action {
        "list" => {
            command.arg("list");
        }
        "remove" => {
            command.arg("remove").arg(name);
        }
        "add" => {
            command.arg("add").arg(name).arg("--url").arg(url);
        }
        _ => {}
    }
    command
        .env("HERMES_HOME", home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| AppError::new("E_HERMES_TIMEOUT", "Hermes MCP action timed out."))?
        .map_err(|error| {
            AppError::new("E_HERMES_RUNTIME", "Hermes MCP action could not start.")
                .with_detail(error.to_string())
        })?;
    if !output.status.success() {
        let detail = diagnostics_failure_detail(&output.stderr);
        return Err(
            AppError::new("E_HERMES_RUNTIME", "Hermes MCP action failed.").with_detail(detail),
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn skill_action(
    app: &AppHandle,
    action: &str,
    identifier: &str,
    profile: Option<&str>,
    connection_id: Option<&str>,
    gateway_url: Option<&str>,
) -> Result<String, AppError> {
    let action = match action {
        "install" | "uninstall" => action,
        _ => return Err(AppError::new("E_HERMES_INPUT", "Unknown skill action.")),
    };
    let identifier = identifier.trim();
    if identifier.is_empty() || identifier.starts_with('-') || identifier.len() > 512 {
        return Err(AppError::new(
            "E_HERMES_INPUT",
            "A valid skill identifier is required.",
        ));
    }
    if let Some(connection_id) = diagnostics::remote_connection(connection_id, gateway_url) {
        return diagnostics::skill_action(connection_id, profile, action, identifier).await;
    }
    let Some(bin) = runtime_bin(app) else {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime is not installed.",
        ));
    };
    let root = hermes_home(app)?;
    profiles::ensure_local_profile(&root, profile)?;
    let home = profiles::resolve_home(&root, profile)?;
    let mut command = runtime_command(&bin)?;
    profiles::pin_default_profile(&mut command, profile);
    command
        .arg("skills")
        .arg(action)
        .arg(identifier)
        .arg("--yes")
        .env("HERMES_HOME", home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| AppError::new("E_HERMES_TIMEOUT", "Hermes skill action timed out."))?
        .map_err(|error| {
            AppError::new("E_HERMES_RUNTIME", "Hermes skill action could not start.")
                .with_detail(error.to_string())
        })?;
    if !output.status.success() {
        let detail = diagnostics_failure_detail(&output.stderr);
        return Err(
            AppError::new("E_HERMES_RUNTIME", "Hermes skill action failed.").with_detail(detail),
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn tool_action(
    app: &AppHandle,
    action: &str,
    name: &str,
    profile: Option<&str>,
    connection_id: Option<&str>,
    gateway_url: Option<&str>,
) -> Result<String, AppError> {
    let action = match action {
        "enable" | "disable" => action,
        _ => return Err(AppError::new("E_HERMES_INPUT", "Unknown tool action.")),
    };
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || name.len() > 512 {
        return Err(AppError::new(
            "E_HERMES_INPUT",
            "A valid toolset or MCP tool name is required.",
        ));
    }
    if let Some(connection_id) = diagnostics::remote_connection(connection_id, gateway_url) {
        return diagnostics::tool_action(connection_id, profile, action, name).await;
    }
    let Some(bin) = runtime_bin(app) else {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime is not installed.",
        ));
    };
    let root = hermes_home(app)?;
    profiles::ensure_local_profile(&root, profile)?;
    let home = profiles::resolve_home(&root, profile)?;
    let mut command = runtime_command(&bin)?;
    profiles::pin_default_profile(&mut command, profile);
    command
        .arg("tools")
        .arg(action)
        .arg(name)
        .env("HERMES_HOME", home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| AppError::new("E_HERMES_TIMEOUT", "Hermes tool action timed out."))?
        .map_err(|error| {
            AppError::new("E_HERMES_RUNTIME", "Hermes tool action could not start.")
                .with_detail(error.to_string())
        })?;
    if !output.status.success() {
        let detail = diagnostics_failure_detail(&output.stderr);
        return Err(
            AppError::new("E_HERMES_RUNTIME", "Hermes tool action failed.").with_detail(detail),
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn cron_action(
    app: &AppHandle,
    action: &str,
    job_id: &str,
    profile: Option<&str>,
    connection_id: Option<&str>,
    gateway_url: Option<&str>,
) -> Result<String, AppError> {
    let action = match action {
        "pause" | "resume" | "remove" => action,
        _ => return Err(AppError::new("E_HERMES_INPUT", "Unknown cron action.")),
    };
    let job_id = job_id.trim();
    if job_id.is_empty() || job_id.starts_with('-') {
        return Err(AppError::new(
            "E_HERMES_INPUT",
            "A valid cron job id is required.",
        ));
    }
    if let Some(connection_id) = diagnostics::remote_connection(connection_id, gateway_url) {
        return diagnostics::cron_action(connection_id, profile, action, job_id).await;
    }
    let Some(bin) = runtime_bin(app) else {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime is not installed.",
        ));
    };
    let root = hermes_home(app)?;
    profiles::ensure_local_profile(&root, profile)?;
    let home = profiles::resolve_home(&root, profile)?;
    let mut command = runtime_command(&bin)?;
    profiles::pin_default_profile(&mut command, profile);
    command
        .arg("cron")
        .arg(action)
        .arg(job_id)
        .env("HERMES_HOME", home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| AppError::new("E_HERMES_TIMEOUT", "Hermes cron action timed out."))?
        .map_err(|error| {
            AppError::new("E_HERMES_RUNTIME", "Hermes cron action could not start.")
                .with_detail(error.to_string())
        })?;
    if !output.status.success() {
        let detail = diagnostics_failure_detail(&output.stderr);
        return Err(
            AppError::new("E_HERMES_RUNTIME", "Hermes cron action failed.").with_detail(detail),
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Keep the tail of a failed CLI's stderr for the diagnostics pane. Python prints the
/// exception last, and the toast carries the short `message`, so truncating from the
/// front (as the action errors do) would drop the one line the pane exists to show.
fn diagnostics_failure_detail(stderr: &[u8]) -> String {
    const MAX_CHARS: usize = 4000;
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_CHARS {
        return text.to_owned();
    }
    let tail: String = chars[chars.len() - MAX_CHARS..].iter().collect();
    format!("…{tail}")
}

pub async fn cli_read(
    app: &AppHandle,
    kind: &str,
    profile: Option<&str>,
    connection_id: Option<&str>,
    gateway_url: Option<&str>,
) -> Result<String, AppError> {
    if let Some(connection_id) = diagnostics::remote_connection(connection_id, gateway_url) {
        return diagnostics::read(connection_id, profile, kind).await;
    }
    let Some(bin) = runtime_bin(app) else {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime is not installed.",
        ));
    };
    let root = hermes_home(app)?;
    profiles::ensure_local_profile(&root, profile)?;
    let home = profiles::resolve_home(&root, profile)?;
    let args: &[&str] = match kind {
        "tools" => &["tools", "list"],
        "skills" => &["skills", "list"],
        // `--all` includes disabled/completed jobs; the profile is already pinned by
        // `HERMES_HOME` (and `--profile default` for the root home). Without it the local
        // pane hides exactly the rows the remote `include_disabled=True` list shows.
        "cron" => &["cron", "list", "--all"],
        _ => {
            return Err(AppError::new(
                "E_HERMES_INPUT",
                "Unknown Hermes diagnostics section.",
            ));
        }
    };
    let mut command = runtime_command(&bin)?;
    profiles::pin_default_profile(&mut command, profile);
    command
        .args(args)
        .env("HERMES_HOME", home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| AppError::new("E_HERMES_TIMEOUT", "Hermes diagnostics timed out."))?
        .map_err(|error| {
            AppError::new("E_HERMES_RUNTIME", "Hermes diagnostics could not start.")
                .with_detail(error.to_string())
        })?;
    if !output.status.success() {
        let detail = diagnostics_failure_detail(&output.stderr);
        return Err(
            AppError::new("E_HERMES_RUNTIME", "Hermes diagnostics failed.").with_detail(detail),
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn audit_entries(app: &AppHandle, limit: usize) -> Result<Vec<HermesAuditEntry>, AppError> {
    let path = audit_path(app)?;
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    let mut entries = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .map(|value| HermesAuditEntry {
            at: value
                .get("at")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned(),
            provider: value
                .get("provider")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned(),
            model: value
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned(),
            toolsets: value
                .get("toolsets")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned(),
            control_level: value
                .get("controlLevel")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned(),
            prompt_chars: value
                .get("promptChars")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            outcome: value
                .get("outcome")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned(),
            session_id: value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            detail: value
                .get("detail")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
        })
        .collect::<Vec<_>>();
    if entries.len() > limit {
        entries = entries.split_off(entries.len() - limit);
    }
    entries.reverse();
    Ok(entries)
}

pub fn open_logs(app: &AppHandle) -> Result<(), AppError> {
    let path = hermes_home(app)?.join("logs");
    if !path.is_dir() {
        return Err(AppError::new("E_HERMES_LOGS", "No Hermes logs exist yet."));
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| {
            AppError::new("E_HERMES_LOGS", "Could not open the Hermes logs.")
                .with_detail(error.to_string())
        })?;
    Ok(())
}

pub fn open_audit(app: &AppHandle) -> Result<(), AppError> {
    let path = audit_path(app)?;
    if !path.is_file() {
        return Err(AppError::new(
            "E_HERMES_AUDIT",
            "No Hermes audit log exists yet.",
        ));
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| {
            AppError::new("E_HERMES_AUDIT", "Could not open the audit log.")
                .with_detail(error.to_string())
        })?;
    Ok(())
}

fn runtime_python(bin: &Path) -> Option<PathBuf> {
    let root = bin.parent()?.parent()?;
    let link = root.join("python").join("bin").join("python3");
    if link.is_file() {
        return Some(link);
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(root.join("python").join("bin"))
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix("python3."))
                .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit()))
        })
        .collect();
    found.sort();
    found.pop()
}

/// Entry point the generated runtime wrapper (`bin/hermes`) also uses.
const HERMES_ENTRYPOINT: &str = "from hermes_cli.main import main; main()";

/// Host variables the runtime needs. Everything else is dropped before spawning so a key that
/// happened to be present when the app was launched from a shell cannot reach terminal/screen
/// tools. Provider keys are loaded from `<HERMES_HOME>/.env` by the runtime itself.
const RUNTIME_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NO_PROXY",
    "no_proxy",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PYTHONIOENCODING",
    "PYTHONUTF8",
    "TERM",
];

fn inherited_runtime_env() -> Vec<(&'static str, OsString)> {
    RUNTIME_ENV_ALLOWLIST
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (*name, value)))
        .collect()
}

fn apply_runtime_environment(command: &mut Command) {
    command.env_clear().envs(inherited_runtime_env());
}

/// Build the runtime process directly instead of going through `bin/hermes` so the
/// interpreter is discovered rather than hard-coded by the generated wrapper. The
/// layout matches that wrapper (`<root>/python/bin/python3`, `<root>/site`).
///
/// No credential is injected here: provider keys live in `<HERMES_HOME>/.env`, which
/// the runtime loads itself (see [`env_store`]).
fn runtime_command(bin: &Path) -> Result<Command, AppError> {
    runtime_command_with_entrypoint(bin, HERMES_ENTRYPOINT)
}

fn runtime_command_with_entrypoint(bin: &Path, entrypoint: &str) -> Result<Command, AppError> {
    let python = runtime_python(bin).ok_or_else(|| {
        AppError::new(
            "E_HERMES_RUNTIME",
            "The Hermes runtime is incomplete. Reinstall it from the assistant.",
        )
    })?;
    let root = bin
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| AppError::new("E_HERMES_RUNTIME", "The Hermes runtime path is invalid."))?;
    let mut pythonpath = root.join("site").display().to_string();
    if let Some(existing) = std::env::var_os("PYTHONPATH")
        && !existing.is_empty()
    {
        pythonpath.push(':');
        pythonpath.push_str(&existing.to_string_lossy());
    }
    let mut command = Command::new(python);
    apply_runtime_environment(&mut command);
    command
        .arg("-c")
        .arg(entrypoint)
        .env("PYTHONPATH", pythonpath);
    Ok(command)
}

/// Resolve the provider key the runtime will authenticate with. Used for the gateway
/// fingerprint and for the custom-endpoint `key_env` decision.
///
/// The key is never injected into the child process: it lives in `<HERMES_HOME>/.env`, which the
/// runtime loads itself (see [`env_store`]). Inherited shell variables are deliberately ignored:
/// the runtime is launched with those credentials scrubbed, so counting one here would claim a
/// key exists while the runtime cannot read it.
fn resolve_provider_secret(home: &Path, input: &HermesChatInput) -> Option<String> {
    if let Some(key) = env_store::env_value(home, provider_key_env(&input.provider)) {
        return Some(key);
    }
    if matches!(input.provider.as_str(), "opencode" | "opencode-go")
        && let Some(key) = local_opencode_key(&input.provider)
    {
        return Some(key);
    }
    None
}

/// The `.env`/`config.yaml` state one chat turn needs, computed before the gateway decides
/// whether to accept it.
///
/// [`TurnConfig::prepare`] only reads: a request the gateway rejects as installing or busy
/// must leave the profile's files byte-for-byte untouched. [`TurnConfig::apply`] is the only
/// writer, and it takes the credential-store lock so a concurrent turn cannot lose its keys or
/// read a half-written file.
struct TurnConfig {
    /// The key the runtime will authenticate with once this plan is applied. Used for the
    /// gateway fingerprint, so a supplied key counts before it reaches `.env`.
    api_key: Option<String>,
    /// The key supplied with the request, which has to be persisted to `.env`.
    key_write: Option<String>,
}

impl TurnConfig {
    fn prepare(home: &Path, input: &HermesChatInput) -> Self {
        let key_write = input
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned);
        let api_key = match key_write {
            // A key sent with the request wins over the one already stored, exactly as the
            // sequential write-then-resolve did.
            Some(ref key) => Some(key.clone()),
            None => resolve_provider_secret(home, input),
        };
        Self { api_key, key_write }
    }

    fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    /// Re-read the stored credential once the gateway lock is held. A chat can queue behind
    /// another turn or a settings-page save while it prepares; using that earlier snapshot
    /// would fingerprint a key the spawned runtime no longer reads. A key supplied with the
    /// request is still authoritative.
    fn refresh_api_key(&mut self, home: &Path, input: &HermesChatInput) {
        if self.key_write.is_some() {
            return;
        }
        self.api_key = resolve_provider_secret(home, input);
    }

    /// Write the turn's `.env` key and merge its settings into `config.yaml`.
    ///
    /// Both files are re-read under the same lock as the write, so a concurrent turn (or the
    /// CLI) cannot have its keys dropped, and readers only ever see a complete file because
    /// the replacement is an atomic rename.
    fn apply(&self, home: &Path, input: &HermesChatInput) -> Result<(), AppError> {
        env_store::with_home_lock(home, || {
            let config_path = home.join("config.yaml");
            // The decision (fingerprint/reuse) used `self.api_key`. If a settings save changed
            // the stored key after that decision, applying now would start a runtime with a
            // different credential than the one the gateway decision was made for. Fail
            // without writing; the caller can retry with a fresh snapshot.
            if self.key_write.is_none() && resolve_provider_secret(home, input) != self.api_key {
                return Err(AppError::new(
                    "E_HERMES_CREDENTIAL_CHANGED",
                    "Hermes credentials changed while the request was waiting. Try again.",
                ));
            }
            // Read and render before touching either file: an unreadable or unparseable
            // config must fail the turn, never be replaced by a document built from an empty
            // base that would drop everything the user put there.
            let existing = read_config_for_update(&config_path)?;
            let mut doc = config_doc_for_update(existing.as_deref())?;
            let before = doc.clone();
            apply_turn_config(&mut doc, input);
            apply_custom_provider(&mut doc, input, self.api_key.is_some());
            let body = if doc == before {
                None
            } else {
                let body = render_config(&doc)?;
                (existing.as_deref() != Some(body.as_str())).then_some(body)
            };
            if let Some(key) = self.key_write.as_deref() {
                env_store::set_env_value_locked(home, provider_key_env(&input.provider), key)?;
            }
            if let Some(body) = body {
                // A named profile's home may not exist yet; `with_home_lock` created it, which
                // is what makes the directory a live `--profile` target for the gateway.
                env_store::atomic_write(&config_path, body.as_bytes())?;
            }
            Ok(())
        })
    }
}

/// Apply the desktop's settings to the runtime's `config.yaml` for a chat turn.
///
/// A key supplied with the request is persisted to `<HERMES_HOME>/.env`; otherwise the
/// value already in `.env` is used as-is. That is the same store the official CLI and
/// dashboard read and write, so both see one set of credentials.
///
/// The document is merged, not replaced: keys this app does not own (tools, skills, browser,
/// cron, other providers, anything the user added by hand) survive the write. The runtime's own
/// `save_config` rewrites the file the same way, so YAML comments in it were never durable.
///
/// Returns the key the runtime will authenticate with, so the caller can fingerprint it.
fn write_config(home: &Path, input: &HermesChatInput) -> Result<Option<String>, AppError> {
    let config = TurnConfig::prepare(home, input);
    config.apply(home, input)?;
    Ok(config.api_key)
}

fn endpoint_of(input: &HermesChatInput) -> Option<&str> {
    input
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn custom_provider_endpoint<'a>(provider: &str, endpoint: Option<&'a str>) -> Option<&'a str> {
    match provider {
        "local" => endpoint.or(Some("http://127.0.0.1:11434/v1")),
        "custom" => endpoint,
        _ => None,
    }
}

/// Apply the keys a chat turn owns.
fn apply_turn_config(doc: &mut Yaml, input: &HermesChatInput) {
    remove_path(doc, &["agent", "image_input_mode"]);
    if input.force_aux_vision {
        set_path(
            doc,
            &["agent", "image_input_mode"],
            Yaml::String("text".into()),
        );
    }
    set_path(
        doc,
        &["agent", "reasoning_effort"],
        Yaml::String(reasoning_effort(&input.effort).unwrap_or("").to_owned()),
    );
    set_path(doc, &["display", "show_reasoning"], Yaml::Boolean(false));
    set_path(doc, &["display", "streaming"], Yaml::Boolean(true));
    // No credential is written to this file: keys stay in `.env`, and `env_passthrough`
    // stays empty so no tool can opt a credential into its own child environment.
    set_path(
        doc,
        &["terminal", "env_passthrough"],
        Yaml::Array(Vec::new()),
    );
    set_path(
        doc,
        &["terminal", "client_env_passthrough"],
        Yaml::Array(Vec::new()),
    );
    set_path(
        doc,
        &["model", "provider"],
        Yaml::String(provider_id(&input.provider).to_owned()),
    );
    set_path(
        doc,
        &["model", "default"],
        Yaml::String(input.model.clone()),
    );
    remove_path(doc, &["model", "base_url"]);
    if let Some(endpoint) = endpoint_of(input) {
        set_path(
            doc,
            &["model", "base_url"],
            Yaml::String(endpoint.to_owned()),
        );
    }
    // Every auxiliary slot the request mentions belongs to the desktop store, so a slot the
    // user put back on "auto" has to disappear instead of keeping its previous override.
    // Slots this build does not know about are left alone.
    for entry in &input.auxiliary {
        remove_path(doc, &["auxiliary", entry.task.as_str()]);
    }
    for entry in input
        .auxiliary
        .iter()
        .filter(|entry| entry.provider != "auto" && !entry.model.is_empty())
    {
        set_path(
            doc,
            &["auxiliary", entry.task.as_str(), "provider"],
            Yaml::String(entry.provider.clone()),
        );
        set_path(
            doc,
            &["auxiliary", entry.task.as_str(), "model"],
            Yaml::String(entry.model.clone()),
        );
    }
}

/// Apply the user-defined provider block the custom and local cards are served by.
fn apply_custom_provider(doc: &mut Yaml, input: &HermesChatInput, has_key: bool) {
    remove_path(doc, &["providers", "openavoo-custom"]);
    let Some(endpoint) = custom_provider_endpoint(&input.provider, endpoint_of(input)) else {
        return;
    };
    set_path(
        doc,
        &["providers", "openavoo-custom", "api"],
        Yaml::String(endpoint.to_owned()),
    );
    set_path(
        doc,
        &["providers", "openavoo-custom", "transport"],
        Yaml::String("chat_completions".into()),
    );
    // `key_env` names the `.env` variable holding the custom endpoint's key; the value itself
    // never reaches this file. `discover_models: true` lets the runtime list the endpoint's own
    // models (`GET <api>/models`); with it off the picker could only ever offer the single model
    // written below.
    if has_key {
        set_path(
            doc,
            &["providers", "openavoo-custom", "key_env"],
            Yaml::String("OPENNAVO_CUSTOM_API_KEY".into()),
        );
    }
    set_path(
        doc,
        &["providers", "openavoo-custom", "default_model"],
        Yaml::String(input.model.clone()),
    );
    set_path(
        doc,
        &["providers", "openavoo-custom", "models"],
        Yaml::Array(vec![Yaml::String(input.model.clone())]),
    );
    set_path(
        doc,
        &["providers", "openavoo-custom", "discover_models"],
        Yaml::Boolean(true),
    );
}

/// Parse `config.yaml` into the document a write merges onto.
///
/// Anything this crate cannot round-trip (invalid YAML, a non-mapping document, anchors) counts
/// as absent: the caller then writes a complete document, which is what the app did before it
/// merged.
fn config_doc(raw: Option<&str>) -> Yaml {
    let Some(raw) = raw else {
        return Yaml::Hash(Hash::new());
    };
    let Ok(docs) = YamlLoader::load_from_str(raw) else {
        return Yaml::Hash(Hash::new());
    };
    match docs.into_iter().next() {
        Some(doc @ Yaml::Hash(_)) if !has_alias(&doc) => doc,
        _ => Yaml::Hash(Hash::new()),
    }
}

/// Read `config.yaml` for a merge write.
///
/// Only a missing file counts as empty. Any other read failure is a real error: treating it as
/// absent would replace a file the user may still recover with a document built from scratch.
fn read_config_for_update(path: &Path) -> Result<Option<String>, AppError> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|error| {
            AppError::new(
                "E_HERMES_CONFIG",
                "The Hermes configuration is not valid UTF-8.",
            )
            .with_detail(error.to_string())
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::new(
            "E_HERMES_CONFIG",
            "Could not read the Hermes configuration.",
        )
        .with_detail(error.to_string())),
    }
}

/// Parse `config.yaml` into the document a write merges onto.
///
/// Unlike [`config_doc`], which is a best-effort read for timeouts, a document this crate
/// cannot merge onto is an error. Writing from an empty base would silently drop every setting
/// the user put in a file we failed to parse.
fn config_doc_for_update(raw: Option<&str>) -> Result<Yaml, AppError> {
    let Some(raw) = raw else {
        return Ok(Yaml::Hash(Hash::new()));
    };
    if raw.trim().is_empty() {
        return Ok(Yaml::Hash(Hash::new()));
    }
    let unreadable = |detail: String| {
        AppError::new(
            "E_HERMES_CONFIG",
            "The Hermes configuration could not be parsed.",
        )
        .with_detail(detail)
    };
    let docs = YamlLoader::load_from_str(raw).map_err(|error| unreadable(error.to_string()))?;
    match docs.into_iter().next() {
        Some(doc @ Yaml::Hash(_)) if !has_alias(&doc) => Ok(doc),
        Some(_) => Err(unreadable(
            "The file does not contain a mapping this app can merge onto.".into(),
        )),
        None => Ok(Yaml::Hash(Hash::new())),
    }
}

fn has_alias(value: &Yaml) -> bool {
    match value {
        Yaml::Alias(_) | Yaml::BadValue => true,
        Yaml::Array(items) => items.iter().any(has_alias),
        Yaml::Hash(map) => map
            .iter()
            .any(|(key, value)| has_alias(key) || has_alias(value)),
        _ => false,
    }
}

fn hash_mut(value: &mut Yaml) -> &mut Hash {
    if !matches!(value, Yaml::Hash(_)) {
        *value = Yaml::Hash(Hash::new());
    }
    let Yaml::Hash(map) = value else {
        unreachable!("a hash was just inserted")
    };
    map
}

fn lookup_mut<'a>(doc: &'a mut Yaml, path: &[&str]) -> Option<&'a mut Yaml> {
    let mut node = doc;
    for key in path {
        let Yaml::Hash(map) = node else {
            return None;
        };
        node = map.get_mut(&Yaml::String((*key).to_owned()))?;
    }
    Some(node)
}

fn set_path(doc: &mut Yaml, path: &[&str], value: Yaml) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut node = doc;
    for key in parents {
        node = hash_mut(node)
            .entry(Yaml::String((*key).to_owned()))
            .or_insert_with(|| Yaml::Hash(Hash::new()));
    }
    hash_mut(node).insert(Yaml::String((*last).to_owned()), value);
}

/// Remove one key, and any section the removal leaves empty, without touching its siblings.
fn remove_path(doc: &mut Yaml, path: &[&str]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    if let Some(Yaml::Hash(map)) = lookup_mut(doc, parents) {
        map.remove(&Yaml::String((*last).to_owned()));
    }
    for depth in (1..=parents.len()).rev() {
        let empty =
            matches!(lookup_mut(doc, &path[..depth]), Some(Yaml::Hash(map)) if map.is_empty());
        if !empty {
            break;
        }
        let Some((key, grand)) = path[..depth].split_last() else {
            break;
        };
        if let Some(Yaml::Hash(map)) = lookup_mut(doc, grand) {
            map.remove(&Yaml::String((*key).to_owned()));
        }
    }
}

fn render_config(doc: &Yaml) -> Result<String, AppError> {
    if matches!(doc, Yaml::Hash(map) if map.is_empty()) {
        return Ok(String::new());
    }
    let mut out = String::new();
    YamlEmitter::new(&mut out).dump(doc).map_err(|error| {
        AppError::new(
            "E_HERMES_CONFIG",
            "Could not serialize the Hermes configuration.",
        )
        .with_detail(error.to_string())
    })?;
    let body = out.strip_prefix("---\n").unwrap_or(&out).to_owned();
    // Keep a POSIX trailing newline so re-writing an unchanged document stays a no-op.
    let body = if body.ends_with('\n') {
        body
    } else {
        format!("{body}\n")
    };
    // `YamlEmitter` only quotes what YAML requires, and a bare `4` or `~` is legal but reads back
    // as an integer and a null. When the emitted text no longer parses back to the same document,
    // fall back to quoting every string so the file means exactly what was written.
    let reparsed = YamlLoader::load_from_str(&body)
        .ok()
        .and_then(|docs| docs.into_iter().next());
    if reparsed.as_ref() == Some(doc) {
        return Ok(body);
    }
    Ok(quoted_config(doc))
}

/// Serialize a document with every string quoted: the exact fallback for [`render_config`].
fn quoted_config(doc: &Yaml) -> String {
    let mut out = String::new();
    write_block(&mut out, doc, 0);
    out.push('\n');
    out
}

fn write_block(out: &mut String, value: &Yaml, indent: usize) {
    match value {
        Yaml::Hash(map) => {
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push('\n');
                }
                pad(out, indent);
                write_scalar(out, key);
                out.push(':');
                write_child(out, item, indent);
            }
        }
        Yaml::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push('\n');
                }
                pad(out, indent);
                out.push('-');
                write_child(out, item, indent);
            }
        }
        other => {
            pad(out, indent);
            write_scalar(out, other);
        }
    }
}

fn write_child(out: &mut String, value: &Yaml, indent: usize) {
    match value {
        Yaml::Hash(map) if map.is_empty() => out.push_str(" {}"),
        Yaml::Array(items) if items.is_empty() => out.push_str(" []"),
        Yaml::Hash(_) | Yaml::Array(_) => {
            out.push('\n');
            write_block(out, value, indent + 2);
        }
        other => {
            out.push(' ');
            write_scalar(out, other);
        }
    }
}

fn write_scalar(out: &mut String, value: &Yaml) {
    match value {
        // `serde_json` escaping is a subset of YAML's double-quoted style, so a string is always
        // safe to write this way.
        Yaml::String(text) => match serde_json::to_string(text) {
            Ok(quoted) => out.push_str(&quoted),
            Err(_) => out.push_str("\"\""),
        },
        Yaml::Integer(number) => out.push_str(&number.to_string()),
        Yaml::Real(number) => out.push_str(number),
        Yaml::Boolean(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Yaml::Hash(_) | Yaml::Array(_) | Yaml::Null | Yaml::BadValue | Yaml::Alias(_) => {
            out.push_str("null");
        }
    }
}

fn pad(out: &mut String, indent: usize) {
    for _ in 0..indent {
        out.push(' ');
    }
}

fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
}

/// Store a provider API key in the selected profile's `.env`, the same file the official
/// Hermes CLI and dashboard read and write. `profile` is `None`/`default` for the root home,
/// otherwise the key belongs to `<root>/profiles/<name>/.env`.
pub fn secret_set(
    app: &AppHandle,
    provider: &str,
    key: &str,
    profile: Option<&str>,
) -> Result<(), AppError> {
    let home = profiles::resolve_home(&hermes_home(app)?, profile)?;
    env_store::set_env_value(&home, provider_key_env(provider), key)
}

/// Whether a key is stored for `provider` in the selected profile.
pub fn secret_status(
    app: &AppHandle,
    provider: &str,
    profile: Option<&str>,
) -> Result<bool, AppError> {
    let home = profiles::resolve_home(&hermes_home(app)?, profile)?;
    Ok(env_store::env_has(&home, provider_key_env(provider)))
}

/// Remove a provider's key line from the selected profile's `.env`.
pub fn secret_delete(
    app: &AppHandle,
    provider: &str,
    profile: Option<&str>,
) -> Result<(), AppError> {
    let home = profiles::resolve_home(&hermes_home(app)?, profile)?;
    env_store::remove_env_value(&home, provider_key_env(provider))?;
    Ok(())
}

/// Remote connections are Panel-only: the token-based remote transport was removed with
/// the connection kinds that used it (`stores/hermes.ts` keeps `local` and `panel`).
pub fn remote_auth_required() -> AppError {
    AppError::new(
        "E_HERMES_REMOTE_AUTH",
        "Remote connections sign in through Hermes Panel.",
    )
}

/// App data root, for the stores that are not part of `HERMES_HOME`.
fn session_root() -> Result<&'static Path, AppError> {
    #[cfg(test)]
    if let Some(root) = PANEL_TEST_ROOT.get() {
        return Ok(root.path());
    }
    DATA_ROOT
        .get()
        .map(PathBuf::as_path)
        .ok_or_else(|| AppError::new("E_HERMES_HOME", "The app data directory is unavailable."))
}

/// Tests share one session root for the whole process. A per-test TempDir was dropped while
/// other parallel tests still used its path (EINVAL on rename). Profile keys stay unique.
#[cfg(test)]
static PANEL_TEST_ROOT: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) fn use_panel_session_root() {
    let _ = PANEL_TEST_ROOT.get_or_init(|| tempfile::tempdir().expect("panel session temp root"));
}

fn panel_cache() -> &'static Mutex<std::collections::HashMap<String, panel::PanelSession>> {
    static CACHE: std::sync::OnceLock<
        Mutex<std::collections::HashMap<String, panel::PanelSession>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Serializes disk and cache changes together. Without one boundary a set and a concurrent
/// get/delete can leave the cache and `session.json` disagreeing (old cookies resurrected,
/// or a fresh login overwritten by a slower response).
fn panel_store_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn cache_guard() -> Result<
    std::sync::MutexGuard<'static, std::collections::HashMap<String, panel::PanelSession>>,
    AppError,
> {
    panel_cache()
        .lock()
        .map_err(|_| AppError::new("E_HERMES_CREDENTIAL", "Panel session cache is poisoned."))
}

/// Whether two snapshots describe the same sign-in. Rotation keeps `login_id`; a re-login
/// gets a new one, so a logout/refresh from the old sign-in must not touch it. Legacy
/// sessions (written before the field) fall back to full equality.
fn same_panel_login(current: &panel::PanelSession, used: &panel::PanelSession) -> bool {
    if current.login_id.is_empty() || used.login_id.is_empty() {
        return current == used;
    }
    current.login_id == used.login_id && current.base_url == used.base_url
}

fn missing_panel_session() -> AppError {
    panel::session_missing()
}

/// Current session from cache or disk. Caller holds [`panel_store_lock`].
fn current_session_locked(profile_id: &str) -> Result<Option<panel::PanelSession>, AppError> {
    let cached = cache_guard()?.get(profile_id).cloned();
    if cached.is_some() {
        return Ok(cached);
    }
    let Some(value) = env_store::session_get(session_root()?, profile_id) else {
        return Ok(None);
    };
    let session: panel::PanelSession = serde_json::from_value(value).map_err(|error| {
        AppError::new("E_HERMES_CREDENTIAL", "The panel session is corrupt.")
            .with_detail(error.to_string())
    })?;
    cache_guard()?.insert(profile_id.to_owned(), session.clone());
    Ok(Some(session))
}

fn encode_session(session: &panel::PanelSession) -> Result<serde_json::Value, AppError> {
    serde_json::to_value(session).map_err(|error| {
        AppError::new("E_HERMES_CREDENTIAL", "Could not encode the panel session.")
            .with_detail(error.to_string())
    })
}

/// Persist a panel session and prime the in-process cache as one transaction.
pub fn panel_session_set(profile_id: &str, session: &panel::PanelSession) -> Result<(), AppError> {
    let value = encode_session(session)?;
    let _store = panel_store_lock();
    env_store::session_set(session_root()?, profile_id, value)?;
    cache_guard()?.insert(profile_id.to_owned(), session.clone());
    Ok(())
}

pub fn panel_session(profile_id: &str) -> Result<panel::PanelSession, AppError> {
    let _store = panel_store_lock();
    current_session_locked(profile_id)?.ok_or_else(missing_panel_session)
}

pub fn panel_session_delete(profile_id: &str) -> Result<(), AppError> {
    let _store = panel_store_lock();
    // Delete the durable copy first: if it fails, the cache must keep describing the file.
    env_store::session_delete(session_root()?, profile_id)?;
    cache_guard()?.remove(profile_id);
    Ok(())
}

/// Store a rotated session only when the stored one is still the snapshot the request used.
///
/// A login can replace the same profile id while an older request is still in flight. That
/// request's rotated cookies belong to the old session and must not overwrite the new one.
pub fn panel_session_update_if(
    profile_id: &str,
    used: &panel::PanelSession,
    next: &panel::PanelSession,
) -> Result<bool, AppError> {
    let value = encode_session(next)?;
    let _store = panel_store_lock();
    let Some(current) = current_session_locked(profile_id)? else {
        return Ok(false);
    };
    // A rotation belongs to the exact cookie snapshot the response was produced from. A
    // newer rotation that landed first must win; this response then fails CAS.
    if current != *used {
        return Ok(false);
    }
    env_store::session_set(session_root()?, profile_id, value)?;
    cache_guard()?.insert(profile_id.to_owned(), next.clone());
    Ok(true)
}

/// Delete a session only when it is still the one the caller acted on. A logout that raced a
/// fresh login must leave the newer session in place.
pub fn panel_session_delete_if(
    profile_id: &str,
    used: &panel::PanelSession,
) -> Result<bool, AppError> {
    let _store = panel_store_lock();
    let Some(current) = current_session_locked(profile_id)? else {
        return Ok(false);
    };
    if !same_panel_login(&current, used) {
        return Ok(false);
    }
    env_store::session_delete(session_root()?, profile_id)?;
    cache_guard()?.remove(profile_id);
    Ok(true)
}

/// Logout's "nothing was stored" branch: a login that landed after that read must survive, so
/// delete only if the store is still empty.
pub fn panel_session_delete_if_absent(profile_id: &str) -> Result<bool, AppError> {
    let _store = panel_store_lock();
    if current_session_locked(profile_id)?.is_some() {
        return Ok(false);
    }
    env_store::session_delete(session_root()?, profile_id)?;
    cache_guard()?.remove(profile_id);
    Ok(true)
}

/// Drop every cached panel session. The stored copies live under the data root, so an
/// uninstall removes them; this keeps the running process from holding them too.
pub fn panel_sessions_forget() {
    let _store = panel_store_lock();
    if let Ok(mut cache) = cache_guard() {
        cache.clear();
    }
}

fn local_opencode_key(provider: &str) -> Option<String> {
    let key = match provider {
        "opencode" => "opencode",
        "opencode-go" => "opencode-go",
        _ => return None,
    };
    let path = std::env::var_os("HOME")
        .map(PathBuf::from)?
        .join(".local/share/opencode/auth.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    value
        .get(key)
        .and_then(|entry| entry.get("key"))
        .and_then(|key| key.as_str())
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

/// Cache the app data root and start the one-time credential migration. Called once
/// from the app setup hook so panel-session helpers never depend on call order.
pub fn init(app: &AppHandle) {
    if data_root(app).is_ok() {
        migrate_legacy_credentials(app);
    }
}

/// Kick off the one-time migration of credentials older builds kept in the Keychain.
/// Runs at most once per process, on a detached thread, and never blocks startup.
fn migrate_legacy_credentials(app: &AppHandle) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let (Ok(root), Ok(home)) = (data_root(app), hermes_home(app)) else {
            return;
        };
        legacy_migration::spawn(root, home);
    });
}

#[derive(Debug)]
struct RuntimeVersionProbe {
    success: bool,
    stderr: String,
    version: Option<String>,
}

/// Read the runtime's own version with an empty, throwaway HERMES_HOME.
///
/// Without this, Hermes falls back to the user's `~/.hermes` checkout (or a
/// source tree) and can report a version that has nothing to do with the
/// packaged runtime OpenNavo installed.
async fn probe_runtime_version(bin: &Path) -> Result<RuntimeVersionProbe, AppError> {
    let check_home =
        std::env::temp_dir().join(format!("opennavo-hermes-check-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&check_home)?;
    let mut command = Command::new("/bin/sh");
    apply_runtime_environment(&mut command);
    command
        .arg(bin)
        .arg("--version")
        .env("HERMES_HOME", &check_home)
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&check_home);
            return Err(
                AppError::new("E_HERMES_RUNTIME", "Hermes runtime could not start.")
                    .with_detail(error.to_string()),
            );
        }
    };
    let mut stdout_pipe = child.stdout.take().expect("version probe stdout is piped");
    let mut stderr_pipe = child.stderr.take().expect("version probe stderr is piped");
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let output = timeout(VERSION_TIMEOUT, async {
        let (stdout_result, stderr_result, status_result) = tokio::join!(
            stdout_pipe.read_to_end(&mut stdout),
            stderr_pipe.read_to_end(&mut stderr),
            child.wait(),
        );
        (stdout_result, stderr_result, status_result)
    })
    .await;
    let (stdout_result, stderr_result, status_result) = match output {
        Ok(output) => output,
        Err(_) => {
            // `kill_on_drop` would reap the child when the future is dropped, but the
            // throwaway HERMES_HOME must outlive the process that is still using it.
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = std::fs::remove_dir_all(&check_home);
            return Err(AppError::new(
                "E_HERMES_TIMEOUT",
                "Hermes version check timed out.",
            ));
        }
    };
    let _ = std::fs::remove_dir_all(&check_home);
    stdout_result.map_err(|error| {
        AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime output could not be read.",
        )
        .with_detail(error.to_string())
    })?;
    stderr_result.map_err(|error| {
        AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime output could not be read.",
        )
        .with_detail(error.to_string())
    })?;
    let status = status_result.map_err(|error| {
        AppError::new("E_HERMES_RUNTIME", "Hermes runtime could not start.")
            .with_detail(error.to_string())
    })?;
    let stdout = clean_output(&String::from_utf8_lossy(&stdout));
    let stderr = clean_output(&String::from_utf8_lossy(&stderr));
    Ok(RuntimeVersionProbe {
        success: status.success(),
        version: status
            .success()
            .then(|| runtime_version_from_output(&stdout))
            .flatten(),
        stderr,
    })
}

async fn verify_runtime_bin(bin: &Path, expected: &str) -> Result<(), AppError> {
    let probe = probe_runtime_version(bin).await?;
    if !probe.success {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "The Hermes runtime version check failed.",
        )
        .with_detail(probe.stderr));
    }
    let actual = probe.version.unwrap_or_else(|| "unknown".to_owned());
    if actual != expected {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "The Hermes runtime does not match the pinned version.",
        )
        .with_detail(format!("expected {expected}, got {actual}")));
    }
    Ok(())
}

pub async fn status(app: AppHandle) -> Result<HermesRuntimeStatus, AppError> {
    migrate_legacy_credentials(&app);
    hygiene::repair_runtime_tree_once(&app).await;
    let expected_version = expected_runtime_version()?;
    let Some(bin) = runtime_bin(&app) else {
        log::warn!("Hermes runtime status: no runtime binary found");
        return Ok(HermesRuntimeStatus {
            ready: false,
            installed: false,
            version: None,
            expected_version,
            path: None,
            data_path: data_root(&app).ok().map(|path| path.display().to_string()),
            computer_use: false,
            outdated: false,
            message: Some("Hermes runtime is not installed. Install it from the assistant.".into()),
        });
    };
    log::info!("Hermes runtime status: checking {}", bin.display());
    let probe = probe_runtime_version(&bin).await.map_err(|error| {
        log::warn!("Hermes runtime status: version check failed: {error}");
        error
    })?;
    if !probe.success {
        log::warn!(
            "Hermes runtime status: version failed stderr={}",
            probe.stderr
        );
        return Ok(HermesRuntimeStatus {
            ready: false,
            installed: true,
            version: None,
            expected_version,
            path: Some(bin.display().to_string()),
            data_path: data_root(&app).ok().map(|path| path.display().to_string()),
            computer_use: false,
            outdated: false,
            message: Some(probe.stderr),
        });
    }
    let version = probe.version;
    let computer_use = bin
        .parent()
        .and_then(|dir| dir.parent())
        .map(|root| {
            root.join("CuaDriver.app/Contents/MacOS/cua-driver")
                .is_file()
        })
        .unwrap_or(false);
    let outdated = version.as_deref() != Some(expected_version.as_str());
    let message = version.is_none().then(|| {
        format!(
            "The installed Hermes runtime does not report a packaged version. Update it to {expected_version}."
        )
    });
    log::info!(
        "Hermes runtime status: ready {} (computer_use={computer_use}, outdated={outdated})",
        version.as_deref().unwrap_or("unknown")
    );
    Ok(HermesRuntimeStatus {
        ready: true,
        installed: true,
        version,
        expected_version,
        path: Some(bin.display().to_string()),
        data_path: data_root(&app).ok().map(|path| path.display().to_string()),
        computer_use,
        outdated,
        message,
    })
}

pub async fn chat(
    app: AppHandle,
    state: &HermesRuntimeState,
    input: HermesChatInput,
) -> Result<HermesChatReply, AppError> {
    let home = hermes_home(&app)?;
    if input
        .gateway_url
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        let profile_id = input.profile_id.as_deref().unwrap_or_default().to_owned();
        if input.panel_auth {
            let panel_url = panel::base_url_for(&profile_id)?;
            // The ws ticket is minted inside `chat_remote_auth`, after attachments are read.
            // Minting it here let a slow transfer spend the 30-second single-use ticket.
            return gateway::chat_remote_auth(
                &panel_url,
                None,
                &home,
                state,
                input,
                Some(&app),
                None,
            )
            .await;
        }
        return Err(remote_auth_required());
    }
    let Some(bin) = runtime_bin(&app) else {
        return Err(AppError::new(
            "E_HERMES_RUNTIME",
            "Hermes runtime is not installed. Install it from the assistant.",
        ));
    };
    gateway::chat(&bin, &home, state, input, Some(&app), None).await
}

#[allow(dead_code)]
async fn chat_with_bin(
    bin: &Path,
    home: &Path,
    state: &HermesRuntimeState,
    input: HermesChatInput,
    app: Option<&AppHandle>,
    sink: Option<UnboundedSender<String>>,
) -> Result<HermesChatReply, AppError> {
    if input.prompt.trim().is_empty() {
        return Err(AppError::new("E_HERMES_INPUT", "The message is empty."));
    }
    write_config(home, &input)?;

    let prompt = {
        let mut prompt = input.prompt.clone();
        for path in &input.attachments {
            prompt.push_str(&format!("\n[Attached file: {path}]"));
        }
        prompt
    };
    let provider = provider_id(&input.provider);
    let mut command = runtime_command(bin)?;
    if let Some(dir) = bin.parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![dir.to_path_buf()];
        paths.extend(std::env::split_paths(&path));
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
        let cua = dir
            .parent()
            .map(|root| root.join("CuaDriver.app/Contents/MacOS/cua-driver"));
        if let Some(cua) = cua.filter(|path| path.is_file()) {
            command.env("HERMES_CUA_DRIVER_CMD", cua);
        }
    }
    command
        .arg("chat")
        .arg("-Q")
        .arg("--provider")
        .arg(provider)
        .arg("--model")
        .arg(&input.model)
        .arg("--toolsets")
        .arg(toolsets(&input))
        .arg("-q")
        .arg(&prompt)
        .env("HERMES_HOME", home)
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(session) = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg("--resume").arg(session);
    }
    if input.mac_enabled && input.control_level == "full" && !input.confirm_writes {
        command.arg("--yolo");
    }
    if let Some(dir) = input
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty() && Path::new(dir).is_dir())
    {
        command.current_dir(dir);
    }
    let mut child = command.spawn().map_err(|error| {
        AppError::new("E_HERMES_RUNTIME", "Hermes runtime could not start.")
            .with_detail(error.to_string())
    })?;
    let pid = child.id();
    if let Some(pid) = pid
        && let Ok(mut current) = state.pid.lock()
    {
        *current = Some(pid);
    }
    let Some(stdout) = child.stdout.take() else {
        return Err(AppError::new(
            "E_HERMES_CHAT",
            "Hermes stdout was unavailable.",
        ));
    };
    let Some(stderr) = child.stderr.take() else {
        return Err(AppError::new(
            "E_HERMES_CHAT",
            "Hermes stderr was unavailable.",
        ));
    };
    let request_id = input.request_id.clone();
    let emitter = app.cloned();
    let stdout_task =
        tokio::spawn(async move { consume_stdout(stdout, emitter, sink, request_id).await });
    let stderr_task = tokio::spawn(async move {
        let mut buffer = String::new();
        let mut reader = stderr;
        let _ = reader.read_to_string(&mut buffer).await;
        buffer
    });

    let status = timeout(CHAT_TIMEOUT, child.wait()).await;
    if let Ok(mut current) = state.pid.lock() {
        *current = None;
    }
    let status = match status {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            stdout_task.abort();
            stderr_task.abort();
            return Err(AppError::new("E_HERMES_CHAT", "Hermes chat failed.")
                .with_detail(error.to_string()));
        }
        Err(_) => {
            if let Some(pid) = pid {
                kill_pid(pid);
            }
            stdout_task.abort();
            stderr_task.abort();
            return Err(AppError::new(
                "E_HERMES_TIMEOUT",
                "Hermes took too long to answer.",
            ));
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = clean_output(&stderr_task.await.unwrap_or_default());
    let stdout = clean_response(&stdout);
    if !status.success() {
        let detail = if stderr.is_empty() {
            stdout.clone()
        } else {
            stderr.clone()
        };
        append_audit(
            home,
            &input,
            "failed",
            session_id(&stderr).as_deref(),
            Some("runtime_error"),
        );
        return Err(
            AppError::new("E_HERMES_CHAT", "Hermes could not complete this request.")
                .with_detail(detail),
        );
    }
    let session = session_id(&stderr);
    append_audit(home, &input, "succeeded", session.as_deref(), None);
    Ok(HermesChatReply {
        text: stdout,
        session_id: session,
        live_session_id: None,
        usage: None,
        interrupted: false,
    })
}

#[derive(Default)]
#[allow(dead_code)]
struct StreamFilter {
    initial: String,
    checked: bool,
}

#[allow(dead_code)]
impl StreamFilter {
    /// Hold the first line long enough to drop Hermes' optional scanner warning,
    /// then release tokens immediately so the UI can render them as they arrive.
    /// The warning is sometimes printed without a newline before the answer.
    fn push(&mut self, text: &str) -> String {
        if self.checked {
            return text.to_owned();
        }
        self.initial.push_str(text);
        let trimmed = self.initial.trim_start();
        if trimmed.is_empty() {
            return String::new();
        }
        if !trimmed.starts_with('⚠') {
            self.checked = true;
            return std::mem::take(&mut self.initial);
        }
        if let Some(index) = self.initial.find("pattern matching only") {
            let marker = "pattern matching only";
            let rest = self.initial[index + marker.len()..].to_owned();
            self.initial.clear();
            self.checked = true;
            return rest.trim_start_matches(['\r', '\n']).to_owned();
        }
        if self.initial.len() >= 300 {
            self.checked = true;
            return std::mem::take(&mut self.initial);
        }
        String::new()
    }

    fn finish(&mut self) -> String {
        if self.checked {
            return String::new();
        }
        self.checked = true;
        std::mem::take(&mut self.initial)
    }
}

#[allow(dead_code)]
async fn consume_stdout<R: AsyncRead + Unpin>(
    mut reader: R,
    app: Option<AppHandle>,
    sink: Option<UnboundedSender<String>>,
    request_id: String,
) -> String {
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 1024];
    let mut filter = StreamFilter::default();
    let mut full = String::new();
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        raw.extend_from_slice(&buffer[..read]);
        let valid = match std::str::from_utf8(&raw) {
            Ok(value) => value.len(),
            Err(error) => error.valid_up_to(),
        };
        if valid == 0 {
            continue;
        }
        let text = String::from_utf8_lossy(&raw[..valid]).into_owned();
        raw.drain(..valid);
        let delta = filter.push(&clean_output(&text));
        if delta.is_empty() {
            continue;
        }
        full.push_str(&delta);
        if let Some(sink) = &sink {
            let _ = sink.send(delta.clone());
        }
        if let Some(app) = &app {
            let _ = app.emit(
                "hermes-chunk",
                HermesChunk {
                    request_id: request_id.clone(),
                    delta,
                },
            );
        }
    }
    let tail = filter.finish();
    if !tail.is_empty() {
        full.push_str(&tail);
        if let Some(sink) = &sink {
            let _ = sink.send(tail.clone());
        }
        if let Some(app) = &app {
            let _ = app.emit(
                "hermes-chunk",
                HermesChunk {
                    request_id,
                    delta: tail,
                },
            );
        }
    }
    full
}

pub async fn stop(state: &HermesRuntimeState) -> Result<(), AppError> {
    // Shutdown is global: every parked card is refused and every turn registration goes
    // away, because the process is going away with them.
    state.cancel_all_turn_asks();
    stop_local_gateway(state).await
}

/// Stop the local gateway (and the turn that asked, when named) without touching cards a
/// Panel host owns. A runtime update or the UI's hard stop uses this; app exit uses [`stop`].
pub async fn stop_local(state: &HermesRuntimeState, turn: Option<&str>) -> Result<(), AppError> {
    let Some(turn) = turn else {
        // Install/uninstall: wake every local card wait, leave Panel cards alone.
        state.cancel_local_turn_asks();
        return stop_local_gateway(state).await;
    };
    // A late hard stop for a turn that already finished is idempotent: nothing to cancel and
    // no reason to touch a gateway another window may now own.
    if !state.is_local_turn_registered(turn) {
        return Ok(());
    }
    state.cancel_turn_asks(Some(turn), None, true);
    // Re-check under the gateway slot: a turn can finish or another local turn can start
    // while this waited for the mutex. Only then is it safe to stop the local gateway.
    let mut guard = state.gateway.lock().await;
    if !state.is_local_turn_registered(turn) || state.has_other_local_turns(Some(turn)) {
        return Ok(());
    }
    let pid = state.pid.lock().ok().and_then(|current| *current);
    if let Some(pid) = pid {
        kill_pid(pid);
    }
    // Take the slot as the old stop path did: a server that received SIGTERM is still
    // `process_alive` for a short window and must not be reused by the next turn.
    if let Some(server) = guard.take() {
        server.stop();
    }
    Ok(())
}

async fn stop_local_gateway(state: &HermesRuntimeState) -> Result<(), AppError> {
    let pid = state.pid.lock().ok().and_then(|current| *current);
    if let Some(pid) = pid {
        kill_pid(pid);
    }
    if let Some(server) = state.gateway.lock().await.take() {
        server.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_info_uses_the_gateway_image_allowlist() {
        let info = attachment_info(vec![
            "/tmp/shot.tif".into(),
            "/tmp/shot.heic".into(),
            "/tmp/shot.ico".into(),
            "/tmp/shot.avif".into(),
        ]);
        assert!(info[0].is_image);
        assert!(!info[1].is_image);
        assert!(info[2].is_image);
        assert!(!info[3].is_image);
    }

    #[test]
    fn diagnostics_detail_keeps_the_tail_of_a_traceback() {
        let stderr = format!("{}\nUnicodeDecodeError: boom", "x".repeat(5000));
        let detail = diagnostics_failure_detail(stderr.as_bytes());
        assert!(detail.starts_with('…'));
        assert!(detail.ends_with("UnicodeDecodeError: boom"));
        assert_eq!(detail.chars().count(), 4001);
    }

    #[test]
    fn diagnostics_detail_keeps_short_stderr_verbatim() {
        assert_eq!(diagnostics_failure_detail(b"  boom \n"), "boom");
    }

    #[test]
    fn saves_pasted_text_as_an_attachable_txt() {
        let dir = tempfile::tempdir().unwrap();
        let text = "line one\nline two";
        let info = save_pasted_text_in(dir.path(), text).unwrap();

        assert!(info.name.starts_with("pasted_content_"));
        assert!(info.name.ends_with(".txt"));
        assert_eq!(info.size, text.len() as u64);
        assert!(!info.is_image);
        assert_eq!(std::fs::read_to_string(&info.path).unwrap(), text);
        assert!(std::path::Path::new(&info.path).is_file());
    }

    #[test]
    fn rejects_an_empty_paste() {
        let dir = tempfile::tempdir().unwrap();
        let error = save_pasted_text_in(dir.path(), "").unwrap_err();
        assert_eq!(error.code, "E_HERMES_PASTE");
    }

    #[test]
    fn rejects_pasted_text_over_the_limit_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let text = "a".repeat(MAX_PASTED_TEXT_BYTES + 1);
        let error = save_pasted_text_in(dir.path(), &text).unwrap_err();
        assert_eq!(error.code, "E_HERMES_PASTE");
        // A refused paste must not leave a file nothing can attach.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn rejects_oversized_image_payloads_before_decoding() {
        let dir = tempfile::tempdir().unwrap();
        // Invalid base64 on purpose: the payload must be refused for its size before decoding,
        // not after the decoder has walked it.
        let payload = "*".repeat(MAX_PASTED_IMAGE_BYTES / 3 * 4 + 8);
        let data_url = format!("data:image/png;base64,{payload}");
        let error = save_pasted_image_in(dir.path(), &data_url, None).unwrap_err();
        assert_eq!(error.code, "E_HERMES_PASTE");
        assert!(error.message.contains("25 MB"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn only_composer_owned_files_are_discarded() {
        let root = tempfile::tempdir().unwrap();
        let pastes = root.path().join(COMPOSER_PASTES_DIR);
        let images = root.path().join(COMPOSER_IMAGES_DIR);
        std::fs::create_dir_all(&pastes).unwrap();
        std::fs::create_dir_all(&images).unwrap();
        let paste = pastes.join("pasted_content_1.txt");
        std::fs::write(&paste, "x").unwrap();
        let image = images.join("shot.png");
        std::fs::write(&image, "x").unwrap();
        let picked = root.path().join("picked.txt");
        std::fs::write(&picked, "x").unwrap();

        assert!(is_managed_composer_path(&paste, &pastes, &images));
        assert!(is_managed_composer_path(&image, &pastes, &images));
        assert!(!is_managed_composer_path(&picked, &pastes, &images));

        discard_managed_file(&paste, &pastes, &images).unwrap();
        assert!(!paste.exists());

        // A picker/drag attachment is never deleted, even when the chip is removed.
        let refused = discard_managed_file(&picked, &pastes, &images).unwrap_err();
        assert_eq!(refused.code, "E_HERMES_PASTE");
        assert!(picked.exists());

        // Removing an already-gone paste is harmless.
        discard_managed_file(&picked.with_extension("missing"), &pastes, &images).unwrap();
    }

    #[test]
    fn saves_a_png_data_url_with_its_mime_extension() {
        let dir = tempfile::tempdir().unwrap();
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC5sAAAAASUVORK5CYII=";
        let info =
            save_pasted_image_in(dir.path(), data_url, Some("Screenshot 2026-11-24.png")).unwrap();

        assert!(info.name.starts_with("Screenshot_2026-11-24_"));
        assert!(info.name.ends_with(".png"));
        assert!(info.is_image);
        assert!(info.size > 0);
        assert!(std::path::Path::new(&info.path).is_file());
    }

    #[test]
    fn pasted_image_payloads_must_be_a_supported_data_url() {
        let dir = tempfile::tempdir().unwrap();
        let not_an_image =
            save_pasted_image_in(dir.path(), "data:text/plain;base64,AAAA", None).unwrap_err();
        assert_eq!(not_an_image.code, "E_HERMES_PASTE");

        let not_data_url = save_pasted_image_in(dir.path(), "iVBORw0KGgo=", None).unwrap_err();
        assert_eq!(not_data_url.code, "E_HERMES_PASTE");

        let bad_base64 =
            save_pasted_image_in(dir.path(), "data:image/png;base64,***", None).unwrap_err();
        assert_eq!(bad_base64.code, "E_HERMES_PASTE");
    }

    #[test]
    fn maps_ui_providers_to_hermes_provider_ids() {
        assert_eq!(provider_id("openai"), "openai-api");
        assert_eq!(provider_id("google"), "gemini");
        assert_eq!(provider_id("local"), "openavoo-custom");
        assert_eq!(provider_id("custom"), "openavoo-custom");
        assert_eq!(provider_id("anthropic"), "anthropic");
    }

    #[test]
    fn writes_auxiliary_task_assignments() {
        let dir = tempfile::tempdir().unwrap();
        let input = HermesChatInput {
            prompt: "hello".into(),
            request_id: "aux-test".into(),
            session_id: None,
            provider: "openai".into(),
            model: "gpt-5.4".into(),
            effort: "medium".into(),
            fast: false,
            api_key: Some("test-key".into()),
            endpoint: None,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: vec![
                HermesAuxAssignment {
                    task: "title_generation".into(),
                    provider: "openai-api".into(),
                    model: "gpt-5.4-mini".into(),
                },
                HermesAuxAssignment {
                    task: "vision".into(),
                    provider: "auto".into(),
                    model: String::new(),
                },
            ],
            force_aux_vision: true,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        write_config(dir.path(), &input).unwrap();
        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        assert!(config.contains("provider: openai-api"));
        assert!(config.contains("default: gpt-5.4"));
        assert!(config.contains("auxiliary:"));
        assert!(config.contains("title_generation:"));
        assert!(config.contains("gpt-5.4-mini"));
        assert!(config.contains("image_input_mode: text"));
        assert!(!config.contains("vision:"));
    }

    #[test]
    fn maps_providers_to_their_dot_env_variables() {
        assert_eq!(provider_key_env("openai"), "OPENAI_API_KEY");
        assert_eq!(provider_key_env("codex"), "OPENAI_API_KEY");
        assert_eq!(provider_key_env("anthropic"), "ANTHROPIC_API_KEY");
        assert_eq!(provider_key_env("claude-code"), "ANTHROPIC_API_KEY");
        assert_eq!(provider_key_env("google"), "GOOGLE_API_KEY");
        assert_eq!(provider_key_env("openrouter"), "OPENROUTER_API_KEY");
        assert_eq!(provider_key_env("nous"), "NOUS_API_KEY");
        assert_eq!(provider_key_env("copilot"), "GITHUB_TOKEN");
        assert_eq!(provider_key_env("custom"), "OPENNAVO_CUSTOM_API_KEY");
        assert_eq!(provider_key_env("local"), "OPENNAVO_CUSTOM_API_KEY");
    }

    #[tokio::test]
    async fn runtime_commands_drop_the_inherited_environment() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_runtime(dir.path(), "#!/bin/sh\nenv\n");
        let inherited = ["CARGO_MANIFEST_DIR", "PWD", "OLDPWD"]
            .into_iter()
            .find(|name| std::env::var_os(name).is_some())
            .expect("the test process should expose at least one non-allowlisted variable");
        let output = runtime_command(&bin).unwrap().output().await.unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            !stdout
                .lines()
                .any(|line| line.starts_with(&format!("{inherited}="))),
            "{inherited} must not reach the Hermes runtime"
        );
        if std::env::var_os("PATH").is_some() {
            assert!(stdout.lines().any(|line| line.starts_with("PATH=")));
        }
        assert!(stdout.lines().any(|line| line.starts_with("PYTHONPATH=")));
    }

    #[test]
    fn writes_a_supplied_key_to_dot_env_and_never_to_config() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = test_input();
        input.api_key = Some("sk-in-dot-env".into());
        let key = write_config(dir.path(), &input).unwrap();
        assert_eq!(key.as_deref(), Some("sk-in-dot-env"));

        let env = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert_eq!(env, "OPENAI_API_KEY=sk-in-dot-env\n");
        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        assert!(!config.contains("sk-in-dot-env"));
        // The key lives in `.env`; the app no longer maintains an auth store of its own.
        assert!(!dir.path().join("auth.json").exists());
    }

    #[test]
    fn reads_the_key_back_from_dot_env_when_the_request_has_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "OPENAI_API_KEY=sk-stored\n").unwrap();
        let mut input = test_input();
        input.api_key = None;
        let key = write_config(dir.path(), &input).unwrap();
        assert_eq!(key.as_deref(), Some("sk-stored"));
        let env = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert_eq!(env, "OPENAI_API_KEY=sk-stored\n");
    }

    #[test]
    fn keeps_the_users_own_dot_env_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "# added by hand\nMY_SETTING=keep\nOPENAI_API_KEY=sk-old\n",
        )
        .unwrap();
        let mut input = test_input();
        input.api_key = Some("sk-new".into());
        write_config(dir.path(), &input).unwrap();
        let env = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert!(env.contains("# added by hand"));
        assert!(env.contains("MY_SETTING=keep"));
        assert!(env.contains("OPENAI_API_KEY=sk-new"));
        assert!(!env.contains("sk-old"));
        assert_eq!(env.matches("OPENAI_API_KEY").count(), 1);
    }

    #[test]
    fn leaves_upstream_oauth_state_untouched() {
        let dir = tempfile::tempdir().unwrap();
        // Hermes owns `auth.json`; the app must not read, rewrite or scrub it.
        let original = serde_json::json!({
            "version": 1,
            "active_provider": "nous",
            "providers": {"nous": {"access_token": "oauth-token"}},
            "credential_pool": {
                "nous": [{"id": "nous1", "source": "device_code", "access_token": "oauth-token"}],
                "openai-api": [{"id": "env1", "source": "env:OPENAI_API_KEY", "access_token": "sk-old"}]
            }
        });
        let path = dir.path().join("auth.json");
        let bytes = serde_json::to_vec_pretty(&original).unwrap();
        std::fs::write(&path, &bytes).unwrap();

        let mut input = test_input();
        input.api_key = Some("sk-new".into());
        write_config(dir.path(), &input).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn custom_endpoints_name_the_dot_env_variable_instead_of_inlining_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = test_input();
        input.provider = "custom".into();
        input.model = "my-model".into();
        input.endpoint = Some("https://example.test/v1".into());
        input.api_key = Some("sk-custom".into());
        let key = write_config(dir.path(), &input).unwrap();
        assert_eq!(key.as_deref(), Some("sk-custom"));

        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        assert!(config.contains("key_env: OPENNAVO_CUSTOM_API_KEY"));
        assert!(!config.contains("sk-custom"));
        let env = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert_eq!(env, "OPENNAVO_CUSTOM_API_KEY=sk-custom\n");
    }

    #[test]
    fn custom_provider_without_a_url_writes_no_provider_block() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = test_input();
        input.provider = "custom".into();
        input.model = "grok-4.7".into();
        input.endpoint = None;
        input.api_key = None;
        write_config(dir.path(), &input).unwrap();
        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        // Defaulting a custom endpoint to the Ollama URL would silently probe a local
        // server the user never asked for.
        assert!(!config.contains("providers:"));
        assert!(!config.contains("11434"));
    }

    #[test]
    fn local_provider_still_defaults_to_the_ollama_url() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = test_input();
        input.provider = "local".into();
        input.model = "llama".into();
        input.endpoint = None;
        input.api_key = None;
        write_config(dir.path(), &input).unwrap();
        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        assert!(config.contains("http://127.0.0.1:11434/v1"));
    }

    #[test]
    fn omits_key_env_when_a_custom_endpoint_has_no_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = test_input();
        input.provider = "local".into();
        input.model = "llama".into();
        input.endpoint = Some("http://127.0.0.1:11434/v1".into());
        input.api_key = None;
        write_config(dir.path(), &input).unwrap();
        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        assert!(!config.contains("key_env"));
    }

    /// A profile's `config.yaml` holds settings the desktop never shows (tools, skills, browser,
    /// cron, other providers). A write must merge onto it instead of replacing the file.
    #[test]
    fn keeps_settings_the_desktop_does_not_own() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.yaml"),
            "_config_version: 7\ntools:\n  browser:\n    enabled: true\nagent:\n  max_turns: 12\n  reasoning_effort: high\nproviders:\n  mine:\n    api: http://127.0.0.1:8000/v1\nmodel:\n  provider: nous\n  default: hermes-4\n",
        )
        .unwrap();
        let mut input = test_input();
        input.model = "gpt-test".into();
        write_config(dir.path(), &input).unwrap();

        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        assert!(config.contains("_config_version: 7"), "{config}");
        assert!(config.contains("browser:"), "{config}");
        assert!(config.contains("max_turns: 12"), "{config}");
        assert!(config.contains("mine:"), "{config}");
        // The keys the desktop owns are still rewritten.
        assert!(config.contains("reasoning_effort: medium"), "{config}");
        assert!(config.contains("provider: openai-api"), "{config}");
        assert!(config.contains("default: gpt-test"), "{config}");
        assert!(!config.contains("hermes-4"), "{config}");
    }

    /// Putting an auxiliary slot back on `auto` has to remove its override, or the runtime keeps
    /// using the model the user just cleared.
    #[test]
    fn a_slot_back_on_auto_drops_its_override() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.yaml"),
            "auxiliary:\n  vision:\n    provider: openai-api\n    model: gpt-4o\n  curator:\n    provider: openai-api\n    model: keep-me\n",
        )
        .unwrap();
        let mut input = test_input();
        input.auxiliary = vec![HermesAuxAssignment {
            task: "vision".into(),
            provider: "auto".into(),
            model: String::new(),
        }];
        write_config(dir.path(), &input).unwrap();

        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        assert!(!config.contains("gpt-4o"), "{config}");
        // A slot this build does not send is left alone.
        assert!(config.contains("keep-me"), "{config}");
    }

    #[test]
    fn a_missing_auxiliary_section_does_not_leave_an_empty_shell() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = test_input();
        input.auxiliary = vec![HermesAuxAssignment {
            task: "vision".into(),
            provider: "auto".into(),
            model: String::new(),
        }];
        write_config(dir.path(), &input).unwrap();
        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        assert!(!config.contains("auxiliary"), "{config}");
    }

    /// `YamlEmitter` leaves `4` and `~` bare, which would read back as an integer and a null.
    /// That document takes the fully quoted fallback, so this also covers its nesting.
    #[test]
    fn keeps_scalars_that_would_change_type() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.yaml"),
            "tools:\n  browser:\n    enabled: true\n",
        )
        .unwrap();
        let mut input = test_input();
        input.provider = "local".into();
        input.model = "4".into();
        write_config(dir.path(), &input).unwrap();
        let config = std::fs::read_to_string(dir.path().join("config.yaml")).unwrap();
        let docs = YamlLoader::load_from_str(&config).unwrap();
        assert_eq!(docs[0]["model"]["default"].as_str(), Some("4"), "{config}");
        assert_eq!(
            docs[0]["providers"]["openavoo-custom"]["models"]
                .as_vec()
                .map(Vec::len),
            Some(1),
            "{config}"
        );
        assert_eq!(
            docs[0]["tools"]["browser"]["enabled"].as_bool(),
            Some(true),
            "{config}"
        );
    }

    /// A config this crate cannot parse must fail the turn, not be replaced by a document
    /// built from an empty base that drops everything the user wrote.
    #[test]
    fn refuses_to_overwrite_a_config_it_cannot_parse() {
        let dir = tempfile::tempdir().unwrap();
        let original = b"model: [unclosed\n";
        std::fs::write(dir.path().join("config.yaml"), original).unwrap();
        let input = test_input();
        let error = write_config(dir.path(), &input).unwrap_err();
        assert_eq!(error.code, "E_HERMES_CONFIG");
        assert_eq!(
            std::fs::read(dir.path().join("config.yaml")).unwrap(),
            original
        );
        assert!(!dir.path().join(".env").exists());
    }

    /// A file that is not a mapping has no keys to merge onto. Rewriting it from scratch is
    /// the same data loss as an unparseable one.
    #[test]
    fn refuses_to_merge_onto_a_non_mapping_config() {
        let dir = tempfile::tempdir().unwrap();
        let original = b"- just\n- a\n- list\n";
        std::fs::write(dir.path().join("config.yaml"), original).unwrap();
        let error = write_config(dir.path(), &test_input()).unwrap_err();
        assert_eq!(error.code, "E_HERMES_CONFIG");
        assert_eq!(
            std::fs::read(dir.path().join("config.yaml")).unwrap(),
            original
        );
    }

    /// A genuine read error is not "no file": overwriting here could destroy a config that is
    /// temporarily unreadable (permissions, a mounted volume).
    #[test]
    fn a_config_read_error_does_not_become_an_empty_document() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("config.yaml")).unwrap();
        let error = write_config(dir.path(), &test_input()).unwrap_err();
        assert_eq!(error.code, "E_HERMES_CONFIG");
        assert!(dir.path().join("config.yaml").is_dir());
    }

    #[test]
    fn removing_a_provider_key_leaves_other_variables() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "OPENAI_API_KEY=sk-x\nANTHROPIC_API_KEY=sk-y\n",
        )
        .unwrap();
        assert!(env_store::remove_env_value(dir.path(), "OPENAI_API_KEY").unwrap());
        let env = std::fs::read_to_string(dir.path().join(".env")).unwrap();
        assert_eq!(env, "ANTHROPIC_API_KEY=sk-y\n");
    }

    /// A refresh or logout that started before a re-login must not overwrite or delete the
    /// newer session that now owns the same profile id.
    #[test]
    fn a_stale_panel_rotation_or_logout_leaves_the_newer_session_alone() {
        use_panel_session_root();
        let profile = format!("cas-{}", uuid::Uuid::new_v4());
        let old = panel::PanelSession {
            base_url: "https://panel.example.test".into(),
            provider: "basic".into(),
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            login_id: "login-old".into(),
        };
        let newer = panel::PanelSession {
            access_token: "new-access".into(),
            refresh_token: "new-refresh".into(),
            login_id: "login-new".into(),
            ..old.clone()
        };
        let rotated_old = panel::PanelSession {
            access_token: "rotated-old-access".into(),
            refresh_token: "rotated-old-refresh".into(),
            ..old.clone()
        };
        // Cookie rotation keeps the login identity: a logout from the pre-rotation snapshot
        // must still delete it, or a successful logout would leave the local login behind.
        let rotated_newer = panel::PanelSession {
            access_token: "rotated-new-access".into(),
            refresh_token: "rotated-new-refresh".into(),
            ..newer.clone()
        };

        panel_session_set(&profile, &old).unwrap();
        // A fresh login lands while the old request is still in flight.
        panel_session_set(&profile, &newer).unwrap();

        assert!(
            !panel_session_update_if(&profile, &old, &rotated_old).unwrap(),
            "a stale rotation must not replace the newer login"
        );
        assert_eq!(panel_session(&profile).unwrap(), newer);

        assert!(
            !panel_session_delete_if(&profile, &old).unwrap(),
            "a stale logout must not delete the newer login"
        );
        assert_eq!(panel_session(&profile).unwrap(), newer);

        // A newer login rotates its cookies: the old login's logout/rotation still loses.
        assert!(panel_session_update_if(&profile, &newer, &rotated_newer).unwrap());
        assert_eq!(panel_session(&profile).unwrap(), rotated_newer);
        assert!(!panel_session_delete_if(&profile, &old).unwrap());
        assert_eq!(panel_session(&profile).unwrap(), rotated_newer);

        // The same login's logout works even from its pre-rotation snapshot.
        assert!(panel_session_delete_if(&profile, &newer).unwrap());
        assert!(panel_session(&profile).is_err());
    }

    /// Rename moves the desktop history with the profile; delete removes it; an existing
    /// target is never overwritten.
    #[test]
    fn profile_history_follows_rename_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("history-old.json");
        let to = dir.path().join("history-new.json");
        std::fs::write(&from, r#"{"conversations":[]}"#).unwrap();
        assert!(move_profile_history(&from, &to).unwrap());
        assert!(!from.exists());
        assert_eq!(
            std::fs::read_to_string(&to).unwrap(),
            r#"{"conversations":[]}"#
        );

        // A target that already has history keeps it; the source is not silently lost.
        std::fs::write(&from, "old").unwrap();
        std::fs::write(&to, "new").unwrap();
        assert!(!move_profile_history(&from, &to).unwrap());
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&from).unwrap(), "old");

        remove_profile_history(&to);
        assert!(!to.exists());
    }

    /// A rotation response is applied only from the exact cookie snapshot it was produced
    /// from; a newer rotation that landed first wins.
    #[test]
    fn a_stale_rotation_does_not_overwrite_a_newer_one() {
        use_panel_session_root();
        let profile = format!("rotate-{}", uuid::Uuid::new_v4());
        let base = panel::PanelSession {
            base_url: "https://panel.example.test".into(),
            provider: "basic".into(),
            access_token: "a0".into(),
            refresh_token: "r0".into(),
            login_id: "login-rotate".into(),
        };
        let first = panel::PanelSession {
            access_token: "a1".into(),
            refresh_token: "r1".into(),
            ..base.clone()
        };
        let second = panel::PanelSession {
            access_token: "a2".into(),
            refresh_token: "r2".into(),
            ..base.clone()
        };
        panel_session_set(&profile, &base).unwrap();
        assert!(panel_session_update_if(&profile, &base, &first).unwrap());
        assert!(
            !panel_session_update_if(&profile, &base, &second).unwrap(),
            "a response built from the replaced cookies must fail CAS"
        );
        assert_eq!(panel_session(&profile).unwrap(), first);
    }

    async fn ticket_fixture() -> (
        String,
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let Ok(Ok((mut socket, _))) =
                tokio::time::timeout(std::time::Duration::from_secs(2), listener.accept()).await
            else {
                return;
            };
            let mut buffer = [0_u8; 2048];
            let _ = socket.read(&mut buffer).await;
            // The request headers are in; only now let the test mutate the login state.
            let _ = seen_tx.send(());
            if tokio::time::timeout(std::time::Duration::from_secs(5), release_rx)
                .await
                .is_err()
            {
                return;
            }
            let body = b"{\"ticket\":\"ticket-1\"}";
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = socket.write_all(body).await;
            let _ = socket.shutdown().await;
        });
        (format!("http://{addr}"), seen_rx, release_tx, task)
    }

    #[tokio::test]
    async fn a_normal_ticket_response_does_not_keep_a_replaced_login() {
        use_panel_session_root();
        let profile = format!("ticket-live-{}", uuid::Uuid::new_v4());
        let (base, seen, release, server) = ticket_fixture().await;
        let old = panel::PanelSession {
            base_url: base.clone(),
            provider: "basic".into(),
            access_token: "old-a".into(),
            refresh_token: "old-r".into(),
            login_id: "login-old".into(),
        };
        panel_session_set(&profile, &old).unwrap();
        let task = tokio::spawn({
            let profile = profile.clone();
            async move { panel::ticket_for_login(&profile, "login-old").await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), seen)
            .await
            .expect("ticket request never reached the server")
            .expect("ticket fixture dropped");
        let new_login = panel::PanelSession {
            base_url: base,
            provider: "basic".into(),
            access_token: "new-a".into(),
            refresh_token: "new-r".into(),
            login_id: "login-new".into(),
        };
        panel_session_set(&profile, &new_login).unwrap();
        release.send(()).unwrap();
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.code, "E_HERMES_PANEL");
        let _ = server.await;
    }

    #[tokio::test]
    async fn a_same_login_rotation_keeps_the_ticket_valid() {
        use_panel_session_root();
        let profile = format!("ticket-rotate-{}", uuid::Uuid::new_v4());
        let (base, seen, release, server) = ticket_fixture().await;
        let base_session = panel::PanelSession {
            base_url: base,
            provider: "basic".into(),
            access_token: "a".into(),
            refresh_token: "r".into(),
            login_id: "login-same".into(),
        };
        panel_session_set(&profile, &base_session).unwrap();
        let task = tokio::spawn({
            let profile = profile.clone();
            async move { panel::ticket_for_login(&profile, "login-same").await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), seen)
            .await
            .expect("ticket request never reached the server")
            .expect("ticket fixture dropped");
        let rotated = panel::PanelSession {
            access_token: "a2".into(),
            refresh_token: "r2".into(),
            ..base_session.clone()
        };
        panel_session_set(&profile, &rotated).unwrap();
        release.send(()).unwrap();
        let request = task.await.unwrap().unwrap();
        assert_eq!(request.ticket, "ticket-1");
        let _ = server.await;
    }

    /// A ticket request bound to the old login is rejected before any network call once the
    /// profile belongs to a different sign-in (including a response with no Set-Cookie).
    #[tokio::test]
    async fn a_ticket_for_replaced_login_is_rejected() {
        use_panel_session_root();
        let profile = format!("ticket-{}", uuid::Uuid::new_v4());
        let session = panel::PanelSession {
            base_url: "http://127.0.0.1:9".into(),
            provider: "basic".into(),
            access_token: "a".into(),
            refresh_token: "r".into(),
            login_id: "login-new".into(),
        };
        panel_session_set(&profile, &session).unwrap();
        let error = panel::ticket_for_login(&profile, "login-old")
            .await
            .unwrap_err();
        assert_eq!(error.code, "E_HERMES_PANEL");
    }

    /// A hard stop that names an unregistered turn is a no-op; it must not touch a gateway
    /// another window may have started.
    #[tokio::test]
    async fn a_late_hard_stop_for_an_unknown_turn_is_a_noop() {
        let state = HermesRuntimeState::default();
        stop_local(&state, Some("req-already-finished"))
            .await
            .unwrap();
    }

    /// Old session.json files have no loginId; they keep working with full-snapshot CAS.
    #[test]
    fn a_legacy_panel_session_without_login_id_still_parses() {
        let value = serde_json::json!({
            "baseUrl": "https://panel.example.test",
            "provider": "basic",
            "accessToken": "a",
            "refreshToken": "r"
        });
        let session: panel::PanelSession = serde_json::from_value(value).unwrap();
        assert!(session.login_id.is_empty());
        assert!(same_panel_login(&session, &session));
    }

    /// Rotation and logout from the same login share one disk/cache boundary: a delete
    /// cannot be undone by a slower rotation, and no stale cache entry survives.
    #[test]
    fn concurrent_rotation_and_logout_do_not_resurrect_a_session() {
        use_panel_session_root();
        let old = panel::PanelSession {
            base_url: "https://panel.example.test".into(),
            provider: "basic".into(),
            access_token: "old-a".into(),
            refresh_token: "old-r".into(),
            login_id: "login-race".into(),
        };
        let rotated = panel::PanelSession {
            access_token: "new-a".into(),
            refresh_token: "new-r".into(),
            ..old.clone()
        };
        for sequence in 0..20 {
            let profile = format!("race-{sequence}");
            panel_session_set(&profile, &old).unwrap();
            std::thread::scope(|scope| {
                let profile_update = profile.clone();
                let profile_delete = profile.clone();
                let old_update = old.clone();
                let old_delete = old.clone();
                let rotated = rotated.clone();
                let update = scope.spawn(move || {
                    let _ = panel_session_update_if(&profile_update, &old_update, &rotated);
                });
                let delete = scope.spawn(move || {
                    let _ = panel_session_delete_if(&profile_delete, &old_delete);
                });
                update.join().unwrap();
                delete.join().unwrap();
            });
            assert!(
                panel_session(&profile).is_err(),
                "a logout or the rotation after it must leave no session"
            );
        }
    }

    /// Upstream error bodies must not enter the durable audit file; only local codes do.
    #[test]
    fn audit_records_a_local_classification_not_upstream_text() {
        let dir = tempfile::tempdir().unwrap();
        let input = test_input();
        let secret = "Authorization: Bearer sk-audit-SECRET prompt text";
        append_audit(
            dir.path(),
            &input,
            "failed",
            Some("session-1"),
            Some(secret),
        );
        append_audit(
            dir.path(),
            &input,
            "failed",
            Some("session-2"),
            Some("gateway_error"),
        );
        let raw = std::fs::read_to_string(dir.path().join(AUDIT_FILE)).unwrap();
        assert!(!raw.contains("sk-audit-SECRET"), "{raw}");
        assert!(!raw.contains("prompt text"), "{raw}");
        let lines: Vec<serde_json::Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(lines[0]["detail"].is_null());
        assert_eq!(lines[1]["detail"], "gateway_error");
        assert_eq!(lines[0]["provider"], input.provider);
        assert_eq!(lines[0]["promptChars"], input.prompt.chars().count() as u64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(AUDIT_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    /// Two windows' explicit upserts/deletes merge under the file lock; a stale window's
    /// write cannot resurrect a row the other deleted.
    #[test]
    fn history_ops_merge_independent_windows_without_resurrection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "version": 3,
                "conversations": [
                    {"id": "shared", "messages": [], "updatedAt": 1},
                    {"id": "deleted", "messages": [], "updatedAt": 2}
                ],
                "activeId": "shared"
            })
            .to_string(),
        )
        .unwrap();

        // Window A deletes one row and adds its own.
        merge_history_ops(
            &path,
            &serde_json::json!({
                "upserts": [{"id": "a", "messages": [], "updatedAt": 3}],
                "deletes": ["deleted"],
                "activeId": "a"
            }),
        )
        .unwrap();
        // Window B, still holding the old baseline, only writes its own new row.
        merge_history_ops(
            &path,
            &serde_json::json!({
                "upserts": [{"id": "b", "messages": [], "updatedAt": 4}],
                "deletes": [],
                "activeId": "b"
            }),
        )
        .unwrap();

        let merged: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let ids: Vec<&str> = merged["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["id"].as_str())
            .collect();
        assert!(ids.contains(&"shared"), "{ids:?}");
        assert!(ids.contains(&"a"), "{ids:?}");
        assert!(ids.contains(&"b"), "{ids:?}");
        assert!(
            !ids.contains(&"deleted"),
            "a stale window resurrected it: {ids:?}"
        );
        assert_eq!(merged["activeId"], "b");
    }

    #[test]
    fn history_merge_refuses_to_overwrite_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        let original = b"not json";
        std::fs::write(&path, original).unwrap();
        let error = merge_history_ops(&path, &serde_json::json!({"upserts": [], "deletes": []}))
            .unwrap_err();
        assert_eq!(error.code, "E_HERMES_HISTORY");
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn maps_reasoning_effort() {
        assert_eq!(reasoning_effort("auto"), None);
        assert_eq!(reasoning_effort("medium"), Some("medium"));
        assert_eq!(reasoning_effort("high"), Some("high"));
    }

    #[test]
    fn runtime_manifest_pins_the_expected_version() {
        let manifest = runtime_manifest().unwrap();
        assert_eq!(manifest.hermes.version, "0.23.3");
        assert_eq!(manifest.plugins.len(), 1);
        assert_eq!(manifest.plugins[0].name, "github-copilot");
        assert_eq!(
            manifest.plugins[0].repository,
            "https://github.com/NousResearch/hermes-labs-plugins"
        );
        assert_eq!(
            manifest.plugins[0].sha,
            "df8f1321941125d45dde71ab20196fbeea093191"
        );
    }

    #[test]
    fn runtime_version_ignores_dates_and_other_numbers() {
        assert_eq!(
            runtime_version_from_output("Hermes Agent v0.23.1 · stable").as_deref(),
            Some("0.23.1")
        );
        assert_eq!(
            runtime_version_from_output("Hermes Agent vunknown (2026.9.24)"),
            None
        );
        assert!(runtime_version_matches(
            "Hermes Agent v0.23.1 · stable",
            "0.23.1"
        ));
        assert!(!runtime_version_matches(
            "Hermes Agent v0.23.0 · stable",
            "0.23.1"
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_probe_sets_an_isolated_hermes_home() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let wrapper = dir.path().join("hermes");
        std::fs::write(
            &wrapper,
            "#!/bin/sh\nif [ -n \"${HERMES_HOME:-}\" ]; then printf 'Hermes Agent v0.23.1 · stable\\n'; else printf 'Hermes Agent vunknown (2026.9.24)\\n'; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();

        let probe = probe_runtime_version(&wrapper).await.unwrap();
        assert!(probe.success);
        assert_eq!(probe.version.as_deref(), Some("0.23.1"));
    }

    fn test_input() -> HermesChatInput {
        HermesChatInput {
            prompt: "hello".into(),
            request_id: "test-request".into(),
            session_id: None,
            provider: "openai".into(),
            model: "gpt-test".into(),
            effort: "medium".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            api_key: Some("test-key".into()),
            endpoint: None,
            mac_enabled: true,
            control_level: "full".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        }
    }

    #[tokio::test]
    async fn runs_a_sidecar_and_returns_stdout_and_session() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_runtime(
            dir.path(),
            "#!/bin/sh\nprintf 'HERMES_OK\\n'\nprintf 'session_id: test-session\\n' >&2\nexit 0\n",
        );
        let state = HermesRuntimeState::default();
        let reply = chat_with_bin(&bin, dir.path(), &state, test_input(), None, None)
            .await
            .unwrap();
        assert_eq!(reply.text, "HERMES_OK");
        assert_eq!(reply.session_id.as_deref(), Some("test-session"));
    }

    #[tokio::test]
    #[ignore = "requires HERMES_RUNTIME_BIN and a reachable OpenAI-compatible test endpoint"]
    async fn runs_a_real_terminal_tool_call_in_full_control() {
        let bin = std::env::var("HERMES_RUNTIME_BIN").expect("HERMES_RUNTIME_BIN");
        let endpoint = std::env::var("HERMES_TEST_ENDPOINT").expect("HERMES_TEST_ENDPOINT");
        let dir = tempfile::tempdir().unwrap();
        let input = HermesChatInput {
            prompt: "Use the terminal to echo HERMES_TERMINAL_OK".into(),
            request_id: "test-request".into(),
            session_id: None,
            provider: "openai".into(),
            model: "gpt-4o-mini".into(),
            effort: "medium".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            api_key: Some("test".into()),
            endpoint: Some(endpoint),
            mac_enabled: true,
            control_level: "full".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        let state = HermesRuntimeState::default();
        let reply = chat_with_bin(Path::new(&bin), dir.path(), &state, input, None, None)
            .await
            .unwrap();
        assert_eq!(reply.text.trim(), "HERMES_TERMINAL_OK");
    }

    #[test]
    fn stream_filter_drops_the_scanner_warning_and_releases_tokens() {
        let mut filter = StreamFilter::default();
        assert_eq!(
            filter.push("  ⚠ tirith security scanner enabled but not available — command scanning will use pattern matching onlyHel"),
            "Hel"
        );
        assert_eq!(filter.push("lo"), "lo");
    }

    #[tokio::test]
    #[ignore = "requires HERMES_RUNTIME_BIN and a reachable OpenAI-compatible test endpoint"]
    async fn runs_the_real_hermes_runtime_against_a_test_endpoint() {
        let bin = std::env::var("HERMES_RUNTIME_BIN").expect("HERMES_RUNTIME_BIN");
        let endpoint = std::env::var("HERMES_TEST_ENDPOINT").expect("HERMES_TEST_ENDPOINT");
        let dir = tempfile::tempdir().unwrap();
        let input = HermesChatInput {
            prompt: "Reply with HERMES_OK".into(),
            request_id: "test-request".into(),
            session_id: None,
            provider: "openai".into(),
            model: "gpt-4o-mini".into(),
            effort: "medium".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            api_key: Some("test".into()),
            endpoint: Some(endpoint),
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        let state = HermesRuntimeState::default();
        let reply = chat_with_bin(Path::new(&bin), dir.path(), &state, input, None, None)
            .await
            .unwrap();
        assert!(!reply.text.trim().is_empty());
        assert!(reply.session_id.is_some());
    }

    #[tokio::test]
    async fn reports_sidecar_failure_with_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_runtime(
            dir.path(),
            "#!/bin/sh\necho 'provider is not configured' >&2\nexit 2\n",
        );
        let state = HermesRuntimeState::default();
        let error = chat_with_bin(&bin, dir.path(), &state, test_input(), None, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, "E_HERMES_CHAT");
        assert!(
            error
                .detail
                .unwrap_or_default()
                .contains("provider is not configured")
        );
    }

    /// A fake runtime with the layout `runtime_command` expects. The interpreter
    /// is a shell script that ignores the bootstrap and emits the test output.
    fn fake_runtime(dir: &Path, script: &str) -> PathBuf {
        let bin = dir.join("bin").join("hermes");
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("python").join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("site")).unwrap();
        std::fs::write(&bin, "#!/bin/sh\nexit 1\n").unwrap();
        let python = dir.join("python").join("bin").join("python3");
        std::fs::write(&python, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        bin
    }

    #[test]
    fn open_control_never_exposes_mac_tools() {
        let input = HermesChatInput {
            prompt: "hi".into(),
            request_id: "test-request".into(),
            session_id: None,
            provider: "openai".into(),
            model: "gpt".into(),
            effort: "medium".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            api_key: None,
            endpoint: None,
            mac_enabled: true,
            control_level: "open".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        assert_eq!(toolsets(&input), "safe");
        assert_eq!(
            toolsets(&HermesChatInput {
                control_level: "full".into(),
                ..input.clone()
            }),
            "terminal,file,computer_use,cronjob"
        );
        assert_eq!(
            toolsets(&HermesChatInput {
                control_level: "full".into(),
                mac_cron: false,
                ..input
            }),
            "terminal,file,computer_use"
        );
    }
}
