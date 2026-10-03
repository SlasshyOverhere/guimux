use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::command;

/// Recovering an agent's session name from the files it writes.
///
/// The pane header prefers the terminal title (OSC 0/2), which costs nothing
/// and is instant. Not every agent sets one, so this is the fallback, and the
/// two supported agents store their name very differently:
///
///   claude  `~/.claude/projects/<slug>/<session>.jsonl` gains an
///           `{"type":"ai-title","aiTitle":"...","sessionId":"..."}` record once
///           it names the conversation. Verified on disk: 145 transcripts carry
///           it, and the record sits at ~99% of file length in files up to 41MB,
///           which is why only the tail is read.
///
///   codex   `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` stores no
///           name at all. The name lives in a side index,
///           `~/.codex/session_index.jsonl`, as `{"id","thread_name","updated_at"}`.
///           The rollout's own first record carries the `cwd` and the `id`, which
///           is how a pane finds its session. Verified on disk: the uuid in the
///           filename equals `session_meta.payload.id` in every rollout, so the
///           two files join. Codex writes no name until the conversation has one.
///
/// OpenCode keeps sessions in SQLite and has no joinable record, so it is not
/// supported. Adding an agent is another match arm here, not a new command.
///
/// Both agents stamp records with the same UTC ISO-8601 shape
/// (`2026-09-29T19:02:55.425Z`), verified across 66 rollouts and 312
/// transcripts, which is what `iso_millis` accepts.
///
/// Two panes in one directory is the case this file exists to get right: their
/// transcripts are identical apart from time and no process id is recorded, so
/// panes are matched to sessions by launch order in `resolve_panes`, one call
/// for the whole directory.
///
/// The title record lives near the end; this is generous and still bounded.
const TAIL_BYTES: u64 = 256 * 1024;
/// The session's own identity is in its first records, so this starts tiny.
/// It is only a starting point: see `read_head`.
const HEAD_BYTES: u64 = 16 * 1024;
/// Ceiling for `read_head`. Measured on disk: the opening record of both agents
/// carries the model instructions and reaches 65KB, so a fixed 16KB window holds
/// one unparseable fragment and no identity at all.
const MAX_HEAD_BYTES: u64 = 256 * 1024;
const MAX_TITLE: usize = 120;
/// Bound on the Codex walk. Rollouts accumulate forever; a UI poll must not
/// grow with them. The date-partitioned layout is the lever if this ever hurts.
const MAX_CODEX_ENTRIES: usize = 4_000;
const MAX_CODEX_HEADS: usize = 80;
const MAX_CODEX_DEPTH: usize = 5;
const MAX_INDEX_BYTES: u64 = 4 * 1024 * 1024;
/// Sessions kept per directory and panes asked per call. guimux cannot put more
/// than a dozen agent tiles in a worktree anyway.
const MAX_SESSIONS: usize = 16;
const MAX_PANES: usize = 16;
/// How far before a pane's launch a session may start and still be its own: a
/// transcript's first record trails the file's creation by ~1.6s (Claude).
const SLACK_MS: u64 = 2_000;

/// Claude Code mangles the project directory by replacing every character that
/// is not a letter or digit with '-'. `D:\orca-workspace\guimux` becomes
/// `D--orca-workspace-guimux`, and `C:\Users\suman\AppData\Local\Temp\x` becomes
/// `C--Users-suman-AppData-Local-Temp-x`. Both confirmed against real folders.
fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn unix_millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Days from the civil epoch (1970-01-01), after Howard Hinnant's algorithm.
/// Only used to turn a parsed UTC timestamp into milliseconds.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // March = 0
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// `2026-09-29T19:02:55.425Z` -> millis. Returns None for anything else,
/// including a local-offset form: a guessed timestamp would misattribute a
/// session, and a missing one merely shows no name.
fn iso_millis(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.trim().parse::<i64>().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut ms = (days_from_civil(y, mo, d) * 86_400 + h * 3_600 + mi * 60 + sec) * 1000;
    // Nothing but optional fraction digits and a `Z` may follow: an offset means
    // the stamp is not UTC and cannot be compared against a local clock.
    for &c in &b[19..] {
        if !matches!(c, b'.' | b'Z' | b'0'..=b'9') {
            return None;
        }
    }
    // Optional fractional seconds; 1-3 digits are all that occur on disk.
    let tail = &s[19..];
    let frac: String = tail.chars().take_while(|c| *c == '.' || c.is_ascii_digit()).collect();
    if let Some(digits) = frac.strip_prefix('.') {
        let mut scaled = 0i64;
        let mut n = 0;
        for c in digits.chars().take(3) {
            scaled = scaled * 10 + c.to_digit(10).unwrap_or(0) as i64;
            n += 1;
        }
        while n < 3 {
            scaled *= 10;
            n += 1;
        }
        ms += scaled;
    }
    u64::try_from(ms).ok()
}

/// Pull the last `aiTitle` out of a Claude Code transcript tail.
///
/// Scans backwards so the newest title wins (a session can be renamed), skips
/// the partial first line left by the seek, and ignores any line that does not
/// parse rather than giving up on the whole file.
fn title_from_tail(tail: &str) -> Option<String> {
    let mut lines: Vec<&str> = tail.lines().collect();
    lines.reverse();
    for line in lines {
        if !line.contains("\"ai-title\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("ai-title") {
            continue;
        }
        let Some(raw) = v.get("aiTitle").and_then(|t| t.as_str()) else {
            continue;
        };
        let cleaned = raw.trim();
        if cleaned.is_empty() {
            continue;
        }
        return Some(cleaned.chars().take(MAX_TITLE).collect());
    }
    None
}

fn read_range(path: &Path, from: u64, len: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    let total = file.metadata().ok()?.len();
    let start = from.min(total.saturating_sub(len));
    let mut file = file;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.take(len).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        // A seek can land mid-record; the first fragment is not a whole line.
        return match text.find('\n') {
            Some(i) => Some(text[i + 1..].to_string()),
            None => Some(String::new()),
        };
    }
    Some(text)
}

/// The opening records, with a window big enough to hold a whole first line.
fn read_head(path: &Path) -> Option<String> {
    let mut len = HEAD_BYTES;
    while len <= MAX_HEAD_BYTES {
        let text = read_range(path, 0, len)?;
        if text.contains('\n') {
            return Some(text);
        }
        len *= 4;
    }
    None
}

/// When the session in this file began, from the earliest timestamp in its
/// opening records.
///
/// mtime is the wrong thing to filter on: a long-running session keeps
/// touching its file, so an old session would look newer than the pane that
/// just launched and get its name put on the wrong header. 14 of the 40 newest
/// Claude transcripts carry no timestamp on their very first record, so this
/// scans the head rather than reading line one.
fn session_start_ms(path: &Path) -> Option<u64> {
    let head = read_head(path)?;
    let mut earliest: Option<u64> = None;
    for line in head.lines().take(12) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) else {
            continue;
        };
        if let Some(ms) = iso_millis(ts) {
            earliest = Some(earliest.map_or(ms, |e: u64| e.min(ms)));
        }
    }
    earliest
}

