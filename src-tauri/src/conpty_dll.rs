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

/// Vendored binary sizes, recorded from node-pty 1.1.0's assets. A copy
/// whose size doesn't match is refused (H-006: stale/tampered DLL pinning).
/// ponytail: sizes catch truncation/swap, not crafted same-size binaries —
/// upgrade to sha256 (const hex, no new dep) when supply-chain review lands.
#[cfg(windows)]
const EXPECTED: &[(&str, u64)] = &[
    ("conpty.dll", 109_600),
    ("OpenConsole.exe", 1_148_448),
];

#[cfg(windows)]
fn log_conpty(msg: &str) {
    eprintln!("[gm-conpty] {msg}");
}

/// Copy vendored assets next to the exe at startup (dev + portable runs),
/// so portable-pty's sideload check (`conpty.dll` beside the binary) hits.
/// Installed runs already have them side-by-side via bundle resources
/// (see tauri.conf.json) — nothing to do there.
#[cfg(windows)]
pub fn ensure_bundled_conpty() {
    let files = ["conpty.dll", "OpenConsole.exe"];
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let exe_dir = match exe_dir {
        Some(d) => d,
        None => {
            log_conpty("cannot resolve exe dir; using system ConPTY");
            return;
        }
    };
    // Release bundle: resources are staged next to the exe by the
    // installer/updater. Never overwrite them here (the old `is_file →
    // continue` pinned a stale DLL forever with no way to update).
    if EXPECTED.iter().all(|(f, _)| exe_dir.join(f).is_file()) {
        return;
    }
    // Dev layout: exe at <root>/src-tauri/target/{debug,release} → vendored
    // assets at <root>/src-tauri/assets/conpty (fixed relative path, two
    // levels up — no directory walk, so no planted-dir sideload vector).
    let src_dir = exe_dir
        .parent()
        .and_then(|t| t.parent())
        .map(|s| s.join("assets").join("conpty"))
        .filter(|c| c.is_dir());
    let src_dir = match src_dir {
        Some(d) => d,
        None => {
            log_conpty("vendored assets not found; using system ConPTY");
            return;
        }
    };
    for f in files {
        let dst = exe_dir.join(f);
        let src = src_dir.join(f);
        let want = EXPECTED.iter().find(|(n, _)| *n == f).map(|(_, s)| *s);
        match (src.metadata(), want) {
            (Ok(m), Some(want)) if m.is_file() && m.len() == want => {}
            (Ok(m), _) => {
                log_conpty(&format!(
                    "{f} size mismatch (got {} bytes, want {want:?}); using system ConPTY",
                    m.len()
                ));
                continue;
            }
            (Err(e), _) => {
                log_conpty(&format!("{f} unreadable: {e}; using system ConPTY"));
                continue;
            }
        }
        // Refresh unconditionally (old code never updated an existing copy).
        match std::fs::copy(&src, &dst) {
            Ok(_) => log_conpty(&format!("{f} staged")),
            Err(e) => log_conpty(&format!("{f} copy failed: {e}; using system ConPTY")),
        }
    }
}
