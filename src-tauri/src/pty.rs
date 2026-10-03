use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, Emitter, State};

#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use winapi::shared::minwindef::DWORD;
#[cfg(windows)]
use winapi::um::jobapi2::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
};
#[cfg(windows)]
use winapi::um::sysinfoapi::GetSystemDirectoryW;
#[cfg(windows)]
use winapi::um::winbase::CREATE_NO_WINDOW;
#[cfg(windows)]
use winapi::um::winnt::{
    JobObjectExtendedLimitInformation, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
};

#[cfg(not(windows))]
use crate::pty_inputrc::ensure_guimux_inputrc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySession {
    pub id: u64,
    pub cwd: String,
    pub shell_kind: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyAttach {
    pub replay: String,
    pub shell_kind: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyOutput {
    pub epoch: u64,
    pub bytes: String,
}

struct PtyEntry {
    // OrderedWriter keeps input in the order the frontend issued it while the
    // blocking pipe write stays off the IPC thread (see its own docs).
    writer: OrderedWriter,
    // Split ownership: the exit watcher owns the real Child (try_wait /
    // wait need &mut), while pty_kill drives this independent killer
    // handle (TerminateProcess on a process HANDLE — no &mut Child needed).
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    // Per-session master behind its own mutex: pty_resize clones the Arc and
    // resizes with the sessions lock released, so a slow ConPTY resize (an
    // RPC into conhost/OpenConsole) blocks only this pane — never another
    // pane's spawn/kill/write (was a global MASTERS lock).
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    #[cfg(windows)]
    process_id: Option<u32>,
    #[cfg(windows)]
    job: Option<OwnedHandle>,
}

/// Queue depth for the writer thread. Bounded so a shell that stops reading
/// cannot grow the queue without limit; past it, `pty_write` applies real
/// back-pressure instead of buffering a paste forever.
const WRITE_QUEUE_DEPTH: usize = 64;

/// Serializes writes to one PTY in the order they were queued.
///
/// `pty_write` has to stay a SYNC command: Tauri runs sync commands inline on
/// the single IPC thread in message order, so enqueueing there is FIFO. As an
/// async command each write became its own task and they contended for one
/// mutex in scheduler order — measured at 500/500 trials reordered on Windows,
/// where that mutex is a non-FIFO SRWLOCK. Reordered keystrokes in a terminal
/// are a correctness bug, so the blocking pipe write moved here instead of onto
/// the IPC thread.
#[derive(Clone)]
pub struct OrderedWriter {
    tx: std::sync::mpsc::SyncSender<Vec<u8>>,
}

impl OrderedWriter {
    fn new(mut sink: Box<dyn Write + Send>) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(WRITE_QUEUE_DEPTH);
        std::thread::spawn(move || {
            while let Ok(chunk) = rx.recv() {
                if sink.write_all(&chunk).is_err() {
                    break;
                }
                let _ = sink.flush();
            }
        });
        Self { tx }
    }

    fn send(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.tx
            .send(bytes)
            .map_err(|_| "pty session is gone".to_string())
    }
}

#[derive(Default)]
pub struct PtyManager {
    next_id: AtomicU64,
    next_slot: AtomicU64,
    slots: Arc<Mutex<HashMap<u64, u64>>>,
    // Arc so the exit watcher can reap the entry it watches for; a shell that
    // exits must not leave its writer thread or its capacity slot behind.
    sessions: Arc<Mutex<HashMap<u64, PtyEntry>>>,
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
            kill_entry(&mut entry);
            drop(entry.master);
        }
        SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).clear();
        SHELL_KINDS.lock().unwrap_or_else(|e| e.into_inner()).clear();
        OUTPUTS.lock().unwrap_or_else(|e| e.into_inner()).clear();
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).clear();
        EXITED.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.slots.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    fn reserve_slot(&self, id: u64) -> Result<u64, String> {
        let token = self
            .next_slot
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        if slots.contains_key(&id) {
            return Err(format!("pty session {id} already exists"));
        }
        if slots.len() >= MAX_SESSIONS {
            return Err(format!(
                "too many live shells ({MAX_SESSIONS}); close a pane in another worktree and retry"
            ));
        }
        slots.insert(id, token);
        Ok(token)
    }

    fn release_slot(&self, id: u64, token: u64) {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        if slots.get(&id) == Some(&token) {
            slots.remove(&id);
        }
    }
}

