use opennavo_desktop_lib::installer;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::{
    io::{Read, Write},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn source_candidates_follow_the_selected_mirror() {
    let mut settings = opennavo_desktop_lib::model::Settings::default();
    assert_eq!(installer::source(&settings), &[installer::OFFICIAL]);
    settings.mirror.key = "tuna".into();
    assert_eq!(
        installer::source(&settings),
        &[installer::MIRROR, installer::OFFICIAL]
    );
}

#[tokio::test]
async fn local_download_fallback_logs_errors_cancellation_and_cleanup() {
    for scenario in [
        "http", "html", "marker", "official", "all", "all_html", "cancel", "override",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("installers");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let accepted = Arc::new(tokio::sync::Notify::new());
        let ready = accepted.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                let bytes = socket.read(&mut request).await.unwrap();
                let official = String::from_utf8_lossy(&request[..bytes]).contains("/official");
                seen.lock().unwrap().push(official);
                ready.notify_one();
                if scenario == "cancel" {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                let failed = !official || matches!(scenario, "official" | "all" | "all_html");
                let (status, body) =
                    if failed && !matches!(scenario, "html" | "marker" | "all_html") {
                        (500, "failed")
                    } else if failed && scenario == "marker" {
                        (200, "#!/bin/bash\n# unrelated script\n")
                    } else if failed {
                        (200, "<html>Homebrew</html>")
                    } else {
                        (200, "#!/usr/bin/env bash\n# Homebrew local test\n")
                    };
                let _ = socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            }
        });
        let mirror = format!("http://{address}/mirror");
        let official = format!("http://{address}/official");
        let sources = match scenario {
            "official" => vec![official.clone()],
            "override" => vec![mirror.clone()],
            _ => vec![mirror.clone(), official.clone()],
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(tokio::sync::Notify::new());
        let flag = cancel.clone();
        let wake = notify.clone();
        let canceler = tokio::spawn(async move {
            if scenario == "cancel" {
                accepted.notified().await;
                flag.store(true, Ordering::Release);
                wake.notify_one();
            }
        });
        let log = tmp.path().join("task.log");
        let lines = Mutex::new(Vec::new());
        let result =
            installer::download_candidates(&root, &sources, cancel, notify, &log, |line| {
                lines.lock().unwrap().push(line)
            })
            .await;
        canceler.await.unwrap();
        let text = tokio::fs::read_to_string(log).await.unwrap();
        assert_eq!(
            text.lines().collect::<Vec<_>>(),
            lines
                .lock()
                .unwrap()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        match scenario {
            "http" | "html" | "marker" => {
                assert!(result.is_ok());
                assert_eq!(*requests.lock().unwrap(), vec![false, true]);
                let reason = if matches!(scenario, "html" | "marker") {
                    "content"
                } else {
                    "http_500"
                };
                assert!(text.contains(&format!("==> Falling back to {official} ({reason})")));
            }
            "all_html" => {
                let error = result.as_ref().err().unwrap();
                assert_eq!(error.code, "E_DOWNLOAD");
                assert_eq!(error.message, "installer_content");
                assert_eq!(*requests.lock().unwrap(), vec![false, true]);
                assert!(text.contains(&format!("==> Falling back to {official} (content)")));
            }
            "cancel" => {
                let error = result.as_ref().err().unwrap();
                assert_eq!(error.code, "E_INTERRUPTED");
                assert_eq!(error.message, "installer_canceled");
                assert_eq!(*requests.lock().unwrap(), vec![false]);
                assert!(!text.contains("Falling back"));
            }
            _ => {
                let error = result.as_ref().err().unwrap();
                assert_eq!(error.code, "E_DOWNLOAD");
                assert_eq!(error.message, "installer_download");
                assert_eq!(error.detail.as_deref(), Some("http_500"));
                assert_eq!(
                    requests.lock().unwrap().len(),
                    if scenario == "all" { 2 } else { 1 }
                );
                assert_eq!(text.contains("Falling back"), scenario == "all");
            }
        }
        drop(result);
        server.abort();
        let _ = server.await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while root.exists() && std::fs::read_dir(&root).unwrap().next().is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
#[tokio::test]
async fn download_size_failure_cleanup_and_private_script_permissions() {
    let tmp = tempfile::tempdir().unwrap();
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let worker = std::thread::spawn(move || {
        let body = b"#!/bin/bash\n# Homebrew\n";
        for size in [body.len(), 1024 * 1024 + 1] {
            let (mut socket, _) = server.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0; 1024];
            assert!(socket.read(&mut bytes).unwrap() > 0);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            if size == body.len() {
                socket.write_all(body).unwrap();
            }
        }
    });
    let url = format!("http://{address}/install.sh");
    let script = installer::download(tmp.path(), &url).await.unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&script.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(script.path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    let path = script.path.clone();
    drop(script);
    assert_eq!(
        installer::download(tmp.path(), &url)
            .await
            .err()
            .unwrap()
            .code,
        "E_DOWNLOAD"
    );
    worker.join().unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while path.exists() || std::fs::read_dir(tmp.path()).unwrap().next().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[test]
fn askpass_is_executable_and_syntax_checked_without_requesting_password() {
    use std::os::unix::fs::PermissionsExt;
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/askpass/opennavo-askpass");
    assert_ne!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o111,
        0
    );
    assert!(
        std::process::Command::new("/bin/sh")
            .args(["-n"])
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    let script = std::fs::read_to_string(path).unwrap();
    assert!(script.contains("with hidden answer"));
    assert!(script.contains("exec /usr/bin/osascript"));
}
