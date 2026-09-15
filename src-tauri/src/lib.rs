pub mod conpty_dll;
pub mod fs;
pub mod git;
pub mod pty;
pub mod worktree;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    conpty_dll::ensure_bundled_conpty();
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }
    builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            worktree::worktree_list,
            worktree::worktree_create,
            worktree::worktree_remove,
            worktree::worktree_merge,
            git::project_detect,
            git::git_init,
            git::git_status,
            git::git_diff,
            git::git_branches,
            fs::fs_tree,
            fs::fs_read,
            fs::fs_write,
            fs::fs_rename,
            pty::pty_spawn,
            pty::pty_attach,
            pty::pty_alive,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_restart,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
