//! Local MCP master-switch commands.
//!
//! B2 only exposes the backend switch and status. The Settings UI, write
//! switch, read tools and config presets arrive in later tasks.

use std::sync::Arc;

use tauri::State;

use crate::{
    AppError,
    mcp::broker::{Broker, BrokerError, McpStatus},
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
    crate::blocking(move || broker.set_enabled(enabled).map_err(map_error)).await?;
    Ok(broker.status())
}

fn map_error(error: BrokerError) -> AppError {
    AppError::new(error.code, error.message)
}
