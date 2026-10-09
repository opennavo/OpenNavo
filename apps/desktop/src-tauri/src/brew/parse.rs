use crate::{
    AppError,
    model::{TaskOp, TaskPhase},
};
use regex::Regex;
use std::sync::LazyLock;

static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")
        .expect("fixed ANSI regex")
});
static PERCENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d{1,3}(?:\.\d+)?)%\s*$").expect("fixed percentage regex"));
static CASK_FETCHED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^✔[\u{fe0e}\u{fe0f}]?\s+Cask\s+\S+").expect("fixed Cask download-completion regex")
});
static VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:\S+\s+)?(\S+)\s+->\s+(\S+)$").expect("fixed version regex"));

pub fn strip_ansi(line: &str) -> String {
    ANSI.replace_all(line, "").into_owned()
}

pub fn map_error(text: &str) -> Option<AppError> {
    let rules = [
        ("E_CHECKSUM", &["SHA256 mismatch"][..]),
        ("E_DOWNLOAD", &["Download failed", "curl: ("][..]),
        ("E_APP_EXISTS", &["It seems there is already an App at"][..]),
        ("E_DISABLED", &["has been disabled", "is disabled"][..]),
        (
            "E_NOT_FOUND",
            &["is unavailable", "No available formula with the name"][..],
        ),
        (
            "E_LOCKED",
            &["Another active Homebrew process", "already locked"][..],
        ),
        (
            "E_SUDO",
            &[
                "a password is required",
                "incorrect password attempt",
                "User canceled",
                "User cancelled",
                "askpass cancelled",
            ][..],
        ),
        // Homebrew exits on zap-protected directories (06 §12.6); check before E_PERMISSION.
        (
            "E_FULL_DISK_ACCESS",
            &["Please enable Full Disk Access"][..],
        ),
        (
            "E_PERMISSION",
            &["Operation not permitted", "Permission denied"][..],
        ),
        (
            "E_MACOS_VERSION",
            &[
                "requires macOS >=",
                "This cask does not run on macOS versions older than",
            ][..],
        ),
        ("E_REQUIRED_BY", &["because it is required by"][..]),
        ("E_CONFLICT", &["conflicts with"][..]),
    ];
    rules
        .into_iter()
        .find(|(_, patterns)| patterns.iter().any(|pattern| text.contains(pattern)))
        .map(|(code, _)| {
            AppError::new(code, code.to_lowercase())
                .with_detail(text.chars().take(4096).collect::<String>())
        })
}

