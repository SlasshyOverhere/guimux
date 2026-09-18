import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { paneEmptiness } from "./terminal/paneEmpty";
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
  dirty?: boolean; // first user keystroke or agent assignment; clean = fresh shell, safe to reuse
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

// Agent fan-out never goes more than 2 across: TUIs wrap at ~80 cols and
// truncate below ~50, so width is sacred and height is spent instead.
// 4 tiles = 2x2, 6 tiles = 3 rows of 2. Rows share height equally via the
// k/(k+1) ratio as each new row appends below.
function tileAgents(panes: Pane[]): PaneNode {
  if (panes.length <= 2) return tileGrid(panes);
  const rows: PaneNode[] = [];
  for (let i = 0; i < panes.length; i += 2) {
    const pair = panes.slice(i, i + 2);
    rows.push(
      pair.length === 1
        ? pair[0]
        : { kind: "split", id: nextId(), direction: "h", ratio: 0.5, first: pair[0], second: pair[1] },
    );
  }
  let node = rows[0];
  for (let i = 1; i < rows.length; i++) {
    node = { kind: "split", id: nextId(), direction: "v", ratio: i / (i + 1), first: node, second: rows[i] };
  }
  return node;
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
  worktrees: Worktree[]; // active project's list; the mirror below keeps every visited project
  worktreesByProject: Record<string, Worktree[]>;
  activeWorktreeId: string | null;
  worktreeLoading: boolean;

  // layout
  layout: PaneNode | null; // per active worktree; simplified: one layout, reset on switch
  layouts: Record<string, PaneNode>; // worktreeId -> layout
  activePaneId: string | null;
  maximizedPaneId: string | null; // fullscreened pane; siblings stay mounted but hidden

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
  hydrate: (projects: Project[], activeProjectId: string | null, seed?: { worktrees: Worktree[]; activeWorktreeId: string | null; worktreesByProject?: Record<string, Worktree[]> }) => void;
  addProject: (p: Project) => void;
  updateProject: (id: string, patch: Partial<Project>) => void;
  removeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  setRepoRoot: (root: string) => void;
  setWorktrees: (wts: Worktree[]) => void;
  setProjectWorktrees: (projectId: string, wts: Worktree[]) => void;
  setActiveWorktree: (id: string) => void;
  // Jump to any project's worktree in one step (sidebar lists every project).
  openProjectWorktree: (projectId: string, worktreeId: string) => void;
  setLayout: (worktreeId: string, node: PaneNode) => void;
  setSplitRatio: (worktreeId: string, splitId: string, ratio: number) => void;
  splitPane: (paneId: string, direction: "h" | "v") => void;
  closePane: (paneId: string) => void;
  toggleMaximizePane: (paneId: string) => void;
  launchAgents: (items: { command: string; count: number }[]) => void;
  dropWorktreeLayout: (id: string) => number[];
  setActivePane: (paneId: string) => void;
  setPtyId: (paneId: string, ptyId: number) => void;
  setPaneCwd: (paneId: string, cwd: string | null) => void;
  markPaneDirty: (paneId: string) => void;
  markPaneClean: (paneId: string) => void;
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
  worktreesByProject: {},
  activeWorktreeId: null,
  worktreeLoading: false,

  layout: null,
  layouts: {},
  activePaneId: null,
  maximizedPaneId: null,


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
  // Seed = last-known worktrees from disk: painted instantly so a shell
  // mounts before git finishes. The loader revalidates in background.
  // ponytail: seed matches by path prefix only; a stale seed (deleted
  // worktree) mounts then the loader corrects it. Persist ids per project
  // when seeds go wrong across multi-root setups.
  hydrate: (projects, activeProjectId, seed) => {
    const ids = new Set(projects.map((p) => p.id));
    const active = activeProjectId && ids.has(activeProjectId) ? activeProjectId : (projects[0]?.id ?? null);
    const proj = projects.find((p) => p.id === active) ?? null;
    const rootOf = (p: Project | null) =>
      p ? (p.isGit ? (p.gitRoot ?? p.path) : p.path) : null;
    const seedWts = seed?.worktrees.filter((w) => {
      // Seed must belong to the active project or the shell spawns elsewhere.
      const root = rootOf(proj);
      return !!root && (w.path === root || w.path.startsWith(root));
    }) ?? [];
    const seedActive = seed?.activeWorktreeId && seedWts.some((w) => w.id === seed.activeWorktreeId)
      ? seed.activeWorktreeId
      : (seedWts.find((w) => w.is_main) ?? seedWts[0])?.id ?? null;
    const seedLayout = seedActive ? { kind: "pane", id: nextId(), ptyId: null } as PaneNode : null;
    // Per-project seeds so the sidebar lists every project at boot, not just
    // the active one. Each list is filtered to its own project root.
    const seedCache: Record<string, Worktree[]> = {};
    if (seed?.worktreesByProject) {
      for (const p of projects) {
        const list = seed.worktreesByProject[p.id];
        if (!list) continue;
        const root = rootOf(p);
        const kept = list.filter((w) => !!root && (w.path === root || w.path.startsWith(root)));
        if (kept.length > 0) seedCache[p.id] = kept.slice(0, 50);
      }
    }
    if (active && seedWts.length > 0) seedCache[active] = seedWts;
    set((s) => ({
      projects,
      activeProjectId: active,
      hydrated: true,
      projectsEpoch: s.projectsEpoch + 1,
      repoRoot: proj ? (proj.isGit ? (proj.gitRoot ?? proj.path) : proj.path) : null,
      worktrees: seedWts,
      worktreesByProject: seedCache,
      activeWorktreeId: seedActive,
      layout: seedLayout,
      layouts: seedActive && seedLayout ? { ...s.layouts, [seedActive]: seedLayout } : s.layouts,
      activePaneId: seedLayout && seedLayout.kind === "pane" ? seedLayout.id : null,
      maximizedPaneId: null,
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
      const removingActive = s.activeProjectId === id;
      const nextActive = removingActive ? (projects[0]?.id ?? null) : s.activeProjectId;
      // Drop the removed project's cached list + layouts, killing its shells.
      const dead = new Set(
        (removingActive ? s.worktrees : (s.worktreesByProject[id] ?? [])).map((w) => w.id),
      );
      for (const [lid, node] of Object.entries(s.layouts)) {
        if (!dead.has(lid)) continue;
        for (const p of collectPaneObjs(node)) {
          if (p.ptyId != null) invoke("pty_kill", { id: p.ptyId }).catch(() => {});
        }
      }
      const layouts = Object.fromEntries(Object.entries(s.layouts).filter(([lid]) => !dead.has(lid)));
      const worktreesByProject = { ...s.worktreesByProject };
      delete worktreesByProject[id];
      if (!removingActive) return { projects, layouts, worktreesByProject };
      // Warm-start the next project from cache so removal never strands the
      // shell on "Starting terminal…"; the loader revalidates after.
      const cached = (nextActive ? worktreesByProject[nextActive] : null) ?? [];
      const nextProj = projects.find((p) => p.id === nextActive) ?? null;
      const layout = (cached.length > 0
        ? layouts[cached.find((w) => w.is_main)?.id ?? cached[0].id]
        : null) ?? { kind: "pane", id: nextId(), ptyId: null };
      const activeWorktreeId = cached.length > 0
        ? (cached.find((w) => w.is_main)?.id ?? cached[0].id)
        : null;
      return {
        projects,
        activeProjectId: nextActive,
        repoRoot: nextProj ? (nextProj.isGit ? (nextProj.gitRoot ?? nextProj.path) : nextProj.path) : null,
        worktrees: cached,
        worktreesByProject,
        activeWorktreeId,
        layout: cached.length > 0 ? layout : null,
        layouts: activeWorktreeId ? { ...layouts, [activeWorktreeId]: layout } : layouts,
        activePaneId: layout.kind === "pane" ? layout.id : collectPanes(layout)[0] ?? null,
        maximizedPaneId: null,
      };
    }),
  setActiveProject: (id) => {
    const s = get();
    const proj = s.projects.find((x) => x.id === id);
    if (!proj || id === s.activeProjectId) return;
    // Project switches keep every PTY alive: stash the outgoing tree AND
    // list in the per-project caches so switching back restores both.
    // Unmounted panes stay in the layouts cache, so TerminalPane's
    // switch-safe cleanup never reaps them while another project is on
    // screen.
    const kept =
      s.activeWorktreeId && s.layout ? { ...s.layouts, [s.activeWorktreeId]: s.layout } : s.layouts;
    const cache = s.activeProjectId
      ? { ...s.worktreesByProject, [s.activeProjectId]: s.worktrees }
      : s.worktreesByProject;
    const cached = cache[id] ?? [];
    // Warm-start from cache: instant list while git revalidates, and the
    // active worktree restores without falling back to main.
    const root = proj.isGit ? (proj.gitRoot ?? proj.path) : proj.path;
    const layout = (cached.length > 0 ? kept[cached.find((w) => w.is_main)?.id ?? cached[0].id] : null)
      ?? { kind: "pane", id: nextId(), ptyId: null };
    const activeWorktreeId = cached.length > 0
      ? (cached.find((w) => w.is_main)?.id ?? cached[0].id)
      : null;
    set({
      activeProjectId: id,
      repoRoot: root,
      worktrees: cached,
      worktreesByProject: cache,
      activeWorktreeId,
      layout: cached.length > 0 ? layout : null,
      layouts: activeWorktreeId ? { ...kept, [activeWorktreeId]: layout } : kept,
      activePaneId: layout.kind === "pane" ? layout.id : collectPanes(layout)[0] ?? null,
      maximizedPaneId: null,
        });
  },
  // Background lists for projects not on screen: cached only, never touch
  // the live list or prune anything (the list belongs to another project).
  setProjectWorktrees: (projectId, wts) =>
    set((s) => ({ worktreesByProject: { ...s.worktreesByProject, [projectId]: wts } })),
  setWorktrees: (wts) =>
    set((s) => {
      // Re-list dropped worktrees (deleted externally, pruned): with
      // switch-safe cleanup their cached shells would leak, so reap them.
      // Active project's previous list is the only prune reference: other
      // projects' cached trees share this map and must survive while hidden.
      const live = new Set(wts.map((w) => w.id));
      const old = new Set(s.worktrees.map((w) => w.id));
      for (const [id, node] of Object.entries(s.layouts)) {
        if (old.has(id) && !live.has(id) && id !== s.activeWorktreeId) {
          for (const p of collectPaneObjs(node)) {
            if (p.ptyId != null) invoke("pty_kill", { id: p.ptyId }).catch(() => {});
          }
        }
      }
      const layouts = Object.fromEntries(
        Object.entries(s.layouts).filter(([id]) => !old.has(id) || live.has(id) || id === s.activeWorktreeId),
      );
      return {
        worktrees: wts,
        worktreesByProject: s.activeProjectId
          ? { ...s.worktreesByProject, [s.activeProjectId]: wts }
          : s.worktreesByProject,
        layouts,
      };
    }),
  setActiveWorktree: (id) => {
    const { layouts, layout: cur, activeWorktreeId } = get();
    // Preserve the outgoing tree: `layouts` only refreshes on layout
    // edits, so without this a switch drops the whole agent grid.
    const kept =
      activeWorktreeId && cur ? { ...layouts, [activeWorktreeId]: cur } : layouts;
    const layout = kept[id] ?? { kind: "pane", id: nextId(), ptyId: null };
    set({
      activeWorktreeId: id,
      layout,
      layouts: kept,
      activePaneId: collectPanes(layout)[0] ?? null,
      maximizedPaneId: null,
    });
  },
  openProjectWorktree: (projectId, worktreeId) => {
    const s = get();
    if (projectId !== s.activeProjectId) {
      get().setActiveProject(projectId);
      // setActiveProject warm-started the cache but picked main: override to
      // the exact row clicked; the layout cache already holds its panes.
      const cur = get();
      const cached = cur.activeProjectId ? cur.worktreesByProject[cur.activeProjectId] ?? [] : [];
      if (!cached.some((w) => w.id === worktreeId)) return;
    }
    get().setActiveWorktree(worktreeId);
  },
  // Removing a worktree orphans its shells: switch-safe unmount cleanup
  // no longer reaps them, so the caller kills the returned pty ids.
  dropWorktreeLayout: (id) => {
    const { layouts, layout: cur, activeWorktreeId } = get();
    const node = layouts[id] ?? (activeWorktreeId === id ? cur : null);
    const ptyIds = node ? collectPaneObjs(node).map((p) => p.ptyId).filter((p): p is number => p != null) : [];
    const next = { ...layouts };
    delete next[id];
    if (activeWorktreeId === id) {
      set({ layouts: next, layout: null, activePaneId: null, maximizedPaneId: null });
    } else {
      set({ layouts: next });
    }
    return ptyIds;
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
        maximizedPaneId: null,
      });
    }
  },
  closePane: (paneId) => {
    const { layout, activeWorktreeId, layouts, maximizedPaneId } = get();
    if (!layout || !activeWorktreeId) return;
    // Never leave a null layout: closing the last pane opens a fresh shell.
    // Null bricks the worktree on "Starting terminal…" with no way back.
    const next = removePane(layout, paneId) ?? { kind: "pane", id: nextId(), ptyId: null };
    set({
      layout: next,
      layouts: { ...layouts, [activeWorktreeId]: next },
      activePaneId: collectPanes(next)[0],
      maximizedPaneId: maximizedPaneId === paneId ? null : maximizedPaneId,
    });
  },
  toggleMaximizePane: (paneId) =>
    set((s) =>
      s.maximizedPaneId === paneId
        ? { maximizedPaneId: null }
        : { maximizedPaneId: paneId, activePaneId: paneId },
    ),
  // Fan-out APPENDS to the existing layout: wipe-and-retile orphaned the
  // current session (the old PTY kept running with no pane attached).
  // Total tiles capped at 12: past that every pane drops below usable TUI
  // width. The append direction alternates with the current root so repeated
  // launches halve height and width in turn instead of squeezing width to a
  // sliver every time (TUIs tolerate short height, not narrow width).
  launchAgents: (items) => {
    const { activeWorktreeId, layouts, layout } = get();
    if (!activeWorktreeId) return;
    const cur = layouts[activeWorktreeId] ?? layout;
    const existing = cur ? collectPaneObjs(cur) : [];
    const room = Math.max(0, 12 - existing.length);
    if (room <= 0) return;
    const cmds: string[] = [];
    for (const item of items) {
      const cmd = item.command.trim();
      if (!cmd) continue;
      const n = Math.min(6, Math.max(1, Math.floor(item.count) || 1));
      for (let i = 0; i < n; i++) cmds.push(cmd);
    }
    if (cmds.length === 0) return;
    // Empty panes (prompt line only, e.g. fresh `PS D:\x>`) are reused in
    // place, so a launch into an empty terminal never splits. Anything else
    // (typed input, command output, a running agent) forces a split. The
    // buffer scan is the authority: keystroke tracking alone misses shells
    // that are dirty from a previous launch or a remount. Live check first:
    // unmounted panes (switching worktrees) have no buffer yet, so they fall
    // back to the dirty flag instead of scanning a stale/empty registry.
    const reusable = existing.filter((p) => {
      if (p.initCmd || p.dirty) return false;
      const e = paneEmptiness(p.id);
      return e.live ? e.empty : true;
    });
    const reuseCount = Math.min(reusable.length, cmds.length);
    const reuseIds = new Set(reusable.slice(0, reuseCount).map((p) => p.id));
    let cmdIdx = 0;
    const assign = (node: PaneNode): PaneNode => {
      if (node.kind === "pane") {
        return reuseIds.has(node.id) ? { ...node, initCmd: cmds[cmdIdx++], dirty: true } : node;
      }
      return { ...node, first: assign(node.first), second: assign(node.second) };
    };
    const patched = cur ? assign(cur) : null;
    const freshCmds = cmds.slice(reuseCount, reuseCount + room);
    if (freshCmds.length === 0) {
      // Everything fit into clean panes: no split at all.
      if (!patched) return;
      set({
        layout: patched,
        layouts: { ...layouts, [activeWorktreeId]: patched },
        activePaneId: reusable[0].id,
        maximizedPaneId: null,
      });
      return;
    }
    const panes: Pane[] = freshCmds.map((cmd) => ({ kind: "pane", id: nextId(), ptyId: null, initCmd: cmd, dirty: true }));
    const fresh = tileAgents(panes);
    if (!patched) {
      set({
        layout: fresh,
        layouts: { ...layouts, [activeWorktreeId]: fresh },
        activePaneId: panes[0].id,
        maximizedPaneId: null,
      });
      return;
    }
    const live = collectPaneObjs(patched);
    const node: PaneNode = {
      kind: "split",
      id: nextId(),
      direction: patched.kind === "split" && patched.direction === "h" ? "v" : "h",
      ratio: Math.max(0.2, Math.min(0.8, live.length / (live.length + panes.length))),
      first: tileGrid(live),
      second: fresh,
    };
    set({
      layout: node,
      layouts: { ...layouts, [activeWorktreeId]: node },
      activePaneId: reuseCount > 0 ? reusable[0].id : panes[0].id,
      maximizedPaneId: null,
        });
  },
  markPaneDirty: (paneId) => {
    // Fires on every keystroke: skip the tree rebuild when already dirty so
    // typing never re-renders the layout.
    const cur = get().layout;
    if (!cur || collectPaneObjs(cur).some((p) => p.id === paneId && p.dirty)) return;
    set((s) => {
      if (!s.layout) return {};
      const patch = (node: PaneNode): PaneNode => {
        if (node.kind === "pane") {
          return node.id === paneId ? { ...node, dirty: true } : node;
        }
        return { ...node, first: patch(node.first), second: patch(node.second) };
      };
      const layout = patch(s.layout);
      return {
        layout,
        layouts: { ...s.layouts, [s.activeWorktreeId!]: layout },
      };
    });
  },
  markPaneClean: (paneId) =>
    set((s) => {
      if (!s.layout) return {};
      const patch = (node: PaneNode): PaneNode => {
        if (node.kind === "pane") {
          // Fresh shell after restart: reusable. Keeps a queued initCmd so a
          // held agent launch still fires instead of being dropped.
          return node.id === paneId ? { ...node, dirty: false } : node;
        }
        return { ...node, first: patch(node.first), second: patch(node.second) };
      };
      const layout = patch(s.layout);
      return {
        layout,
        layouts: { ...s.layouts, [s.activeWorktreeId!]: layout },
      };
    }),
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
