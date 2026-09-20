import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, ChevronRight, X, GitBranch, Check } from "lucide-react";
// Ledger sidebar: typographic rows only. No status dots, no row icons, no
// hover icon buttons — status reads as words ("3 changed", "clean"), actions
// live in the right-click menu. Re-add inline affordances only if the menu
// proves undiscoverable.
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

// Porcelain letters, not icon glyphs: M amber, added green, deleted red.
function statusLetter(s: FileStatus): { letter: string; color: string; label: string } {
  if (s.workdir_status === "?" || s.index_status === "?")
    return { letter: "A", color: "var(--gm-green)", label: "untracked" };
  if (s.workdir_status === "M" || s.index_status === "M")
    return { letter: "M", color: "var(--gm-amber)", label: "modified" };
  if (s.workdir_status === "D" || s.index_status === "D")
    return { letter: "D", color: "var(--gm-red)", label: "deleted" };
  if (s.workdir_status === "R" || s.index_status === "R")
    return { letter: "R", color: "var(--gm-ink-dim)", label: "renamed" };
  return { letter: "·", color: "var(--gm-ink-dim)", label: s.workdir_status || "changed" };
}

// Long Windows paths wrap mid-segment and wreck the list; shorten to the
// last two segments. Main worktree keeps its full path (it is the anchor).
function shortPath(p: string, full: boolean): string {
  if (full) return p;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-2).join("/");
}

