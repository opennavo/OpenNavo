use crate::{AppError, model::Settings};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;

pub const OFFICIAL: &str = "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh";
pub const MIRROR: &str = "https://mirrors.ustc.edu.cn/misc/brew-install.sh";
pub struct Script {
    pub path: PathBuf,
    root: PathBuf,
}
impl Drop for Script {
    fn drop(&mut self) {
        let root = self.root.clone();
        std::thread::spawn(move || {
            let _ = std::fs::remove_dir_all(root);
        });
    }
}
pub fn source(settings: &Settings) -> &'static [&'static str] {
    if settings.mirror.key == "official" {
        &[OFFICIAL]
    } else {
        &[MIRROR, OFFICIAL]
    }
}
pub async fn download_candidates(
    root: &Path,
    sources: &[String],
    cancel: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
    log_path: &Path,
    emit: impl Fn(String),
) -> Result<Script, AppError> {
    let mut last = AppError::new("E_DOWNLOAD", "installer_download");
    for (index, source) in sources.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new("E_INTERRUPTED", "installer_canceled"));
        }
        if index > 0 {
            append_log(
                log_path,
                &format!("==> Falling back to {source} ({})", reason(&last)),
                &emit,
            )
            .await?;
        }
        append_log(
            log_path,
            &format!("==> Downloading the installer from {source}"),
            &emit,
        )
        .await?;
        let result = tokio::select! {
            biased;
            _ = notify.notified() => return Err(AppError::new("E_INTERRUPTED", "installer_canceled")),
            result = download(root, source) => result,
        };
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new("E_INTERRUPTED", "installer_canceled"));
        }
        match result {
            Ok(script) => return Ok(script),
            Err(error) if error.code != "E_DOWNLOAD" => return Err(error),
            Err(error) => {
                append_log(
                    log_path,
                    &format!("==> Installer download failed ({})", reason(&error)),
                    &emit,
                )
                .await?;
                last = error;
            }
        }
    }
    Err(last)
}
async fn append_log(path: &Path, line: &str, emit: &impl Fn(String)) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(format!("{line}\n").as_bytes()).await?;
    file.flush().await?;
    emit(line.to_owned());
    Ok(())
}
fn reason(error: &AppError) -> &str {
    error
        .detail
        .as_deref()
        .unwrap_or(match error.message.as_str() {
            "installer_timeout" => "timeout",
            "installer_content" => "content",
            "installer_size" => "size",
            "installer_empty" => "empty",
            "installer_download" => "download",
            _ => "io",
        })
}
pub async fn download(root: &Path, url: &str) -> Result<Script, AppError> {
    let root = root.join(uuid::Uuid::now_v7().to_string());
    // Create and return the cleanup guard inside the thread; dropping the result cleans up even if the waiter cancels.
    let script = crate::blocking(move || {
        let script = Script {
            path: root.join("install.sh"),
            root,
        };
        std::fs::create_dir_all(&script.root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script.root, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(script)
    })
    .await?;
    let client = reqwest::Client::builder()
        .https_only(url.starts_with("https://"))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(download_error)?
        .error_for_status()
        .map_err(download_error)?;
    if response
        .content_length()
        .is_some_and(|len| len > 1024 * 1024)
    {
        return Err(AppError::new("E_DOWNLOAD", "installer_size"));
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&script.path).await?;
    let mut bytes = 0;
    let mut content = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(download_error)? {
        bytes += chunk.len();
        if bytes > 1024 * 1024 {
            return Err(AppError::new("E_DOWNLOAD", "installer_size"));
        }
        file.write_all(&chunk).await?;
        content.extend_from_slice(&chunk);
    }
    if bytes == 0 {
        return Err(AppError::new("E_DOWNLOAD", "installer_empty"));
    }
    file.flush().await?;
    let first = content
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    if !matches!(first, b"#!/bin/bash" | b"#!/usr/bin/env bash")
        || !content
            .windows(b"Homebrew".len())
            .any(|part| part == b"Homebrew")
    {
        return Err(AppError::new("E_DOWNLOAD", "installer_content"));
    }
    Ok(script)
}
fn download_error(error: reqwest::Error) -> AppError {
    let reason = if error.is_timeout() {
        "timeout".into()
    } else if let Some(status) = error.status() {
        format!("http_{}", status.as_u16())
    } else if error.is_connect() {
        "connect".into()
    } else {
        "download".into()
    };
    AppError::new(
        "E_DOWNLOAD",
        if error.is_timeout() {
            "installer_timeout"
        } else {
            "installer_download"
        },
    )
    .with_detail(reason)
}
