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
