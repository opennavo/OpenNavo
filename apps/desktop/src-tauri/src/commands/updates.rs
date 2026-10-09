use crate::{AppError, core::DesktopCore, model::*};
use std::sync::Arc;
use tauri::State;
#[tauri::command]
#[specta::specta]
pub fn updates_status(state: State<'_, Arc<DesktopCore>>) -> Result<UpdatesStatus, AppError> {
    state.updates_status()
}
#[tauri::command]
#[specta::specta]
pub fn updates_list(state: State<'_, Arc<DesktopCore>>) -> Result<Vec<OutdatedItem>, AppError> {
    state.updates_list()
}
#[tauri::command]
#[specta::specta]
pub async fn updates_check(
    state: State<'_, Arc<DesktopCore>>,
    run_brew_update: bool,
) -> Result<Vec<OutdatedItem>, AppError> {
    state.inner().check_updates(run_brew_update).await
}
#[tauri::command]
#[specta::specta]
pub async fn updates_ignore(
    state: State<'_, Arc<DesktopCore>>,
    target: TaskTarget,
    version: Option<String>,
    until: Option<i64>,
) -> Result<(), AppError> {
    state.inner().ignore_update(target, version, until).await
}
#[tauri::command]
#[specta::specta]
pub async fn updates_unignore(
    state: State<'_, Arc<DesktopCore>>,
    target: TaskTarget,
) -> Result<(), AppError> {
    state.inner().unignore_update(target).await
}
