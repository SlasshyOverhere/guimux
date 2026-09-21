// Same-document file-drag channel (explorer tree -> terminal panes).
//
// The drop handler used to read the path only from `dataTransfer`, but the
// Tauri/WebView2 webview can deliver a same-app drop with an emptied
// dataTransfer (custom MIME types stripped, text/plain unreliable) — the
// handler then hit `if (!path) return` and the drop silently did nothing.
// Both sides run in one JS context, so a shared holder is the reliable
// channel; dataTransfer stays as the fallback for OS file drops from
// outside the app.
//
// Lifecycle: dragstart sets `.path`, drop consumes it, dragend clears it
// (drop always fires before dragend, so a missed drop never leaks a stale path).
export const dragFile: { path: string | null } =
  typeof window !== "undefined" &&
  (window as unknown as { __gmDragFile?: { path: string | null } }).__gmDragFile
    ? (window as unknown as { __gmDragFile: { path: string | null } }).__gmDragFile
    : { path: null };

if (typeof window !== "undefined") {
  const w = window as unknown as { __gmDragFile?: { path: string | null } };
  w.__gmDragFile = dragFile;
}

// Quote a Windows path for pasting at a PowerShell/cmd prompt. `"` is an
// illegal file-name character on Windows, so no inner-quote escaping is
// needed; a trailing backslash (folders) would escape the closing quote, so
// it is doubled (harmless to both shells).
export function quoteForShell(path: string): string {
  const safe = path.endsWith("\\") ? `${path}\\` : path;
  return `"${safe}" `;
}

// Release-to-paste bus: HTML5 drop never fires in this webview (logs show
// dragstart -> dragend with dropEffect none and zero dragover/drop events),
// so the explorer announces the release point and the pane under it pastes
// via its own live terminal + session (no stale ids passed through the DOM).
export function notifyFileDrop(path: string, x: number, y: number) {
  window.dispatchEvent(new CustomEvent("gm-file-drop", { detail: { path, x, y } }));
}

export function notifyFileDragOver(x: number, y: number) {
  window.dispatchEvent(new CustomEvent("gm-file-drag-over", { detail: { x, y } }));
}

export function notifyFileDragLeave() {
  window.dispatchEvent(new CustomEvent("gm-file-drag-leave"));
}

export interface TauriDropPosition {
  x: number;
  y: number;
}
export interface TauriDragPayload {
  paths?: string[] | null;
  position?: TauriDropPosition | [number, number] | null;
}

// Tauri serializes PhysicalPosition as {x,y}; accept tuples defensively.
export function normalizeTauriPos(raw: unknown): TauriDropPosition | null {
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) {
    const [x, y] = raw as unknown[];
    return typeof x === "number" && typeof y === "number" ? { x, y } : null;
  }
  const { x, y } = raw as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

// Physical webview px -> viewport css px. Proportional, so OS scale factor
// and app zoom cancel out instead of needing exact constants for each.
export function physicalToCss(
  pos: TauriDropPosition,
  phys: { w: number; h: number },
  css: { w: number; h: number },
): { x: number; y: number } | null {
  if (!(phys.w > 0) || !(phys.h > 0)) return null;
  return { x: (pos.x * css.w) / phys.w, y: (pos.y * css.h) / phys.h };
}

// Dedupe: a Tauri drop already pasted, so a late HTML5 drop is stale.
let lastOsDropAt = 0;
export function noteOsDrop() {
  lastOsDropAt = Date.now();
}
export function recentOsDrop(windowMs = 800): boolean {
  return Date.now() - lastOsDropAt < windowMs;
}

function visiblePaneEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll("[data-pane-drop]")).filter((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }) as HTMLElement[];
}

// OS file drops (Explorer -> window) arrive as Tauri drag events, never as
// HTML5 drops, so without this they silently do nothing. Re-emits through
// the gm-file-drop bus the panes already paste from.
export function startOsFileDropBridge(): () => void {
  let disposed = false;
  const unlistens: Array<() => void> = [];
  let phys: { w: number; h: number } | null = null;
  const refreshSize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const s = await getCurrentWindow().innerSize();
      if (!disposed) phys = { w: s.width, h: s.height };
    } catch {
      /* vite dev: no Tauri runtime */
    }
  };
  const toCss = (pos: TauriDropPosition) => {
    const mapped = phys
      ? physicalToCss(pos, phys, { w: window.innerWidth, h: window.innerHeight })
      : null;
    if (mapped) return mapped;
    const sf = window.devicePixelRatio || 1;
    const zoom = parseFloat(document.documentElement.style.zoom || "1") || 1;
    return { x: pos.x / sf / zoom, y: pos.y / sf / zoom };
  };
  const over = (payload: TauriDragPayload | undefined) => {
    const pos = normalizeTauriPos(payload?.position);
    if (!pos) return;
    const css = toCss(pos);
    notifyFileDragOver(css.x, css.y);
  };
  (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      if (disposed) return;
      unlistens.push(
        await listen<TauriDragPayload>("tauri://drag-enter", (ev) => {
          void refreshSize();
          over(ev.payload);
        }),
      );
      unlistens.push(await listen<TauriDragPayload>("tauri://drag-over", (ev) => over(ev.payload)));
      unlistens.push(
        await listen<TauriDragPayload>("tauri://drag-drop", (ev) => {
          notifyFileDragLeave();
          const paths = (ev.payload?.paths ?? []).filter(
            (p): p is string => typeof p === "string" && p.length > 0,
          );
          const pos = normalizeTauriPos(ev.payload?.position);
          if (paths.length === 0 || !pos) return;
          noteOsDrop();
          const panes = visiblePaneEls();
          if (panes.length === 1) {
            const r = panes[0].getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            for (const p of paths) notifyFileDrop(p, cx, cy);
            return;
          }
          const css = toCss(pos);
          for (const p of paths) notifyFileDrop(p, css.x, css.y);
        }),
      );
      unlistens.push(await listen("tauri://drag-leave", () => notifyFileDragLeave()));
    } catch {
      /* vite dev: no Tauri runtime */
    }
  })();
  return () => {
    disposed = true;
    for (const u of unlistens) {
      try {
        u();
      } catch {
        /* already gone */
      }
    }
  };
}
