import { useEffect, useRef, useState } from "react";
import { ChevronDown, PanelBottomClose, Search } from "lucide-react";
import { useStore } from "../store";
import { ExplorerPane } from "../explorer/ExplorerPane";
import { EditorPane } from "../editor/EditorPane";
import { PREF, numIn, readPref, writePref } from "../uiPrefs";

type Mode = "tree" | "editor";

/**
 * The file surface: a resizable dock under the terminals that shows the tree
 * or the editor. Editing here instead of in a 250px side rail is the whole
 * reason this exists — the old panel gave a code editor about eight words per
 * line.
 */
export function FileDock({ root }: { root: string }) {
  const editorPath = useStore((s) => s.editorPath);
  const closeEditor = useStore((s) => s.closeEditor);
  const [mode, setMode] = useState<Mode>("tree");
  const [height, setHeight] = useState(() =>
    readPref(PREF.dockHeight, 320, numIn(140, 900)),
  );
  const heightRef = useRef(height);
  heightRef.current = height;

  // Opening a file switches to it; closing the last one falls back to the tree,
  // so the dock never comes up empty.
  const hadEditor = useRef(!!editorPath);
  useEffect(() => {
    if (editorPath) {
      setMode("editor");
      hadEditor.current = true;
    } else if (hadEditor.current) {
      setMode("tree");
      hadEditor.current = false;
    }
  }, [editorPath]);

  const onResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    // CSS zoom scales clientY but not layout heights, so divide the cursor
    // delta by uiZoom to keep the dock under the pointer.
    const zoom = useStore.getState().settings.uiZoom || 1;
    const startY = e.clientY;
    const startH = heightRef.current;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      const nh = Math.min(900, Math.max(140, startH - (ev.clientY - startY) / zoom));
      heightRef.current = nh;
      setHeight(nh);
    };
    const up = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writePref(PREF.dockHeight, Math.round(heightRef.current));
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className="gm-rule-top relative flex shrink-0 flex-col bg-surface-panel"
      style={{ height }}
    >
      <div
        className="group absolute inset-x-0 top-[-3px] z-20 h-[6px] cursor-row-resize"
        onMouseDown={onResizeDown}
        onDoubleClick={() => {
          heightRef.current = 320;
          setHeight(320);
          writePref(PREF.dockHeight, 320);
        }}
        title="Drag to resize, double-click to reset"
      >
        <div className="mx-auto h-[3px] w-full bg-[color:var(--gm-ink-mute)] opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 px-2">
        <div className="gm-seg" role="radiogroup" aria-label="File panel">
          <button
            role="radio"
            aria-checked={mode === "tree"}
            data-active={String(mode === "tree")}
            onClick={() => setMode("tree")}
            title="Browse files"
          >
            <Search size={11} strokeWidth={2} className="mr-1 inline" /> Tree
          </button>
          <button
            role="radio"
            aria-checked={mode === "editor"}
            data-active={String(mode === "editor")}
            onClick={() => setMode("editor")}
            disabled={!editorPath}
            title={editorPath ? "Edit open files" : "No file open"}
          >
            Editor
          </button>
        </div>

        <span className="gm-meta min-w-0 flex-1 truncate" title={root}>
          {root}
        </span>

        {mode === "editor" && editorPath && (
          <button
            className="gm-icon-btn gm-icon-btn--sm"
            title="Close the current file"
            aria-label="Close the current file"
            onClick={() => closeEditor()}
          >
            <ChevronDown size={13} strokeWidth={2} />
          </button>
        )}
        <button
          className="gm-icon-btn gm-icon-btn--sm"
          title="Hide the file panel"
          aria-label="Hide the file panel"
          onClick={() => useStore.getState().toggleRight()}
        >
          <PanelBottomClose size={13} strokeWidth={2} />
        </button>
      </div>

      <div className="min-h-0 flex-1 border-t border-[color:var(--gm-hairline-soft)]">
        {mode === "editor" && editorPath ? (
          <EditorPane root={root} />
        ) : (
          <ExplorerPane root={root} embedded />
        )}
      </div>
    </div>
  );
}