import type { ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";
import type { Worktree } from "../types";

// Worktrees git knows that guimux never opened ("discovered"): one collapsed
// line per project, expanding to a preview grouped by parent directory. Rows
// open through the caller's own handler, so the active project and the other
// projects keep their different wiring in one place each.
//
// The line is a notification, not a permanent toggle: it counts only rows that
// arrived since the last dismiss, and it disappears once the rows are shown or
// kept hidden. Leaving it up while the rows are in the list says "hiding 5"
// over five visible rows.

const parentPath = (p: string) => {
  // Shared dirname: keeps case + Windows separators, never re-joins.
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p : p.slice(0, i);
};

/** Collapse siblings under one parent dir, first-seen order. */
export function groupByParent(rows: Worktree[]): { path: string; rows: Worktree[] }[] {
  const groups: { path: string; rows: Worktree[] }[] = [];
  const byPath = new Map<string, { path: string; rows: Worktree[] }>();
  for (const wt of rows) {
    const path = parentPath(wt.path);
    const key = path.toLowerCase();
    const found = byPath.get(key);
    if (found) {
      found.rows.push(wt);
      continue;
    }
    const next = { path, rows: [wt] };
    byPath.set(key, next);
    groups.push(next);
  }
  return groups;
}

interface Props {
  /** Rows that arrived since the last dismiss. */
  fresh: Worktree[];
  expanded: boolean;
  onToggle: () => void;
  onKeepHidden: () => void;
  onShowInList: () => void;
  groups: Record<string, true>;
  onToggleGroup: (key: string) => void;
  groupKey: (parentDir: string) => string;
  renderRow: (wt: Worktree) => ReactNode;
}

export function DiscoveredBlock({
  fresh,
  expanded,
  onToggle,
  onKeepHidden,
  onShowInList,
  groups,
  onToggleGroup,
  groupKey,
  renderRow,
}: Props) {
  if (fresh.length === 0) return null;
  const noun = fresh.length === 1 ? "worktree" : "worktrees";
  const all = groupByParent(fresh);
  const shown = all.slice(0, 5);
  const extra = all.length - shown.length;

  const keepHidden = (
    <button
      className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-[var(--gm-hover)] hover:text-ink-200"
      onClick={onKeepHidden}
      title="Keep hidden"
      aria-label={`Keep ${fresh.length} discovered ${noun} hidden`}
    >
      <X size={12} strokeWidth={2} />
    </button>
  );

  return (
    <div className="mt-0.5 px-2.5 py-1">
      <div className="flex items-center gap-1">
        <button
          className="gm-tab flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          data-active={false}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${fresh.length} discovered ${noun}`}
          title="Worktrees git knows that were never opened here"
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="tnum truncate">
            Hiding {fresh.length} discovered {noun}
          </span>
        </button>
        {keepHidden}
      </div>
      {expanded && (
        <div className="mt-1">
          {shown.map((g) => {
            const key = groupKey(g.path);
            const open = !!groups[key];
            return (
              <div key={key} className="mt-1">
                <div className="gm-meta mono truncate" title={g.path}>
                  {g.path} · {g.rows.length}
                </div>
                {(open ? g.rows : g.rows.slice(0, 3)).map(renderRow)}
                {g.rows.length > 3 && (
                  <button
                    className="gm-tab px-2 py-1"
                    data-active={false}
                    onClick={() => onToggleGroup(key)}
                  >
                    {open ? "Show fewer" : `Show ${g.rows.length - 3} more`}
                  </button>
                )}
              </div>
            );
          })}
          {extra > 0 && <div className="gm-meta px-2 py-1">+ {extra} more locations</div>}
          <div className="mt-1 flex items-center gap-2 px-2 py-1">
            <button className="gm-tab text-[12px] font-semibold text-ink-100" onClick={onShowInList}>
              Show in worktree list
            </button>
            <button className="gm-tab text-[12px]" onClick={onKeepHidden}>
              Keep hidden
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
