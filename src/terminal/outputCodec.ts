// Dependency-free PTY output codec: base64 decode + per-frame batching.
// No xterm/Tauri imports, so `node --test` can load it directly.

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 (with padding) -> bytes. Mirrors pty.rs base64_encode. */
export function decodeBase64(input: string): Uint8Array {
  let len = input.length;
  while (len > 0 && input.charCodeAt(len - 1) === 0x3d /* '=' */) len--;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let written = 0;
  for (let i = 0; i < len; i++) {
    const c = input.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) continue; // whitespace or invalid: skip
    bits = (bits << 6) | v;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[written++] = (bits >> bitCount) & 0xff;
    }
  }
  return written === out.length ? out : out.subarray(0, written);
}

export interface OutputBatcherDeps {
  isHidden: () => boolean;
  requestFrame: (cb: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
}

function defaultDeps(): OutputBatcherDeps {
  const hasRaf = typeof requestAnimationFrame === "function";
  return {
    isHidden: () => typeof document !== "undefined" && !!document.hidden,
    requestFrame: (cb) => (hasRaf ? requestAnimationFrame(cb) : -1),
    cancelFrame: (h) => {
      if (h >= 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
    },
    setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimer: (h) => clearTimeout(h),
  };
}

const HIDDEN_FLUSH_MS = 16;
// rAF still fires while hidden/minimised in some cases even before
// document.hidden flips; this watchdog keeps output moving if it does not.
const WATCHDOG_MS = 50;

export interface OutputBatcher {
  push(bytes: Uint8Array): void;
  flush(): void;
  cancel(): void;
  readonly pending: number;
}

/** Coalesces chunks into one ordered flush per frame; never reorders or drops. */
export function createOutputBatcher(
  onFlush: (bytes: Uint8Array) => void,
  deps?: Partial<OutputBatcherDeps>,
): OutputBatcher {
  const d: OutputBatcherDeps = { ...defaultDeps(), ...deps };
  let chunks: Uint8Array[] = [];
  let total = 0;
  let frame: number | null = null;
  let timer: number | null = null;
  let scheduled = false;

  const clearScheduled = () => {
    if (frame != null) {
      d.cancelFrame(frame);
      frame = null;
    }
    if (timer != null) {
      d.clearTimer(timer);
      timer = null;
    }
    scheduled = false;
  };

  const flushNow = () => {
    clearScheduled();
    if (total === 0) return;
    const merged = chunks.length === 1 ? chunks[0] : concat(chunks, total);
    chunks = [];
    total = 0;
    onFlush(merged);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (d.isHidden()) {
      timer = d.setTimer(flushNow, HIDDEN_FLUSH_MS);
      return;
    }
    frame = d.requestFrame(flushNow);
    timer = d.setTimer(flushNow, WATCHDOG_MS);
  };

  return {
    push(bytes) {
      if (bytes.length === 0) return;
      chunks.push(bytes);
      total += bytes.length;
      schedule();
    },
    flush: flushNow,
    cancel() {
      clearScheduled();
      chunks = [];
      total = 0;
    },
    get pending() {
      return total;
    },
  };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
