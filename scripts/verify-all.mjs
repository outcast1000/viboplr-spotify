// One live check per Spotify service the plugin depends on, run against the
// REAL site with the SAME injected scripts and pickers index.js ships
// (extract-scripts.mjs). Spotify can change its markup at any time; this is
// the "is everything still working?" button — run it before a release and
// whenever a feature misbehaves.
//
//   npm run verify:all
//   npm run verify:all -- --only album-by-name,track-plays
//   VERIFY_HEADLESS=1 npm run verify:all            (after one headed login)
//   VERIFY_CHANNEL=chromium npm run verify:all      (no Google Chrome installed)
//   VERIFY_REPORT=report.json npm run verify:all    (machine-readable result)
//
// Fixtures (override for a catalog your account can see):
//   VERIFY_ARTIST="Radiohead" VERIFY_ALBUM="OK Computer" VERIFY_TRACK="Karma Police"
//   RADIO_QUERY / SEARCH_QUERY — seed + query for the radio / search checks
//
// Every check runs independently (one that depends on an earlier check's
// output is skipped if that failed) and the process exits 1 if any failed.
// Each failure names the plugin function to look at.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, argv } from "node:process";
import { extractScripts } from "./extract-scripts.mjs";
import {
  INDEX_PATH, harnessOptions, launch, installBridge, ensureLoggedIn,
  step, navigate, evalIn, sleep, envNum,
} from "./lib/harness.mjs";
import { startFakeHost } from "./lib/fake-host.mjs";

const FIX = {
  artist: env.VERIFY_ARTIST || "Radiohead",
  album: env.VERIFY_ALBUM || "OK Computer",
  track: env.VERIFY_TRACK || "Karma Police",
  radioQuery: env.RADIO_QUERY || "Daft Punk One More Time",
  searchQuery: env.SEARCH_QUERY || "Daft Punk One More Time",
};

const onlyArg = argv.find((a) => a.startsWith("--only"));
const ONLY = onlyArg
  ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : argv[argv.indexOf(onlyArg) + 1] || "").split(",").map((s) => s.trim()).filter(Boolean)
  : null;

class CheckFailure extends Error {}
function need(cond, msg) { if (!cond) throw new CheckFailure(msg); }

const GEN = 1;

// A tracklist scrape (playlist / album / Liked Songs / radio / search page):
// the shared row parser, run exactly once like the host does.
async function scrapeTracklist(page, bridge, S, id, opts) {
  const d = await step(page, bridge, S.scriptScrollThenScrape(id, GEN, opts), "tracks", {
    pump: false,
    timeoutMs: 30000 + 800 * (opts.maxSteps || 60),
    match: (m) => m.playlistId === id,
  });
  if (d.error) throw new CheckFailure(`row parser error: ${d.error}`);
  return d;
}

function rowQuality(tracks) {
  const n = tracks.length;
  const noArtist = tracks.filter((t) => !t.artist).length;
  const noId = tracks.filter((t) => !t.spotifyId).length;
  const noDur = tracks.filter((t) => !t.duration).length;
  need(noArtist <= n * 0.2, `${noArtist}/${n} rows have no artist — artist link selector drifted (parseVisibleRows)`);
  need(noId <= n * 0.2, `${noId}/${n} rows have no Spotify id — /track/ link selector drifted (parseVisibleRows)`);
  need(noDur <= n * 0.2, `${noDur}/${n} rows have no duration — last-gridcell m:ss rule drifted (parseVisibleRows)`);
}

// A direct (Pathfinder) tracklist read, as ensureTracks / scrapeLikedSongs
// start one. Its failure message names the reason the plugin would log before
// falling back to the scrape.
async function directTracklist(page, bridge, S, tag, id, kind) {
  const t0 = Date.now();
  const d = await step(page, bridge, S.scriptDirectTracks(tag, id, GEN, { kind }), ["tracks", "tracks-direct-failed"], {
    pump: false,
    timeoutMs: 120000,
    match: (m) => m.playlistId === tag && (m.source === "direct" || m.reason !== undefined),
  });
  need(d.__type === "tracks", `direct read failed: ${d.reason} (scriptDirectTracks — the plugin falls back to the scrape)`);
  return { ...d, ms: Date.now() - t0 };
}

// One direct Pathfinder query (scriptPathfinder), as the plugin's directQuery
// runs it. Its failure is what the plugin logs before falling back.
let pfSeq = 0;
async function pathfinder(page, bridge, S, op, vars) {
  const tag = "verify-pf" + (++pfSeq);
  const d = await step(page, bridge, S.scriptPathfinder(tag, GEN, op, vars, null), "pathfinder", {
    pump: false, timeoutMs: 30000, match: (m) => m.tag === tag,
  });
  need(!d.error, `${op} failed: ${d.error} (scriptPathfinder — the plugin falls back to the page)`);
  return d.data;
}

async function openPage(page, bridge, S, path, withTracklist) {
  await navigate(page, S, "https://open.spotify.com" + path);
  const d = await step(page, bridge, S.scriptWaitForPage(GEN, path, withTracklist), "page-ready", { timeoutMs: 35000 });
  need(d.ok, `${path} never rendered${withTracklist ? " a tracklist row" : ""}: ${d.error || "?"} (scriptWaitForPage)`);
}

async function candidates(page, bridge, S, query, facet) {
  await navigate(page, S, S.searchUrl(query, facet));
  const d = await step(page, bridge, S.scriptSearchCandidates(GEN, facet), "search-candidates", { timeoutMs: 40000 });
  need(!d.error, `candidates script error: ${d.error}`);
  need(!d.loggedOut, "search page shows the login button — signed out");
  const c = d.candidates || [];
  need(c.length > 0, d.noResults
    ? `Spotify answered "no results" for /${facet} "${query}" — a real miss, or search throttling after a burst of runs (wait a few minutes and re-run); not a selector problem`
    : `/${facet} search for "${query}" yielded no candidates — row/card selectors drifted (scriptSearchCandidates)`);
  return c;
}

