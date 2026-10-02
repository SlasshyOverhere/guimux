use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(not(windows))]
use std::sync::OnceLock;

const INPUTRC_TEXT: &str = "$include /etc/inputrc\n$include ~/.inputrc\n\"\\e[3;5~\": kill-word\n\"\\C-h\": backward-kill-word\n\"\\e\\x7f\": backward-kill-word\n";
const INPUTRC_NAME: &str = "guimux-inputrc";

/// A stable inputrc we already own: regular, private, and byte-identical to
/// what we write. Anything else at that path (a symlink, a planted file, a
/// half-written one) is never trusted, so the caller falls back to a unique
/// name instead.
fn reusable_inputrc(path: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return None;
        }
    }
    (std::fs::read_to_string(path).ok()? == INPUTRC_TEXT).then(|| path.to_path_buf())
}

fn write_inputrc(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path)?;
    match file.write_all(INPUTRC_TEXT.as_bytes()) {
        Ok(()) => Ok(()),
        Err(e) => {
            drop(file);
            let _ = std::fs::remove_file(path);
            Err(e)
        }
    }
}

/// One inputrc per user, not one per launch: the stable name is reused across
/// runs so the temp dir does not grow a file on every start.
fn create_inputrc_in(dir: &Path) -> Result<PathBuf, String> {
    let stable = dir.join(INPUTRC_NAME);
    if let Some(path) = reusable_inputrc(&stable) {
        return Ok(path);
    }
    if write_inputrc(&stable).is_ok() {
        return Ok(stable);
    }
    // The stable path is taken by something we will not overwrite.
    static CTR: AtomicU64 = AtomicU64::new(0);
    for _ in 0..16 {
        let path = dir.join(format!(
            "{INPUTRC_NAME}-{}-{}",
            std::process::id(),
            CTR.fetch_add(1, Ordering::Relaxed)
        ));
        match write_inputrc(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("could not create a private inputrc path".into())
}

#[cfg(not(windows))]
pub fn ensure_guimux_inputrc() -> Option<PathBuf> {
    static INPUTRC: OnceLock<Option<PathBuf>> = OnceLock::new();
    INPUTRC
        .get_or_init(|| {
            // The user's own guimux dir keeps the file out of the shared temp
            // dir entirely; the temp dir stays the fallback.
            if let Some(home) = dirs::home_dir().map(|h| h.join(".guimux")) {
                if std::fs::create_dir_all(&home).is_ok() {
                    if let Ok(path) = create_inputrc_in(&home) {
                        return Some(path);
                    }
                }
            }
            create_inputrc_in(&std::env::temp_dir()).ok()
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_one_private_inputrc_and_refuses_a_planted_one() {
        let dir = std::env::temp_dir().join(format!("guimux-inputrc-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let first = create_inputrc_in(&dir).unwrap();
        // A second launch reuses it instead of leaving another file behind.
        assert_eq!(create_inputrc_in(&dir).unwrap(), first);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), INPUTRC_TEXT);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        // Tampered with: never trusted, and never overwritten either.
        std::fs::write(&first, "planted").unwrap();
        let second = create_inputrc_in(&dir).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(&second).unwrap(), INPUTRC_TEXT);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