#[cfg(windows)]
fn create_process_job(
    child: &(dyn portable_pty::Child + Send + Sync),
) -> Result<OwnedHandle, String> {
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};

    let raw = unsafe { CreateJobObjectW(null_mut(), null()) };
    if raw.is_null() {
        return Err(format!(
            "CreateJobObjectW: {}",
            std::io::Error::last_os_error()
        ));
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw as _) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.as_raw_handle() as _,
            JobObjectExtendedLimitInformation,
            &mut limits as *mut _ as *mut _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
        )
    };
    if configured == 0 {
        return Err(format!(
            "SetInformationJobObject: {}",
            std::io::Error::last_os_error()
        ));
    }
    let process = child
        .as_raw_handle()
        .ok_or_else(|| "child has no Windows process handle".to_string())?;
    let assigned = unsafe { AssignProcessToJobObject(job.as_raw_handle() as _, process as _) };
    if assigned == 0 {
        return Err(format!(
            "AssignProcessToJobObject: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(job)
}

#[cfg(windows)]
fn system_taskkill() -> Option<PathBuf> {
    let mut buffer = [0u16; 260];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as DWORD) };
    if length == 0 || length as usize >= buffer.len() {
        return None;
    }
    let directory = std::ffi::OsString::from_wide(&buffer[..length as usize]);
    Some(PathBuf::from(directory).join("taskkill.exe"))
}

