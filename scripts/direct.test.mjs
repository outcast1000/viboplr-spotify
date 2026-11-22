// Pins the pure mappers behind the direct reads (index.js "Direct reads
// (Pathfinder)") against responses recorded from the live web player on
// 2026-11-22 (scripts/fixtures/pathfinder/, home.json anonymised). When
// Spotify changes a shape, `npm run verify:direct` / `verify:all` fail live;
// re-record the fixture and fix the mapper here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractScripts } from "./extract-scripts.mjs";

const S = extractScripts(fileURLToPath(new URL("../index.js", import.meta.url)));
// Values from the vm sandbox have that realm's prototypes; compare plain copies.
const plain = (x) => JSON.parse(JSON.stringify(x));
const fixture = (op) => JSON.parse(readFileSync(new URL(`./fixtures/pathfinder/${op}.json`, import.meta.url), "utf8"));

test("search ops cover the three facets the lookups use", () => {
  assert.deepEqual(plain(S.SEARCH_OPS), { tracks: "searchTracks", albums: "searchAlbums", artists: "searchArtists" });
  const v = S.searchVars("karma police radiohead", 30);
  assert.equal(v.searchTerm, "karma police radiohead");
  assert.equal(v.limit, 30);
  assert.equal(v.offset, 0);
});

test("candidatesFromSearch: tracks keep the picker's shape (id, title, artists, album)", () => {
  const r = S.candidatesFromSearch("tracks", fixture("searchTracks").data);
  assert.ok(r.total > 0);
  const first = r.candidates[0];
  assert.deepEqual(plain(first), {
    kind: "track", id: "0DiWol3AO6WpXZgp0goxAV", title: "One More Time", artists: ["Daft Punk"],
    albumId: "2noRn2Aes5aoNVsU6iWThc", albumName: "Discovery", durationMs: 320357,
  });
  // The picker the lookups run picks it.
  assert.equal(S.pickTrackCandidate(r.candidates, "One More Time", "Daft Punk", null).id, "0DiWol3AO6WpXZgp0goxAV");
});

test("candidatesFromSearch: albums and artists", () => {
  const al = S.candidatesFromSearch("albums", fixture("searchAlbums").data).candidates;
  assert.deepEqual(plain(al[0]), {
    kind: "album", id: "6dVIqQ8qmQ5GBnJ9shOYGE", title: "OK Computer", artists: ["Radiohead"],
    imageUrl: "https://i.scdn.co/image/ab67616d0000b273c8b444df094279e70d0ed856",
  });
  assert.equal(S.pickAlbumCandidate(al, "OK Computer", "Radiohead").id, "6dVIqQ8qmQ5GBnJ9shOYGE");
  const ar = S.candidatesFromSearch("artists", fixture("searchArtists").data).candidates;
  assert.equal(ar[0].kind, "artist");
  assert.equal(ar[0].id, "4Z8W4fKeB5YxbusRsdQVPb");
  assert.equal(ar[0].title, "Radiohead");
  // The image providers answer with these: the widest (640px) variant.
  assert.match(ar[0].imageUrl, /^https:\/\/i\.scdn\.co\/image\/ab6761610000e5eb/);
  assert.ok(ar.every((a) => a.imageUrl), "every artist hit here has a photo");
  assert.equal(S.pickArtistCandidate(ar, "Radiohead").id, "4Z8W4fKeB5YxbusRsdQVPb");
});

test("candidatesFromSearch: a response of another shape is null, an empty one counts zero", () => {
  assert.equal(S.candidatesFromSearch("tracks", { searchV2: {} }), null);
  assert.equal(S.candidatesFromSearch("tracks", null), null);
  assert.deepEqual(plain(S.candidatesFromSearch("artists", { searchV2: { artists: { items: [], totalCount: 0 } } })), { candidates: [], total: 0 });
  // An artist with no photo still matches by name; it just has no image.
  const bare = S.candidatesFromSearch("artists", { searchV2: { artists: { totalCount: 1, items: [
    { data: { __typename: "Artist", uri: "spotify:artist:x1", profile: { name: "Nobody" } } }] } } });
  assert.equal(bare.candidates[0].imageUrl, null);
});

