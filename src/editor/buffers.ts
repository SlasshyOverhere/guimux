import { useStore } from "../store";

// Unsaved buffers keyed by path. This lives at module scope on purpose: the
// editor and the explorer mount and unmount independently (worktree switches,
// opening a file closes the tree), and local state took the user's edits with
// it. Only dirty buffers are kept, so the map cannot grow without bound.
export interface Buffer {
  content: string;
  saved: string;
  dirty: boolean;
}

export const buffers = new Map<string, Buffer>();

/** Publish the dirty count so the window close and update restart can guard. */
export function syncEditorDirtyCount() {
  let count = 0;
  for (const buffer of buffers.values()) if (buffer.dirty) count += 1;
  useStore.getState().setEditorDirtyCount(count);
}

export function isDirty(path: string): boolean {
  return buffers.get(path)?.dirty ?? false;
}

/** Retarget a buffer after its file was renamed underneath the editor. */
export function moveBuffer(from: string, to: string) {
  const buffered = buffers.get(from);
  if (!buffered) return;
  buffers.delete(from);
  buffers.set(to, buffered);
}

export function dropBuffer(path: string) {
  buffers.delete(path);
  syncEditorDirtyCount();
}