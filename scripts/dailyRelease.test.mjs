// Scheduled-release helpers: patch bumping, conventional-commit parsing,
// and note grouping. Run: node --test scripts/dailyRelease.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bumpPatch, compareSemver, maxVersion, parseSubject, parseVersion, releaseNotes } from "./daily-release.mjs";

describe("bumpPatch", () => {
  it("increments only the patch component", () => {
    assert.equal(bumpPatch("0.1.3"), "0.1.4");
    assert.equal(bumpPatch("0.1.9"), "0.1.10");
    assert.equal(bumpPatch("1.0.0"), "1.0.1");
  });

  it("rejects anything that is not a plain semver patch version", () => {
    for (const bad of ["", "v1.2.3", "1.2", "1.2.3-rc1", "next"]) {
      assert.throws(() => bumpPatch(bad), /semver|not a plain/);
    }
  });
});

describe("parseVersion", () => {
  it("accepts plain semver only", () => {
    assert.deepEqual(parseVersion("0.1.3"), { major: 0, minor: 1, patch: 3 });
    assert.equal(parseVersion("0.1.2-test1"), null);
    assert.equal(parseVersion("1.2"), null);
    assert.equal(parseVersion(undefined), null);
  });
});

describe("compareSemver", () => {
  it("orders numerically, not lexically", () => {
    assert.equal(compareSemver("0.1.9", "0.1.10"), -1);
    assert.equal(compareSemver("0.2.0", "0.1.99"), 1);
    assert.equal(compareSemver("0.1.3", "0.1.3"), 0);
  });

  it("maxVersion never walks a version backwards", () => {
    assert.equal(maxVersion("0.1.3", "0.2.0"), "0.2.0");
    assert.equal(maxVersion("0.3.0", "0.2.0"), "0.3.0");
  });
});

describe("parseSubject", () => {
  it("splits conventional commits into type, scope and text", () => {
    assert.deepEqual(parseSubject("fix(pty): drop stale watcher"), {
      type: "fix",
      scope: "pty",
      text: "drop stale watcher",
    });
    assert.deepEqual(parseSubject("docs: note the build gotcha"), {
      type: "docs",
      scope: null,
      text: "note the build gotcha",
    });
  });

  it("keeps a breaking-change marker but still classifies the commit", () => {
    assert.deepEqual(parseSubject("feat(api)!: drop v1"), {
      type: "feat",
      scope: "api",
      text: "drop v1",
    });
  });

  it("leaves a plain subject alone", () => {
    assert.deepEqual(parseSubject("wip"), { type: null, scope: null, text: "wip" });
  });
});

describe("releaseNotes", () => {
  const commits = [
    { sha: "aaaaaaa1111111", subject: "perf(pty): base64 output and coalesce flushes" },
    { sha: "bbbbbbb2222222", subject: "fix(sidebar): defer startup fan-out" },
    { sha: "ccccccc3333333", subject: "docs: note the build gotcha" },
    { sha: "ddddddd4444444", subject: "tweak a thing" },
  ];

  it("groups commits under conventional headings", () => {
    const notes = releaseNotes(commits, "0.1.4", "v0.1.3");
    assert.match(notes, /^## guimux 0\.1\.4/);
    assert.match(notes, /### Performance/);
    assert.match(notes, /### Bug fixes/);
    assert.match(notes, /### Documentation/);
    assert.match(notes, /### Other changes/);
    assert.match(notes, /Commits since v0\.1\.3\./);
  });

  it("keeps the scope as a bold prefix and the short sha as a ref", () => {
    const notes = releaseNotes(commits, "0.1.4", "v0.1.3");
    assert.match(notes, /- \*\*pty\*\*: base64 output and coalesce flushes \(`aaaaaaa`\)/);
  });

  it("orders groups consistently regardless of commit order", () => {
    const headings = (list) =>
      releaseNotes(list, "0.1.4", "v0.1.3")
        .split("\n")
        .filter((l) => l.startsWith("### "));
    const expected = headings(commits);
    assert.deepEqual(headings([...commits].reverse()), expected);
    assert.deepEqual(headings([commits[3], commits[1], commits[0], commits[2]]), expected);
  });

  it("does not emit empty headings", () => {
    const notes = releaseNotes([commits[1]], "0.1.4", "v0.1.3");
    assert.doesNotMatch(notes, /### Performance/);
    assert.doesNotMatch(notes, /### Documentation/);
  });

  it("still produces valid notes for an empty commit range", () => {
    const notes = releaseNotes([], "0.1.4", "v0.1.3");
    assert.match(notes, /No user-facing changes\./);
  });
});