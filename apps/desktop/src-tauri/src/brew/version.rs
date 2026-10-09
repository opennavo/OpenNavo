use std::{cmp::Ordering, sync::LazyLock};
static TOKENS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new("[0-9]+|[a-z]+").expect("fixed version expression"));
/// Share edge cases with Go/TS; unknown versions cannot imply an update.
pub fn compare(left: &str, right: &str) -> Option<Ordering> {
    let left = left.trim().to_lowercase();
    let right = right.trim().to_lowercase();
    if left.is_empty()
        || right.is_empty()
        || left == "latest"
        || right == "latest"
        || left.len() > 8192
        || right.len() > 8192
    {
        return None;
    }
    let lh = left == "head" || left.starts_with("head-");
    let rh = right == "head" || right.starts_with("head-");
    if lh || rh {
        return Some(lh.cmp(&rh));
    }
    let lp: Vec<_> = left.strip_prefix('v').unwrap_or(&left).split(',').collect();
    let rp: Vec<_> = right
        .strip_prefix('v')
        .unwrap_or(&right)
        .split(',')
        .collect();
    for i in 0..lp.len().max(rp.len()) {
        let l: Vec<_> = TOKENS
            .find_iter(lp.get(i).copied().unwrap_or(""))
            .map(|m| m.as_str())
            .collect();
        let r: Vec<_> = TOKENS
            .find_iter(rp.get(i).copied().unwrap_or(""))
            .map(|m| m.as_str())
            .collect();
        let order = parts(&l, &r);
        if order != Ordering::Equal {
            return Some(order);
        }
    }
    Some(Ordering::Equal)
}
fn split<'a, 'b>(tokens: &'a [&'b str]) -> (&'a [&'b str], &'b str, &'a [&'b str]) {
    if let Some(i) = tokens
        .iter()
        .position(|v| v.as_bytes()[0].is_ascii_alphabetic())
    {
        (&tokens[..i], tokens[i], &tokens[i + 1..])
    } else {
        (tokens, "", &[])
    }
}
fn label(value: &str) -> (u8, &str) {
    match value {
        "alpha" | "a" => (0, "alpha"),
        "beta" | "b" => (1, "beta"),
        "pre" | "preview" => (2, "pre"),
        "rc" => (3, "rc"),
        "" => (4, ""),
        "p" | "post" => (5, "post"),
        _ => (6, value),
    }
}
fn number(value: &str) -> &str {
    let value = value.trim_start_matches('0');
    if value.is_empty() { "0" } else { value }
}
fn parts(mut left: &[&str], mut right: &[&str]) -> Ordering {
    loop {
        let (ln, ll, lr) = split(left);
        let (rn, rl, rr) = split(right);
        for i in 0..ln.len().max(rn.len()) {
            let l = number(ln.get(i).copied().unwrap_or("0"));
            let r = number(rn.get(i).copied().unwrap_or("0"));
            let order = l.len().cmp(&r.len()).then(l.cmp(r));
            if order != Ordering::Equal {
                return order;
            }
        }
        let order = label(ll).cmp(&label(rl));
        if order != Ordering::Equal {
            return order;
        }
        if lr.is_empty() && rr.is_empty() {
            return Ordering::Equal;
        }
        left = lr;
        right = rr;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(serde::Deserialize)]
    struct Case {
        left: String,
        right: String,
        expected: Option<i32>,
    }
    #[test]
    fn shared_cases() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../../../apps/server/testdata/version_cases.json"
        ))
        .unwrap();
        assert!(cases.len() >= 86);
        for case in cases {
            let got = compare(&case.left, &case.right).map(|o| match o {
                Ordering::Less => -1,
                Ordering::Equal => 0,
                Ordering::Greater => 1,
            });
            assert_eq!(got, case.expected, "{} / {}", case.left, case.right);
        }
    }
}
