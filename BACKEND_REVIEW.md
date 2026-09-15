# Backend Review: `src-tauri` (guimux 0.1.0)

**Scope**: `lib.rs`, `pty.rs`, `worktree.rs`, `git.rs`, `fs.rs`, `conpty_dll.rs`, `main.rs`, `tauri.conf.json`, `capabilities/default.json`. All 7 backend sources + IPC config read; callers spot-checked via `invoke(` grep.
**Findings**: 15 (2 Critical, 6 High, 7 Medium). No high-confidence RCE from a remote attacker (desktop app, no network surface) — the real risks are **local data loss** and **XSS→RCE chain**.

## Critical

### C-001 Arbitrary recursive delete in `worktree_remove` fallback
- **Location**: `worktree.rs` (~`remove_dir_all` fallback when git says "is not a working tree")
- **Issue**: `id` (a path from the frontend) is passed to `std::fs::remove_dir_all(&path)` with zero validation. Any non-worktree path triggers the fallback: `id=C:\Users\x\Documents`, `~/.ssh`, even the repo root itself gets recursively deleted.
- **Evidence**: `if last_err.contains("is not a working tree") { remove_dir_all(&path) … }` — `path` is never canonicalized or checked against the worktree list.
- **Fix**: canonicalize `path`, require it to be listed in `git worktree list` output (or under `~/.guimux/worktrees/<project>`), and refuse `repo_root` / home-dir / short paths. Add `--` before the path arg.

### C-002 XSS→RCE chain is one injection away (`csp: null` + `withGlobalTauri` + god-mode IPC)
- **Location**: `tauri.conf.json` (`"csp": null`, `"withGlobalTauri": true`)
- **Issue**: CSP is fully disabled and every window gets `__TAURI__.core.invoke`. Any script injection (rendered branch/file names, diff text, dialog content, future markdown preview) immediately gains `pty_spawn` (spawn anywhere), `fs_write` (write anywhere, unlimited size), and C-001 (delete anywhere).
- **Fix**: set a CSP, `withGlobalTauri: false` (use explicit JS imports), keep `dangerousRemoteDomainIpcAccess` absent.

## High

