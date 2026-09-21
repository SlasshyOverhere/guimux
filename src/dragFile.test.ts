// OS file-drop bridge helpers: Tauri reports physical px relative to the
// webview, so mapping must stay proportional (scale and zoom cancel out).
// Run: node --test src/dragFile.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTauriPos, noteOsDrop, physicalToCss, quoteForShell, recentOsDrop } from "./dragFile.ts";

describe("normalizeTauriPos", () => {
  it("passes {x,y} through", () => {
    assert.deepEqual(normalizeTauriPos({ x: 960, y: 540 }), { x: 960, y: 540 });
  });

  it("accepts [x,y] tuples", () => {
    assert.deepEqual(normalizeTauriPos([960, 540]), { x: 960, y: 540 });
  });

  it("rejects missing or non-numeric coords", () => {
    for (const raw of [null, undefined, "960,540", 42, { x: 1 }, { y: 2 }, { x: "1", y: 2 }, [1]]) {
      assert.equal(normalizeTauriPos(raw), null, JSON.stringify(raw));
    }
  });
});

describe("physicalToCss", () => {
  it("maps proportionally, so scale and zoom need no constants", () => {
    // 150% OS scale: 1920 physical = 1280 css; drop at physical center.
    assert.deepEqual(
      physicalToCss({ x: 960, y: 540 }, { w: 1920, h: 1080 }, { w: 1280, h: 720 }),
      { x: 640, y: 360 },
    );
  });

  it("tracks the viewport when app zoom shrinks it", () => {
    // Same window at 1.25x app zoom: layout viewport is 1024 wide.
    assert.deepEqual(
      physicalToCss({ x: 960, y: 540 }, { w: 1920, h: 1080 }, { w: 1024, h: 576 }),
      { x: 512, y: 288 },
    );
  });

  it("returns null on a zero physical size instead of dividing by it", () => {
    assert.equal(physicalToCss({ x: 1, y: 1 }, { w: 0, h: 1080 }, { w: 1, h: 1 }), null);
  });
});

describe("quoteForShell", () => {
  it("quotes with a trailing space for prompt pasting", () => {
    assert.equal(quoteForShell("C:\\a\\b.txt"), '"C:\\a\\b.txt" ');
  });

  it("doubles a trailing backslash so it cannot escape the quote", () => {
    assert.equal(quoteForShell("C:\\a\\"), '"C:\\a\\\\" ');
  });
});

describe("recentOsDrop", () => {
  it("is true right after a drop, false with a zero window", () => {
    noteOsDrop();
    assert.equal(recentOsDrop(), true);
    assert.equal(recentOsDrop(0), false);
  });
});
