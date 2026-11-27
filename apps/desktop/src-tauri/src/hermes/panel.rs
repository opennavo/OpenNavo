//! Hermes Panel account/password authentication.
//!
//! The panel owns the login session. OpenNavo keeps the HttpOnly session cookies
//! in `<data_root>/.opennavo/session.json` (owner-only, plaintext) and mints
//! short-lived ws tickets for each gateway WebSocket.

use std::time::Duration;

use reqwest::header::{COOKIE, SET_COOKIE};
use serde::{Deserialize, Serialize};

use super::AppError;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PanelLoginResult {
    pub base_url: String,
    pub provider: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PanelSession {
    pub base_url: String,
    pub provider: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Stable identity of this login. Cookie rotation preserves it; a new sign-in gets a new
    /// one. Old sessions on disk deserialize as empty and fall back to full equality.
    #[serde(default)]
    pub login_id: String,
}

fn base_url(raw: &str) -> Result<String, AppError> {
    let mut parsed = reqwest::Url::parse(raw.trim())
        .map_err(|_| AppError::new("E_HERMES_PANEL_URL", "Invalid Hermes panel URL."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new(
            "E_HERMES_PANEL_URL",
            "Panel URL must start with http:// or https://.",
        ));
    }
    // A base URL is joined with panel routes; credentials, a query or a fragment cannot be
    // carried forward and would silently change the origin/route of every request.
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(AppError::new(
            "E_HERMES_PANEL_URL",
            "Panel URL must not contain credentials, a query or a fragment.",
        ));
    }
    // The typed host is what distinguishes a bracketed IPv6 literal from a domain; comparing
    // `host_str()` to "::1" rejected `http://[::1]:9119`.
    if parsed.scheme() == "http" {
        let host = parsed
            .host_str()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']');
        let allowed = match host.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V4(ip)) => {
                let octets = ip.octets();
                let tailnet = octets[0] == 100 && (64..=127).contains(&octets[1]);
                tailnet || ip.is_loopback()
            }
            Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback(),
            Err(_) => host == "localhost" || host.ends_with(".ts.net"),
        };

        if !allowed {
            return Err(AppError::new(
                "E_HERMES_PANEL_URL",
                "Use HTTPS for a non-Tailscale Hermes panel.",
            ));
        }
    }
    let mut path = parsed.path().trim_end_matches('/').to_owned();
    if path.ends_with("/login") {
        path.truncate(path.len() - "/login".len());
        path = path.trim_end_matches('/').to_owned();
    }
    parsed.set_path(&path);
    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}
fn client_with_timeout(timeout: Duration) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|error| {
            AppError::new("E_HERMES_PANEL", "Could not prepare the panel request.")
                .with_detail(error.to_string())
        })
}

fn client() -> Result<reqwest::Client, AppError> {
    client_with_timeout(Duration::from_secs(20))
}

/// A 16 MiB upload or image preview over a tailnet can outlast the API timeout. File transfers
/// get their own budget; the upload body streams instead of being read into memory first.
fn transfer_client() -> Result<reqwest::Client, AppError> {
    client_with_timeout(Duration::from_secs(300))
}

fn cookie_value(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    for value in headers.get_all(SET_COOKIE) {
        let Ok(raw) = value.to_str() else {
            continue;
        };
        let Some(pair) = raw.split(';').next() else {
            continue;
        };
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key.trim() != name {
            continue;
        }
        // A deletion (`name=""; Max-Age=0`, sent when the panel rejects the session) is not a
        // rotated token. Treating the quoted empty value as one would write an unusable cookie
        // into the session store and clobber a login that landed while the request was in flight.
        let value = value.trim();
        if value.trim_matches('"').is_empty() {
            continue;
        }
        return Some(value.to_owned());
    }
    None
}

/// Upper bound for one panel JSON body. Transcripts can be large, but an unbounded `.json()`
/// lets a broken or hostile host buffer until the process dies.
pub(crate) const MAX_PANEL_JSON_BYTES: usize = 32 * 1024 * 1024;

/// Read a JSON body through a byte cap. The error is diagnostic text, never the body itself.
pub(crate) async fn read_json_limited(
    response: &mut reqwest::Response,
    limit: usize,
) -> Result<serde_json::Value, String> {
    let mut body = Vec::new();
    while body.len() <= limit {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let room = limit.saturating_add(1).saturating_sub(body.len());
                body.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            Ok(None) => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    if body.len() > limit {
        return Err(format!("panel response exceeded {limit} bytes"));
    }
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

pub async fn login(base: &str, username: &str, password: &str) -> Result<PanelSession, AppError> {
    if username.trim().is_empty() || password.is_empty() {
        return Err(AppError::new(
            "E_HERMES_PANEL_INPUT",
            "Panel username and password are required.",
        ));
    }
    let base = base_url(base)?;
    let client = client()?;
    let mut providers_response = client
        .get(format!("{base}/api/auth/providers"))
        .send()
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_PANEL", "Could not reach the Hermes panel.")
                .with_detail(error.to_string())
        })?;
    let providers: serde_json::Value =
        read_json_limited(&mut providers_response, MAX_PANEL_JSON_BYTES)
            .await
            .unwrap_or(serde_json::Value::Null);
    let provider = providers
        .get("providers")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("supports_password")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
            })
        })
        .and_then(|item| item.get("name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("basic")
        .to_owned();
    let response = client
        .post(format!("{base}/auth/password-login"))
        .json(&serde_json::json!({
            "provider": provider,
            "username": username.trim(),
            "password": password,
            "next": ""
        }))
        .send()
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_PANEL", "Could not sign in to the Hermes panel.")
                .with_detail(error.to_string())
        })?;
    let status = response.status();
    let headers = response.headers().clone();
    if !status.is_success() {
        return Err(AppError::new(
            "E_HERMES_PANEL_AUTH",
            format!("Hermes panel login returned {status}."),
        ));
    }
    let access_token = cookie_value(&headers, "hermes_session_at").ok_or_else(|| {
        AppError::new(
            "E_HERMES_PANEL_AUTH",
            "Hermes panel did not return a session cookie.",
        )
    })?;
    let refresh_token = cookie_value(&headers, "hermes_session_rt").ok_or_else(|| {
        AppError::new(
            "E_HERMES_PANEL_AUTH",
            "Hermes panel did not return a refresh cookie.",
        )
    })?;
    Ok(PanelSession {
        base_url: base,
        provider,
        access_token,
        refresh_token,
        login_id: uuid::Uuid::new_v4().to_string(),
    })
}

pub(crate) fn cookie_header(session: &PanelSession) -> String {
    format!(
        "hermes_session_at={}; hermes_session_rt={}",
        session.access_token, session.refresh_token
    )
}

fn refreshed_session(
    session: &PanelSession,
    headers: &reqwest::header::HeaderMap,
) -> Option<PanelSession> {
    let access =
        cookie_value(headers, "hermes_session_at").unwrap_or_else(|| session.access_token.clone());
    let refresh =
        cookie_value(headers, "hermes_session_rt").unwrap_or_else(|| session.refresh_token.clone());
    if access == session.access_token && refresh == session.refresh_token {
        return None;
    }
    Some(PanelSession {
        base_url: session.base_url.clone(),
        provider: session.provider.clone(),
        access_token: access,
        refresh_token: refresh,
        login_id: session.login_id.clone(),
    })
}

/// Persist cookies rotated by a response, but only if the request still owns the stored
/// session. A response that lands after a newer login at the same profile id is stale and
/// must not replace the new cookies.
pub fn persist_response_cookies(
    profile_id: &str,
    used: &PanelSession,
    headers: &reqwest::header::HeaderMap,
) -> Result<(), AppError> {
    if let Some(refreshed) = refreshed_session(used, headers) {
        super::panel_session_update_if(profile_id, used, &refreshed)?;
    }
    Ok(())
}

pub fn base_url_for(profile_id: &str) -> Result<String, AppError> {
    Ok(super::panel_session(profile_id)?.base_url)
}

