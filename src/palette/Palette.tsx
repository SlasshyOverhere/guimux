import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";
import { detectToProject } from "../project";
import { errorDialog } from "../dialogs";
import { useModalFocus } from "../modalFocus";
import type { FsNode, Project, Worktree } from "../types";
import {
  Bot,
  FolderOpen,
  GitBranch,
  Columns2,
  Rows2,
  File as FileIcon,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  Settings as SettingsIcon,
} from "lucide-react";

interface Item {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon?: React.ReactNode;
  action: () => void;
}

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
  const addProject = useStore((s) => s.addProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const repoRoot = useStore((s) => s.repoRoot);
  const worktrees = useStore((s) => s.worktrees);
  const setActiveWorktree = useStore((s) => s.setActiveWorktree);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<FsNode[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(paletteOpen);

  const projects: Project[] = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const proj = projects.find((p) => p.id === activeProjectId) ?? null;

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
    if (proj?.isGit && repoRoot && match("new worktree branch isolate")) {
      out.push({
        id: "cmd:new-worktree",
        label: "New worktree",
        hint: "git worktree add",
        group: "Commands",
        icon: <GitBranch size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => {
          void (async () => {
            const created = await invoke<Worktree>("worktree_create", { repoRoot, name: null, base: null });
            const st = useStore.getState();
            if (st.repoRoot !== repoRoot) return;
            st.setWorktrees([...st.worktrees.filter((w) => w.id !== created.id), created]);
            st.setActiveWorktree(created.id);
            try {
              const fresh = await invoke<Worktree[]>("worktree_list", { repoRoot });
              const cur = useStore.getState();
              if (cur.repoRoot === repoRoot && fresh.some((w) => w.id === created.id)) {
                cur.setWorktrees(fresh);
                cur.setActiveWorktree(created.id);
              }
            } catch {
              /* keep the optimistic row if the follow-up list fails */
            }
          })().catch((e) => errorDialog(`${e}`));
        },
      });
    }
    if (match("split terminal right columns")) {
      out.push({
        id: "cmd:split-h",
        label: "Split terminal right",
        hint: "Ctrl+Shift+D",
        group: "Commands",
        icon: <Columns2 size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => {
          const st = useStore.getState();
          if (st.activePaneId) st.splitPane(st.activePaneId, "h");
        },
      });
    }
    if (match("split terminal down rows")) {
      out.push({
        id: "cmd:split-v",
        label: "Split terminal down",
        group: "Commands",
        icon: <Rows2 size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => {
          const st = useStore.getState();
          if (st.activePaneId) st.splitPane(st.activePaneId, "v");
        },
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
    if (match("open settings preferences")) {
      out.push({
        id: "cmd:settings",
        label: "Open settings",
        hint: "fonts, scrollback",
        group: "Commands",
        icon: <SettingsIcon size={14} strokeWidth={2} className="text-ink-400" />,
        action: () => useStore.getState().setSettingsOpen(true),
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
    return out.slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, worktrees, files, repoRoot, setActiveWorktree, projects, proj?.isGit]);

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
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-xl shadow-pop"
        style={{ background: "var(--gm-overlay)", border: "1px solid var(--gm-hairline)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4" style={{ borderBottom: "1px solid var(--gm-hairline-soft)" }}>
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls="gm-palette-list"
            aria-activedescendant={items[selected] ? `gm-palette-opt-${selected}` : undefined}
            aria-label="Search commands, projects, worktrees, and files"
            className="w-full bg-transparent py-3.5 text-[13.5px] text-ink-100 outline-none placeholder:text-ink-400"
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
                <div className="px-4 pb-0.5 pt-2 text-[11px] font-semibold uppercase text-ink-500" style={{ letterSpacing: "0.08em" }}>
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
                  className={`gm-row mx-1.5 flex cursor-pointer items-center gap-2.5 px-2.5 py-2 text-[12.5px] ${
                    i === selected ? "text-ink-100" : "text-ink-300"
                  }`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => run(i)}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                  {item.hint && (
                    <span className="tnum max-w-[220px] truncate text-[11px] text-ink-400">{item.hint}</span>
                  )}
                  {i === selected && <CornerDownLeft size={12} className="shrink-0 text-ink-400" />}
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="px-4 py-6 text-center">
              <div className="text-[12.5px] font-medium text-ink-300">No matches</div>
              <div className="mt-0.5 text-[11.5px] text-ink-400">Try a shorter fragment of the name or path.</div>
            </div>
          )}
        </div>
        <div
          className="tnum flex items-center gap-4 px-4 py-2 text-[11px] text-ink-400"
          style={{ borderTop: "1px solid var(--gm-hairline-soft)" }}
        >
          <span className="flex items-center gap-1.5"><span className="gm-kbd flex items-center gap-0.5"><ArrowUp size={10} /><ArrowDown size={10} /></span> navigate</span>
          <span className="flex items-center gap-1.5"><span className="gm-kbd flex items-center gap-0.5"><CornerDownLeft size={10} /></span> open</span>
          <span className="flex-1" />
          <span>{items.length} results</span>
        </div>
      </div>
    </div>
  );
}
