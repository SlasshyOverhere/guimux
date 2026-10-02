// PTY output codec tests. Vectors mirror pty::tests::base64_encode_vectors.
// Run: node --test src/terminal/outputCodec.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOutputBatcher, decodeBase64, type OutputBatcherDeps } from "./outputCodec.ts";

describe("decodeBase64", () => {
  it("decodes the vectors pty.rs encodes", () => {
    assert.deepEqual([...decodeBase64("")], []);
    assert.deepEqual([...decodeBase64("aGVsbG8=")], [0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    assert.deepEqual([...decodeBase64("aGk=")], [0x68, 0x69]); // "hi"
    assert.deepEqual([...decodeBase64("dGVzdA==")], [0x74, 0x65, 0x73, 0x74]); // "test"
    assert.deepEqual([...decodeBase64("AP8Q")], [0x00, 0xff, 0x10]);
    // PowerShell -EncodedCommand payload: UTF-16LE "test".
    assert.deepEqual([...decodeBase64("dABlAHMAdAA=")], [0x74, 0, 0x65, 0, 0x73, 0, 0x74, 0]);
  });

  it("tolerates whitespace and ignores non-alphabet bytes", () => {
    assert.deepEqual([...decodeBase64("aGVs\nbG8 =")], [0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  });
});

function manualDeps() {
  let hidden = false;
  const frames: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const deps: OutputBatcherDeps = {
    isHidden: () => hidden,
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length - 1;
    },
    cancelFrame: () => {},
    setTimer: (cb) => {
      timers.push(cb);
      return timers.length - 1;
    },
    clearTimer: () => {},
  };
  return {
    deps,
    setHidden: (v: boolean) => (hidden = v),
    runFrame: () => frames.shift()?.(),
    runTimer: () => timers.shift()?.(),
    frames,
    timers,
  };
}

describe("createOutputBatcher", () => {
  it("coalesces chunks into one ordered flush", () => {
    const m = manualDeps();
    const out: Uint8Array[] = [];
    const b = createOutputBatcher((bytes) => out.push(bytes), m.deps);
    b.push(new Uint8Array([1]));
    b.push(new Uint8Array([2, 3]));
    b.push(new Uint8Array([4]));
    assert.equal(out.length, 0, "nothing written before the frame");
    assert.equal(b.pending, 4);
    m.runFrame();
    assert.equal(out.length, 1);
    assert.deepEqual([...out[0]], [1, 2, 3, 4]);
    assert.equal(b.pending, 0);
  });

  it("uses the timer fallback when hidden instead of rAF", () => {
    const m = manualDeps();
    m.setHidden(true);
    const out: Uint8Array[] = [];
    const b = createOutputBatcher((bytes) => out.push(bytes), m.deps);
    b.push(new Uint8Array([9]));
    assert.equal(m.frames.length, 0, "no frame scheduled while hidden");
    assert.equal(m.timers.length, 1);
    m.runTimer();
    assert.deepEqual([...out[0]], [9]);
  });

  it("cancel drops pending output and the scheduled flush", () => {
    const m = manualDeps();
    const out: Uint8Array[] = [];
    const b = createOutputBatcher((bytes) => out.push(bytes), m.deps);
    b.push(new Uint8Array([7]));
    b.cancel();
    assert.equal(b.pending, 0);
    m.runFrame();
    m.runTimer();
    assert.equal(out.length, 0);
  });
});
