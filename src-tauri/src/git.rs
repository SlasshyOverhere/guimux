use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
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
/// `git push` and `git fetch` move objects over the network, so they legitimately
/// run past GIT_TIMEOUT; killing one there failed mid-transfer with
/// "timed out after 30s" and looked like a network fault.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

/// All git spawns go through here: on Windows a child console process flashes
/// a visible console window unless CREATE_NO_WINDOW is set — that flash is
/// the "terminals popping in and out" on startup and on every status poll.
#[cfg(windows)]
const GIT_EXECUTABLE: &str = "git.exe";
#[cfg(not(windows))]
const GIT_EXECUTABLE: &str = "git";

fn git_executable_from_path(path: &OsStr) -> Result<PathBuf, String> {
    for directory in std::env::split_paths(path) {
        if !directory.is_absolute() {
            continue;
        }
        let candidate = directory.join(GIT_EXECUTABLE);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("{GIT_EXECUTABLE} was not found in an absolute PATH entry"))
}

fn git_executable() -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH").ok_or("PATH is not set")?;
    git_executable_from_path(&path)
}

pub fn git_cmd() -> Result<Command, String> {
    let mut cmd = Command::new(git_executable()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    Ok(cmd)
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
            Ok(0) => break,
            Err(_) => {
                // A read error is not EOF. Reporting it as one hands the caller
                // a silently short stream flagged as complete.
                truncated = true;
                break;
            }
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

/// Reads at most `cap` bytes, then stops so the child can be killed instead of
/// blocking on a full pipe. Extracted from `git_capped` so the error-vs-EOF
/// handling is testable without spawning git.
fn read_to_cap(reader: &mut impl Read, cap: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 32 * 1024];
    while buf.len() < cap {
        match reader.read(&mut chunk) {
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
            // Not EOF: without this the caller gets a short read that looks
            // whole, and `git_status`/`git_diff` report it as complete.
            Err(_) => {
                truncated = true;
                break;
            }
        }
    }
    // Reaching the cap is enough to conservatively mark the result
    // truncated. Waiting for one extra byte here can block forever when
    // the child is still writing past the cap.
    if buf.len() >= cap {
        truncated = true;
    }
    (buf, truncated)
}

fn recv_reader<T>(rx: &mpsc::Receiver<T>, timeout: Duration) -> Option<T> {
    rx.recv_timeout(timeout).ok()
}

pub fn git_output(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>, bool), String> {
    let mut child = git_cmd()
        .map_err(|e| format!("[git] {e}"))?
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("[git] failed to spawn: {e}"))?;
    let stdout = child.stdout.take().ok_or("git stdout pipe unavailable")?;
    let stderr = child.stderr.take().ok_or("git stderr pipe unavailable")?;
    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    let _ = std::thread::spawn(move || {
        let _ = out_tx.send(read_capped(stdout, STATUS_CAP));
    });
    let _ = std::thread::spawn(move || {
        let _ = err_tx.send(read_capped(stderr, STDERR_CAP));
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("[git] wait failed: {e}"));
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("git {} timed out after {}s", args.join(" "), timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let (Some((stdout, stdout_truncated)), Some((stderr, stderr_truncated))) =
        (
            recv_reader(&out_rx, READER_DRAIN_TIMEOUT),
            recv_reader(&err_rx, READER_DRAIN_TIMEOUT),
        )
    else {
        return Err("[git] output pipe did not close".into());
    };
    Ok((status, stdout, stderr, stdout_truncated || stderr_truncated))
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    // Every dynamic ref/path arg must be preceded by `"--"` at the call
    // site; static flag lists here are safe by construction.
    git_probe(repo, args, GIT_TIMEOUT).map_err(|(_, rendered)| rendered)
}

/// The only way to run a git command that moves objects over the network.
/// Its deadline is baked in rather than passed in: while the timeout was an
/// argument, routing a push or fetch back onto GIT_TIMEOUT was a one-token
/// edit that no runtime test could see. There is now nothing to get wrong
/// except calling the wrong one of these two functions.
fn network_git(repo: &Path, args: &[&str]) -> Result<String, String> {
    git_probe(repo, args, NETWORK_TIMEOUT).map_err(|(_, rendered)| rendered)
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

#[command(async)]
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

#[command(async)]
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
    let mut child = git_cmd()?
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "[git] failed to spawn".to_string())?;
    let stdout = child.stdout.take().ok_or("git stdout pipe unavailable")?;
    let stderr = child.stderr.take().ok_or("git stderr pipe unavailable")?;
    let child = Arc::new(Mutex::new(child));
    let timed_out = Arc::new(AtomicBool::new(false));
    let watchdog_child = Arc::clone(&child);
    let watchdog_timeout = Arc::clone(&timed_out);
    let watchdog = std::thread::spawn(move || {
        let deadline = Instant::now() + GIT_TIMEOUT;
        loop {
            let done = {
                let mut child = watchdog_child.lock().unwrap_or_else(|e| e.into_inner());
                matches!(child.try_wait(), Ok(Some(_)))
            };
            if done || Instant::now() >= deadline {
                if !done {
                    watchdog_timeout.store(true, Ordering::SeqCst);
                    let _ = watchdog_child
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .kill();
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    // Drain stderr on its own thread: reading it after wait() would deadlock
    // if git ever filled the pipe while we were still reading stdout.
    let (err_tx, err_rx) = mpsc::channel();
    let _ = std::thread::spawn(move || {
        let _ = err_tx.send(read_capped(stderr, STDERR_CAP));
    });
    let mut out = stdout;
    let (buf, truncated) = read_to_cap(&mut out, cap);
    if truncated {
        let _ = child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .kill();
    }
    let status = child
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .wait()
        .map_err(|e| e.to_string())?;
    let _ = watchdog.join();
    if timed_out.load(Ordering::SeqCst) {
        return Err(format!("git {} timed out after {}s", args.join(" "), GIT_TIMEOUT.as_secs()));
    }
    let (stderr, stderr_truncated) = recv_reader(&err_rx, READER_DRAIN_TIMEOUT)
        .ok_or("[git] stderr pipe did not close")?;
    if !truncated && !status.success() {
        let mut message = String::from_utf8_lossy(&stderr).trim().to_string();
        if stderr_truncated {
            message.push_str(" [stderr truncated]");
        }
        return Err(format!("git {} failed: {}", args.join(" "), message));
    }
    Ok((String::from_utf8_lossy(&buf).to_string(), truncated))
}

#[command(async)]
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

/// `Path::strip_prefix` compares components byte for byte, so a `c:\repo` path
/// never matches a `C:/repo` root on Windows. Fall back to a case-insensitive
/// component match there so a differently spelled root is still in scope.
fn strip_repo_prefix(path: &Path, repo: &Path) -> Option<PathBuf> {
    if let Ok(rest) = path.strip_prefix(repo) {
        return Some(rest.to_path_buf());
    }
    #[cfg(windows)]
    {
        let parts: Vec<_> = path.components().collect();
        let root: Vec<_> = repo.components().collect();
        let matches = parts.len() >= root.len()
            && parts
                .iter()
                .zip(&root)
                .all(|(a, b)| a.as_os_str().eq_ignore_ascii_case(b.as_os_str()));
        matches.then(|| parts[root.len()..].iter().collect())
    }
    #[cfg(not(windows))]
    None
}

#[command(async)]
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
            strip_repo_prefix(&requested, &repo)
                .ok_or("diff file is outside the repository")?
        } else {
            requested.clone()
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

#[command(async)]
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

/// git exits 128 for a missing upstream, a missing ref, and a repo with no
/// commits. Those are real zeroes, not failures. Everything else (not a
/// repository, dubious ownership, a timeout) is a real failure and must reach
/// the banner: a silent 0/0 makes a broken repo look exactly like a clean one.
fn is_unmeasurable(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("no upstream configured")
        || lower.contains("no such branch")
        || lower.contains("not a valid ref")
        || lower.contains("unknown revision")
        || lower.contains("ambiguous argument")
}

/// Runs git and shapes the result. The single owner of that job: `git` is a
/// thin wrapper that drops the stderr, and the ahead/behind path keeps it to
/// tell "nothing to measure" from "git refused". `git_output`'s own errors
/// pass through untouched so the rendered text never doubles up a prefix.
fn git_probe(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, (String, String)> {
    let (status, stdout, stderr, truncated) =
        git_output(repo, args, timeout).map_err(|e| (String::new(), e))?;
    let detail = String::from_utf8_lossy(&stderr).trim().to_string();
    if status.success() {
        if truncated {
            return Err((detail, "git output exceeded safety limit".into()));
        }
        Ok(String::from_utf8_lossy(&stdout).to_string())
    } else {
        Err((
            detail.clone(),
            format!("git {} failed: {}", args.join(" "), detail),
        ))
    }
}

/// The branch ahead/behind is measured against. `Ok(None)` means there is
/// genuinely nothing to measure (no upstream, no main/master, no commits yet);
/// `Err` means git itself failed and the user has to see why.
fn counterpart(repo: &Path) -> Result<Option<String>, String> {
    // Upstream first: the branch's own tracking ref when it has one.
    match git_probe(
        repo,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        GIT_TIMEOUT,
    ) {
        Ok(out) => {
            let u = out.trim().to_string();
            if !u.is_empty() && reject_git_ref(&u, "upstream").is_ok() {
                return Ok(Some(u));
            }
        }
        Err((detail, _)) if is_unmeasurable(&detail) => {}
        Err((_, rendered)) => return Err(rendered),
    }
    // No upstream (typical for guimux/ branches): fall back to main/master
    // so the badge still reads as commits unique to this worktree.
    for cand in ["main", "master"] {
        match git_probe(
            repo,
            &["show-ref", "--verify", &format!("refs/heads/{cand}")],
            GIT_TIMEOUT,
        ) {
            Ok(_) => return Ok(Some(cand.to_string())),
            // A ref that simply is not there is the normal miss, not a failure.
            Err((detail, _)) if is_unmeasurable(&detail) => continue,
            Err((_, rendered)) => return Err(rendered),
        }
    }
    Ok(None)
}

#[command(async)]
pub fn git_ahead_behind(path: String) -> Result<AheadBehind, String> {
    let repo = PathBuf::from(&path);
    let Some(base) = counterpart(&repo)? else {
        return Ok(AheadBehind { ahead: 0, behind: 0 });
    };
    let spec = format!("HEAD...{base}");
    match git_probe(&repo, &["rev-list", "--left-right", "--count", &spec], GIT_TIMEOUT) {
        Ok(out) => {
            let mut it = out.split_whitespace();
            // An unparseable count is a git we do not understand, not a zero.
            match (it.next().and_then(|s| s.parse().ok()), it.next().and_then(|s| s.parse().ok())) {
                (Some(ahead), Some(behind)) => Ok(AheadBehind { ahead, behind }),
                _ => Err("git rev-list returned an unreadable count".into()),
            }
        }
        // Empty repo (no HEAD yet): nothing to be ahead of.
        Err((detail, _)) if is_unmeasurable(&detail) => Ok(AheadBehind { ahead: 0, behind: 0 }),
        Err((_, rendered)) => Err(rendered),
    }
}

#[command(async)]
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

#[command(async)]
pub fn git_push(path: String) -> Result<String, String> {
    let repo = PathBuf::from(&path);
    network_git(&repo, &["push"])
}

#[command(async)]
pub fn git_fetch(path: String) -> Result<String, String> {
    let repo = PathBuf::from(&path);
    network_git(&repo, &["fetch", "--prune"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reader_drain_timeout_is_bounded() {
        let (tx, rx) = mpsc::channel::<u8>();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            let _ = tx.send(1);
        });
        let started = Instant::now();
        assert!(recv_reader(&rx, Duration::from_millis(10)).is_none());
        assert!(started.elapsed() < Duration::from_millis(250));
    }

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
        // An absolute file path, with the root spelled in a different case:
        // Windows prefix matching must still scope it.
        let mut recased = dir.to_string_lossy().to_string();
        if cfg!(windows) {
            recased = recased.to_lowercase();
        }
        let absolute =
            git_diff(recased, None, Some(dir.join("a.txt").to_string_lossy().to_string())).unwrap();
        assert!(absolute.contains("+changed"), "absolute scoped diff missing");
        assert!(!absolute.contains("other"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn capped_diff_stops_at_requested_cap() {
        let dir = std::env::temp_dir().join(format!("guimux-git-cap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            Command::new("git").args(&args).current_dir(&dir).output().unwrap();
        }
        fs::write(dir.join("a.txt"), "a".repeat(4096)).unwrap();
        Command::new("git").args(["add", "."]).current_dir(&dir).output().unwrap();
        Command::new("git").args(["commit", "-m", "init"]).current_dir(&dir).output().unwrap();
        fs::write(dir.join("a.txt"), "b".repeat(4096)).unwrap();

        let (diff, truncated) = git_capped(&dir, &["diff", "--"], 128).unwrap();
        assert!(truncated);
        assert!(diff.len() <= 128);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_path_ignores_relative_entries() {
        let dir = std::env::temp_dir().join(format!("guimux-git-path-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let fake = dir.join(GIT_EXECUTABLE);
        fs::write(&fake, b"not executable").unwrap();

        let absolute = std::env::join_paths([dir.clone()]).unwrap();
        assert_eq!(git_executable_from_path(&absolute).unwrap(), fake);
        assert!(git_executable_from_path(std::ffi::OsStr::new("relative-git-dir")).is_err());
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

    /// Every user-visible git error flows through `git`/`git_probe`, so its
    /// message shape is the app's actual contract with the banner. These pin
    /// it: once-labelled prefix, git's own stderr kept, nothing swallowed.
    #[test]
    fn spawn_failures_render_gits_prefix_exactly_once() {
        // An invalid cwd makes spawn() fail deterministically, which is the
        // only path where git_output's own "[git] " label is produced.
        let missing = std::env::temp_dir().join("guimux-spawn-fail-probe");
        let _ = fs::remove_dir_all(&missing);
        let error = git(&missing, &["log", "--oneline"]).unwrap_err();
        assert!(
            !error.contains("[git] [git]"),
            "git's prefix was doubled: {error}"
        );
        assert!(
            error.starts_with("[git] "),
            "git's own prefix was dropped: {error}"
        );
        assert!(
            error.contains("failed to spawn"),
            "the failure reason was swallowed: {error}"
        );
    }

    #[test]
    fn a_non_zero_exit_surfaces_gits_own_message() {
        let notrepo = std::env::temp_dir().join(format!("guimux-notrepo-msg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&notrepo);
        fs::create_dir_all(&notrepo).unwrap();

        let error = git(&notrepo, &["branch", "-a"]).unwrap_err();
        assert!(
            error.starts_with("git branch -a failed: "),
            "unexpected shape: {error}"
        );
        assert!(
            error.contains("not a git repository"),
            "git's stderr was dropped: {error}"
        );

        // The commands the sidebar calls must keep the same shape rather than
        // inventing their own wording.
        for (expected, error) in [
            (
                "git push failed: ",
                git_push(notrepo.to_string_lossy().to_string()).unwrap_err(),
            ),
            (
                "git fetch --prune failed: ",
                git_fetch(notrepo.to_string_lossy().to_string()).unwrap_err(),
            ),
        ] {
            assert!(error.starts_with(expected), "unexpected shape: {error}");
            assert!(
                error.contains("not a git repository"),
                "git's stderr was dropped: {error}"
            );
        }

        let _ = fs::remove_dir_all(&notrepo);
    }

    #[test]
    fn our_own_validation_messages_still_win_over_git() {
        let notrepo = std::env::temp_dir().join(format!("guimux-validate-msg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&notrepo);
        fs::create_dir_all(&notrepo).unwrap();
        let error = git_commit(notrepo.to_string_lossy().to_string(), "   ".into(), None).unwrap_err();
        assert_eq!(error, "commit message is empty");
        let _ = fs::remove_dir_all(&notrepo);
    }

    /// A remote that accepts the connection and never sends a ref
    /// advertisement: the connection is alive but has stopped responding, which
    /// is what a slow or wedged upstream looks like to git. Raw `git push` and
    /// `git fetch` against one never return (measured past 75s), so the app-side
    /// deadline is the only thing bounding them.
    fn silent_remote() -> String {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("git://{}/repo.git", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for conn in listener.incoming() {
                match conn {
                    Ok(s) => held.push(s),
                    Err(_) => break,
                }
            }
        });
        url
    }

    /// A repo with one commit whose origin is a silent remote, so both push and
    /// fetch reach for the network instead of failing before they dial out.
    fn repo_tracking_silent_remote(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("guimux-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
        };
        run(&["init", "-q", "-b", "main", "."]);
        std::fs::write(dir.join("f.txt"), b"data").unwrap();
        run(&["add", "-A"]);
        run(&["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init"]);
        let url = silent_remote();
        run(&["remote", "add", "origin", &url]);
        run(&["config", "branch.main.remote", "origin"]);
        run(&["config", "branch.main.merge", "refs/heads/main"]);
        dir
    }

    /// The deadline is enforced and per call; the constant assertion is what
    /// keeps push and fetch off the poll cap. Both tests use a 2s deadline
    /// rather than NETWORK_TIMEOUT so they finish in seconds.
    fn assert_killed_at(repo: &Path, args: &[&str], what: &str) {
        use std::time::Instant;
        let t0 = Instant::now();
        let error = git_probe(repo, args, Duration::from_secs(2))
            .map_err(|(_, rendered)| rendered)
            .unwrap_err();
        let elapsed = t0.elapsed();
        assert_eq!(
            error,
            format!("git {} timed out after 2s", args.join(" ")),
            "unexpected error: {error}"
        );
        assert!(
            elapsed < Duration::from_secs(20),
            "the kill did not happen promptly: {elapsed:?}"
        );
        assert!(
            NETWORK_TIMEOUT > GIT_TIMEOUT * 10,
            "network timeout {NETWORK_TIMEOUT:?} is not meaningfully longer than {GIT_TIMEOUT:?} ({what})"
        );
    }

    /// The runtime tests call `git_probe` directly, so they pin the kill and
    /// the constant but not which entry point each command uses — the one
    /// edit they cannot see. Checking that against the source is deliberate:
    /// the runtime alternative has to outlast the 30s poll cap.
    #[test]
    fn push_and_fetch_both_reach_the_network_through_network_git() {
        let src = include_str!("git.rs");
        for cmd in ["pub fn git_push", "pub fn git_fetch"] {
            let rest = &src[src.find(cmd).expect("command not found")..];
            let body = &rest[..rest.find("
}").expect("unterminated body")];
            assert!(
                body.contains("network_git("),
                "{cmd} does not go through network_git:{body}"
            );
            assert!(
                !body.contains("GIT_TIMEOUT"),
                "{cmd} names the poll cap directly:{body}"
            );
        }
        // And the deadline-taking entry point stays gone: it is what let a
        // network command be capped at 30s without anyone noticing. The name
        // is assembled so this test does not trip over its own text.
        let banned = ["git_with", "timeout"].concat();
        assert!(
            !src.contains(&banned),
            "a deadline-taking git entry point is back; push and fetch can be capped again"
        );
    }


    #[test]
    fn a_push_to_a_silent_remote_is_killed_at_its_own_deadline() {
        let dir = repo_tracking_silent_remote("pushprobe");
        assert_killed_at(&dir, &["push"], "push");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fetch_from_a_silent_remote_is_killed_at_its_own_deadline() {
        let dir = repo_tracking_silent_remote("fetchprobe");
        assert_killed_at(&dir, &["fetch", "--prune"], "fetch");
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn flag_shaped_refs_are_refused_everywhere() {
        assert!(reject_git_ref("main", "ref").is_ok());
        assert!(reject_git_ref("-f", "ref").is_err());
        assert!(reject_git_ref("--upload-pack=evil", "ref").is_err());
        assert!(reject_git_ref("ma\0in", "ref").is_err());
    }

    #[test]
    fn ahead_behind_uses_the_configured_upstream_and_not_main_or_master() {
        // A real local remote, a real push, no mocks: `counterpart` takes the
        // rev-parse @{u} success branch, which is the common case for any repo
        // with a remote and was previously untested.
        let dir = std::env::temp_dir().join(format!("guimux-upstream-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let remote = dir.join("remote.git");
        let repo = dir.join("work");
        fs::create_dir_all(&repo).unwrap();
        Command::new("git")
            .args(["init", "-q", "--bare"])
            .arg(&remote)
            .output()
            .unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            Command::new("git").args(&args).current_dir(&repo).output().unwrap();
        }
        fs::write(repo.join("a.txt"), "hello").unwrap();
        Command::new("git").args(["add", "."]).current_dir(&repo).output().unwrap();
        Command::new("git").args(["commit", "-m", "init"]).current_dir(&repo).output().unwrap();
        Command::new("git")
            .args(["remote", "add", "origin"])
            .arg(&remote)
            .current_dir(&repo)
            .output()
            .unwrap();
        let push = Command::new("git")
            .args(["push", "-u", "origin", "main"])
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(
            push.status.success(),
            "push failed: {}",
            String::from_utf8_lossy(&push.stderr)
        );

        assert_eq!(
            counterpart(&repo).unwrap(),
            Some("origin/main".to_string()),
            "the configured upstream must win over the main/master fallback"
        );

        // One commit past the upstream. Against `main` this would read 0/0, so
        // ahead == 1 is what proves the upstream was actually the base.
        fs::write(repo.join("b.txt"), "local").unwrap();
        Command::new("git").args(["add", "."]).current_dir(&repo).output().unwrap();
        Command::new("git").args(["commit", "-m", "local"]).current_dir(&repo).output().unwrap();
        let ab = git_ahead_behind(repo.to_string_lossy().to_string()).unwrap();
        assert_eq!((ab.ahead, ab.behind), (1, 0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ahead_behind_reports_git_failures_instead_of_a_clean_zero() {
        // A directory that is not a repo used to come back Ok(0, 0), which the
        // sidebar rendered as a legitimate "0 ahead" badge. A broken worktree
        // must be distinguishable from a clean one.
        let dir = std::env::temp_dir().join(format!("guimux-not-a-repo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let error = git_ahead_behind(dir.to_string_lossy().to_string()).unwrap_err();
        assert!(
            error.contains("not a git repository"),
            "unexpected error: {error}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ahead_behind_still_reports_zero_for_a_genuinely_unmeasurable_repo() {
        // The cases that really are zero must stay zero, or the fix above just
        // trades a silent lie for a red banner on every fresh repo.
        let dir = std::env::temp_dir().join(format!("guimux-empty-repo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            Command::new("git").args(&args).current_dir(&dir).output().unwrap();
        }
        let ab = git_ahead_behind(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!((ab.ahead, ab.behind), (0, 0));

        // And a committed repo with no upstream and no main/master behind it.
        fs::write(dir.join("a.txt"), "hello").unwrap();
        Command::new("git").args(["add", "."]).current_dir(&dir).output().unwrap();
        Command::new("git").args(["commit", "-m", "init"]).current_dir(&dir).output().unwrap();
        let ab = git_ahead_behind(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!((ab.ahead, ab.behind), (0, 0));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A `Read` that yields one full buffer and then fails, to prove a
    /// mid-stream error is not mistaken for a clean end of file.
    struct OneShotThenError(bool);

    impl Read for OneShotThenError {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                Err(std::io::Error::other("simulated pipe failure"))
            } else {
                self.0 = true;
                Ok(buf.len())
            }
        }
    }

    #[test]
    fn read_failures_are_not_reported_as_clean_end_of_file() {
        let (out, truncated) = read_capped(OneShotThenError(false), 64 * 1024);
        assert!(!out.is_empty(), "the first successful read must still be kept");
        assert!(truncated, "a mid-stream read error must mark the result truncated");

        let (out, truncated) = read_to_cap(&mut OneShotThenError(false), 64 * 1024);
        assert!(!out.is_empty());
        assert!(
            truncated,
            "git_capped would hand back a short read that looks complete"
        );
    }

    #[test]
    fn a_clean_short_read_is_not_marked_truncated() {
        struct Short {
            data: Vec<u8>,
            pos: usize,
        }
        impl Read for Short {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.pos >= self.data.len() {
                    return Ok(0);
                }
                let n = (self.data.len() - self.pos).min(buf.len());
                buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
                self.pos += n;
                Ok(n)
            }
        }
        let (out, truncated) = read_to_cap(
            &mut Short {
                data: b"abc".to_vec(),
                pos: 0,
            },
            1024,
        );
        assert_eq!(out, b"abc");
        assert!(!truncated);
        let (out, truncated) = read_capped(
            Short {
                data: b"abc".to_vec(),
                pos: 0,
            },
            1024,
        );
        assert_eq!(out, b"abc");
        assert!(!truncated);
    }
}

