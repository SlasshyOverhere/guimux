import { useEffect, useMemo } from "react";
import { allPaneIds, useStore } from "./store";
import { matchCombo } from "./combo";

/** Where a binding may fire. "app" means chrome: never inside a terminal or a
 *  text field, where the same chord belongs to the shell or the input. */
export type Scope = "app" | "terminal";

export type Group = "Worktrees" | "Panes" | "View" | "Files";

export interface Binding {
  id: string;
  /** Human-readable accelerator, e.g. "Ctrl+Shift+D". Shown in the cheat sheet. */
  combo: string;
  label: string;
  group: Group;
  scope: Scope;
  /** Terminal-scoped alternates for chords the shell owns. The primary combo
   *  stays the advertised one; a shell that eats Ctrl+K still gets Ctrl+Shift+K. */
  alt?: { combo: string; scope: Scope }[];
  run: () => void;
}

// Accelerator parsing and matching live in ./combo, which has no imports and
// is unit tested; this file owns what the chords *are*.

/** True when the focused element belongs to a shell rather than to chrome. */
function inTerminal(e: KeyboardEvent): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.(".xterm");
}

function inField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return true;
  // contenteditable hosts the Monaco editor and the commit box's peers.
  return t.isContentEditable;
}
/** Every binding, in the order the cheat sheet groups them. */
export function useBindings(): Binding[] {
  return useMemo(() => {
    const st = () => useStore.getState();
    const zoomBy = (delta: number) =>
      st().setSettings({
        uiZoom: Math.min(2, Math.max(0.5, Math.round((st().settings.uiZoom + delta) * 100) / 100)),
      });
    // Worktrees are addressed by position so the tab strip and the digits
    // always agree, including across a project switch.
    const gotoWorktree = (i: number) => {
      const s = st();
      const rows = s.worktrees.filter((wt) => !wt.id.startsWith("plain:"));
      const wt = (rows.length ? rows : s.worktrees)[i];
      if (wt) s.setActiveWorktree(wt.id);
    };
    const nextPane = (step: number) => {
      const s = st();
      const ids = allPaneIds(s.layout);
      if (ids.length < 2) return;
      const at = ids.indexOf(s.activePaneId ?? ids[0]);
      s.setActivePane(ids[(at + step + ids.length) % ids.length]);
    };
    const split = (direction: "h" | "v") => {
      const s = st();
      if (s.activePaneId) s.splitPane(s.activePaneId, direction);
    };
    const closePane = () => {
      const s = st();
      if (s.activePaneId) s.closePane(s.activePaneId);
    };

    const out: Binding[] = [
      {
        id: "palette",
        combo: "Ctrl+K",
        alt: [{ combo: "Ctrl+Shift+K", scope: "terminal" }],
        label: "Command palette",
        group: "Files",
        scope: "app",
        run: () => st().setPaletteOpen(true),
      },
      {
        id: "settings",
        combo: "Ctrl+,",
        label: "Settings",
        group: "View",
        scope: "app",
        run: () => st().setSettingsOpen(true),
      },
      {
        id: "cheatsheet",
        combo: "Ctrl+Shift+?",
        label: "Keyboard shortcuts",
        group: "View",
        scope: "terminal",
        alt: [{ combo: "Ctrl+Shift+?", scope: "app" }],
        run: () => st().setCheatSheetOpen(!st().cheatSheetOpen),
      },
      {
        id: "agents",
        combo: "Ctrl+Shift+A",
        label: "Launch agents",
        group: "Panes",
        scope: "terminal",
        alt: [{ combo: "Ctrl+Shift+A", scope: "app" }],
        run: () => st().setAgentOpen(true),
      },

      {
        id: "worktree.1",
        combo: "Ctrl+1",
        label: "Go to worktree 1",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(0),
      },
      {
        id: "worktree.2",
        combo: "Ctrl+2",
        label: "Go to worktree 2",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(1),
      },
      {
        id: "worktree.3",
        combo: "Ctrl+3",
        label: "Go to worktree 3",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(2),
      },
      {
        id: "worktree.4",
        combo: "Ctrl+4",
        label: "Go to worktree 4",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(3),
      },
      {
        id: "worktree.5",
        combo: "Ctrl+5",
        label: "Go to worktree 5",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(4),
      },
      {
        id: "worktree.6",
        combo: "Ctrl+6",
        label: "Go to worktree 6",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(5),
      },
      {
        id: "worktree.7",
        combo: "Ctrl+7",
        label: "Go to worktree 7",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(6),
      },
      {
        id: "worktree.8",
        combo: "Ctrl+8",
        label: "Go to worktree 8",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(7),
      },
      {
        id: "worktree.9",
        combo: "Ctrl+9",
        label: "Go to worktree 9",
        group: "Worktrees",
        scope: "app",
        run: () => gotoWorktree(8),
      },
      {
        id: "worktree.next",
        combo: "Ctrl+Alt+ArrowRight",
        label: "Next worktree",
        group: "Worktrees",
        scope: "app",
        run: () => {
          const s = st();
          const rows = s.worktrees;
          if (rows.length < 2) return;
          const at = rows.findIndex((wt) => wt.id === s.activeWorktreeId);
          s.setActiveWorktree(rows[(at + 1 + rows.length) % rows.length].id);
        },
      },
      {
        id: "worktree.prev",
        combo: "Ctrl+Alt+ArrowLeft",
        label: "Previous worktree",
        group: "Worktrees",
        scope: "app",
        run: () => {
          const s = st();
          const rows = s.worktrees;
          if (rows.length < 2) return;
          const at = rows.findIndex((wt) => wt.id === s.activeWorktreeId);
          s.setActiveWorktree(rows[(at - 1 + rows.length) % rows.length].id);
        },
      },
      {
        id: "worktree.new",
        combo: "Ctrl+Shift+N",
        label: "New worktree",
        group: "Worktrees",
        scope: "app",
        run: () => st().requestNewWorktree(),
      },

      {
        id: "pane.splitDown",
        combo: "Ctrl+Shift+ArrowDown",
        label: "Split pane below",
        group: "Panes",
        // Shift keeps it clear of Ctrl+D (EOF) and Ctrl+J (newline).
        scope: "terminal",
        alt: [{ combo: "Ctrl+Shift+ArrowDown", scope: "app" }],
        run: () => split("h"),
      },
      {
        id: "pane.splitRight",
        combo: "Ctrl+Shift+ArrowRight",
        label: "Split pane right",
        group: "Panes",
        scope: "terminal",
        alt: [{ combo: "Ctrl+Shift+ArrowRight", scope: "app" }],
        run: () => split("v"),
      },
      {
        id: "pane.next",
        combo: "Ctrl+Shift+Enter",
        label: "Focus next pane",
        group: "Panes",
        scope: "terminal",
        alt: [{ combo: "Ctrl+Shift+Enter", scope: "app" }],
        run: () => nextPane(1),
      },
      {
        id: "pane.maximize",
        combo: "Ctrl+Shift+M",
        label: "Maximize / restore pane",
        group: "Panes",
        scope: "terminal",
        alt: [{ combo: "Ctrl+Shift+M", scope: "app" }],
        run: () => {
          const s = st();
          if (s.activePaneId) s.toggleMaximizePane(s.activePaneId);
        },
      },
      {
        id: "pane.close",
        combo: "Ctrl+Shift+W",
        label: "Close pane",
        group: "Panes",
        scope: "app",
        run: closePane,
      },

      {
        id: "view.sidebar",
        combo: "Ctrl+B",
        label: "Toggle sidebar",
        group: "View",
        scope: "app",
        run: () => st().toggleLeft(),
      },
      {
        id: "view.dock",
        combo: "Ctrl+J",
        label: "Toggle file dock",
        group: "View",
        scope: "app",
        run: () => st().toggleRight(),
      },
      {
        id: "view.zoomIn",
        combo: "Ctrl+=",
        label: "Zoom in",
        group: "View",
        scope: "app",
        run: () => zoomBy(0.1),
      },
      {
        id: "view.zoomOut",
        combo: "Ctrl+-",
        label: "Zoom out",
        group: "View",
        scope: "app",
        run: () => zoomBy(-0.1),
      },
      {
        id: "view.zoomReset",
        combo: "Ctrl+0",
        label: "Reset zoom",
        group: "View",
        scope: "app",
        run: () => st().setSettings({ uiZoom: 1 }),
      },
    ];
    return out;
  }, []);
}

