//! Bundled-ConPTY loader, node-pty parity.
//!
//! Why this exists: system ConPTY (kernel32 CreatePseudoConsole) kills the
//! parent PowerShell when bun-runtime TUIs (opencode) exit — both `/exit` and
//! Ctrl+C paths (anomalyco/opencode#28673, #26480). node-pty's bundled
//! conpty.dll + OpenConsole.exe host survives the same flow (proven H19/H20/H21:
//! inbox dead/alive=false, bundled alive=true across /exit, /quit, Ctrl+C).
//!
//! How it works: like portable-pty's `PsuedoCon::new`, but against OUR
//! vendored conpty.dll (assets/conpty/, same binaries node-pty 1.1.0 ships),
//! loaded via `conpty.dll` side-by-side in the exe dir. portable-pty 0.8.1
//! prefers a sideloaded `conpty.dll` the same way, so no fork needed: place
//! the dll next to the binary and its `load_conpty()` picks it up.
//!
//! ponytail: if portable-pty ever drops the sideload preference, call
//! `ensure_bundled_conpty()` + CreatePseudoConsole directly via this module.

/// Copy vendored assets next to the exe at startup (dev + portable runs),
/// so portable-pty's sideload check (`conpty.dll` beside the binary) hits.
#[cfg(windows)]
pub fn ensure_bundled_conpty() {
    let files = ["conpty.dll", "OpenConsole.exe"];
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let exe_dir = match exe_dir {
        Some(d) => d,
        None => return,
    };
    // Tauri dev runs the exe from target/debug; bundled assets live in
    // src-tauri/assets/conpty. Installed runs already have them side-by-side
    // via bundle resources (see tauri.conf.json).
    let src_dir = exe_dir.join("assets").join("conpty");
    let src_dir = if src_dir.is_dir() {
        src_dir
    } else {
        // target/debug -> src-tauri/assets/conpty
        let mut d = exe_dir.clone();
        let mut found = None;
        for _ in 0..4 {
            let cand = d.join("src-tauri").join("assets").join("conpty");
            if cand.is_dir() {
                found = Some(cand);
                break;
            }
            if !d.pop() {
                break;
            }
        }
        match found {
            Some(d) => d,
            None => return,
        }
    };
    for f in files {
        let dst = exe_dir.join(f);
        if dst.is_file() {
            continue;
        }
        let src = src_dir.join(f);
        if src.is_file() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
}
