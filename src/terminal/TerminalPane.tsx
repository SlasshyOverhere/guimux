import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Columns2, GripVertical, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import { allPaneIds, useStore } from "../store";
import { dragFile, quoteForShell, recentOsDrop } from "../dragFile";
import type { PtyAttach, PtySession } from "../types";
import { registerLiveTerm, unregisterLiveTerm } from "./paneEmpty";

// Set localStorage `guimux-stress=1` + reload for the dev stress loop (see stress.ts).
export const STRESS_KEY = "guimux-stress";

// Persisted scrollback per pane id, survives worktree switches (and via
// localStorage, app restarts). Keyed by pane id.
const stateCache = new Map<string, string>();

const LS_SCROLL_PREFIX = "guimux-scroll-";
const LS_SCROLL_INDEX = "guimux-scroll-index";
const MAX_PERSISTED_PANES = 24;

function readScrollback(paneId: string): string | null {
  return stateCache.get(paneId) ?? localStorage.getItem(LS_SCROLL_PREFIX + paneId);
}

function persistScrollback(paneId: string, state: string) {
  stateCache.set(paneId, state);
  // Same cap as the localStorage index: the in-memory map grew forever.
  while (stateCache.size > MAX_PERSISTED_PANES) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
  try {
    localStorage.setItem(LS_SCROLL_PREFIX + paneId, state);
    // Pane ids embed a timestamp and are never reused, so cap the stored
    // buffers by recency and sweep keys orphaned before this cap existed.
    let index: string[] = [];
    try {
      index = JSON.parse(localStorage.getItem(LS_SCROLL_INDEX) ?? "[]") as string[];
    } catch {
      /* rebuild below */
    }
    index = index.filter((id) => id !== paneId);
    index.push(paneId);
    while (index.length > MAX_PERSISTED_PANES) {
      const drop = index.shift();
      if (drop) localStorage.removeItem(LS_SCROLL_PREFIX + drop);
    }
    localStorage.setItem(LS_SCROLL_INDEX, JSON.stringify(index));
    const keep = new Set(index);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(LS_SCROLL_PREFIX) && !keep.has(k.slice(LS_SCROLL_PREFIX.length))) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    /* quota */
  }
}

// Toolbar chip position per pane id: the chip floats over the grid and can
// cover TUI content, so the user can drag it anywhere in the pane. Written
// on drag end only; survives switches and restarts via the persisted pane id.
const LS_TOOLS_POS = "guimux-pane-tools-pos";
const toolsPosCache = new Map<string, { x: number; y: number }>();

function readToolsPos(paneId: string): { x: number; y: number } | null {
  const hit = toolsPosCache.get(paneId);
  if (hit) return hit;
  try {
    const all = JSON.parse(localStorage.getItem(LS_TOOLS_POS) ?? "{}") as Record<
      string,
      { x: number; y: number }
    >;
    const p = all[paneId];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const pos = { x: Math.max(0, Math.min(2000, p.x)), y: Math.max(0, Math.min(2000, p.y)) };
      toolsPosCache.set(paneId, pos);
      return pos;
    }
  } catch {
    /* corrupt: fall back to the corner */
  }
  return null;
}

function writeToolsPos(paneId: string, pos: { x: number; y: number }) {
  toolsPosCache.set(paneId, pos);
  try {
    const all = JSON.parse(localStorage.getItem(LS_TOOLS_POS) ?? "{}") as Record<
      string,
      { x: number; y: number }
    >;
    all[paneId] = pos;
    const keys = Object.keys(all);
    while (keys.length > 100) delete all[keys.shift()!];
    localStorage.setItem(LS_TOOLS_POS, JSON.stringify(all));
  } catch {
    /* quota */
  }
}

function clearToolsPos(paneId: string) {
  toolsPosCache.delete(paneId);
  try {
    const all = JSON.parse(localStorage.getItem(LS_TOOLS_POS) ?? "{}") as Record<
      string,
      { x: number; y: number }
    >;
    delete all[paneId];
    localStorage.setItem(LS_TOOLS_POS, JSON.stringify(all));
  } catch {
    /* quota */
  }
}

interface Props {
  paneId: string;
  ptyId: number | null;
  cwd: string;
  visible: boolean;
  initCmd?: string | null;
  onClose: () => void;
}

function paneAlive(node: unknown, paneId: string): boolean {
  const v = node as { kind?: string; id?: string; first?: unknown; second?: unknown } | null;
  if (!v) return false;
  if (v.kind === "pane") return v.id === paneId;
  return paneAlive(v.first ?? null, paneId) || paneAlive(v.second ?? null, paneId);
}

// Sane grid, never zero: FitAddon on an unmeasured/hidden container reports
// 0s, and a 0-size ConPTY wedges rendering (blank pane).
function saneDims(term: Terminal): { cols: number; rows: number } | null {
  const cols = term.cols ?? 0;
  const rows = term.rows ?? 0;
  if (cols < 2 || rows < 1) return null;
  return { cols, rows };
}

function fitSane(term: Terminal, fit: FitAddon): { cols: number; rows: number } | null {
  try {
    fit.fit();
  } catch {
    return null;
  }
  return saneDims(term);
}
// Resize (split drag, font zoom, maximize) reflows the buffer, which resets
// the viewport — a long agent run jumps to the top and the user must scroll
// back down. Snapshot the viewport across fit() and restore it: pinned to
// the bottom when following live output, else the same line (clamped).
function fitKeepViewport(term: Terminal, fit: FitAddon): { cols: number; rows: number } | null {
  const dbg =
    typeof localStorage !== "undefined" && localStorage.getItem("GUIMUX_RESIZE_DEBUG") === "1";
  const pre = dbg
    ? (() => {
        try {
          const b = term.buffer.active;
          return `pre: vp=${b.viewportY} base=${b.baseY} cursorY=${b.cursorY} len=${b.length}`;
        } catch {
          return "pre: (no buffer)";
        }
      })()
    : "";
  let y = 0;
  let atBottom = true;
  try {
    const buf = term.buffer.active;
    y = buf.viewportY;
    atBottom = y >= buf.baseY;
  } catch {
    /* no buffer yet: fresh terminal */
  }
  try {
    fit.fit();
  } catch {
    return null;
  }
  const dims = saneDims(term);
  if (!dims) return null;
  try {
    if (atBottom) term.scrollToBottom();
    else term.scrollToLine(Math.max(0, Math.min(y, term.buffer.active.baseY)));
  } catch {
    /* best-effort restore */
  }
  if (dbg) {
    try {
      const b = term.buffer.active;
      console.log(
        `[gm-resize] fitKeepViewport ${dims.cols}x${dims.rows} atBottom=${atBottom} savedY=${y} ${pre} | post: vp=${b.viewportY} base=${b.baseY} cursorY=${b.cursorY} len=${b.length}`,
      );
    } catch {
      /* best-effort */
    }
  }
  return dims;
}

