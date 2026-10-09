use crate::{AppError, model::*};
#[tauri::command]
#[specta::specta]
pub async fn mirror_probe(mirrors: Vec<MirrorInput>) -> Result<Vec<MirrorProbe>, AppError> {
    crate::mirror::probe(mirrors).await
}
