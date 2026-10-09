use crate::model::Settings;
use std::{collections::BTreeMap, path::Path};

pub fn construct(settings: &Settings, prefix: &str, askpass: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for key in ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR"] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), value);
        }
    }
    for (key, value) in [
        (
            "PATH",
            format!("{prefix}/bin:{prefix}/sbin:/usr/bin:/bin:/usr/sbin:/sbin"),
        ),
        ("LANG", "en_US.UTF-8".into()),
        ("HOMEBREW_NO_AUTO_UPDATE", "1".into()),
        ("HOMEBREW_NO_ENV_HINTS", "1".into()),
        ("HOMEBREW_NO_COLOR", "1".into()),
        ("HOMEBREW_NO_EMOJI", "1".into()),
        ("COLUMNS", "120".into()),
        ("LINES", "40".into()),
        ("SUDO_ASKPASS", askpass.to_string_lossy().into_owned()),
        ("OPENNAVO_LOCALE", settings.locale.as_str().into()),
    ] {
        env.insert(key.into(), value);
    }
    for (suffix, key) in [
        ("MESSAGE", "askpass.message"),
        ("TITLE", "askpass.title"),
        ("OK", "askpass.ok"),
        ("CANCEL", "askpass.cancel"),
    ] {
        // Build checks ensure embedded resources are complete; do not inherit caller dialog text.
        if let Ok(text) = crate::native_i18n::text(settings.locale, key) {
            env.insert(format!("OPENNAVO_ASKPASS_{suffix}"), text);
        }
    }
    if settings.homebrew_analytics == Some(false) {
        env.insert("HOMEBREW_NO_ANALYTICS".into(), "1".into());
    }
    for (key, value) in crate::mirror::variables(&settings.mirror) {
        env.insert(key.into(), value.into());
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn whitelist_does_not_inherit_credentials() {
        let env = construct(
            &Settings::default(),
            "/opt/homebrew",
            Path::new("/tmp/helper"),
        );
        assert_eq!(env["HOMEBREW_NO_AUTO_UPDATE"], "1");
        assert_eq!(
            env["PATH"],
            "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
        );
        assert!(!env.contains_key("LLM_API_KEY"));
        assert!(!env.contains_key("GITHUB_TOKEN"));
        assert!(!env.contains_key("HOMEBREW_NO_ANALYTICS"));
        let env = construct(
            &Settings {
                homebrew_analytics: Some(false),
                ..Default::default()
            },
            "/tmp",
            Path::new("/tmp/helper"),
        );
        assert_eq!(env["HOMEBREW_NO_ANALYTICS"], "1");
    }
}
