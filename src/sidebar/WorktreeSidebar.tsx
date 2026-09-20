import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Search, X } from "lucide-react";
// Ledger sidebar: typographic rows, no status dots. Status reads as words
// ("3", "clean", "…"), actions sit behind the row's own menu button and the
// right-click menu. Rows come from WorktreeRow, so every list (active, other
// projects, discovered, sleeping) shares one shape.
import { useStore } from "../store";
import { detectToProject } from "../project";
import { createSingleFlight } from "../singleFlight";
import { PREF, flagMap, numIn, readPref, stringArrayMap, writePref } from "../uiPrefs";
import { DiscoveredBlock } from "./DiscoveredBlock";
import { CreateWorktreeForm } from "./CreateWorktreeForm";
import { RowMenu, type MenuItem } from "./RowMenu";
import { WorktreeRow } from "./WorktreeRow";
import { parseRemoveGuard } from "./removeGuard";
import { statusLetter } from "./statusLetter";
import { useWorktreeStatuses } from "./useWorktreeStatuses";
import { confirmDialog, errorDialog } from "../dialogs";
import type { Project, Worktree } from "../types";

// One listing at a time: two in-flight `worktree_list` calls race to write the
// same store slice, and the loser is whichever finished last.
const listGuard = createSingleFlight();

// Row menu box (six items at most), used to keep it inside the viewport.
const ROW_MENU_SIZE = { w: 192, h: 214 };

interface MenuState {
  x: number;
  y: number;
  wt: Worktree;
  /** Owned by the row's project; undefined for the active project. */
  pid?: string;
}

