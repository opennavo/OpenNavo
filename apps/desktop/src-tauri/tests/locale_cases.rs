use opennavo_desktop_lib::{model::Locale, settings};

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    languages: Vec<String>,
    expected: Locale,
}
#[test]
fn shared_locale_cases() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../../../apps/server/testdata/locale_cases.json"
    ))
    .expect("shared locale fixtures must be valid");
    for case in cases {
        let languages: Vec<&str> = case.languages.iter().map(String::as_str).collect();
        assert_eq!(
            settings::match_locale(&languages),
            case.expected,
            "{}",
            case.name
        );
    }
}
