import { useCallback, useRef } from "react";
import { useStore, type PaneNode, type Pane, type Split } from "../store";
import { TerminalPane } from "./TerminalPane";

function containsPane(node: PaneNode, paneId: string): boolean {
  if (node.kind === "pane") return node.id === paneId;
  return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

function countPanes(node: PaneNode): number {
  if (node.kind === "pane") return 1;
  return countPanes(node.first) + countPanes(node.second);
}

export function SplitView({ node, cwd, maximizedId, start = 1 }: { node: PaneNode; cwd: string; maximizedId?: string | null; start?: number }) {
  // Root reads the store (stale id restores the full grid); nested levels
  // inherit the prop so hidden siblings still compute hidden=true.
  const stored = useStore((s) => s.maximizedPaneId);
  const maxId =
    maximizedId !== undefined
      ? maximizedId
      : stored && containsPane(node, stored)
        ? stored
        : null;
  if (node.kind === "pane") {
    // Key by pane id: without this, splitting elsewhere in the tree remounts
    // surviving panes (new xterm + new PTY listeners mid-stream → blank pane).
    return <PaneWrap key={node.id} pane={node} num={start} cwd={cwd} maximizedId={maxId} />;
  }
  return <SplitNode key={node.id} split={node} cwd={cwd} maximizedId={maxId} start={start} />;
}

function PaneWrap({ pane, num, cwd, maximizedId }: { pane: Pane; num: number; cwd: string; maximizedId: string | null }) {
  const { activePaneId, setActivePane, closePane, splitPane, toggleMaximizePane } = useStore();
  const active = activePaneId === pane.id;
  const maxed = maximizedId === pane.id;
  // Maximized siblings stay mounted (PTY alive) but hidden, so restore is instant.
  const hidden = maximizedId != null && maximizedId !== pane.id;
  return (
    <div
      className="gm-pane-in group/pane flex h-full w-full flex-col overflow-hidden rounded-[10px]"
      data-active={active}
      onMouseDown={() => setActivePane(pane.id)}
      style={
        hidden
          ? { display: "none" }
          : {
              background: "#101010",
              // Active pane gets the brighter edge, idle gets a dim one. Same
              // tile color both states so selection never shifts text.
              boxShadow: active
                ? "inset 0 0 0 1px rgba(255,255,255,0.22)"
                : "inset 0 0 0 1px rgba(255,255,255,0.10)",
            }
      }
    >
      <div
        className="flex h-8 shrink-0 select-none items-center gap-2 px-2.5"
        style={{
          background: active ? "rgba(255,255,255,0.055)" : "rgba(255,255,255,0.025)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
        }}
      >
        {/* traffic dots: red closes, yellow maximizes, green splits right */}
        <span className="flex items-center gap-1.5">
          <button
            title="Close pane"
            aria-label="Close pane"
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              closePane(pane.id);
            }}
            className="h-2.5 w-2.5 rounded-full transition-transform hover:scale-110"
            style={{ background: "#ff5f57" }}
          />
          <button
            title={maxed ? "Restore panes" : "Maximize pane"}
            aria-label={maxed ? "Restore panes" : "Maximize pane"}
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setActivePane(pane.id);
              toggleMaximizePane(pane.id);
            }}
            className="h-2.5 w-2.5 rounded-full transition-transform hover:scale-110"
            style={{ background: "#febc2e" }}
          />
          <button
            title="Split right"
            aria-label="Split pane right"
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setActivePane(pane.id);
              splitPane(pane.id, "h");
            }}
            className="h-2.5 w-2.5 rounded-full transition-transform hover:scale-110"
            style={{ background: "#28c840" }}
          />
        </span>
        <span
          className="tnum min-w-0 flex-1 truncate text-center text-[11px] font-medium"
          style={{ color: active ? "var(--gm-ink-dim)" : "var(--gm-ink-faint)" }}
        >
          Terminal {num}
        </span>
        {/* spacer balances the dots so the title stays centered */}
        <span className="w-[46px] shrink-0" aria-hidden />
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <TerminalPane
          paneId={pane.id}
          ptyId={pane.ptyId}
          cwd={pane.cwd ?? cwd}
          visible={!hidden}
          initCmd={pane.initCmd ?? null}
          onClose={() => closePane(pane.id)}
        />
      </div>
    </div>
  );
}

function SplitNode({ split, cwd, maximizedId, start = 1 }: { split: Split; cwd: string; maximizedId: string | null; start?: number }) {
  const firstCount = countPanes(split.first);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeWorktreeId = useStore((s) => s.activeWorktreeId);
  const setSplitRatio = useStore((s) => s.setSplitRatio);
  const dragging = useRef(false);
  // Maximized: keep both branches mounted (PTYs alive) but show only the
  // one containing the pane; the other hides via display:none.
  const firstHas = maximizedId != null && containsPane(split.first, maximizedId);
  const secondHas = maximizedId != null && containsPane(split.second, maximizedId);
  const maxed = firstHas || secondHas;

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

  // Black 8px channels, cards never touch. The knob only marks the drag
  // handle on hover. Maximized hides gutters so the pane owns the frame.
  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full ${maxed ? "" : "gap-2"} ${split.direction === "h" ? "flex-row" : "flex-col"}`}
      style={{ background: "#000000" }}
    >
      <div
        style={firstHas ? { flex: 1 } : secondHas ? { display: "none" } : { flexBasis: `calc(${split.ratio * 100}% - 4px)` }}
        className="min-h-0 min-w-0"
      >
        <SplitView key={split.first.id} node={split.first} cwd={cwd} maximizedId={maxed ? maximizedId : null} start={start} />
      </div>
      <div
        role="separator"
        aria-orientation={split.direction === "h" ? "vertical" : "horizontal"}
        tabIndex={maxed ? -1 : 0}
        aria-hidden={maxed}
        aria-label="Split resize handle"
        style={maxed ? { display: "none" } : undefined}
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
        {/* Faint bar inside a 9px hit target; gutter stays black. */}
        <div
          style={{ background: "rgba(255,255,255,0.09)" }}
          className={`rounded-full ${split.direction === "h" ? "h-[calc(100%-8px)] w-[3px]" : "h-[3px] w-[calc(100%-8px)]"}`}
        />
      </div>
      <div
        style={secondHas ? { flex: 1 } : firstHas ? { display: "none" } : { flexBasis: `calc(${(1 - split.ratio) * 100}% - 4px)` }}
        className="min-h-0 min-w-0"
      >
        <SplitView key={split.second.id} node={split.second} cwd={cwd} maximizedId={maxed ? maximizedId : null} start={start + firstCount} />
      </div>
    </div>
  );
}