// A plugin:* check that came back empty: say so when Spotify itself answered
// "no results" (throttling after a burst of runs), rather than blaming code.
function throttleHint(host, since) {
  return host.events.slice(since).some((e) => e.kind === "log" && /no results" page/.test(e.data))
    ? " — Spotify showed its \"no results\" page (search throttling? wait a few minutes and re-run)"
    : "";
}

const CHECKS = [
  {
    id: "home-shelves",
    protects: "Sync (home shelves + playlist cards)",
    async run({ page, bridge, S, shared }) {
      await page.goto(S.MUSIC_CHIP_URL, { waitUntil: "domcontentloaded" });
      // Host parity: the plugin scrapes after its login poll + a settle
      // (>= 2.5s after the page opens); verify:scrape uses 4.5s. The shelf
      // scraper reads what is rendered, so scraping earlier reports nothing.
      await sleep(envNum("VERIFY_SETTLE_MS", 4500));
      const d = await step(page, bridge, S.scriptScrapeShelves(true), ["shelves", "error"], { pump: false, timeoutMs: 150000 });
      need(d.__type === "shelves", `shelf scrape error: ${d.message || "?"} (scriptScrapeShelves)`);
      const shelves = d.shelves || [];
      const cards = shelves.flatMap((s) => s.playlists || []);
      need(shelves.length > 0, "no shelves found on the music-chip home (scriptScrapeShelves heading/section rules)");
      need(cards.length >= 3, `only ${cards.length} cards across ${shelves.length} shelves`);
      const unnamed = cards.filter((c) => !c.name).length;
      const noCover = cards.filter((c) => !c.imageUrl).length;
      need(unnamed <= cards.length * 0.2, `${unnamed}/${cards.length} cards have no name`);
      need(noCover <= cards.length * 0.5, `${noCover}/${cards.length} cards have no cover (bestImg / findImgContainer)`);
      shared.playlist = cards.find((c) => c.kind !== "album") || null;
      shared.shelves = shelves;
      shared.homeAlbum = cards.find((c) => c.kind === "album") || null;
      return `${shelves.length} shelves, ${cards.length} cards (${noCover} without cover)`;
    },
  },
  {
    id: "playlist-tracks",
    protects: "Viewing / playing a synced playlist (ensureTracks)",
    needs: ["home-shelves"],
    async run({ page, bridge, S, shared }) {
      need(shared.playlist, "home had no playlist card to open");
      const pl = shared.playlist;
      await evalIn(page, S.scriptNavigatePlaylist(pl.id, "playlist"));
      const d = await (async () => {
        const r = await step(page, bridge, S.scriptWaitForPage(GEN, "/playlist/" + pl.id, true), "page-ready", { timeoutMs: 35000 });
        need(r.ok, `/playlist/${pl.id} never rendered a tracklist row`);
        return scrapeTracklist(page, bridge, S, pl.id, { maxSteps: 5 });
      })();
      const tracks = d.tracks || [];
      need(tracks.length > 0, `"${pl.name}" scraped 0 tracks`);
      rowQuality(tracks);
      need(d.total != null, "tracklist has no aria-rowcount — the definite-finish rule is gone (totalRows)");
      need(d.coverUrl, `no playlist cover (rules tried: ${JSON.stringify(d.coverRuleAttempts || [])})`);
      return `"${pl.name}": ${tracks.length}/${d.total} rows in 5 steps, cover via ${d.coverRule}`;
    },
  },
  {
    id: "liked-songs",
    protects: "Import Liked Songs as likes (scrapeLikedSongs)",
    async run({ page, bridge, S }) {
      await evalIn(page, S.scriptNavigatePlaylist("", "collection"));
      const r = await step(page, bridge, S.scriptWaitForPage(GEN, "/collection/tracks", true), "page-ready", { timeoutMs: 35000 });
      need(r.ok, "/collection/tracks never rendered a tracklist row (an account with no Liked Songs also fails here)");
      const d = await scrapeTracklist(page, bridge, S, "liked", { maxSteps: 3, kind: "collection" });
      const tracks = d.tracks || [];
      need(tracks.length > 0, "Liked Songs scraped 0 tracks");
      rowQuality(tracks);
      return `${tracks.length} rows in 3 steps (of ${d.total ?? "?"})`;
    },
  },
  // The direct reads (scriptDirectTracks) are what ensureTracks and the Liked
  // Songs import try first; the two scrape checks above are their fallback.
  // A failure here means the plugin is slower (it falls back), not broken.
  {
    id: "direct-playlist",
    protects: "Fast playlist / album loading (scriptDirectTracks; fallback: playlist-tracks)",
    needs: ["home-shelves"],
    async run({ page, bridge, S, shared }) {
      need(shared.playlist, "home had no playlist card to read");
      const pl = shared.playlist;
      const d = await directTracklist(page, bridge, S, "direct-pl", pl.id, "playlist");
      const tracks = d.tracks || [];
      need(tracks.length > 0, `"${pl.name}" read 0 tracks directly`);
      rowQuality(tracks);
      need(d.total != null && tracks.length >= d.total * 0.95, `read ${tracks.length} of ${d.total} — paging stopped early`);
      return `"${pl.name}": ${tracks.length}/${d.total} tracks in ${d.ms}ms`;
    },
  },
  {
    id: "direct-liked",
    protects: "Fast Liked Songs import (scriptDirectTracks; fallback: liked-songs)",
    async run({ page, bridge, S }) {
      const d = await directTracklist(page, bridge, S, "direct-liked", null, "collection");
      const tracks = d.tracks || [];
      need(tracks.length > 0, "Liked Songs read 0 tracks directly (an account with no Liked Songs also fails here)");
      rowQuality(tracks);
      need(d.total != null && tracks.length >= d.total * 0.95, `read ${tracks.length} of ${d.total} — paging stopped early`);
      return `${tracks.length}/${d.total} tracks in ${d.ms}ms`;
    },
  },
  {
    id: "direct-radio",
    protects: "Fast Spotify radio (scriptDirectTracks kind radio: inspiredby-mix + station read; fallback: radio)",
    async run({ page, bridge, S }) {
      await navigate(page, S, S.searchTracksUrl(FIX.radioQuery));
      const seed = await step(page, bridge, S.scriptSearchTopTrack(GEN), "radio-seed", { timeoutMs: 40000 });
      need(seed.trackId, `seed search failed: ${seed.error || "no trackId"} (scriptSearchTopTrack)`);
      const d = await directTracklist(page, bridge, S, "direct-radio", seed.trackId, "radio");
      const tracks = d.tracks || [];
      need(tracks.length >= 10, `station ${d.stationId} read only ${tracks.length} tracks`);
      rowQuality(tracks);
      need(tracks[0].spotifyId === seed.trackId, `the station doesn't open with the seed (first: ${tracks[0].name}) — stripSeedRow won't drop it`);
      return `seed "${seed.name}" → station ${d.stationId}, ${tracks.length} tracks in ${d.ms}ms`;
    },
  },
  // The direct reads behind Home, song search and the catalog lookups; each
  // page check next to it is that feature's fallback.
  {
    id: "direct-home",
    protects: "Fast Sync of the home shelves (shelvesFromHome; fallback: home-shelves)",
    needs: ["home-shelves"],
    async run({ page, bridge, S, shared }) {
      const data = await pathfinder(page, bridge, S, "home", S.homeVars());
      const shelves = S.shelvesFromHome(data, true);
      need(shelves, "home answered an unexpected shape (shelvesFromHome)");
      const names = new Set(shelves.map((x) => x.section));
      const scraped = (shared.shelves || []).map((x) => x.section);
      const missing = scraped.filter((n) => !names.has(n));
      // What the response held, to tell a renamed section from an absent one.
      const sections = (data.home.sectionContainer.sections.items || []).map((x) =>
        `${(x.data.__typename || "").replace(/Home|SectionData/g, "")}:${(x.data.title && x.data.title.transformedLabel) || "-"}` +
        `(${((x.sectionItems && x.sectionItems.items) || []).map((i) => ((i.content && i.content.__typename) || "?").replace("ResponseWrapper", "")[0]).join("")})`);
      // Spotify's home varies between two requests (the page's and this one),
      // so a shelf or two can differ without anything being wrong — the plugin
      // reads the page's own answer for exactly that reason. Most must match:
      // a naming bug (the rules unit-tested in direct.test.mjs) renames many.
      need(missing.length <= scraped.length / 2, `most shelves the page shows are missing or named differently in the direct read: ${JSON.stringify(missing)} — Home shelves are registered by name (shelvesFromHome naming rules). Response: ${sections.join(" ")}`);
      const cards = shelves.flatMap((x) => x.playlists);
      need(cards.length >= 3, `only ${cards.length} cards`);
      need(cards.filter((c) => !c.imageUrl).length <= cards.length * 0.2, "most cards have no cover");
      return `${shelves.length} shelves, ${cards.length} cards (page: ${scraped.length} shelves` +
        (missing.length ? `; this sample lacks ${JSON.stringify(missing)} — Spotify varies its home per request` : "") + ")";
    },
  },
  {
    id: "direct-search",
    protects: "Fast song search (searchTracks → tracksFromSearch; fallback: song-search)",
    async run({ page, bridge, S }) {
      const rows = S.tracksFromSearch(await pathfinder(page, bridge, S, "searchTracks", S.searchVars(FIX.searchQuery, 50)));
      need(rows, "searchTracks answered an unexpected shape (tracksFromSearch)");
      need(rows.length >= 5, `only ${rows.length} results for "${FIX.searchQuery}"`);
      rowQuality(rows);
      return `"${FIX.searchQuery}": ${rows.length} rows, first "${rows[0].name}" – ${rows[0].artist}`;
    },
  },
  {
    id: "direct-lookups",
    protects: "Fast album / plays / listeners lookups (candidatesFromSearch, getTrack, queryArtistOverview; fallback: the page checks)",
    async run({ page, bridge, S }) {
      const cand = async (facet, q) => {
        const r = S.candidatesFromSearch(facet, await pathfinder(page, bridge, S, S.SEARCH_OPS[facet], S.searchVars(q, 30)));
        need(r, `${facet} search answered an unexpected shape (candidatesFromSearch)`);
        return r.candidates;
      };
      const al = S.pickAlbumCandidate(await cand("albums", FIX.artist + " " + FIX.album), FIX.album, FIX.artist);
      need(al, `no album "${FIX.album}" among the direct candidates (pickAlbumCandidate)`);
      need(al.imageUrl, `album "${FIX.album}" came back without a cover — the album image provider would answer nothing (candidatesFromSearch: coverArt)`);
      const t = S.pickTrackCandidate(await cand("tracks", FIX.track + " " + FIX.artist), FIX.track, FIX.artist, FIX.album);
      need(t, `no track "${FIX.track}" among the direct candidates (pickTrackCandidate)`);
      const plays = S.playsFromTrack(await pathfinder(page, bridge, S, "getTrack",
        { uri: "spotify:track:" + t.id, includeVideoAssociationItems: false, includeMusicVideoPreviews: false }));
      need(plays > 0, `getTrack gave no play count for ${t.id} (playsFromTrack)`);
      const ar = S.pickArtistCandidate(await cand("artists", FIX.artist), FIX.artist);
      need(ar, `no artist "${FIX.artist}" among the direct candidates (pickArtistCandidate)`);
      need(ar.imageUrl, `artist "${FIX.artist}" came back without a photo — the artist image provider would answer nothing (candidatesFromSearch: visuals.avatarImage)`);
      const listeners = S.listenersFromOverview(await pathfinder(page, bridge, S, "queryArtistOverview",
        { uri: "spotify:artist:" + ar.id, locale: "", preReleaseV2: false, includeMusicVideoPreviews: false }));
      need(listeners > 0, `queryArtistOverview gave no monthly listeners for ${ar.id} (listenersFromOverview)`);
      return `album ${al.id}, "${t.title}" ${plays.toLocaleString("en")} plays, ${ar.title} ${listeners.toLocaleString("en")} listeners`;
    },
  },
  {
    id: "song-search",
    protects: "Song search box + Cmd+K provider (scrapeSearchTracks)",
    async run({ page, bridge, S }) {
      await navigate(page, S, S.searchTracksUrl(FIX.searchQuery));
      const ready = await step(page, bridge, S.scriptWaitForSearchResults(GEN), "search-ready", { timeoutMs: 35000 });
      need(ready.ok, `results never rendered: ${ready.error || "?"} (scriptWaitForSearchResults)`);
      const d = await scrapeTracklist(page, bridge, S, "search-results", { maxSteps: 3 });
      const tracks = d.tracks || [];
      need(tracks.length >= 5, `only ${tracks.length} results for "${FIX.searchQuery}"`);
      rowQuality(tracks);
      return `"${FIX.searchQuery}": ${tracks.length} rows; top "${tracks[0].name}" — ${tracks[0].artist}`;
    },
  },
  {
    id: "radio",
    protects: "Start Spotify radio (scrapeRadioTracks)",
    async run({ page, bridge, S }) {
      await navigate(page, S, S.searchTracksUrl(FIX.radioQuery));
      const seed = await step(page, bridge, S.scriptSearchTopTrack(GEN), "radio-seed", { timeoutMs: 40000 });
      need(seed.trackId, `seed search failed: ${seed.error || "no trackId"} (scriptSearchTopTrack)`);
      await evalIn(page, S.scriptNavigateTrackPage(seed.trackId));
      const go = await step(page, bridge, S.scriptGoToRadio(GEN, seed.trackId), "radio-go", { timeoutMs: 45000 });
      need(go.ok, `"Go to song radio" failed: ${go.error || "?"}${go.menuItems ? " — menu: " + JSON.stringify(go.menuItems) : ""} (scriptGoToRadio)`);
      const st = await step(page, bridge, S.scriptWaitForStation(GEN, seed.trackId), "radio-station", { timeoutMs: 30000 });
      need(st.ok, `station page never opened: ${st.error || "?"} (scriptWaitForStation)`);
      const d = await scrapeTracklist(page, bridge, S, "radio-station", { maxSteps: 40 });
      const tracks = d.tracks || [];
      need(tracks.length >= 10, `station scraped only ${tracks.length} tracks`);
      rowQuality(tracks);
      return `seed "${seed.name}" → ${tracks.length} station tracks (${st.url.replace("https://open.spotify.com", "")})`;
    },
  },
  {
    id: "album-by-name",
    protects: "Play the Full Album (Spotify) + get_album_tracks, album named (lookupSpotifyAlbum)",
    async run({ page, bridge, S }) {
      const cands = await candidates(page, bridge, S, FIX.artist + " " + FIX.album, "albums");
      const albums = cands.filter((c) => c.kind === "album");
      need(albums.length > 0, "album search returned no album cards (card selector / cardTitle drifted)");
      // A compilation card ("Various Artists") has no artist link; its subtitle names it.
      need(albums.filter((c) => c.artists.length > 0).length >= albums.length * 0.9, `album cards without an artist: ${albums.filter((c) => !c.artists.length).map((c) => c.title).slice(0, 3).join("; ")} (the artist link / cardSubtitle rule drifted)`);
      const pick = S.pickAlbumCandidate(cands, FIX.album, FIX.artist);
      need(pick, `pickAlbumCandidate found no "${FIX.album}" by ${FIX.artist} among: ${albums.map((a) => a.title + " / " + a.artists.join(",")).slice(0, 5).join("; ")}`);
      await openPage(page, bridge, S, "/album/" + pick.id, true);
      const d = await scrapeTracklist(page, bridge, S, "album-lookup", { maxSteps: 40, kind: "album" });
      const tracks = d.tracks || [];
      need(tracks.length > 0, "album page scraped 0 tracks");
      rowQuality(tracks);
      need(d.total != null, "album tracklist has no aria-rowcount (totalRows)");
      need(tracks.length === d.total, `album scrape incomplete: ${tracks.length}/${d.total} rows`);
      need(d.coverUrl, "no album cover found");
      return `"${pick.title}" (${pick.id}): ${tracks.length}/${d.total} tracks, cover via ${d.coverRule}`;
    },
  },
  {
    id: "album-via-track",
    protects: "Play the Full Album (Spotify) when the album isn't named / is a compilation",
    async run({ page, bridge, S, shared }) {
      const cands = await candidates(page, bridge, S, FIX.track + " " + FIX.artist, "tracks");
      const rows = cands.filter((c) => c.kind === "track");
      need(rows.length > 0, "track search returned no track rows");
      need(rows.filter((r) => r.albumId).length >= rows.length * 0.8, "track rows lost their /album/ link");
      const t = S.pickTrackCandidate(cands, FIX.track, FIX.artist, null);
      need(t, `pickTrackCandidate found no "${FIX.track}" by ${FIX.artist} among: ${rows.slice(0, 5).map((r) => r.title + " / " + r.artists.join(",")).join("; ")}`);
      need(t.albumId && t.albumName, "matched track row has no album link");
      shared.track = t;
      return `"${t.title}" (${t.id}) → album "${t.albumName}" (${t.albumId})`;
    },
  },
  {
    id: "track-plays",
    protects: "Spotify Plays info section + get_track_plays (lookupTrackPlays)",
    needs: ["album-via-track"],
    async run({ page, bridge, S, shared }) {
      const t = shared.track;
      await navigate(page, S, "https://open.spotify.com/track/" + t.id);
      const d = await step(page, bridge, S.scriptReadTrackPlays(GEN, t.id), "track-plays", {
        timeoutMs: 40000, match: (m) => m.trackId === t.id,
      });
      need(!d.error, `plays script error: ${d.error}`);
      need(!d.missing, `no [data-testid="playcount"] on the track page (hero rendered: ${d.heroRendered}) — selector drifted (scriptReadTrackPlays)`);
      const n = S.parseCount(d.raw);
      need(n != null && n > 1000, `play count "${d.raw}" parsed to ${n} (parseCount)`);
      return `"${t.title}": "${d.raw}" → ${n.toLocaleString("en-US")} plays`;
    },
  },
  {
    id: "artist-listeners",
    protects: "Spotify Listeners info section + get_artist_listeners (lookupArtistListeners)",
    async run({ page, bridge, S }) {
      const cands = await candidates(page, bridge, S, FIX.artist, "artists");
      const a = S.pickArtistCandidate(cands, FIX.artist);
      need(a, `pickArtistCandidate found no "${FIX.artist}" among: ${cands.filter((c) => c.kind === "artist").slice(0, 5).map((c) => c.title).join("; ")}`);
      await navigate(page, S, "https://open.spotify.com/artist/" + a.id);
      const d = await step(page, bridge, S.scriptReadArtistListeners(GEN, a.id), "artist-listeners", {
        timeoutMs: 40000, match: (m) => m.artistId === a.id,
      });
      need(!d.error, `listeners script error: ${d.error}`);
      need(!d.missing, "no \"monthly listeners\" text on the artist page (scriptReadArtistListeners; non-English UI?)");
      const n = S.pickListenerCount(d.texts);
      need(n != null && n > 0, `listener texts ${JSON.stringify(d.texts)} parsed to ${n} (pickListenerCount)`);
      const exact = d.texts.some((x) => !/\d\s*[KMB]\b/i.test(x));
      return `${a.title}: ${n.toLocaleString("en-US")} monthly listeners${exact ? "" : " (compact figure only — exact hidden span gone)"}`;
    },
  },

  // ---- End to end through the plugin itself (scripts/lib/fake-host.mjs) ----
  // The checks above prove the page scripts + pickers; these run index.js's
  // own flow code (browse-window login gate, stepper, lookup queue) through
  // the handlers it registers with the host.
  {
    id: "plugin:track-plays",
    protects: "Spotify Plays info section, as the host calls it",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const entity = { kind: "track", id: 0, name: FIX.track, artistName: FIX.artist };
      const before = host.windows;
      const since = host.events.length;
      // Two concurrent fetches (the host's header + tabs both ask) must share
      // one lookup — one window, the same answer.
      const [a, b] = await Promise.all([host.infoFetch("spotify_track_plays", entity), host.infoFetch("spotify_track_plays", entity)]);
      need(host.windows - before === 1, `concurrent fetches opened ${host.windows - before} windows, expected 1 (infoLookup dedupe)`);
      need(a.status === "ok", `status ${a.status}${a.message ? ": " + a.message : ""}${throttleHint(host, since)}`);
      need(JSON.stringify(a) === JSON.stringify(b), "concurrent fetches got different results");
      const item = a.value.items[0];
      need(item && item.value > 1000 && item.label === "Spotify plays", `bad title_line value ${JSON.stringify(a.value)}`);
      need(a.value._meta && a.value._meta.providerName === "Spotify", "missing _meta.providerName");
      return `${item.value.toLocaleString("en-US")} ${item.label} (${a.value.url})`;
    },
  },
  {
    id: "plugin:artist-listeners",
    protects: "Spotify Listeners info section, as the host calls it",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const since = host.events.length;
      const r = await host.infoFetch("spotify_artist_listeners", { kind: "artist", id: 0, name: FIX.artist });
      need(r.status === "ok", `status ${r.status}${r.message ? ": " + r.message : ""}${throttleHint(host, since)}`);
      const item = r.value.items[0];
      need(item && item.value > 0, `bad title_line value ${JSON.stringify(r.value)}`);
      const miss = await host.infoFetch("spotify_artist_listeners", { kind: "artist", id: 0, name: "Qzxv Nonexistent Band" });
      need(miss.status === "not_found", `an unknown artist returned ${miss.status} (must be not_found, never a fuzzy wrong artist)`);
      return `${item.value.toLocaleString("en-US")} ${item.label}; unknown artist → not_found`;
    },
  },
  {
    id: "plugin:play-album",
    protects: "\"Play the Full Album (Spotify)\" menu action, album named",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const since = host.events.length;
      host.menuAction("play-spotify-album", { kind: "track", title: FIX.track, artistName: FIX.artist, albumTitle: FIX.album });
      const ev = await host.waitForPlayOrNotify(since, 120000);
      need(ev.kind === "play", `no play — notification: "${ev.data}"${throttleHint(host, since)}`);
      const p = host.played[host.played.length - 1];
      need(p.context && p.context.source === "album", `context ${JSON.stringify(p.context)}`);
      need(p.tracks.every((t, i) => t.track_number === i + 1), "tracks not numbered in album order");
      need(p.tracks.every((t) => t.album_title && t.artist_name && t.path), "tracks missing album / artist / path");
      const loading = host.events.slice(since).filter((e) => e.kind === "request-action").map((e) => e.data.a);
      need(loading.includes("show-loading") && loading.includes("hide-loading"), `loading modal not shown+hidden: ${loading.join(",")}`);
      return `played "${p.context.name}" — ${p.tracks.length} tracks, 1. ${p.tracks[0].title}`;
    },
  },
  {
    id: "plugin:play-album-via-track",
    protects: "\"Play the Full Album (Spotify)\" when the track has no album tag",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const since = host.events.length;
      host.menuAction("play-spotify-album", { kind: "track", title: FIX.track, artistName: FIX.artist });
      const ev = await host.waitForPlayOrNotify(since, 120000);
      need(ev.kind === "play", `no play — notification: "${ev.data}"${throttleHint(host, since)}`);
      const p = host.played[host.played.length - 1];
      return `played "${p.context.name}" — ${p.tracks.length} tracks`;
    },
  },
  {
    id: "plugin:ranked-lists",
    protects: "Spotify Top Songs / Track Popularity (artist_top_tracks, album_track_popularity) and the per-artist memo",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const since = host.events.length;
      // An artist nobody asked about yet in this run, so the first read is real.
      const artist = "Portishead";
      const top = await host.infoFetch("artist_top_tracks", { kind: "artist", name: artist, id: 0 });
      need(top.status === "ok", `Top Songs for ${artist}: ${JSON.stringify(top)}${throttleHint(host, since)}`);
      const items = top.value.items;
      need(items.length >= 5 && items.every((i) => i.name && i.value > 0), `Top Songs rows: ${JSON.stringify(items.slice(0, 3))}`);
      need(top.value._meta && /open\.spotify\.com\/artist\//.test(top.value._meta.url), "no Spotify link on Top Songs");
      // The same artist's listeners and photo now come from the memo: no window.
      const w0 = host.windows;
      const listeners = await host.infoFetch("spotify_artist_listeners", { kind: "artist", name: artist, id: 0 });
      const photo = await host.image("artist", artist);
      need(listeners.status === "ok" && photo.status === "ok", `listeners ${listeners.status}, photo ${photo.status}`);
      need(host.windows === w0, `listeners + photo opened ${host.windows - w0} more window(s) — the per-artist memo isn't shared`);
      const album = await host.infoFetch("album_track_popularity", { kind: "album", name: FIX.album, artistName: FIX.artist, id: 0 });
      need(album.status === "ok", `Track Popularity for ${FIX.album}: ${JSON.stringify(album)}${throttleHint(host, since)}`);
      const rows = album.value.items;
      need(rows.length >= 10 && rows[0].name === "Airbag", `album rows (want album order, Airbag first): ${JSON.stringify(rows.slice(0, 3))}`);
      return `${artist}: ${items.length} top songs (1. ${items[0].name}, ${items[0].value.toLocaleString("en")} plays), listeners + photo from memory; ` +
        `${FIX.album}: ${rows.length} tracks`;
    },
  },
  {
    id: "plugin:artist-sections",
    protects: "Spotify's artist sections (About, Similar Artists, Stats, Photos, Concerts, Top Songs, listeners) and their one shared read",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const since = host.events.length;
      const artist = "Massive Attack";
      const entity = { kind: "artist", name: artist, id: 0 };
      const types = ["artist_bio", "similar_artists", "spotify_artist_stats", "spotify_artist_photos",
        "spotify_concerts", "artist_top_tracks", "spotify_artist_listeners"];
      // All at once, as an artist page asks: one window must serve them all.
      const w0 = host.windows;
      const res = await Promise.all(types.map((t) => host.infoFetch(t, entity)));
      const by = Object.fromEntries(types.map((t, i) => [t, res[i]]));
      for (const t of types) {
        // A band that isn't touring has no concerts: that's not_found, not a failure.
        const okay = by[t].status === "ok" || (t === "spotify_concerts" && by[t].status === "not_found");
        need(okay, `${t}: ${JSON.stringify(by[t]).slice(0, 200)}${throttleHint(host, since)}`);
      }
      need(host.windows - w0 === 1, `the artist's ${types.length} sections opened ${host.windows - w0} windows — they should share one read`);
      const v = (t) => by[t].value;
      need(/<p>/.test(v("artist_bio").summary), "About has no paragraphs");
      need(v("similar_artists").items.length >= 5, "few similar artists");
      need(v("spotify_artist_stats").items.some((i) => i.label === "Followers"), "stats lack followers");
      need(v("spotify_artist_photos").images.every((i) => /^https:\/\//.test(i.url)), "a photo without an https url");
      const gigs = by.spotify_concerts.status === "ok" ? v("spotify_concerts").items.length : 0;
      return `${artist}: bio ${v("artist_bio").full.length} chars, ${v("similar_artists").items.length} similar, ` +
        `${v("spotify_artist_stats").items.length} stats, ${v("spotify_artist_photos").images.length} photos, ${gigs} concerts — 1 window`;
    },
  },
  {
    id: "plugin:track-sections",
    protects: "Spotify track credits (spotify_track_credits) and the play count, one shared read per track",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const since = host.events.length;
      // A track nobody asked about yet in this run.
      const entity = { kind: "track", name: "Teardrop", artistName: "Massive Attack", albumTitle: "Mezzanine", id: 0 };
      const w0 = host.windows;
      const [credits, plays] = await Promise.all([
        host.infoFetch("spotify_track_credits", entity),
        host.infoFetch("spotify_track_plays", entity),
      ]);
      need(credits.status === "ok", `credits: ${JSON.stringify(credits).slice(0, 200)}${throttleHint(host, since)}`);
      need(plays.status === "ok", `plays: ${JSON.stringify(plays).slice(0, 200)}${throttleHint(host, since)}`);
      need(host.windows - w0 === 1, `credits + plays opened ${host.windows - w0} windows — they should share one read`);
      const rows = credits.value.items;
      need(rows.some((r) => /^(Composer|Writer|Songwriter|Lyricist)/.test(r.key)), `no writer among the credits: ${JSON.stringify(rows)}`);
      need(rows.every((r) => r.key && r.value), "a credit row without a role or names");
      return `"${entity.name}": ${rows.map((r) => r.key).join(", ")}; ${plays.value.items[0].value.toLocaleString("en")} plays — 1 window`;
    },
  },
  {
    id: "plugin:lyrics",
    protects: "Spotify lyrics (the lyrics chain): synced only for the user's cut, words otherwise, none for an instrumental",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const since = host.events.length;
      const track = (durationSecs) => ({ kind: "track", name: FIX.track, artistName: FIX.artist, albumTitle: FIX.album, id: 0, durationSecs });
      // The album cut is 4:24: a track page asks for lyrics, plays and credits at once.
      const w0 = host.windows;
      const [synced, plays, credits] = await Promise.all([
        host.infoFetch("lyrics", track(264)),
        host.infoFetch("spotify_track_plays", track(264)),
        host.infoFetch("spotify_track_credits", track(264)),
      ]);
      need(synced.status === "ok", `lyrics for "${FIX.track}": ${JSON.stringify(synced).slice(0, 200)}${throttleHint(host, since)}`);
      need(synced.value.kind === "synced" && /^\[\d\d:\d\d\.\d\d\]/.test(synced.value.text), `want synced LRC for the right length, got ${synced.value.kind}`);
      need(plays.status === "ok" && credits.status === "ok", `plays ${plays.status}, credits ${credits.status}`);
      need(host.windows - w0 === 1, `lyrics + plays + credits opened ${host.windows - w0} windows — they should share one read`);
      const lines = synced.value.text.split("\n").length;
      // Another cut's length, or none: the words only (a synced value is cached forever).
      const wrong = await host.infoFetch("lyrics", track(300));
      need(wrong.status === "ok" && wrong.value.kind === "plain" && !/\[\d\d:/.test(wrong.value.text), `wrong length should give plain words, got ${JSON.stringify(wrong).slice(0, 120)}`);
      const unknown = await host.infoFetch("lyrics", track(undefined));
      need(unknown.status === "ok" && unknown.value.kind === "plain", `unknown length should give plain words, got ${unknown.value && unknown.value.kind}`);
      need(/Spotify/.test(synced.value._meta.providerName), "no Spotify attribution");
      // An instrumental has no lyrics: not_found, so the chain moves on / shows none.
      const inst = await host.infoFetch("lyrics", { kind: "track", name: "Avril 14th", artistName: "Aphex Twin", id: 0, durationSecs: 125 });
      need(inst.status === "not_found", `an instrumental should be not_found, got ${JSON.stringify(inst).slice(0, 160)}`);
      return `"${FIX.track}": synced ${lines} lines (${synced.value._meta.providerName}) with plays + credits in 1 window; ` +
        `wrong / unknown length → words; instrumental → not_found`;
    },
  },
  {
    id: "plugin:now-playing",
    protects: "The \"Plays (Spotify)\" Now Playing info item (nowPlayingPlays): within the host's 5s, instant once known",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const item = host.nowPlayingItems["spotify-plays"];
      need(item && item.label === "Plays (Spotify)" && item.defaultEnabled === false, `item not registered as expected: ${JSON.stringify(item)}`);
      // A song nobody asked about yet in this run, as the host passes it.
      const track = { title: "Hounds of Love", artist_name: "Kate Bush", album_title: "Hounds of Love", duration_secs: 183 };
      const t0 = Date.now();
      const first = await host.nowPlaying("spotify-plays", track);
      const firstMs = Date.now() - t0;
      need(firstMs < 5000, `first answer took ${firstMs}ms — past the host's 5s, the item would be dropped`);
      // The read runs on even when the first answer came back empty (an ask
      // meanwhile joins it rather than starting another): wait for it to land.
      let landed = first;
      for (let i = 0; i < 20 && landed.status !== "ok"; i++) {
        await sleep(1000);
        landed = await host.nowPlaying("spotify-plays", track);
      }
      need(landed.status === "ok" && /^[\d.]+[kMB]? plays on Spotify$/.test(landed.text), `no plays line: ${JSON.stringify(landed)}`);
      // Now the song is known: the next ask (the song playing again) must come
      // from memory, well inside the 5s.
      const t1 = Date.now();
      const again = await host.nowPlaying("spotify-plays", track);
      const againMs = Date.now() - t1;
      need(again.status === "ok" && againMs < 200, `a known song took ${againMs}ms (${again.status}) — it should come from memory`);
      // Look-ahead: with the item in use, the next queued song is read while
      // this one plays, so it is known by the time it starts (a cold read
      // rarely fits in the host's 5s).
      const next = { title: "Running Up That Hill (A Deal With God)", artist_name: "Kate Bush", album_title: "Hounds of Love", duration_secs: 300 };
      host.queue = { tracks: [track, next], index: 0 };
      host.startTrack(track);
      let ready = null;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const t2 = Date.now();
        const r = await host.nowPlaying("spotify-plays", next);
        if (r.status === "ok" && Date.now() - t2 < 200) { ready = r; break; }
      }
      need(ready, "the next queued song wasn't looked up ahead (lookAheadNextTrack)");
      return `cold: ${first.status} in ${firstMs}ms; then "${again.text}" from memory in ${againMs}ms; ` +
        `next in queue read ahead: "${ready.text}"`;
    },
  },
  {
    id: "plugin:images",
    protects: "Artist photo / album cover image providers (api.imageProviders: lookupArtistImage, lookupAlbumCover)",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const since = host.events.length;
      // As the host's chain asks: one at a time, (name) / (name, artistName).
      const artist = await host.image("artist", FIX.artist);
      need(artist && artist.status === "ok" && /^https:\/\/i\.scdn\.co\/image\//.test(artist.url),
        `artist "${FIX.artist}": ${JSON.stringify(artist)}${throttleHint(host, since)}`);
      const album = await host.image("album", FIX.album, FIX.artist);
      need(album && album.status === "ok" && /^https:\/\/i\.scdn\.co\/image\/ab67616d0000b273/.test(album.url),
        `album "${FIX.album}": ${JSON.stringify(album)} (want the 640px cover)${throttleHint(host, since)}`);
      // A wrong picture is worse than none: an unknown name must not borrow one.
      const nobody = await host.image("artist", "Zzqx Nonexistent Artist 4417");
      need(nobody && nobody.status !== "ok", `an unknown artist got a picture: ${JSON.stringify(nobody)}`);
      const noArtist = await host.image("album", FIX.album);
      need(noArtist && noArtist.status === "not_found", `an album with no artist should be not_found: ${JSON.stringify(noArtist)}`);
      return `artist ${artist.url.split("/").pop().slice(0, 12)}…, album ${album.url.split("/").pop().slice(0, 12)}…, unknown → ${nobody.status}`;
    },
  },
  {
    id: "plugin:assistant-tools",
    protects: "get_album_tracks / get_track_plays / get_artist_listeners",
    async run({ pluginHost }) {
      const host = await pluginHost();
      const album = await host.tool("get_album_tracks", { artist: FIX.artist, album: FIX.album });
      need(album.found && album.tracks.length > 0, `get_album_tracks: ${JSON.stringify(album).slice(0, 200)}`);
      const before = host.windows;
      const plays = await host.tool("get_track_plays", { artist: FIX.artist, title: FIX.track });
      need(plays.found && plays.plays > 1000, `get_track_plays: ${JSON.stringify(plays)}`);
      const listeners = await host.tool("get_artist_listeners", { artist: FIX.artist });
      need(listeners.found && listeners.monthlyListeners > 0, `get_artist_listeners: ${JSON.stringify(listeners)}`);
      let threw = false;
      try { await host.tool("get_album_tracks", {}); } catch { threw = true; }
      need(threw, "get_album_tracks accepted empty args");
      return `album ${album.tracks.length} tracks · ${plays.plays.toLocaleString("en-US")} plays · ${listeners.monthlyListeners.toLocaleString("en-US")} listeners (${host.windows - before} extra windows)`;
    },
  },
];

