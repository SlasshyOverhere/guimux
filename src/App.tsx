import { useEffect } from "react";
import { useStore } from "./store";
import { ErrorBanner, Topbar } from "./chrome/Topbar";
import { Welcome } from "./chrome/Welcome";
import { WorktreeTabs } from "./chrome/WorktreeTabs";
import { FileDock } from "./chrome/FileDock";
import { useWorkspace } from "./bootstrap";
import { useKeymap } from "./keymap";
import { CheatSheet } from "./chrome/CheatSheet";
import { startOsFileDropBridge } from "./dragFile";
import { maybeStartStress } from "./terminal/stress";
import { SplitView } from "./terminal/SplitView";
import { WorktreeSidebar } from "./sidebar/WorktreeSidebar";
import { Palette } from "./palette/Palette";
import { SettingsPanel } from "./settings/SettingsPanel";
import { AgentLauncher } from "./agents/AgentLauncher";

export default function App() {
  const hydrated = useStore((s) => s.hydrated);
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const worktree = useStore((s) => s.worktrees.find((w) => w.id === s.activeWorktreeId));
  const layout = useStore((s) => s.layout);
  const leftVisible = useStore((s) => s.leftVisible);
  const rightVisible = useStore((s) => s.rightVisible);
  const requestNewWorktree = useStore((s) => s.requestNewWorktree);
  const settingsOpen = useStore((s) => s.settingsOpen);

  const { repoError, openFolder, dismissError } = useWorkspace();
  useKeymap();

  useEffect(() => {
    maybeStartStress();
  }, []);

  // OS file drops arrive as Tauri drag events, never HTML5: bridge them onto
  // the pane paste bus once for the whole window.
  useEffect(() => startOsFileDropBridge(), []);

  const dialogs = (
    <>
      <Palette />
      <AgentLauncher />
      <CheatSheet />
    </>
  );

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-canvas text-strong text-ink-400">
        Restoring projects...
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-full flex-col">
        <Topbar />
        <div className="relative min-h-0 flex-1">
          <Welcome onOpen={openFolder} />
        </div>
        {dialogs}
      </div>
    );
  }

  // Settings is a page, not a card: it takes the whole window below the
  // topbar, so the previews have somewhere to live and the section list has
  // somewhere to sit. The topbar stays for the window controls and the drag
  // region, and Escape or Ctrl+, gets you back.
  if (settingsOpen) {
    return (
      <div className="flex h-full flex-col">
        <Topbar />
        <SettingsPanel />
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar />
      {repoError && <ErrorBanner message={repoError} onDismiss={dismissError} />}
      {/* Worktrees as tabs: one row that says which worktree you are in and
          which are dirty, instead of hunting the sidebar for it. */}
      <WorktreeTabs onNewWorktree={requestNewWorktree} />
      <div className="flex min-h-0 flex-1">
        {leftVisible && <WorktreeSidebar />}
        <div className="gm-divider-l flex min-w-0 flex-1 flex-col bg-surface-canvas">
          <div className="min-h-0 flex-1">
            {worktree && layout ? (
              <SplitView key={worktree.id} node={layout} cwd={worktree.path} />
            ) : (
              <div className="flex h-full items-center justify-center text-strong text-ink-400">
                Starting terminal...
              </div>
            )}
          </div>
          {/* Files and editing live under the terminals, not in a side rail: a
              250px column gave the editor eight words a line. */}
          {rightVisible && worktree && <FileDock key={worktree.id} root={worktree.path} />}
        </div>
      </div>
      {dialogs}
    </div>
  );
}
