import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  ChevronRight,
  File as FileIcon,
  FileDiff,
  Pencil,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { announceWrite } from "../announceWrite";
import { confirmDialog, errorDialog } from "../dialogs";
import { baseName, pathSegments, pathStartsRoot, relPath } from "../path";
import { isMarkdownPath, renderMarkdown } from "../explorer/markdown";
import { canSaveBuffer, confirmUnsavedDiscard } from "../explorer/editorBuffer";
import { buffers, dropBuffer, moveBuffer, syncEditorDirtyCount } from "./buffers";

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  rs: "rust", py: "python", json: "json", md: "markdown", css: "css",
  html: "html", toml: "ini", yml: "yaml", yaml: "yaml",
};

function languageFor(path: string | null): string {
  const ext = path?.split(".").pop() ?? "";
  return LANGUAGES[ext] ?? "plaintext";
}

/**
 * The file editor: tabs across the top, breadcrumb + actions below, content
 * filling the rest. Sized by its parent dock rather than a side rail, because
 * a 260px column was never enough to read code in.
 */
export function EditorPane({ root }: { root: string }) {
  const editorPath = useStore((s) => s.editorPath);
  const editorTabs = useStore((s) => s.editorTabs);
  const diffMode = useStore((s) => s.diffMode);
  const openEditor = useStore((s) => s.openEditor);
  const closeEditor = useStore((s) => s.closeEditor);
  const editorFontSize = useStore((s) => s.settings.editorFontSize);

  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [contentLoaded, setContentLoaded] = useState(false);
  const [gitDiff, setGitDiff] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const loadedPathRef = useRef<string | null>(null);
  const editorPathRef = useRef(editorPath);
  editorPathRef.current = editorPath;
  // Markdown preview defaults on for .md files; the raw toggle loads Monaco.
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const reveal = useStore((s) => s.editorReveal);
  const [editorInstance, setEditorInstance] =
    useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  // Bundled Monaco is most of the app bundle: fetch it the first time a file
  // actually needs it, rather than at boot where it delayed the first shell.
  const [monacoReady, setMonacoReady] = useState(false);
  const [monacoError, setMonacoError] = useState<string | null>(null);
  const [monacoRetry, setMonacoRetry] = useState(0);

  useEffect(() => {
    if (!editorPath || monacoReady || (markdownPreview && isMarkdownPath(editorPath))) return;
    let cancelled = false;
    setMonacoError(null);
    // A rejected chunk used to strand the pane on "Loading editor…" with no
    // recovery, so the failure has a visible message and a retry.
    void import("../monaco").then(
      () => !cancelled && setMonacoReady(true),
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

  useEffect(() => {
    if (!editorPath) return;
    // A dirty buffer outranks disk: this is the remount that used to lose it.
    const cached = buffers.get(editorPath);
    if (cached?.dirty) {
      loadedPathRef.current = editorPath;
      setContent(cached.content);
      setSavedContent(cached.saved);
      setDirty(true);
      setContentLoaded(true);
      return;
    }
    let cancelled = false;
    loadedPathRef.current = null;
    setContent("");
    setSavedContent("");
    setDirty(false);
    setContentLoaded(false);
    invoke<string>("fs_read", { path: editorPath })
      .then((c) => {
        if (cancelled) return;
        loadedPathRef.current = editorPath;
        setContent(c);
        setSavedContent(c);
        setDirty(false);
        setContentLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        loadedPathRef.current = null;
        setContent(`// cannot open: ${e}`);
        setSavedContent("");
        setDirty(false);
        setContentLoaded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editorPath]);

  // Mirror live edits into the shared buffer so a switch cannot lose them,
  // and so the close guard sees an edit issued between keystroke and mirror.
  useEffect(() => {
    if (!editorPath || !canSaveBuffer(editorPath, loadedPathRef.current)) return;
    if (dirty) buffers.set(editorPath, { content, saved: savedContent, dirty: true });
    else buffers.delete(editorPath);
    syncEditorDirtyCount();
  }, [editorPath, content, savedContent, dirty]);

  const save = async () => {
    if (!editorPath) return;
    if (!canSaveBuffer(editorPath, loadedPathRef.current)) {
      void errorDialog("Save blocked: file content is not loaded");
      return;
    }
    const path = editorPath;
    const nextContent = content;
    announceWrite(path);
    try {
      await invoke("fs_write_checked", { path, content: nextContent, expected: savedContent });
    } catch (e) {
      void errorDialog(`save failed: ${e}`);
      return;
    }
    dropBuffer(path);
    if (editorPathRef.current === path) {
      setSavedContent(nextContent);
      setDirty(false);
    }
  };

  // Monaco registers Ctrl+S once, so it reads the current save through a ref
  // rather than a closure captured at mount.
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveRef.current = () => void save();
  });

  // Ctrl+S from the editor only: a focused terminal owns that key, and DC3
  // would silently pause output via XOFF.
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
  }, [editorPath, diffMode, content]);

  useEffect(() => {
    if (!editorPath || !diffMode) return;
    let cancelled = false;
    setGitDiff("");
    invoke<string>("git_diff", { path: root, base: null, file: editorPath })
      .then((diff) => !cancelled && setGitDiff(diff))
      .catch(() => !cancelled && setGitDiff(""));
    return () => {
      cancelled = true;
    };
  }, [root, editorPath, diffMode]);

  // A search hit asks for a line; apply it once the editor actually holds the
  // file, then clear so switching tabs back does not re-jump.
  useEffect(() => {
    if (!reveal || !editorInstance || !editorPath) return;
    try {
      editorInstance.revealLineInCenter(reveal);
      editorInstance.setPosition({ lineNumber: reveal, column: 1 });
    } catch {
      /* disposed mid-open */
    }
    useStore.getState().consumeReveal();
  }, [reveal, editorPath, editorInstance]);

  const closeGuarded = async (path?: string | null) => {
    const target = path ?? editorPath;
    if (!target) return;
    const isDirty = buffers.get(target)?.dirty || (target === editorPath && dirty);
    if (isDirty && !(await confirmUnsavedDiscard(1, confirmDialog, "close this file"))) return;
    dropBuffer(target);
    closeEditor(target);
  };

  const commitRename = async () => {
    const oldPath = editorPath;
    setRenaming(false);
    if (!oldPath) return;
    const name = renameDraft.trim();
    if (!name || name === baseName(oldPath)) return;
    if (/[\\/]/.test(name)) {
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
    moveBuffer(oldPath, newPath);
    openEditor(newPath, diffMode);
  };

  const tabs = useMemo(() => editorTabs.filter((t) => pathStartsRoot(root, t)), [editorTabs, root]);
  const breadcrumbs = editorPath ? pathSegments(root, editorPath) : [];
  const showPreview = !!editorPath && markdownPreview && isMarkdownPath(editorPath);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-canvas">
      {tabs.length > 1 && (
        <div className="gm-rule flex items-stretch overflow-x-auto" role="tablist" aria-label="Open files">
          {tabs.map((t) => {
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
                className={`group/tab flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-[color:var(--gm-hairline-soft)] px-3 py-1.5 text-meta ${
                  active
                    ? "bg-surface-raised text-ink-100"
                    : "text-ink-400 hover:bg-[color:var(--gm-hover)] hover:text-ink-200"
                }`}
              >
                <span className="max-w-[140px] truncate">{baseName(t)}</span>
                {buffers.get(t)?.dirty && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--gm-amber)]" title="Unsaved changes" />
                )}
                <button
                  className="gm-icon-btn gm-icon-btn--sm -mr-1.5 !h-5 !min-w-5 !px-0 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100"
                  title={`Close ${baseName(t)}`}
                  aria-label={`Close ${baseName(t)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeGuarded(t);
                  }}
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* breadcrumb + actions: where you are, then what you can do here */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {renaming ? (
            <input
              autoFocus
              className="gm-field mono flex-1 px-1 text-body"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenaming(false);
                e.stopPropagation();
              }}
              onBlur={() => void commitRename()}
              onFocus={(e) => {
                // Select the stem, not the extension, like VS Code.
                const dot = e.target.value.lastIndexOf(".");
                if (dot > 0) e.target.setSelectionRange(0, dot);
                else e.target.select();
              }}
              aria-label="Rename open file"
            />
          ) : (
            <>
              <FileIcon size={13} strokeWidth={2} className="shrink-0 text-ink-500" />
              {breadcrumbs.length > 0 && (
                <span className="hidden shrink-0 items-center gap-1 text-meta text-ink-500 sm:flex">
                  {breadcrumbs.map((seg) => (
                    <span key={seg} className="flex items-center gap-1">
                      <ChevronRight size={10} strokeWidth={2} />
                      {seg}
                    </span>
                  ))}
                </span>
              )}
              <span className="truncate text-body font-medium text-ink-100" title={editorPath ?? ""}>
                {editorPath ? baseName(editorPath) : ""}
              </span>
            </>
          )}
        </div>

        {!contentLoaded ? (
          <span className="tnum shrink-0 text-meta font-semibold text-[color:var(--gm-amber)]">
            not loaded
          </span>
        ) : dirty ? (
          <span className="tnum shrink-0 text-meta font-semibold text-[color:var(--gm-amber)]">
            edited
          </span>
        ) : (
          <span className="gm-meta tnum shrink-0">saved</span>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          {!diffMode && (
            <>
              <button
                title="Rename file (F2)"
                aria-label="Rename file"
                className="gm-icon-btn gm-icon-btn--sm"
                onClick={() => {
                  if (!editorPath) return;
                  setRenameDraft(baseName(editorPath));
                  setRenaming(true);
                }}
              >
                <Pencil size={13} strokeWidth={2} />
              </button>
              <button
                title="Close editor"
                aria-label="Close editor"
                className="gm-icon-btn gm-icon-btn--sm"
                onClick={() => void closeGuarded()}
              >
                <X size={13} strokeWidth={2} />
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
                aria-label="Toggle diff"
                className="gm-icon-btn gm-icon-btn--sm"
                onClick={() => editorPath && openEditor(editorPath, true)}
              >
                <FileDiff size={13} strokeWidth={2} />
              </button>
              {dirty && (
                <button title="Revert" aria-label="Revert" className="gm-icon-btn gm-icon-btn--sm" onClick={() => {
                  setContent(savedContent);
                  setDirty(false);
                }}>
                  <RotateCcw size={13} strokeWidth={2} />
                </button>
              )}
              <button
                title="Save (Ctrl+S)"
                aria-label="Save"
                disabled={!contentLoaded}
                className={`gm-icon-btn ml-1 !h-ctl gap-1.5 px-3 text-body font-semibold ${
                  dirty ? "gm-btn" : "text-ink-500"
                }`}
                onClick={() => void save()}
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
            <div className="tnum gm-meta gm-rule flex items-center gap-3 px-3 py-1.5">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-[color:var(--gm-green)]" /> added
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-[color:var(--gm-red)]" /> removed
              </span>
              <span className="flex-1" />
              <span className="mono truncate">{editorPath ? relPath(root, editorPath) : ""}</span>
            </div>
            <div className="flex-1 overflow-auto p-2">
              <pre className="mono select-text whitespace-pre-wrap text-meta leading-5">
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
                            : { color: "var(--gm-ink-mute)" }
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            </div>
            <div className="gm-rule-top p-2">
              <button
                disabled={!contentLoaded}
                title={contentLoaded ? undefined : "File content could not be loaded — open it in the editor instead"}
                className="gm-btn w-full py-1.5 text-body"
                onClick={async () => {
                  const path = editorPath;
                  if (path && canSaveBuffer(path, loadedPathRef.current)) {
                    const nextContent = content;
                    try {
                      announceWrite(path);
                      await invoke("fs_write_checked", { path, content: nextContent, expected: savedContent });
                    } catch (e) {
                      void errorDialog(`save failed: ${e}`);
                      return;
                    }
                    dropBuffer(path);
                  }
                  closeEditor();
                }}
              >
                Accept working-tree content
              </button>
            </div>
          </div>
        ) : showPreview ? (
          <div className="gm-md-preview h-full" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        ) : !monacoReady ? (
          monacoError ? (
            <div className="gm-meta p-3 text-body">
              Editor failed to load ({monacoError}).{" "}
              <button className="underline" onClick={() => setMonacoRetry((n) => n + 1)}>
                Retry
              </button>
            </div>
          ) : (
            <div className="gm-meta p-3 text-body">Loading editor…</div>
          )
        ) : (
          <Editor
            height="100%"
            // One model per file: without a path every file shared Monaco's
            // default model, so Ctrl+Z could restore another file's text.
            path={relPath(root, editorPath ?? "")}
            language={languageFor(editorPath)}
            theme="vs-dark"
            value={content}
            loading={<div className="gm-meta p-3 text-body">Loading editor…</div>}
            onChange={(v) => {
              setContent(v ?? "");
              setDirty(true);
            }}
            onMount={(editor, monaco) => {
              // Instance in state, not a ref: setting it re-renders, which is
              // what lets a pending search-hit reveal fire on first mount.
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
                  "editorWidget.background": "#1c1c1c",
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