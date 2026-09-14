use crate::git::git_cmd;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    pub id: String,
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    pub last_commit: Option<i64>,
}

fn last_commit_ts(path: &Path) -> Option<i64> {
    let out = git_cmd()
        .args(["log", "-1", "--format=%ct"])
        .current_dir(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

fn rand_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let rand: u16 = rand_id_suffix();
    format!("{ts:x}-{:04x}", rand & 0xffff)
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
    let out = git_cmd()
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|_| "[git] failed to spawn".to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

fn current_branch(path: &Path) -> Result<String, String> {
    let out = git_cmd()
        .args(["branch", "--show-current"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[command]
pub fn worktree_list(repo_root: String) -> Result<Vec<Worktree>, String> {
    let root = PathBuf::from(&repo_root);
    if !root.exists() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let out = git_cmd()
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("failed to run git (is it on PATH?): {e}"))?;
    if !out.status.success() {
        // Never swallow stderr here: the old Ok(vec![]) made the UI sit on
        // "Starting terminal…" forever (e.g. git's "dubious ownership" refusal).
        return Err(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
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
    let out = match git_cmd().args(&args).current_dir(repo).output() {
        Ok(o) if o.status.success() => o,
        _ => return map,
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
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
    // ponytail: project slug is the bare folder name; same-named repos in
    // different locations share one folder — upgrade path is hash(repo_root).
    let project: String = sanitize(
        &root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".into()),
    );
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

#[command]
pub fn worktree_remove(
    repo_root: String,
    id: String,
    delete_branch: bool,
) -> Result<(), String> {
    let path = PathBuf::from(&id);
    // Run git from the MAIN worktree (a linked worktree reports itself as
    // toplevel, and removing a worktree from inside itself fails on Windows).
    // Resolve via repo_root: the worktree dir itself may be half-removed and
    // unusable as a cwd.
    let anchor = PathBuf::from(&repo_root);
    let root = find_main_worktree(&anchor).unwrap_or(anchor);
    if !path.exists() {
        // Dir already gone (e.g. a previous forced remove half-finished):
        // prune the stale entry so `git worktree list` stops showing it.
        let _ = run_git(&root, &["worktree", "prune"]);
        return Ok(());
    }
    // capture branch before removal
    let branch = current_branch(&path).ok();
    // Windows: AV/indexers can briefly lock freshly-written files; retry a few times.
    // A stale entry ("is not a working tree") is NOT transient: fall through to
    // the manual cleanup below instead of retrying.
    let mut last_err = String::new();
    for attempt in 0..5 {
        match run_git(&root, &["worktree", "remove", "--force", id.as_str()]) {
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
        // Git already forgot this path (stale lock/metadata, half-removed dir):
        // delete the folder ourselves, prune, and drop the branch.
        if let Err(e) = std::fs::remove_dir_all(&path) {
            return Err(format!(
                "worktree is not registered with git and folder cleanup failed (close terminals using it and retry): {e}"
            ));
        }
        let _ = run_git(&root, &["worktree", "prune"]);
        if delete_branch {
            if let Some(b) = branch {
                let _ = run_git(&root, &["branch", "-D", &b]);
            }
        }
        return Ok(());
    }
    if !last_err.is_empty() {
        return Err(last_err);
    }
    if delete_branch {
        if let Some(b) = branch {
            let _ = run_git(&root, &["branch", "-D", &b]);
        }
        return Ok(());
    }
    Ok(())
}

#[command]
pub fn worktree_merge(id: String) -> Result<String, String> {
    // Merge the worktree's branch into its base branch, in the MAIN worktree.
    let path = PathBuf::from(&id);
    let main_wt = find_main_worktree(&path).ok_or("could not find main worktree")?;
    let branch = current_branch(&path)?;
    let base = find_base_branch(&main_wt, &branch)?;
    // Ensure main worktree is on the base branch
    let cur = current_branch(&main_wt).unwrap_or_default();
    if cur != base {
        run_git(&main_wt, &["checkout", &base])?;
    }
    run_git(&main_wt, &["merge", "--no-ff", "--no-edit", &branch])
}

fn find_main_worktree(path: &Path) -> Option<PathBuf> {
    // git worktree list from any worktree; first entry is main
    let out = git_cmd()
        .args(["worktree", "list", "--porcelain"])
        .current_dir(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find_map(|l| l.strip_prefix("worktree "))
        .map(PathBuf::from)
}

fn find_base_branch(main_wt: &Path, branch: &str) -> Result<String, String> {
    // Heuristic: merge-base with main/master; fallback to current HEAD of main worktree.
    for cand in ["main", "master"] {
        let ok = git_cmd()
            .args(["merge-base", "--is-ancestor", branch, cand])
            .current_dir(main_wt)
            .output();
        if let Ok(o) = ok {
            if o.status.success() {
                return Ok(cand.to_string());
            }
        }
    }
    let cur_branch = current_branch(main_wt).unwrap_or_default();
    if cur_branch.is_empty() {
        return Err("no base branch found".into());
    }
    Ok(cur_branch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn fixture_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("guimux-test-{}", std::process::id()));
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

        worktree_remove(root.clone(), wt.id.clone(), true).unwrap();
        assert!(!Path::new(&wt.path).exists());
        let _ = fs::remove_dir_all(&repo);
    }
}
