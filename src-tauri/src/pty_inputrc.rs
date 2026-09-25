use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(not(windows))]
use std::sync::OnceLock;

const INPUTRC_TEXT: &str = "$include /etc/inputrc\n$include ~/.inputrc\n\"\\e[3;5~\": kill-word\n\"\\C-h\": backward-kill-word\n\"\\e\\x7f\": backward-kill-word\n";

fn create_inputrc_in(dir: &Path) -> Result<PathBuf, String> {
    static CTR: AtomicU64 = AtomicU64::new(0);
    for _ in 0..16 {
        let path = dir.join(format!(
            "guimux-inputrc-{}-{}",
            std::process::id(),
            CTR.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        };
        if let Err(e) = file.write_all(INPUTRC_TEXT.as_bytes()) {
            let _ = std::fs::remove_file(&path);
            return Err(e.to_string());
        }
        return Ok(path);
    }
    Err("could not create a private inputrc path".into())
}

#[cfg(not(windows))]
pub fn ensure_guimux_inputrc() -> Option<PathBuf> {
    static INPUTRC: OnceLock<Option<PathBuf>> = OnceLock::new();
    INPUTRC
        .get_or_init(|| create_inputrc_in(&std::env::temp_dir()).ok())
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_private_unique_inputrc() {
        let dir = std::env::temp_dir().join(format!("guimux-inputrc-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = create_inputrc_in(&dir).unwrap();
        let second = create_inputrc_in(&dir).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), INPUTRC_TEXT);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
