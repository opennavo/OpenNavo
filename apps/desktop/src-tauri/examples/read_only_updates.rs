use opennavo_desktop_lib::{
    brew::{args::ReadOp, locate, version::compare},
    core::DesktopCore,
    library::files,
    model::*,
    updates::Outdated,
};
use std::{
    cmp::Ordering,
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() != Some("--real-read-only") {
        return Err("require --real-read-only; never runs update or upgrade".into());
    }
    let output = std::env::args().nth(2).map(PathBuf::from);
    let tmp = tempfile::tempdir()?;
    let core = DesktopCore::open(
        tmp.path().join("data"),
        tmp.path().join("cache"),
        tmp.path().join("askpass"),
        Arc::new(|_| {}),
    )?;
    {
        let mut settings = core.settings.write().map_err(|_| "settings")?;
        settings.homebrew_analytics = Some(false);
        settings.include_greedy = true;
    }
    let installed = core
        .refresh_library(LibraryChangeReason::Refresh, None)
        .await?;
    let items = core.check_updates(false).await?;
    let settings = core.current_settings()?;
    let brew = core.brew_info().await?;
    let raw = locate::read(&brew, &settings, ReadOp::Outdated { greedy: true }, None).await?;
    let direct: Outdated = serde_json::from_str(&raw)?;
    let mut expected: BTreeSet<_> = direct
        .formulae
        .iter()
        .map(|i| format!("formula:{}", i.name))
        .chain(direct.casks.iter().map(|i| format!("cask:{}", i.name)))
        .collect();
    let mut excluded = Vec::new();
    for candidate in &direct.casks {
        if let Some(local) = installed
            .iter()
            .find(|i| i.kind == Kind::Cask && i.token == candidate.name && i.auto_updates)
            && local
                .app_paths
                .iter()
                .filter_map(|p| files::actual_version(Path::new(p)))
                .any(|v| {
                    compare(&v, &candidate.current_version).is_some_and(|o| o != Ordering::Less)
                })
        {
            expected.remove(&format!("cask:{}", candidate.name));
            excluded.push(candidate.name.clone());
        }
    }
    let actual: BTreeSet<_> = items
        .iter()
        .map(|i| format!("{}:{}", i.kind.as_str(), i.token))
        .collect();
    assert_eq!(actual, expected);
    println!(
        "greedy read-only: {} formulae + {} casks -> {} candidates, {} self_updated excluded; exact token sets match",
        direct.formulae.len(),
        direct.casks.len(),
        items.len(),
        excluded.len()
    );
    if let Some(path) = output {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &serde_json::json!({"formulae":direct.formulae.len(),"casks":direct.casks.len(),"remaining":items.len(),"excluded":excluded,"items":items}),
            )?,
        )?;
    }
    core.queue.shutdown();
    while !core.storage_summary()?.complete {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}
