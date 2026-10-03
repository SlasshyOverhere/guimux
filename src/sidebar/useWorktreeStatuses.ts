import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createSingleFlight } from "../singleFlight";
import { useStore } from "../store";
import type { FileStatus } from "../types";

// One pass at a time. A pass costs ~300ms per worktree, which outruns the 8s
// tick on a repo with enough of them, so overlapping passes would double the
// git spawns and re-renders.
const pass = createSingleFlight();

const same = (a: FileStatus[] | undefined, b: FileStatus[] | undefined) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (f, i) =>
      f.path === b[i].path &&
      f.index_status === b[i].index_status &&
      f.workdir_status === b[i].workdir_status,
  );
};

/**
 * Polls porcelain status for the active repo's worktrees into the store.
 * Called once from App: the sidebar rows and the worktree tab strip both read
 * it, and a second poll would double every git spawn.
 */
export function useWorktreeStatuses(repoRoot: string | null, isGit: boolean) {
  useEffect(() => {
    if (!repoRoot || !isGit) {
      useStore.getState().setStatuses({}, false);
      return;
    }
    let cancelled = false;
    useStore.getState().setStatuses({}, false);

    const run = async () => {
      // Read the list at pass time, so a create or remove between ticks is
      // picked up without re-arming the interval and without a stale closure.
      const st = useStore.getState();
      const active = st.activeWorktreeId;
      const rows = st.worktrees.filter((wt) => !wt.id.startsWith("plain:"));
      const ordered = [
        ...rows.filter((w) => w.id === active),
        ...rows.filter((w) => w.id !== active),
      ];
      const next: Record<string, FileStatus[]> = {};
      for (const [i, wt] of ordered.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;
        try {
          next[wt.id] = await invoke<FileStatus[]>("git_status", { path: wt.path });
        } catch {
          // Unreadable (dir gone, repo locked), so leave it out. An empty list
          // here would read as "clean".
          continue;
        }
        if (cancelled) return;
        if (useStore.getState().repoRoot !== repoRoot) return;
        // Publish each row as it lands so badges appear early, but skip the
        // write when nothing changed so a steady poll costs no renders.
        const snap = { ...next };
        const cur = useStore.getState().statuses;
        if (Object.keys(snap).some((k) => !same(cur[k], snap[k]))) {
          useStore.getState().setStatuses(snap, true);
        }
      }
      // No worktrees to read: the repo is clean, so stop saying "checking".
      if (!cancelled && ordered.length === 0) useStore.getState().setStatuses({}, true);
    };

    // First pass deferred 3s: startup belongs to the shells; badges catch up.
    const first = setTimeout(() => void pass.run(run), 3000);
    const tick = setInterval(() => {
      if (!document.hidden) void pass.run(run);
    }, 8000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(tick);
    };
  }, [repoRoot, isGit]);
}