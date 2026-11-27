//! Lightweight provider authentication probe. It only calls model-listing
//! endpoints, so testing never consumes completion tokens.

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use yaml_rust2::Yaml;

use super::{AppError, env_store, local_opencode_key, login, provider_key_env};

/// Error bodies are diagnostics, not a data channel: a gateway can return a whole HTML page.
const MAX_DIAGNOSTIC_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesTestInput {
    pub provider: String,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    /// Agent profile whose stored key is probed; `None`/`default` is the root home.
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub message: String,
}

/// Key the probe should use: an explicit one, else whatever the selected profile's `.env` holds,
/// else a key from the OpenCode CLI's own store.
fn resolve_key(app: &AppHandle, input: &HermesTestInput) -> Option<String> {
    if let Some(key) = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        return Some(key.to_owned());
    }
    let stored = login::profile_home(app, input.profile.as_deref())
        .ok()
        .and_then(|home| {
            let key = env_store::env_value(&home, provider_key_env(&input.provider))?;
            // A custom/local profile's stored key belongs to the endpoint saved in its
            // config. Sending it to a different origin would hand the credential to a host
            // the user never configured (the model catalog applies the same rule).
            if matches!(input.provider.as_str(), "custom" | "local") {
                let endpoint = input.endpoint.as_deref().map(str::trim).unwrap_or("");
                let configured = configured_endpoint(&home, &input.provider);
                if !same_origin(configured.as_deref(), Some(endpoint)) {
                    return None;
                }
            }
            Some(key)
        });
    stored.or_else(|| local_opencode_key(&input.provider))
}

/// The endpoint this profile last saved for the custom/local card.
fn configured_endpoint(home: &std::path::Path, provider: &str) -> Option<String> {
    let raw = std::fs::read_to_string(home.join("config.yaml")).ok()?;
    let doc = super::config_doc(Some(&raw));
    let root = doc.as_hash()?;
    let key = |value: &Yaml, name: &str| {
        value
            .as_hash()
            .and_then(|map| map.get(&Yaml::String(name.to_owned())))
            .and_then(Yaml::as_str)
            .map(str::to_owned)
    };
    if provider == "custom" || provider == "local" {
        let provider_url = root
            .get(&Yaml::String("providers".to_owned()))
            .and_then(|providers| providers.as_hash())
            .and_then(|providers| providers.get(&Yaml::String("openavoo-custom".to_owned())))
            .and_then(|entry| key(entry, "api"));
        return provider_url.or_else(|| {
            root.get(&Yaml::String("model".to_owned()))
                .and_then(|model| key(model, "base_url"))
        });
    }
    None
}

/// Scheme, host and port — the parts that decide whether a credential may travel.
fn origin_of(url: &str) -> Option<(String, String, Option<u16>)> {
    let url = reqwest::Url::parse(url.trim()).ok()?;
    Some((
        url.scheme().to_owned(),
        url.host_str()?.to_owned(),
        url.port_or_known_default(),
    ))
}

fn same_origin(left: Option<&str>, right: Option<&str>) -> bool {
    match (
        left.filter(|value| !value.trim().is_empty()),
        right.filter(|value| !value.trim().is_empty()),
    ) {
        (Some(left), Some(right)) => origin_of(left) == origin_of(right),
        // No saved endpoint means the stored key has no known destination; do not send it.
        _ => false,
    }
}