/// One line of a prompt, cleaned to something a 28px pane header can carry.
const MAX_PROMPT: usize = 60;

/// The prose of a `content` field: a bare string, or the first block carrying
/// text. The block type is not matched on purpose: Claude writes `text`, Codex
/// writes `input_text`, and a tool result block has `content` rather than
/// `text`, so looking for the key finds prose and leaves results out.
fn content_text(content: Option<&serde_json::Value>) -> Option<String> {
    match content? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(blocks) => blocks.iter().find_map(|b| {
            b.get("text")
                .and_then(|t| t.as_str())
                .map(|t| t.to_string())
                .filter(|t| !t.trim().is_empty())
        }),
        _ => None,
    }
}

/// Turn raw prompt text into a header label: one line, no markers, short.
///
/// A prompt is whatever the user typed, so it arrives as prose, as an injected
/// marker (`<command-name>/clear</command-name>`), as a pasted image
/// (`[Image #1 …]`) or as a wall of tool output. Only the prose is a label.
fn prompt_label(raw: &str) -> Option<String> {
    let flat: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut text = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    // Drop leading wrappers: `<command-name>/clear</command-name>` and
    // `[Image #1 …]` are the agent's bookkeeping, not something the user wrote.
    for _ in 0..3 {
        if let Some(rest) = text.strip_prefix('<') {
            let Some(close) = rest.find("</") else { break };
            let Some(end) = rest[close..].find('>') else { break };
            text = rest[close + end + 1..].split_whitespace().collect::<Vec<_>>().join(" ");
            continue;
        }
        if text.starts_with('[') {
            let Some(end) = text.find(']') else { break };
            text = text[end + 1..].split_whitespace().collect::<Vec<_>>().join(" ");
            continue;
        }
        break;
    }
    let text = text.trim().trim_matches(['*', '#', '`']).trim();
    // No letters means an image placeholder, a path fragment or a number.
    if text.chars().count() < 3 || !text.chars().any(char::is_alphabetic) {
        return None;
    }
    if text.chars().count() <= MAX_PROMPT {
        return Some(text.to_string());
    }
    let cut = text
        .char_indices()
        .nth(MAX_PROMPT.saturating_sub(1))
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    Some(format!("{}\u{2026}", text[..cut].trim_end()))
}

/// Pull the last prompt a human typed out of a Claude Code transcript tail.
///
/// Verified on disk: a `user` record is written both for every prompt and for
/// every tool result (943 of 991 in one project), plus injected `isMeta`
/// records, so the tool and meta ones are skipped rather than shown.
fn prompt_from_claude_tail(tail: &str) -> Option<String> {
    for line in tail.lines().rev() {
        if !line.contains("\"user\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") || v.get("toolUseResult").is_some() {
            continue;
        }
        if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false)
            || v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false)
        {
            continue;
        }
        let Some(text) = content_text(v.get("message").and_then(|m| m.get("content"))) else {
            continue;
        };
        if let Some(label) = prompt_label(&text) {
            return Some(label);
        }
    }
    None
}

/// Pull the last prompt a human typed out of a Codex rollout tail.
///
/// Codex writes a typed prompt twice: as an `event_msg`/`item_completed`
/// carrying a `UserMessage` item, and as the model's own `response_item` with
/// role `user`. Only the first shape is read, because the second also carries
/// the context Codex injects at startup — the `AGENTS.md` instructions,
/// `<recommended_plugins>`, `<environment_context>` — which is not something
/// anyone typed and makes a useless label. Measured over 59 rollouts on disk:
/// every typed prompt has the first shape, and the injected records have only
/// the second. A session whose first prompt has not landed yet therefore has
/// no label, which is right: there is nothing of the user's to show.
fn prompt_from_codex_tail(tail: &str) -> Option<String> {
    for line in tail.lines().rev() {
        if !line.contains("UserMessage") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(pl) = v.get("payload") else { continue };
        if pl.get("type").and_then(|t| t.as_str()) != Some("item_completed") {
            continue;
        }
        let Some(item) = pl.get("item") else { continue };
        if item.get("type").and_then(|t| t.as_str()) != Some("UserMessage") {
            continue;
        }
        if let Some(label) = content_text(item.get("content")).as_deref().and_then(prompt_label) {
            return Some(label);
        }
    }
    None
}

/// Codex writes no name of its own, so an unnamed session's label is read from
/// the rollout tail. Only the panes' own sessions get here, and only while they
/// are still unnamed.
fn codex_prompt(source: &str) -> Option<String> {
    let path = Path::new(source);
    let len = path.metadata().ok()?.len();
    let tail = read_range(path, len.saturating_sub(TAIL_BYTES), TAIL_BYTES).unwrap_or_default();
    prompt_from_codex_tail(&tail)
}

/// Paths are compared case-insensitively: Windows reports the same directory
/// with different casing across calls, and a false mismatch is a blank header.
fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        p.trim()
            .trim_end_matches(['/', '\\'])
            .replace('/', "\\")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<(u64, PathBuf)>, budget: &mut usize) {
    if depth > MAX_CODEX_DEPTH || *budget == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, depth + 1, out, budget);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let mtime = entry.metadata().map(|m| m.modified().map(unix_millis).unwrap_or(0)).unwrap_or(0);
            out.push((mtime, path));
        }
    }
}

/// One session an agent has started in a directory, as the filesystem sees it.
struct FoundSession {
    /// When the session began, from its own records (never from mtime).
    started_ms: u64,
    /// None when the agent has not named the conversation yet.
    title: Option<String>,
    /// Last prompt, used as the label until a name turns up. Read from the tail
    /// Claude always reads; Codex fills it in only for a pane's own session.
    prompt: Option<String>,
    /// File the label came from, for the pane's tooltip.
    source: String,
}

