export interface Worktree {
  id: string;
  path: string;
  branch: string;
  is_main: boolean;
  last_commit?: number | null; // unix seconds, absent for plain folders
}

export interface Project {
  id: string;
  path: string;
  name: string;
  isGit: boolean;
  gitRoot: string | null;
  branch: string | null;
}

export interface PtySession {
  id: number;
  cwd: string;
}

export interface FileStatus {
  path: string;
  index_status: string;
  workdir_status: string;
}

export interface FsNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FsNode[] | null;
}

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  flags: string; // default flags appended on launch, e.g. --dangerously-skip-permissions
}

export interface Settings {
  terminalFontSize: number;
  editorFontSize: number;
  scrollback: number;
  uiZoom: number;
  agents: AgentDef[];
}

export const DEFAULT_SETTINGS: Settings = {
  terminalFontSize: 13,
  editorFontSize: 13,
  scrollback: 10_000,
  uiZoom: 1,
  agents: [
    { id: "claude", name: "Claude", command: "claude", flags: "" },
    { id: "codex", name: "Codex", command: "codex", flags: "" },
    { id: "opencode", name: "OpenCode", command: "opencode", flags: "" },
  ],
};
