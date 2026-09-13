use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySession {
    pub id: u64,
    pub cwd: String,
}

struct PtyEntry {
    writer: Box<dyn Write + Send>,
    // Split ownership: the exit watcher owns the real Child (try_wait /
    // wait need &mut), while pty_kill drives this independent killer
    // handle (TerminateProcess on a process HANDLE — no &mut Child needed).
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, PtyEntry>>,
}

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((*c.get(1).unwrap_or(&0) as u32) << 8)
            | (*c.get(2).unwrap_or(&0) as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if c.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn utf16le(s: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(s.len() * 2);
    for u in s.encode_utf16() {
        v.extend_from_slice(&u.to_le_bytes());
    }
    v
}

/// Orca parity (powershell-osc133-bootstrap.ts, windows-shell-args.ts):
/// PowerShell launches as `-NoLogo -NoExit -EncodedCommand <this>`.
/// -EncodedCommand is quoting-proof; inline -Command is not, and dot-sourcing
/// a .ps1 is execution-policy gated. Expects UTF-16LE base64.
/// ponytail: no OSC133 prompt markers (orca uses them for agent exit-code
/// tracking); add when a consumer needs prompt lifecycle.
fn powershell_bootstrap(cwd: &str) -> String {
    let safe_cwd = cwd.replace('\'', "''");
    format!(
        "# guimux bootstrap: UTF-8 console + stable cwd after $PROFILE.\n\
         chcp 65001 >$null\n\
         try {{ [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); \
         [Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); \
         $OutputEncoding = [Console]::OutputEncoding }} catch {{}}\n\
         try {{ Set-Location -LiteralPath '{safe_cwd}' -ErrorAction Stop }} catch {{}}"
    )
}

/// Reject Store App Execution Alias stubs (0-byte reparse points under
/// WindowsApps): ConPTY CreateProcessW rejects them with code 5.
/// (Orca: windows-powershell-executable.ts)
fn is_real_exe(p: &std::path::Path) -> bool {
    if p.components().any(|c| {
        c.as_os_str().to_string_lossy().eq_ignore_ascii_case("WindowsApps")
    }) {
        return false;
    }
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

fn find_in_path(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .filter(|d| d.is_absolute())
            .map(|d| d.join(exe))
            .find(|p| is_real_exe(p))
    })
}

fn resolve_pwsh() -> Option<String> {
    {
        let cache = PWSH_CACHE.lock().unwrap();
        if let Some(cached) = cache.clone() {
            return cached;
        }
    }
    let mut pwsh: Option<PathBuf> = None;
    for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(root) = std::env::var(key) {
            for major in ["7", "8", "6"] {
                let c = PathBuf::from(&root).join("PowerShell").join(major).join("pwsh.exe");
                if is_real_exe(&c) {
                    pwsh = Some(c);
                    break;
                }
            }
            if pwsh.is_some() {
                break;
            }
        }
    }
    if pwsh.is_none() {
        if let Ok(la) = std::env::var("LOCALAPPDATA") {
            for major in ["7", "8", "6"] {
                let c = PathBuf::from(&la)
                    .join("Microsoft")
                    .join("PowerShell")
                    .join(major)
                    .join("pwsh.exe");
                if is_real_exe(&c) {
                    pwsh = Some(c);
                    break;
                }
            }
        }
    }
    if pwsh.is_none() {
        pwsh = find_in_path("pwsh.exe");
    }
    let out = pwsh.map(|p| p.to_string_lossy().to_string());
    *PWSH_CACHE.lock().unwrap() = Some(out.clone());
    out
}

/// Ordered Windows launch attempts, orca parity
/// (windows-shell-fallback-chain.ts): real absolute exes only,
/// pwsh -> inbox powershell -> cmd, so a terminal always opens.
#[cfg(windows)]
fn windows_shell_chain(cwd: &str) -> Vec<(String, Vec<String>)> {
    if let Ok(over) = std::env::var("GUIMUX_SHELL") {
        if !over.trim().is_empty() {
            return vec![(over, vec![])];
        }
    }
    let pwsh = resolve_pwsh();

    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let inbox = PathBuf::from(&sysroot)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let inbox = if is_real_exe(&inbox) {
        Some(inbox.to_string_lossy().to_string())
    } else {
        None
    };

    let encoded = cached_bootstrap(cwd);
    let ps_args = || {
        vec![
            "-NoLogo".to_string(),
            "-NoExit".to_string(),
            "-EncodedCommand".to_string(),
            encoded.clone(),
        ]
    };
    let mut chain = vec![];
    if let Some(p) = pwsh {
        chain.push((p, ps_args()));
    }
    if let Some(p) = inbox {
        if !chain.iter().any(|(s, _)| s.eq_ignore_ascii_case(&p)) {
            chain.push((p, ps_args()));
        }
    }
    let cmd = std::env::var("COMSPEC").unwrap_or_else(|_| {
        PathBuf::from(&sysroot)
            .join("System32")
            .join("cmd.exe")
            .to_string_lossy()
            .to_string()
    });
    chain.push((cmd, vec!["/K".into(), "chcp 65001 > nul".into()]));
    chain
}

