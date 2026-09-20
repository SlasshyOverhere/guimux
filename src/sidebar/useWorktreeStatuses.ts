import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createSingleFlight } from "../singleFlight";
import { useStore } from "../store";
import type { FileStatus } from "../types";

export interface WorktreeStatuses {
  /** Porcelain entries by worktree path. Empty until the repo has been read. */
  statuses: Record<string, FileStatus[]>;
  /** False until a pass has landed for this repo: empty is not "clean". */
  loaded: boolean;
}

// One pass at a time. A pass costs ~300ms per worktree, which outruns the 8s
// tick on a repo with enough of them — overlapping passes would double every
// git spawn and re-render the panel twice as often.
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

/** Status for the repo's worktrees, refreshed in the background. */
export function useWorktreeStatuses(repoRoot: string | null, isGit: boolean): WorktreeStatuses {
  // Keyed by repo root, not project: the same repo added twice shares one set
  // of numbers, and a project switch can never show the previous repo's count.
  const [state, setState] = useState<{ forRoot: string | null; byWorktree: Record<string, FileStatus[]> }>(
    { forRoot: null, byWorktree: {} },
  );

  useEffect(() => {
    if (!repoRoot || !isGit) {
      setState({ forRoot: null, byWorktree: {} });
      return;
    }
    setState({ forRoot: null, byWorktree: {} });
    let cancelled = false;

    const run = async () => {
      // Read the list at pass time: a create/remove between ticks is picked up
      // without re-arming the interval (and without a stale closure).
      const st = useStore.getState();
      const active = st.activeWorktreeId;
      const ids = st.worktrees.filter((wt) => !wt.id.startsWith("plain:")).map((wt) => wt.id);
      const paths = new Map(st.worktrees.map((wt) => [wt.id, wt.path]));
      const ordered = [...ids.filter((id) => id === active), ...ids.filter((id) => id !== active)];
      const next: Record<string, FileStatus[]> = {};
      let published = false;
      for (const [i, id] of ordered.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;
        try {
          next[id] = await invoke<FileStatus[]>("git_status", { path: paths.get(id)! });
        } catch {
          // Unreadable (dir gone, repo locked): leave it out. An empty list
          // here would read as "clean", which is exactly the wrong claim.
          continue;
        }
        if (cancelled) return;
        // Publish each row as it lands (snappy badges) but skip the update when
        // nothing changed, so a steady-state poll costs no renders at all.
        const snap = { ...next };
        const current = useStore.getState().repoRoot === repoRoot;
        if (!current) return;
        published = true;
        setState((prev) =>
          prev.forRoot === repoRoot && Object.keys(snap).every((k) => same(prev.byWorktree[k], snap[k]))
            ? prev
            : { forRoot: repoRoot, byWorktree: snap },
        );
      }
      // No worktrees to read: the repo is genuinely clean, so stop saying
      // "checking". A pass where every read failed stays unknown on purpose.
      if (!cancelled && !published && ordered.length === 0) {
        setState((prev) => (prev.forRoot === repoRoot ? prev : { forRoot: repoRoot, byWorktree: {} }));
      }
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

  const loaded = state.forRoot === repoRoot && repoRoot !== null;
  return { statuses: loaded ? state.byWorktree : {}, loaded };
}
