// Tests planOrphanPrune / retiredDirExpired in index.js — the grace period
// that keeps a track image (or a retired playlist's folder) on disk for a week
// after it stops being used. The host keeps what the plugin handed it as local
// paths — a Home card for up to a day, the queue and Latest play for longer —
// and deleting the file the moment a mix rotated left those pointing at
// nothing.
//
// index.js runs only inside the host's sandbox, so the pure functions are
// extracted from source by brace-matching and evaluated in isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

function extractFn(name) {
  const src = readFileSync(INDEX_PATH, "utf8");
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(name + " not found in index.js");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return new Function("return (" + src.slice(start, i + 1) + ")")();
    }
  }
  throw new Error("unbalanced braces extracting " + name);
}

const planOrphanPrune = extractFn("planOrphanPrune");
const retiredDirExpired = extractFn("retiredDirExpired");

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 7 * DAY;
const NOW = 1_800_000_000_000;
const file = (name) => ({ name, isDir: false });

test("a file that just became unused is kept and its clock starts", () => {
  const plan = planOrphanPrune([file("track-a.jpg")], {}, {}, NOW, GRACE);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.orphans, { "track-a.jpg": NOW });
  assert.equal(plan.changed, true);
});

test("an old download that just became unused is still kept — the clock is orphan time, not mtime", () => {
  // modifiedAt says weeks ago; that must not matter.
  const plan = planOrphanPrune([{ name: "track-a.jpg", isDir: false, modifiedAt: (NOW - 60 * DAY) / 1000 }], {}, {}, NOW, GRACE);
  assert.deepEqual(plan.remove, []);
});

test("a file unused for less than the grace period is kept, unchanged", () => {
  const orphans = { "track-a.jpg": NOW - 6 * DAY };
  const plan = planOrphanPrune([file("track-a.jpg")], {}, orphans, NOW, GRACE);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.orphans, orphans);
  assert.equal(plan.changed, false);
});

test("a file unused for the whole grace period is removed and forgotten", () => {
  const plan = planOrphanPrune([file("track-a.jpg")], {}, { "track-a.jpg": NOW - GRACE }, NOW, GRACE);
  assert.deepEqual(plan.remove, ["track-a.jpg"]);
  assert.deepEqual(plan.orphans, {});
  assert.equal(plan.changed, true);
});

test("a file the tracklist uses is never removed, and coming back clears its clock", () => {
  const plan = planOrphanPrune([file("track-a.jpg")], { "track-a.jpg": true }, { "track-a.jpg": NOW - 30 * DAY }, NOW, GRACE);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.orphans, {});
  assert.equal(plan.changed, true);
});

test("only track-*.jpg files are ever considered", () => {
  const entries = [file("cover.jpg"), file("meta.json"), file("tracks.json"), file("orphans.json"), file("track-a.png"), { name: "track-dir.jpg", isDir: true }];
  const plan = planOrphanPrune(entries, {}, {}, NOW, GRACE);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.orphans, {});
  assert.equal(plan.changed, false);
});

test("a record for a file that is gone is dropped", () => {
  const plan = planOrphanPrune([], {}, { "track-gone.jpg": NOW - DAY }, NOW, GRACE);
  assert.deepEqual(plan.orphans, {});
  assert.equal(plan.changed, true);
});

test("nothing to do is reported as no change, so nothing is written", () => {
  const plan = planOrphanPrune([file("track-a.jpg")], { "track-a.jpg": true }, {}, NOW, GRACE);
  assert.equal(plan.changed, false);
  assert.equal(planOrphanPrune(null, {}, {}, NOW, GRACE).changed, false);
});

test("a garbage record restarts the clock instead of deleting", () => {
  const plan = planOrphanPrune([file("track-a.jpg")], {}, { "track-a.jpg": "yesterday" }, NOW, GRACE);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.orphans, { "track-a.jpg": NOW });
});

test("a retired playlist folder is swept only after the grace period", () => {
  assert.equal(retiredDirExpired({ retiredAt: NOW - 6 * DAY }, NOW, GRACE), false);
  assert.equal(retiredDirExpired({ retiredAt: NOW - GRACE }, NOW, GRACE), true);
});

test("a folder with no (or a broken) retired marker is never swept", () => {
  assert.equal(retiredDirExpired(null, NOW, GRACE), false);
  assert.equal(retiredDirExpired({}, NOW, GRACE), false);
  assert.equal(retiredDirExpired({ retiredAt: "x" }, NOW, GRACE), false);
});
