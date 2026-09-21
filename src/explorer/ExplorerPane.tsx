import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useStore } from "../store";
import { announceWrite } from "../announceWrite";
import { dragFile, notifyFileDrop } from "../dragFile";
import { confirmDialog, errorDialog } from "../dialogs";
import { menuPos } from "../menuPos";
import { PREF, numIn, readPref, writePref } from "../uiPrefs";
import { ChevronRight, ChevronDown, File as FileIcon, Folder, Save, FileDiff, X, FilePlus2, RotateCcw, Pencil, Search } from "lucide-react";
import { isMarkdownPath, renderMarkdown } from "./markdown";
import type { FsNode, GrepHit } from "../types";

// ponytail: all file icons share the muted tone; per-extension colors only
// when the tree needs type scanning at a glance.

const SEP = /[\\/]/;

// Unsaved buffers keyed by path: the pane remounts on every worktree switch
// (key={wt.id}), and local state alone took the user's edits with it.
const buffers = new Map<string, { content: string; saved: string; dirty: boolean }>();

// Tree paths mix separators (worktree roots use `/`, DirEntry adds `\`), so
// both comparisons below normalize before matching.
const normSep = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const inRoot = (root: string, p: string) => {
  const r = normSep(root);
  const n = normSep(p);
  return n === r || n.startsWith(r + "/");
};

function baseName(p: string): string {
  const parts = p.split(SEP);
  return parts[parts.length - 1] ?? p;
}

function siblingPath(oldPath: string, name: string): string {
  const i = Math.max(oldPath.lastIndexOf("/"), oldPath.lastIndexOf("\\"));
  const sep = oldPath.includes("\\") ? "\\" : "/";
  return (i < 0 ? name : oldPath.slice(0, i + 1) + name).replace(/\\/g, sep === "\\" ? "\\" : "/");
}

function TreeNode({
  node,
  depth,
  onOpen,
  root,
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
  root: string;
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
  // ponytail: one counter drives collapse/expand-all; it also runs on mount
  // so expand-all reaches nested dirs that mount after their parent opens.
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
        className="gm-row flex cursor-pointer items-center gap-1.5 px-1 py-[5px] text-[12.5px] text-ink-300 hover:text-ink-100"
        style={{ paddingLeft: depth * 14 + 6 }}
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
          // HTML5 DnD never dispatches dragover in this webview (see logs:
          // dragstart -> dragend with dropEffect none, nothing between), so
          // track the pointer manually and paste on release over a terminal.
          // ponytail: pointer-based, no dataTransfer; drop if DnD ever works.
          (window as unknown as { __gmLastDrag?: string }).__gmLastDrag = node.path;
          dragFile.path = node.path;
        }}
        onDragEnd={(e) => {
          // Pointer fallback: HTML5 drop never fires here, so paste on
          // release when the pointer is over a terminal pane. Same JS
          // context, so write straight to the pane's PTY.
          try {
            const cx = (e as React.DragEvent).clientX;
            const cy = (e as React.DragEvent).clientY;
            const el = document.elementFromPoint(cx, cy);
            const host = el?.closest?.("[data-pane-drop]") as HTMLElement | null;
            const path = dragFile.path ?? (window as unknown as { __gmLastDrag?: string }).__gmLastDrag ?? null;
            if (path && host) notifyFileDrop(path, cx, cy);
          } catch { /* best-effort paste */ }
          dragFile.path = null;
          (window as unknown as { __gmLastDrag?: string }).__gmLastDrag = undefined; }}
        title={`${node.path}\nRight-click to rename`}
      >
        {isDir ? (
          <>
            <span className="w-3 shrink-0 text-ink-500">
              {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
            </span>
            <Folder size={14} className="shrink-0 text-ink-500" strokeWidth={2} />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <FileIcon size={14} className="shrink-0 text-ink-500" strokeWidth={2} />
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
            className="mono min-w-0 flex-1 rounded border bg-ink-950 px-1 text-[12.5px] text-ink-100 outline-none"
            style={{ borderColor: "var(--gm-hairline)" }}
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
      </div>
      {isDir && open &&
        node.children?.map((c) => (
          <TreeNode key={c.path} node={c} depth={depth + 1} onOpen={onOpen} root={root} onMenu={onMenu} renaming={renaming} renameDraft={renameDraft} setRenameDraft={setRenameDraft} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel} bulkOpen={bulkOpen} bulkN={bulkN} />
        ))}
      {isDir && open && node.truncated && (
        <div className="gm-meta pl-5 py-0.5 text-[11px]" title="Directory listing capped at 2000 entries">
          … truncated
        </div>
      )}
    </div>
  );
}

