use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use notify::Watcher as _NotifyWatcher;
use tauri::{command, AppHandle, Emitter};
#[cfg(windows)]
use winapi::um::sysinfoapi::GetSystemDirectoryW;

const MAX_FILE: u64 = 1_000_000; // skip files >1MB
const MAX_WRITE: usize = 5_000_000; // fs_write cap: stops disk-fill, allows growth past read cap
const MAX_CHILDREN: usize = 2000; // per-dir cap (H-002: 100k-file dirs froze the UI)
const MAX_NODES: usize = 20_000; // whole-tree cap
const MAX_GREP_FILES: usize = 20_000; // scanned files per search
const MAX_GREP_HITS: usize = 200; // hits per search
const MAX_GREP_DIRS: usize = 20_000; // directories visited per search
const MAX_GREP_ENTRIES: usize = 200_000; // directory entries examined per search
const MAX_WATCH_DIRS: usize = 10_000; // directories watched per root
const MAX_WATCH_ENTRIES: usize = 200_000; // directory entries examined per root
const IGNORED: &[&str] = &[".git", "node_modules", "target", "dist", ".next", "__pycache__"];
/// Windows reserved names (also `NUL.txt`): open/read would block the IPC thread.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9",
];
static WRITE_CTR: AtomicU64 = AtomicU64::new(0);
static WRITE_LOCK: Mutex<()> = Mutex::new(());

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

fn is_link_like(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    false
}

fn reject_link_components(path: &Path, what: &str) -> Result<(), String> {
    let mut current = path;
    loop {
        if let Ok(metadata) = fs::symlink_metadata(current) {
            if is_link_like(&metadata) {
                return Err(format!("invalid {what}: symlink or junction paths are not allowed"));
            }
        }
        let Some(parent) = current.parent() else { break };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(())
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
            #[cfg(windows)]
            while name.ends_with(' ') || name.ends_with('.') {
                name.pop();
            }
            #[cfg(windows)]
            if name.is_empty() {
                return Err(format!("invalid {what}: reserved device name"));
            }
            #[cfg(windows)]
            if name.contains(':') {
                return Err(format!("invalid {what}: alternate data streams are not allowed"));
            }
            if let Some(dot) = name.find('.') {
                name.truncate(dot);
            }
            if RESERVED.contains(&name.as_str()) {
                return Err(format!("invalid {what}: reserved device name"));
            }
        }
    }
    reject_link_components(p, what)?;
    Ok(())
}

