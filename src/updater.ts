import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { createSingleFlight } from "./singleFlight";
import { updaterErrorMessage } from "./updaterPolicy";

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
  progress: number | null;
  error: string | null;
}

export const INITIAL_UPDATER_STATE: UpdaterState = {
  status: "idle",
  info: null,
  progress: null,
  error: null,
};

type Patch = (p: Partial<UpdaterState>) => void;

// Last check result, shared between startup auto-check and Settings UI:
// opening Settings after an auto-check shows the result without re-checking.
let lastCheck: { status: UpdaterStatus; info: UpdateInfo | null } | null = null;

export function getLastCheck(): { status: UpdaterStatus; info: UpdateInfo | null } | null {
  return lastCheck;
}

// Every check completion (success or error) broadcasts here so an open
// Settings panel live-updates even when the boot auto-check finishes late.
// lastCheck above keeps only successful results for late mounters.
export interface CheckCompletion {
  status: "up-to-date" | "available" | "error";
  info: UpdateInfo | null;
  error: string | null;
}

const checkListeners = new Set<(e: CheckCompletion) => void>();

export function subscribeCheckCompletion(fn: (e: CheckCompletion) => void): () => void {
  checkListeners.add(fn);
  return () => {
    checkListeners.delete(fn);
  };
}

function broadcast(e: CheckCompletion): void {
  for (const fn of [...checkListeners]) {
    try {
      fn(e);
    } catch {
      /* listener failure never breaks the check flow */
    }
  }
}

// Single-flight across the app: startup auto-check and Settings
// "Check now" share it, so neither double-downloads nor double-notifies.
const flight = createSingleFlight();

// Versions already toasted this session: one notification per version.
const notified: Record<string, true> = {};

export async function notifyAvailable(version: string): Promise<void> {
  if (notified[version]) return;
  notified[version] = true;
  try {
    if (!(await isPermissionGranted())) await requestPermission();
    sendNotification({
      title: "Guimux update available",
      body: `Guimux ${version} is available — see Settings › Updates.`,
    });
  } catch {
    /* notifications unavailable (browser dev) — Settings UI still shows it */
  }
}

// Once per session. Fire-and-forget from App boot: never blocks startup,
// updater failure never prevents launch. No intervals — one check per launch.
let autoRan = false;

export async function maybeAutoCheck(enabled: boolean): Promise<void> {
  if (autoRan || !enabled) return;
  autoRan = true;
  const info = await checkForUpdates(() => {});
  if (info) await notifyAvailable(info.version);
}

/** Check for updates. Null = up to date (or check already running). */
export async function checkForUpdates(set: Patch): Promise<UpdateInfo | null> {
  return flight.run(async () => {
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (!update) {
        lastCheck = { status: "up-to-date", info: null };
        set({ status: "up-to-date", info: null, progress: null });
        broadcast({ status: "up-to-date", info: null, error: null });
        return null;
      }
      try {
        const info: UpdateInfo = {
          currentVersion: update.currentVersion,
          version: update.version,
          body: update.body ?? null,
          date: update.date ?? null,
        };
        lastCheck = { status: "available", info };
        set({ status: "available", info, progress: null });
        broadcast({ status: "available", info, error: null });
        return info;
      } finally {
        await update.close();
      }
    } catch (e) {
      const error = updaterErrorMessage(e);
      set({ status: "error", error, progress: null });
      broadcast({ status: "error", info: null, error });
      return null;
    }
  });
}

/**
 * Download + install the pending update (re-checks for a fresh handle).
 * Windows install() exits the app; macOS/Linux caller relaunches.
 */
export async function downloadAndInstallUpdate(set: Patch): Promise<boolean> {
  return (
    (await flight.run(async () => {
      set({ status: "downloading", error: null });
      try {
        const update = await check();
        if (!update) {
          lastCheck = { status: "up-to-date", info: null };
          set({ status: "up-to-date", info: null, progress: null });
          return false;
        }
        try {
          set({
            info: {
              currentVersion: update.currentVersion,
              version: update.version,
              body: update.body ?? null,
              date: update.date ?? null,
            },
          });
          await update.downloadAndInstall((ev) => {
            if (ev.event === "Started") set({ progress: null });
            else if (ev.event === "Finished") set({ progress: 100 });
          });
          set({ status: "ready", progress: 100 });
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

// ponytail: progress stays indeterminate — the updater reports chunk sizes
// without reliable totals. Add a determinate bar when totals prove stable.
