use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatus {
    pub path: String,
    pub index_status: String,
    pub workdir_status: String,
}

const DIFF_CAP: usize = 1_000_000; // 1MB per file

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

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    // Every dynamic ref/path arg must be preceded by `"--"` at the call
    // site; static flag lists here are safe by construction.
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

#[command]
pub fn project_detect(path: String) -> Result<ProjectInfo, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    // Single spawn: toplevel + branch in one `rev-parse`. Two spawns per
    // project doubled startup latency and flashed two console windows each.
    // `--show-toplevel` succeeds anywhere inside a worktree; a `HEAD`
    // abbrev-ref means detached (no current branch).
    let out = git_cmd()
        .args(["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"])
        .current_dir(&p)
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout).into_owned();
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
        }
        _ => Ok(ProjectInfo {
            name: dir_name_of(&p),
            path,
            is_git: false,
            git_root: None,
            branch: None,
        }),
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
    let out = git_cmd()
        .args(["init", "-b", &initial])
        .current_dir(&p)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git init failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(p.to_string_lossy().to_string())
}

#[command]
pub fn git_status(path: String) -> Result<Vec<FileStatus>, String> {
    let repo = PathBuf::from(&path);
    let out = git(&repo, &["status", "--porcelain", "-z"])?;
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
pub fn git_diff(path: String, base: Option<String>) -> Result<String, String> {
    let repo = PathBuf::from(&path);
    let mut args: Vec<String> = vec![
        "-c".into(),
        "core.quotepath=false".into(),
        "diff".into(),
        "--no-color".into(),
        "--".into(),
    ];
    if let Some(b) = &base {
        reject_git_ref(b, "base")?;
        args.push(b.clone());
    }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let diff = git(&repo, &args_ref)?;
    if diff.len() > DIFF_CAP {
        let mut cut = diff;
        cut.truncate(DIFF_CAP);
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

        let diff = git_diff(dir.to_string_lossy().to_string(), None).unwrap();
        assert!(diff.contains("-hello"));
        assert!(diff.contains("+changed"));
        let _ = fs::remove_dir_all(&dir);
    }
}
