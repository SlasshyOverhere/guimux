#!/usr/bin/env node
// Version planning for the scheduled daily release.
//
//   node scripts/daily-release.mjs plan  --base-ref origin/main --out plan.json
//   node scripts/daily-release.mjs bump  <version>
//   node scripts/daily-release.mjs notes <fromTag> <baseRef> --out notes.md
//
// The pure helpers are exported so `node --test` can cover them without git.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

/** 0.1.3 -> 0.1.4. Patch only: the daily job must never surprise a major bump. */
export function bumpPatch(version) {
  const v = parseVersion(version);
  if (!v) throw new Error(`not a plain semver patch version: ${version}`);
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

/**
 * Strict x.y.z only. Prerelease tags such as v0.1.2-test1 are real releases
 * but must never become the base we bump from, and must not crash the job.
 */
export function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? "").trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function compareSemver(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

export const maxVersion = (a, b) => (compareSemver(a, b) >= 0 ? a : b);

const GROUPS = [
  ["feat", "Features"],
  ["fix", "Bug fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactors"],
  ["style", "Refactors"],
  ["revert", "Refactors"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "CI"],
  ["chore", "Maintenance"],
];

/** "fix(pty): drop stale watcher" -> { type: "fix", scope: "pty", text: "drop stale watcher" } */
export function parseSubject(subject) {
  const m = /^([a-z]+)(?:\(([^)]+)\))?!?:\s+(.*)$/.exec(subject);
  if (!m) return { type: null, scope: null, text: subject };
  return { type: m[1], scope: m[2] ?? null, text: m[3] };
}

export function releaseNotes(commits, version, lastTag) {
  const grouped = new Map();
  for (const c of commits) {
    const parsed = parseSubject(c.subject);
    const heading = GROUPS.find(([type]) => type === parsed.type)?.[1] ?? "Other changes";
    if (!grouped.has(heading)) grouped.set(heading, []);
    grouped.get(heading).push({ ...c, parsed });
  }
  const order = [...GROUPS.map(([, h]) => h), "Other changes"];
  const lines = [`## guimux ${version}`, ""];
  if (lastTag) {
    lines.push(`Commits since ${lastTag}.`, "");
  }
  if (commits.length === 0) {
    lines.push("_No user-facing changes._");
    return `${lines.join("\n")}\n`;
  }
  for (const heading of order) {
    const rows = grouped.get(heading);
    if (!rows?.length) continue;
    lines.push(`### ${heading}`, "");
    for (const c of rows) {
      const scope = c.parsed.scope ? `**${c.parsed.scope}**: ` : "";
      lines.push(`- ${scope}${c.parsed.text} (\`${c.sha.slice(0, 7)}\`)`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const exec = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function currentPackageVersion() {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

function allTags() {
  const out = exec(["tag", "--list", "v*", "--sort=-v:refname"]).trim();
  return out ? out.split("\n") : [];
}

/** Newest v* tag by version, prereleases included: what has been released. */
function latestTag(tags) {
  return tags[0] ?? null;
}

/** Highest strict semver across tags and package.json, ignoring prereleases. */
function versionBase(tags) {
  const candidates = tags.map((t) => t.replace(/^v/, "")).filter((v) => parseVersion(v));
  candidates.push(currentPackageVersion());
  return candidates.reduce((acc, v) => (compareSemver(v, acc) > 0 ? v : acc));
}

function commitsSince(from, to) {
  const range = from ? `${from}..${to}` : to;
  const raw = exec([
    "log",
    "--no-merges",
    "--pretty=format:%H%x1f%s%x1f%b%x1e",
    range,
  ]);
  return raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject] = r.split("\x1f");
      return { sha: sha.trim(), subject: (subject || "").trim() };
    });
}

export function plan(baseRef = "origin/main") {
  const tags = allTags();
  const tag = latestTag(tags);
  // Bump past the highest real version seen anywhere (tags or package.json),
  // so neither a hand-made tag nor a manual prerelease can collide with us.
  const nextVersion = bumpPatch(versionBase(tags));
  const baseSha = exec(["rev-parse", baseRef]).trim();
  const commits = commitsSince(tag, baseSha);
  return {
    shouldRelease: commits.length > 0,
    lastTag: tag,
    baseRef,
    baseSha,
    nextVersion,
    tag: `v${nextVersion}`,
    commitCount: commits.length,
    commits,
  };
}

/** Rewrite the version everywhere Tauri and Cargo read it. Asserts each edit landed. */
export function bump(version) {
  const current = currentPackageVersion();
  for (const file of VERSION_FILES) {
    const text = readFileSync(file, "utf8");
    let next;
    if (file === "package-lock.json") {
      // The lock repeats the package version at the root and under packages[""].
      next = text.replace(
        /("name": "guimux",\r?\n\s*"version": ")[^"]+(")/g,
        `$1${version}$2`,
      );
    } else if (file === "src-tauri/Cargo.lock") {
      next = text.replace(
        // \r? because a Windows checkout of Cargo.lock keeps CRLF endings.
        /(name = "guimux"\r?\nversion = ")[^"]+(")/,
        `$1${version}$2`,
      );
    } else if (file === "src-tauri/Cargo.toml") {
      next = text.replace(/^version = "[^"]+"/m, `version = "${version}"`);
    } else {
      next = text.replace(`"version": "${current}"`, `"version": "${version}"`);
    }
    if (next === text) throw new Error(`version bump did not match in ${file}`);
    writeFileSync(file, next);
  }
  return version;
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

function main(argv) {
  const [cmd, ...args] = argv;
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (cmd === "plan") {
    const out = arg("out");
    const result = plan(arg("base-ref") ?? "origin/main");
    if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      `${result.shouldRelease ? "RELEASE" : "NO CHANGE"}: ${result.commitCount} new commit(s) on ${result.baseRef}` +
        (result.shouldRelease ? ` -> ${result.tag}` : ` since ${result.lastTag}`),
    );
  } else if (cmd === "bump") {
    console.log(bump(args[0]));
  } else if (cmd === "notes") {
    const [fromTag, baseRef] = args;
    const out = arg("out");
    const commits = commitsSince(fromTag, baseRef);
    const version = (arg("version") ?? fromTag ?? "next").replace(/^v/, "");
    const text = releaseNotes(commits, version, fromTag);
    if (out) writeFileSync(out, text);
    else process.stdout.write(text);
  } else {
    console.error("usage: daily-release.mjs <plan|bump|notes> ...");
    process.exit(2);
  }
}

// Only drive the CLI when run directly; importing must stay side-effect free
// so `node --test` can pull in the pure helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(rest.length || process.argv.length > 2 ? [command, ...rest] : []);
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
}