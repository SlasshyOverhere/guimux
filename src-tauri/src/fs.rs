use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::command;

const MAX_FILE: u64 = 1_000_000; // skip files >1MB
const MAX_WRITE: usize = 5_000_000; // fs_write cap: stops disk-fill, allows growth past read cap
const MAX_CHILDREN: usize = 2000; // per-dir cap (H-002: 100k-file dirs froze the UI)
const MAX_NODES: usize = 20_000; // whole-tree cap
const IGNORED: &[&str] = &[".git", "node_modules", "target", "dist", ".next", "__pycache__"];
/// Windows reserved names (also `NUL.txt`): open/read would block the IPC thread.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9",
];
static WRITE_CTR: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<Node>>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Rejects paths that would block or escape: NUL/COM1-style device names,
/// `\\.\` device prefixes, and UNC paths.
fn reject_special_path(p: &Path, what: &str) -> Result<(), String> {
    let s = p.to_string_lossy();
    if s.starts_with("\\\\.\\") || s.starts_with("\\\\?\\") || s.starts_with("\\\\") || s.starts_with("//") {
        return Err(format!("invalid {what}: device/UNC paths are not allowed"));
    }
    for c in p.components() {
        if let Component::Normal(os) = c {
            let mut name = os.to_string_lossy().to_uppercase();
            if let Some(dot) = name.find('.') {
                name.truncate(dot);
            }
            if RESERVED.contains(&name.as_str()) {
                return Err(format!("invalid {what}: reserved device name"));
            }
        }
    }
    Ok(())
}

fn build_tree(path: &Path, depth: u32, max_depth: u32, budget: &mut usize) -> Option<Node> {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let leaf = |truncated: bool| {
        Some(Node {
            name: name.clone(),
            path: path.to_string_lossy().to_string(),
            is_dir: path.is_dir(),
            children: if path.is_dir() { Some(vec![]) } else { None },
            truncated,
        })
    };
    if !path.is_dir() {
        return Some(Node {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            children: None,
            truncated: false,
        });
    }
    if depth >= max_depth {
        return leaf(false);
    }
    if *budget == 0 {
        return leaf(true);
    }
    let mut children = vec![];
    let entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return None,
    };
    // Skip (don't squash) unreadable entries: flatten() hid permission errors.
    let mut collected = vec![];
    for e in entries {
        match e {
            Ok(e) => collected.push(e),
            Err(_) => continue,
        }
    }
    collected.sort_by_key(|e| e.file_name());
    let mut truncated = false;
    for entry in collected.into_iter().take(MAX_CHILDREN + 1) {
        if children.len() >= MAX_CHILDREN {
            truncated = true;
            break;
        }
        let fname = entry.file_name().to_string_lossy().to_string();
        if IGNORED.contains(&fname.as_str()) || fname.starts_with('.') && fname != ".github" {
            continue;
        }
        if *budget == 0 {
            truncated = true;
            break;
        }
        *budget -= 1;
        // Symlinks: list the link itself, never recurse (cycle/escape risk).
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            children.push(Node {
                name: fname,
                path: entry.path().to_string_lossy().to_string(),
                is_dir: false,
                children: None,
                truncated: false,
            });
            continue;
        }
        if let Some(node) = build_tree(&entry.path(), depth + 1, max_depth, budget) {
            children.push(node);
        }
    }
    Some(Node {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: true,
        children: Some(children),
        truncated,
    })
}

#[command]
pub fn fs_tree(path: String, depth: u32) -> Result<Option<Node>, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut budget = MAX_NODES;
    Ok(build_tree(&p, 0, depth.clamp(1, 6), &mut budget))
}

#[command]
pub fn fs_rename(old: String, new: String) -> Result<(), String> {
    let from = PathBuf::from(&old);
    let to = PathBuf::from(&new);
    if !from.exists() {
        return Err(format!("not found: {old}"));
    }
    if from.parent() != to.parent() {
        return Err("can only rename within the same folder".into());
    }
    match to.file_name().and_then(|s| s.to_str()) {
        Some(n) if !n.is_empty() && !n.contains(['/', '\\']) => {}
        _ => return Err("invalid file name".into()),
    }
    if to.exists() {
        return Err("a file with that name already exists".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[command]
pub fn fs_read(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    reject_special_path(&p, "path")?;
    // Read with a hard cap instead of check-then-read (TOCTOU: the file can
    // grow between metadata and read). take() stops at the cap; a full
    // buffer means oversize.
    let f = fs::File::open(&p).map_err(|e| e.to_string())?;
    if f.metadata().map(|m| m.is_dir()).unwrap_or(false) {
        return Err("cannot read a directory".into());
    }
    let mut buf = Vec::new();
    f.take(MAX_FILE + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_FILE {
        return Err("file too large (> 1MB)".to_string());
    }
    String::from_utf8(buf).map_err(|e| format!("not valid utf-8 or unreadable: {e}"))
}

#[command]
pub fn fs_write(path: String, content: String) -> Result<(), String> {
    if content.len() > MAX_WRITE {
        return Err(format!("content too large ({} bytes > 5MB)", content.len()));
    }
    let p = PathBuf::from(&path);
    reject_special_path(&p, "path")?;
    // Atomic temp+rename: a crash mid-write no longer leaves a truncated
    // file, and autosaves can't interleave. No more auto-mkdir (H-001:
    // writing `C:\startup\x` created the whole chain) — parent must exist.
    let parent = p.parent().ok_or("invalid path")?;
    if !parent.is_dir() {
        return Err(format!("parent directory does not exist: {}", parent.to_string_lossy()));
    }
    let n = WRITE_CTR.fetch_add(1, Ordering::SeqCst);
    let tmp = parent.join(format!(".guimux-tmp-{}-{}", std::process::id(), n));
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, &p) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_names_rejected() {
        assert!(reject_special_path(Path::new("C:/x/NUL"), "path").is_err());
        assert!(reject_special_path(Path::new("C:/x/COM1.txt"), "path").is_err());
        assert!(reject_special_path(Path::new("\\\\.\\C:"), "path").is_err());
        assert!(reject_special_path(Path::new("C:/ok/file.txt"), "path").is_ok());
    }

    #[test]
    fn read_caps_without_toctou() {
        let dir = std::env::temp_dir().join(format!("guimux-fs-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.bin");
        fs::write(&big, vec![b'x'; MAX_FILE as usize + 10]).unwrap();
        assert!(fs_read(big.to_string_lossy().to_string()).is_err());
        let small = dir.join("small.txt");
        fs::write(&small, "hi").unwrap();
        assert_eq!(fs_read(small.to_string_lossy().to_string()).unwrap(), "hi");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tree_caps_children() {
        let dir = std::env::temp_dir().join(format!("guimux-tree-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..(MAX_CHILDREN + 50) {
            fs::write(dir.join(format!("f{i:05}.txt")), "x").unwrap();
        }
        let mut budget = MAX_NODES;
        let node = build_tree(&dir, 0, 6, &mut budget).unwrap();
        let kids = node.children.unwrap();
        assert_eq!(kids.len(), MAX_CHILDREN);
        assert!(node.truncated);
        let _ = fs::remove_dir_all(&dir);
    }
}
