//! CLI-side connection to the app's Local MCP broker.
//!
//! The client is lazy: `initialize` and `tools/list` never touch the socket.
//! Every `tools/call` first reads the persisted master switch, then connects
//! with a 500 ms budget and forwards one internal request. A dropped stream is
//! reported as `E_APP_DISCONNECTED`; the next call may reconnect.

use std::{
    io::{self, BufRead, BufReader, ErrorKind, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use serde_json::{Value, json};

use super::{socket, state};

/// Connect deadline required by the local MCP design.
pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
/// Deadline for writing one request to the broker.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Deadline for the broker's answer to one request. Write tools wait for the
/// native confirmation dialog, which times out after 60 s on the app side, so
/// the budget covers that plus planning and queueing. Read tools never wait on
/// the user and answer well within it.
pub const READ_TIMEOUT: Duration = Duration::from_secs(90);
/// Maximum accepted broker response line (the app may return catalog pages).
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Internal RPC version.
pub const RPC_VERSION: u64 = 1;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// CLI-visible failure classes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// The persisted master switch is off.
    Disabled,
    /// The switch is on, but no broker is listening.
    AppNotRunning,
    /// The broker went away while a request was in flight.
    Disconnected,
    /// Internal protocol or transport response was unusable.
    Protocol(String),
    /// The socket is not served by the current user, or its directory is not
    /// private. The CLI refuses to talk to it.
    UntrustedPeer(String),
    /// The broker accepted the request but did not answer in time.
    Timeout,
    /// Broker returned a structured error.
    Broker { code: String, message: String },
}

impl CallError {
    /// JSON-RPC code used by the stdio server.
    pub fn jsonrpc_code(&self) -> i64 {
        match self {
            Self::Disabled => -32001,
            Self::AppNotRunning => -32002,
            Self::Disconnected => -32003,
            Self::UntrustedPeer(_) => -32004,
            Self::Timeout => -32005,
            Self::Broker { code, .. } if code == "E_TOOL_NOT_FOUND" => -32602,
            Self::Broker { .. } => -32603,
            Self::Protocol(_) => -32603,
        }
    }

    /// Stable error code exposed through JSON-RPC `error.data.code`.
    pub fn data_code(&self) -> &str {
        match self {
            Self::Disabled => "E_MCP_DISABLED",
            Self::AppNotRunning => "E_APP_NOT_RUNNING",
            Self::Disconnected => "E_APP_DISCONNECTED",
            Self::UntrustedPeer(_) => "E_MCP_UNTRUSTED_PEER",
            Self::Timeout => "E_APP_TIMEOUT",
            Self::Broker { code, .. } => code,
            Self::Protocol(_) => "E_MCP_PROTOCOL",
        }
    }

    /// Human-readable, actionable message.
    pub fn message(&self) -> String {
        match self {
            Self::Disabled => {
                "Local MCP is turned off in OpenNavo Settings. Ask the user to enable it."
                    .to_owned()
            }
            Self::AppNotRunning => {
                "OpenNavo is not running. Please open OpenNavo and try again.".to_owned()
            }
            Self::Disconnected => {
                "OpenNavo disconnected before answering. Please retry the call.".to_owned()
            }
            Self::UntrustedPeer(reason) => format!(
                "Refusing to use the Local MCP socket because it is not private to this user ({reason}). Quit any other OpenNavo instance and reopen OpenNavo."
            ),
            Self::Timeout => "OpenNavo did not answer in time. Please retry the call.".to_owned(),
            Self::Broker { message, .. } => message.clone(),
            Self::Protocol(message) => {
                format!("OpenNavo returned an invalid MCP response: {message}")
            }
        }
    }
}

/// Lazy CLI client.
pub struct Client {
    data_dir: PathBuf,
    stream: Option<BufReader<UnixStream>>,
    read_timeout: Duration,
}

impl Client {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            stream: None,
            read_timeout: READ_TIMEOUT,
        }
    }

    /// Override the response deadline (tests).
    pub fn with_read_timeout(mut self, timeout: Duration) -> Self {
        self.read_timeout = timeout;
        self
    }

    /// Directory whose `mcp/state.json` controls this client.
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// Forward one internal request. The caller serializes calls on a session.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
        if !state::load(&self.data_dir).enabled {
            // Do not use a socket left behind by a previous run while the user
            // has turned Local MCP off.
            self.stream = None;
            return Err(CallError::Disabled);
        }

        let id = format!(
            "{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        );
        let request = json!({
            "v": RPC_VERSION,
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line =
            serde_json::to_vec(&request).map_err(|error| CallError::Protocol(error.to_string()))?;
        line.push(b'\n');

        let stream = self.ensure_stream()?;
        if let Err(error) = stream
            .get_mut()
            .write_all(&line)
            .and_then(|_| stream.get_mut().flush())
        {
            self.stream = None;
            return Err(map_stream_error(error));
        }

        let response = match read_line(stream, MAX_RESPONSE_BYTES) {
            Ok(Some(response)) => response,
            Ok(None) => {
                self.stream = None;
                return Err(CallError::Disconnected);
            }
            Err(error) => {
                self.stream = None;
                return Err(map_stream_error(error));
            }
        };
        let response: Value = match serde_json::from_slice(&response) {
            Ok(response) => response,
            Err(error) => {
                self.stream = None;
                return Err(CallError::Protocol(error.to_string()));
            }
        };
        parse_response(&response)
    }

    fn ensure_stream(&mut self) -> Result<&mut BufReader<UnixStream>, CallError> {
        if self.stream.is_none() {
            let resolved = socket::path(&self.data_dir);
            let stream = socket::connect_timeout(&resolved.path, CONNECT_TIMEOUT)
                .map_err(map_connect_error)?;
            // macOS reports EINVAL from setsockopt once the peer has already
            // closed; that is a disconnect, not a protocol error.
            stream
                .set_write_timeout(Some(WRITE_TIMEOUT))
                .and_then(|_| stream.set_read_timeout(Some(self.read_timeout)))
                .map_err(map_setup_error)?;
            socket::verify_server(&resolved, &stream).map_err(|error| {
                if error.kind() == ErrorKind::PermissionDenied {
                    CallError::UntrustedPeer(error.to_string())
                } else {
                    map_stream_error(error)
                }
            })?;
            self.stream = Some(BufReader::new(stream));
        }
        Ok(self.stream.as_mut().expect("stream was just installed"))
    }
}

fn map_connect_error(error: io::Error) -> CallError {
    match error.raw_os_error() {
        Some(code)
            if code == nix::libc::ENOENT
                || code == nix::libc::ECONNREFUSED
                || code == nix::libc::ETIMEDOUT =>
        {
            CallError::AppNotRunning
        }
        _ if error.kind() == ErrorKind::NotFound || error.kind() == ErrorKind::TimedOut => {
            CallError::AppNotRunning
        }
        _ => CallError::Protocol(error.to_string()),
    }
}

/// Only used for setting socket timeouts: macOS reports EINVAL there once
/// the peer has already closed.
fn map_setup_error(error: io::Error) -> CallError {
    if error.raw_os_error() == Some(nix::libc::EINVAL) {
        CallError::Disconnected
    } else {
        map_stream_error(error)
    }
}

fn map_stream_error(error: io::Error) -> CallError {
    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) {
        return CallError::Timeout;
    }
    match error.raw_os_error() {
        Some(code)
            if code == nix::libc::ECONNRESET
                || code == nix::libc::EPIPE
                || code == nix::libc::ENOTCONN =>
        {
            CallError::Disconnected
        }
        _ if matches!(
            error.kind(),
            ErrorKind::BrokenPipe
                | ErrorKind::ConnectionReset
                | ErrorKind::ConnectionAborted
                | ErrorKind::UnexpectedEof
                | ErrorKind::NotConnected
        ) =>
        {
            CallError::Disconnected
        }
        _ => CallError::Protocol(error.to_string()),
    }
}

