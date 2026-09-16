# guimux

Lean Tauri 2 + React worktree/terminal workbench.

![guimux preview](img/guimux_preview.png)

> **Early beta.** This project is actively under development. Expect bugs, glitches, and missing features. Things will break.

Pull requests are welcome — open one and the author will review and merge.

## Run

```bash
npm install
npm run dev          # frontend only
npm run tauri dev    # full app
```

## Build

```bash
npm run tauri build
```

## What it does

- **Worktrees** — list / create / remove / merge branches
- **Terminal splits** — GPU-accelerated xterm.js, unlimited h/v splits per worktree
- **File explorer + editor** — Monaco with autosave
