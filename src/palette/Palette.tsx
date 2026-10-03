import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { openFolderProject } from "../bootstrap";
import { errorDialog } from "../dialogs";
import { fetchWorktree, pushWorktree } from "../gitOps";
import { useBindings } from "../keymap";
import { prettyCombo } from "../combo";
import { useModalFocus } from "../modalFocus";
import type { FsNode, Project } from "../types";
import {
  Bot,
  FolderOpen,
  GitBranch,
  Columns2,
  File as FileIcon,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  Settings as SettingsIcon,
  PanelLeft,
  PanelBottom,
  Keyboard,
  Type,
  Upload,
  Download,
} from "lucide-react";

interface Item {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon?: React.ReactNode;
  action: () => void;
}

// One icon per binding group, so a keyboard command and its palette row are
// recognisably the same thing.
const GROUP_ICON: Record<string, React.ReactNode> = {
  Worktrees: <GitBranch size={14} strokeWidth={2} className="text-ink-400" />,
  Panes: <Columns2 size={14} strokeWidth={2} className="text-ink-400" />,
  Files: <FileIcon size={14} strokeWidth={2} className="text-ink-400" />,
  View: <PanelLeft size={14} strokeWidth={2} className="text-ink-400" />,
};

// Result sections, in the order a person looks for them. Rows are sorted into
// these buckets: commands are contributed by several sources, and appending
// them in source order printed the same heading twice.
const GROUP_ORDER = ["Commands", "Git", "Worktrees", "Panes", "Files", "View", "Projects"];

function fuzzy(hay: string, needle: string): boolean {
  // subsequence match: keeps palette forgiving for paths and branches
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) j++;
  }
  return j === needle.length;
}

