use serde::Serialize;

use crate::error::AppError;

/// Client information for About, X-Client-Version headers, and diagnostics.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    /// Platform, e.g. macos.
    pub os: String,
    /// CPU architecture, e.g. aarch64 or x86_64.
    pub arch: String,
}

#[tauri::command]
#[specta::specta]
pub fn app_info(app: tauri::AppHandle) -> Result<AppInfo, AppError> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
    })
}
