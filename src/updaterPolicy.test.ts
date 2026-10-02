// Updater policy tests: single-flight guard + error mapping.
// Run: node --test src/updaterPolicy.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight } from "./singleFlight.ts";
import { createProgressTracker, formatBytes, updaterErrorMessage } from "./updaterPolicy.ts";

describe("single flight", () => {
  it("second concurrent caller gets null, first completes", async () => {
    const f = createSingleFlight();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = f.run(() => gate.then(() => "done"));
    const second = await f.run(() => Promise.resolve("should-not-run"));
    assert.equal(second, null);
    assert.equal(f.busy, true);
    release();
    assert.equal(await first, "done");
    assert.equal(f.busy, false);
  });

  it("guard releases after failure", async () => {
    const f = createSingleFlight();
    const r = await f.run(() => Promise.reject(new Error("boom")).catch(() => "caught"));
    assert.equal(r, "caught");
    assert.equal(f.busy, false);
    assert.equal(await f.run(() => Promise.resolve(1)), 1);
  });

  it("sequential runs both execute", async () => {
    const f = createSingleFlight();
    assert.equal(await f.run(() => Promise.resolve("a")), "a");
    assert.equal(await f.run(() => Promise.resolve("b")), "b");
  });
});

describe("updaterErrorMessage", () => {
  it("maps network failures to retry-later line", () => {
    assert.match(updaterErrorMessage(new Error("fetch failed: connect timeout")), /try again later/);
    assert.match(updaterErrorMessage(new Error("DNS resolve failed")), /network/i);
  });
  it("maps signature failures without leaking internals", () => {
    const m = updaterErrorMessage(new Error("minisign signature verify: invalid sig"));
    assert.match(m, /signature/i);
    assert.doesNotMatch(m, /minisign/);
  });
  it("falls back to generic retry line", () => {
    assert.match(updaterErrorMessage(new Error("weird 500")), /try again later/);
    assert.match(updaterErrorMessage("string failure"), /try again later/);
  });
  it("never returns empty or stack traces", () => {
    const e = new Error("x");
    e.stack = "Error: x\n    at foo (bar.ts:1:1)\n    at baz (qux.ts:2:2)";
    const m = updaterErrorMessage(e);
    assert.ok(m.length > 0 && m.length < 200);
    assert.doesNotMatch(m, /at foo|bar\.ts/);
  });
});

describe("createProgressTracker", () => {
  it("accumulates chunks against the total from Started", () => {
    const t = createProgressTracker();
    t.push({ event: "Started", data: { contentLength: 1000 } });
    assert.deepEqual(t.value(), { downloaded: 0, total: 1000, percent: 0, done: false });
    assert.equal(t.push({ event: "Progress", data: { chunkLength: 250 } }).percent, 25);
    assert.equal(t.push({ event: "Progress", data: { chunkLength: 250 } }).percent, 50);
    assert.equal(t.value().downloaded, 500);
  });

  it("finishes at 100 percent regardless of the byte count", () => {
    const t = createProgressTracker();
    t.push({ event: "Started", data: { contentLength: 1000 } });
    t.push({ event: "Progress", data: { chunkLength: 400 } });
    const done = t.push({ event: "Finished" });
    assert.equal(done.percent, 100);
    assert.equal(done.done, true);
  });

  it("stays indeterminate when the server sent no Content-Length", () => {
    const t = createProgressTracker();
    const started = t.push({ event: "Started" });
    assert.equal(started.percent, null);
    assert.equal(started.total, null);
    // Bytes are still tracked, so the UI can show "12.4 MB downloaded".
    const p = t.push({ event: "Progress", data: { chunkLength: 1024 } });
    assert.equal(p.percent, null);
    assert.equal(p.downloaded, 1024);
    // Finished still resolves the bar.
    assert.equal(t.push({ event: "Finished" }).percent, 100);
  });

  it("treats a zero or negative Content-Length as indeterminate", () => {
    for (const contentLength of [0, -1, Number.NaN]) {
      const t = createProgressTracker();
      const s = t.push({ event: "Started", data: { contentLength } });
      assert.equal(s.total, null, `contentLength=${contentLength}`);
      assert.equal(s.percent, null, `contentLength=${contentLength}`);
    }
  });

  it("clamps a server that under-reports the total", () => {
    const t = createProgressTracker();
    t.push({ event: "Started", data: { contentLength: 100 } });
    const p = t.push({ event: "Progress", data: { chunkLength: 4000 } });
    assert.equal(p.percent, 100);
  });

  it("ignores junk chunk lengths instead of producing NaN", () => {
    const t = createProgressTracker();
    t.push({ event: "Started", data: { contentLength: 100 } });
    const p = t.push({ event: "Progress", data: { chunkLength: Number.NaN } });
    assert.equal(p.downloaded, 0);
    assert.equal(p.percent, 0);
    // A new download starts from zero, never the previous run's bytes.
    t.push({ event: "Progress", data: { chunkLength: 50 } });
    t.push({ event: "Started", data: { contentLength: 200 } });
    assert.deepEqual(t.value(), { downloaded: 0, total: 200, percent: 0, done: false });
  });

  it("reset clears a completed download", () => {
    const t = createProgressTracker();
    t.push({ event: "Started", data: { contentLength: 100 } });
    t.push({ event: "Finished" });
    t.reset();
    assert.deepEqual(t.value(), { downloaded: 0, total: null, percent: null, done: false });
  });
});

describe("formatBytes", () => {
  it("scales units and keeps one decimal only where it matters", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(820), "820 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(10 * 1024), "10.0 KB");
    assert.equal(formatBytes(18.4 * 1024 * 1024), "18.4 MB");
    assert.equal(formatBytes(999.4 * 1024 * 1024), "999 MB");
  });
  it("returns empty string for non-finite or negative input", () => {
    assert.equal(formatBytes(-1), "");
    assert.equal(formatBytes(Number.NaN), "");
    assert.equal(formatBytes(Number.POSITIVE_INFINITY), "");
  });
});
