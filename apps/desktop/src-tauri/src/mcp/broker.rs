//! App-side Unix socket broker for Local MCP.
//!
//! The broker is installed during Tauri setup and only binds when the persisted
//! master switch is on. Turning the switch off stops the accept loop, removes
//! the socket immediately, shuts down every live connection and clears the
//! per-connection session set. Broker failures are returned to Settings but
//! never block app startup.
//!
//! The internal protocol is newline-delimited JSON:
//! `{"v":1,"id":"...","method":"tools/call","params":{...}}` and
//! `{"v":1,"id":"...","ok":true,"result":...}` or `ok:false,error`.

use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead, BufReader, ErrorKind, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde::Serialize;
use serde_json::{Value, json};

use super::{
    socket, state,
    tools::{ToolError, ToolHost},
};

/// Maximum accepted internal request line.
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// Maximum internal response line.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// At most eight concurrent clients.
pub const MAX_CONNECTIONS: usize = 8;
/// Internal protocol version.
pub const RPC_VERSION: u64 = 1;
/// Accept polling interval; keeps shutdown responsive without a self-pipe.
const ACCEPT_POLL: Duration = Duration::from_millis(20);

/// Broker status surfaced by `mcp_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub socket_path: Option<String>,
    pub error: Option<String>,
}

/// Broker operation failure with a stable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerError {
    pub code: &'static str,
    pub message: String,
}

impl BrokerError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(error: io::Error) -> Self {
        Self::new("E_MCP_BROKER", error.to_string())
    }
}

impl std::fmt::Display for BrokerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BrokerError {}

#[derive(Default)]
struct Inner {
    enabled: bool,
    running: bool,
    path: Option<PathBuf>,
    error: Option<String>,
    stop: Option<Arc<AtomicBool>>,
    thread: Option<JoinHandle<()>>,
    connections: HashMap<u64, UnixStream>,
    sessions: HashSet<u64>,
    /// Never reset, so ids stay unique across disable/enable cycles.
    next_connection: u64,
    /// Identity of the socket file this broker published.
    socket_id: Option<socket::SocketId>,
}

/// Shared broker handle. Tauri manages `Arc<Broker>`.
pub struct Broker {
    data_dir: PathBuf,
    host: Option<Arc<dyn ToolHost>>,
    inner: Mutex<Inner>,
    /// Serializes whole switch transitions (bind/persist/stop), so runtime
    /// state and the persisted switch cannot diverge under concurrent toggles.
    lifecycle: Mutex<()>,
}

impl Broker {
    /// Broker without tools, used by socket-only tests and diagnostics.
    pub fn new(data_dir: PathBuf) -> Self {
        Self::with_host(data_dir, None)
    }

    /// Broker with the app-side read-tool implementation.
    pub fn with_host(data_dir: PathBuf, host: Option<Arc<dyn ToolHost>>) -> Self {
        let enabled = state::load(&data_dir).enabled;
        Self {
            data_dir,
            host,
            inner: Mutex::new(Inner {
                enabled,
                ..Inner::default()
            }),
            lifecycle: Mutex::new(()),
        }
    }

    /// Current status for Settings and diagnostics.
    pub fn status(&self) -> McpStatus {
        let inner = self.lock();
        McpStatus {
            enabled: inner.enabled,
            running: inner.running,
            socket_path: inner
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            error: inner.error.clone(),
        }
    }

    /// Bind at startup iff the persisted switch is on.
    pub fn start_if_enabled(self: &Arc<Self>) -> Result<(), BrokerError> {
        let _transition = self.transition();
        if self.status().enabled {
            self.enable()
        } else {
            // The switch is off: never create or accept on a socket. A socket
            // left by a crashed previous run is safe to clean only when stale,
            // owned by this user and still a socket.
            if let Err(error) = socket::remove_stale(&self.data_dir) {
                log::warn!("Local MCP stale socket cleanup failed: {error}");
            }
            Ok(())
        }
    }

