import type { KeyboardEvent, MouseEvent } from "react";
import { MoreHorizontal } from "lucide-react";
import type { AheadBehind, FileStatus, Worktree } from "../types";

// One row shape for every worktree in the panel: selected rail, branch line,
// status cluster, and a hover actions button. A context menu alone leaves the
// actions unreachable without a mouse.

export const rowKey = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

// Long Windows paths wrap mid-segment and wreck the list, so shortPath keeps
// the last two segments. The main worktree keeps its full path.
export function shortPath(p: string, full: boolean): string {
  if (full) return p;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 3 ? p : "…/" + parts.slice(-2).join("/");
}

const slash = (s: string) => s.replace(/\\/g, "/");

interface Props {
  wt: Worktree;
  onOpen: () => void;
  /** Anchor for the row menu: pointer position, or the button's own rect. */
  onMenu: (at: { x: number; y: number }) => void;
  selected?: boolean;
  /** Porcelain entries, or null when status has not been read yet. Omitted
   *  entirely for rows that never show a cluster (sleeping, discovered). */
  status?: FileStatus[] | null;
  /** Ahead/behind vs upstream (or main). Null = not read yet; hidden then. */
  aheadBehind?: AheadBehind | null;
  pinned?: boolean;
  /** Sleeping rows read quieter without leaving the list. */
  dim?: boolean;
  /** Discovered previews show the branch only: the group header has the dir. */
  compact?: boolean;
}

export function WorktreeRow({
  wt,
  onOpen,
  onMenu,
  selected = false,
  status,
  aheadBehind,
  pinned = false,
  dim = false,
  compact = false,
}: Props) {
  const plainRow = wt.id.startsWith("plain:");
  const known = status !== undefined && status !== null;
  const dirty = status?.length ?? 0;
  const abAhead = aheadBehind?.ahead ?? 0;
  const abBehind = aheadBehind?.behind ?? 0;
  const showAb = aheadBehind != null && (abAhead > 0 || abBehind > 0);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-selected={selected}
      className={`gm-row gm-rail group/row cursor-pointer px-2.5 py-1.5 ${dim ? "opacity-60 hover:opacity-100" : ""}`}
      onClick={onOpen}
      onKeyDown={rowKey(onOpen)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      title={`${wt.branch}\n${wt.path}\nRight-click, or use the row button, for actions.`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            selected ? "font-semibold text-ink-100" : "font-medium text-ink-200"
          }`}
        >
          {wt.branch}
          {!plainRow && wt.is_main && <span className="font-normal text-ink-500"> · main</span>}
          {pinned && <span className="font-normal text-ink-500"> · pinned</span>}
        </span>
        {status !== undefined && (
          <span className="flex-none text-[11px]">
            {!known ? (
              <span className="gm-meta tnum" title="Status not read yet">
                …
              </span>
            ) : dirty > 0 ? (
              <span className="tnum font-semibold" style={{ color: "var(--gm-amber)" }}>
                {dirty}
              </span>
            ) : (
              <span className="gm-meta tnum">clean</span>
            )}
          </span>
        )}
        {showAb && (
          <span
            className="tnum flex-none text-[11px] text-ink-500"
            title={abBehind > 0 ? `${abAhead} ahead, ${abBehind} behind` : `${abAhead} ahead`}
          >
            {abAhead > 0 ? `↑${abAhead}` : ""}{abAhead > 0 && abBehind > 0 ? " " : ""}{abBehind > 0 ? `↓${abBehind}` : ""}
          </span>
        )}
        <button
          className="gm-icon-btn gm-icon-btn--sm -my-0.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
          aria-label={`Actions for ${wt.branch}`}
          aria-haspopup="menu"
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            // The row itself is a button: without this, opening the menu also
            // opens the worktree.
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu({ x: r.right, y: r.bottom + 4 });
          }}
          onKeyDown={(e) => e.stopPropagation()}
          tabIndex={0}
        >
          <MoreHorizontal size={14} strokeWidth={2} />
        </button>
      </div>
      {!compact && (
        <div className="gm-meta mono mt-0.5 truncate" title={slash(wt.path)}>
          {shortPath(wt.path, wt.is_main)}
        </div>
      )}
    </div>
  );
}
