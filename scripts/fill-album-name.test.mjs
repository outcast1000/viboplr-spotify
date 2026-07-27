// Tests the fillAlbumName helper in index.js, which backfills each track's
// `album` from the album entry's own title. Spotify's album page omits the
// per-row album column (every track shares the page's album), so the row
// scraper returns album="" for album-kind entries — this helper repairs that.
//
// index.js runs only inside the host's new Function sandbox, so we can't import
// it. Instead we extract the (pure, self-contained) fillAlbumName function from
// source by brace-matching and eval it in isolation — testing the REAL code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) so the path is valid on Windows too — .pathname
// yields "/D:/…", which fails to open.
const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

// Pull `function fillAlbumName(...) { ... }` out of index.js by brace-matching
// from the declaration to its matching close brace.
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

const fillAlbumName = extractFn("fillAlbumName");

test("album entry: fills empty album with the entry name", () => {
  const pl = { kind: "album", name: "Random Access Memories" };
  const tracks = [{ name: "Get Lucky", album: "" }, { name: "Doin' it Right" }];
  fillAlbumName(pl, tracks);
  assert.equal(tracks[0].album, "Random Access Memories");
  assert.equal(tracks[1].album, "Random Access Memories");
});

test("album entry: does not overwrite an album the scraper did find", () => {
  const pl = { kind: "album", name: "Album Title" };
  const tracks = [{ name: "x", album: "Soundtrack Vol. 1" }];
  fillAlbumName(pl, tracks);
  assert.equal(tracks[0].album, "Soundtrack Vol. 1");
});

test("playlist entry: leaves albums untouched (column is present on playlist pages)", () => {
  const pl = { kind: "playlist", name: "My Mix" };
  const tracks = [{ name: "x", album: "" }, { name: "y", album: "Real Album" }];
  fillAlbumName(pl, tracks);
  assert.equal(tracks[0].album, "");
  assert.equal(tracks[1].album, "Real Album");
});

test("returns tracks; tolerates null/odd inputs", () => {
  assert.doesNotThrow(() => fillAlbumName(null, []), "no throw on null pl");
  assert.deepEqual(fillAlbumName({ kind: "album", name: "" }, [{ album: "" }]), [{ album: "" }], "empty name: no fill");
  const t = [{ album: "" }];
  assert.equal(fillAlbumName({ kind: "album", name: "A" }, t), t, "returns the same array (mutated in place)");
});
