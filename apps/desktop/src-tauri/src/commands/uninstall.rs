use crate::{AppError, core::DesktopCore, model::*};
use std::{path::Path, sync::Arc};
use tauri::State;
#[tauri::command]
#[specta::specta]
pub async fn local_apps_list(
    state: State<'_, Arc<DesktopCore>>,
) -> Result<Vec<LocalApp>, AppError> {
    let engine = state.queue.uninstall_engine.clone();
    let list = crate::blocking(move || engine.list()).await?;
    let engine = state.queue.uninstall_engine.clone();
    tauri::async_runtime::spawn(async move {
        let _ = engine.hydrate_catalog().await;
    });
    Ok(list)
}
#[tauri::command]
#[specta::specta]
pub async fn local_apps_refresh(
    state: State<'_, Arc<DesktopCore>>,
) -> Result<Vec<LocalApp>, AppError> {
    // Homebrew may be absent; native app enumeration remains available.
    let _ = state
        .inner()
        .refresh_library(LibraryChangeReason::Refresh, None)
        .await;
    let engine = state.queue.uninstall_engine.clone();
    let list = crate::blocking(move || engine.refresh(LocalAppsChangedReason::Refresh)).await?;
    let engine = state.queue.uninstall_engine.clone();
    tauri::async_runtime::spawn(async move {
        let _ = engine.hydrate_catalog().await;
    });
    Ok(list)
}
#[tauri::command]
#[specta::specta]
pub async fn local_app_open(
    state: State<'_, Arc<DesktopCore>>,
    id: String,
) -> Result<(), AppError> {
    let engine = state.queue.uninstall_engine.clone();
    crate::blocking(move || {
        let app = engine.app(&id)?;
        engine.control.reopen(Path::new(&app.app.path))
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn local_app_reveal(
    state: State<'_, Arc<DesktopCore>>,
    id: String,
) -> Result<(), AppError> {
    let engine = state.queue.uninstall_engine.clone();
    crate::blocking(move || {
        let app = engine.app(&id)?;
        crate::uninstall::execute::reveal(Path::new(&app.app.path))
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn local_app_footprint(
    state: State<'_, Arc<DesktopCore>>,
    id: String,
) -> Result<Footprint, AppError> {
    state
        .queue
        .uninstall_engine
        .footprint(id, state.permissions().await?)
        .await
}
#[tauri::command]
#[specta::specta]
pub async fn uninstall_plan(
    state: State<'_, Arc<DesktopCore>>,
    request_id: String,
    app_ids: Vec<String>,
) -> Result<UninstallPlan, AppError> {
    let permissions = state.permissions().await?;
    state
        .queue
        .uninstall_engine
        .plan(request_id, app_ids, permissions)
        .await
}
#[tauri::command]
#[specta::specta]
pub async fn uninstall_plan_cancel(
    state: State<'_, Arc<DesktopCore>>,
    request_id: String,
) -> Result<(), AppError> {
    state.queue.uninstall_engine.cancel(&request_id)
}
#[tauri::command]
#[specta::specta]
pub async fn uninstall_reveal(
    state: State<'_, Arc<DesktopCore>>,
    plan_id: String,
    item_id: String,
) -> Result<(), AppError> {
    let engine = state.queue.uninstall_engine.clone();
    crate::blocking(move || {
        let plan = engine.cached_plan(&plan_id, crate::uninstall::now())?;
        let item = plan
            .plan
            .apps
            .iter()
            .flat_map(|a| &a.items)
            .find(|i| i.id == item_id)
            .ok_or_else(|| AppError::new("E_INVALID_ARG", "item_id"))?;
        crate::uninstall::execute::reveal(Path::new(&item.path))
    })
    .await
}
/// Uninstall after the user allows it in OpenNavo's confirmation window; every queued task is bound
/// to the exact items that window listed.
#[tauri::command]
#[specta::specta]
pub async fn uninstall_execute(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopCore>>,
    confirmation: State<'_, Arc<crate::confirmation::ConfirmationService>>,
    plan_id: String,
    choices: Vec<UninstallChoice>,
    mode: DeleteMode,
) -> Result<Vec<Task>, AppError> {
    let queue = state.queue.clone();
    let engine = queue.uninstall_engine.clone();
    let (digest, view) = {
        let engine = engine.clone();
        let (plan_id, choices) = (plan_id.clone(), choices.clone());
        crate::blocking(move || engine.confirm_plan(&plan_id, choices, mode)).await?
    };
    let action = if mode == DeleteMode::Delete {
        "uninstall delete"
    } else {
        "uninstall"
    };
    let service = confirmation.inner().clone();
    let request = crate::destructive::request(action, &format!("uninstall/{plan_id}"), digest);
    crate::destructive::confirmed(
        &service,
        request,
        |request| service.confirm_window(&app, request, view),
        |approved| {
            crate::blocking(move || {
                engine.execute_choices_confirmed(&queue, &plan_id, choices, mode, &approved)
            })
        },
    )
    .await
}
/// Retry a failed Homebrew uninstall that had no plan (the Full Disk Access prompt, history), by
/// task id only: Rust rebuilds its options from the stored task, asks in OpenNavo's confirmation
/// window, and queues it only if that task still yields the same plan.
#[tauri::command]
#[specta::specta]
pub async fn uninstall_retry(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopCore>>,
    confirmation: State<'_, Arc<crate::confirmation::ConfirmationService>>,
    task_id: String,
) -> Result<Task, AppError> {
    let core = state.inner().clone();
    let load = |core: Arc<DesktopCore>, id: String| {
        crate::blocking(move || {
            let task = core
                .database
                .task(&id)?
                .ok_or_else(|| AppError::new("E_NOT_FOUND", "task"))?;
            crate::destructive::uninstall_retry_plan(&task)
        })
    };
    let (target, _, digest) = load(core.clone(), task_id.clone()).await?;
    let kind = match target.kind {
        TaskKind::Formula => "formula",
        _ => "cask",
    };
    let view = crate::confirmation::McpConfirmView::app_action(
        "brewUninstall",
        &target.token,
        vec![crate::confirmation::ConfirmItemView::row(
            &target.token,
            &format!("{kind}/{}", target.token),
        )],
        1,
        None,
    );
    let service = confirmation.inner().clone();
    let request =
        crate::destructive::request("uninstall retry", &format!("task/{task_id}"), digest);
    crate::destructive::confirmed(
        &service,
        request,
        |request| service.confirm_window(&app, request, view),
        |approved| async move {
            let (target, options, again) = load(core.clone(), task_id).await?;
            if again != approved {
                return Err(crate::destructive::plan_changed());
            }
            let queue = core.queue.clone();
            crate::blocking(move || {
                queue.enqueue(TaskOp::Uninstall, Some(target), options, TaskTrigger::Retry)
            })
            .await
        },
    )
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn uninstall_restore(
    state: State<'_, Arc<DesktopCore>>,
    task_id: String,
) -> Result<RestoreResult, AppError> {
    let engine = state.queue.uninstall_engine.clone();
    let result = crate::blocking(move || engine.restore(&task_id)).await;
    let engine = state.queue.uninstall_engine.clone();
    let _ = crate::blocking(move || engine.refresh(LocalAppsChangedReason::Task)).await;
    result
}
/// Delete these uninstalls' items from the Trash for good, after one confirmation for the batch.
#[tauri::command]
#[specta::specta]
pub async fn uninstall_purge(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopCore>>,
    confirmation: State<'_, Arc<crate::confirmation::ConfirmationService>>,
    task_ids: Vec<String>,
) -> Result<u64, AppError> {
    let engine = state.queue.uninstall_engine.clone();
    let (digest, view) = {
        let engine = engine.clone();
        let task_ids = task_ids.clone();
        crate::blocking(move || engine.purge_plan(&task_ids)).await?
    };
    let service = confirmation.inner().clone();
    let request = crate::destructive::request("purge", &task_ids.join(","), digest);
    crate::destructive::confirmed(
        &service,
        request,
        |request| service.confirm_window(&app, request, view),
        |approved| crate::blocking(move || engine.purge_confirmed(&task_ids, &approved)),
    )
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn local_app_footprints(
    state: State<'_, Arc<DesktopCore>>,
) -> Result<FootprintReport, AppError> {
    state.queue.uninstall_engine.footprint_report()
}

#[tauri::command]
#[specta::specta]
pub async fn local_apps_scan_footprints(
    state: State<'_, Arc<DesktopCore>>,
    force: bool,
) -> Result<bool, AppError> {
    let engine = state.queue.uninstall_engine.clone();
    let scan = engine.clone();
    crate::blocking(move || scan.list()).await?;
    engine.scan_footprints(state.permissions().await?, force)
}

#[tauri::command]
#[specta::specta]
pub async fn local_app_retry_footprint(
    state: State<'_, Arc<DesktopCore>>,
    id: String,
) -> Result<(), AppError> {
    let engine = state.queue.uninstall_engine.clone();
    engine.app(&id)?;
    engine.schedule_footprints(vec![id], state.permissions().await?)
}