#[derive(Default, Debug)]
pub struct Parser {
    pub phase: Option<TaskPhase>,
    pub percent: Option<f32>,
    pub step_index: Option<u8>,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub app_paths: Vec<String>,
    pub caveats: Vec<String>,
    pub error: Option<AppError>,
    pub already_latest: bool,
    pub succeeded: bool,
    in_caveats: bool,
    after_upgrade: bool,
}
impl Parser {
    pub fn feed(&mut self, input: &str, op: TaskOp) {
        let line = strip_ansi(input);
        let line = line.trim();
        if line.starts_with("==>") {
            self.in_caveats = line.starts_with("==> Caveats");
        } else if self.in_caveats {
            self.caveats.push(line.into());
        }
        let phase = if line.starts_with("==> Fetching ") {
            Some(TaskPhase::Fetching)
        } else if line.starts_with("==> Downloading http") {
            Some(TaskPhase::Downloading)
        } else if line.starts_with("==> Installing Cask ") || line.starts_with("==> Pouring ") {
            Some(TaskPhase::Installing)
        } else if line.starts_with("==> Upgrading ") {
            self.after_upgrade = true;
            Some(TaskPhase::Installing)
        } else if line.starts_with("==> Backing up App ")
            || line.starts_with("==> Removing App ")
            || line.starts_with("==> Moving App ")
        {
            Some(TaskPhase::Installing)
        } else if line.starts_with("==> Linking") {
            Some(TaskPhase::Linking)
        } else if line.starts_with("==> Uninstalling Cask ")
            || line.starts_with("Uninstalling ")
            || (op == TaskOp::Uninstall && line.starts_with("==> Purging files"))
        {
            Some(TaskPhase::Uninstalling)
        } else if line.starts_with("==> Cleaning")
            || line.starts_with("Removing: ")
            || line.starts_with("==> Purging files")
        {
            Some(TaskPhase::Cleaning)
        } else if line.starts_with("==> Updating Homebrew") {
            Some(TaskPhase::Updating)
        } else {
            None
        };
        if let Some(phase) = phase {
            self.phase = Some(phase);
            self.percent = match phase {
                TaskPhase::Installing => Some(70.0),
                TaskPhase::Linking | TaskPhase::Cleaning => Some(95.0),
                _ => None,
            };
            self.step_index = Some(match op {
                TaskOp::Uninstall => {
                    if phase == TaskPhase::Uninstalling {
                        1
                    } else {
                        2
                    }
                }
                _ => match phase {
                    TaskPhase::Preparing | TaskPhase::Updating => 0,
                    TaskPhase::Fetching | TaskPhase::Downloading => 1,
                    TaskPhase::Installing | TaskPhase::Linking => 2,
                    _ => 3,
                },
            });
        }
        // Homebrew 7 parallel downloads may omit legacy percentages; checkmarks indicate download completion, not successful installation.
        if CASK_FETCHED.is_match(line) {
            self.phase = Some(TaskPhase::Downloading);
            self.percent = Some(70.0);
            self.step_index = Some(1);
        }
        if line.starts_with('#')
            && let Some(captures) = PERCENT.captures(line)
            && let Ok(percent) = captures[1].parse::<f32>()
            && percent <= 100.0
        {
            self.phase = Some(TaskPhase::Downloading);
            self.percent = Some(percent * 0.7);
            self.step_index = Some(1);
        }
        if self.after_upgrade
            && let Some(captures) = VERSION.captures(line)
        {
            self.from_version = Some(captures[1].into());
            self.to_version = Some(captures[2].into());
            self.after_upgrade = false;
        }
        if line.starts_with("==> Moving App '")
            && let Some((_, path)) = line.split_once("' to '")
        {
            self.app_paths
                .push(path.trim_end_matches(['\'', '.']).into());
        }
        if line.contains("was successfully installed") || line.contains("was successfully upgraded")
        {
            self.succeeded = true;
            self.phase = Some(TaskPhase::Finishing);
            self.percent = Some(100.0);
        }
        if line.contains("Not upgrading ")
            && line.contains("the latest version is already installed")
        {
            self.already_latest = true;
        }
        if let Some(error) = map_error(line) {
            self.error = Some(error);
        }
    }
}