test("tracksFromSearch: rows like the search-page scrape, widest cover, m:ss", () => {
  const rows = S.tracksFromSearch(fixture("searchTracks").data);
  assert.ok(rows.length > 0);
  assert.deepEqual(plain(rows[0]), {
    name: "One More Time", artist: "Daft Punk", album: "Discovery", duration: "5:20",
    imageUrl: "https://i.scdn.co/image/ab67616d0000b2731e81bff9807a9e629fce5ade", spotifyId: "0DiWol3AO6WpXZgp0goxAV",
  });
  const ids = rows.map((r) => r.spotifyId);
  assert.equal(new Set(ids).size, ids.length, "duplicates collapse by id");
});

test("playsFromTrack / listenersFromOverview", () => {
  assert.equal(S.playsFromTrack(fixture("getTrack").data), 1008254944);
  assert.equal(S.playsFromTrack({ trackUnion: { playcount: "0" } }), null, "no count shown under ~1,000 plays");
  assert.equal(S.playsFromTrack({ trackUnion: {} }), null);
  assert.equal(S.playsFromTrack(null), null);
  assert.equal(S.listenersFromOverview(fixture("queryArtistOverview").data), 46888176);
  assert.equal(S.listenersFromOverview({ artistUnion: { stats: {} } }), null);
});

test("topTracksFromOverview: Top Songs in Spotify's order, valued by all-time plays", () => {
  const items = plain(S.topTracksFromOverview(fixture("queryArtistOverview").data, "Radiohead"));
  assert.equal(items.length, 10);
  assert.deepEqual(items[0], { name: "Creep", value: 3267216368, libraryKind: "track" });
  assert.ok(items.every((i) => i.value > 0 && i.libraryKind === "track"));
  // The credit is the page's own artist, so no subtitle repeats it on every row.
  assert.ok(items.every((i) => i.subtitle === undefined));
  // Asked without an artist (or for another one), the credit is kept as the row's artist.
  assert.equal(S.topTracksFromOverview(fixture("queryArtistOverview").data, null)[0].subtitle, "Radiohead");
  assert.equal(S.topTracksFromOverview({ artistUnion: {} }, "x"), null);
});

test("albumTracksFromAlbum: the album's tracks in album order, with their plays", () => {
  const r = plain(S.albumTracksFromAlbum(fixture("getAlbum").data, "Radiohead"));
  assert.equal(r.name, "OK Computer");
  assert.equal(r.total, 12);
  assert.deepEqual(r.items.map((i) => i.name).slice(0, 3), ["Airbag", "Paranoid Android", "Subterranean Homesick Alien"]);
  assert.deepEqual(r.items[0], { name: "Airbag", value: 108458143, libraryKind: "track" });
  assert.equal(S.albumTracksFromAlbum({}, "x"), null);
  // A featured artist stays on its row; a missing count is 0, not NaN.
  const feat = plain(S.albumTracksFromAlbum({ albumUnion: { name: "A", tracksV2: { totalCount: 1, items: [
    { track: { name: "Duet", artists: { items: [{ profile: { name: "Radiohead" } }, { profile: { name: "Guest" } }] } } }] } } }, "Radiohead"));
  assert.deepEqual(feat.items[0], { name: "Duet", value: 0, libraryKind: "track", subtitle: "Radiohead, Guest" });
});

test("artistFactsFromOverview: one read feeds every artist section", () => {
  const f = plain(S.artistFactsFromOverview(fixture("queryArtistOverview").data, "Radiohead"));
  assert.equal(f.listeners, 46888176);
  assert.equal(f.followers, 17603366);
  assert.equal(f.worldRank, 79);
  assert.equal(f.topCities[0].city, "Mexico City");
  assert.equal(f.topTracks[0].name, "Creep");
  assert.ok(f.bio.length > 1, "the bio keeps its paragraphs");
  assert.ok(f.bio.every((p) => !/<|spotify:artist/.test(p)), "no markup or internal links left");
  assert.equal(f.related[0], "The Smiths");
  assert.equal(f.photos[0].caption, "Banner", "the wide banner first");
  assert.ok(f.photos[0].width > f.photos[0].height);
  assert.equal(f.concerts.length, 5);
  assert.equal(S.artistFactsFromOverview({}, "x"), null);
  // A sparse artist (no bio, stats, related, photos or tour) is all empty, not a throw.
  const bare = plain(S.artistFactsFromOverview({ artistUnion: { stats: {} } }, "x"));
  assert.deepEqual([bare.bio, bare.related, bare.photos, bare.concerts, bare.topTracks], [null, [], [], [], []]);
});

