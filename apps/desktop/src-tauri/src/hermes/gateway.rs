//! Streaming Hermes gateway transport.
//!
//! `hermes chat -Q` only prints the final answer to a pipe, so the desktop uses
//! the local `hermes serve` JSON-RPC gateway (`/api/ws`) for token deltas. The
//! gateway also owns the same agent/tool/session implementation as the CLI.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::{Instant, sleep, timeout, timeout_at};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use yaml_rust2::Yaml;

use super::{
    AppError, AskAnswer, HermesAskReply, HermesChatInput, HermesChatReply, HermesChunk,
    HermesModelOptions, HermesRuntimeState, HermesSteerResult, HermesSteerStatus, HermesUsage,
    append_audit, clean_output, kill_pid, provider_id, reasoning_effort, toolsets,
    write_catalog_config, write_config,
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const START_TIMEOUT: Duration = Duration::from_secs(25);
const MESSAGE_TIMEOUT: Duration = Duration::from_secs(180);
/// Best-effort read of `display.busy_input_mode` before the first prompt. A slow or older
/// gateway must not hold the turn: the official default is `interrupt` anyway.
const BUSY_MODE_TIMEOUT: Duration = Duration::from_secs(2);
/// Pause before repeating a catalog read that died on a service-restart close.
///
/// Close code 1012 asks clients to wait 5–30s. The catalog read sits on a UI path that gives
/// up at 55s, so this is one short attempt rather than that backoff. It does not reconnect by
/// itself: a remote retry has to mint a new panel ticket first.
const MODEL_OPTIONS_RESTART_PAUSE: Duration = Duration::from_millis(400);

pub struct GatewayServer {
    pub port: u16,
    pub token: String,
    fingerprint: String,
    pid: u32,
    _child: Child,
}

impl Drop for GatewayServer {
    fn drop(&mut self) {
        kill_pid(self.pid);
    }
}

impl GatewayServer {
    fn matches(&self, fingerprint: &str) -> bool {
        self.fingerprint == fingerprint
    }

    pub fn stop(&self) {
        kill_pid(self.pid);
    }
}

fn server_fingerprint(input: &HermesChatInput, key: Option<&str>) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        input.profile.as_deref().unwrap_or("default"),
        provider_id(&input.provider),
        input.endpoint.as_deref().unwrap_or(""),
        key.map(key_digest).unwrap_or_default(),
        toolsets(input),
        input
            .auxiliary
            .iter()
            .filter(|entry| entry.provider != "auto" && !entry.model.is_empty())
            .map(|entry| format!("{}:{}:{}", entry.task, entry.provider, entry.model))
            .collect::<Vec<_>>()
            .join(","),
        input.force_aux_vision
    )
}

/// A running gateway keeps whatever key it loaded at startup, so a changed key has to
/// restart it. Digest the key rather than holding the secret in the fingerprint.
fn key_digest(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..16].to_owned()
}

fn apply_runtime_env(command: &mut Command, bin: &Path) {
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
}

fn free_port() -> Result<u16, AppError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        AppError::new("E_HERMES_GATEWAY", "Could not reserve a local port.")
            .with_detail(error.to_string())
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| {
            AppError::new("E_HERMES_GATEWAY", "Could not read the local port.")
                .with_detail(error.to_string())
        })?
        .port();
    Ok(port)
}

async fn port_open(port: u16) -> bool {
    timeout(
        Duration::from_millis(400),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map(|result| result.is_ok())
    .unwrap_or(false)
}

async fn ensure_server(
    bin: &Path,
    home: &Path,
    state: &HermesRuntimeState,
    input: &HermesChatInput,
    api_key: Option<&str>,
) -> Result<Arc<GatewayServer>, AppError> {
    let fingerprint = server_fingerprint(input, api_key);
    let mut guard = state.gateway.lock().await;
    if let Some(server) = guard.as_ref()
        && server.matches(&fingerprint)
        && port_open(server.port).await
    {
        return Ok(server.clone());
    }
    *guard = None;
    let port = free_port()?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut command = super::runtime_command(bin)?;
    // Always name the profile explicitly: without the flag the runtime follows the sticky
    // `active_profile` file, so a profile picked in the CLI could silently replace the
    // default profile whose config/.env we just wrote.
    let profile = input
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|profile| !profile.is_empty())
        .unwrap_or("default");
    if !super::profiles::name_ok(profile) {
        return Err(AppError::new(
            "E_HERMES_PROFILE_NAME",
            "Profile names must be lowercase letters, digits, dashes or underscores.",
        ));
    }
    command.arg("--profile").arg(profile);
    command.arg("serve");
    // `--isolated` marks this backend as app-owned. Without it the runtime's host singleton
    // treats a typed `--port` as a conflict whenever any other `hermes serve`/`dashboard` owns
    // the machine — including a gateway this app left behind in an earlier run — and exits 78
    // instead of starting. The desktop always runs its own backend on its own free port for
    // one home/profile, so opting out is both safe and required; otherwise every catalog and
    // chat read waits out the startup timeout and fails.
    command.arg("--isolated");
    command
        .arg("--skip-build")
        .arg("--port")
        .arg(port.to_string())
        .env("HERMES_HOME", home)
        .env("HERMES_DASHBOARD_SESSION_TOKEN", &token)
        .env("HERMES_TUI_TOOLSETS", toolsets(input))
        .env("PYTHONUNBUFFERED", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    apply_runtime_env(&mut command, bin);
    let child = command.spawn().map_err(|error| {
        AppError::new("E_HERMES_GATEWAY", "Hermes gateway could not start.")
            .with_detail(error.to_string())
    })?;
    let pid = child.id().unwrap_or(0);
    // Only the start future owns the child until the server below takes it. A dropped future
    // must not leave an isolated `hermes serve` behind, and SIGTERM alone does not guarantee
    // that: a child that refuses or ignores it survives. `StartingGateway` keeps the handle and
    // sends SIGKILL on drop; the normal handoff keeps `GatewayServer`'s SIGTERM lifecycle.
    let mut starting = StartingGateway { child: Some(child) };
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        // The child is checked before the port: an exited process has to be reported now, not
        // after a wait on a socket it will never open.
        match starting.child_mut().try_wait() {
            Ok(Some(status)) => {
                // Reaped already: release the guard without signaling a dead pid.
                starting.take();
                return Err(gateway_exit_error(status, home));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(AppError::new(
                    "E_HERMES_GATEWAY",
                    "Hermes gateway could not be monitored during startup.",
                )
                .with_detail(error.to_string()));
            }
        }
        if port_open(port).await {
            let child = starting
                .take()
                .expect("the starting gateway already handed off");
            let server = Arc::new(GatewayServer {
                port,
                token,
                fingerprint,
                pid,
                _child: child,
            });
            *guard = Some(server.clone());
            return Ok(server);
        }
        sleep(Duration::from_millis(150)).await;
    }
    // An exit during the last sleep is an exit, not a timeout.
    if let Ok(Some(status)) = starting.child_mut().try_wait() {
        starting.take();
        return Err(gateway_exit_error(status, home));
    }
    Err(AppError::new(
        "E_HERMES_GATEWAY",
        "Hermes gateway did not become ready. Restart Hermes and try again.",
    ))
}

/// Owns the spawned gateway until `GatewayServer` takes it.
///
/// `ensure_server` waits for the port before handing the child to the server. If that future
/// is dropped in the meantime (app quit, a superseded request), tokio leaves the child running,
/// so every cancelled start would leak another isolated `hermes serve`. Owning the handle lets
/// the guard call `start_kill` (SIGKILL) on drop, which also covers a child that refuses or
/// ignores SIGTERM. The handoff is explicit, so a running gateway keeps the server's existing
/// SIGTERM lifecycle.
struct StartingGateway {
    child: Option<Child>,
}

impl StartingGateway {
    fn child_mut(&mut self) -> &mut Child {
        self.child
            .as_mut()
            .expect("the starting gateway already handed off")
    }

    /// Take the child out: for handoff, or to drop an already-reaped process without signaling.
    fn take(&mut self) -> Option<Child> {
        self.child.take()
    }
}

impl Drop for StartingGateway {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
    }
}

/// User-facing reason for a gateway that exited before it served its port.
///
/// The exit status is the only reliable evidence here: `exit 78` is the runtime's permanent
/// configuration refusal for more than one situation, so no cause is invented. The settings
/// sheet renders `detail`, so it must say the exit happened during startup. The gateway's own
/// log is named only when that file exists, so the pointer is never dead. The child's stderr is
/// deliberately not captured: it can carry the dashboard session token or provider credentials
/// the gateway loads from the profile's `.env`, and the runtime logs are the place for detail.
fn gateway_exit_error(status: std::process::ExitStatus, home: &Path) -> AppError {
    let mut detail = format!("Hermes gateway exited during startup ({status}).");
    let log = home.join("logs").join("gui.log");
    if log.is_file() {
        detail.push_str(&format!(" See {}", log.display()));
    }
    AppError::new("E_HERMES_GATEWAY", "Hermes gateway exited during startup.").with_detail(detail)
}

fn rpc_error(value: &Value) -> Option<String> {
    value
        .get("error")
        .filter(|error| !error.is_null())
        .map(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Hermes gateway error")
                .to_owned()
        })
}

fn is_session_not_found_error(value: &Value) -> bool {
    let Some(error) = value.get("error").filter(|error| !error.is_null()) else {
        return false;
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let message = message.trim_end_matches('.');
    let canonical = message
        .strip_prefix("4001:")
        .map(str::trim)
        .unwrap_or(message)
        .eq_ignore_ascii_case("session not found");
    let code = error.get("code").and_then(|code| {
        code.as_i64()
            .or_else(|| code.as_str().and_then(|value| value.parse().ok()))
    });
    match code {
        // `session.resume` reports a missing stored session as 4007. Older gateways used 4001
        // for the same condition, but only when the message is the canonical one.
        Some(4007) => true,
        Some(4001) => canonical,
        // Never accept a 5000 (`resume failed: …`) payload that merely wraps the phrase.
        Some(_) => false,
        None => canonical,
    }
}

async fn send_json(socket: &mut Socket, value: Value) -> Result<(), AppError> {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_GATEWAY_STREAM", "Hermes gateway write failed.")
                .with_detail(error.to_string())
        })
}

/// Read the next JSON frame, skipping WebSocket control frames.
///
/// `hermes serve` runs uvicorn with its default `ws_ping_interval=20s`, so the runtime pings the
/// socket every 20 seconds. The official dashboard client is a browser: ping/pong happens inside
/// the browser's WebSocket stack and the page never sees those frames. tungstenite also answers
/// them for us (it queues the pong and flushes it on the next read), so a control frame only has to
/// be skipped. Treating it as a protocol error aborted the turn ~20s into a stream with
/// "Hermes gateway sent an unexpected frame."
///
/// `limit: None` keeps reading without a stall budget: while an approval card is open the user owns
/// the clock, and the loop still has to drain pings (a reader that stops reading drops the socket).
///
/// The budget is one absolute deadline for the whole read, not a timeout per frame: a control frame
/// restarts nothing, or a gateway that only pings would keep a turn alive forever.
async fn next_frame(socket: &mut Socket, limit: Option<Duration>) -> Result<Value, AppError> {
    let deadline = limit.map(|limit| Instant::now() + limit);
    loop {
        let pending = socket.next();
        let message = match deadline {
            Some(deadline) => timeout_at(deadline, pending).await.map_err(|_| {
                AppError::new("E_HERMES_GATEWAY_TIMEOUT", "Hermes gateway timed out.")
            })?,
            None => pending.await,
        };
        let message = message
            .ok_or_else(|| {
                AppError::new(
                    "E_HERMES_GATEWAY_STREAM",
                    "Hermes gateway closed the connection.",
                )
            })?
            .map_err(|error| {
                AppError::new("E_HERMES_GATEWAY_STREAM", "Hermes gateway read failed.")
                    .with_detail(error.to_string())
            })?;
        match message {
            Message::Text(text) => {
                return serde_json::from_str(text.as_str()).map_err(|error| {
                    AppError::new(
                        "E_HERMES_GATEWAY_STREAM",
                        "Hermes gateway sent invalid JSON.",
                    )
                    .with_detail(error.to_string())
                });
            }
            Message::Binary(bytes) => {
                return serde_json::from_slice(&bytes).map_err(|error| {
                    AppError::new(
                        "E_HERMES_GATEWAY_STREAM",
                        "Hermes gateway sent invalid JSON.",
                    )
                    .with_detail(error.to_string())
                });
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(frame) => return Err(gateway_close_error(frame)),
        }
    }
}

#[cfg(test)]
async fn recv_json(socket: &mut Socket) -> Result<Value, AppError> {
    next_frame(socket, Some(MESSAGE_TIMEOUT)).await
}

/// A WebSocket close while a request is in flight.
///
/// `hermes serve` runs under uvicorn, which closes live sockets with 1012 (service restart)
/// and an empty reason when the process reloads. Formatting that as `code 1012:` made the
/// profile rail show a raw status code. 1012 and 1013 are defined as "connect again", so they
/// get their own code and the catalog read retries once. The status number stays out of the
/// user-visible text; an empty reason must not become a detail string.
fn gateway_close_error(frame: Option<CloseFrame>) -> AppError {
    let Some(frame) = frame else {
        return AppError::new(
            "E_HERMES_GATEWAY_STREAM",
            "Hermes gateway closed the connection.",
        );
    };
    let reason = frame.reason.to_string();
    if matches!(frame.code, CloseCode::Restart | CloseCode::Again) {
        let error = AppError::new("E_HERMES_GATEWAY_RESTART", "Hermes gateway is restarting.");
        return if reason.trim().is_empty() {
            error
        } else {
            error.with_detail(reason)
        };
    }
    AppError::new(
        "E_HERMES_GATEWAY_STREAM",
        "Hermes gateway closed the connection.",
    )
    .with_detail(format!("code {}: {reason}", u16::from(frame.code)))
}

/// Repeat a catalog read once when the gateway closed the socket to restart.
///
/// `model.options` only reads. A chat turn must not use this: resubmitting it would run the
/// agent a second time. The future is polled only after a restart close, and only then, so a
/// caller can mint a fresh panel ticket inside it. Reusing the ticket from the attempt that
/// just closed is not possible: a panel WebSocket ticket is consumed on the handshake.
pub(crate) async fn model_options_once_more(
    error: AppError,
    retry: impl std::future::Future<Output = Result<HermesModelOptions, AppError>>,
) -> Result<HermesModelOptions, AppError> {
    if error.code != "E_HERMES_GATEWAY_RESTART" {
        return Err(error);
    }
    sleep(MODEL_OPTIONS_RESTART_PAUSE).await;
    retry.await
}

async fn rpc(socket: &mut Socket, id: u64, method: &str, params: Value) -> Result<Value, AppError> {
    rpc_within(socket, id, method, params, MESSAGE_TIMEOUT).await
}

async fn rpc_within(
    socket: &mut Socket,
    id: u64,
    method: &str,
    params: Value,
    limit: Duration,
) -> Result<Value, AppError> {
    send_json(
        socket,
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .await?;
    loop {
        let value = next_frame(socket, Some(limit)).await?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = rpc_error(&value) {
            return Err(AppError::new("E_HERMES_GATEWAY_STREAM", error));
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

/// Resume a stored session without treating every transport/RPC failure as "the session is gone".
/// Only an explicit `session not found` may fall through to `session.create`; timeouts, auth
/// failures and transient gateway errors must reach the caller with the original session intact.
async fn resume_session(socket: &mut Socket, stored: &str) -> Result<Option<Value>, AppError> {
    send_json(
        socket,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session.resume",
            "params": {"session_id": stored, "cols": 120, "source": "desktop"}
        }),
    )
    .await?;
    loop {
        let value = next_frame(socket, Some(MESSAGE_TIMEOUT)).await?;
        if value.get("id").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        if value.get("error").is_some_and(|error| !error.is_null()) {
            if is_session_not_found_error(&value) {
                return Ok(None);
            }
            let message = rpc_error(&value).unwrap_or_else(|| "Hermes gateway error".to_owned());
            let code = value
                .get("error")
                .and_then(|error| error.get("code"))
                .map(Value::to_string)
                .unwrap_or_else(|| "unknown".to_owned());
            return Err(AppError::new("E_HERMES_GATEWAY_STREAM", message)
                .with_detail(format!("session.resume failed with code {code}.")));
        }
        return Ok(Some(value.get("result").cloned().unwrap_or(Value::Null)));
    }
}

async fn open_session(
    socket: &mut Socket,
    input: &HermesChatInput,
    home: &Path,
    remote: bool,
) -> Result<(String, String, Vec<Value>, bool, Option<i64>), AppError> {
    let provider = if remote {
        input.provider.clone()
    } else {
        provider_id(&input.provider).to_owned()
    };
    let model = input.model.clone();
    let effort = reasoning_effort(&input.effort);
    if let Some(stored) = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        && let Some(result) = resume_session(socket, stored).await?
    {
        let live = result
            .get("session_id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::new(
                    "E_HERMES_GATEWAY_STREAM",
                    "Hermes gateway resumed a session without a runtime id.",
                )
            })?;
        let stored_id = result
            .get("stored_session_id")
            .and_then(Value::as_str)
            .unwrap_or(stored)
            .to_owned();
        // `open_requests` replays whoever was still waiting on a human (an approval card written
        // to the previous connection): without re-delivering it the agent stays parked until the
        // runtime's own deadline and the user never sees the question.
        let open = result
            .get("open_requests")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let generation = result.get("execution_generation").and_then(Value::as_i64);
        return Ok((live.to_owned(), stored_id, open, true, generation));
    }
    let mut params = json!({
        "cols": 120,
        "title": input.prompt.chars().take(60).collect::<String>(),
        "source": "desktop",
        "model": model,
        "provider": provider,
        "fast": input.fast
    });
    // A remote host cannot see this Mac's paths, so never send `cwd` (or fall back to this
    // Mac's HOME) on a remote request: it only leaked the local working directory.
    if !remote {
        let cwd = input
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|dir| !dir.is_empty() && Path::new(dir).is_dir())
            .map(str::to_owned)
            .or_else(|| Some(std::env::var("HOME").unwrap_or_else(|_| home.display().to_string())));
        if let Some(cwd) = cwd {
            params["cwd"] = Value::String(cwd);
        }
    }
    if let Some(effort) = effort {
        params["reasoning_effort"] = Value::String(effort.to_owned());
    }
    if let Some(profile) = input
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|profile| !profile.is_empty() && *profile != "default")
    {
        params["profile"] = Value::String(profile.to_owned());
    }
    let result = rpc(socket, 1, "session.create", params).await?;
    let live = result
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::new(
                "E_HERMES_GATEWAY_STREAM",
                "Hermes gateway did not return a session id.",
            )
        })?
        .to_owned();
    let stored = result
        .get("stored_session_id")
        .and_then(Value::as_str)
        .unwrap_or(&live)
        .to_owned();
    let open = result
        .get("open_requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let generation = result.get("execution_generation").and_then(Value::as_i64);
    Ok((live, stored, open, false, generation))
}