/// Preserve UTF-8 boundaries across chunks; CR progress refreshes and CRLF emit only complete nonempty lines.
#[derive(Default)]
pub struct LineDecoder {
    pending: Vec<u8>,
}
impl LineDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for byte in bytes {
            if *byte == b'\r' || *byte == b'\n' {
                if !self.pending.is_empty() {
                    lines.push(strip_ansi(&String::from_utf8_lossy(&self.pending)));
                    self.pending.clear();
                }
            } else {
                self.pending.push(*byte);
                if self.pending.len() >= 65536 {
                    lines.push(strip_ansi(&String::from_utf8_lossy(&self.pending)));
                    self.pending.clear();
                }
            }
        }
        lines
    }
    pub fn finish(&mut self) -> Vec<String> {
        self.push(b"\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunked_cr_and_utf8() {
        let mut decoder = LineDecoder::default();
        assert!(decoder.push(b"\x1b[32m## 5").is_empty());
        assert_eq!(decoder.push(b"0.0%\x1b[0m\r\n"), vec!["## 50.0%"]);
        let bytes = "微信".as_bytes();
        assert!(decoder.push(&bytes[..2]).is_empty());
        assert_eq!(decoder.push(&[&bytes[2..], b"\n"].concat()), vec!["微信"]);
    }
    #[test]
    fn homebrew7_upgrade_preserves_download_completion_through_installation() {
        let mut parser = Parser::default();
        let expected = [
            (TaskPhase::Fetching, None),
            (TaskPhase::Downloading, Some(70.0)),
            (TaskPhase::Installing, Some(70.0)),
            (TaskPhase::Installing, Some(70.0)),
            (TaskPhase::Installing, Some(70.0)),
            (TaskPhase::Installing, Some(70.0)),
            (TaskPhase::Installing, Some(70.0)),
            (TaskPhase::Installing, Some(70.0)),
            (TaskPhase::Linking, Some(95.0)),
            (TaskPhase::Cleaning, Some(95.0)),
            (TaskPhase::Finishing, Some(100.0)),
        ];
        let lines: Vec<_> = include_str!("../../tests/fixtures/upgrade_homebrew7.txt")
            .lines()
            .collect();
        assert_eq!(lines.len(), expected.len());
        for (index, (line, (phase, percent))) in lines.iter().zip(expected).enumerate() {
            parser.feed(line, TaskOp::Upgrade);
            assert_eq!(
                (parser.phase, parser.percent),
                (Some(phase), percent),
                "{line}"
            );
            assert_eq!(parser.succeeded, index == lines.len() - 1);
        }
        assert_eq!(parser.from_version.as_deref(), Some("2026.17"));
        assert_eq!(parser.to_version.as_deref(), Some("2026.21"));
    }

    #[test]
    fn download_completion_is_not_installation_success() {
        for marker in ["✔", "✔︎", "✔️"] {
            let mut parser = Parser::default();
            parser.feed(&format!("{marker} Cask notion (7.37.1)"), TaskOp::Upgrade);
            assert_eq!(parser.percent, Some(70.0));
            assert!(!parser.succeeded);
            parser.feed("Error: Download failed", TaskOp::Upgrade);
            assert!(parser.error.is_some());
            assert!(!parser.succeeded);
        }
        let mut parser = Parser::default();
        parser.feed("✘ Cask notion (7.37.1)", TaskOp::Upgrade);
        assert_eq!(parser.percent, None);
        parser.feed("==> Purging files for Cask notion", TaskOp::Uninstall);
        assert_eq!(parser.phase, Some(TaskPhase::Uninstalling));
        parser.feed("==> Updating Homebrew...", TaskOp::Update);
        assert_eq!(parser.phase, Some(TaskPhase::Updating));
    }

    #[test]
    fn official_logs_cover_phases_and_errors() {
        let mut parser = Parser::default();
        for line in include_str!("../../tests/fixtures/install.txt").lines() {
            parser.feed(line, TaskOp::Install);
        }
        assert_eq!(parser.phase, Some(TaskPhase::Linking));
        assert_eq!(parser.app_paths, vec!["/Applications/Inkscape.app"]);
        for line in include_str!("../../tests/fixtures/errors.txt")
            .lines()
            .filter(|l| !l.is_empty())
        {
            let (code, text) = line.split_once('\t').expect("annotated error code");
            assert_eq!(map_error(text).expect(text).code, code);
        }
        let mut parser = Parser::default();
        for line in include_str!("../../tests/fixtures/upgrade.txt").lines() {
            parser.feed(line, TaskOp::Upgrade);
        }
        assert_eq!(parser.from_version.as_deref(), Some("5.4.2"));
        assert_eq!(parser.to_version.as_deref(), Some("5.5.0"));
        parser.feed("#### 25.0%", TaskOp::Install);
        assert_eq!(parser.percent, Some(17.5));
        parser.feed(
            include_str!("../../tests/fixtures/latest.txt"),
            TaskOp::Upgrade,
        );
        assert!(parser.already_latest);
        assert!(parser.error.is_none());
        let mut phases = Vec::new();
        for line in include_str!("../../tests/fixtures/stages.txt").lines() {
            parser.feed(line, TaskOp::Uninstall);
            if let Some(phase) = parser.phase {
                phases.push(phase);
            }
        }
        assert!(phases.contains(&TaskPhase::Fetching));
        assert!(phases.contains(&TaskPhase::Installing));
        assert!(phases.contains(&TaskPhase::Uninstalling));
        assert!(phases.contains(&TaskPhase::Cleaning));
        assert!(!parser.caveats.is_empty());
    }
}
