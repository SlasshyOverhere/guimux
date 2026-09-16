import { invoke } from "@tauri-apps/api/core";
import type { Project } from "./types";

interface DetectResult {
  path: string;
  name: string;
  is_git: boolean;
  git_root: string | null;
  branch: string | null;
}

export async function detectToProject(detectedPath: string): Promise<Project> {
  const d = await invoke<DetectResult>("project_detect", { path: detectedPath });
  // project_detect returns git slash-style roots on Windows (`C:/…`);
  // the frontend compares paths with `\` — normalize at the boundary.
  const slash = (p: string | null) =>
    p == null ? p : p.replace(/\//g, navigator.platform.startsWith("Win") ? "\\" : "/");
  const norm = slash(d.is_git && d.git_root ? d.git_root : d.path)!;
  return {
    id: norm,
    path: norm,
    name: d.name,
    isGit: d.is_git,
    gitRoot: slash(d.git_root),
    branch: d.branch,
  };
}
