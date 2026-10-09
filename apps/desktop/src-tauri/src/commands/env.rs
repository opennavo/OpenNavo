use crate::{AppError, model::EnvInfo};
use tauri_specta::Event;
#[tauri::command]
#[specta::specta]
pub async fn env_detect(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<crate::core::DesktopCore>>,
) -> Result<EnvInfo, AppError> {
    let info = state.detect_environment().await?;
    let _ = crate::events::EnvChanged(info.clone()).emit(&app);
    Ok(info)
}