export function WorktreeSidebar() {
  const {
    projects,
    activeProjectId,
    repoRoot,
    worktrees,
    worktreesByProject,
    layouts,
    activeWorktreeId,
    setActiveWorktree,
    openProjectWorktree,
    setWorktrees,
    updateProject,
    openEditor,
  } = useStore();
  // Unvisited projects have no cached list yet: fill them in once per repo
  // root so every project shows rows (your screenshot's always-on panel).
  // Writes go through setProjectWorktrees (cache only), never the live list.
  const [listedRoots, setListedRoots] = useState<Record<string, true>>({});
  const cacheKeys = Object.keys(worktreesByProject).length;
  useEffect(() => {
    let cancelled = false;
    const missing = projects.filter(
      (p) => p.isGit && (p.gitRoot ?? p.path) && !worktreesByProject[p.id] && !listedRoots[p.gitRoot ?? p.path],
    );
    if (missing.length === 0) return;
    (async () => {
      for (const p of missing) {
        const root = p.gitRoot ?? p.path;
        try {
          const wts: Worktree[] = await invoke("worktree_list", { repoRoot: root });
          if (cancelled || !wts.length) continue;
          const st = useStore.getState();
          if (st.activeProjectId === p.id) st.setWorktrees(wts);
          else st.setProjectWorktrees(p.id, wts);
        } catch {
          /* offline/locked: App's loader surfaces errors for the active project */
        }
        if (!cancelled) setListedRoots((r) => ({ ...r, [root]: true as const }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length, cacheKeys]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [baseOpen, setBaseOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, FileStatus[]>>({});
  const [tab, setTab] = useState<"worktrees" | "changes">("worktrees");
  const [settledOpen, setSettledOpen] = useState(false);
  // Other projects start collapsed: one line each until opened. Active
  // project is always expanded. Persisted so the list stays calm.
  const [projOpen, setProjOpen] = useState<Record<string, true>>(() => {
    try {
      return JSON.parse(localStorage.getItem("guimux-sidebar-expanded") ?? "{}");
    } catch {
      return {};
    }
  });
  const toggleProjOpen = (pid: string) => {
    setProjOpen((c) => {
      const next = { ...c };
      if (next[pid]) delete next[pid];
      else next[pid] = true as const;
      try {
        localStorage.setItem("guimux-sidebar-expanded", JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  };
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; projectId: string } | null>(null);
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
      // Never blank a live list: an empty/errored re-list here used to wipe
      // the seeded fallback and strand the shell on "Starting terminal…".
      if (wts.length === 0) return;
      setWorktrees(wts);
      const cur = useStore.getState();
      if (!wts.find((w) => w.id === cur.activeWorktreeId)) {
        setActiveWorktree((wts.find((w) => w.is_main) ?? wts[0]).id);
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

  const openCreate = async () => {
    setCreating(true);
    if (!repoRoot) return;
    try {
      const list: string[] = await invoke("git_branches", { repoRoot });
      setBranches(list);
    } catch {
      setBranches([]);
    }
  };

  const create = async () => {
    if (!repoRoot || !isGit) return;
    const label = name.trim() || "worktree";
    setCreating(false);
    // Optimistic progress row: the form closes at once and creation runs
    // underneath while the user keeps working.
    setPending(label);
    try {
      const created: Worktree = await invoke("worktree_create", {
        repoRoot,
        name: name.trim() || null,
        base: base.trim() || null,
      });
      setName("");
      setBase("");
      // Mount the new shell at once; the re-list below reconciles in background.
      setWorktrees([...useStore.getState().worktrees, created]);
      setActiveWorktree(created.id);
      await refreshList();
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

  // pid scopes the git call to the row's own project (other-project rows
  // carry their projectId; active rows default to the current repo root).
  const remove = async (wt: Worktree, pid?: string) => {
    if (!(await confirmDialog(`Remove worktree "${wt.branch}"? (branch will be deleted)`))) return;
    const root = pid ? rootOf(pid) : repoRoot;
    if (!root) return;
    const runRemove = async (force: boolean) => {
      await invoke("worktree_remove", {
        repoRoot: root,
        id: wt.id,
        deleteBranch: !wt.is_main,
        force,
      });
      // Orphaned shells no longer die on unmount, so reap them explicitly.
      for (const pty of useStore.getState().dropWorktreeLayout(wt.id)) {
        invoke("pty_kill", { id: pty }).catch(() => {});
      }
      if (pid && pid !== useStore.getState().activeProjectId) {
        await refreshProjectList(pid, root);
      } else {
        await refreshList();
      }
    };
    try {
      await runRemove(false);
    } catch (e) {
      // Uncommitted work is the one failure worth a second, explicit confirm:
      // the backend refuses rather than silently discarding it.
      if (!String(e).includes("uncommitted changes")) {
        void errorDialog(`remove failed: ${e}`);
        return;
      }
      if (!(await confirmDialog(`${wt.branch} has uncommitted changes. Remove it anyway and discard them?`))) return;
      try {
        await runRemove(true);
      } catch (e2) {
        void errorDialog(`remove failed: ${e2}`);
      }
    }
  };

  const merge = async (wt: Worktree, pid?: string) => {
    if (!(await confirmDialog(`Merge "${wt.branch}" into base branch?`))) return;
    try {
      await invoke("worktree_merge", { id: wt.id });
      const root = pid ? rootOf(pid) : repoRoot;
      if (pid && root && pid !== useStore.getState().activeProjectId) {
        await refreshProjectList(pid, root);
      } else {
        await refreshList();
      }
    } catch (e) {
      void errorDialog(`merge failed: ${e}`);
    }
  };

  const abortMerge = async (wt: Worktree, pid?: string) => {
    try {
      await invoke("worktree_merge_abort", { id: wt.id });
      const root = pid ? rootOf(pid) : repoRoot;
      if (pid && root && pid !== useStore.getState().activeProjectId) {
        await refreshProjectList(pid, root);
      } else {
        await refreshList();
      }
    } catch (e) {
      void errorDialog(`abort failed: ${e}`);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      /* clipboard unavailable: no-op */
    }
  };

  const openMenu = (e: React.MouseEvent, id: string, projectId?: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, id, projectId: projectId ?? activeProjectId ?? "" });
  };
  // Other-project rows act on their own repo root, not the active one.
  const rootOf = (pid: string) => {
    const p = useStore.getState().projects.find((x) => x.id === pid);
    return p && p.isGit ? (p.gitRoot ?? p.path) : null;
  };
  const refreshProjectList = async (pid: string, root: string) => {
    try {
      const wts: Worktree[] = await invoke("worktree_list", { repoRoot: root });
      if (wts.length === 0) return;
      const st = useStore.getState();
      if (st.activeProjectId === pid) {
        st.setWorktrees(wts);
        if (!wts.find((w) => w.id === st.activeWorktreeId)) {
          st.setActiveWorktree((wts.find((w) => w.is_main) ?? wts[0]).id);
        }
      } else {
        st.setProjectWorktrees(pid, wts);
      }
    } catch {
      /* active-project errors surface via App's loader; others stay quiet */
    }
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
  const bq = base.trim().toLowerCase();
  const baseOptions = (bq ? branches.filter((b) => b.toLowerCase().includes(bq)) : branches).slice(0, 40);
  const matches = (wt: Worktree) =>
    !q || wt.branch.toLowerCase().includes(q) || wt.path.toLowerCase().includes(q);
  // Discovered rows are worktrees git knows that guimux never created: no
  // layout (never opened as a session), no guimux/ branch, not main.
  // Orca pattern: one collapsed line per project, "Hiding N discovered
  // worktrees", expanding to a preview grouped by parent path. A persisted
  // dismiss baseline keeps them hidden until new ones appear; the filter
  // still searches everything, and opening a hidden row adopts it.
  const isDiscovered = (wt: Worktree) =>
    !wt.is_main && !wt.id.startsWith("plain:") && !layouts[wt.id] && !wt.branch.startsWith("guimux/");
  const [showAll, setShowAll] = useState<Record<string, true>>({});
  const [disExpanded, setDisExpanded] = useState<Record<string, true>>({});
  const [disGroups, setDisGroups] = useState<Record<string, true>>({});
  const [disBaseline, setDisBaseline] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem("guimux-discovered-baseline") ?? "{}");
    } catch {
      return {};
    }
  });
  const saveBaseline = (next: Record<string, string[]>) => {
    setDisBaseline(next);
    try {
      localStorage.setItem("guimux-discovered-baseline", JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  const parentPath = (p: string) => {
    // Shared dirname: keeps case + Windows separators, never re-joins.
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i <= 0 ? p : p.slice(0, i);
  };
  const discoveredGroups = (rows: Worktree[]) => {
    const groups: { path: string; rows: Worktree[] }[] = [];
    const byPath = new Map<string, { path: string; rows: Worktree[] }>();
    for (const wt of rows) {
      const path = parentPath(wt.path);
      const g = byPath.get(path.toLowerCase());
      if (g) {
        g.rows.push(wt);
        continue;
      }
      const next = { path, rows: [wt] };
      byPath.set(path.toLowerCase(), next);
      groups.push(next);
    }
    return groups;
  };
  const delKey = (s: Record<string, true>, pid: string) => {
    const next = { ...s };
    delete next[pid];
    return next;
  };
  const baseSet = (pid: string) => new Set(disBaseline[pid] ?? []);
  // New since last dismiss: all the line counts and previews.
  const freshDiscovered = (rows: Worktree[], pid: string) => {
    const base = baseSet(pid);
    return rows.filter((wt) => isDiscovered(wt) && !base.has(wt.id));
  };
  const dismissDiscovered = (pid: string, rows: Worktree[]) => {
    const base = baseSet(pid);
    for (const wt of rows) if (isDiscovered(wt)) base.add(wt.id);
    saveBaseline({ ...disBaseline, [pid]: [...base] });
    setDisExpanded((s) => delKey(s, pid));
  };
  const showDiscovered = (pid: string) => {
    const next = { ...disBaseline };
    delete next[pid];
    saveBaseline(next);
    setShowAll((s) => ({ ...s, [pid]: true as const }));
    setDisExpanded((s) => delKey(s, pid));
  };
  const visibleRows = (rows: Worktree[], pid: string) => {
    // Filtering searches everything, discovered included: a collapsed line
    // must never hide a match. Idle view shows sessions + guimux branches.
    if (q) return rows.filter(matches);
    if (showAll[pid]) return rows;
    return rows.filter((wt) => !isDiscovered(wt));
  };
  const settled = gitRows.filter(isStale).filter(matches);
  const live = gitRows
    .filter((wt) => !isStale(wt))
    .filter(matches)
    // Pinned worktrees stay at the top of the project.
    .sort((a, b) => Number(!!pinned[b.id]) - Number(!!pinned[a.id]));
  const activePid = activeProjectId ?? "";
  const shownLive = visibleRows(live, activePid);
  const shownSettled = visibleRows(settled, activePid);
  const menuWt = menu
    ? worktrees.find((w) => w.id === menu.id)
      ?? Object.values(worktreesByProject).flat().find((w) => w.id === menu.id)
      ?? null
    : null;
  // Every other project, below the active one: project name, then its cached
  // worktrees. Plain folders have no worktrees, so they show one shell row.
  const otherProjects = projects.filter((p) => p.id !== activeProjectId);
  const otherRows = (p: Project) => {
    if (!p.isGit) return [{ id: `plain:${p.id}`, path: p.path, branch: p.name, is_main: true } as Worktree];
    return worktreesByProject[p.id] ?? [];
  };

  return (
    <div
      className="relative flex h-full shrink-0 flex-col bg-ink-900"
      style={{ width, borderRight: "1px solid var(--gm-hairline-soft)" }}
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

      {/* header: section label + count, the only heading in this panel */}
      <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
          Worktrees
        </span>
        {isGit && (
          <span className="tnum gm-meta">{live.length + settled.length}</span>
        )}
      </div>

      {/* filter: underline, not a box */}
      <div
        className="mx-4 flex items-center gap-1.5"
        style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}
      >
        <Search size={13} strokeWidth={2} className="shrink-0 text-ink-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={isGit ? "Filter branches and paths" : "Filter"}
          aria-label="Filter worktrees"
          className="w-full bg-transparent py-2 text-[12px] text-ink-100 outline-none placeholder:text-ink-500"
        />
        {query && (
          <button
            className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-[var(--gm-hover)] hover:text-ink-200"
            onClick={() => setQuery("")}
            title="Clear filter"
            aria-label="Clear filter"
          >
            <X size={12} strokeWidth={2} />
          </button>
        )}
      </div>

      {/* tabs: active reads through weight + color only */}
      <div className="flex items-center gap-4 px-4 pb-0.5 pt-2">
        <button
          className="gm-tab"
          data-active={tab === "worktrees"}
          onClick={() => setTab("worktrees")}
        >
          Worktrees
        </button>
        {isGit && (
          <button
            className="gm-tab tnum"
            data-active={tab === "changes"}
            onClick={() => setTab("changes")}
          >
            Changes{totalDirty > 0 ? ` · ${totalDirty}` : ""}
          </button>
        )}
      </div>

      {tab === "worktrees" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {isPlain && (
            <div className="px-1 py-1 text-[12px] leading-5 text-ink-300">
              Terminals and files work now; worktrees appear after init.{" "}
              <button
                className="font-semibold text-ink-100 hover:underline"
                onClick={initGit}
              >
                Init git here
              </button>
            </div>
          )}

          {pending && (
            <div className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[12px] text-ink-400">
              <span
                className="h-3 w-3 shrink-0 animate-spin rounded-full"
                style={{ border: "2px solid var(--gm-hairline)", borderTopColor: "var(--gm-ink-mute)" }}
              />
              <span className="truncate">Creating {pending}…</span>
            </div>
          )}

          {/* Active project gets its own labeled section so its rows never
              blend into the projects below. */}
          {proj && (shownLive.length > 0 || q) && (
            <div
              className="flex items-baseline justify-between px-2.5 pb-1 pt-2"
              title={proj.path}
            >
              <span className="truncate text-[12px] font-semibold text-ink-100">
                {proj.name}
              </span>
              <span className="tnum gm-meta flex-none">
                {shownLive.length}
              </span>
            </div>
          )}

          {shownLive.map((wt) => {
            const dirty = (statuses[wt.id] ?? []).length;
            const plainRow = wt.id.startsWith("plain:");
            const selected = wt.id === activeWorktreeId;
            return (
              <div
                key={wt.id}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                data-selected={selected}
                className="gm-row cursor-pointer px-2.5 py-2"
                style={selected ? { boxShadow: "inset 2px 0 0 var(--gm-ink-mute)" } : undefined}
                onClick={() => setActiveWorktree(wt.id)}
                onKeyDown={rowKey(() => setActiveWorktree(wt.id))}
                onContextMenu={(e) => openMenu(e, wt.id)}
                title={plainRow ? wt.path : `${wt.branch}\n${wt.path}\nRight-click for open, pin, copy, merge, remove.`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-[13px] ${
                      selected ? "font-semibold text-ink-100" : "font-medium text-ink-200"
                    }`}
                  >
                    {wt.branch}
                    {!plainRow && wt.is_main && (
                      <span className="font-normal text-ink-500"> · main</span>
                    )}
                    {pinned[wt.id] && (
                      <span className="font-normal text-ink-500"> · pinned</span>
                    )}
                  </span>
                  {dirty > 0 ? (
                    <span className="tnum flex-none text-[11px] font-semibold" style={{ color: "var(--gm-amber)" }}>
                      {dirty}
                    </span>
                  ) : (
                    <span className="gm-meta tnum flex-none">clean</span>
                  )}
                </div>
                <div className="gm-meta mono mt-0.5 truncate" title={wt.path}>
                  {shortPath(wt.path, wt.is_main)}
                </div>
              </div>
            );
          })}

          {(() => {
            const fresh = freshDiscovered(gitRows, activePid);
            if (fresh.length === 0 || q) return null;
            const expanded = !!disExpanded[activePid];
            const noun = fresh.length === 1 ? "worktree" : "worktrees";
            const groups = discoveredGroups(fresh).slice(0, 5);
            const extra = Math.max(0, discoveredGroups(fresh).length - groups.length);
            return (
              <div className="mt-0.5 px-2.5 py-1">
                <div className="flex items-center gap-1">
                  <button
                    className="gm-tab flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                    data-active={false}
                    onClick={() => setDisExpanded((s) => (expanded ? delKey(s, activePid) : { ...s, [activePid]: true as const }))}
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
                  <button
                    className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-[var(--gm-hover)] hover:text-ink-200"
                    onClick={() => dismissDiscovered(activePid, gitRows)}
                    title="Keep hidden"
                    aria-label={`Keep ${fresh.length} discovered ${noun} hidden`}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </div>
                {expanded && (
                  <div className="mt-1">
                    {groups.map((g) => {
                      const gkey = `${activePid}::${g.path.toLowerCase()}`;
                      const gopen = !!disGroups[gkey];
                      const shown = gopen ? g.rows : g.rows.slice(0, 3);
                      return (
                        <div key={gkey} className="mt-1">
                          <div className="gm-meta mono truncate" title={g.path}>
                            {g.path} · {g.rows.length}
                          </div>
                          {shown.map((wt) => (
                            <div
                              key={wt.id}
                              role="button"
                              tabIndex={0}
                              className="gm-row cursor-pointer px-2 py-1.5"
                              onClick={() => setActiveWorktree(wt.id)}
                              onKeyDown={rowKey(() => setActiveWorktree(wt.id))}
                              onContextMenu={(e) => openMenu(e, wt.id)}
                              title={`${wt.branch}\n${wt.path}`}
                            >
                              <div className="truncate text-[12px] font-medium text-ink-300">
                                {wt.branch}
                              </div>
                            </div>
                          ))}
                          {g.rows.length > 3 && (
                            <button
                              className="gm-tab px-2 py-1"
                              data-active={false}
                              onClick={() => setDisGroups((s) => (gopen ? delKey(s, gkey) : { ...s, [gkey]: true as const }))}
                            >
                              {gopen ? "Show fewer" : `Show ${g.rows.length - 3} more`}
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {extra > 0 && (
                      <div className="gm-meta px-2 py-1">+ {extra} more locations</div>
                    )}
                    <div className="mt-1 flex items-center gap-2 px-2 py-1">
                      <button
                        className="font-semibold text-ink-100 hover:underline text-[12px]"
                        onClick={() => showDiscovered(activePid)}
                      >
                        Show in worktree list
                      </button>
                      <button
                        className="text-ink-400 hover:text-ink-200 text-[12px]"
                        onClick={() => dismissDiscovered(activePid, gitRows)}
                      >
                        Keep hidden
                      </button>
                    </div>
                    <div className="gm-meta px-2 pb-1">Change this later from the project menu.</div>
                  </div>
                )}
              </div>
            );
          })()}

          {shownLive.length === 0 && shownSettled.length === 0 && q && (
            <div className="px-2.5 py-4 text-center text-[12px] text-ink-400">
              No worktrees match.
            </div>
          )}

          {/* Other projects: collapsed to one labeled line each. Chevron
              expands; rows jump straight to that project's worktree. While
              filtering, every project with a match auto-expands. */}
          {!q && otherProjects.length > 0 && (
            <div
              className="mx-2.5 mb-1 mt-3"
              style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}
            />
          )}
          {!q && otherProjects.map((p) => {
            const all = otherRows(p);
            const rows = visibleRows(all, p.id);
            if (all.length === 0) return null;
            const open = !!projOpen[p.id];
            return (
              <div key={p.id} className="mt-0.5">
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  className="gm-row flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-2"
                  onClick={() => toggleProjOpen(p.id)}
                  onKeyDown={rowKey(() => toggleProjOpen(p.id))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    useStore.getState().setActiveProject(p.id);
                  }}
                  title={`${p.path}\nExpand to browse, right-click to switch.`}
                >
                  <ChevronRight
                    size={12}
                    strokeWidth={2}
                    className={`shrink-0 text-ink-500 transition-transform ${open ? "rotate-90" : ""}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-100">{p.name}</span>
                  <span className="tnum gm-meta flex-none">{rows.length}</span>
                </div>
                {!open ? null : (
                <>
                <div className="pb-0.5 pl-4">
                {rows.map((wt) => {
                  const selected = wt.id === activeWorktreeId;
                  const plainRow = wt.id.startsWith("plain:");
                  return (
                    <div
                      key={wt.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      data-selected={selected}
                      className="gm-row cursor-pointer px-2.5 py-2"
                      style={selected ? { boxShadow: "inset 2px 0 0 var(--gm-ink-mute)" } : undefined}
                      onClick={() => openProjectWorktree(p.id, wt.id)}
                      onKeyDown={rowKey(() => openProjectWorktree(p.id, wt.id))}
                      onContextMenu={(e) => openMenu(e, wt.id, p.id)}
                      title={plainRow ? wt.path : `${wt.branch}\n${wt.path}\nRight-click for open, pin, copy, merge, remove.`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-200">
                          {wt.branch}
                          {!plainRow && wt.is_main && (
                            <span className="font-normal text-ink-500"> · main</span>
                          )}
                          {pinned[wt.id] && (
                            <span className="font-normal text-ink-500"> · pinned</span>
                          )}
                        </span>
                      </div>
                      <div className="gm-meta mono mt-0.5 truncate" title={wt.path}>
                        {shortPath(wt.path, wt.is_main)}
                      </div>
                    </div>
                  );
                })}
                {(() => {
                  const fresh = freshDiscovered(all, p.id);
                  if (fresh.length === 0) return null;
                  const expanded = !!disExpanded[p.id];
                  const noun = fresh.length === 1 ? "worktree" : "worktrees";
                  const groups = discoveredGroups(fresh).slice(0, 5);
                  const extra = Math.max(0, discoveredGroups(fresh).length - groups.length);
                  return (
                    <div className="mt-0.5 px-2.5 py-1">
                      <div className="flex items-center gap-1">
                        <button
                          className="gm-tab flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                          data-active={false}
                          onClick={() => setDisExpanded((s) => (expanded ? delKey(s, p.id) : { ...s, [p.id]: true as const }))}
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
                        <button
                          className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-[var(--gm-hover)] hover:text-ink-200"
                          onClick={() => dismissDiscovered(p.id, all)}
                          title="Keep hidden"
                          aria-label={`Keep ${fresh.length} discovered ${noun} hidden`}
                        >
                          <X size={12} strokeWidth={2} />
                        </button>
                      </div>
                      {expanded && (
                        <div className="mt-1">
                          {groups.map((g) => {
                            const gkey = `${p.id}::${g.path.toLowerCase()}`;
                            const gopen = !!disGroups[gkey];
                            const shown = gopen ? g.rows : g.rows.slice(0, 3);
                            return (
                              <div key={gkey} className="mt-1">
                                <div className="gm-meta mono truncate" title={g.path}>
                                  {g.path} · {g.rows.length}
                                </div>
                                {shown.map((wt) => (
                                  <div
                                    key={wt.id}
                                    role="button"
                                    tabIndex={0}
                                    className="gm-row cursor-pointer px-2 py-1.5"
                                    onClick={() => openProjectWorktree(p.id, wt.id)}
                                    onKeyDown={rowKey(() => openProjectWorktree(p.id, wt.id))}
                                    onContextMenu={(e) => openMenu(e, wt.id, p.id)}
                                    title={`${wt.branch}\n${wt.path}`}
                                  >
                                    <div className="truncate text-[12px] font-medium text-ink-300">
                                      {wt.branch}
                                    </div>
                                  </div>
                                ))}
                                {g.rows.length > 3 && (
                                  <button
                                    className="gm-tab px-2 py-1"
                                    data-active={false}
                                    onClick={() => setDisGroups((s) => (gopen ? delKey(s, gkey) : { ...s, [gkey]: true as const }))}
                                  >
                                    {gopen ? "Show fewer" : `Show ${g.rows.length - 3} more`}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                          {extra > 0 && (
                            <div className="gm-meta px-2 py-1">+ {extra} more locations</div>
                          )}
                          <div className="mt-1 flex items-center gap-2 px-2 py-1">
                            <button
                              className="font-semibold text-ink-100 hover:underline text-[12px]"
                              onClick={() => showDiscovered(p.id)}
                            >
                              Show in worktree list
                            </button>
                            <button
                              className="text-ink-400 hover:text-ink-200 text-[12px]"
                              onClick={() => dismissDiscovered(p.id, all)}
                            >
                              Keep hidden
                            </button>
                          </div>
                          <div className="gm-meta px-2 pb-1">Change this later from the project menu.</div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                </div>
                </>
                )}
              </div>
            );
          })}

          {q && otherProjects.map((p) => {
            const all = otherRows(p);
            const rows = all.filter(matches);
            if (rows.length === 0) return null;
            return (
              <div key={p.id} className="mt-1">
                <div className="px-2.5 pb-0.5 pt-2 text-[12px] font-semibold text-ink-100" title={p.path}>
                  {p.name} <span className="tnum gm-meta font-normal">· {rows.length}</span>
                </div>
                {rows.map((wt) => (
                  <div
                    key={wt.id}
                    role="button"
                    tabIndex={0}
                    className="gm-row cursor-pointer px-2.5 py-2"
                    onClick={() => openProjectWorktree(p.id, wt.id)}
                    onKeyDown={rowKey(() => openProjectWorktree(p.id, wt.id))}
                    onContextMenu={(e) => openMenu(e, wt.id, p.id)}
                    title={`${wt.branch}\n${wt.path}`}
                  >
                    <div className="truncate text-[13px] font-medium text-ink-200">{wt.branch}</div>
                    <div className="gm-meta mono mt-0.5 truncate" title={wt.path}>
                      {shortPath(wt.path, wt.is_main)}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          {shownSettled.length > 0 && (
            <div className="mt-1">
              <button
                className="gm-tab flex w-full items-center gap-1.5 px-2.5 py-2"
                data-active={false}
                onClick={() => setSettledOpen((o) => !o)}
                aria-expanded={settledOpen}
                title="Worktrees quiet for over 48 hours"
              >
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className={`shrink-0 transition-transform ${settledOpen ? "rotate-90" : ""}`}
                />
                <span className="tnum">
                  Sleeping · {shownSettled.length}
                </span>
              </button>
              {settledOpen &&
                shownSettled.map((wt) => (
                  <div
                    key={wt.id}
                    role="button"
                    tabIndex={0}
                    className="gm-row cursor-pointer px-2.5 py-2 opacity-60 hover:opacity-100"
                    onClick={() => revive(wt.id)}
                    onKeyDown={rowKey(() => revive(wt.id))}
                    onContextMenu={(e) => openMenu(e, wt.id)}
                    title={`${wt.branch}\n${wt.path}\nQuiet over 48h — click to make active again.`}
                  >
                    <div className="truncate text-[12.5px] font-medium text-ink-300">
                      {wt.branch}
                      {pinned[wt.id] && (
                        <span className="font-normal text-ink-500"> · pinned</span>
                      )}
                    </div>
                    <div className="gm-meta mono mt-0.5 truncate">
                      {shortPath(wt.path, false)}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {isGit && activeWt && (
            <div className="px-2.5 pb-1 pt-1 text-[12.5px] font-semibold text-ink-100">
              {activeWt.branch}{" "}
              <span className="font-normal text-ink-500">
                {activeStatuses.length === 0
                  ? "is clean."
                  : `has ${activeStatuses.length} changed ${activeStatuses.length === 1 ? "file" : "files"}.`}
              </span>
            </div>
          )}
          {isGit &&
            activeStatuses.map((s) => {
              const g = statusLetter(s);
              return (
                <div
                  key={s.path}
                  role="button"
                  tabIndex={0}
                  className="gm-row flex cursor-pointer items-baseline gap-2 px-2.5 py-[5px]"
                  onClick={() => openEditor(`${activeWt!.path}/${s.path}`, true)}
                  onKeyDown={rowKey(() => openEditor(`${activeWt!.path}/${s.path}`, true))}
                  title={`${s.path} (${g.label})`}
                >
                  <span
                    className="mono w-3 flex-none text-center text-[11px] font-bold"
                    style={{ color: g.color }}
                    aria-hidden
                  >
                    {g.letter}
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[12px] text-ink-200">{s.path}</span>
                </div>
              );
            })}
        </div>
      )}

      {/* footer: new worktree is a quiet line in the panel, not a box */}
      {tab === "worktrees" && isGit && (
        <div className="px-4 pb-3">
          {creating ? (
            <div
              className="rounded-lg p-3"
              style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--gm-hairline-soft)" }}
            >
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] font-semibold text-ink-100">New worktree</span>
                <button
                  className="rounded-md p-1 text-ink-400 hover:bg-[var(--gm-hover)] hover:text-ink-200"
                  onClick={() => setCreating(false)}
                  title="Close"
                  aria-label="Close"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
              <label htmlFor="gm-wt-name" className="gm-meta mt-2 block text-[11px]">
                Branch name
              </label>
              <input
                id="gm-wt-name"
                autoFocus
                className="mono mt-1 w-full rounded-md bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none placeholder:text-ink-500"
                style={{ border: "1px solid var(--gm-hairline)" }}
                placeholder="feature/my-change (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                  if (e.key === "Escape") setCreating(false);
                }}
              />
              <label htmlFor="gm-wt-base" className="gm-meta mt-2.5 block text-[11px]">
                Start from
              </label>
              <div className="relative mt-1">
                <GitBranch size={13} strokeWidth={2} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
                <input
                  id="gm-wt-base"
                  className="mono w-full rounded-md bg-ink-950 py-1.5 pl-8 pr-7 text-[12px] text-ink-100 outline-none placeholder:text-ink-500"
                  style={{ border: "1px solid var(--gm-hairline)" }}
                  placeholder="Current HEAD"
                  value={base}
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={baseOpen}
                  aria-controls="gm-base-menu"
                  onChange={(e) => { setBase(e.target.value); setBaseOpen(true); }}
                  onFocus={() => setBaseOpen(true)}
                  onBlur={() => setTimeout(() => setBaseOpen(false), 120)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") create();
                    if (e.key === "Escape") {
                      if (baseOpen) setBaseOpen(false);
                      else setCreating(false);
                    }
                    if (e.key === "ArrowDown" && !baseOpen) setBaseOpen(true);
                  }}
                />
                {base && (
                  <button
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-400 hover:bg-[var(--gm-hover)] hover:text-ink-200"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setBase("")}
                    title="Use current HEAD"
                    aria-label="Clear start point"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                )}
                {baseOpen && (
                  <div id="gm-base-menu" role="listbox" className="gm-menu absolute bottom-full left-0 right-0 z-30 mb-1 max-h-48 overflow-y-auto">
                    <button
                      role="option"
                      aria-selected={!base.trim()}
                      className="gm-menu-item mono gap-2 text-[12px]"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setBase(""); setBaseOpen(false); }}
                    >
                      <span className="flex-1 text-left">Current HEAD</span>
                      {!base.trim() && <Check size={12} strokeWidth={2} className="shrink-0 text-ink-400" />}
                    </button>
                    {baseOptions.map((b) => (
                      <button
                        key={b}
                        role="option"
                        aria-selected={base === b}
                        className="gm-menu-item mono gap-2 text-[12px]"
                        title={b}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setBase(b); setBaseOpen(false); }}
                      >
                        <span className="min-w-0 flex-1 truncate text-left">{b}</span>
                        {base === b && <Check size={12} strokeWidth={2} className="shrink-0 text-ink-400" />}
                      </button>
                    ))}
                    {base.trim() && baseOptions.length === 0 && (
                      <div className="px-3 py-2 text-[11.5px] text-ink-400">No match — Enter uses it as-is.</div>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  className="flex-1 rounded-md px-3 py-1.5 text-[12px] font-semibold"
                  style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
                  onClick={create}
                >
                  Create worktree
                </button>
                <button
                  className="rounded-md px-2 py-1.5 text-[12px] font-medium text-ink-400 hover:text-ink-200"
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="w-full pt-2 text-left text-[12px] font-medium text-ink-500 hover:text-ink-100"
              onClick={() => void openCreate()}
            >
              + New worktree
            </button>
          )}
        </div>
      )}

      {/* row context menu: words only — open, pin, copy, merge, remove */}
      {menu && menuWt && (
        <div
          className="gm-menu tnum fixed z-50 w-48"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 260),
          }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            className="gm-menu-item"
            onClick={() => {
              const st = useStore.getState();
              if (menu.projectId && menu.projectId !== st.activeProjectId) {
                st.openProjectWorktree(menu.projectId, menuWt.id);
              } else {
                st.setActiveWorktree(menuWt.id);
              }
              setMenu(null);
            }}
            role="menuitem"
          >
            Open worktree
          </button>
          <button
            className="gm-menu-item"
            onClick={() => {
              togglePin(menuWt.id);
              setMenu(null);
            }}
            role="menuitem"
          >
            {pinned[menuWt.id] ? "Unpin" : "Pin to top"}
          </button>
          <button
            className="gm-menu-item"
            onClick={() => {
              void copyPath(menuWt.path);
              setMenu(null);
            }}
            role="menuitem"
          >
            Copy path
          </button>
          {!menuWt.is_main && !menuWt.id.startsWith("plain:") && (
            <>
              <button
                className="gm-menu-item"
                onClick={() => {
                  const pid = menu.projectId;
                  setMenu(null);
                  merge(menuWt, pid);
                }}
                role="menuitem"
              >
                Merge into base
              </button>
              <button
                className="gm-menu-item"
                onClick={() => {
                  const pid = menu.projectId;
                  setMenu(null);
                  abortMerge(menuWt, pid);
                }}
                role="menuitem"
              >
                Abort merge
              </button>
              <button
                className="gm-menu-item"
                onClick={() => {
                  const pid = menu.projectId;
                  setMenu(null);
                  remove(menuWt, pid);
                }}
                role="menuitem"
              >
                Remove worktree
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