async fn ticket_with_refresh(
    session: &PanelSession,
) -> Result<(String, Option<PanelSession>), AppError> {
    let client = client()?;
    let mut response = client
        .post(format!("{}/api/auth/ws-ticket", session.base_url))
        .header(COOKIE, cookie_header(session))
        .send()
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_PANEL", "Could not mint a panel WebSocket ticket.")
                .with_detail(error.to_string())
        })?;
    let status = response.status();
    let headers = response.headers().clone();
    let value = read_json_limited(&mut response, MAX_PANEL_JSON_BYTES)
        .await
        .unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(AppError::new(
            "E_HERMES_PANEL_AUTH",
            format!("Panel ws-ticket returned {status}."),
        ));
    }
    let ticket = value
        .get("ticket")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| AppError::new("E_HERMES_PANEL_AUTH", "Panel did not return a ws ticket."))?;
    Ok((ticket, refreshed_session(session, &headers)))
}

pub async fn ticket(session: &PanelSession) -> Result<String, AppError> {
    let client = client()?;
    let mut response = client
        .post(format!("{}/api/auth/ws-ticket", session.base_url))
        .header(COOKIE, cookie_header(session))
        .send()
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_PANEL", "Could not mint a panel WebSocket ticket.")
                .with_detail(error.to_string())
        })?;
    let status = response.status();
    let value = read_json_limited(&mut response, MAX_PANEL_JSON_BYTES)
        .await
        .unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(AppError::new(
            "E_HERMES_PANEL_AUTH",
            format!("Panel ws-ticket returned {status}."),
        ));
    }
    value
        .get("ticket")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| AppError::new("E_HERMES_PANEL_AUTH", "Panel did not return a ws ticket."))
}

pub async fn logout(session: &PanelSession) -> Result<(), AppError> {
    let client = client()?;
    let _ = client
        .post(format!("{}/auth/logout", session.base_url))
        .header(COOKIE, cookie_header(session))
        .send()
        .await;
    Ok(())
}

/// One authenticated panel response, status included. Diagnostics actions need the raw
/// status to tell "the profile does not exist on this host" (404) from every other failure;
/// the session helpers below keep their existing classification.
pub(crate) struct PanelReply {
    pub status: reqwest::StatusCode,
    pub value: serde_json::Value,
}

/// Join a panel route onto a base URL that may carry a path prefix (`https://host/hermes`).
pub(crate) fn endpoint_url(base: &str, path: &str) -> Result<reqwest::Url, AppError> {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    reqwest::Url::parse(&format!("{base}/{path}"))
        .map_err(|_| AppError::new("E_HERMES_PANEL_URL", "Invalid Hermes panel URL."))
}

/// One authenticated panel request. Every session read and write goes through here so the
/// rotated cookies are persisted the same way for GET, PATCH and DELETE.
pub(crate) async fn request_raw(
    profile_id: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    failure: &str,
) -> Result<PanelReply, AppError> {
    let session = super::panel_session(profile_id)?;
    request_raw_with_session(profile_id, &session, method, path, body, failure).await
}

/// One authenticated request built from a caller-held snapshot. The URL, cookie and the
/// cookie rotation all belong to the same session even if a relogin lands mid-flight.
pub(crate) async fn request_raw_with_session(
    profile_id: &str,
    session: &PanelSession,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    failure: &str,
) -> Result<PanelReply, AppError> {
    let client = client()?;
    let url = endpoint_url(&session.base_url, path)?;
    let mut request = client
        .request(method, url)
        .header(COOKIE, cookie_header(session));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| AppError::new("E_HERMES_PANEL", failure).with_detail(error.to_string()))?;
    let status = response.status();
    let headers = response.headers().clone();
    let mut response = response;
    let value = match read_json_limited(&mut response, MAX_PANEL_JSON_BYTES).await {
        Ok(value) => value,
        // A rejected body is only diagnostic; a successful one must be a complete JSON
        // document or the caller would silently act on an empty list.
        Err(detail) if status.is_success() => {
            return Err(AppError::new(
                "E_HERMES_PANEL",
                "The Hermes panel returned an unreadable response.",
            )
            .with_detail(detail));
        }
        Err(_) => serde_json::Value::Null,
    };
    // A rejected response may carry a deletion cookie; only a success can rotate the session.
    if status.is_success() {
        persist_response_cookies(profile_id, session, &headers)?;
    }
    Ok(PanelReply { status, value })
}

async fn send(
    profile_id: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    failure: &str,
) -> Result<serde_json::Value, AppError> {
    let session = super::panel_session(profile_id)?;
    send_with_session(profile_id, &session, method, path, body, failure).await
}

async fn send_with_session(
    profile_id: &str,
    session: &PanelSession,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    failure: &str,
) -> Result<serde_json::Value, AppError> {
    let reply = request_raw_with_session(profile_id, session, method, path, body, failure).await?;
    if !reply.status.is_success() {
        return Err(status_error(reply.status, failure));
    }
    Ok(reply.value)
}

/// 401 and 403 reject the stored panel session. Profile probes and panel requests share
/// this set so a later auth status is classified in one place. 419 and 429 stay with the
/// caller until a panel response shows they mean the session itself.
pub(crate) fn session_rejected(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 401 | 403)
}

pub(crate) fn session_expired(detail: impl Into<String>) -> AppError {
    AppError::new(
        "E_HERMES_PANEL_AUTH",
        "Hermes Panel session expired. Sign in again.",
    )
    .with_detail(detail)
}

pub(crate) fn session_missing() -> AppError {
    AppError::new(
        "E_HERMES_PANEL_AUTH",
        "Hermes Panel session is missing. Sign in again.",
    )
}

/// A non-2xx panel response, classified so callers can tell "sign in again" (401/403)
/// from "this host has no such route" (404). Reporting every failure as an auth error
/// left the history list unable to degrade when an older host lacks an endpoint.
/// The message stays the operation failure; the sign-in sheet keys off the auth code.
fn status_error(status: reqwest::StatusCode, failure: &str) -> AppError {
    let code = if session_rejected(status) {
        "E_HERMES_PANEL_AUTH"
    } else if status.as_u16() == 404 {
        "E_HERMES_PANEL_UNSUPPORTED"
    } else {
        "E_HERMES_PANEL"
    };
    AppError::new(code, failure).with_detail(format!("Panel request returned {status}."))
}

/// Same classification as [`status_error`], but with the host's own `detail` text.
/// Diagnostics keep the backend message (for example `Profile 'x' does not exist.`).
pub(crate) fn reply_error(
    status: reqwest::StatusCode,
    failure: &str,
    detail: impl Into<String>,
) -> AppError {
    if session_rejected(status) {
        return session_expired(detail);
    }
    let code = if status.as_u16() == 404 {
        "E_HERMES_PANEL_UNSUPPORTED"
    } else {
        "E_HERMES_PANEL"
    };
    AppError::new(code, failure).with_detail(detail)
}

async fn get_json(profile_id: &str, path: &str) -> Result<serde_json::Value, AppError> {
    send(
        profile_id,
        reqwest::Method::GET,
        path,
        None,
        "Could not read panel data.",
    )
    .await
}

fn named_profile(profile: Option<&str>) -> Option<&str> {
    profile
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "default")
}

/// Scope a panel request to one Hermes profile. `default` is the host's own profile and
/// takes no parameter; anything unnameable is dropped rather than sent.
fn profile_query(profile: Option<&str>) -> Option<String> {
    let name = named_profile(profile)?;
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(format!("profile={}", urlencoding::encode(name)))
}

