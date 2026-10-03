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
  shell_kind: ShellKind;
  epoch: number;
}

export type ShellKind = "powershell" | "cmd" | "posix" | "fish" | "unknown";

export interface PtyAttach {
  // base64, not number[]: serde renders a byte vec as a JSON array (~3.5x).
  replay: string;
  shell_kind: ShellKind;
  epoch: number;
}

export interface PtyOutput {
  epoch: number;
  bytes: string;
}

export interface FileStatus {
  path: string;
  index_status: string;
  workdir_status: string;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface GrepHit {
  path: string;
  lineno: number;
  text: string;
}

export interface FsNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FsNode[] | null;
  truncated?: boolean;
}

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  flags: string; // default flags appended on launch, e.g. --dangerously-skip-permissions
}

export type Density = "comfortable" | "compact";

export interface Settings {
  terminalFontSize: number;
  editorFontSize: number;
  scrollback: number;
  uiZoom: number;
  /** Row padding + control height. `compact` retunes the whole app. */
  density: Density;
  autoCheckForUpdates: boolean;
  agents: AgentDef[];
}

export const DEFAULT_SETTINGS: Settings = {
  terminalFontSize: 13,
  editorFontSize: 13,
  scrollback: 10_000,
  uiZoom: 1,
  density: "comfortable",
  autoCheckForUpdates: true,
  agents: [
    { id: "claude", name: "Claude", command: "claude", flags: "" },
    { id: "codex", name: "Codex", command: "codex", flags: "" },
    { id: "opencode", name: "OpenCode", command: "opencode", flags: "" },
  ],
};
