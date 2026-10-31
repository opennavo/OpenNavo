//! OpenNavo's own destructive commands (#77): installing a Brewfile, running a cleanup,
//! uninstalling apps and emptying their items from the Trash.
//!
//! Each one is asked in the same confirmation window as Local MCP writes and deep links
//! ([`ConfirmationService::confirm_window`]): one slot, a one-time id, Deny by default, Allow refused
//! by Rust for a second, Return/Escape/closing/leaving the window deny, and only the `mcp-confirm`
//! window may read or answer it. The main window can start the request but never answer it.
//!
//! The grant binds a digest of the exact plan the window lists. After Allow the digest is computed
//! again from Rust's own state; if anything changed, nothing runs and the command fails with
//! `E_PLAN_CHANGED`. Queued cleanup and uninstall tasks carry their digest and check it once more
//! before the first file is touched.

use std::future::Future;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    AppError,
    confirmation::{ConfirmItemView, ConfirmationRequest, ConfirmationService},
    core::DesktopCore,
    model::{
        BrewfileEntryStatus, Kind, Task, TaskKind, TaskOp, TaskOptions, TaskState, TaskTarget,
    },
    queue::{ResolvedInstallPlan, ordered_install_plans_digest},
};

/// Caller of every confirmation started by OpenNavo's own window.
pub const APP_CALLER: &str = "opennavo app";

/// At most this many paths are listed in the window; the count and total size still cover all.
pub const MAX_LISTED_ITEMS: usize = 200;

/// Canonical SHA-256 of a serializable plan (tuples and vectors only, no map ordering).
pub fn digest(value: &impl Serialize) -> String {
    let canonical = serde_json::to_vec(value).expect("plans are serializable");
    format!("{:x}", Sha256::digest(canonical))
}

/// The plan is no longer the one the user allowed.
pub fn plan_changed() -> AppError {
    AppError::new("E_PLAN_CHANGED", "plan_changed")
}

/// The confirmation request of one destructive command; the grant binds `plan_digest`.
pub fn request(action: &str, target: &str, plan_digest: String) -> ConfirmationRequest {
    ConfirmationRequest {
        caller: APP_CALLER.into(),
        source: "opennavo".into(),
        action: action.into(),
        target: target.into(),
        plan_digest: Some(plan_digest),
    }
}

/// Ask with `ask` (the confirmation window), consume the grant once, then hand the approved digest
/// to `execute`, which must compare it with the current plan before it changes anything. A denial,
/// a timeout or a busy window returns that error and `execute` never runs.
pub async fn confirmed<T, Ask, AskFut, Run, RunFut>(
    service: &ConfirmationService,
    request: ConfirmationRequest,
    ask: Ask,
    execute: Run,
) -> Result<T, AppError>
where
    Ask: FnOnce(ConfirmationRequest) -> AskFut,
    AskFut: Future<Output = Result<crate::confirmation::ConfirmationGrant, AppError>>,
    Run: FnOnce(String) -> RunFut,
    RunFut: Future<Output = Result<T, AppError>>,
{
    let approved = request
        .plan_digest
        .clone()
        .ok_or_else(|| AppError::new("E_INVALID_ARG", "plan_digest"))?;
    let grant = ask(request.clone()).await?;
    service.consume(&grant, &request)?;
    execute(approved).await
}

/// Retrying a failed Homebrew uninstall that had no plan (for example one blocked by Full Disk
/// Access): Rust takes the target and options from the stored task, never from the caller, adds
/// `--force` after a Full Disk Access failure (the app was moved, Caskroom kept a backup), and binds
/// the digest to the task id, target and final options.
pub fn uninstall_retry_plan(task: &Task) -> Result<(TaskTarget, TaskOptions, String), AppError> {
    let target = task
        .target
        .clone()
        .filter(|_| task.op == TaskOp::Uninstall && task.options.plan_id.is_none())
        .filter(|_| matches!(task.state, TaskState::Failed | TaskState::Canceled))
        .ok_or_else(|| AppError::new("E_INVALID_ARG", "uninstall_retry"))?;
    let mut options = task.options.clone();
    options.plan_digest = None;
    if task
        .error
        .as_ref()
        .is_some_and(|error| error.code == "E_FULL_DISK_ACCESS")
    {
        options.force = true;
    }
    let digest = digest(&("uninstall retry", &task.id, &target, &options));
    Ok((target, options, digest))
}

