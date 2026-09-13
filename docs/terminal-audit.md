# Terminal audit — findings, root causes, evidence

Date: 2026-09-13. Codebase: guimux at D:/orca-workspace/guimux (no git repo — fixes applied directly, no commits).

## P1 — output-before-attach race: CONFIRMED

`TerminalPane.tsx` order per mount: `term.open()` → `fit.fit()` → `invoke("pty_spawn")` returns sid →
`await attach(term, sid)` which registers `listen("pty:output-{sid}")`.

Backend `spawn_pair` (`pty.rs`) spawns the child and starts `spawn_output_pump` immediately. Tauri
`app.emit` is fire-and-forget with no buffering. Any shell bytes emitted between process start and the
frontend's async `listen()` registration are dropped. A fast prompt (warm pwsh) lands exactly in that
window → pane looks blank and waits on input that the user thinks did nothing.

Second instance of the same race on remount: split changes the pane tree (`SplitView` children have no
keys, so React may remount panes). Cleanup unlistens; remount re-listens. Output emitted in between is
lost. Evidence: `attach()` only called after spawn; unlisteners torn down in cleanup with no replay.

Fix: per-PTY ring buffer in Rust. Pump always appends (cap 256KB); emits live only when `attached`.
Frontend calls new `pty_attach(id)` after listeners are registered; backend marks attached and returns
the buffered bytes, which the frontend writes before live events flow. Fixes both first-mount and
remount. No retries/timeouts.

## Dead-id reattach → blank pane: CONFIRMED

`TerminalPane` mount with non-null `ptyId` (stored in layout via `setPtyId`) skips spawn and only
attaches. But worktree-switch cleanup kills the PTY (`paneAlive(newLayout, paneId)` is false after
`setActiveWorktree`, so `pty_kill` runs) while the layout keeps the stale `ptyId`. Switching back
remounts with a dead id: attach succeeds (listen on a channel that will never fire, exit already fired
while unlistened) → permanently blank pane with no error.

Fix: mount path validates via `pty_attach`. On "no such pty session" it spawns fresh and rewires, same
as the existing restart fallback.

## Restart exit race: CONFIRMED

`pty_restart` = `pty_kill(id)` + `spawn_pair(same id)`. The old exit-watcher thread still owns the old
`Child`; when the killed child dies it emits `pty:exit-{id}` — now addressed to the NEW session on the
same id. Frontend marks the fresh shell exited.

Fix: per-id epoch. Watcher captures epoch at spawn; emits only if the epoch is still current. Kill and
restart bump/remove epochs so stale watchers stay silent.

## Zero-size PTY: RISK CONFIRMED (guard missing)

Spawn uses `term.cols/rows` after a best-effort `fit.fit()` in try/catch — defaults (80x24) usually save
it, but every `pty_resize` path (ResizeObserver, font-zoom effect) forwards unclamped dims, and the
backend accepts cols/rows=0 into `openpty`/`master.resize`. A 0-size ConPTY wedges rendering (blank).

Fix: clamp to >=1 on both sides. Backend `clamp_dims` in spawn/resize/restart; frontend clamps and
skips resize until `fit` reports cols>=2 && rows>=1. Initial resize deferred until sane.

## Premature exit detection: RULED OUT (kept as-is)

`try_wait` poll 120ms returns `Some` only on true child death (`GetExitCodeProcess`). A slow-spawning
shell (cold inbox powershell) is still alive → `Ok(None)` → keep polling. No EOF-based exit anywhere
(pump never emits exit). Invariant preserved.

## Serialize/restore: SAFE with hardening

Restore (`term.write(saved)`) runs before spawn/attach, so it cannot suppress the live prompt. Hardening:
wrap in try/catch so a corrupt buffer never breaks mount; live replay is written after restore.

## Close-last-pane / worktree_list: NO DEFECT

`closePane` always replaces null with a fresh pane; App loader falls back to `plain:<id>` solo worktree
and keeps git errors in the banner (`setRepoError`) instead of hanging on "Starting terminal…".
`worktree_list` returns Err (never Ok([])). Untouched.

## GPU/WebGL

`@xterm/addon-webgl@0.18.0` is already in package.json but never loaded (ponytail comment prefers DOM).
API verified in `node_modules/@xterm/addon-webgl/typings/addon-webgl.d.ts`: `new WebglAddon()`,
`onContextLoss: IEvent<void>`, `dispose()`, `clearTextureAtlas()`. Plan: load per visible pane,
`onContextLoss` → dispose → canvas/DOM fallback without touching buffer or focus, re-attempt on next
mount. Context exhaustion: browsers cap ~16 WebGL contexts; panes can exceed it, so attempt can throw —
fallback covers it, no hard cap needed (lean: try, fall back).

## Spawn latency

Hot path per spawn rebuilds the UTF-16LE base64 bootstrap per chain entry and re-probes the filesystem
(ProgramFiles x3 majors, LOCALAPPDATA, PATH, SystemRoot metadata) every spawn. Fix: cache bootstrap
base64 per cwd + cache resolved pwsh path (OnceLock, bypassed by GUIMUX_SHELL). No behavior change to
the chain order. Instrumentation via `GUIMUX_PTY_DEBUG=1` (ipc→started→first-byte eprintln).
Baseline on this box: not measurable here (no tauri dev run in this session); latency recorded as
code-level before/after once runnable — see final report.

## Fixes applied (2026-09-13)

Backend (`src-tauri/src/pty.rs`, `lib.rs` registers `pty_attach`):
- Ring buffer + explicit attach (`BUFFERS`/`ATTACHED`, `pty_attach` replays ≤256KB).
- Epoch-guarded exit watchers AND output pumps (`EPOCHS`, `next_epoch`, kill bumps).
- `clamp_dims` in spawn/resize/restart; `pty_kill` clears buffer/attach state.
- Bootstrap base64 cached per cwd, pwsh path resolved once (`GUIMUX_SHELL` bypasses).
- `GUIMUX_PTY_DEBUG=1` timestamps: ipc-received → process-started → first-byte.

Frontend (`TerminalPane.tsx`, `SplitView.tsx`, `App.tsx`, new `stress.ts`):
- attach = listen first, then `pty_attach` replay write; dead-id mounts respawn fresh.
- `fitSane`/`saneDims` guards on spawn, resize, font-zoom; zero-size never sent.
- WebGL primary with `onContextLoss` → dispose → canvas/DOM fallback (+ `sw` badge),
  disposed when hidden, re-attempted when visible.
- Split children keyed by pane/split id — surviving panes never remount on split.
- Dev stress loop (`maybeStartStress`, `guimux-stress=1`).

Verification: `cargo test` 9/9 ok (5 new), `tsc --noEmit` clean, `vite build` ok.
Live acceptance (100 cold spawns, split/close cycles, WebGL loss, latency numbers)
needs a running `npm run tauri dev` session — NOT done here; run the stress loop
and `GUIMUX_PTY_DEBUG=1` there before calling this complete.
