import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FolderGit2,
  Plus,
  Trash2,
  GitMerge,
  House as HomeIcon,
  Check,
  FilePlus2,
  FilePenLine,
  FileX2,
  ArrowRightLeft,
  Dot,
  ChevronRight,
  Archive,
  Search,
  Pin,
  Copy,
  X,
  type LucideIcon,
} from "lucide-react";
// ponytail: sidebar shows worktrees only; Projects lives in the topbar
// switcher. Re-add a sidebar list only when multi-project is visible at once.
import { useStore } from "../store";
import { detectToProject } from "../project";
import { confirmDialog, errorDialog } from "../dialogs";
import type { Worktree, FileStatus, Project } from "../types";

// Rows are divs with onClick; make them reachable and activable by keyboard.
const rowKey = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

function statusGlyph(s: FileStatus): { Icon: LucideIcon; color: string; label: string } {
  if (s.workdir_status === "?" || s.index_status === "?")
    return { Icon: FilePlus2, color: "var(--gm-green)", label: "untracked" };
  if (s.workdir_status === "M" || s.index_status === "M")
    return { Icon: FilePenLine, color: "var(--gm-amber)", label: "modified" };
  if (s.workdir_status === "D" || s.index_status === "D")
    return { Icon: FileX2, color: "var(--gm-red)", label: "deleted" };
  if (s.workdir_status === "R" || s.index_status === "R")
    return { Icon: ArrowRightLeft, color: "var(--gm-ink-dim)", label: "renamed" };
  return { Icon: Dot, color: "var(--gm-ink-dim)", label: s.workdir_status || "changed" };
}

