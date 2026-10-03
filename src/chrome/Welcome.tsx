import { useState } from "react";
import { Folder, FolderOpen, GitBranch } from "lucide-react";
import { useStore } from "../store";
import { useBindings } from "../keymap";
import { prettyCombo } from "../combo";

/**
 * Empty state: a composed workbench card, not a marketing hero. Recent
 * projects stay here so a restart is one click, not a folder picker.
 */
export function Welcome({ onOpen }: { onOpen: () => Promise<void> }) {
  const projects = useStore((s) => s.projects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      await onOpen();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-surface-canvas p-6">
      <div className="gm-dialog w-[480px] max-w-full p-7">
        <div>
          <div className="text-strong font-semibold tracking-tight text-ink-100">
            Guimux workbench
          </div>
          <div className="gm-meta mt-1 text-body">
            Terminals, worktrees, and files in one surface
          </div>
        </div>

        <button
          className="gm-btn mt-5 flex w-full items-center justify-center gap-2 px-4 py-2.5 text-strong"
          onClick={() => void open()}
          disabled={busy}
        >
          <FolderOpen size={15} strokeWidth={2.2} />
          {busy ? "Opening..." : "Open folder or repository"}
        </button>

        <div className="mt-5 grid grid-cols-2 gap-2 text-left">
          <div className="gm-inset p-3">
            <div className="flex items-center gap-1.5 text-body font-medium text-ink-200">
              <Folder size={12} strokeWidth={2} className="text-ink-400" /> Plain folder
            </div>
            <div className="gm-meta mt-1 text-meta leading-5">
              Terminals and files work immediately.
            </div>
          </div>
          <div className="gm-inset p-3">
            <div className="flex items-center gap-1.5 text-body font-medium text-ink-200">
              <GitBranch size={12} strokeWidth={2} className="text-ink-400" /> Git repository
            </div>
            <div className="gm-meta mt-1 text-meta leading-5">
              Adds isolated worktrees per branch.
            </div>
          </div>
        </div>

        {projects.length > 0 && (
          <div className="gm-rule mt-5 pt-3">
            <div className="gm-meta mb-1.5">Recent</div>
            {projects.slice(0, 4).map((p) => (
              <button
                key={p.id}
                onClick={() => setActiveProject(p.id)}
                className="gm-row flex w-full items-center gap-2 px-2 py-1.5 text-left"
                title={p.path}
              >
                {p.isGit ? (
                  <GitBranch size={12} strokeWidth={2} className="shrink-0 text-ink-400" />
                ) : (
                  <Folder size={12} strokeWidth={2} className="shrink-0 text-ink-400" />
                )}
                <span className="flex-1 truncate text-body font-medium text-ink-200">
                  {p.name}
                </span>
                <span className="max-w-[220px] truncate text-meta text-ink-500">{p.path}</span>
              </button>
            ))}
          </div>
        )}

        <div className="gm-meta mt-5 flex items-center gap-4 text-meta">
          {/* Read from the keymap: a hand-written hint here went stale the
              moment a chord changed. */}
          {useBindings()
            .filter((b) => b.id === "palette" || b.id === "pane.splitDown")
            .map((b) => (
              <span key={b.id} className="flex items-center gap-1.5">
                <span className="gm-kbd">{prettyCombo(b.combo).replace("Ctrl+", "Ctrl ")}</span>
                {b.id === "palette" ? "palette" : "split"}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}
