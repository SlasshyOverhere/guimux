import { create } from "zustand";
import type { Project, Worktree } from "./types";
import { DEFAULT_SETTINGS, type Settings } from "./types";

// ---- Pane tree model -------------------------------------------------------
// Binary split tree. Each leaf = one terminal pane.

export interface Pane {
  kind: "pane";
  id: string;
  ptyId: number | null;
  cwd?: string | null; // last known shell cwd (OSC 7); splits inherit it
  initCmd?: string | null; // typed once into a freshly spawned shell (agent launch)
}

export interface Split {
  kind: "split";
  id: string;
  direction: "h" | "v"; // h = children side by side
  ratio: number; // 0..1 split position of first child
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = Pane | Split;

let counter = 0;
export const nextId = () => `n${++counter}-${Date.now().toString(36)}`;

function readVis(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

function collectPanes(node: PaneNode, out: string[] = []): string[] {
  if (node.kind === "pane") out.push(node.id);
  else {
    collectPanes(node.first, out);
    collectPanes(node.second, out);
  }
  return out;
}

function findAndSplit(node: PaneNode, paneId: string, direction: "h" | "v"): PaneNode | null {
  if (node.kind === "pane") {
    if (node.id !== paneId) return null;
    // Inherit the source pane's last-known shell cwd (OSC 7) so a split
    // from D:/test/workspace/testing/ opens there, not at the worktree root.
    const newPane: Pane = { kind: "pane", id: nextId(), ptyId: null, cwd: node.cwd ?? null };
    return {
      kind: "split",
      id: nextId(),
      direction,
      ratio: 0.5,
      first: node,
      second: newPane,
    };
  }
  const first = findAndSplit(node.first, paneId, direction);
  if (first) return { ...node, first };
  const second = findAndSplit(node.second, paneId, direction);
  if (second) return { ...node, second };
  return null;
}

function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "pane") {
    return node.id === paneId ? null : node;
  }
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

// Balanced tiling for agent fan-out: split the list in half, alternate h/v
// per depth. 2 = side by side, 3 = one left + two stacked right, 4 = 2x2.
function tileGrid(panes: Pane[], depth = 0): PaneNode {
  if (panes.length === 1) return panes[0];
  const mid = Math.ceil(panes.length / 2);
  return {
    kind: "split",
    id: nextId(),
    direction: depth % 2 === 0 ? "h" : "v",
    ratio: 0.5,
    first: tileGrid(panes.slice(0, mid), depth + 1),
    second: tileGrid(panes.slice(mid), depth + 1),
  };
}

function collectPaneObjs(node: PaneNode, out: Pane[] = []): Pane[] {
  if (node.kind === "pane") out.push(node);
  else {
    collectPaneObjs(node.first, out);
    collectPaneObjs(node.second, out);
  }
  return out;
}

// Ratio update targets ONE nested split by id. Never rebuild the caller's
// subtree into setLayout: that replaced the whole worktree layout with the
// local split and orphaned every other pane (the "terminals overlapping /
// old session gone but still running" bug).
function withSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    first: withSplitRatio(node.first, splitId, ratio),
    second: withSplitRatio(node.second, splitId, ratio),
  };
}

interface AppState {
  // projects (multi-root; each may or may not be git)
  projects: Project[];
  activeProjectId: string | null;
  hydrated: boolean;
  // Bumped by every hydrate so the worktree loader can key on it.
  projectsEpoch: number;

  // worktrees (per git project; empty for plain folders)
  repoRoot: string | null;
  worktrees: Worktree[];
  activeWorktreeId: string | null;
  worktreeLoading: boolean;

  // layout
  layout: PaneNode | null; // per active worktree; simplified: one layout, reset on switch
  layouts: Record<string, PaneNode>; // worktreeId -> layout
  activePaneId: string | null;

  // agent launcher dialog + sidebar visibility
  agentOpen: boolean;
  leftVisible: boolean;
  rightVisible: boolean;

  // editor
  editorOpen: boolean;
  editorPath: string | null;
  diffMode: boolean;

  // palette
  paletteOpen: boolean;

  // settings
  settings: Settings;
  settingsOpen: boolean;

