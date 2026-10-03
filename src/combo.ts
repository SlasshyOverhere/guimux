// Accelerator matching, kept free of imports so it can be unit tested.
// A combo is "Ctrl+Shift+D": modifier names in any order, then the key, which
// may be a letter, a digit or a literal such as "," or "?".

export interface ComboSpec {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseCombo(combo: string): ComboSpec {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const has = (mod: string) => parts.slice(0, -1).some((p) => p.toLowerCase() === mod);
  return {
    // "Mod" is the cross-platform spelling: Cmd on macOS, Ctrl elsewhere.
    ctrl: has("ctrl") || has("mod"),
    shift: has("shift"),
    alt: has("alt"),
    key,
  };
}

/**
 * Exact match, modifiers included: Ctrl+B must not fire on Ctrl+Shift+B, or
 * every chord would claim a press that a later binding wanted.
 */
export function matchCombo(e: KeyboardEvent, combo: string): boolean {
  const want = parseCombo(combo);
  const mod = e.ctrlKey || e.metaKey;
  if (want.ctrl ? !mod : mod) return false;
  if (e.altKey !== want.alt) return false;
  if (e.shiftKey !== want.shift) return false;
  // Letters compare case-insensitively because Shift+letter arrives as the
  // uppercase character; punctuation and arrows compare exactly.
  if (want.key.length === 1) return e.key.toLowerCase() === want.key.toLowerCase();
  return e.key === want.key;
}

// Named keys read badly in a menu ("Ctrl+Alt+ArrowRight"). The glyphs are
// what a keycap shows, so that is what the palette, the cheat sheet and the
// welcome hints print. Matching still uses the name.
const GLYPH: Record<string, string> = {
  ArrowRight: "→",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  Escape: "Esc",
  " ": "Space",
};

export function prettyCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) => GLYPH[p] ?? (p.length === 1 ? p : p.replace("Arrow", "")))
    .join("+");
}
