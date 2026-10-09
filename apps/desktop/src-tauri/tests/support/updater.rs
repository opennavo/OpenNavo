use opennavo_desktop_lib::AppError;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri_plugin_updater::UpdaterExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

pub const PAYLOAD: &[u8] = include_bytes!("../fixtures/updater/OpenNavo_demo.app.tar.gz");
pub const SIGNATURE: &str = include_str!("../fixtures/updater/OpenNavo_demo.app.tar.gz.sig");
pub const PUBLIC: &str = include_str!("../fixtures/updater/development.pub");
fn error(error: impl std::fmt::Display) -> AppError {
    AppError::new("E_UNKNOWN", "updater_verify").with_detail(error.to_string())
}
pub struct Server {
    pub base: String,
    runner: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.runner.abort();
    }
}
impl Server {
    pub async fn new(payload: Vec<u8>, version: &str, signature: &str) -> Result<Self, AppError> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version":version, "notes":"本地签名与更新验证", "pub_date":"2026-10-05T00:00:00Z",
            "platforms":{
                "darwin-aarch64":{"url":format!("{base}/app.tar.gz"),"signature":signature.trim()},
                "darwin-x86_64":{"url":format!("{base}/app.tar.gz"),"signature":signature.trim()}
            }
        }))?;
        let payload = Arc::new(payload);
        let manifest = Arc::new(manifest);
        let runner = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let payload = payload.clone();
                let manifest = manifest.clone();
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    let size = match tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        stream.read(&mut request),
                    )
                    .await
                    {
                        Ok(Ok(size)) => size,
                        _ => return,
                    };
                    let request = String::from_utf8_lossy(&request[..size]);
                    // Simulate redirects from fixed GitHub download URLs to asset hosts; verify native updater redirect handling.
                    if request.starts_with("GET /app.tar.gz ") {
                        let _ = stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /asset.tar.gz\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                        return;
                    }
                    let body = if request.starts_with("GET /latest.json ") {
                        manifest
                    } else {
                        payload
                    };
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/octet-stream\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                });
            }
        });
        Ok(Self { base, runner })
    }
}
pub fn app(version: &str) -> Result<tauri::App<tauri::test::MockRuntime>, AppError> {
    app_with_public(version, PUBLIC)
}
pub fn app_with_public(
    version: &str,
    public: &str,
) -> Result<tauri::App<tauri::test::MockRuntime>, AppError> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.package_info_mut().version = version.parse().map_err(error)?;
    context.config_mut().identifier = "com.opennavo.desktop.dev_verify".into();
    // Only local MockRuntime uses HTTP; production configuration permits HTTPS only.
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({"pubkey":public.trim(),"dangerousInsecureTransportProtocol":true}),
    );
    tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .map_err(error)
}
pub fn bundle(root: &Path) -> Result<PathBuf, AppError> {
    let app = root.join("OpenNavo_demo.app");
    std::fs::create_dir_all(app.join("Contents/MacOS"))?;
    let mut info = plist::Dictionary::new();
    info.insert("CFBundleShortVersionString".into(), "0.0.1".into());
    plist::Value::Dictionary(info)
        .to_file_xml(app.join("Contents/Info.plist"))
        .map_err(error)?;
    let executable = app.join("Contents/MacOS/opennavo_demo");
    std::fs::write(&executable, "OpenNavo test fixture 0.0.1\n")?;
    Ok(executable)
}
pub fn version(executable: &Path) -> Result<String, AppError> {
    let path = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| error("bundle_path"))?
        .join("Info.plist");
    let info = plist::Value::from_file(path).map_err(error)?;
    info.as_dictionary()
        .and_then(|d| d.get("CFBundleShortVersionString"))
        .and_then(plist::Value::as_string)
        .map(str::to_owned)
        .ok_or_else(|| error("bundle_version"))
}
pub fn updater(
    app: &tauri::App<tauri::test::MockRuntime>,
    server: &Server,
    path: &Path,
) -> Result<tauri_plugin_updater::Updater, AppError> {
    app.updater_builder()
        .endpoints(vec![
            format!("{}/latest.json", server.base)
                .parse()
                .map_err(error)?,
        ])
        .map_err(error)?
        .executable_path(path)
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(error)
}
