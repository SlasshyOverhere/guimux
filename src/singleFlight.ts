// Dependency-free single-flight guard (no Tauri imports, so node --test can
// exercise it directly). Used by the updater, and by the sidebar's status poll
// and worktree list refresh.

export interface SingleFlight {
  readonly busy: boolean;
  run<T>(fn: () => Promise<T>): Promise<T | null>;
}

/** Concurrent runs corrupt shared state or duplicate work; the second caller
 *  gets null instead of a second execution. */
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