/// One attachment ready for the open session.
#[derive(Debug)]
struct PreparedAttachment {
    path: String,
    name: String,
    kind: AttachKind,
}

#[derive(Debug)]
enum AttachKind {
    /// Local `hermes serve` can read `path`. `image.attach` accepts the gateway allowlist.
    LocalImage,
    LocalFile,
    /// Panel authority sessions only implement `image.attach_bytes`, and only for these types.
    /// `image.attach` looks the session up in the legacy table and returns `session not found`.
    RemoteImage(Vec<u8>),
    /// Everything else, including bmp/tiff/svg/ico and HEIC, goes through `file.attach`'s
    /// `data_url`. The panel gateway cannot read this Mac's path.
    RemoteFile(Vec<u8>),
}

/// Extensions `image.attach` accepts. This is Hermes gateway `_IMAGE_EXTENSIONS`
/// (`hermes_cli/cli_terminal_input.py`). HEIC, HEIF and AVIF are not in that set:
/// sending them as `image.attach` fails the turn with 4016 before `prompt.submit`.
pub(crate) fn attachment_is_image(path: &Path) -> bool {
    extension_is(
        path,
        &[
            "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "svg", "ico",
        ],
    )
}

/// Types `gateway.session_images.attach_bytes` will stage. The wider `image.attach` set is
/// rejected there with `invalid_params`.
fn remote_image_bytes(path: &Path) -> bool {
    extension_is(path, &["png", "jpg", "jpeg", "gif", "webp"])
}

fn extension_is(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            allowed
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn encode_bytes(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Remote attachments travel inside one JSON-RPC frame. The panel raises its websocket limit
/// for this (`_DESKTOP_ATTACHMENT_WS_MAX_BYTES`); 16 MiB matches the webapp upload cap.
const REMOTE_ATTACHMENT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const ATTACHMENT_RPC_TIMEOUT: Duration = Duration::from_secs(300);

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "attachment".to_owned())
}

async fn prepare_attachments(
    input: &HermesChatInput,
    remote: bool,
) -> Result<Vec<PreparedAttachment>, AppError> {
    if remote {
        input
            .profile_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(super::remote_auth_required)?;
    }
    let mut prepared = Vec::with_capacity(input.attachments.len());
    for attachment in &input.attachments {
        let path = Path::new(attachment);
        let metadata = tokio::fs::metadata(path).await.map_err(|error| {
            AppError::new("E_HERMES_ATTACHMENT", "The attached file no longer exists.")
                .with_detail(error.to_string())
        })?;
        if !metadata.is_file() {
            return Err(AppError::new(
                "E_HERMES_ATTACHMENT",
                "The attached file is not a regular file.",
            ));
        }
        let name = file_name(path);
        let kind = if remote {
            if metadata.len() > REMOTE_ATTACHMENT_MAX_BYTES {
                return Err(AppError::new(
                    "E_HERMES_ATTACHMENT",
                    "Remote attachments are limited to 16 MB.",
                ));
            }
            let bytes = tokio::fs::read(path).await.map_err(|error| {
                AppError::new("E_HERMES_ATTACHMENT", "Could not read the attached file.")
                    .with_detail(error.to_string())
            })?;
            if bytes.len() as u64 > REMOTE_ATTACHMENT_MAX_BYTES {
                return Err(AppError::new(
                    "E_HERMES_ATTACHMENT",
                    "Remote attachments are limited to 16 MB.",
                ));
            }
            if remote_image_bytes(path) {
                AttachKind::RemoteImage(bytes)
            } else {
                AttachKind::RemoteFile(bytes)
            }
        } else if attachment_is_image(path) {
            AttachKind::LocalImage
        } else {
            AttachKind::LocalFile
        };
        prepared.push(PreparedAttachment {
            path: attachment.clone(),
            name,
            kind,
        });
    }
    Ok(prepared)
}

fn attach_params(attachment: &PreparedAttachment, session_id: &str) -> (&'static str, Value) {
    match &attachment.kind {
        AttachKind::LocalImage => (
            "image.attach",
            json!({"session_id": session_id, "path": attachment.path}),
        ),
        AttachKind::LocalFile => (
            "file.attach",
            json!({"session_id": session_id, "path": attachment.path}),
        ),
        AttachKind::RemoteImage(bytes) => (
            "image.attach_bytes",
            json!({
                "session_id": session_id,
                "content_base64": encode_bytes(bytes),
                "filename": attachment.name,
            }),
        ),
        AttachKind::RemoteFile(bytes) => (
            "file.attach",
            json!({
                "session_id": session_id,
                "name": attachment.name,
                "data_url": format!(
                    "data:application/octet-stream;base64,{}",
                    encode_bytes(bytes)
                ),
            }),
        ),
    }
}

/// Stream a turn through the local Hermes gateway. The desktop has no fallback
/// to the CLI when the gateway itself cannot start.
pub async fn chat(
    bin: &Path,
    home: &Path,
    state: &HermesRuntimeState,
    input: HermesChatInput,
    app: Option<&AppHandle>,
    sink: Option<UnboundedSender<String>>,
) -> Result<HermesChatReply, AppError> {
    // `--profile` makes the runtime re-home to `<root>/profiles/<name>` before it reads any
    // config, so the model and `.env` must be written there rather than to the shared root.
    let config_home = super::profiles::resolve_home(home, input.profile.as_deref())?;
    let api_key = write_config(&config_home, &input)?;
    let server = ensure_server(bin, &config_home, state, &input, api_key.as_deref()).await?;
    let url = format!(
        "ws://127.0.0.1:{}/api/ws?token={}",
        server.port, server.token
    );
    let (socket, _) = connect_async(url).await.map_err(|error| {
        AppError::new(
            "E_HERMES_GATEWAY_STREAM",
            "Could not connect to the Hermes gateway.",
        )
        .with_detail(error.to_string())
    })?;
    let attachments = prepare_attachments(&input, false).await?;
    chat_over_socket(socket, home, state, input, attachments, app, sink, false).await
}

fn remote_ws_url_auth(url: &str, query: &str) -> Result<String, AppError> {
    let url = url.trim();
    let url = if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        url.to_owned()
    };
    if !(url.starts_with("ws://") || url.starts_with("wss://")) {
        return Err(AppError::new(
            "E_HERMES_REMOTE_URL",
            "Remote gateway URL must start with ws://, wss://, http:// or https://.",
        ));
    }
    let (mut base, existing) = match url.split_once('?') {
        Some((base, query)) => (base.to_owned(), Some(query)),
        None => (url, None),
    };
    // Keep any panel mount prefix (`https://host/hermes`) instead of treating it as the
    // WebSocket endpoint; only append `/api/ws` when the path is not already that endpoint.
    base = base.trim_end_matches('/').to_owned();
    if let Some(trimmed) = base.strip_suffix("/login") {
        base = trimmed.trim_end_matches('/').to_owned();
    }
    if !base.ends_with("/api/ws") {
        base.push_str("/api/ws");
    }
    let query = existing
        .map(|existing| format!("{existing}&{query}"))
        .unwrap_or_else(|| query.to_owned());
    Ok(format!("{base}?{query}"))
}

async fn connect_remote_auth(url: &str, query: &str) -> Result<Socket, AppError> {
    let ws_url = remote_ws_url_auth(url, query)?;
    let (socket, _) = timeout(START_TIMEOUT, connect_async(ws_url))
        .await
        .map_err(|_| {
            AppError::new(
                "E_HERMES_REMOTE_TIMEOUT",
                "Remote gateway connection timed out.",
            )
        })?
        .map_err(|error| {
            AppError::new(
                "E_HERMES_REMOTE_CONNECT",
                "Could not connect to the remote Hermes gateway.",
            )
            .with_detail(error.to_string())
        })?;
    Ok(socket)
}

pub async fn chat_remote_auth(
    url: &str,
    query: Option<&str>,
    home: &Path,
    state: &HermesRuntimeState,
    input: HermesChatInput,
    app: Option<&AppHandle>,
    sink: Option<UnboundedSender<String>>,
) -> Result<HermesChatReply, AppError> {
    // Read attachments before opening the socket. The panel ws ticket is single-use and lives
    // for 30 seconds, so it is minted immediately before connect, after this local read.
    let attachments = prepare_attachments(&input, true).await?;
    let query = match query {
        Some(query) => query.to_owned(),
        None => {
            let profile_id = input
                .profile_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(super::remote_auth_required)?;
            let ticket = super::panel::ticket_for(profile_id).await?;
            format!("ticket={}", urlencoding::encode(&ticket))
        }
    };
    let socket = connect_remote_auth(url, &query).await?;
    chat_over_socket(socket, home, state, input, attachments, app, sink, true).await
}

/// Fallback window when an approval carries no `timeout_s`. Matches the runtime's own
/// `approvals.timeout` default, so a card lives as long as the agent is willing to wait.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);
/// `agent.clarify_timeout` default since config schema 53.
const CLARIFY_TIMEOUT: Duration = Duration::from_secs(90);
/// The runtime's sudo / env secret / vault unlock prompt deadlines (`agent_callbacks.py`).
const CREDENTIAL_TIMEOUT: Duration = Duration::from_secs(120);
/// The runtime's vault save-login / one-time-code card deadlines (`session_vault_prompt.py`).
const VAULT_FORM_TIMEOUT: Duration = Duration::from_secs(180);
/// Longest window we honor, whatever the runtime asks for. A configured `approvals.timeout` above
/// this still works server-side (`request.cancel` settles the card); the cap only keeps a malformed
/// value from overflowing an `Instant` or parking the turn forever.
const MAX_ASK_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// The refusal the official renderer sends when no window of its own serves a bridge tool
/// (`server_requests.py::NOT_SHOWN_CODE`). It is not a JSON-RPC code, so it is spelled out here.
const NOT_SHOWN_CODE: i64 = 4404;
/// Bridges driven by in-app windows this build does not have: a preview pane, a terminal, a tour.
const WINDOW_OWNED_REQUESTS: [&str; 5] = [
    "preview.read",
    "preview.act",
    "terminal.read",
    "window.read",
    "tour",
];

/// What a server→client request asks the renderer for. Each kind has its own card and result shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AskKind {
    Approval,
    Clarify,
    Sudo,
    Secret,
    VaultUnlock,
    VaultSaveLogin,
    VaultCode,
}

impl AskKind {
    fn of(method: &str) -> Option<Self> {
        match method {
            "approval" => Some(Self::Approval),
            "clarify" => Some(Self::Clarify),
            "sudo" => Some(Self::Sudo),
            "secret" => Some(Self::Secret),
            "vault.unlock_prompt" => Some(Self::VaultUnlock),
            "vault.save_login" => Some(Self::VaultSaveLogin),
            "vault.code" => Some(Self::VaultCode),
            _ => None,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::Approval => "approval",
            Self::Clarify => "clarify",
            Self::Sudo => "sudo",
            Self::Secret => "secret",
            Self::VaultUnlock => "vault-unlock",
            Self::VaultSaveLogin => "vault-save-login",
            Self::VaultCode => "vault-code",
        }
    }

    /// Fail-closed answer when the card is dismissed, the turn is stopped or the window expires.
    fn refusal(self) -> Value {
        match self {
            Self::Approval => json!({"choice": "deny"}),
            // An empty object is clarify's "cancelled": nobody answered, which is not an answer.
            Self::Clarify => json!({}),
            // Every remaining kind answers one `ValueResult { value }`; "" declines.
            Self::Sudo
            | Self::Secret
            | Self::VaultUnlock
            | Self::VaultSaveLogin
            | Self::VaultCode => {
                json!({"value": ""})
            }
        }
    }
}