fn with_profile(path: String, profile: Option<&str>) -> String {
    match profile_query(profile) {
        Some(query) => {
            let separator = if path.contains('?') { '&' } else { '?' };
            format!("{path}{separator}{query}")
        }
        None => path,
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn build_file_url(
    base: &str,
    route: &str,
    path: &str,
    profile: Option<&str>,
    session_id: Option<&str>,
    ticket: Option<&str>,
) -> Result<String, AppError> {
    let mut url = reqwest::Url::parse(&format!("{}{route}", base.trim_end_matches('/'))).map_err(
        |error| {
            AppError::new("E_HERMES_MEDIA", "Could not prepare the Hermes media URL.")
                .with_detail(error.to_string())
        },
    )?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("path", path);
        if let Some(profile) = named_profile(profile) {
            query.append_pair("profile", profile);
        }
        if let Some(session_id) = non_empty(session_id) {
            query.append_pair("session_id", session_id);
        }
        if let Some(ticket) = ticket.filter(|ticket| !ticket.is_empty()) {
            query.append_pair("ticket", ticket);
        }
    }
    Ok(url.to_string())
}

const MAX_IMAGE_DATA_URL_BYTES: usize = 24 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES: usize = MAX_IMAGE_DATA_URL_BYTES + 64 * 1024;

fn image_too_large() -> AppError {
    AppError::new(
        "E_HERMES_MEDIA",
        "This Hermes image is too large to preview.",
    )
}

fn validate_image_data_url(data: &str) -> Result<(), AppError> {
    if data.is_empty() {
        return Err(AppError::new(
            "E_HERMES_MEDIA",
            "Hermes panel returned no image data.",
        ));
    }
    // The panel is another process: never let its response turn into an arbitrary navigation or
    // a payload larger than the documented image cap.
    if !data
        .get(.."data:image/".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:image/"))
    {
        return Err(AppError::new(
            "E_HERMES_MEDIA",
            "Hermes panel returned an unsupported image payload.",
        ));
    }
    if data.len() > MAX_IMAGE_DATA_URL_BYTES {
        return Err(image_too_large());
    }
    Ok(())
}

/// The image route returns a data URL inside JSON, so cap the response while reading it instead
/// of buffering an unbounded body and rejecting it afterwards.
async fn get_image_json(profile_id: &str, path: &str) -> Result<serde_json::Value, AppError> {
    let session = super::panel_session(profile_id)?;
    let client = transfer_client()?;
    let mut response = client
        .get(format!("{}{}", session.base_url, path))
        .header(COOKIE, cookie_header(&session))
        .send()
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_MEDIA", "Could not read this Hermes image.")
                .with_detail(error.to_string())
        })?;
    let status = response.status();
    let headers = response.headers().clone();
    if status.is_success() {
        persist_response_cookies(profile_id, &session, &headers)?;
    }
    if !status.is_success() {
        return Err(status_error(status, "Could not read this Hermes image."));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_IMAGE_RESPONSE_BYTES as u64)
    {
        return Err(image_too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        AppError::new("E_HERMES_MEDIA", "Could not read this Hermes image.")
            .with_detail(error.to_string())
    })? {
        if body.len().saturating_add(chunk.len()) > MAX_IMAGE_RESPONSE_BYTES {
            return Err(image_too_large());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|error| {
        AppError::new(
            "E_HERMES_MEDIA",
            "Hermes panel returned an invalid image response.",
        )
        .with_detail(error.to_string())
    })
}

/// `GET /api/fs/read-data-url` for a panel-owned image. The panel caps the payload (16 MiB).
pub async fn read_data_url(
    profile_id: &str,
    path: &str,
    profile: Option<&str>,
    session_id: Option<&str>,
) -> Result<String, AppError> {
    let mut route = format!("/api/fs/read-data-url?path={}", urlencoding::encode(path));
    if let Some(session_id) = non_empty(session_id) {
        route.push_str("&session_id=");
        route.push_str(&urlencoding::encode(session_id));
    }
    let value = get_image_json(profile_id, &with_profile(route, profile)).await?;
    let data = value
        .as_str()
        .or_else(|| value.get("dataUrl").and_then(serde_json::Value::as_str))
        .unwrap_or_default();
    validate_image_data_url(data)?;
    Ok(data.to_owned())
}

/// Mint the path-bound ticket the panel's stream/download routes accept without a cookie.
async fn file_ticket(
    profile_id: &str,
    session: &PanelSession,
    route: &str,
    path: &str,
    profile: Option<&str>,
    session_id: Option<&str>,
) -> Result<String, AppError> {
    let body = serde_json::json!({
        "route": route,
        "path": path,
        "profile": named_profile(profile),
        "session_id": non_empty(session_id),
    });
    let value = send_with_session(
        profile_id,
        session,
        reqwest::Method::POST,
        "/api/files/ticket",
        Some(body),
        "Could not prepare this Hermes file.",
    )
    .await?;
    value
        .get("ticket")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            AppError::new(
                "E_HERMES_MEDIA",
                "Hermes panel did not return a file ticket.",
            )
        })
}

/// One panel stream the loopback proxy may fetch. `cookie` is set only when the panel is a
/// dashboard: that surface answers 404 for `POST /api/files/ticket` (`browser_files` is webapp-only)
/// but still serves `/api/files/stream` to the session cookie.
pub(crate) struct PanelStreamRequest {
    pub url: String,
    pub cookie: Option<String>,
}

pub(crate) async fn file_stream_request(
    profile_id: &str,
    path: &str,
    profile: Option<&str>,
    session_id: Option<&str>,
) -> Result<PanelStreamRequest, AppError> {
    // One snapshot for the URL, the ticket request and the fallback cookie: a relogin that
    // lands while the ticket is minted must not pair the old base with the new cookies.
    let session = super::panel_session(profile_id)?;
    let base = session.base_url.clone();
    match file_ticket(profile_id, &session, "stream", path, profile, session_id).await {
        Ok(ticket) => Ok(PanelStreamRequest {
            url: build_file_url(
                &base,
                "/api/files/stream",
                path,
                profile,
                session_id,
                Some(&ticket),
            )?,
            cookie: None,
        }),
        Err(error) if error.code == "E_HERMES_PANEL_UNSUPPORTED" => Ok(PanelStreamRequest {
            url: build_file_url(&base, "/api/files/stream", path, profile, session_id, None)?,
            cookie: Some(cookie_header(&session)),
        }),
        Err(error) => Err(error),
    }
}

pub async fn file_download_url(
    profile_id: &str,
    path: &str,
    profile: Option<&str>,
    session_id: Option<&str>,
) -> Result<String, AppError> {
    let session = super::panel_session(profile_id)?;
    let base = session.base_url.clone();
    match file_ticket(profile_id, &session, "download", path, profile, session_id).await {
        Ok(ticket) => build_file_url(
            &base,
            "/api/fs/download",
            path,
            profile,
            session_id,
            Some(&ticket),
        ),
        // The browser that opens this URL has no panel cookie. A dashboard cannot mint a ticket,
        // so the file is saved here and opened as a local path.
        Err(error) if error.code == "E_HERMES_PANEL_UNSUPPORTED" => {
            download_for_open(profile_id, &session, path, profile, session_id).await
        }
        Err(error) => Err(error),
    }
}

const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const DOWNLOAD_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

fn download_file_name(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path).trim();
    let mut name = String::new();
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            name.push(ch);
        } else {
            name.push('_');
        }
    }
    let name = name.trim_matches('.').to_owned();
    if name.is_empty() {
        "download".to_owned()
    } else {
        name
    }
}

async fn cleanup_stale_downloads(dir: &std::path::Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let now = std::time::SystemTime::now();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let stale = entry
            .metadata()
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > DOWNLOAD_MAX_AGE);
        if stale {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

async fn download_for_open(
    profile_id: &str,
    session: &PanelSession,
    path: &str,
    profile: Option<&str>,
    session_id: Option<&str>,
) -> Result<String, AppError> {
    let url = build_file_url(
        &session.base_url,
        "/api/fs/download",
        path,
        profile,
        session_id,
        None,
    )?;
    let mut response = transfer_client()?
        .get(url)
        .header(COOKIE, cookie_header(session))
        .send()
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_MEDIA", "Could not download this Hermes file.")
                .with_detail(error.to_string())
        })?;
    let status = response.status();
    let headers = response.headers().clone();
    if status.is_success() {
        persist_response_cookies(profile_id, session, &headers)?;
    }
    if !status.is_success() {
        return Err(status_error(status, "Could not download this Hermes file."));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
    {
        return Err(AppError::new(
            "E_HERMES_MEDIA",
            "This Hermes file is too large to download.",
        ));
    }
    let dir = std::env::temp_dir().join("opennavo-hermes-media");
    tokio::fs::create_dir_all(&dir).await.map_err(|error| {
        AppError::new("E_HERMES_MEDIA", "Could not download this Hermes file.")
            .with_detail(error.to_string())
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).await;
    }
    cleanup_stale_downloads(&dir).await;
    let file_path = dir.join(format!(
        "{}-{}",
        uuid::Uuid::new_v4().simple(),
        download_file_name(path)
    ));
    stream_download_to(&mut response, &file_path).await?;
    Ok(file_path.to_string_lossy().into_owned())
}