### H-001 `fs_write`: arbitrary path, auto-`mkdir`, unlimited size
- **Location**: `fs.rs::fs_write` — `create_dir_all(parent)` + `fs::write` with no size cap (read path caps at 1 MB, write path doesn't).
- **Impact**: arbitrary file write (startup folder, PS profile) + disk-fill DoS; non-atomic truncate-then-write corrupts files on crash; concurrent autosaves interleave.
- **Fix**: cap content (e.g. 1–5 MB), write temp + rename, reject device paths (`NUL`/`CON`/`COM*`, `\\.\`).

### H-002 `fs_tree`: unbounded fan-out hangs UI
- **Location**: `fs.rs::build_tree` — collects + sorts **all** entries per dir, recurses to depth 6, no node/children cap.
- **Impact**: opening a folder with a 100k-file dir (logs, datasets) builds multi-MB JSON → memory spike + frozen UI. `entries.flatten()` also hides permission errors.
- **Fix**: cap children per dir (~2000 + `truncated: true` flag), and total nodes.

### H-003 `pty_write` holds the global sessions lock across blocking pipe I/O
- **Location**: `pty.rs::pty_write` — `sessions.lock()` held through `write_all` + `flush`; no size cap on `data`; no cap on session count; `pty_attach` returns `Vec<u8>` (serialized as ~3.5× JSON bloat vs bytes).
- **Impact**: one back-pressured PTY freezes all spawn/kill/resize; unbounded spawns × 256 KB replay buffers = memory exhaustion.
- **Fix**: per-session writer lock (release map lock before I/O), cap write size (e.g. 1 MB), cap live sessions, return base64 / `serde_bytes`.

### H-004 `worktree_merge`: wrong base + leaves repo mid-conflict with no recovery
- **Location**: `worktree.rs::find_base_branch` + `worktree_merge`.
- **Issues**: (1) `merge-base --is-ancestor branch cand` is **backwards** — for a normal unmerged branch this is false, so it falls back to "whatever's checked out in main" and can merge into the wrong branch (existing test masks this: single-branch fixture accidentally lands on `main`). (2) Failed/conflicted merge leaves the main worktree in `MERGE_HEAD` state; there is no `merge --abort` command, so the user is stuck. (3) checkout+merge isn't atomic — concurrent merges race.
- **Fix**: flip to `--is-ancestor cand branch`; refuse to merge with a dirty main worktree; add `worktree_merge_abort`.

### H-005 Git flag injection via leading-`-` refs/paths
- **Location**: `worktree_create` (`base` → `worktree add … <base>`), `worktree_remove` (`id` → `worktree remove --force <id>`), `git_diff` (`base` → `diff … <base>`).
- **Impact**: `Command::args` blocks shell injection, but a value like `--help`/`--output=C:\x` is parsed as a flag. `git diff --output=…` silently writes to a file and returns empty.
- **Fix**: reject refs/paths starting with `-`, or insert `--` separators.

### H-006 `conpty_dll.rs`: unverified DLL copy, dev-path traversal, never updates
- **Location**: `conpty_dll.rs::ensure_bundled_conpty`.
- **Issues**: copies `conpty.dll`/`OpenConsole.exe` next to the exe with no hash check; dev lookup walks up 4 parents for `src-tauri/assets/conpty` (a planted dir = DLL sideload); `if dst.is_file() { continue }` pins a stale/vulnerable DLL forever; failures are silent (`let _ = copy`) → invisible fallback to the buggy system ConPTY.
- **Fix**: ship via bundle resources only, verify size/hash, log failures.

## Medium

| # | Location | Issue | Fix |
|---|----------|-------|-----|
| M-001 | `pty.rs` (15× `.lock().unwrap()`) | One panic while holding a mutex poisons it; every later PTY op panics → subsystem bricked | `lock().unwrap_or_else(\|e\| e.into_inner())` |
| M-002 | `pty.rs` pump threads | Blocked `read()` never signalled on `pty_kill`; master drop doesn't always unblock the cloned reader → leaked thread per kill; `Err(_) => break` also kills the pump on transient `Interrupted` | retry on `Interrupted`; shutdown flag / drop reader first |
| M-003 | `pty.rs::push_buffer` | `drain(..excess)` memmoves ~256 KB on every 8 KB read while detached + chatty → CPU burn | `VecDeque<u8>` or truncate-with-copy |
| M-004 | `git.rs::git_status` `entry[3..]` | Byte-slice panics on any <3-byte entry; non-UTF8 names mangled by `from_utf8_lossy` then unopenable | `entry.get(3..)` + reject/escape |
| M-005 | `git.rs`/`fs.rs` special files | `fs_read`/`metadata` follow symlinks; `CON`/`NUL`/pipes block the IPC thread forever; TOCTOU on the 1 MB check | blocklist device paths, `read` with cap instead of check-then-read |
| M-006 | `Cargo.toml` | `git2`, `notify` are never used (all git is CLI) — dead libgit2 attack surface + build cost | remove deps; run `cargo audit` (no audit run in this review) |
| M-007 | `pty.rs` dims / `pty_resize` | Only lower-clamped; 65535×65535 passes to ConPTY; `pty_resize` returns `Ok` for unknown ids while `pty_attach` errors — inconsistent, masks dead-pane bugs | clamp upper (e.g. 1000×500); error on unknown id |

## Low / glitches (noted, not expanded)

- `rand_id`: millis + stack-address entropy collides within the same ms → `worktree add -b` fails, no retry.
- Same-named repos in different folders share `~/.guimux/worktrees/<slug>` (acknowledged `ponytail` comment) → cross-project dir mixing.
- `BOOTSTRAP_CACHE` unbounded per-cwd; `PWSH_CACHE` never invalidated on `PATH` change.
- `worktree_list` assumes first porcelain entry is main; detached HEAD yields empty branch — UI must handle.
- Tests share global statics (`BUFFERS`/`EPOCHS`) with fixed magic ids and no cleanup → flaky under parallel `cargo test`.
- `capabilities/default.json` grants `mcp-bridge:default` unconditionally while the plugin only inits in debug — strip from release manifest.
- `project_detect` returns `C:/…` (git slash style) vs frontend `C:\…` → path-equality bugs.

## Suggested fix order (minimal diffs first)

1. C-001 path guard + `--` separators (also covers H-005) — one function, prevents data loss.
2. H-004 flip `is-ancestor` args + dirty-tree refusal + `merge --abort` command.
3. H-001/H-002 caps (write size, tree children) + temp-write-rename.
4. C-002 CSP + `withGlobalTauri: false`.
5. M-001 poison-resistant locks; M-007 clamps; remove dead deps (M-006).
