use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, Emitter, State};

#[cfg(not(windows))]
use crate::pty_inputrc::ensure_guimux_inputrc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySession {
    pub id: u64,
    pub cwd: String,
    pub shell_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyAttach {
    pub replay: Vec<u8>,
    pub shell_kind: String,
}

struct PtyEntry {
    // Arc: pty_write clones it under the map lock, then does blocking pipe
    // I/O with the map lock released — one back-pressured PTY no longer
    // freezes all spawn/kill/resize (H-003).
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    // Split ownership: the exit watcher owns the real Child (try_wait /
    // wait need &mut), while pty_kill drives this independent killer
    // handle (TerminateProcess on a process HANDLE — no &mut Child needed).
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    // Per-session master behind its own mutex: pty_resize clones the Arc and
    // resizes with the sessions lock released, so a slow ConPTY resize (an
    // RPC into conhost/OpenConsole) blocks only this pane — never another
    // pane's spawn/kill/write (was a global MASTERS lock).
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
}

#[derive(Default)]
pub struct PtyManager {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, PtyEntry>>,
}

impl PtyManager {
    /// Terminate every live shell. ConPTY children are not in a job object, so
    /// without this the shells (and any agents they host) outlive the window.
    pub fn kill_all(&self) {
        let entries: Vec<PtyEntry> = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.drain().map(|(_, entry)| entry).collect()
        };
        for mut entry in entries {
            let _ = entry.killer.kill();
            drop(entry.master);
        }
        SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).clear();
        SHELL_KINDS.lock().unwrap_or_else(|e| e.into_inner()).clear();
        ATTACHED.lock().unwrap_or_else(|e| e.into_inner()).clear();
        BUFFERS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
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

/// PowerShell launches as `-NoLogo -NoExit -EncodedCommand <this>`.
/// -EncodedCommand is quoting-proof; inline -Command is not, and dot-sourcing
/// a .ps1 is execution-policy gated. Expects UTF-16LE base64.
fn powershell_bootstrap(cwd: &str) -> String {
    let safe_cwd = cwd.replace('\'', "''");
    format!(
        "# guimux bootstrap: UTF-8 console + stable cwd after $PROFILE.\n\
         chcp 65001 >$null\n\
         try {{ [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); \
         [Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); \
         $OutputEncoding = [Console]::OutputEncoding }} catch {{}}\n\
         try {{ Set-Location -LiteralPath '{safe_cwd}' -ErrorAction Stop }} catch {{}}\n\
         # Word-kill: PSReadLine defaults leave Ctrl+Backspace / Ctrl+Delete\n\
         # unbound, so the sequences arrive but do nothing. Guarded so spawn\n\
         # never fails when PSReadLine is absent (cmd.exe path).\n\
         try {{ if (Get-Module PSReadLine) {{ Set-PSReadLineKeyHandler -Key 'Ctrl+Backspace' -Function BackwardKillWord -ErrorAction SilentlyContinue; Set-PSReadLineKeyHandler -Key 'Ctrl+Delete' -Function KillWord -ErrorAction SilentlyContinue }} }} catch {{}}\n\
         # Split inherits the live cwd: report it on every prompt via OSC 7\n\
         # (file:// URI) + OSC 9;9 (native path, ConPTY/WT style). Write-Host\n\
         # side-channel keeps the returned prompt string clean for PSReadLine\n\
         # width math. ponytail: unix shells ($SHELL spawn) emit no OSC 7;\n\
         # add PROMPT_COMMAND/precmd injection when split-inherit matters there.\n\
         function global:prompt {{ try {{ $p = (Get-Location).Path -replace '\\\\','/'; \
         if ($p -match '^[A-Za-z]:') {{ $p = '/' + $p }}; \
         $e = [char]27; $b = [char]7; \
         Write-Host -NoNewline \"${{e}}]7;file://localhost${{p}}${{b}}${{e}}]9;9;$((Get-Location).Path)${{b}}\" }} catch {{}}; \
         \"PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) \" }}"
    )
}

/// Reject Store App Execution Alias stubs (0-byte reparse points under
/// WindowsApps): ConPTY CreateProcessW rejects them with code 5.
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
        let cache = PWSH_CACHE.lock().unwrap_or_else(|e| e.into_inner());
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
    *PWSH_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(out.clone());
    out
}

