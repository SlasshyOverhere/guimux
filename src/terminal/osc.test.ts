import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOsc, extractLiveCwd, sessionNameFrom } from "./osc.ts";

const BEL = "\x07";
const ST = "\x1b\\";

test("reads the cwd from OSC 9;9 and OSC 7", () => {
  assert.equal(extractLiveCwd(`\x1b]9;9;D:\\work\\repo${BEL}`), "D:\\work\\repo");
  assert.equal(
    extractLiveCwd(`\x1b]7;file://host/D:/work/repo${BEL}`),
    "D:\\work\\repo",
  );
  // A UNC share arrives as `file://server/share/x`, indistinguishable from a
  // drive host, so it is reported as "no cwd" rather than guessed at. The pane
  // then keeps the cwd it was launched in.
  assert.equal(extractLiveCwd(`\x1b]7;file://server/share/x${BEL}`), null);
});

test("accepts ST as well as BEL as the string terminator", () => {
  assert.equal(extractLiveCwd(`\x1b]9;9;/home/me/src${ST}`), "/home/me/src");
  assert.equal(parseOsc(`\x1b]2;my session${ST}`).title, "my session");
});

test("percent-decodes the OSC 7 path and drops the host", () => {
  assert.equal(
    extractLiveCwd(`\x1b]7;file://host/D:/a%20b/c${BEL}`),
    "D:\\a b\\c",
  );
});

test("a broken escape yields the raw path rather than throwing", () => {
  assert.equal(extractLiveCwd(`\x1b]7;file://host/D:/a%zz/c${BEL}`), "D:\\a%zz\\c");
});

test("last sequence in the buffer wins", () => {
  const buf = `\x1b]9;9;D:\\first${BEL}noise\x1b]9;9;D:\\second${BEL}`;
  assert.equal(extractLiveCwd(buf), "D:\\second");
});

test("parses window titles from OSC 0 and 2 and strips shell decorations", () => {
  assert.equal(parseOsc(`\x1b]2;fix the parser${BEL}`).title, "fix the parser");
  // OSC 0 carries "icon;window". With no icon segment the title is the only one.
  assert.equal(parseOsc(`\x1b]0;my-icon;fix the parser${BEL}`).title, "fix the parser");
  assert.equal(parseOsc(`\x1b]0;fix the parser${BEL}`).title, "fix the parser");
  assert.equal(parseOsc(`\x1b]2;✗ D:\\work${BEL}`).title, "D:\\work");
  // OSC 1 names the icon only; it never carries a window title.
  assert.equal(parseOsc(`\x1b]1;icon-name${BEL}`).title, null);
});

test("plain output has no cwd and no title", () => {
  assert.deepEqual(parseOsc("total 0\r\ndone\r\n"), { cwd: null, title: null });
});

test("an agent session name is believed", () => {
  assert.equal(sessionNameFrom("fix the flaky pane test", "D:\\work\\repo"), "fix the flaky pane test");
  assert.equal(sessionNameFrom("refactor: split panes", null), "refactor: split panes");
});

test("the shell's own cwd title is never mistaken for a session name", () => {
  // Both decorations, both spellings, plus the branch suffix some shells add.
  assert.equal(sessionNameFrom("D:\\work\\repo", "D:\\work\\repo"), null);
  assert.equal(sessionNameFrom("✗ D:\\work\\repo", "D:\\work\\repo"), null);
  assert.equal(sessionNameFrom("~ D:/work/repo (main)", "D:\\work\\repo"), null);
  assert.equal(sessionNameFrom("/home/me/src", "/home/me/src"), null);
});

test("bare paths, blanks and icons are rejected", () => {
  assert.equal(sessionNameFrom("D:\\somewhere\\else", "D:\\work\\repo"), null);
  assert.equal(sessionNameFrom("   ", "D:\\work"), null);
  assert.equal(sessionNameFrom(null, "D:\\work"), null);
  // An agent that renames itself to a spinner or a pid is not naming a session.
  assert.equal(sessionNameFrom("⠋", "D:\\work"), null);
  assert.equal(sessionNameFrom("12345", "D:\\work"), null);
  // Absurd length is a leaked buffer, not a title.
  assert.equal(sessionNameFrom("x".repeat(200), "D:\\work"), null);
});
