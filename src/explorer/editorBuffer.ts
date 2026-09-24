export function canSaveBuffer(activePath: string | null, loadedPath: string | null): boolean {
  return activePath !== null && activePath === loadedPath;
}