/// Ordered Windows launch attempts: real absolute exes only,
/// pwsh -> inbox powershell -> cmd, so a terminal always opens.
#[cfg(windows)]
fn windows_shell_chain(cwd: &str) -> Vec<(String, Vec<String>)> {
    let mut chain: Vec<(String, Vec<String>)> = vec![];
    // Override wins, but the chain stays behind it: a typo'd path used to
    // leave the pane with no shell at all.
    if let Ok(over) = std::env::var("GUIMUX_SHELL") {
        let over = over.trim().to_string();
        if !over.is_empty() {
            chain.push((over, vec![]));
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
    // -NoProfile: user $PROFILE scripts can add seconds per spawn and the
    // bootstrap below already sets the cwd itself, so profiles buy nothing.
    let ps_args = || {
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NoExit".to_string(),
            "-EncodedCommand".to_string(),
            encoded.clone(),
        ]
    };
    if let Some(p) = pwsh {
        if !chain.iter().any(|(s, _)| s.eq_ignore_ascii_case(&p)) {
            chain.push((p, ps_args()));
        }
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

/// cwd per live session id, so `pty_restart` can respawn in place.
static SPAWN_CWDS: std::sync::LazyLock<Mutex<HashMap<u64, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static SHELL_KINDS: std::sync::LazyLock<Mutex<HashMap<u64, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn shell_kind_for(shell: &str) -> &'static str {
    let name = Path::new(shell)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    match name.as_str() {
        "pwsh" | "powershell" => "powershell",
        "cmd" => "cmd",
        "fish" => "fish",
        "bash" | "sh" | "zsh" | "ksh" | "dash" => "posix",
        _ => "unknown",
    }
}

/// Output-before-attach fix: per-PTY ring buffer. The pump always appends
/// (cap 256KB, oldest dropped); live `pty:output-{id}` emits only after the
/// frontend sends explicit `pty_attach(id)`, which replays the buffer.
const REPLAY_CAP: usize = 256 * 1024;
/// H-003 caps: at most 64 live shells (24-pane UI + headroom), 1MB per write.
const MAX_SESSIONS: usize = 64;
const MAX_PTY_WRITE: usize = 1 << 20;
static BUFFERS: std::sync::LazyLock<Mutex<HashMap<u64, VecDeque<u8>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static ATTACHED: std::sync::LazyLock<Mutex<HashMap<u64, bool>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Exit-watcher epochs: restart/kill bumps the epoch so a stale watcher for
/// the old child never emits `pty:exit-{id}` at the reused numeric id.
static EPOCHS: std::sync::LazyLock<Mutex<HashMap<u64, u64>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Shells that died while their pane was unmounted (exit event fired with
/// no listener): `pty_alive` reports them so the remount shows Restart
/// instead of a bricked, prompt-less grid.
static EXITED: std::sync::LazyLock<Mutex<HashSet<u64>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn clamp_dims(cols: u16, rows: u16) -> (u16, u16) {
    // Lower bound (0-size wedges ConPTY rendering) + upper bound (a
    // 65535x65535 grid otherwise passes straight to ConPTY). M-007.
    (cols.clamp(1, 1000), rows.clamp(1, 500))
}

fn push_buffer(id: u64, epoch: u64, bytes: &[u8]) {
    // Epoch check BEFORE taking BUFFERS (lock order EPOCHS → BUFFERS, same
    // as bump_epoch_reset_buffer): a pump thread that read bytes just before
    // a restart/kill can never slip them into the reused id's fresh replay
    // buffer — the old window showed dead-shell garbage in restarted panes.
    let epochs = EPOCHS.lock().unwrap_or_else(|e| e.into_inner());
    if epochs.get(&id).copied() != Some(epoch) {
        return; // stale pump from a killed/restarted session
    }
    // VecDeque: dropping from the front never memmoves the retained tail
    // (M-003: Vec::drain shifted ~256KB on every 8KB read while detached).
    let mut map = BUFFERS.lock().unwrap_or_else(|e| e.into_inner());
    let buf = map.entry(id).or_default();
    buf.extend(bytes.iter().copied());
    let excess = buf.len().saturating_sub(REPLAY_CAP);
    buf.drain(..excess);
}

/// Spawn-latency caches: bootstrap base64 per cwd, resolved pwsh path once.
/// GUIMUX_SHELL bypasses the pwsh cache (env override must always win).
static BOOTSTRAP_CACHE: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static PWSH_CACHE: std::sync::LazyLock<Mutex<Option<Option<String>>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

fn cached_bootstrap(cwd: &str) -> String {
    {
        let map = BOOTSTRAP_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = map.get(cwd) {
            return s.clone();
        }
    }
    let s = base64_encode(&utf16le(&powershell_bootstrap(cwd)));
    BOOTSTRAP_CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(cwd.to_string(), s.clone());
    s
}

fn pty_debug() -> bool {
    std::env::var("GUIMUX_PTY_DEBUG").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false)
}

pub 
fn epoch_current(id: u64, epoch: u64) -> bool {
    EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).get(&id).copied() == Some(epoch)
}

fn next_epoch(id: u64) -> u64 {
    let mut map = EPOCHS.lock().unwrap_or_else(|e| e.into_inner());
    let e = map.get(&id).copied().unwrap_or(0) + 1;
    map.insert(id, e);
    e
}

/// Spawn/restart path: bump the epoch AND install a fresh replay buffer as
/// one logical step (EPOCHS → BUFFERS lock order, matching push_buffer) so
/// no stale pump can write between the bump and the reset.
fn bump_epoch_reset_buffer(id: u64) -> u64 {
    let e = next_epoch(id);
    BUFFERS.lock().unwrap_or_else(|e| e.into_inner()).insert(id, VecDeque::new());
    e
}

/// Watch the SHELL child (not the pty pipe): only a true shell death may
/// raise `pty:exit`. A reader EOF while the child still runs is a pipe
/// artifact — emitting exit there is what bricked panes when TUIs that
/// juggle console handles (opencode server child, bun runtime teardown)
/// made ConPTY deliver EOF early. Exit fires from
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
            EXITED.lock().unwrap_or_else(|e| e.into_inner()).insert(id);
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
                    let attached = ATTACHED.lock().unwrap_or_else(|e| e.into_inner()).get(&id).copied().unwrap_or(false);
                    if attached {
                        let _ = app.emit(&format!("pty:output-{id}"), buf[..n].to_vec());
                    } else {
                        // Attached panes have no reader for the replay buffer
                        // (pty_attach drained it), so rebuilding a 256KB copy
                        // per chunk only burned memory and memcpy.
                        push_buffer(id, epoch, &buf[..n]);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
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
    // Cap live shells: each holds a 256KB replay buffer (H-003).
    if state.sessions.lock().unwrap_or_else(|e| e.into_inner()).len() >= MAX_SESSIONS {
        return Err(format!(
            "too many live shells ({MAX_SESSIONS}); close a pane in another worktree and retry"
        ));
    }
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
    let mut shell_kind = "unknown";
    for (shell, shell_args) in &attempts {
        let mut cmd = CommandBuilder::new(shell.clone());
        for arg in shell_args {
            cmd.arg(arg);
        }
        cmd.cwd(&path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "guimux");
        #[cfg(not(windows))]
        {
            // Readline shells (bash) pick this up; other shells ignore it.
            // Never overrides an explicit user INPUTRC.
            if std::env::var_os("INPUTRC").is_none() {
                if let Some(path) = ensure_guimux_inputrc() {
                    cmd.env("INPUTRC", path);
                }
            }
        }
        match pair.slave.spawn_command(cmd) {
            Ok(c) => {
                if pty_debug() {
                    eprintln!("[gm-pty] id={id} process-started shell={shell} +{}ms", t_start.elapsed().as_millis());
                }
                child = Some(c);
                shell_kind = shell_kind_for(shell);
                break;
            }
            // Store-alias stub (code 5) or AV block: walk the chain.
            Err(e) => spawn_err = e.to_string(),
        }
    }
    // Failure paths after openpty: drop the master explicitly so ConPTY
    // handles (conhost/OpenConsole pipe ends) are torn down via Drop if
    // reader/writer extraction or every shell spawn failed. The pair/slave
    // drop follows immediately, so nothing lingers.
    let child = match child {
        Some(c) => c,
        None => {
            drop(pair);
            return Err(format!("failed to spawn shell: {spawn_err}"));
        }
    };
    let (reader, writer) = match (pair.master.try_clone_reader(), pair.master.take_writer()) {
        (Ok(r), Ok(w)) => (r, w),
        (Err(e), _) | (_, Err(e)) => {
            drop(pair);
            return Err(e.to_string());
        }
    };

    {
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.insert(
            id,
            PtyEntry {
                writer: Arc::new(Mutex::new(writer)),
                killer: child.clone_killer(),
                master: Arc::new(Mutex::new(pair.master)),
            },
        );
    }
    {
        let mut map = SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(id, cwd.clone());
    }
    SHELL_KINDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, shell_kind.to_string());
    ATTACHED.lock().unwrap_or_else(|e| e.into_inner()).insert(id, live);
    let epoch = bump_epoch_reset_buffer(id);

    // Exit authority = shell process liveness (GetExitCodeProcess), never
    // pipe EOF. The watcher owns the real Child; the stored killer stays
    // behind for pty_kill/pty_restart.
    spawn_exit_watcher(app.clone(), id, epoch, child);
    spawn_output_pump(app.clone(), id, epoch, reader, t_start);
    Ok(PtySession {
        id,
        cwd,
        shell_kind: shell_kind.to_string(),
    })
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
pub fn pty_attach(id: u64) -> Result<PtyAttach, String> {
    if !SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&id) {
        return Err("no such pty session".into());
    }
    ATTACHED.lock().unwrap_or_else(|e| e.into_inner()).insert(id, true);
    // ponytail: Vec<u8> serializes as a JSON number array (~3.5x bloat vs
    // raw bytes); kept because the frontend consumes number[] — switch both
    // to base64 together if replay size ever matters.
    let replay = BUFFERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id)
        .unwrap_or_default()
        .into_iter()
        .collect();
    let shell_kind = SHELL_KINDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    Ok(PtyAttach { replay, shell_kind })
}