async function main() {
  const S = extractScripts(INDEX_PATH);
  const opts = harnessOptions();
  const selected = ONLY ? CHECKS.filter((c) => ONLY.includes(c.id)) : CHECKS;
  if (ONLY) {
    const unknown = ONLY.filter((id) => !CHECKS.some((c) => c.id === id));
    if (unknown.length) throw new Error(`unknown check(s): ${unknown.join(", ")} — known: ${CHECKS.map((c) => c.id).join(", ")}`);
    // Pull in what the selected checks depend on.
    for (const c of [...selected]) for (const dep of c.needs || []) {
      if (!selected.some((s) => s.id === dep)) selected.unshift(CHECKS.find((x) => x.id === dep));
    }
  }
  console.log("options:", JSON.stringify(opts));
  console.log("fixtures:", JSON.stringify(FIX));

  const results = [];
  const { ctx, page } = await launch(opts);
  // One plugin instance for every plugin:* check, started on first use.
  let hostP = null;
  const pluginHost = () => (hostP = hostP || startFakeHost(ctx, { debug: opts.debug }));
  try {
    const bridge = await installBridge(page, opts);
    const t0 = Date.now();
    try {
      await ensureLoggedIn(page, bridge, S, opts);
      results.push({ id: "login", status: "pass", ms: Date.now() - t0, detail: "logged in", protects: "everything" });
    } catch (e) {
      results.push({ id: "login", status: "fail", ms: Date.now() - t0, detail: e.message, protects: "everything" });
      return results;
    }
    console.log("✓ login");

    const shared = {};
    for (const check of CHECKS.filter((c) => selected.includes(c))) {
      const blocked = (check.needs || []).filter((dep) => !results.some((r) => r.id === dep && r.status === "pass"));
      if (blocked.length) {
        results.push({ id: check.id, status: "skip", ms: 0, detail: `needs ${blocked.join(", ")}`, protects: check.protects });
        console.log(`- ${check.id}: skipped (needs ${blocked.join(", ")})`);
        continue;
      }
      bridge.reset();
      const start = Date.now();
      process.stdout.write(`… ${check.id} `);
      try {
        const detail = await check.run({ page, bridge, S, shared, pluginHost });
        results.push({ id: check.id, status: "pass", ms: Date.now() - start, detail, protects: check.protects });
        console.log(`\r✓ ${check.id}: ${detail}`);
      } catch (e) {
        const detail = e instanceof CheckFailure ? e.message : `harness error: ${e.message}`;
        // Evidence for the post-mortem: what the page looked like when the
        // check gave up (plugin:* checks run in their own windows, which the
        // fake host captures itself under VERIFY_DEBUG).
        const shot = join(tmpdir(), `viboplr-spotify-verify-${check.id.replace(/[^\w-]/g, "_")}.png`);
        const shotOk = await page.screenshot({ path: shot }).then(() => true, () => false);
        const seen = await page.evaluate(() => ((document.querySelector("main") || document.body).innerText || "").replace(/\s+/g, " ").trim().slice(0, 160)).catch(() => "");
        // Spotify's own error page means Spotify refused the request (outage,
        // or rate limiting after a burst of runs) — say so before anyone goes
        // hunting for a selector that didn't move.
        const spotifyError = /Something went wrong/i.test(seen)
          ? " [Spotify showed its \"Something went wrong\" page — an outage or rate limiting; re-run later before touching selectors]"
          : "";
        results.push({ id: check.id, status: "fail", ms: Date.now() - start, detail: detail + spotifyError, protects: check.protects, url: page.url(), screenshot: shotOk ? shot : null, pageText: seen });
        console.log(`\r✗ ${check.id}: ${detail}`);
      }
    }
    return results;
  } finally {
    if (hostP) await hostP.then((h) => h.deactivate(), () => {});
    await ctx.close();
  }
}

