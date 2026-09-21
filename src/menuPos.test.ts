// Menu placement under app zoom. Rendered offset is `left * zoom`, so these
// assert in rendered space: the menu must sit on the pointer and stay inside
// the viewport at every zoom the app allows (0.5 - 2).
// Run: node --test src/menuPos.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { menuPos } from "./menuPos.ts";

const menu = { w: 192, h: 210 };
const view = (zoom: number, w = 1000, h = 800) => ({ zoom, w, h });
const rendered = (v: number, zoom: number) => Math.round(v * zoom * 100) / 100;

describe("menuPos", () => {
  it("is the identity at zoom 1", () => {
    const p = menuPos(120, 90, menu, view(1));
    assert.equal(p.left, 120);
    assert.equal(p.top, 90);
  });

  it("lands the menu on the pointer at every zoom", () => {
    for (const zoom of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const p = menuPos(300, 200, menu, view(zoom));
      assert.equal(rendered(p.left, zoom), 300, `left at zoom ${zoom}`);
      assert.equal(rendered(p.top, zoom), 200, `top at zoom ${zoom}`);
    }
  });

  it("keeps the menu inside the viewport when the click is near the edge", () => {
    for (const zoom of [0.5, 1, 1.5, 2]) {
      const v = view(zoom);
      const p = menuPos(v.w, v.h, menu, v);
      assert.ok(p.left >= 0 && rendered(p.left, zoom) + menu.w * zoom <= v.w + 0.01, `right edge at zoom ${zoom}`);
      assert.ok(p.top >= 0 && rendered(p.top, zoom) + menu.h * zoom <= v.h + 0.01, `bottom edge at zoom ${zoom}`);
    }
  });

  it("parks at the origin when the menu cannot fit", () => {
    const p = menuPos(500, 500, menu, view(1, 150, 100));
    assert.deepEqual(p, { left: 0, top: 0 });
  });

  it("treats a zero zoom as 1 instead of dividing by it", () => {
    assert.deepEqual(menuPos(40, 50, menu, view(0)), { left: 40, top: 50 });
  });
});
