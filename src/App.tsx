import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Columns2,
  Rows2,
  Radio,
  GitBranch,
  Search,
  FolderOpen,
  Folder,
  X,
  Plus,
  ChevronDown,
  CircleDot,
  House as HomeIcon,
  Settings as SettingsIcon,
  Bot,
  PanelLeft,
  PanelRight,
} from "lucide-react";
import { useStore } from "./store";
import { WindowControls } from "./chrome/WindowControls";
import { loadPersisted, savePersisted } from "./persist";
import { SplitView } from "./terminal/SplitView";
import { WorktreeSidebar } from "./sidebar/WorktreeSidebar";
import { ExplorerPane } from "./explorer/ExplorerPane";
import { Palette } from "./palette/Palette";
import { SettingsPanel } from "./settings/SettingsPanel";
import { AgentLauncher } from "./agents/AgentLauncher";
import type { Project, Worktree } from "./types";

import { detectToProject } from "./project";
import { maybeStartStress } from "./terminal/stress";
export { detectToProject };

/* ------------------------------------------------------------------ */
/* Topbar: a treated workbench rail. Project switcher + worktree       */
/* breadcrumb + session controls. One palette, one accent, Inter only. */
/* ------------------------------------------------------------------ */

function Topbar({ onAdd }: { onAdd: () => void }) {
  const {
    projects,
    activeProjectId,
    setActiveProject,
    removeProject,
    worktrees,
    activeWorktreeId,
    setActiveWorktree,
    broadcast,
    toggleBroadcast,
    setPaletteOpen,
    setSettingsOpen,
    setAgentOpen,
    leftVisible,
    toggleLeft,
    rightVisible,
    toggleRight,
  } = useStore();
  const proj = projects.find((p) => p.id === activeProjectId) ?? null;
  const wt = worktrees.find((w) => w.id === activeWorktreeId);
  const [projOpen, setProjOpen] = useState(false);
  const [wtOpen, setWtOpen] = useState(false);

  // Escape + pointer-down-outside close whichever dropdown is open.
  // pointerdown (not click): a real click-outside that works even when the
  // click itself is swallowed, and it closes before the row's click fires.
  useEffect(() => {
    if (!projOpen && !wtOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setProjOpen(false);
        setWtOpen(false);
      }
    };
    // mousedown (not pointerdown): synthetic PointerEvents dispatched via
    // JS do not trigger real pointerdown listeners in this WebView, but
    // real mousedown always fires for real clicks, so gate on that.
    const onDown = (e: MouseEvent) => {
      // The click-outside overlay covers the screen but lives INSIDE the
      // menu root, so exempt it: a press on it is definitionally outside.
      const t = e.target as HTMLElement;
      if (t.closest("[data-menu-root]") && !t.closest("[data-outside]")) return;
      setProjOpen(false);
      setWtOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [projOpen, wtOpen]);

  // Drag must ignore anything clickable: on Windows a native drag started on
  // mousedown swallows the follow-up click, which bricked every dropdown row
  // and click-outside overlay in this bar (they are divs, not <button>s).
  const noDrag = (t: HTMLElement) =>
    !!t.closest("button, [role='button'], input, textarea, a, [data-no-drag]");
  // Drag on mousemove-after-press (real gesture), never on bare mousedown:
  // Windows treats startDragging like a native caption drag and swallows the
  // click that follows, which bricked every dropdown in this bar (the click
  // that opens the menu never fires its onClick after a drag starts, and the
  // same swallowed-click bricks rows and the click-outside overlay).
  const onBarDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || noDrag(e.target as HTMLElement)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const move = (ev: MouseEvent) => {
      if (dragging) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      dragging = true;
      cleanup();
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow().startDragging().catch(() => {});
      }).catch(() => {});
    };
    const up = () => cleanup();
    const cleanup = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const onBarDouble = (e: React.MouseEvent) => {
    if (noDrag(e.target as HTMLElement)) return;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().toggleMaximize().catch(() => {});
    }).catch(() => {});
  };

  return (
    <div
      data-tauri-drag-region
      onMouseDown={onBarDown}
      onDoubleClick={onBarDouble}
      className="flex h-11 shrink-0 select-none items-center gap-1 border-b bg-ink-900 pl-3 pr-0"
      style={{ borderColor: "var(--gm-hairline)" }}
    >
      {/* wordmark: bare type, no tile, no gradient */}
      <span
        className="mr-1 select-none text-[13px] font-semibold tracking-tight text-ink-100"
        style={{ letterSpacing: "-0.02em" }}
      >
        guimux
      </span>
      <span className="mr-2 h-4 w-px" style={{ background: "var(--gm-hairline)" }} />

      {/* project switcher */}
      <div className="relative" data-menu-root style={{ zIndex: projOpen ? 50 : undefined }}>
        <button
          className="flex max-w-[260px] items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] font-medium text-ink-200 hover:bg-white/[0.04]"
          onClick={() => setProjOpen(!projOpen)}
          title={proj?.path ?? "No project open"}
          aria-haspopup="menu"
          aria-expanded={projOpen}
        >
          {proj?.isGit ? (
            <GitBranch size={13} className="shrink-0 text-accent-500" strokeWidth={2.2} />
          ) : (
            <Folder size={13} className="shrink-0 text-ink-400" strokeWidth={2.2} />
          )}
          <span className="truncate">{proj ? proj.name : "No project"}</span>
          {!proj?.isGit && proj && (
            <span className="tnum shrink-0 text-[11px] font-medium text-ink-400">
              local
            </span>
          )}
          <ChevronDown size={12} className="shrink-0 text-ink-400" />
        </button>
        {projOpen && (
          <>
            <div className="fixed inset-0 z-30" data-no-drag data-outside />
            <div
              className="absolute left-0 top-9 z-40 w-80 overflow-hidden rounded-lg py-1 shadow-pop"
              style={{
                background: "var(--gm-overlay)",
                border: "1px solid var(--gm-hairline)",
              }}
            >
              <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-ink-400">
                Projects
              </div>
              {projects.map((p) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  className={`group flex cursor-pointer items-center gap-2.5 px-3 py-2 ${
                    p.id === activeProjectId ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
                  }`}
                  onClick={() => {
                    setActiveProject(p.id);
                    setProjOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveProject(p.id);
                      setProjOpen(false);
                    }
                  }}
                >
                  {p.isGit ? (
                    <GitBranch
                      size={13}
                      className={`shrink-0 ${p.id === activeProjectId ? "text-accent-500" : "text-ink-400"}`}
                    />
                  ) : (
                    <Folder size={13} className="shrink-0 text-ink-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-[12.5px] font-medium ${
                        p.id === activeProjectId ? "text-ink-100" : "text-ink-200"
                      }`}
                    >
                      {p.name}
                    </div>
                    <div className="truncate text-[11px] text-ink-400">{p.path}</div>
                  </div>
                  {p.id === activeProjectId && (
                    <CircleDot size={12} className="shrink-0 text-accent-500" />
                  )}
                  <button
                    title="Remove project"
                    className="hidden shrink-0 rounded p-1 text-ink-400 hover:bg-white/[0.06] hover:text-clay-400 group-hover:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeProject(p.id);
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button
                className="mt-1 flex w-full items-center gap-2 px-3 py-2.5 text-[12.5px] font-medium text-ink-300 hover:bg-white/[0.03] hover:text-ink-100"
                style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}
                onClick={() => {
                  setProjOpen(false);
                  onAdd();
                }}
              >
                <Plus size={13} className="text-accent-500" /> Open folder or repository
              </button>
            </div>
          </>
        )}
      </div>

      {/* worktree breadcrumb */}
      {proj?.isGit && wt && (
        <>
          <span className="px-0.5 text-[12px] text-ink-400">/</span>
          <div className="relative" data-menu-root style={{ zIndex: wtOpen ? 50 : undefined }}>
            <button
              className="flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
              onClick={() => setWtOpen(!wtOpen)}
              title={wt.path}
              aria-haspopup="menu"
              aria-expanded={wtOpen}
            >
              {wt.is_main && <span title="Main worktree" className="flex shrink-0"><HomeIcon size={12} className="text-accent-500" /></span>}
              <span className="mono truncate text-[12px]">{wt.branch || "(detached)"}</span>
              <ChevronDown size={12} className="shrink-0 text-ink-400" />
            </button>
            {wtOpen && (
              <>
                <div className="fixed inset-0 z-30" data-no-drag data-outside />
                <div
                  className="absolute left-0 top-9 z-40 w-72 overflow-hidden rounded-lg py-1 shadow-pop"
                  style={{
                    background: "var(--gm-overlay)",
                    border: "1px solid var(--gm-hairline)",
                  }}
                >
                  {worktrees.map((w) => (
                    <div
                      key={w.id}
                      role="button"
                      tabIndex={0}
                      className={`cursor-pointer px-3 py-2 ${
                        w.id === activeWorktreeId ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
                      }`}
                      onClick={() => {
                        setActiveWorktree(w.id);
                        setWtOpen(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setActiveWorktree(w.id);
                          setWtOpen(false);
                        }
                      }}
                    >
                      <div
                        className={`mono flex items-center gap-1.5 truncate text-[12px] ${
                          w.id === activeWorktreeId ? "text-accent-400" : "text-ink-200"
                        }`}
                      >
                        {w.is_main && <span title="Main worktree" className="flex shrink-0"><HomeIcon size={11} /></span>}
                        <span className="truncate">{w.branch || "(detached)"}</span>
                      </div>
                      <div className="truncate text-[11px] text-ink-400">{w.path}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      <div className="flex-1" />

      <button
        title="Hide or show the left sidebar"
        aria-label={leftVisible ? "Collapse left sidebar" : "Expand left sidebar"}
        aria-pressed={leftVisible}
        className="rounded-md p-2 text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
        onClick={toggleLeft}
      >
        <PanelLeft size={14} />
      </button>

      {/* launch CLI agents into auto-arranged terminal tiles */}
      <button
        title="Launch agents"
        onClick={() => setAgentOpen(true)}
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
      >
        <Bot size={13} />
        <span className="hidden md:inline">Agents</span>
      </button>

      <button
        title="Hide or show the right sidebar"
        aria-label={rightVisible ? "Collapse right sidebar" : "Expand right sidebar"}
        aria-pressed={rightVisible}
        className="rounded-md p-2 text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
        onClick={toggleRight}
      >
        <PanelRight size={14} />
      </button>

      {/* broadcast: honest switch, no glow */}
      <button
        title="Broadcast input: type once, all visible panes receive"
        onClick={toggleBroadcast}
        className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
          broadcast.active ? "text-ink-100" : "text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
        }`}
        style={broadcast.active ? { background: "var(--gm-accent-wash)" } : undefined}
      >
        <span
          className="flex h-4 w-7 items-center rounded-full px-0.5 transition-colors"
          style={{
            background: broadcast.active ? "var(--gm-accent)" : "rgba(255,255,255,0.14)",
            justifyContent: broadcast.active ? "flex-end" : "flex-start",
          }}
        >
          <span
            className="h-3 w-3 rounded-full"
            style={{ background: broadcast.active ? "var(--gm-accent-ink)" : "var(--gm-ink-mute)" }}
          />
        </span>
        <Radio size={13} className={broadcast.active ? "text-accent-400" : ""} />
        <span className="hidden md:inline">Broadcast</span>
      </button>

      <button
        title="Command palette"
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
        onClick={() => setPaletteOpen(true)}
      >
        <Search size={13} />
        <span className="gm-kbd">Ctrl K</span>
      </button>

      <button
        title="Settings"
        aria-label="Open settings"
        className="rounded-md p-2 text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
        onClick={() => setSettingsOpen(true)}
      >
        <SettingsIcon size={14} />
      </button>

      <span className="mx-1.5 h-4 w-px shrink-0" style={{ background: "var(--gm-hairline)" }} />
      <WindowControls />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Welcome: a composed workbench card, not a marketing hero.           */
/* ------------------------------------------------------------------ */

function Welcome({ onOpen, busy }: { onOpen: () => void; busy: boolean }) {
  const projects = useStore((s) => s.projects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  return (
    <div className="flex h-full items-center justify-center bg-ink-950 p-6">
      <div
        className="w-[480px] max-w-full rounded-xl p-7 shadow-pop"
        style={{
          background: "var(--gm-panel)",
          border: "1px solid var(--gm-hairline)",
        }}
      >
        <div>
          <div className="text-[14px] font-semibold tracking-tight text-ink-100">
            Guimux workbench
          </div>
          <div className="mt-0.5 text-[12px] text-ink-400">
            Terminals, worktrees, and files in one surface
          </div>
        </div>

        <button
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold transition-colors"
          style={{
            background: "var(--gm-accent)",
            color: "var(--gm-accent-ink)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--gm-accent-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--gm-accent)")}
          onClick={onOpen}
          disabled={busy}
        >
          <FolderOpen size={15} strokeWidth={2.2} />
          {busy ? "Opening..." : "Open folder or repository"}
        </button>

        <div className="mt-5 grid grid-cols-2 gap-2 text-left">
          <div
            className="rounded-lg p-3"
            style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--gm-hairline-soft)" }}
          >
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-200">
              <Folder size={12} className="text-ink-400" /> Plain folder
            </div>
            <div className="mt-1 text-[11.5px] leading-5 text-ink-400">
              Terminals and files work immediately.
            </div>
          </div>
          <div
            className="rounded-lg p-3"
            style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--gm-hairline-soft)" }}
          >
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-200">
              <GitBranch size={12} className="text-ink-400" /> Git repository
            </div>
            <div className="mt-1 text-[11.5px] leading-5 text-ink-400">
              Adds isolated worktrees per branch.
            </div>
          </div>
        </div>

        {projects.length > 0 && (
          <div className="mt-5" style={{ borderTop: "1px solid var(--gm-hairline-soft)", paddingTop: 12 }}>
            <div className="mb-1.5 text-[11px] font-medium text-ink-400">Recent</div>
            {projects.slice(0, 4).map((p) => (
              <button
                key={p.id}
                onClick={() => setActiveProject(p.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/[0.04]"
                title={p.path}
              >
                {p.isGit ? (
                  <GitBranch size={12} className="shrink-0 text-accent-500" />
                ) : (
                  <Folder size={12} className="shrink-0 text-ink-400" />
                )}
                <span className="flex-1 truncate text-[12.5px] font-medium text-ink-200">
                  {p.name}
                </span>
                <span className="max-w-[220px] truncate text-[11px] text-ink-400">{p.path}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-5 flex items-center gap-4 text-[11.5px] text-ink-400">
          <span className="flex items-center gap-1.5">
            <span className="gm-kbd">Ctrl K</span> palette
          </span>
          <span className="flex items-center gap-1.5">
            <span className="gm-kbd">Ctrl D</span> split
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status strip: quiet session facts, tabular numerals.                */
/* ------------------------------------------------------------------ */

function StatusStrip() {
  const proj = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const wt = useStore((s) => s.worktrees.find((w) => w.id === s.activeWorktreeId));
  const broadcast = useStore((s) => s.broadcast);
  if (!proj) return null;
  return (
    <div
      className="tnum flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t px-3 text-[11px] text-ink-400"
      style={{ borderColor: "var(--gm-hairline)", background: "var(--gm-canvas)" }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {proj.isGit ? <GitBranch size={11} className="shrink-0 text-accent-500" /> : <Folder size={11} className="shrink-0" />}
        <span className="truncate text-ink-400">{wt ? wt.branch || "(detached)" : proj.name}</span>
      </span>
      <span className="hidden max-w-[420px] truncate sm:block" title={wt?.path ?? proj.path}>
        {wt?.path ?? proj.path}
      </span>
      <span className="flex-1" />
      {broadcast.active && (
        <span className="flex items-center gap-1.5 font-medium" style={{ color: "var(--gm-accent)" }}>
          <Radio size={11} /> broadcast to {broadcast.targetPaneIds.length}
        </span>
      )}
      <span>{proj.isGit ? "git worktree session" : "folder session"}</span>
    </div>
  );
}

export default function App() {
  const {
    projects,
    activeProjectId,
    hydrated,
    addProject,
    setActiveProject,
    setRepoRoot,
    worktrees,
    activeWorktreeId,
    setActiveWorktree,
    setWorktrees,
    layout,
    activePaneId,
    splitPane,
    broadcast,
    leftVisible,
    rightVisible,
  } = useStore();

  const [busy, setBusy] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  const proj = projects.find((p) => p.id === activeProjectId) ?? null;

  // Dev-only terminal stress loop (localStorage `guimux-stress=1`); no-op otherwise.
  useEffect(() => {
    maybeStartStress();
  }, []);

  // Restore persisted projects once on startup, then persist on every change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadPersisted();
      if (cancelled) return;
      const st = useStore.getState();
      if (saved?.settings) st.hydrateSettings(saved.settings);
      if (saved && saved.projects.length > 0) {
        // Single hydrate AFTER re-detect (parallel): the old two-hydrate
        // sequence (saved, then fresh) reset layout/worktrees mid-mount,
        // killing the just-spawned PTY and flashing a kill+respawn cycle —
        // the "terminals popping in and out" on startup.
        // Re-detect refreshes branch/gitRoot and drops deleted folders.
        const settled = await Promise.all(
          saved.projects.map((p) => detectToProject(p.path).catch(() => null)),
        );
        if (cancelled) return;
        const fresh = settled.filter((p): p is Project => p !== null);
        if (cancelled) return;
        const cur = useStore.getState();
        if (fresh.length === 0) {
          cur.hydrate([], null);
        } else {
          // detectToProject normalizes to git root, so ids may shift; remap by path.
          const oldActive = saved.projects.find((p) => p.id === saved.activeProjectId);
          const byPath = oldActive ? fresh.find((p) => p.path === oldActive.path) : undefined;
          cur.hydrate(fresh, byPath?.id ?? fresh[0].id);
        }
      } else {
        st.hydrate([], null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settings = useStore((s) => s.settings);
  useEffect(() => {
    if (!hydrated) return;
    savePersisted({ projects, activeProjectId, settings });
  }, [hydrated, projects, activeProjectId, settings]);

  // App-wide zoom: CSS `zoom` on <html> scales all chrome (topbar, sidebar,
  // explorer, dialogs). Terminals refit through their ResizeObserver.
  // ponytail: `zoom` is non-standard but fine in WebView2/Chromium; switch
  // to Webview.setZoom if native per-window zoom is ever needed.
  const uiZoom = useStore((s) => s.settings.uiZoom);
  useEffect(() => {
    document.documentElement.style.zoom = uiZoom === 1 ? "" : String(uiZoom);
  }, [uiZoom]);

  const addFolder = async () => {
    try {
      setBusy(true);
      setRepoError(null);
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Open folder or git repository",
      });
      if (!picked) return;
      const raw = Array.isArray(picked) ? picked[0] : (picked as string);
      const p = await detectToProject(raw);
      addProject(p);
      setActiveProject(p.id);
    } catch (e) {
      setRepoError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Worktree loader: keyed ONLY on project identity, never on the object
  // (a fresh projects array each hydrate re-created `activeProject` and
  // re-ran this effect, double-listing worktrees and remounting the PTY).
  const activeProjectIdSel = useStore((s) => s.activeProjectId);
  const activeProjectGitKey = useStore((s) => {
    const p = s.projects.find((x) => x.id === s.activeProjectId) ?? null;
    return p ? `${p.id}::${p.isGit ? (p.gitRoot ?? p.path) : p.path}` : null;
  });
  useEffect(() => {
    if (!hydrated || !activeProjectGitKey) return;
    const sep = activeProjectGitKey.lastIndexOf("::");
    const id = activeProjectGitKey.slice(0, sep);
    const st0 = useStore.getState();
    const p = st0.projects.find((x) => x.id === id) ?? null;
    if (!p) return;
    let cancelled = false;
    (async () => {
      try {
        setRepoError(null);
        if (p.isGit) {
          const root = p.gitRoot ?? p.path;
          setRepoRoot(root);
          let wts: Worktree[] | null = null;
          // Defer one frame: lets first paint land before the shell burst.
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          try {
            const listed = await invoke<Worktree[]>("worktree_list", { repoRoot: root });
            if (listed.length > 0) wts = listed;
          } catch (e) {
            // Fall through to the plain-folder fallback below. The banner
            // keeps the git error visible instead of sticking on "Starting…".
            if (!cancelled) setRepoError(String(e));
          }
          if (cancelled) return;
          if (wts) {
            setWorktrees(wts);
            const st = useStore.getState();
            if (!wts.find((w) => w.id === st.activeWorktreeId)) {
              const main = wts.find((w) => w.is_main) ?? wts[0];
              setActiveWorktree(main.id);
            }
            return;
          }
          // Git list failed or empty: plain folder terminal on the project
          // path so a shell always mounts.
          setRepoRoot(p.path);
          const solo: Worktree[] = [
            { id: `plain:${p.id}`, path: p.path, branch: p.name, is_main: true },
          ];
          setWorktrees(solo);
          const st = useStore.getState();
          if (st.activeWorktreeId !== solo[0].id) setActiveWorktree(solo[0].id);
        } else {
          setRepoRoot(p.path);
          const solo: Worktree[] = [
            { id: `plain:${p.id}`, path: p.path, branch: p.name, is_main: true },
          ];
          if (cancelled) return;
          setWorktrees(solo);
          const st = useStore.getState();
          if (st.activeWorktreeId !== solo[0].id) setActiveWorktree(solo[0].id);
        }
      } catch (e) {
        if (!cancelled) setRepoError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, activeProjectGitKey, activeProjectIdSel]);

  // Ctrl+K palette, Ctrl+D split, Ctrl+, settings,
  // Ctrl+=/-/0 app zoom (terminals own these keys when focused)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const inTerm = !!(e.target as HTMLElement | null)?.closest?.(".xterm");
      if (mod && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
        if (!inTerm) {
          e.preventDefault();
          const st = useStore.getState();
          const z = st.settings.uiZoom;
          if (e.key === "0") st.setSettings({ uiZoom: 1 });
          else st.setSettings({ uiZoom: Math.min(2, Math.max(0.5, Math.round((z + (e.key === "=" || e.key === "+" ? 0.1 : -0.1)) * 100) / 100)) });
          return;
        }
        // inside a terminal: let the pane own Ctrl+0, ignore Ctrl+=/- so the
        // shell sees them instead of the app zooming underneath it.
        return;
      }
      if (mod && e.key.toLowerCase() === "k") {
        // In a focused terminal Ctrl+K is kill-line: let the shell have it.
        if (inTerm) return;
        e.preventDefault();
        const st = useStore.getState();
        st.setPaletteOpen(!st.paletteOpen);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        const st = useStore.getState();
        st.setSettingsOpen(!st.settingsOpen);
      } else if (mod && e.key.toLowerCase() === "d" && !e.shiftKey) {
        const st = useStore.getState();
        if (st.activePaneId && st.paletteOpen === false) {
          const tag = (e.target as HTMLElement | null)?.tagName;
          if (tag !== "INPUT" && tag !== "TEXTAREA") {
            e.preventDefault();
            st.splitPane(st.activePaneId, "h");
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const st = useStore.getState();
    const ids: string[] = [];
    const walk = (n: unknown) => {
      const v = n as { kind?: string; id?: string; first?: unknown; second?: unknown } | null;
      if (!v) return;
      if (v.kind === "pane" && v.id) ids.push(v.id);
      else {
        walk(v.first ?? null);
        walk(v.second ?? null);
      }
    };
    walk(st.layout);
    st.setBroadcastTargets(ids);
  }, [layout]);


  const wt = worktrees.find((w) => w.id === activeWorktreeId);

  useEffect(() => {
    if (wt && !layout) {
      const st = useStore.getState();
      st.setActiveWorktree(wt.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wt?.id]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center bg-ink-950 text-[13px] text-ink-400">
        Restoring projects...
      </div>
    );
  }

  if (!proj) {
    return (
      <div className="flex h-full flex-col">
        <div
          data-tauri-drag-region
          onMouseDown={(e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest("button, [role='button'], input, textarea, a")) return;
            import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
              getCurrentWindow().startDragging().catch(() => {});
            }).catch(() => {});
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("button, [role='button'], input, textarea, a")) return;
            import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
              getCurrentWindow().toggleMaximize().catch(() => {});
            }).catch(() => {});
          }}
          className="flex h-11 shrink-0 select-none items-center gap-2 border-b bg-ink-900 pl-3 pr-0"
          style={{ borderColor: "var(--gm-hairline)" }}
        >
          <span className="text-[13px] font-semibold tracking-tight text-ink-100">
            guimux
          </span>
          <div className="flex-1" />
          <button
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-ink-400 hover:bg-white/[0.04]"
            onClick={() => useStore.getState().setPaletteOpen(true)}
          >
            <Search size={13} />
            <span className="gm-kbd">Ctrl K</span>
          </button>
          <span className="mx-1.5 h-4 w-px shrink-0" style={{ background: "var(--gm-hairline)" }} />
          <WindowControls />
        </div>
        <div className="relative min-h-0 flex-1">
          <Welcome onOpen={addFolder} busy={busy} />
          {repoError && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md px-3 py-1.5 text-xs"
              style={{ background: "var(--gm-overlay)", border: "1px solid rgba(199,78,57,0.4)", color: "var(--gm-red)" }}>
              {repoError}
            </div>
          )}
        </div>
        <Palette />
        <SettingsPanel />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar onAdd={addFolder} />
      {repoError && (
        <div
          className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-[11.5px]"
          style={{ background: "rgba(199,78,57,0.08)", borderBottom: "1px solid rgba(199,78,57,0.25)", color: "var(--gm-red)" }}
        >
          <X size={12} /> {repoError}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {leftVisible && <WorktreeSidebar />}
        <div className="relative min-w-0 flex-1 bg-ink-950">
          {wt && layout ? (
            <SplitView key={wt.id} node={layout} cwd={wt.path} />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-ink-400">
              {busy ? "Loading..." : "Starting terminal..."}
            </div>
          )}
          {activePaneId && (
            <div
              className="pointer-events-none absolute bottom-2.5 right-2.5 flex overflow-hidden rounded-lg shadow-pop"
              style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
            >
              <button
                className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium text-ink-300 hover:bg-white/[0.05] hover:text-ink-100"
                onClick={() => splitPane(activePaneId, "h")}
                title="Split right (Ctrl+D)"
              >
                <Columns2 size={12} /> Split right
              </button>
              <span className="w-px" style={{ background: "var(--gm-hairline)" }} />
              <button
                className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium text-ink-300 hover:bg-white/[0.05] hover:text-ink-100"
                onClick={() => splitPane(activePaneId, "v")}
                title="Split down"
              >
                <Rows2 size={12} /> Split down
              </button>
            </div>
          )}
        </div>
        {wt && rightVisible && <ExplorerPane key={wt.id} root={wt.path} />}
      </div>
      <StatusStrip />
      <Palette />
      <SettingsPanel />
      <AgentLauncher />
      {broadcast.active && (
        <div
          className="tnum pointer-events-none fixed bottom-10 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg px-3.5 py-1.5 text-[12px] font-medium shadow-pop"
          style={{
            background: "var(--gm-overlay)",
            border: "1px solid var(--gm-hairline)",
            color: "var(--gm-accent)",
          }}
        >
          <Radio size={12} /> Broadcast on: typing goes to {broadcast.targetPaneIds.length}{" "}
          {broadcast.targetPaneIds.length === 1 ? "pane" : "panes"}
        </div>
      )}
    </div>
  );
}