/// Removes a partially written download unless the caller keeps it. A dropped future (window
/// closed, request superseded) runs this too, so retries cannot accumulate half files.
struct PendingDownload {
    path: Option<std::path::PathBuf>,
}

impl PendingDownload {
    fn new(path: &std::path::Path) -> Self {
        Self {
            path: Some(path.to_path_buf()),
        }
    }
}

impl Drop for PendingDownload {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

async fn stream_download_to(
    response: &mut reqwest::Response,
    file_path: &std::path::Path,
) -> Result<(), AppError> {
    use tokio::io::AsyncWriteExt;
    let mut pending = PendingDownload::new(file_path);
    let mut file = tokio::fs::File::create(file_path).await.map_err(|error| {
        AppError::new("E_HERMES_MEDIA", "Could not download this Hermes file.")
            .with_detail(error.to_string())
    })?;
    let mut written = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        AppError::new("E_HERMES_MEDIA", "Could not download this Hermes file.")
            .with_detail(error.to_string())
    })? {
        written = written.saturating_add(chunk.len() as u64);
        if written > MAX_DOWNLOAD_BYTES {
            return Err(AppError::new(
                "E_HERMES_MEDIA",
                "This Hermes file is too large to download.",
            ));
        }
        file.write_all(&chunk).await.map_err(|error| {
            AppError::new("E_HERMES_MEDIA", "Could not download this Hermes file.")
                .with_detail(error.to_string())
        })?;
    }
    file.flush().await.map_err(|error| {
        AppError::new("E_HERMES_MEDIA", "Could not download this Hermes file.")
            .with_detail(error.to_string())
    })?;
    // Only a complete, flushed file is kept.
    pending.path = None;
    Ok(())
}

/// `GET /api/sessions` path. Each Hermes profile keeps its own session store on the host,
/// so the list has to be scoped or every profile shows the same conversations.
///
/// `exclude_sources=cron` mirrors the panel's own sidebar: scheduled jobs are not
/// conversations, and without the filter one hourly job pushes every real chat off the first
/// page (one busy panel held 135 cron rows against 5 real ones). `order=recent` keeps a long
/// chat on page one after it compresses onto a fresh id, and `min_messages=1` drops the empty
/// rows the CLI leaves behind.
pub fn sessions_path(profile: Option<&str>, limit: usize, offset: usize) -> String {
    with_profile(
        format!(
            "/api/sessions?limit={}&offset={}&order=recent&min_messages=1&exclude_sources=cron",
            limit.clamp(1, 100),
            offset
        ),
        profile,
    )
}

/// External messaging platforms. Mirrors the host's gateway adapters and the panel's own
/// desktop (`MESSAGING_SESSION_SOURCE_IDS`): each one is a gateway conversation, and the
/// panel's sidebar never mixes them into recents.
pub const MESSAGING_SOURCES: &[&str] = &[
    "telegram",
    "discord",
    "slack",
    "mattermost",
    "matrix",
    "signal",
    "whatsapp",
    "bluebubbles",
    "photon",
    "homeassistant",
    "email",
    "sms",
    "webhook",
    "api_server",
    "weixin",
    "wecom",
    "qqbot",
    "yuanbao",
    "dingtalk",
    "feishu",
];

/// Sources that run on the host itself rather than on a messaging platform.
const LOCAL_SOURCES: &[&str] = &[
    "acp", "cli", "codex", "desktop", "gateway", "kanban", "local", "oneshot", "tui",
];

/// Rows that are plumbing, never conversations a person opens from a history list.
const INTERNAL_SOURCES: &[&str] = &["acp", "kanban", "oneshot", "subagent", "tool"];

/// One view of the panel's session store. The client asks for a slice at a time, the same
/// way the panel's own desktop keeps recents, per-platform threads, scheduled jobs and the
/// archive apart instead of interleaving them on one page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistorySlice {
    Recents,
    Messaging,
    Cron,
    Archived,
}

impl HistorySlice {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "recents" => Some(Self::Recents),
            "messaging" => Some(Self::Messaging),
            "cron" => Some(Self::Cron),
            "archived" => Some(Self::Archived),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recents => "recents",
            Self::Messaging => "messaging",
            Self::Cron => "cron",
            Self::Archived => "archived",
        }
    }

    /// `archived` filter for this view: the archive is its own list, everything else hides it.
    fn archived(self) -> &'static str {
        match self {
            Self::Archived => "only",
            _ => "exclude",
        }
    }

    /// An included source, used by the scheduled-jobs view.
    fn source(self) -> Option<&'static str> {
        match self {
            Self::Cron => Some("cron"),
            _ => None,
        }
    }

    fn excludes(self) -> Vec<&'static str> {
        match self {
            // Scheduled jobs are their own list. Leaving `cron` out here put every routine run
            // (they are frequent and chatty) on top of the person's real conversations — the
            // panel's own desktop excludes it for the same reason.
            Self::Recents => std::iter::once("cron")
                .chain(INTERNAL_SOURCES.iter().copied())
                .chain(MESSAGING_SOURCES.iter().copied())
                .collect(),
            // A gateway thread is a conversation on an external platform: the host's own sources
            // (and the plumbing rows) have no place in this list either.
            Self::Messaging => std::iter::once("cron")
                .chain(LOCAL_SOURCES.iter().copied())
                .chain(
                    INTERNAL_SOURCES
                        .iter()
                        .copied()
                        .filter(|id| !LOCAL_SOURCES.contains(id)),
                )
                .collect(),
            Self::Cron => Vec::new(),
            Self::Archived => INTERNAL_SOURCES
                .iter()
                .copied()
                .chain(std::iter::once("cron"))
                .collect(),
        }
    }
}

pub struct HistoryQuery<'a> {
    pub slice: HistorySlice,
    pub profile: Option<&'a str>,
    /// Read every profile's store through the host's aggregated endpoint.
    pub all_profiles: bool,
    pub limit: usize,
    pub offset: usize,
}