    /// Apply the master switch immediately and persist it.
    pub fn set_enabled(self: &Arc<Self>, enabled: bool) -> Result<(), BrokerError> {
        let _transition = self.transition();
        if enabled {
            self.enable()
        } else {
            self.disable()
        }
    }

    fn enable(self: &Arc<Self>) -> Result<(), BrokerError> {
        let mut inner = self.lock();
        if inner.running {
            inner.enabled = true;
            inner.error = None;
            return state::save(&self.data_dir, true).map_err(BrokerError::io);
        }
        let previous_enabled = inner.enabled;

        let resolved = socket::prepare(&self.data_dir).map_err(|error| {
            let failure = BrokerError::io(error);
            inner.error = Some(failure.to_string());
            failure
        })?;
        let (listener, socket_id) = socket::bind_owned(&resolved).map_err(|error| {
            let failure = BrokerError::io(error);
            inner.error = Some(failure.to_string());
            failure
        })?;

        if let Err(error) = state::save(&self.data_dir, true) {
            drop(listener);
            socket::remove_if_same(&self.data_dir, socket_id);
            let failure = BrokerError::io(error);
            inner.error = Some(failure.to_string());
            return Err(failure);
        }

        let stop = Arc::new(AtomicBool::new(false));
        inner.enabled = true;
        inner.running = true;
        inner.path = Some(resolved.path);
        inner.error = None;
        inner.stop = Some(stop.clone());
        inner.socket_id = Some(socket_id);

        let weak = Arc::downgrade(self);
        let stop_thread = stop.clone();
        let host = self.host.clone();
        match thread::Builder::new()
            .name("opennavo-mcp-broker".into())
            .spawn(move || accept_loop(weak, listener, stop_thread, host))
        {
            Ok(handle) => {
                inner.thread = Some(handle);
                Ok(())
            }
            Err(error) => {
                inner.enabled = previous_enabled;
                inner.running = false;
                inner.path = None;
                inner.stop = None;
                inner.socket_id = None;
                let failure = BrokerError::io(error);
                inner.error = Some(failure.to_string());
                let _ = state::save(&self.data_dir, previous_enabled);
                socket::remove_if_same(&self.data_dir, socket_id);
                Err(failure)
            }
        }
    }

    fn disable(&self) -> Result<(), BrokerError> {
        // Persist "off" before stopping anything. If the write fails, the
        // broker keeps running and reports the error, so the runtime and the
        // persisted switch never disagree and the next launch cannot silently
        // turn Local MCP back on.
        if let Err(error) = state::save(&self.data_dir, false) {
            let failure = BrokerError::io(error);
            self.lock().error = Some(failure.to_string());
            return Err(failure);
        }
        let thread = {
            let mut inner = self.lock();
            inner.enabled = false;
            inner.error = None;
            self.stop_runtime(&mut inner)
        };
        join(thread);
        Ok(())
    }

    /// Stop accepting, drop connections, and clear sessions without changing
    /// the persisted switch (used on app exit).
    pub fn shutdown(&self) {
        let _transition = self.transition();
        let thread = {
            let mut inner = self.lock();
            self.stop_runtime(&mut inner)
        };
        join(thread);
    }

    /// Stop runtime resources and return the accept thread for joining after
    /// the mutex guard is dropped.
    fn stop_runtime(&self, inner: &mut Inner) -> Option<JoinHandle<()>> {
        if let Some(stop) = inner.stop.take() {
            stop.store(true, Ordering::Release);
        }
        inner.running = false;
        inner.path = None;
        for connection in inner.connections.values() {
            let _ = connection.shutdown(std::net::Shutdown::Both);
        }
        inner.connections.clear();
        inner.sessions.clear();
        if let Some(socket_id) = inner.socket_id.take() {
            socket::remove_if_same(&self.data_dir, socket_id);
        }
        inner.thread.take()
    }

    fn transition(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        let thread = {
            let mut inner = self.lock();
            self.stop_runtime(&mut inner)
        };
        join(thread);
    }
}

fn join(thread: Option<JoinHandle<()>>) {
    if let Some(thread) = thread {
        let _ = thread.join();
    }
}