fn build_tree(path: &Path, depth: u32, max_depth: u32, budget: &mut usize) -> Option<Node> {
    let metadata = fs::symlink_metadata(path).ok()?;
    let is_dir = metadata.is_dir() && !is_link_like(&metadata);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let leaf = |truncated: bool| {
        Some(Node {
            name: name.clone(),
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: if is_dir { Some(vec![]) } else { None },
            truncated,
        })
    };
    if !is_dir {
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
    // Apply the cap while reading; collecting the whole directory first let a
    // huge folder bypass the memory bound before the cap was enforced.
    let mut collected: Vec<(fs::DirEntry, String)> = Vec::with_capacity(MAX_CHILDREN + 1);
    let mut entry_overflow = false;
    for e in entries {
        let Ok(entry) = e else { continue };
        let fname = entry.file_name().to_string_lossy().to_string();
        if IGNORED.contains(&fname.as_str()) || fname.starts_with('.') && fname != ".github" {
            continue;
        }
        if collected.len() > MAX_CHILDREN {
            entry_overflow = true;
            break;
        }
        collected.push((entry, fname));
    }
    collected.sort_by_key(|entry| entry.0.file_name());
    let mut truncated = entry_overflow;
    for (entry, fname) in collected.into_iter().take(MAX_CHILDREN) {
        if children.len() >= MAX_CHILDREN {
            truncated = true;
            break;
        }
        if *budget == 0 {
            truncated = true;
            break;
        }
        *budget -= 1;
        // Links: list the link itself, never recurse (cycle/escape risk).
        let entry_path = entry.path();
        if fs::symlink_metadata(&entry_path)
            .map(|metadata| is_link_like(&metadata))
            .unwrap_or(false)
        {
            children.push(Node {
                name: fname,
                path: entry_path.to_string_lossy().to_string(),
                is_dir: false,
                children: None,
                truncated: false,
            });
            continue;
        }
        if let Some(node) = build_tree(&entry_path, depth + 1, max_depth, budget) {
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
    reject_special_path(&p, "path")?;
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut budget = MAX_NODES;
    Ok(build_tree(&p, 0, depth.clamp(1, 6), &mut budget))
}

/// Directory identity for a rename. Windows paths are case-insensitive and
/// accept both separators, so a raw Path compare rejected `c:/a` vs `C:\a`.
fn same_dir(a: Option<&Path>, b: Option<&Path>) -> bool {
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
        ),
        _ => return false,
    };
    if cfg!(windows) {
        a.replace('/', "\\")
            .eq_ignore_ascii_case(&b.replace('/', "\\"))
    } else {
        a == b
    }
}

#[command]
pub fn fs_rename(old: String, new: String) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let from = PathBuf::from(&old);
    let to = PathBuf::from(&new);
    reject_special_path(&from, "rename source")?;
    if !from.exists() {
        return Err(format!("not found: {old}"));
    }
    if !same_dir(from.parent(), to.parent()) {
        return Err("can only rename within the same folder".into());
    }
    // Same reserved-name/device-path guard as fs_read/fs_write: renaming a
    // file to `NUL`, `COM1.txt`, etc. bricks it (undeletable via Explorer).
    reject_special_path(&to, "rename target")?;
    match to.file_name().and_then(|s| s.to_str()) {
        Some(n) if !n.is_empty() && !n.contains(['/', '\\']) => {}
        _ => return Err("invalid file name".into()),
    }
    if to.exists() {
        return Err("a file with that name already exists".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn system_explorer() -> Result<PathBuf, String> {
    let mut buffer = [0u16; 260];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return Err("cannot resolve the Windows system directory".into());
    }
    let directory = PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
    Ok(directory.join("explorer.exe"))
}

#[command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    reject_special_path(&p, "path")?;
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    // No shell: argv only, so paths can't inject flags/commands.
    // Explorer needs backslashes: worktree ids use `/` (norm_sep) and
    // Explorer silently falls back to Documents on forward slashes.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new(system_explorer()?);
        c.arg(p.to_string_lossy().replace('/', "\\"));
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = { let mut c = std::process::Command::new("open"); c.arg(&p); c };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = { let mut c = std::process::Command::new("xdg-open"); c.arg(&p); c };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[command]
pub fn fs_read(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    reject_special_path(&p, "path")?;
    // Read with a hard cap instead of check-then-read (TOCTOU: the file can
    // grow between metadata and read). take() stops at the cap; a full
    // buffer means oversize.
    match fs::metadata(&p) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("cannot read a non-regular file".into()),
        Err(e) => return Err(e.to_string()),
    }
    let f = fs::File::open(&p).map_err(|e| e.to_string())?;
    match f.metadata() {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("cannot read a non-regular file".into()),
        Err(e) => return Err(e.to_string()),
    }
    let mut buf = Vec::new();
    f.take(MAX_FILE + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_FILE {
        return Err("file too large (> 1MB)".to_string());
    }
    String::from_utf8(buf).map_err(|e| format!("not valid utf-8 or unreadable: {e}"))
}

fn file_matches(path: &Path, expected: &str) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() != expected.len() as u64 {
        return false;
    }
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut current = Vec::with_capacity(expected.len());
    file.take(MAX_FILE + 1)
        .read_to_end(&mut current)
        .is_ok()
        && current == expected.as_bytes()
}

fn write_text(path: &str, content: &str, expected: Option<&str>) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if content.len() > MAX_WRITE {
        return Err(format!("content too large ({} bytes > 5MB)", content.len()));
    }
    let p = PathBuf::from(path);
    reject_special_path(&p, "path")?;
    // Atomic temp+rename: a crash mid-write no longer leaves a truncated
    // file, and autosaves can't interleave. No more auto-mkdir (H-001:
    // writing `C:\startup\x` created the whole chain) — parent must exist.
    let parent = p.parent().ok_or("invalid path")?;
    if !parent.is_dir() {
        return Err(format!("parent directory does not exist: {}", parent.to_string_lossy()));
    }
    let target_meta = match fs::symlink_metadata(&p) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err("cannot write through a symlink".into());
            }
            if meta.is_dir() {
                return Err("cannot write a directory".into());
            }
            Some(meta.permissions())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let n = WRITE_CTR.fetch_add(1, Ordering::SeqCst);
    let tmp = parent.join(format!(".guimux-tmp-{}-{}", std::process::id(), n));
    let mut temp = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    if let Err(e) = temp.write_all(content.as_bytes()) {
        drop(temp);
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Some(permissions) = target_meta {
        if let Err(e) = fs::set_permissions(&tmp, permissions) {
            drop(temp);
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }
    if let Some(expected) = expected {
        if !file_matches(&p, expected) {
            let _ = fs::remove_file(&tmp);
            return Err("file changed on disk".into());
        }
    }
    // AV scanners and indexers briefly lock a freshly written file on Windows:
    // retry the swap instead of failing the save outright.
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..4 {
        match fs::rename(&tmp, &p) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(40 * (attempt + 1)));
            }
        }
    }
    // Never leave the temp file behind: it shows up as untracked in the
    // user's project.
    let _ = fs::remove_file(&tmp);
    Err(last_err
        .map(|e| e.to_string())
        .unwrap_or_else(|| "rename failed".into()))
}