/// What a Brewfile install queues, as shown in the window.
pub struct BrewfilePlan {
    pub plans: Vec<ResolvedInstallPlan>,
    pub rows: Vec<ConfirmItemView>,
    pub digest: String,
}

/// Read the Brewfile again and build its install plan. The file must still be the one the preview
/// read (`file_digest`); the plan digest covers that file and the ordered resolved installs (final
/// identities, taps and Homebrew arguments).
pub fn brewfile_plan(
    core: &DesktopCore,
    path: &str,
    file_digest: &str,
    decisions: &crate::model::BrewfileDecisions,
) -> Result<BrewfilePlan, AppError> {
    let content = crate::brewfile::read(std::path::Path::new(path))?;
    if crate::brewfile::content_digest(&content) != file_digest {
        return Err(plan_changed());
    }
    let library = core.library_list()?;
    let preview = crate::brewfile::parse(&content, &library, |kind, token| {
        let (tap, upstream) = crate::brew::args::split_cask_token(token)?;
        if tap.is_some() {
            crate::catalog::get_brew_cask(&core.database, upstream, tap)
        } else {
            crate::catalog::get(&core.database, kind, token)
        }
    })?;
    let active = core.queue.active()?;
    let mut plans = Vec::new();
    let mut rows = Vec::new();
    for entry in &preview.entries {
        let Some(token) = entry.token.as_deref() else {
            let mut row = ConfirmItemView::row(&entry.raw, &format!("Brewfile:{}", entry.line));
            row.skip = Some("unsupported".into());
            rows.push(row);
            continue;
        };
        let kind = match entry.kind {
            Some(Kind::Formula) => "formula",
            _ => "cask",
        };
        let mut row = ConfirmItemView::row(token, &format!("{kind}/{token}"));
        let target = TaskTarget {
            kind: TaskKind::Cask,
            token: token.to_owned(),
        };
        let owned = token.to_owned();
        row.skip = match entry.status {
            BrewfileEntryStatus::Ready
                if entry.kind == Some(Kind::Cask) && decisions.declined.contains(&owned) =>
            {
                Some("declined".into())
            }
            BrewfileEntryStatus::Ready if entry.kind == Some(Kind::Cask) => {
                if crate::commands::deeplink::target_available(&target, &library, &active) {
                    let adopt = decisions.adopt.contains(&owned);
                    let plan = ResolvedInstallPlan::resolve(
                        &core.database,
                        target,
                        crate::model::TaskOptions {
                            adopt,
                            ..Default::default()
                        },
                    )?;
                    // A third-party tap is the user's call every time: one they were not asked about
                    // means the catalog changed after the main window checked it.
                    if let Some(tap) = plan.tap()
                        && !decisions.taps.iter().any(|approved| approved == tap)
                    {
                        return Err(plan_changed());
                    }
                    // Show the identity the digest binds: the resolved Homebrew token and its tap.
                    let identity = format!("cask/{}", plan.command_target().token);
                    row = ConfirmItemView::row(
                        token,
                        &plan
                            .tap()
                            .map_or(identity.clone(), |tap| format!("{identity} [{tap}]")),
                    );
                    if adopt {
                        row.note = Some("adopt".into());
                    }
                    plans.push(plan);
                    None
                } else {
                    Some("queued".into())
                }
            }
            BrewfileEntryStatus::Installed => Some("installed".into()),
            BrewfileEntryStatus::Skipped => Some("duplicate".into()),
            _ => Some("unsupported".into()),
        };
        rows.push(row);
    }
    if plans.is_empty() {
        return Err(AppError::new(
            "E_INVALID_ARG",
            "brewfile_nothing_to_install",
        ));
    }
    if plans.len() > 200 {
        return Err(AppError::new("E_INVALID_ARG", "too_many_targets"));
    }
    let mut decided = decisions.clone();
    for list in [&mut decided.adopt, &mut decided.taps, &mut decided.declined] {
        list.sort();
        list.dedup();
    }
    let digest = digest(&(
        path,
        file_digest,
        &decided,
        ordered_install_plans_digest(&plans),
    ));
    Ok(BrewfilePlan {
        plans,
        rows,
        digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed_uninstall(code: &str, options: TaskOptions) -> Task {
        Task {
            target_name: None,
            outcome: None,
            id: "task-1".into(),
            op: TaskOp::Uninstall,
            target: Some(TaskTarget {
                kind: TaskKind::Cask,
                token: "rectangle".into(),
            }),
            options,
            trigger: crate::model::TaskTrigger::Manual,
            state: TaskState::Failed,
            phase: None,
            percent: None,
            bytes_done: None,
            bytes_total: None,
            speed_bps: None,
            step_index: None,
            step_count: None,
            from_version: None,
            to_version: None,
            error: Some(AppError::new(code, "failed")),
            exit_code: None,
            log_path: None,
            created_at: 0,
            started_at: None,
            finished_at: None,
        }
    }

    #[test]
    fn an_uninstall_retry_takes_its_options_from_the_stored_task() {
        let zap = TaskOptions {
            zap: true,
            ..TaskOptions::default()
        };
        let (target, options, digest) =
            uninstall_retry_plan(&failed_uninstall("E_FULL_DISK_ACCESS", zap.clone())).unwrap();
        assert_eq!(target.token, "rectangle");
        // Full Disk Access: the app is already moved; Rust adds --force, the caller cannot.
        assert!(options.zap && options.force);
        let (_, other, other_digest) =
            uninstall_retry_plan(&failed_uninstall("E_IO", zap)).unwrap();
        assert!(!other.force);
        assert_ne!(digest, other_digest);
        // A forged digest from an older task never matches the plan of this one.
        let mut changed = failed_uninstall("E_FULL_DISK_ACCESS", TaskOptions::default());
        changed.id = "task-2".into();
        assert_ne!(uninstall_retry_plan(&changed).unwrap().2, digest);
    }

    #[test]
    fn only_a_finished_unplanned_uninstall_can_be_retried() {
        let mut planned = failed_uninstall("E_IO", TaskOptions::default());
        planned.options.plan_id = Some("plan".into());
        let mut running = failed_uninstall("E_IO", TaskOptions::default());
        running.state = TaskState::Running;
        let mut reinstall = failed_uninstall("E_IO", TaskOptions::default());
        reinstall.op = TaskOp::Reinstall;
        for task in [planned, running, reinstall] {
            assert_eq!(
                uninstall_retry_plan(&task).unwrap_err().message,
                "uninstall_retry"
            );
        }
    }
    use crate::confirmation::McpConfirmView;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };

    fn view() -> McpConfirmView {
        McpConfirmView::app_action(
            "cleanup",
            "Clean up",
            vec![ConfirmItemView::row("Caches", "/Users/me/Library/Caches/x")],
            0,
            Some(42),
        )
    }

    /// Run `confirmed` against the real prompt logic (no window) and answer it with `answer`.
    async fn run(
        approved: &str,
        current: &'static str,
        answer: impl FnOnce(&ConfirmationService) + Send + 'static,
        timeout: Duration,
        delay: Duration,
    ) -> (Result<(), AppError>, bool) {
        let service = Arc::new(ConfirmationService::default());
        let executed = Arc::new(AtomicBool::new(false));
        let answering = Arc::clone(&service);
        let responder = tokio::spawn(async move {
            // Wait until the prompt is shown, then answer like a window would.
            for _ in 0..200 {
                if answering.window_view().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            tokio::time::sleep(delay).await;
            answer(&answering);
        });
        let ran = Arc::clone(&executed);
        let prompt = Arc::clone(&service);
        let result = confirmed(
            &service,
            request("cleanup", "cleanup/report", approved.into()),
            move |request| async move {
                prompt
                    .confirm_prompt(request, view(), timeout, |_, _| Ok(()), || {})
                    .await
            },
            move |digest| async move {
                if digest != current {
                    return Err(plan_changed());
                }
                ran.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        responder.await.unwrap();
        (result, executed.load(Ordering::SeqCst))
    }

    fn allow(service: &ConfirmationService) {
        let id = service.window_view().expect("prompt").id;
        service.test_arm();
        service.answer_window(&id, true).expect("allow");
    }

    #[tokio::test]
    async fn allow_runs_the_approved_plan() {
        let (result, executed) = run(
            "plan-a",
            "plan-a",
            allow,
            Duration::from_secs(5),
            Duration::ZERO,
        )
        .await;
        result.expect("allowed");
        assert!(executed);
    }

    #[tokio::test]
    async fn a_plan_changed_after_the_window_never_runs() {
        let (result, executed) = run(
            "plan-a",
            "plan-b",
            allow,
            Duration::from_secs(5),
            Duration::ZERO,
        )
        .await;
        assert_eq!(result.unwrap_err().code, "E_PLAN_CHANGED");
        assert!(!executed);
    }

    #[tokio::test]
    async fn deny_never_runs() {
        let deny = |service: &ConfirmationService| {
            let id = service.window_view().expect("prompt").id;
            service.answer_window(&id, false).expect("deny");
        };
        let (result, executed) = run(
            "plan-a",
            "plan-a",
            deny,
            Duration::from_secs(5),
            Duration::ZERO,
        )
        .await;
        assert_eq!(result.unwrap_err().code, "E_CONFIRMATION_DENIED");
        assert!(!executed);
    }

    #[tokio::test]
    async fn timeout_never_runs_and_a_late_allow_is_refused() {
        let late = |service: &ConfirmationService| {
            // The window was closed at the timeout: there is nothing left to allow.
            assert!(service.window_view().is_none());
            assert!(service.answer_window("any", true).is_err());
        };
        let (result, executed) = run(
            "plan-a",
            "plan-a",
            late,
            Duration::from_millis(50),
            Duration::from_millis(150),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "E_CONFIRMATION_TIMEOUT");
        assert!(!executed);
    }

    #[tokio::test]
    async fn the_main_window_cannot_answer_for_the_user() {
        // The answer commands check the calling window's label before touching the prompt.
        let main_tries = |service: &ConfirmationService| {
            let shown = service.window_view().expect("prompt");
            for label in ["main", "tray", "tray-monitor", "permission-guide"] {
                assert_eq!(
                    crate::commands::mcp::require_confirm_window(label)
                        .unwrap_err()
                        .code,
                    "E_FORBIDDEN"
                );
            }
            // Nothing was answered: the window is still waiting with the same one-time id.
            assert_eq!(service.window_view().expect("still open").id, shown.id);
        };
        let (result, executed) = run(
            "plan-a",
            "plan-a",
            main_tries,
            Duration::from_millis(80),
            Duration::ZERO,
        )
        .await;
        assert_eq!(result.unwrap_err().code, "E_CONFIRMATION_TIMEOUT");
        assert!(!executed);
    }

    #[tokio::test]
    async fn a_busy_window_is_not_a_grant() {
        let service = Arc::new(ConfirmationService::default());
        let holder = Arc::clone(&service);
        let open = tokio::spawn(async move {
            holder
                .confirm_prompt(
                    request("uninstall", "a", "x".into()),
                    view(),
                    Duration::from_millis(100),
                    |_, _| Ok(()),
                    || {},
                )
                .await
        });
        for _ in 0..200 {
            if service.window_view().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let prompt = Arc::clone(&service);
        let result = confirmed(
            &service,
            request("cleanup", "b", "y".into()),
            move |request| async move {
                prompt
                    .confirm_prompt(
                        request,
                        view(),
                        Duration::from_secs(1),
                        |_, _| Ok(()),
                        || {},
                    )
                    .await
            },
            |_| async { Ok::<_, AppError>(()) },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "E_BUSY");
        let _ = open.await;
    }

    #[test]
    fn the_view_names_the_app_as_the_requester_and_filters_paths() {
        let view = McpConfirmView::app_action(
            "uninstallDelete",
            "Rectangle\u{202e}",
            vec![ConfirmItemView::row(
                "Rectangle",
                "/Applications/Rect\u{200b}angle.app",
            )],
            0,
            Some(7),
        );
        assert_eq!(view.origin, "app");
        assert_eq!(view.name, "Rectangle");
        assert_eq!(view.items[0].target, "/Applications/Rectangle.app");
        assert_eq!(view.bytes, Some(7));
        assert!(view.signer.is_none() && view.source.is_none());
    }
}