// Chords that reach a modal must not also fire a chrome shortcut behind it.
const MODAL_IDS = new Set(["cheatsheet", "palette", "settings"]);

function modalOpen(st: ReturnType<typeof useStore.getState>) {
  return st.paletteOpen || st.settingsOpen || st.agentOpen || st.cheatSheetOpen;
}

/**
 * The one global keydown listener. Terminals keep their own chords: a binding
 * scoped to "app" never fires inside .xterm, and a binding scoped to
 * "terminal" only exists because the plain Ctrl+ form belongs to the shell.
 */
export function useKeymap() {
  const bindings = useBindings();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const term = inTerminal(e);
      // A text field or the Monaco editor owns its own chords (Ctrl+K is a
      // prefix there, Ctrl+F finds), so app bindings stand down.
      const field = inField(e);
      for (const b of bindings) {
        const here: Scope = term ? "terminal" : "app";
        if (field && !term) return;
        const altHit = b.alt?.find((a) => a.scope === here);
        const primaryHit = b.scope === here;
        if (!primaryHit && !altHit) continue;
        if (!matchCombo(e, primaryHit ? b.combo : altHit!.combo)) continue;
        // An open modal owns the keyboard: only the chords that toggle it
        // still work, so Ctrl+K closes the palette instead of splitting a pane
        // behind it.
        const st = useStore.getState();
        if (modalOpen(st) && !MODAL_IDS.has(b.id)) return;
        e.preventDefault();
        e.stopPropagation();
        b.run();
        // A toggle's mirror chord is a separate binding; stop so one press
        // cannot both close a modal and run the next match.
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings]);
}
