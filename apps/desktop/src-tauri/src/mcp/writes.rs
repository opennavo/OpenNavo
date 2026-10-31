//! App-side Local MCP write tools: `install_app` and `uninstall_app`.
//!
//! Every write goes through the same steps, in order:
//! 1. The audit log must be writable, otherwise the write is refused.
//! 2. The request is planned (catalog lookup / installed-app lookup) and
//!    anything that cannot be done is refused before the user is asked.
//! 3. One native confirmation dialog (the shared single-slot
//!    `ConfirmationService`; another open dialog means `E_BUSY`). The dialog
//!    names the direct parent of the `mcp` subprocess by its code signature,
//!    or "Unsigned · path", then the nearest `.app` ancestor marked
//!    unverified, then the self-reported client name.
//! 4. The grant is consumed at once and is only honoured while the
//!    connection is open and both switches are on.
//! 5. The approval is recorded; if that fails nothing runs.
//! 6. The install is queued like a deep-link install, or the `.app` bundle
//!    alone is moved to the Trash through the uninstall engine.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{
    audit::{self, Audit, AuditCaller, AuditDecision, AuditEntry},
    caller::{self, SystemProcesses},
    tools::{BUSY_MESSAGE, ToolError, WriteContext, WriteRequest},
};
use crate::{
    AppError,
    confirmation::{ConfirmationRequest, ConfirmationService},
    core::DesktopCore,
    model::{Locale, TaskKind, TaskTarget, TaskTrigger},
    native_i18n,
    queue::ResolvedInstallPlan,
    security::{signature, types::SignatureStatus},
    uninstall::{AppSource, DeleteMode, ItemCategory, UninstallChoice},
};

/// Everything a write needs from the running app.
pub struct Writes {
    pub app: tauri::AppHandle,
    pub core: Arc<DesktopCore>,
    pub audit: Audit,
}

/// A planned write, ready to show and execute.
enum Plan {
    Install {
        plan: Box<ResolvedInstallPlan>,
        name: String,
    },
    Uninstall {
        plan_id: String,
        app_id: String,
        item_ids: Vec<String>,
        path: String,
        name: String,
    },
}