fn accept_loop(
    weak: Weak<Broker>,
    listener: UnixListener,
    stop: Arc<AtomicBool>,
    host: Option<Arc<dyn ToolHost>>,
) {
    if let Err(error) = listener.set_nonblocking(true) {
        log::warn!("Local MCP accept loop unavailable: {error}");
        return;
    }
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Err(error) = stream.set_nonblocking(false) {
                    log::warn!("Local MCP connection setup failed: {error}");
                    continue;
                }
                let Some(broker) = weak.upgrade() else {
                    return;
                };
                if let Err(error) = socket::verify_peer(&stream) {
                    log::warn!("Local MCP rejected peer: {error}");
                    continue;
                }
                let Ok(shutdown) = stream.try_clone() else {
                    continue;
                };
                let Some(id) = broker.register(shutdown) else {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    continue;
                };
                let unregister_weak = weak.clone();
                let connection_host = host.clone();
                let spawned = thread::Builder::new()
                    .name(format!("opennavo-mcp-conn-{id}"))
                    .spawn(move || {
                        connection_loop(unregister_weak, id, stream, connection_host);
                    });
                if spawned.is_err()
                    && let Some(broker) = weak.upgrade()
                {
                    broker.unregister(id);
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL);
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => {
                log::warn!("Local MCP accept failed: {error}");
                thread::sleep(ACCEPT_POLL);
            }
        }
    }
    drop(listener);
}

impl Broker {
    fn register(&self, shutdown: UnixStream) -> Option<u64> {
        let mut inner = self.lock();
        if !inner.running || inner.connections.len() >= MAX_CONNECTIONS {
            return None;
        }
        inner.next_connection = inner.next_connection.wrapping_add(1);
        let id = inner.next_connection;
        inner.connections.insert(id, shutdown);
        inner.sessions.insert(id);
        Some(id)
    }

    /// Whether a connection still belongs to the running broker. A worker
    /// from a previous enable cycle (or a disabled broker) gets `false`.
    fn is_active(&self, id: u64) -> bool {
        let inner = self.lock();
        inner.running && inner.connections.contains_key(&id)
    }

    fn unregister(&self, id: u64) {
        let mut inner = self.lock();
        inner.connections.remove(&id);
        inner.sessions.remove(&id);
    }
}

/// Internal reply failure. Codes are owned because tool failures come from
/// `AppError`/`ToolError` rather than a fixed set of literals.
type RpcError = (String, String);

fn rpc_error(code: &str, message: &str) -> RpcError {
    (code.to_owned(), message.to_owned())
}

fn connection_loop(
    weak: Weak<Broker>,
    id: u64,
    stream: UnixStream,
    host: Option<Arc<dyn ToolHost>>,
) {
    let mut reader = BufReader::new(stream);
    loop {
        let line = match read_line(&mut reader, MAX_REQUEST_BYTES) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) if error.kind() == ErrorKind::InvalidData => {
                let _ = write_response(
                    reader.get_mut(),
                    Value::Null,
                    Err(rpc_error(
                        "E_REQUEST_TOO_LARGE",
                        "Request exceeds the size limit",
                    )),
                );
                break;
            }
            Err(_) => break,
        };
        // Re-check before every dispatch: once the switch is turned off (or
        // this connection was dropped), no further request is served.
        if !weak.upgrade().is_some_and(|broker| broker.is_active(id)) {
            break;
        }
        let request: Value = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(_) => {
                if write_response(
                    reader.get_mut(),
                    Value::Null,
                    Err(rpc_error("E_INVALID_REQUEST", "Invalid JSON request")),
                )
                .is_err()
                {
                    break;
                }
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str);
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let version = request.get("v").and_then(Value::as_u64);
        let result = if version != Some(RPC_VERSION) {
            Err(rpc_error("E_INVALID_REQUEST", "Unsupported RPC version"))
        } else {
            match method {
                Some("ping") => Ok(json!({})),
                Some("tools/list") => Ok(super::tools::list_result()),
                Some("tools/call") => call_tool(host.as_deref(), params),
                Some(_) => Err(rpc_error("E_METHOD_NOT_FOUND", "Method not found")),
                None => Err(rpc_error("E_INVALID_REQUEST", "Missing method")),
            }
        };
        if write_response(reader.get_mut(), id, result).is_err() {
            break;
        }
    }
    if let Some(broker) = weak.upgrade() {
        broker.unregister(id);
    }
}

