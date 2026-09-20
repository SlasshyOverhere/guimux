# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Guimux: lean Tauri 2 + React worktree/terminal workbench. Worktree = git dir (path + branch). Terminal = generic PTY with cwd in a worktree. Splits = N independent PTYs per worktree.

## Commands

- `npm run dev` — Vite frontend only (port 1420, `strictPort`, ignores `src-tauri`).
- `npm run tauri dev` — full app (frontend at `http://localhost:1420` per `src-tauri/tauri.conf.json`).
- `npm run typecheck` / `npm run build` — `tsc --noEmit` / `tsc --noEmit && vite build`. No lint script.
- `npm test` — frontend unit tests (`node --test src/updaterPolicy.test.ts`). `src/updaterPolicy.ts` is dependency-free so it runs without a bundler.
- `cd src-tauri && cargo test` — Rust tests (`worktree_lifecycle`, `worktree_remove_guards_uncommitted_work`, `status_and_diff`, `encoded_command_matches_powershell`, `alias_stub_rejected`, plus pty replay/epoch and fs cap tests). Single test: `cd src-tauri && cargo test <name>` (e.g. `cargo test worktree_lifecycle`).
- `.github/workflows/ci.yml` runs typecheck + `npm test` + `npm run build`, and `cargo test` on windows-latest and ubuntu-22.04, on every push to main and every PR. `release.yml` only handles tagged builds.
- `npm run tauri build` — production bundle (icons + `assets/conpty/*` resources).

## Architecture

- Backend `src-tauri/src/`: `lib.rs` registers all IPC + plugins (`store`, `notification`, `dialog`; `mcp-bridge` debug-only) and manages `PtyManager` state. `pty.rs` = generic PTY via `portable-pty` (spawn/write/resize/kill/restart; events `pty:output-{id}`, `pty:exit-{id}`). `worktree.rs` = `git worktree` CLI list/create (`guimux/<ts>-<rand>` branch, `<name>-wt` sibling dir)/remove (retried 5x for Windows locks)/merge into main|master. `git.rs` = `project_detect` (rev-parse toplevel → git root), `git_init`, `git_status` (`-z` porcelain, rename-aware), `git_diff` (1MB cap). `fs.rs` = `fs_tree` (depth clamped 1–6, skips `.git node_modules target dist .next __pycache__`, dotfiles except `.github`)/read/write (1MB read cap, UTF-8 only). `conpty_dll.rs` stages bundled ConPTY on Windows.
- Frontend `src/`: `App.tsx` (topbar, worktree loader, keybindings, welcome/status), `store.ts` (zustand: projects, worktrees, binary pane-split tree per worktree in `layouts`, broadcast, editor/palette/settings), `persist.ts` (tauri `LazyStore guimux.json` + sync localStorage mirror, debounced 150ms), `project.ts` (`detectToProject` normalizes to git root). `terminal/` (`SplitView` + `TerminalPane`: xterm + fit/unicode11/serialize, scrollback 10k persisted to localStorage capped at 24 panes), `sidebar/WorktreeSidebar`, `explorer/ExplorerPane` (bundled Monaco, one model per file, explicit Ctrl+S save; `monaco.ts` wires the local loader + workers and is imported lazily on first file open), `palette/Palette` (Ctrl+K), `settings/SettingsPanel`, `chrome/WindowControls`.
- IPC: frontend never shells git; all git/pty/fs goes through `invoke` commands in `lib.rs`. Broadcast = `pty_write` to N visible panes, no prompt abstraction.

## Gotchas

