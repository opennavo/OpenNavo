use crate::{AppError, model::*};
#[tauri::command]
#[specta::specta]
pub async fn mirror_probe(mirrors: Vec<MirrorInput>) -> Result<Vec<MirrorProbe>, AppError> {
    crate::mirror::probe(mirrors).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn custom_probe_frontend_payload_passes_ipc_validation_and_sends_four_heads() {
        // The frontend test asserts its actual generated payload equals this shared contract.
        let contract: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/custom-mirror-probes.json"
        ))
        .unwrap();
        let mut inputs: Vec<MirrorInput> =
            serde_json::from_value(contract["probes"].clone()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        for input in &mut inputs {
            crate::brew::args::validate_token(&input.key).unwrap();
            let url = reqwest::Url::parse(&input.probe_url).unwrap();
            input.probe_url = format!("{base}{}", url.path());
        }
        // The previous camelCase payload is rejected before any network access.
        let mut invalid = inputs.clone();
        for input in &mut invalid {
            input.key = format!("custom-test-{}", input.name);
            assert!(crate::brew::args::validate_token(&input.key).is_err());
        }
        assert_eq!(
            mirror_probe(invalid).await.unwrap_err().code,
            "E_INVALID_ARG"
        );

        let expected_keys: Vec<_> = inputs.iter().map(|input| input.key.clone()).collect();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut bytes = [0; 1024];
                    let count = stream.read(&mut bytes).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&bytes[..count]);
                    if request.windows(4).any(|chunk| chunk == b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(
                    String::from_utf8(request)
                        .unwrap()
                        .lines()
                        .next()
                        .unwrap()
                        .to_owned(),
                );
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
            requests.sort();
            requests
        });
        let results = mirror_probe(inputs).await.unwrap();
        assert_eq!(
            results.iter().map(|result| &result.key).collect::<Vec<_>>(),
            expected_keys.iter().collect::<Vec<_>>()
        );
        assert!(
            results
                .iter()
                .all(|result| result.ok && result.status == Some(200))
        );
        assert_eq!(
            server.await.unwrap(),
            [
                "HEAD /api/cask.jws.json HTTP/1.1",
                "HEAD /bottles HTTP/1.1",
                "HEAD /brew.git HTTP/1.1",
                "HEAD /homebrew-core.git HTTP/1.1",
            ]
        );
    }
}
