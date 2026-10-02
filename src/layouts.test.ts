// Layout key normalization + duplicate collapse.
// Run: node --test src/layouts.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLayouts } from "./layouts.ts";

const pane = (id: string) => ({ kind: "pane", id, ptyId: null });
const split = (id: string, first: unknown, second: unknown) => ({
  kind: "split",
  id,
  direction: "h",
  ratio: 0.5,
  first,
  second,
});

describe("sanitizeLayouts", () => {
  it("normalizes backslash keys to the slash id", () => {
    const out = sanitizeLayouts({ "plain:D:\\test": pane("a") });
    assert.ok(out);
    assert.deepEqual(Object.keys(out), ["plain:D:/test"]);
  });

  it("drops duplicates, keeping the tree with the right pane count", () => {
    const out = sanitizeLayouts({
      "plain:D:\\test": split("s", pane("a"), pane("b")),
      "plain:D:/test": pane("a"),
    });
    assert.ok(out);
    assert.deepEqual(Object.keys(out), ["plain:D:/test"]);
    assert.equal((out["plain:D:/test"] as { kind: string }).kind, "split");
  });

  it("keeps the richer tree regardless of key order", () => {
    const out = sanitizeLayouts({
      "plain:D:/test": pane("a"),
      "plain:D:\\test": split("s", pane("a"), pane("b")),
    });
    assert.ok(out);
    assert.equal((out["plain:D:/test"] as { kind: string }).kind, "split");
  });

  it("returns undefined for empty or malformed input", () => {
    assert.equal(sanitizeLayouts(null), undefined);
    assert.equal(sanitizeLayouts([]), undefined);
    assert.equal(sanitizeLayouts({ "x": { kind: "bogus" } }), undefined);
  });
});
