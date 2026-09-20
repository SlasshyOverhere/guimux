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
