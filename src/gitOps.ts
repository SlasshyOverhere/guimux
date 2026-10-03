import { invoke } from "@tauri-apps/api/core";
import { errorDialog } from "./dialogs";

// One implementation per git verb, shared by the sidebar's Changes section and
// the command palette. They used to live in the sidebar only, which meant the
// palette could not offer them without a second copy of the error handling.

export async function pushWorktree(path: string): Promise<boolean> {
  try {
    await invoke("git_push", { path });
    return true;
  } catch (e) {
    void errorDialog(`push failed: ${e}`);
    return false;
  }
}

export async function fetchWorktree(path: string): Promise<boolean> {
  try {
    await invoke("git_fetch", { path });
    return true;
  } catch (e) {
    void errorDialog(`fetch failed: ${e}`);
    return false;
  }
}

/** Stages everything, then commits. An empty message is the caller's job to
 *  reject: git would take the last commit's subject, which is never intended. */
export async function commitWorktree(path: string, message: string): Promise<boolean> {
  try {
    await invoke("git_commit", { path, message, stageAll: true });
    return true;
  } catch (e) {
    void errorDialog(`commit failed: ${e}`);
    return false;
  }
}