export function WorktreeSidebar() {
  const {
    projects,
    activeProjectId,
    repoRoot,
    worktrees,
    activeWorktreeId,
    setActiveWorktree,
    setWorktrees,
    updateProject,
    openEditor,
    setPaletteOpen,
  } = useStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, FileStatus[]>>({});
  const [tab, setTab] = useState<"worktrees" | "changes">("worktrees");
  const [settledOpen, setSettledOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projCollapsed, setProjCollapsed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [pinned, setPinned] = useState<Record<string, true>>(() => {
    try {
      return JSON.parse(localStorage.getItem("guimux-pinned-worktrees") ?? "{}");
    } catch {
      return {};
    }
  });
  const togglePin = (id: string) => {
    setPinned((p) => {
      const next = { ...p };
      if (next[id]) delete next[id];
      else next[id] = true as const;
      localStorage.setItem("guimux-pinned-worktrees", JSON.stringify(next));
      return next;
    });
  };
  const [revived, setRevived] = useState<Record<string, true>>(() => {
    try {
      return JSON.parse(localStorage.getItem("guimux-revived-worktrees") ?? "{}");
    } catch {
      return {};
    }
  });
  // ponytail: inactivity = last commit age only (no fs mtime/terminal polling).
  // Upgrade path: backend `inactive_since` covering mtime + dirty + pty recency.
  const SETTLE_AFTER_S = 48 * 3600;
  const revive = (id: string) => {
    setRevived((r) => {
      const next = { ...r, [id]: true as const };
      localStorage.setItem("guimux-revived-worktrees", JSON.stringify(next));
      return next;
    });
    setActiveWorktree(id);
  };
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem("guimux-sidebar-w"));
    return Number.isFinite(v) && v >= 180 && v <= 480 ? v : 240;
  });
  const widthRef = useRef(width);
  widthRef.current = width;

  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // App-level CSS zoom scales clientX but not layout widths: divide the
    // cursor delta by uiZoom so the sidebar tracks the pointer 1:1.
    const zoom = useStore.getState().settings.uiZoom || 1;
    const startX = e.clientX;
    const startW = widthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      const nw = Math.min(480, Math.max(180, startW + (ev.clientX - startX) / zoom));
      widthRef.current = nw;
      setWidth(nw);
    };
    const up = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("guimux-sidebar-w", String(Math.round(widthRef.current)));
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, []);

  const proj: Project | null =
    projects.find((p) => p.id === activeProjectId) ?? null;
  const isGit = proj?.isGit ?? false;
  const isPlain = proj ? !proj.isGit : false;

  const refreshList = async () => {
    if (!repoRoot || !isGit) return;
    // Skip while App's loader owns this repoRoot: App always lists right
    // after it sets repoRoot, so a sidebar re-list here doubles the spawns
    // on every project switch (and on startup).
    await new Promise((r) => setTimeout(r, 1500));
    const st = useStore.getState();
    if (st.repoRoot !== repoRoot) return;
    try {
      const wts: Worktree[] = await invoke("worktree_list", { repoRoot });
      if (useStore.getState().repoRoot !== repoRoot) return;
      setWorktrees(wts);
      if (wts.length > 0) {
        const cur = useStore.getState();
        if (!wts.find((w) => w.id === cur.activeWorktreeId)) {
          setActiveWorktree((wts.find((w) => w.is_main) ?? wts[0]).id);
        }
      }
    } catch {
      /* App's loader surfaces list errors in the banner; stay quiet here */
    }
  };

  useEffect(() => {
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, isGit]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (!repoRoot || !isGit) return;
      // Active worktree first (snappy badge), the rest staggered 300ms
      // apart so N worktrees never burst N git spawns at once on startup.
      const ids = worktrees.filter((wt) => !wt.id.startsWith("plain:")).map((wt) => wt.id);
      const paths = new Map(worktrees.map((wt) => [wt.id, wt.path]));
      const ordered = [
        ...ids.filter((id) => id === useStore.getState().activeWorktreeId),
        ...ids.filter((id) => id !== useStore.getState().activeWorktreeId),
      ];
      const next: Record<string, FileStatus[]> = {};
      for (const [i, id] of ordered.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;
        try {
          next[id] = await invoke("git_status", { path: paths.get(id)! });
        } catch {
          next[id] = [];
        }
        if (!cancelled) setStatuses({ ...next });
      }
      if (!cancelled) setStatuses(next);
    };
    // First poll deferred 3s: the shell burst owns startup; badges catch up.
    const first = setTimeout(() => void poll(), 3000);
    // 8s (not 4s) and skipped while the window is hidden: git_status runs
    // per worktree and this poll is the app's steady-state background load.
    const t = setInterval(() => {
      if (!document.hidden) void poll();
    }, 8000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, isGit, activeProjectId, worktrees.length]);

  // Click anywhere or Escape dismisses the row context menu.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const create = async () => {
    if (!repoRoot || !isGit) return;
    const label = name.trim() || "worktree";
    setCreating(false);
    // Optimistic progress row: the form closes at once and creation runs
    // underneath while the user keeps working (Orca creates in background).
    setPending(label);
    try {
      const created: Worktree = await invoke("worktree_create", {
        repoRoot,
        name: name.trim() || null,
        base: base.trim() || null,
      });
      setName("");
      setBase("");
      await refreshList();
      setActiveWorktree(created.id);
    } catch (e) {
      void errorDialog(`worktree create failed: ${e}`);
    } finally {
      setPending(null);
    }
  };

  const initGit = async () => {
    if (!proj || isGit) return;
    try {
      await invoke("git_init", { path: proj.path, branch: "main" });
      const re = await detectToProject(proj.path);
      updateProject(proj.id, {
        isGit: true,
        gitRoot: re.gitRoot,
        branch: re.branch,
      });
    } catch (e) {
      void errorDialog(`git init failed: ${e}`);
    }
  };

  const remove = async (wt: Worktree) => {
    if (!(await confirmDialog(`Remove worktree "${wt.branch}"? (branch will be deleted)`))) return;
    try {
      await invoke("worktree_remove", { repoRoot, id: wt.id, deleteBranch: !wt.is_main });
      await refreshList();
    } catch (e) {
      void errorDialog(`remove failed: ${e}`);
    }
  };

  const merge = async (wt: Worktree) => {
    if (!(await confirmDialog(`Merge "${wt.branch}" into base branch?`))) return;
    try {
      await invoke("worktree_merge", { id: wt.id });
      await refreshList();
    } catch (e) {
      void errorDialog(`merge failed: ${e}`);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      /* clipboard unavailable: no-op */
    }
  };

  const openMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, id });
  };

  const activeWt = worktrees.find((w) => w.id === activeWorktreeId);
  const activeStatuses = activeWt ? statuses[activeWt.id] ?? [] : [];
  const totalDirty = Object.values(statuses).reduce((a, l) => a + l.length, 0);

  const nowS = Math.floor(Date.now() / 1000);
  const isStale = (wt: Worktree) =>
    !wt.id.startsWith("plain:") &&
    !wt.is_main &&
    wt.id !== activeWorktreeId &&
    !revived[wt.id] &&
    (statuses[wt.id] ?? []).length === 0 &&
    wt.last_commit != null &&
    nowS - wt.last_commit > SETTLE_AFTER_S;
  const gitRows = worktrees.filter((wt) => (isGit ? !wt.id.startsWith("plain:") : true));
  const q = query.trim().toLowerCase();
  const matches = (wt: Worktree) =>
    !q || wt.branch.toLowerCase().includes(q) || wt.path.toLowerCase().includes(q);
  const settled = gitRows.filter(isStale).filter(matches);
  const live = gitRows
    .filter((wt) => !isStale(wt))
    .filter(matches)
    // Pinned worktrees stay at the top of the project (Orca: pin to top).
    .sort((a, b) => Number(!!pinned[b.id]) - Number(!!pinned[a.id]));
  const menuWt = menu ? worktrees.find((w) => w.id === menu.id) ?? null : null;

  return (
    <div
      className="relative flex h-full shrink-0 flex-col bg-ink-900"
      style={{ width, borderRight: "1px solid var(--gm-hairline)" }}
    >
      <div
        className="group absolute bottom-0 right-[-2.5px] top-0 z-20 w-[5px] cursor-col-resize"
        onMouseDown={onResizeDown}
        onDoubleClick={() => {
          widthRef.current = 240;
          setWidth(240);
          localStorage.setItem("guimux-sidebar-w", "240");
        }}
        title="Drag to resize, double-click to reset"
      >
        <div
          className="mx-auto h-full w-[3px] rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: "var(--gm-ink-mute)" }}
        />
      </div>
      {/* header: sidebar filter plus a search button that opens the jump
          palette (Orca: header filter input + Cmd-J search button). */}
      <div className="flex items-center gap-1.5 px-2 pt-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5"
          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--gm-hairline-soft)" }}
        >
          <Search size={12} className="shrink-0 text-ink-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isGit ? "Filter worktrees" : "Filter"}
            aria-label="Filter worktrees"
            className="w-full bg-transparent text-[12px] text-ink-100 outline-none placeholder:text-ink-400"
          />
          {query && (
            <button
              className="shrink-0 rounded p-0.5 text-ink-400 hover:text-ink-200"
              onClick={() => setQuery("")}
              title="Clear filter"
              aria-label="Clear filter"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button
          className="shrink-0 rounded-md p-2 text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
          onClick={() => setPaletteOpen(true)}
          title="Jump to worktree, file, or command (Ctrl K)"
          aria-label="Open jump palette"
        >
          <Search size={13} />
        </button>
      </div>
      {/* tabs: real tab indicator, weight shift, no travelling underline.
          Changes tab only exists for git projects (no dead tab in folders). */}
      <div className="flex px-2 pt-2" style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}>
        <button
          className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] ${
            isGit ? "flex-1" : ""
          } ${
            tab === "worktrees"
              ? "bg-white/[0.06] font-semibold text-ink-100"
              : "font-medium text-ink-400 hover:bg-white/[0.03] hover:text-ink-300"
          }`}
          onClick={() => setTab("worktrees")}
        >
          <FolderGit2 size={12} />
          {isGit ? "Worktrees" : "Folder"}
        </button>
        {isGit && (
        <button
          className={`tnum flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] ${
            tab === "changes"
              ? "bg-white/[0.06] font-semibold text-ink-100"
              : "font-medium text-ink-400 hover:bg-white/[0.03] hover:text-ink-300"
          }`}
          onClick={() => setTab("changes")}
        >
          Changes
          {totalDirty > 0 && (
            <span className="text-[11px] font-semibold" style={{ color: "var(--gm-accent)" }}>
              {totalDirty}
            </span>
          )}
        </button>
        )}
      </div>

      {tab === "worktrees" ? (
        <div className="flex-1 overflow-y-auto p-2">
          {isPlain && (
            <div
              className="mb-2 rounded-lg p-2.5 text-[11.5px] leading-5 text-ink-300"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--gm-hairline-soft)" }}
            >
              Plain folder. Terminals and files work now; worktrees appear after init.
              <button
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-medium text-ink-200 hover:bg-white/[0.05]"
                style={{ border: "1px solid var(--gm-hairline)" }}
                onClick={initGit}
              >
                <Plus size={12} /> Init git here
              </button>
            </div>
          )}

          {/* project row: Orca groups worktrees under their project. */}
          {proj && isGit && (
            <button
              className="tnum mb-1 flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium text-ink-400 hover:bg-white/[0.03] hover:text-ink-300"
              onClick={() => setProjCollapsed((c) => !c)}
              aria-expanded={!projCollapsed}
              title={proj.path}
            >
              <ChevronRight
                size={12}
                className={`shrink-0 transition-transform ${projCollapsed ? "" : "rotate-90"}`}
              />
              <FolderGit2 size={12} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{proj.name}</span>
              <span>{gitRows.length}</span>
            </button>
          )}

          {!projCollapsed && (
          <>
          {pending && (
            <div className="mb-px flex items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] text-ink-300">
              <span
                className="h-3 w-3 shrink-0 animate-spin rounded-full"
                style={{ border: "2px solid var(--gm-hairline)", borderTopColor: "var(--gm-ink-mute)" }}
              />
              <span className="truncate">Creating {pending}…</span>
            </div>
          )}

          {live.map((wt) => {
              const dirty = (statuses[wt.id] ?? []).length;
              const plainRow = wt.id.startsWith("plain:");
              const selected = wt.id === activeWorktreeId;
              return (
                <div
                  key={wt.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  className={`group mb-px cursor-pointer rounded-md px-2.5 py-2 ${
                    selected ? "bg-white/[0.055]" : "hover:bg-white/[0.03]"
                  }`}
                  style={selected ? { boxShadow: "inset 2px 0 0 var(--gm-accent)" } : undefined}
                  onClick={() => setActiveWorktree(wt.id)}
                  onKeyDown={rowKey(() => setActiveWorktree(wt.id))}
                  onContextMenu={(e) => openMenu(e, wt.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`flex min-w-0 items-center gap-1.5 text-[12.5px] ${
                        selected || dirty > 0 ? "font-semibold text-ink-100" : "font-medium text-ink-300"
                      }`}
                    >
                      {!plainRow && wt.is_main && (
                        <span title="Main worktree" className="flex shrink-0"><HomeIcon size={11} className="text-accent-500" /></span>
                      )}
                      {pinned[wt.id] && (
                        <span title="Pinned to top" className="flex shrink-0"><Pin size={10} className="text-ink-400" /></span>
                      )}
                      <span className="truncate">{wt.branch}</span>
                    </span>
                    {!plainRow && !wt.is_main && (
                      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                        <button
                          title="Merge into base"
                          className="rounded p-1 text-ink-400 hover:bg-white/[0.06] hover:text-moss-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            merge(wt);
                          }}
                        >
                          <GitMerge size={12} />
                        </button>
                        <button
                          title="Remove worktree"
                          className="rounded p-1 text-ink-400 hover:bg-white/[0.06] hover:text-clay-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(wt);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="tnum mt-0.5 flex items-center justify-between gap-2 text-[11px] text-ink-400">
                    <span className="truncate">{wt.path}</span>
                    {dirty > 0 && (
                      <span className="shrink-0 font-medium" style={{ color: "var(--gm-amber)" }}>
                        {dirty} changed
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

          {live.length === 0 && settled.length === 0 && q && (
            <div className="px-2.5 py-4 text-center text-[12px] text-ink-400">
              No worktrees match.
            </div>
          )}

          {settled.length > 0 && (
            <div className="mt-1.5">
              <button
                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium text-ink-400 hover:bg-white/[0.03] hover:text-ink-300"
                onClick={() => setSettledOpen((o) => !o)}
                aria-expanded={settledOpen}
                title="Worktrees quiet for over 48 hours"
              >
                <ChevronRight
                  size={12}
                  className={`shrink-0 transition-transform ${settledOpen ? "rotate-90" : ""}`}
                />
                <Archive size={12} className="shrink-0" />
                <span className="tnum">
                  Sleeping · {settled.length}
                </span>
              </button>
              {settledOpen &&
                settled.map((wt) => (
                  <div
                    key={wt.id}
                    role="button"
                    tabIndex={0}
                    className="group mb-px cursor-pointer rounded-md px-2.5 py-2 opacity-60 hover:bg-white/[0.03] hover:opacity-100"
                    onClick={() => revive(wt.id)}
                    onKeyDown={rowKey(() => revive(wt.id))}
                    onContextMenu={(e) => openMenu(e, wt.id)}
                    title="Quiet over 48h — click to make active again"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-ink-300">
                        {pinned[wt.id] && (
                          <span title="Pinned to top" className="flex shrink-0"><Pin size={10} className="text-ink-400" /></span>
                        )}
                        <span className="truncate">{wt.branch}</span>
                      </span>
                      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                        <button
                          title="Merge into base"
                          className="rounded p-1 text-ink-400 hover:bg-white/[0.06] hover:text-moss-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            merge(wt);
                          }}
                        >
                          <GitMerge size={12} />
                        </button>
                        <button
                          title="Remove worktree"
                          className="rounded p-1 text-ink-400 hover:bg-white/[0.06] hover:text-clay-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(wt);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    </div>
                    <div className="tnum mt-0.5 truncate text-[11px] text-ink-400">
                      {wt.path}
                    </div>
                  </div>
                ))}
            </div>
          )}

          {isGit &&
            (creating ? (
              <div
                className="mt-2 rounded-lg p-2.5"
                style={{ background: "var(--gm-raised)", border: "1px solid var(--gm-hairline)" }}
              >
                <input
                  autoFocus
                  className="mono w-full rounded-md bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none placeholder:text-ink-400"
                  style={{ border: "1px solid var(--gm-hairline)" }}
                  placeholder="branch name (optional)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") create();
                    if (e.key === "Escape") setCreating(false);
                  }}
                />
                <input
                  className="mono mt-1.5 w-full rounded-md bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none placeholder:text-ink-400"
                  style={{ border: "1px solid var(--gm-hairline)" }}
                  placeholder="start from (blank = current HEAD)"
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") create();
                    if (e.key === "Escape") setCreating(false);
                  }}
                />
                <div className="mt-2 flex gap-1.5">
                  <button
                    className="flex-1 rounded-md py-1.5 text-[12px] font-semibold"
                    style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
                    onClick={create}
                  >
                    Create worktree
                  </button>
                  <button
                    className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-300 hover:bg-white/[0.05]"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-[12px] font-medium text-ink-300 hover:bg-white/[0.03] hover:text-ink-200"
                style={{ border: "1px dashed rgba(255,255,255,0.16)" }}
                onClick={() => setCreating(true)}
              >
                <Plus size={12} /> New worktree
              </button>
            ))}
          </>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-1.5">
          {isGit && activeWt && activeStatuses.length === 0 && (
            <div className="flex flex-col items-center px-2 py-4 text-center">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full"
                style={{ background: "rgba(129,184,139,0.1)", border: "1px solid rgba(129,184,139,0.25)" }}
              >
                <Check size={13} style={{ color: "var(--gm-green)" }} />
              </span>
              <div className="mt-2 text-[12.5px] font-medium text-ink-200">Working tree clean</div>
              <div className="mt-0.5 text-[11.5px] text-ink-300">Nothing to review in this worktree.</div>
            </div>
          )}
          {isGit &&
            activeStatuses.map((s) => {
              const g = statusGlyph(s);
              return (
                <div
                  key={s.path}
                  role="button"
                  tabIndex={0}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px] hover:bg-white/[0.03]"
                  onClick={() => openEditor(`${activeWt!.path}/${s.path}`, true)}
                  onKeyDown={rowKey(() => openEditor(`${activeWt!.path}/${s.path}`, true))}
                  title={`${s.path} (${g.label})`}
                >
                  <g.Icon size={13} className="shrink-0" style={{ color: g.color }} aria-hidden />
                  <span className="truncate text-[12px] text-ink-200">{s.path}</span>
                </div>
              );
            })}
        </div>
      )}

      {/* row context menu: open / pin / copy / merge / remove (Orca: right-click actions). */}
      {menu && menuWt && (
        <div
          className="tnum fixed z-50 w-48 overflow-hidden rounded-lg py-1 shadow-pop"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 220),
            background: "var(--gm-overlay)",
            border: "1px solid var(--gm-hairline)",
          }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-ink-200 hover:bg-white/[0.04]"
            onClick={() => {
              setActiveWorktree(menuWt.id);
              setMenu(null);
            }}
            role="menuitem"
          >
            <Check size={12} className="text-ink-400" /> Open worktree
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-ink-200 hover:bg-white/[0.04]"
            onClick={() => {
              togglePin(menuWt.id);
              setMenu(null);
            }}
            role="menuitem"
          >
            <Pin size={12} className="text-ink-400" /> {pinned[menuWt.id] ? "Unpin" : "Pin to top"}
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-ink-200 hover:bg-white/[0.04]"
            onClick={() => {
              void copyPath(menuWt.path);
              setMenu(null);
            }}
            role="menuitem"
          >
            <Copy size={12} className="text-ink-400" /> Copy path
          </button>
          {!menuWt.is_main && !menuWt.id.startsWith("plain:") && (
            <>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-ink-200 hover:bg-white/[0.04]"
                onClick={() => {
                  setMenu(null);
                  merge(menuWt);
                }}
                role="menuitem"
              >
                <GitMerge size={12} className="text-ink-400" /> Merge into base
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-ink-200 hover:bg-white/[0.04]"
                onClick={() => {
                  setMenu(null);
                  remove(menuWt);
                }}
                role="menuitem"
              >
                <Trash2 size={12} className="text-ink-400" /> Remove worktree
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
