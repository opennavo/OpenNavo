use crate::{AppError, core::DesktopCore, model::*};
use std::sync::Arc;
use tauri::State;
#[tauri::command]
#[specta::specta]
pub async fn brewfile_export(
    state: State<'_, Arc<DesktopCore>>,
    path: String,
    targets: Option<Vec<TaskTarget>>,
) -> Result<u32, AppError> {
    if let Some(targets) = targets {
        let database = state.database.clone();
        return crate::blocking(move || {
            crate::brewfile::export_catalog_list(&database, &path, &targets)
        })
        .await;
    }
    crate::brewfile::export(state.inner().clone(), path).await
}
#[tauri::command]
#[specta::specta]
pub async fn brewfile_preview(
    state: State<'_, Arc<DesktopCore>>,
    path: String,
) -> Result<BrewfilePreview, AppError> {
    crate::brewfile::preview(state.inner().clone(), path).await
}
/// Install a Brewfile's ready casks after the user allows the whole list in OpenNavo's
/// confirmation window. The file must still be the one `brewfile_preview` read (`digest`), and it
/// is read and resolved again after Allow; any change refuses with `E_PLAN_CHANGED`.
/// `decisions` carries the tap and adoption answers the main window already collected; they are
/// part of the digest, and a tap nobody was asked about refuses the plan.
#[tauri::command]
#[specta::specta]
pub async fn brewfile_install(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopCore>>,
    confirmation: State<'_, Arc<crate::confirmation::ConfirmationService>>,
    path: String,
    digest: String,
    decisions: crate::model::BrewfileDecisions,
) -> Result<Vec<Task>, AppError> {
    crate::commands::deeplink::ensure_install_environment(&state).await?;
    let core = state.inner().clone();
    let plan = {
        let (core, path, digest, decisions) = (
            core.clone(),
            path.clone(),
            digest.clone(),
            decisions.clone(),
        );
        crate::blocking(move || {
            crate::destructive::brewfile_plan(&core, &path, &digest, &decisions)
        })
        .await?
    };
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Brewfile".into());
    let mut view = crate::confirmation::McpConfirmView::app_action(
        "brewfileInstall",
        &name,
        plan.rows,
        plan.plans.len(),
        None,
    );
    view.path = Some(crate::confirmation::display_value(&path));
    let service = confirmation.inner().clone();
    let request = crate::destructive::request("brewfile install", &path, plan.digest);
    crate::destructive::confirmed(
        &service,
        request,
        |request| service.confirm_window(&app, request, view),
        |approved| async move {
            crate::commands::deeplink::ensure_install_environment(&core).await?;
            crate::blocking(move || {
                let again = crate::destructive::brewfile_plan(&core, &path, &digest, &decisions)?;
                if again.digest != approved {
                    return Err(crate::destructive::plan_changed());
                }
                core.queue
                    .enqueue_resolved_installs(again.plans, TaskTrigger::Bundle)
            })
            .await
        },
    )
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn doctor_run(state: State<'_, Arc<DesktopCore>>) -> Result<DoctorReport, AppError> {
    crate::maintenance::diagnose(state.inner().clone()).await
}