fn call_tool(host: Option<&dyn ToolHost>, params: Value) -> Result<Value, RpcError> {
    // Availability is checked before any validation so an unavailable broker
    // answers every call the same way, whatever the name or arguments.
    let Some(host) = host else {
        return Err(rpc_error(
            "E_MCP_DISABLED",
            "Local MCP read tools are unavailable",
        ));
    };
    let Some(params) = params.as_object() else {
        return Err(rpc_error("E_INVALID_ARG", "Invalid tool call"));
    };
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Err(rpc_error("E_INVALID_ARG", "Missing tool name"));
    };
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
    super::tools::call(host, name, arguments)
        .map_err(|error: ToolError| (error.code, error.message))
}

fn write_response(
    stream: &mut UnixStream,
    id: Value,
    result: Result<Value, RpcError>,
) -> io::Result<()> {
    let response = match result {
        Ok(result) => json!({
            "v": RPC_VERSION,
            "id": id,
            "ok": true,
            "result": result,
        }),
        Err((code, message)) => json!({
            "v": RPC_VERSION,
            "id": id,
            "ok": false,
            "error": { "code": code, "message": message },
        }),
    };
    let mut body = serde_json::to_vec(&response).map_err(io::Error::other)?;
    if body.len() > MAX_RESPONSE_BYTES {
        body = serde_json::to_vec(&json!({
            "v": RPC_VERSION,
            "id": id,
            "ok": false,
            "error": { "code": "E_RESPONSE_TOO_LARGE", "message": "Response exceeds the size limit" },
        }))
        .map_err(io::Error::other)?;
    }
    body.push(b'\n');
    stream.write_all(&body)?;
    stream.flush()
}

