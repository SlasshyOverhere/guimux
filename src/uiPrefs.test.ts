// Chrome-preference validators. The regression this pins: `boolPref` has to
// keep reading the pre-JSON "0"/"1" the store used to write by hand, or every
// existing panel layout silently resets to the default on upgrade.
// Run: node --test src/uiPrefs.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boolPref, flagMap, numIn, stringArrayMap } from "./uiPrefs.ts";

describe("boolPref", () => {
  it("passes real booleans through", () => {
    assert.equal(boolPref(true), true);
    assert.equal(boolPref(false), false);
  });

  it("reads the pre-JSON 0/1 form", () => {
    assert.equal(boolPref(0), false);
    assert.equal(boolPref(1), true);
  });

  it("rejects anything else so the caller keeps its default", () => {
    assert.equal(boolPref("false"), null);
    assert.equal(boolPref(null), null);
    assert.equal(boolPref(2), null);
    assert.equal(boolPref(undefined), null);
  });
});

describe("numIn", () => {
  const check = numIn(10, 20);

  it("accepts the inclusive range", () => {
    assert.equal(check(10), 10);
    assert.equal(check(15), 15);
    assert.equal(check(20), 20);
  });

  it("rejects out-of-range and non-finite numbers", () => {
    assert.equal(check(9), null);
    assert.equal(check(21), null);
    assert.equal(check(Number.NaN), null);
    assert.equal(check(Infinity), null);
  });
});

describe("flagMap", () => {
  it("keeps only explicit true entries", () => {
    assert.deepEqual(flagMap({ a: true, b: false, c: true }), { a: true, c: true });
  });

  it("rejects non-records", () => {
    assert.equal(flagMap([1, 2]), null);
    assert.equal(flagMap(null), null);
  });
});

describe("stringArrayMap", () => {
  it("keeps only string arrays", () => {
    assert.deepEqual(stringArrayMap({ p: ["a", 1, null] }), { p: ["a"] });
  });

  it("drops keys whose value is not an array", () => {
    assert.deepEqual(stringArrayMap({ p: "nope" }), {});
  });

  it("rejects non-records", () => {
    assert.equal(stringArrayMap("nope"), null);
  });
});
