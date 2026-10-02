function windowsPaths(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.startsWith("Win");
}

export function normalizePath(value: string, caseInsensitive = windowsPaths()): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function pathStartsRoot(
  root: string | null,
  path: string,
  caseInsensitive = windowsPaths(),
): boolean {
  if (!root) return false;
  const normalizedRoot = normalizePath(root, caseInsensitive);
  const normalizedPath = normalizePath(path, caseInsensitive);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
