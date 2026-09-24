use crate::git::{git_output, reject_git_ref, GIT_TIMEOUT};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::command;

/// Process-unique suffix (rand_id collisions failed `worktree add -b`) and a
/// merge mutex (checkout+merge is not atomic across concurrent calls).
static ID_CTR: AtomicU64 = AtomicU64::new(0);
static MERGE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    pub id: String,
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    pub last_commit: Option<i64>,
}

fn last_commit_ts(path: &Path) -> Option<i64> {
    run_git(path, &["log", "-1", "--format=%ct"])
        .ok()
        .and_then(|out| out.trim().parse().ok())
}

fn rand_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let n = ID_CTR.fetch_add(1, Ordering::SeqCst);
    let rand: u16 = rand_id_suffix();
    format!("{ts:x}-{:x}-{:x}-{rand:04x}", std::process::id(), n)
}

fn rand_id_suffix() -> u16 {
    // cheap entropy: time nanos + address of a stack value
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let stack = &nanos as *const u32 as usize;
    (nanos as u16) ^ (stack as u16) ^ ((stack >> 16) as u16)
}

fn run_git(repo: &Path, args: &[&str]) -> Result<String, String> {
    // Some operations (merge) need a real CLI; run in the repo root.
    // NO_WINDOW + no rev-parse-audit: one spawn per op, invisible on Windows.
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

fn git_succeeds(repo: &Path, args: &[&str]) -> bool {
    git_output(repo, args, GIT_TIMEOUT)
        .map(|(status, _, _, _)| status.success())
        .unwrap_or(false)
}

fn current_branch(path: &Path) -> Result<String, String> {
    run_git(path, &["branch", "--show-current"])
        .map(|out| out.trim().to_string())
        .map_err(|e| format!("cannot inspect current branch: {e}"))
}

// (async): git spawns block for seconds; keep them off the main thread or
// the whole UI freezes (preflight/refresh wrap every delete).
#[command(async)]
pub fn worktree_list(repo_root: String) -> Result<Vec<Worktree>, String> {
    let root = PathBuf::from(&repo_root);
    if !root.exists() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let (status, stdout, stderr, truncated) = git_output(
        &root,
        &["worktree", "list", "--porcelain"],
        GIT_TIMEOUT,
    )
    .map_err(|e| format!("failed to run git (is it on PATH?): {e}"))?;
    if !status.success() {
        // Never swallow stderr here: the old Ok(vec![]) made the UI sit on
        // "Starting terminal…" forever (e.g. git's "dubious ownership" refusal).
        return Err(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if truncated {
        return Err("git worktree list output exceeded safety limit".into());
    }
    let text = String::from_utf8_lossy(&stdout);
    // (path, branch, head-hash, is_main). HEAD is free in this output; the
    // old code ignored it and ran one `git log` per worktree (N spawns on
    // the startup path). Timestamps resolve in one batch spawn below.
    let mut rows: Vec<(String, String, String, bool)> = vec![];
    let mut cur_path = String::new();
    let mut cur_branch = String::new();
    let mut cur_head = String::new();
    // Non-closure flush: borrows of `rows` inside an FnMut closure fight the
    // loop's later borrows. A macro expands inline, no borrow issue. First
    // flushed row is main (git lists it first).
    macro_rules! flush {
        () => {
            if !cur_path.is_empty() {
                let is_main = rows.is_empty();
                // Detached HEAD has no `branch` line: show the short hash so
                // the row never renders blank.
                if cur_branch.is_empty() {
                    cur_branch = if cur_head.len() >= 7 {
                        format!("detached:{}", &cur_head[..7])
                    } else {
                        "detached".to_string()
                    };
                }
                rows.push((cur_path.clone(), cur_branch.clone(), cur_head.clone(), is_main));
                cur_path.clear();
                cur_branch.clear();
                cur_head.clear();
            }
        };
    }
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush!();
            cur_path = p.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = b.trim_start_matches("refs/heads/").to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            cur_head = h.trim().to_string();
        } else if line.is_empty() {
            flush!();
        }
    }
    flush!();
    let stamps = batch_commit_ts(&root, rows.iter().map(|r| r.2.clone()).collect());
    Ok(rows
        .into_iter()
        .map(|(path, branch, head, is_main)| {
            let path = norm_sep(path);
            Worktree {
                id: path.clone(),
                path,
                branch,
                is_main,
                last_commit: stamps.get(&head).copied(),
            }
        })
        .collect())
}

/// One `git log --no-walk` for every worktree HEAD (empty map on failure).
fn batch_commit_ts(repo: &Path, heads: Vec<String>) -> std::collections::HashMap<String, i64> {
    use std::collections::HashMap;
    let mut map = HashMap::new();
    let heads: Vec<String> = heads.into_iter().filter(|h| !h.is_empty()).collect();
    if heads.is_empty() {
        return map;
    }
    let mut args: Vec<&str> = vec!["log", "--no-walk", "--format=%H %ct"];
    args.extend(heads.iter().map(|s| s.as_str()));
    let Ok(out) = run_git(repo, &args) else {
        return map;
    };
    for line in out.lines() {
        let mut it = line.split_whitespace();
        if let (Some(h), Some(ts)) = (it.next(), it.next()) {
            if let Ok(ts) = ts.parse() {
                map.insert(h.to_string(), ts);
            }
        }
    }
    map
}

#[command]
pub fn worktree_create(
    repo_root: String,
    base: Option<String>,
    name: Option<String>,
) -> Result<Worktree, String> {
    let root = PathBuf::from(&repo_root);
    if !root.exists() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    // branch: guimux/<ts>-<rand>
    let branch = match &name {
        Some(n) if !n.trim().is_empty() => format!("guimux/{}", sanitize(n)),
        _ => format!("guimux/{}", rand_id()),
    };
    let dir_name = branch
        .trim_start_matches("guimux/")
        .replace('/', "-");
    let slug = sanitize(
        &root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".into()),
    );
    // Same-named repos in different folders shared one dir: mix a hash of
    // the canonical root into the folder name.
    let project: String = format!("{slug}-{h:08x}", h = short_hash(&root));
    let base_dir = dirs::home_dir()
        .map(|h| h.join(".guimux").join("worktrees").join(&project))
        .unwrap_or_else(|| root.parent().unwrap_or(&root).to_path_buf());
    let _ = std::fs::create_dir_all(&base_dir);
    let path = base_dir.join(format!("{}-wt", dir_name));
    let mut i = 0;
    let mut target = path.clone();
    while target.exists() {
        i += 1;
        target = base_dir.join(format!("{}-wt-{}", dir_name, i));
    }
    let base_ref = base.unwrap_or_else(|| "HEAD".into());
    reject_git_ref(&base_ref, "base")?;
    run_git(
        &root,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            target.to_string_lossy().as_ref(),
            &base_ref,
        ],
    )?;
    // Forward slashes: must `==` the `worktree list` ids for the same path.
    let created_path = norm_sep(target.to_string_lossy().to_string());
    let last_commit = last_commit_ts(Path::new(&created_path));
    Ok(Worktree {
        id: created_path.clone(),
        path: created_path,
        branch,
        is_main: false,
        last_commit,
    })
}

