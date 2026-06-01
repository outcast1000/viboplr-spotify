import { test } from "node:test";
import assert from "node:assert/strict";
import { extractScripts } from "./extract-scripts.mjs";

// Resolve paths relative to this test file (ESM import.meta.url → filesystem path).
const resolvePath = (rel) => new URL(rel, import.meta.url).pathname;

test("extracts the scrape scripts from index.js", () => {
  const s = extractScripts(resolvePath("../index.js"));

  // The two eval'd strings must be non-empty self-invoking functions.
  assert.match(s.SCRIPT_CHECK_LOGIN, /^\(function\(\)\{/);
  assert.match(s.SCRIPT_SCRAPE_SHELVES, /^\(function\(\)\{/);
  assert.ok(s.SCRIPT_SCRAPE_SHELVES.includes("__viboplr"), "scrape script uses the send bridge");

  // The two builders must be functions that produce eval'able strings.
  assert.equal(typeof s.scriptNavigatePlaylist, "function");
  assert.equal(typeof s.scriptScrollThenScrape, "function");
  assert.match(s.scriptNavigatePlaylist("abc123"), /abc123/);
  assert.match(s.scriptScrollThenScrape("abc123", 999), /abc123/);

  // Smoke test: every eval'd script must be syntactically valid JS (the harness
  // eval()s these in Playwright). new Function(code) is a cheap parse-only check.
  assert.doesNotThrow(() => new Function(s.SCRIPT_CHECK_LOGIN), "SCRIPT_CHECK_LOGIN parses");
  assert.doesNotThrow(() => new Function(s.SCRIPT_SCRAPE_SHELVES), "SCRIPT_SCRAPE_SHELVES parses");
  assert.doesNotThrow(() => new Function(s.scriptNavigatePlaylist("abc123")), "scriptNavigatePlaylist parses");
  assert.doesNotThrow(() => new Function(s.scriptScrollThenScrape("abc123", 999)), "scriptScrollThenScrape parses");

  assert.equal(s.MUSIC_CHIP_URL, "https://open.spotify.com/home?facet=music-chip");
});

test("throws loudly when markers are missing", () => {
  assert.throws(
    () => extractScripts(resolvePath("../package.json")),
    /SCRAPE-SCRIPTS markers/
  );
});
