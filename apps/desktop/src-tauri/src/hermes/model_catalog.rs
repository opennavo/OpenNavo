use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;

use super::{
    AppError, HermesModelOptions, HermesModelOptionsInput, HermesRuntimeState,
    custom_provider_endpoint, installing_error, profiles, provider_id, provider_key_env,
    runtime_command_with_entrypoint,
};

/// The same inventory builder as Hermes' GET /api/model/options, in a process scoped to the
/// requested home. Draft endpoint and credential overrides last for this read.
const ENTRYPOINT: &str = r#"
import json
import os
import sys
from contextlib import redirect_stdout
from dataclasses import replace

options = json.load(sys.stdin)
with redirect_stdout(sys.stderr):
    from hermes_cli.env_loader import load_hermes_dotenv
    load_hermes_dotenv()
    from hermes_cli.inventory import build_model_options_payload, load_picker_context

    context = load_picker_context()
    provider = options["provider"]
    endpoint = options["endpoint"]
    key = options["api_key"]
    key_env = options["key_env"]
    if endpoint:
        from utils import same_base_url_origin

        saved = context.user_providers.get(provider)
        if not isinstance(saved, dict):
            saved = {}
        saved_url = saved.get("base_url") or saved.get("api") or saved.get("url")
        entry = {"api": endpoint, "discover_models": True}
        if key:
            entry["api_key"] = key
        elif saved_url and same_base_url_origin(saved_url, endpoint):
            entry["key_env"] = key_env
        context = replace(context, current_provider=provider, current_model=options["model"],
                          current_base_url=endpoint, user_providers={**context.user_providers, provider: entry})
    elif key and provider != "openavoo-custom":
        os.environ[key_env] = key

    catalog = build_model_options_payload(context, refresh=options["refresh"],
                                          include_unconfigured=options["include_unconfigured"])
json.dump(catalog, sys.stdout)
"#;

pub(crate) async fn read(
    bin: &Path,
    root_home: &Path,
    state: &HermesRuntimeState,
    input: &HermesModelOptionsInput,
) -> Result<HermesModelOptions, AppError> {
    if state.installing.load(Ordering::SeqCst) {
        return Err(installing_error());
    }
    let profile = input.profile.as_deref();
    profiles::ensure_local_profile(root_home, profile)?;
    let home = profiles::resolve_home(root_home, profile)?;
    let endpoint = input
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|endpoint| !endpoint.is_empty());
    let payload = json!({
        "provider": provider_id(&input.provider),
        "model": input.model,
        "endpoint": custom_provider_endpoint(&input.provider, endpoint),
        "api_key": input.api_key.as_deref().map(str::trim),
        "key_env": provider_key_env(&input.provider),
        "refresh": input.refresh,
        "include_unconfigured": input.include_unconfigured,
    })
    .to_string();
    let mut command = runtime_command_with_entrypoint(bin, ENTRYPOINT)?;
    command
        .env("HERMES_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = timeout(Duration::from_secs(45), async {
        let mut child = command.spawn()?;
        let mut stdin = child.stdin.take().expect("the catalog request is piped");
        let send = async move { stdin.write_all(payload.as_bytes()).await };
        let (_, output) = tokio::try_join!(send, child.wait_with_output())?;
        Ok::<_, std::io::Error>(output)
    })
    .await
    .map_err(|_| {
        AppError::new(
            "E_HERMES_MODEL_OPTIONS_TIMEOUT",
            "Loading the model catalog timed out.",
        )
    })?
    .map_err(|error| {
        AppError::new(
            "E_HERMES_MODEL_OPTIONS",
            "Could not read the Hermes model catalog.",
        )
        .with_detail(error.to_string())
    })?;
    if !output.status.success() {
        return Err(AppError::new(
            "E_HERMES_MODEL_OPTIONS",
            "Hermes could not load the model catalog.",
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| {
        AppError::new(
            "E_HERMES_MODEL_OPTIONS",
            "Hermes returned an invalid model catalog.",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::TcpListener;

    #[tokio::test]
    #[ignore = "requires HERMES_RUNTIME_BIN"]
    async fn refreshes_a_draft_endpoint_independently_of_the_chat_gateway() {
        let bin = std::env::var("HERMES_RUNTIME_BIN").unwrap();
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profiles/work");
        std::fs::create_dir_all(&profile).unwrap();
        let config =
            "_config_version: 54\nmodel:\n  provider: openai-api\n  default: saved-model\n";
        let saved_env = "OPENNAVO_CUSTOM_API_KEY=stored-key\n";
        std::fs::write(profile.join("config.yaml"), config).unwrap();
        std::fs::write(profile.join(".env"), saved_env).unwrap();

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let provider = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut lines = BufReader::new(&mut socket).lines();
            let mut headers = Vec::new();
            while let Some(line) = lines.next_line().await.unwrap() {
                if line.is_empty() {
                    break;
                }
                headers.push(line.to_ascii_lowercase());
            }
            let body = r#"{"data":[{"id":"listed-model"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            headers
        });
        let state = HermesRuntimeState::default();
        let _gateway = state.gateway.lock().await;
        let options = read(
            Path::new(&bin),
            root.path(),
            &state,
            &HermesModelOptionsInput {
                provider: "custom".into(),
                model: "typed-model".into(),
                effort: "medium".into(),
                fast: false,
                api_key: Some("draft-key".into()),
                endpoint: Some(endpoint),
                refresh: true,
                include_unconfigured: true,
                gateway_url: None,
                profile_id: None,
                profile: Some("work".into()),
                panel_auth: false,
            },
        )
        .await
        .unwrap();
        let row = options
            .providers
            .iter()
            .find(|row| row.slug == "openavoo-custom")
            .unwrap();
        assert!(row.models.iter().any(|model| model == "listed-model"));
        let headers = timeout(Duration::from_secs(1), provider)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(headers.first().unwrap(), "get /v1/models http/1.1");
        assert!(
            headers
                .iter()
                .any(|header| header == "authorization: bearer draft-key")
        );
        assert_eq!(
            std::fs::read_to_string(profile.join("config.yaml")).unwrap(),
            config
        );
        assert_eq!(
            std::fs::read_to_string(profile.join(".env")).unwrap(),
            saved_env
        );
        assert!(!root.path().join("config.yaml").exists());
    }
}

#[cfg(test)]
mod entrypoint_tests {
    use super::*;

    /// Silent catalog discovery must not attach a saved key when the profile has no saved
    /// endpoint to bind it to. An explicit draft key is handled by the `if key` branch.
    #[test]
    fn a_saved_key_requires_a_saved_same_origin_endpoint() {
        assert!(
            ENTRYPOINT.contains("elif saved_url and same_base_url_origin(saved_url, endpoint):")
        );
        assert!(!ENTRYPOINT.contains("not saved_url or same_base_url_origin"));
    }
}
