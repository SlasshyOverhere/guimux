use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatus {
    pub path: String,
    pub index_status: String,
    pub workdir_status: String,
}

const DIFF_CAP: usize = 1_000_000; // 1MB per file
/// `status -z` on a repo with ~100k changes is ~8MB; cap the read there too.
const STATUS_CAP: usize = 8 * 1024 * 1024;
const STDERR_CAP: usize = 64 * 1024;
pub const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// All git spawns go through here: on Windows a child console process flashes
/// a visible console window unless CREATE_NO_WINDOW is set — that flash is
/// the "terminals popping in and out" on startup and on every status poll.
pub fn git_cmd() -> Command {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Rejects flag-shaped git refs (H-005): a leading `-` would be parsed as a
/// git flag (`git diff --output=...` silently writes to a file).
pub fn reject_git_ref(v: &str, what: &str) -> Result<(), String> {
    if v.starts_with('-') || v.contains('\0') {
        return Err(format!("invalid {what}: {v}"));
    }
    Ok(())
}

fn read_capped(mut reader: impl Read, cap: usize) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(cap.min(64 * 1024));
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(out.len());
                if room > 0 {
                    out.extend_from_slice(&chunk[..n.min(room)]);
                }
                if n > room {
                    truncated = true;
                }
            }
        }
    }
    (out, truncated)
}

pub fn git_output(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>, bool), String> {
    let mut child = git_cmd()
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("[git] failed to spawn: {e}"))?;
    let stdout = child.stdout.take().ok_or("git stdout pipe unavailable")?;
    let stderr = child.stderr.take().ok_or("git stderr pipe unavailable")?;
    let out_thread = std::thread::spawn(move || read_capped(stdout, STATUS_CAP));
    let err_thread = std::thread::spawn(move || read_capped(stderr, STDERR_CAP));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(format!("[git] wait failed: {e}"));
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let (stdout, stdout_truncated) = out_thread.join().unwrap_or_default();
    let (stderr, stderr_truncated) = err_thread.join().unwrap_or_default();
    match status {
        Some(status) => Ok((status, stdout, stderr, stdout_truncated || stderr_truncated)),
        None => Err(format!("git {} timed out after {}s", args.join(" "), timeout.as_secs())),
    }
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    // Every dynamic ref/path arg must be preceded by `"--"` at the call
    // site; static flag lists here are safe by construction.
    let (status, stdout, stderr, truncated) = git_output(repo, args, GIT_TIMEOUT)?;
    if status.success() {
        if truncated {
            return Err("git output exceeded safety limit".into());
        }
        Ok(String::from_utf8_lossy(&stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&stderr);
        Err(format!(
            "git {} failed: {}",
            args.join(" "),
            stderr.trim()
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub is_git: bool,
    pub git_root: Option<String>,
    pub branch: Option<String>,
}

fn dir_name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn is_not_repository_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("not a git repository")
        || lower.contains("not under version control")
        || lower.contains("not a working tree")
}

#[command]
pub fn project_detect(path: String) -> Result<ProjectInfo, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("PROJECT_PATH_MISSING: not a directory: {path}"));
    }
    // Single spawn: toplevel + branch in one `rev-parse`. Two spawns per
    // project doubled startup latency and flashed two console windows each.
    // `--show-toplevel` succeeds anywhere inside a worktree; a `HEAD`
    // abbrev-ref means detached (no current branch).
    let (status, stdout, stderr, truncated) = git_output(
        &p,
        &["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"],
        GIT_TIMEOUT,
    )
    .map_err(|e| format!("failed to run git while detecting project: {e}"))?;
    if status.success() {
        if truncated {
            return Err("git project detection output exceeded safety limit".into());
        }
        let text = String::from_utf8_lossy(&stdout).into_owned();
        let mut lines = text.lines();
        let root = lines.next().unwrap_or("").trim().to_string();
        if root.is_empty() {
            return Err("git rev-parse returned no toplevel".into());
        }
        let branch = lines
            .next()
            .map(str::trim)
            .filter(|b| !b.is_empty() && *b != "HEAD")
            .map(str::to_string);
        Ok(ProjectInfo {
            name: PathBuf::from(&root)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| root.clone()),
            path: path.clone(),
            is_git: true,
            git_root: Some(root),
            branch,
        })
    } else {
        let stderr = String::from_utf8_lossy(&stderr);
        if !is_not_repository_error(&stderr) {
            return Err(format!("git project detection failed: {}", stderr.trim()));
        }
        Ok(ProjectInfo {
            name: dir_name_of(&p),
            path,
            is_git: false,
            git_root: None,
            branch: None,
        })
    }
}

