import type { Terminal } from "@xterm/xterm";

// Live xterm instances by pane id, so the store can judge emptiness from
// the actual buffer instead of keystroke tracking alone.
const liveTerms = new Map<string, Terminal>();

export function registerLiveTerm(paneId: string, term: Terminal) {
  liveTerms.set(paneId, term);
}

export function unregisterLiveTerm(paneId: string) {
  liveTerms.delete(paneId);
}

export interface PaneEmptiness {
  live: boolean;
  empty: boolean;
  nonBlank: number;
  lastLine: string;
}

const PROMPT_TAIL = /[>$#%❯➜]\s*$/;

// Empty = the screen shows nothing but prompt line(s) (e.g. `PS D:\x>`).
// Scans the last viewport-height lines: scrollback above the fold (e.g.
// cleared with `cls`) does not count. Every non-blank line must end in a
// prompt char, so command echoes, typed-but-unentered input, and any output
// all veto. Unmounted panes have no live buffer: live=false, empty=false,
// and the caller falls back to its dirty flag.
export function paneEmptiness(paneId: string): PaneEmptiness {
  const dead = (live: boolean): PaneEmptiness => ({ live, empty: false, nonBlank: 0, lastLine: "" });
  const term = liveTerms.get(paneId);
  if (!term) return dead(false);
  try {
    const buf = term.buffer.active;
    const rows = term.rows ?? 0;
    if (rows < 1) return dead(true);
    // Absolute buffer index of the viewport top (same field fitKeepViewport
    // uses). Falls back to bottom-aligned math so a fresh shell still scans
    // right, and stays correct when scrolled up instead of scanning stale rows.
    const top = buf.viewportY ?? Math.max(0, buf.length - rows);
    let nonBlank = 0;
    let lastLine = "";
    for (let i = top + rows - 1; i >= top; i--) {
      const text = buf.getLine(i)?.translateToString(true) ?? "";
      if (text.trim() === "") continue;
      nonBlank++;
      if (nonBlank === 1) lastLine = text;
      if (nonBlank > 3 || !PROMPT_TAIL.test(text)) {
        return { live: true, empty: false, nonBlank, lastLine };
      }
    }
    // Zero lines = prompt not drawn yet (shell still spawning): still fresh.
    return { live: true, empty: true, nonBlank, lastLine };
  } catch {
    return dead(true);
  }
}

export function isPaneVisuallyEmpty(paneId: string): boolean {
  return paneEmptiness(paneId).empty;
}