/// Codex sessions in `cwd` that began at or after `since_ms`, oldest first.
fn codex_sessions(home: &Path, cwd: &str, since_ms: u64) -> Vec<FoundSession> {
    let sessions_dir = home.join(".codex").join("sessions");
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    let mut budget = MAX_CODEX_ENTRIES;
    collect_rollouts(&sessions_dir, 0, &mut files, &mut budget);
    // Newest first: the panes' sessions are recent by construction.
    files.sort_by_key(|f| std::cmp::Reverse(f.0));

    let mut out: Vec<FoundSession> = Vec::new();
    let mut examined = 0usize;
    for (mtime, path) in files {
        if examined >= MAX_CODEX_HEADS || out.len() >= MAX_SESSIONS {
            break;
        }
        // Cheap pre-filter: a rollout no pane started cannot be one of theirs.
        // mtime is never used to accept a session, only to reject one.
        if since_ms > 0 && mtime + SLACK_MS < since_ms {
            continue;
        }
        examined += 1;
        let Some(head) = read_head(&path) else { continue };
        let mut meta = None;
        for line in head.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
                meta = v.get("payload").cloned();
                break;
            }
        }
        let Some(meta) = meta else { continue };
        let Some(meta_cwd) = meta.get("cwd").and_then(|c| c.as_str()) else {
            continue;
        };
        if !same_dir(meta_cwd, cwd) {
            continue;
        }
        // Start time, not mtime: see `session_start_ms`.
        let started = meta
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(iso_millis)
            .or_else(|| session_start_ms(&path));
        let Some(started) = started else { continue };
        if since_ms > 0 && started + SLACK_MS < since_ms {
            continue;
        }
        out.push(FoundSession {
            started_ms: started,
            title: None,
            prompt: None,
            source: path.to_string_lossy().into_owned(),
        });
    }
    out.sort_by_key(|f| f.started_ms);

    // One index read for the whole directory rather than one per rollout. The
    // uuid in the filename equals `session_meta.payload.id` in every rollout on
    // disk, so the two join without reopening the file.
    let text = read_range(&home.join(".codex").join("session_index.jsonl"), 0, MAX_INDEX_BYTES).unwrap_or_default();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(id) = v.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        let name = v.get("thread_name").and_then(|n| n.as_str()).unwrap_or_default().trim();
        if name.is_empty() {
            continue;
        }
        let Some(found) = out.iter_mut().find(|f| {
            Path::new(&f.source)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.contains(id))
        }) else {
            continue;
        };
        found.title = Some(name.chars().take(MAX_TITLE).collect());
    }
    out
}

/// Claude Code sessions in `cwd` that began at or after `since_ms`, oldest first.
fn claude_sessions(home: &Path, cwd: &str, since_ms: u64) -> Vec<FoundSession> {
    let dir: PathBuf = home.join(".claude").join("projects").join(project_slug(cwd));
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    // (start, path, length). Only the newest MAX_SESSIONS are read further: a
    // transcript tail is 256KB, and a directory with more live sessions than
    // that cannot be attributed to panes safely anyway.
    let mut found: Vec<(u64, PathBuf, u64)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // Direct children only: `subagents/` holds nested transcripts that
        // belong to a sub-agent, not to a pane.
        if path.parent() != Some(dir.as_path()) || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        // One unreadable entry must not abandon the whole directory.
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let started = session_start_ms(&path).unwrap_or_else(|| meta.modified().map(unix_millis).unwrap_or(0));
        if since_ms > 0 && started + SLACK_MS < since_ms {
            continue;
        }
        found.push((started, path, meta.len()));
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found.truncate(MAX_SESSIONS);

    let mut out = Vec::with_capacity(found.len());
    for (started, path, len) in found.into_iter().rev() {
        let tail = read_range(&path, len.saturating_sub(TAIL_BYTES), TAIL_BYTES).unwrap_or_default();
        out.push(FoundSession {
            started_ms: started,
            title: title_from_tail(&tail),
            prompt: prompt_from_claude_tail(&tail),
            source: path.to_string_lossy().into_owned(),
        });
    }
    out
}

/// A pane asking for the session it started.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneAsk {
    pub id: String,
    /// When the pane launched its agent, ms since epoch. A pane without one has
    /// no floor and cannot be told apart from history, so it is never asked.
    pub since_ms: Option<u64>,
}

/// A pane that got a name, and how it was matched.
#[derive(Serialize)]
pub struct ResolvedTitle {
    pub id: String,
    pub title: String,
    pub source: String,
    /// True when the pane was told its session by launch order instead of being
    /// the only candidate, so the header can say which it was.
    pub matched: bool,
    /// "name" for a real conversation name, "prompt" for the last prompt used
    /// as a stand-in until the agent names it. The header has to say which: a
    /// prompt is the user's own words, not something they chose to call it.
    pub via: &'static str,
}

/// Hand every pane in a directory the session that is actually its own.
///
/// Two panes running an agent in one directory write two transcripts identical
/// apart from time, and neither agent records a process id, so the only thing
/// left to match on is order: guimux launches panes in order, an agent creates
/// its session file within about a second of starting (measured on disk: median
/// 1.0s for Codex, 1.6s for Claude), and the first record carries that start.
/// When the session count and the pane count agree, the oldest session is the
/// oldest pane's and the mapping is forced. Any other count means a session
/// started that no pane owns, or a pane never started one, and order says
/// nothing: each pane then takes the one session no other pane has claimed, in
/// launch order, so a pane whose own session file has not been written yet
/// leaves its neighbour's name alone.
fn resolve_panes(asks: &[(String, u64)], sessions: &mut [FoundSession]) -> Vec<(String, usize, bool)> {
    sessions.sort_by_key(|f| f.started_ms);
    // Stable, so a fan-out keeps the launch order the frontend sent: every pane
    // in one batch shares a single timestamp and only the order separates them.
    let mut panes: Vec<&(String, u64)> = asks.iter().collect();
    panes.sort_by_key(|p| p.1);

    // (pane id, session index, matched by order). Labelling happens once, after
    // this, so only the sessions a pane really owns are ever read.
    let forced = sessions.len() == panes.len()
        && panes
            .iter()
            .zip(sessions.iter())
            .all(|(pane, session)| session.started_ms + SLACK_MS >= pane.1);
    if forced {
        return panes
            .iter()
            .zip(sessions.iter().enumerate())
            .map(|(pane, (idx, _))| (pane.0.clone(), idx, panes.len() > 1))
            .collect();
    }
    let mut claimed = vec![false; sessions.len()];
    let mut out = Vec::new();
    for pane in panes {
        let hits: Vec<usize> = (0..sessions.len())
            .filter(|i| !claimed[*i] && sessions[*i].started_ms + SLACK_MS >= pane.1)
            .collect();
        let [only] = hits[..] else { continue };
        claimed[only] = true;
        out.push((pane.0.clone(), only, false));
    }
    out
}

/// What to show for a paired session: its name, or the last prompt standing in
/// for one until the agent gets round to naming it.
fn label_for(bin: &str, session: &FoundSession) -> Option<(String, &'static str)> {
    if let Some(title) = &session.title {
        return Some((title.clone(), "name"));
    }
    // Codex keeps no name at all, so an unnamed session's label costs a tail
    // read. That is worth it only for a session some pane actually owns.
    let prompt = match bin {
        "claude" => session.prompt.clone(),
        "codex" => codex_prompt(&session.source),
        _ => None,
    };
    prompt.map(|p| (p, "prompt"))
}

