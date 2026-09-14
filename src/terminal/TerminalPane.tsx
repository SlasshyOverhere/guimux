import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Columns2, Rows2, X } from "lucide-react";
import { useStore } from "../store";

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
  } = useStore();

  const markExited = () => {
    exitedRef.current = true;
    setExited(true);
  };

  // Listeners first, THEN pty_attach: the backend buffers everything since
  // spawn and replays it, so the spawn→listen window drops nothing.
  const attach = async (term: Terminal, sid: number) => {
    const disposeOutput = await listen<number[]>(`pty:output-${sid}`, (ev) => {
      try {
        term.write(new Uint8Array(ev.payload));
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
    if (replay.length > 0) term.write(new Uint8Array(replay));
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

  const fontSize = useStore((s) => s.settings.terminalFontSize);
  const scrollback = useStore((s) => s.settings.scrollback);

  // Font zoom: apply cell size, refit the grid, then tell the pty its new
  // dims. Skipping the resize leaves the shell wrapping at the old width.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    const dims = fitRef.current ? fitSane(term, fitRef.current) : saneDims(term);
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
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !document.activeElement?.closest(".xterm")) return;
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
      theme: {
        background: "#0a0a0a",
        foreground: "#fafafa",
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
      if (sessionId != null) {
        // Layout kept an id (remount after split / worktree switch). The PTY
        // may have been killed while unmounted: pty_attach validates, and a
        // rejection means spawn fresh instead of a permanently blank pane.
        try {
          await attach(term, sessionId);
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
      const pending = initCmdRef.current;
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
      const dims = fitSane(term, fit);
      if (!dims) return; // hidden/unmeasured: never send 0-size
      const sid = sessionRef.current;
      if (sid != null) invoke("pty_resize", { id: sid, cols: dims.cols, rows: dims.rows });
    });
    ro.observe(hostRef.current);

    return () => {
      alive = false;
      ro.disconnect();
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
      // Splitting remounts this component while the pane stays in the
      // layout tree. Killing the pty there orphans the live session and
      // the remount reattaches to a dead id, which bricked every split.
      // Only reap when the pane is really gone (close / worktree switch).
      if (!paneAlive(useStore.getState().layout, paneId)) {
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
        fitRef.current && fitSane(term, fitRef.current);
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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const path = e.dataTransfer.getData("application/guimux-file-path");
    const sid = sessionRef.current;
    if (!path || sid == null || exitedRef.current) return;
    // relative-ish: use as-is, quoted
    invoke("pty_write", { id: sid, data: `"${path}" ` });
    termRef.current?.focus();
  };

  return (
    <div
      className="relative h-full w-full bg-ink-950"
      onMouseDown={() => setActivePane(paneId)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div
        className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/pane:opacity-100 focus-within:opacity-100"
      >
        {!webgl && (
          <span
            title="Software rendering fallback (WebGL unavailable)"
            className="rounded-md px-1.5 py-1 text-[10px] text-ink-400"
            style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
          >
            sw
          </span>
        )}
        <button
          title="Split right (Ctrl+D)"
          aria-label="Split pane right"
          className="rounded-md p-1.5 text-ink-300 hover:bg-white/[0.06] hover:text-ink-100"
          style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
          onClick={() => splitPane(paneId, "h")}
        >
          <Columns2 size={12} />
        </button>
        <button
          title="Split down"
          aria-label="Split pane down"
          className="rounded-md p-1.5 text-ink-300 hover:bg-white/[0.06] hover:text-ink-100"
          style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
          onClick={() => splitPane(paneId, "v")}
        >
          <Rows2 size={12} />
        </button>
        <button
          title="Close pane"
          aria-label="Close pane"
          className="rounded-md p-1.5 text-ink-300 hover:text-clay-400"
          style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
          onClick={() => {
            const sid = sessionRef.current;
            if (sid != null) invoke("pty_kill", { id: sid });
            onClose();
          }}
        >
          <X size={12} />
        </button>
      </div>
      {exited && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center pb-3">
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] shadow-pop"
            style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
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
              className="rounded-md px-2 py-1 text-ink-400 hover:bg-white/[0.06] hover:text-ink-200"
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