#[cfg(windows)]
fn kill_windows_tree(pid: u32) {
    let Some(taskkill) = system_taskkill() else {
        return;
    };
    let pid = pid.to_string();
    let _ = std::process::Command::new(taskkill)
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

fn kill_entry(entry: &mut PtyEntry) {
    #[cfg(windows)]
    {
        let mut terminated = false;
        if let Some(job) = entry.job.as_ref() {
            terminated = unsafe { TerminateJobObject(job.as_raw_handle() as _, 1) } != 0;
        }
        if !terminated {
            if let Some(pid) = entry.process_id {
                kill_windows_tree(pid);
            }
        }
    }
    let _ = entry.killer.kill();
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

/// Output-before-attach fix: per-PTY state makes the replay/attachment handoff
/// atomic. Detached output is capped at 256KB; attached output is emitted live.
const REPLAY_CAP: usize = 256 * 1024;
/// H-003 caps: at most 64 live shells (24-pane UI + headroom), 1MB per write.
const MAX_SESSIONS: usize = 64;
const MAX_PTY_WRITE: usize = 1 << 20;
struct OutputState {
    epoch: u64,
    attached: bool,
    replay: VecDeque<u8>,
}

#[derive(Debug, PartialEq)]
enum OutputDisposition {
    Emit,
    Buffered,
    Stale,
}

static OUTPUTS: std::sync::LazyLock<Mutex<HashMap<u64, OutputState>>> =
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

fn queue_output(id: u64, epoch: u64, bytes: &[u8]) -> OutputDisposition {
    let mut outputs = OUTPUTS.lock().unwrap_or_else(|e| e.into_inner());
    let Some(state) = outputs.get_mut(&id) else {
        return OutputDisposition::Stale;
    };
    if state.epoch != epoch {
        return OutputDisposition::Stale;
    }
    if state.attached {
        return OutputDisposition::Emit;
    }
    // VecDeque: dropping from the front never memmoves the retained tail
    // (M-003: Vec::drain shifted ~256KB on every 8KB read while detached).
    state.replay.extend(bytes.iter().copied());
    let excess = state.replay.len().saturating_sub(REPLAY_CAP);
    state.replay.drain(..excess);
    OutputDisposition::Buffered
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

/// Kill-side epoch bump, only for ids we actually handed out. `next_epoch`
/// always inserts, so bumping for an unknown id left a permanent EPOCHS entry
/// and the webview can call `pty_kill` with any id it likes.
fn bump_epoch_if_tracked(id: u64) {
    if EPOCHS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&id)
    {
        next_epoch(id);
    }
}

/// Spawn/restart path: install fresh output state with the new epoch so a
/// stale pump can neither append to replay nor emit into the new session.
fn reset_output(id: u64, attached: bool) -> u64 {
    let e = next_epoch(id);
    OUTPUTS.lock().unwrap_or_else(|e| e.into_inner()).insert(
        id,
        OutputState {
            epoch: e,
            attached,
            replay: VecDeque::new(),
        },
    );
    e
}

fn attach_output(id: u64) -> Option<(u64, Vec<u8>)> {
    let mut outputs = OUTPUTS.lock().unwrap_or_else(|e| e.into_inner());
    let state = outputs.get_mut(&id)?;
    state.attached = true;
    let epoch = state.epoch;
    let replay = std::mem::take(&mut state.replay).into_iter().collect();
    Some((epoch, replay))
}

fn detach_output(id: u64) {
    if let Some(state) = OUTPUTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&id)
    {
        state.attached = false;
    }
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
/// Drop a finished session's entry. Extracted so the reaping can be tested
/// against a real pipe without standing up a Tauri app: it is the only thing
/// that ends the writer thread for a shell that exited on its own.
fn reap_session(sessions: &Mutex<HashMap<u64, PtyEntry>>, id: u64) {
    sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
}

fn spawn_exit_watcher(
    app: AppHandle,
    id: u64,
    epoch: u64,
    slot: u64,
    slots: Arc<Mutex<HashMap<u64, u64>>>,
    sessions: Arc<Mutex<HashMap<u64, PtyEntry>>>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) {
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
            {
                let mut slots = slots.lock().unwrap_or_else(|e| e.into_inner());
                if slots.get(&id) == Some(&slot) {
                    slots.remove(&id);
                }
            }
            // Reap the entry. Nothing else removes one for a shell that just
            // exited: its writer thread would drain a dead pipe forever, and
            // the entry counts against MAX_SESSIONS, so enough exits would
            // refuse every later spawn with "too many live shells". Dropping
            // the entry drops the queue's last sender, which ends the thread.
            // Inside the epoch guard, so a stale watcher cannot reap the
            // replacement session that reused this id.
            reap_session(&sessions, id);
            EXITED.lock().unwrap_or_else(|e| e.into_inner()).insert(id);
            let _ = app.emit(&format!("pty:exit-{id}"), code as i32);
        }
    });
}

