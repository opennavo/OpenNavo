use crate::{AppError, brew::args::validate_token, core::DesktopCore, model::*};
use std::{collections::HashSet, path::Path, sync::Arc};

pub fn read(path: &Path) -> Result<String, AppError> {
    use std::io::Read;
    if !path.is_absolute() {
        return Err(AppError::new("E_INVALID_ARG", "brewfile_path"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(AppError::new("E_INVALID_ARG", "brewfile_size"));
    }
    String::from_utf8(bytes).map_err(|_| AppError::new("E_INVALID_ARG", "brewfile_utf8"))
}

fn without_comment(line: &str) -> String {
    let mut quote = None;
    let mut escaped = false;
    let mut end = line.len();
    for (index, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && quote.is_some() {
            escaped = true;
            continue;
        }
        if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() && matches!(ch, '\'' | '"') {
            quote = Some(ch);
        } else if quote.is_none() && ch == '#' {
            end = index;
            break;
        }
    }
    line[..end].trim().to_owned()
}

pub fn parse(
    content: &str,
    installed: &[InstalledItem],
    catalog: impl Fn(Kind, &str) -> Result<Option<CatalogItem>, AppError>,
) -> Result<BrewfilePreview, AppError> {
    if content.len() > 1024 * 1024 || content.lines().count() > 10_000 {
        return Err(AppError::new("E_INVALID_ARG", "brewfile_size"));
    }
    let grammar = regex::Regex::new(r#"^(brew|cask|tap)\s+(?:"([^"]+)"|'([^']+)')\s*$"#)
        .map_err(|_| AppError::new("E_UNKNOWN", "brewfile_grammar"))?;
    let mut preview = BrewfilePreview {
        entries: vec![],
        ready: 0,
        installed: 0,
        unsupported: 0,
    };
    let mut seen = HashSet::new();
    for (number, line) in content.lines().enumerate() {
        let raw = without_comment(line);
        if raw.is_empty() {
            continue;
        }
        let category = raw.split_whitespace().next().unwrap_or("");
        let kind = match category {
            "brew" => Some(Kind::Formula),
            "cask" => Some(Kind::Cask),
            _ => None,
        };
        let mut entry = BrewfileEntry {
            line: number as u32 + 1,
            raw: raw.clone(),
            kind,
            token: None,
            status: BrewfileEntryStatus::Invalid,
            reason: None,
        };
        if category != "cask" {
            entry.status = BrewfileEntryStatus::Unsupported;
            entry.reason = Some(
                match category {
                    "tap" | "mas" | "vscode" | "whalebrew" => category,
                    _ => "other",
                }
                .into(),
            );
        } else if let Some(kind) = kind {
            if let Some(captures) = grammar.captures(&raw) {
                let token = captures
                    .get(2)
                    .or_else(|| captures.get(3))
                    .map(|m| m.as_str())
                    .unwrap_or("");
                if validate_token(token).is_ok() {
                    entry.token = Some(token.into());
                    entry.status = if !seen.insert((kind, token.to_owned())) {
                        BrewfileEntryStatus::Skipped
                    } else if installed.iter().any(|i| i.kind == kind && i.token == token) {
                        BrewfileEntryStatus::Installed
                    } else {
                        match catalog(kind, token)? {
                            Some(item) if !item.disabled && !item.hidden => {
                                BrewfileEntryStatus::Ready
                            }
                            Some(_) => BrewfileEntryStatus::Unsupported,
                            None => BrewfileEntryStatus::NotFound,
                        }
                    };
                    if entry.status == BrewfileEntryStatus::Unsupported {
                        entry.reason = Some("other".into());
                    }
                }
            }
        } else {
            entry.status = BrewfileEntryStatus::Unsupported;
            entry.reason = Some(
                match category {
                    "mas" | "vscode" | "whalebrew" => category,
                    _ => "other",
                }
                .into(),
            );
        }
        match entry.status {
            BrewfileEntryStatus::Ready => preview.ready += 1,
            BrewfileEntryStatus::Installed => preview.installed += 1,
            BrewfileEntryStatus::Unsupported => preview.unsupported += 1,
            _ => {}
        }
        preview.entries.push(entry);
    }
    Ok(preview)
}

pub async fn preview(core: Arc<DesktopCore>, path: String) -> Result<BrewfilePreview, AppError> {
    crate::blocking(move || {
        let content = read(Path::new(&path))?;
        parse(&content, &core.library_list()?, |kind, token| {
            crate::catalog::get(&core.database, kind, token)
        })
    })
    .await
}

pub async fn export(core: Arc<DesktopCore>, path: String) -> Result<u32, AppError> {
    let args = crate::brew::args::export_args(&path)?;
    let _read = core.queue.read_gate.read().await;
    let output =
        crate::maintenance::run(&core.brew_info().await?, &core.current_settings()?, args).await?;
    output.success()?;
    crate::blocking(move || {
        let data = read(Path::new(&path))?;
        let preview = parse(&data, &[], |_, _| Ok(None))?;
        let entries: Vec<_> = preview
            .entries
            .iter()
            .filter(|e| e.kind == Some(Kind::Cask) && e.token.is_some())
            .collect();
        let mut output = String::new();
        for entry in &entries {
            if let Some(token) = &entry.token {
                output.push_str(&format!("cask \"{}\"\n", token));
            }
        }
        std::fs::write(&path, output)?;
        Ok(entries.len() as u32)
    })
    .await
}

/// Export a user-selected list without requiring Homebrew or querying installed apps.
pub fn export_list(path: &str, targets: &[TaskTarget]) -> Result<u32, AppError> {
    if !Path::new(path).is_absolute() || targets.len() > 200 {
        return Err(AppError::new("E_INVALID_ARG", "brewfile_list"));
    }
    let mut seen = HashSet::new();
    let mut output = String::new();
    for target in targets {
        if target.kind != Kind::Cask {
            return Err(AppError::new("E_INVALID_ARG", "unsupported_kind"));
        }
        validate_token(&target.token)?;
        if seen.insert(&target.token) {
            output.push_str(&format!("cask \"{}\"\n", target.token));
        }
    }
    std::fs::write(path, output)?;
    Ok(seen.len() as u32)
}