fn tool_error(error: AppError) -> ToolError {
    ToolError::new(error.code, error.message)
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

impl Writes {
    pub fn run(&self, request: WriteRequest, context: WriteContext) -> Result<Value, ToolError> {
        self.audit.check().map_err(|_| audit_unavailable())?;
        let plan = block_on(self.plan(&request))?;
        let identity = self.identify(&context);
        let locale = crate::confirmation::app_locale(&self.app);
        let message = dialog_message(locale, &plan, &identity).map_err(tool_error)?;
        let confirmation_request = ConfirmationRequest {
            caller: MCP_CALLER.into(),
            source: identity.caller.path.clone().unwrap_or_default(),
            action: request.tool().into(),
            target: request.object(),
            plan_digest: match &plan {
                Plan::Install { plan, .. } => Some(plan.digest()),
                Plan::Uninstall { plan_id, .. } => Some(plan_id.clone()),
            },
        };
        let service = self.confirmation()?;
        // Planning can take a while; do not open a dialog for a request that is already void.
        if !(context.still_valid)() {
            return Err(invalidated());
        }
        let decision =
            block_on(service.confirm_message(&self.app, confirmation_request.clone(), message));
        let mut entry = AuditEntry {
            id: uuid::Uuid::now_v7().to_string(),
            at: audit::now_ms(),
            tool: request.tool().to_owned(),
            object: request.object(),
            caller: identity.caller,
            decision: AuditDecision::Denied,
            result: None,
        };
        let grant = match decision {
            Ok(grant) => grant,
            Err(error) if error.code == "E_BUSY" => {
                return Err(ToolError::new("E_BUSY", BUSY_MESSAGE));
            }
            Err(error) if error.code == "E_CONFIRMATION_INVALIDATED" => {
                entry.decision = AuditDecision::Invalidated;
                let _ = self.audit.record(&entry, entry.at);
                return Err(invalidated());
            }
            Err(error) => {
                entry.decision = if error.code == "E_CONFIRMATION_TIMEOUT" {
                    AuditDecision::TimedOut
                } else {
                    AuditDecision::Denied
                };
                let _ = self.audit.record(&entry, entry.at);
                return Err(match entry.decision {
                    AuditDecision::TimedOut => ToolError::new(
                        "E_CONFIRMATION_TIMEOUT",
                        "The user did not answer the confirmation in time.",
                    ),
                    _ => ToolError::new(
                        "E_CONFIRMATION_DENIED",
                        "The user denied this request in OpenNavo.",
                    ),
                });
            }
        };
        service
            .consume(&grant, &confirmation_request)
            .map_err(tool_error)?;
        if !(context.still_valid)() {
            entry.decision = AuditDecision::Invalidated;
            let _ = self.audit.record(&entry, audit::now_ms());
            return Err(invalidated());
        }
        entry.decision = AuditDecision::Allowed;
        self.audit
            .record(&entry, audit::now_ms())
            .map_err(|_| audit_unavailable())?;
        let outcome = block_on(self.execute(plan, &context));
        let result = match &outcome {
            Ok((label, _)) => label.clone(),
            Err(error) => error.code.clone(),
        };
        let _ = self
            .audit
            .record_result(&entry.id, &result, audit::now_ms());
        outcome.map(|(_, value)| value)
    }

    /// A switch was turned off: withdraw the open Local MCP dialog, if any.
    pub fn cancel(&self) {
        if let Ok(service) = self.confirmation() {
            service.revoke_caller(MCP_CALLER);
        }
    }

    fn confirmation(&self) -> Result<Arc<ConfirmationService>, ToolError> {
        use tauri::Manager;
        self.app
            .try_state::<Arc<ConfirmationService>>()
            .map(|state| state.inner().clone())
            .ok_or_else(|| ToolError::internal("confirmation service unavailable"))
    }

    async fn plan(&self, request: &WriteRequest) -> Result<Plan, ToolError> {
        match request {
            WriteRequest::Install { kind, token } => self.plan_install(kind, token).await,
            WriteRequest::Uninstall { path } => self.plan_uninstall(path).await,
        }
    }

    async fn plan_install(&self, kind: &str, token: &str) -> Result<Plan, ToolError> {
        let (catalog_kind, task_kind) = match kind {
            "cask" => (crate::model::Kind::Cask, TaskKind::Cask),
            "formula" => (crate::model::Kind::Formula, TaskKind::Formula),
            _ => return Err(ToolError::invalid("kind must be cask or formula")),
        };
        let core = self.core.clone();
        let owned = token.to_owned();
        let item =
            crate::blocking(move || crate::catalog::get(&core.database, catalog_kind, &owned))
                .await
                .map_err(tool_error)?
                .ok_or_else(|| {
                    ToolError::new(
                        "E_NOT_FOUND",
                        "No catalog app with that kind and token; use search_catalog first.",
                    )
                })?;
        if item.disabled {
            return Err(ToolError::new(
                "E_UNSUPPORTED",
                "This app is disabled in the catalog and cannot be installed.",
            ));
        }
        let target = TaskTarget {
            kind: task_kind,
            token: token.to_owned(),
        };
        let core = self.core.clone();
        let check = target.clone();
        let available = crate::blocking(move || {
            Ok(crate::commands::deeplink::target_available(
                &check,
                &core.library_list()?,
                &core.queue.active()?,
            ))
        })
        .await
        .map_err(tool_error)?;
        if !available {
            return Err(ToolError::new(
                "E_ALREADY_INSTALLED",
                "This app is already installed or already queued.",
            ));
        }
        crate::commands::deeplink::ensure_install_environment(&self.core)
            .await
            .map_err(tool_error)?;
        let core = self.core.clone();
        let plan = crate::blocking(move || {
            ResolvedInstallPlan::resolve(&core.database, target, Default::default())
        })
        .await
        .map_err(tool_error)?;
        let name = item_name(&item).unwrap_or_else(|| token.to_owned());
        Ok(Plan::Install {
            plan: Box::new(plan),
            name,
        })
    }

    async fn plan_uninstall(&self, path: &str) -> Result<Plan, ToolError> {
        let engine = self.core.queue.uninstall_engine.clone();
        let apps = crate::blocking(move || engine.list())
            .await
            .map_err(tool_error)?;
        let app = apps
            .into_iter()
            .find(|app| app.path.trim_end_matches('/') == path)
            .ok_or_else(|| {
                ToolError::new(
                    "E_NOT_FOUND",
                    "No installed app at that path; use list_installed_apps.",
                )
            })?;
        if app.running {
            return Err(app_running());
        }
        if app.source == AppSource::Homebrew {
            return Err(ToolError::new(
                "E_UNSUPPORTED",
                "This app is managed by Homebrew. Uninstalling it would remove more than the app, so ask the user to uninstall it in OpenNavo.",
            ));
        }
        if !app.removable || app.protected_reason.is_some() {
            return Err(ToolError::new(
                "E_PROTECTED",
                "OpenNavo does not remove this app.",
            ));
        }
        let permissions = self.core.permissions().await.map_err(tool_error)?;
        let request_id = format!("mcp-{}", uuid::Uuid::new_v4());
        let plan = self
            .core
            .queue
            .uninstall_engine
            .plan(request_id, vec![app.id.clone()], permissions)
            .await
            .map_err(tool_error)?;
        let app_plan = plan
            .apps
            .iter()
            .find(|candidate| candidate.app_id == app.id)
            .ok_or_else(|| ToolError::internal("uninstall plan is missing the app"))?;
        if app_plan.running {
            return Err(app_running());
        }
        if app_plan.blocked_reason.is_some() {
            return Err(ToolError::new(
                "E_PROTECTED",
                "OpenNavo cannot remove this app right now.",
            ));
        }
        // Only the bundle itself: related files are never part of an MCP uninstall.
        let item_ids: Vec<String> = app_plan
            .items
            .iter()
            .filter(|item| {
                item.category == ItemCategory::App
                    && item.path.trim_end_matches('/') == app.path.trim_end_matches('/')
            })
            .map(|item| item.id.clone())
            .collect();
        if item_ids.len() != 1 {
            return Err(ToolError::new(
                "E_UNSUPPORTED",
                "OpenNavo could not isolate the app bundle for this app.",
            ));
        }
        Ok(Plan::Uninstall {
            plan_id: plan.plan_id,
            app_id: app.id,
            item_ids,
            path: app.path,
            name: app.name,
        })
    }

    async fn execute(
        &self,
        plan: Plan,
        context: &WriteContext,
    ) -> Result<(String, Value), ToolError> {
        match plan {
            Plan::Install { plan, .. } => {
                crate::commands::deeplink::ensure_install_environment(&self.core)
                    .await
                    .map_err(tool_error)?;
                // The environment check awaits; a switch may have gone off meanwhile.
                if !(context.still_valid)() {
                    return Err(invalidated());
                }
                let queue = self.core.queue.clone();
                let task = crate::blocking(move || {
                    queue.enqueue_resolved_install(*plan, TaskTrigger::Mcp)
                })
                .await
                .map_err(tool_error)?;
                Ok((
                    format!("queued:{}", task.id),
                    json!({ "status": "queued", "task": task }),
                ))
            }
            Plan::Uninstall {
                plan_id,
                app_id,
                item_ids,
                path,
                ..
            } => {
                let queue = self.core.queue.clone();
                let engine = queue.uninstall_engine.clone();
                let tasks = crate::blocking(move || {
                    engine.execute_choices(
                        &queue,
                        &plan_id,
                        vec![UninstallChoice {
                            app_id,
                            item_ids,
                            quit_running: false,
                        }],
                        DeleteMode::Trash,
                    )
                })
                .await
                .map_err(tool_error)?;
                let task = tasks.into_iter().next();
                let label = task
                    .as_ref()
                    .map_or_else(|| "queued".to_owned(), |task| format!("queued:{}", task.id));
                Ok((
                    label,
                    json!({ "status": "queued", "movesToTrash": [path], "task": task }),
                ))
            }
        }
    }

    fn identify(&self, context: &WriteContext) -> Identity {
        let process = caller::resolve(&SystemProcesses, context.peer_pid);
        let signature = process
            .parent_path
            .as_deref()
            .and_then(|path| signature::inspect(path).ok());
        let signed = signature.as_ref().is_some_and(|info| {
            matches!(
                info.status,
                SignatureStatus::Apple | SignatureStatus::AppStore | SignatureStatus::DeveloperId
            )
        });
        let may_come_from = process.may_come_from.as_deref().map(caller::bundle_name);
        Identity {
            caller: AuditCaller {
                path: process
                    .parent_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                signer: signature
                    .as_ref()
                    .filter(|_| signed)
                    .and_then(|info| info.signer.clone()),
                team_id: signature
                    .as_ref()
                    .filter(|_| signed)
                    .and_then(|info| info.team_id.clone()),
                signed,
                may_come_from,
                claimed_name: context.client_name.clone(),
                pid: process.parent_pid,
            },
        }
    }
}

struct Identity {
    caller: AuditCaller,
}

fn item_name(item: &crate::model::CatalogItem) -> Option<String> {
    serde_json::to_value(item)
        .ok()?
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// Confirmation caller for every Local MCP write; switch-off revokes by it.
const MCP_CALLER: &str = "local mcp";

fn invalidated() -> ToolError {
    ToolError::new(
        "E_CONFIRMATION_INVALIDATED",
        "The request was withdrawn because the connection closed or Local MCP writes were turned off.",
    )
}

fn audit_unavailable() -> ToolError {
    ToolError::new(
        "E_AUDIT_UNAVAILABLE",
        "OpenNavo could not write its audit log, so it refused this request.",
    )
}

fn app_running() -> ToolError {
    ToolError::new(
        "E_APP_RUNNING",
        "The app is running. Ask the user to quit it, then try again.",
    )
}

fn text(locale: Locale, key: &str) -> Result<String, AppError> {
    native_i18n::text(locale, &format!("mcpConfirm.{key}"))
}

/// Keep caller-supplied text on one line and bounded.
fn one_line(value: &str) -> String {
    let cleaned: String = value
        .chars()
        // Bidi overrides and zero-width characters could reorder or hide text in the dialog.
        .filter(|character| !is_invisible(*character))
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(300)
        .collect();
    cleaned.trim().to_owned()
}

fn is_invisible(character: char) -> bool {
    matches!(
        character,
        '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// The main caller line: signer when signed, otherwise "Unsigned · path".
fn caller_line(locale: Locale, caller: &AuditCaller) -> Result<String, AppError> {
    let who = match (&caller.signer, &caller.path) {
        (Some(signer), _) if caller.signed => one_line(signer),
        (_, Some(path)) => text(locale, "unsigned")?.replace("{path}", &one_line(path)),
        _ => text(locale, "unknownCaller")?,
    };
    Ok(text(locale, "requestedBy")?.replace("{caller}", &who))
}

fn dialog_message(locale: Locale, plan: &Plan, identity: &Identity) -> Result<String, AppError> {
    let mut message = match plan {
        Plan::Install { plan, name } => {
            let target = plan.command_target();
            text(locale, "install")?
                .replace("{name}", &one_line(name))
                .replace(
                    "{target}",
                    &format!("{}/{}", target.kind.as_str(), one_line(&target.token)),
                )
        }
        Plan::Uninstall { path, name, .. } => text(locale, "uninstall")?
            .replace("{name}", &one_line(name))
            .replace("{path}", &one_line(path)),
    };
    message.push_str("\n\n");
    message.push_str(&caller_line(locale, &identity.caller)?);
    if let Some(origin) = &identity.caller.may_come_from {
        message.push('\n');
        message.push_str(&text(locale, "mayComeFrom")?.replace("{name}", &one_line(origin)));
    }
    if let Some(claimed) = &identity.caller.claimed_name {
        message.push('\n');
        message.push_str(&text(locale, "claims")?.replace("{name}", &one_line(claimed)));
    }
    message.push_str("\n\n");
    message.push_str(&text(locale, "footer")?);
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(signed: bool) -> AuditCaller {
        AuditCaller {
            path: Some("/opt/homebrew/bin/node".into()),
            signer: signed.then(|| "Developer ID Application: Example Inc (ABCDE12345)".into()),
            team_id: signed.then(|| "ABCDE12345".into()),
            signed,
            may_come_from: Some("Cursor".into()),
            claimed_name: Some("cursor-vscode".into()),
            pid: Some(42),
        }
    }

    #[test]
    fn every_locale_has_the_dialog_text() {
        for locale in [
            Locale::EnUs,
            Locale::ZhCn,
            Locale::ZhHant,
            Locale::JaJp,
            Locale::EsEs,
            Locale::PtBr,
            Locale::RuRu,
            Locale::DeDe,
            Locale::FrFr,
            Locale::ItIt,
        ] {
            for key in [
                "install",
                "uninstall",
                "requestedBy",
                "unsigned",
                "unknownCaller",
                "mayComeFrom",
                "claims",
                "footer",
            ] {
                let value = text(locale, key).expect("translated");
                assert!(!value.is_empty(), "{locale:?} {key}");
            }
            for (key, placeholder) in [
                ("install", "{target}"),
                ("uninstall", "{path}"),
                ("requestedBy", "{caller}"),
                ("unsigned", "{path}"),
                ("mayComeFrom", "{name}"),
                ("claims", "{name}"),
            ] {
                assert!(
                    text(locale, key).expect("translated").contains(placeholder),
                    "{locale:?} {key} keeps {placeholder}"
                );
            }
        }
    }

    #[test]
    fn caller_lines_name_signer_or_unsigned_path_and_never_the_pid() {
        let signed = caller_line(Locale::EnUs, &caller(true)).expect("line");
        assert!(signed.contains("Developer ID Application: Example Inc"));
        let unsigned = caller_line(Locale::EnUs, &caller(false)).expect("line");
        assert!(unsigned.contains("/opt/homebrew/bin/node"));
        assert!(!signed.contains("42") && !unsigned.contains("42"));
        let unknown = caller_line(Locale::EnUs, &AuditCaller::default()).expect("line");
        assert!(!unknown.is_empty());
    }

    #[test]
    fn one_line_strips_control_characters() {
        assert_eq!(one_line("evil\nAllowed: yes\u{7}"), "evil Allowed: yes");
        assert_eq!(one_line(&"x".repeat(400)).len(), 300);
        assert_eq!(
            one_line("IINA\u{202E}ppa.exe\u{200B}\u{FEFF}"),
            "IINAppa.exe"
        );
        assert_eq!(one_line("a\u{2066}b\u{2069}c\u{200F}"), "abc");
    }
}
