import { test } from "node:test";
import assert from "node:assert/strict";
import { extractScripts } from "./extract-scripts.mjs";

test("extracts the scrape scripts from index.js", () => {
  const s = extractScripts(new URL("../index.js", import.meta.url).pathname);

  // The two eval'd strings must be non-empty self-invoking functions.
  assert.match(s.SCRIPT_CHECK_LOGIN, /^\(function\(\)\{/);
  assert.match(s.SCRIPT_SCRAPE_SHELVES, /^\(function\(\)\{/);
  assert.ok(s.SCRIPT_SCRAPE_SHELVES.includes("__viboplr"), "scrape script uses the send bridge");

  // The two builders must be functions that produce eval'able strings.
  assert.equal(typeof s.scriptNavigatePlaylist, "function");
  assert.equal(typeof s.scriptScrollThenScrape, "function");
  assert.match(s.scriptNavigatePlaylist("abc123"), /abc123/);
  assert.match(s.scriptScrollThenScrape("abc123", 999), /abc123/);

  assert.equal(s.MUSIC_CHIP_URL, "https://open.spotify.com/home?facet=music-chip");
});

test("throws loudly when markers are missing", () => {
  assert.throws(
    () => extractScripts(new URL("../package.json", import.meta.url).pathname),
    /SCRAPE-SCRIPTS markers/
  );
});