test("artist sections: the shapes each display kind reads", () => {
  const f = S.artistFactsFromOverview(fixture("queryArtistOverview").data, "Radiohead");
  const bio = plain(S.bioSection(f));
  assert.match(bio.summary, /^<p>Radiohead are a touchstone/);
  assert.ok(!/<a /.test(bio.summary));
  const rel = plain(S.relatedSection(f));
  assert.equal(rel.itemKind, "artist");
  assert.deepEqual(rel.items[0], { name: "The Smiths", libraryKind: "artist" });
  const stats = plain(S.statsSection(f)).items;
  assert.deepEqual(stats.slice(0, 3), [
    { label: "Monthly listeners", value: 46888176 },
    { label: "Followers", value: 17603366 },
    { label: "World rank", value: "#79" },
  ]);
  assert.deepEqual(stats[3], { label: "Mexico City, MX", value: 700868, unit: "listeners" });
  const photos = plain(S.photosSection(f, "Radiohead")).images;
  assert.equal(photos[0].caption, "Radiohead — Banner");
  assert.ok(photos.every((i) => /^https:\/\//.test(i.url) && i.source === "Spotify"));
  const gigs = plain(S.concertsSection(f)).items;
  assert.match(gigs[0].name, /^Tue 8 Jun 2027 · /);
  assert.match(gigs[0].url, /^https:\/\/open\.spotify\.com\/concert\//);
  // Nothing to show → null (the host then hides the tab).
  const bare = S.artistFactsFromOverview({ artistUnion: {} }, "x");
  for (const fn of [S.bioSection, S.relatedSection, S.statsSection, S.photosSection, S.concertsSection]) {
    assert.equal(fn(bare, "x"), null);
  }
});

test("creditsFromTrack / creditsSection: who wrote, produced and performed it", () => {
  const c = plain(S.creditsFromTrack(fixture("queryTrackCreditsGroupedModal").data));
  assert.deepEqual(c.roles.map((r) => r.role), ["Main Artist", "Composer", "Lyricist", "Producer"]);
  assert.deepEqual(c.roles[1].names, ["Colin Greenwood", "Ed O'Brien", "Jonny Greenwood", "Philip Selway", "Thom Yorke"]);
  assert.equal(c.roles[1].group, "Composition & Lyrics");
  assert.deepEqual(c.sources, ["XL Recordings"]);
  const rows = plain(S.creditsSection(c)).items;
  assert.deepEqual(rows[0], { key: "Main Artist", value: "Radiohead" });
  assert.deepEqual(rows[1], { key: "Composers", value: "Colin Greenwood, Ed O'Brien, Jonny Greenwood, Philip Selway, Thom Yorke" });
  assert.deepEqual(rows[2], { key: "Lyricist", value: "Thom Yorke" });
  assert.deepEqual(rows[rows.length - 1], { key: "Source", value: "XL Recordings" });
  // Only a main artist is not worth a tab; no credits block is null.
  assert.equal(S.creditsSection({ roles: [{ role: "Main Artist", group: "Artist", names: ["X"] }], sources: [] }), null);
  assert.equal(S.creditsFromTrack({ trackUnion: {} }), null);
  // A name listed twice under one role appears once.
  const dup = S.creditsFromTrack({ trackUnion: { creditsTrait: { contributors: { items: [
    { name: "A", role: "Producer" }, { name: "A", role: "Producer" }, { name: "B", role: "Producer" }] } } } });
  assert.deepEqual(plain(dup.roles[0].names), ["A", "B"]);
});

// Spotify's color-lyrics response, structure as recorded 2026-11-22 (field
// names, syncType, capStatus, the "♪" instrumental marks, string times) — the
// lines themselves are made up: real ones are licensed Musixmatch lyrics.
const COLOR_LYRICS = {
  lyrics: {
    syncType: "LINE_SYNCED", provider: "MusixMatch", providerLyricsId: "1", providerDisplayName: "Musixmatch",
    capStatus: "NONE", previewLines: [], alternatives: [], language: "en", isRtlLanguage: false,
    lines: [
      { startTimeMs: "26780", words: "First made-up line", syllables: [], endTimeMs: "0" },
      { startTimeMs: "33250", words: "♪", syllables: [], endTimeMs: "0" },
      { startTimeMs: "61005", words: "Second made-up line", syllables: [], endTimeMs: "0" },
    ],
  },
  colors: { background: -1, text: -1, highlightText: -1 },
};

test("lyricsFromColorLyrics / lyricsValue: synced only for the user's cut", () => {
  const lyr = S.lyricsFromColorLyrics(COLOR_LYRICS);
  assert.equal(lyr.synced, true);
  assert.equal(lyr.provider, "Musixmatch");
  // Same length (within 2s): LRC, "♪" kept as a blank timed line.
  assert.deepEqual(plain(S.lyricsValue(lyr, true)), {
    text: "[00:26.78]First made-up line\n[00:33.25]\n[01:01.01]Second made-up line", kind: "synced",
  });
  // Unknown or different length: the words alone, no "♪".
  assert.deepEqual(plain(S.lyricsValue(lyr, false)), { text: "First made-up line\nSecond made-up line", kind: "plain" });
  // Capped (a free-tier preview) or empty: nothing — never cached as the lyrics.
  assert.equal(S.lyricsFromColorLyrics({ lyrics: { ...COLOR_LYRICS.lyrics, capStatus: "PREVIEW" } }), null);
  assert.equal(S.lyricsFromColorLyrics({ lyrics: { ...COLOR_LYRICS.lyrics, lines: [] } }), null);
  assert.equal(S.lyricsFromColorLyrics(null), null, "404: the track has no lyrics");
  // Unsynced lyrics are plain even for the right length.
  const uns = S.lyricsFromColorLyrics({ lyrics: { ...COLOR_LYRICS.lyrics, syncType: "UNSYNCED" } });
  assert.equal(S.lyricsValue(uns, true).kind, "plain");
  // No syncType, an unknown one, or lines without times: plain — never LRC with
  // every line at 00:00 (code review).
  for (const syncType of [undefined, "SOMETHING_NEW"]) {
    const l = S.lyricsFromColorLyrics({ lyrics: { ...COLOR_LYRICS.lyrics, syncType } });
    assert.equal(S.lyricsValue(l, true).kind, "plain", String(syncType));
  }
  const untimed = S.lyricsFromColorLyrics({ lyrics: { ...COLOR_LYRICS.lyrics,
    lines: COLOR_LYRICS.lyrics.lines.map((x) => ({ ...x, startTimeMs: "0" })) } });
  assert.equal(S.lyricsValue(untimed, true).kind, "plain");
  assert.equal(S.lrcTime(3723450), "62:03.45");
});

test("sameLength / pickTrackByLength: the release with the user's length", () => {
  assert.equal(S.sameLength(320357, 321), true);
  assert.equal(S.sameLength(320357, 323), false);
  assert.equal(S.sameLength(320357, null), false, "unknown length is never the same");
  const cands = [
    { kind: "track", id: "single", title: "Song", artists: ["Band"], durationMs: 211000 },
    { kind: "track", id: "remaster", title: "Song - 2011 Remaster", artists: ["Band"], durationMs: 250000 },
    { kind: "track", id: "acoustic", title: "Song (Acoustic)", artists: ["Band"], durationMs: 300500 },
    { kind: "track", id: "album", title: "Song", artists: ["Band"], durationMs: 241000 },
    { kind: "track", id: "other", title: "Song", artists: ["Other Band"], durationMs: 240000 },
  ];
  // Without a length, the plain pick (exact title, Spotify's order).
  assert.equal(S.pickTrackByLength(cands, "Song", "Band", null, null).id, "single");
  // With one: another release of the same title that has it (the album cut).
  assert.equal(S.pickTrackByLength(cands, "Song", "Band", null, 240).id, "album");
  // Never a worse title for a length (code review): a remaster or an acoustic
  // take of our length doesn't replace the exact title — its synced lyrics
  // would be cached for the original for good.
  assert.equal(S.pickTrackByLength(cands, "Song", "Band", null, 250).id, "single");
  assert.equal(S.pickTrackByLength(cands, "Song", "Band", null, 300).id, "single");
  // The user's own title being the variant picks the variant.
  assert.equal(S.pickTrackByLength(cands, "Song (Acoustic)", "Band", null, 300).id, "acoustic");
  // Another artist's "Song" never wins, whatever its length.
  assert.notEqual(S.pickTrackByLength(cands, "Song", "Band", null, 240).id, "other");
});

test("compactCount: the Now Playing line's numbers", () => {
  assert.equal(S.compactCount(990402), "990k");
  assert.equal(S.compactCount(3267216368), "3.3B");
  assert.equal(S.compactCount(1508), "1.5k");
  assert.equal(S.compactCount(1000), "1k");
  assert.equal(S.compactCount(46888176), "46.9M");
  assert.equal(S.compactCount(999950), "1M", "never \"1000K\"");
  assert.equal(S.compactCount(842), "842");
  assert.equal(S.compactCount(0), "0");
});

test("concertDate: the venue's own calendar day", () => {
  assert.equal(S.concertDate("2027-06-08T19:00+09:00"), "Tue 8 Jun 2027");
  assert.equal(S.concertDate("2026-12-31T23:30-08:00"), "Thu 31 Dec 2026");
  assert.equal(S.concertDate(""), "");
});

test("shelvesFromHome: the scraper's shelves, named the way the page heads them", () => {
  const data = fixture("home").data;
  const shelves = S.shelvesFromHome(data, true);
  const names = shelves.map((s) => s.section);
  // The untitled top grid is "Home"; "More like X" / "Discover more from X"
  // are named after their artist; the single-card feed sections are left out.
  assert.equal(names[0], "Home");
  assert.ok(names.includes("Made For You"));
  assert.ok(names.includes("Recommended Stations"));
  assert.ok(!names.some((n) => /^More like |^Discover more from /.test(n)), "header artist, not the label");
  assert.ok(!names.includes("Made for you"), "HomeFeedBaselineSectionData is not a shelf");
  const generic = data.home.sectionContainer.sections.items.filter((s) =>
    /HomeGenericSectionData|HomeShortsSectionData/.test(s.data.__typename));
  assert.equal(shelves.length, generic.length);

  const stations = shelves.find((s) => s.section === "Recommended Stations");
  assert.equal(stations.description, "Non-stop music based on your favorite songs and artists.");
  const card = stations.playlists[0];
  assert.equal(card.kind, "playlist");
  assert.ok(card.id && card.name && card.imageUrl);
  assert.equal(card.subtitle, "With Artist P and more", "HTML description → text");
});

test("shelvesFromHome: albums only when asked for; unnamed and artist cards never", () => {
  const data = fixture("home").data;
  const withAlbums = S.shelvesFromHome(data, true).flatMap((s) => s.playlists);
  const without = S.shelvesFromHome(data, false).flatMap((s) => s.playlists);
  assert.ok(withAlbums.some((c) => c.kind === "album"));
  assert.ok(!without.some((c) => c.kind === "album"));
  assert.ok(withAlbums.every((c) => c.name && (c.kind === "playlist" || c.kind === "album")));
  assert.equal(S.shelvesFromHome({}, true), null);
});

test("htmlToText / formatMs", () => {
  assert.equal(S.htmlToText('With <a href="spotify:artist:1">Goat</a> &amp; more &#x27;yes&#x27;'), "With Goat & more 'yes'");
  assert.equal(S.htmlToText(null), "");
  assert.equal(S.formatMs(320357), "5:20");
  assert.equal(S.formatMs(4503000), "75:03");
  assert.equal(S.formatMs(0), "");
});

test("the in-page scripts are self-contained (they parse, and name the helpers they use)", () => {
  for (const script of [
    S.scriptPathfinder("t", 1, "searchTracks", S.searchVars("x"), null),
    S.scriptPathfinder("t", 1, "home", S.homeVars(), null),
    S.scriptDirectTracks("t", "abc", 1, { kind: "radio" }),
    S.SCRIPT_CAPTURE,
  ]) {
    assert.doesNotThrow(() => new Function(script), "parses");
  }
  assert.match(S.scriptPathfinder("t", 1, "home", S.homeVars(), null), /"fills":\["timeZone","sp_t"\]/);
});
