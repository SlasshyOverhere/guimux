import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canSaveBuffer, confirmUnsavedDiscard } from "./editorBuffer.ts";

describe("canSaveBuffer", () => {
  it("only permits writes to the path whose content loaded", () => {
    assert.equal(canSaveBuffer("b.txt", "a.txt"), false);
    assert.equal(canSaveBuffer("a.txt", "a.txt"), true);
    assert.equal(canSaveBuffer("a.txt", null), false);
  });
});

describe("confirmUnsavedDiscard", () => {
  it("does not prompt when there are no dirty buffers", async () => {
    let prompted = false;
    assert.equal(await confirmUnsavedDiscard(0, async () => (prompted = true)), true);
    assert.equal(prompted, false);
  });

  it("requires confirmation and names the affected file count", async () => {
    let text = "";
    assert.equal(await confirmUnsavedDiscard(2, async (message) => {
      text = message;
      return false;
    }, "restart for the update"), false);
    assert.match(text, /2 unsaved files/);
    assert.match(text, /restart for the update/);
  });
});
