import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { loadPersisted, savePersisted } from "./persist";
import { detectToProject } from "./project";
import { normalizePath } from "./path";
import { useWorktreeStatuses } from "./sidebar/useWorktreeStatuses";
import { maybeAutoCheck } from "./updater";
import { useStore } from "./store";
import type { Project, Worktree } from "./types";

// detectToProject normalizes to the git root, so a project's id can shift
// between runs. Reconcile persisted state by path, not by id.
const sameProject = (a: string, b: string) => normalizePath(a) === normalizePath(b);

/** Folder picker -> registered project. Null when the picker is cancelled. */
async function pickProject(): Promise<Project | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    title: "Open folder or git repository",
  });
  if (!picked) return null;
  const raw = Array.isArray(picked) ? picked[0] : (picked as string);
  return detectToProject(raw);
}

/** Pick a folder and make it the active project. False when cancelled.
 *  Shared by the welcome card and the palette's "Open folder" command so the
 *  two never drift; the caller owns the error surface. */
export async function openFolderProject(): Promise<boolean> {
  const p = await pickProject();
  if (!p) return false;
  const st = useStore.getState();
  st.addProject(p);
  st.setActiveProject(p.id);
  return true;
}

/** Restore persisted state once, write it back on every change, apply zoom. */
function usePersistence() {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const worktrees = useStore((s) => s.worktrees);
  const activeWorktreeId = useStore((s) => s.activeWorktreeId);
  const worktreesByProject = useStore((s) => s.worktreesByProject);
  const layouts = useStore((s) => s.layouts);
  const activePaneId = useStore((s) => s.activePaneId);
  const settings = useStore((s) => s.settings);
  const uiZoom = useStore((s) => s.settings.uiZoom);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadPersisted();
      if (cancelled) return;
      const st = useStore.getState();
      if (saved?.settings) st.hydrateSettings(saved.settings);
      // Read the preference after hydration: before this point the check
      // always saw DEFAULT_SETTINGS, so turning the auto-check off never took
      // effect at startup. Fire-and-forget: never blocks boot or terminals.
      void maybeAutoCheck(useStore.getState().settings.autoCheckForUpdates);
      if (!saved || saved.projects.length === 0) {
        st.hydrate([], null);
        return;
      }
      // Paint instantly from disk, revalidate in background. Awaiting N git
      // rev-parses before the first hydrate left boot on "Starting
      // terminal…" for 10-30s on cold Windows spawns; now the seeded shell
      // mounts at once and re-detect plus the loader correct it after.
      st.hydrate(saved.projects, saved.activeProjectId, {
        worktrees: saved.worktrees ?? [],
        activeWorktreeId: saved.activeWorktreeId ?? null,
        worktreesByProject: saved.worktreesByProject,
        layouts: saved.layouts,
        activePaneId: saved.activePaneId,
      });
      const settled = await Promise.all(
        saved.projects.map(async (p) => {
          try {
            return await detectToProject(p.path);
          } catch (e) {
            // Missing folders are stale state; Git/permission failures are
            // transient and must not silently delete a valid project.
            return String(e).includes("PROJECT_PATH_MISSING:") ? null : p;
          }
        }),
      );
      if (cancelled) return;
      const fresh = settled.filter((p): p is Project => p !== null);
      let cur = useStore.getState();
      for (const old of saved.projects) {
        if (!fresh.some((p) => sameProject(p.path, old.path))) cur.removeProject(old.id);
      }
      cur = useStore.getState();
      if (fresh.length === 0) {
        if (cur.projects.length === 0) cur.hydrate([], null);
        return;
      }
      const oldActive = saved.projects.find((p) => p.id === saved.activeProjectId);
      const kept =
        (oldActive ? fresh.find((p) => sameProject(p.path, oldActive.path)) : undefined) ??
        fresh.find((p) => p.id === cur.activeProjectId) ??
        fresh[0];
      // Keep the existing id and its cached layouts when the project survived.
      const oldKept = saved.projects.find((p) => sameProject(p.path, kept.path));
      if (oldKept) {
        cur.updateProject(oldKept.id, { ...kept, id: oldKept.id });
        if (cur.activeProjectId !== oldKept.id) cur.setActiveProject(oldKept.id);
      } else {
        cur.addProject(kept);
        cur.setActiveProject(kept.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!useStore.getState().hydrated) return;
    savePersisted({
      projects,
      activeProjectId,
      worktrees,
      activeWorktreeId,
      worktreesByProject,
      layouts,
      activePaneId,
      settings,
    });
  }, [
    projects,
    activeProjectId,
    worktrees,
    activeWorktreeId,
    worktreesByProject,
    layouts,
    activePaneId,
    settings,
  ]);

  // App-wide zoom: CSS `zoom` on <html> scales all chrome (topbar, sidebar,
  // explorer, dialogs). Terminals refit through their ResizeObserver.
  // ponytail: `zoom` is non-standard but fine in WebView2/Chromium; switch
  // to Webview.setZoom if native per-window zoom is ever needed.
  useEffect(() => {
    document.documentElement.style.zoom = uiZoom === 1 ? "" : String(uiZoom);
  }, [uiZoom]);

  // Density is a data attribute, not a class: styles.css re-declares the five
  // type/space variables for [data-density="compact"] and every utility that
  // reads them (text-body, py-row, h-ctl) retunes at once.
  const density = useStore((s) => s.settings.density);
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);
}

