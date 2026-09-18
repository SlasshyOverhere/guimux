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

// Empty = the visible screen shows nothing but one prompt line
// (e.g. `PS D:\x>`). Only the viewport is scanned: scrollback above the
// fold (e.g. cleared with `cls`) does not count. Strict on purpose: any
// command echo or output adds a second non-blank line, and reusing such a
// pane would clobber visible work. Unmounted panes have no live buffer:
// returns false so callers fall back to the dirty flag.
export function isPaneVisuallyEmpty(paneId: string): boolean {
  const term = liveTerms.get(paneId);
  if (!term) return false;
  try {
    const buf = term.buffer.active;
    const rows = term.rows ?? 0;
    if (rows < 1) return false;
    const top = buf.viewportY ?? 0;
    let found = 0;
    let last = "";
    for (let i = top + rows - 1; i >= top; i--) {
      const text = buf.getLine(i)?.translateToString(true) ?? "";
      if (text.trim() === "") continue;
      found++;
      if (found === 1) last = text;
      if (found > 1) return false;
    }
    if (found === 0) return true; // prompt not drawn yet: still fresh
    return /[>$#%❯➜]\s*$/.test(last);
  } catch {
    return false;
  }
}
