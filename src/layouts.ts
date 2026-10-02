// Layout sanitization, dependency-free so `node --test` can load it.
// Persisted layouts must be small static trees: strip runtime session state
// so a restart spawns fresh shells instead of attaching to dead pty ids or
// re-firing a queued agent command.
import type { PaneNode } from "./store";

export function sanitizeLayoutNode(node: unknown, depth = 0, seen = { n: 0 }): PaneNode | null {
  if (!node || typeof node !== "object" || depth > 10 || seen.n > 24) return null;
  const v = node as Record<string, unknown>;
  if (v.kind === "pane") {
    if (typeof v.id !== "string" || !v.id || v.id.length > 80) return null;
    seen.n += 1;
    const cwd = typeof v.cwd === "string" && v.cwd.length > 0 && v.cwd.length <= 500 ? v.cwd : null;
    return { kind: "pane", id: v.id, ptyId: null, cwd, initCmd: null };
  }
  if (v.kind === "split") {
    if (typeof v.id !== "string" || !v.id || v.id.length > 80) return null;
    const direction = v.direction === "v" ? "v" : "h";
    const ratio =
      typeof v.ratio === "number" && Number.isFinite(v.ratio)
        ? Math.min(0.9, Math.max(0.1, v.ratio))
        : 0.5;
    const first = sanitizeLayoutNode(v.first, depth + 1, seen);
    const second = sanitizeLayoutNode(v.second, depth + 1, seen);
    if (!first || !second) return null;
    return { kind: "split", id: v.id, direction, ratio, first, second };
  }
  return null;
}

export function collectLayoutPaneIds(node: PaneNode, out: Set<string>) {
  if (node.kind === "pane") out.add(node.id);
  else {
    collectLayoutPaneIds(node.first, out);
    collectLayoutPaneIds(node.second, out);
  }
}

function countLayoutPanes(node: PaneNode): number {
  return node.kind === "pane" ? 1 : countLayoutPanes(node.first) + countLayoutPanes(node.second);
}

export function sanitizeLayouts(input: unknown): Record<string, PaneNode> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, PaneNode> = {};
  const panes: Record<string, number> = {};
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (!rawKey || rawKey.length > 500) continue;
    // Keys are worktree ids: normalize `\` -> `/`, or a tree saved under
    // `plain:D:\test` can never be found by the id `plain:D:/test`.
    const key = rawKey.replace(/\\/g, "/");
    if (!key || key.length > 500) continue;
    const clean = sanitizeLayoutNode(value);
    if (!clean) continue;
    const count = countLayoutPanes(clean);
    if (out[key] === undefined) {
      if (Object.keys(out).length >= 50) continue;
      out[key] = clean;
      panes[key] = count;
    } else if (count > panes[key]) {
      // Duplicate after normalization: the missed restore left a synthetic
      // single pane behind, so keep the richer tree.
      out[key] = clean;
      panes[key] = count;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
