import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCombo, parseCombo, prettyCombo } from "./combo.ts";

// Minimal stand-in for KeyboardEvent: only the fields matchCombo reads.
type Mods = Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>>;
const ev = (key: string, mods: Mods = {}) =>
  ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

test("parseCombo reads modifiers in any order", () => {
  assert.deepEqual(parseCombo("Ctrl+Shift+D"), { ctrl: true, shift: true, alt: false, key: "D" });
  assert.deepEqual(parseCombo("Shift+Ctrl+,"), { ctrl: true, shift: true, alt: false, key: "," });
  assert.deepEqual(parseCombo("Ctrl+Alt+ArrowRight"), {
    ctrl: true,
    shift: false,
    alt: true,
    key: "ArrowRight",
  });
  // Mod is the cross-platform spelling of Ctrl/Cmd.
  assert.equal(parseCombo("Mod+K").ctrl, true);
});

test("a chord requires every modifier it names and rejects extras", () => {
  assert.ok(matchCombo(ev("d", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+D"));
  // Shift+letter arrives uppercase from the browser.
  assert.ok(matchCombo(ev("D", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+D"));
  // Ctrl+B must not swallow Ctrl+Shift+B.
  assert.equal(matchCombo(ev("B", { ctrlKey: true, shiftKey: true }), "Ctrl+B"), false);
  assert.equal(matchCombo(ev("b", { ctrlKey: true }), "Ctrl+Shift+B"), false);
  // A bare letter binding must not fire while a modifier is held.
  assert.equal(matchCombo(ev("b", { ctrlKey: true }), "B"), false);
});

test("alt and no-modifier chords behave", () => {
  assert.ok(matchCombo(ev("ArrowRight", { ctrlKey: true, altKey: true }), "Ctrl+Alt+ArrowRight"));
  assert.equal(matchCombo(ev("ArrowRight", { ctrlKey: true }), "Ctrl+Alt+ArrowRight"), false);
  assert.ok(matchCombo(ev("F5"), "F5"));
  assert.equal(matchCombo(ev("F4"), "F5"), false);
});

test("cmd satisfies a Ctrl chord, because WebView2 and macOS differ", () => {
  assert.ok(matchCombo(ev("k", { metaKey: true }), "Ctrl+K"));
  // Cmd is not "no modifier": it still must not fire a bare chord.
  assert.equal(matchCombo(ev("k", { metaKey: true }), "K"), false);
});

test("punctuation keys match exactly", () => {
  assert.ok(matchCombo(ev(",", { ctrlKey: true }), "Ctrl+,"));
  assert.equal(matchCombo(ev(".", { ctrlKey: true }), "Ctrl+,"), false);
  assert.ok(matchCombo(ev("?", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+?"));
  assert.equal(matchCombo(ev("/", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+?"), false);
});

test("prettyCombo swaps key names for the glyphs on a keycap", () => {
  assert.equal(prettyCombo("Ctrl+Alt+ArrowRight"), "Ctrl+Alt+→");
  assert.equal(prettyCombo("Ctrl+Shift+ArrowDown"), "Ctrl+Shift+↓");
  assert.equal(prettyCombo("Ctrl+Shift+Enter"), "Ctrl+Shift+↵");
  // Letters and punctuation are already their own glyphs.
  assert.equal(prettyCombo("Ctrl+Shift+D"), "Ctrl+Shift+D");
  assert.equal(prettyCombo("Ctrl+,"), "Ctrl+,");
  assert.equal(prettyCombo("Ctrl+Shift+?"), "Ctrl+Shift+?");
});
