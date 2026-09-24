export function canSaveBuffer(activePath: string | null, loadedPath: string | null): boolean {
  return activePath !== null && activePath === loadedPath;
}

export async function confirmUnsavedDiscard(
  count: number,
  confirm: (message: string) => Promise<boolean>,
  action = "continue",
): Promise<boolean> {
  const files = Math.max(0, Math.floor(count));
  if (files === 0) return true;
  const noun = files === 1 ? "file" : "files";
  return confirm(`${files} unsaved ${noun} will be discarded if you ${action}. Continue?`);
}