export function Palette() {
  const paletteOpen = useStore((s) => s.paletteOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const repoRoot = useStore((s) => s.repoRoot);
  const worktrees = useStore((s) => s.worktrees);
  const setActiveWorktree = useStore((s) => s.setActiveWorktree);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<FsNode[]>([]);
  const bindings = useBindings();
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(paletteOpen);

  const projects: Project[] = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const proj = projects.find((p) => p.id === activeProjectId) ?? null;
  const activeWt = worktrees.find((w) => w.id === useStore.getState().activeWorktreeId) ?? null;

  useEffect(() => {
    if (!paletteOpen) return;
    setQuery("");
    setSelected(0);
    // Escape closes even when focus leaves the input (e.g. tabs out).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [paletteOpen]);

  useEffect(() => {
    let cancelled = false;
    // Lazy: only scan when the palette opens. The old effect walked the
    // tree on every repoRoot change (startup included) for results nobody
    // saw until Ctrl+K.
    if (!repoRoot || !paletteOpen) {
      setFiles([]);
      return () => {
        cancelled = true;
      };
    }
    invoke<FsNode>("fs_tree", { path: repoRoot, depth: 3 })
      .then((t) => {
        if (cancelled) return;
        const flat: FsNode[] = [];
        const walk = (n: FsNode) => {
          if (!n.is_dir) flat.push(n);
          n.children?.forEach(walk);
        };
        if (t) walk(t);
        setFiles(flat);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, paletteOpen]);

  const openFolder = async () => {
    try {
      await openFolderProject();
    } catch (e) {
      void errorDialog(`${e}`);
    }
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || fuzzy(s.toLowerCase(), q);

    if (match("open folder repository add project")) {
      out.push({
        id: "cmd:open-folder",
        label: "Open folder or repository",
        hint: "add project",
        group: "Commands",
        icon: <FolderOpen size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => void openFolder(),
      });
    }
    if (proj?.isGit && match("new worktree branch isolate")) {
      out.push({
        id: "cmd:new-worktree",
        label: "New worktree…",
        hint: "name and base branch",
        group: "Commands",
        icon: <GitBranch size={14} strokeWidth={2} className="text-ink-400" />,
        // The same request the tab strip's + sends: one create form, so the
        // palette and the sidebar cannot disagree about what it asks for.
        action: () => useStore.getState().requestNewWorktree(),
      });
    }
    if (proj?.isGit && match("push publish upload branch upstream")) {
      out.push({
        id: "git:push",
        label: `Push ${activeWt?.branch ?? "current branch"}`,
        hint: "git push",
        group: "Git",
        icon: <Upload size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => {
          if (activeWt) void pushWorktree(activeWt.path);
        },
      });
    }
    if (proj?.isGit && match("fetch pull download remote prune")) {
      out.push({
        id: "git:fetch",
        label: "Fetch and prune",
        hint: "git fetch",
        group: "Git",
        icon: <Download size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => {
          if (activeWt) void fetchWorktree(activeWt.path);
        },
      });
    }
    if (proj?.isGit && match("commit stage all message")) {
      out.push({
        id: "git:commit",
        label: "Commit staged changes",
        hint: "type a message in the sidebar",
        group: "Git",
        icon: <GitBranch size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => {
          // No message to ask for here: the sidebar's field is the one place a
          // commit message is typed, so this reveals it instead of guessing.
          if (!useStore.getState().leftVisible) useStore.getState().toggleLeft();
          document.querySelector<HTMLInputElement>('[aria-label="Commit message"]')?.focus();
        },
      });
    }
    if (match("toggle density compact comfortable spacing rows")) {
      const compact = useStore.getState().settings.density === "compact";
      out.push({
        id: "cmd:density",
        label: compact ? "Use comfortable density" : "Use compact density",
        hint: "row height and type size",
        group: "View",
        icon: <Type size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => {
          const st = useStore.getState();
          st.setSettings({ density: compact ? "comfortable" : "compact" });
        },
      });
    }
    if (match("file dock files tree editor bottom panel")) {
      out.push({
        id: "cmd:dock",
        label: "Show / hide the file dock",
        hint: "Ctrl+J",
        group: "View",
        icon: <PanelBottom size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => useStore.getState().toggleRight(),
      });
    }
    if (match("keyboard shortcuts cheat sheet keys help")) {
      out.push({
        id: "cmd:cheatsheet",
        label: "Keyboard shortcuts",
        hint: "Ctrl+Shift+?",
        group: "View",
        icon: <Keyboard size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => useStore.getState().setCheatSheetOpen(true),
      });
    }
    if (match("launch agents cli claude codex opencode fan out")) {
      out.push({
        id: "cmd:agents",
        label: "Launch agents",
        hint: "pick agent + count",
        group: "Commands",
        icon: <Bot size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => useStore.getState().setAgentOpen(true),
      });
    }

    // Every registered shortcut is a row. The palette is therefore the
    // discoverable face of the keymap: a chord added in keymap.ts shows up
    // here with its accelerator, and a removed one disappears. The hand-written
    // commands above are only the ones no binding owns.
    for (const b of bindings) {
      // The palette cannot invoke itself, and "worktree 3" is a worse label
      // than the branch name listed further down.
      if (b.id === "palette" || /^worktree\.\d$/.test(b.id)) continue;
      if (!match(`${b.label} ${b.combo} ${b.group}`)) continue;
      out.push({
        id: `key:${b.id}`,
        label: b.label,
        hint: prettyCombo(b.combo),
        group: b.group,
        icon: GROUP_ICON[b.group] ?? <SettingsIcon size={14} strokeWidth={2} className="text-ink-400" />,
        action: b.run,
      });
    }

    if (proj?.isGit) {
      for (const wt of worktrees) {
        if (wt.id.startsWith("plain:")) continue;
        const branch = wt.branch ?? "";
        if (!q || fuzzy(branch.toLowerCase(), q) || fuzzy(wt.path.toLowerCase(), q)) {
          out.push({
            id: `wt:${wt.id}`,
            label: branch || "(detached)",
            hint: wt.is_main ? "main worktree" : wt.path,
            group: "Worktrees",
            icon: <GitBranch size={14} strokeWidth={2} className="text-ink-400" />,
            action: () => setActiveWorktree(wt.id),
          });
        }
      }
    }
    // Filter first, then cap: slicing before matching hides deep files
    // in repos over 500 files.
    for (const f of files) {
      const rel = f.path.slice((repoRoot?.length ?? 0) + 1);
      if (!q || fuzzy(rel.toLowerCase(), q)) {
        if (out.length >= 40) break;
        out.push({
          id: `file:${f.path}`,
          label: rel,
          hint: "open in editor",
          group: "Files",
          icon: <FileIcon size={14} strokeWidth={2} className="text-ink-400" />,
          action: () => useStore.getState().openEditor(f.path, false),
        });
      }
    }
    for (const p of projects) {
      if (!q || fuzzy(p.name.toLowerCase(), q) || fuzzy(p.path.toLowerCase(), q)) {
        out.push({
          id: `proj:${p.id}`,
          label: p.name,
          hint: p.isGit ? "git project" : "folder project",
          group: "Projects",
          icon: <GitBranch size={14} strokeWidth={2} className="text-ink-400" />,
          action: () => setActiveProject(p.id),
        });
      }
    }
    // Group order, stable inside a group so ranking survives.
    const rank = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i === -1 ? GROUP_ORDER.length : i;
    };
    out.sort((a, b) => rank(a.group) - rank(b.group));
    return out.slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, worktrees, files, repoRoot, setActiveWorktree, projects, proj?.isGit, bindings]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!paletteOpen) return null;

  const run = (i: number) => {
    items[i]?.action();
    setPaletteOpen(false);
  };

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
      onClick={() => setPaletteOpen(false)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="gm-dialog w-[560px] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gm-rule flex items-center gap-2 px-4">
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls="gm-palette-list"
            aria-activedescendant={items[selected] ? `gm-palette-opt-${selected}` : undefined}
            aria-label="Search commands, projects, worktrees, and files"
            className="w-full bg-transparent py-3.5 text-strong text-ink-100 outline-none placeholder:text-ink-400"
            placeholder="Type a command, project, worktree, or file"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                run(selected);
              } else if (e.key === "Escape") {
                setPaletteOpen(false);
              } else if (e.key === "Tab") {
                // single-input dialog: keep focus on the query field
                e.preventDefault();
              }
            }}
          />
          <span className="gm-kbd">esc</span>
        </div>
        <div ref={listRef} id="gm-palette-list" role="listbox" aria-label="Results" className="max-h-[340px] overflow-y-auto py-1.5">
          {items.map((item, i) => {
            const header =
              item.group !== lastGroup ? (
                <div className="gm-sect px-4 pb-0.5 pt-2">
                  {item.group}
                </div>
              ) : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header}
                <div
                  id={`gm-palette-opt-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === selected}
                  data-selected={i === selected}
                  className={`gm-row mx-1.5 flex cursor-pointer items-center gap-2.5 px-2.5 py-2 text-body ${
                    i === selected ? "text-ink-100" : "text-ink-300"
                  }`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => run(i)}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                  {item.hint && (
                    <span className="tnum max-w-[220px] truncate text-meta text-ink-400">{item.hint}</span>
                  )}
                  {i === selected && <CornerDownLeft size={12} className="shrink-0 text-ink-400" />}
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="px-4 py-6 text-center">
              <div className="text-body font-medium text-ink-300">No matches</div>
              <div className="mt-0.5 text-meta text-ink-400">Try a shorter fragment of the name or path.</div>
            </div>
          )}
        </div>
        <div className="gm-rule-top tnum flex items-center gap-4 px-4 py-2 text-meta text-ink-400">
          <span className="flex items-center gap-1.5"><span className="gm-kbd flex items-center gap-0.5"><ArrowUp size={10} /><ArrowDown size={10} /></span> navigate</span>
          <span className="flex items-center gap-1.5"><span className="gm-kbd flex items-center gap-0.5"><CornerDownLeft size={10} /></span> open</span>
          <span className="flex-1" />
          <span>{items.length} results</span>
        </div>
      </div>
    </div>
  );
}
