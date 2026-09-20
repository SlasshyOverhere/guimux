// Updater policy tests: single-flight guard + error mapping.
// Run: node --test src/updaterPolicy.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight } from "./singleFlight.ts";
import { updaterErrorMessage } from "./updaterPolicy.ts";

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