/// Where an answer goes: current runtimes take a server→client request answered by JSON-RPC id
/// (`srq-…`), older ones an `approval.request` event answered by `approval.respond`.
enum AskTarget {
    Request(String),
    Event(String),
}

impl AskTarget {
    fn id(&self) -> &str {
        match self {
            AskTarget::Request(id) | AskTarget::Event(id) => id,
        }
    }

    fn matches(&self, id: &str) -> bool {
        match self {
            AskTarget::Request(own) | AskTarget::Event(own) => own == id,
        }
    }
}

/// Who owns the approval decision for this turn.
struct AskPolicy {
    /// Ask the user (writes are confirmed, or a remote host owns its tools) instead of deciding here.
    ask_user: bool,
    /// This Mac's full-control mode: approve without a prompt.
    full_control: bool,
    /// `agent.clarify_timeout` for this profile; `None` is the runtime's "wait forever" (`<= 0`).
    clarify_timeout: Option<Duration>,
}

/// One card the user still has to answer. The read loop keeps running while it is open: uvicorn pings
/// the socket every 20s, and a reader that parks on the answer drops the connection first.
struct PendingAsk {
    target: AskTarget,
    kind: AskKind,
    /// The chat turn that opened this card; the renderer uses it to ignore another window's events.
    turn_request_id: String,
    /// What the settled note in the transcript names (the command, the env var, the first question).
    summary: String,
    /// `None` when the runtime waits forever (`agent.clarify_timeout <= 0`).
    deadline: Option<Instant>,
}

enum Step {
    Frame(Value),
    Answer(Option<AskAnswer>),
    Cancelled,
    Expired,
}

/// Show a card for a server→client request, or answer it from the turn's own policy.
///
/// `restored` marks a request replayed from `open_requests`: its remaining time is unknown, so the
/// card gets no countdown and the backend's `request.cancel` is the authority.
#[allow(clippy::too_many_arguments)]
async fn open_ask(
    socket: &mut Socket,
    app: Option<&AppHandle>,
    target: AskTarget,
    kind: AskKind,
    params: Value,
    policy: &AskPolicy,
    live_sid: &str,
    turn_request_id: &str,
    restored: bool,
) -> Result<Option<PendingAsk>, AppError> {
    let window = ask_window(kind, &params, policy.clarify_timeout);
    let display_window = if restored { None } else { window };
    // Only approvals have a policy: a clarify or a password prompt is the agent asking something the
    // app cannot answer for the user, so those always reach the card.
    if kind == AskKind::Approval && !policy.ask_user {
        let choice = if policy.full_control { "once" } else { "deny" };
        send_response(socket, &target, json!({"choice": choice}), live_sid).await?;
        return Ok(None);
    }
    if let Some(app) = app {
        let _ = app.emit(
            "hermes-ask",
            json!({
                "requestId": target.id(),
                "turnRequestId": turn_request_id,
                "kind": kind.wire(),
                "deadline": display_window.map(|window| unix_millis() + window.as_millis() as u64),
                "params": params,
            }),
        );
    }
    Ok(Some(PendingAsk {
        summary: ask_summary(kind, &params),
        target,
        kind,
        turn_request_id: turn_request_id.to_owned(),
        deadline: window.map(|window| Instant::now() + window),
    }))
}

