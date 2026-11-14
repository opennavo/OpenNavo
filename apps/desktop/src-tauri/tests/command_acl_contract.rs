//! The window ACL must cover every command the app registers.
//!
//! App commands are not implicitly callable: Tauri resolves each invoke against the
//! capability that applies to the window, and a command missing from
//! `permissions/native.toml` fails at runtime with
//! `"<command> not allowed. Command not found"` — which reads like a missing
//! registration and sent one debugging session chasing a stale binary. This test
//! makes the omission fail at build time instead.

/// Command names registered in `collect_commands![...]` in `src/lib.rs`.
fn registered_commands() -> Vec<String> {
    let source = include_str!("../src/lib.rs");
    let list = source
        .split_once("collect_commands![")
        .expect("src/lib.rs must register commands with collect_commands!")
        .1
        .split_once("])")
        .expect("collect_commands! list must be closed")
        .0;
    list.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            entry
                .rsplit("::")
                .next()
                .expect("a command path has a last segment")
                .to_owned()
        })
        .collect()
}

/// The `commands.allow` list of one permission in `permissions/native.toml`.
fn allowed_commands(identifier: &str) -> Vec<String> {
    let acl = include_str!("../permissions/native.toml");
    let block = acl
        .split("[[permission]]")
        .find(|section| section.contains(&format!("identifier = \"{identifier}\"")))
        .unwrap_or_else(|| panic!("permissions/native.toml has no {identifier}"));
    block
        .split_once("commands.allow = [")
        .expect("the permission must list allowed commands")
        .1
        .split_once(']')
        .expect("the allow list must be closed")
        .0
        .split(',')
        .map(|entry| entry.trim().trim_matches('"'))
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Every command allowed by any permission block.
fn allowed_anywhere() -> Vec<String> {
    let acl = include_str!("../permissions/native.toml");
    let mut allowed = Vec::new();
    for section in acl.split("[[permission]]") {
        let Some((_, rest)) = section.split_once("commands.allow = [") else {
            continue;
        };
        let Some((list, _)) = rest.split_once(']') else {
            continue;
        };
        allowed.extend(
            list.split(',')
                .map(|entry| entry.trim().trim_matches('"'))
                .filter(|entry| !entry.is_empty())
                .map(str::to_owned),
        );
    }
    allowed
}

#[test]
fn every_registered_command_is_allowed_for_some_window() {
    // A command registered in the handler but absent from every capability is unreachable: the
    // webview gets `<command> not allowed. Command not found`, which looks like a missing
    // registration. Narrow windows (tray, firewall alert, MCP confirm, guide) legitimately own
    // their own commands, so the guard is "some window", not "the main window".
    let allowed = allowed_anywhere();
    let mut missing: Vec<String> = registered_commands()
        .into_iter()
        .filter(|command| !allowed.contains(command))
        .collect();
    missing.sort();
    missing.dedup();

    assert!(
        missing.is_empty(),
        "these commands are registered but no capability in permissions/native.toml allows them, \
         so no webview can invoke them: {missing:?}"
    );
}

#[test]
fn the_allow_list_names_no_command_the_app_never_registers() {
    // The reverse direction is a smaller risk (dead entries), but a typo here silently
    // allows nothing, so it is worth pinning too.
    let registered = registered_commands();
    let mut unknown: Vec<String> = allowed_commands("native-main")
        .into_iter()
        .filter(|command| !registered.contains(command))
        .collect();
    unknown.sort();
    unknown.dedup();

    assert!(
        unknown.is_empty(),
        "permissions/native.toml (native-main) allows commands that src/lib.rs does not register: {unknown:?}"
    );
}

#[test]
fn the_panel_history_commands_are_reachable_from_the_main_window() {
    // The regression this file was written for: both commands shipped in the handler and in the
    // generated bindings, but neither was in the ACL, so the history popover failed at runtime
    // with "not allowed. Command not found" while the code looked complete.
    let allowed = allowed_commands("native-main");
    for command in ["hermes_panel_history", "hermes_panel_session_archive"] {
        assert!(
            allowed.iter().any(|entry| entry == command),
            "{command} must be allowed in native-main"
        );
    }
}

#[test]
fn profile_windows_get_only_the_assistant_surface() {
    let allowed = allowed_commands("native-hermes-profile");
    for command in [
        "hermes_chat",
        "hermes_model_options",
        "hermes_agent_profile_create",
        "hermes_open_profile_window",
    ] {
        assert!(
            allowed.iter().any(|entry| entry == command),
            "{command} must be allowed for Hermes profile windows"
        );
    }
    for command in [
        "firewall_status",
        "uninstall_execute",
        "settings_set",
        "app_quit",
        "mcp_set_enabled",
    ] {
        assert!(
            !allowed.iter().any(|entry| entry == command),
            "{command} must not be reachable from a Hermes profile window"
        );
    }
}
