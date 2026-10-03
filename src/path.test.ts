import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  baseName,
  normSep,
  normalizePath,
  pathSegments,
  pathStartsRoot,
  relPath,
  siblingPath,
  shortPath,
} from "./path.ts";

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

describe("display form", () => {
  it("uses forward slashes and drops the trailing separator", () => {
    assert.equal(normSep("C:\\repo\\src\\"), "C:/repo/src");
  });

  it("takes the last segment", () => {
    assert.equal(baseName("C:\\repo\\src\\app.tsx"), "app.tsx");
    assert.equal(baseName("solo"), "solo");
  });
});

describe("shortPath", () => {
  it("keeps the full path when asked", () => {
    assert.equal(shortPath("D:\\a\\b\\c", true), "D:\\a\\b\\c");
  });

  it("keeps the last two segments so long paths do not wrap mid-segment", () => {
    assert.equal(shortPath("D:\\work\\guimux\\src\\terminal", false), "…/src/terminal");
  });

  it("leaves short paths alone", () => {
    assert.equal(shortPath("D:\\work", false), "D:\\work");
  });
});

describe("relPath", () => {
  it("strips the root", () => {
    assert.equal(relPath("C:\\repo", "C:\\repo\\src\\a.ts"), "src/a.ts");
  });

  it("returns the path untouched when it is outside the root", () => {
    assert.equal(relPath("C:\\repo", "D:\\other\\a.ts"), "D:/other/a.ts");
  });
});

describe("siblingPath", () => {
  it("replaces the last segment and keeps the separator", () => {
    assert.equal(siblingPath("C:\\repo\\src\\a.ts", "b.ts"), "C:\\repo\\src\\b.ts");
    assert.equal(siblingPath("/repo/a.ts", "b.ts"), "/repo/b.ts");
  });

  it("handles a bare name", () => {
    assert.equal(siblingPath("a.ts", "b.ts"), "b.ts");
  });
});

describe("pathSegments", () => {
  it("returns the ancestor directories, outermost first", () => {
    assert.deepEqual(pathSegments("/repo", "/repo/src/terminal/a.ts"), ["src", "terminal"]);
  });

  it("is empty for a file at the root", () => {
    assert.deepEqual(pathSegments("/repo", "/repo/a.ts"), []);
  });

  it("is empty when the file is outside the root", () => {
    assert.deepEqual(pathSegments("/repo", "/elsewhere/a.ts"), []);
  });
});