#[command]
pub fn git_init(path: String, branch: Option<String>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let initial = branch.unwrap_or_else(|| "main".into());
    reject_git_ref(&initial, "branch")?;
    let (status, _, stderr, truncated) =
        git_output(&p, &["init", "-b", &initial], GIT_TIMEOUT)?;
    if !status.success() {
        return Err(format!(
            "git init failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if truncated {
        return Err("git init output exceeded safety limit".into());
    }
    Ok(p.to_string_lossy().to_string())
}

/// Capped read: `Command::output()` buffered a whole multi-hundred-MB diff
/// only for the caller to keep the first 1MB. Stop reading at the cap, then
/// kill the child so it never blocks on a full pipe. Returns (text, truncated).
fn git_capped(repo: &Path, args: &[&str], cap: usize) -> Result<(String, bool), String> {
    use std::process::Stdio;
    let mut child = git_cmd()
        .args(args)
        .current_dir(repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "[git] failed to spawn".to_string())?;
    // Drain stderr on its own thread: reading it after wait() would deadlock
    // if git ever filled the pipe while we were still reading stdout.
    let err_thread = child.stderr.take().map(|e| {
        std::thread::spawn(move || read_capped(e, STDERR_CAP))
    });
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    if let Some(mut out) = child.stdout.take() {
        let mut chunk = [0u8; 32 * 1024];
        while buf.len() < cap {
            match out.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let room = cap - buf.len();
                    if n > room {
                        buf.extend_from_slice(&chunk[..room]);
                        truncated = true;
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                Err(_) => break,
            }
        }
        // Reaching the cap is enough to conservatively mark the result
        // truncated. Waiting for one extra byte here can block forever when
        // the child is still writing past the cap.
        if buf.len() >= cap {
            truncated = true;
        }
    }
    if truncated {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let (stderr, stderr_truncated) = err_thread
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();
    if !truncated && !status.success() {
        let mut message = String::from_utf8_lossy(&stderr).trim().to_string();
        if stderr_truncated {
            message.push_str(" [stderr truncated]");
        }
        return Err(format!("git {} failed: {}", args.join(" "), message));
    }
    Ok((String::from_utf8_lossy(&buf).to_string(), truncated))
}

#[command]
pub fn git_status(path: String) -> Result<Vec<FileStatus>, String> {
    let repo = PathBuf::from(&path);
    // core.quotepath=false (same as git_diff): without it non-ASCII paths
    // come back quoted + octal-escaped ("na\303\257ve.txt") and can't be
    // opened from the tree.
    let (mut out, truncated) = git_capped(
        &repo,
        &["-c", "core.quotepath=false", "status", "--porcelain", "-z"],
        STATUS_CAP,
    )?;
    if truncated {
        // The tail entry is a partial record: drop it rather than report a
        // bogus path that cannot be opened from the tree.
        if let Some(i) = out.rfind('\0') {
            out.truncate(i + 1);
        }
    }
    let mut files = vec![];
    let mut iter = out.split('\0').filter(|s| !s.is_empty());
    // M-004: byte-slice panicked on any <3-byte entry; non-UTF8 names came
    // back mangled and unopenable. get(3..) skips malformed entries, and
    // lossy paths are still returned (the tree shows them, open may fail).
    while let Some(entry) = iter.next() {
        let mut chars = entry.chars();
        let ix = chars.next().unwrap_or(' ');
        let wd = chars.next().unwrap_or(' ');
        let Some(file_path) = entry.get(3..) else {
            continue;
        };
        let file_path = file_path.to_string();
        // rename entries: "R  new\0old" — the -z form has the orig path next
        if ix == 'R' || ix == 'C' || wd == 'R' || wd == 'C' {
            let _orig = iter.next();
        }
        files.push(FileStatus {
            path: file_path,
            index_status: ix.to_string(),
            workdir_status: wd.to_string(),
        });
    }
    Ok(files)
}

#[command]
pub fn git_diff(path: String, base: Option<String>, file: Option<String>) -> Result<String, String> {
    let repo = PathBuf::from(&path);
    let mut args: Vec<String> = vec![
        "-c".into(),
        "core.quotepath=false".into(),
        "diff".into(),
        "--no-color".into(),
    ];
    // Base BEFORE `--`: everything after it is a pathspec, so the old order
    // made `git diff -- <ref>` diff a path named like the ref (usually
    // nothing) instead of the revision.
    if let Some(b) = &base {
        reject_git_ref(b, "base")?;
        args.push(b.clone());
    }
    args.push("--".into());
    if let Some(file) = file {
        if file.trim().is_empty() || file.contains('\0') {
            return Err("invalid diff file".into());
        }
        let requested = PathBuf::from(&file);
        let relative = if requested.is_absolute() {
            requested
                .strip_prefix(&repo)
                .map_err(|_| "diff file is outside the repository".to_string())?
        } else {
            requested.as_path()
        };
        if relative.as_os_str().is_empty()
            || relative == Path::new(".")
            || relative.components().any(|c| matches!(c, Component::ParentDir))
        {
            return Err("invalid diff file".into());
        }
        args.push(relative.to_string_lossy().replace('\\', "/"));
    }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (diff, truncated) = git_capped(&repo, &args_ref, DIFF_CAP)?;
    if truncated {
        // Cut on a char boundary: String::truncate panics mid multi-byte.
        let mut cut = diff;
        let mut at = cut.len();
        while at > 0 && !cut.is_char_boundary(at) {
            at -= 1;
        }
        cut.truncate(at);
        cut.push_str("\n... [diff truncated at 1MB]\n");
        return Ok(cut);
    }
    Ok(diff)
}

#[command]
pub fn git_branches(repo_root: String) -> Result<Vec<String>, String> {
    let repo = PathBuf::from(&repo_root);
    let out = git(&repo, &["branch", "-a", "--format=%(refname:short)"])?;
    let mut branches: Vec<String> = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains(" -> "))
        .map(str::to_string)
        .collect();
    branches.sort();
    branches.dedup();
    Ok(branches)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

fn counterpart(repo: &Path) -> Option<String> {
    // Upstream first: the branch's own tracking ref when it has one.
    if let Ok(out) = git(repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) {
        let u = out.trim().to_string();
        if !u.is_empty() {
            return Some(u);
        }
    }
    // No upstream (typical for guimux/ branches): fall back to main/master
    // so the badge still reads as commits unique to this worktree.
    for cand in ["main", "master"] {
        if git(repo, &["show-ref", "--verify", &format!("refs/heads/{cand}")]).is_ok() {
            return Some(cand.to_string());
        }
    }
    None
}

#[command]
pub fn git_ahead_behind(path: String) -> Result<AheadBehind, String> {
    let repo = PathBuf::from(&path);
    let Some(base) = counterpart(&repo) else {
        return Ok(AheadBehind { ahead: 0, behind: 0 });
    };
    let spec = format!("HEAD...{base}");
    match git(&repo, &["rev-list", "--left-right", "--count", &spec]) {
        Ok(out) => {
            let mut it = out.split_whitespace();
            let ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            Ok(AheadBehind { ahead, behind })
        }
        // Empty repo (no HEAD yet): nothing to be ahead of.
        Err(_) => Ok(AheadBehind { ahead: 0, behind: 0 }),
    }
}

#[command]
pub fn git_commit(path: String, message: String, stage_all: Option<bool>) -> Result<String, String> {
    let repo = PathBuf::from(&path);
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is empty".into());
    }
    if msg.contains('\0') {
        return Err("invalid commit message".into());
    }
    let msg: String = msg.chars().take(2000).collect();
    if stage_all.unwrap_or(false) {
        git(&repo, &["add", "-A"])?;
    }
    git(&repo, &["commit", "-m", &msg])
}

#[command]
pub fn git_push(path: String) -> Result<String, String> {
    let repo = PathBuf::from(&path);
    git(&repo, &["push"])
}

#[command]
pub fn git_fetch(path: String) -> Result<String, String> {
    let repo = PathBuf::from(&path);
    git(&repo, &["fetch", "--prune"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn status_and_diff() {
        let dir = std::env::temp_dir().join(format!("guimux-git-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            Command::new("git").args(&args).current_dir(&dir).output().unwrap();
        }
        fs::write(dir.join("a.txt"), "hello").unwrap();
        Command::new("git").args(["add", "."]).current_dir(&dir).output().unwrap();
        Command::new("git").args(["commit", "-m", "init"]).current_dir(&dir).output().unwrap();

        fs::write(dir.join("a.txt"), "changed").unwrap();
        let st = git_status(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].path, "a.txt");
        assert_eq!(st[0].workdir_status, "M");

        let diff = git_diff(dir.to_string_lossy().to_string(), None, Some("a.txt".into())).unwrap();
        assert!(diff.contains("-hello"));
        assert!(diff.contains("+changed"));
        fs::write(dir.join("b.txt"), "other").unwrap();
        let scoped = git_diff(dir.to_string_lossy().to_string(), None, Some("a.txt".into())).unwrap();
        assert!(!scoped.contains("other"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_and_ahead_behind() {
        let dir = std::env::temp_dir().join(format!("guimux-git-wr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            Command::new("git").args(&args).current_dir(&dir).output().unwrap();
        }
        let root = dir.to_string_lossy().to_string();
        assert!(git_commit(root.clone(), "   ".into(), None).is_err());
        fs::write(dir.join("a.txt"), "hello").unwrap();
        git_commit(root.clone(), "init".into(), Some(true)).unwrap();
        let ab = git_ahead_behind(root.clone()).unwrap();
        assert_eq!((ab.ahead, ab.behind), (0, 0));
        Command::new("git").args(["checkout", "-b", "feature"]).current_dir(&dir).output().unwrap();
        fs::write(dir.join("b.txt"), "work").unwrap();
        git_commit(root.clone(), "wt change".into(), Some(true)).unwrap();
        let ab = git_ahead_behind(root.clone()).unwrap();
        assert_eq!((ab.ahead, ab.behind), (1, 0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_detection_distinguishes_plain_folders_from_git_errors() {
        assert!(is_not_repository_error(
            "fatal: not a git repository (or any of the parent directories): .git"
        ));
        assert!(is_not_repository_error(
            "fatal: not a git repository: '/tmp/repo'"
        ));
        assert!(!is_not_repository_error(
            "fatal: detected dubious ownership in repository at '/tmp/repo'"
        ));
        assert!(!is_not_repository_error("fatal: unable to access repository"));
    }

    #[test]
    fn project_detection_marks_missing_paths() {
        let path = std::env::temp_dir().join(format!(
            "guimux-missing-project-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        let error = project_detect(path.to_string_lossy().to_string()).unwrap_err();
        assert!(error.starts_with("PROJECT_PATH_MISSING:"), "unexpected error: {error}");
    }
}
