//! Local MCP master-switch commands.
//!
//! Settings drives both switches through these commands. Write tools arrive
//! in a later task; the write switch only gates them.

use std::sync::Arc;

use tauri::State;

use crate::{
    AppError,
    mcp::{
        audit::AuditEntry,
        broker::{Broker, BrokerError, McpStatus},
    },
};

/// Return the persisted master switch and live broker state.
#[tauri::command]
#[specta::specta]
pub fn mcp_status(broker: State<'_, Arc<Broker>>) -> McpStatus {
    broker.status()
}

/// Turn the Local MCP broker on or off immediately and persist the choice.
#[tauri::command]
#[specta::specta]
pub async fn mcp_set_enabled(
    broker: State<'_, Arc<Broker>>,
    enabled: bool,
) -> Result<McpStatus, AppError> {
    let broker = broker.inner().clone();
    let switch = Arc::clone(&broker);
    crate::blocking(move || switch.set_enabled(enabled).map_err(map_error)).await?;
    Ok(broker.status())
}

/// Allow or forbid Local MCP write tools immediately; turning it off disconnects every client.
#[tauri::command]
#[specta::specta]
pub async fn mcp_set_write_enabled(
    broker: State<'_, Arc<Broker>>,
    enabled: bool,
) -> Result<McpStatus, AppError> {
    let broker = broker.inner().clone();
    let switch = Arc::clone(&broker);
    crate::blocking(move || switch.set_write_enabled(enabled).map_err(map_error)).await?;
    Ok(broker.status())
}

/// Local MCP write audit log, newest first (90-day retention).
#[tauri::command]
#[specta::specta]
pub async fn mcp_audit_list(broker: State<'_, Arc<Broker>>) -> Result<Vec<AuditEntry>, AppError> {
    let audit = broker.audit();
    crate::blocking(move || Ok(audit.list(crate::mcp::audit::now_ms())?)).await
}

/// Delete every Local MCP audit entry.
#[tauri::command]
#[specta::specta]
pub async fn mcp_audit_clear(broker: State<'_, Arc<Broker>>) -> Result<(), AppError> {
    let audit = broker.audit();
    crate::blocking(move || Ok(audit.clear()?)).await
}

fn map_error(error: BrokerError) -> AppError {
    AppError::new(error.code, error.message)
}

/// Content of the open Local MCP confirmation; only the confirmation window may read it.
#[tauri::command]
#[specta::specta]
pub fn mcp_confirm_get(
    window: tauri::WebviewWindow,
    confirmation: State<'_, Arc<crate::confirmation::ConfirmationService>>,
) -> Result<Option<crate::confirmation::McpConfirmView>, AppError> {
    require_confirm_window(window.label())?;
    Ok(confirmation.window_view())
}

/// Answer the open Local MCP confirmation once; only the confirmation window may answer.
#[tauri::command]
#[specta::specta]
pub fn mcp_confirm_answer(
    window: tauri::WebviewWindow,
    confirmation: State<'_, Arc<crate::confirmation::ConfirmationService>>,
    id: String,
    allow: bool,
) -> Result<(), AppError> {
    require_confirm_window(window.label())?;
    confirmation.answer_window(&id, allow)
}

/// The confirmation commands answer only the window the app created for them, whatever the
/// capability files say: any other webview (main, tray, guide...) is refused.
pub(crate) fn require_confirm_window(label: &str) -> Result<(), AppError> {
    if label == crate::confirmation::MCP_CONFIRM_LABEL {
        Ok(())
    } else {
        Err(AppError::new("E_FORBIDDEN", "mcp_confirm_window_only"))
    }
}

#[cfg(test)]
mod confirm_window_tests {
    use super::require_confirm_window;

    #[test]
    fn only_the_confirmation_window_may_read_or_answer() {
        assert!(require_confirm_window("mcp-confirm").is_ok());
        for label in [
            "main",
            "tray",
            "tray-monitor",
            "permission-guide",
            "firewall-alert",
            "mcp-confirm2",
            "",
        ] {
            assert_eq!(
                require_confirm_window(label).unwrap_err().code,
                "E_FORBIDDEN",
                "{label}"
            );
        }
    }

    #[test]
    fn capabilities_grant_the_confirmation_commands_to_that_window_only() {
        let acl = include_str!("../../permissions/native.toml");
        for section in acl.split("[[permission]]") {
            let grants = section.contains("\"mcp_confirm_get\"")
                || section.contains("\"mcp_confirm_answer\"");
            if grants {
                assert!(
                    section.contains("identifier = \"native-mcp-confirm\""),
                    "{section}"
                );
            }
        }
        let main = acl
            .split("[[permission]]")
            .find(|section| section.contains("identifier = \"native-main\""))
            .expect("native-main");
        for command in [
            "mcp_status",
            "mcp_set_enabled",
            "mcp_set_write_enabled",
            "mcp_audit_list",
            "mcp_audit_clear",
        ] {
            assert!(main.contains(&format!("\"{command}\"")), "{command}");
        }
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/mcp-confirm.json"))
                .expect("json");
        assert_eq!(capability["windows"], serde_json::json!(["mcp-confirm"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["native-mcp-confirm", "core:event:default"])
        );
        for other in [
            include_str!("../../capabilities/main.json"),
            include_str!("../../capabilities/tray.json"),
            include_str!("../../capabilities/tray-monitor.json"),
            include_str!("../../capabilities/guide.json"),
            include_str!("../../capabilities/firewall-alert.json"),
        ] {
            assert!(!other.contains("native-mcp-confirm"));
            assert!(!other.contains("\"mcp-confirm\""));
        }
    }
}