fn spawn_output_pump(
    app: AppHandle,
    id: u64,
    epoch: u64,
    mut reader: Box<dyn Read + Send>,
    t_start: std::time::Instant,
) {
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
                    if pty_debug() && first {
                        first = false;
                        eprintln!(
                            "[gm-pty] id={id} first-byte {}ms after spawn start",
                            t_start.elapsed().as_millis()
                        );
                    }
                    match queue_output(id, epoch, &buf[..n]) {
                        OutputDisposition::Emit => {
                            // Base64, not Vec<u8>: serde renders a byte vec as
                            // a JSON number array (~3.5x bloat on 8KB chunks).
                            let _ = app.emit(
                                &format!("pty:output-{id}"),
                                PtyOutput {
                                    epoch,
                                    bytes: base64_encode(&buf[..n]),
                                },
                            );
                        }
                        OutputDisposition::Buffered => {}
                        OutputDisposition::Stale => break,
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
    let slot = state.reserve_slot(id)?;
    let result = spawn_pair_inner(app, state, id, cwd, cols, rows, live, slot);
    if result.is_err() {
        state.release_slot(id, slot);
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn spawn_pair_inner(
    app: &AppHandle,
    state: &State<PtyManager>,
    id: u64,
    cwd: String,
    cols: u16,
    rows: u16,
    live: bool,
    slot: u64,
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
    let mut child = match child {
        Some(c) => c,
        None => {
            drop(pair);
            return Err(format!("failed to spawn shell: {spawn_err}"));
        }
    };
    #[cfg(windows)]
    let process_id = child.process_id();
    #[cfg(windows)]
    let job = match create_process_job(child.as_ref()) {
        Ok(job) => Some(job),
        Err(error) => {
            eprintln!("[gm-pty] id={id} process job unavailable: {error}");
            None
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
        // Cap under the insert lock: with pty_spawn async, N panes boot at once
        // and the old check-then-insert window let them all pass the cap.
        if sessions.len() >= MAX_SESSIONS {
            drop(sessions);
            let _ = child.kill();
            drop(pair);
            return Err(format!(
                "too many live shells ({MAX_SESSIONS}); close a pane in another worktree and retry"
            ));
        }
        sessions.insert(
            id,
            PtyEntry {
                writer: OrderedWriter::new(writer),
                killer: child.clone_killer(),
                master: Arc::new(Mutex::new(pair.master)),
                #[cfg(windows)]
                process_id,
                #[cfg(windows)]
                job,
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
    let epoch = reset_output(id, live);

    // Exit authority = shell process liveness (GetExitCodeProcess), never
    // pipe EOF. The watcher owns the real Child; the stored killer stays
    // behind for pty_kill/pty_restart.
    spawn_exit_watcher(
        app.clone(),
        id,
        epoch,
        slot,
        Arc::clone(&state.slots),
        Arc::clone(&state.sessions),
        child,
    );
    spawn_output_pump(app.clone(), id, epoch, reader, t_start);
    Ok(PtySession {
        id,
        cwd,
        shell_kind: shell_kind.to_string(),
        epoch,
    })
}

#[command(async)]
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
#[command(async)]
pub fn pty_attach(id: u64) -> Result<PtyAttach, String> {
    let (epoch, replay) = attach_output(id).ok_or("no such pty session")?;
    let shell_kind = SHELL_KINDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    Ok(PtyAttach {
        // Base64, not Vec<u8>: serde would render the replay as a JSON number
        // array; the frontend decodes it back to bytes.
        replay: base64_encode(&replay),
        shell_kind,
        epoch,
    })
}

#[command]
pub fn pty_detach(id: u64) {
    detach_output(id);
}

/// Liveness probe for remounts: false when the session is unknown OR its
/// shell already exited (e.g. while the pane sat unmounted on another
/// worktree). `pty_restart` still recovers such ids (cwd is retained).
#[command]
pub fn pty_alive(id: u64) -> bool {
    SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&id)
        && !EXITED.lock().unwrap_or_else(|e| e.into_inner()).contains(&id)
}

#[command(async)]
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

// Sync on purpose: the enqueue has to happen on the single IPC thread so
// queued bytes keep their order (see OrderedWriter). The body never touches
// the pipe, so a shell that stops reading cannot freeze the window — it can
// only fill the bounded queue and apply back-pressure.
#[command]
pub fn pty_write(state: State<PtyManager>, id: u64, data: String) -> Result<(), String> {
    if data.len() > MAX_PTY_WRITE {
        return Err(format!("pty write too large ({} bytes > 1MB)", data.len()));
    }
    // Clone the per-session writer under the map lock, then release it
    // before the (bounded) queue wait (H-003).
    let writer = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(&id).map(|e| e.writer.clone()).ok_or("no such pty session")?
    };
    // Passthrough: xterm sends \r for Enter and ConPTY
    // wants it as-is. The old \r -> \r\r\n chain double-submitted every
    // Enter, which PSReadLine read as line-continuation (the stray `>>`).
    writer.send(data.into_bytes())
}

#[command(async)]
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

// (async): TerminateJobObject, and the taskkill /T /F fallback, block on the
// process tree; closing a pane that hosts agents froze the window for seconds.
#[command(async)]
pub fn pty_kill(state: State<PtyManager>, id: u64) -> Result<(), String> {
    let master_to_close = {
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.remove(&id).map(|mut entry| {
            // The job/tree kill includes descendants; the portable-pty killer
            // remains the fallback for hosts without a Windows job.
            kill_entry(&mut entry);
            entry.master
        })
    };
    // Drop the master OUTSIDE the sessions lock: portable-pty's Drop/close
    // tears down ConPTY handles and can block briefly. (The master Arc may
    // still be cloned-here-then-held by a concurrent resize; dropping our
    // Arc lets the last holder close the PTY.)
    drop(master_to_close);
    state
        .slots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    SPAWN_CWDS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    SHELL_KINDS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    EXITED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    OUTPUTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    // Bump the epoch so the dead child's watcher can never emit exit at this
    // id again (matters for restart, which reuses the id right after).
    bump_epoch_if_tracked(id);
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
    fn base64_encode_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(b"hi"), "aGk=");
        assert_eq!(base64_encode(b"test"), "dGVzdA==");
        assert_eq!(base64_encode(&[0x00, 0xff, 0x10]), "AP8Q");
    }

    #[test]
    fn classifies_shells_for_safe_path_pasting() {
        assert_eq!(shell_kind_for("/bin/bash"), "posix");
        assert_eq!(shell_kind_for("/usr/bin/fish"), "fish");
        assert_eq!(shell_kind_for("custom-shell"), "unknown");
    }

    #[cfg(windows)]
    #[test]
    fn classifies_windows_shells_for_safe_path_pasting() {
        assert_eq!(shell_kind_for(r"C:\Program Files\PowerShell\7\pwsh.exe"), "powershell");
        assert_eq!(shell_kind_for("cmd.exe"), "cmd");
    }

    #[test]
    fn alias_stub_rejected() {
        assert!(!is_real_exe(std::path::Path::new(
            "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"
        )));
    }

    #[cfg(windows)]
    #[test]
    fn taskkill_fallback_uses_system_directory() {
        let path = system_taskkill().expect("system directory");
        assert!(path.is_absolute());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("taskkill.exe")
        );
    }

    /// The freeze this queue was built to avoid: a bounded channel blocks
    /// whoever fills it, and `pty_write` is a sync command on the single IPC
    /// thread. The pipe is not free either: a ConPTY whose child never reads
    /// stdin still meters input, sustained at ~0.35 MB/s for 1-8KB chunks
    /// over an 8s flood and ~1.25 MB/s at 64KB, though its own console
    /// buffer swallows the first few hundred KB. So a producer that saturates
    /// the pipe is limited by the pipe, and an assertion sized to 16MB
    /// measures that rate instead of the bug: 16MB needs ~45s at the slow
    /// end, and the 30s budget this test used to carry lost the race on a
    /// loaded box (231 of 256 chunks).
    ///
    /// What is worth pinning is the queue. Push well past WRITE_QUEUE_DEPTH
    /// with a payload any real paste fits in, and every send has to land
    /// inside the budget: if the drain thread ever stops draining, the queue
    /// fills at 64 chunks and the first send past that blocks forever, which
    /// is the freeze this test exists to catch.
    #[cfg(windows)]
    #[test]
    fn a_shell_that_never_reads_stdin_still_drains_the_write_queue() {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut command = CommandBuilder::new("powershell.exe");
        command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 120"]);
        let mut child = pair.slave.spawn_command(command).expect("child");
        let master = pair.master;
        // Drain output the way the output pump does, so the output side is
        // never what we are measuring.
        let mut reader = master.try_clone_reader().expect("reader");
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = std::io::Read::read(&mut reader, &mut buf) {
                if n == 0 {
                    break;
                }
            }
        });
        let writer = OrderedWriter::new(master.take_writer().expect("writer"));

        let sends = WRITE_QUEUE_DEPTH + 32;
        let chunk = vec![b'x'; 4 * 1024];
        let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = accepted.clone();
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let w = writer.clone();
        std::thread::spawn(move || {
            for _ in 0..sends {
                if w.send(chunk.clone()).is_err() {
                    break;
                }
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            let _ = tx.send(true);
        });

        // 96 chunks of 4KB is 384KB, a paste bigger than any terminal sees,
        // and 32 chunks more than the queue holds, so the drain thread has to
        // have moved at least that many for the producer to finish. Even at
        // 20KB/s that is 20s of budget for a fifth of a megabyte.
        let drained = rx
            .recv_timeout(std::time::Duration::from_secs(20))
            .is_ok();
        assert!(
            child.try_wait().expect("poll child").is_none(),
            "the child must stay alive"
        );
        assert!(
            drained,
            "the writer stalled: only {} of {sends} chunks were accepted",
            accepted.load(std::sync::atomic::Ordering::SeqCst)
        );
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), sends);
        let _ = child.kill();
        let _ = child.wait();
    }

    /// The quiet failure this reaps: a shell that exits on its own left its
    /// entry — and so its writer thread — in place forever, because only
    /// pty_kill/pty_restart removed one. The thread kept draining a dead pipe
    /// silently, and every lingering entry counted against MAX_SESSIONS, so
    /// enough exits refused every later spawn with "too many live shells".
    /// The quiet failure this reaps: a shell that exits on its own left its
    /// entry — and so its writer thread — in place forever, because only
    /// pty_kill/pty_restart removed one. The thread kept draining a dead pipe
    /// silently, and every lingering entry counted against MAX_SESSIONS, so
    /// enough exits refused every later spawn with "too many live shells".
    /// Dropping the entry also drops the queue's last sender, which is what
    /// ends the writer thread (std mpsc recv fails once no sender remains).
    #[cfg(windows)]
    #[test]
    fn reaping_a_finished_session_frees_its_entry() {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/C", "exit"]);
        let mut child = pair.slave.spawn_command(command).expect("child");
        let master = pair.master;
        let sessions: Mutex<HashMap<u64, PtyEntry>> = Mutex::new(HashMap::new());
        sessions.lock().unwrap().insert(
            4242,
            PtyEntry {
                writer: OrderedWriter::new(master.take_writer().expect("writer")),
                killer: child.clone_killer(),
                master: Arc::new(Mutex::new(master)),
                process_id: None,
                job: None,
            },
        );
        let _ = child.wait();
        assert_eq!(sessions.lock().unwrap().len(), 1);

        reap_session(&sessions, 4242);

        assert!(sessions.lock().unwrap().is_empty(), "the entry was not reaped");
        // What pty_write does: it looks the session up, so a reaped one now
        // reports "no such pty session" instead of queueing into a pipe that
        // nobody drains any more.
        assert!(
            sessions.lock().unwrap().get(&4242).is_none(),
            "a write to a finished session would still be swallowed silently"
        );

        // And the watcher is what has to do it, on the exit path. Checked
        // against the source because the watcher needs an AppHandle to run.
        let src = include_str!("pty.rs");
        let body = &src[src.find("fn spawn_exit_watcher").expect("watcher")..];
        let body = &body[..body.find("
}").expect("watcher body")];
        assert!(
            body.contains("reap_session(&sessions, id)"),
            "the exit watcher no longer reaps the session: {body}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn process_job_terminates_real_pty_child() {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("pty");
        let mut command = CommandBuilder::new("cmd.exe");
        command.arg("/K");
        let mut child = pair.slave.spawn_command(command).expect("child");
        let job = create_process_job(child.as_ref()).expect("assign process job");
        assert!(child.try_wait().expect("poll child").is_none());
        assert!(unsafe { TerminateJobObject(job.as_raw_handle() as _, 1) } != 0);
        std::thread::sleep(std::time::Duration::from_millis(120));
        assert!(child.try_wait().expect("wait child").is_some());
    }

    struct Recorder {
        seen: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for Recorder {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.seen.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn queued_writes_drain_in_the_order_they_were_queued() {
        // The regression this guards: as an async command each write raced the
        // others for one mutex and arrived scrambled (500/500 trials measured).
        // Chunks are multi-byte and self-identifying so any reordering or
        // splitting is visible, and the run deliberately exceeds the queue
        // depth so the back-pressure wait is covered too.
        let seen = Arc::new(Mutex::new(Vec::new()));
        let writer = OrderedWriter::new(Box::new(Recorder {
            seen: seen.clone(),
        }));
        let chunks: Vec<Vec<u8>> = (0..(WRITE_QUEUE_DEPTH as u16 * 4))
            .map(|i| format!("[{i:04}]").into_bytes())
            .collect();
        let want: Vec<u8> = chunks.concat();
        for chunk in &chunks {
            writer.send(chunk.clone()).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while seen.lock().unwrap_or_else(|e| e.into_inner()).len() < want.len()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let got = seen.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert_eq!(
            got.len(),
            want.len(),
            "writer thread did not drain the queue"
        );
        assert_eq!(
            got, want,
            "queued writes reached the sink out of order"
        );
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
        EPOCHS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, 0);
        let epoch = reset_output(id, false);
        assert_eq!(
            queue_output(id, epoch, &[b'a'; 10]),
            OutputDisposition::Buffered
        );
        assert_eq!(
            queue_output(id, epoch, &[b'b'; REPLAY_CAP + 100]),
            OutputDisposition::Buffered
        );
        let (_, buf) = attach_output(id).unwrap();
        assert_eq!(buf.len(), REPLAY_CAP);
        // oldest bytes ('a's) were dropped
        assert!(buf.iter().all(|&b| b == b'b'));
        assert_eq!(queue_output(id, epoch, b"live"), OutputDisposition::Emit);
        OUTPUTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    #[test]
    fn stale_pump_cannot_pollute_replay_buffer() {
        // Regression: a pump thread that read bytes just before a restart
        // could push them into the reused id's fresh replay buffer between
        // pty_kill's output-state removal and spawn_pair's replacement.
        let id = 0x5EEDu64;
        EPOCHS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, 0);
        let e1 = reset_output(id, false);
        assert_eq!(
            queue_output(id, e1, b"old-shell-garbage"),
            OutputDisposition::Buffered
        );
        let e2 = reset_output(id, false);
        assert_ne!(e2, 1);
        assert_eq!(
            queue_output(id, e1, b"late stale bytes"),
            OutputDisposition::Stale
        );
        assert_eq!(queue_output(id, e2, b"fresh"), OutputDisposition::Buffered);
        let (_, buf) = attach_output(id).unwrap();
        assert_eq!(buf, b"fresh".to_vec());
        OUTPUTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
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
    fn killing_an_unknown_id_leaves_no_epoch_entry() {
        let id = 0x5A5A_5A5Au64;
        EPOCHS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        bump_epoch_if_tracked(id);
        assert!(!EPOCHS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&id));

        // A real session still gets bumped, so its pending watcher goes stale.
        let live = next_epoch(id);
        assert!(epoch_current(id, live));
        bump_epoch_if_tracked(id);
        assert!(!epoch_current(id, live));
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    #[test]
    fn detach_stops_live_delivery_until_reattach() {
        let id = 0x00DE_7AC4_u64;
        EPOCHS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, 0);
        let epoch = reset_output(id, true);
        pty_detach(id);
        assert_eq!(
            queue_output(id, epoch, b"buffered"),
            OutputDisposition::Buffered
        );
        OUTPUTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        EPOCHS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    #[test]
    fn exited_shells_release_capacity_without_stale_release() {
        let manager = PtyManager::default();
        let mut tokens = Vec::new();
        for id in 0..MAX_SESSIONS as u64 {
            tokens.push(manager.reserve_slot(id).unwrap());
        }
        assert!(manager.reserve_slot(MAX_SESSIONS as u64).is_err());

        manager.release_slot(0, tokens[0]);
        let replacement = manager.reserve_slot(MAX_SESSIONS as u64).unwrap();
        manager.release_slot(0, tokens[0]);
        assert_eq!(
            manager
                .slots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&(MAX_SESSIONS as u64)),
            Some(&replacement)
        );
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