static MASTERS: std::sync::LazyLock<Mutex<HashMap<u64, Box<dyn portable_pty::MasterPty + Send>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// cwd per live session id, so `pty_restart` can respawn in place.
static SPAWN_CWDS: std::sync::LazyLock<Mutex<HashMap<u64, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Output-before-attach fix: per-PTY ring buffer. The pump always appends
/// (cap 256KB, oldest dropped); live `pty:output-{id}` emits only after the
/// frontend sends explicit `pty_attach(id)`, which replays the buffer.
const REPLAY_CAP: usize = 256 * 1024;
static BUFFERS: std::sync::LazyLock<Mutex<HashMap<u64, Vec<u8>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static ATTACHED: std::sync::LazyLock<Mutex<HashMap<u64, bool>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Exit-watcher epochs: restart/kill bumps the epoch so a stale watcher for
/// the old child never emits `pty:exit-{id}` at the reused numeric id.
static EPOCHS: std::sync::LazyLock<Mutex<HashMap<u64, u64>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn clamp_dims(cols: u16, rows: u16) -> (u16, u16) {
    (cols.max(1), rows.max(1))
}

fn push_buffer(id: u64, bytes: &[u8]) {
    let mut map = BUFFERS.lock().unwrap();
    let buf = map.entry(id).or_default();
    buf.extend_from_slice(bytes);
    if buf.len() > REPLAY_CAP {
        let excess = buf.len() - REPLAY_CAP;
        buf.drain(..excess);
    }
}

/// Spawn-latency caches: bootstrap base64 per cwd, resolved pwsh path once.
/// GUIMUX_SHELL bypasses the pwsh cache (env override must always win).
static BOOTSTRAP_CACHE: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static PWSH_CACHE: std::sync::LazyLock<Mutex<Option<Option<String>>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

fn cached_bootstrap(cwd: &str) -> String {
    {
        let map = BOOTSTRAP_CACHE.lock().unwrap();
        if let Some(s) = map.get(cwd) {
            return s.clone();
        }
    }
    let s = base64_encode(&utf16le(&powershell_bootstrap(cwd)));
    BOOTSTRAP_CACHE.lock().unwrap().insert(cwd.to_string(), s.clone());
    s
}

fn pty_debug() -> bool {
    std::env::var("GUIMUX_PTY_DEBUG").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false)
}

pub fn register_master(id: u64, master: Box<dyn portable_pty::MasterPty + Send>) {
    MASTERS.lock().unwrap().insert(id, master);
}

fn epoch_current(id: u64, epoch: u64) -> bool {
    EPOCHS.lock().unwrap().get(&id).copied() == Some(epoch)
}

fn next_epoch(id: u64) -> u64 {
    let mut map = EPOCHS.lock().unwrap();
    let e = map.get(&id).copied().unwrap_or(0) + 1;
    map.insert(id, e);
    e
}

/// Watch the SHELL child (not the pty pipe): only a true shell death may
/// raise `pty:exit`. A reader EOF while the child still runs is a pipe
/// artifact — emitting exit there is what bricked panes when TUIs that
/// juggle console handles (opencode server child, bun runtime teardown)
/// made ConPTY deliver EOF early. Orca/node-pty equivalent: exit fires from
/// WaitForSingleObject on the shell process, never from pipe state.
/// The watcher captures its spawn epoch and stays silent unless still
/// current, so `pty_restart` (same numeric id) never delivers the old
/// child's exit to the new session.
fn spawn_exit_watcher(app: AppHandle, id: u64, epoch: u64, mut child: Box<dyn portable_pty::Child + Send + Sync>) {
    std::thread::spawn(move || {
        let code: u32 = loop {
            std::thread::sleep(std::time::Duration::from_millis(120));
            match child.try_wait() {
                Ok(Some(status)) => break status.exit_code(),
                // try_wait is GetExitCodeProcess — no signals, no TerminateProcess.
                // Child alive (even with a dead pipe) = keep the pane up.
                Ok(None) => continue,
                Err(_) => break 0xFFFFFFFF,
            }
        };
        if epoch_current(id, epoch) {
            let _ = app.emit(&format!("pty:exit-{id}"), code as i32);
        }
    });
}

