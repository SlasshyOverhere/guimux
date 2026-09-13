import { create } from "zustand";
import type { Project, Worktree } from "./types";
import { DEFAULT_SETTINGS, type Settings } from "./types";

// ---- Pane tree model -------------------------------------------------------
// Binary split tree. Each leaf = one terminal pane.

export interface Pane {
  kind: "pane";
  id: string;
  ptyId: number | null;
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
    const newPane: Pane = { kind: "pane", id: nextId(), ptyId: null };
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

// ---- Broadcast groups: per-worktree set of visible pane ids ----------------

export interface BroadcastState {
  active: boolean;
  targetPaneIds: string[];
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

  // broadcast
  broadcast: BroadcastState;

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
  splitPane: (paneId: string, direction: "h" | "v") => void;
  closePane: (paneId: string) => void;
  launchAgents: (command: string, count: number) => void;
  setActivePane: (paneId: string) => void;
  setPtyId: (paneId: string, ptyId: number) => void;
  clearInitCmd: (paneId: string) => void;
  toggleBroadcast: () => void;
  setAgentOpen: (open: boolean) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setBroadcastTargets: (ids: string[]) => void;
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

  broadcast: { active: false, targetPaneIds: [] },

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
      broadcast: { active: false, targetPaneIds: [] },
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
      broadcast: { active: false, targetPaneIds: [] },
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
      broadcast: { active: false, targetPaneIds: [] },
    });
  },
  setLayout: (worktreeId, node) =>
    set((s) => ({
      layouts: { ...s.layouts, [worktreeId]: node },
      layout: node,
    })),
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
  launchAgents: (command, count) => {
    const { activeWorktreeId, layouts } = get();
    const cmd = command.trim();
    if (!activeWorktreeId || !cmd) return;
    const n = Math.min(6, Math.max(1, Math.floor(count) || 1));
    const panes: Pane[] = Array.from({ length: n }, () => ({
      kind: "pane",
      id: nextId(),
      ptyId: null,
      initCmd: cmd,
    }));
    const node = tileGrid(panes);
    set({
      layout: node,
      layouts: { ...layouts, [activeWorktreeId]: node },
      activePaneId: panes[0].id,
      broadcast: { active: false, targetPaneIds: [] },
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
  toggleBroadcast: () =>
    set((s) => ({ broadcast: { ...s.broadcast, active: !s.broadcast.active } })),
  setBroadcastTargets: (ids) =>
    set((s) => ({ broadcast: { ...s.broadcast, targetPaneIds: ids } })),
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