#[command]
pub fn pty_detach(id: u64) {
    ATTACHED.lock().unwrap_or_else(|e| e.into_inner()).insert(id, false);
}

/// Liveness probe for remounts: false when the session is unknown OR its
/// shell already exited (e.g. while the pane sat unmounted on another
/// worktree). `pty_restart` still recovers such ids (cwd is retained).
#[command]
pub fn pty_alive(id: u64) -> bool {
    SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&id)
        && !EXITED.lock().unwrap_or_else(|e| e.into_inner()).contains(&id)
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
        let map = SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner());
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
    if data.len() > MAX_PTY_WRITE {
        return Err(format!("pty write too large ({} bytes > 1MB)", data.len()));
    }
    // Clone the per-session writer under the map lock, then release it
    // before blocking pipe I/O (H-003).
    let writer = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(&id).map(|e| e.writer.clone()).ok_or("no such pty session")?
    };
    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
    // Passthrough: xterm sends \r for Enter and ConPTY
    // wants it as-is. The old \r -> \r\r\n chain double-submitted every
    // Enter, which PSReadLine read as line-continuation (the stray `>>`).
    //write_all via MutexGuard deref
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

#[command]
pub fn pty_resize(state: State<PtyManager>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let _ = state;
    // A 0-size resize wedges ConPTY rendering (blank pane); clamp, never skip
    // (an early resize is still better than none for shells that query size).
    let (cols, rows) = clamp_dims(cols, rows);
    // M-007: error on unknown ids (pty_attach does) so resize-to-dead-pane
    // bugs surface instead of silently succeeding.
    // Clone the per-session master Arc under the sessions lock, then resize
    // with the lock released: a slow ConPTY resize can't stall other panes'
    // spawn/kill/write (and resize of a dead pane errors below).
    let master = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(&id).map(|e| e.master.clone()).ok_or("no such pty session")?
    };
    let dbg = pty_debug();
    if dbg {
        eprintln!("[gm-pty] id={id} pty_resize {cols}x{rows}");
    }
    let r = master.lock().unwrap_or_else(|e| e.into_inner()).resize(portable_pty::PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    if dbg {
        match &r {
            Ok(_) => eprintln!("[gm-pty] id={id} pty_resize {cols}x{rows} ok"),
            Err(e) => eprintln!("[gm-pty] id={id} pty_resize {cols}x{rows} ERR: {e}"),
        }
    }
    // Report instead of swallowing: a wedged ConPTY resize used to look like
    // success from the frontend's side.
    r.map_err(|e| format!("pty_resize failed: {e}"))
}