fn spawn_output_pump(app: AppHandle, id: u64, epoch: u64, mut reader: Box<dyn Read + Send>, t_start: std::time::Instant) {
    // EOF just ends the stream. This thread never emits exit.
    // Every byte is buffered; live emit starts only after `pty_attach`.
    // The epoch guard stops a pre-restart pump from leaking stale bytes
    // into the reused numeric id's buffer/channel.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut first = true;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if !epoch_current(id, epoch) {
                        break;
                    }
                    if pty_debug() && first {
                        first = false;
                        eprintln!("[gm-pty] id={id} first-byte {}ms after spawn start", t_start.elapsed().as_millis());
                    }
                    push_buffer(id, &buf[..n]);
                    let attached = ATTACHED.lock().unwrap().get(&id).copied().unwrap_or(false);
                    if attached {
                        let _ = app.emit(&format!("pty:output-{id}"), buf[..n].to_vec());
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_pair(
    app: &AppHandle,
    state: &State<PtyManager>,
    id: u64,
    cwd: String,
    cols: u16,
    rows: u16,
    live: bool,
) -> Result<PtySession, String> {
    use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

    let t_start = std::time::Instant::now();
    // Never a zero-size PTY: a 0-col/row ConPTY wedges rendering (blank pane).
    let (cols, rows) = clamp_dims(cols, rows);
    if pty_debug() {
        eprintln!("[gm-pty] id={id} ipc-received cwd={cwd} {cols}x{rows}");
    }

    let path = PathBuf::from(&cwd);
    if !path.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    #[cfg(windows)]
    let attempts: Vec<(String, Vec<String>)> = windows_shell_chain(&cwd);
    #[cfg(not(windows))]
    let attempts: Vec<(String, Vec<String>)> = vec![(
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()),
        vec![],
    )];

    let mut spawn_err = String::new();
    let mut child = None;
    for (shell, shell_args) in &attempts {
        let mut cmd = CommandBuilder::new(shell.clone());
        for arg in shell_args {
            cmd.arg(arg);
        }
        cmd.cwd(&path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "guimux");
        match pair.slave.spawn_command(cmd) {
            Ok(c) => {
                if pty_debug() {
                    eprintln!("[gm-pty] id={id} process-started shell={shell} +{}ms", t_start.elapsed().as_millis());
                }
                child = Some(c);
                break;
            }
            // Store-alias stub (code 5) or AV block: walk the chain, like orca.
            Err(e) => spawn_err = e.to_string(),
        }
    }
    let child = child.ok_or_else(|| format!("failed to spawn shell: {spawn_err}"))?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    register_master(id, pair.master);
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(
            id,
            PtyEntry {
                writer,
                killer: child.clone_killer(),
            },
        );
    }
    {
        let mut map = SPAWN_CWDS.lock().unwrap();
        map.insert(id, cwd.clone());
    }
    BUFFERS.lock().unwrap().insert(id, Vec::new());
    ATTACHED.lock().unwrap().insert(id, live);
    let epoch = next_epoch(id);

    // Exit authority = shell process liveness (GetExitCodeProcess), never
    // pipe EOF. The watcher owns the real Child; the stored killer stays
    // behind for pty_kill/pty_restart.
    spawn_exit_watcher(app.clone(), id, epoch, child);
    spawn_output_pump(app.clone(), id, epoch, reader, t_start);
    Ok(PtySession { id, cwd })
}

#[command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyManager>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<PtySession, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    spawn_pair(&app, &state, id, cwd, cols, rows, false)
}

/// Frontend calls this AFTER registering its `pty:output-{id}` / `pty:exit-{id}`
/// listeners. Marks the session live and returns every byte emitted so far, so
/// the output-before-attach window is replayed, not dropped. Errors on unknown
/// ids so the pane can detect a dead session (e.g. killed across a worktree
/// switch) and spawn fresh instead of sitting blank.
#[command]
pub fn pty_attach(id: u64) -> Result<Vec<u8>, String> {
    if !SPAWN_CWDS.lock().unwrap().contains_key(&id) {
        return Err("no such pty session".into());
    }
    ATTACHED.lock().unwrap().insert(id, true);
    Ok(BUFFERS.lock().unwrap().remove(&id).unwrap_or_default())
}