- `decorations: false` — custom drag via `startDragging` on mousemove-after-press only; never drag on mousedown (swallows clicks on Windows). Dropdowns are divs with `role=button`, closed via `mousedown` capture + Escape.
- No `StrictMode` in `main.tsx` (xterm 5.5.0 dispose race logs noise in dev double-mount).
- PTY exit authority = shell process liveness (`try_wait` poll 120ms), never pipe EOF (TUIs deliver early EOF). `pty_write` passes bytes through unmodified (`\r` stays `\r`).
- Windows shell chain: `GUIMUX_SHELL` override → real `pwsh.exe` (rejects `WindowsApps` 0-byte aliases) → inbox `powershell.exe -NoLogo -NoExit -EncodedCommand <utf16le-base64 bootstrap>` (chcp 65001 + Set-Location) → `cmd /K chcp 65001`.
- Closing last pane opens a fresh shell (never null layout); `worktree_list` errors propagate (never `Ok([])`) so git failures (e.g. dubious ownership) show in banner, not "Starting terminal…" hang. Plain (non-git) projects get synthetic `plain:<id>` worktree so a shell always mounts.
- PTY attach protocol: backend buffers per-PTY output (256KB ring) until frontend sends `pty_attach(id)`, which marks live + replays buffered bytes. Frontend registers `pty:output-{id}` listeners FIRST, then calls `pty_attach`. `pty_attach` errors on unknown ids → pane spawns fresh, never blank.
- Geometry: never spawn/resize with cols/rows < 1 (backend clamps; frontend skips resize until FitAddon reports cols>=2, rows>=1). Split children keyed by pane id so splits never remount surviving panes.
- Restart reuses the numeric id with a bumped epoch; stale exit-watchers/output pumps stay silent.
- WebGL (`@xterm/addon-webgl`) is the primary renderer; `onContextLoss` disposes to canvas/DOM fallback, re-attempted on next visible mount. Hidden panes dispose WebGL, PTY stays alive.
- Debug flags: `GUIMUX_PTY_DEBUG=1` (backend spawn timestamps on stderr); `localStorage guimux-stress=1` + reload runs the dev-only split/write/close stress loop (console `[gm-stress]`; `__gmStressStop()` stops it).
- App zoom via CSS `zoom` on `<html>` (0.5–2); terminals refit via ResizeObserver. Ctrl+D splits h (outside inputs/terminal), Ctrl+K palette skipped when terminal focused (kill-line).

## Custom Instructions

### Comments

- Comment rarely — only where the code genuinely can't explain itself.
- One short tldr line, straight to the point. No multi-line essays, no restating the code, no commented-out code.

### Commits

- Commit after **each** fix or feature the moment it's done and verified. Never batch unrelated work: 5 issues fixed = 5 commits, so history reads as a step-by-step trail.
- Conventional Commits, lowercase, short and imperative:
  `fix(pty): drop stale exit watcher`, `feat(sidebar): prune worktrees`, `refactor(store): flatten layout helpers`.
- Subject <= ~60 chars, no trailing period. Body optional and only for the *why* — 1–2 short lines max.
- **No git attributions, ever.** No `Co-Authored-By`, no "Generated with …", no emoji footers, no tool signatures. Commit as the repo's normal author.
- **Commit only.** Never `git push` or any remote-affecting command without explicit user approval.

### Best Practices (this app)

- **All OS work goes through Rust.** The frontend never shells out to git/fs/pty: add a `#[tauri::command]` in the matching module, register it in `lib.rs`'s `invoke_handler`, call it via `invoke<T>("name", { camelCaseArgs })`.
- **Keep the wire contract in sync.** Rust serde structs and `src/types.ts` mirror each other (snake_case fields) — change both in the same commit.
- **Propagate errors, don't swallow them.** Backend errors surface in the banner; returning `Ok([])`/empty on failure hides real problems (e.g. git dubious ownership) and strands the UI on "Starting terminal…".
- **PTY rules:** register `pty:output-{id}` listeners *before* `pty_attach`; never spawn/resize below 1 col / 1 row; exit authority is process liveness, not pipe EOF; `pty_write` bytes pass through unmodified.
- **Pane identity:** key split children by pane id; never remount a surviving pane; never leave a layout null (closing the last pane opens a fresh shell).
- **Persist through `store.ts`** (zustand) + `persist.ts` (`LazyStore` + debounced mirror) — no ad-hoc storage.
- **Windows first.** File locks (retried removes), path separators, the shell fallback chain and ConPTY staging all matter; prefer `portable-pty` APIs over spawning shells.
- **Stay lean.** Match the terse existing style; don't add a dependency, abstraction, or config knob for a one-off. No `StrictMode` (xterm dispose race). There is no lint tooling — don't assume it.
- **No runtime CDNs.** The packaged CSP is `script-src 'self'`, so anything fetched at runtime (Monaco's AMD bundle is the precedent) breaks in `tauri build` while working fine under Vite. Bundle it and configure `loader.config({ monaco })` instead of letting a loader reach out.
- **Verify before committing:** `npm run typecheck` after frontend edits, `cd src-tauri && cargo test` after Rust edits, `npm run build` when in doubt.
- Keep `AGENTS.md` in sync with this file when either changes.
