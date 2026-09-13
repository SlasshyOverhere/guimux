# Guimux — Plan

Lean Orca alternative on **Tauri 2 + Rust + React**. No Electron lag.
Repo: `D:/orca-workspace/guimux`

## 1. Core model

- **Worktree = isolated git directory.** Nothing else. No agent binding. No status. Just `path + branch`.
- **Terminal = PTY with a cwd inside a worktree.** User types whatever CLI they want. Guimux never knows or cares what agent it is.
- **Split = N terminals per worktree, unlimited.** One worktree starts with 1 terminal. User splits h/v as much as wanted. Each split = independent PTY, same cwd.
- **No hardcoded agents.** No `claude` / `codex` / `opencode` strings anywhere. No detection, no switcher, no usage tracking. If it runs in a terminal, it runs here.

What Guimux does NOT do: no prompt bar, no fan-out-to-agent API, no agent run tracking, no output parsing, no mobile, no SSH, no browser, no Linear.

## 2. P0 features (only these)

1. **Worktrees** — list / create (branch auto `guimux/<ts>-<rand>`) / remove / merge winner into base. Shell `git worktree` CLI (libgit2 worktree support is thin). Status/diff via `git2`.
2. **GPU terminal splits** — xterm.js + WebGL, infinite h/v splits per worktree, fit/resize, scrollback 10k + persist to disk (survives restart). Hidden panes pause renderer, PTY stays alive.
3. **Generic PTY** — `pty_spawn(cwd, shell, cols, rows)`, `pty_write`, `pty_resize`, `pty_kill`. Events `pty:output-{id}`, `pty:exit-{id}`. Output batched 16ms. No agent awareness.
4. **Broadcast input (replaces fan-out)** — toggle: type once, send same bytes to all visible panes in current worktree. Pure `pty_write` to N sessions. No prompt abstraction.
5. **File explorer + editor** — tree per active worktree (`notify` watch), Monaco + autosave, diff view + per-file accept + merge winner button.
6. **Drag files → terminal** — drop file/image on a terminal pane = paste relative path (quoted) into that PTY. `@` autocomplete optional P1. No agent prompt injection.
7. **GitHub minimal** — PAT in OS keychain, list PRs/issues, checkout PR branch into new worktree, diff. No write actions v1.
8. **Palette + notifications** — `Ctrl+K` (worktrees, files, commands). Toast + OS notify on PTY exit only. No idle-agent heuristics.

## 3. Stack

- **Rust:** `tokio`, `portable-pty`, `git2`, `octocrab`, `notify`, `specta`, plugins: `store`, `notification`, `dialog`, `updater`.
- **TS:** React 18 + Vite + Tailwind + shadcn, `zustand` (layout only), xterm.js (`webgl`, `fit`, `serialize`), `@monaco-editor/react`, `lucide-react`.
- Single WebView. PTY threads in Rust. Frontend never shells git/gh.

## 4. IPC (all of it)

```rust
worktree_list(repo_root) -> Vec<Worktree>            // { id, path, branch }
worktree_create(repo_root, base?, name?) -> Worktree
worktree_remove(id, delete_branch: bool)
worktree_merge(id)                                   // merge branch -> base, no-ff

pty_spawn(cwd, cols, rows) -> PtySession             // { id, cwd } — shell from OS default
pty_write(id, data: String)
pty_resize(id, cols, rows)
pty_kill(id)
// events: pty:output-{id}(bytes), pty:exit-{id}(code)

git_status(path) -> Vec<FileStatus>
git_diff(path, base?) -> String                       // unified, cap 1MB/file

github_prs(repo) -> Vec<Pr>
github_issues(repo) -> Vec<Issue>
github_checkout_pr(repo, number) -> Worktree

fs_tree(path, depth) -> Vec<Node>
fs_read(path) -> String
fs_write(path, content)
```

No `agent_*` commands. Ever.

## 5. Layout

```
┌ topbar: repo ▾ │ +worktree │ broadcast toggle │ palette ┐
├ sidebar ┬ terminal grid (splits) ┬ editor/diff ┤
│ worktrees│ ┌────┬────┐            │ tabs+merge  │
│ github   │ │ pty│ pty│  split any │           │
│          │ └────┴────┘  direction │           │
└──────────┴────────────────────────┴───────────┘
```

Sidebar: Worktrees | GitHub. No Agents tab. Terminal grid = main view. Editor = right pane, collapsible. No bottom prompt bar.

## 6. Build order

0. Scaffold (2d): tauri-app react-ts-vite + tailwind + shadcn + specta + store + CI (mac/win/linux). Startup/RAM harness.
1. Worktrees (3d): commands + sidebar + fixture-repo tests.
2. Terminals (1w): single PTY + WebGL → splits → persist. Hardest. ConPTY quirks on Windows, WebGL ctx cap (pause hidden, canvas fallback past 8 visible).
3. Explorer + editor + diff (4d): tree + Monaco + autosave + merge winner. Skip files >1MB.
4. Drag-drop → PTY paste + broadcast toggle (2d).
5. GitHub (3d): PAT + list + checkout-PR-as-worktree.
6. Palette + exit notifications (2d).
7. Ship (1w): single-instance, updater, signed builds, perf pass.

## 7. Budgets

Cold start <1s. Idle <150MB. +~40MB/pane. Typing <16ms @4 panes. Diff 500 files <200ms. PTY emit ≤60/s/pane.

## 8. Next

1. Scaffold in this dir.
2. `worktree_*` + sidebar first.
3. One PTY pane, then splits.
4. v0.1 = P0 above. Dogfood here.
