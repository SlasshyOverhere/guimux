import { useCallback, useRef } from "react";
import { useStore, type PaneNode, type Pane, type Split } from "../store";
import { TerminalPane } from "./TerminalPane";

export function SplitView({ node, cwd }: { node: PaneNode; cwd: string }) {
  if (node.kind === "pane") {
    // Key by pane id: without this, splitting elsewhere in the tree remounts
    // surviving panes (new xterm + new PTY listeners mid-stream → blank pane).
    return <PaneWrap key={node.id} pane={node} cwd={cwd} />;
  }
  return <SplitNode key={node.id} split={node} cwd={cwd} />;
}

function PaneWrap({ pane, cwd }: { pane: Pane; cwd: string }) {
  const { activePaneId, closePane } = useStore();
  const active = activePaneId === pane.id;
  // Native tile: no border, no window-in-window. The canvas itself is
  // the surface; the active pane reads through a soft inset tint + faint
  // edge, an inactive pane is bare canvas. Zero splits = zero seams.
  return (
    <div
      className="gm-pane-in group/pane h-full w-full overflow-hidden rounded-lg"
      data-active={active}
      style={
        active
          ? { background: "var(--gm-panel)", boxShadow: "inset 0 0 0 1px var(--gm-hairline-soft)" }
          : { background: "var(--gm-canvas)" }
      }
    >
      <TerminalPane
        paneId={pane.id}
        ptyId={pane.ptyId}
        cwd={pane.cwd ?? cwd}
        visible={true}
        initCmd={pane.initCmd ?? null}
        onClose={() => closePane(pane.id)}
      />
    </div>
  );
}

function SplitNode({ split, cwd }: { split: Split; cwd: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeWorktreeId = useStore((s) => s.activeWorktreeId);
  const setSplitRatio = useStore((s) => s.setSplitRatio);
  const dragging = useRef(false);

  const onDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = split.direction === "h" ? "col-resize" : "row-resize";
    const move = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio =
        split.direction === "h"
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;
      if (activeWorktreeId) setSplitRatio(activeWorktreeId, split.id, ratio);
    };
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [split.direction, split.id, activeWorktreeId, setSplitRatio]);

  // Gutters carry the canvas color so splits read as carved channels,
  // not glowing bars. Rounded caps, stable through drag.
  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full gap-1 p-1 ${split.direction === "h" ? "flex-row" : "flex-col"}`}
      style={{ background: "var(--gm-canvas)" }}
    >
      <div
        style={{ flexBasis: `calc(${split.ratio * 100}% - 7.5px)` }}
        className="min-h-0 min-w-0"
      >
        <SplitView key={split.first.id} node={split.first} cwd={cwd} />
      </div>
      <div
        role="separator"
        aria-orientation={split.direction === "h" ? "vertical" : "horizontal"}
        tabIndex={0}
        aria-label="Split resize handle"
        className={`flex shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--gm-hover)] focus-visible:bg-[var(--gm-hover)] ${
          split.direction === "h" ? "w-[9px] cursor-col-resize" : "h-[9px] cursor-row-resize"
        }`}
        onMouseDown={onDown}
        onKeyDown={(e) => {
          const step =
            e.key === "ArrowUp" || e.key === "ArrowLeft"
              ? -0.02
              : e.key === "ArrowDown" || e.key === "ArrowRight"
                ? 0.02
                : 0;
          if (!step) return;
          e.preventDefault();
          if (!activeWorktreeId) return;
          setSplitRatio(activeWorktreeId, split.id, split.ratio + step);
        }}
      >
        {/* visible 3px bar inside a 9px hit target */}
        <div
          style={{ background: "rgba(255,255,255,0.09)" }}
          className={`rounded-full ${split.direction === "h" ? "h-[calc(100%-8px)] w-[3px]" : "h-[3px] w-[calc(100%-8px)]"}`}
        />
      </div>
      <div
        style={{ flexBasis: `calc(${(1 - split.ratio) * 100}% - 7.5px)` }}
        className="min-h-0 min-w-0"
      >
        <SplitView key={split.second.id} node={split.second} cwd={cwd} />
      </div>
    </div>
  );
}
