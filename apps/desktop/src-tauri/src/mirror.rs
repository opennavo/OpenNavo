use crate::{AppError, model::*};
use std::{
    error::Error as _,
    time::{Duration, Instant},
};
pub const VARIABLES: [(&str, &str); 4] = [
    ("HOMEBREW_API_DOMAIN", "apiDomain"),
    ("HOMEBREW_BOTTLE_DOMAIN", "bottleDomain"),
    ("HOMEBREW_BREW_GIT_REMOTE", "brewGitRemote"),
    ("HOMEBREW_CORE_GIT_REMOTE", "coreGitRemote"),
];
pub fn validate_url(value: &str) -> Result<(), AppError> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(AppError::new("E_INVALID_ARG", "mirror_url"));
    }
    let url =
        reqwest::Url::parse(value).map_err(|_| AppError::new("E_INVALID_ARG", "mirror_url"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new("E_INVALID_ARG", "mirror_url"));
    }
    Ok(())
}
pub fn normalize(mut choice: MirrorChoice) -> Result<MirrorChoice, AppError> {
    crate::brew::args::validate_token(&choice.key)?;
    if choice.key == "official" {
        choice.api_domain = None;
        choice.bottle_domain = None;
        choice.brew_git_remote = None;
        choice.core_git_remote = None;
    }
    for value in [
        &choice.api_domain,
        &choice.bottle_domain,
        &choice.brew_git_remote,
        &choice.core_git_remote,
    ]
    .into_iter()
    .flatten()
    {
        validate_url(value)?;
    }
    Ok(choice)
}
pub fn variables(choice: &MirrorChoice) -> Vec<(&'static str, &str)> {
    if choice.key == "official" {
        return Vec::new();
    }
    [
        (&VARIABLES[0].0, &choice.api_domain),
        (&VARIABLES[1].0, &choice.bottle_domain),
        (&VARIABLES[2].0, &choice.brew_git_remote),
        (&VARIABLES[3].0, &choice.core_git_remote),
    ]
    .into_iter()
    .filter_map(|(key, value)| value.as_deref().map(|value| (*key, value)))
    .collect()
}
/// Text for Settings to copy, never executed or written to shell configuration; URLs remain single-quoted strings.
pub fn terminal_environment(choice: &MirrorChoice) -> Result<String, AppError> {
    let choice = normalize(choice.clone())?;
    if choice.key == "official" {
        // One variable per line, matching export formatting, to avoid a long command in Settings.
        return Ok(VARIABLES
            .iter()
            .map(|(name, _)| format!("unset {name}"))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    Ok(variables(&choice)
        .into_iter()
        .map(|(key, value)| format!("export {key}='{}'", value.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join("\n"))
}
fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "timeout".into();
    }
    let mut reason = error.to_string().to_lowercase();
    let mut source = error.source();
    while let Some(next) = source {
        reason.push_str(&next.to_string().to_lowercase());
        source = next.source();
    }
    if reason.contains("dns") || reason.contains("resolve") || reason.contains("getaddrinfo") {
        "dns"
    } else if reason.contains("tls") || reason.contains("certificate") || reason.contains("ssl") {
        "tls"
    } else {
        "connect"
    }
    .into()
}
pub async fn probe(mirrors: Vec<MirrorInput>) -> Result<Vec<MirrorProbe>, AppError> {
    probe_with_timeout(mirrors, Duration::from_secs(5)).await
}
pub async fn probe_with_timeout(
    mirrors: Vec<MirrorInput>,
    timeout: Duration,
) -> Result<Vec<MirrorProbe>, AppError> {
    if mirrors.len() > 32 {
        return Err(AppError::new("E_INVALID_ARG", "mirror_count"));
    }
    let mut identities = std::collections::HashSet::new();
    for input in &mirrors {
        crate::brew::args::validate_token(&input.key)?;
        if !identities.insert(&input.key) {
            return Err(AppError::new("E_INVALID_ARG", "mirror_duplicate"));
        }
        validate_url(&input.probe_url)?;
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("OpenNavo/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let mut results = Vec::new();
    let mut inputs = mirrors.into_iter().enumerate();
    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..4 {
        if let Some((index, input)) = inputs.next() {
            launch(&mut workers, client.clone(), index, input);
        }
    }
    while let Some(result) = workers.join_next().await {
        results.push(result.map_err(|e| {
            AppError::new("E_NETWORK", "mirror_probe_task").with_detail(e.to_string())
        })?);
        if let Some((index, input)) = inputs.next() {
            launch(&mut workers, client.clone(), index, input);
        }
    }
    results.sort_by_key(|r| r.0);
    Ok(results.into_iter().map(|r| r.1).collect())
}
fn launch(
    workers: &mut tokio::task::JoinSet<(usize, MirrorProbe)>,
    client: reqwest::Client,
    index: usize,
    input: MirrorInput,
) {
    workers.spawn(async move {
        let start = Instant::now();
        let result = match client.head(input.probe_url).send().await {
            Ok(response) => {
                let status = response.status();
                let ok = status.is_success();
                MirrorProbe {
                    key: input.key,
                    ok,
                    latency_ms: ok
                        .then(|| start.elapsed().as_millis().min(u32::MAX as u128) as u32),
                    status: Some(status.as_u16()),
                    error: (!ok).then(|| format!("http_{}", status.as_u16())),
                }
            }
            Err(error) => MirrorProbe {
                key: input.key,
                ok: false,
                latency_ms: None,
                status: None,
                error: Some(network_error(&error)),
            },
        };
        (index, result)
    });
}
