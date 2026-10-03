import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import { allPaneIds, collectPaneObjs, useStore, type Pane, type PaneNode, type SessionKind } from "../store";
import { shortPath } from "../path";
import { dragFile, quoteForShell, recentOsDrop } from "../dragFile";
import type { PtyAttach, PtyOutput, PtySession } from "../types";
import { registerLiveTerm, unregisterLiveTerm } from "./paneEmpty";
import { extractLiveCwd, parseOsc, sessionNameFrom } from "./osc";
import { createOutputBatcher, decodeBase64, type OutputBatcher } from "./outputCodec";

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

// Pane tools used to be a floating chip you had to hover for, draggable so it
// would not cover TUI output, and persisted per pane. It is now a permanent
// header row: 28px a pane is cheaper than controls nobody can find, and a
// header cannot be dragged over the program it sits above.

// Stable colour + initial per agent name, so the same agent always wears the
// same badge across panes and restarts. Derived, not stored: it is decoration
// that must never be able to disagree with the name beside it.
const AGENT_TINTS = ["#e2c08d", "#81b88b", "#7fa8d8", "#c58bd0", "#d08b7f", "#8bd0c0"];

// Executables whose session name the backend knows how to find. Kept in step
// with the match arms in `agent_session.rs`: an agent missing here is never
// polled, so the UI cannot ask for a name the backend would only guess at.
const READABLE_AGENT_BINS = new Set(["claude", "codex"]);

type ResolvedTitle = { id: string; title: string; source: string; matched: boolean; via: "name" | "prompt" };

/// Panes competing for the same transcripts: same directory, same agent, and a
/// launch floor to search from. Two panes in one directory are only told apart
/// by being resolved together, never one at a time.
function agentGroup(layout: PaneNode | null, cwd: string, bin: string | null | undefined): Pane[] {
  if (!bin || !READABLE_AGENT_BINS.has(bin)) return [];
  return collectPaneObjs(layout).filter(
    (p) => p.agent && p.agentBin === bin && (p.cwd ?? cwd) === cwd && typeof p.agentSince === "number",
  );
}

/// The group as a string, so the store selector stays referentially stable and
/// the poll only restarts when the group itself changes: pane ids in tree order
/// (which is launch order), then how many of them still lack a name.
function agentGroupKey(
  layout: PaneNode | null,
  cwd: string,
  bin: string | null | undefined,
  paneId: string,
): string {
  const group = agentGroup(layout, cwd, bin);
  if (!group.some((p) => p.id === paneId)) return "";
  // A prompt is a placeholder: the pane still wants its real name, so it keeps
  // the group polling until one turns up.
  const pending = group.filter((p) => !p.session || p.sessionKind === "prompt").length;
  return `${group.map((p) => p.id).join(",")}|${pending}`;
}

/** How a pane's label should admit itself in the header tooltip. */
const PROVENANCE: Record<SessionKind, string> = {
  title: "name from the terminal title",
  name: "name read from",
  paired: "name matched by launch order, read from",
  prompt: "last prompt, no name yet, read from",
};

function agentBadge(agent: string): { tint: string; initial: string } {
  let h = 0;
  for (let i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) >>> 0;
  const initial = (agent.trim()[0] ?? "?").toUpperCase();
  return { tint: AGENT_TINTS[h % AGENT_TINTS.length], initial };
}

