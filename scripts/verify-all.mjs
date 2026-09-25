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
      need(albums.every((c) => c.artists.length > 0), "album cards carry no artist link (cardSubtitle drifted)");
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
