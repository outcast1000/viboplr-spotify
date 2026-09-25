// Tests the pure catalog-lookup helpers (album tracklist, track plays, artist
// listeners): the candidate pickers and the count parsers. The candidate
// fixtures are shaped exactly like scriptSearchCandidates' output and were
// taken from the live site on 2026-09-25 (see `npm run verify:all`, which
// runs the same functions on today's pages).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { extractScripts } from "./extract-scripts.mjs";

const S = extractScripts(fileURLToPath(new URL("../index.js", import.meta.url)));

// /search/Karma Police Radiohead/tracks
const TRACK_ROWS = [
  { kind: "track", id: "63OQupATfueTdZMWTxW03A", title: "Karma Police", artists: ["Radiohead"], albumId: "6dVIqQ8qmQ5GBnJ9shOYGE", albumName: "OK Computer" },
  { kind: "track", id: "70VjECXPkO7APS1bAj4wEN", title: "Karma Police - Remastered", artists: ["Radiohead"], albumId: "0tzfI6NFJqcJkWb23R3lRZ", albumName: "OK Computer OKNOTOK 1997 2017" },
  { kind: "track", id: "07DvRMhMBY2ue8gMoWZdRP", title: "Karma Police", artists: ["Radiohead"], albumId: "4jRXvY6sq0s4otFU4pAWoV", albumName: "Karma Police" },
];
// /search/Radiohead OK Computer/albums
const ALBUM_CARDS = [
  { kind: "album", id: "0tzfI6NFJqcJkWb23R3lRZ", title: "OK Computer OKNOTOK 1997 2017", artists: ["Radiohead"] },
  { kind: "album", id: "6dVIqQ8qmQ5GBnJ9shOYGE", title: "OK Computer", artists: ["Radiohead"] },
  { kind: "album", id: "5pENEl0DGwi6kkiaft2D73", title: "MCP Performs Radiohead: OK Computer (Instrumental Version)", artists: ["Molotov Cocktail Piano"] },
];
// /search/Radiohead/artists
const ARTIST_CARDS = [
  { kind: "artist", id: "4Z8W4fKeB5YxbusRsdQVPb", title: "Radiohead" },
  { kind: "artist", id: "6olE6TJLqED3rqDCT0FyPh", title: "Nirvana" },
];

test("normalizeName folds case, accents, punctuation and a leading 'the'", () => {
  assert.equal(S.normalizeName("Björk"), "bjork");
  assert.equal(S.normalizeName("The Beatles"), "beatles");
  assert.equal(S.normalizeName("Simon & Garfunkel"), "simon and garfunkel");
  assert.equal(S.normalizeName("  AC/DC "), "ac dc");
  assert.equal(S.normalizeName("Μάνος Χατζιδάκις"), "μανος χατζιδακις");
  assert.equal(S.normalizeName(null), "");
});

test("coreTitle drops edition noise", () => {
  assert.equal(S.coreTitle("Karma Police - Remastered"), "karma police");
  assert.equal(S.coreTitle("Where Is My Mind? - 2007 Remaster"), "where is my mind");
  assert.equal(S.coreTitle("Paranoid Android (Live) [2009]"), "paranoid android");
});

test("artistMatches accepts the lead name of a credit string", () => {
  assert.ok(S.artistMatches(["Radiohead"], "radiohead"));
  assert.ok(S.artistMatches(["Daft Punk", "Pharrell Williams"], "Daft Punk feat. Pharrell Williams"));
  assert.ok(S.artistMatches(["Simon & Garfunkel"], "Simon and Garfunkel"));
  assert.ok(S.artistMatches(["Björk"], "Bjork"));
  assert.ok(!S.artistMatches(["Radiohead"], "Thom Yorke"));
  assert.ok(!S.artistMatches([], "Radiohead"));
  assert.ok(!S.artistMatches(["Radiohead"], ""));
});

test("pickTrackCandidate: exact title in Spotify order, album hint wins ties", () => {
  assert.equal(S.pickTrackCandidate(TRACK_ROWS, "Karma Police", "Radiohead").id, "63OQupATfueTdZMWTxW03A");
  // The single's album hint lifts the third row over the first.
  assert.equal(S.pickTrackCandidate(TRACK_ROWS, "Karma Police", "Radiohead", "Karma Police").id, "07DvRMhMBY2ue8gMoWZdRP");
  // The same edition spelled differently is an exact match…
  assert.equal(S.pickTrackCandidate(TRACK_ROWS, "Karma Police (Remastered)", "Radiohead").id, "70VjECXPkO7APS1bAj4wEN");
  // …and an edition Spotify doesn't list falls back to the song itself.
  assert.equal(S.pickTrackCandidate(TRACK_ROWS, "Karma Police (Live at Glastonbury)", "Radiohead").id, "63OQupATfueTdZMWTxW03A");
  assert.equal(S.pickTrackCandidate(TRACK_ROWS, "Karma Police", "Nirvana"), null);
  assert.equal(S.pickTrackCandidate(TRACK_ROWS, "Creep", "Radiohead"), null);
  assert.equal(S.pickTrackCandidate(ALBUM_CARDS, "OK Computer", "Radiohead"), null, "album cards are never tracks");
});

