use super::{
    args::{ReadOp, read_args},
    env::construct,
};
use crate::{
    AppError,
    model::{BrewInfo, EnvInfo, PermissionState, Settings},
};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

pub async fn read(
    brew: &BrewInfo,
    settings: &Settings,
    op: ReadOp,
    token: Option<&str>,
) -> Result<String, AppError> {
    let mut command = Command::new(&brew.path);
    command
        .args(read_args(op, token)?)
        .env_clear()
        .envs(construct(
            settings,
            &brew.prefix,
            Path::new("/nonexistent/opennavo_askpass"),
        ))
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| AppError::new("E_TIMEOUT", "brew_read_timeout"))??;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(super::parse::map_error(&detail).unwrap_or_else(|| {
            AppError::new("E_UNKNOWN", "brew_read_failed").with_detail(detail)
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub async fn locate(settings: &Settings) -> Result<BrewInfo, AppError> {
    let mut paths = Vec::new();
    // A failed test override must never fall through to real brew and execute simulated writes on the development machine.
    if let Some(path) = std::env::var_os("OPENNAVO_BREW_PATH") {
        return probe(&PathBuf::from(path), settings).await;
    }
    if let Some(path) = &settings.brew_path {
        paths.push(PathBuf::from(path));
    }
    paths.extend([
        PathBuf::from("/opt/homebrew/bin/brew"),
        PathBuf::from("/usr/local/bin/brew"),
    ]);
    for path in paths {
        if let Ok(info) = probe(&path, settings).await {
            return Ok(info);
        }
    }
    // Use only a fixed shell command for executable discovery; invoke brew itself with argument arrays.
    let mut shell = Command::new("/bin/zsh");
    shell.args(["-lc", "command -v brew"]).kill_on_drop(true);
    if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(2), shell.output()).await
        && output.status.success()
    {
        let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        if let Ok(info) = probe(&path, settings).await {
            return Ok(info);
        }
    }
    Err(AppError::new("E_BREW_NOT_FOUND", "brew_not_found"))
}

async fn probe(path: &Path, settings: &Settings) -> Result<BrewInfo, AppError> {
    if !path.is_absolute()
        || !tokio::fs::metadata(path)
            .await
            .is_ok_and(|metadata| metadata.is_file())
    {
        return Err(AppError::new("E_BREW_NOT_FOUND", "invalid_brew_path"));
    }
    let prefix = path
        .parent()
        .and_then(Path::parent)
        .unwrap_or(Path::new("/opt/homebrew"));
    let mut info = BrewInfo {
        path: path.to_string_lossy().into(),
        prefix: prefix.to_string_lossy().into(),
        version: String::new(),
    };
    let version = read(&info, settings, ReadOp::Version, None).await?;
    info.version = version
        .lines()
        .find_map(|line| line.strip_prefix("Homebrew "))
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::new("E_BREW_NOT_FOUND", "invalid_brew_version"))?
        .to_owned();
    info.prefix = read(&info, settings, ReadOp::Prefix, None).await?;
    if !Path::new(&info.prefix).is_absolute() {
        return Err(AppError::new("E_BREW_NOT_FOUND", "invalid_brew_prefix"));
    }
    Ok(info)
}

pub async fn detect(settings: &Settings, app_management: PermissionState) -> EnvInfo {
    async fn system(program: &str, args: &[&str]) -> Option<String> {
        let mut command = Command::new(program);
        command.args(args).kill_on_drop(true);
        tokio::time::timeout(Duration::from_secs(2), command.output())
            .await
            .ok()?
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    }
    let (version, rosetta, clt, brew) = tokio::join!(
        system("/usr/bin/sw_vers", &["-productVersion"]),
        system("/usr/sbin/sysctl", &["-n", "sysctl.proc_translated"]),
        system("/usr/bin/xcode-select", &["-p"]),
        tokio::time::timeout(Duration::from_secs(3), locate(settings))
    );
    EnvInfo {
        macos_version: version.unwrap_or_default(),
        arch: if std::env::consts::ARCH == "aarch64" {
            "arm64"
        } else {
            "x86_64"
        }
        .into(),
        rosetta: rosetta.as_deref() == Some("1"),
        clt_installed: clt.is_some(),
        brew: brew.ok().and_then(Result::ok),
        app_management,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn configured_fake_is_detected_without_mutating_real_brew() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-brew/brew");
        let settings = Settings {
            brew_path: Some(path.to_string_lossy().into()),
            ..Settings::default()
        };
        let info = locate(&settings).await.expect("simulated discovery");
        assert_eq!(info.version, "7.0.7");
        assert_eq!(info.path, path.to_string_lossy());
    }
}
