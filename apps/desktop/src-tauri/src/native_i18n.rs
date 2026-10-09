use crate::{AppError, model::Locale};
pub fn text(locale: Locale, key: &str) -> Result<String, AppError> {
    let data = match locale {
        Locale::ZhCn => include_str!("../resources/locales/zh-CN.json"),
        Locale::EnUs => include_str!("../resources/locales/en-US.json"),
        Locale::JaJp => include_str!("../resources/locales/ja-JP.json"),
        Locale::EsEs => include_str!("../resources/locales/es-ES.json"),
        Locale::PtBr => include_str!("../resources/locales/pt-BR.json"),
        Locale::RuRu => include_str!("../resources/locales/ru-RU.json"),
    };
    let values: std::collections::HashMap<String, String> = serde_json::from_str(data)?;
    values
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::new("E_UNKNOWN", "native_translation"))
}

pub fn plural_index(locale: Locale, count: u32) -> usize {
    match locale {
        Locale::ZhCn | Locale::JaJp => 0,
        Locale::EnUs | Locale::EsEs => usize::from(count != 1),
        Locale::PtBr => usize::from(count > 1),
        Locale::RuRu => {
            if count % 10 == 1 && count % 100 != 11 {
                0
            } else if (2..=4).contains(&(count % 10)) && !(12..=14).contains(&(count % 100)) {
                1
            } else {
                2
            }
        }
    }
}
pub fn plural(locale: Locale, key: &str, count: u32) -> Result<String, AppError> {
    let value = text(locale, key)?;
    value
        .split('|')
        .nth(plural_index(locale, count))
        .map(|s| s.trim().replace("{count}", &count.to_string()))
        .ok_or_else(|| AppError::new("E_UNKNOWN", "native_plural"))
}
