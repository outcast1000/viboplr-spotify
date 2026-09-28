// Tests viewHeaderFor in index.js: the header the host draws over the Spotify
// view (api.ui.setViewHeader, host >= 1.0.77). Extracted from source by
// brace-matching and eval'd in isolation, like image-url.test.mjs — so this
// runs the REAL function.
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

const viewHeaderFor = extractFn("viewHeaderFor");
const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"));

const base = { status: "idle", refreshing: false, playlists: 0, shelves: 0, lastSync: "", lastCheckFailed: false };
const h = (over) => viewHeaderFor({ ...base, ...over });

test("fresh install: manifest subtitle, Not synced", () => {
  const r = h({});
  assert.equal(r.subtitle, MANIFEST.viewHeader.subtitle);
  assert.deepEqual(r.status, { variant: "muted", label: "Not synced" });
});

test("synced library: counts + last sync in the subtitle, Synced", () => {
  const r = h({ status: "done", playlists: 24, shelves: 6, lastSync: "29 Sep, 14:32" });
  assert.equal(r.subtitle, "24 playlists on 6 shelves · last sync 29 Sep, 14:32");
  assert.deepEqual(r.status, { variant: "success", label: "Synced" });
});

test("singular counts and no timestamp", () => {
  assert.equal(h({ playlists: 1, shelves: 1 }).subtitle, "1 playlist on 1 shelf");
});

test("a sync in progress (incl. the login check and a silent refresh) reads as Syncing…", () => {
  for (const over of [{ status: "waiting-login" }, { status: "running" }, { status: "done", refreshing: true, playlists: 3, shelves: 1 }]) {
    assert.deepEqual(h(over).status, { variant: "muted", label: "Syncing…" });
  }
  assert.match(h({ status: "running", playlists: 3, shelves: 1 }).subtitle, /^3 playlists/);
});

test("a failed sync is an error; a failed last check afterwards is a warning", () => {
  assert.deepEqual(h({ status: "error", lastCheckFailed: true }).status, { variant: "error", label: "Sync failed" });
  assert.deepEqual(h({ status: "done", playlists: 5, shelves: 2, lastCheckFailed: true }).status, { variant: "warning", label: "Last sync failed" });
});

test("stays within the host's limits and sets no actions", () => {
  const r = h({ status: "done", playlists: 12345, shelves: 999, lastSync: "29 Sep 2026, 14:32:00" });
  assert.ok(r.subtitle.length <= 160);
  assert.ok(r.status.label.length <= 32);
  assert.equal(r.actions, undefined);
  assert.ok(["success", "warning", "error", "muted"].includes(r.status.variant));
});
