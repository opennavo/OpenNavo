use opennavo_desktop_lib::{core::DesktopCore, model::*};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() != Some("--real-read-only") {
        return Err("require --real-read-only; this program never starts a write queue".into());
    }
    let output = std::env::args().nth(2).map(PathBuf::from);
    let temp = tempfile::tempdir()?;
    let core = DesktopCore::open(
        temp.path().join("data"),
        temp.path().join("cache"),
        temp.path().join("unused_askpass"),
        Arc::new(|_| {}),
    )?;
    {
        let mut settings = core.settings.write().map_err(|_| "settings")?;
        settings.homebrew_analytics = Some(false);
    }
    let start = Instant::now();
    let items = core
        .refresh_library(LibraryChangeReason::Refresh, None)
        .await?;
    println!(
        "metadata scan: {}ms, {} casks, {} formulae",
        start.elapsed().as_millis(),
        items.iter().filter(|i| i.kind == Kind::Cask).count(),
        items.iter().filter(|i| i.kind == Kind::Formula).count()
    );
    assert!(start.elapsed() < Duration::from_secs(5));
    let cache_start = Instant::now();
    let _ = core.library_list()?;
    assert!(cache_start.elapsed().as_millis() < 300);
    while !core.storage_summary()?.complete {
        if start.elapsed() > Duration::from_secs(180) {
            return Err("size scan timeout".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let items = core.library_list()?;
    let with_apps: Vec<_> = items
        .iter()
        .filter(|i| i.kind == Kind::Cask && !i.app_paths.is_empty())
        .collect();
    let icons = with_apps.iter().filter(|i| i.icon_path.is_some()).count();
    let actual = with_apps
        .iter()
        .filter(|i| i.actual_version.is_some())
        .count();
    let self_updated = items
        .iter()
        .filter(|i| i.status == InstalledStatus::SelfUpdated)
        .count();
    for item in &with_apps {
        if let Some(path) = &item.icon_path {
            let image = image::open(path)?;
            assert!(image.width() <= 512 && image.height() <= 512);
        }
    }
    println!(
        "enriched: {}ms, {actual}/{} actual versions, {icons}/{} PNG icons, {self_updated} self_updated",
        start.elapsed().as_millis(),
        with_apps.len(),
        with_apps.len()
    );
    for item in &with_apps {
        if item.icon_path.is_none() {
            for path in &item.app_paths {
                let result = opennavo_desktop_lib::library::files::icon(
                    &core.database,
                    std::path::Path::new(path),
                    &temp.path().join("cache/icons"),
                );
                eprintln!("icon diagnosis {}: {:?}", item.token, result);
            }
        }
    }
    assert_eq!(icons, with_apps.len());
    assert_eq!(actual, with_apps.len());
    let report = serde_json::json!({"metadataCount":items.len(),"scanMs":start.elapsed().as_millis(),"apps":with_apps.len(),"icons":icons,"actualVersions":actual,"selfUpdated":self_updated,"storage":core.storage_summary()?,"items":items});
    if let Some(path) = output {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(&report)?)?;
    }
    Ok(())
}
