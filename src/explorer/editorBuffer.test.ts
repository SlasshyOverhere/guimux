import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canSaveBuffer } from "./editorBuffer.ts";

describe("canSaveBuffer", () => {
  it("only permits writes to the path whose content loaded", () => {
    assert.equal(canSaveBuffer("b.txt", "a.txt"), false);
    assert.equal(canSaveBuffer("a.txt", "a.txt"), true);
    assert.equal(canSaveBuffer("a.txt", null), false);
  });
});
