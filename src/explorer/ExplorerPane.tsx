import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Editor from "@monaco-editor/react";
import { useStore } from "../store";
import { confirmDialog, errorDialog } from "../dialogs";
import { ChevronRight, ChevronDown, File as FileIcon, Folder, Save, FileDiff, X, FilePlus2, RotateCcw, Pencil } from "lucide-react";
import type { FsNode } from "../types";

// ponytail: all file icons share the muted tone; per-extension colors only
// when the tree needs type scanning at a glance.

const SEP = /[\\/]/;

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
}) {
  const [open, setOpen] = useState(depth < 1);
  const isDir = node.is_dir;
  const rel = node.path.slice(root.length + 1);
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
        onDragStart={(e) => {
          e.dataTransfer.setData("application/guimux-file-path", rel);
          e.dataTransfer.effectAllowed = "copy";
        }}
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
          <TreeNode key={c.path} node={c} depth={depth + 1} onOpen={onOpen} root={root} onMenu={onMenu} renaming={renaming} renameDraft={renameDraft} setRenameDraft={setRenameDraft} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel} />
        ))}
    </div>
  );
}

export function ExplorerPane({ root }: { root: string }) {
  const editorPath = useStore((s) => s.editorPath);
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

  const refreshTree = () => {
    invoke<FsNode>("fs_tree", { path: root, depth: 4 })
      .then((t) => setTree(t))
      .catch(() => setTree(null));
  };

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
    try {
      await invoke("fs_rename", { old: oldPath, new: newPath });
    } catch (e) {
      void errorDialog(`rename failed: ${e}`);
      return;
    }
    // Untitled flow: renaming the open file retargets the editor buffer.
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
  // clear the draft when switching roots.
  useEffect(() => {
    setRenaming(null);
    setMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  useEffect(() => {
    if (!editorPath) return;
    // Load in diff mode too: "Accept working-tree content" writes this buffer
    // back to disk, so it must hold real file content, never the initial "".
    invoke<string>("fs_read", { path: editorPath })
      .then((c) => {
        setContent(c);
        setSavedContent(c);
        setDirty(false);
        setContentLoaded(true);
      })
      .catch((e) => {
        setContent(`// cannot open: ${e}`);
        setSavedContent("");
        setDirty(false);
        setContentLoaded(false);
      });
  }, [editorPath]);

  // Ctrl+S anywhere while editing
  useEffect(() => {
    if (!editorPath || diffMode) return;
    const onKey = (e: KeyboardEvent) => {
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
    const rel = editorPath.slice(root.length + 1);
    return rel;
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
    try {
      await invoke("fs_write", { path: editorPath, content });
    } catch (e) {
      void errorDialog(`save failed: ${e}`);
      return;
    }
    setSavedContent(content);
    setDirty(false);
  };
  saveRef.current = () => void save();

  const revert = () => {
    setContent(savedContent);
    setDirty(false);
  };

  const closeEditorGuarded = async () => {
    if (dirty && !(await confirmDialog("Discard unsaved changes?"))) return;
    closeEditor();
  };

  const newFile = async () => {
    const p = `${root}/untitled`;
    try {
      await invoke("fs_read", { path: p });
    } catch {
      // doesn't exist yet: create it empty so the editor opens real content
      try {
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
      style={{
        left: Math.min(menu.x, window.innerWidth - 180),
        top: Math.min(menu.y, window.innerHeight - 80),
      }}
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

  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem("guimux-explorer-w"));
    return Number.isFinite(v) && v >= 220 && v <= 720 ? v : 256;
  });
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
      localStorage.setItem("guimux-explorer-w", String(Math.round(widthRef.current)));
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
            <button title="New file" aria-label="New file" className="gm-icon-btn gm-icon-btn--sm" onClick={() => void newFile()}>
              <FilePlus2 size={14} strokeWidth={2} />
            </button>
            <button title="Refresh file tree" aria-label="Refresh file tree" className="gm-icon-btn gm-icon-btn--sm" onClick={refreshTree}>
              <RotateCcw size={13} strokeWidth={2} />
            </button>
          </span>
        </div>
        <div className="gm-meta tnum truncate px-4 pb-2" title={root}>
          {root}
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {tree?.children?.length ? (
            tree.children.map((c) => (
              <TreeNode key={c.path} node={c} depth={0} onOpen={(p) => openEditor(p, false)} root={root} {...renameRowProps} />
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
        ) : (
          <Editor
            height="100%"
            language={language}
            theme="vs-dark"
            value={content}
            onChange={(v) => {
              setContent(v ?? "");
              setDirty(true);
            }}
            onMount={(editor, monaco) => {
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

// Wired per-render by the component so the Monaco Ctrl+S command saves
// the current buffer. Declared at module scope because onMount only fires once.
const saveRef: { current: () => void } = { current: () => {} };
