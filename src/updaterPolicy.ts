// Dependency-free updater policy: pure logic + concurrency guard.
// No Tauri imports so node --test can exercise this directly.

/** Map updater failures to one user-friendly line; never leak stack traces. */
export function updaterErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/network|fetch|connect|timeout|dns|offline|resolve|certificate/i.test(msg))
    return "Couldn't check for updates (network). Please try again later.";
  if (/signature|verify|trust/i.test(msg))
    return "Update signature check failed. Guimux stays on the current version.";
  return "Couldn't check for updates. Please try again later.";
}

/* ------------------------------------------------------------------ */
/* Download progress                                                   */
/* ------------------------------------------------------------------ */

/**
 * Structural mirror of the updater plugin's `DownloadEvent`, declared here so
 * the tracker stays importable from node --test (the plugin ships no types at
 * runtime) and the shape we depend on lives in one place.
 */
export type DownloadEventLike =
  | { event: "Started"; data?: { contentLength?: number | null } | null }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished"; data?: unknown };

export interface DownloadProgress {
  /** Bytes received so far; always known, even when total is not. */
  downloaded: number;
  /** Null when the server sent no Content-Length. */
  total: number | null;
  /** 0..100, or null when total is unknown. */
  percent: number | null;
  done: boolean;
}

/** Sum chunk sizes against the one Content-Length sent on `Started`. A missing
 *  or non-positive total yields an indeterminate bar instead of dividing by zero. */
export function createProgressTracker(): {
  push: (ev: DownloadEventLike) => DownloadProgress;
  value: () => DownloadProgress;
  reset: () => void;
} {
  let downloaded = 0;
  let total: number | null = null;
  let done = false;

  const snapshot = (): DownloadProgress => {
    if (done) return { downloaded: total ?? downloaded, total, percent: 100, done: true };
    if (total === null || total <= 0)
      return { downloaded, total: null, percent: null, done: false };
    // Clamp: an under-reported total would pin the bar at 100% mid-download.
    const percent = Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
    return { downloaded, total, percent, done: false };
  };

  return {
    push(ev) {
      if (ev.event === "Started") {
        downloaded = 0;
        done = false;
        const len = ev.data?.contentLength;
        total = typeof len === "number" && Number.isFinite(len) && len > 0 ? len : null;
      } else if (ev.event === "Progress") {
        const n = ev.data?.chunkLength;
        if (typeof n === "number" && Number.isFinite(n) && n > 0) downloaded += n;
      } else {
        done = true;
      }
      return snapshot();
    },
    value: snapshot,
    reset() {
      downloaded = 0;
      total = null;
      done = false;
    },
  };
}

/** "18.4 MB" / "820 KB". One decimal below 100 so a moving bar doesn't look stalled. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = u === 0 || v >= 100 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[u]}`;
}