fn read_line<R: BufRead>(reader: &mut R, max: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |position| position + 1);
        if line.len() + take > max {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "request exceeds the size limit",
            ));
        }
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_some() {
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

/// App-side read tools backed by the live `DesktopCore`.
///
/// These methods run on broker connection threads and hand database/bundle
/// work to the app's blocking pool. The updatable-apps path reads only existing
/// cached update results; it never calls the update checker, starts a scan or
/// performs a network request.
struct LiveTools {
    core: Arc<crate::core::DesktopCore>,
}

impl LiveTools {
    fn new(core: Arc<crate::core::DesktopCore>) -> Self {
        Self { core }
    }
}

fn tool_error(error: crate::AppError) -> ToolError {
    ToolError::new(error.code, error.message)
}

fn json_error(error: serde_json::Error) -> ToolError {
    ToolError::internal(error.to_string())
}

/// Run database or bundle work on the app's blocking pool. Broker connections
/// are already non-tokio threads, but this keeps the same rule as Tauri
/// commands: no filesystem or SQLite read runs on a tokio worker.
fn blocking_tool<T>(
    work: impl FnOnce() -> Result<T, crate::AppError> + Send + 'static,
) -> Result<T, ToolError>
where
    T: Send + 'static,
{
    tauri::async_runtime::block_on(crate::blocking(work)).map_err(tool_error)
}

fn parse_kind(kind: &str) -> Result<crate::model::Kind, ToolError> {
    match kind {
        "cask" => Ok(crate::model::Kind::Cask),
        "formula" => Ok(crate::model::Kind::Formula),
        "link" => Ok(crate::model::Kind::Link),
        _ => Err(ToolError::invalid("kind is not supported")),
    }
}

impl ToolHost for LiveTools {
    fn search_catalog(
        &self,
        query: &str,
        kind: Option<&str>,
        limit: u32,
    ) -> Result<Value, ToolError> {
        let query = crate::model::SearchQuery {
            q: query.to_owned(),
            kind: kind.map(parse_kind).transpose()?,
            include_links: false,
            category: None,
            include_disabled: false,
            limit,
            offset: 0,
        };
        let database = self.core.database.clone();
        let page =
            blocking_tool(move || crate::catalog::search_without_history(&database, &query))?;
        serde_json::to_value(page).map_err(json_error)
    }

    fn get_catalog_item(&self, kind: &str, token: &str) -> Result<Value, ToolError> {
        let kind = parse_kind(kind)?;
        let token = token.to_owned();
        let database = self.core.database.clone();
        let item = blocking_tool(move || crate::catalog::get(&database, kind, &token))?;
        Ok(json!({ "item": item }))
    }

    fn list_installed_apps(&self) -> Result<Value, ToolError> {
        let engine = self.core.queue.uninstall_engine.clone();
        let apps = blocking_tool(move || engine.list())?;
        let rows: Vec<Value> = apps
            .iter()
            .map(|app| {
                json!({
                    "id": app.id,
                    "path": app.path,
                    "name": app.name,
                    "version": app.version,
                    "bundleId": app.bundle_id,
                    "source": app.source,
                })
            })
            .collect();
        Ok(json!({ "apps": rows }))
    }

    fn list_updatable_apps(&self) -> Result<Value, ToolError> {
        // `updates_list` only merges cached in-memory results and persisted
        // candidates. It never calls `check_update_sources`, so this cannot
        // start a feed request or a new update scan.
        let core = self.core.clone();
        let updates = blocking_tool(move || core.updates_list())?;
        if updates.is_empty() {
            return Ok(json!({ "apps": [] }));
        }

        // Paths come from caches too: the in-memory app inventory for native
        // updates and the stored library snapshot for Homebrew entries.
        let database = self.core.database.clone();
        let installed: Vec<crate::model::InstalledItem> = blocking_tool(move || {
            Ok(database
                .meta("installed_cache")?
                .as_deref()
                .and_then(|body| serde_json::from_str(body).ok())
                .unwrap_or_default())
        })?;
        let rows: Vec<Value> = updates
            .into_iter()
            .map(|update| {
                let id = update
                    .app_id
                    .clone()
                    .unwrap_or_else(|| update.token.clone());
                let path = update
                    .app_id
                    .as_deref()
                    .and_then(|id| self.core.queue.uninstall_engine.app(id).ok())
                    .map(|cached| cached.app.path)
                    .or_else(|| {
                        installed
                            .iter()
                            .find(|local| {
                                local.kind == update.kind && local.matches_token(&update.token)
                            })
                            .and_then(|local| local.app_paths.first().cloned())
                    })
                    .unwrap_or_default();
                json!({
                    "id": id,
                    "path": path,
                    "name": update.name,
                    "currentVersion": update.installed_version,
                    "latestVersion": update.current_version,
                })
            })
            .collect();
        Ok(json!({ "apps": rows }))
    }

    fn get_task(&self, id: &str) -> Result<Value, ToolError> {
        let database = self.core.database.clone();
        let id = id.to_owned();
        let task = blocking_tool(move || database.task(&id))?;
        Ok(json!({ "task": task }))
    }
}

/// Install the broker during Tauri setup. Startup failures are logged and
/// surfaced through `mcp_status`; they never block the app.
pub fn install(app: tauri::AppHandle) {
    use tauri::Manager;

    let data_dir = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(error) => {
            log::warn!("Local MCP data directory unavailable: {error}");
            return;
        }
    };
    let Some(core) = app
        .try_state::<Arc<crate::core::DesktopCore>>()
        .map(|state| state.inner().clone())
    else {
        log::warn!("Local MCP read tools unavailable: DesktopCore is not managed");
        return;
    };
    let host: Arc<dyn ToolHost> = Arc::new(LiveTools::new(core));
    let broker = Arc::new(Broker::with_host(data_dir, Some(host)));
    if let Err(error) = broker.start_if_enabled() {
        log::warn!("Local MCP broker unavailable: {error}");
    }
    app.manage(broker);
}

