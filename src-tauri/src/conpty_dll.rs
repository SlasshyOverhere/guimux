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
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use winapi::um::winbase::SetDllDirectoryW;

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
fn harden_dll_search_path() -> bool {
    unsafe { SetDllDirectoryW(std::ptr::null()) != 0 }
}

#[cfg(windows)]
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(windows)]
fn reject_link_components(path: &Path) -> Result<(), String> {
    let mut current = path;
    loop {
        match std::fs::symlink_metadata(current) {
            Ok(metadata) if is_link_like(&metadata) => {
                return Err("ConPTY asset path contains a link or reparse point".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot inspect ConPTY asset path: {error}")),
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(())
}

#[cfg(windows)]
fn asset_matches(path: &Path, expected_size: u64, expected_hash: &str) -> bool {
    if reject_link_components(path).is_err() {
        return false;
    }
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if is_link_like(&metadata) {
        return false;
    }
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

#[cfg(windows)]
fn stage_asset(src: &Path, dst: &Path, expected_size: u64, expected_hash: &str) -> bool {
    if !asset_matches(src, expected_size, expected_hash) || reject_link_components(dst).is_err() {
        return false;
    }
    match std::fs::symlink_metadata(dst) {
        Ok(metadata) if !is_link_like(&metadata) && metadata.is_file() => {
            return asset_matches(dst, expected_size, expected_hash);
        }
        Ok(_) => return false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return false,
    }
    let Ok(input) = std::fs::File::open(src) else {
        return false;
    };
    let mut output = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)
    {
        Ok(file) => file,
        Err(_) => return false,
    };
    if let Err(error) = std::io::copy(&mut input.take(expected_size + 1), &mut output) {
        drop(output);
        let _ = std::fs::remove_file(dst);
        log_conpty(&format!("asset copy failed: {error}"));
        return false;
    }
    drop(output);
    if !asset_matches(dst, expected_size, expected_hash) {
        let _ = std::fs::remove_file(dst);
        return false;
    }
    true
}

/// Copy vendored assets next to the exe at startup (dev + portable runs),
/// so portable-pty's sideload check (`conpty.dll` beside the binary) hits.
/// Installed runs already have them side-by-side via bundle resources
/// (see tauri.conf.json) — nothing to do there.
#[cfg(windows)]
pub fn ensure_bundled_conpty() -> bool {
    if !harden_dll_search_path() {
        log_conpty("failed to remove cwd from DLL search path; refusing startup");
        return false;
    }
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
    let mut all_present = true;
    for (name, size, hash) in EXPECTED {
        let dst = exe_dir.join(name);
        match std::fs::symlink_metadata(&dst) {
            Ok(metadata) if !is_link_like(&metadata) && metadata.is_file() => {
                if !asset_matches(&dst, *size, hash) {
                    log_conpty("existing ConPTY asset failed integrity check; refusing startup");
                    return false;
                }
            }
            Ok(_) => {
                log_conpty("existing ConPTY asset is not a regular file; refusing startup");
                return false;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                all_present = false;
            }
            Err(error) => {
                log_conpty(&format!(
                    "cannot inspect existing ConPTY asset: {error}; refusing startup"
                ));
                return false;
            }
        }
    }
    if all_present {
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
            log_conpty("vendored assets not found; using system ConPTY");
            return true;
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
        if stage_asset(&src, &dst, *size, hash) {
            log_conpty(&format!("{name} staged"));
        } else {
            log_conpty(&format!("{name} could not be staged; using system ConPTY"));
        }
    }
    let valid = EXPECTED.iter().all(|(name, size, hash)| {
        let dst = exe_dir.join(name);
        match std::fs::symlink_metadata(&dst) {
            Ok(metadata) => {
                !is_link_like(&metadata) && metadata.is_file() && asset_matches(&dst, *size, hash)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        }
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
    fn staging_never_overwrites_an_existing_destination() {
        let dir = std::env::temp_dir().join(format!("guimux-conpty-stage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (name, size, hash) = EXPECTED[0];
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets/conpty")
            .join(name);
        let dst = dir.join(name);
        std::fs::write(&dst, b"keep").unwrap();
        assert!(!stage_asset(&src, &dst, size, hash));
        assert_eq!(std::fs::read(&dst).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dll_search_path_hardening_succeeds() {
        assert!(harden_dll_search_path());
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