/// FNV-1a over the root path: distinguishes same-named repos in the
/// worktrees dir without a new dependency.
fn short_hash(root: &Path) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in root.to_string_lossy().bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// C-001 guard for the `remove_dir_all` fallback (git already forgot the
/// path): only delete inside our own `~/.guimux/worktrees` tree — never the
/// repo root, home, or anything else. Returns the canonical target.
fn safe_manual_remove_target(main_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let target = std::fs::canonicalize(path).map_err(|e| format!("cannot resolve path: {e}"))?;
    let canon_root = std::fs::canonicalize(main_root).unwrap_or_else(|_| main_root.to_path_buf());
    if target == canon_root {
        return Err("refusing to delete the main worktree".into());
    }
    if let Some(home) = dirs::home_dir() {
        let canon_home = std::fs::canonicalize(&home).unwrap_or(home);
        if target == canon_home {
            return Err("refusing to delete the home directory".into());
        }
        let wt_base = canon_home.join(".guimux").join("worktrees");
        if target != wt_base && target.starts_with(&wt_base) {
            return Ok(target);
        }
    }
    let canon = target.to_string_lossy().to_string();
    Err(format!(
        "GUIMUX_STALE_OUTSIDE path={canon} repo={} worktree is not registered with git and is outside the managed dir; will not delete. Run `git worktree prune` to drop the stale entry or `git worktree repair` to re-register it, then retry",
        canon_root.to_string_lossy()
    ))
}