#[command]
pub fn fs_write(path: String, content: String) -> Result<(), String> {
    write_text(&path, &content, None)
}

#[command]
pub fn fs_create_empty(path: String) -> Result<bool, String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let p = PathBuf::from(&path);
    reject_special_path(&p, "path")?;
    let parent = p.parent().ok_or("invalid path")?;
    if !parent.is_dir() {
        return Err(format!("parent directory does not exist: {}", parent.to_string_lossy()));
    }
    match OpenOptions::new().write(true).create_new(true).open(&p) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[command]
pub fn fs_write_checked(path: String, content: String, expected: String) -> Result<(), String> {
    if expected.len() as u64 > MAX_FILE {
        return Err("expected file content is too large".into());
    }
    write_text(&path, &content, Some(&expected))
}

/// Paste drop for clipboard images: base64 bytes -> `<dir>/.guimux-pastes/`.
/// Narrow by design: the parent dir must be `.guimux-pastes` and the file
/// name `paste-*<ext>` with an image extension, so this can never become a
/// general binary writer. Returns the final path (numeric suffix on clash).
const MAX_PASTE_BYTES: usize = 10_000_000;

fn base64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a' + 26) as u32),
        b'0'..=b'9' => Some((c - b'0' + 52) as u32),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !bytes.len().is_multiple_of(4) {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for c in bytes.chunks(4) {
        let mut n: u32 = 0;
        let mut pad = 0;
        for (i, &b) in c.iter().enumerate() {
            if b == b'=' {
                pad += 1;
                n <<= 6;
            } else {
                if pad > 0 {
                    return Err("invalid base64 padding".into());
                }
                n = (n << 6) | base64_val(b).ok_or("invalid base64 character")?;
            }
            let _ = i;
        }
        if pad > 2 {
            return Err("invalid base64 padding".into());
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

fn valid_paste_name(name: &str) -> bool {
    let Some(stem) = name.strip_prefix("paste-") else {
        return false;
    };
    let Some(dot) = stem.rfind('.') else {
        return false;
    };
    let (id, ext) = stem.split_at(dot);
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return false;
    }
    matches!(ext.to_ascii_lowercase().as_str(), ".png" | ".jpg" | ".jpeg" | ".webp" | ".gif" | ".bmp")
}

#[command]
pub fn fs_write_bytes(path: String, base64: String) -> Result<String, String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if base64.len() > MAX_PASTE_BYTES / 3 * 4 + 4 {
        return Err("pasted image too large".into());
    }
    let p = PathBuf::from(&path);
    if p.parent().and_then(|d| d.file_name()).map(|n| n != ".guimux-pastes").unwrap_or(true) {
        return Err("fs_write_bytes only writes into .guimux-pastes".into());
    }
    let name = p.file_name().and_then(|s| s.to_str()).ok_or("invalid file name")?;
    if !valid_paste_name(name) {
        return Err("invalid paste file name".into());
    }
    let bytes = base64_decode(&base64)?;
    if bytes.len() > MAX_PASTE_BYTES {
        return Err("pasted image too large (> 10MB)".into());
    }
    // Our own managed drop dir: create it, unlike fs_write's no-mkdir rule.
    let parent = p.parent().ok_or("invalid path")?;
    reject_special_path(parent, "paste drop directory")?;
    if let Ok(meta) = std::fs::symlink_metadata(parent) {
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("invalid paste drop directory".into());
        }
    } else {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let meta = std::fs::symlink_metadata(parent).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("invalid paste drop directory".into());
        }
    }
    // Suffix on clash instead of truncating another paste. create_new also
    // rejects a dangling or malicious symlink at the chosen target.
    let mut target = p.clone();
    for i in 1..100 {
        let stem = name.rsplit_once('.').map(|s| s.0).unwrap_or(name);
        let ext = name.rsplit_once('.').map(|s| s.1).unwrap_or("png");
        if i > 1 {
            target = parent.join(format!("{stem}-{}.{ext}", i - 1));
        }
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(&bytes) {
                    drop(file);
                    let _ = std::fs::remove_file(&target);
                    return Err(e.to_string());
                }
                return Ok(target.to_string_lossy().to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("could not pick a free paste file name".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrepHit {
    pub path: String,
    pub lineno: u32,
    pub text: String,
}

fn grep_visible(name: &str) -> bool {
    // Same ignore rules as the tree: build output, dotfiles (minus .github)
    // and device names never match.
    if IGNORED.contains(&name) {
        return false;
    }
    if name.starts_with('.') && name != ".github" {
        return false;
    }
    true
}

#[command]
pub fn grep_search(
    path: String,
    query: String,
    case_sensitive: Option<bool>,
    limit: Option<u32>,
) -> Result<Vec<GrepHit>, String> {
    grep_search_with_limits(path, query, case_sensitive, limit, MAX_GREP_DIRS, MAX_GREP_ENTRIES)
}

fn grep_search_with_limits(
    path: String,
    query: String,
    case_sensitive: Option<bool>,
    limit: Option<u32>,
    max_dirs: usize,
    max_entries: usize,
) -> Result<Vec<GrepHit>, String> {
    let root = PathBuf::from(&path);
    reject_special_path(&root, "path")?;
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let q = query.trim();
    if q.is_empty() || q.len() > 200 {
        return Err("query must be 1-200 chars".into());
    }
    let case_sensitive = case_sensitive.unwrap_or(false);
    let needle = if case_sensitive { q.to_string() } else { q.to_lowercase() };
    let cap = limit.unwrap_or(100).clamp(1, MAX_GREP_HITS as u32) as usize;
    let mut hits = vec![];
    let mut scanned = 0usize;
    let mut visited_dirs = 0usize;
    let mut examined_entries = 0usize;
    let mut stack = vec![root];
    // Iterative walk: same skip rules as fs_tree, regular files only
    // (symlinks listed, never followed). Stops at the hit cap or the scan
    // budget, whichever comes first — a node_modules-heavy root otherwise
    // blocks the IPC thread for seconds.
    'walk: while let Some(dir) = stack.pop() {
        let Ok(metadata) = fs::symlink_metadata(&dir) else { continue };
        if is_link_like(&metadata) || !metadata.is_dir() {
            continue;
        }
        if visited_dirs >= max_dirs {
            break;
        }
        visited_dirs += 1;
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            if hits.len() >= cap || scanned >= MAX_GREP_FILES || examined_entries >= max_entries {
                break 'walk;
            }
            examined_entries += 1;
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if !grep_visible(&name) {
                continue;
            }
            let fpath = entry.path();
            if fs::symlink_metadata(&fpath)
                .map(|metadata| is_link_like(&metadata))
                .unwrap_or(false)
            {
                continue;
            }
            let Ok(ftype) = entry.file_type() else { continue };
            if ftype.is_dir() {
                stack.push(fpath);
                continue;
            }
            if !ftype.is_file() {
                continue;
            }
            scanned += 1;
            let mut file = match fs::File::open(&fpath) {
                Ok(file) => file,
                Err(_) => continue,
            };
            let mut bytes = Vec::new();
            if Read::by_ref(&mut file)
                .take(MAX_FILE + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 > MAX_FILE
            {
                continue;
            }
            // Binary probe: a NUL in the head means not text.
            if bytes.iter().take(8192).any(|&b| b == 0) {
                continue;
            }
            let text = match String::from_utf8(bytes) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let pstr = fpath.to_string_lossy().to_string();
            if case_sensitive {
                for (i, line) in text.lines().enumerate() {
                    if hits.len() >= cap {
                        break;
                    }
                    if line.contains(&needle) {
                        hits.push(GrepHit {
                            path: pstr.clone(),
                            lineno: (i + 1) as u32,
                            text: line.trim().chars().take(200).collect::<String>(),
                        });
                    }
                }
            } else {
                let low = text.to_lowercase();
                for ((i, line), (_, lline)) in text.lines().enumerate().zip(low.lines().enumerate()) {
                    if hits.len() >= cap {
                        break;
                    }
                    if lline.contains(&needle) {
                        hits.push(GrepHit {
                            path: pstr.clone(),
                            lineno: (i + 1) as u32,
                            text: line.trim().chars().take(200).collect::<String>(),
                        });
                    }
                }
            }
        }
    }
    Ok(hits)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsChanged {
    pub root: String,
}

// One safe watcher per root at most. Roots stay registered for the app
// lifetime (cap 16, oldest evicted): worktree switches re-subscribe faster
// than teardown + re-arm, and an idle watcher costs one thread.
static WATCHERS: std::sync::LazyLock<Mutex<WatchedRoots>> =
    std::sync::LazyLock::new(|| Mutex::new(WatchedRoots::default()));

#[derive(Default)]
struct WatchedRoots {
    order: Vec<String>,
    live: std::collections::HashMap<String, mpsc::Sender<()>>,
}

static COALESCE_TX: std::sync::LazyLock<Mutex<Option<mpsc::Sender<String>>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

fn coalesce_tx(app: &AppHandle) -> mpsc::Sender<String> {
    let mut slot = COALESCE_TX.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = slot.clone() {
        return tx;
    }
    let (tx, rx) = mpsc::channel::<String>();
    let app = app.clone();
    // One thread for all roots: trailing-edge 600ms coalescing per root, so
    // a `git checkout` (hundreds of writes) delivers one `fs-changed`.
    std::thread::spawn(move || {
        let mut pending: std::collections::HashMap<String, std::time::Instant> =
            std::collections::HashMap::new();
        let quiet = std::time::Duration::from_millis(600);
        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(150)) {
                Ok(root) => {
                    pending.insert(root, std::time::Instant::now() + quiet);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let now = std::time::Instant::now();
            let due: Vec<String> = pending
                .iter()
                .filter(|(_, at)| **at <= now)
                .map(|(r, _)| r.clone())
                .collect();
            for root in due {
                pending.remove(&root);
                let _ = app.emit("fs-changed", FsChanged { root });
            }
        }
    });
    *slot = Some(tx.clone());
    tx
}

fn collect_watch_dirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![root.to_path_buf()];
    let mut entries_seen = 0usize;
    while let Some(dir) = stack.pop() {
        if !seen.insert(dir.clone()) {
            continue;
        }
        if dirs.len() >= MAX_WATCH_DIRS {
            return Err("watch directory limit exceeded".into());
        }
        dirs.push(dir.clone());
        let entries = fs::read_dir(&dir)
            .map_err(|e| format!("cannot inspect watch directory {}: {e}", dir.to_string_lossy()))?;
        for entry in entries {
            if entries_seen >= MAX_WATCH_ENTRIES {
                return Err("watch entry limit exceeded".into());
            }
            entries_seen += 1;
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            if !grep_visible(&name) {
                continue;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else { continue };
            if !is_link_like(&metadata) && metadata.is_dir() {
                stack.push(path);
            }
        }
    }
    Ok(dirs)
}

fn add_watch_tree(
    watcher: &mut notify::RecommendedWatcher,
    watched: &mut HashSet<PathBuf>,
    root: &Path,
    start: &Path,
    budget: &mut usize,
) {
    if !start.starts_with(root) || reject_link_components(start, "watch path").is_err() {
        return;
    }
    let mut stack = vec![start.to_path_buf()];
    let mut entries_seen = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(metadata) = fs::symlink_metadata(&dir) else { continue };
        if is_link_like(&metadata) || !metadata.is_dir() {
            continue;
        }
        if !watched.insert(dir.clone()) {
            continue;
        }
        if *budget == 0 {
            watched.remove(&dir);
            break;
        }
        *budget -= 1;
        if watcher
            .watch(&dir, notify::RecursiveMode::NonRecursive)
            .is_err()
        {
            watched.remove(&dir);
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries {
            if entries_seen >= MAX_WATCH_ENTRIES {
                break;
            }
            entries_seen += 1;
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            if !grep_visible(&name) {
                continue;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else { continue };
            if !is_link_like(&metadata) && metadata.is_dir() {
                stack.push(path);
            }
        }
    }
}

fn spawn_watch_manager(
    app: &AppHandle,
    root: String,
    watch_root: PathBuf,
    dirs: Vec<PathBuf>,
) -> Result<mpsc::Sender<()>, String> {
    let (event_tx, event_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = mpsc::channel();
    let fire = root.clone();
    let notify_tx = coalesce_tx(app);
    let mut watcher = notify::RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            let _ = event_tx.send(result);
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    let mut watched = HashSet::new();
    for dir in dirs {
        watcher
            .watch(&dir, notify::RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        watched.insert(dir);
    }
    let mut budget = MAX_WATCH_DIRS.saturating_sub(watched.len());
    std::thread::spawn(move || {
        loop {
            match stop_rx.try_recv() {
                Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
                Err(mpsc::TryRecvError::Empty) => {}
            }
            match event_rx.recv_timeout(std::time::Duration::from_millis(150)) {
                Ok(Ok(event)) => {
                    for path in event.paths {
                        if !path.starts_with(&watch_root) {
                            continue;
                        }
                        if path.is_dir() {
                            add_watch_tree(
                                &mut watcher,
                                &mut watched,
                                &watch_root,
                                &path,
                                &mut budget,
                            );
                        } else {
                            watched.retain(|known| known != &path && !known.starts_with(&path));
                        }
                    }
                    let _ = notify_tx.send(fire.clone());
                }
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    });
    Ok(stop_tx)
}

#[command(async)]
pub fn fs_watch(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    reject_special_path(&p, "path")?;
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let dirs = collect_watch_dirs(&p)?;
    // Slash-normalized like every other path id, so the frontend's `==`
    // against worktree roots holds on Windows.
    let root = p.to_string_lossy().replace('\\', "/");
    {
        let map = WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
        if map.live.contains_key(&root) {
            return Ok(());
        }
    }
    let stop = spawn_watch_manager(&app, root.clone(), p, dirs)?;
    let mut map = WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
    if map.live.len() >= 16 {
        if let Some(old) = map.order.first().cloned() {
            map.order.remove(0);
            map.live.remove(&old);
        }
    }
    // Re-check under the same lock: two panes racing fs_watch on one root
    // would otherwise arm it twice (the loser's watcher just drops).
    if !map.live.contains_key(&root) {
        map.order.push(root.clone());
        map.live.insert(root, stop);
    } else {
        drop(stop);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveal_rejects_non_dirs() {
        assert!(fs_reveal("C:/no/such/dir-xyz".into()).is_err());
        assert!(reject_special_path(Path::new("\\\\.\\C:"), "path").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn reveal_uses_system_explorer() {
        let path = system_explorer().unwrap();
        assert!(path.is_absolute());
        assert_eq!(path.file_name().and_then(|name| name.to_str()), Some("explorer.exe"));
    }

    #[test]
    fn reserved_names_rejected() {
        assert!(reject_special_path(Path::new("C:/x/NUL"), "path").is_err());
        assert!(reject_special_path(Path::new("C:/x/COM1.txt"), "path").is_err());
        assert!(reject_special_path(Path::new("\\\\.\\C:"), "path").is_err());
        assert!(reject_special_path(Path::new("C:/ok/file.txt"), "path").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn reserved_names_reject_windows_trailing_aliases() {
        for name in ["NUL ", "NUL  ", "NUL ."] {
            assert!(reject_special_path(Path::new("C:/x").join(name).as_path(), "path").is_err());
        }
    }

    #[test]
    fn scans_reject_unc_roots() {
        let root = r"\\server\share";
        assert!(fs_tree(root.into(), 1).is_err());
        assert!(grep_search(root.into(), "text".into(), None, None).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn alternate_data_stream_names_rejected() {
        assert!(reject_special_path(Path::new("C:/x/file.txt:stream"), "path").is_err());
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

    #[cfg(unix)]
    #[test]
    fn read_and_grep_skip_non_regular_files() {
        let dir = std::env::temp_dir().join(format!("guimux-fs-fifo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("pipe");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());

        assert!(fs_read(fifo.to_string_lossy().to_string()).is_err());
        assert!(grep_search(dir.to_string_lossy().to_string(), "needle".into(), None, None)
            .unwrap()
            .is_empty());
        let _ = fs::remove_file(&fifo);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn checked_write_rejects_external_changes() {
        let dir = std::env::temp_dir().join(format!("guimux-fs-checked-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("checked.txt");
        let path = file.to_string_lossy().to_string();
        fs::write(&file, "original").unwrap();
        fs_write_checked(path.clone(), "local".into(), "original".into()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "local");
        fs::write(&file, "external").unwrap();
        let error = fs_write_checked(path, "mine".into(), "original".into()).unwrap_err();
        assert!(error.contains("changed on disk"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "external");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn checked_writes_serialize_competing_saves() {
        use std::sync::{Arc, Barrier};

        let dir = std::env::temp_dir().join(format!("guimux-fs-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("race.txt");
        fs::write(&file, "original").unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for content in ["left", "right"] {
            let path = file.to_string_lossy().to_string();
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                fs_write_checked(path, content.into(), "original".into()).is_ok()
            }));
        }
        let successes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successes, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn checked_write_preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("guimux-fs-mode-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mode.txt");
        fs::write(&file, "before").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
        fs_write(file.to_string_lossy().to_string(), "after".into()).unwrap();
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o640);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn checked_write_rejects_symlink_targets() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join(format!("guimux-fs-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.txt");
        fs::write(&target, "before").unwrap();
        let link = dir.join("link.txt");
        symlink(&target, &link).unwrap();
        assert!(fs_write(link.to_string_lossy().to_string(), "after".into()).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "before");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn linked_components_are_rejected_and_not_searched() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join(format!("guimux-fs-components-{}", std::process::id()));
        let outside = dir.join("outside");
        let root = dir.join("root");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(outside.join("secret.txt"), "needle").unwrap();
        let link = root.join("link");
        symlink(&outside, &link).unwrap();

        assert!(fs_read(link.join("secret.txt").to_string_lossy().to_string()).is_err());
        assert!(fs_write(link.join("new.txt").to_string_lossy().to_string(), "x".into()).is_err());
        assert!(fs_tree(link.to_string_lossy().to_string(), 1).is_err());
        assert!(grep_search(root.to_string_lossy().to_string(), "needle".into(), None, None)
            .unwrap()
            .is_empty());
        let tree = fs_tree(root.to_string_lossy().to_string(), 2).unwrap().unwrap();
        let linked = tree.children.unwrap().into_iter().find(|n| n.name == "link").unwrap();
        assert!(linked.children.is_none());
        assert!(!collect_watch_dirs(&root).unwrap().iter().any(|dir| dir == &link));

        let _ = fs::remove_file(&link);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn linked_components_are_rejected_and_not_searched() {
        let dir = std::env::temp_dir().join(format!("guimux-fs-components-{}", std::process::id()));
        let outside = dir.join("outside");
        let root = dir.join("root");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(outside.join("secret.txt"), "needle").unwrap();
        let link = root.join("link");
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(output.status.success(), "mklink failed: {}", String::from_utf8_lossy(&output.stderr));

        assert!(fs_read(link.join("secret.txt").to_string_lossy().to_string()).is_err());
        assert!(fs_write(link.join("new.txt").to_string_lossy().to_string(), "x".into()).is_err());
        assert!(fs_tree(link.to_string_lossy().to_string(), 1).is_err());
        assert!(grep_search(root.to_string_lossy().to_string(), "needle".into(), None, None)
            .unwrap()
            .is_empty());
        let tree = fs_tree(root.to_string_lossy().to_string(), 2).unwrap().unwrap();
        let linked = tree.children.unwrap().into_iter().find(|n| n.name == "link").unwrap();
        assert!(linked.children.is_none());
        assert!(!collect_watch_dirs(&root).unwrap().iter().any(|dir| dir == &link));

        assert!(fs::remove_dir(&link).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_empty_never_overwrites_existing_files() {
        let dir = std::env::temp_dir().join(format!("guimux-fs-create-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("untitled");
        let path = file.to_string_lossy().to_string();
        assert!(fs_create_empty(path.clone()).unwrap());
        assert_eq!(fs::read(&file).unwrap(), b"");
        fs::write(&file, "existing").unwrap();
        assert!(!fs_create_empty(path).unwrap());
        assert_eq!(fs::read_to_string(&file).unwrap(), "existing");
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

    #[test]
    fn grep_finds_text_skips_binary_and_dotfiles() {
        let dir = std::env::temp_dir().join(format!("guimux-grep-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        fs::write(dir.join("a.txt"), "hello world\nsecond line\n").unwrap();
        fs::write(dir.join("b.txt"), "nothing here\n").unwrap();
        fs::write(dir.join("bin.dat"), b"hel\x00lo").unwrap();
        fs::write(dir.join("big.txt"), vec![b'x'; MAX_FILE as usize + 1]).unwrap();
        fs::write(dir.join(".hidden"), "hello hidden\n").unwrap();
        let hits = grep_search(root.clone(), "hello".into(), None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].lineno, 1);
        assert!(hits[0].path.ends_with("a.txt"));
        assert!(grep_search(root.clone(), "   ".into(), None, None).is_err());
        assert!(grep_search(root, "HELLO".into(), Some(true), None).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn grep_bounds_directory_and_entry_traversal() {
        let dir = std::env::temp_dir().join(format!("guimux-grep-budget-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let nested = dir.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("hit.txt"), "needle").unwrap();
        let root = dir.to_string_lossy().to_string();

        assert!(grep_search_with_limits(root.clone(), "needle".into(), None, None, 2, 100)
            .unwrap()
            .is_empty());
        assert!(grep_search_with_limits(root, "needle".into(), None, None, 100, 1)
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_decode_vectors() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("aGk=").unwrap(), b"hi");
        assert_eq!(base64_decode("").unwrap(), b"");
        assert!(base64_decode("!!!").is_err());
        assert!(base64_decode("abc").is_err());
    }

    #[test]
    fn paste_names_narrow() {
        assert!(valid_paste_name("paste-m3x-abc123.png"));
        assert!(valid_paste_name("paste-1.JPG"));
        assert!(!valid_paste_name("paste-x.txt"));
        assert!(!valid_paste_name("evil.png"));
        assert!(!valid_paste_name("paste-.png"));
        assert!(!valid_paste_name("paste-a/b.png"));
    }

    #[test]
    fn paste_bytes_roundtrip_and_guards() {
        let dir = std::env::temp_dir().join(format!("guimux-paste-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let drop = dir.join(".guimux-pastes");
        // 1x1 png body, arbitrary bytes: the command is encoding-agnostic.
        let target = drop.join("paste-t1-abc.png");
        let saved = fs_write_bytes(target.to_string_lossy().to_string(), "aGVsbG8=".into()).unwrap();
        assert_eq!(std::fs::read(&saved).unwrap(), b"hello");
        // Clash suffixes instead of truncating.
        let saved2 = fs_write_bytes(target.to_string_lossy().to_string(), "aGk=".into()).unwrap();
        assert_ne!(saved, saved2);
        assert_eq!(std::fs::read(&saved2).unwrap(), b"hi");
        // Outside the drop dir, and bad names, are refused.
        assert!(fs_write_bytes(dir.join("x.png").to_string_lossy().to_string(), "aGk=".into()).is_err());
        assert!(fs_write_bytes(drop.join("evil.txt").to_string_lossy().to_string(), "aGk=".into()).is_err());
        assert!(fs_write_bytes(target.to_string_lossy().to_string(), "!!!".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn paste_does_not_follow_symlink_targets() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join(format!("guimux-paste-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".guimux-pastes")).unwrap();
        let outside = dir.join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        let requested = dir.join(".guimux-pastes").join("paste-link.png");
        symlink(&outside, &requested).unwrap();
        let saved = fs_write_bytes(requested.to_string_lossy().to_string(), "aGk=".into()).unwrap();
        assert_ne!(saved, requested.to_string_lossy());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        let _ = fs::remove_dir_all(&dir);
    }
}
