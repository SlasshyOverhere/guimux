import { LazyStore } from "@tauri-apps/plugin-store";
import { DEFAULT_SETTINGS, type Project, type Settings } from "./types";

export interface PersistedState {
  projects: Project[];
  activeProjectId: string | null;
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
    agents,
  };
}

function readLocal(): PersistedState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!Array.isArray(parsed.projects)) return null;
    return { projects: parsed.projects, activeProjectId: parsed.activeProjectId ?? null, settings: cleanSettings(parsed.settings) };
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

function sanitize(s: PersistedState | null | undefined): PersistedState | null {
  if (!s || !Array.isArray(s.projects)) return null;
  const projects = s.projects.filter(
    (p) => p && typeof p.id === "string" && typeof p.path === "string" && typeof p.name === "string",
  );
  const ids = new Set(projects.map((p) => p.id));
  const activeProjectId =
    s.activeProjectId && ids.has(s.activeProjectId) ? s.activeProjectId : (projects[0]?.id ?? null);
  return { projects, activeProjectId, settings: cleanSettings(s.settings) };
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
