import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  GitBranch,
  Search,
  FolderOpen,
  Folder,
  X,
  Plus,
  House as HomeIcon,
  Settings as SettingsIcon,
  Bot,
  PanelLeftOpen,
  PanelLeftClose,
  PanelRightOpen,
  PanelRightClose,
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
import { maybeAutoCheck } from "./updater";
export { detectToProject };

/* ------------------------------------------------------------------ */
/* Topbar: session title. Project picker left, worktree centered like   */
/* a document title, tools right. One palette, one accent, Inter only.  */
/* ------------------------------------------------------------------ */

function Topbar({ onAdd }: { onAdd: () => void }) {
  const {
    projects,
    activeProjectId,
    setActiveProject,
    removeProject,
    worktrees,
    activeWorktreeId,
    setSettingsOpen,
    setAgentOpen,
    leftVisible,
    rightVisible,
    toggleLeft,
    toggleRight,
  } = useStore();
  const proj = projects.find((p) => p.id === activeProjectId) ?? null;
  const wt = worktrees.find((w) => w.id === activeWorktreeId);
  const [projOpen, setProjOpen] = useState(false);

  // Escape + pointer-down-outside close the project dropdown.
  // pointerdown (not click): a real click-outside that works even when the
  // click itself is swallowed, and it closes before the row's click fires.
  useEffect(() => {
    if (!projOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjOpen(false);
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
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [projOpen]);

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
      className="flex h-11 shrink-0 select-none items-center gap-1.5 bg-ink-900 pl-3 pr-0"
      style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}
    >
      {/* wordmark: bare type, no tile, no gradient */}
      <span
        className="select-none text-[13px] font-semibold tracking-tight text-ink-100"
        style={{ letterSpacing: "-0.02em" }}
      >
        guimux
      </span>
      {import.meta.env.DEV && (
        <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-amber-300">
          dev
        </span>
      )}

      <button
        title={leftVisible ? "Collapse left sidebar (Ctrl+B)" : "Expand left sidebar (Ctrl+B)"}
        aria-label={leftVisible ? "Collapse left sidebar" : "Expand left sidebar"}
        aria-pressed={leftVisible}
        onClick={toggleLeft}
        data-active={leftVisible}
        className="gm-icon-btn gm-icon-btn--sm ml-1"
      >
        {leftVisible ? <PanelLeftClose size={14} strokeWidth={2} /> : <PanelLeftOpen size={14} strokeWidth={2} />}
      </button>

      {/* project picker, left */}
      <div className="relative" data-menu-root style={{ zIndex: projOpen ? 50 : undefined }}>
        <button
          className="gm-icon-btn h-[30px] max-w-[220px] gap-2 px-2 text-[12.5px] font-medium text-ink-200"
          style={{ width: "auto" }}
          onClick={() => setProjOpen(!projOpen)}
          title={proj?.path ?? "No project open"}
          aria-haspopup="menu"
          aria-expanded={projOpen}
        >
          {proj?.isGit ? (
            <GitBranch size={14} className="shrink-0 text-ink-400" strokeWidth={2} />
          ) : (
            <Folder size={14} className="shrink-0 text-ink-400" strokeWidth={2} />
          )}
          <span className="truncate">{proj ? proj.name : "No project"}</span>
        </button>
        {projOpen && (
          <>
            <div className="fixed inset-0 z-30" data-no-drag data-outside />
            <div
              className="gm-menu absolute left-0 top-9 z-40 w-80"
            >
              <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-ink-400">
                Projects
              </div>
              {projects.map((p) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  data-selected={p.id === activeProjectId}
                  className="gm-row group mx-1 flex cursor-pointer items-center gap-2.5 px-2 py-2"
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
                      size={14}
                      strokeWidth={2}
                      className="shrink-0 text-ink-400"
                    />
                  ) : (
                    <Folder size={14} strokeWidth={2} className="shrink-0 text-ink-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-[12.5px] ${
                        p.id === activeProjectId ? "font-semibold text-ink-100" : "font-medium text-ink-200"
                      }`}
                    >
                      {p.name}
                    </div>
                    <div className="truncate text-[11px] text-ink-500">{p.path}</div>
                  </div>
                  <button
                    title="Remove project"
                    className="hidden shrink-0 rounded-md p-1 text-ink-400 hover:bg-[var(--gm-hover)] hover:text-clay-400 group-hover:block"
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
                className="gm-menu-item mt-1 text-[12.5px]"
                style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}
                onClick={() => {
                  setProjOpen(false);
                  onAdd();
                }}
              >
                <Plus size={14} strokeWidth={2} className="text-ink-400" /> Open folder or repository
              </button>
            </div>
          </>
        )}
      </div>

      {/* session title: centered worktree, the document of this app */}
      {wt ? (
        <div className="pointer-events-none absolute left-1/2 flex max-w-[40vw] -translate-x-1/2 items-center gap-1.5">
          {wt.is_main && (
            <span title="Main worktree" className="flex shrink-0">
              <HomeIcon size={11} strokeWidth={2} className="text-ink-400" />
            </span>
          )}
          <span className="truncate text-[12.5px] font-semibold text-ink-100" title={wt.path}>
            {wt.branch || "(detached)"}
          </span>
        </div>
      ) : (
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[12.5px] font-medium text-ink-400">
          No worktree
        </div>
      )}

      <div className="flex-1" />

      {/* launch CLI agents into auto-arranged terminal tiles */}
      <button
        title="Launch agents"
        onClick={() => setAgentOpen(true)}
        className="gm-icon-btn text-[12px] font-medium"
      >
        <Bot size={14} strokeWidth={2} />
        <span className="hidden pr-0.5 md:inline">Agents</span>
      </button>

      <button
        title={rightVisible ? "Collapse right sidebar" : "Expand right sidebar"}
        aria-label={rightVisible ? "Collapse right sidebar" : "Expand right sidebar"}
        aria-pressed={rightVisible}
        onClick={toggleRight}
        data-active={rightVisible}
        className="gm-icon-btn gm-icon-btn--sm"
      >
        {rightVisible ? <PanelRightClose size={14} strokeWidth={2} /> : <PanelRightOpen size={14} strokeWidth={2} />}
      </button>

      <button
        title="Settings"
        aria-label="Open settings"
        className="gm-icon-btn gm-icon-btn--sm"
        onClick={() => setSettingsOpen(true)}
      >
        <SettingsIcon size={14} strokeWidth={2} />
      </button>

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
          <div className="gm-meta mt-1 text-[12px]">
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
              <Folder size={12} strokeWidth={2} className="text-ink-400" /> Plain folder
            </div>
            <div className="gm-meta mt-1 text-[11.5px] leading-5">
              Terminals and files work immediately.
            </div>
          </div>
          <div
            className="rounded-lg p-3"
            style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--gm-hairline-soft)" }}
          >
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-200">
              <GitBranch size={12} strokeWidth={2} className="text-ink-400" /> Git repository
            </div>
            <div className="gm-meta mt-1 text-[11.5px] leading-5">
              Adds isolated worktrees per branch.
            </div>
          </div>
        </div>

        {projects.length > 0 && (
          <div className="mt-5" style={{ borderTop: "1px solid var(--gm-hairline-soft)", paddingTop: 12 }}>
            <div className="gm-meta mb-1.5">Recent</div>
            {projects.slice(0, 4).map((p) => (
              <button
                key={p.id}
                onClick={() => setActiveProject(p.id)}
                className="gm-row flex w-full items-center gap-2 px-2 py-1.5 text-left"
                title={p.path}
              >
                {p.isGit ? (
                  <GitBranch size={12} strokeWidth={2} className="shrink-0 text-ink-400" />
                ) : (
                  <Folder size={12} strokeWidth={2} className="shrink-0 text-ink-400" />
                )}
                <span className="flex-1 truncate text-[12.5px] font-medium text-ink-200">
                  {p.name}
                </span>
                <span className="max-w-[220px] truncate text-[11px] text-ink-500">{p.path}</span>
              </button>
            ))}
          </div>
        )}

        <div className="gm-meta mt-5 flex items-center gap-4 text-[11.5px]">
          <span className="flex items-center gap-1.5">
            <span className="gm-kbd">Ctrl K</span> palette
          </span>
          <span className="flex items-center gap-1.5">
            <span className="gm-kbd">Ctrl Shift D</span> split
          </span>
        </div>
      </div>
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
    leftVisible,
    rightVisible,
  } = useStore();

  const [busy, setBusy] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  const proj = projects.find((p) => p.id === activeProjectId) ?? null;

  useEffect(() => {
    maybeStartStress();
    // Startup update check: fire-and-forget, never blocks boot or terminals.
    void maybeAutoCheck(useStore.getState().settings.autoCheckForUpdates);
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
        // Paint instantly from disk, revalidate in background. The old flow
        // awaited N git rev-parses before the first hydrate, so boot sat on
        // "Starting terminal…" for 10-30s on cold Windows spawns. Now the
        // seeded shell mounts at once; re-detect + loader correct it after.
        const seedWts = saved.worktrees ?? [];
        const seedActive = saved.activeWorktreeId ?? null;
        st.hydrate(saved.projects, saved.activeProjectId, { worktrees: seedWts, activeWorktreeId: seedActive, worktreesByProject: saved.worktreesByProject });
        // Re-detect refreshes branch/gitRoot and drops deleted folders.
        const settled = await Promise.all(
          saved.projects.map((p) => detectToProject(p.path).catch(() => null)),
        );
        if (cancelled) return;
        const fresh = settled.filter((p): p is Project => p !== null);
        if (cancelled) return;
        if (fresh.length === 0) {
          useStore.getState().hydrate([], null);
        } else {
          // detectToProject normalizes to git root, so ids may shift; remap by path.
          const oldActive = saved.projects.find((p) => p.id === saved.activeProjectId);
          const byPath = oldActive ? fresh.find((p) => p.path === oldActive.path) : undefined;
          const cur = useStore.getState();
          // Keep the seeded shell if the project survived re-detect: a second
          // hydrate would wipe layout/worktrees mid-mount and respawn the PTY.
          const kept = byPath ?? fresh.find((p) => p.id === cur.activeProjectId) ?? fresh[0];
          cur.updateProject(kept.id, { isGit: kept.isGit, gitRoot: kept.gitRoot, branch: kept.branch });
          if (kept.id !== cur.activeProjectId) cur.setActiveProject(kept.id);
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
  const worktreesByProject = useStore((s) => s.worktreesByProject);
  useEffect(() => {
    if (!hydrated) return;
    savePersisted({ projects, activeProjectId, worktrees, activeWorktreeId, worktreesByProject, settings });
  }, [hydrated, projects, activeProjectId, worktrees, activeWorktreeId, worktreesByProject, settings]);

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

  // Worktree loader: keyed on project identity + boot epoch. The epoch
  // pins each run to one boot: without it, the background re-detect patch
  // (updateProject/setActiveProject above) changed the key mid-load and the
  // effect re-ran, double-listing worktrees and remounting the PTY.
  const projectsEpoch = useStore((s) => s.projectsEpoch);
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
        if (p.isGit) {
          const root = p.gitRoot ?? p.path;
          setRepoRoot(root);
          let wts: Worktree[] | null = null;
          // No frame defer: the seeded shell already painted; revalidate now.
          try {
            const listed = await invoke<Worktree[]>("worktree_list", { repoRoot: root });
            if (listed.length > 0) wts = listed;
          } catch (e) {
            // Keep the seeded list on git failure (offline/locked): the old
            // fallthrough replaced it with a plain-folder shell and moved the
            // user. Banner carries the error instead.
            const st = useStore.getState();
            if (st.worktrees.length === 0) {
              setRepoRoot(p.path);
              const solo: Worktree[] = [
                { id: `plain:${p.id}`, path: p.path, branch: p.name, is_main: true },
              ];
              if (!cancelled) {
                setWorktrees(solo);
                setActiveWorktree(solo[0].id);
              }
            }
            if (!cancelled) setRepoError(String(e));
            return;
          }
          if (cancelled) return;
          if (wts) {
            if (!cancelled) setRepoError(null);
            setWorktrees(wts);
            const st = useStore.getState();
            if (!wts.find((w) => w.id === st.activeWorktreeId)) {
              const main = wts.find((w) => w.is_main) ?? wts[0];
              setActiveWorktree(main.id);
            }
            return;
          }
          // Git list empty (not failed): plain folder terminal on the project
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
  }, [hydrated, projectsEpoch, activeProjectGitKey]);

  // Ctrl+K palette, Ctrl+D split, Ctrl+, settings,
  // Ctrl+=/-/0 app zoom (terminals own these keys when focused).
  // Every other app shortcut below is also terminal-exempt: when a shell or
  // TUI has focus its keystrokes (Ctrl+D EOF, Ctrl+B tmux prefix, ...) must
  // reach the PTY unmodified, never trigger chrome.
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
        // In a focused terminal plain Ctrl+K is kill-line: let the shell
        // have it. Ctrl+Shift+K still opens the palette from a terminal.
        if (inTerm && !e.shiftKey) return;
        e.preventDefault();
        const st = useStore.getState();
        st.setPaletteOpen(!st.paletteOpen);
      } else if (mod && e.key === ",") {
        // Ctrl+, is a readline binding in some shells: never steal it.
        if (inTerm) return;
        e.preventDefault();
        const st = useStore.getState();
        st.setSettingsOpen(!st.settingsOpen);
      } else if (mod && e.key.toLowerCase() === "b" && !e.shiftKey) {
        // Ctrl+B is the tmux prefix: it must reach the PTY, never chrome.
        if (inTerm) return;
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
          const st = useStore.getState();
          if (e.altKey) st.toggleRight();
          else st.toggleLeft();
        }
      } else if (mod && e.key.toLowerCase() === "d") {
        // Plain Ctrl+D is EOF (closes prompts, exits REPLs): it must reach
        // the PTY. Ctrl+Shift+D splits even from a focused terminal.
        if (inTerm && !e.shiftKey) return;
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
          className="flex h-11 shrink-0 select-none items-center gap-2 bg-ink-900 pl-3 pr-0"
          style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}
        >
          <span className="text-[13px] font-semibold tracking-tight text-ink-100">
            guimux
          </span>
          {import.meta.env.DEV && (
            <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-amber-300">
              dev
            </span>
          )}
          <div className="flex-1" />
          <button
            className="gm-icon-btn text-[12px]"
            onClick={() => useStore.getState().setPaletteOpen(true)}
          >
            <Search size={14} strokeWidth={2} />
            <span className="gm-kbd">Ctrl K</span>
          </button>
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
        <div className="relative min-w-0 flex-1 bg-ink-950" style={{ borderLeft: "1px solid var(--gm-hairline-soft)" }}>
          {wt && layout ? (
            <SplitView key={wt.id} node={layout} cwd={wt.path} />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-ink-400">
              {busy ? "Loading..." : "Starting terminal..."}
            </div>
          )}
        </div>
        {wt && rightVisible && <ExplorerPane key={wt.id} root={wt.path} />}
      </div>
      <Palette />
      <SettingsPanel />
      <AgentLauncher />
    </div>
  );
}
