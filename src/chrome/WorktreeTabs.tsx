import { useEffect, useRef } from "react";
import { House, Plus } from "lucide-react";
import { useStore, allPaneIds } from "../store";
import { statusLetter } from "../sidebar/statusLetter";
import type { FileStatus, Worktree } from "../types";

// Severity ladder for a worktree's worst mark. Reusing statusLetter means the
// tab strip and the Changes list can never disagree about what "D" outranks.
const MARKS = ["var(--gm-ink-dim)", "var(--gm-green)", "var(--gm-amber)", "var(--gm-red)"];

interface Signal {
  color: string;
  dirty: number;
  panes: number;
  loaded: boolean;
}

function signalFor(
  wt: Worktree,
  statuses: Record<string, FileStatus[]>,
  panes: number,
): Signal {
  const entries = statuses[wt.id];
  const loaded = entries !== undefined;
  const dirty = entries?.length ?? 0;
  let worst = 0;
  for (const f of entries ?? []) {
    const rank = MARKS.indexOf(statusLetter(f).color);
    if (rank > worst) worst = rank;
  }
  const color = !loaded
    ? "var(--gm-ink-faint)"
    : dirty === 0
      ? "var(--gm-green)"
      : (MARKS[worst] ?? "var(--gm-amber)");
  return { color, dirty, panes, loaded };
}

/**
 * Every worktree in the session, always visible. The sidebar is where you
 * manage them; this is where you see and jump between them, with the pane and
 * dirty-file counts that say which one is busy.
 */
export function WorktreeTabs({ onNewWorktree }: { onNewWorktree?: () => void }) {
  const worktrees = useStore((s) => s.worktrees);
  const activeWorktreeId = useStore((s) => s.activeWorktreeId);
  const setActiveWorktree = useStore((s) => s.setActiveWorktree);
  const layouts = useStore((s) => s.layouts);
  const statuses = useStore((s) => s.statuses);
  const isGit = useStore((s) => {
    const p = s.projects.find((x) => x.id === s.activeProjectId);
    return !!p?.isGit;
  });
  const barRef = useRef<HTMLDivElement>(null);

  const rows = isGit ? worktrees.filter((wt) => !wt.id.startsWith("plain:")) : worktrees;

  // Keep the active tab in view when the switch came from the keyboard or the
  // palette rather than from a click on the strip.
  useEffect(() => {
    barRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeWorktreeId]);

  if (rows.length === 0) return null;

  return (
    <div
      ref={barRef}
      className="gm-rule flex h-tab shrink-0 items-stretch overflow-x-auto bg-surface-panel"
      role="tablist"
      aria-label="Worktrees"
    >
      {rows.map((wt) => {
        const active = wt.id === activeWorktreeId;
        const sig = signalFor(wt, statuses, allPaneIds(layouts[wt.id] ?? null).length);
        return (
          <button
            key={wt.id}
            role="tab"
            aria-selected={active}
            data-active={active}
            title={`${wt.branch}\n${wt.path}`}
            onClick={() => setActiveWorktree(wt.id)}
            className={`group/tab flex shrink-0 items-center gap-2 border-r border-[color:var(--gm-hairline-soft)] px-3 text-body ${
              active
                ? "bg-surface-canvas text-ink-100"
                : "text-ink-400 hover:bg-[color:var(--gm-hover)] hover:text-ink-200"
            }`}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: sig.color }}
              title={
                !isGit
                  ? "plain folder"
                  : !sig.loaded
                    ? "status not read yet"
                    : sig.dirty === 0
                      ? "clean"
                      : `${sig.dirty} changed ${sig.dirty === 1 ? "file" : "files"}`
              }
            />
            {wt.is_main && <House size={11} strokeWidth={2} className="shrink-0 text-ink-500" />}
            <span className={`truncate ${active ? "font-semibold" : "font-medium"}`}>
              {wt.branch || "(detached)"}
            </span>
            {sig.panes > 1 && (
              <span className="tnum shrink-0 text-meta text-ink-500" title={`${sig.panes} panes`}>
                {sig.panes}
              </span>
            )}
            {sig.dirty > 0 && (
              <span className="tnum shrink-0 text-meta font-semibold text-[color:var(--gm-amber)]">
                {sig.dirty}
              </span>
            )}
          </button>
        );
      })}
      {onNewWorktree && isGit && (
        <button
          className="gm-icon-btn my-auto ml-1 shrink-0 !h-7 !min-w-7"
          title="New worktree"
          aria-label="New worktree"
          onClick={onNewWorktree}
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}