#[command]
pub fn pty_kill(state: State<PtyManager>, id: u64) -> Result<(), String> {
    let master_to_close = {
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.remove(&id).map(|mut entry| {
            // Killer handle = TerminateProcess on the shell HANDLE. Never
            // touches the exit-watcher's owned Child, which exits its poll
            // on its own.
            let _ = entry.killer.kill();
            entry.master
        })
    };
    // Drop the master OUTSIDE the sessions lock: portable-pty's Drop/close
    // tears down ConPTY handles and can block briefly. (The master Arc may
    // still be cloned-here-then-held by a concurrent resize; dropping our
    // Arc lets the last holder close the PTY.)
    drop(master_to_close);
    SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    SHELL_KINDS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    EXITED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    BUFFERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    ATTACHED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
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
    fn classifies_shells_for_safe_path_pasting() {
        assert_eq!(shell_kind_for(r"C:\Program Files\PowerShell\7\pwsh.exe"), "powershell");
        assert_eq!(shell_kind_for("cmd.exe"), "cmd");
        assert_eq!(shell_kind_for("/bin/bash"), "posix");
        assert_eq!(shell_kind_for("/usr/bin/fish"), "fish");
        assert_eq!(shell_kind_for("custom-shell"), "unknown");
    }

    #[test]
    fn alias_stub_rejected() {
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
        assert_eq!(clamp_dims(65535, 65535), (1000, 500));
    }

    #[test]
    fn replay_buffer_caps_oldest_first() {
        let id = 0xB0FFEBu64;
        BUFFERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).insert(id, 1);
        push_buffer(id, 1, &[b'a'; 10]);
        push_buffer(id, 1, &[b'b'; REPLAY_CAP + 100]);
        let buf = BUFFERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id).unwrap();
        assert_eq!(buf.len(), REPLAY_CAP);
        // oldest bytes ('a's) were dropped
        assert!(buf.iter().all(|&b| b == b'b'));
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    #[test]
    fn stale_pump_cannot_pollute_replay_buffer() {
        // Regression: a pump thread that read bytes just before a restart
        // could push them into the reused id's fresh replay buffer between
        // pty_kill's BUFFERS.remove and spawn_pair's insert.
        let id = 0x5EEDu64;
        BUFFERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).insert(id, 1);
        // old-epoch pump arrives AFTER the restart bumped the epoch
        push_buffer(id, 1, b"old-shell-garbage");
        let e2 = bump_epoch_reset_buffer(id);
        assert_ne!(e2, 1);
        push_buffer(id, 1, b"late stale bytes"); // must be dropped
        push_buffer(id, e2, b"fresh");
        let buf = BUFFERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id).unwrap();
        assert_eq!(buf, b"fresh".to_vec());
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    #[test]
    fn stale_epoch_is_not_current() {
        let id = 0xE90C4u64;
        let e1 = next_epoch(id);
        assert!(epoch_current(id, e1));
        let e2 = next_epoch(id);
        assert!(!epoch_current(id, e1));
        assert!(epoch_current(id, e2));
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    #[test]
    fn attach_rejects_unknown_session() {
        assert!(pty_attach(0xDEAD_DEAD).is_err());
    }

    #[test]
    fn detach_stops_live_delivery_until_reattach() {
        let id = 0xDE7A_C4u64;
        ATTACHED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, true);
        pty_detach(id);
        assert!(!ATTACHED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .copied()
            .unwrap_or(false));
        ATTACHED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }

    #[test]
    fn exited_session_reports_not_alive() {
        let id = 0xA11CEu64;
        SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).insert(id, "C:\\x".into());
        assert!(pty_alive(id));
        EXITED.lock().unwrap_or_else(|e| e.into_inner()).insert(id);
        assert!(!pty_alive(id));
        SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        EXITED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        assert!(!pty_alive(id));
    }

    #[test]
    fn bootstrap_cache_stable_per_cwd() {
        let a = cached_bootstrap("C:\\x");
        let b = cached_bootstrap("C:\\x");
        let c = cached_bootstrap("C:\\y");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn bootstrap_binds_word_kill_guarded() {
        let b = powershell_bootstrap("C:\\repo");
        assert!(b.contains("Ctrl+Backspace") && b.contains("BackwardKillWord"), "missing left-word binding");
        assert!(b.contains("Ctrl+Delete") && b.contains("KillWord"), "missing right-word binding");
        assert!(b.contains("Get-Module PSReadLine"), "binding must be guarded");
    }

}
