// Chrome view state (sidebar/explorer width, pins, collapse, hidden groups).
// Every read and write goes through here: storage throws in private mode and at
// quota, and two of these writes run inside React state updaters, where a throw
// would take down the render. Key names live in PREF so they are greppable.
//
// This is chrome state, not app state: it deliberately stays out of
// persist.ts/store.ts, which carry the project list, layouts, and settings.

export const PREF = {
  sidebarWidth: "guimux-sidebar-w",
  explorerWidth: "guimux-explorer-w",
  expandedProjects: "guimux-sidebar-expanded",
  pinnedWorktrees: "guimux-pinned-worktrees",
  revivedWorktrees: "guimux-revived-worktrees",
  discoveredBaseline: "guimux-discovered-baseline",
} as const;

export function readPref<T>(key: string, fallback: T, check: (v: unknown) => T | null): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (check(JSON.parse(raw) as unknown) ?? fallback);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode: view state is best-effort */
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const numIn =
  (min: number, max: number) =>
  (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** `{ key: true }` maps (pins, revived rows, collapsed projects). */
export const flagMap = (v: unknown): Record<string, true> | null => {
  if (!isRecord(v)) return null;
  const out: Record<string, true> = {};
  for (const [k, set] of Object.entries(v)) if (set === true) out[k] = true;
  return out;
};

/** `{ projectId: string[] }` maps (the hidden-worktree baseline). */
export const stringArrayMap = (v: unknown): Record<string, string[]> | null => {
  if (!isRecord(v)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(v)) {
    if (Array.isArray(list)) out[k] = list.filter((x): x is string => typeof x === "string");
  }
  return out;
};
