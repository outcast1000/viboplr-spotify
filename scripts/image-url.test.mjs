// Tests the upgradeImageUrl / downgradeImageUrl helpers in index.js, which
// swap Spotify CDN size tokens so track art caches at 640px instead of the
// 64px thumbnail the web app's tracklist rows serve. The tokens are scraped
// knowledge (album art ids: ab67616d0000<size><32 hex>; mosaic covers:
// mosaic.scdn.co/<size>/...), so pin them here.
//
// index.js runs only inside the host's new Function sandbox, so we can't import
// it. Instead we extract the (pure, self-contained) functions from source by
// brace-matching and eval them in isolation — testing the REAL code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) so the path is valid on Windows too — .pathname
// yields "/D:/…", which fails to open.
const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

// Pull `function <name>(...) { ... }` out of index.js by brace-matching from
// the declaration to its matching close brace.
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
      if (depth === 0) {
        const body = src.slice(start, i + 1);
        return new Function("return (" + body + ")")();
      }
    }
  }
  throw new Error("unbalanced braces extracting " + name);
}

const upgradeImageUrl = extractFn("upgradeImageUrl");
const downgradeImageUrl = extractFn("downgradeImageUrl");

const HASH = "ab1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";

test("upgrades 64px and 300px album art to the 640px variant", () => {
  assert.equal(
    upgradeImageUrl("https://i.scdn.co/image/ab67616d00004851" + HASH),
    "https://i.scdn.co/image/ab67616d0000b273" + HASH
  );
  assert.equal(
    upgradeImageUrl("https://i.scdn.co/image/ab67616d00001e02" + HASH),
    "https://i.scdn.co/image/ab67616d0000b273" + HASH
  );
});

test("upgrades mosaic covers to 640", () => {
  assert.equal(
    upgradeImageUrl("https://mosaic.scdn.co/60/aaa/bbb/ccc/ddd"),
    "https://mosaic.scdn.co/640/aaa/bbb/ccc/ddd"
  );
  assert.equal(
    upgradeImageUrl("https://mosaic.scdn.co/300/aaa/bbb/ccc/ddd"),
    "https://mosaic.scdn.co/640/aaa/bbb/ccc/ddd"
  );
});

test("upgrade is idempotent and leaves unknown URLs untouched", () => {
  const hi = "https://i.scdn.co/image/ab67616d0000b273" + HASH;
  assert.equal(upgradeImageUrl(hi), hi);
  assert.equal(upgradeImageUrl(upgradeImageUrl("https://mosaic.scdn.co/60/x")), "https://mosaic.scdn.co/640/x");
  // Pickasso (personalized playlist covers) have no size token — pass through.
  const pickasso = "https://pickasso.spotifycdn.com/image/ab67c0de/dt/v1/img/radio/artist/xyz/en";
  assert.equal(upgradeImageUrl(pickasso), pickasso);
  // Non-http (local cached paths, null) pass through — cacheAllImages calls
  // this on every pass, including tracks already resolved to disk paths.
  assert.equal(upgradeImageUrl("C:\\cache\\track-123.jpg"), "C:\\cache\\track-123.jpg");
  assert.equal(upgradeImageUrl(null), null);
  assert.equal(upgradeImageUrl(""), "");
});

test("downgrade reverses to the variants the web app itself serves", () => {
  assert.equal(
    downgradeImageUrl("https://i.scdn.co/image/ab67616d0000b273" + HASH),
    "https://i.scdn.co/image/ab67616d00004851" + HASH
  );
  assert.equal(
    downgradeImageUrl("https://mosaic.scdn.co/640/aaa"),
    "https://mosaic.scdn.co/300/aaa"
  );
  // A URL with no known token downgrades to itself — the caller uses equality
  // to decide there is no fallback left and rethrows the original error.
  const pickasso = "https://pickasso.spotifycdn.com/image/ab67c0de/dt/v1/img/radio/artist/xyz/en";
  assert.equal(downgradeImageUrl(pickasso), pickasso);
  assert.equal(downgradeImageUrl(null), null);
});