fn history_param(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

/// One slice of the panel's store. `all_profiles` rides `/api/profiles/sessions`, which opens
/// every profile's `state.db` on the host and tags rows with their owning profile; the
/// per-profile view keeps `/api/sessions` so older hosts still work.
pub fn history_path(query: &HistoryQuery<'_>) -> String {
    let base = if query.all_profiles {
        "/api/profiles/sessions"
    } else {
        "/api/sessions"
    };
    let mut params = vec![
        format!("limit={}", query.limit.clamp(1, 200)),
        format!("offset={}", query.offset),
        "order=recent".to_owned(),
        "min_messages=1".to_owned(),
        format!("archived={}", query.slice.archived()),
    ];
    if let Some(source) = query.slice.source() {
        params.push(format!("source={source}"));
    }
    let excludes = query.slice.excludes();
    if !excludes.is_empty() {
        let joined = excludes
            .iter()
            .map(|id| history_param(id))
            .collect::<Vec<_>>()
            .join(",");
        params.push(format!("exclude_sources={joined}"));
    }
    if query.all_profiles {
        params.push("profile=all".to_owned());
    } else if let Some(profile) = profile_query(query.profile) {
        params.push(profile);
    }
    format!("{base}?{}", params.join("&"))
}

/// `order=latest` pages from the newest turn, which is the view the panel's own desktop opens:
/// anchoring at the oldest turn hid the current state of a long conversation. `offset` counts
/// back from that newest row, so the next older page is `offset = rows already loaded`.
pub fn messages_path(
    profile: Option<&str>,
    session_id: &str,
    limit: usize,
    offset: usize,
) -> String {
    with_profile(
        format!(
            "/api/sessions/{}/messages?limit={}&offset={}&order=latest",
            urlencoding::encode(session_id),
            limit.clamp(1, 200),
            offset
        ),
        profile,
    )
}

/// The session row itself, for the sidebar mutations (rename, delete).
pub fn session_path(profile: Option<&str>, session_id: &str) -> String {
    with_profile(
        format!("/api/sessions/{}", urlencoding::encode(session_id)),
        profile,
    )
}

/// `DELETE` carries the mutation fence in the query string; `PATCH` carries it in the body.
///
/// The panel refuses an unfenced write (409 `client_upgrade_required`) because a second client
/// may have moved the row: `expected_revision` is the row's `runtime_revision` and
/// `expected_generation` its `runtime_generation` (the panel requires the generation for a
/// delete). `request_id` makes an exact retry replay instead of applying twice.
pub fn delete_path(
    profile: Option<&str>,
    session_id: &str,
    request_id: &str,
    expected_revision: i64,
    expected_generation: i64,
) -> String {
    with_profile(
        format!(
            "/api/sessions/{}?request_id={}&expected_revision={}&expected_generation={}",
            urlencoding::encode(session_id),
            urlencoding::encode(request_id),
            expected_revision.max(0),
            expected_generation.max(0)
        ),
        profile,
    )
}

pub async fn sessions(
    profile_id: &str,
    profile: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<String, AppError> {
    let value = get_json(profile_id, &sessions_path(profile, limit, offset)).await?;
    serde_json::to_string(&value).map_err(|error| {
        AppError::new("E_HERMES_PANEL", "Could not encode panel sessions.")
            .with_detail(error.to_string())
    })
}

/// Read one history slice and normalize the envelope.
///
/// A host without `/api/profiles/sessions` (older than 0.23) answers 404: the same slice is
/// retried per-profile and reported as `degraded`, so the list stays usable and the UI can
/// say why the cross-profile view is missing.
pub async fn history(
    profile_id: &str,
    profile: Option<&str>,
    all_profiles: bool,
    slice: &str,
    limit: usize,
    offset: usize,
) -> Result<String, AppError> {
    let slice = HistorySlice::parse(slice)
        .ok_or_else(|| AppError::new("E_HERMES_PANEL_INPUT", "Unknown history slice."))?;
    let query = HistoryQuery {
        slice,
        profile,
        all_profiles,
        limit,
        offset,
    };
    let (value, degraded) = match get_json(profile_id, &history_path(&query)).await {
        Ok(value) => (value, false),
        Err(error) if all_profiles && error.code == "E_HERMES_PANEL_UNSUPPORTED" => {
            let fallback = HistoryQuery {
                all_profiles: false,
                ..query
            };
            (get_json(profile_id, &history_path(&fallback)).await?, true)
        }
        Err(error) => return Err(error),
    };
    serde_json::to_string(&history_payload(
        slice,
        all_profiles,
        degraded,
        limit,
        offset,
        &value,
    ))
    .map_err(|error| {
        AppError::new("E_HERMES_PANEL", "Could not encode panel history.")
            .with_detail(error.to_string())
    })
}

/// The renderer should never have to know which endpoint answered. Trimmed to the fields the
/// sidebar reads, plus the paging signal the host's `total` only implies.
fn history_payload(
    slice: HistorySlice,
    all_profiles: bool,
    degraded: bool,
    limit: usize,
    offset: usize,
    value: &serde_json::Value,
) -> serde_json::Value {
    let rows = value
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = value
        .get("total")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(rows.len() as u64);
    let seen = rows.len() as u64 + offset as u64;
    let profile_totals = value
        .get("profile_totals")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "slice": slice.as_str(),
        "allProfiles": all_profiles && !degraded,
        "degraded": degraded,
        "sessions": rows,
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": !rows.is_empty() && seen < total,
        "profileTotals": profile_totals,
    })
}

/// Archive or restore one panel session. Same fenced mutation as rename: the panel refuses an
/// unfenced write once a second client may have moved the row.
pub async fn set_archived(
    profile_id: &str,
    profile: Option<&str>,
    session_id: &str,
    archived: bool,
    expected_revision: i64,
    expected_generation: i64,
) -> Result<(), AppError> {
    send(
        profile_id,
        reqwest::Method::PATCH,
        &session_path(profile, session_id),
        Some(serde_json::json!({
            "archived": archived,
            "request_id": uuid::Uuid::now_v7().to_string(),
            "expected_revision": expected_revision.max(0),
            "expected_generation": expected_generation.max(0)
        })),
        "Could not change the panel conversation's archive state.",
    )
    .await?;
    Ok(())
}

pub async fn messages(
    profile_id: &str,
    session_id: &str,
    profile: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<String, AppError> {
    let value = get_json(
        profile_id,
        &messages_path(profile, session_id, limit, offset),
    )
    .await?;
    serde_json::to_string(&value).map_err(|error| {
        AppError::new("E_HERMES_PANEL", "Could not encode panel messages.")
            .with_detail(error.to_string())
    })
}

/// Rename a panel session. The panel keeps one authoritative sidebar revision, so a
/// local-only rename would be overwritten the next time the list is read.
pub async fn rename(
    profile_id: &str,
    profile: Option<&str>,
    session_id: &str,
    title: &str,
    expected_revision: i64,
    expected_generation: i64,
) -> Result<(), AppError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::new(
            "E_HERMES_PANEL_INPUT",
            "A conversation title is required.",
        ));
    }
    send(
        profile_id,
        reqwest::Method::PATCH,
        &session_path(profile, session_id),
        Some(serde_json::json!({
            "title": title,
            "request_id": uuid::Uuid::now_v7().to_string(),
            "expected_revision": expected_revision.max(0),
            "expected_generation": expected_generation.max(0)
        })),
        "Could not rename the panel conversation.",
    )
    .await?;
    Ok(())
}

/// Delete a panel session. Hiding the row locally only made it reappear on the next read.
pub async fn delete(
    profile_id: &str,
    profile: Option<&str>,
    session_id: &str,
    expected_revision: i64,
    expected_generation: i64,
) -> Result<(), AppError> {
    let request_id = uuid::Uuid::now_v7().to_string();
    send(
        profile_id,
        reqwest::Method::DELETE,
        &delete_path(
            profile,
            session_id,
            &request_id,
            expected_revision,
            expected_generation,
        ),
        None,
        "Could not delete the panel conversation.",
    )
    .await?;
    Ok(())
}

pub async fn cookie_header_for(profile_id: &str) -> Result<String, AppError> {
    let session = super::panel_session(profile_id)?;
    Ok(cookie_header(&session))
}

/// URL and ticket from one session snapshot. Callers that pair `base_url_for` with
/// `ticket_for` could mix two logins (or two hosts on the same id) across the await.
#[derive(Debug)]
pub(crate) struct PanelTicketRequest {
    pub base_url: String,
    pub ticket: String,
}

pub(crate) fn session_changed() -> AppError {
    AppError::new(
        "E_HERMES_PANEL",
        "The Hermes Panel login changed while this request was being prepared. Try again.",
    )
}

pub(crate) fn session_login_id(profile_id: &str) -> Result<String, AppError> {
    Ok(super::panel_session(profile_id)?.login_id)
}

pub(crate) async fn ticket_request(profile_id: &str) -> Result<PanelTicketRequest, AppError> {
    let session = super::panel_session(profile_id)?;
    ticket_for_login(profile_id, &session.login_id).await
}

/// Mint for the same login captured before an attachment read. The latest cookies of that
/// login are used (a legal rotation may have landed), and the login identity is checked again
/// after the network call. A different login is rejected even if the response has no
/// Set-Cookie. Rotation CAS still uses the full snapshot that produced the response.
pub(crate) async fn ticket_for_login(
    profile_id: &str,
    expected_login: &str,
) -> Result<PanelTicketRequest, AppError> {
    let latest = super::panel_session(profile_id)?;
    if latest.login_id != expected_login {
        return Err(session_changed());
    }
    let (ticket, refreshed) = ticket_with_refresh(&latest).await?;
    // The response may have taken long enough for a re-login to land. Its login id decides;
    // a normal response with no Set-Cookie must not keep using a replaced login.
    let after = super::panel_session(profile_id)?;
    if after.login_id != latest.login_id {
        return Err(session_changed());
    }
    if let Some(refreshed) = refreshed {
        // Failure means a newer rotation won; never overwrite it. The ticket itself is valid.
        let _ = super::panel_session_update_if(profile_id, &latest, &refreshed)?;
    }
    Ok(PanelTicketRequest {
        base_url: latest.base_url,
        ticket,
    })
}

