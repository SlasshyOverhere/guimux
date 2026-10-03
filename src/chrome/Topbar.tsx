import { X } from "lucide-react";
import {
  Bot,
  House as HomeIcon,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useStore } from "../store";
import { WindowControls } from "./WindowControls";

// Drag must ignore anything clickable: on Windows a native drag started on
// mousedown swallows the follow-up click, which bricked every dropdown row
// and click-outside overlay in the bar (they are divs, not <button>s).
const noDrag = (t: HTMLElement) =>
  !!t.closest("button, [role='button'], input, textarea, a, [data-no-drag]");

// Drag on mousemove-after-press (real gesture), never on bare mousedown:
// Windows treats startDragging like a native caption drag and swallows the
// click that follows.
function barDragDown(e: React.MouseEvent) {
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
}

function barDoubleClick(e: React.MouseEvent) {
  if (noDrag(e.target as HTMLElement)) return;
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    getCurrentWindow().toggleMaximize().catch(() => {});
  }).catch(() => {});
}

function Wordmark() {
  return (
    <>
      <span
        className="select-none text-strong font-semibold text-ink-100"
        style={{ letterSpacing: "-0.02em" }}
      >
        guimux
      </span>
      {import.meta.env.DEV && (
        <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-px text-label font-semibold uppercase tracking-wider text-amber-300">
          dev
        </span>
      )}
    </>
  );
}

/** Sidebar (left) and file dock (bottom) toggles share one shape: an icon
 *  button that reads as pressed while its panel is showing. */
function PanelToggle({ side }: { side: "left" | "bottom" }) {
  const open = useStore((s) => (side === "left" ? s.leftVisible : s.rightVisible));
  const toggle = useStore((s) => (side === "left" ? s.toggleLeft : s.toggleRight));
  const label = side === "left" ? "sidebar" : "file dock";
  const keys = side === "left" ? "Ctrl+B" : "Ctrl+J";
  const Icon = side === "left"
    ? open ? PanelLeftClose : PanelLeftOpen
    : open ? PanelBottomClose : PanelBottomOpen;
  return (
    <button
      title={`${open ? "Hide" : "Show"} ${label} (${keys})`}
      aria-label={`${open ? "Hide" : "Show"} ${label}`}
      aria-pressed={open}
      onClick={toggle}
      data-active={open}
      className="gm-icon-btn gm-icon-btn--sm"
    >
      <Icon size={14} strokeWidth={2} />
    </button>
  );
}

/**
 * The one window bar. A project-less session shows the palette affordance;
 * inside a project it shows the worktree as the document title plus the
 * panel toggles. Wordmark, drag region and window controls never change.
 */
export function Topbar() {
  const inProject = useStore((s) => s.activeProjectId != null);
  const worktree = useStore((s) =>
    s.worktrees.find((w) => w.id === s.activeWorktreeId),
  );
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setAgentOpen = useStore((s) => s.setAgentOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);

  return (
    <div
      data-tauri-drag-region
      onMouseDown={barDragDown}
      onDoubleClick={barDoubleClick}
      className="gm-rule flex h-11 shrink-0 select-none items-center gap-1.5 bg-surface-panel pl-3 pr-0"
    >
      <Wordmark />

      {inProject && (
        <span className="ml-1">
          <PanelToggle side="left" />
        </span>
      )}

      {/* session title: the worktree, centered like a document title */}
      {inProject && (
        <div className="pointer-events-none absolute left-1/2 flex max-w-[40vw] -translate-x-1/2 items-center gap-1.5">
          {worktree?.is_main && (
            <span title="Main worktree" className="flex shrink-0">
              <HomeIcon size={11} strokeWidth={2} className="text-ink-400" />
            </span>
          )}
          <span
            className="truncate text-body font-semibold text-ink-100"
            title={worktree?.path}
          >
            {worktree?.branch || "No worktree"}
          </span>
        </div>
      )}

      <div className="flex-1" />

      {/* Command palette stays reachable with the mouse in a project too: a
          keyboard-only entry point is invisible to everyone who does not
          already know the binding. */}
      <button
        className="gm-icon-btn text-body"
        onClick={() => setPaletteOpen(true)}
        title="Command palette"
        aria-label="Command palette"
      >
        <Search size={14} strokeWidth={2} />
        {!inProject && <span className="gm-kbd">Ctrl K</span>}
      </button>

      {inProject && (
        <>
          {/* launch CLI agents into auto-arranged terminal tiles */}
          <button
            title="Launch agents"
            onClick={() => setAgentOpen(true)}
            className="gm-icon-btn text-body font-medium"
          >
            <Bot size={14} strokeWidth={2} />
            <span className="hidden pr-0.5 md:inline">Agents</span>
          </button>
          <PanelToggle side="bottom" />
          <button
            title="Settings"
            aria-label="Open settings"
            className="gm-icon-btn gm-icon-btn--sm"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={14} strokeWidth={2} />
          </button>
        </>
      )}

      <WindowControls />
    </div>
  );
}

/** Banner for a project-level failure (git list, permissions). */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-meta"
      style={{
        background: "rgba(199,78,57,0.08)",
        borderBottom: "1px solid rgba(199,78,57,0.25)",
        color: "var(--gm-red)",
      }}
    >
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
      <button
        onClick={onDismiss}
        className="gm-icon-btn gm-icon-btn--sm shrink-0"
        title="Dismiss"
        aria-label="Dismiss error"
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
