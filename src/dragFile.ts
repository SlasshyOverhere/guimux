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
