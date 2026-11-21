//! Per-profile diagnostics for the Hermes behind a connection.
//!
//! A profile belongs to one gateway. Local connections run the CLI against this
//! Mac's `HERMES_HOME`; Panel connections call the same REST endpoints the
//! official dashboard uses, scoped by `?profile=`. The profile name is always sent
//! explicitly on the remote path (including `default`), because an omitted
//! profile resolves to the panel process's launch profile, not the user's pick.

use reqwest::Method;
use serde_json::Value;

use super::AppError;
use super::panel::{self, PanelReply};
use super::profiles;

/// Panel connection id when both halves of the remote scope are present.
pub(crate) fn remote_connection<'a>(
    connection_id: Option<&'a str>,
    gateway_url: Option<&'a str>,
) -> Option<&'a str> {
    let connection_id = connection_id?.trim();
    let gateway_url = gateway_url?.trim();
    (!connection_id.is_empty() && !gateway_url.is_empty()).then_some(connection_id)
}

fn profile_name(profile: Option<&str>) -> Result<&str, AppError> {
    let name = profile
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("default");
    if !profiles::name_ok(name) {
        return Err(AppError::new(
            "E_HERMES_PROFILE_NAME",
            "Profile names must be lowercase letters, digits, dashes or underscores.",
        ));
    }
    Ok(name)
}

fn profile_query(profile: &str) -> String {
    format!("profile={}", urlencoding::encode(profile))
}

fn read_path(kind: &str, profile: &str) -> Result<String, AppError> {
    let query = profile_query(profile);
    match kind {
        "tools" => Ok(format!("/api/tools/toolsets?{query}")),
        "skills" => Ok(format!("/api/skills?{query}")),
        "cron" => Ok(format!("/api/cron/jobs?{query}")),
        _ => Err(AppError::new(
            "E_HERMES_INPUT",
            "Unknown Hermes diagnostics section.",
        )),
    }
}