fn parse_response(response: &Value) -> Result<Value, CallError> {
    if response.get("v").and_then(Value::as_u64) != Some(RPC_VERSION) {
        return Err(CallError::Protocol("unsupported response version".into()));
    }
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }
    let error = response
        .get("error")
        .ok_or_else(|| CallError::Protocol("missing error".into()))?;
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .ok_or_else(|| CallError::Protocol("missing error code".into()))?;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("MCP request failed");
    Err(CallError::Broker {
        code: code.to_owned(),
        message: message.to_owned(),
    })
}

fn read_line<R: BufRead>(reader: &mut R, max: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                line.push(b'\n');
                Ok(Some(line))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |position| position + 1);
        if line.len() + take > max {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "MCP response exceeds the size limit",
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::net::UnixListener, thread};

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn serve_once(dir: &std::path::Path, response: Value) {
        let listener = UnixListener::bind(&socket::path(dir).path).expect("bind");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone"))
                .read_line(&mut request)
                .expect("read request");
            let request: Value = serde_json::from_str(&request).expect("request json");
            assert_eq!(request["v"], 1);
            serde_json::to_writer(&mut stream, &response).expect("write");
            stream.write_all(b"\n").expect("newline");
        });
    }

    #[test]
    fn missing_socket_with_switch_on_is_app_not_running() {
        let dir = tempdir();
        state::prepare_enabled_for_test(dir.path());
        let mut client = Client::new(dir.path().into());
        assert_eq!(
            client.call("tools/call", json!({})),
            Err(CallError::AppNotRunning)
        );
        assert_eq!(
            CallError::AppNotRunning.message(),
            "OpenNavo is not running. Please open OpenNavo and try again."
        );
    }

    #[test]
    fn switch_off_is_disabled_even_when_a_socket_exists() {
        let dir = tempdir();
        let resolved = socket::path(dir.path());
        state::ensure_private_dir(&resolved.directory).expect("dir");
        let listener = UnixListener::bind(&resolved.path).expect("bind");
        let mut client = Client::new(dir.path().into());
        assert_eq!(
            client.call("tools/call", json!({})),
            Err(CallError::Disabled)
        );
        drop(listener);
    }

    #[test]
    fn round_trips_a_result() {
        let dir = tempdir();
        state::prepare_enabled_for_test(dir.path());
        serve_once(
            dir.path(),
            json!({"v":1,"id":"x","ok":true,"result":{"answer":42}}),
        );
        let mut client = Client::new(dir.path().into());
        assert_eq!(
            client
                .call("tools/call", json!({"name":"x"}))
                .expect("result"),
            json!({"answer":42})
        );
    }

    #[test]
    fn broker_error_is_preserved() {
        let dir = tempdir();
        state::prepare_enabled_for_test(dir.path());
        serve_once(
            dir.path(),
            json!({"v":1,"id":"x","ok":false,"error":{"code":"E_TOOL_NOT_FOUND","message":"Unknown tool"}}),
        );
        let mut client = Client::new(dir.path().into());
        assert_eq!(
            client.call("tools/call", json!({"name":"x"})),
            Err(CallError::Broker {
                code: "E_TOOL_NOT_FOUND".into(),
                message: "Unknown tool".into()
            })
        );
    }

    #[test]
    fn broker_that_never_answers_times_out_and_drops_the_stream() {
        let dir = tempdir();
        state::prepare_enabled_for_test(dir.path());
        let listener = UnixListener::bind(&socket::path(dir.path()).path).expect("bind");
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            // Accept the request but never answer.
            let _ = wait.recv();
            drop(stream);
        });
        let mut client =
            Client::new(dir.path().into()).with_read_timeout(Duration::from_millis(200));
        let started = std::time::Instant::now();
        assert_eq!(
            client.call("tools/call", json!({})),
            Err(CallError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(client.stream.is_none());
        assert_eq!(CallError::Timeout.data_code(), "E_APP_TIMEOUT");
        release.send(()).expect("release");
        handle.join().expect("join");
    }

    #[test]
    fn socket_directory_with_broad_permissions_is_untrusted() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir();
        state::prepare_enabled_for_test(dir.path());
        let resolved = socket::path(dir.path());
        let _listener = UnixListener::bind(&resolved.path).expect("bind");
        std::fs::set_permissions(&resolved.directory, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");
        let mut client = Client::new(dir.path().into());
        let error = client.call("tools/call", json!({})).expect_err("untrusted");
        assert!(matches!(error, CallError::UntrustedPeer(_)), "{error:?}");
        assert_eq!(error.data_code(), "E_MCP_UNTRUSTED_PEER");
    }

    #[test]
    fn disconnect_is_reported_and_next_call_can_reconnect() {
        let dir = tempdir();
        state::prepare_enabled_for_test(dir.path());
        let listener = UnixListener::bind(&socket::path(dir.path()).path).expect("bind");
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            drop(stream);
        });
        let mut client = Client::new(dir.path().into());
        assert_eq!(
            client.call("tools/call", json!({})),
            Err(CallError::Disconnected)
        );
        handle.join().expect("join");
    }
}
