import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, ChevronDown, File as FileIcon, Folder, RotateCcw, Search, X } from "lucide-react";
import { useStore } from "../store";
import { announceWrite } from "../announceWrite";
import { dragFile, notifyFileDrop } from "../dragFile";
import { errorDialog } from "../dialogs";
import { menuPos } from "../menuPos";
import { baseName, normSep, pathStartsRoot, relPath } from "../path";
import { PREF, numIn, readPref, writePref } from "../uiPrefs";
import { moveBuffer, syncEditorDirtyCount } from "../editor/buffers";
import type { FsNode, GrepHit } from "../types";

// The explorer is now purely the file tree: browsing, searching, renaming,
// and creating. Editing lives in the dock below the terminals, which has room
// to actually read code. Open a file with openEditor(); both panels follow.

const SEP = /[\\/]/;

function TreeNode({
  node,
  depth,
  onOpen,
  onMenu,
  renaming,
  renameDraft,
  setRenameDraft,
  onRenameCommit,
  onRenameCancel,
  bulkOpen,
  bulkN,
}: {
  node: FsNode;
  depth: number;
  onOpen: (path: string) => void;
  onMenu: (path: string, x: number, y: number) => void;
  renaming: string | null;
  renameDraft: string;
  setRenameDraft: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  bulkOpen: boolean;
  bulkN: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  // One counter drives collapse/expand-all; it also runs on mount so expand-all
  // reaches nested dirs that mount after their parent opens.
  useEffect(() => {
    if (bulkN > 0) setOpen(bulkOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkN]);
  const isDir = node.is_dir;
  const isRenaming = renaming === node.path;

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isDir ? open : undefined}
        className="gm-row flex cursor-pointer items-center gap-1.5 pr-2 text-body text-ink-300 hover:text-ink-100"
        style={{ paddingLeft: depth * 13 + 8, paddingTop: 3, paddingBottom: 3 }}
        onClick={() => (isDir ? setOpen(!open) : onOpen(node.path))}
        onKeyDown={(e) => {
          if (e.key === "F2") {
            e.preventDefault();
            onMenu(node.path, -1, -1);
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isDir) setOpen(!open);
            else onOpen(node.path);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(node.path, e.clientX, e.clientY);
        }}
        draggable={!isRenaming}
        onDragStart={() => {
          // HTML5 DnD never dispatches dragover in this webview (dragstart ->
          // dragend with dropEffect none and nothing between), so track the
          // pointer manually and paste on release over a terminal.
          // ponytail: pointer-based, no dataTransfer; drop if DnD ever works.
          (window as unknown as { __gmLastDrag?: string }).__gmLastDrag = node.path;
          dragFile.path = node.path;
        }}
        onDragEnd={(e) => {
          // Same JS context as the pane, so write the release point straight
          // to the terminal under it.
          try {
            const cx = (e as React.DragEvent).clientX;
            const cy = (e as React.DragEvent).clientY;
            const el = document.elementFromPoint(cx, cy);
            const host = el?.closest?.("[data-pane-drop]") as HTMLElement | null;
            const path = dragFile.path ?? (window as unknown as { __gmLastDrag?: string }).__gmLastDrag ?? null;
            if (path && host) notifyFileDrop(path, cx, cy);
          } catch {
            /* best-effort paste */
          }
          dragFile.path = null;
          (window as unknown as { __gmLastDrag?: string }).__gmLastDrag = undefined;
        }}
        title={node.path}
      >
        {isDir ? (
          <>
            <span className="w-3 shrink-0 text-ink-500">
              {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
            </span>
            <Folder size={13} className="shrink-0 text-ink-500" strokeWidth={2} />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <FileIcon size={13} className="shrink-0 text-ink-500" strokeWidth={2} />
          </>
        )}
        {isRenaming ? (
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameCommit();
              if (e.key === "Escape") onRenameCancel();
              e.stopPropagation();
            }}
            onBlur={onRenameCommit}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => {
              // Select the stem, not the extension, like VS Code.
              const dot = e.target.value.lastIndexOf(".");
              if (dot > 0) e.target.setSelectionRange(0, dot);
              else e.target.select();
            }}
            aria-label="Rename file"
            className="gm-field mono min-w-0 flex-1 px-1"
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
      </div>
      {isDir && open && (
        <>
          {node.children?.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              onOpen={onOpen}
              onMenu={onMenu}
              renaming={renaming}
              renameDraft={renameDraft}
              setRenameDraft={setRenameDraft}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
              bulkOpen={bulkOpen}
              bulkN={bulkN}
            />
          ))}
          {node.truncated && (
            <div className="gm-meta py-0.5 pl-6 text-label" title="Directory listing capped at 2000 entries">
              … truncated
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** `embedded` drops the rail behaviour (fixed width, vertical grip, title) so
 *  the tree can live in the bottom dock under the terminals. */
export function ExplorerPane({ root, embedded = false }: { root: string; embedded?: boolean }) {
  const openEditor = useStore((s) => s.openEditor);
  const [tree, setTree] = useState<FsNode | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [bulk, setBulk] = useState({ open: true, n: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [searching, setSearching] = useState(false);
  const rootRef = useRef(root);
  rootRef.current = root;
  const treeRequestRef = useRef(0);

  const refreshTree = () => {
    const request = ++treeRequestRef.current;
    const requestedRoot = root;
    invoke<FsNode>("fs_tree", { path: root, depth: 4 })
      .then((t) => {
        if (request !== treeRequestRef.current || normSep(requestedRoot) !== normSep(rootRef.current)) return;
        setTree(t);
      })
      .catch(() => {
        if (request !== treeRequestRef.current || normSep(requestedRoot) !== normSep(rootRef.current)) return;
        setTree(null);
      });
  };

  // External changes (git checkout, agent writes, another editor): the backend
  // coalesces raw notify events to one `fs-changed` per 600ms of quiet; this
  // side trails another 750ms so a burst still costs one walk.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let unlisten: (() => void) | null = null;
    // Live refresh stops silently if the watch cannot be armed, so say so
    // instead of leaving the tree looking merely stale.
    invoke("fs_watch", { path: root }).catch((e) => console.warn(`[gm-fs] watch failed for ${root}:`, e));
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ root: string }>("fs-changed", (ev) => {
          if (cancelled || normSep(ev.payload.root) !== normSep(root)) return;
          if (timer != null) clearTimeout(timer);
          timer = window.setTimeout(() => {
            timer = null;
            refreshTree();
          }, 750);
        }),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Content search over the worktree, debounced; needs 2+ chars.
  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    if (!searchOpen || q.length < 2) {
      setHits([]);
      setSearching(false);
      return () => {
        cancelled = true;
      };
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      invoke<GrepHit[]>("grep_search", { path: root, query: q })
        .then((h) => {
          if (cancelled) return;
          setHits(h);
          setSearching(false);
        })
        .catch(() => {
          if (cancelled) return;
          setHits([]);
          setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, searchOpen, root]);

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

  const commitRename = async () => {
    const oldPath = renaming;
    setRenaming(null);
    if (!oldPath) return;
    const name = renameDraft.trim();
    if (!name || name === baseName(oldPath)) return;
    if (SEP.test(name)) {
      void errorDialog("name cannot contain slashes");
      return;
    }
    const i = Math.max(oldPath.lastIndexOf("/"), oldPath.lastIndexOf("\\"));
    const newPath = oldPath.slice(0, i + 1) + name;
    announceWrite(oldPath, newPath);
    try {
      await invoke("fs_rename", { old: oldPath, new: newPath });
    } catch (e) {
      void errorDialog(`rename failed: ${e}`);
      return;
    }
    // A rename of the open file retargets both the buffer and the tab.
    moveBuffer(oldPath, newPath);
    syncEditorDirtyCount();
    if (useStore.getState().editorPath === oldPath) openEditor(newPath, false);
    refreshTree();
  };

  useEffect(() => {
    // Idle-deferred: fs_tree walks the disk and the shell burst owns startup;
    // the tree fills in right after without blocking first paint.
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    const id = ric
      ? ric.call(window, refreshTree, { timeout: 1500 })
      : window.setTimeout(refreshTree, 300);
    return () => {
      const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (cic) cic(id);
      else window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Tabs pointing outside this worktree drop; the survivor stays open instead
  // of bouncing back to the tree. Dirty ones need a decision first.
  useEffect(() => {
    setRenaming(null);
    setMenu(null);
    const st = useStore.getState();
    const outside = st.editorTabs.filter((path) => !pathStartsRoot(root, path));
    if (outside.length === 0) return;
    st.setEditorTabs(st.editorTabs.filter((path) => pathStartsRoot(root, path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const newFile = async () => {
    for (let i = 0; i < 100; i++) {
      const name = i === 0 ? "untitled" : `untitled-${i + 1}`;
      const path = `${root.replace(/[/\\]+$/, "")}/untitled`.replace(/[^/\\]*$/, "") + name;
      try {
        const created = await invoke<boolean>("fs_create_empty", { path });
        if (!created) continue;
        announceWrite(path);
        openEditor(path, false);
        setRenameDraft(baseName(path));
        setRenaming(path);
        return;
      } catch (e) {
        void errorDialog(`new file failed: ${e}`);
        return;
      }
    }
    void errorDialog("could not find an available new file name");
  };

  const [width, setWidth] = useState(() => readPref(PREF.explorerWidth, 248, numIn(200, 560)));
  const widthRef = useRef(width);
  widthRef.current = width;
  const onResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    // App-level CSS zoom scales clientX but not layout widths: divide the
    // cursor delta by uiZoom so the panel tracks the pointer 1:1.
    const zoom = useStore.getState().settings.uiZoom || 1;
    const startX = e.clientX;
    const startW = widthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      const nw = Math.min(560, Math.max(200, startW + (ev.clientX - startX) / zoom));
      widthRef.current = nw;
      setWidth(nw);
    };
    const up = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writePref(PREF.explorerWidth, Math.round(widthRef.current));
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const renameRowProps = {
    renaming,
    renameDraft,
    setRenameDraft,
    onRenameCommit: () => void commitRename(),
    onRenameCancel: () => setRenaming(null),
  };

  return (
    <div
      className={
        embedded
          ? "relative flex h-full min-w-0 flex-1 flex-col"
          : "relative flex h-full shrink-0 flex-col bg-surface-panel"
      }
      style={embedded ? undefined : { width }}
    >
      {/* The rail had a width and a right-edge grip. In the dock the tree
          takes the full width and the dock itself owns the height. */}
      {!embedded && (
        <div
          className="group absolute bottom-0 right-[-2.5px] top-0 z-20 w-[5px] cursor-col-resize"
          onMouseDown={onResizeDown}
          onDoubleClick={() => {
            widthRef.current = 248;
            setWidth(248);
            writePref(PREF.explorerWidth, 248);
          }}
          title="Drag to resize, double-click to reset"
        >
          <div className="mx-auto h-full w-[3px] rounded-full bg-[color:var(--gm-ink-mute)] opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      )}

      {/* Toolbar only when embedded: the dock header already names the root,
          so a second "Files" title just spent 28px saying it twice. */}
      <div
        className={`flex items-center justify-end gap-0.5 ${embedded ? "h-8 shrink-0 px-2" : "gm-rule px-3 pb-1 pt-2"}`}
      >
        {!embedded && <span className="gm-sect">Files</span>}
        <div className="flex items-center gap-0.5">
          <button
            title={bulk.open ? "Collapse all folders" : "Expand all folders"}
            aria-label={bulk.open ? "Collapse all folders" : "Expand all folders"}
            aria-pressed={bulk.open}
            data-active={bulk.open}
            className="gm-icon-btn gm-icon-btn--sm"
            onClick={() => setBulk((b) => ({ open: !b.open, n: b.n + 1 }))}
          >
            {bulk.open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
          </button>
          <button
            title="New file"
            aria-label="New file"
            className="gm-icon-btn gm-icon-btn--sm"
            onClick={() => void newFile()}
          >
            <FileIcon size={13} strokeWidth={2} />
            <span className="sr-only">New file</span>
          </button>
          <button
            title="Search file contents"
            aria-label="Search file contents"
            aria-pressed={searchOpen}
            data-active={searchOpen}
            className="gm-icon-btn gm-icon-btn--sm"
            onClick={() => setSearchOpen((o) => !o)}
          >
            <Search size={13} strokeWidth={2} />
          </button>
          <button
            title="Refresh file tree"
            aria-label="Refresh file tree"
            className="gm-icon-btn gm-icon-btn--sm"
            onClick={refreshTree}
          >
            <RotateCcw size={12} strokeWidth={2} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="gm-rule mx-3 mb-1 flex items-center gap-1.5">
          <Search size={12} strokeWidth={2} className="shrink-0 text-ink-500" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setQuery("");
              }
            }}
            placeholder="Search contents (2+ chars)"
            aria-label="Search file contents"
            className="w-full bg-transparent py-1.5 text-body text-ink-100 outline-none placeholder:text-ink-500"
          />
          {query && (
            <button
              className="gm-icon-btn gm-icon-btn--sm"
              onClick={() => setQuery("")}
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={11} strokeWidth={2} />
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {searchOpen && query.trim().length >= 2 ? (
          searching && hits.length === 0 ? (
            <div className="px-2 py-2 text-body text-ink-400">Searching…</div>
          ) : hits.length > 0 ? (
            <>
              <div className="gm-meta tnum px-2 py-1">
                {hits.length}
                {hits.length >= 100 ? "+" : ""} match{hits.length === 1 ? "" : "es"}
              </div>
              {hits.map((h, i) => (
                <div
                  key={`${h.path}:${h.lineno}:${i}`}
                  role="button"
                  tabIndex={0}
                  className="gm-row cursor-pointer px-2 py-1"
                  onClick={() => openEditor(h.path, false, h.lineno)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openEditor(h.path, false, h.lineno);
                    }
                  }}
                  title={`${h.path}:${h.lineno}`}
                >
                  <div className="mono truncate text-body text-ink-200">
                    {relPath(root, h.path)}
                    <span className="text-ink-500">:{h.lineno}</span>
                  </div>
                  <div className="mono truncate text-meta text-ink-400">{h.text}</div>
                </div>
              ))}
            </>
          ) : (
            <div className="px-2 py-2 text-body text-ink-400">No matches</div>
          )
        ) : tree?.children?.length ? (
          tree.children.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={0}
              onOpen={(p) => openEditor(p, false)}
              onMenu={(path, x, y) => {
                // Keyboard (F2) goes straight to inline rename; a pointer gets
                // the menu.
                if (x < 0 || y < 0) {
                  setMenu(null);
                  setRenameDraft(baseName(path));
                  setRenaming(path);
                  return;
                }
                setMenu({ x, y, path });
              }}
              {...renameRowProps}
              bulkOpen={bulk.open}
              bulkN={bulk.n}
            />
          ))
        ) : (
          <div className="px-2 py-2 text-body text-ink-400">No files</div>
        )}
      </div>

      {menu && (
        <div
          className="gm-menu tnum fixed z-50 w-40"
          style={menuPos(menu.x, menu.y, { w: 160, h: 44 }, {
            zoom: useStore.getState().settings.uiZoom || 1,
            w: window.innerWidth,
            h: window.innerHeight,
          })}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            className="gm-menu-item"
            role="menuitem"
            onClick={() => {
              setRenameDraft(baseName(menu.path));
              setRenaming(menu.path);
              setMenu(null);
            }}
          >
            Rename
          </button>
        </div>
      )}
    </div>
  );
}