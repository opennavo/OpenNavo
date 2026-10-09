use opennavo_desktop_lib::{mirror, model::MirrorInput};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let body: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../apps/server/testdata/desktop/client-config.json"
    ))?;
    let mirrors: Vec<MirrorInput> = serde_json::from_value(body["data"]["mirrors"].clone())?;
    let results = mirror::probe(mirrors).await?;
    assert_eq!(results.len(), 4);
    println!("{}", serde_json::to_string_pretty(&results)?);
    Ok(())
}
