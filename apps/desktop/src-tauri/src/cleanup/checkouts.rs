use super::*;
use std::{
    io::Read,
    process::{Command, Stdio},
};

/// Git is quick; a hung network filesystem or credential prompt must not stall a category.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// A duplicate clone must have been idle this long before it is even listed.
const DUPLICATE_IDLE_DAYS: i64 = 30;

#[derive(Debug)]
struct Repo {
    root: PathBuf,
    common: PathBuf,
    remote: Option<String>,
}
#[derive(Debug)]
struct Worktree {
    path: PathBuf,
    main: bool,
}
impl Collector<'_> {
    fn checkout_expired(&mut self) -> bool {
        if Instant::now() < self.deadline {
            return false;
        }
        let home = self.engine.uninstall.roots.home.clone();
        self.result
            .incomplete(&home, SkippedLocationReason::Timeout);
        true
    }
    /// Read-only P2 discovery: linked worktrees and clones that share an origin. Nothing here is offered for
    /// removal; a later slice adds the gated `git worktree remove` / Trash actions.
    pub(super) fn checkouts(&mut self) -> Result<(), AppError> {
        let roots = self.project_roots.clone();
        let mut candidates = vec![];
        for root in roots {
            self.walk_checkouts(&root, 0, &mut candidates)?;
        }
        // A linked worktree and its main checkout share one common dir: keep a single repo, preferring the main
        // checkout so `worktree list` reports the linked ones instead of skipping itself.
        let mut found: BTreeMap<PathBuf, Vec<(PathBuf, Option<String>)>> = BTreeMap::new();
        for dir in candidates {
            self.check()?;
            let Some(top) = git_until(&dir, &["rev-parse", "--show-toplevel"], self.deadline)
            else {
                continue;
            };
            let root = PathBuf::from(top.trim());
            let root = root.canonicalize().unwrap_or(root);
            let Some(common) = common_dir(&root, self.deadline) else {
                continue;
            };
            let remote = git_until(&root, &["remote", "get-url", "origin"], self.deadline)
                .map(|url| normalize_remote(url.trim()))
                .filter(|url| !url.is_empty());
            found.entry(common).or_default().push((root, remote));
        }
        let repos: Vec<Repo> = found
            .into_iter()
            .map(|(common, roots)| {
                let (root, _) = roots
                    .iter()
                    .find(|(root, _)| root.join(".git").is_dir())
                    .cloned()
                    .unwrap_or_else(|| roots[0].clone());
                // A linked worktree can carry the remote even when the main checkout's config is unusual.
                let remote = roots.iter().find_map(|(_, remote)| remote.clone());
                Repo {
                    root,
                    common,
                    remote,
                }
            })
            .collect();
        let home = self.engine.uninstall.roots.home.clone();
        let mut listed = BTreeSet::new();
        for repo in &repos {
            if Instant::now() >= self.deadline {
                self.result
                    .incomplete(&home, SkippedLocationReason::Timeout);
                break;
            }
            self.worktrees(repo, &mut listed)?;
        }
        let mut by_remote: BTreeMap<String, Vec<&Repo>> = BTreeMap::new();
        for repo in &repos {
            if let Some(remote) = &repo.remote {
                by_remote.entry(remote.clone()).or_default().push(repo);
            }
        }
        for group in by_remote.values().filter(|group| group.len() > 1) {
            if Instant::now() >= self.deadline {
                self.result
                    .incomplete(&home, SkippedLocationReason::Timeout);
                break;
            }
            for repo in group {
                if self.checkout_expired() {
                    break;
                }
                if !duplicate_candidate(&repo.root, self.deadline) {
                    continue;
                }
                let owner = duplicate_owner(repo);
                let title = repo
                    .root
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| repo.root.display().to_string());
                self.add_checkout_item(
                    &repo.root,
                    owner,
                    title,
                    remote_name(&repo.remote.clone().unwrap_or_default()),
                    CleanupReason::DuplicateCheckout,
                )?;
            }
        }
        Ok(())
    }
    fn walk_checkouts(
        &mut self,
        dir: &Path,
        depth: usize,
        out: &mut Vec<PathBuf>,
    ) -> Result<(), AppError> {
        if depth > rules::PROJECT_MAX_DEPTH || self.checkout_expired() {
            return Ok(());
        }
        self.check()?;
        if dir.join(".git").exists() {
            out.push(dir.to_path_buf());
            return Ok(());
        }
        for child in self.children(dir)? {
            let name = child
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let generated = rules::PROJECT_ARTIFACTS
                .iter()
                .any(|(_, dirs)| dirs.contains(&name));
            if name.starts_with('.')
                || name.ends_with(".git")
                || name == "node_modules"
                || generated
            {
                continue;
            }
            self.walk_checkouts(&child, depth + 1, out)?;
        }
        Ok(())
    }
    fn worktrees(&mut self, repo: &Repo, listed: &mut BTreeSet<PathBuf>) -> Result<(), AppError> {
        let home = self.engine.uninstall.roots.home.clone();
        // The main checkout may sit outside the roots; derive the repository name from the common dir instead.
        let group_title = repo
            .common
            .parent()
            .and_then(|root| root.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| repo.root.display().to_string());
        let Some(output) = git_until(
            &repo.root,
            &["worktree", "list", "--porcelain"],
            self.deadline,
        ) else {
            self.checkout_expired();
            return Ok(());
        };
        for worktree in parse_worktrees(&output) {
            self.check()?;
            if self.checkout_expired() {
                break;
            }
            if worktree.main
                || !worktree.path.starts_with(&home)
                || !worktree.path.is_dir()
                || !belongs_to(&worktree.path, &repo.common)
                || !listed.insert(worktree.path.clone())
            {
                continue;
            }
            let title = worktree
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| worktree.path.display().to_string());
            self.add_checkout_item(
                &worktree.path,
                checkout_owner(repo),
                title,
                group_title.clone(),
                CleanupReason::Worktree,
            )?;
        }
        Ok(())
    }
    fn add_checkout_item(
        &mut self,
        path: &Path,
        owner: Owner,
        title: String,
        group_title: String,
        reason: CleanupReason,
    ) -> Result<(), AppError> {
        self.progress(Some(path));
        let (bytes, incomplete) =
            tree::measure_filtered(path, self.flag, self.deadline, |_| false)?;
        if let Some(incomplete) = incomplete {
            self.result.incomplete(path, incomplete);
        }
        if bytes == 0 && incomplete.is_none() {
            return Ok(());
        }
        let modified_at = fs::symlink_metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_millis().min(i64::MAX as u128) as i64);
        self.ensure_checkout_group(&owner, &group_title);
        let item = CleanupItem {
            id: uuid::Uuid::now_v7().to_string(),
            path: path.to_string_lossy().into_owned(),
            kind: CleanupItemKind::Dir,
            command: None,
            size_bytes: Some(bytes),
            size_complete: incomplete.is_none(),
            kept_open_files: 0,
            modified_at,
            reason,
            restore: CleanupRestore::Never,
            selected: false,
            delete_mode: DeleteMode::Trash,
            needs_admin: false,
            note: None,
        };
        self.insert(
            item,
            owner,
            title,
            None,
            ItemAction::Path {
                empty_only: false,
                bootout: None,
            },
        );
        Ok(())
    }
}
impl Collector<'_> {
    /// The first item in a group decides its title; checkouts want the repository name, not the first worktree's.
    fn ensure_checkout_group(&mut self, owner: &Owner, title: &str) {
        let key = owner
            .group_key
            .clone()
            .or_else(|| owner.bundle.clone())
            .unwrap_or_else(|| title.to_string());
        if self
            .result
            .category
            .groups
            .iter()
            .any(|group| group.id == key)
        {
            return;
        }
        self.result.category.groups.push(CleanupGroup {
            id: key,
            title: title.to_string(),
            subtitle: owner.group_subtitle.clone(),
            app_id: owner.app_id.clone(),
            bundle_id: owner.bundle.clone(),
            items: vec![],
        });
    }
}
fn checkout_owner(repo: &Repo) -> Owner {
    Owner {
        tool_key: Some("git".into()),
        group_key: Some(format!("checkout:{}", repo.common.display())),
        group_subtitle: repo
            .common
            .parent()
            .and_then(|root| root.parent())
            .map(|dir| dir.display().to_string()),
        ..Owner::default()
    }
}
fn duplicate_owner(repo: &Repo) -> Owner {
    Owner {
        tool_key: Some("git".into()),
        group_key: Some(format!(
            "checkout-remote:{}",
            repo.remote.clone().unwrap_or_default()
        )),
        group_subtitle: repo.remote.clone(),
        ..Owner::default()
    }
}
/// `git worktree list` can contain entries copied from another clone; only trust a `.git` file that points back at
/// this repository's common dir.
fn belongs_to(path: &Path, common: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path.join(".git")) else {
        return false;
    };
    let Some(target) = text.trim().strip_prefix("gitdir: ") else {
        return false;
    };
    let target = PathBuf::from(target);
    let target = if target.is_absolute() {
        target
    } else {
        path.join(target)
    };
    target
        .canonicalize()
        .is_ok_and(|target| target.starts_with(common))
}
fn remote_name(remote: &str) -> String {
    remote
        .rsplit(['/', ':'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(remote)
        .to_string()
}
/// A clean clone with nothing unpushed, no stash, and an idle index can be re-fetched if it is removed.
fn duplicate_candidate(root: &Path, deadline: Instant) -> bool {
    // Check the index first: `git status` can refresh its mtime, which would hide an otherwise idle clone.
    if !index_older_than(root, DUPLICATE_IDLE_DAYS) {
        return false;
    }
    // `status.showUntrackedFiles=no` must not make an untracked file look clean.
    let clean = git_until(
        root,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
        deadline,
    )
    .is_some_and(|out| out.trim().is_empty());
    let unpushed = git_until(
        root,
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
        deadline,
    )
    .is_some_and(|out| out.trim() == "0");
    let no_stash =
        git_until(root, &["stash", "list"], deadline).is_some_and(|out| out.trim().is_empty());
    clean && unpushed && no_stash
}
fn index_older_than(root: &Path, days: i64) -> bool {
    fs::symlink_metadata(root.join(".git/index"))
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.elapsed().ok())
        .is_some_and(|elapsed| elapsed.as_secs() >= days as u64 * 86_400)
}
fn common_dir(root: &Path, deadline: Instant) -> Option<PathBuf> {
    let raw = git_until(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        deadline,
    )
    .or_else(|| git_until(root, &["rev-parse", "--git-common-dir"], deadline))?;
    let path = PathBuf::from(raw.trim());
    let path = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    Some(path.canonicalize().unwrap_or(path))
}
fn normalize_remote(url: &str) -> String {
    let url = redact_remote(url.trim()).trim_end_matches('/').to_string();
    url.strip_suffix(".git").unwrap_or(&url).to_lowercase()
}
/// Remotes are shown in the UI; a token embedded in `https://user:token@host/...` must never reach it.
fn redact_remote(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    match rest.split_once('@') {
        Some((_, host)) => format!("{scheme}://{host}"),
        None => url.to_string(),
    }
}
fn parse_worktrees(output: &str) -> Vec<Worktree> {
    let mut worktrees = vec![];
    for (index, block) in output.split("\n\n").enumerate() {
        let mut path = None;
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(value));
            }
        }
        if let Some(path) = path {
            worktrees.push(Worktree {
                path,
                main: index == 0,
            });
        }
    }
    worktrees
}
/// One git call bounded by both the category deadline and the per-call cap.
fn git_until(dir: &Path, args: &[&str], deadline: Instant) -> Option<String> {
    let timeout = deadline.saturating_duration_since(Instant::now());
    if timeout.is_zero() {
        return None;
    }
    git(dir, args, timeout.min(GIT_TIMEOUT))
}
fn git(dir: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new("git")
        .current_dir(dir)
        .arg("--no-optional-locks")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/usr/bin/true")
        .env("SSH_ASKPASS", "/usr/bin/true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = vec![];
        stdout.take(1 << 20).read_to_end(&mut bytes).ok()?;
        Some(bytes)
    });
    let deadline = Instant::now() + timeout;
    let succeeded = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    if !succeeded {
        let _ = reader.join();
        return None;
    }
    let bytes = reader.join().ok()??;
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linked_worktrees_and_marks_the_first_one_main() {
        let output = "worktree /src/app\nHEAD aaa\nbranch refs/heads/main\n\nworktree /src/app-feature\nHEAD bbb\ndetached\n";
        let worktrees = parse_worktrees(output);
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].main);
        assert!(!worktrees[1].main);
        assert_eq!(worktrees[1].path, PathBuf::from("/src/app-feature"));
    }
    #[test]
    fn remotes_compare_without_scheme_specific_suffixes() {
        assert_eq!(
            normalize_remote("https://github.com/OpenNavo/OpenNavo.git/"),
            "https://github.com/opennavo/opennavo"
        );
        assert_eq!(
            normalize_remote("https://user:token@example.com/a.git"),
            "https://example.com/a"
        );
    }
    #[test]
    fn an_expired_budget_skips_git() {
        assert!(git_until(Path::new("."), &["--version"], Instant::now()).is_none());
    }
    #[test]
    fn a_recent_index_is_not_a_duplicate_yet() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join(".git/index"), b"index").unwrap();
        assert!(!index_older_than(&repo, DUPLICATE_IDLE_DAYS));
    }
}