interface Props {
  paneId: string;
  ptyId: number | null;
  cwd: string;
  visible: boolean;
  initCmd?: string | null;
  /** Display name of the agent launched into this pane, or null for a shell. */
  agent?: string | null;
  /** Executable the agent runs as. The transcript fallback is per-agent. */
  agentBin?: string | null;
  /** When this pane launched its agent, ms since epoch. */
  agentSince?: number | null;
  /** Conversation name the agent last reported, or its last prompt until it
   *  reports one. */
  session?: string | null;
  /** What `session` is, so the header can say whether it is a real name. */
  sessionKind?: SessionKind | null;
  /** Where the name came from: "title" or a transcript path. */
  sessionFrom?: string | null;
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

// Live-cwd tracking and session-name watching: the shell reports its cwd on
// every prompt via OSC 7 (file:// URI) + OSC 9;9 (native path, ConPTY/WT
// style), emitted by the powershell bootstrap in pty.rs. Snoop the raw output
// bytes, keep the last match, store it on the pane so splits inherit the
// source pane's directory. The parsers live in ./osc with their own tests.

export function TerminalPane({ paneId, ptyId, cwd, visible, initCmd, agent, agentBin, agentSince, session, sessionKind, sessionFrom, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const unlisteners = useRef<UnlistenFn[]>([]);
  const outputBatcherRef = useRef<OutputBatcher | null>(null);
  const sessionRef = useRef<number | null>(ptyId);
  const sessionEpochRef = useRef<number | null>(null);
  const shellKindRef = useRef<PtySession["shell_kind"]>("unknown");
  // Agent fan-out: one-shot command typed into a fresh shell, then cleared.
  const initCmdRef = useRef<string | null>(initCmd ?? null);
  const initCmdEffectReadyRef = useRef(false);
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
  // Mirror for the header: the ref alone cannot re-render, and a pane that
  // does not say where it is is how you type a command in the wrong place.
  const [liveCwd, setLiveCwd] = useState<string | null>(null);
  // Last session name written. The title arrives on every prompt, so the store
  // is only touched when the name actually changed.
  const lastSessionRef = useRef<string | null>(session ?? null);
  const badge = agent ? agentBadge(agent) : null;

  // Transcript fallback for agents that never set a terminal title. Claude puts
  // an `ai-title` record in its transcript; Codex writes no name into the
  // rollout at all and keeps one in a side index, which the same command joins.
  //
  // Panes sharing a directory compete for the same transcripts, so the whole
  // group is resolved in one call by one of them (the first in tree order,
  // which is the order a fan-out launched them) and the rest only render what
  // the store already holds. The loop stops when every pane in the group has a
  // name. OpenCode stores sessions in SQLite and is simply never asked for.
  const groupKey = useStore((s) => agentGroupKey(s.layout, cwd, agentBin, paneId));
  const leads = groupKey.split("|")[0] === paneId;
  const pending = Number(groupKey.split("|")[1] ?? 0);
  useEffect(() => {
    // No floor, no question: a pane restored from disk cannot be told apart
    // from the sessions already on disk.
    if (!leads || pending === 0 || !agentBin || typeof agentSince !== "number") return;
    // Narrowed into a const: the closures below do not keep the narrowing.
    const bin = agentBin;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.hidden) return;
      const group = agentGroup(useStore.getState().layout, cwd, bin);
      if (group.length === 0) return;
      const dir = liveCwdRef.current ?? cwd;
      try {
        const found = await invoke<ResolvedTitle[]>("agent_session_titles", {
          cwd: dir,
          bin,
          panes: group.map((p) => ({ id: p.id, sinceMs: p.agentSince })),
        });
        if (cancelled) return;
        for (const hit of found ?? []) {
          // Same guard as the title path: a transcript could hold anything.
          const named = sessionNameFrom(hit.title, liveCwdRef.current ?? dir);
          if (!named) continue;
          // Three ways to get here and the user can tell them apart: the agent's
          // own name, that name matched by launch order rather than being the
          // only candidate, or the last prompt standing in for a name.
          const kind: SessionKind =
            hit.via === "prompt" ? "prompt" : hit.matched ? "paired" : "name";
          useStore.getState().setPaneSession(hit.id, named, hit.source, kind);
        }
      } catch {
        /* no session on disk yet, or the agent is not installed on this machine */
      }
    };
    // An agent names its session after the first exchange, so an immediate
    // check would be wasted.
    const first = setTimeout(() => void tick(), 8000);
    const every = setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(every);
    };
  }, [agentBin, agentSince, cwd, groupKey, leads, pending]);
  const snoopDecoderRef = useRef(new TextDecoder());
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
      dbg(`pty_resize -> ${d ? `${d.cols}x${d.rows}` : "?"} (debounced, sid=${sid})`);
      if (d && sid != null)
        invoke("pty_resize", { id: sid, cols: d.cols, rows: d.rows })
          .then(() => dbg(`pty_resize ${d.cols}x${d.rows} ok`))
          .catch((e) => dbg(`pty_resize FAILED: ${e}`));
    }, 120);
  };
  const snoopTailRef = useRef("");
  const snoopLiveCwd = (bytes: Uint8Array) => {
    let text: string;
    try {
      text = snoopDecoderRef.current.decode(bytes, { stream: true });
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
      setLiveCwd(found);
      useStore.getState().setPaneCwd(paneId, found);
    }
    // Only an agent pane has a session to name. A plain shell overwrites the
    // title with the cwd on every prompt, and sessionNameFrom rejects those.
    if (agent) {
      const named = sessionNameFrom(parseOsc(buf).title, liveCwdRef.current);
      if (named !== lastSessionRef.current) {
        lastSessionRef.current = named;
        useStore.getState().setPaneSession(paneId, named, null, "title");
      }
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
const pending: PtyOutput[] = [];
    let replaying = true;
    const writeOutput = (output: PtyOutput) => {
      const currentEpoch = sessionEpochRef.current;
      if (currentEpoch != null && output.epoch < currentEpoch) return;
      sessionEpochRef.current = output.epoch;
      // Batch it: the flush callback decodes, snoops and writes once per
      // frame, in arrival order.
      outputBatcherRef.current?.push(decodeBase64(output.bytes));
    };
    const disposeOutput = await listen<PtyOutput>(`pty:output-${sid}`, (ev) => {
      if (replaying) pending.push(ev.payload);
      else writeOutput(ev.payload);
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
try {
      const attached = await invoke<PtyAttach>("pty_attach", { id: sid });
      shellKindRef.current = attached.shell_kind;
      sessionEpochRef.current = attached.epoch;
      // Replay goes straight to the terminal so it lands before the queued
      // live chunks the batcher flushes on the next frame.
      if (attached.replay) {
        if (!aliveRef.current) return;
        const bytes = decodeBase64(attached.replay);
        snoopLiveCwd(bytes);
        writeKeepPlace(term, bytes);
      }
      for (const output of pending) writeOutput(output);
      pending.length = 0;
      replaying = false;
    } catch (error) {
      disposeOutput();
      disposeExit();
      throw error;
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
    sessionEpochRef.current = null;
    const session = await invoke<PtySession>("pty_spawn", {
      cwd,
      cols: dims.cols,
      rows: dims.rows,
    });
    // The PTY was born at this size: a post-spawn maybeResize with the same
    // dims must not re-send it (they'd no-op anyway, but keep the ledger true).
    lastDimsRef.current = dims;
    sessionRef.current = session.id;
    sessionEpochRef.current = session.epoch;
    shellKindRef.current = session.shell_kind;
    snoopDecoderRef.current = new TextDecoder();
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
    snoopDecoderRef.current = new TextDecoder();
    // Same-id restart keeps the existing listeners alive: the backend
    // respawns the child and the reader thread re-emits on the same
    // `pty:output-{id}` channel, so output flows with no re-subscribe.
    try {
      if (sid != null) {
        const session = await invoke<PtySession>("pty_restart", { id: sid, cols: dims.cols, rows: dims.rows });
        shellKindRef.current = session.shell_kind;
        sessionEpochRef.current = session.epoch;
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

  // Fresh cwd for the mount-effect closures below, which capture the first
  // render: the pane keeps its identity while the worktree cwd can change.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  // Image paste: save the blob under `<cwd>/.guimux-pastes/` and paste the
  // quoted path, so a screenshot Ctrl+V lands a file the shell (or an agent
  // reading the path) can use.
  const pasteImageBlob = async (blob: Blob) => {
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
      pasteShellPath(saved);
    } catch {
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

  const pasteClipboard = () => {
    const term = termRef.current;
    term?.focus();
    if (navigator.clipboard?.readText) {
      navigator.clipboard
        .readText()
        .then(async (text) => {
          if (text) {
            // Single sender: term.paste honors bracketed-paste mode and flows
            // through onData -> pty_write. Raw pty_write would not.
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
              await pasteImageBlob(await imageItem.getType(imageType));
            } catch {
              showPasteHint("Couldn't read pasted image");
            }
            return;
          }
          showPasteHint("Clipboard is empty");
        })
        .catch(() => {
          // Permission denial only: let the shell paste itself. Empty/image
          // never reaches here, so this is not a blind fallback.
          sendRaw("\x16");
        });
    } else {
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
    // One decode + two snoops + one term.write per frame, not per chunk:
    // thousands of 8KB chunks/sec pegged the UI thread. Order preserved.
    const outputBatcher = createOutputBatcher((bytes) => {
      if (!aliveRef.current) return;
      snoopLiveCwd(bytes);
      if (resizeDebug) {
        const text = new TextDecoder().decode(bytes).replace(/\x1b/g, "\\e");
        console.log(
          `[gm-resize pane=${paneId}] post-resize output ${bytes.length}B: ${JSON.stringify(text.slice(0, 300))} | ${bufferState(term)}`,
        );
      }
      try {
        writeKeepPlace(term, bytes);
      } catch (e) {
        console.error(`[gm-term] output write failed pane=${paneId} sid=${sessionRef.current}:`, e);
      }
    });
    outputBatcherRef.current = outputBatcher;
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
        useStore.getState().markPaneDirty(paneId);
        void pasteImageBlob(imageFile);
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
          pasteClipboard();
          return false;
        }
      }
      // Shift+Insert emits a native `paste` event (xterm emits no key for it);
      // the capture listener above eats that event, so send it ourselves.
      if (e.type === "keydown" && e.key === "Insert" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        chordPasteAt.current = Date.now();
        pasteClipboard();
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
          sendRaw("\x17");
          return false;
        }
      }
      return true;
    });
    // Registered before the spawn/attach round-trips below: xterm fires into
    // nothing until a listener exists, so the first keystrokes were dropped.
    term.onData((data) => {
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
      let freshSessionId: number | null = null;
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
            freshSessionId = sessionId;
            if (!alive) {
              invoke("pty_kill", { id: sessionId });
              return;
            }
            sessionRef.current = sessionId;
            await attach(term, sessionId);
          } catch (e) {
            if (freshSessionId != null) invoke("pty_kill", { id: freshSessionId });
            term.writeln(`\x1b[31mfailed to spawn shell: ${e}\x1b[0m`);
            return;
          }
        }
      } else {
        try {
          sessionId = await spawnFresh(term, fit);
          freshSessionId = sessionId;
          if (!alive) {
            invoke("pty_kill", { id: sessionId });
            return;
          }
          sessionRef.current = sessionId;
          await attach(term, sessionId);
        } catch (e) {
          if (freshSessionId != null) invoke("pty_kill", { id: freshSessionId });
          term.writeln(`\x1b[31mfailed to spawn shell: ${e}\x1b[0m`);
          return;
        }
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
      // Never flush into a disposed terminal.
      outputBatcherRef.current?.cancel();
      outputBatcherRef.current = null;
      if (resizeTimerRef.current != null) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      unregisterLiveTerm(paneId);
      ro.disconnect();
      hostRef.current?.removeEventListener("paste", killNativePaste, true);
      const sid = sessionRef.current;
      if (sid != null) invoke("pty_detach", { id: sid }).catch(() => {});
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
    if (!initCmdEffectReadyRef.current) {
      initCmdEffectReadyRef.current = true;
      return;
    }
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
      className="relative flex h-full w-full flex-col"
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
        else pasteClipboard();
      }}
      onDragEnter={handleDragEnter}
      onDragOver={acceptDrag}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Permanent header: pane identity on the left, pane actions on the
          right. No hover, no drag, nothing floating over the program's
          output. */}
      <div className="gm-rule flex h-7 shrink-0 items-center gap-2 bg-surface-panel px-2">
        {agent && badge ? (
          <>
            {/* Identity: who runs here, and what they are working on. The cwd
                moves to the tooltip once a session name exists, because the
                name is what you actually want to read at a glance. */}
            <span
              className="flex shrink-0 items-center gap-1.5 rounded-[4px] px-1 py-px text-meta font-semibold"
              style={{ background: `${badge.tint}1f`, color: badge.tint }}
              title={`${agent} — ${liveCwd ?? cwd}`}
            >
              <span
                className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] text-label font-bold"
                style={{ background: badge.tint, color: "var(--gm-canvas)" }}
                aria-hidden
              >
                {badge.initial}
              </span>
              {agent}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-meta text-ink-300"
              title={
                session
                  ? `${session}\n\n${liveCwd ?? cwd}${
                      sessionKind
                        ? `\n${PROVENANCE[sessionKind]}${sessionFrom ? `\n${sessionFrom}` : ""}`
                        : ""
                    }`
                  : liveCwd ?? cwd
              }
            >
              {session || shortPath(liveCwd ?? cwd, false)}
            </span>
          </>
        ) : (
          <span
            className="mono min-w-0 flex-1 truncate text-meta text-ink-500"
            title={liveCwd ?? cwd}
          >
            {shortPath(liveCwd ?? cwd, false)}
          </span>
        )}
        <div className="gm-pane-tools" role="toolbar" aria-label="Pane controls">
          {!webgl && (
            <span
              title="Software rendering fallback (WebGL unavailable)"
              className="rounded border border-[color:var(--gm-hairline)] px-1 text-label text-ink-500"
            >
              sw
            </span>
          )}
          <button
            title="Split right (Ctrl+Shift+→)"
            aria-label="Split pane right"
            onClick={() => splitPane(paneId, "h")}
          >
            <Columns2 size={13} strokeWidth={2} />
          </button>
          <button
            title="Split down (Ctrl+Shift+↓)"
            aria-label="Split pane down"
            onClick={() => splitPane(paneId, "v")}
          >
            <Rows2 size={13} strokeWidth={2} />
          </button>
          {paneCount > 1 && (
            <button
              title={maximized ? "Restore panes (Ctrl+Shift+M)" : "Maximize pane (Ctrl+Shift+M)"}
              aria-label={maximized ? "Restore panes" : "Maximize pane"}
              aria-pressed={maximized}
              onClick={() => toggleMaximizePane(paneId)}
            >
              {maximized ? <Minimize2 size={13} strokeWidth={2} /> : <Maximize2 size={13} strokeWidth={2} />}
            </button>
          )}
          <button
            title="Close pane (Ctrl+Shift+W)"
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
            className="gm-menu px-3 py-1.5 text-body text-ink-200"
            role="status"
          >
            {pasteHint}
          </div>
        </div>
      )}
      {exited && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center pb-3">
          <div
            className="gm-menu flex items-center gap-2 px-3 py-1.5 text-body"
          >
            <span className="text-ink-400">Shell exited</span>
            <button className="gm-btn px-2.5 py-1 text-strong" onClick={restart}>
              Restart
            </button>
            <button
              className="gm-btn-ghost px-2 py-1 text-body"
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
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}
