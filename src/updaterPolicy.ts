// Dependency-free updater policy: pure logic + concurrency guard.
// No Tauri imports so node --test can exercise this directly.

export interface SingleFlight {
  readonly busy: boolean;
  run<T>(fn: () => Promise<T>): Promise<T | null>;
}

/**
 * Single-flight guard: concurrent check/download corrupts the updater
 * Resource and double-notifies. Second caller gets null (no-op).
 */
export function createSingleFlight(): SingleFlight {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async run<T>(fn: () => Promise<T>): Promise<T | null> {
      if (busy) return null;
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    },
  };
}

/** Map updater failures to one user-friendly line; never leak stack traces. */
export function updaterErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/network|fetch|connect|timeout|dns|offline|resolve|certificate/i.test(msg))
    return "Couldn't check for updates (network). Please try again later.";
  if (/signature|verify|trust/i.test(msg))
    return "Update signature check failed. Guimux stays on the current version.";
  return "Couldn't check for updates. Please try again later.";
}