function report(results) {
  const w = Math.max(...results.map((r) => r.id.length));
  console.log("\n===== VERIFY ALL =====");
  for (const r of results) {
    const mark = r.status === "pass" ? "✓" : r.status === "skip" ? "-" : "✗";
    console.log(`${mark} ${r.id.padEnd(w)}  ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.detail}`);
    if (r.status === "fail") {
      console.log(`  ${" ".repeat(w)}          affects: ${r.protects}${r.url ? " · at " + r.url : ""}`);
      if (r.pageText) console.log(`  ${" ".repeat(w)}          page said: "${r.pageText}"`);
      if (r.screenshot) console.log(`  ${" ".repeat(w)}          screenshot: ${r.screenshot}`);
    }
  }
  const failed = results.filter((r) => r.status === "fail").length;
  const passed = results.filter((r) => r.status === "pass").length;
  console.log(`\n${failed ? "✗ FAIL" : "✓ PASS"} — ${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped`);
  if (env.VERIFY_REPORT) {
    writeFileSync(env.VERIFY_REPORT, JSON.stringify({ at: new Date().toISOString(), fixtures: FIX, results }, null, 2));
    console.log("report written to " + env.VERIFY_REPORT);
  }
  if (failed) process.exitCode = 1;
}

main().then(report).catch((e) => {
  console.error("\n✗ harness error:", e.message);
  process.exitCode = 1;
});
