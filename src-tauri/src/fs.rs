use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;

const MAX_FILE: u64 = 1_000_000; // skip files >1MB
const IGNORED: &[&str] = &[".git", "node_modules", "target", "dist", ".next", "__pycache__"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<Node>>,
}

fn build_tree(path: &Path, depth: u32, max_depth: u32) -> Option<Node> {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    if !path.is_dir() {
        return Some(Node {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            children: None,
        });
    }
    if depth >= max_depth {
        return Some(Node {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: true,
            children: Some(vec![]),
        });
    }
    let mut children = vec![];
    let entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return None,
    };
    let mut collected: Vec<_> = entries.flatten().collect();
    collected.sort_by_key(|e| e.file_name());
    for entry in collected {
        let fname = entry.file_name().to_string_lossy().to_string();
        if IGNORED.contains(&fname.as_str()) || fname.starts_with('.') && fname != ".github" {
            continue;
        }
        if let Some(node) = build_tree(&entry.path(), depth + 1, max_depth) {
            children.push(node);
        }
    }
    Some(Node {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: true,
        children: Some(children),
    })
}

#[command]
pub fn fs_tree(path: String, depth: u32) -> Result<Option<Node>, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    Ok(build_tree(&p, 0, depth.clamp(1, 6)))
}

#[command]
pub fn fs_read(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE {
        return Err(format!(
            "file too large ({} bytes > 1MB)",
            meta.len()
        ));
    }
    if meta.is_dir() {
        return Err("cannot read a directory".into());
    }
    fs::read_to_string(&p).map_err(|e| format!("not valid utf-8 or unreadable: {e}"))
}

#[command]
pub fn fs_write(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| e.to_string())
}
