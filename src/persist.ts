import { LazyStore } from "@tauri-apps/plugin-store";
import { DEFAULT_SETTINGS, type Project, type Settings, type Worktree } from "./types";
import type { PaneNode } from "./store";

export interface PersistedState {
  projects: Project[];
  activeProjectId: string | null;
  // Last-known worktree list + selection: painted instantly on boot so a
  // shell mounts before git finishes. Revalidated in background.
  worktrees?: Worktree[];
  activeWorktreeId?: string | null;
  worktreesByProject?: Record<string, Worktree[]>;
  // Split trees per worktree id. Runtime fields are stripped on save
  // (ptyId -> null, dirty/initCmd dropped); cwd is kept for split inherit.
  layouts?: Record<string, PaneNode>;
  activePaneId?: string | null;
  settings?: Settings;
}

const KEY = "guimux-state-v1";
const LS_KEY = "guimux-state-v1";

let tauriStore: LazyStore | null = null;
try {
  tauriStore = new LazyStore("guimux.json");
} catch {
  tauriStore = null;
}

function cleanSettings(s: unknown): Settings {
  const v = (s ?? {}) as Partial<Settings>;
  const num = (n: unknown, fb: number, lo: number, hi: number) =>
    Number.isFinite(n as number) ? Math.min(hi, Math.max(lo, n as number)) : fb;
  const rawAgents = Array.isArray(v.agents) ? v.agents : DEFAULT_SETTINGS.agents;
  const agents = rawAgents
    .filter((a) => a && typeof a.name === "string" && typeof a.command === "string")
    .map((a, i) => ({
      id: typeof a.id === "string" && a.id ? a.id : `agent-${i}`,
      name: a.name.slice(0, 40),
      command: a.command.slice(0, 200),
      flags: typeof a.flags === "string" ? a.flags.slice(0, 200) : "",
    }))
    .slice(0, 20);
  return {
    terminalFontSize: num(v.terminalFontSize, DEFAULT_SETTINGS.terminalFontSize, 10, 24),
    editorFontSize: num(v.editorFontSize, DEFAULT_SETTINGS.editorFontSize, 10, 24),
    scrollback: num(v.scrollback, DEFAULT_SETTINGS.scrollback, 1000, 50_000),
    uiZoom: num(v.uiZoom, DEFAULT_SETTINGS.uiZoom, 0.5, 2),
    autoCheckForUpdates:
      typeof v.autoCheckForUpdates === "boolean"
        ? v.autoCheckForUpdates
        : DEFAULT_SETTINGS.autoCheckForUpdates,
    agents,
  };
}

function readLocal(): PersistedState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    return sanitize(parsed);
  } catch {
    return null;
  }
}

function writeLocal(s: PersistedState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* quota or private mode */
  }
}

function sanitizeWorktrees(wts: unknown): Worktree[] | undefined {
  if (!Array.isArray(wts)) return undefined;
  const clean = wts
    .filter(
      (w): w is Worktree =>
        !!w && typeof w.id === "string" && typeof w.path === "string" && typeof w.branch === "string",
    )
    // Pre-fix seeds were saved with `\` ids; backend now emits `/` — normalize
    // or the seed filter drops them and boot loses its instant shell.
    .map((w) => ({ ...w, id: w.id.replace(/\\/g, "/"), path: w.path.replace(/\\/g, "/") }));
  return clean.length > 0 ? clean.slice(0, 50) : undefined;
}

