use tauri::Manager;

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
    #[cfg(all(debug_assertions, feature = "debug-mcp"))]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            worktree::worktree_list,
            worktree::worktree_create,
            worktree::worktree_remove,
            worktree::worktree_prune,
            worktree::worktree_repair,
            worktree::worktree_merge,
            worktree::worktree_merge_abort,
            git::project_detect,
            git::git_init,
            git::git_status,
            git::git_diff,
            git::git_branches,
            git::git_ahead_behind,
            git::git_commit,
            git::git_push,
            git::git_fetch,
            fs::fs_tree,
            fs::fs_read,
            fs::fs_write,
            fs::fs_rename,
            fs::fs_reveal,
            fs::fs_watch,
            fs::grep_search,
            pty::pty_spawn,
            pty::pty_attach,
            pty::pty_alive,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_restart,
            pty::pty_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // ConPTY children are not in a job object: without this, shells and
            // the agents they host keep running with no window attached.
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(pty) = app.try_state::<pty::PtyManager>() {
                    pty.kill_all();
                }
            }
        });
}
