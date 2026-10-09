#![cfg(target_os = "macos")]
#[path = "support/updater.rs"]
mod support;

#[test]
fn self_update_checks_default_to_enabled_and_preserve_explicit_opt_out() {
    use opennavo_desktop_lib::model::Settings;
    assert!(Settings::default().auto_check_app_updates);
    let legacy: Settings = serde_json::from_str(r#"{"autoCheck":false}"#).unwrap();
    assert!(!legacy.auto_check);
    assert!(legacy.auto_check_app_updates);
    let opted_out: Settings = serde_json::from_str(r#"{"autoCheckAppUpdates":false}"#).unwrap();
    assert!(!opted_out.auto_check_app_updates);
    let persisted = serde_json::to_string(&opted_out).unwrap();
    assert!(
        !serde_json::from_str::<Settings>(&persisted)
            .unwrap()
            .auto_check_app_updates
    );
}
use std::path::Path;
use support::*;

#[tokio::test]
async fn native_updater_download_verifies_and_replaces_only_temporary_app() {
    let tmp = tempfile::tempdir().unwrap();
    let path = bundle(tmp.path()).unwrap();
    let server = Server::new(PAYLOAD.to_vec(), "0.0.2", SIGNATURE)
        .await
        .unwrap();
    let app = app("0.0.1").unwrap();
    let updater = updater(&app, &server, &path).unwrap();
    let update = updater.check().await.unwrap().unwrap();
    assert_eq!(
        (&*update.current_version, &*update.version),
        ("0.0.1", "0.0.2")
    );
    assert_eq!(version(&path).unwrap(), "0.0.1");
    let mut downloaded = 0;
    let mut finished = false;
    let bytes = update
        .download(|n, _| downloaded += n, || finished = true)
        .await
        .unwrap();
    assert!(finished);
    assert_eq!(downloaded, PAYLOAD.len());
    assert_eq!(bytes, PAYLOAD);
    assert_eq!(
        tauri_plugin_updater::extract_path_from_executable(&path).unwrap(),
        tmp.path().join("OpenNavo_demo.app")
    );
    tokio::task::spawn_blocking(move || update.install(bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(version(&path).unwrap(), "0.0.2");
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "OpenNavo test fixture 0.0.2\n"
    );
}

#[tokio::test]
async fn rejects_modified_archive_invalid_signature_and_signed_version_mismatch() {
    let tmp = tempfile::tempdir().unwrap();
    let path = bundle(tmp.path()).unwrap();
    let app = app("0.0.1").unwrap();
    let mut modified = PAYLOAD.to_vec();
    modified[10] ^= 1;
    for (payload, remote_version, signature) in [
        (modified, "0.0.2", SIGNATURE),
        (PAYLOAD.to_vec(), "0.0.2", "invalid"),
        (PAYLOAD.to_vec(), "99.0.0", SIGNATURE),
    ] {
        let server = Server::new(payload, remote_version, signature)
            .await
            .unwrap();
        let update = updater(&app, &server, &path)
            .unwrap()
            .check()
            .await
            .unwrap()
            .unwrap();
        assert!(update.download(|_, _| {}, || {}).await.is_err());
        assert_eq!(version(&path).unwrap(), "0.0.1");
    }
}

#[tokio::test]
async fn current_and_older_versions_never_offer_downgrade() {
    let tmp = tempfile::tempdir().unwrap();
    let path = bundle(tmp.path()).unwrap();
    let app = app("0.0.2").unwrap();
    for version in ["0.0.1", "0.0.2"] {
        let server = Server::new(PAYLOAD.to_vec(), version, SIGNATURE)
            .await
            .unwrap();
        assert!(
            updater(&app, &server, &path)
                .unwrap()
                .check()
                .await
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn production_configuration_and_capabilities_use_https_channels_and_main_only() {
    let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let parsed: tauri_plugin_updater::Config =
        serde_json::from_value(context.config().plugins.0["updater"].clone()).unwrap();
    assert!(!parsed.dangerous_insecure_transport_protocol);
    assert!(!parsed.allow_downgrades);
    assert_eq!(
        parsed.endpoints[0].as_str(),
        "https://cdn.opennavo.com/desktop/stable/latest.json"
    );
    assert!(parsed.pubkey.len() > 80);
    let beta: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.beta.conf.json")).unwrap();
    assert_eq!(
        beta["plugins"]["updater"]["endpoints"][0],
        "https://cdn.opennavo.com/desktop/beta/latest.json"
    );
    let authority = context.runtime_authority_mut();
    for command in ["check", "download", "install", "download_and_install"] {
        let command = format!("plugin:updater|{command}");
        assert!(
            authority
                .resolve_access(&command, "main", "main", &tauri::ipc::Origin::Local)
                .is_some()
        );
        assert!(
            authority
                .resolve_access(&command, "tray", "tray", &tauri::ipc::Origin::Local)
                .is_none()
        );
    }
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/updater/development.pub");
    assert!(fixture.is_file());
}
