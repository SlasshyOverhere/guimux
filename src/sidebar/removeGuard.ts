// Removing a worktree runs `git worktree remove --force` plus `branch -D`, so
// it can discard two different kinds of work. The backend refuses and names
// what would be lost; this turns that refusal into the facts the confirm dialog
// needs. Anything else, such as a locked file, returns null and must be
// reported as an error, never escalated into a destructive retry.
//
// A stale entry (git forgot the path) is NOT a guard refusal: it carries a
// GUIMUX_STALE_* marker with the canonical path and must go through
// parseRemoveStale, never the force-retry below.
//
// Sentinels are matched on the phrase the backend appends to every guard, so a
// reworded list of reasons still escalates correctly.
const SENTINEL = "retry to discard them";

export interface RemoveGuard {
  dirty: boolean;
  /** Commits that only exist on this branch; 0 when git could not tell. */
  unmerged: number;
  base: string | null;
  /** "has uncommitted changes and 3 unmerged commits (main)" */
  summary: string;
}

export function parseRemoveGuard(e: unknown): RemoveGuard | null {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (!msg.includes(SENTINEL)) return null;

  const dirty = msg.includes("uncommitted changes");
  const m = /(\d+) commits? not in (\S+)/.exec(msg);
  const unmerged = m ? Number(m[1]) : 0;
  // `\S+` runs to the next space, so it carries the message's sentence period.
  // A branch name can contain dots, so trim only the punctuation at the end.
  const base = m ? m[2].replace(/[.,;:!?]+$/, "") : null;

  const parts: string[] = [];
  if (dirty) parts.push("uncommitted changes");
  if (unmerged > 0) {
    parts.push(`${unmerged} unmerged commit${unmerged === 1 ? "" : "s"}${base ? ` (${base})` : ""}`);
  }
  return {
    dirty,
    unmerged,
    base,
    summary: parts.length > 0 ? `has ${parts.join(" and ")}` : "has work that would be lost",
  };
}

export interface RemoveStale {
  kind: "inside" | "outside";
  path: string;
  repo: string;
}

export function parseRemoveStale(e: unknown): RemoveStale | null {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const kind = msg.includes("GUIMUX_STALE_INSIDE")
    ? ("inside" as const)
    : msg.includes("GUIMUX_STALE_OUTSIDE")
      ? ("outside" as const)
      : null;
  if (!kind) return null;
  const p = /path=(\S+)/.exec(msg)?.[1] ?? "";
  const r = /repo=(\S+)/.exec(msg)?.[1] ?? "";
  return { kind, path: p, repo: r };
}
