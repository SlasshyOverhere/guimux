// Removing a worktree runs `git worktree remove --force` plus `branch -D`, so
// it can discard two different kinds of work. The backend refuses and names
// what would be lost; this turns that refusal into the facts the confirm dialog
// needs. Anything else (locked file, stale entry) returns null and must be
// reported as an error rather than escalated into a destructive retry.
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
  const base = m ? m[2] : null;

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
