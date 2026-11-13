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

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PanelSession {
    pub base_url: String,
    pub provider: String,
    pub access_token: String,
    pub refresh_token: String,
}

fn base_url(raw: &str) -> Result<String, AppError> {
    let mut value = raw.trim().trim_end_matches('/').to_owned();
    if value.ends_with("/login") {
        value.truncate(value.len() - "/login".len());
        value = value.trim_end_matches('/').to_owned();
    }
    let value = value.as_str();
    if !(value.starts_with("http://") || value.starts_with("https://")) {
        return Err(AppError::new(
            "E_HERMES_PANEL_URL",
            "Panel URL must start with http:// or https://.",
        ));
    }
    if value.starts_with("http://") {
        let parsed = reqwest::Url::parse(value)
            .map_err(|_| AppError::new("E_HERMES_PANEL_URL", "Invalid Hermes panel URL."))?;
        let host = parsed.host_str().unwrap_or_default();
        let tailnet = host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| {
                let octets = ip.octets();
                octets[0] == 100 && (64..=127).contains(&octets[1])
            })
            .unwrap_or(false);
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
        if !tailnet && !loopback && !host.ends_with(".ts.net") {
            return Err(AppError::new(
                "E_HERMES_PANEL_URL",
                "Use HTTPS for a non-Tailscale Hermes panel.",
            ));
        }
    }
    Ok(value.to_owned())
}

fn client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| {
            AppError::new("E_HERMES_PANEL", "Could not prepare the panel request.")
                .with_detail(error.to_string())
        })
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
        if key.trim() == name {
            return Some(value.to_owned());
        }
    }
    None
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
    let providers: serde_json::Value = client
        .get(format!("{base}/api/auth/providers"))
        .send()
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_PANEL", "Could not reach the Hermes panel.")
                .with_detail(error.to_string())
        })?
        .json()
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
    })
}

fn cookie_header(session: &PanelSession) -> String {
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
    })
}

pub fn persist_response_cookies(
    profile_id: &str,
    headers: &reqwest::header::HeaderMap,
) -> Result<(), AppError> {
    let session = super::panel_session(profile_id)?;
    if let Some(refreshed) = refreshed_session(&session, headers) {
        super::panel_session_set(profile_id, &refreshed)?;
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
    let response = client
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
    let value: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
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
    let response = client
        .post(format!("{}/api/auth/ws-ticket", session.base_url))
        .header(COOKIE, cookie_header(session))
        .send()
        .await
        .map_err(|error| {
            AppError::new("E_HERMES_PANEL", "Could not mint a panel WebSocket ticket.")
                .with_detail(error.to_string())
        })?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
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

/// One authenticated panel request. Every session read and write goes through here so the
/// rotated cookies are persisted the same way for GET, PATCH and DELETE.
async fn send(
    profile_id: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    failure: &str,
) -> Result<serde_json::Value, AppError> {
    let session = super::panel_session(profile_id)?;
    let client = client()?;
    let mut request = client
        .request(method, format!("{}{}", session.base_url, path))
        .header(COOKIE, cookie_header(&session));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| AppError::new("E_HERMES_PANEL", failure).with_detail(error.to_string()))?;
    let status = response.status();
    let headers = response.headers().clone();
    persist_response_cookies(profile_id, &headers)?;
    let value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(AppError::new(
            "E_HERMES_PANEL_AUTH",
            format!("Panel request returned {status}."),
        ));
    }
    Ok(value)
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

/// Scope a panel request to one Hermes profile. `default` is the host's own profile and
/// takes no parameter; anything unnameable is dropped rather than sent.
fn profile_query(profile: Option<&str>) -> Option<String> {
    let name = profile
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "default")?;
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

pub async fn ticket_for(profile_id: &str) -> Result<String, AppError> {
    let session = super::panel_session(profile_id)?;
    let (ticket, refreshed) = ticket_with_refresh(&session).await?;
    if let Some(refreshed) = refreshed {
        super::panel_session_set(profile_id, &refreshed)?;
    }
    Ok(ticket)
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
            &query,
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