// Persisted layouts must be small static trees: strip runtime session state
// so a restart spawns fresh shells instead of attaching to dead pty ids or
// re-firing a queued agent command.
function sanitizeLayoutNode(node: unknown, depth = 0, seen = { n: 0 }): PaneNode | null {
  if (!node || typeof node !== "object" || depth > 10 || seen.n > 24) return null;
  const v = node as Record<string, unknown>;
  if (v.kind === "pane") {
    if (typeof v.id !== "string" || !v.id || v.id.length > 80) return null;
    seen.n += 1;
    const cwd = typeof v.cwd === "string" && v.cwd.length > 0 && v.cwd.length <= 500 ? v.cwd : null;
    return { kind: "pane", id: v.id, ptyId: null, cwd, initCmd: null };
  }
  if (v.kind === "split") {
    if (typeof v.id !== "string" || !v.id || v.id.length > 80) return null;
    const direction = v.direction === "v" ? "v" : "h";
    const ratio =
      typeof v.ratio === "number" && Number.isFinite(v.ratio)
        ? Math.min(0.9, Math.max(0.1, v.ratio))
        : 0.5;
    const first = sanitizeLayoutNode(v.first, depth + 1, seen);
    const second = sanitizeLayoutNode(v.second, depth + 1, seen);
    if (!first || !second) return null;
    return { kind: "split", id: v.id, direction, ratio, first, second };
  }
  return null;
}

function collectLayoutPaneIds(node: PaneNode, out: Set<string>) {
  if (node.kind === "pane") out.add(node.id);
  else {
    collectLayoutPaneIds(node.first, out);
    collectLayoutPaneIds(node.second, out);
  }
}

function sanitizeLayouts(input: unknown): Record<string, PaneNode> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, PaneNode> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= 50) break;
    if (!key || key.length > 500) continue;
    const clean = sanitizeLayoutNode(value);
    if (clean) out[key] = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitize(s: PersistedState | null | undefined): PersistedState | null {
  if (!s || !Array.isArray(s.projects)) return null;
  const projects = s.projects.filter(
    (p) => p && typeof p.id === "string" && typeof p.path === "string" && typeof p.name === "string",
  );
  const ids = new Set(projects.map((p) => p.id));
  const activeProjectId =
    s.activeProjectId && ids.has(s.activeProjectId) ? s.activeProjectId : (projects[0]?.id ?? null);
  const worktrees = sanitizeWorktrees(s.worktrees);
  const wtIds = worktrees ? new Set(worktrees.map((w) => w.id)) : null;
  const activeWorktreeId =
    s.activeWorktreeId && wtIds?.has(s.activeWorktreeId) ? s.activeWorktreeId : undefined;
  let worktreesByProject: Record<string, Worktree[]> | undefined;
  if (s.worktreesByProject && typeof s.worktreesByProject === "object") {
    worktreesByProject = {};
    for (const [pid, list] of Object.entries(s.worktreesByProject)) {
      if (!ids.has(pid)) continue;
      const clean = sanitizeWorktrees(list);
      if (clean) worktreesByProject[pid] = clean;
    }
    if (Object.keys(worktreesByProject).length === 0) worktreesByProject = undefined;
  }
  const layouts = sanitizeLayouts(s.layouts);
  let activePaneId: string | null | undefined;
  if (typeof s.activePaneId === "string" && s.activePaneId && layouts) {
    const live = new Set<string>();
    for (const node of Object.values(layouts)) collectLayoutPaneIds(node, live);
    if (live.has(s.activePaneId)) activePaneId = s.activePaneId;
  }
  return { projects, activeProjectId, worktrees, activeWorktreeId, worktreesByProject, layouts, activePaneId, settings: cleanSettings(s.settings) };
}

export async function loadPersisted(): Promise<PersistedState | null> {
  if (tauriStore) {
    try {
      const v = await tauriStore.get<PersistedState>(KEY);
      const clean = sanitize(v ?? undefined);
      if (clean) {
        // Keep the browser fallback in sync so vite-dev and prod agree.
        writeLocal(clean);
        return clean;
      }
    } catch {
      /* fall through to localStorage */
    }
  }
  return sanitize(readLocal());
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: PersistedState | null = null;

export function savePersisted(s: PersistedState) {
  const clean = sanitize(s);
  if (!clean) return;
  pending = clean;
  // Always keep the localStorage mirror fresh (instant, sync).
  writeLocal(clean);
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    const next = pending;
    pending = null;
    if (!next || !tauriStore) return;
    try {
      await tauriStore.set(KEY, next);
      await tauriStore.save();
    } catch {
      /* Tauri store unavailable (browser dev) — localStorage already written */
    }
  }, 150);
}
