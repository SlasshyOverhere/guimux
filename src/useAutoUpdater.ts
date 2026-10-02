import { useCallback, useSyncExternalStore } from "react";
import {
  checkForUpdates,
  dismissUpdate,
  downloadAndInstallUpdate,
  getUpdaterState,
  notifyAvailable,
  relaunchApp,
  subscribeUpdaterState,
  type UpdaterState,
} from "./updater";

/**
 * Live updater state + actions.
 *
 * State lives in the module store, not here, so the update card and this hook
 * are just two subscribers to one source of truth: a download started from the
 * card fills the bar in Settings, and a check that finished at boot shows up
 * when Settings is finally opened.
 */
export function useAutoUpdater(): UpdaterState & {
  checkNow: () => Promise<void>;
  downloadInstall: () => Promise<void>;
  relaunch: () => Promise<void>;
  dismiss: () => void;
} {
  const state = useSyncExternalStore(subscribeUpdaterState, getUpdaterState);

  const checkNow = useCallback(async () => {
    const info = await checkForUpdates();
    if (info) await notifyAvailable(info.version);
  }, []);

  const downloadInstall = useCallback(async () => {
    await downloadAndInstallUpdate();
  }, []);

  const relaunch = useCallback(async () => {
    await relaunchApp();
  }, []);

  const dismiss = useCallback(() => {
    if (state.info) dismissUpdate(state.info.version);
  }, [state.info]);

  return { ...state, checkNow, downloadInstall, relaunch, dismiss };
}
