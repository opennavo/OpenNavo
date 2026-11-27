//! Secondary Hermes profile windows.

use crate::AppError;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(crate) const PROFILE_WINDOW_PREFIX: &str = "hermes-profile-";

pub(crate) fn valid_profile_name(profile: &str) -> bool {
    !profile.is_empty()
        && profile
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Window labels allow only a small character set. The connection id is hex-encoded so two
/// connections with the same agent profile get distinct labels (`default` on a panel and on
/// this Mac used to collide and focus the wrong host). The profile is already validated to
/// `[a-z0-9_-]`, and hex contains no `-`, so the first separator is unambiguous.
pub(crate) fn profile_window_label(connection: &str, profile: &str) -> String {
    let mut encoded = String::with_capacity(connection.len() * 2);
    for byte in connection.as_bytes() {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    format!("{PROFILE_WINDOW_PREFIX}{encoded}-{profile}")
}

/// Parse a label this module created. Labels from older builds (prefix + profile, no
/// connection) still resolve to their profile so an old notification can reopen them.
pub(crate) fn profile_window_identity(label: &str) -> Option<(Option<String>, String)> {
    let rest = label.strip_prefix(PROFILE_WINDOW_PREFIX)?;
    match rest.split_once('-') {
        Some((hex, profile))
            if !hex.is_empty()
                && hex.len() % 2 == 0
                && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            if !valid_profile_name(profile) {
                return None;
            }
            let mut bytes = Vec::with_capacity(hex.len() / 2);
            for index in (0..hex.len()).step_by(2) {
                bytes.push(u8::from_str_radix(&hex[index..index + 2], 16).ok()?);
            }
            Some((Some(String::from_utf8(bytes).ok()?), profile.to_owned()))
        }
        _ if valid_profile_name(rest) => Some((None, rest.to_owned())),
        _ => None,
    }
}

/// Open (or focus) the window that owns one Hermes profile. The optional conversation is a
/// notification target: the page selects it once its own history has loaded.
pub(crate) fn open_profile_window(
    app: &AppHandle,
    connection_id: Option<&str>,
    profile: &str,
    conversation_id: Option<&str>,
) -> Result<WebviewWindow, AppError> {
    let profile = profile.trim();
    if !valid_profile_name(profile) {
        return Err(AppError::new(
            "E_HERMES_PROFILE_NAME",
            "Invalid profile name for a new window.",
        ));
    }
    let connection = connection_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local");
    let label = profile_window_label(connection, profile);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(window);
    }
    let mut url = format!(
        "index.html?profile={}&connection={}",
        urlencoding::encode(profile),
        urlencoding::encode(connection)
    );
    if let Some(conversation_id) = conversation_id.map(str::trim).filter(|id| !id.is_empty()) {
        url.push_str("&conversation=");
        url.push_str(&urlencoding::encode(conversation_id));
    }
    url.push_str("#/assistant");
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(format!("Hermes · {profile}"))
        .inner_size(1200.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .build()
        .map_err(|error| {
            AppError::new("E_HERMES_WINDOW", "Could not open the profile window.")
                .with_detail(error.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_profile_on_two_connections_gets_distinct_labels() {
        let local = profile_window_label("local", "default");
        let panel = profile_window_label("panel-1", "default");
        assert_ne!(local, panel);
        assert!(local.starts_with(PROFILE_WINDOW_PREFIX));
        assert!(super::valid_profile_name("default"));
    }

    #[test]
    fn parses_new_labels_and_legacy_profile_only_labels() {
        let label = profile_window_label("panel:work/us", "research");
        assert_eq!(
            profile_window_identity(&label),
            Some((Some("panel:work/us".to_owned()), "research".to_owned()))
        );
        assert_eq!(
            profile_window_identity("hermes-profile-research"),
            Some((None, "research".to_owned()))
        );
        assert_eq!(profile_window_identity("main"), None);
        assert_eq!(profile_window_identity("hermes-profile-"), None);
    }
}