/// Session names for every pane running `bin` in `cwd`.
///
/// Resolving the directory in one call is the point: one walk per tick instead
/// of one per pane, and panes that share a directory get told apart instead of
/// all staying blank.
#[command]
pub fn agent_session_titles(cwd: String, bin: String, panes: Vec<PaneAsk>) -> Result<Vec<ResolvedTitle>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    Ok(titles_in(&home, &cwd, &bin, panes))
}

fn titles_in(home: &Path, cwd: &str, bin: &str, panes: Vec<PaneAsk>) -> Vec<ResolvedTitle> {
    let cwd = cwd.trim();
    if cwd.is_empty() || cwd.len() > 500 || panes.is_empty() || panes.len() > MAX_PANES {
        return Vec::new();
    }
    let asks: Vec<(String, u64)> = panes
        .into_iter()
        .filter_map(|p| p.since_ms.map(|since| (p.id, since)))
        .collect();
    let since = asks.iter().map(|(_, s)| *s).min().unwrap_or(0);
    let mut sessions = match bin {
        "claude" => claude_sessions(home, cwd, since),
        "codex" => codex_sessions(home, cwd, since),
        _ => Vec::new(),
    };
    let mut out = Vec::new();
    for (id, idx, matched) in resolve_panes(&asks, &mut sessions) {
        let Some(session) = sessions.get(idx) else { continue };
        let Some((label, via)) = label_for(bin, session) else { continue };
        out.push(ResolvedTitle {
            id,
            title: label,
            source: session.source.clone(),
            matched,
            via,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const TITLE_LINE: &str = r#"{"type":"ai-title","aiTitle":"fix the flaky pane test","sessionId":"abc"}"#;

    fn stamp(ms: u64) -> String {
        // 2026-09-29T19:02:55Z, formatted from a known epoch value.
        let secs = ms / 1000;
        let days = secs / 86_400;
        let rem = secs % 86_400;
        let (y, mo, d) = civil_from_days(days as i64);
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
            y,
            mo,
            d,
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
        )
    }

    /// Inverse of `days_from_civil`, for building fixtures.
    fn civil_from_days(z: i64) -> (i64, i64, i64) {
        let z = z + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        (if m <= 2 { y + 1 } else { y }, m, d)
    }

    #[test]
    fn iso_timestamps_round_trip() {
        // The two shapes actually seen on disk.
        assert_eq!(iso_millis("2026-09-29T19:02:55.425Z"), Some(1_790_708_575_425));
        assert_eq!(iso_millis("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_millis("2026-09-29T19:02:55Z"), iso_millis("2026-09-29T19:02:55.000Z"));
        // Fraction shorter than 3 digits scales rather than truncating.
        assert_eq!(iso_millis("2026-09-29T19:02:55.5Z"), iso_millis("2026-09-29T19:02:55.500Z"));
    }

    #[test]
    fn iso_rejects_anything_it_cannot_be_sure_of() {
        // A local offset is not UTC; guessing one would misattribute a session.
        assert_eq!(iso_millis("2026-09-29T19:02:55+02:00"), None);
        assert_eq!(iso_millis("not a date"), None);
        assert_eq!(iso_millis(""), None);
        assert_eq!(iso_millis("2026-13-01T00:00:00.000Z"), None);
        assert_eq!(iso_millis("2026-09-29T99:02:55.000Z"), None);
    }

    #[test]
    fn slug_matches_claudes_on_disk_layout() {
        // Both of these are real directory names on the machine this was
        // written on, so a regression here silently breaks every lookup.
        assert_eq!(project_slug(r"D:\orca-workspace\guimux"), "D--orca-workspace-guimux");
        assert_eq!(
            project_slug(r"C:\Users\suman\AppData\Local\Temp\t3code\claude\title-FtKT70"),
            "C--Users-suman-AppData-Local-Temp-t3code-claude-title-FtKT70"
        );
        assert_eq!(project_slug("/home/me/src"), "-home-me-src");
    }

    #[test]
    fn newest_title_wins() {
        let tail = format!(
            "{TITLE_LINE}\n{}\n{}\n",
            r#"{"type":"ai-title","aiTitle":"first pass","sessionId":"abc"}"#,
            r#"{"type":"ai-title","aiTitle":"final name","sessionId":"abc"}"#
        );
        assert_eq!(title_from_tail(&tail), Some("final name".into()));
    }

    #[test]
    fn ignores_other_records_and_broken_lines() {
        let tail = format!(
            concat!(
                "not json at all\n",
                r#"{{"type":"summary","summary":"a different record"}}"#,
                "\n",
                r#"{{"type":"user","message":{{"role":"user"}}}}"#,
                "\n{{ truncated",
                "\n{}\n",
            ),
            TITLE_LINE
        );
        assert_eq!(title_from_tail(&tail), Some("fix the flaky pane test".into()));
    }

    #[test]
    fn requires_the_record_type_not_merely_the_word() {
        // A message that merely mentions ai-title must not be read as one.
        let tail = r#"{"type":"user","message":{"text":"type ai-title please"},"sessionId":"x"}"#;
        assert_eq!(title_from_tail(tail), None);
    }

    #[test]
    fn empty_title_is_not_a_name() {
        let tail = r#"{"type":"ai-title","aiTitle":"   ","sessionId":"x"}"#;
        assert_eq!(title_from_tail(tail), None);
    }

    #[test]
    fn no_record_yields_nothing() {
        assert_eq!(title_from_tail("{\"type\":\"user\"}\n"), None);
        assert_eq!(title_from_tail(""), None);
    }

    /// A fresh fake home: `.claude/projects/<slug>/…` and `.codex/sessions/…`.
    fn fake_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gm-agent-session-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The answer the command gives, without going through $HOME.
    fn resolved(home: &Path, bin: &str, cwd: &str, asks: Vec<(String, u64)>) -> Vec<ResolvedTitle> {
        let panes: Vec<PaneAsk> = asks
            .into_iter()
            .map(|(id, since)| PaneAsk { id, since_ms: Some(since) })
            .collect();
        titles_in(home, cwd, bin, panes)
    }

    fn codex_name(home: &Path, cwd: &str, since: u64) -> Option<ResolvedTitle> {
        codex_titles(home, cwd, vec![("p1".to_string(), since)]).into_iter().next()
    }

    fn codex_titles(home: &Path, cwd: &str, asks: Vec<(String, u64)>) -> Vec<ResolvedTitle> {
        resolved(home, "codex", cwd, asks)
    }

    fn claude_titles(home: &Path, cwd: &str, asks: Vec<(String, u64)>) -> Vec<ResolvedTitle> {
        resolved(home, "claude", cwd, asks)
    }

    fn claude_name(home: &Path, cwd: &str, since: u64) -> Option<ResolvedTitle> {
        claude_titles(home, cwd, vec![("p1".to_string(), since)]).into_iter().next()
    }

    /// Fixtures are written raw, so a Windows path needs its backslashes doubled
    /// before it can sit inside a JSON string.
    fn j(s: &str) -> String {
        s.replace('\\', "\\\\")
    }

    fn write_file_at(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        f.sync_all().unwrap();
    }

    #[test]
    fn codex_joins_the_rollout_to_the_name_index() {
        let home = fake_home("codex-join");
        let cwd = r"D:\orca-workspace\guimux";
        let started = stamp(1_790_708_575_000);
        let id = "01a0d226-f6be-7e33-96ed-8743a932d8e1";
        write_file_at(
            &home.join(".codex/sessions/2026/09/24").join(format!("rollout-2026-09-24T12-12-44-{id}.jsonl")),
            &format!(
                concat!(
                    r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","timestamp":"{ts}"}}}}"#,
                    "\n",
                    r#"{{"type":"response_item","payload":{{"type":"message"}}}}"#,
                    "\n",
                ),
                ts = started,
                id = id,
                cwd = j(cwd)
            ),
        );
        write_file_at(
            &home.join(".codex/session_index.jsonl"),
            &format!(
                concat!(
                    r#"{{"id":"other","thread_name":"unrelated","updated_at":"{ts}"}}"#,
                    "\n",
                    r#"{{"id":"{id}","thread_name":"hey, what is this app?","updated_at":"{ts}"}}"#,
                    "\n",
                ),
                ts = started,
                id = id
            ),
        );

        let title = codex_name(&home, cwd, 0).expect("expected a name");
        assert_eq!(title.title, "hey, what is this app?");
        // Provenance is the session's own file, not the index it was named in.
        assert!(title.source.contains("rollout-") && title.source.ends_with(".jsonl"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_skips_a_rollout_older_than_the_pane() {
        let home = fake_home("codex-stale");
        let cwd = r"D:\orca-workspace\guimux";
        let old_ms = 1_790_708_575_000;
        let old = stamp(old_ms);
        let id = "aaaaaaaa-0000-0000-0000-000000000001";
        write_file_at(
            &home.join(".codex/sessions/2026/09/24").join(format!("rollout-old-{id}.jsonl")),
            &format!(
                concat!(
                    r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","timestamp":"{ts}"}}}}"#,
                    "\n",
                ),
                ts = old,
                id = id,
                cwd = j(cwd)
            ),
        );
        write_file_at(
            &home.join(".codex/session_index.jsonl"),
            &format!(r#"{{"id":"{id}","thread_name":"stale name"}}"#, id = id),
        );
        // A pane that launched an hour later must not inherit that name.
        assert!(codex_name(&home, cwd, old_ms + 3_600_000).is_none());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_declines_when_two_sessions_share_the_directory() {
        let home = fake_home("codex-ambiguous");
        let cwd = r"D:\orca-workspace\guimux";
        let started = stamp(1_790_708_575_000);
        let dir = home.join(".codex/sessions/2026/09/24");
        for (n, id) in ["aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002"].iter().enumerate() {
            write_file_at(
                &dir.join(format!("rollout-{n}-{id}.jsonl")),
                &format!(
                    concat!(
                        r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","timestamp":"{ts}"}}}}"#,
                        "\n",
                    ),
                    ts = started,
                    id = id,
                    cwd = j(cwd)
                ),
            );
        }
        write_file_at(
            &home.join(".codex/session_index.jsonl"),
            "{\"id\":\"aaaaaaaa-0000-0000-0000-000000000001\",\"thread_name\":\"first\"}\n",
        );
        // Two live sessions here cannot be told apart from the filesystem.
        assert!(codex_name(&home, cwd, 0).is_none());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_ignores_another_directory_and_a_rollout_with_no_name() {
        let home = fake_home("codex-elsewhere");
        let id = "cccccccc-0000-0000-0000-000000000003";
        let started = stamp(1_790_708_575_000);
        write_file_at(
            &home.join(".codex/sessions/2026/09/24").join(format!("rollout-{id}.jsonl")),
            &format!(
                concat!(
                    r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{id}","cwd":"C:\\other","timestamp":"{ts}"}}}}"#,
                    "\n",
                ),
                ts = started,
                id = id
            ),
        );
        assert!(codex_name(&home, r"D:\orca-workspace\guimux", 0).is_none());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn paths_compare_case_insensitively_and_ignore_a_trailing_separator() {
        assert!(same_dir(r"D:\Work\guimux", "d:/work/guimux"));
        assert!(same_dir(r"D:\Work\guimux\", r"D:\Work\guimux"));
        assert!(!same_dir(r"D:\Work\guimux", r"D:\Work\guimux\src"));
    }

    /// Transcripts reach 41MB in practice. Reading one whole on every poll would
    /// be ruinous, so this proves the title is still found in the tail of a file
    /// far larger than the read window.
    #[test]
    fn reads_the_tail_of_a_file_larger_than_the_window() {
        let home = fake_home("claude-tail");
        let path = home.join("big.jsonl");
        let mut f = File::create(&path).unwrap();
        let filler = format!("{}\n", "x".repeat(900));
        // Three windows of filler, so the title sits well past the boundary.
        for _ in 0..(TAIL_BYTES as usize / filler.len() * 3) {
            f.write_all(filler.as_bytes()).unwrap();
        }
        // The title lands past the window boundary, as it does on disk.
        f.write_all(TITLE_LINE.as_bytes()).unwrap();
        f.write_all(b"\n").unwrap();
        f.sync_all().unwrap();
        assert!(f.metadata().unwrap().len() > TAIL_BYTES * 2);

        let tail = read_range(&path, f.metadata().unwrap().len().saturating_sub(TAIL_BYTES), TAIL_BYTES).unwrap();
        assert_eq!(title_from_tail(&tail), Some("fix the flaky pane test".into()));
        let _ = fs::remove_dir_all(&home);
    }

    /// A seek into the middle of a record must not turn a fragment into a name.
    #[test]
    fn a_seek_boundary_does_not_invent_a_title() {
        let home = fake_home("claude-boundary");
        let path = home.join("big.jsonl");
        let mut f = File::create(&path).unwrap();
        // The record straddles the boundary and is preceded by no newline in
        // the tail, so the fragment cannot parse.
        f.write_all("y".repeat(TAIL_BYTES as usize - 10).as_bytes()).unwrap();
        f.write_all(TITLE_LINE.as_bytes()).unwrap();
        f.write_all(b"\n").unwrap();
        f.sync_all().unwrap();

        let tail = read_range(&path, f.metadata().unwrap().len().saturating_sub(TAIL_BYTES), TAIL_BYTES).unwrap();
        assert_eq!(title_from_tail(&tail), None);
        let _ = fs::remove_dir_all(&home);
    }

    /// Both agents open with a record carrying the model instructions; measured
    /// on disk it reaches 65KB, past the initial head window. A fixed window
    /// returns one unparseable fragment and no identity at all, so it grows.
    #[test]
    fn codex_survives_a_first_record_larger_than_the_head_window() {
        let home = fake_home("codex-fat-meta");
        let cwd = r"D:\orca-workspace\guimux";
        let started = stamp(1_790_708_575_000);
        let id = "dddddddd-0000-0000-0000-000000000004";
        let pad = "x".repeat(HEAD_BYTES as usize * 2);
        write_file_at(
            &home.join(".codex/sessions/2026/09/29").join(format!("rollout-fat-{id}.jsonl")),
            &format!(
                concat!(
                    r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","timestamp":"{ts}","instructions":"{pad}"}}}}"#,
                    "\n",
                ),
                ts = started,
                id = id,
                cwd = j(cwd),
                pad = pad
            ),
        );
        write_file_at(
            &home.join(".codex/session_index.jsonl"),
            &format!(r#"{{"id":"{id}","thread_name":"long instructions"}}"#, id = id),
        );
        assert_eq!(
            codex_name(&home, cwd, 0).map(|r| r.title),
            Some("long instructions".into())
        );
        let _ = fs::remove_dir_all(&home);
    }

    /// The same trap on the Claude side: an unreadable first line would drop the
    /// start time and silently fall back to mtime.
    #[test]
    fn session_start_is_found_past_a_long_first_record() {
        let home = fake_home("claude-fat-head");
        let path = home.join("fat.jsonl");
        let ms = 1_790_708_575_000;
        write_file_at(
            &path,
            &format!(
                concat!(r#"{{"timestamp":"{ts}","type":"user","instructions":"{pad}"}}"#, "\n"),
                ts = stamp(ms),
                pad = "x".repeat(HEAD_BYTES as usize * 2)
            ),
        );
        assert_eq!(session_start_ms(&path), Some(ms));
        let _ = fs::remove_dir_all(&home);
    }
    /// A Codex rollout for `cwd` that started at `started_ms`.
    fn rollout(home: &Path, id: &str, cwd: &str, started_ms: u64) {
        let ts = stamp(started_ms);
        write_file_at(
            &home.join(".codex/sessions/2026/09/29").join(format!("rollout-{id}.jsonl")),
            &format!(
                concat!(
                    r#"{{"timestamp":"{ts}","type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","timestamp":"{ts}"}}}}"#,
                    "\n",
                ),
                ts = ts,
                id = id,
                cwd = j(cwd)
            ),
        );
    }

    fn index(home: &Path, entries: &[(&str, &str)]) {
        let body: String = entries
            .iter()
            .map(|(id, name)| format!(r#"{{"id":"{id}","thread_name":"{name}"}}"#, id = id, name = name) + "\n")
            .collect();
        write_file_at(&home.join(".codex/session_index.jsonl"), &body);
    }

    /// A Claude transcript for `cwd` that has already been named.
    fn transcript(home: &Path, cwd: &str, id: &str, started_ms: u64, title: &str) {
        let ts = stamp(started_ms);
        write_file_at(
            &home.join(".claude/projects").join(project_slug(cwd)).join(format!("{id}.jsonl")),
            &format!(
                concat!(
                    r#"{{"timestamp":"{ts}","type":"user","sessionId":"{id}","cwd":"{cwd}"}}"#,
                    "\n",
                    r#"{{"type":"ai-title","aiTitle":"{title}","sessionId":"{id}"}}"#,
                    "\n",
                ),
                ts = ts,
                id = id,
                cwd = j(cwd),
                title = title
            ),
        );
    }

    /// Two panes in one directory used to leave both headers blank: the
    /// filesystem cannot say which transcript belongs to which pane, so each
    /// one saw two candidates and gave up. Order can, because guimux launches
    /// panes in order and an agent creates its session file as it starts.
    #[test]
    fn two_panes_in_one_directory_each_get_their_own_session() {
        let home = fake_home("codex-pairing");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        let first = "11111111-0000-0000-0000-000000000001";
        let second = "22222222-0000-0000-0000-000000000002";
        rollout(&home, first, cwd, launch + 1_000);
        rollout(&home, second, cwd, launch + 4_000);
        index(&home, &[(first, "fix the flaky pane test"), (second, "rename the header badge")]);

        // One shared floor, exactly like a fan-out.
        let asks = vec![("p1".to_string(), launch), ("p2".to_string(), launch)];
        let got = codex_titles(&home, cwd, asks);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].id.as_str(), got[0].title.as_str()), ("p1", "fix the flaky pane test"));
        assert_eq!((got[1].id.as_str(), got[1].title.as_str()), ("p2", "rename the header badge"));
        assert!(got.iter().all(|g| g.matched), "order did the matching here");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn claude_pairs_two_transcripts_in_one_directory() {
        let home = fake_home("claude-pairing");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        transcript(&home, cwd, "aaaa1111-0000-0000-0000-00000000000a", launch + 2_000, "first conversation");
        transcript(&home, cwd, "bbbb2222-0000-0000-0000-00000000000b", launch + 9_000, "second conversation");

        let asks = vec![("p1".to_string(), launch), ("p2".to_string(), launch)];
        let got = claude_titles(&home, cwd, asks);
        assert_eq!(
            got.iter().map(|g| (g.id.as_str(), g.title.as_str())).collect::<Vec<_>>(),
            vec![("p1", "first conversation"), ("p2", "second conversation")]
        );
        let _ = fs::remove_dir_all(&home);
    }

    /// The count is what makes the match forced. A third session means one of
    /// them belongs to no pane, the order no longer lines up, and a wrong name
    /// is worse than none.
/// The common case, end to end: one pane, one transcript, one name.
    #[test]
    fn claude_names_a_lone_transcript_in_the_directory() {
        let home = fake_home("claude-lone");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        transcript(&home, cwd, "aaaa1111-0000-0000-0000-00000000000a", launch + 2_000, "just this one");
        let got = claude_name(&home, cwd, launch).expect("a name");
        assert_eq!(got.title, "just this one");
        assert!(!got.matched, "one pane is a single candidate, not a pair");
        assert!(got.source.ends_with(".jsonl"));
        let _ = fs::remove_dir_all(&home);
    }

    /// A pane polling before it has written its own session file must not be
    /// handed the name of the pane that already has one.
    #[test]
    fn a_session_is_handed_to_only_one_pane() {
        let home = fake_home("codex-one-session-two-panes");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        let first = "11111111-0000-0000-0000-000000000001";
        rollout(&home, first, cwd, launch + 1_000);
        index(&home, &[(first, "only session")]);

        let asks = vec![("p1".to_string(), launch), ("p2".to_string(), launch + 500)];
        let got = codex_titles(&home, cwd, asks);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].id.as_str(), got[0].title.as_str()), ("p1", "only session"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn more_sessions_than_panes_names_nobody() {
        let home = fake_home("codex-extra-session");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        let ids = [
            "11111111-0000-0000-0000-000000000001",
            "22222222-0000-0000-0000-000000000002",
            "33333333-0000-0000-0000-000000000003",
        ];
        for (n, id) in ids.iter().enumerate() {
            rollout(&home, id, cwd, launch + 1_000 * (n as u64 + 1));
        }
        index(&home, &[("11111111-0000-0000-0000-000000000001", "one")]);

        let asks = vec![("p1".to_string(), launch), ("p2".to_string(), launch)];
        assert!(codex_titles(&home, cwd, asks).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    /// Codex writes no name until the conversation has one. The pair is still
    /// forced, so the pane that owns the named session is told and the other
    /// waits for its own name instead of taking the wrong one.
    #[test]
    fn a_session_without_a_name_does_not_block_the_others() {
        let home = fake_home("codex-one-unnamed");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        let first = "11111111-0000-0000-0000-000000000001";
        let second = "22222222-0000-0000-0000-000000000002";
        rollout(&home, first, cwd, launch + 1_000);
        rollout(&home, second, cwd, launch + 4_000);
        index(&home, &[(second, "the one that got named")]);

        let asks = vec![("p1".to_string(), launch), ("p2".to_string(), launch)];
        let got = codex_titles(&home, cwd, asks);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].id.as_str(), got[0].title.as_str()), ("p2", "the one that got named"));
        let _ = fs::remove_dir_all(&home);
    }

    /// Two sessions, two panes, but the pair order would hand the second pane a
    /// session that started before it did. The forced match is refused and each
    /// pane falls back to being the single candidate it genuinely is.
    #[test]
    fn pairing_is_refused_when_a_session_predates_its_pane() {
        let home = fake_home("codex-pairing-refused");
        let cwd = r"D:\orca-workspace\guimux";
        let first_pane = 1_790_708_575_000;
        let first = "11111111-0000-0000-0000-000000000001";
        let second = "22222222-0000-0000-0000-000000000002";
        rollout(&home, first, cwd, first_pane - 1_800);
        rollout(&home, second, cwd, first_pane - 1_500);
        index(&home, &[(first, "older session"), (second, "newer session")]);

        let asks = vec![
            ("p1".to_string(), first_pane),
            ("p2".to_string(), first_pane + 1_000),
        ];
        // Refused, and the fallback cannot rescue it either: both sessions sit
        // inside the slack of both panes, so neither is a single candidate.
        assert!(codex_titles(&home, cwd, asks).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    /// A pane restored from disk has no launch floor, so it is never asked:
    /// without one it cannot be told apart from the sessions already on disk.
    #[test]
    fn a_pane_without_a_launch_floor_is_not_asked() {
        let home = fake_home("codex-no-floor");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        rollout(&home, "11111111-0000-0000-0000-000000000001", cwd, launch + 1_000);
        index(&home, &[("11111111-0000-0000-0000-000000000001", "named")]);

        let asked = vec![PaneAsk { id: "p1".to_string(), since_ms: None }];
        assert!(titles_in(&home, cwd, "codex", asked).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    /// The whole contract: directory in, one entry per named pane out, and an
    /// agent it cannot read yields nothing rather than a guess.
    #[test]
    fn the_command_answers_for_the_whole_directory() {
        let home = fake_home("codex-command");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        let first = "11111111-0000-0000-0000-000000000001";
        rollout(&home, first, cwd, launch + 1_000);
        index(&home, &[("first", "ignored"), (first, "only session")]);

        let asked = vec![
            PaneAsk { id: "p1".to_string(), since_ms: Some(launch) },
            PaneAsk { id: "p2".to_string(), since_ms: Some(launch) },
        ];
        let got = titles_in(&home, cwd, "codex", asked);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].id.as_str(), got[0].title.as_str()), ("p1", "only session"));
        assert!(!got[0].matched, "a single candidate is not a pair");

        let asked = vec![PaneAsk { id: "p1".to_string(), since_ms: Some(launch) }];
        assert!(titles_in(&home, cwd, "opencode", asked).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

/// A Codex rollout that has prompts but no name yet.
    ///
    /// Fixtures are built with `json!` rather than hand-written braces: a
    /// transcript is nested JSON, and a miscounted brace in a test is a test
    /// that silently stops testing anything.
    fn rollout_with_prompt(home: &Path, id: &str, cwd: &str, started_ms: u64, prompt: &str) {
        let ts = stamp(started_ms);
        let typed = format!("{prompt}\n");
        let body = [
            json!({"timestamp": ts, "type": "session_meta",
                   "payload": {"id": id, "cwd": cwd, "timestamp": ts}}),
            json!({"timestamp": ts, "type": "event_msg",
                   "payload": {"type": "item_completed",
                               "item": {"type": "UserMessage",
                                        "content": [{"type": "text", "text": typed}]}}}),
            json!({"timestamp": ts, "type": "response_item",
                   "payload": {"type": "message", "role": "user",
                               "content": [{"type": "input_text", "text": typed}]}}),
            json!({"timestamp": ts, "type": "response_item",
                   "payload": {"type": "message", "role": "assistant",
                               "content": [{"type": "output_text", "text": "on it"}]}}),
        ]
        .iter()
        .map(|v| format!("{}\n", v))
        .collect::<String>();
        write_file_at(
            &home.join(".codex/sessions/2026/09/29").join(format!("rollout-{id}.jsonl")),
            &body,
        );
    }

    /// A Claude transcript with a prompt and no `ai-title` yet. The newest
    /// record is a tool result, which is what a transcript mostly is.
    fn transcript_unnamed(home: &Path, cwd: &str, id: &str, started_ms: u64, prompt: &str) {
        let ts = stamp(started_ms);
        let body = [
            json!({"timestamp": ts, "type": "user", "isSidechain": false,
                   "message": {"role": "user", "content": prompt}}),
            json!({"timestamp": ts, "type": "assistant",
                   "message": {"role": "assistant", "content": "working"}}),
            json!({"timestamp": ts, "type": "user", "isSidechain": false,
                   "toolUseResult": {"stdout": "ok"},
                   "message": {"role": "user",
                               "content": [{"type": "tool_result", "content": "42 files changed"}]}}),
        ]
        .iter()
        .map(|v| format!("{}\n", v))
        .collect::<String>();
        write_file_at(
            &home.join(".claude/projects").join(project_slug(cwd)).join(format!("{id}.jsonl")),
            &body,
        );
    }

    fn lines(values: &[serde_json::Value]) -> String {
        values.iter().map(|v| format!("{}\n", v)).collect()
    }

    /// Verified on disk: a `user` record is written for every prompt *and* for
    /// every tool result (943 of 991 in one project), and the tool result is
    /// usually the newest record in the tail.
    #[test]
    fn a_claude_tool_result_is_not_the_last_prompt() {
        let tail = lines(&[
            json!({"type": "user", "isSidechain": false,
                   "message": {"role": "user", "content": "fix the flaky pane test"}}),
            json!({"type": "user", "isSidechain": false, "toolUseResult": {"stdout": "ok"},
                   "message": {"role": "user",
                               "content": [{"type": "tool_result", "content": "42 files changed"}]}}),
        ]);
        assert_eq!(prompt_from_claude_tail(&tail), Some("fix the flaky pane test".into()));
        assert_eq!(prompt_from_claude_tail("{ truncated\n"), None);
    }

    /// Injected (`isMeta`) and sub-agent (`isSidechain`) records are the agent
    /// talking to itself. Only what the user typed is a label.
    #[test]
    fn injected_claude_records_are_not_prompts() {
        let tail = lines(&[
            json!({"type": "user", "isSidechain": false,
                   "message": {"role": "user", "content": "why is the pane header blank?"}}),
            json!({"type": "user", "isMeta": true,
                   "message": {"role": "user", "content": "<command-name>/clear</command-name>"}}),
            json!({"type": "user", "isSidechain": true,
                   "message": {"role": "user", "content": "a sub-agent question"}}),
        ]);
        assert_eq!(prompt_from_claude_tail(&tail), Some("why is the pane header blank?".into()));
    }

    /// Codex writes a typed prompt twice, as a `UserMessage` item and as the
    /// model's own user message, but only the first is read: the second also
    /// carries the context Codex injects at startup, which nobody typed.
    #[test]
    fn a_codex_prompt_comes_from_the_item_not_the_injected_context() {
        let item = lines(&[json!({"timestamp": "2026-09-24T06:42:49.068Z", "type": "event_msg",
                                  "payload": {"type": "item_completed",
                                              "item": {"type": "UserMessage",
                                                       "content": [{"type": "text", "text": "ci checks failed \n"}]}}})]);
        assert_eq!(prompt_from_codex_tail(&item), Some("ci checks failed".into()));
        for injected in [
            "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nYou are my agent.",
            "<recommended_plugins>\nHere is a list of plugins.",
            "<environment_context>\n  <cwd>D:/repo</cwd>",
        ] {
            let message = lines(&[json!({"timestamp": "2026-09-24T06:42:49.068Z", "type": "response_item",
                                         "payload": {"type": "message", "role": "user",
                                                     "content": [{"type": "input_text", "text": injected}]}})]);
            assert_eq!(prompt_from_codex_tail(&message), None, "injected context leaked: {injected:?}");
        }
        let assistant = lines(&[json!({"timestamp": "2026-09-24T06:42:49.068Z", "type": "response_item",
                                       "payload": {"type": "message", "role": "assistant",
                                                   "content": [{"type": "output_text", "text": "running the suite"}]}})]);
        assert_eq!(prompt_from_codex_tail(&assistant), None);
    }

    /// A header is one line and a few words: the agent's own markers come off,
    /// runs of whitespace collapse, and a wall of text is cut.
    #[test]
    fn a_prompt_label_is_one_line_short_and_unmarked() {
        assert_eq!(
            prompt_label("<command-name>/clear</command-name>\n  do   the\r\nthing  "),
            Some("do the thing".into())
        );
        assert_eq!(
            prompt_label("<local-command-caveat>Caveat: noise</local-command-caveat> add a settings page"),
            Some("add a settings page".into())
        );
        assert_eq!(prompt_label("[Image #1] describe this screenshot"), Some("describe this screenshot".into()));
        assert_eq!(prompt_label("[Image #1]"), None);
        let label = prompt_label(&"a".repeat(200)).expect("a label");
        assert_eq!(label.chars().count(), MAX_PROMPT);
        assert!(label.ends_with('\u{2026}'));
    }

    /// The whole point: a pane whose agent has not named the conversation yet
    /// still gets a label, and the label says what it is.
    #[test]
    fn an_unnamed_session_falls_back_to_the_last_prompt() {
        let home = fake_home("codex-prompt-fallback");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        let id = "11111111-0000-0000-0000-000000000001";
        rollout_with_prompt(&home, id, cwd, launch + 1_000, "ci checks failed");
        index(&home, &[]);

        let got = codex_name(&home, cwd, launch).expect("a label");
        assert_eq!((got.title.as_str(), got.via), ("ci checks failed", "prompt"));
        let _ = fs::remove_dir_all(&home);
    }

    /// A name always wins over the prompt it stands in for.
    #[test]
    fn a_name_replaces_the_prompt_fallback() {
        let home = fake_home("codex-name-wins");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        let id = "22222222-0000-0000-0000-000000000002";
        rollout_with_prompt(&home, id, cwd, launch + 1_000, "ci checks failed");
        index(&home, &[(id, "green ci")]);

        let got = codex_name(&home, cwd, launch).expect("a label");
        assert_eq!((got.title.as_str(), got.via), ("green ci", "name"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_claude_session_without_a_title_falls_back_to_the_last_prompt() {
        let home = fake_home("claude-prompt-fallback");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        transcript_unnamed(&home, cwd, "aaaa1111-0000-0000-0000-00000000000a", launch + 2_000, "the sidebar will not resize");

        let got = claude_name(&home, cwd, launch).expect("a label");
        assert_eq!((got.title.as_str(), got.via), ("the sidebar will not resize", "prompt"));
        let _ = fs::remove_dir_all(&home);
    }

    /// Pairing happens before labels, so two unnamed panes each keep their own.
    #[test]
    fn two_unnamed_panes_each_get_their_own_prompt() {
        let home = fake_home("codex-two-prompts");
        let cwd = r"D:\orca-workspace\guimux";
        let launch = 1_790_708_575_000;
        rollout_with_prompt(&home, "11111111-0000-0000-0000-000000000001", cwd, launch + 1_000, "first question");
        rollout_with_prompt(&home, "22222222-0000-0000-0000-000000000002", cwd, launch + 4_000, "second question");
        index(&home, &[]);

        let asks = vec![("p1".to_string(), launch), ("p2".to_string(), launch)];
        let got = codex_titles(&home, cwd, asks);
        assert_eq!(
            got.iter().map(|g| (g.id.as_str(), g.title.as_str(), g.via)).collect::<Vec<_>>(),
            vec![("p1", "first question", "prompt"), ("p2", "second question", "prompt")]
        );
        let _ = fs::remove_dir_all(&home);
    }
}
