// Porcelain letter precedence. The regression this pins: a staged addition
// came back as "·" (index "A" matched no branch) and a file deleted from the
// worktree read "M" whenever it was also staged-modified.
// Run: node --test src/sidebar/statusLetter.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statusLetter } from "./statusLetter.ts";

const s = (index: string, workdir: string) => ({ path: "f.txt", index_status: index, workdir_status: workdir });
const letter = (index: string, workdir: string) => statusLetter(s(index, workdir)).letter;

describe("statusLetter", () => {
  it("maps the porcelain columns to one letter", () => {
    assert.equal(letter("?", "?"), "A"); // untracked
    assert.equal(letter("A", " "), "A"); // staged addition
    assert.equal(letter(" ", "M"), "M"); // modified in the worktree
    assert.equal(letter("M", " "), "M"); // staged modification
    assert.equal(letter("R", " "), "R"); // rename
    assert.equal(letter(" ", "D"), "D"); // deleted
    assert.equal(letter(" ", " "), "·"); // nothing
  });

  it("prefers deletion over a staged modification", () => {
    assert.equal(letter("M", "D"), "D");
  });

  it("prefers a staged addition over a later worktree edit", () => {
    assert.equal(letter("A", "M"), "A");
  });

  it("keeps colours on the state tokens", () => {
    for (const [i, w] of [["?", "?"], ["A", " "], [" ", "M"], [" ", "D"]] as const) {
      assert.match(statusLetter(s(i, w)).color, /^var\(--gm-/);
    }
  });
});