pub async fn ticket_for(profile_id: &str) -> Result<String, AppError> {
    Ok(ticket_request(profile_id).await?.ticket)
}

pub fn has_session(profile_id: &str) -> bool {
    super::panel_session(profile_id).is_ok()
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn omits_the_profile_for_the_hosts_own_profile() {
        assert_eq!(
            sessions_path(None, 20, 0),
            "/api/sessions?limit=20&offset=0&order=recent&min_messages=1&exclude_sources=cron"
        );
        assert_eq!(
            sessions_path(Some("default"), 20, 0),
            "/api/sessions?limit=20&offset=0&order=recent&min_messages=1&exclude_sources=cron"
        );
        assert_eq!(
            sessions_path(Some("   "), 20, 0),
            "/api/sessions?limit=20&offset=0&order=recent&min_messages=1&exclude_sources=cron"
        );
    }

    #[test]
    fn hides_scheduled_jobs_and_sorts_by_latest_activity() {
        // Cron rows are not conversations: one hourly job pushed every real chat off page one.
        let path = sessions_path(None, 20, 0);
        assert!(path.contains("exclude_sources=cron"));
        assert!(path.contains("order=recent"));
        assert!(path.contains("min_messages=1"));
    }

    #[test]
    fn scopes_the_list_to_a_named_profile() {
        assert_eq!(
            sessions_path(Some("aso"), 20, 40),
            "/api/sessions?limit=20&offset=40&order=recent&min_messages=1&exclude_sources=cron&profile=aso"
        );
    }

    #[test]
    fn drops_a_profile_name_that_cannot_be_a_directory() {
        // Never forward something the host would reject or misresolve.
        assert_eq!(
            sessions_path(Some("../../etc"), 20, 0),
            "/api/sessions?limit=20&offset=0&order=recent&min_messages=1&exclude_sources=cron"
        );
    }

    #[test]
    fn scopes_message_reads_too() {
        assert_eq!(
            messages_path(Some("aso"), "abc", 120, 0),
            "/api/sessions/abc/messages?limit=120&offset=0&order=latest&profile=aso"
        );
        assert_eq!(
            messages_path(None, "abc", 120, 240),
            "/api/sessions/abc/messages?limit=120&offset=240&order=latest"
        );
        // A caller cannot ask for more than the panel's own page cap.
        assert_eq!(
            messages_path(None, "abc", 10_000, 0),
            "/api/sessions/abc/messages?limit=200&offset=0&order=latest"
        );
    }

    #[test]
    fn builds_the_row_path_for_sidebar_mutations() {
        assert_eq!(session_path(None, "abc"), "/api/sessions/abc");
        // The first query separator is `?`, not `&`.
        assert_eq!(
            session_path(Some("aso"), "abc"),
            "/api/sessions/abc?profile=aso"
        );
        assert_eq!(
            session_path(Some("aso"), "a b/c"),
            "/api/sessions/a%20b%2Fc?profile=aso"
        );
    }

    #[test]
    fn fences_a_delete_the_way_the_panel_requires() {
        // No fence = 409 client_upgrade_required, so both the revision and the generation
        // (mandatory for delete) travel in the query string.
        assert_eq!(
            delete_path(None, "abc", "req-1", 3, 0),
            "/api/sessions/abc?request_id=req-1&expected_revision=3&expected_generation=0"
        );
        assert_eq!(
            delete_path(Some("aso"), "a b", "req 2", 7, 2),
            "/api/sessions/a%20b?request_id=req%202&expected_revision=7&expected_generation=2&profile=aso"
        );
    }

    fn query(slice: HistorySlice, profile: Option<&str>, all_profiles: bool) -> String {
        history_path(&HistoryQuery {
            slice,
            profile,
            all_profiles,
            limit: 30,
            offset: 60,
        })
    }

    #[test]
    fn recents_keep_gateway_threads_out_of_the_main_list() {
        // The panel's own desktop does the same: a busy Telegram bot would otherwise bury
        // every local chat behind a page of messenger threads.
        let path = query(HistorySlice::Recents, None, false);
        assert!(path.starts_with("/api/sessions?limit=30&offset=60&order=recent&min_messages=1"));
        assert!(path.contains("archived=exclude"));
        // Scheduled jobs are a separate list. Omitting `cron` here put 38 routine runs above a
        // single real chat on a real host, which is exactly what the user saw.
        assert!(path.contains("exclude_sources=cron,"));
        assert!(path.contains("subagent"));
        assert!(path.contains("oneshot"));
        for platform in ["telegram", "discord", "slack", "whatsapp"] {
            assert!(path.contains(platform), "recents must exclude {platform}");
        }
    }

    #[test]
    fn messaging_is_the_inverse_of_recents() {
        let path = query(HistorySlice::Messaging, Some("aso"), false);
        // Every local source, plus the internal rows `LOCAL_SOURCES` does not name: a `subagent`
        // run is plumbing, not a Telegram thread.
        assert!(path.contains(
            "exclude_sources=cron,acp,cli,codex,desktop,gateway,kanban,local,oneshot,tui,subagent,tool"
        ));
        assert!(
            !path.contains("telegram"),
            "the messaging slice must not exclude platforms"
        );
        assert!(path.ends_with("&profile=aso"));
    }

    #[test]
    fn cron_rows_have_their_own_slice() {
        let path = query(HistorySlice::Cron, None, false);
        assert!(path.contains("source=cron"));
        assert!(!path.contains("exclude_sources"));
        assert!(path.contains("archived=exclude"));
    }

    #[test]
    fn the_archive_is_its_own_list() {
        let path = query(HistorySlice::Archived, Some("default"), false);
        assert!(path.contains("archived=only"));
        assert!(path.contains("exclude_sources=acp,kanban,oneshot,subagent,tool,cron"));
        // `default` is the host's own profile: no parameter, same as before.
        assert!(!path.contains("profile="));
    }

    #[test]
    fn aggregation_rides_the_profiles_endpoint() {
        let path = query(HistorySlice::Messaging, Some("aso"), true);
        assert!(path.starts_with("/api/profiles/sessions?"));
        // `profile=all` wins over the selected agent profile: the host fans out itself.
        assert!(path.ends_with("&profile=all"));
        assert!(!path.contains("profile=aso"));
    }

    #[test]
    fn drops_an_unnameable_slice_and_profile() {
        assert!(HistorySlice::parse("everything").is_none());
        assert_eq!(
            HistorySlice::parse(" archived "),
            Some(HistorySlice::Archived)
        );
        let path = query(HistorySlice::Recents, Some("../../etc"), false);
        assert!(!path.contains("profile="));
    }

    #[test]
    fn classifies_panel_status_codes() {
        let expired = status_error(
            reqwest::StatusCode::UNAUTHORIZED,
            "Could not read panel data.",
        );
        assert_eq!(expired.code, "E_HERMES_PANEL_AUTH");
        assert_eq!(expired.message, "Could not read panel data.");
        assert_eq!(
            expired.detail.as_deref(),
            Some("Panel request returned 401 Unauthorized.")
        );
        assert_eq!(
            status_error(reqwest::StatusCode::NOT_FOUND, "x").code,
            "E_HERMES_PANEL_UNSUPPORTED"
        );
        assert_eq!(
            status_error(reqwest::StatusCode::BAD_GATEWAY, "x").code,
            "E_HERMES_PANEL"
        );
        assert!(!session_rejected(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert_eq!(
            session_missing().message,
            "Hermes Panel session is missing. Sign in again."
        );
    }

    #[test]
    fn reports_more_rows_only_when_the_host_has_them() {
        let page = serde_json::json!({
            "sessions": [{"id": "a"}, {"id": "b"}],
            "total": 5
        });
        let payload = history_payload(HistorySlice::Messaging, true, false, 20, 0, &page);
        assert_eq!(payload["hasMore"], serde_json::json!(true));
        assert_eq!(payload["allProfiles"], serde_json::json!(true));
        assert_eq!(payload["slice"], serde_json::json!("messaging"));
        let last = history_payload(HistorySlice::Messaging, false, false, 20, 3, &page);
        assert_eq!(last["hasMore"], serde_json::json!(false));
        // A degraded read is per-profile: the UI must not claim an aggregate.
        let degraded = history_payload(HistorySlice::Recents, true, true, 20, 0, &page);
        assert_eq!(degraded["allProfiles"], serde_json::json!(false));
        assert_eq!(degraded["degraded"], serde_json::json!(true));
        // An empty page is a real answer, not "more to load".
        let empty = history_payload(
            HistorySlice::Recents,
            false,
            false,
            20,
            0,
            &serde_json::json!({"sessions": [], "total": 0}),
        );
        assert_eq!(empty["hasMore"], serde_json::json!(false));
    }
}

#[cfg(test)]
mod media_url_tests {
    use super::*;

    #[test]
    fn omits_the_default_profile_and_encodes_the_path_and_ticket() {
        let url = build_file_url(
            "https://panel.tail1234.ts.net:9119",
            "/api/files/stream",
            "/home/kaka/.hermes/cache/scratch/sample scene.mp4",
            Some("default"),
            Some("session 1"),
            Some("ticket+/="),
        )
        .unwrap();
        assert!(url.starts_with("https://panel.tail1234.ts.net:9119/api/files/stream?"));
        assert!(url.contains("path=%2Fhome%2Fkaka%2F.hermes%2Fcache%2Fscratch%2Fsample+scene.mp4"));
        assert!(!url.contains("profile="));
        assert!(url.contains("session_id=session+1"));
        assert!(url.contains("ticket=ticket%2B%2F%3D"));
    }

    #[test]
    fn keeps_a_named_profile_in_the_file_query() {
        let url = build_file_url(
            "http://100.64.0.9:9119",
            "/api/fs/download",
            "/tmp/a.pdf",
            Some("aso"),
            None,
            Some("abc"),
        )
        .unwrap();
        assert!(url.contains("profile=aso"));
        assert!(url.contains("ticket=abc"));
    }

    #[test]
    fn cookie_fetch_omits_the_ticket_query() {
        let url = build_file_url(
            "http://100.64.0.9:9119",
            "/api/files/stream",
            "/tmp/clip.mp4",
            None,
            None,
            None,
        )
        .unwrap();
        assert!(!url.contains("ticket="));
        assert!(url.contains("path=%2Ftmp%2Fclip.mp4"));
    }

    #[test]
    fn download_names_keep_the_extension_and_drop_directories() {
        assert_eq!(download_file_name("/tmp/a b.pdf"), "a_b.pdf");
        assert_eq!(download_file_name(r"C:\shots\..\note.txt"), "note.txt");
        assert_eq!(download_file_name(".."), "download");
        assert_eq!(download_file_name(""), "download");
    }

    #[test]
    fn only_accepts_bounded_image_data_urls() {
        assert!(validate_image_data_url("data:image/png;base64,AAAA").is_ok());
        assert!(validate_image_data_url("DATA:IMAGE/PNG;base64,AAAA").is_ok());
        assert!(validate_image_data_url("https://panel.example/a.png").is_err());
        assert!(validate_image_data_url("data:text/html;base64,AAAA").is_err());
        assert!(validate_image_data_url("").is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_cookies(values: &[&'static str]) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        for value in values {
            headers.append(SET_COOKIE, reqwest::header::HeaderValue::from_static(value));
        }
        headers
    }

    #[test]
    fn ignores_the_deletion_cookies_sent_with_a_rejected_session() {
        // The panel's expired-session response clears both cookies. Storing the quoted empty
        // values as tokens would replace a session that logged in while this response was in
        // flight, and every later request would carry the dead value.
        let headers = set_cookies(&[
            "hermes_session_at=\"\"; HttpOnly; Max-Age=0",
            "hermes_session_rt=\"\"; HttpOnly; Max-Age=0",
        ]);
        assert_eq!(cookie_value(&headers, "hermes_session_at"), None);
        assert_eq!(cookie_value(&headers, "hermes_session_rt"), None);
        assert_eq!(
            cookie_value(&headers, "hermes_session_at=; Max-Age=0"),
            None
        );
    }

    #[test]
    fn a_rejected_session_never_rotates_the_stored_tokens() {
        let session = PanelSession {
            base_url: "http://panel.tail1234.ts.net:9119".to_owned(),
            provider: "basic".to_owned(),
            access_token: "access-token".to_owned(),
            refresh_token: "refresh-token".to_owned(),
            login_id: "smoke-login".to_owned(),
        };
        let cleared = set_cookies(&[
            "hermes_session_at=\"\"; HttpOnly; Max-Age=0",
            "hermes_session_rt=\"\"; HttpOnly; Max-Age=0",
        ]);
        // `None` keeps the caller from writing anything: the stored session is untouched.
        assert!(refreshed_session(&session, &cleared).is_none());
    }

    #[test]
    fn keeps_the_real_cookie_value_verbatim() {
        let headers = set_cookies(&[
            "hermes_session_at=access-token; Path=/; HttpOnly",
            "hermes_session_rt=refresh-token; Path=/; HttpOnly",
        ]);
        assert_eq!(
            cookie_value(&headers, "hermes_session_at").as_deref(),
            Some("access-token")
        );
        assert_eq!(
            cookie_value(&headers, "hermes_session_rt").as_deref(),
            Some("refresh-token")
        );
        // Multiple Set-Cookie rows: an unrelated name must not mask the one asked for.
        assert_eq!(cookie_value(&headers, "hermes_session_pkce"), None);
    }

    /// Real-host smoke test for the history slices: every slice must come back with the
    /// envelope the renderer expects, and the two lists a person opens must not be empty on a
    /// panel that has gateway traffic. Tokens come from the environment so nothing is stored.
    ///
    /// ```sh
    /// HERMES_PANEL_URL=http://100.64.0.9:9119 \
    /// HERMES_PANEL_AT=<session cookie> HERMES_PANEL_RT=<refresh cookie> \
    /// cargo test --lib hermes::panel::tests::reads_every_history_slice -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "requires HERMES_PANEL_URL, HERMES_PANEL_AT and HERMES_PANEL_RT"]
    async fn reads_every_history_slice_from_a_real_panel() {
        let url = std::env::var("HERMES_PANEL_URL").expect("HERMES_PANEL_URL");
        let access = std::env::var("HERMES_PANEL_AT").expect("HERMES_PANEL_AT");
        let refresh = std::env::var("HERMES_PANEL_RT").expect("HERMES_PANEL_RT");
        let profile =
            std::env::var("HERMES_PANEL_PROFILE").unwrap_or_else(|_| "default".to_owned());
        // Isolated, process-lived store root even when this test runs alone.
        super::super::use_panel_session_root();
        let session = PanelSession {
            base_url: base_url(&url).unwrap(),
            provider: "basic".to_owned(),
            access_token: access,
            refresh_token: refresh,
            login_id: "smoke-login".to_owned(),
        };
        super::super::panel_session_set("smoke", &session).unwrap();

        let agent_profile = if profile == "default" {
            None
        } else {
            Some(profile.as_str())
        };
        let mut counts = Vec::new();
        for slice in ["recents", "messaging", "cron", "archived"] {
            let raw = history("smoke", agent_profile, false, slice, 40, 0)
                .await
                .unwrap_or_else(|error| panic!("{slice} failed: {error:?}"));
            let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(value["slice"], serde_json::json!(slice));
            assert_eq!(value["degraded"], serde_json::json!(false));
            let rows = value["sessions"].as_array().map(Vec::len).unwrap_or(0);
            println!(
                "{slice:9} total={} rows={rows} sources={:?}",
                value["total"],
                value["sessions"]
                    .as_array()
                    .map(|rows| rows
                        .iter()
                        .filter_map(|row| row["source"].as_str())
                        .collect::<Vec<_>>())
                    .unwrap_or_default()
            );
            counts.push((slice, rows));
        }

        // Aggregated read: every profile on the host, tagged with its owner.
        let raw = history("smoke", agent_profile, true, "recents", 40, 0)
            .await
            .expect("aggregated recents");
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let profiles: Vec<&str> = value["sessions"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row["profile"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        println!(
            "all-profiles total={} rows={} profiles={:?} degraded={}",
            value["total"],
            profiles.len(),
            profiles,
            value["degraded"]
        );

        // A panel with local chats must answer the recents slice; gateway traffic must answer
        // the messaging slice. An empty answer here is the bug this test exists to catch.
        let recents = counts
            .iter()
            .find(|(slice, _)| *slice == "recents")
            .unwrap()
            .1;
        assert!(recents > 0, "recents came back empty");
    }

    #[tokio::test]
    #[ignore = "requires HERMES_PANEL_URL, HERMES_PANEL_USER and HERMES_PANEL_PASSWORD"]
    async fn logs_in_and_mints_a_ws_ticket() {
        let url = std::env::var("HERMES_PANEL_URL").expect("HERMES_PANEL_URL");
        let user = std::env::var("HERMES_PANEL_USER").expect("HERMES_PANEL_USER");
        let password = std::env::var("HERMES_PANEL_PASSWORD").expect("HERMES_PANEL_PASSWORD");
        let session = login(&url, &user, &password).await.unwrap();
        assert!(!session.access_token.is_empty());
        assert!(!session.refresh_token.is_empty());
        let ticket = ticket(&session).await.unwrap();
        assert!(!ticket.is_empty());
        if std::env::var("HERMES_PANEL_TEST_MODELS").as_deref() == Ok("1") {
            let query = format!("ticket={}", urlencoding::encode(&ticket));
            let options = super::super::gateway::model_options_remote_auth(
                &session.base_url,
                &query,
                None,
                true,
                true,
            )
            .await
            .unwrap();
            assert!(!options.providers.is_empty());
        }
    }
    #[tokio::test]
    #[ignore = "requires HERMES_PANEL_URL, HERMES_PANEL_USER, HERMES_PANEL_PASSWORD and HERMES_PANEL_TEST_CHAT=1"]
    async fn chats_through_a_panel_ticket() {
        if std::env::var("HERMES_PANEL_TEST_CHAT").as_deref() != Ok("1") {
            return;
        }
        let url = std::env::var("HERMES_PANEL_URL").expect("HERMES_PANEL_URL");
        let user = std::env::var("HERMES_PANEL_USER").expect("HERMES_PANEL_USER");
        let password = std::env::var("HERMES_PANEL_PASSWORD").expect("HERMES_PANEL_PASSWORD");
        let session = login(&url, &user, &password).await.unwrap();
        let first_ticket = ticket(&session).await.unwrap();
        let query = format!("ticket={}", urlencoding::encode(&first_ticket));
        let options = super::super::gateway::model_options_remote_auth(
            &session.base_url,
            &query,
            None,
            false,
            true,
        )
        .await
        .unwrap();
        let (provider, model) = options
            .providers
            .iter()
            .find_map(|item| {
                item.models
                    .first()
                    .map(|model| (item.slug.clone(), model.clone()))
            })
            .unwrap_or_else(|| ("custom".into(), "grok-4.7".into()));
        println!("panel provider={provider} model={model}");
        let chat_ticket = ticket(&session).await.unwrap();
        let query = format!("ticket={}", urlencoding::encode(&chat_ticket));
        let home = tempfile::tempdir().unwrap();
        let state = super::super::HermesRuntimeState::default();
        let input = super::super::HermesChatInput {
            prompt: "Reply with exactly PANEL_OK".into(),
            request_id: "panel-chat-test".into(),
            session_id: None,
            provider: provider.clone(),
            model: model.clone(),
            effort: "low".into(),
            fast: false,
            api_key: None,
            endpoint: None,
            cwd: None,
            attachments: Vec::new(),
            auxiliary: Vec::new(),
            force_aux_vision: false,
            gateway_url: Some(session.base_url.clone()),
            profile_id: Some("panel-test".into()),
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
        let reply = super::super::gateway::chat_remote_auth(
            &session.base_url,
            Some(&query),
            home.path(),
            &state,
            input,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(
            reply.text.contains("PANEL_OK"),
            "reply was {:?}",
            reply.text
        );
    }
    #[tokio::test]
    #[ignore = "requires HERMES_PANEL_URL, HERMES_PANEL_USER, HERMES_PANEL_PASSWORD and HERMES_PANEL_TEST_PROFILE"]
    async fn model_options_for_a_panel_profile() {
        let url = std::env::var("HERMES_PANEL_URL").expect("HERMES_PANEL_URL");
        let user = std::env::var("HERMES_PANEL_USER").expect("HERMES_PANEL_USER");
        let password = std::env::var("HERMES_PANEL_PASSWORD").expect("HERMES_PANEL_PASSWORD");
        let profile =
            std::env::var("HERMES_PANEL_TEST_PROFILE").expect("HERMES_PANEL_TEST_PROFILE");
        let session = login(&url, &user, &password).await.unwrap();
        let ticket = ticket(&session).await.unwrap();
        let query = format!("ticket={}", urlencoding::encode(&ticket));
        let options = super::super::gateway::model_options_remote_auth(
            &session.base_url,
            &query,
            Some(&profile),
            true,
            true,
        )
        .await
        .unwrap();
        println!(
            "current={:?} providers={:?}",
            options.model,
            options
                .providers
                .iter()
                .map(|provider| (
                    provider.slug.clone(),
                    provider.models.len(),
                    provider.is_current
                ))
                .collect::<Vec<_>>()
        );
        assert!(!options.providers.is_empty());
    }
}

#[cfg(test)]
mod download_tests {
    use super::*;

    #[tokio::test]
    async fn a_json_body_is_read_through_a_hard_cap() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = b"{\"value\":\"0123456789\"}";
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            socket.write_all(body).await.unwrap();
            let _ = socket.shutdown().await;
        });
        let mut response = reqwest::get(format!("http://{addr}/json")).await.unwrap();
        let error = read_json_limited(&mut response, 8).await.unwrap_err();
        assert!(error.contains("exceeded"), "{error}");
        let _ = server.await;

        // A second response within the cap parses normally.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = b"{\"ok\":true}";
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            socket.write_all(body).await.unwrap();
            let _ = socket.shutdown().await;
        });
        let mut response = reqwest::get(format!("http://{addr}/json")).await.unwrap();
        let value = read_json_limited(&mut response, 1024).await.unwrap();
        assert_eq!(value["ok"], true);
        let _ = server.await;
    }

    #[test]
    fn a_dropped_download_guard_removes_its_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("partial");
        std::fs::write(&path, b"partial").unwrap();
        {
            let _guard = PendingDownload::new(&path);
        }
        assert!(!path.exists());
    }

    /// An interrupted body is an error, and the guard removes the bytes written so far.
    #[tokio::test]
    async fn an_interrupted_body_leaves_no_file() {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            use tokio::io::AsyncReadExt;
            let mut buffer = [0_u8; 1024];
            let _ = socket.read(&mut buffer).await;
            // Promise more than is sent, then close: reqwest surfaces a body error.
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\nfirst")
                .await
                .unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("partial");
        let mut response = reqwest::get(format!("http://{addr}/file")).await.unwrap();
        let result = stream_download_to(&mut response, &path).await;
        assert!(result.is_err());
        assert!(
            !path.exists(),
            "an interrupted download left a partial file"
        );
        let _ = server.await;
    }
}

#[cfg(test)]
mod base_url_tests {
    use super::*;

    #[test]
    fn accepts_loopback_and_tailnet_and_keeps_a_path_prefix() {
        assert_eq!(base_url("http://[::1]:9119").unwrap(), "http://[::1]:9119");
        assert_eq!(
            base_url("http://127.0.0.1:9119/").unwrap(),
            "http://127.0.0.1:9119"
        );
        assert_eq!(
            base_url("http://100.64.1.2:9119").unwrap(),
            "http://100.64.1.2:9119"
        );
        assert_eq!(
            base_url("https://panel.tail1234.ts.net:9119/hermes/login").unwrap(),
            "https://panel.tail1234.ts.net:9119/hermes"
        );
    }

    #[test]
    fn rejects_insecure_non_tailnet_and_non_base_url_parts() {
        assert!(base_url("http://8.8.8.8:9119").is_err());
        assert!(base_url("https://user:pass@panel.example").is_err());
        assert!(base_url("https://panel.example/?token=1").is_err());
        assert!(base_url("https://panel.example/#frag").is_err());
        assert!(base_url("ftp://panel.example").is_err());
    }
}