/// Best-effort cleanup on app exit. The persisted switch is left untouched.
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;

    if let Some(broker) = app.try_state::<Arc<Broker>>() {
        broker.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, os::unix::net::UnixStream};

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn request(path: &std::path::Path, body: Value) -> Value {
        let mut stream = UnixStream::connect(path).expect("connect");
        serde_json::to_writer(&mut stream, &body).expect("write");
        stream.write_all(b"\n").expect("newline");
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).expect("read");
        serde_json::from_str(&line).expect("json")
    }

    fn wait_running(broker: &Arc<Broker>) {
        for _ in 0..100 {
            if broker.status().running {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("broker did not start");
    }

    #[test]
    fn switch_off_creates_no_socket() {
        let dir = tempdir();
        let broker = Arc::new(Broker::new(dir.path().to_path_buf()));
        broker.start_if_enabled().expect("start");
        assert!(!broker.status().running);
        assert!(!socket::path(dir.path()).path.exists());
    }

    #[test]
    fn failed_disable_persist_keeps_running_and_never_reenables_on_restart() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir();
        let broker = Arc::new(Broker::new(dir.path().to_path_buf()));
        broker.set_enabled(true).expect("enable");
        wait_running(&broker);
        let mcp = state::mcp_dir(dir.path());
        std::fs::set_permissions(&mcp, std::fs::Permissions::from_mode(0o500)).expect("chmod");

        broker.set_enabled(false).expect_err("persist must fail");
        let status = broker.status();
        // Runtime and persisted switch agree: still on, error reported.
        assert!(status.enabled && status.running, "{status:?}");
        assert!(status.error.is_some());
        assert!(state::load(dir.path()).enabled);

        std::fs::set_permissions(&mcp, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        broker.set_enabled(false).expect("disable");
        assert!(!broker.status().running);
        assert!(!state::load(dir.path()).enabled);
        broker.shutdown();

        // A fresh broker (next launch) stays off.
        let restarted = Arc::new(Broker::new(dir.path().to_path_buf()));
        restarted.start_if_enabled().expect("start");
        assert!(!restarted.status().enabled);
        assert!(!restarted.status().running);
    }

    #[test]
    fn switch_on_binds_and_answers_ping() {
        let dir = tempdir();
        let broker = Arc::new(Broker::new(dir.path().to_path_buf()));
        broker.set_enabled(true).expect("enable");
        wait_running(&broker);
        let response = request(
            &socket::path(dir.path()).path,
            json!({"v":1,"id":"1","method":"ping","params":{}}),
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"], json!({}));
        broker.set_enabled(false).expect("disable");
        assert!(!socket::path(dir.path()).path.exists());
        assert!(!broker.status().running);
    }

    #[test]
    fn turning_off_disconnects_existing_connection_and_clears_sessions() {
        let dir = tempdir();
        let broker = Arc::new(Broker::new(dir.path().to_path_buf()));
        broker.set_enabled(true).expect("enable");
        wait_running(&broker);
        let mut stream = UnixStream::connect(socket::path(dir.path()).path).expect("connect");
        for _ in 0..100 {
            if !broker.lock().sessions.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(broker.lock().sessions.len(), 1);
        broker.set_enabled(false).expect("disable");
        let mut byte = [0u8; 1];
        let _ = stream.read(&mut byte);
        assert!(broker.lock().sessions.is_empty());
    }

    #[test]
    fn unsupported_method_returns_structured_error() {
        let dir = tempdir();
        let broker = Arc::new(Broker::new(dir.path().to_path_buf()));
        broker.set_enabled(true).expect("enable");
        wait_running(&broker);
        let response = request(
            &socket::path(dir.path()).path,
            json!({"v":1,"id":"1","method":"nope","params":{}}),
        );
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "E_METHOD_NOT_FOUND");
        broker.shutdown();
    }

    #[test]
    fn oversized_request_does_not_kill_broker() {
        let dir = tempdir();
        let broker = Arc::new(Broker::new(dir.path().to_path_buf()));
        broker.set_enabled(true).expect("enable");
        wait_running(&broker);
        let path = socket::path(dir.path()).path;
        let mut stream = UnixStream::connect(&path).expect("connect");
        stream
            .write_all(&vec![b'x'; MAX_REQUEST_BYTES + 1])
            .expect("oversized");
        stream.write_all(b"\n").expect("newline");
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).expect("error response");
        let response: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(response["error"]["code"], "E_REQUEST_TOO_LARGE");

        let response = request(&path, json!({"v":1,"id":"2","method":"ping"}));
        assert_eq!(response["ok"], true);
        broker.shutdown();
    }

    struct MockHost;

    impl ToolHost for MockHost {
        fn search_catalog(
            &self,
            query: &str,
            kind: Option<&str>,
            _limit: u32,
        ) -> Result<Value, ToolError> {
            assert_eq!(query, "firefox");
            assert_eq!(kind, Some("cask"));
            Ok(json!({
                "total": 1,
                "items": [{ "item": { "kind": "cask", "token": "firefox" } }]
            }))
        }

        fn get_catalog_item(&self, _kind: &str, _token: &str) -> Result<Value, ToolError> {
            Ok(json!({ "item": null }))
        }

        fn list_installed_apps(&self) -> Result<Value, ToolError> {
            Ok(json!({ "apps": [] }))
        }

        fn list_updatable_apps(&self) -> Result<Value, ToolError> {
            Ok(json!({ "apps": [] }))
        }

        fn get_task(&self, id: &str) -> Result<Value, ToolError> {
            assert_eq!(id, "task-1");
            Ok(json!({ "task": { "id": "task-1", "state": "running" } }))
        }
    }

    fn broker_with_mock(dir: &tempfile::TempDir) -> Arc<Broker> {
        let host: Arc<dyn ToolHost> = Arc::new(MockHost);
        Arc::new(Broker::with_host(dir.path().to_path_buf(), Some(host)))
    }

    #[test]
    fn broker_round_trips_search_and_get_task() {
        let dir = tempdir();
        let broker = broker_with_mock(&dir);
        broker.set_enabled(true).expect("enable");
        wait_running(&broker);
        let path = socket::path(dir.path()).path;

        let response = request(
            &path,
            json!({
                "v": 1,
                "id": "search",
                "method": "tools/call",
                "params": {
                    "name": "search_catalog",
                    "arguments": { "query": "firefox", "kind": "cask" }
                }
            }),
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["untrusted"], true);
        assert_eq!(response["result"]["items"][0]["item"]["untrusted"], true);

        let response = request(
            &path,
            json!({
                "v": 1,
                "id": "task",
                "method": "tools/call",
                "params": { "name": "get_task", "arguments": { "id": "task-1" } }
            }),
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["task"]["state"], "running");
        broker.shutdown();
    }

    #[test]
    fn tools_list_and_unknown_write_names_are_rejected() {
        let dir = tempdir();
        let broker = broker_with_mock(&dir);
        broker.set_enabled(true).expect("enable");
        wait_running(&broker);
        let path = socket::path(dir.path()).path;

        let response = request(&path, json!({"v":1,"id":"list","method":"tools/list"}));
        assert_eq!(response["ok"], true);
        let names: Vec<&str> = response["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "search_catalog",
                "get_catalog_item",
                "list_installed_apps",
                "list_updatable_apps",
                "get_task"
            ]
        );
        assert!(!names.contains(&"install_app"));
        assert!(!names.contains(&"uninstall_app"));

        for name in ["install_app", "uninstall_app", "get_latest_scan_result"] {
            let response = request(
                &path,
                json!({
                    "v": 1,
                    "id": name,
                    "method": "tools/call",
                    "params": { "name": name, "arguments": {} }
                }),
            );
            assert_eq!(response["ok"], false, "name {name}");
            assert_eq!(response["error"]["code"], "E_TOOL_NOT_FOUND", "name {name}");
        }
        broker.shutdown();
    }
}