export function ExplorerPane({ root }: { root: string }) {
  const editorPath = useStore((s) => s.editorPath);
  const editorTabs = useStore((s) => s.editorTabs);
  const diffMode = useStore((s) => s.diffMode);
  const openEditor = useStore((s) => s.openEditor);
  const closeEditor = useStore((s) => s.closeEditor);
  const editorFontSize = useStore((s) => s.settings.editorFontSize);
  const [tree, setTree] = useState<FsNode | null>(null);
  const [content, setContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [contentLoaded, setContentLoaded] = useState(false);
  const [gitDiff, setGitDiff] = useState<string>("");
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [bulk, setBulk] = useState({ open: true, n: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [searching, setSearching] = useState(false);
  // Jump-to-line after opening a search hit: applied once the editor mounts.
  const [reveal, setReveal] = useState<{ path: string; lineno: number } | null>(null);
  const [editorInstance, setEditorInstance] =
    useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  // Bundled Monaco is most of the app bundle: fetch it the first time a file
  // is opened rather than at boot, where it delayed the first shell. The
  // import configures the loader, so it must finish before Editor renders.
  const [monacoReady, setMonacoReady] = useState(false);
  const [monacoError, setMonacoError] = useState<string | null>(null);
  const [monacoRetry, setMonacoRetry] = useState(0);
  // Markdown preview: defaults on for .md files, toggled per-file.
  const [markdownPreview, setMarkdownPreview] = useState(true);
  useEffect(() => {
    // Skip Monaco load when markdown preview is active: saves bundle init
    // time. Monaco loads on first raw toggle.
    if (!editorPath || monacoReady || (markdownPreview && isMarkdownPath(editorPath))) return;
    let cancelled = false;
    setMonacoError(null);
    // No catch used to leave monacoReady false forever on failure, so a
    // rejected chunk (blocked CDN fallback, bad worker resolve) stranded
    // the pane on "Loading editor…" with no recovery.
    void import("../monaco").then(
      () => {
        if (!cancelled) setMonacoReady(true);
      },
      (e) => {
        if (cancelled) return;
        console.error("monaco load failed:", e);
        setMonacoError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [editorPath, monacoReady, monacoRetry, markdownPreview]);

  const refreshTree = () => {
    invoke<FsNode>("fs_tree", { path: root, depth: 4 })
      .then((t) => setTree(t))
      .catch(() => setTree(null));
  };

  // External changes (git checkout, agent writes, another editor): the
  // backend coalesces raw notify events to one `fs-changed` per 600ms of
  // quiet; this side trails another 750ms so a burst still costs one walk.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let unlisten: (() => void) | null = null;
    invoke("fs_watch", { path: root }).catch(() => {});
    listen<{ root: string }>("fs-changed", (ev) => {
      if (cancelled || normSep(ev.payload.root) !== normSep(root)) return;
      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        refreshTree();
      }, 750);
    })
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
    const q = query.trim();
    if (!searchOpen || q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      invoke<GrepHit[]>("grep_search", { path: root, query: q })
        .then((h) => {
          setHits(h);
          setSearching(false);
        })
        .catch(() => {
          setHits([]);
          setSearching(false);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [query, searchOpen, root]);

  // A search hit opens its file first; reveal the line once the editor holds it.
  useEffect(() => {
    if (!reveal || editorPath !== reveal.path || !editorInstance) return;
    try {
      editorInstance.revealLineInCenter(reveal.lineno);
      editorInstance.setPosition({ lineNumber: reveal.lineno, column: 1 });
    } catch {
      /* disposed mid-open */
    }
    setReveal(null);
  }, [reveal, editorPath, editorInstance]);

  // Click anywhere or Escape dismisses the file context menu.
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

  // A rename that targets the open file while the editor covers the tree
  // renames through the header input instead (same state, same commit).
  const startRename = (path: string) => {
    setMenu(null);
    setRenaming(path);
    setRenameDraft(baseName(path));
  };

  const openMenu = (path: string, x: number, y: number) => {
    // Keyboard (F2) goes straight to inline rename; pointer gets the menu.
    if (x < 0 || y < 0) {
      startRename(path);
      return;
    }
    setMenu({ x, y, path });
  };

  const commitRename = async () => {
    const oldPath = renaming;
    if (!oldPath) return;
    const name = renameDraft.trim();
    if (!name || name === baseName(oldPath)) {
      setRenaming(null);
      return;
    }
    if (SEP.test(name)) {
      void errorDialog("name cannot contain slashes");
      return;
    }
    const newPath = siblingPath(oldPath, name);
    setRenaming(null);
    announceWrite(oldPath, newPath);
    try {
      await invoke("fs_rename", { old: oldPath, new: newPath });
    } catch (e) {
      void errorDialog(`rename failed: ${e}`);
      return;
    }
    // Untitled flow: renaming the open file retargets the editor buffer.
    const buffered = buffers.get(oldPath);
    if (buffered) {
      buffers.delete(oldPath);
      buffers.set(newPath, buffered);
    }
    if (editorPath === oldPath) openEditor(newPath, diffMode);
    refreshTree();
  };

  useEffect(() => {
    // Idle-deferred: fs_tree walks the disk and the shell burst owns
    // startup; the tree fills in right after without blocking first paint.
    const schedule = (cb: () => void) => {
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) return ric.call(window, cb, { timeout: 1500 });
      return window.setTimeout(cb, 300);
    };
    const id = schedule(refreshTree);
    return () => {
      const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (cic) cic(id as number);
      else window.clearTimeout(id as number);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Renaming a file out from under the URL bar input leaves a stale path;
  // clear the draft when switching roots. Tabs outside the new root drop;
  // the survivor (if any) stays open instead of bouncing back to the tree.
  useEffect(() => {
    setRenaming(null);
    setMenu(null);
    const st = useStore.getState();
    const open = st.editorPath;
    if (open && !inRoot(root, open)) {
      st.setEditorTabs(st.editorTabs.filter((t) => inRoot(root, t)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  useEffect(() => {
    if (!editorPath) return;
    // A dirty buffer outranks disk: this is the remount that used to lose it.
    const cached = buffers.get(editorPath);
    if (cached?.dirty) {
      setContent(cached.content);
      setSavedContent(cached.saved);
      setDirty(true);
      setContentLoaded(true);
      return;
    }
    // Load in diff mode too: "Accept working-tree content" writes this buffer
    // back to disk, so it must hold real file content, never the initial "".
    // Guarded: switching files mid-read let the stale response overwrite the
    // new file's content.
    let cancelled = false;
    setContentLoaded(false);
    invoke<string>("fs_read", { path: editorPath })
      .then((c) => {
        if (cancelled) return;
        setContent(c);
        setSavedContent(c);
        setDirty(false);
        setContentLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setContent(`// cannot open: ${e}`);
        setSavedContent("");
        setDirty(false);
        setContentLoaded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editorPath]);

  // Ctrl+S anywhere while editing (never from a focused terminal: the
  // shell owns that key, and DC3 would silently pause output via XOFF).
  // Mirror only unsaved buffers: a clean one reloads from disk, and keeping
  // every opened file in memory would grow without bound.
  useEffect(() => {
    if (!editorPath) return;
    if (dirty) buffers.set(editorPath, { content, saved: savedContent, dirty: true });
    else buffers.delete(editorPath);
  }, [editorPath, content, savedContent, dirty]);

  useEffect(() => {
    if (!editorPath || diffMode) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorPath, diffMode, content]);

  useEffect(() => {
    if (!editorPath || !diffMode) return;
    // Diff-only: the old effect ran `git diff` on every file open even when
    // the diff view was never shown, adding a spawn to the startup path.
    invoke<string>("git_diff", { path: root, base: null })
      .then(setGitDiff)
      .catch(() => setGitDiff(""));
  }, [root, editorPath, diffMode]);

  const shortName = useMemo(() => {
    if (!editorPath) return "";
    const r = normSep(root);
    const p = normSep(editorPath);
    return p.startsWith(r + "/") ? p.slice(r.length + 1) : p;
  }, [editorPath, root]);

  const language = useMemo(() => {
    const ext = editorPath?.split(".").pop() ?? "";
    const map: Record<string, string> = {
      ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
      rs: "rust", py: "python", json: "json", md: "markdown", css: "css",
      html: "html", toml: "ini", yml: "yaml", yaml: "yaml",
    };
    return map[ext] ?? "plaintext";
  }, [editorPath]);

  const save = async () => {
    if (!editorPath) return;
    announceWrite(editorPath);
    try {
      await invoke("fs_write", { path: editorPath, content });
    } catch (e) {
      void errorDialog(`save failed: ${e}`);
      return;
    }
    setSavedContent(content);
    setDirty(false);
    // Own writes land through the watcher too, but a save can also create
    // the file (untitled flow): refresh at once instead of waiting out the
    // coalesce window.
    refreshTree();
  };
  // Monaco's Ctrl+S handler is registered once in onMount, so it reads the
  // current save through a ref instead of a stale closure.
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveRef.current = () => void save();
  });

  const revert = () => {
    setContent(savedContent);
    setDirty(false);
  };

  const closeEditorGuarded = async (path?: string) => {
    const target = path ?? editorPath;
    if (!target) return;
    // Live edits mirror into `buffers` on render; check both so a close
    // issued between keystroke and mirror still guards.
    const isDirty = buffers.get(target)?.dirty || (target === editorPath && dirty);
    if (isDirty && !(await confirmDialog("Discard unsaved changes?"))) return;
    buffers.delete(target);
    closeEditor(target);
  };

  const tabName = (p: string) => {
    const r = normSep(root);
    const n = normSep(p);
    const rel = n.startsWith(r + "/") ? n.slice(r.length + 1) : n;
    return rel.split("/").pop() ?? rel;
  };

  const newFile = async () => {
    const p = `${root}/untitled`;
    try {
      await invoke("fs_read", { path: p });
    } catch {
      // doesn't exist yet: create it empty so the editor opens real content
      try {
        announceWrite(p);
        await invoke("fs_write", { path: p, content: "" });
      } catch {
        /* fall through: editor will show the read error */
      }
    }
    openEditor(p, false);
    // The editor covers the tree, so the rename affordance lives in the
    // header pencil: start there immediately for the fresh untitled file.
    startRename(p);
  };

  const renameRowProps = {
    onMenu: openMenu,
    renaming,
    renameDraft,
    setRenameDraft,
    onRenameCommit: () => void commitRename(),
    onRenameCancel: () => setRenaming(null),
  };

  const menuEl = menu && (
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
        onClick={() => startRename(menu.path)}
        role="menuitem"
      >
        Rename
      </button>
    </div>
  );

  const [width, setWidth] = useState(() => readPref(PREF.explorerWidth, 256, numIn(220, 720)));
  const widthRef = useRef(width);
  widthRef.current = width;
  const onResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const zoom = useStore.getState().settings.uiZoom || 1;
    const startX = e.clientX;
    const startW = widthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      const nw = Math.min(720, Math.max(220, startW - (ev.clientX - startX) / zoom));
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

  if (!editorPath) {
    return (
      <div className="relative flex h-full shrink-0 flex-col bg-ink-900" style={{ width, borderLeft: "1px solid var(--gm-hairline-soft)" }}>
        <div
          className="group absolute bottom-0 left-[-2.5px] top-0 z-20 w-[5px] cursor-col-resize"
          onMouseDown={onResizeDown}
          title="Drag to resize"
        >
          <div
            className="mx-auto h-full w-[3px] rounded-full opacity-0 transition-opacity group-hover:opacity-100"
            style={{ background: "var(--gm-ink-mute)" }}
          />
        </div>
        <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">Explorer</span>
          <span className="flex gap-0.5">
            <button title={bulk.open ? "Collapse all folders" : "Expand all folders"} aria-label={bulk.open ? "Collapse all folders" : "Expand all folders"} aria-pressed={bulk.open} data-active={bulk.open} className="gm-icon-btn gm-icon-btn--sm" onClick={() => setBulk((b) => ({ open: !b.open, n: b.n + 1 }))}>
              {bulk.open ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
            </button>
            <button title="New file" aria-label="New file" className="gm-icon-btn gm-icon-btn--sm" onClick={() => void newFile()}>
              <FilePlus2 size={14} strokeWidth={2} />
            </button>
            <button title="Search file contents" aria-label="Search file contents" aria-pressed={searchOpen} data-active={searchOpen} className="gm-icon-btn gm-icon-btn--sm" onClick={() => setSearchOpen((o) => !o)}>
              <Search size={14} strokeWidth={2} />
            </button>
            <button title="Refresh file tree" aria-label="Refresh file tree" className="gm-icon-btn gm-icon-btn--sm" onClick={refreshTree}>
              <RotateCcw size={13} strokeWidth={2} />
            </button>
          </span>
        </div>
        <div className="gm-meta tnum truncate px-4 pb-2" title={root}>
          {root}
        </div>
        {searchOpen && (
          <div className="mx-4 mb-1 flex items-center gap-1.5" style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}>
            <Search size={13} strokeWidth={2} className="shrink-0 text-ink-500" />
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
              className="w-full bg-transparent py-2 text-[12px] text-ink-100 outline-none placeholder:text-ink-500"
            />
            {query && (
              <button
                className="gm-icon-btn gm-icon-btn--sm"
                onClick={() => setQuery("")}
                title="Clear search"
                aria-label="Clear search"
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {searchOpen && query.trim().length >= 2 ? (
            searching && hits.length === 0 ? (
              <div className="px-2.5 py-2 text-[12px] text-ink-400">Searching…</div>
            ) : hits.length > 0 ? (
              <>
                <div className="gm-meta tnum px-2.5 py-1">
                  {hits.length}{hits.length >= 100 ? "+" : ""} match{hits.length === 1 ? "" : "es"}
                </div>
                {hits.map((h, i) => {
                  const rel = normSep(h.path).startsWith(normSep(root) + "/")
                    ? normSep(h.path).slice(normSep(root).length + 1)
                    : h.path;
                  const openHit = () => {
                    openEditor(h.path, false);
                    setReveal({ path: h.path, lineno: h.lineno });
                  };
                  return (
                    <div
                      key={`${h.path}:${h.lineno}:${i}`}
                      role="button"
                      tabIndex={0}
                      className="gm-row cursor-pointer px-2.5 py-[5px]"
                      onClick={openHit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openHit();
                        }
                      }}
                      title={`${h.path}:${h.lineno}`}
                    >
                      <div className="mono truncate text-[12px] text-ink-200">
                        {rel}
                        <span className="text-ink-500">:{h.lineno}</span>
                      </div>
                      <div className="mono truncate text-[11px] text-ink-400">{h.text}</div>
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="px-2.5 py-2 text-[12px] text-ink-400">No matches</div>
            )
          ) : tree?.children?.length ? (
            tree.children.map((c) => (
              <TreeNode key={c.path} node={c} depth={0} onOpen={(p) => openEditor(p, false)} root={root} {...renameRowProps} bulkOpen={bulk.open} bulkN={bulk.n} />
            ))
          ) : (
            <div className="px-2.5 py-2 text-[12px] text-ink-400">No files</div>
          )}
        </div>
        <div className="gm-meta px-4 py-2.5">
          Right-click a file to rename · drag into a terminal to paste its path
        </div>
        {menuEl}
      </div>
    );
  }

  const renamingOpenFile = renaming === editorPath;

  return (
    <div className="relative flex h-full max-w-[60vw] shrink-0 flex-col bg-ink-900" style={{ width: Math.max(width, 400), borderLeft: "1px solid var(--gm-hairline-soft)" }}>
      <div
        className="group absolute bottom-0 left-[-2.5px] top-0 z-20 w-[5px] cursor-col-resize"
        onMouseDown={onResizeDown}
        title="Drag to resize"
      >
        <div
          className="mx-auto h-full w-[3px] rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: "var(--gm-ink-mute)" }}
        />
      </div>
      {editorTabs.length > 1 && (
        <div
          className="flex items-center gap-0.5 overflow-x-auto px-2 pt-1.5"
          role="tablist"
          aria-label="Open files"
          style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}
        >
          {editorTabs.map((t) => {
            const active = t === editorPath;
            return (
              <div
                key={t}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                title={t}
                onClick={() => openEditor(t, false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openEditor(t, false);
                  }
                }}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 py-1.5 text-[12px] ${
                  active ? "font-semibold text-ink-100" : "font-medium text-ink-400 hover:text-ink-200"
                }`}
                style={active ? { background: "rgba(255,255,255,0.04)" } : undefined}
              >
                <span className="max-w-[140px] truncate">{tabName(t)}</span>
                {buffers.get(t)?.dirty && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: "var(--gm-amber)" }}
                    title="Unsaved changes"
                  />
                )}
                <button
                  className={`gm-icon-btn gm-icon-btn--sm -mr-1 focus-visible:opacity-100 ${active ? "" : "opacity-0 hover:opacity-100"}`}
                  title={`Close ${tabName(t)}`}
                  aria-label={`Close ${tabName(t)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeEditorGuarded(t);
                  }}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div
        className="flex items-center justify-between gap-2 px-2.5 py-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <button className="gm-icon-btn gm-icon-btn--sm" onClick={() => void closeEditorGuarded()} title="Close editor (back to tree)">
            <X size={14} strokeWidth={2} />
          </button>
          <FileIcon size={14} strokeWidth={2} className="shrink-0 text-ink-500" />
          {renamingOpenFile ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenaming(null);
                e.stopPropagation();
              }}
              onBlur={() => void commitRename()}
              onFocus={(e) => {
                const dot = e.target.value.lastIndexOf(".");
                if (dot > 0) e.target.setSelectionRange(0, dot);
                else e.target.select();
              }}
              aria-label="Rename open file"
              className="mono min-w-0 flex-1 rounded border bg-ink-950 px-1 text-[12.5px] text-ink-100 outline-none"
              style={{ borderColor: "var(--gm-hairline)" }}
            />
          ) : (
            <span className="truncate text-[12.5px] font-medium text-ink-100" title={editorPath}>
              {shortName}
            </span>
          )}
          {dirty ? (
            <span className="tnum shrink-0 text-[11px] font-semibold" style={{ color: "var(--gm-amber)" }}>edited</span>
          ) : (
            <span className="gm-meta tnum shrink-0">saved</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!diffMode && (
            <>
              <button
                title="Rename file (F2)"
                aria-label="Rename file"
                className="gm-icon-btn gm-icon-btn--sm"
                onClick={() => editorPath && startRename(editorPath)}
              >
                <Pencil size={14} strokeWidth={2} />
              </button>
              {isMarkdownPath(editorPath ?? "") && (
                <div className="gm-seg" role="radiogroup" aria-label="Markdown view">
                  <button
                    role="radio"
                    aria-checked={!markdownPreview}
                    data-active={String(!markdownPreview)}
                    title="Show raw source"
                    onClick={() => setMarkdownPreview(false)}
                  >
                    Raw
                  </button>
                  <button
                    role="radio"
                    aria-checked={markdownPreview}
                    data-active={String(markdownPreview)}
                    title="Show rendered markdown"
                    onClick={() => setMarkdownPreview(true)}
                  >
                    Markdown
                  </button>
                </div>
              )}
              <button
                title="Toggle diff"
                className="gm-icon-btn gm-icon-btn--sm"
                onClick={() => openEditor(editorPath, true)}
              >
                <FileDiff size={14} strokeWidth={2} />
              </button>
              {dirty && (
                <button
                  title="Revert"
                  className="gm-icon-btn gm-icon-btn--sm"
                  onClick={revert}
                >
                  <RotateCcw size={13} strokeWidth={2} />
                </button>
              )}
              <button
                title="Save (Ctrl+S)"
                className="gm-icon-btn ml-1 h-[30px] gap-1.5 px-3 text-[12px] font-semibold"
                style={
                  dirty
                    ? { background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }
                    : { color: "var(--gm-ink-faint)" }
                }
                onClick={save}
              >
                <Save size={13} strokeWidth={2} /> Save
              </button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {diffMode ? (
          <div className="flex h-full flex-col">
            <div className="tnum gm-meta flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--gm-green)" }} /> added</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--gm-red)" }} /> removed</span>
              <span className="flex-1" />
              <span className="mono">{shortName}</span>
            </div>
            <div className="flex-1 overflow-auto bg-ink-950 p-2">
              <pre className="mono select-text whitespace-pre-wrap text-[11.5px] leading-5">
                {gitDiff.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className="rounded-sm px-2"
                    style={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? { background: "rgba(129,184,139,0.1)", color: "var(--gm-green)" }
                        : line.startsWith("-") && !line.startsWith("---")
                          ? { background: "rgba(199,78,57,0.11)", color: "var(--gm-red)" }
                          : line.startsWith("@@")
                            ? { color: "var(--gm-ink-dim)" }
                            : line.startsWith("diff ") || line.startsWith("index ")
                              ? { color: "var(--gm-ink-mute)" }
                              : { color: "var(--gm-ink-dim)" }
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            </div>
            <div className="p-2.5" style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}>
              <button
                disabled={!contentLoaded}
                title={contentLoaded ? undefined : "File content could not be loaded — open it in the editor instead"}
                className="w-full rounded-md py-2 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--gm-accent)", color: "var(--gm-accent-ink)" }}
                onClick={async () => {
                  if (editorPath && contentLoaded) {
                    try {
                      announceWrite(editorPath);
                      await invoke("fs_write", { path: editorPath, content });
                    } catch (e) {
                      void errorDialog(`save failed: ${e}`);
                      return;
                    }
                  }
                  closeEditor();
                }}
              >
                Accept working-tree content
              </button>
            </div>
          </div>
        ) : markdownPreview && isMarkdownPath(editorPath ?? "") ? (
          <div
            className="gm-md-preview"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        ) : !monacoReady ? (
          monacoError ? (
            <div className="gm-meta p-3 text-[12px]">
              Editor failed to load ({monacoError}).{" "}
              <button className="underline" onClick={() => setMonacoRetry((n) => n + 1)}>
                Retry
              </button>
            </div>
          ) : (
            <div className="gm-meta p-3 text-[12px]">Loading editor…</div>
          )
        ) : (
          <Editor
            height="100%"
            // One model per file: without a path every file shared Monaco's
            // default model, so Ctrl+Z could restore another file's text.
            path={normSep(editorPath ?? "")}
            language={language}
            theme="vs-dark"
            value={content}
            loading={<div className="gm-meta p-3 text-[12px]">Loading editor…</div>}
            onChange={(v) => {
              setContent(v ?? "");
              setDirty(true);
            }}
            onMount={(editor, monaco) => {
              // Instance in state (not a ref): setting it re-renders, which
              // is what lets a pending search-hit reveal fire on first mount.
              setEditorInstance(editor);
              monaco.editor.defineTheme("guimux-dark", {
                base: "vs-dark",
                inherit: true,
                rules: [],
                colors: {
                  "editor.background": "#0a0a0a",
                  "editor.lineHighlightBackground": "#ffffff08",
                  "editorLineNumber.foreground": "#737373",
                  "editorLineNumber.activeForeground": "#e5e5e5",
                  "editorCursor.foreground": "#e5e5e5",
                  "editor.selectionBackground": "#e5e5e545",
                  "editorWidget.background": "#171717",
                  "editorWidget.border": "#ffffff12",
                },
              });
              monaco.editor.setTheme("guimux-dark");
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                void saveRef.current();
              });
            }}
            options={{
              fontSize: editorFontSize,
              fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontLigatures: false,
              lineHeight: 1.6,
              minimap: { enabled: false },
              automaticLayout: true,
              padding: { top: 10 },
              renderLineHighlight: "all",
              scrollBeyondLastLine: false,
              smoothScrolling: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