export function WorktreeSidebar() {
  // Slices, not the whole store: a bare useStore() re-rendered this panel on
  // every keystroke-driven markPaneDirty anywhere in the app.
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const repoRoot = useStore((s) => s.repoRoot);
  const worktrees = useStore((s) => s.worktrees);
  const worktreesByProject = useStore((s) => s.worktreesByProject);
  const layouts = useStore((s) => s.layouts);
  const activeWorktreeId = useStore((s) => s.activeWorktreeId);
  const setActiveWorktree = useStore((s) => s.setActiveWorktree);
  const openProjectWorktree = useStore((s) => s.openProjectWorktree);
  const setWorktrees = useStore((s) => s.setWorktrees);
  const updateProject = useStore((s) => s.updateProject);
  const openEditor = useStore((s) => s.openEditor);

  // Unvisited projects have no cached list yet: fill them in once per repo
  // root so every project shows rows. Writes go through setProjectWorktrees
  // (cache only), never the live list.
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
          const before = useStore.getState().worktrees;
          const wts: Worktree[] = await invoke("worktree_list", { repoRoot: root });
          if (cancelled || !wts.length) continue;
          const st = useStore.getState();
          // This fetch can outlive a create/remove and would then replace a
          // newer list with an older one. The store swaps the array on every
          // write, so identity is the "untouched since I started" test.
          if (st.activeProjectId === p.id) {
            if (st.worktrees === before) st.setWorktrees(wts);
          } else {
            st.setProjectWorktrees(p.id, wts);
          }
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
  const [branches, setBranches] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [tab, setTab] = useState<"worktrees" | "changes">("worktrees");
  const [settledOpen, setSettledOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Other projects start collapsed: one line each until opened. Active project
  // is always expanded. Persisted so the list stays calm.
  const [projOpen, setProjOpen] = useState<Record<string, true>>(() =>
    readPref<Record<string, true>>(PREF.expandedProjects, {}, flagMap),
  );
  const toggleProjOpen = (pid: string) => {
    setProjOpen((c) => {
      const next = { ...c };
      if (next[pid]) delete next[pid];
      else next[pid] = true as const;
      writePref(PREF.expandedProjects, next);
      return next;
    });
  };
  const [pinned, setPinned] = useState<Record<string, true>>(() =>
    readPref<Record<string, true>>(PREF.pinnedWorktrees, {}, flagMap),
  );
  const togglePin = (id: string) => {
    setPinned((p) => {
      const next = { ...p };
      if (next[id]) delete next[id];
      else next[id] = true as const;
      writePref(PREF.pinnedWorktrees, next);
      return next;
    });
  };
  const [revived, setRevived] = useState<Record<string, true>>(() =>
    readPref<Record<string, true>>(PREF.revivedWorktrees, {}, flagMap),
  );
  // ponytail: inactivity = last commit age only (no fs mtime/terminal polling).
  // Upgrade path: backend `inactive_since` covering mtime + dirty + pty recency.
  const SETTLE_AFTER_S = 48 * 3600;
  const revive = (id: string) => {
    setRevived((r) => {
      const next = { ...r, [id]: true as const };
      writePref(PREF.revivedWorktrees, next);
      return next;
    });
    setActiveWorktree(id);
  };

  const [width, setWidth] = useState(() => readPref(PREF.sidebarWidth, 240, numIn(180, 480)));
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
      writePref(PREF.sidebarWidth, Math.round(widthRef.current));
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, []);

  const proj: Project | null = projects.find((p) => p.id === activeProjectId) ?? null;
  const isGit = proj?.isGit ?? false;
  const isPlain = proj ? !proj.isGit : false;
  // Must run before any conditional return and after isGit exists: `empty` is
  // not `clean`, so the panel needs to know whether status has landed.
  const { statuses, loaded: statusLoaded } = useWorktreeStatuses(repoRoot, isGit);

  // `immediate` skips the deferral below: explicit user actions (create,
  // merge, remove) are not racing App's loader and should not wait 1.5s to
  // reconcile. One listing at a time, so a create+remove pair cannot interleave.
  const refreshList = async (immediate = false) => {
    if (!repoRoot || !isGit) return;
    // Skip while App's loader owns this repoRoot: App always lists right
    // after it sets repoRoot, so a sidebar re-list here doubles the spawns
    // on every project switch (and on startup).
    if (!immediate) await new Promise((r) => setTimeout(r, 1500));
    if (useStore.getState().repoRoot !== repoRoot) return;
    await listGuard.run(async () => {
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
    });
  };

  useEffect(() => {
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, isGit]);

  // Click anywhere or Escape dismisses the row menu.
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

  const create = async (values: { name: string; base: string }) => {
    if (!repoRoot || !isGit) return;
    setCreating(false);
    // Optimistic progress row: the form closes at once and creation runs
    // underneath while the user keeps working.
    setPending(values.name || "worktree");
    try {
      const created: Worktree = await invoke("worktree_create", {
        repoRoot,
        name: values.name || null,
        base: values.base || null,
      });
      // Mount the new shell at once; the re-list below reconciles in background.
      setWorktrees([...useStore.getState().worktrees, created]);
      setActiveWorktree(created.id);
      await refreshList(true);
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
      updateProject(proj.id, { isGit: true, gitRoot: re.gitRoot, branch: re.branch });
    } catch (e) {
      void errorDialog(`git init failed: ${e}`);
    }
  };

  // pid scopes the git call to the row's own project; the active project
  // passes nothing and falls back to the live repo root.
  const remove = async (wt: Worktree, pid?: string) => {
    if (!(await confirmDialog(`Remove worktree "${wt.branch}"? The directory and its branch are deleted.`)))
      return;
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
        await refreshList(true);
      }
    };
    try {
      await runRemove(false);
    } catch (e) {
      // The backend refuses to discard real work and names what is at stake:
      // uncommitted changes, unmerged commits, or both. Anything else is an
      // ordinary failure — never escalate it into a destructive retry.
      const guard = parseRemoveGuard(e);
      if (!guard) {
        void errorDialog(`remove failed: ${e}`);
        return;
      }
      if (!(await confirmDialog(`${wt.branch} ${guard.summary}. Remove it anyway and discard that work?`)))
        return;
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
        await refreshList(true);
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
        await refreshList(true);
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

  const activeWt = worktrees.find((w) => w.id === activeWorktreeId);
  const activeStatuses = activeWt ? statuses[activeWt.id] ?? [] : [];
  const totalDirty = Object.values(statuses).reduce((a, l) => a + l.length, 0);
  const nowS = Math.floor(Date.now() / 1000);
  const isStale = (wt: Worktree) =>
    !wt.id.startsWith("plain:") &&
    !wt.is_main &&
    wt.id !== activeWorktreeId &&
    !revived[wt.id] &&
    // Known-empty only: an unread row is not evidence of a quiet worktree.
    statuses[wt.id]?.length === 0 &&
    wt.last_commit != null &&
    nowS - wt.last_commit > SETTLE_AFTER_S;

  const q = query.trim().toLowerCase();
  const matches = (wt: Worktree) =>
    !q || wt.branch.toLowerCase().includes(q) || wt.path.toLowerCase().includes(q);
  // Discovered rows are worktrees git knows that guimux never created: no
  // layout (never opened as a session), no guimux/ branch, not main.
  // One collapsed line per project, expanding to a preview grouped by parent
  // path; a persisted dismiss baseline keeps the line down until new ones
  // arrive, and the filter still searches everything.
  const isDiscovered = (wt: Worktree) =>
    !wt.is_main && !wt.id.startsWith("plain:") && !layouts[wt.id] && !wt.branch.startsWith("guimux/");
  const [showAll, setShowAll] = useState<Record<string, true>>({});
  const [disExpanded, setDisExpanded] = useState<Record<string, true>>({});
  const [disGroups, setDisGroups] = useState<Record<string, true>>({});
  const [disBaseline, setDisBaseline] = useState<Record<string, string[]>>(() =>
    readPref<Record<string, string[]>>(PREF.discoveredBaseline, {}, stringArrayMap),
  );
  const saveBaseline = (next: Record<string, string[]>) => {
    setDisBaseline(next);
    writePref(PREF.discoveredBaseline, next);
  };
  const delKey = (s: Record<string, true>, key: string) => {
    const next = { ...s };
    delete next[key];
    return next;
  };
  const toggle = (
    set: React.Dispatch<React.SetStateAction<Record<string, true>>>,
    key: string,
    open: boolean,
  ) => set((cur) => (open ? delKey(cur, key) : { ...cur, [key]: true as const }));
  const markHidden = (pid: string, rows: Worktree[]) => {
    const base = new Set(disBaseline[pid] ?? []);
    for (const wt of rows) if (isDiscovered(wt)) base.add(wt.id);
    saveBaseline({ ...disBaseline, [pid]: [...base] });
  };
  const freshDiscovered = (rows: Worktree[], pid: string) => {
    const base = new Set(disBaseline[pid] ?? []);
    return rows.filter((wt) => isDiscovered(wt) && !base.has(wt.id));
  };
  // Showing them resolves the announcement too: the line counts rows the user
  // has not answered, so it must not outlive the answer.
  const showDiscovered = (pid: string, rows: Worktree[]) => {
    markHidden(pid, rows);
    setShowAll((s) => ({ ...s, [pid]: true as const }));
    setDisExpanded((s) => delKey(s, pid));
  };
  const dismissDiscovered = (pid: string, rows: Worktree[]) => {
    markHidden(pid, rows);
    setDisExpanded((s) => delKey(s, pid));
  };
  /** Rows to announce for a project: none while they are all on screen. */
  const toAnnounce = (rows: Worktree[], pid: string) =>
    showAll[pid] ? [] : freshDiscovered(rows, pid);
  const visibleRows = (rows: Worktree[], pid: string) => {
    // Filtering searches everything, discovered included: a collapsed line
    // must never hide a match. Idle view shows sessions + guimux branches.
    if (q) return rows.filter(matches);
    if (showAll[pid]) return rows;
    return rows.filter((wt) => !isDiscovered(wt));
  };

  const gitRows = worktrees.filter((wt) => (isGit ? !wt.id.startsWith("plain:") : true));
  const settled = gitRows.filter(isStale).filter(matches);
  const live = gitRows
    .filter((wt) => !isStale(wt))
    .filter(matches)
    // Pinned worktrees stay at the top of the project.
    .sort((a, b) => Number(!!pinned[b.id]) - Number(!!pinned[a.id]));
  const activePid = activeProjectId ?? "";
  const shownLive = visibleRows(live, activePid);
  const shownSettled = visibleRows(settled, activePid);
  // Every other project, below the active one: project name, then its cached
  // worktrees. Plain folders have no worktrees, so they show one shell row.
  const otherProjects = projects.filter((p) => p.id !== activeProjectId);
  const otherRows = (p: Project) => {
    if (!p.isGit)
      return [{ id: `plain:${p.id}`, path: p.path, branch: p.name, is_main: true } as Worktree];
    return worktreesByProject[p.id] ?? [];
  };

  const menuItems = (wt: Worktree, pid?: string): MenuItem[] => {
    const st = useStore.getState();
    const items: MenuItem[] = [
      {
        label: "Open worktree",
        onSelect: () =>
          pid && pid !== st.activeProjectId
            ? st.openProjectWorktree(pid, wt.id)
            : st.setActiveWorktree(wt.id),
      },
      { label: pinned[wt.id] ? "Unpin" : "Pin to top", onSelect: () => togglePin(wt.id) },
      { label: "Copy path", onSelect: () => void copyPath(wt.path) },
    ];
    if (!wt.is_main && !wt.id.startsWith("plain:")) {
      items.push(
        { label: "Merge into base", onSelect: () => void merge(wt, pid) },
        { label: "Abort merge", onSelect: () => void abortMerge(wt, pid) },
        { label: "Remove worktree", onSelect: () => void remove(wt, pid) },
      );
    }
    return items;
  };

  /** Shared wiring for every row in the panel. */
  const row = (wt: Worktree, pid?: string) => (
    <WorktreeRow
      key={wt.id}
      wt={wt}
      selected={wt.id === activeWorktreeId}
      pinned={!!pinned[wt.id]}
      // Other projects' status is never read here: omit the cluster rather
      // than claim anything about rows we have not looked at.
      status={pid ? undefined : statuses[wt.id] ?? null}
      onOpen={() => (pid ? openProjectWorktree(pid, wt.id) : setActiveWorktree(wt.id))}
      onMenu={(at) => setMenu({ ...at, wt, pid })}
    />
  );

  const discoveredRow = (wt: Worktree, pid?: string) => (
    <WorktreeRow
      key={wt.id}
      wt={wt}
      compact
      selected={wt.id === activeWorktreeId}
      onOpen={() => (pid ? openProjectWorktree(pid, wt.id) : setActiveWorktree(wt.id))}
      onMenu={(at) => setMenu({ ...at, wt, pid })}
    />
  );

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
          writePref(PREF.sidebarWidth, 240);
        }}
        title="Drag to resize, double-click to reset"
      >
        <div
          className="mx-auto h-full w-[3px] rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: "var(--gm-ink-mute)" }}
        />
      </div>

      {/* header: the panel's only heading, plus its total */}
      <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
        <span className="gm-sect">Worktrees</span>
        {isGit && <span className="tnum gm-meta">{live.length + settled.length}</span>}
      </div>

      {/* filter: underline, not a box */}
      <div className="mx-4 flex items-center gap-1.5" style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}>
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
            className="gm-icon-btn gm-icon-btn--sm"
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
        <button className="gm-tab" data-active={tab === "worktrees"} onClick={() => setTab("worktrees")}>
          Worktrees
        </button>
        {isGit && (
          <button className="gm-tab tnum" data-active={tab === "changes"} onClick={() => setTab("changes")}>
            Changes{totalDirty > 0 ? ` · ${totalDirty}` : ""}
          </button>
        )}
      </div>

      {tab === "worktrees" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {!proj && (
            <div className="px-3 py-8 text-center">
              <div className="text-[12px] text-ink-300">No projects yet.</div>
              <div className="gm-meta mt-1">Open a folder or repository from the switcher above.</div>
            </div>
          )}

          {isPlain && (
            <div className="px-1 py-1 text-[12px] leading-5 text-ink-300">
              Terminals and files work now; worktrees appear after init.{" "}
              <button className="font-semibold text-ink-100 hover:underline" onClick={initGit}>
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
            <div className="flex items-baseline justify-between px-2.5 pb-1 pt-2" title={proj.path}>
              <span className="truncate text-[12px] font-semibold text-ink-100">{proj.name}</span>
              <span className="tnum gm-meta flex-none">{shownLive.length}</span>
            </div>
          )}

          {shownLive.map((wt) => row(wt))}

          {isGit && (
            <DiscoveredBlock
              // A search goes through every row, so the line has nothing to
              // announce while one is active.
              fresh={q ? [] : toAnnounce(gitRows, activePid)}
              expanded={!!disExpanded[activePid]}
              onToggle={() => toggle(setDisExpanded, activePid, !!disExpanded[activePid])}
              onKeepHidden={() => dismissDiscovered(activePid, gitRows)}
              onShowInList={() => showDiscovered(activePid, gitRows)}
              groups={disGroups}
              onToggleGroup={(key) => toggle(setDisGroups, key, !!disGroups[key])}
              groupKey={(dir) => `${activePid}::${dir.toLowerCase()}`}
              renderRow={(wt) => discoveredRow(wt)}
            />
          )}

          {q && shownLive.length === 0 && shownSettled.length === 0 && (
            <div className="px-2.5 py-4 text-center text-[12px] text-ink-400">No worktrees match.</div>
          )}
          {isGit && !q && shownLive.length === 0 && (
            <div className="gm-meta px-2.5 py-3 leading-5">
              No worktrees yet — create one below, or pull a branch in with git.
            </div>
          )}

          {/* Other projects: one labeled line each. Chevron expands; rows jump
              straight to that project's worktree. */}
          {!q && otherProjects.length > 0 && (
            <div className="mx-2.5 mb-1 mt-3" style={{ borderTop: "1px solid var(--gm-hairline-soft)" }} />
          )}
          {!q &&
            otherProjects.map((p) => {
              const all = otherRows(p);
              if (all.length === 0) return null;
              const rows = visibleRows(all, p.id);
              const open = !!projOpen[p.id];
              return (
                <div key={p.id} className="mt-0.5">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    className="gm-row flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-2"
                    onClick={() => toggleProjOpen(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleProjOpen(p.id);
                      }
                    }}
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
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-100">
                      {p.name}
                    </span>
                    <span className="tnum gm-meta flex-none">{rows.length}</span>
                  </div>
                  {open && (
                    <div className="pb-0.5 pl-4">
                      {rows.map((wt) => row(wt, p.id))}
                      <DiscoveredBlock
                        fresh={q ? [] : toAnnounce(all, p.id)}
                        expanded={!!disExpanded[p.id]}
                        onToggle={() => toggle(setDisExpanded, p.id, !!disExpanded[p.id])}
                        onKeepHidden={() => dismissDiscovered(p.id, all)}
                        onShowInList={() => showDiscovered(p.id, all)}
                        groups={disGroups}
                        onToggleGroup={(key) => toggle(setDisGroups, key, !!disGroups[key])}
                        groupKey={(dir) => `${p.id}::${dir.toLowerCase()}`}
                        renderRow={(wt) => discoveredRow(wt, p.id)}
                      />
                    </div>
                  )}
                </div>
              );
            })}

          {q &&
            otherProjects.map((p) => {
              const rows = otherRows(p).filter(matches);
              if (rows.length === 0) return null;
              return (
                <div key={p.id} className="mt-1">
                  <div className="px-2.5 pb-0.5 pt-2 text-[12px] font-semibold text-ink-100" title={p.path}>
                    {p.name} <span className="tnum gm-meta font-normal">· {rows.length}</span>
                  </div>
                  {rows.map((wt) => row(wt, p.id))}
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
                <span className="tnum">Sleeping · {shownSettled.length}</span>
              </button>
              {settledOpen &&
                shownSettled.map((wt) => (
                  <div key={wt.id} title="Quiet over 48h — click to make active again">
                    <WorktreeRow
                      wt={wt}
                      dim
                      pinned={!!pinned[wt.id]}
                      onOpen={() => revive(wt.id)}
                      onMenu={(at) => setMenu({ ...at, wt })}
                    />
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
                {!statusLoaded
                  ? "· reading status…"
                  : activeStatuses.length === 0
                    ? "is clean."
                    : `has ${activeStatuses.length} changed ${activeStatuses.length === 1 ? "file" : "files"}.`}
              </span>
            </div>
          )}
          {isGit && !activeWt && <div className="gm-meta px-2.5 py-2">No active worktree.</div>}
          {isGit &&
            activeStatuses.map((s) => {
              const g = statusLetter(s);
              const open = () => openEditor(`${activeWt!.path}/${s.path}`, true);
              return (
                <div
                  key={s.path}
                  role="button"
                  tabIndex={0}
                  className="gm-row flex cursor-pointer items-baseline gap-2 px-2.5 py-[5px]"
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open();
                    }
                  }}
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
            <CreateWorktreeForm
              branches={branches}
              onSubmit={create}
              onCancel={() => setCreating(false)}
            />
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

      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          size={ROW_MENU_SIZE}
          items={menuItems(menu.wt, menu.pid)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
