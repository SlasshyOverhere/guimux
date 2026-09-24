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

#[cfg(windows)]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::io::Read;

/// Vendored binary sizes and SHA-256 digests, recorded from node-pty 1.1.0's assets.
#[cfg(windows)]
const EXPECTED: &[(&str, u64, &str)] = &[
    (
        "conpty.dll",
        109_600,
        "7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed",
    ),
    (
        "OpenConsole.exe",
        1_148_448,
        "d1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc",
    ),
];

#[cfg(windows)]
fn log_conpty(msg: &str) {
    eprintln!("[gm-conpty] {msg}");
}

#[cfg(windows)]
fn asset_matches(path: &std::path::Path, expected_size: u64, expected_hash: &str) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() != expected_size {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let Ok(read) = file.read(&mut buffer) else {
            return false;
        };
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut actual = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(actual, "{byte:02x}");
    }
    actual == expected_hash
}

/// Copy vendored assets next to the exe at startup (dev + portable runs),
/// so portable-pty's sideload check (`conpty.dll` beside the binary) hits.
/// Installed runs already have them side-by-side via bundle resources
/// (see tauri.conf.json) — nothing to do there.
#[cfg(windows)]
pub fn ensure_bundled_conpty() -> bool {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let exe_dir = match exe_dir {
        Some(d) => d,
        None => {
            log_conpty("cannot resolve exe dir; using system ConPTY");
            return true;
        }
    };
    let mut valid = true;
    for (name, size, hash) in EXPECTED {
        let dst = exe_dir.join(name);
        if asset_matches(&dst, *size, hash) {
            continue;
        }
        if dst.exists() {
            valid = false;
        }
    }
    if EXPECTED
        .iter()
        .all(|(name, size, hash)| asset_matches(&exe_dir.join(name), *size, hash))
    {
        return true;
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
            if valid {
                log_conpty("vendored assets not found; using system ConPTY");
            } else {
                log_conpty("existing ConPTY assets failed integrity checks; refusing startup");
            }
            return valid;
        }
    };
    for (name, size, hash) in EXPECTED {
        let dst = exe_dir.join(name);
        let src = src_dir.join(name);
        if !asset_matches(&src, *size, hash) {
            log_conpty(&format!(
                "{name} failed integrity check; using system ConPTY"
            ));
            continue;
        }
        match std::fs::copy(&src, &dst) {
            Ok(_) if asset_matches(&dst, *size, hash) => {
                log_conpty(&format!("{name} staged"));
            }
            Ok(_) => {
                log_conpty(&format!("{name} staged copy failed integrity check"));
            }
            Err(e) => {
                log_conpty(&format!("{name} copy failed: {e}; using system ConPTY"));
            }
        }
    }
    valid = EXPECTED.iter().all(|(name, size, hash)| {
        let dst = exe_dir.join(name);
        !dst.exists() || asset_matches(&dst, *size, hash)
    });
    if !valid {
        log_conpty("ConPTY integrity checks failed; refusing startup");
    }
    valid
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn asset_hash_rejects_same_size_tampering() {
        let path = std::env::temp_dir().join(format!("guimux-conpty-hash-{}", std::process::id()));
        std::fs::write(&path, b"test").unwrap();
        assert!(asset_matches(
            &path,
            4,
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        ));
        std::fs::write(&path, b"evil").unwrap();
        assert!(!asset_matches(
            &path,
            4,
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        ));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn vendored_assets_match_pinned_hashes() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/conpty");
        assert!(EXPECTED.iter().all(|(name, size, hash)| asset_matches(
            &root.join(name),
            *size,
            hash
        )));
    }
}
