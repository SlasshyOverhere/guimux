// Run: node --test src/sidebar/removeGuard.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRemoveGuard } from "./removeGuard.ts";

const guard = (msg: string) => parseRemoveGuard(new Error(msg));

describe("parseRemoveGuard", () => {
  it("reads uncommitted changes", () => {
    const g = guard("worktree has uncommitted changes. Commit or merge first, or retry to discard them");
    assert.deepEqual(g, {
      dirty: true,
      unmerged: 0,
      base: null,
      summary: "has uncommitted changes",
    });
  });

  it("reads unmerged commits with the base branch", () => {
    const g = guard("worktree has 3 commits not in main. Commit or merge first, or retry to discard them");
    assert.equal(g?.dirty, false);
    assert.equal(g?.unmerged, 3);
    assert.equal(g?.base, "main");
    assert.equal(g?.summary, "has 3 unmerged commits (main)");
  });

  it("reads both reasons in one refusal", () => {
    const g = guard(
      "worktree has uncommitted changes and 1 commit not in master. Commit or merge first, or retry to discard them",
    );
    assert.equal(g?.dirty, true);
    assert.equal(g?.unmerged, 1);
    assert.equal(g?.summary, "has uncommitted changes and 1 unmerged commit (master)");
  });

  it("keeps dots inside a branch name while trimming the sentence period", () => {
    const g = guard("worktree has 2 commits not in release/1.0. Commit or merge first, or retry to discard them");
    assert.equal(g?.base, "release/1.0");
    assert.equal(g?.unmerged, 2);
  });

  it("returns null for failures that are not a guard", () => {
    assert.equal(guard("remove failed: permission denied"), null);
    assert.equal(guard("fatal: not a git repository"), null);
    assert.equal(guard(""), null);
    assert.equal(parseRemoveGuard(undefined), null);
  });

  it("keeps escalating when only the sentinel survives a reword", () => {
    const g = guard("some future reason, retry to discard them");
    assert.equal(g?.unmerged, 0);
    assert.equal(g?.summary, "has work that would be lost");
  });
});