test("pickAlbumCandidate prefers the exact name over an edition and requires the artist", () => {
  assert.equal(S.pickAlbumCandidate(ALBUM_CARDS, "OK Computer", "Radiohead").id, "6dVIqQ8qmQ5GBnJ9shOYGE");
  assert.equal(S.pickAlbumCandidate(ALBUM_CARDS, "OK Computer OKNOTOK 1997 2017", "Radiohead").id, "0tzfI6NFJqcJkWb23R3lRZ");
  // A tribute album by another artist never matches.
  assert.equal(S.pickAlbumCandidate(ALBUM_CARDS, "OK Computer", "Various Artists"), null);
  assert.equal(S.pickAlbumCandidate(ALBUM_CARDS, "Kid A", "Radiohead"), null);
});

test("pickArtistCandidate needs the name itself", () => {
  assert.equal(S.pickArtistCandidate(ARTIST_CARDS, "Radiohead").id, "4Z8W4fKeB5YxbusRsdQVPb");
  assert.equal(S.pickArtistCandidate(ARTIST_CARDS, "radiohead").id, "4Z8W4fKeB5YxbusRsdQVPb");
  assert.equal(S.pickArtistCandidate(ARTIST_CARDS, "Deftones"), null);
});

test("parseCount reads exact and compact counts", () => {
  assert.equal(S.parseCount("906,467,975"), 906467975);
  assert.equal(S.parseCount("46,842,698 monthly listeners"), 46842698);
  assert.equal(S.parseCount("46.8M monthly listeners"), 46800000);
  assert.equal(S.parseCount("1.2K"), 1200);
  assert.equal(S.parseCount("3,1B"), 3100000000);
  assert.equal(S.parseCount("12 345 678"), 12345678);
  assert.equal(S.parseCount("1.234.567"), 1234567);
  assert.equal(S.parseCount("no digits"), null);
  assert.equal(S.parseCount(""), null);
});

test("pickListenerCount prefers the exact figure over the compact one", () => {
  assert.equal(S.pickListenerCount(["46.8M monthly listeners", "46,842,698 monthly listeners"]), 46842698);
  assert.equal(S.pickListenerCount(["46.8M monthly listeners"]), 46800000);
  assert.equal(S.pickListenerCount([]), null);
});

test("lookup page scripts are self-invoking and carry their ids", () => {
  const cand = S.scriptSearchCandidates(7, "albums");
  assert.ok(cand.includes("albums"), "guarded to its facet");
  assert.match(cand, /^\(function\(\)\{/);
  assert.ok(cand.includes('"search-candidates"'));
  assert.match(S.scriptReadTrackPlays(7, "abc"), /\/track\//);
  assert.ok(S.scriptReadTrackPlays(7, "abc").includes('"abc"'));
  assert.ok(S.scriptReadArtistListeners(7, "xyz").includes('"xyz"'));
  assert.ok(S.scriptWaitForPage(7, "/album/q1", true).includes("/album/q1"));
  assert.equal(S.searchUrl("a b", "albums"), "https://open.spotify.com/search/a%20b/albums");
  // Every builder must produce parseable JS.
  for (const s of [cand, S.scriptReadTrackPlays(1, "a"), S.scriptReadArtistListeners(1, "a"), S.scriptWaitForPage(1, "/x", false), S.scriptNavigateTo("https://x/")]) {
    assert.doesNotThrow(() => new Function(s), s.slice(0, 60));
  }
});

test("scriptSearchCandidates only runs on its own search facet", () => {
  const script = S.scriptSearchCandidates(1, "tracks");
  // True when the script got past its page guard (runOnce marks the window).
  const passesGuard = (pathname) => {
    const sandbox = {
      location: { pathname, href: "https://open.spotify.com" + pathname },
      window: { __viboplr: { send() {} } },
      document: { querySelector: () => null, querySelectorAll: () => [] },
      setTimeout: () => 0,
      console: { log() {}, error() {} },
    };
    vm.runInNewContext(script, sandbox);
    return sandbox.window.__viboplrRadio_cand === 1;
  };
  // The page being navigated away from must not run it.
  assert.equal(passesGuard("/album/6dVIqQ8qmQ5GBnJ9shOYGE"), false);
  assert.equal(passesGuard("/search/Karma%20Police/albums"), false);
  // Its own facet (with or without the intl prefix / trailing slash) does.
  assert.equal(passesGuard("/search/Karma%20Police/tracks"), true);
  assert.equal(passesGuard("/intl-de/search/Karma%20Police/tracks/"), true);
});

test("scriptSearchCandidates reports Spotify's own 'no results' page", () => {
  const script = S.scriptSearchCandidates(1, "tracks", 1);
  const run = (mainText) => {
    const sent = [];
    const main = { textContent: mainText, querySelectorAll: () => [] };
    const sandbox = {
      location: { pathname: "/search/x/tracks", href: "https://open.spotify.com/search/x/tracks" },
      window: { __viboplr: { send: (type, data) => sent.push({ type, data }) } },
      document: { querySelector: (sel) => (sel === "main" ? main : null), querySelectorAll: () => [], body: main },
      // Run the poll to its (1ms) budget immediately.
      setTimeout: (fn) => fn(),
      Date: { now: (() => { let t = 0; return () => (t += 10); })() },
      console: { log() {}, error() {} },
    };
    vm.runInNewContext(script, sandbox);
    return sent.find((m) => m.type === "search-candidates").data;
  };
  // Verbatim textContent from the throttled page (2026-09-25): siblings glued.
  assert.equal(run('AllSongsPlaylistsAlbumsArtistsGenres & MoodsNo Songs found for "Karma Police Radiohead"Please make sure').noResults, true);
  assert.equal(run("Songs Karma Police Radiohead").noResults, false);
});
