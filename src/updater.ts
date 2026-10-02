import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { createSingleFlight } from "./singleFlight";
import { createProgressTracker, updaterErrorMessage } from "./updaterPolicy";
import type { DownloadProgress } from "./updaterPolicy";

export { updaterErrorMessage };

export interface UpdateInfo {
  currentVersion: string;
  version: string;
  body?: string | null;
  date?: string | null;
}

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdaterState {
  status: UpdaterStatus;
  info: UpdateInfo | null;
  /** Null until the first download event; percent null => indeterminate bar. */
  progress: DownloadProgress | null;
  error: string | null;
  /** Version the user dismissed this session; hides the in-app card. */
  dismissedVersion: string | null;
}

export const INITIAL_UPDATER_STATE: UpdaterState = {
  status: "idle",
  info: null,
  progress: null,
  error: null,
  dismissedVersion: null,
};

/* ------------------------------------------------------------------ */
/* Observable state                                                    */
/* ------------------------------------------------------------------ */

// Module-level, not React state: the card and Settings are independent
// subscribers, so a download started in one keeps filling the bar in the other.
// card keep filling the bar in a panel opened halfway through.
let state: UpdaterState = INITIAL_UPDATER_STATE;
const listeners = new Set<() => void>();

function set(p: Partial<UpdaterState>): void {
  const next = { ...state, ...p };
  if (
    next.status === state.status &&
    next.info === state.info &&
    next.progress === state.progress &&
    next.error === state.error &&
    next.dismissedVersion === state.dismissedVersion
  ) {
    return;
  }
  state = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a broken subscriber never breaks the updater */
    }
  }
}

export function getUpdaterState(): UpdaterState {
  return state;
}

export function subscribeUpdaterState(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Hide the in-app card for this version until the app restarts. */
export function dismissUpdate(version: string): void {
  set({ dismissedVersion: version });
}

/* ------------------------------------------------------------------ */
/* OS notification                                                     */
/* ------------------------------------------------------------------ */

// Windows only toasts once the app is installed with a Start Menu shortcut, so
// the card is the real surface and this is just a background heads-up.
// ponytail: the plugin never emits actionPerformed on desktop, so the toast
// cannot carry a clickable button -- don't re-add `onAction`.
async function toast(title: string, body: string): Promise<boolean> {
  try {
    if (!(await isPermissionGranted())) await requestPermission();
    sendNotification({ title, body });
    return true;
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[updater] notification failed:", e);
    return false;
  }
}

// One toast per version per session.
const notified: Record<string, true> = {};

/** True when the user is already looking at the window. */
function windowFocused(): boolean {
  return typeof document === "undefined" ? false : document.hasFocus();
}

export async function notifyAvailable(version: string): Promise<void> {
  if (notified[version]) return;
  notified[version] = true;
  // Already staring at the app: the in-app card says it better than a toast.
  if (windowFocused()) return;
  await toast("Guimux update available", `Guimux ${version} is ready to install.`);
}

// Single-flight across the app: the startup auto-check, the Settings "Check
// now" button and the update card share it, so none double-download.
const flight = createSingleFlight();

/** Check for updates. Null = up to date (or a check was already running). */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  return (
    (await flight.run(async () => {
      set({ status: "checking", error: null });
      try {
        const update = await check();
        if (!update) {
          set({ status: "up-to-date", info: null, progress: null, error: null });
          return null;
        }
        try {
          const info: UpdateInfo = {
            currentVersion: update.currentVersion,
            version: update.version,
            body: update.body ?? null,
            date: update.date ?? null,
          };
          set({
            status: "available",
            info,
            progress: null,
            error: null,
            // Re-ask after a "Later" dismissal when checking from Settings.
            dismissedVersion: state.dismissedVersion === info.version ? null : state.dismissedVersion,
          });
          return info;
        } finally {
          await update.close();
        }
      } catch (e) {
        set({ status: "error", error: updaterErrorMessage(e), progress: null });
        return null;
      }
    })) ?? null
  );
}

/**
 * Download + install the pending update (re-checks for a fresh handle).
 * Windows install() exits the app; macOS/Linux caller relaunches.
 */
export async function downloadAndInstallUpdate(): Promise<boolean> {
  return (
    (await flight.run(async () => {
      set({ status: "downloading", error: null, progress: null });
      try {
        const update = await check();
        if (!update) {
          set({ status: "up-to-date", info: null, progress: null, error: null });
          return false;
        }
        try {
          const info: UpdateInfo = {
            currentVersion: update.currentVersion,
            version: update.version,
            body: update.body ?? null,
            date: update.date ?? null,
          };
          const tracker = createProgressTracker();
          // Fires per chunk; only publish on a whole percent.
          let lastSent = -1;
          const onEvent = (ev: DownloadEvent) => {
            const p = tracker.push(ev);
            const pct = p.percent ?? -1;
            if (p.done || pct !== lastSent) {
              lastSent = pct;
              set({ progress: p });
            }
          };
          set({ info, status: "downloading", error: null });
          await update.downloadAndInstall(onEvent);
          set({ status: "ready", info, progress: { ...tracker.value(), percent: 100, done: true } });
          void toast(
            "Guimux updated",
            `Guimux ${info.version} is installed. Restart to apply it.`,
          );
          return true;
        } finally {
          await update.close();
        }
      } catch (e) {
        set({ status: "error", error: updaterErrorMessage(e), progress: null });
        return false;
      }
    })) ?? false
  );
}

/** Relaunch into the installed update (macOS/Linux; Windows exits on install). */
export async function relaunchApp(): Promise<void> {
  await relaunch();
}

// Once per session. Fire-and-forget from App boot: never blocks startup,
// updater failure never prevents launch. No intervals — one check per launch.
let autoRan = false;

export async function maybeAutoCheck(enabled: boolean): Promise<void> {
  if (autoRan || !enabled) return;
  autoRan = true;
  const info = await checkForUpdates();
  if (info) await notifyAvailable(info.version);
}
