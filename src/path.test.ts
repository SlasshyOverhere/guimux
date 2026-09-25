import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, pathStartsRoot } from "./path.ts";

describe("path normalization", () => {
  it("normalizes separators and trailing slashes", () => {
    assert.equal(normalizePath("C:\\repo\\", false), "C:/repo");
  });

  it("matches Windows paths case-insensitively", () => {
    assert.equal(pathStartsRoot("C:/Repo", "c:\\repo\\src\\file.ts", true), true);
  });

  it("does not treat a sibling prefix as a child", () => {
    assert.equal(pathStartsRoot("/repo", "/repo-old/file.ts", false), false);
  });
});