  // actions
  hydrate: (projects: Project[], activeProjectId: string | null) => void;
  addProject: (p: Project) => void;
  updateProject: (id: string, patch: Partial<Project>) => void;
  removeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  setRepoRoot: (root: string) => void;
  setWorktrees: (wts: Worktree[]) => void;
  setActiveWorktree: (id: string) => void;
  setLayout: (worktreeId: string, node: PaneNode) => void;
  setSplitRatio: (worktreeId: string, splitId: string, ratio: number) => void;
  splitPane: (paneId: string, direction: "h" | "v") => void;
  closePane: (paneId: string) => void;
  launchAgents: (items: { command: string; count: number }[]) => void;
  setActivePane: (paneId: string) => void;
  setPtyId: (paneId: string, ptyId: number) => void;
  setPaneCwd: (paneId: string, cwd: string) => void;
  clearInitCmd: (paneId: string) => void;
  setAgentOpen: (open: boolean) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  openEditor: (path: string | null, diff?: boolean) => void;
  closeEditor: () => void;
  setPaletteOpen: (open: boolean) => void;
  setSettings: (patch: Partial<Settings>) => void;
  hydrateSettings: (s: Settings) => void;
  setSettingsOpen: (open: boolean) => void;
}

export const useStore = create<AppState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  hydrated: false,
  projectsEpoch: 0,

  repoRoot: null,
  worktrees: [],
  activeWorktreeId: null,
  worktreeLoading: false,

  layout: null,
  layouts: {},
  activePaneId: null,


  agentOpen: false,
  leftVisible: readVis("guimux-left"),
  rightVisible: readVis("guimux-right"),

  editorOpen: false,
  editorPath: null,
  diffMode: false,

  paletteOpen: false,

  settings: DEFAULT_SETTINGS,
  settingsOpen: false,

  setRepoRoot: (root) => set({ repoRoot: root }),
  hydrate: (projects, activeProjectId) => {
    const ids = new Set(projects.map((p) => p.id));
    const active = activeProjectId && ids.has(activeProjectId) ? activeProjectId : (projects[0]?.id ?? null);
    const proj = projects.find((p) => p.id === active) ?? null;
    set((s) => ({
      projects,
      activeProjectId: active,
      hydrated: true,
      projectsEpoch: s.projectsEpoch + 1,
      repoRoot: proj ? proj.path : null,
      worktrees: [],
      activeWorktreeId: null,
      layout: null,
      activePaneId: null,
    }));
  },
  addProject: (p) =>
    set((s) => ({
      projects: s.projects.some((x) => x.id === p.id) ? s.projects : [...s.projects, p],
      activeProjectId: s.activeProjectId ?? p.id,
    })),
  updateProject: (id, patch) =>
    set((s) => ({
      projects: s.projects.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    })),
  removeProject: (id) =>
    set((s) => {
      const projects = s.projects.filter((x) => x.id !== id);
      const activeProjectId =
        s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId;
      return { projects, activeProjectId };
    }),
  setActiveProject: (id) => {
    const s = get();
    const proj = s.projects.find((x) => x.id === id);
    if (!proj) return;
    // Switching projects resets worktree selection; App effect reloads it.
    set({
      activeProjectId: id,
      repoRoot: proj.path,
      worktrees: [],
      activeWorktreeId: null,
      layout: null,
      activePaneId: null,
        });
  },
  setWorktrees: (wts) => set({ worktrees: wts }),
  setActiveWorktree: (id) => {
    const { layouts } = get();
    const layout = layouts[id] ?? { kind: "pane", id: nextId(), ptyId: null };
    set({
      activeWorktreeId: id,
      layout,
      activePaneId: collectPanes(layout)[0] ?? null,
        });
  },
  setLayout: (worktreeId, node) =>
    set((s) => ({
      layouts: { ...s.layouts, [worktreeId]: node },
      layout: s.activeWorktreeId === worktreeId ? node : s.layout,
    })),
  setSplitRatio: (worktreeId, splitId, ratio) =>
    set((s) => {
      const cur = s.layouts[worktreeId] ?? (s.activeWorktreeId === worktreeId ? s.layout : null);
      if (!cur) return {};
      const clamped = Math.min(0.9, Math.max(0.1, ratio));
      const next = withSplitRatio(cur, splitId, clamped);
      return {
        layouts: { ...s.layouts, [worktreeId]: next },
        layout: s.activeWorktreeId === worktreeId ? next : s.layout,
      };
    }),
  splitPane: (paneId, direction) => {
    const { layout, activeWorktreeId, layouts } = get();
    if (!layout || !activeWorktreeId) return;
    const next = findAndSplit(layout, paneId, direction);
    if (next) {
      set({
        layout: next,
        layouts: { ...layouts, [activeWorktreeId]: next },
      });
    }
  },
  closePane: (paneId) => {
    const { layout, activeWorktreeId, layouts } = get();
    if (!layout || !activeWorktreeId) return;
    // Never leave a null layout: closing the last pane opens a fresh shell.
    // Null bricks the worktree on "Starting terminal…" with no way back.
    const next = removePane(layout, paneId) ?? { kind: "pane", id: nextId(), ptyId: null };
    set({
      layout: next,
      layouts: { ...layouts, [activeWorktreeId]: next },
      activePaneId: collectPanes(next)[0],
    });
  },
  // Fan-out APPENDS to the existing layout: wipe-and-retile orphaned the
  // current session (the old PTY kept running with no pane attached).
  launchAgents: (items) => {
    const { activeWorktreeId, layouts, layout } = get();
    if (!activeWorktreeId) return;
    const panes: Pane[] = [];
    for (const item of items) {
      const cmd = item.command.trim();
      if (!cmd) continue;
      const n = Math.min(6, Math.max(1, Math.floor(item.count) || 1));
      for (let i = 0; i < n; i++) panes.push({ kind: "pane", id: nextId(), ptyId: null, initCmd: cmd });
    }
    if (panes.length === 0) return;
    panes.length = Math.min(panes.length, 12);
    const fresh = tileGrid(panes);
    const cur = layouts[activeWorktreeId] ?? layout;
    const existing = cur ? collectPaneObjs(cur) : [];
    // No live tiles yet: plain retile keeps the old single-pane behaviour.
    if (existing.length <= 1 && existing.every((p) => p.ptyId == null && !p.initCmd)) {
      const node = fresh;
      set({
        layout: node,
        layouts: { ...layouts, [activeWorktreeId]: node },
        activePaneId: panes[0].id,
            });
      return;
    }
    const live: Pane[] = existing.length > 0 ? existing : [{ kind: "pane", id: nextId(), ptyId: null }];
    const node: PaneNode = {
      kind: "split",
      id: nextId(),
      direction: "h",
      ratio: Math.max(0.2, Math.min(0.8, live.length / (live.length + panes.length))),
      first: tileGrid(live),
      second: fresh,
    };
    set({
      layout: node,
      layouts: { ...layouts, [activeWorktreeId]: node },
      activePaneId: panes[0].id,
        });
  },
  clearInitCmd: (paneId) =>
    set((s) => {
      if (!s.layout) return {};
      const patch = (node: PaneNode): PaneNode => {
        if (node.kind === "pane") {
          return node.id === paneId ? { ...node, initCmd: null } : node;
        }
        return { ...node, first: patch(node.first), second: patch(node.second) };
      };
      const layout = patch(s.layout);
      return {
        layout,
        layouts: { ...s.layouts, [s.activeWorktreeId!]: layout },
      };
    }),
  setActivePane: (paneId) => set({ activePaneId: paneId }),
  setPtyId: (paneId, ptyId) =>
    set((s) => {
      if (!s.layout) return {};
      const patch = (node: PaneNode): PaneNode => {
        if (node.kind === "pane") {
          return node.id === paneId ? { ...node, ptyId } : node;
        }
        return { ...node, first: patch(node.first), second: patch(node.second) };
      };
      const layout = patch(s.layout);
      return {
        layout,
        layouts: { ...s.layouts, [s.activeWorktreeId!]: layout },
      };
    }),
  setPaneCwd: (paneId, cwd) =>
    set((s) => {
      if (!s.layout) return {};
      const patch = (node: PaneNode): PaneNode => {
        if (node.kind === "pane") {
          return node.id === paneId ? { ...node, cwd } : node;
        }
        return { ...node, first: patch(node.first), second: patch(node.second) };
      };
      const layout = patch(s.layout);
      return {
        layout,
        layouts: { ...s.layouts, [s.activeWorktreeId!]: layout },
      };
    }),
  openEditor: (path, diff = false) =>
    set({ editorOpen: true, editorPath: path, diffMode: diff }),
  closeEditor: () => set({ editorOpen: false, editorPath: null }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  hydrateSettings: (s) => set({ settings: { ...DEFAULT_SETTINGS, ...s } }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setAgentOpen: (open) => set({ agentOpen: open }),
  toggleLeft: () =>
    set((s) => {
      try {
        localStorage.setItem("guimux-left", s.leftVisible ? "0" : "1");
      } catch {
        /* private mode */
      }
      return { leftVisible: !s.leftVisible };
    }),
  toggleRight: () =>
    set((s) => {
      try {
        localStorage.setItem("guimux-right", s.rightVisible ? "0" : "1");
      } catch {
        /* private mode */
      }
      return { rightVisible: !s.rightVisible };
    }),
}));

export function allPaneIds(node: PaneNode | null): string[] {
  return node ? collectPanes(node) : [];
}
