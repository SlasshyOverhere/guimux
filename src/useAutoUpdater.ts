import { useCallback, useEffect, useState } from "react";
import {
  INITIAL_UPDATER_STATE,
  checkForUpdates,
  downloadAndInstallUpdate,
  getLastCheck,
  notifyAvailable,
  relaunchApp,
  subscribeCheckCompletion,
  type UpdaterState,
} from "./updater";

/**
 * Updater state + actions for Settings. Seeds from the startup auto-check
 * result and live-updates when a background check finishes while open.
 */
export function useAutoUpdater() {
  const [state, setState] = useState<UpdaterState>(() => {
    const last = getLastCheck();
    return last
      ? { ...INITIAL_UPDATER_STATE, status: last.status, info: last.info, error: last.error }
      : INITIAL_UPDATER_STATE;
  });
  const patch = useCallback((p: Partial<UpdaterState>) => setState((s) => ({ ...s, ...p })), []);

  useEffect(() => {
    // Finished before open: adopt it (only from idle — never clobber
    // an in-progress user check). Finishes while open: live-update.
    const last = getLastCheck();
    if (last) {
      setState((s) =>
        s.status === "idle"
          ? { ...s, status: last.status, info: last.info, error: last.error }
          : s,
      );
    }
    return subscribeCheckCompletion((e) => {
      if (e.status === "error") setState((s) => ({ ...s, status: "error", error: e.error, progress: null }));
      else setState((s) => ({ ...s, status: e.status, info: e.info, progress: null }));
    });
  }, []);

  const checkNow = useCallback(async () => {
    const info = await checkForUpdates(patch);
    if (info) void notifyAvailable(info.version);
  }, [patch]);

  const downloadInstall = useCallback(async () => {
    await downloadAndInstallUpdate(patch);
  }, [patch]);

  const relaunch = useCallback(async () => {
    await relaunchApp();
  }, []);

  return { ...state, checkNow, downloadInstall, relaunch };
}