pub async fn test(app: AppHandle, input: HermesTestInput) -> Result<HermesTestResult, AppError> {
    let key = resolve_key(&app, &input);
    let provider = input.provider.as_str();
    if matches!(provider, "codex" | "claude-code" | "copilot" | "nous") {
        let local = login::status(&app, input.profile.as_deref()).ok();
        let (hermes_provider, local_detected) = match provider {
            "codex" => (
                "openai-codex",
                local.as_ref().map(|status| status.codex).unwrap_or(false),
            ),
            "claude-code" => (
                "anthropic",
                local
                    .as_ref()
                    .map(|status| status.claude_code)
                    .unwrap_or(false),
            ),
            "copilot" => (
                "copilot",
                local.as_ref().map(|status| status.copilot).unwrap_or(false),
            ),
            "nous" => (
                "nous",
                local.as_ref().map(|status| status.nous).unwrap_or(false),
            ),
            _ => (provider, false),
        };
        let authenticated =
            login::hermes_authenticated(&app, hermes_provider, input.profile.as_deref());
        if authenticated {
            return Ok(HermesTestResult {
                ok: true,
                status: None,
                message: "Hermes 认证已存在；实际模型请求会在对话时验证。".into(),
            });
        }
        if local_detected {
            return Ok(HermesTestResult {
                ok: false,
                status: None,
                message: "检测到本机凭据，但尚未连接 Hermes；请点“登录”完成连接。".into(),
            });
        }
        return Ok(HermesTestResult {
            ok: false,
            status: None,
            message: "未检测到该服务商的本机登录。".into(),
        });
    }
    let (url, mode) = match provider {
        "opencode-go" => (
            "https://opencode.ai/zen/go/v1/models".to_owned(),
            "opencode",
        ),
        "opencode" => ("https://opencode.ai/zen/v1/models".to_owned(), "opencode"),
        "openai" => ("https://api.openai.com/v1/models".to_owned(), "openai"),
        "anthropic" | "claude-code" => (
            "https://api.anthropic.com/v1/models".to_owned(),
            "anthropic",
        ),
        "google" => (
            "https://generativelanguage.googleapis.com/v1beta/models".to_owned(),
            "google",
        ),
        "openrouter" => ("https://openrouter.ai/api/v1/models".to_owned(), "openai"),
        "local" | "custom" => {
            let endpoint = input
                .endpoint
                .as_deref()
                .unwrap_or("")
                .trim()
                .trim_end_matches('/');
            if endpoint.is_empty() {
                return Ok(HermesTestResult {
                    ok: false,
                    status: None,
                    message: "请先填写 Base URL。".into(),
                });
            }
            let base = if endpoint.ends_with("/v1") {
                endpoint.to_owned()
            } else {
                format!("{endpoint}/v1")
            };
            (format!("{base}/models"), "openai")
        }
        _ => {
            return Ok(HermesTestResult {
                ok: false,
                status: None,
                message: "当前服务商暂不支持测试连接。".into(),
            });
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("OpenNavo/0.1.29"));
    if mode == "opencode" {
        headers.insert(
            "x-opencode-session",
            HeaderValue::from_static("open-navo-test"),
        );
    }
    if let Some(key) = key.as_deref() {
        if mode == "anthropic" {
            if let Ok(value) = HeaderValue::from_str(key) {
                headers.insert("x-api-key", value);
            }
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        } else if mode == "google" {
            // A key in the query string ends up in proxy logs and error messages. The
            // documented header keeps it out of both.
            if let Ok(value) = HeaderValue::from_str(key) {
                headers.insert("x-goog-api-key", value);
            }
        } else if let Ok(value) = HeaderValue::from_str(&format!("Bearer {key}")) {
            headers.insert(AUTHORIZATION, value);
        }
    }
    let response = probe_client()?
        .get(url)
        .headers(headers)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| {
            // `reqwest` includes the full URL in its Display; a configured endpoint may carry
            // a token or query. Only the transport class is useful to the user.
            AppError::new("E_HERMES_TEST", "连接测试失败。")
                .with_detail(error.without_url().to_string())
        })?;
    let status = response.status();
    let body = read_limited_body(response).await;
    if status.is_success() {
        Ok(HermesTestResult {
            ok: true,
            status: Some(status.as_u16()),
            message: format!("连接成功 · HTTP {}", status.as_u16()),
        })
    } else {
        let redacted = redact_secrets(&body, key.as_deref());
        let detail = if redacted.len() > 240 {
            let end = (0..=240)
                .rev()
                .find(|index| redacted.is_char_boundary(*index))
                .unwrap_or(0);
            &redacted[..end]
        } else {
            &redacted
        };
        Ok(HermesTestResult {
            ok: false,
            status: Some(status.as_u16()),
            message: format!("HTTP {} · {}", status.as_u16(), detail.trim()),
        })
    }
}

/// Auth probes carry a credential in a header. Redirects are disabled so a saved key can
/// never be forwarded to a different origin chosen by the first response.
fn probe_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| {
            AppError::new("E_HERMES_TEST", "连接测试失败。")
                .with_detail(error.without_url().to_string())
        })
}

/// Read a diagnostic body without buffering an unbounded page.
async fn read_limited_body(mut response: reqwest::Response) -> String {
    let mut body = Vec::new();
    while body.len() < MAX_DIAGNOSTIC_BYTES {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let room = MAX_DIAGNOSTIC_BYTES - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            Ok(None) | Err(_) => break,
        }
    }
    String::from_utf8_lossy(&body).into_owned()
}

/// Remove the probed credential from diagnostic output, plus any `key=`/`token=` query value
/// a host echoed back. The test never displays the key it sent.
fn redact_secrets(text: &str, key: Option<&str>) -> String {
    let mut text = text.to_owned();
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        text = text.replace(key, "[redacted]");
    }
    let pattern = regex::Regex::new(r#"(?i)(key|token|api_key|access_token)=([^&"' <>\r\n]*)"#)
        .expect("secret query regex");
    pattern.replace_all(&text, "$1=[redacted]").into_owned()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_configured_origin_may_receive_a_stored_key() {
        assert!(same_origin(
            Some("https://api.example.test/v1"),
            Some("https://api.example.test/other")
        ));
        assert!(!same_origin(
            Some("https://api.example.test/v1"),
            Some("https://evil.example.test/v1")
        ));
        assert!(!same_origin(
            Some("https://api.example.test/v1"),
            Some("http://api.example.test/v1")
        ));
        assert!(!same_origin(Some("https://api.example.test/v1"), Some("")));
        assert!(!same_origin(None, Some("https://api.example.test/v1")));
    }

    #[test]
    fn configured_endpoint_reads_the_custom_provider_block() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.yaml"),
            "providers:\n  openavoo-custom:\n    api: https://saved.example.test/v1\n",
        )
        .unwrap();
        assert_eq!(
            configured_endpoint(dir.path(), "custom").as_deref(),
            Some("https://saved.example.test/v1")
        );
        assert_eq!(configured_endpoint(dir.path(), "openai"), None);
    }

    #[tokio::test]
    async fn an_auth_probe_does_not_follow_a_redirect_to_another_origin() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://evil.example.test/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let response = probe_client()
            .unwrap()
            .get(format!("http://{addr}/models"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        let _ = server.await;
    }

    #[test]
    fn diagnostics_never_echo_the_probed_key() {
        let key = "sk-test-PLACEHOLDER";
        let redacted = redact_secrets(
            &format!("401 for https://api.example.test/v1?key={key}&alt=1 and header {key}",),
            Some(key),
        );
        assert!(!redacted.contains(key), "{redacted}");
        assert!(redacted.contains("alt=1"), "{redacted}");
        assert_eq!(
            redact_secrets("token=abc123&x=1", None),
            "token=[redacted]&x=1"
        );
    }
}