/// Paths git currently knows, slash-normalized for `==` with worktree ids.
fn registered_paths(root: &Path) -> Result<Vec<String>, String> {
    let (status, stdout, stderr, truncated) = git_output(
        root,
        &["worktree", "list", "--porcelain"],
        GIT_TIMEOUT,
    )
    .map_err(|e| format!("cannot inspect git worktrees: {e}"))?;
    if !status.success() {
        return Err(format!(
            "cannot inspect git worktrees: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if truncated {
        return Err("cannot inspect git worktrees: output exceeded safety limit".into());
    }
    Ok(String::from_utf8_lossy(&stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(|p| norm_sep(p.to_string()))
        .collect())
}

fn is_registered(root: &Path, id: &str) -> Result<bool, String> {
    let want = norm_sep(id.to_string());
    #[cfg(windows)]
    {
        Ok(registered_paths(root)?
            .iter()
            .any(|p| p.eq_ignore_ascii_case(&want)))
    }
    #[cfg(not(windows))]
    {
        Ok(registered_paths(root)?.iter().any(|p| p == &want))
    }
}

/// Stale classification for an id git no longer lists: canonical path plus
/// whether it sits inside the managed `~/.guimux/worktrees` tree.
fn classify_stale(main_root: &Path, path: &Path) -> (bool, String) {
    let canon = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string());
    let inside = safe_manual_remove_target(main_root, path).is_ok();
    (inside, canon)
}

fn delete_branch_guarded(root: &Path, b: &str, force: bool) -> Result<(), String> {
    if b.is_empty() || b.starts_with('-') || b.contains('\0') {
        return Err("invalid branch name".into());
    }
    // -d refuses an unmerged branch; -D only once the caller accepted the
    // loss of uncommitted work.
    let flag = if force { "-D" } else { "-d" };
    run_git(root, &["branch", flag, "--", b]).map(|_| ())
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            ' ' | '/' | '\\' | ':' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect()
}

/// Git for Windows prints paths with `/` (`worktree list --porcelain`,
/// `rev-parse --show-toplevel`) while PathBuf displays with `\`. A
/// backslash id from `worktree_create` never `==` its slash id from
/// `worktree_list`, so the UI selected a ghost worktree and sat on
/// "Starting terminal…" forever after every create.
#[cfg(windows)]
fn norm_sep(s: String) -> String {
    s.replace('\\', "/")
}
#[cfg(not(windows))]
fn norm_sep(s: String) -> String {
    s
}

// (async): status checks + up to 2s retry sleeps + recursive dir delete
// would freeze the app for ~5s on the main thread.
#[command(async)]
pub fn worktree_remove(
    repo_root: String,
    id: String,
    delete_branch: bool,
    force: Option<bool>,
) -> Result<(), String> {
    reject_git_ref(&id, "worktree id")?;
    let force = force.unwrap_or(false);
    let path = PathBuf::from(&id);
    // Run git from the MAIN worktree (a linked worktree reports itself as
    // toplevel, and removing a worktree from inside itself fails on Windows).
    // Resolve via repo_root: the worktree dir itself may be half-removed and
    // unusable as a cwd.
    let anchor = PathBuf::from(&repo_root);
    let root = find_main_worktree(&anchor).ok_or_else(|| {
        format!("cannot inspect git worktrees at {}", anchor.to_string_lossy())
    })?;
    if !path.exists() {
        // Dir already gone (e.g. a previous forced remove half-finished):
        // prune the stale entry so `git worktree list` stops showing it.
        run_git(&root, &["worktree", "prune"])?;
        return Ok(());
    }
    let branch = if delete_branch {
        let branch = current_branch(&path)?;
        if branch.is_empty() {
            return Err("cannot delete a detached worktree branch".into());
        }
        Some(branch)
    } else {
        None
    };
    // Git already forgot this id (moved folder, deleted
    // `.git/worktrees/<name>`, external `git worktree remove` without a
    // refresh): fail structured so the UI can show the path, offer prune,
    // and refresh — never a dead-end "delete it manually".
    if !is_registered(&root, &id)? {
        let (inside, canon) = classify_stale(&root, &path);
        let repo = root.to_string_lossy().to_string();
        if inside {
            if force {
                let target = safe_manual_remove_target(&root, &path)?;
                if let Err(e) = std::fs::remove_dir_all(&target) {
                    return Err(format!(
                        "worktree is not registered with git and folder cleanup failed (close terminals using it and retry): {e}"
                    ));
                }
                run_git(&root, &["worktree", "prune"])?;
                if delete_branch {
                    if let Some(b) = branch.as_deref() {
                        delete_branch_guarded(&root, b, force)?;
                    }
                }
                return Ok(());
            }
            return Err(format!(
                "GUIMUX_STALE_INSIDE path={canon} repo={repo} worktree is not registered with git; folder is inside the managed dir and can be deleted. Retry with force to delete the folder and prune"
            ));
        }
        return Err(format!(
            "GUIMUX_STALE_OUTSIDE path={canon} repo={repo} worktree is not registered with git and is outside the managed dir; will not delete. Run `git worktree prune` to drop the stale entry or `git worktree repair` to re-register it, then retry"
        ));
    }
    // --force also discards uncommitted work, so refuse it until the caller
    // confirmed the loss. Ignored build output does not count as dirty.
    if !force {
        let dirty = worktree_dirty(&path)?;
        // delete_branch runs `branch -D`, which also drops commits the base
        // never saw. Name them: a finished-but-unmerged branch must not vanish
        // behind a generic "branch will be deleted" prompt.
        let unmerged = if delete_branch {
            unmerged_commits(&root, branch.as_deref().unwrap_or_default())?
                .filter(|(n, _)| *n > 0)
        } else {
            None
        };
        let mut lost: Vec<String> = Vec::new();
        if dirty {
            lost.push("uncommitted changes".into());
        }
        if let Some((n, base)) = &unmerged {
            let noun = if *n == 1 { "commit" } else { "commits" };
            lost.push(format!("{n} {noun} not in {base}"));
        }
        if !lost.is_empty() {
            return Err(format!(
                "worktree has {}. Commit or merge first, or retry to discard them",
                lost.join(" and ")
            ));
        }
    }
    // Windows: AV/indexers can briefly lock freshly-written files; retry a few times.
    // A stale entry ("is not a working tree") is NOT transient: fall through to
    // the manual cleanup below instead of retrying.
    let mut last_err = String::new();
    for attempt in 0..5 {
        match run_git(&root, &["worktree", "remove", "--force", "--", id.as_str()]) {
            Ok(_) => {
                last_err = String::new();
                break;
            }
            Err(e) => {
                last_err = e.clone();
                if e.contains("is not a working tree") {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200 * (attempt + 1)));
            }
        }
    }
    if last_err.contains("is not a working tree") {
        // Raced to stale between the pre-check and remove: same structured
        // path as above, so the UI never sees a dead-end string.
        let (inside, canon) = classify_stale(&root, &path);
        let repo = root.to_string_lossy().to_string();
        if !inside {
            return Err(format!(
                "GUIMUX_STALE_OUTSIDE path={canon} repo={repo} worktree is not registered with git and is outside the managed dir; will not delete. Run `git worktree prune` to drop the stale entry or `git worktree repair` to re-register it, then retry"
            ));
        }
        if !force {
            return Err(format!(
                "GUIMUX_STALE_INSIDE path={canon} repo={repo} worktree became unregistered during removal; folder is inside the managed dir and was not deleted. Retry with force to delete it and prune"
            ));
        }
        let target = safe_manual_remove_target(&root, &path)?;
        if let Err(e) = std::fs::remove_dir_all(&target) {
            return Err(format!(
                "worktree is not registered with git and folder cleanup failed (close terminals using it and retry): {e}"
            ));
        }
        run_git(&root, &["worktree", "prune"])?;
        if let Some(b) = branch.as_deref() {
            delete_branch_guarded(&root, b, force)?;
        }
        return Ok(());
    }
    if !last_err.is_empty() {
        // Include the canonical path so the dialog never shows a bare id.
        let canon = std::fs::canonicalize(&path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| id.clone());
        return Err(format!("{} (path={canon})", last_err));
    }
    if let Some(b) = branch.as_deref() {
        delete_branch_guarded(&root, b, force)?;
        return Ok(());
    }
    Ok(())
}

#[command]
pub fn worktree_prune(repo_root: String) -> Result<(), String> {
    let anchor = PathBuf::from(&repo_root);
    let root = find_main_worktree(&anchor).unwrap_or(anchor);
    run_git(&root, &["worktree", "prune"])?;
    Ok(())
}

#[command]
pub fn worktree_repair(repo_root: String, path: Option<String>) -> Result<String, String> {
    let anchor = PathBuf::from(&repo_root);
    let root = find_main_worktree(&anchor).unwrap_or(anchor);
    match path {
        Some(p) if !p.trim().is_empty() => {
            reject_git_ref(&p, "path")?;
            run_git(&root, &["worktree", "repair", "--", p.trim()])
        }
        _ => run_git(&root, &["worktree", "repair"]),
    }
}

#[command]
pub fn worktree_merge(id: String) -> Result<String, String> {
    // Serialize merges: checkout+merge is not atomic across concurrent calls.
    let _guard = MERGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Merge the worktree's branch into its base branch, in the MAIN worktree.
    let path = PathBuf::from(&id);
    let main_wt = find_main_worktree(&path).ok_or("could not find main worktree")?;
    let branch = current_branch(&path)?;
    reject_git_ref(&branch, "branch")?;
    let base = find_base_branch(&main_wt, &branch)?;
    // Refuse with a dirty main worktree: a conflicted merge leaves MERGE_HEAD
    // behind (recover with `worktree_merge_abort`).
    if worktree_dirty(&main_wt)? {
        return Err("main worktree has uncommitted changes — commit or stash first".into());
    }
    // Ensure main worktree is on the base branch
    let cur = current_branch(&main_wt).unwrap_or_default();
    let switched = cur != base;
    if switched {
        run_git(&main_wt, &["checkout", &base])?;
    }
    match run_git(&main_wt, &["merge", "--no-ff", "--no-edit", "--", &branch]) {
        Ok(msg) => Ok(msg),
        Err(e) => {
            // The merge failed (conflict or otherwise): leave no surprise
            // side effect beyond the merge itself — put the main worktree
            // back on the branch the user had checked out. Best-effort: the
            // merge error is the one that matters, so a failed restore is
            // only appended, never replaces it.
            if switched {
                if let Err(r_err) = run_git(&main_wt, &["checkout", &cur]) {
                    return Err(format!("{e}\n(also failed to restore branch '{cur}' on the main worktree: {r_err})"));
                }
            }
            Err(e)
        }
    }
}

#[command]
pub fn worktree_merge_abort(id: String) -> Result<String, String> {
    // Recovery for a conflicted `worktree_merge` (MERGE_HEAD left behind).
    let _guard = MERGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = PathBuf::from(&id);
    let main_wt = find_main_worktree(&path).ok_or("could not find main worktree")?;
    run_git(&main_wt, &["merge", "--abort"])
}

fn find_main_worktree(path: &Path) -> Option<PathBuf> {
    // git worktree list from any worktree; first entry is main
    let (status, stdout, _, truncated) =
        git_output(path, &["worktree", "list", "--porcelain"], GIT_TIMEOUT).ok()?;
    if !status.success() || truncated {
        return None;
    }
    let text = String::from_utf8_lossy(&stdout);
    text.lines()
        .find_map(|l| l.strip_prefix("worktree "))
        .map(PathBuf::from)
}

fn find_base_branch(main_wt: &Path, branch: &str) -> Result<String, String> {
    // Heuristic: merge-base with main/master; fallback to current HEAD of main worktree.
    for cand in ["main", "master"] {
        if git_succeeds(main_wt, &["merge-base", "--is-ancestor", cand, branch]) {
            return Ok(cand.to_string());
        }
    }
    let cur_branch = current_branch(main_wt).unwrap_or_default();
    if cur_branch.is_empty() {
        return Err("no base branch found".into());
    }
    Ok(cur_branch)
}

fn worktree_dirty(path: &Path) -> Result<bool, String> {
    let (status, stdout, stderr, truncated) =
        git_output(path, &["status", "--porcelain"], GIT_TIMEOUT)
            .map_err(|e| format!("cannot inspect worktree status: {e}"))?;
    if !status.success() {
        return Err(format!(
            "cannot inspect worktree status: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if truncated {
        return Err("cannot inspect worktree status: output exceeded safety limit".into());
    }
    Ok(!stdout.is_empty())
}

/// Commits on the worktree's branch that its base lacks: what `branch -D`
/// would throw away.
fn unmerged_commits(main_wt: &Path, branch: &str) -> Result<Option<(usize, String)>, String> {
    if branch.is_empty() {
        return Ok(None);
    }
    let base = find_base_branch(main_wt, branch)?;
    let range = format!("{base}..{branch}");
    let (status, stdout, stderr, truncated) = git_output(
        main_wt,
        &["rev-list", "--count", &range],
        GIT_TIMEOUT,
    )
    .map_err(|e| format!("cannot inspect unmerged commits: {e}"))?;
    if !status.success() {
        return Err(format!(
            "cannot inspect unmerged commits: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if truncated {
        return Err("cannot inspect unmerged commits: output exceeded safety limit".into());
    }
    let n = String::from_utf8_lossy(&stdout)
        .trim()
        .parse::<usize>()
        .map_err(|_| "cannot inspect unmerged commits: invalid count".to_string())?;
    Ok(Some((n, base)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn fixture_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "guimux-test-{}-{}",
            std::process::id(),
            ID_CTR.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Command::new("git").args(["init", "-b", "main"]).current_dir(&dir).output().unwrap();
        Command::new("git").args(["config", "user.email", "t@t"]).current_dir(&dir).output().unwrap();
        Command::new("git").args(["config", "user.name", "t"]).current_dir(&dir).output().unwrap();
        fs::write(dir.join("a.txt"), "hello").unwrap();
        Command::new("git").args(["add", "."]).current_dir(&dir).output().unwrap();
        Command::new("git").args(["commit", "-m", "init"]).current_dir(&dir).output().unwrap();
        dir
    }

    #[test]
    fn worktree_remove_guards_uncommitted_work() {
        let repo = fixture_repo();
        let root = repo.to_string_lossy().to_string();
        let wt = worktree_create(root.clone(), None, Some("dirty-one".into())).unwrap();
        fs::write(Path::new(&wt.path).join("scratch.txt"), "uncommitted").unwrap();

        let err = worktree_remove(root.clone(), wt.id.clone(), false, None).unwrap_err();
        assert!(err.contains("uncommitted changes"), "unexpected error: {err}");

        worktree_remove(root.clone(), wt.id.clone(), false, Some(true)).unwrap();
        assert!(!Path::new(&wt.path).exists());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn worktree_remove_guards_unmerged_commits() {
        let repo = fixture_repo();
        let root = repo.to_string_lossy().to_string();
        let wt = worktree_create(root.clone(), None, Some("unmerged-one".into())).unwrap();
        fs::write(Path::new(&wt.path).join("c.txt"), "only on this branch").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(&wt.path)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "unmerged work"])
            .current_dir(&wt.path)
            .output()
            .unwrap();

        // Clean tree, but the branch holds a commit main never saw.
        let err = worktree_remove(root.clone(), wt.id.clone(), true, None).unwrap_err();
        assert!(err.contains("1 commit not in main"), "unexpected error: {err}");

        worktree_remove(root.clone(), wt.id.clone(), true, Some(true)).unwrap();
        assert!(!Path::new(&wt.path).exists());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn worktree_lifecycle() {
        let repo = fixture_repo();
        let root = repo.to_string_lossy().to_string();

        let wt = worktree_create(root.clone(), None, Some("test-one".into())).unwrap();
        assert!(Path::new(&wt.path).exists());
        assert_eq!(wt.branch, "guimux/test-one");

        let list = worktree_list(root.clone()).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|w| w.branch == "guimux/test-one"));
        assert!(list.iter().all(|w| w.last_commit.is_some()));

        // commit in worktree, then merge
        fs::write(Path::new(&wt.path).join("b.txt"), "from wt").unwrap();
        Command::new("git").args(["add", "."]).current_dir(&wt.path).output().unwrap();
        Command::new("git").args(["commit", "-m", "wt change"]).current_dir(&wt.path).output().unwrap();

        let msg = worktree_merge(wt.id.clone()).unwrap();
        assert!(msg.contains("Merge") || !msg.is_empty());

        worktree_remove(root.clone(), wt.id.clone(), true, Some(false)).unwrap();
        assert!(!Path::new(&wt.path).exists());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn stale_outside_returns_structured_error_and_keeps_folder() {
        let repo = fixture_repo();
        let root = repo.to_string_lossy().to_string();
        let outside = std::env::temp_dir().join(format!(
            "guimux-outside-{}-{}",
            std::process::id(),
            ID_CTR.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        let id = outside.to_string_lossy().to_string();
        let err = worktree_remove(root.clone(), id, false, None).unwrap_err();
        assert!(err.contains("GUIMUX_STALE_OUTSIDE"), "unexpected error: {err}");
        assert!(err.contains("path="), "error must carry canonical path: {err}");
        assert!(outside.exists());
        let _ = fs::remove_dir_all(&outside);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn worktree_merge_rejects_untracked_main_changes() {
        let repo = fixture_repo();
        let root = repo.to_string_lossy().to_string();
        let wt = worktree_create(root.clone(), None, Some("untracked-main".into())).unwrap();
        fs::write(repo.join("scratch.txt"), "untracked").unwrap();

        let err = worktree_merge(wt.id.clone()).unwrap_err();
        assert!(err.contains("uncommitted changes"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn removal_fails_closed_when_git_lookup_fails() {
        let dir = std::env::temp_dir().join(format!("guimux-no-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let worktree = dir.join("worktree");
        fs::create_dir_all(&worktree).unwrap();
        assert!(registered_paths(&dir).is_err());
        let error = worktree_remove(
            dir.to_string_lossy().to_string(),
            worktree.to_string_lossy().to_string(),
            false,
            Some(false),
        )
        .unwrap_err();
        assert!(error.contains("cannot inspect git worktrees"), "unexpected error: {error}");
        assert!(worktree.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dir_prunes_to_ok() {
        let repo = fixture_repo();
        let root = repo.to_string_lossy().to_string();
        let gone = repo.join("gone-wt");
        assert!(!gone.exists());
        worktree_remove(root.clone(), gone.to_string_lossy().to_string(), false, None).unwrap();
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn prune_and_repair_run() {
        let repo = fixture_repo();
        let root = repo.to_string_lossy().to_string();
        worktree_prune(root.clone()).unwrap();
        let _ = worktree_repair(root.clone(), None);
        let _ = fs::remove_dir_all(&repo);
    }
}