/// The window the runtime is willing to wait, bounded so a malformed value cannot park the turn
/// forever. Only approvals forward `timeout_s`; the other prompts keep their deadline server-side,
/// so the fallback mirrors each method's own deadline or the displayed countdown disappears early.
/// A `None` result means the runtime waits forever (`agent.clarify_timeout <= 0`).
fn ask_window(
    kind: AskKind,
    params: &Value,
    clarify_timeout: Option<Duration>,
) -> Option<Duration> {
    params
        .get("timeout_s")
        .and_then(Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .map(|window| window.min(MAX_ASK_WINDOW))
        .or(match kind {
            AskKind::Approval => Some(APPROVAL_TIMEOUT),
            AskKind::Clarify => clarify_timeout,
            AskKind::Sudo | AskKind::Secret | AskKind::VaultUnlock => Some(CREDENTIAL_TIMEOUT),
            AskKind::VaultSaveLogin | AskKind::VaultCode => Some(VAULT_FORM_TIMEOUT),
        })
}

/// `<= 0` is the runtime's "wait forever"; a missing/invalid value falls back to the schema default.
fn window_from_seconds(seconds: Option<i64>) -> Option<Duration> {
    match seconds {
        Some(seconds) if seconds <= 0 => None,
        Some(seconds) => Some(Duration::from_secs(
            (seconds as u64).min(MAX_ASK_WINDOW.as_secs()),
        )),
        None => Some(CLARIFY_TIMEOUT),
    }
}

fn yaml_seconds(value: &Yaml) -> Option<i64> {
    match value {
        Yaml::Integer(seconds) => Some(*seconds),
        Yaml::Real(text) => text.parse::<f64>().ok().map(|value| value as i64),
        Yaml::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn json_seconds(value: &Value) -> Option<i64> {
    if let Some(seconds) = value.as_i64() {
        return Some(seconds);
    }
    if let Some(seconds) = value.as_f64() {
        return Some(seconds as i64);
    }
    value
        .as_str()
        .and_then(|text| text.trim().parse::<i64>().ok())
}

/// `clarify.timeout` (legacy, explicit) wins over `agent.clarify_timeout`, exactly like
/// `tools/clarify_gateway.py::resolve_clarify_timeout`. The runtime keeps the clarify deadline
/// server-side (its frame carries no `timeout_s`), and `<= 0` means it waits forever.
fn clarify_timeout(home: &Path) -> Option<Duration> {
    clarify_timeout_from_config(
        std::fs::read_to_string(home.join("config.yaml"))
            .ok()
            .as_deref(),
    )
}

fn clarify_timeout_from_config(raw: Option<&str>) -> Option<Duration> {
    let Some(raw) = raw else {
        return Some(CLARIFY_TIMEOUT);
    };
    let doc = super::config_doc(Some(raw));
    let Some(root) = doc.as_hash() else {
        return Some(CLARIFY_TIMEOUT);
    };
    let legacy = root
        .get(&Yaml::String("clarify".to_owned()))
        .and_then(Yaml::as_hash)
        .and_then(|clarify| clarify.get(&Yaml::String("timeout".to_owned())))
        .filter(|value| !matches!(value, Yaml::Null | Yaml::BadValue));
    let seconds = match legacy {
        // An explicit legacy value wins even when it is non-numeric; the runtime then uses 90.
        Some(value) => yaml_seconds(value),
        None => root
            .get(&Yaml::String("agent".to_owned()))
            .and_then(Yaml::as_hash)
            .and_then(|agent| agent.get(&Yaml::String("clarify_timeout".to_owned())))
            .and_then(yaml_seconds),
    };
    window_from_seconds(seconds)
}

/// The same resolution against a gateway's `config.get full` payload. A remote profile keeps its
/// own config, so its clarify window cannot be read from this Mac's `config.yaml`. When the read
/// fails we cannot know the remote window, so the card gets no local deadline at all (the
/// backend's `request.cancel` stays authoritative) instead of guessing a possibly shorter one.
async fn remote_clarify_timeout(socket: &mut Socket, live_sid: &str) -> Option<Duration> {
    // One small config read before the turn starts; a slow tailnet must not stall the chat.
    let result = rpc_within(
        socket,
        5,
        "config.get",
        json!({"key": "full", "session_id": live_sid}),
        Duration::from_secs(5),
    )
    .await
    .ok()?;
    let config = result.get("config")?;
    clarify_timeout_from_value(config)
}

fn clarify_timeout_from_value(config: &Value) -> Option<Duration> {
    let root = config.as_object();
    let legacy = root
        .and_then(|root| root.get("clarify"))
        .and_then(Value::as_object)
        .and_then(|clarify| clarify.get("timeout"))
        .filter(|value| !value.is_null());
    let seconds = match legacy {
        Some(value) => json_seconds(value),
        None => root
            .and_then(|root| root.get("agent"))
            .and_then(Value::as_object)
            .and_then(|agent| agent.get("clarify_timeout"))
            .and_then(json_seconds),
    };
    window_from_seconds(seconds)
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// One line naming what the user was asked, kept short enough for a transcript row.
fn ask_summary(kind: AskKind, params: &Value) -> String {
    let field = |name: &str| {
        params
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let text = match kind {
        AskKind::Approval => field("command")
            .or_else(|| field("description"))
            .unwrap_or_default(),
        AskKind::Clarify => field("question")
            .or_else(|| {
                params
                    .get("questions")
                    .and_then(Value::as_array)
                    .and_then(|questions| questions.first())
                    .and_then(|question| question.get("question"))
                    .and_then(Value::as_str)
            })
            .unwrap_or_default(),
        AskKind::Sudo => field("command").unwrap_or_default(),
        AskKind::Secret => field("env_var")
            .or_else(|| field("prompt"))
            .unwrap_or_default(),
        AskKind::VaultUnlock => field("display_name")
            .or_else(|| field("backend"))
            .unwrap_or_default(),
        AskKind::VaultSaveLogin => field("site")
            .or_else(|| field("origin"))
            .unwrap_or_default(),
        AskKind::VaultCode => field("site").or_else(|| field("hint")).unwrap_or_default(),
    };
    let mut summary = text.chars().take(200).collect::<String>();
    if text.chars().count() > 200 {
        summary.push('…');
    }
    summary
}

/// Answer a server→client request with the JSON-RPC `result` the runtime expects.
async fn send_response(
    socket: &mut Socket,
    target: &AskTarget,
    result: Value,
    live_sid: &str,
) -> Result<(), AppError> {
    match target {
        AskTarget::Request(id) => {
            send_json(
                socket,
                json!({"jsonrpc": "2.0", "id": id, "result": result}),
            )
            .await
        }
        // The event protocol only ever asks for approvals; the answer is its own RPC.
        AskTarget::Event(request_id) => {
            let choice = result
                .get("choice")
                .and_then(Value::as_str)
                .unwrap_or("deny")
                .to_owned();
            let mut params = json!({"session_id": live_sid, "choice": choice});
            if !request_id.is_empty() {
                params["request_id"] = Value::String(request_id.clone());
            }
            send_json(
                socket,
                json!({"jsonrpc": "2.0", "id": 100, "method": "approval.respond", "params": params}),
            )
            .await
        }
    }
}

/// Refuse a request this build cannot serve. A bridge tool gets the renderer's "no window shows this
/// chat" decline (the runtime turns it into a friendly refusal); anything else says "no handler",
/// which settles the request at once so the agent is never parked on a question nobody can see.
async fn refuse_request(socket: &mut Socket, id: &str, method: &str) -> Result<(), AppError> {
    let (code, message) = if WINDOW_OWNED_REQUESTS.contains(&method) {
        (
            NOT_SHOWN_CODE,
            "No Hermes Desktop window is showing this chat, so its preview, terminal and tour are out \
             of reach. Ask the user to open this chat in the Desktop app, then retry."
                .to_owned(),
        )
    } else {
        (
            -32601,
            format!("This Hermes Desktop build has no handler for {method}."),
        )
    };
    send_json(
        socket,
        json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
    )
    .await
}

/// The transcript note for one settled request: what was asked, how it ended, and — for a clarify —
/// how many questions were answered. Never carries a secret value.
fn settled_note(
    ask: &PendingAsk,
    outcome: &str,
    scope: Option<&str>,
    count: Option<usize>,
) -> Value {
    json!({
        "requestId": ask.target.id(),
        "turnRequestId": ask.turn_request_id,
        "kind": ask.kind.wire(),
        "outcome": outcome,
        "scope": scope,
        "summary": ask.summary,
        "count": count,
    })
}

/// The runtime-side result for one answer, plus the note the transcript records for it.
fn answer_result(ask: &PendingAsk, reply: HermesAskReply) -> (Value, Value) {
    let settled = |outcome: &str, scope: Option<&str>, count: Option<usize>| {
        settled_note(ask, outcome, scope, count)
    };
    match (ask.kind, reply) {
        (AskKind::Approval, HermesAskReply::Approval { choice }) => {
            let scope =
                matches!(choice.as_str(), "once" | "session" | "always").then(|| choice.clone());
            let outcome = if choice == "deny" {
                "denied"
            } else {
                "allowed"
            };
            (
                json!({"choice": choice}),
                settled(outcome, scope.as_deref(), None),
            )
        }
        (AskKind::Clarify, HermesAskReply::Clarify { answers, cancelled }) => {
            if cancelled {
                return (AskKind::Clarify.refusal(), settled("cancelled", None, None));
            }
            let answered = answers
                .iter()
                .filter(|answer| answer.answer.is_some())
                .count();
            let answers = answers
                .into_iter()
                .map(|answer| {
                    (
                        answer.qid,
                        answer.answer.map(Value::String).unwrap_or(Value::Null),
                    )
                })
                .collect::<serde_json::Map<String, Value>>();
            (
                json!({"answers": answers}),
                settled("submitted", None, Some(answered)),
            )
        }
        (
            AskKind::Sudo | AskKind::Secret | AskKind::VaultUnlock | AskKind::VaultCode,
            HermesAskReply::Secret { value },
        ) => {
            let outcome = if value.trim().is_empty() {
                "skipped"
            } else {
                "submitted"
            };
            (json!({"value": value}), settled(outcome, None, None))
        }
        (
            AskKind::VaultSaveLogin,
            HermesAskReply::VaultSaveLogin {
                identifier,
                password,
            },
        ) => {
            // The runtime stores the pair as a JSON string under `value`; an empty password declines.
            if password.is_empty() {
                return (
                    AskKind::VaultSaveLogin.refusal(),
                    settled("skipped", None, None),
                );
            }
            let credential = json!({
                "identifier": identifier.trim(),
                "password": password,
            })
            .to_string();
            (
                json!({"value": credential}),
                settled("submitted", None, None),
            )
        }
        // A reply that does not match its card is a renderer bug: fail closed rather than park the agent.
        (kind, _) => (kind.refusal(), settled("cancelled", None, None)),
    }
}

fn emit_settled(app: Option<&AppHandle>, settled: &Value) {
    if let Some(app) = app {
        let _ = app.emit("hermes-ask-settled", settled.clone());
    }
}

/// The runtime's `display.busy_input_mode` (`interrupt` | `steer` | `queue`). The official
/// desktop reads the same value from `config.get {key:"busy"}`. Older gateways do not know the
/// key; the deadline keeps the turn from waiting on a best-effort config read.
async fn busy_input_mode(socket: &mut Socket, live_session_id: &str) -> String {
    rpc_within(
        socket,
        3,
        "config.get",
        json!({"key": "busy", "session_id": live_session_id}),
        BUSY_MODE_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|result| {
        result
            .get("value")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
    .filter(|value| matches!(value.as_str(), "interrupt" | "steer" | "queue"))
    .unwrap_or_else(|| "interrupt".to_owned())
}

#[allow(clippy::too_many_arguments)]
async fn chat_over_socket(
    mut socket: Socket,
    home: &Path,
    state: &HermesRuntimeState,
    input: HermesChatInput,
    attachments: Vec<PreparedAttachment>,
    app: Option<&AppHandle>,
    sink: Option<UnboundedSender<String>>,
    remote: bool,
) -> Result<HermesChatReply, AppError> {
    // The runtime fails every server→client request fast for a connection that never advertised
    // handling them (`server_requests.py::advertise`). Without this the approval queue waits out its
    // own timeout and withdraws the tool while no card ever reaches the user.
    let _ = rpc(
        &mut socket,
        0,
        "client.capabilities",
        json!({"server_requests": true}),
    )
    .await;
    let (live_sid, stored_sid, open_requests, resumed, resumed_generation) =
        open_session(&mut socket, &input, home, remote).await?;
    // The runtime keeps clarify's deadline server-side, so mirror its configured value: the local
    // profile's config.yaml, or a remote host's own config. Unreadable config falls back to the
    // schema default; `None` means the runtime waits forever.
    let clarify_window = if remote {
        remote_clarify_timeout(&mut socket, &live_sid).await
    } else {
        super::profiles::resolve_home(home, input.profile.as_deref())
            .ok()
            .map_or(Some(CLARIFY_TIMEOUT), |config_home| {
                clarify_timeout(&config_home)
            })
    };
    if let Some(app) = app {
        let busy_mode = busy_input_mode(&mut socket, &live_sid).await;
        let _ = app.emit(
            "hermes-session",
            json!({
                "requestId": input.request_id,
                "liveSessionId": live_sid,
                "sessionId": stored_sid,
                "resumed": resumed,
                "busyInputMode": busy_mode
            }),
        );
    }
    // A remote host still owns its tools, so its approval must reach the user even though this Mac's
    // capabilities are forced off.
    let policy = AskPolicy {
        ask_user: input.confirm_writes || remote,
        full_control: !remote
            && input.mac_enabled
            && input.control_level == "full"
            && !input.confirm_writes,
        clarify_timeout: clarify_window,
    };
    if policy.full_control {
        let _ = rpc(
            &mut socket,
            2,
            "config.set",
            json!({"session_id": live_sid, "key": "yolo", "value": true, "scope": "session"}),
        )
        .await;
    }
    let mut prompt = input.prompt.clone();
    for (index, attachment) in attachments.iter().enumerate() {
        let (method, params) = attach_params(attachment, &live_sid);
        // A remote payload can be 16 MiB of base64 on a tailnet. The turn's 180s frame budget
        // is too short for that transfer; the old HTTP upload used the same 300s budget.
        let attached = if remote {
            rpc_within(
                &mut socket,
                10 + index as u64,
                method,
                params,
                ATTACHMENT_RPC_TIMEOUT,
            )
            .await?
        } else {
            rpc(&mut socket, 10 + index as u64, method, params).await?
        };
        if matches!(
            attachment.kind,
            AttachKind::LocalFile | AttachKind::RemoteFile(_)
        ) && let Some(reference) = attached.get("ref_text").and_then(Value::as_str)
        {
            prompt.push('\n');
            prompt.push_str(reference);
        }
    }
    send_json(
        &mut socket,
        json!({"jsonrpc": "2.0", "id": 4, "method": "prompt.submit", "params": {"session_id": live_sid, "text": prompt}}),
    )
    .await?;

    let result = stream_turn(
        &mut socket,
        home,
        state,
        &input,
        app,
        sink.as_ref(),
        &live_sid,
        &stored_sid,
        policy,
        open_requests,
        resumed_generation,
    )
    .await;
    // The cards, and the sender a late answer would reach, die with the turn.
    *state.asks.lock().await = None;
    result
}

#[allow(clippy::too_many_arguments)]
async fn stream_turn(
    socket: &mut Socket,
    home: &Path,
    state: &HermesRuntimeState,
    input: &HermesChatInput,
    app: Option<&AppHandle>,
    sink: Option<&UnboundedSender<String>>,
    live_sid: &str,
    stored_sid: &str,
    policy: AskPolicy,
    open_requests: Vec<Value>,
    resumed_generation: Option<i64>,
) -> Result<HermesChatReply, AppError> {
    let mut asks: Vec<PendingAsk> = Vec::new();
    let (answers, mut answered) = tokio::sync::mpsc::unbounded_channel::<AskAnswer>();
    *state.asks.lock().await = Some(answers);
    // A question still waiting on the previous connection is re-delivered here, as the official
    // client does with `session.resume`'s `open_requests`.
    for entry in open_requests {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let method = entry
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = entry.get("params").cloned().unwrap_or(Value::Null);
        match AskKind::of(method) {
            Some(kind) => {
                if let Some(ask) = open_ask(
                    socket,
                    app,
                    AskTarget::Request(id.to_owned()),
                    kind,
                    params,
                    &policy,
                    live_sid,
                    &input.request_id,
                    true,
                )
                .await?
                {
                    asks.push(ask);
                }
            }
            None => refuse_request(socket, id, method).await?,
        }
    }
    let mut deadline = Instant::now() + MESSAGE_TIMEOUT;
    let mut accumulated = String::new();
    // Resume reports the last claimed generation. The turn this submit is about to claim is
    // strictly newer, so the snapshot is only a floor: publishing it would steer with a value
    // the gateway is about to retire.
    let mut execution_generation = resumed_generation;
    loop {
        // A parked question owns the clock: the turn's stall budget does not run while the user decides.
        if asks.is_empty() && Instant::now() >= deadline {
            let _ = send_json(
                socket,
                json!({"jsonrpc": "2.0", "id": 99, "method": "session.interrupt", "params": {"session_id": live_sid}}),
            )
            .await;
            return Err(AppError::new(
                "E_HERMES_GATEWAY_TIMEOUT",
                "Hermes took too long to answer.",
            ));
        }
        let value = if asks.is_empty() {
            // Bounded by the same stall budget as the check above, so a gateway that only pings
            // lands here and the session is interrupted instead of being left running.
            match next_frame(socket, Some(MESSAGE_TIMEOUT)).await {
                Ok(value) => value,
                Err(error) if error.code == "E_HERMES_GATEWAY_TIMEOUT" => {
                    let _ = send_json(
                        socket,
                        json!({"jsonrpc": "2.0", "id": 99, "method": "session.interrupt", "params": {"session_id": live_sid}}),
                    )
                    .await;
                    return Err(AppError::new(
                        "E_HERMES_GATEWAY_TIMEOUT",
                        "Hermes took too long to answer.",
                    ));
                }
                Err(error) => return Err(error),
            }
        } else {
            let soonest = asks.iter().filter_map(|ask| ask.deadline).min();
            let step = match soonest {
                Some(soonest) => {
                    let wait = soonest.saturating_duration_since(Instant::now());
                    tokio::select! {
                        frame = next_frame(socket, None) => Step::Frame(frame?),
                        answer = answered.recv() => Step::Answer(answer),
                        _ = state.approval_cancel.notified() => Step::Cancelled,
                        _ = sleep(wait) => Step::Expired,
                    }
                }
                // Every open card waits forever (`agent.clarify_timeout <= 0`): no local expiry.
                None => tokio::select! {
                    frame = next_frame(socket, None) => Step::Frame(frame?),
                    answer = answered.recv() => Step::Answer(answer),
                    _ = state.approval_cancel.notified() => Step::Cancelled,
                },
            };
            match step {
                Step::Frame(value) => value,
                Step::Answer(Some(answer)) => {
                    if let Some(index) = asks
                        .iter()
                        .position(|ask| ask.target.matches(&answer.request_id))
                    {
                        let ask = asks.remove(index);
                        let (result, settled) = answer_result(&ask, answer.reply);
                        send_response(socket, &ask.target, result, live_sid).await?;
                        emit_settled(app, &settled);
                    }
                    // The card may have been open past the stall budget; the agent now owes the
                    // next frame, so restart the budget instead of interrupting on the stale one.
                    deadline = Instant::now() + MESSAGE_TIMEOUT;
                    continue;
                }
                // The turn was stopped (⌘⇧.) or the channel died: fail closed on every open card.
                Step::Answer(None) | Step::Cancelled => {
                    for ask in asks.drain(..) {
                        send_response(socket, &ask.target, ask.kind.refusal(), live_sid).await?;
                        emit_settled(app, &settled_note(&ask, "cancelled", None, None));
                    }
                    deadline = Instant::now() + MESSAGE_TIMEOUT;
                    continue;
                }
                Step::Expired => {
                    let now = Instant::now();
                    let (expired, live): (Vec<PendingAsk>, Vec<PendingAsk>) = asks
                        .drain(..)
                        .partition(|ask| ask.deadline.is_some_and(|deadline| deadline <= now));
                    asks = live;
                    for ask in expired {
                        send_response(socket, &ask.target, ask.kind.refusal(), live_sid).await?;
                        emit_settled(app, &settled_note(&ask, "timeout", None, None));
                    }
                    // A card the user took minutes to answer must not consume the next frame's
                    // stall budget: re-arm it once the card settles.
                    deadline = Instant::now() + MESSAGE_TIMEOUT;
                    continue;
                }
            }
        };
        // `MESSAGE_TIMEOUT` is a stall budget, not a cap on the turn: the official dashboard client
        // has no whole-turn deadline, so any frame the runtime sends (a delta, a tool event, a
        // compaction status) proves the turn is alive. Without this reset a long answer streaming
        // past three minutes was interrupted mid-sentence.
        deadline = Instant::now() + MESSAGE_TIMEOUT;
        if let Some(error) = rpc_error(&value)
            && value.get("id").and_then(Value::as_u64) == Some(4)
        {
            append_audit(home, input, "failed", Some(stored_sid), Some(&error));
            return Err(AppError::new("E_HERMES_GATEWAY_STREAM", error));
        }
        // A server→client request: the turn is parked on a human answer. Approvals, clarify questions
        // and password prompts become cards; a bridge this build has no window for is declined.
        if let Some(method) = value
            .get("method")
            .and_then(Value::as_str)
            .filter(|method| *method != "event")
        {
            let Some(Value::String(id)) = value.get("id") else {
                continue;
            };
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            match AskKind::of(method) {
                Some(kind) => {
                    if let Some(ask) = open_ask(
                        socket,
                        app,
                        AskTarget::Request(id.clone()),
                        kind,
                        params,
                        &policy,
                        live_sid,
                        &input.request_id,
                        false,
                    )
                    .await?
                    {
                        asks.push(ask);
                        #[cfg(test)]
                        state.ask_opened.notify_one();
                    }
                }
                None => refuse_request(socket, id, method).await?,
            }
            continue;
        }
        let Some(params) = value.get("params") else {
            continue;
        };
        let event = params
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = params.get("payload").cloned().unwrap_or(Value::Null);
        // `prompt.submit` publishes `session.info` before the claim, still carrying the previous
        // generation and `running: false`. A steer flushed with that value is refused as
        // `stale_generation`. Only the claim (`message.start`) or a frame that says the turn is
        // running may advance the stamp, and only to a newer value.
        if let Some(generation) = accepted_running_generation(execution_generation, event, params) {
            execution_generation = Some(generation);
            if let Some(app) = app {
                let _ = app.emit(
                    "hermes-session",
                    json!({
                        "requestId": input.request_id,
                        "liveSessionId": live_sid,
                        "sessionId": stored_sid,
                        "executionGeneration": generation
                    }),
                );
            }
        }
        match event {
            "message.delta" => {
                let delta = payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    continue;
                }
                accumulated.push_str(delta);
                if let Some(sink) = sink {
                    let _ = sink.send(delta.to_owned());
                }
                if let Some(app) = app {
                    let _ = app.emit(
                        "hermes-chunk",
                        HermesChunk {
                            request_id: input.request_id.clone(),
                            delta: delta.to_owned(),
                        },
                    );
                }
            }
            "tool.start" => {
                if let Some(app) = app {
                    let _ = app.emit(
                        "hermes-tool",
                        json!({
                            "requestId": input.request_id,
                            "phase": "start",
                            "toolId": payload.get("tool_id").and_then(Value::as_str).unwrap_or_default(),
                            "name": payload.get("name").and_then(Value::as_str).unwrap_or("tool"),
                            "label": payload.get("preview").and_then(Value::as_str).unwrap_or("")
                        }),
                    );
                }
            }
            "tool.complete" => {
                if let Some(app) = app {
                    let _ = app.emit(
                        "hermes-tool",
                        json!({
                            "requestId": input.request_id,
                            "phase": "complete",
                            "toolId": payload.get("tool_id").and_then(Value::as_str).unwrap_or_default(),
                            "name": payload.get("name").and_then(Value::as_str).unwrap_or("tool"),
                            "label": payload.get("summary").and_then(Value::as_str).unwrap_or(""),
                            "duration": payload.get("duration_s").and_then(Value::as_f64).unwrap_or(0.0)
                        }),
                    );
                }
            }
            "reasoning.delta" | "thinking.delta" => {
                if let Some(app) = app {
                    let delta = payload.get("text").and_then(Value::as_str).unwrap_or("");
                    if !delta.is_empty() {
                        let _ = app.emit(
                            "hermes-reasoning",
                            json!({"requestId": input.request_id, "delta": delta}),
                        );
                    }
                }
            }
            "message.complete" => {
                let text = payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or(&accumulated)
                    .to_owned();
                let status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("complete");
                if status == "error" {
                    append_audit(home, input, "failed", Some(stored_sid), Some(&text));
                    return Err(AppError::new("E_HERMES_GATEWAY_STREAM", text));
                }
                // Official desktop treats `interrupted` as a stopped turn: Hermes
                // blanks the "waiting for model response" sentinel, so this text
                // is often empty while the preamble already streamed. Recording
                // that as success made the bubble look like a finished answer.
                let interrupted = status == "interrupted";
                append_audit(
                    home,
                    input,
                    if interrupted {
                        "interrupted"
                    } else {
                        "succeeded"
                    },
                    Some(stored_sid),
                    None,
                );
                let usage = payload
                    .get("usage")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<HermesUsage>(value).ok());
                return Ok(HermesChatReply {
                    text: clean_output(&text),
                    session_id: Some(stored_sid.to_owned()),
                    live_session_id: Some(live_sid.to_owned()),
                    usage,
                    interrupted,
                });
            }
            "error" => {
                let message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Hermes gateway returned an error.")
                    .to_owned();
                append_audit(home, input, "failed", Some(stored_sid), Some(&message));
                return Err(AppError::new("E_HERMES_GATEWAY_STREAM", message));
            }
            "request.cancel" => {
                // The runtime withdrew the question (its own deadline, an interrupt, another surface
                // answered): drop the card and record how it ended.
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(index) = asks.iter().position(|ask| ask.target.matches(id)) {
                    let ask = asks.remove(index);
                    let outcome =
                        if payload.get("reason").and_then(Value::as_str) == Some("timeout") {
                            "timeout"
                        } else {
                            "cancelled"
                        };
                    emit_settled(app, &settled_note(&ask, outcome, None, None));
                }
            }
            "approval.request" => {
                // Older runtimes ask over an event and take `approval.respond`; current ones ask over
                // the server→client request handled above.
                let request_id = payload
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if let Some(ask) = open_ask(
                    socket,
                    app,
                    AskTarget::Event(request_id),
                    AskKind::Approval,
                    payload,
                    &policy,
                    live_sid,
                    &input.request_id,
                    false,
                )
                .await?
                {
                    asks.push(ask);
                }
            }
            _ => {}
        }
    }
}

async fn connect_running(state: &HermesRuntimeState) -> Result<Socket, AppError> {
    let server = state
        .gateway
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| AppError::new("E_HERMES_GATEWAY", "No Hermes session is running."))?;
    let url = format!(
        "ws://127.0.0.1:{}/api/ws?token={}",
        server.port, server.token
    );
    connect_async(url)
        .await
        .map(|(socket, _)| socket)
        .map_err(|error| {
            AppError::new(
                "E_HERMES_GATEWAY_STREAM",
                "Could not connect to the Hermes gateway.",
            )
            .with_detail(error.to_string())
        })
}

pub async fn interrupt(state: &HermesRuntimeState, live_session_id: &str) -> Result<(), AppError> {
    // Wakes the running turn's card wait, which fails closed on every open ask itself.
    state.approval_cancel.notify_waiters();
    let mut socket = connect_running(state).await?;
    rpc(
        &mut socket,
        1,
        "session.interrupt",
        json!({"session_id": live_session_id}),
    )
    .await?;
    Ok(())
}

pub async fn interrupt_remote_auth(
    url: &str,
    query: &str,
    live_session_id: &str,
) -> Result<(), AppError> {
    let mut socket = connect_remote_auth(url, query).await?;
    rpc(
        &mut socket,
        1,
        "session.interrupt",
        json!({"session_id": live_session_id}),
    )
    .await?;
    Ok(())
}

pub async fn steer_remote_auth(
    url: &str,
    query: &str,
    live_session_id: &str,
    execution_generation: i64,
    text: &str,
) -> Result<HermesSteerResult, AppError> {
    if text.trim().is_empty() {
        return Err(AppError::new("E_HERMES_INPUT", "The message is empty."));
    }
    let mut socket = connect_remote_auth(url, query).await?;
    let result = rpc(
        &mut socket,
        1,
        "session.steer",
        steer_params(live_session_id, execution_generation, text),
    )
    .await?;
    steer_result(result)
}

pub async fn steer(
    state: &HermesRuntimeState,
    live_session_id: &str,
    execution_generation: i64,
    text: &str,
) -> Result<HermesSteerResult, AppError> {
    if text.trim().is_empty() {
        return Err(AppError::new("E_HERMES_INPUT", "The message is empty."));
    }
    let mut socket = connect_running(state).await?;
    let result = rpc(
        &mut socket,
        1,
        "session.steer",
        steer_params(live_session_id, execution_generation, text),
    )
    .await?;
    steer_result(result)
}

/// The official desktop's busy-input default: cancel the active model request, keep the work
/// already shown, insert the correction as a real user row and retry. During tool execution the
/// runtime degrades this to a steer and answers `redirected` once the tool boundary is safe.
pub async fn redirect_remote_auth(
    url: &str,
    query: &str,
    live_session_id: &str,
    text: &str,
) -> Result<HermesSteerResult, AppError> {
    if text.trim().is_empty() {
        return Err(AppError::new("E_HERMES_INPUT", "The message is empty."));
    }
    let mut socket = connect_remote_auth(url, query).await?;
    let result = rpc(
        &mut socket,
        1,
        "session.redirect",
        redirect_params(live_session_id, text),
    )
    .await?;
    steer_result(result)
}

pub async fn redirect(
    state: &HermesRuntimeState,
    live_session_id: &str,
    text: &str,
) -> Result<HermesSteerResult, AppError> {
    if text.trim().is_empty() {
        return Err(AppError::new("E_HERMES_INPUT", "The message is empty."));
    }
    let mut socket = connect_running(state).await?;
    let result = rpc(
        &mut socket,
        1,
        "session.redirect",
        redirect_params(live_session_id, text),
    )
    .await?;
    steer_result(result)
}

/// Generation a queued steer may echo, or `None` when this frame must not move the stamp.
///
/// Idle `session.info` (the frame `prompt.submit` publishes before the admission is claimed)
/// still carries the previous turn's generation. The official desktop client also refuses to
/// move a generation backwards.
fn accepted_running_generation(current: Option<i64>, event: &str, params: &Value) -> Option<i64> {
    let payload = params.get("payload").unwrap_or(&Value::Null);
    let running =
        event == "message.start" || payload.get("running").and_then(Value::as_bool) == Some(true);
    if !running {
        return None;
    }
    let generation = params
        .get("execution_generation")
        .and_then(Value::as_i64)
        .or_else(|| payload.get("execution_generation").and_then(Value::as_i64))?;
    if current.is_some_and(|current| generation <= current) {
        return None;
    }
    Some(generation)
}

/// `session.steer` rejects any other key and requires this exact generation, so keep the wire
/// shape in one place instead of letting the local and remote paths drift apart.
fn steer_params(live_session_id: &str, execution_generation: i64, text: &str) -> Value {
    json!({
        "session_id": live_session_id,
        "text": text,
        "execution_generation": execution_generation
    })
}

/// The official desktop sends only the session and text for a redirect; the runtime has no
/// generation fence on this method.
fn redirect_params(live_session_id: &str, text: &str) -> Value {
    json!({
        "session_id": live_session_id,
        "text": text
    })
}

fn steer_result(result: Value) -> Result<HermesSteerResult, AppError> {
    let status = match result.get("status").and_then(Value::as_str) {
        Some("queued") => HermesSteerStatus::Queued,
        Some("redirected") => HermesSteerStatus::Redirected,
        Some("rejected") => HermesSteerStatus::Rejected,
        _ => Err(AppError::new(
            "E_HERMES_STEER",
            "Hermes gateway returned an unexpected steer response.",
        )
        .with_detail(result.to_string()))?,
    };
    let delivered = if status == HermesSteerStatus::Rejected {
        result.get("delivered").and_then(Value::as_bool)
    } else {
        None
    };
    Ok(HermesSteerResult { status, delivered })
}

/// Read the official Hermes model catalog through the local gateway.
pub async fn model_options(
    bin: &Path,
    home: &Path,
    state: &HermesRuntimeState,
    input: HermesChatInput,
    refresh: bool,
    include_unconfigured: bool,
) -> Result<HermesModelOptions, AppError> {
    let config_home = super::profiles::resolve_home(home, input.profile.as_deref())?;
    // A catalog read must not rewrite the profile's model, agent or auxiliary settings: the
    // settings sheet loads a profile's catalog just by selecting it, passing that profile's
    // saved draft (or the built-in default when this window never opened it), so a full write
    // here replaced the profile's own model with whatever the draft happened to hold.
    let api_key = write_catalog_config(&config_home, &input)?;
    let profile = input.profile.clone();
    let read = |api_key: &Option<String>| {
        let config_home = config_home.clone();
        let input = input.clone();
        let api_key = api_key.clone();
        let profile = profile.clone();
        async move {
            let server =
                ensure_server(bin, &config_home, state, &input, api_key.as_deref()).await?;
            let url = format!(
                "ws://127.0.0.1:{}/api/ws?token={}",
                server.port, server.token
            );
            let (socket, _) = connect_async(url).await.map_err(|error| {
                AppError::new(
                    "E_HERMES_GATEWAY_STREAM",
                    "Could not connect to the Hermes gateway.",
                )
                .with_detail(error.to_string())
            })?;
            // Hold this clone across the read. The last `GatewayServer` drops kills the child,
            // and a non-lexical drop at `server.token` would let a concurrent restart do that
            // while this socket is still open.
            let options = model_options_over_socket(
                socket,
                refresh,
                include_unconfigured,
                profile.as_deref(),
            )
            .await;
            drop(server);
            options
        }
    };
    match read(&api_key).await {
        Err(error) => model_options_once_more(error, read(&api_key)).await,
        result => result,
    }
}

async fn model_options_over_socket(
    mut socket: Socket,
    refresh: bool,
    include_unconfigured: bool,
    profile: Option<&str>,
) -> Result<HermesModelOptions, AppError> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        rpc(
            &mut socket,
            1,
            "model.options",
            json!({
                "include_unconfigured": include_unconfigured,
                "refresh": refresh,
                "profile": profile.filter(|value| !value.trim().is_empty() && *value != "default")
            }),
        ),
    )
    .await
    .map_err(|_| {
        AppError::new(
            "E_HERMES_MODEL_OPTIONS_TIMEOUT",
            "加载官方模型目录超时，请稍后重试。",
        )
    })??;
    serde_json::from_value(result).map_err(|error| {
        AppError::new(
            "E_HERMES_MODEL_OPTIONS",
            "Hermes returned an invalid model catalog.",
        )
        .with_detail(error.to_string())
    })
}

pub async fn model_options_remote_auth(
    url: &str,
    query: &str,
    profile: Option<&str>,
    refresh: bool,
    include_unconfigured: bool,
) -> Result<HermesModelOptions, AppError> {
    // One handshake per call. The query carries a single-use panel ticket, so a restart
    // retry belongs to the caller, which mints a new ticket before connecting again.
    let socket = connect_remote_auth(url, query).await?;
    model_options_over_socket(socket, refresh, include_unconfigured, profile).await
}

/// Test seam used by the ignored real-runtime tests.
#[cfg(test)]
pub async fn chat_for_test(
    bin: &Path,
    home: &Path,
    input: HermesChatInput,
    sink: UnboundedSender<String>,
) -> Result<HermesChatReply, AppError> {
    let state = HermesRuntimeState::default();
    chat(bin, home, &state, input, None, Some(sink)).await
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::hermes::HermesClarifyAnswer;

    #[test]
    fn image_attachments_match_the_gateway_allowlist() {
        for extension in [
            "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "svg", "ico",
        ] {
            assert!(
                attachment_is_image(Path::new(&format!("/tmp/shot.{extension}"))),
                "{extension}"
            );
            assert!(
                attachment_is_image(Path::new(&format!(
                    "/tmp/shot.{}",
                    extension.to_ascii_uppercase()
                ))),
                "{extension} uppercase"
            );
        }
        for extension in ["heic", "heif", "avif", "mp4", "pdf", "txt"] {
            assert!(
                !attachment_is_image(Path::new(&format!("/tmp/shot.{extension}"))),
                "{extension}"
            );
        }
    }

    #[test]
    fn remote_png_uses_attach_bytes_and_other_files_use_a_data_url() {
        let image = PreparedAttachment {
            path: "/tmp/a.png".into(),
            name: "a.png".into(),
            kind: AttachKind::RemoteImage(b"png".to_vec()),
        };
        let (method, params) = attach_params(&image, "sid");
        assert_eq!(method, "image.attach_bytes");
        assert_eq!(params["filename"], "a.png");
        assert_eq!(params["content_base64"], encode_bytes(b"png"));
        assert!(params.get("path").is_none());

        let file = PreparedAttachment {
            path: "/tmp/a.heic".into(),
            name: "a.heic".into(),
            kind: AttachKind::RemoteFile(b"heic".to_vec()),
        };
        let (method, params) = attach_params(&file, "sid");
        assert_eq!(method, "file.attach");
        assert_eq!(params["name"], "a.heic");
        assert_eq!(
            params["data_url"],
            format!(
                "data:application/octet-stream;base64,{}",
                encode_bytes(b"heic")
            )
        );
        assert!(params.get("path").is_none());
    }

    #[tokio::test]
    async fn remote_attachments_are_read_locally() {
        let dir = std::env::temp_dir().join(format!("hermes-attach-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("shot.PNG");
        let bmp = dir.join("shot.bmp");
        let big = dir.join("big.bin");
        std::fs::write(&png, b"png-bytes").unwrap();
        std::fs::write(&bmp, b"bmp-bytes").unwrap();
        std::fs::File::create(&big)
            .unwrap()
            .set_len(REMOTE_ATTACHMENT_MAX_BYTES + 1)
            .unwrap();
        let input = HermesChatInput {
            prompt: "hi".into(),
            request_id: "req".into(),
            session_id: None,
            provider: "custom".into(),
            model: "m".into(),
            effort: "low".into(),
            fast: false,
            api_key: None,
            endpoint: None,
            cwd: None,
            attachments: vec![png.display().to_string(), bmp.display().to_string()],
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: Some("http://panel.example:9119".into()),
            profile_id: Some("panel".into()),
            profile: None,
            panel_auth: true,
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: false,
            mac_screen: false,
            mac_files: false,
            mac_cron: false,
            confirm_writes: false,
        };
        let prepared = prepare_attachments(&input, true).await.unwrap();
        assert!(matches!(
            &prepared[0].kind,
            AttachKind::RemoteImage(bytes) if bytes == b"png-bytes"
        ));
        assert!(matches!(
            &prepared[1].kind,
            AttachKind::RemoteFile(bytes) if bytes == b"bmp-bytes"
        ));
        let local = prepare_attachments(&input, false).await.unwrap();
        assert!(matches!(local[0].kind, AttachKind::LocalImage));
        assert!(matches!(local[1].kind, AttachKind::LocalImage));
        let mut too_big = input;
        too_big.attachments = vec![big.display().to_string()];
        let error = prepare_attachments(&too_big, true).await.unwrap_err();
        assert_eq!(error.code, "E_HERMES_ATTACHMENT");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Connect a client to an in-process WebSocket server and return both ends.
    async fn ws_pair() -> (
        Socket,
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            tokio_tungstenite::accept_async(stream)
                .await
                .expect("handshake")
        });
        let (client, _) = connect_async(format!("ws://{addr}/api/ws"))
            .await
            .expect("connect");
        let server = server.await.expect("server task");
        (client, server)
    }

    async fn next_text(
        socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> Value {
        loop {
            match socket.next().await.expect("frame").expect("message") {
                Message::Text(text) => return serde_json::from_str(text.as_str()).expect("json"),
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn resume_only_falls_back_for_an_explicit_missing_session() {
        let (mut client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let request = next_text(&mut server).await;
            assert_eq!(request["method"], "session.resume");
            server
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "error": {"code": 4007, "message": "session not found"}
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("resume error");
        });
        assert!(
            resume_session(&mut client, "stale")
                .await
                .unwrap()
                .is_none()
        );
        server_task.await.unwrap();
    }

    #[test]
    fn session_not_found_detection_rejects_wrapped_errors() {
        for not_found in [
            json!({"error": {"code": 4007, "message": "session not found"}}),
            json!({"error": {"code": 4001, "message": "session not found"}}),
            json!({"error": {"message": "Session not found."}}),
            json!({"error": {"message": "4001: session not found"}}),
        ] {
            assert!(is_session_not_found_error(&not_found), "{not_found}");
        }
        for hidden in [
            json!({"error": {"code": 5000, "message": "resume failed: session not found"}}),
            json!({"error": {"code": 4001, "message": "resume failed: session not found"}}),
            json!({"error": {"code": 5030, "message": "session not found"}}),
        ] {
            assert!(!is_session_not_found_error(&hidden), "{hidden}");
        }
    }

    #[tokio::test]
    async fn resume_does_not_hide_transient_gateway_errors() {
        let (mut client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let request = next_text(&mut server).await;
            assert_eq!(request["method"], "session.resume");
            server
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "error": {"code": 5030, "message": "gateway temporarily unavailable"}
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("resume error");
        });
        let error = resume_session(&mut client, "stored")
            .await
            .expect_err("transient errors must not create a new session");
        assert_eq!(error.code, "E_HERMES_GATEWAY_STREAM");
        assert!(error.to_string().contains("temporarily unavailable"));
        server_task.await.unwrap();
    }

    fn ask(target: AskTarget, kind: AskKind, params: Value) -> PendingAsk {
        PendingAsk {
            summary: ask_summary(kind, &params),
            target,
            kind,
            turn_request_id: "turn-1".into(),
            deadline: Some(Instant::now() + APPROVAL_TIMEOUT),
        }
    }

    #[test]
    fn the_card_window_matches_the_runtime_deadline() {
        // An approval forwards its `approvals.timeout`; the card lives exactly as long as the agent
        // is willing to wait instead of denying on a client-side guess.
        assert_eq!(
            ask_window(AskKind::Approval, &json!({"timeout_s": 300}), None),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            ask_window(AskKind::Approval, &json!({"timeout_s": 45}), None),
            Some(Duration::from_secs(45))
        );
        // A long configured approvals.timeout is honored, not truncated to an hour.
        assert_eq!(
            ask_window(AskKind::Approval, &json!({"timeout_s": 7200}), None),
            Some(Duration::from_secs(7200))
        );
        // Only an absurd value is capped, so it cannot overflow an Instant.
        assert_eq!(
            ask_window(AskKind::Approval, &json!({"timeout_s": 999_999}), None),
            Some(MAX_ASK_WINDOW)
        );

        // The other prompt frames carry no `timeout_s`: mirror each method's own deadline so the
        // countdown does not vanish while the backend is still waiting.
        for (kind, window) in [
            (AskKind::Approval, APPROVAL_TIMEOUT),
            (AskKind::Clarify, CLARIFY_TIMEOUT),
            (AskKind::Sudo, CREDENTIAL_TIMEOUT),
            (AskKind::Secret, CREDENTIAL_TIMEOUT),
            (AskKind::VaultUnlock, CREDENTIAL_TIMEOUT),
            (AskKind::VaultSaveLogin, VAULT_FORM_TIMEOUT),
            (AskKind::VaultCode, VAULT_FORM_TIMEOUT),
        ] {
            assert_eq!(
                ask_window(kind, &json!({}), Some(CLARIFY_TIMEOUT)),
                Some(window),
                "{:?}",
                kind
            );
            assert_eq!(
                ask_window(kind, &json!({"timeout_s": 0}), Some(CLARIFY_TIMEOUT)),
                Some(window),
                "{:?}",
                kind
            );
        }

        // A configured clarify timeout drives the card; `<= 0` means the runtime never cancels.
        assert_eq!(
            ask_window(
                AskKind::Clarify,
                &json!({}),
                Some(Duration::from_secs(3600))
            ),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(ask_window(AskKind::Clarify, &json!({}), None), None);
    }

    #[test]
    fn clarify_timeout_follows_the_configured_value() {
        assert_eq!(clarify_timeout_from_config(None), Some(CLARIFY_TIMEOUT));
        assert_eq!(
            clarify_timeout_from_config(Some("agent:\n  clarify_timeout: 3600\n")),
            Some(Duration::from_secs(3600))
        );
        // A quoted / float value is still seconds.
        assert_eq!(
            clarify_timeout_from_config(Some("agent:\n  clarify_timeout: \"120\"\n")),
            Some(Duration::from_secs(120))
        );
        assert_eq!(
            clarify_timeout_from_config(Some("agent:\n  clarify_timeout: 120.0\n")),
            Some(Duration::from_secs(120))
        );
        // `<= 0` is the runtime's "wait forever".
        assert_eq!(
            clarify_timeout_from_config(Some("agent:\n  clarify_timeout: 0\n")),
            None
        );
        assert_eq!(
            clarify_timeout_from_config(Some("agent:\n  clarify_timeout: -1\n")),
            None
        );
        // Missing or malformed config keeps the schema default.
        assert_eq!(
            clarify_timeout_from_config(Some("agent: {}\n")),
            Some(CLARIFY_TIMEOUT)
        );

        // The legacy `clarify.timeout` wins when explicitly set, even over a numeric agent value.
        assert_eq!(
            clarify_timeout_from_config(Some(
                "clarify:\n  timeout: 3600\nagent:\n  clarify_timeout: 90\n"
            )),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(
            clarify_timeout_from_config(Some(
                "clarify:\n  timeout: 0\nagent:\n  clarify_timeout: 3600\n"
            )),
            None
        );
        // A non-numeric legacy value resolves to 90 instead of falling through to the agent value.
        assert_eq!(
            clarify_timeout_from_config(Some(
                "clarify:\n  timeout: never\nagent:\n  clarify_timeout: 3600\n"
            )),
            Some(CLARIFY_TIMEOUT)
        );
        assert_eq!(
            clarify_timeout_from_config(Some(":::")),
            Some(CLARIFY_TIMEOUT)
        );
    }

    #[test]
    fn remote_clarify_timeout_uses_the_same_precedence() {
        assert_eq!(
            clarify_timeout_from_value(&json!({"agent": {"clarify_timeout": 120}})),
            Some(Duration::from_secs(120))
        );
        assert_eq!(
            clarify_timeout_from_value(&json!({
                "clarify": {"timeout": "120"},
                "agent": {"clarify_timeout": 3600}
            })),
            Some(Duration::from_secs(120))
        );
        assert_eq!(
            clarify_timeout_from_value(&json!({
                "clarify": {"timeout": 0},
                "agent": {"clarify_timeout": 3600}
            })),
            None
        );
        assert_eq!(
            clarify_timeout_from_value(&json!({"clarify": {"timeout": null}})),
            Some(CLARIFY_TIMEOUT)
        );
        assert_eq!(
            clarify_timeout_from_value(&json!({})),
            Some(CLARIFY_TIMEOUT)
        );
    }

    /// A failed remote config read must not shorten the card: without the remote's window we give
    /// the card no local deadline and let `request.cancel` settle it.
    #[tokio::test]
    async fn a_remote_config_read_failure_leaves_the_window_to_the_backend() {
        let (mut client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let request = next_text(&mut server).await;
            assert_eq!(request["method"], "config.get");
            assert_eq!(request["params"]["key"], "full");
            server
                .send(Message::Text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "error": {"code": -32601, "message": "unknown key"}
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("reply");
        });
        assert_eq!(remote_clarify_timeout(&mut client, "live-1").await, None);
        server_task.await.unwrap();
    }

    #[test]
    fn every_card_kind_maps_to_the_methods_the_runtime_uses() {
        assert_eq!(AskKind::of("approval"), Some(AskKind::Approval));
        assert_eq!(AskKind::of("clarify"), Some(AskKind::Clarify));
        assert_eq!(AskKind::of("secret"), Some(AskKind::Secret));
        assert_eq!(AskKind::of("sudo"), Some(AskKind::Sudo));
        assert_eq!(
            AskKind::of("vault.unlock_prompt"),
            Some(AskKind::VaultUnlock)
        );
        assert_eq!(
            AskKind::of("vault.save_login"),
            Some(AskKind::VaultSaveLogin)
        );
        assert_eq!(AskKind::of("vault.code"), Some(AskKind::VaultCode));
        // Bridges need windows this build does not have; onboarding is not a normal chat turn.
        for method in ["preview.read", "tour", "setup_beat"] {
            assert_eq!(AskKind::of(method), None, "{method}");
        }
    }

    #[test]
    fn an_idle_session_info_is_not_the_running_generation() {
        let idle = json!({
            "type": "session.info",
            "execution_generation": 7,
            "payload": {"running": false, "execution_generation": 7}
        });
        assert_eq!(
            accepted_running_generation(None, "session.info", &idle),
            None
        );
        assert_eq!(
            accepted_running_generation(Some(7), "session.info", &idle),
            None
        );
        // A token frame is not a claim. The generation arrives on `message.start`.
        let delta = json!({
            "type": "message.delta",
            "execution_generation": 8,
            "payload": {"text": "x"}
        });
        assert_eq!(
            accepted_running_generation(Some(7), "message.delta", &delta),
            None
        );

        let start = json!({
            "type": "message.start",
            "execution_generation": 8,
            "payload": {"text": ""}
        });
        assert_eq!(
            accepted_running_generation(Some(7), "message.start", &start),
            Some(8)
        );
        assert_eq!(
            accepted_running_generation(Some(8), "message.start", &start),
            None,
            "the same stamp must not be published twice"
        );
        assert_eq!(
            accepted_running_generation(
                Some(8),
                "message.start",
                &json!({"execution_generation": 7, "payload": {}})
            ),
            None,
            "a replay must not rewind the floor"
        );

        let running = json!({
            "type": "session.info",
            "payload": {"running": true, "execution_generation": 9}
        });
        assert_eq!(
            accepted_running_generation(Some(8), "session.info", &running),
            Some(9)
        );
    }

    #[test]
    fn steer_carries_the_running_generation() {
        let params = steer_params("live-1", 7, "check the failing test");
        assert_eq!(
            params,
            json!({
                "session_id": "live-1",
                "text": "check the failing test",
                "execution_generation": 7
            })
        );
        assert_eq!(
            steer_result(json!({"status": "queued"})).expect("queued steer"),
            HermesSteerResult {
                status: HermesSteerStatus::Queued,
                delivered: None
            }
        );
        assert_eq!(
            steer_result(json!({"status": "redirected"})).expect("redirected steer"),
            HermesSteerResult {
                status: HermesSteerStatus::Redirected,
                delivered: None
            }
        );
        assert_eq!(
            steer_result(json!({"status": "rejected", "delivered": false}))
                .expect("an undelivered rejection reaches the UI"),
            HermesSteerResult {
                status: HermesSteerStatus::Rejected,
                delivered: Some(false)
            }
        );
        assert_eq!(
            steer_result(json!({"status": "rejected"})).expect("a delivered rejection is final"),
            HermesSteerResult {
                status: HermesSteerStatus::Rejected,
                delivered: None
            }
        );
        assert_eq!(
            steer_result(json!({"status": "unexpected"}))
                .expect_err("an unknown steer status must reach the UI")
                .code,
            "E_HERMES_STEER"
        );
    }

    #[test]
    fn redirect_carries_only_the_session_and_text() {
        assert_eq!(
            redirect_params("live-1", "use the API instead"),
            json!({"session_id": "live-1", "text": "use the API instead"})
        );
        assert_eq!(
            steer_result(json!({"status": "redirected"})).expect("redirected correction"),
            HermesSteerResult {
                status: HermesSteerStatus::Redirected,
                delivered: None
            }
        );
        assert_eq!(
            steer_result(json!({"status": "rejected"})).expect("an idle redirect reaches the UI"),
            HermesSteerResult {
                status: HermesSteerStatus::Rejected,
                delivered: None
            }
        );
    }

    #[tokio::test]
    async fn a_ping_only_gateway_still_runs_out_of_budget() {
        let (mut client, mut server) = ws_pair().await;
        // `hermes serve` pings every 20s. Skipping them keeps the socket alive, but each one used to
        // restart the per-frame timeout, so a gateway that only pinged could hold a turn open
        // forever; the stall budget has to be one deadline for the whole read.
        let pinger = tokio::spawn(async move {
            loop {
                if server.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
                sleep(Duration::from_millis(10)).await;
            }
        });
        let result = timeout(
            Duration::from_secs(5),
            next_frame(&mut client, Some(Duration::from_millis(120))),
        )
        .await
        .expect("the stall budget must expire despite the pings");
        pinger.abort();

        assert_eq!(
            result.expect_err("a stalled read has to time out").code,
            "E_HERMES_GATEWAY_TIMEOUT"
        );
    }

    #[tokio::test]
    async fn a_restart_close_is_not_shown_as_a_raw_status_code() {
        let (client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let request = next_text(&mut server).await;
            assert_eq!(request["method"], "model.options");
            server
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Restart,
                    reason: "".into(),
                })))
                .await
                .expect("close");
        });
        let error = model_options_over_socket(client, false, true, None)
            .await
            .expect_err("a restart close fails the read");
        assert_eq!(error.code, "E_HERMES_GATEWAY_RESTART");
        assert_eq!(error.detail, None);
        assert!(
            !error.to_string().contains("1012"),
            "the profile rail used to render the raw close code: {error}"
        );
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn an_ordinary_close_keeps_its_status_in_the_detail() {
        let (client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let _ = next_text(&mut server).await;
            server
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Normal,
                    reason: "bye".into(),
                })))
                .await
                .expect("close");
        });
        let error = model_options_over_socket(client, false, true, None)
            .await
            .expect_err("a normal close still fails the read");
        assert_eq!(error.code, "E_HERMES_GATEWAY_STREAM");
        assert_eq!(error.detail.as_deref(), Some("code 1000: bye"));
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn a_remote_catalog_read_does_not_reuse_its_ticket() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let connections = std::sync::Arc::new(AtomicUsize::new(0));
        let count = connections.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("first handshake");
            count.fetch_add(1, Ordering::SeqCst);
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("upgrade");
            let _ = next_text(&mut socket).await;
            socket
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Restart,
                    reason: "".into(),
                })))
                .await
                .expect("close");
            if timeout(Duration::from_millis(800), listener.accept())
                .await
                .is_ok()
            {
                count.fetch_add(1, Ordering::SeqCst);
            }
        });
        let error =
            model_options_remote_auth(&format!("ws://{addr}"), "ticket=once", None, false, true)
                .await
                .expect_err("the restart must reach the caller, which mints the next ticket");
        assert_eq!(error.code, "E_HERMES_GATEWAY_RESTART");
        server.await.unwrap();
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "reconnecting here would present the ticket the first handshake already consumed"
        );
    }

    #[tokio::test]
    async fn answers_a_server_request_by_its_srq_id() {
        let (mut client, mut server) = ws_pair().await;
        let open = ask(
            AskTarget::Request("srq-abc123".into()),
            AskKind::Approval,
            json!({"command": "rm -rf build"}),
        );
        let (result, settled) = answer_result(
            &open,
            HermesAskReply::Approval {
                choice: "session".into(),
            },
        );
        send_response(&mut client, &open.target, result, "live-1")
            .await
            .expect("answer");

        let frame = next_text(&mut server).await;
        assert_eq!(frame["id"], "srq-abc123");
        assert_eq!(frame["result"]["choice"], "session");
        assert!(frame.get("method").is_none());
        // The transcript note names the scope the user granted.
        assert_eq!(settled["outcome"], "allowed");
        assert_eq!(settled["scope"], "session");
        assert_eq!(settled["summary"], "rm -rf build");
    }

    #[tokio::test]
    async fn answers_an_event_approval_over_its_rpc() {
        let (mut client, mut server) = ws_pair().await;
        send_response(
            &mut client,
            &AskTarget::Event("approval-7".into()),
            json!({"choice": "deny"}),
            "live-1",
        )
        .await
        .expect("answer");
        let frame = next_text(&mut server).await;
        assert_eq!(frame["method"], "approval.respond");
        assert_eq!(frame["params"]["session_id"], "live-1");
        assert_eq!(frame["params"]["request_id"], "approval-7");
        assert_eq!(frame["params"]["choice"], "deny");
    }

    #[test]
    fn event_approvals_match_answers_and_cancellations() {
        let target = AskTarget::Event("approval-7".into());
        assert!(target.matches("approval-7"));
        assert!(!target.matches("approval-8"));
    }

    #[test]
    fn settled_notes_name_the_turn_that_asked() {
        let card = ask(
            AskTarget::Request("srq-abc123".into()),
            AskKind::Approval,
            json!({"command": "rm -rf build"}),
        );
        let settled = settled_note(&card, "allowed", Some("once"), None);
        assert_eq!(settled["requestId"], "srq-abc123");
        assert_eq!(settled["turnRequestId"], "turn-1");
    }

    #[tokio::test]
    async fn clarify_answers_travel_as_one_answers_map() {
        let (mut client, mut server) = ws_pair().await;
        let open = ask(
            AskTarget::Request("srq-clarify".into()),
            AskKind::Clarify,
            json!({"questions": [
                {"qid": "q1", "question": "Which database?"},
                {"qid": "q2", "question": "Which region?", "choices": ["eu", "us"]}
            ]}),
        );
        let (result, settled) = answer_result(
            &open,
            HermesAskReply::Clarify {
                answers: vec![
                    HermesClarifyAnswer {
                        qid: "q1".into(),
                        answer: Some("postgres".into()),
                    },
                    HermesClarifyAnswer {
                        qid: "q2".into(),
                        answer: None,
                    },
                ],
                cancelled: false,
            },
        );
        send_response(&mut client, &open.target, result, "live-1")
            .await
            .expect("answer");

        let frame = next_text(&mut server).await;
        assert_eq!(frame["result"]["answers"]["q1"], "postgres");
        // A skipped question is `null`, which is what the clarify tool reads as "not answered".
        assert!(frame["result"]["answers"]["q2"].is_null());
        assert_eq!(settled["outcome"], "submitted");
        assert_eq!(settled["count"], 1);
    }

    #[tokio::test]
    async fn a_dismissed_clarify_cancels_instead_of_answering() {
        let open = ask(
            AskTarget::Request("srq-clarify".into()),
            AskKind::Clarify,
            json!({"questions": [{"qid": "q1", "question": "Which database?"}]}),
        );
        let (result, settled) = answer_result(
            &open,
            HermesAskReply::Clarify {
                answers: Vec::new(),
                cancelled: true,
            },
        );
        assert_eq!(result, json!({}));
        assert_eq!(settled["outcome"], "cancelled");
    }

    #[tokio::test]
    async fn a_secret_prompt_answers_a_masked_value() {
        let (mut client, mut server) = ws_pair().await;
        let open = ask(
            AskTarget::Request("srq-secret".into()),
            AskKind::Secret,
            json!({"env_var": "OPENAI_API_KEY", "prompt": "Paste the key"}),
        );
        let (result, settled) = answer_result(
            &open,
            HermesAskReply::Secret {
                value: "sk-test".into(),
            },
        );
        send_response(&mut client, &open.target, result, "live-1")
            .await
            .expect("answer");
        assert_eq!(next_text(&mut server).await["result"]["value"], "sk-test");
        assert_eq!(settled["outcome"], "submitted");
        // The note names the variable, never the secret itself.
        assert_eq!(settled["summary"], "OPENAI_API_KEY");
        assert!(!settled.to_string().contains("sk-test"));

        let skipped = ask(
            AskTarget::Request("srq-secret-2".into()),
            AskKind::Secret,
            json!({"env_var": "OPENAI_API_KEY"}),
        );
        let (result, settled) = answer_result(
            &skipped,
            HermesAskReply::Secret {
                value: String::new(),
            },
        );
        assert_eq!(result, json!({"value": ""}));
        assert_eq!(settled["outcome"], "skipped");
    }

    #[tokio::test]
    async fn every_single_value_prompt_answers_its_value() {
        let (mut client, mut server) = ws_pair().await;
        for (kind, params, answer, summary) in [
            (
                AskKind::Sudo,
                json!({"command": "sudo brew install ripgrep"}),
                "hunter2",
                "sudo brew install ripgrep",
            ),
            (
                AskKind::VaultUnlock,
                json!({"backend": "1password", "display_name": "1Password"}),
                "master-password",
                "1Password",
            ),
            (
                AskKind::VaultCode,
                json!({"site": "example.com", "hint": "Authenticator"}),
                "123456",
                "example.com",
            ),
        ] {
            let open = ask(
                AskTarget::Request(format!("srq-{}", kind.wire())),
                kind,
                params,
            );
            let (result, settled) = answer_result(
                &open,
                HermesAskReply::Secret {
                    value: answer.into(),
                },
            );
            send_response(&mut client, &open.target, result, "live-1")
                .await
                .expect("answer");
            assert_eq!(
                next_text(&mut server).await["result"]["value"],
                answer,
                "{}",
                kind.wire()
            );
            assert_eq!(settled["kind"], kind.wire());
            assert_eq!(settled["outcome"], "submitted");
            assert_eq!(settled["summary"], summary);
            assert!(!settled.to_string().contains(answer));
        }
    }

    #[tokio::test]
    async fn vault_save_login_answers_a_json_credential() {
        let (mut client, mut server) = ws_pair().await;
        let open = ask(
            AskTarget::Request("srq-vault-save".into()),
            AskKind::VaultSaveLogin,
            json!({"origin": "https://example.com", "site": "example.com"}),
        );
        let (result, settled) = answer_result(
            &open,
            HermesAskReply::VaultSaveLogin {
                identifier: "  user@example.com  ".into(),
                password: "hunter2".into(),
            },
        );
        send_response(&mut client, &open.target, result, "live-1")
            .await
            .expect("answer");

        let frame = next_text(&mut server).await;
        let value = frame["result"]["value"]
            .as_str()
            .expect("the runtime reads a JSON string under value");
        assert_eq!(
            value,
            r#"{"identifier":"user@example.com","password":"hunter2"}"#
        );
        assert_eq!(settled["outcome"], "submitted");
        assert_eq!(settled["summary"], "example.com");
        assert!(!settled.to_string().contains("hunter2"));

        // No password means the user declined to save: answer "" instead of a credential blob.
        let skipped = ask(
            AskTarget::Request("srq-vault-save-2".into()),
            AskKind::VaultSaveLogin,
            json!({"origin": "https://example.com", "site": "example.com"}),
        );
        let (result, settled) = answer_result(
            &skipped,
            HermesAskReply::VaultSaveLogin {
                identifier: "user@example.com".into(),
                password: String::new(),
            },
        );
        assert_eq!(result, json!({"value": ""}));
        assert_eq!(settled["outcome"], "skipped");
    }

    /// A bridge tool gets the renderer's "no window shows this chat" decline; anything else says
    /// "no handler". Either way the request settles at once instead of parking the agent.
    #[tokio::test]
    async fn requests_this_build_cannot_serve_are_refused_fast() {
        let (mut client, mut server) = ws_pair().await;
        refuse_request(&mut client, "srq-preview", "preview.read")
            .await
            .expect("refuse");
        let frame = next_text(&mut server).await;
        assert_eq!(frame["error"]["code"], NOT_SHOWN_CODE);

        refuse_request(&mut client, "srq-setup", "setup_beat")
            .await
            .expect("refuse");
        let frame = next_text(&mut server).await;
        assert_eq!(frame["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn the_turn_policy_decides_approvals_without_a_card() {
        let (mut client, mut server) = ws_pair().await;
        // Full control: approve silently, no card and no transcript note.
        let silent = open_ask(
            &mut client,
            None,
            AskTarget::Request("srq-a".into()),
            AskKind::Approval,
            json!({"command": "rm -rf build"}),
            &AskPolicy {
                ask_user: false,
                full_control: true,
                clarify_timeout: Some(CLARIFY_TIMEOUT),
            },
            "live-1",
            "turn-1",
            false,
        )
        .await
        .expect("open");
        assert!(silent.is_none());
        assert_eq!(next_text(&mut server).await["result"]["choice"], "once");

        // Confirmed writes reach the user instead of being decided here.
        let card = open_ask(
            &mut client,
            None,
            AskTarget::Request("srq-b".into()),
            AskKind::Approval,
            json!({"command": "rm -rf build"}),
            &AskPolicy {
                ask_user: true,
                full_control: false,
                clarify_timeout: Some(CLARIFY_TIMEOUT),
            },
            "live-1",
            "turn-1",
            false,
        )
        .await
        .expect("open");
        assert!(card.is_some());
    }

    /// A card can stay open past `MESSAGE_TIMEOUT`. Answering it must not charge the agent for that
    /// wait: the stall budget starts when the card settles, not when the turn did.
    #[tokio::test(start_paused = true)]
    async fn answering_a_card_after_the_stall_budget_keeps_the_turn_alive() {
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("hermes-stall-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (client, mut server) = ws_pair().await;
        let input = HermesChatInput {
            prompt: "hi".into(),
            request_id: "req-1".into(),
            session_id: None,
            provider: "custom".into(),
            model: "m".into(),
            effort: "low".into(),
            fast: false,
            api_key: None,
            endpoint: None,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            mac_enabled: true,
            control_level: "ask".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: false,
            confirm_writes: true,
        };
        let policy = AskPolicy {
            ask_user: true,
            full_control: false,
            clarify_timeout: Some(CLARIFY_TIMEOUT),
        };
        let state = Arc::new(HermesRuntimeState::default());
        let task_state = state.clone();
        let task_dir = dir.clone();
        let task = tokio::spawn(async move {
            let mut client = client;
            stream_turn(
                &mut client,
                &task_dir,
                &task_state,
                &input,
                None,
                None,
                "live-1",
                "stored-1",
                policy,
                Vec::new(),
                None,
            )
            .await
        });

        let opened = state.ask_opened.notified();
        tokio::pin!(opened);
        opened.as_mut().enable();
        server
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0",
                    "id": "srq-1",
                    "method": "approval",
                    "params": {"command": "rm -rf build", "choices": ["once", "deny"]}
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("ask");
        // Wait until the read loop has actually parked on the card before moving the clock.
        opened.await;
        // Well past the 180s stall budget, still inside the approval's 300s window.
        tokio::time::advance(Duration::from_secs(200)).await;

        let answers = state.asks.lock().await.clone().expect("a live turn");
        answers
            .send(AskAnswer {
                request_id: "srq-1".into(),
                reply: HermesAskReply::Approval {
                    choice: "once".into(),
                },
            })
            .expect("answer");
        server
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0",
                    "method": "event",
                    "params": {"type": "message.complete", "payload": {"text": "done"}}
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("complete");
        let reply = task
            .await
            .expect("turn task")
            .expect("the answered card must not time the turn out");
        assert_eq!(reply.text, "done");
        let response = next_text(&mut server).await;
        assert_eq!(response["id"], "srq-1");
        assert_eq!(response["result"]["choice"], "once");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A clarify question or a credential prompt is not a policy decision: it reaches the user even in
    /// full-control mode.
    #[tokio::test]
    async fn clarify_and_prompt_cards_ignore_the_approval_policy() {
        let (mut client, _server) = ws_pair().await;
        for (kind, params) in [
            (
                AskKind::Clarify,
                json!({"questions": [{"qid": "q1", "question": "Which database?"}]}),
            ),
            (
                AskKind::Sudo,
                json!({"command": "sudo brew install ripgrep"}),
            ),
            (AskKind::Secret, json!({"env_var": "TOKEN"})),
            (
                AskKind::VaultUnlock,
                json!({"backend": "1password", "display_name": "1Password"}),
            ),
            (
                AskKind::VaultSaveLogin,
                json!({"origin": "https://example.com", "site": "example.com"}),
            ),
            (AskKind::VaultCode, json!({"site": "example.com"})),
        ] {
            let card = open_ask(
                &mut client,
                None,
                AskTarget::Request(format!("srq-{}", kind.wire())),
                kind,
                params,
                &AskPolicy {
                    ask_user: false,
                    full_control: true,
                    clarify_timeout: Some(CLARIFY_TIMEOUT),
                },
                "live-1",
                "turn-1",
                false,
            )
            .await
            .expect("open");
            assert!(card.is_some(), "{} must reach the user", kind.wire());
        }
    }

    /// `hermes serve` pings every 20s (uvicorn's default `ws_ping_interval`); the runtime used to
    /// fail the whole turn with "unexpected frame" when that first ping landed mid-stream.
    #[tokio::test]
    async fn skips_transport_control_frames() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("handshake");
            socket
                .send(Message::Ping(vec![1, 2].into()))
                .await
                .expect("ping");
            socket
                .send(Message::Pong(vec![3].into()))
                .await
                .expect("pong");
            socket
                .send(Message::Text(
                    json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}})
                        .to_string()
                        .into(),
                ))
                .await
                .expect("result");
            // Drain the client's automatic pong so its read path flushes the reply.
            let _ = socket.next().await;
        });
        let (mut socket, _) = connect_async(format!("ws://{addr}/api/ws"))
            .await
            .expect("connect");
        let value = recv_json(&mut socket)
            .await
            .expect("control frames keep the stream alive");
        assert_eq!(value["result"]["ok"], true);
        server.abort();
    }

    #[test]
    fn login_path_normalizes_to_the_ws_endpoint() {
        assert_eq!(
            remote_ws_url_auth("http://panel.tail1234.ts.net:9119/login", "ticket=abc").unwrap(),
            "ws://panel.tail1234.ts.net:9119/api/ws?ticket=abc"
        );
    }

    #[test]
    fn keeps_a_panel_prefix_when_building_the_ws_endpoint() {
        assert_eq!(
            remote_ws_url_auth("https://host/hermes", "ticket=abc").unwrap(),
            "wss://host/hermes/api/ws?ticket=abc"
        );
        assert_eq!(
            remote_ws_url_auth("https://host/hermes/", "ticket=abc").unwrap(),
            "wss://host/hermes/api/ws?ticket=abc"
        );
        assert_eq!(
            remote_ws_url_auth("https://host/hermes/api/ws", "ticket=abc").unwrap(),
            "wss://host/hermes/api/ws?ticket=abc"
        );
        assert_eq!(
            remote_ws_url_auth("https://host/hermes/login", "ticket=abc").unwrap(),
            "wss://host/hermes/api/ws?ticket=abc"
        );
    }

    #[tokio::test]
    #[ignore = "requires HERMES_RUNTIME_BIN, HERMES_TEST_ENDPOINT, HERMES_TEST_API_KEY and HERMES_TEST_MODEL"]
    async fn gateway_resumes_a_stored_session() {
        let bin = std::env::var("HERMES_RUNTIME_BIN").expect("HERMES_RUNTIME_BIN");
        let endpoint = std::env::var("HERMES_TEST_ENDPOINT").expect("HERMES_TEST_ENDPOINT");
        let key = std::env::var("HERMES_TEST_API_KEY").expect("HERMES_TEST_API_KEY");
        let model = std::env::var("HERMES_TEST_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
        let provider = std::env::var("HERMES_TEST_PROVIDER").unwrap_or_else(|_| "openai".into());
        let dir = tempfile::tempdir().unwrap();
        let input = HermesChatInput {
            prompt: "The secret word is ORBITAL. Remember it and reply with OK.".into(),
            request_id: "gateway-resume-1".into(),
            session_id: None,
            provider: provider.clone(),
            model: model.clone(),
            effort: "low".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            api_key: Some(key.clone()),
            endpoint: Some(endpoint.clone()),
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let first = chat_for_test(Path::new(&bin), dir.path(), input, tx)
            .await
            .unwrap();
        let stored = first.session_id.expect("stored session id");
        let second = HermesChatInput {
            prompt: "What was the secret word? Reply with only the word.".into(),
            request_id: "gateway-resume-2".into(),
            session_id: Some(stored),
            provider: provider.clone(),
            model,
            effort: "low".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            api_key: Some(key),
            endpoint: Some(endpoint),
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
        let reply = chat_for_test(Path::new(&bin), dir.path(), second, tx2)
            .await
            .unwrap();
        assert!(
            reply.text.to_uppercase().contains("ORBITAL"),
            "resume lost context: {}",
            reply.text
        );
    }

    #[tokio::test]
    #[ignore = "requires HERMES_RUNTIME_BIN, HERMES_TEST_ENDPOINT, HERMES_TEST_API_KEY and HERMES_TEST_MODEL"]
    async fn gateway_attaches_a_text_file() {
        let bin = std::env::var("HERMES_RUNTIME_BIN").expect("HERMES_RUNTIME_BIN");
        let endpoint = std::env::var("HERMES_TEST_ENDPOINT").expect("HERMES_TEST_ENDPOINT");
        let key = std::env::var("HERMES_TEST_API_KEY").expect("HERMES_TEST_API_KEY");
        let model = std::env::var("HERMES_TEST_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
        let provider = std::env::var("HERMES_TEST_PROVIDER").unwrap_or_else(|_| "openai".into());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("attachment.txt");
        std::fs::write(&file, "HERMES_ATTACHMENT_OK").unwrap();
        let input = HermesChatInput {
            prompt: "Read the attached file and reply with exactly its contents.".into(),
            request_id: "gateway-attachment-test".into(),
            session_id: None,
            provider,
            model,
            effort: "low".into(),
            fast: false,
            cwd: None,
            attachments: vec![file.display().to_string()],
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: None,
            panel_auth: false,
            api_key: Some(key),
            endpoint: Some(endpoint),
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let reply = chat_for_test(Path::new(&bin), dir.path(), input, tx)
            .await
            .unwrap();
        assert!(
            reply.text.contains("HERMES_ATTACHMENT_OK"),
            "attachment not read: {}",
            reply.text
        );
    }

    #[tokio::test]
    #[ignore = "requires HERMES_RUNTIME_BIN, HERMES_TEST_ENDPOINT, HERMES_TEST_API_KEY and HERMES_TEST_MODEL"]
    async fn gateway_terminal_control_runs_on_the_mac() {
        let bin = std::env::var("HERMES_RUNTIME_BIN").expect("HERMES_RUNTIME_BIN");
        let endpoint = std::env::var("HERMES_TEST_ENDPOINT").expect("HERMES_TEST_ENDPOINT");
        let key = std::env::var("HERMES_TEST_API_KEY").expect("HERMES_TEST_API_KEY");
        let model = std::env::var("HERMES_TEST_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
        let provider = std::env::var("HERMES_TEST_PROVIDER").unwrap_or_else(|_| "openai".into());
        let dir = tempfile::tempdir().unwrap();
        let input = HermesChatInput {
            prompt: "Use the terminal tool to run exactly: echo HERMES_TERMINAL_OK. Then tell me the output.".into(),
            request_id: "gateway-terminal-test".into(),
            session_id: None,
            provider: provider.clone(),
            model,
            effort: "low".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
        profile: None,
        panel_auth: false,
            api_key: Some(key),
            endpoint: Some(endpoint),
            mac_enabled: true,
            control_level: "full".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let reply = chat_for_test(Path::new(&bin), dir.path(), input, tx)
            .await
            .unwrap();
        assert!(
            reply.text.contains("HERMES_TERMINAL_OK"),
            "terminal output missing: {}",
            reply.text
        );
    }

    #[tokio::test]
    #[ignore = "requires HERMES_RUNTIME_BIN"]
    async fn loads_the_official_model_catalog() {
        let bin = std::env::var("HERMES_RUNTIME_BIN").expect("HERMES_RUNTIME_BIN");
        let dir = tempfile::tempdir().unwrap();
        let input = HermesChatInput {
            prompt: String::new(),
            request_id: "model-options-test".into(),
            session_id: None,
            provider: "copilot".into(),
            model: "gpt-5.4".into(),
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
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        let state = HermesRuntimeState::default();
        let options = model_options(Path::new(&bin), dir.path(), &state, input, true, true)
            .await
            .unwrap();
        assert!(!options.providers.is_empty());
        assert!(
            options
                .providers
                .iter()
                .any(|provider| !provider.slug.is_empty())
        );
    }

    #[tokio::test]
    #[ignore = "requires HERMES_RUNTIME_BIN, HERMES_TEST_ENDPOINT, HERMES_TEST_API_KEY and HERMES_TEST_MODEL"]
    async fn streams_real_hermes_gateway_chunks() {
        let bin = std::env::var("HERMES_RUNTIME_BIN").expect("HERMES_RUNTIME_BIN");
        let endpoint = std::env::var("HERMES_TEST_ENDPOINT").expect("HERMES_TEST_ENDPOINT");
        let key = std::env::var("HERMES_TEST_API_KEY").expect("HERMES_TEST_API_KEY");
        let model = std::env::var("HERMES_TEST_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
        let provider = std::env::var("HERMES_TEST_PROVIDER").unwrap_or_else(|_| "openai".into());
        let dir = tempfile::tempdir().unwrap();
        let input = HermesChatInput {
            prompt: "Write a 60-word plain-text explanation of why the sky is blue. Do not use markdown.".into(),
            request_id: "gateway-stream-test".into(),
            session_id: None,
            provider: provider.clone(),
            model,
            effort: "low".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
        profile: None,
        panel_auth: false,
            api_key: Some(key),
            endpoint: Some(endpoint),
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: true,
            mac_screen: true,
            mac_files: true,
            mac_cron: true,
            confirm_writes: false,
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let reply = chat_for_test(Path::new(&bin), dir.path(), input, tx)
            .await
            .unwrap();
        let mut chunks = Vec::new();
        while let Some(delta) = rx.recv().await {
            chunks.push(delta);
        }
        assert!(chunks.len() > 2, "expected gateway deltas, got {chunks:?}");
        assert!(!reply.text.trim().is_empty());
        assert!(reply.session_id.is_some());
    }

    /// A fake runtime with the layout `runtime_command` expects: the interpreter is a shell
    /// script that records its arguments and reacts like the real `hermes serve`.
    #[cfg(unix)]
    fn fake_gateway_runtime(dir: &Path, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let bin = dir.join("bin").join("hermes");
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("python").join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("site")).unwrap();
        std::fs::write(&bin, "#!/bin/sh\nexit 1\n").unwrap();
        let python = dir.join("python").join("bin").join("python3");
        std::fs::write(&python, script).unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[cfg(unix)]
    fn gateway_input(profile: Option<&str>) -> HermesChatInput {
        HermesChatInput {
            prompt: String::new(),
            request_id: "gateway-start-test".into(),
            session_id: None,
            provider: "custom".into(),
            model: "m".into(),
            effort: "low".into(),
            fast: false,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: None,
            profile_id: None,
            profile: profile.map(str::to_owned),
            panel_auth: false,
            api_key: None,
            endpoint: None,
            mac_enabled: false,
            control_level: "open".into(),
            mac_terminal: false,
            mac_screen: false,
            mac_files: false,
            mac_cron: false,
            confirm_writes: false,
        }
    }

    /// The exit status is the only evidence the error may lean on: 78 is emitted for more than
    /// one runtime refusal, so the detail names the status and never a guessed cause. The log
    /// location appears only when that file exists.
    #[cfg(unix)]
    #[test]
    fn startup_exit_detail_names_the_actual_status_without_a_cause() {
        use std::os::unix::process::ExitStatusExt;

        let dir = tempfile::tempdir().unwrap();
        let detail = |status| gateway_exit_error(status, dir.path()).detail.unwrap();
        let exit = |code: i32| std::process::ExitStatus::from_raw(code << 8);

        let refused = detail(exit(78));
        assert!(refused.contains("exited during startup"), "{refused}");
        assert!(refused.contains("exit status: 78"), "{refused}");
        assert!(
            !refused.contains("backend"),
            "the detail must not name a cause the status cannot prove: {refused}"
        );
        assert!(
            !refused.contains("See"),
            "a missing log file must not be named: {refused}"
        );
        assert!(detail(exit(0)).contains("exit status: 0"));
        assert!(detail(std::process::ExitStatus::from_raw(15)).contains("signal: 15"));

        std::fs::create_dir_all(dir.path().join("logs")).unwrap();
        std::fs::write(dir.path().join("logs").join("gui.log"), "").unwrap();
        assert!(detail(exit(78)).contains("logs/gui.log"));
    }

    /// The app-owned backend must opt out of the host singleton, and the child's stderr — which
    /// here carries the live dashboard session token — must not reach the error the UI renders.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_refusing_gateway_keeps_its_token_out_of_the_error() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_gateway_runtime(
            dir.path(),
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\n\
             printf '%s' \"$HERMES_DASHBOARD_SESSION_TOKEN\" > \"$0.token\"\n\
             printf 'token=%s key=sk-test-DO-NOT-LEAK\\n' \"$HERMES_DASHBOARD_SESSION_TOKEN\" >&2\n\
             exit 78\n",
        );
        let state = HermesRuntimeState::default();
        let input = gateway_input(None);
        let started = Instant::now();
        let error = match ensure_server(&bin, dir.path(), &state, &input, None).await {
            Ok(_) => panic!("the refusing gateway must not be reported as ready"),
            Err(error) => error,
        };
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "startup waited {:?} instead of failing fast",
            started.elapsed()
        );
        assert_eq!(error.code, "E_HERMES_GATEWAY");
        let detail = error.detail.clone().unwrap_or_default();
        assert!(
            detail.contains("exited during startup") && detail.contains("exit status: 78"),
            "the startup exit and its status are missing from {detail:?}"
        );
        assert!(
            !detail.contains("See"),
            "no log file exists yet, so none must be named: {detail:?}"
        );
        let token =
            std::fs::read_to_string(dir.path().join("python").join("bin").join("python3.token"))
                .unwrap();
        assert!(
            !token.trim().is_empty(),
            "the child never saw its dashboard session token"
        );
        let rendered = format!("{}{}", error.message, detail);
        assert!(
            !rendered.contains(token.trim()),
            "the dashboard session token leaked into the error: {rendered}"
        );
        assert!(
            !rendered.contains("sk-test-DO-NOT-LEAK"),
            "stderr leaked: {rendered}"
        );
        let args =
            std::fs::read_to_string(dir.path().join("python").join("bin").join("python3.args"))
                .unwrap();
        assert!(
            args.lines().any(|line| line == "--isolated"),
            "the default profile must also opt out of the host singleton: {args}"
        );
        assert!(
            args.lines().any(|line| line == "default"),
            "the profile flag is missing: {args}"
        );
    }

    /// Any startup exit keeps the real status, says it happened during startup, and withholds
    /// the stderr that may contain credentials.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_exiting_gateway_reports_the_status_without_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_gateway_runtime(
            dir.path(),
            "#!/bin/sh\necho 'fatal: provider key sk-test-DO-NOT-LEAK rejected' >&2\nexit 3\n",
        );
        let state = HermesRuntimeState::default();
        let input = gateway_input(None);
        let error = match ensure_server(&bin, dir.path(), &state, &input, None).await {
            Ok(_) => panic!("the exited gateway must not be reported as ready"),
            Err(error) => error,
        };
        assert_eq!(error.code, "E_HERMES_GATEWAY");
        let detail = error.detail.unwrap_or_default();
        assert!(
            detail.contains("exited during startup"),
            "the detail must say the exit happened during startup: {detail:?}"
        );
        assert!(
            detail.contains("exit status: 3"),
            "the exit status is missing from {detail:?}"
        );
        assert!(
            !detail.contains("sk-test-DO-NOT-LEAK"),
            "stderr leaked: {detail}"
        );
    }

    #[cfg(unix)]
    fn process_alive(pid: i32) -> bool {
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid),
            None::<nix::sys::signal::Signal>,
        )
        .is_ok()
    }

    #[cfg(unix)]
    async fn wait_until_gone(pid: i32) -> bool {
        for _ in 0..100 {
            if !process_alive(pid) {
                return true;
            }
            sleep(Duration::from_millis(20)).await;
        }
        false
    }

    /// SIGKILLs a test child on failure, so the SIGTERM-ignoring fixture cannot outlive the
    /// test. It only signals a process that is still alive, and the caller disarms it once the
    /// child is confirmed gone, so a recycled pid is never targeted.
    #[cfg(unix)]
    struct TestChildGuard(Option<i32>);

    #[cfg(unix)]
    impl Drop for TestChildGuard {
        fn drop(&mut self) {
            if let Some(pid) = self.0
                && process_alive(pid)
            {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
        }
    }

    /// Aborting a start (window closed, superseded request) must stop the child the future was
    /// waiting for, even when the child ignores SIGTERM — a SIGTERM-only guard would pass a
    /// plain `sleep` fixture, so this one sets `SIG_IGN` before `exec`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_start_kills_a_gateway_that_ignores_sigterm() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_gateway_runtime(
            dir.path(),
            // An ignored disposition survives `exec` (a trapped handler would reset to the
            // default), so the long sleep itself keeps ignoring SIGTERM.
            "#!/bin/sh\ntrap '' TERM\nprintf '%s' \"$$\" > \"$0.pid\"\nexec sleep 30\n",
        );
        let home = dir.path().to_path_buf();
        let state = HermesRuntimeState::default();
        let input = gateway_input(None);
        let task = tokio::spawn(async move {
            let _ = ensure_server(&bin, &home, &state, &input, None).await;
        });
        let pid_file = dir.path().join("python").join("bin").join("python3.pid");
        let mut pid = None;
        for _ in 0..150 {
            if let Some(text) = std::fs::read_to_string(&pid_file).ok()
                && let Ok(value) = text.trim().parse::<i32>()
            {
                pid = Some(value);
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        let pid = pid.expect("the fake gateway never started");
        let mut cleanup = TestChildGuard(Some(pid));
        // Prove the fixture's inherited SIG_IGN: the startup guard's SIGTERM could not stop
        // this child, so only the SIGKILL cleanup can.
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGTERM,
        );
        sleep(Duration::from_millis(100)).await;
        assert!(process_alive(pid), "the fixture must ignore SIGTERM");

        task.abort();
        let _ = task.await;
        let gone = wait_until_gone(pid).await;
        if gone {
            cleanup.0 = None;
        }
        assert!(gone, "the cancelled start left gateway pid {pid} running");
    }

    /// A normal handoff must not trigger the startup kill, and the server must keep stopping a
    /// running gateway with its existing SIGTERM lifecycle.
    #[cfg(unix)]
    #[tokio::test]
    async fn handing_the_child_off_keeps_the_server_lifecycle() {
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id().unwrap() as i32;
        let mut starting = StartingGateway { child: Some(child) };
        let child = starting.take().expect("the child");
        drop(starting);
        assert!(
            process_alive(pid),
            "the startup guard killed a handed-off child"
        );

        let server = GatewayServer {
            port: 0,
            token: String::new(),
            fingerprint: String::new(),
            pid: pid as u32,
            _child: child,
        };
        server.stop();
        drop(server);
        assert!(
            wait_until_gone(pid).await,
            "the handed-off gateway was not stopped"
        );
    }
}
