import type { FileStatus } from "../types";

export interface StatusMark {
  letter: string;
  color: string;
  label: string;
}

// Porcelain letters, not icon glyphs. Precedence matters: a file deleted from
// the worktree reads "D" even when the index also carries an "M" (it is gone,
// whatever was staged), and a staged addition is "A" rather than a blank "·".
// Colors are the --gm-* state tokens, so components never hardcode one.
export function statusLetter(s: FileStatus): StatusMark {
  const cols = [s.index_status, s.workdir_status];
  const has = (c: string) => cols.includes(c);

  if (has("?")) return { letter: "A", color: "var(--gm-green)", label: "untracked" };
  if (s.index_status === "A") return { letter: "A", color: "var(--gm-green)", label: "added" };
  if (has("D")) return { letter: "D", color: "var(--gm-red)", label: "deleted" };
  if (has("R")) return { letter: "R", color: "var(--gm-ink-dim)", label: "renamed" };
  if (has("M")) return { letter: "M", color: "var(--gm-amber)", label: "modified" };
  return { letter: "·", color: "var(--gm-ink-dim)", label: s.workdir_status || "changed" };
}
