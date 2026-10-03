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

// The tree mixes separators (roots arrive slash-style, DirEntry entries carry
// whatever the OS reported), so every comparison and label normalizes first.

/** Single display form: forward slashes, no trailing separator. */
export function normSep(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function baseName(p: string): string {
  const parts = normSep(p).split("/");
  return parts[parts.length - 1] ?? p;
}

/** Long Windows paths wrap mid-segment and wreck a list, so the row shows the
 *  last two segments. The main worktree keeps its full path. */
export function shortPath(p: string, full: boolean): string {
  if (full) return p;
  const parts = normSep(p).split("/").filter(Boolean);
  return parts.length <= 3 ? p : "…/" + parts.slice(-2).join("/");
}

/** Path of `p` relative to `root`, or `p` itself when it sits elsewhere. */
export function relPath(root: string, p: string): string {
  const r = normSep(root);
  const n = normSep(p);
  return n.startsWith(r + "/") ? n.slice(r.length + 1) : n;
}

/** The same path with its last segment replaced, keeping the original
 *  separator. Drives rename for both the tree row and the editor header. */
export function siblingPath(oldPath: string, name: string): string {
  const i = Math.max(oldPath.lastIndexOf("/"), oldPath.lastIndexOf("\\"));
  return i < 0 ? name : oldPath.slice(0, i + 1) + name;
}

/** Every ancestor of `p` up to `root`, outermost first. Drives the editor's
 *  breadcrumb; empty when the file is not under the root. */
export function pathSegments(root: string, p: string): string[] {
  const rel = relPath(root, p);
  if (rel === normSep(p)) return [];
  const parts = rel.split("/").filter(Boolean);
  return parts.slice(0, -1);
}
