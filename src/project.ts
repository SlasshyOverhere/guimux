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
  const normPath = d.is_git && d.git_root ? d.git_root : d.path;
  return {
    id: normPath,
    path: normPath,
    name: d.name,
    isGit: d.is_git,
    gitRoot: d.git_root,
    branch: d.branch,
  };
}