/**
 * Lists the active project's worktrees. Keyed on project identity plus the
 * boot epoch: the epoch pins each run to one boot, because without it the
 * background re-detect patch in usePersistence changes the key mid-load, the
 * effect re-runs, and worktrees get listed twice with the PTY remounted.
 */
function useWorktreeLoader(onError: (message: string | null) => void) {
  const hydrated = useStore((s) => s.hydrated);
  const projectsEpoch = useStore((s) => s.projectsEpoch);
  const activeGitKey = useStore((s) => {
    const p = s.projects.find((x) => x.id === s.activeProjectId) ?? null;
    return p ? `${p.id}::${p.isGit ? (p.gitRoot ?? p.path) : p.path}` : null;
  });

  useEffect(() => {
    if (!hydrated || !activeGitKey) return;
    const p = useStore.getState().projects.find(
      (x) => x.id === activeGitKey.slice(0, activeGitKey.lastIndexOf("::")),
    );
    if (!p) return;
    let cancelled = false;
    const st = useStore.getState();

    // A plain folder always gets one synthetic worktree so a shell mounts.
    const solo: Worktree[] = [
      { id: `plain:${p.id}`, path: p.path, branch: p.name, is_main: true },
    ];
    const showSolo = () => {
      if (cancelled) return;
      st.setRepoRoot(p.path);
      st.setWorktrees(solo);
      if (useStore.getState().activeWorktreeId !== solo[0].id) st.setActiveWorktree(solo[0].id);
    };

    (async () => {
      try {
        if (!p.isGit) {
          showSolo();
          return;
        }
        const root = p.gitRoot ?? p.path;
        st.setRepoRoot(root);
        let wts: Worktree[];
        // No frame defer: the seeded shell already painted; revalidate now.
        try {
          wts = await invoke<Worktree[]>("worktree_list", { repoRoot: root });
        } catch (e) {
          // Keep the seeded list on git failure (offline/locked): falling
          // through replaced it with a plain-folder shell and moved the
          // user. The banner carries the error instead.
          if (useStore.getState().worktrees.length === 0) showSolo();
          if (!cancelled) onError(String(e));
          return;
        }
        if (cancelled) return;
        // An empty list is not a failure: a repo with no worktrees yet still
        // needs a shell, so it gets the plain-folder fallback.
        if (wts.length === 0) {
          showSolo();
          return;
        }
        onError(null);
        st.setWorktrees(wts);
        const cur = useStore.getState();
        if (!wts.find((w) => w.id === cur.activeWorktreeId)) {
          cur.setActiveWorktree((wts.find((w) => w.is_main) ?? wts[0]).id);
        }
      } catch (e) {
        if (!cancelled) onError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, projectsEpoch, activeGitKey]);

  // Dropping a worktree, or closing its last pane, can leave the active one
  // without a layout; a null layout strands the shell on "Starting
  // terminal…" with no way back, so re-enter the worktree to rebuild it.
  // Read fresh from the store, so it only has to fire on a worktree change.
  const activeWorktreeId = useStore((s) => s.activeWorktreeId);
  useEffect(() => {
    const cur = useStore.getState();
    if (!cur.activeWorktreeId || cur.layout) return;
    if (cur.worktrees.some((w) => w.id === cur.activeWorktreeId)) {
      cur.setActiveWorktree(cur.activeWorktreeId);
    }
  }, [activeWorktreeId]);
}

export interface Workspace {
  /** Banner text for a project-level failure, or null when healthy. */
  repoError: string | null;
  openFolder: () => Promise<void>;
  dismissError: () => void;
}

/** Everything the shell needs from boot: state, the folder picker, errors. */
export function useWorkspace(): Workspace {
  const [repoError, setRepoError] = useState<string | null>(null);
  usePersistence();
  useWorktreeLoader(setRepoError);
  // One poller for the whole window: the sidebar rows, the worktree tab strip
  // and the command palette all read the same store slice, and a second poll
  // would double every git spawn.
  const repoRoot = useStore((s) => s.repoRoot);
  const isGit = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.isGit ?? false);
  useWorktreeStatuses(repoRoot, isGit);

  const openFolder = async () => {
    try {
      setRepoError(null);
      await openFolderProject();
    } catch (e) {
      setRepoError(String(e));
    }
  };

  return { repoError, openFolder, dismissError: () => setRepoError(null) };
}