fn response_detail(value: &Value) -> String {
    value
        .get("detail")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

/// The response body on 2xx, or the host's own error detail otherwise. A 404
/// naming a missing profile is the "this profile only exists on another
/// gateway" case, and stays a clean profile error instead of a generic panel one.
fn response_value(reply: PanelReply, failure: &str) -> Result<Value, AppError> {
    if reply.status.is_success() {
        return Ok(reply.value);
    }
    let detail = response_detail(&reply.value);
    if reply.status.as_u16() == 404 && detail.to_ascii_lowercase().contains("does not exist") {
        return Err(AppError::new(
            "E_HERMES_PROFILE",
            "The Hermes profile does not exist on this connection.",
        )
        .with_detail(detail));
    }
    Err(panel::reply_error(reply.status, failure, detail))
}

fn items(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn enabled_tag(value: &Value) -> &'static str {
    if value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "✓ enabled "
    } else {
        "✗ disabled"
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

pub(crate) fn format_tools(value: &Value, profile: &str) -> String {
    let mut out = format!("Toolsets in profile '{profile}':\n");
    let list = items(value);
    if list.is_empty() {
        out.push_str("  (none)\n");
    }
    for item in list {
        out.push_str(&format!(
            "  {}  {}  {}\n",
            enabled_tag(item),
            text(item, "name"),
            text(item, "label")
        ));
    }
    out
}

pub(crate) fn format_skills(value: &Value, profile: &str) -> String {
    let mut out = format!("Skills in profile '{profile}':\n");
    let list = items(value);
    if list.is_empty() {
        out.push_str("  (none)\n");
    }
    for item in list {
        let category = text(item, "category");
        let provenance = text(item, "provenance");
        let suffix = match (category.is_empty(), provenance.is_empty()) {
            (true, true) => String::new(),
            (false, true) => format!("  ({category})"),
            (true, false) => format!("  [{provenance}]"),
            (false, false) => format!("  ({category}, {provenance})"),
        };
        out.push_str(&format!(
            "  {}  {}{suffix}\n",
            enabled_tag(item),
            text(item, "name")
        ));
    }
    out
}

pub(crate) fn format_cron(value: &Value, profile: &str) -> String {
    let list = items(value);
    if list.is_empty() {
        return format!("No scheduled jobs in profile '{profile}'.");
    }
    let mut out = format!("Scheduled jobs in profile '{profile}':\n");
    for item in list {
        let schedule = item
            .get("schedule_display")
            .and_then(Value::as_str)
            .or_else(|| {
                item.get("schedule")
                    .and_then(|schedule| schedule.get("display"))
                    .and_then(Value::as_str)
            })
            .unwrap_or_default();
        let name = text(item, "name");
        let state = text(item, "state");
        let suffix = if state.is_empty() {
            String::new()
        } else {
            format!("  [{state}]")
        };
        out.push_str(&format!(
            "  {}  {}  {schedule}  {name}{suffix}\n",
            enabled_tag(item),
            text(item, "id")
        ));
    }
    out
}

pub(crate) fn format_mcp(value: &Value, profile: &str) -> String {
    let mut out = format!("MCP servers in profile '{profile}':\n");
    let list = value
        .get("servers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if list.is_empty() {
        out.push_str("  (none)\n");
    }
    for item in list {
        out.push_str(&format!(
            "  {}  {}\n",
            text(item, "name"),
            text(item, "transport")
        ));
    }
    out
}

pub(crate) async fn read(
    connection_id: &str,
    profile: Option<&str>,
    kind: &str,
) -> Result<String, AppError> {
    let profile = profile_name(profile)?;
    let path = read_path(kind, profile)?;
    let reply = panel::request_raw(
        connection_id,
        Method::GET,
        &path,
        None,
        "Could not read Hermes diagnostics.",
    )
    .await?;
    let value = response_value(reply, "Could not read Hermes diagnostics.")?;
    Ok(match kind {
        "tools" => format_tools(&value, profile),
        "skills" => format_skills(&value, profile),
        "cron" => format_cron(&value, profile),
        _ => unreachable!("read_path rejects unknown sections"),
    })
}

fn job_owner(value: &Value, requested: &str) -> String {
    value
        .get("profile")
        .and_then(Value::as_str)
        .or_else(|| value.get("profile_name").and_then(Value::as_str))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(requested)
        .to_owned()
}

async fn cron_job(connection_id: &str, profile: &str, job_id: &str) -> Result<Value, AppError> {
    let path = format!(
        "/api/cron/jobs/{}?{}",
        urlencoding::encode(job_id),
        profile_query(profile)
    );
    let reply = panel::request_raw(
        connection_id,
        Method::GET,
        &path,
        None,
        "Could not read the scheduled job.",
    )
    .await?;
    response_value(reply, "Could not read the scheduled job.")
}

pub(crate) async fn cron_action(
    connection_id: &str,
    profile: Option<&str>,
    action: &str,
    job_id: &str,
) -> Result<String, AppError> {
    let profile = profile_name(profile)?;
    let query = profile_query(profile);
    let job = urlencoding::encode(job_id);
    let (method, path, failure, done) = match action {
        "pause" => (
            Method::POST,
            format!("/api/cron/jobs/{job}/pause?{query}"),
            "Could not pause the scheduled job.",
            "paused",
        ),
        "resume" => (
            Method::POST,
            format!("/api/cron/jobs/{job}/resume?{query}"),
            "Could not resume the scheduled job.",
            "resumed",
        ),
        "remove" => (
            Method::DELETE,
            format!("/api/cron/jobs/{job}?{query}"),
            "Could not remove the scheduled job.",
            "removed",
        ),
        _ => return Err(AppError::new("E_HERMES_INPUT", "Unknown cron action.")),
    };

    // `?profile=` is a hint, not a fence: the host locates a job by id/name across every
    // profile and mutates the owner it finds. Read the owner first so a job from another
    // profile is refused instead of paused/resumed/deleted here. (Delete's 2xx body carries
    // no profile, so only this preflight can see the mismatch.)
    let current = cron_job(connection_id, profile, job_id).await?;
    let owner = job_owner(&current, profile);
    if owner != profile {
        return Err(AppError::new(
            "E_HERMES_PROFILE",
            format!("Scheduled job '{job_id}' belongs to profile '{owner}', not '{profile}'."),
        )
        .with_detail(format!(
            "Switch to profile '{owner}' to change this job; nothing was changed."
        )));
    }

    let reply = panel::request_raw(connection_id, method, &path, None, failure).await?;
    let value = response_value(reply, failure)?;
    // The hint is resolved again for the mutation itself. If it landed on another profile
    // (a job id shared by two profiles, or a concurrent move), report that truthfully rather
    // than claiming the selected profile changed.
    if action != "remove" {
        let applied = job_owner(&value, profile);
        if applied != profile {
            return Err(AppError::new(
                "E_HERMES_PROFILE",
                format!(
                    "Scheduled job '{job_id}' was changed in profile '{applied}', not '{profile}'."
                ),
            )
            .with_detail(format!(
                "Switch to profile '{applied}' to see it; the selected profile is unchanged."
            )));
        }
    }
    Ok(format!("Scheduled job {job_id} {done}."))
}

pub(crate) async fn tool_action(
    connection_id: &str,
    profile: Option<&str>,
    action: &str,
    name: &str,
) -> Result<String, AppError> {
    let profile = profile_name(profile)?;
    let enabled = match action {
        "enable" => true,
        "disable" => false,
        _ => return Err(AppError::new("E_HERMES_INPUT", "Unknown tool action.")),
    };
    let path = format!(
        "/api/tools/toolsets/{}?{}",
        urlencoding::encode(name),
        profile_query(profile)
    );
    let body = serde_json::json!({ "enabled": enabled, "profile": profile });
    let reply = panel::request_raw(
        connection_id,
        Method::PUT,
        &path,
        Some(body),
        "Could not update the toolset.",
    )
    .await?;
    response_value(reply, "Could not update the toolset.")?;
    Ok(format!(
        "Toolset '{name}' {}.",
        if enabled { "enabled" } else { "disabled" }
    ))
}

pub(crate) async fn skill_action(
    connection_id: &str,
    profile: Option<&str>,
    action: &str,
    identifier: &str,
) -> Result<String, AppError> {
    let profile = profile_name(profile)?;
    let (path, body, failure, done) = match action {
        "install" => (
            "/api/skills/hub/install",
            serde_json::json!({ "identifier": identifier, "profile": profile }),
            "Could not install the skill.",
            "Install started for",
        ),
        "uninstall" => (
            "/api/skills/hub/uninstall",
            serde_json::json!({ "name": identifier, "profile": profile }),
            "Could not uninstall the skill.",
            "Uninstall started for",
        ),
        _ => return Err(AppError::new("E_HERMES_INPUT", "Unknown skill action.")),
    };
    let reply = panel::request_raw(connection_id, Method::POST, path, Some(body), failure).await?;
    response_value(reply, failure)?;
    Ok(format!("{done} skill '{identifier}'."))
}

pub(crate) async fn mcp_action(
    connection_id: &str,
    profile: Option<&str>,
    action: &str,
    name: &str,
    url: &str,
) -> Result<String, AppError> {
    let profile = profile_name(profile)?;
    let query = profile_query(profile);
    match action {
        "list" => {
            let path = format!("/api/mcp/servers?{query}");
            let reply = panel::request_raw(
                connection_id,
                Method::GET,
                &path,
                None,
                "Could not list MCP servers.",
            )
            .await?;
            let value = response_value(reply, "Could not list MCP servers.")?;
            Ok(format_mcp(&value, profile))
        }
        "add" => {
            let body = serde_json::json!({ "name": name, "url": url, "profile": profile });
            let reply = panel::request_raw(
                connection_id,
                Method::POST,
                "/api/mcp/servers",
                Some(body),
                "Could not add the MCP server.",
            )
            .await?;
            response_value(reply, "Could not add the MCP server.")?;
            Ok(format!("MCP server '{name}' added."))
        }
        "remove" => {
            let path = format!("/api/mcp/servers/{}?{query}", urlencoding::encode(name));
            let reply = panel::request_raw(
                connection_id,
                Method::DELETE,
                &path,
                None,
                "Could not remove the MCP server.",
            )
            .await?;
            response_value(reply, "Could not remove the MCP server.")?;
            Ok(format!("MCP server '{name}' removed."))
        }
        _ => Err(AppError::new("E_HERMES_INPUT", "Unknown MCP action.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, value: Value) -> PanelReply {
        PanelReply {
            status: reqwest::StatusCode::from_u16(status).unwrap(),
            value,
        }
    }

    #[test]
    fn remote_scope_needs_both_halves() {
        assert_eq!(
            remote_connection(Some("panel-1"), Some("http://host:9119")),
            Some("panel-1")
        );
        assert_eq!(remote_connection(Some(" "), Some("http://host:9119")), None);
        assert_eq!(remote_connection(Some("panel-1"), Some("  ")), None);
        assert_eq!(remote_connection(None, Some("http://host:9119")), None);
    }

    #[test]
    fn paths_are_profile_scoped() {
        assert_eq!(
            read_path("tools", "opennavo").unwrap(),
            "/api/tools/toolsets?profile=opennavo"
        );
        assert_eq!(
            read_path("skills", "default").unwrap(),
            "/api/skills?profile=default"
        );
        assert_eq!(
            read_path("cron", "a b").unwrap(),
            "/api/cron/jobs?profile=a%20b"
        );
        assert!(read_path("unknown", "default").is_err());
    }

    #[test]
    fn missing_profile_is_a_clean_profile_error() {
        let error = response_value(
            reply(
                404,
                serde_json::json!({"detail": "Profile 'opennavo' does not exist."}),
            ),
            "Could not read Hermes diagnostics.",
        )
        .unwrap_err();
        assert_eq!(error.code, "E_HERMES_PROFILE");
        assert!(error.detail.unwrap_or_default().contains("opennavo"));
    }

    #[test]
    fn panel_auth_failures_stay_auth_failures() {
        let error = response_value(
            reply(401, serde_json::json!({"detail": "expired"})),
            "Could not read Hermes diagnostics.",
        )
        .unwrap_err();
        assert_eq!(error.code, "E_HERMES_PANEL_AUTH");
    }

    #[test]
    fn toolsets_render_enabled_state() {
        let text = format_tools(
            &serde_json::json!([
                {"name": "web", "label": "Web Search", "enabled": true},
                {"name": "video", "label": "Video", "enabled": false}
            ]),
            "default",
        );
        assert!(text.contains("✓ enabled   web  Web Search"));
        assert!(text.contains("✗ disabled  video  Video"));
    }

    #[test]
    fn skills_render_category_and_provenance() {
        let text = format_skills(
            &serde_json::json!([
                {"name": "review", "category": "dev", "provenance": "hub", "enabled": true}
            ]),
            "work",
        );
        assert!(text.contains("Skills in profile 'work'"));
        assert!(text.contains("review  (dev, hub)"));
    }

    #[test]
    fn cron_handles_the_empty_list() {
        assert_eq!(
            format_cron(&serde_json::json!([]), "default"),
            "No scheduled jobs in profile 'default'."
        );
        let text = format_cron(
            &serde_json::json!([
                {"id": "job-1", "name": "Morning", "enabled": true, "schedule_display": "0 9 * * *"}
            ]),
            "default",
        );
        assert!(text.contains("job-1  0 9 * * *  Morning"));
    }

    #[test]
    fn job_owner_reads_the_host_profile_fields() {
        assert_eq!(
            job_owner(&serde_json::json!({"profile": "opennavo"}), "default"),
            "opennavo"
        );
        assert_eq!(
            job_owner(&serde_json::json!({"profile_name": "work"}), "default"),
            "work"
        );
        assert_eq!(job_owner(&serde_json::json!({}), "default"), "default");
        assert_eq!(
            job_owner(&serde_json::json!({"profile": "  "}), "default"),
            "default"
        );
    }

    #[test]
    fn mcp_lists_server_transports() {
        let text = format_mcp(
            &serde_json::json!({"servers": [{"name": "github", "transport": "stdio"}]}),
            "default",
        );
        assert!(text.contains("github  stdio"));
    }
}
