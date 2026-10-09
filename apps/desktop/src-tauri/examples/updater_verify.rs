#[path = "../tests/support/updater.rs"]
mod support;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if !arguments.is_empty() {
        return verify_archive(&arguments).await;
    }
    let tmp = tempfile::tempdir()?;
    let path = support::bundle(tmp.path())?;
    let server =
        support::Server::new(support::PAYLOAD.to_vec(), "0.0.2", support::SIGNATURE).await?;
    let app = support::app("0.0.1")?;
    let updater = support::updater(&app, &server, &path)?;
    let update = updater.check().await?.ok_or("update_not_found")?;
    let before = support::version(&path)?;
    let mut downloaded = 0;
    let bytes = update.download(|n, _| downloaded += n, || {}).await?;
    tokio::task::spawn_blocking(move || update.install(bytes)).await??;
    let after = support::version(&path)?;
    if (before.as_str(), after.as_str()) != ("0.0.1", "0.0.2") {
        return Err("version_transition_failed".into());
    }
    println!(
        "Local update verified: {before} → {after}, downloaded and verified {downloaded} bytes; temporary app cleaned up, no GUI started."
    );
    Ok(())
}

async fn verify_archive(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if arguments.len() != 4
        || !matches!(
            arguments[0].as_str(),
            "--verify-archive" | "--install-archive"
        )
    {
        return Err(
            "usage: --verify-archive/--install-archive <archive> <version> <public>".into(),
        );
    }
    let archive = std::path::Path::new(&arguments[1]);
    let bytes = tokio::fs::read(archive).await?;
    let signature = tokio::fs::read_to_string(format!("{}.sig", archive.display())).await?;
    let public = tokio::fs::read_to_string(&arguments[3]).await?;
    let tmp = tempfile::tempdir()?;
    let path = support::bundle(tmp.path())?;
    let server = support::Server::new(bytes.clone(), &arguments[2], &signature).await?;
    let install = arguments[0] == "--install-archive";
    let app = support::app_with_public(if install { "0.0.1" } else { "0.0.0-0" }, &public)?;
    let update = support::updater(&app, &server, &path)?
        .check()
        .await?
        .ok_or("update_not_found")?;
    let downloaded = update.download(|_, _| {}, || {}).await?;
    if downloaded != bytes {
        return Err("archive_content_mismatch".into());
    }
    if install {
        let before = support::version(&path)?;
        tokio::task::spawn_blocking(move || update.install(downloaded)).await??;
        let after = support::version(&path)?;
        if after != arguments[2] {
            return Err("native_version_transition_failed".into());
        }
        // The updater replaces only a temporary app; never execute the real build binary or write user installation directories.
        println!(
            "Native update archive replacement verified: {before} → {after}, {} bytes verified; app not started.",
            bytes.len()
        );
    } else {
        println!(
            "Native update signature verified by plugin: {} bytes, not installed.",
            bytes.len()
        );
    }
    Ok(())
}