// A TUI repaint sends ED 3 (scrollback wipe), and a long agent run trims the
// scrollback cap on every line past it. Either way xterm deletes the lines
// above the viewport and clamps a scrolled-up one to line 0 — the reader lands
// at the very start of a buffer that keeps growing below them, with no way
// back but a long scroll. When a write clamps a non-following viewport to the
// start, its lines are gone from the buffer: show the live screen instead.
// A surviving place (xterm shifts it with the trim) is left alone.
function writeKeepPlace(term: Terminal, data: string | Uint8Array) {
  let vp = 0;
  let following = true;
  try {
    const b = term.buffer.active;
    vp = b.viewportY;
    following = vp >= b.baseY;
  } catch {
    /* no buffer yet */
  }
  term.write(data, () => {
    if (following || vp === 0) return;
    try {
      const b = term.buffer.active;
      if (b.viewportY === 0 && b.baseY > 0) term.scrollToBottom();
    } catch {
      /* disposed mid-write */
    }
  });
}

// Live-cwd tracking: the shell reports its cwd on every prompt via OSC 7
// (file:// URI) + OSC 9;9 (native path, ConPTY/WT style), emitted by the
// powershell bootstrap in pty.rs. Snoop the raw output bytes, keep the last
// match, store it on the pane so splits inherit the source pane's directory.
// ST is BEL or ESC\. Buffer tail is retained so a sequence split across two
// output chunks still parses.
function extractLiveCwd(buf: string): string | null {
  let native: string | null = null;
  let uriPath: string | null = null;
  let m: RegExpExecArray | null;
  const re99 = /\x1b\]9;9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  while ((m = re99.exec(buf)) !== null) {
    const p = m[1].trim();
    if (p) native = p;
  }
  const re7 = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  while ((m = re7.exec(buf)) !== null) {
    const uri = m[1].trim();
    const i = uri.indexOf("file://");
    if (i < 0) continue;
    const rest = uri.slice(i + "file://".length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue;
    let path = rest.slice(slash);
    try {
      path = decodeURIComponent(path);
    } catch {
      /* raw on bad escapes */
    }
    path = path.replace(/\//g, "\\");
    if (/^\\[A-Za-z]:\\/.test(path)) path = path.slice(1);
    if (/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) uriPath = path;
  }
  return native ?? uriPath;
}

export function TerminalPane({ paneId, ptyId, cwd, visible, initCmd, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const unlisteners = useRef<UnlistenFn[]>([]);
  const sessionRef = useRef<number | null>(ptyId);
  const shellKindRef = useRef<PtySession["shell_kind"]>("unknown");
  // Agent fan-out: one-shot command typed into a fresh shell, then cleared.
  const initCmdRef = useRef<string | null>(initCmd ?? null);
  initCmdRef.current = initCmd ?? null;
  const exitedRef = useRef(false);
  // Mirrors the mount effect's `alive` flag for code that outlives a render.
  const aliveRef = useRef(true);
  // The resize observer is created once per pane: reading the prop directly
  // left it pinned to the visibility of the first render.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [exited, setExited] = useState(false);
  const [webgl, setWebgl] = useState(true);
  const splitPane = useStore((s) => s.splitPane);
  const setActivePane = useStore((s) => s.setActivePane);
  const setPtyId = useStore((s) => s.setPtyId);
  const toggleMaximizePane = useStore((s) => s.toggleMaximizePane);
  const maximized = useStore((s) => s.maximizedPaneId === paneId);
  const paneCount = useStore((s) => allPaneIds(s.layout).length);
  // Live cwd, reported by the shell via OSC 7 / 9;9. Stored on the pane so
  // a split from D:/test/workspace/testing/ opens there, not worktree root.
  const liveCwdRef = useRef<string | null>(null);
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  // Resize storms (drag, zoom, observer echo) reflow ConPTY on every tick:
  // only forward when cols/rows actually changed — AND coalesce to one
  // backend resize ~120ms after the last change. xterm still fits on every
  // tick (the display tracks the window), but a window drag/maximize that
  // used to fire dozens of pty_resize calls now delivers ONE clean size to
  // ConPTY. Full-screen TUIs (Claude Code/Ink) repaint per resize event;
  // a rapid sequence interleaves ConPTY's screen repaint with the TUI's
  // own repaint and shoves the UI down, leaving blank rows above it.
  const resizeTimerRef = useRef<number | null>(null);
  const pendingDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  // Post-resize output trace: ConPTY's repaint AFTER a resize is the
  // remaining suspect (fit-time buffer was verified clean). For 2s after a
  // debounced resize fires, log buffer state per output chunk.
  const traceOutputUntilRef = useRef(0);
  // GUIMUX_RESIZE_DEBUG=1 (localStorage) traces the whole resize pipeline:
  // host px -> fit() grid -> debounce -> pty_resize, plus buffer state
  // (viewport/baseY) so a "blank rows at top" bug can be located to the
  // exact stage — px math (devicePixelRatio/scaling), grid change, or
  // buffer drift between xterm and ConPTY.
  const resizeDebug =
    typeof localStorage !== "undefined" && localStorage.getItem("GUIMUX_RESIZE_DEBUG") === "1";
  const dbg = (msg: string) => {
    if (resizeDebug) console.log(`[gm-resize pane=${paneId}] ${msg}`);
  };
  const bufferState = (t: Terminal) => {
    try {
      const b = t.buffer.active;
      return `vp=${b.viewportY} base=${b.baseY} cursorY=${b.cursorY} len=${b.length} rows=${t.rows} cols=${t.cols}`;
    } catch {
      return "(no buffer)";
    }
  };
  const maybeResize = (dims: { cols: number; rows: number } | null) => {
    if (!dims) return;
    const last = lastDimsRef.current;
    dbg(`fit result ${dims.cols}x${dims.rows} (last ${last ? `${last.cols}x${last.rows}` : "none"}) ${bufferState(termRef.current!)}`);
    if (last && last.cols === dims.cols && last.rows === dims.rows) return;
    lastDimsRef.current = dims;
    pendingDimsRef.current = dims;
    if (resizeTimerRef.current != null) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      const d = pendingDimsRef.current;
      pendingDimsRef.current = null;
      const sid = sessionRef.current;
      traceOutputUntilRef.current = Date.now() + 2000;
      dbg(`pty_resize -> ${d ? `${d.cols}x${d.rows}` : "?"} (debounced, sid=${sid})`);
      if (d && sid != null)
        invoke("pty_resize", { id: sid, cols: d.cols, rows: d.rows })
          .then(() => {
            dbg(`pty_resize ${d.cols}x${d.rows} ok`);
            // Render-layer audit: buffer state was verified clean by the
            // fit trace; if the prompt still renders displaced, the canvas
            // or viewport must be offset inside the host. Measure exactly
            // where the rendered screen sits vs the pane box.
            setTimeout(() => {
              const t = termRef.current;
              if (!t) return;
              try {
                const host = hostRef.current;
                const screen = host?.querySelector(".xterm-screen") as HTMLElement | null;
                const viewport = host?.querySelector(".xterm-viewport") as HTMLElement | null;
                const canvas = screen?.querySelector("canvas") as HTMLCanvasElement | null;
                const hr = host?.getBoundingClientRect();
                const sr = screen?.getBoundingClientRect();
                const vr = viewport?.getBoundingClientRect();
                dbg(
                  `render-audit: hostTop=${hr?.top.toFixed(1)} screenTop=${sr?.top.toFixed(1)} gapPx=${hr && sr ? (sr.top - hr.top).toFixed(1) : "?"} viewportScrollTop=${viewport?.scrollTop ?? "?"} viewportH=${vr?.height.toFixed(1)} screenH=${sr?.height.toFixed(1)} canvas=${canvas ? `${canvas.width}x${canvas.height} cssH=${canvas.getBoundingClientRect().height.toFixed(1)}` : "none"} rows=${t.rows} cols=${t.cols} vp=${t.buffer.active.viewportY} base=${t.buffer.active.baseY} len=${t.buffer.active.length} cursorY=${t.buffer.active.cursorY}`,
                );
              } catch (e) {
                dbg(`render-audit failed: ${e}`);
              }
            }, 150);
          })
          .catch((e) => dbg(`pty_resize FAILED: ${e}`));
    }, 120);
  };
  const snoopTailRef = useRef("");
  const snoopLiveCwd = (bytes: Uint8Array) => {
    let text: string;
    try {
      text = new TextDecoder().decode(bytes);
    } catch {
      return;
    }
    if (!text.includes("\x1b]")) {
      // No OSC opener: still bound the tail for the rare split sequence.
      snoopTailRef.current = (snoopTailRef.current + text).slice(-512);
      return;
    }
    const buf = snoopTailRef.current + text;
    const found = extractLiveCwd(buf);
    snoopTailRef.current = buf.slice(-512);
    if (found && found !== liveCwdRef.current) {
      liveCwdRef.current = found;
      useStore.getState().setPaneCwd(paneId, found);
    }
  };

  const markExited = () => {
    exitedRef.current = true;
    setExited(true);
  };

  // Listeners first, THEN pty_attach: the backend buffers everything since
  // spawn and replays it, so the spawn→listen window drops nothing.
  // Paste is the only input path that bypasses onData (native `paste` DOM
  // event -> xterm handles it internally). Mark dirty there; typed keys and
  // drops go through onData below. ponytail: keystrokes alone never decide
  // reuse — the launch-time buffer scan does — so a stray mark here only
  // costs a split, never work.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onPasteCapture = () => useStore.getState().markPaneDirty(paneId);
    el.addEventListener("paste", onPasteCapture, true);
    return () => el.removeEventListener("paste", onPasteCapture, true);
  }, [paneId]);

  // Listeners first, THEN pty_attach: the backend buffers everything since
  // spawn and replays it, so the spawn→listen window drops nothing.
  const attach = async (term: Terminal, sid: number) => {
    const disposeOutput = await listen<number[]>(`pty:output-${sid}`, (ev) => {
      const bytes = new Uint8Array(ev.payload);
      snoopLiveCwd(bytes);
      if (localStorage.getItem("GUIMUX_RESIZE_DEBUG") === "1" && Date.now() < traceOutputUntilRef.current) {
        const text = new TextDecoder().decode(bytes).replace(/\x1b/g, "\\e");
        console.log(
          `[gm-resize pane=${paneId}] post-resize output ${bytes.length}B: ${JSON.stringify(text.slice(0, 300))} | ${(() => {
            try {
              const b = term.buffer.active;
              return `vp=${b.viewportY} base=${b.baseY} cursorY=${b.cursorY} len=${b.length}`;
            } catch {
              return "(no buffer)";
            }
          })()}`,
        );
      }
      try {
        writeKeepPlace(term, bytes);
      } catch (e) {
        console.error(`[gm-term] output write failed pane=${paneId} sid=${sid}:`, e);
      }
    });
    const disposeExit = await listen<number>(`pty:exit-${sid}`, () => {
      term.writeln("\r\n\x1b[90m[process exited: hit Restart below to reopen the shell]\x1b[0m");
      markExited();
    });
    // Unmounted mid-await: these handlers would otherwise outlive the
    // terminal and keep firing into a disposed buffer, and attaching would
    // drain the backend's replay buffer for a pane that is no longer there.
    if (!aliveRef.current) {
      disposeOutput();
      disposeExit();
      return;
    }
    unlisteners.current.push(disposeOutput, disposeExit);
    const attached = await invoke<PtyAttach>("pty_attach", { id: sid });
    shellKindRef.current = attached.shell_kind;
    if (attached.replay.length > 0) {
      const bytes = new Uint8Array(attached.replay);
      snoopLiveCwd(bytes);
      writeKeepPlace(term, bytes);
    }
  };

  // WebGL primary, canvas/DOM fallback. Buffer, cursor, and focus live on the
  // Terminal, not the addon, so disposing the addon loses nothing.
  const enableWebgl = (term: Terminal) => {
    if (webglRef.current) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        try {
          addon.dispose();
        } catch {
          /* already gone */
        }
        if (webglRef.current === addon) webglRef.current = null;
        setWebgl(false); // canvas/DOM fallback, buffer intact
      });
      term.loadAddon(addon);
      webglRef.current = addon;
      setWebgl(true);
    } catch {
      webglRef.current = null;
      setWebgl(false);
    }
  };

  const spawnFresh = async (term: Terminal, fit: FitAddon): Promise<number> => {
    const dims = fitSane(term, fit) ?? { cols: 80, rows: 24 };
    const session = await invoke<PtySession>("pty_spawn", {
      cwd,
      cols: dims.cols,
      rows: dims.rows,
    });
    // The PTY was born at this size: a post-spawn maybeResize with the same
    // dims must not re-send it (they'd no-op anyway, but keep the ledger true).
    lastDimsRef.current = dims;
    sessionRef.current = session.id;
    shellKindRef.current = session.shell_kind;
    setPtyId(paneId, session.id);
    return session.id;
  };

  const restart = async () => {
    const term = termRef.current;
    if (!term) return;
    useStore.getState().markPaneClean(paneId);
    const sid = sessionRef.current;
    const dims = saneDims(term) ?? { cols: 80, rows: 24 };
    lastDimsRef.current = dims;
    // Same-id restart keeps the existing listeners alive: the backend
    // respawns the child and the reader thread re-emits on the same
    // `pty:output-{id}` channel, so output flows with no re-subscribe.
    try {
      if (sid != null) {
        const session = await invoke<PtySession>("pty_restart", { id: sid, cols: dims.cols, rows: dims.rows });
        shellKindRef.current = session.shell_kind;
      } else {
        throw new Error("no session yet");
      }
    } catch {
      // Backend lost the session entirely: spawn a fresh one and rewire.
      try {
        for (const un of unlisteners.current) un();
        unlisteners.current = [];
        const id = await spawnFresh(term, fitRef.current!);
        await attach(term, id);
      } catch (e) {
        term.writeln(`\x1b[31mrestart failed: ${e}\x1b[0m`);
        return;
      }
    }
    exitedRef.current = false;
    setExited(false);
    term.clear();
    term.focus();
  };

  // Raw fallback when the Web Clipboard API is denied (focus/permission):
  // ^V lets PSReadLine/conhost paste from the system clipboard themselves.
  // Bypasses xterm (no onData), so mark dirty here too. Kept next to the
  // main onData marker so both write paths stay in sync.
  const sendRaw = (data: string) => {
    const sid = sessionRef.current;
    if (sid != null && !exitedRef.current) {
      useStore.getState().markPaneDirty(paneId);
      invoke("pty_write", { id: sid, data }).catch(() => {});
    }
  };

  // Transient pane hint (clipboard empty, image save failed). A small
  // overlay, never terminal output: writing into the grid would pollute the
  // shell.
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const pasteHintTimer = useRef<number | null>(null);
  const showPasteHint = (msg: string) => {
    setPasteHint(msg);
    if (pasteHintTimer.current != null) clearTimeout(pasteHintTimer.current);
    pasteHintTimer.current = window.setTimeout(() => setPasteHint(null), 2200);
  };
  useEffect(
    () => () => {
      if (pasteHintTimer.current != null) clearTimeout(pasteHintTimer.current);
    },
    [],
  );

  const pasteShellPath = (path: string) => {
    const sid = sessionRef.current;
    const term = termRef.current;
    const quoted = quoteForShell(path, shellKindRef.current);
    if (!quoted) {
      if (!navigator.clipboard) {
        showPasteHint("This shell cannot paste paths safely");
        return;
      }
      void navigator.clipboard
        .writeText(path)
        .then(() => showPasteHint("Path copied — paste it manually in this shell"))
        .catch(() => showPasteHint("Path copy failed"));
      return;
    }
    if (sid == null || !term || exitedRef.current) return;
    term.focus();
    setActivePane(paneId);
    try {
      term.input(quoted, true);
    } catch {
      invoke("pty_write", { id: sid, data: quoted }).catch(() => showPasteHint("Failed to paste path"));
    }
  };

  // Chord-initiated pastes (Ctrl+V et al below) are followed ~instantly by
  // the webview's own native `paste` event. The async pasteClipboard() owns
  // those gestures, so the sync reader must stand down briefly or every
  // key-chord paste lands twice. Refreshed per chord, so rapid repeats keep
  // working; a menu-only paste inside the window is the accepted tradeoff.
  const chordPasteAt = useRef(0);

  // ConPTY wants CR for newlines; a lone LF pastes as a bare linefeed.
  const normalizePaste = (text: string) => text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");

  const pasteDebug = (info: string) => {
    try {
      if (localStorage.getItem("GUIMUX_PASTE_DEBUG") === "1") console.log(`[gm-paste pane=${paneId}] ${info}`);
    } catch {
      /* storage unavailable */
    }
  };

  // Fresh cwd for the mount-effect closures below, which capture the first
  // render: the pane keeps its identity while the worktree cwd can change.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Image paste: save the blob under `<cwd>/.guimux-pastes/` and paste the
  // quoted path, so a screenshot Ctrl+V lands a file the shell (or an agent
  // reading the path) can use.
  const pasteImageBlob = async (blob: Blob, chord: string) => {
    const ext =
      blob.type === "image/jpeg" ? "jpg"
      : blob.type === "image/gif" ? "gif"
      : blob.type === "image/webp" ? "webp"
      : blob.type === "image/bmp" ? "bmp"
      : "png";
    const dir = cwdRef.current.replace(/[/\\]+$/, "");
    const name = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const path = `${dir}/.guimux-pastes/${name}`;
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const base64 = dataUrl.split(",", 2)[1] ?? "";
      if (!base64) throw new Error("empty image data");
      const saved = await invoke<string>("fs_write_bytes", { path, base64 });
      pasteDebug(`chord=${chord} imageSaved=${blob.size}B ext=${ext} fallbackUsed=false`);
      pasteShellPath(saved);
    } catch (e) {
      pasteDebug(`chord=${chord} imageSaveFailed fallbackUsed=false`);
      showPasteHint("Couldn't save pasted image");
    }
  };

  const copySelection = () => {
    const term = termRef.current;
    if (!term || !term.hasSelection()) return false;
    const sel = term.getSelection();
    if (!sel) return false;
    const done = () => {
      term.clearSelection();
      term.focus();
    };
    const fallbackCopy = () => {
      // No async Clipboard API (denied/unsupported): execCommand from a temp
      // field. Selection stays put on failure so the user can retry.
      try {
        const ta = document.createElement("textarea");
        ta.value = sel;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (ok) done();
        else term.focus();
      } catch {
        term.focus();
      }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(sel).then(done, fallbackCopy);
    else fallbackCopy();
    return true;
  };

  const pasteClipboard = (chord = "key") => {
    const term = termRef.current;
    term?.focus();
    if (navigator.clipboard?.readText) {
      navigator.clipboard
        .readText()
        .then(async (text) => {
          if (text) {
            // Single sender: term.paste honors bracketed-paste mode and flows
            // through onData -> pty_write. Raw pty_write would not.
            pasteDebug(`chord=${chord} textLen=${text.length} imagePresent=false fallbackUsed=false`);
            try {
              term?.paste(normalizePaste(text));
            } catch {
              sendRaw(normalizePaste(text));
            }
            return;
          }
          // Empty text: probe for an image and save it under
          // `.guimux-pastes/`, pasting the file path. A screenshot copy is
          // never a silent no-op.
          let imageType: string | null = null;
          let imageItem: ClipboardItem | null = null;
          try {
            if (navigator.clipboard?.read) {
              const items = await navigator.clipboard.read();
              for (const it of items) {
                const t = it.types.find((x) => x.startsWith("image/"));
                if (t) {
                  imageType = t;
                  imageItem = it;
                  break;
                }
              }
            }
          } catch {
            /* probe denied: treat as empty */
          }
          if (imageItem && imageType) {
            try {
              const blob = await imageItem.getType(imageType);
              await pasteImageBlob(blob, chord);
            } catch {
              pasteDebug(`chord=${chord} textLen=0 imagePresent=true fallbackUsed=false`);
              showPasteHint("Couldn't read pasted image");
            }
            return;
          }
          pasteDebug(`chord=${chord} textLen=0 imagePresent=false fallbackUsed=false`);
          showPasteHint("Clipboard is empty");
        })
        .catch(() => {
          // Permission denial only: let the shell paste itself. Empty/image
          // never reaches here, so this is not a blind fallback.
          pasteDebug(`chord=${chord} textLen=? imagePresent=? fallbackUsed=true`);
          sendRaw("\x16");
        });
    } else {
      pasteDebug(`chord=${chord} textLen=? imagePresent=? fallbackUsed=true`);
      sendRaw("\x16");
    }
  };

  const fontSize = useStore((s) => s.settings.terminalFontSize);
  const scrollback = useStore((s) => s.settings.scrollback);

  // Font zoom: apply cell size, refit the grid, then tell the pty its new
  // dims. Skipping the resize leaves the shell wrapping at the old width.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    // Live panes need this too: scrollback was frozen at mount, and the pane
    // created at boot predates the persisted settings load.
    if (term.options.scrollback !== scrollback) term.options.scrollback = scrollback;
    maybeResize(fitRef.current ? fitKeepViewport(term, fitRef.current) : saneDims(term));
  }, [fontSize, scrollback]);

  // Ctrl+wheel / Ctrl+= / Ctrl+- zooms this pane; Ctrl+0 resets.
  // Wheel needs a non-passive listener + stopPropagation: xterm's own wheel
  // handler scrolls otherwise, and the browser zooms the whole page.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const clamp = (n: number) => Math.min(24, Math.max(10, Math.round(n)));
    const step = (d: number) => {
      const st = useStore.getState();
      st.setSettings({ terminalFontSize: clamp(st.settings.terminalFontSize + d) });
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      step(e.deltaY < 0 ? 1 : -1);
    };
    // Scoped to this pane's own grid: every mounted pane registers this
    // window listener, and an unscoped check would zoom N times for N panes.
    const inThisTerm = (e: KeyboardEvent) => {
      const t = e.target as Node | null;
      if (t && el.contains(t)) return true;
      const ae = document.activeElement;
      return !!ae && el.contains(ae);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !inThisTerm(e)) return;
      if (e.key === "0") {
        e.preventDefault();
        useStore.getState().setSettings({ terminalFontSize: 13 });
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        step(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        step(-1);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
    };
  }, []);

  useEffect(() => {
    if (!hostRef.current || termRef.current) return;

    const term = new Terminal({
      scrollback,
      fontSize,
      // Hosted on ConPTY (Windows): tells xterm its reflow must match
      // ConPTY's buffer behavior. Without this, growing the window drops
      // reflowed lines into scrollback while ConPTY reprints in place —
      // the buffers drift and blank rows pile up above the prompt (the
      // "wasted space at top" after window resize). buildNumber 21376+
      // keeps reflow ON (native wrapping is correct there); the key thing
      // is backend !== undefined, which activates the viewport-compensation
      // heuristic for rows added to scrollback on growth.
      windowsPty: { backend: "conpty", buildNumber: 21376 },
      // 1.2 like Windows Terminal: 1.0 leaves zero leading so ascenders
      // and descenders touch/clip on neighboring rows (the cramped look).
      lineHeight: 1.2,
      // Cascadia Mono first: native on Windows, drawn for ConPTY box/powerline
      // glyphs at the same advance so TUIs stay aligned; JetBrains next.
      fontFamily: '"Cascadia Mono", "JetBrains Mono", "Ubuntu Mono", Consolas, "DejaVu Sans Mono", Menlo, Monaco, ui-monospace, SFMono-Regular, "Symbols Nerd Font Mono", monospace',
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "block",
      drawBoldTextInBrightColors: true,
      // 1 (off): 4.5 recolors dim TUI grays to pass contrast, washing out
      // palettes that native terminals pass through untouched.
      minimumContrastRatio: 1,
      macOptionClickForcesSelection: true,
      // Opaque: WebGL + transparent background flickers (compositor
      // blends every frame). Tile div is the same #000000, so no seam.
      theme: {
        background: "#000000",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        cursorAccent: "#171717",
        selectionBackground: "rgba(229,229,229,0.28)",
        black: "#171717",
        red: "#c74e39",
        green: "#81b88b",
        yellow: "#e2c08d",
        blue: "#3794ff",
        magenta: "#b66dff",
        cyan: "#40b0a6",
        white: "#fafafa",
        // Bright variants: without these, CLIs using bright ANSI codes fall
        // back to xterm's defaults, which sit off-palette on graphite.
        brightBlack: "#525252",
        brightRed: "#e07a66",
        brightGreen: "#a4d1ae",
        brightYellow: "#ecd3a4",
        brightBlue: "#6ca8ff",
        brightMagenta: "#c98dff",
        brightCyan: "#5cc4b8",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      // Opaque background: no alpha blending, no per-frame composite.
      allowTransparency: false,
    });
    const fit = new FitAddon();
    // Unicode 11 width tables BEFORE any
    // write. CJK/emoji/ZWJ bake their cell width at write time; restoring
    // scrollback under the default v6 tables lays wide chars out as single
    // cells and re-measurement breaks pairing (split glyphs, stray gaps).
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    try {
      term.unicode.activeVersion = "11";
    } catch {
      /* older xterm: provider stays default */
    }
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    term.open(hostRef.current);
    registerLiveTerm(paneId, term);
    // Single paste path: the native `paste` DOM event carries the only
    // synchronous clipboard source (`clipboardData`), so read it here first
    // and send via term.paste() (bracketed-paste aware, one sender). The
    // Ctrl+V / right-click path below ALSO sends via term.paste() — the
    // preventDefault here keeps the native handler from double-sending.
    // Keydown preventDefault is NOT enough: xterm's keydown path never
    // cancels it on the custom-handler early-return, and the webview fires
    // the paste event anyway.
    // ponytail: one capture listener; drop it if xterm ever gains a "no native paste" option.
    const killNativePaste = (e: Event) => {
      // Owned by the chord handler just now: eat without re-sending, or the
      // gesture pastes twice (sync here + async pasteClipboard).
      if (Date.now() - chordPasteAt.current < 500) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const ce = e as ClipboardEvent;
      const data = ce.clipboardData;
      const text = data?.getData("text/plain") ?? "";
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        pasteDebug(`chord=native-paste textLen=${text.length} imagePresent=false fallbackUsed=false`);
        useStore.getState().markPaneDirty(paneId);
        try {
          term.paste(normalizePaste(text));
        } catch {
          sendRaw(normalizePaste(text));
        }
        return;
      }
      const files = data?.files;
      const imageFile = files ? Array.from(files).find((f) => f.type.startsWith("image/")) : undefined;
      if (imageFile) {
        e.preventDefault();
        e.stopPropagation();
        pasteDebug(`chord=native-paste textLen=0 imagePresent=true fallbackUsed=false`);
        useStore.getState().markPaneDirty(paneId);
        void pasteImageBlob(imageFile, "native-paste");
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    hostRef.current.addEventListener("paste", killNativePaste, true);
     // Keybinds that must work while a TUI owns the grid: Ctrl+C copy when
    // text is selected (else the SIGINT the TUI may need), Ctrl+V paste.
    // Supported paste chords: Ctrl+V, Cmd+V, Ctrl+Shift+V (shift is
    // intentionally not excluded), Shift+Insert. Alt+V is NOT paste anywhere
    // (it falls through to the PTY as ESC+v for readline); claiming it would
    // break word-backward bindings. Returning false keeps xterm from also
    // feeding the key to the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.type === "keydown") {
        const termNow = termRef.current;
        if (e.key.toLowerCase() === "c" && termNow?.hasSelection()) {
          copySelection();
          return false;
        }
        if (e.key.toLowerCase() === "v") {
          chordPasteAt.current = Date.now();
          pasteClipboard(e.shiftKey ? "ctrl-shift-v" : e.metaKey && !e.ctrlKey ? "cmd-v" : "ctrl-v");
          return false;
        }
      }
      // Shift+Insert emits a native `paste` event (xterm emits no key for it);
      // the capture listener above eats that event, so send it ourselves.
      if (e.type === "keydown" && e.key === "Insert" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        chordPasteAt.current = Date.now();
        pasteClipboard("shift-insert");
        return false;
      }
      // Ctrl+Backspace: xterm emits a bare ^H (0x08), which ConPTY delivers
      // WITHOUT the Ctrl modifier, so the shell sees a plain single-letter
      // backward-delete. Translate to ^W (Ctrl+W) — backward-kill-word by
      // default in PSReadLine, readline, zsh and fish — but only on the
      // normal buffer: alternate-screen TUIs get the raw key untouched.
      if (e.type === "keydown" && e.key === "Backspace" && e.ctrlKey && !e.metaKey && !e.altKey) {
        let alt = false;
        try {
          const t = termRef.current;
          alt = t != null && t.buffer.active !== t.buffer.normal;
        } catch {
          alt = false;
        }
        if (!alt) {
          try {
            if (localStorage.getItem("GUIMUX_KEY_DEBUG") === "1")
              console.log(`[gm-key pane=${paneId}] ctrl-backspace -> ^W`);
          } catch {
            /* storage unavailable */
          }
          sendRaw("\x17");
          return false;
        }
      }
      return true;
    });
    // Registered before the spawn/attach round-trips below: xterm fires into
    // nothing until a listener exists, so the first keystrokes were dropped.
    term.onData((data) => {
      // Word-kill probe: with GUIMUX_KEY_DEBUG=1, log the raw codes reaching
      // pty_write for Backspace/Delete chords. Ctrl+Backspace in the normal
      // buffer is translated to ^W above and never reaches here; in a TUI it
      // arrives as ^H, Ctrl+Delete as ESC[3;5~.
      try {
        if (localStorage.getItem("GUIMUX_KEY_DEBUG") === "1" && /[\x7f\x08]|\x1b\[3/.test(data)) {
          const codes = Array.from(data).map((c) => c.charCodeAt(0));
          console.log(`[gm-key pane=${paneId}] onData codes=${JSON.stringify(codes)}`);
        }
      } catch {
        /* storage unavailable */
      }
      useStore.getState().markPaneDirty(paneId);
      if (exitedRef.current) return;
      const sid = sessionRef.current;
      if (sid != null) invoke("pty_write", { id: sid, data });
    });
    enableWebgl(term);

    // Restore persisted scrollback (best-effort: a corrupt buffer must never
    // break the mount or suppress the live prompt). Never marks dirty here:
    // remounts (worktree switch, HMR) restore on every return, and the live
    // buffer scan already vetoes panes whose history is real output.
    try {
      const saved = readScrollback(paneId);
      if (saved) {
        const ser = new SerializeAddon();
        term.loadAddon(ser);
        term.write(saved);
      }
    } catch {
      /* fall through to live shell */
    }

    let alive = true;
    aliveRef.current = true;

    (async () => {
      if (!alive) return;
      let sessionId = sessionRef.current;
      // Remount onto a shell that died while unmounted: attach listeners
      // first (so Restart recovers), then surface the Restart banner.
      // Input wiring below still runs; only the one-shot initCmd is held.
      let deadSession = false;
      if (sessionId != null) {
        // Layout kept an id (remount after split / worktree switch).
        // pty_attach validates; rejection = spawn fresh, not blank.
        try {
          await attach(term, sessionId);
          const live = await invoke<boolean>("pty_alive", { id: sessionId }).catch(() => true);
          if (!live) {
            deadSession = true;
            markExited();
            term.writeln("\r\n\x1b[90m[process exited: hit Restart below to reopen the shell]\x1b[0m");
          }
        } catch {
          if (!alive) return;
          for (const un of unlisteners.current) un();
          unlisteners.current = [];
          try {
            sessionId = await spawnFresh(term, fit);
            if (!alive) {
              invoke("pty_kill", { id: sessionId });
              return;
            }
            sessionRef.current = sessionId;
            await attach(term, sessionId);
          } catch (e) {
            term.writeln(`\x1b[31mfailed to spawn shell: ${e}\x1b[0m`);
            return;
          }
        }
      } else {
        try {
          sessionId = await spawnFresh(term, fit);
          if (!alive) {
            invoke("pty_kill", { id: sessionId });
            return;
          }
          sessionRef.current = sessionId;
        } catch (e) {
          term.writeln(`\x1b[31mfailed to spawn shell: ${e}\x1b[0m`);
          return;
        }
        await attach(term, sessionId);
      }

      // Fire-and-forget: the pty input buffer holds the line until the shell
      // prompts. Non-blocking so a slow shell never delays keystrokes.
      // Dead session: hold the command for Restart (its write would drop).
      const pending = deadSession ? null : initCmdRef.current;
      if (pending) {
        const cmdText = pending;
        setTimeout(() => {
          if (!alive || exitedRef.current) return;
          const sid = sessionRef.current;
          if (sid == null) return;
          invoke("pty_write", { id: sid, data: `${cmdText}\r` })
            .then(() => {
              initCmdRef.current = null;
              useStore.getState().clearInitCmd(paneId);
            })
            .catch(() => {
              /* session died: keep initCmd for the next remount */
            });
        }, 600);
      }

    })();

    const ro = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      // One fit+resize per frame tops: the observer can fire multiple times
      // per layout change, and fit() itself mutates layout (echo loop).
      requestAnimationFrame(() => {
        if (!alive || !visibleRef.current) return;
        const hostPx =
          hostRef.current?.getBoundingClientRect();
        if (resizeDebug && hostPx) {
          console.log(
            `[gm-resize pane=${paneId}] observer: host=${hostPx.width.toFixed(1)}x${hostPx.height.toFixed(1)}px dpr=${window.devicePixelRatio}`,
          );
        }
        maybeResize(fitRef.current ? fitKeepViewport(term, fitRef.current) : null);
      });
    });
    ro.observe(hostRef.current);

    return () => {
      alive = false;
      aliveRef.current = false;
      if (resizeTimerRef.current != null) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      unregisterLiveTerm(paneId);
      ro.disconnect();
      hostRef.current?.removeEventListener("paste", killNativePaste, true);
      for (const un of unlisteners.current) un();
      unlisteners.current = [];
      // persist scrollback
      try {
        const ser = new SerializeAddon();
        term.loadAddon(ser);
        persistScrollback(paneId, ser.serialize());
      } catch {
        /* serialize may fail */
      }
      // Splitting remounts while the pane stays in the tree; worktree
      // switches unmount panes whose trees stay cached in `layouts`.
      // Only reap when the pane is gone from EVERY cached tree (close).
      // ponytail: linear scan over cached worktrees; fine for <100 trees.
      const st = useStore.getState();
      const kept =
        paneAlive(st.layout, paneId) ||
        Object.values(st.layouts).some((n) => paneAlive(n, paneId));
      if (!kept) {
        const sid = sessionRef.current;
        if (sid != null) invoke("pty_kill", { id: sid });
      }
      try {
        webglRef.current?.dispose();
      } catch {
        /* context already lost */
      }
      webglRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]); // ptyId tracked via sessionRef; prop changes handled explicitly

  // Agent launch into an already-mounted clean pane: the mount path above
  // only fires initCmd once, so a command assigned later (reuse, no split)
  // is typed here. Fresh panes skip this (no session yet; mount handles it).
  useEffect(() => {
    if (!initCmd) return;
    if (!termRef.current || sessionRef.current == null || exitedRef.current) return;
    const cmdText = initCmd;
    const t = setTimeout(() => {
      const sid = sessionRef.current;
      if (sid == null || exitedRef.current) return;
      invoke("pty_write", { id: sid, data: `${cmdText}\r` })
        .then(() => useStore.getState().clearInitCmd(paneId))
        .catch(() => {
          /* session died: keep initCmd for the next remount */
        });
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initCmd]);

  // Pause rendering when hidden: dispose webgl, keep PTY alive.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (visible) {
      try {
        maybeResize(fitRef.current ? fitKeepViewport(term, fitRef.current) : null);
      } catch {
        /* noop */
      }
      // Re-attempt WebGL on every return to visible (context may have freed).
      enableWebgl(term);
    } else if (webglRef.current) {
      try {
        webglRef.current.dispose();
      } catch {
        /* noop */
      }
      webglRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Release-to-paste: HTML5 drop never fires in this webview, so the
  // explorer announces the release point and the pane under it feeds the
  // quoted path through its own live terminal input (same path typed keys
  // use). The acceptDrag/handleDrop handlers below stay as the fallback
  // for OS file drops if the webview ever dispatches real drop events.
  // Toolbar chip drag: press the grip and drop the chip anywhere in the pane.
  // Pointer events only (no dataTransfer); clamped inside the pane, position
  // remembered per pane. Double-click the grip to snap back to the corner.
  const toolsRef = useRef<HTMLDivElement>(null);
  const [toolsPos, setToolsPos] = useState<{ x: number; y: number } | null>(() =>
    readToolsPos(paneId),
  );
  const moveToolsDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const barEl = toolsRef.current;
    if (!barEl) return;
    const barRect = barEl.getBoundingClientRect();
    const dx = e.clientX - barRect.left;
    const dy = e.clientY - barRect.top;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    let last: { x: number; y: number } | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (last) writeToolsPos(paneId, last);
    };
    const move = (ev: MouseEvent) => {
      const r = paneRef.current?.getBoundingClientRect();
      if (!r || r.width <= 0) return;
      const bw = barEl.offsetWidth;
      const bh = barEl.offsetHeight;
      last = {
        x: Math.min(Math.max(4, ev.clientX - r.left - dx), Math.max(4, r.width - bw - 4)),
        y: Math.min(Math.max(4, ev.clientY - r.top - dy), Math.max(4, r.height - bh - 4)),
      };
      setToolsPos(last);
    };
    const up = () => finish();
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  };
  const dragDepth = useRef(0);
  const [dropHot, setDropHot] = useState(false);
  useEffect(() => {
    const onFileDrop = (ev: Event) => {
      const { path, x, y } = (ev as CustomEvent<{ path: string; x: number; y: number }>).detail ?? {};
      if (!path) return;
      const el = paneRef.current ? document.elementFromPoint(x, y) : null;
      const inside = !!el && !!paneRef.current?.contains(el);
      if (!inside || exitedRef.current) return;
      if (sessionRef.current == null) return;
      pasteShellPath(path);
    };
    window.addEventListener("gm-file-drop", onFileDrop);
    return () => window.removeEventListener("gm-file-drop", onFileDrop);
  }, [paneId]);
  // OS file drags (Explorer -> window) never fire HTML5 drag events here,
  // so the bridge announces the hovered point and the pane under it glows.
  useEffect(() => {
    const onOver = (ev: Event) => {
      const { x, y } = (ev as CustomEvent<{ x: number; y: number }>).detail ?? {};
      if (typeof x !== "number" || typeof y !== "number") return;
      const el = paneRef.current ? document.elementFromPoint(x, y) : null;
      const inside = !!el && !!paneRef.current?.contains(el);
      setDropHot(visibleRef.current && !exitedRef.current && inside);
    };
    const onLeave = () => setDropHot(false);
    window.addEventListener("gm-file-drag-over", onOver);
    window.addEventListener("gm-file-drag-leave", onLeave);
    return () => {
      window.removeEventListener("gm-file-drag-over", onOver);
      window.removeEventListener("gm-file-drag-leave", onLeave);
    };
  }, [paneId]);
  const acceptDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const handleDragEnter = (e: React.DragEvent) => {
    acceptDrag(e);
    dragDepth.current += 1;
    if (!exitedRef.current) setDropHot(true);
  };
  const handleDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropHot(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // A Tauri OS drop already pasted: this late HTML5 echo is stale.
    if (recentOsDrop()) return;
    dragDepth.current = 0;
    setDropHot(false);
    if (exitedRef.current) return;
    // Primary channel: dragFile.path set by explorer dragstart in the same
    // JS context (same-app dataTransfer can arrive emptied in WebView2).
    // Fallbacks cover OS file drops and any other drag source.
    const stash = dragFile.path;
    dragFile.path = null;
    const dt = e.dataTransfer;
    const path =
      stash ||
      dt.getData("text/plain") ||
      dt.getData("application/guimux-file-path") ||
      (dt.files?.[0] as (File & { path?: string }) | undefined)?.path ||
      "";
    if (!path || sessionRef.current == null) return;
    pasteShellPath(path);
  };

  return (
    <div
      ref={paneRef}
      className="relative h-full w-full"
      data-drop-hot={dropHot}
      data-pane-drop
      data-pty-id={sessionRef.current ?? undefined}
      style={dropHot ? { boxShadow: "inset 0 0 0 2px var(--gm-accent)" } : undefined}
      onMouseDown={() => {
        setActivePane(paneId);
        // Clicking pane chrome (toolbar, gutters) parks focus on a button or
        // div: without this every key after a mouse click goes nowhere.
        termRef.current?.focus();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (termRef.current?.hasSelection()) copySelection();
        else pasteClipboard("context-menu");
      }}
      onDragEnter={handleDragEnter}
      onDragOver={acceptDrag}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={toolsRef}
        className="absolute right-2 top-2 z-10 flex items-center opacity-0 transition-opacity duration-150 group-hover/pane:opacity-100 focus-within:opacity-100"
        style={toolsPos ? { left: toolsPos.x, top: toolsPos.y, right: "auto" } : undefined}
      >
        {!webgl && (
          <span
            title="Software rendering fallback (WebGL unavailable)"
            className="mr-1 rounded-md px-1.5 py-1 text-[10px] text-ink-500"
            style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
          >
            sw
          </span>
        )}
        <div className="gm-pane-tools" role="toolbar" aria-label="Pane controls">
          <button
            title="Drag to move toolbar, double-click to reset"
            aria-label="Drag to move toolbar"
            className="cursor-grab active:cursor-grabbing"
            onMouseDown={moveToolsDrag}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setToolsPos(null);
              clearToolsPos(paneId);
            }}
          >
            <GripVertical size={13} strokeWidth={2} />
          </button>
          <button
            title="Split right (Ctrl+Shift+D)"
            aria-label="Split pane right"
            onClick={() => splitPane(paneId, "h")}
          >
            <Columns2 size={13} strokeWidth={2} />
          </button>
          <button
            title="Split down"
            aria-label="Split pane down"
            onClick={() => splitPane(paneId, "v")}
          >
            <Rows2 size={13} strokeWidth={2} />
          </button>
          {paneCount > 1 && (
            <button
              title={maximized ? "Restore panes" : "Maximize pane"}
              aria-label={maximized ? "Restore panes" : "Maximize pane"}
              aria-pressed={maximized}
              onClick={() => toggleMaximizePane(paneId)}
            >
              {maximized ? <Minimize2 size={13} strokeWidth={2} /> : <Maximize2 size={13} strokeWidth={2} />}
            </button>
          )}
          <button
            title="Close pane"
            aria-label="Close pane"
            onClick={() => {
              const sid = sessionRef.current;
              if (sid != null) invoke("pty_kill", { id: sid });
              onClose();
            }}
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      {pasteHint && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
          <div
            className="gm-menu px-3 py-1.5 text-[12px] text-ink-200"
            role="status"
          >
            {pasteHint}
          </div>
        </div>
      )}
      {exited && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center pb-3">
          <div
            className="gm-menu flex items-center gap-2 px-3 py-1.5 text-[12px]"
          >
            <span className="text-ink-400">Shell exited</span>
            <button
              className="rounded-md px-2.5 py-1 font-semibold"
              style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
              onClick={restart}
            >
              Restart
            </button>
            <button
              className="rounded-md px-2 py-1 text-ink-400 hover:bg-[var(--gm-hover)] hover:text-ink-200"
              onClick={() => {
                const sid = sessionRef.current;
                if (sid != null) invoke("pty_kill", { id: sid });
                onClose();
              }}
            >
              Close pane
            </button>
          </div>
        </div>
      )}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
