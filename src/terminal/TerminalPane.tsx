import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import { allPaneIds, useStore } from "../store";
import { dragFile, quoteForShell } from "../dragFile";

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
  return dims;
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
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const unlisteners = useRef<UnlistenFn[]>([]);
  const sessionRef = useRef<number | null>(ptyId);
  // Agent fan-out: one-shot command typed into a fresh shell, then cleared.
  const initCmdRef = useRef<string | null>(initCmd ?? null);
  initCmdRef.current = initCmd ?? null;
  const exitedRef = useRef(false);
  const [exited, setExited] = useState(false);
  const [webgl, setWebgl] = useState(true);
  const {
    splitPane,
    setActivePane,
    setPtyId,
    toggleMaximizePane,
  } = useStore();
  const maximized = useStore((s) => s.maximizedPaneId === paneId);
  const paneCount = useStore((s) => allPaneIds(s.layout).length);
  // Live cwd, reported by the shell via OSC 7 / 9;9. Stored on the pane so
  // a split from D:/test/workspace/testing/ opens there, not worktree root.
  const liveCwdRef = useRef<string | null>(null);
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
  const attach = async (term: Terminal, sid: number) => {
    const disposeOutput = await listen<number[]>(`pty:output-${sid}`, (ev) => {
      const bytes = new Uint8Array(ev.payload);
      snoopLiveCwd(bytes);
      try {
        term.write(bytes);
      } catch (e) {
        console.error(`[gm-term] output write failed pane=${paneId} sid=${sid}:`, e);
      }
    });
    const disposeExit = await listen<number>(`pty:exit-${sid}`, () => {
      term.writeln("\r\n\x1b[90m[process exited: hit Restart below to reopen the shell]\x1b[0m");
      markExited();
    });
    unlisteners.current.push(disposeOutput, disposeExit);
    const replay = await invoke<number[]>("pty_attach", { id: sid });
    if (replay.length > 0) {
      const bytes = new Uint8Array(replay);
      snoopLiveCwd(bytes);
      term.write(bytes);
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
    const session: { id: number; cwd: string } = await invoke("pty_spawn", {
      cwd,
      cols: dims.cols,
      rows: dims.rows,
    });
    sessionRef.current = session.id;
    setPtyId(paneId, session.id);
    return session.id;
  };

  const restart = async () => {
    const term = termRef.current;
    if (!term) return;
    const sid = sessionRef.current;
    const dims = saneDims(term) ?? { cols: 80, rows: 24 };
    // Same-id restart keeps the existing listeners alive: the backend
    // respawns the child and the reader thread re-emits on the same
    // `pty:output-{id}` channel, so output flows with no re-subscribe.
    try {
      if (sid != null) {
        await invoke("pty_restart", { id: sid, cols: dims.cols, rows: dims.rows });
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
  const sendRaw = (data: string) => {
    const sid = sessionRef.current;
    if (sid != null && !exitedRef.current) invoke("pty_write", { id: sid, data }).catch(() => {});
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
        .then((text) => {
          if (!text) return;
          // term.paste honors bracketed-paste mode; raw pty_write would not.
          try {
            term?.paste(text);
          } catch {
            sendRaw(text);
          }
        })
        .catch(() => sendRaw("\x16"));
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
    const dims = fitRef.current ? fitKeepViewport(term, fitRef.current) : saneDims(term);
    if (!dims) return; // unmeasured container: never send 0-size
    const sid = sessionRef.current;
    if (sid != null) invoke("pty_resize", { id: sid, cols: dims.cols, rows: dims.rows });
  }, [fontSize]);

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
      // Orca parity: no extra leading. 1.45 double-spaced every TUI row,
      // which is the airy gap in the screenshot. Orca clamps lineHeight to
      // [1,3] and defaults to 1; TUIs assume compact cells.
      lineHeight: 1,
      // Ubuntu Mono forced: self-hosted via fontsource, no OS lookup miss.
      fontFamily: '"Ubuntu Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, Monaco, ui-monospace, SFMono-Regular, "Symbols Nerd Font Mono", monospace',
      cursorBlink: true,
      cursorStyle: "block",
      drawBoldTextInBrightColors: true,
      macOptionClickForcesSelection: true,
      // Transparent: the tile div owns the surface (canvas vs panel) so
      // active/inactive reads without a window-inside-window seam.
      theme: {
        background: "rgba(0,0,0,0)",
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
    });
    const fit = new FitAddon();
    // Orca parity (pane-lifecycle.ts): Unicode 11 width tables BEFORE any
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
    // Single paste path: xterm natively sends `paste` DOM events to the PTY
    // (handlePasteEvent → triggerDataEvent → onData), while our Ctrl+V /
    // right-click path ALSO sends via term.paste() → every paste lands twice.
    // Kill the native event at capture (an ancestor capture listener fires
    // before xterm's own textarea/element listeners, and stopPropagation on
    // the way down never reaches the target) so the manual term.paste() in
    // pasteClipboard() is the only sender. Keydown preventDefault is NOT
    // enough: xterm's keydown path never cancels it on the custom-handler
    // early-return, and the webview fires the paste event anyway.
    // ponytail: one capture listener; drop it if xterm ever gains a "no native paste" option.
    const killNativePaste = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    hostRef.current.addEventListener("paste", killNativePaste, true);
     // Keybinds that must work while a TUI owns the grid: Ctrl+C copy when
    // text is selected (else the SIGINT the TUI may need), Ctrl+V paste.
    // Returning false keeps xterm from also feeding the key to the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.type === "keydown") {
        const termNow = termRef.current;
        if (e.key.toLowerCase() === "c" && termNow?.hasSelection()) {
          copySelection();
          return false;
        }
        if (e.key.toLowerCase() === "v") {
          pasteClipboard();
          return false;
        }
      }
      // Shift+Insert emits a native `paste` event (xterm emits no key for it);
      // the capture listener above eats that event, so send it ourselves.
      if (e.type === "keydown" && e.key === "Insert" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        pasteClipboard();
        return false;
      }
      return true;
    });
    enableWebgl(term);

    // Restore persisted scrollback (best-effort: a corrupt buffer must never
    // break the mount or suppress the live prompt).
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

      term.onData((data) => {
        if (exitedRef.current) return;
        const sid = sessionRef.current;
        if (sid != null) {
          invoke("pty_write", { id: sid, data });
        }
      });
    })();

    const ro = new ResizeObserver(() => {
      if (!visible) return;
      const dims = fitKeepViewport(term, fit);
      if (!dims) return; // hidden/unmeasured: never send 0-size
      const sid = sessionRef.current;
      if (sid != null) invoke("pty_resize", { id: sid, cols: dims.cols, rows: dims.rows });
    });
    ro.observe(hostRef.current);

    return () => {
      alive = false;
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

  // Pause rendering when hidden: dispose webgl, keep PTY alive.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (visible) {
      try {
        fitRef.current && fitKeepViewport(term, fitRef.current);
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

  // Drop acceptance: cancel BOTH dragenter and dragover — dragover alone
  // leaves the 🚫 cursor in this webview. dropHot rings the pane so a
  // missing ring means the drop never reaches us (stale build), not a
  // silent handler failure.
  const dragDepth = useRef(0);
  const [dropHot, setDropHot] = useState(false);
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
    const sid = sessionRef.current;
    if (!path || sid == null) return;
    // term.paste honors bracketed-paste mode; raw pty_write would not.
    try {
      termRef.current?.paste(quoteForShell(path));
    } catch {
      invoke("pty_write", { id: sid, data: quoteForShell(path) });
    }
    termRef.current?.focus();
  };

  return (
    <div
      className="relative h-full w-full"
      data-drop-hot={dropHot}
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
      <div
        className="absolute right-2 top-2 z-10 flex items-center opacity-0 transition-opacity duration-150 group-hover/pane:opacity-100 focus-within:opacity-100"
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