#[command]
pub fn pty_restart(
    app: AppHandle,
    state: State<PtyManager>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<PtySession, String> {
    // Respawn the same numeric id in its original cwd so the frontend
    // keeps its listeners and the dead pane recovers in place.
    // `live=true`: listeners survive, so stream immediately; the epoch bump
    // inside spawn_pair silences the old child's watcher.
    let cwd = {
        let map = SPAWN_CWDS.lock().unwrap();
        map.get(&id).cloned().unwrap_or_default()
    };
    if cwd.is_empty() {
        return Err("no such pty session".into());
    }
    pty_kill(state.clone(), id)?;
    spawn_pair(&app, &state, id, cwd, cols, rows, true)
}

#[command]
pub fn pty_write(state: State<PtyManager>, id: u64, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let entry = sessions.get_mut(&id).ok_or("no such pty session")?;
    // Passthrough like Orca/node-pty: xterm sends \r for Enter and ConPTY
    // wants it as-is. The old \r -> \r\r\n chain double-submitted every
    // Enter, which PSReadLine read as line-continuation (the stray `>>`).
    entry.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    entry.writer.flush().map_err(|e| e.to_string())
}

#[command]
pub fn pty_resize(state: State<PtyManager>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let _ = state;
    // A 0-size resize wedges ConPTY rendering (blank pane); clamp, never skip
    // (an early resize is still better than none for shells that query size).
    let (cols, rows) = clamp_dims(cols, rows);
    if let Some(master) = MASTERS.lock().unwrap().get(&id) {
        let _ = master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    Ok(())
}

#[command]
pub fn pty_kill(state: State<PtyManager>, id: u64) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut entry) = sessions.remove(&id) {
        // Killer handle = TerminateProcess on the shell HANDLE. Never touches
        // the exit-watcher's owned Child, which exits its poll on its own.
        let _ = entry.killer.kill();
    }
    MASTERS.lock().unwrap().remove(&id);
    SPAWN_CWDS.lock().unwrap().remove(&id);
    BUFFERS.lock().unwrap().remove(&id);
    ATTACHED.lock().unwrap().remove(&id);
    // Bump the epoch so the dead child's watcher can never emit exit at this
    // id again (matters for restart, which reuses the id right after).
    next_epoch(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_command_matches_powershell() {
        // "test" as UTF-16LE base64. Reference from powershell.exe itself:
        // [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('test'))
        assert_eq!(base64_encode(&utf16le("test")), "dABlAHMAdAA=");
        assert_eq!(utf16le("A"), vec![0x41, 0x00]);
    }

    #[test]
    fn alias_stub_rejected_like_orca() {
        assert!(!is_real_exe(std::path::Path::new(
            "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"
        )));
    }

    #[test]
    fn geometry_never_zero() {
        assert_eq!(clamp_dims(0, 0), (1, 1));
        assert_eq!(clamp_dims(0, 24), (1, 24));
        assert_eq!(clamp_dims(80, 0), (80, 1));
        assert_eq!(clamp_dims(80, 24), (80, 24));
    }

    #[test]
    fn replay_buffer_caps_oldest_first() {
        let id = 0xB0FFEBu64;
        BUFFERS.lock().unwrap().remove(&id);
        push_buffer(id, &[b'a'; 10]);
        push_buffer(id, &[b'b'; REPLAY_CAP + 100]);
        let buf = BUFFERS.lock().unwrap().remove(&id).unwrap();
        assert_eq!(buf.len(), REPLAY_CAP);
        // oldest bytes ('a's) were dropped
        assert!(buf.iter().all(|&b| b == b'b'));
    }

    #[test]
    fn stale_epoch_is_not_current() {
        let id = 0xE90C4u64;
        let e1 = next_epoch(id);
        assert!(epoch_current(id, e1));
        let e2 = next_epoch(id);
        assert!(!epoch_current(id, e1));
        assert!(epoch_current(id, e2));
        EPOCHS.lock().unwrap().remove(&id);
    }

    #[test]
    fn attach_rejects_unknown_session() {
        assert!(pty_attach(0xDEAD_DEAD).is_err());
    }

    #[test]
    fn bootstrap_cache_stable_per_cwd() {
        let a = cached_bootstrap("C:\\x");
        let b = cached_bootstrap("C:\\x");
        let c = cached_bootstrap("C:\\y");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
