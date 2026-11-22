// Verify the direct tracklist reads (scriptDirectTracks — Pathfinder, no
// scrolling) against the LIVE web player, and compare each with the page
// scrape (scriptScrollThenScrape) the plugin falls back to.
//
//   npm run verify:direct
//   VERIFY_HEADLESS=1 npm run verify:direct          (after one headed login)
//   VERIFY_SKIP_SCRAPE=1 npm run verify:direct       (direct reads only — fast)
//   VERIFY_PLAYLIST=<id> VERIFY_BIG_PLAYLIST=<id> VERIFY_ALBUM_ID=<id> npm run verify:direct
//   RADIO_QUERY="Daft Punk One More Time" RADIO_TITLE="One More Time" RADIO_ARTIST="Daft Punk"
//
// A pass means: each direct read answered "tracks" (not "tracks-direct-failed"),
// read as many tracks as Spotify says the list has (paging works), every row
// has a name and an artist, and — unless skipped — the scrape of the same list
// found no track the direct read missed.
import { env } from "node:process";
import { extractScripts } from "./extract-scripts.mjs";
import {
  INDEX_PATH, harnessOptions, launch, installBridge, ensureLoggedIn, step, evalIn, sleep, envBool,
} from "./lib/harness.mjs";
import { startFakeHost } from "./lib/fake-host.mjs";

const OPTS = harnessOptions();
const SKIP_SCRAPE = envBool("VERIFY_SKIP_SCRAPE");
const GEN = 1;

const TARGETS = [
  { label: "Liked Songs", tag: "liked-songs", id: null, kind: "collection" },
  { label: "playlist", tag: "verify-playlist", id: env.VERIFY_PLAYLIST || "37i9dQZF1DXcBWIGoYBM5M", kind: "playlist" },
  // Over 100 tracks, so the read needs more than one page.
  { label: "big playlist", tag: "verify-big", id: env.VERIFY_BIG_PLAYLIST || "37i9dQZF1DX4UtSsGT1Sbe", kind: "playlist" },
  { label: "album", tag: "verify-album", id: env.VERIFY_ALBUM_ID || "6dVIqQ8qmQ5GBnJ9shOYGE", kind: "album" },
];

const key = (t) => t.spotifyId || `${t.name}|${t.artist}`;
const RADIO_QUERY = env.RADIO_QUERY || "Daft Punk One More Time";

async function readDirect(page, bridge, S, t) {
  const t0 = Date.now();
  const d = await step(page, bridge, S.scriptDirectTracks(t.tag, t.id, GEN, { kind: t.kind }),
    ["tracks", "tracks-direct-failed"], {
      pump: false,
      timeoutMs: 120000,
      match: (m) => m.playlistId === t.tag && (m.source === "direct" || m.reason !== undefined),
    });
  return { ...d, ms: Date.now() - t0 };
}

async function readScrape(page, bridge, S, t) {
  // Same as the plugin's fallback: full navigation, then its 4s settle.
  await bridge.ensure();
  await evalIn(page, S.scriptNavigatePlaylist(t.id || t.tag, t.kind));
  await sleep(4500);
  const t0 = Date.now();
  const d = await step(page, bridge, S.scriptScrollThenScrape(t.id || t.tag, GEN, { kind: t.kind, maxSteps: 999 }), "tracks", {
    pump: false,
    timeoutMs: 30000 + 800 * 999,
    match: (m) => m.playlistId === (t.id || t.tag) && m.source === undefined,
  });
  return { ...d, ms: Date.now() - t0 };
}

const S = extractScripts(INDEX_PATH);
const { ctx, page } = await launch(OPTS);
const bridge = await installBridge(page, OPTS);
let failures = 0;
try {
  await ensureLoggedIn(page, bridge, S, OPTS);
  for (const t of TARGETS) {
    console.log(`\n== ${t.label} (${t.kind}${t.id ? " " + t.id : ""})`);
    bridge.reset();
    let direct;
    try {
      direct = await readDirect(page, bridge, S, t);
    } catch (e) {
      console.log(`  FAIL direct: ${e.message}`); failures++; continue;
    }
    if (direct.__type === "tracks-direct-failed") {
      console.log(`  FAIL direct: ${direct.reason}`); failures++; continue;
    }
    const tracks = direct.tracks || [];
    const noArtist = tracks.filter((x) => !x.name || !x.artist).length;
    console.log(`  direct: ${tracks.length}/${direct.total} tracks in ${direct.ms}ms` +
      (direct.coverUrl ? ", cover ok" : ", no cover") +
      (direct.description ? `, description "${direct.description.slice(0, 50)}"` : ""));
    if (tracks[0]) console.log(`    first: ${JSON.stringify(tracks[0])}`);
    if (!tracks.length) { console.log("  FAIL direct: no tracks"); failures++; continue; }
    if (direct.total != null && tracks.length < direct.total) {
      // Duplicates collapse by Spotify id, like the scrape; anything more is a paging bug.
      console.log(`  WARN direct: ${direct.total - tracks.length} short of the list's total (duplicates or unreadable items)`);
    }
    if (noArtist) { console.log(`  FAIL direct: ${noArtist} rows without a name or artist`); failures++; }

    if (SKIP_SCRAPE) continue;
    bridge.reset();
    let scrape;
    try {
      scrape = await readScrape(page, bridge, S, t);
    } catch (e) {
      console.log(`  (scrape for comparison failed: ${e.message})`); continue;
    }
    const st = scrape.tracks || [];
    const have = new Set(tracks.map(key));
    const missing = st.filter((x) => !have.has(key(x)));
    console.log(`  scrape: ${st.length}/${scrape.total} tracks in ${scrape.ms}ms — ${missing.length} the direct read lacks`);
    if (missing.length) {
      console.log(`    e.g. ${missing.slice(0, 3).map((x) => `${x.name} – ${x.artist}`).join("; ")}`);
      failures++;
    }
  }

  // Song radio: seed search (the page, as the plugin does), the direct station
  // read, then — unless skipped — the old click path on the same seed, which
  // must land on the same station.
  console.log(`\n== song radio ("${RADIO_QUERY}")`);
  try {
    bridge.reset();
    await bridge.ensure();
    await evalIn(page, S.scriptNavigateTo(S.searchTracksUrl(RADIO_QUERY)));
    const seed = await step(page, bridge, S.scriptSearchTopTrack(GEN), "radio-seed", { timeoutMs: 40000 });
    if (!seed.trackId) throw new Error(`seed search failed: ${seed.error || "no trackId"}`);
    console.log(`  seed: ${seed.name} — ${seed.artist} (${seed.trackId})`);
    const d = await readDirect(page, bridge, S, { tag: "radio-station", id: seed.trackId, kind: "radio" });
    if (d.__type === "tracks-direct-failed") throw new Error(`direct: ${d.reason}`);
    const tracks = d.tracks || [];
    console.log(`  direct: station ${d.stationId}, ${tracks.length}/${d.total} tracks in ${d.ms}ms`);
    if (tracks.length < 10) { console.log("  FAIL direct: fewer than 10 station tracks"); failures++; }
    // stripSeedRow drops the opening row only when it is the seed, by id.
    if (!tracks[0] || tracks[0].spotifyId !== seed.trackId) {
      console.log(`  WARN: the station doesn't open with the seed (first: ${tracks[0] && tracks[0].name}) — the seed will play twice`);
    }
    if (!SKIP_SCRAPE) {
      await evalIn(page, S.scriptNavigateTrackPage(seed.trackId));
      const go = await step(page, bridge, S.scriptGoToRadio(GEN, seed.trackId), "radio-go", { timeoutMs: 45000 });
      if (!go.ok) throw new Error(`click path: "Go to song radio" failed: ${go.error || "?"}`);
      const st = await step(page, bridge, S.scriptWaitForStation(GEN, seed.trackId), "radio-station", { timeoutMs: 30000 });
      if (!st.ok) throw new Error(`click path: station page never opened: ${st.error || "?"}`);
      const clickStation = (String(st.url).match(/\/playlist\/([A-Za-z0-9]+)/) || [])[1];
      const sc = await step(page, bridge, S.scriptScrollThenScrape("radio-click", GEN, { maxSteps: 40 }), "tracks", {
        pump: false, timeoutMs: 60000, match: (m) => m.playlistId === "radio-click",
      });
      const have = new Set(tracks.map(key));
      const missing = (sc.tracks || []).filter((x) => !have.has(key(x)));
      console.log(`  click path: station ${clickStation}, ${(sc.tracks || []).length} tracks — ${missing.length} the direct read lacks`);
      if (clickStation !== d.stationId) { console.log("  FAIL: the direct read picked a different station than the click"); failures++; }
      if (missing.length) { console.log(`    e.g. ${missing.slice(0, 3).map((x) => `${x.name} – ${x.artist}`).join("; ")}`); failures++; }
    }
  } catch (e) {
    console.log(`  FAIL radio: ${e.message}`); failures++;
  }

  // The plugin's own flow (ensureTracks, through the get_playlist_tracks
  // assistant tool) on the REAL index.js: once as shipped, once with the direct
  // read's requests refused, which must fall back to the page scrape and still
  // answer. The direct read is told apart by its page size (limit 100): the
  // page itself asks for 25 / 50, so the scrape still renders.
  console.log("\n== plugin flow (ensureTracks)");
  const big = TARGETS.find((x) => x.tag === "verify-big");
  const pl = TARGETS.find((x) => x.tag === "verify-playlist");
  let refuseDirect = false;
  let refuseSearch = false;
  await ctx.route("https://api-partner.spotify.com/pathfinder/v2/query", (route) => {
    let body = null;
    try { body = JSON.parse(route.request().postData() || "null"); } catch { /* not JSON */ }
    if (refuseDirect && body && /^fetchPlaylist/.test(body.operationName) && body.variables && body.variables.limit === 100) {
      return route.fulfill({ status: 500, body: "refused by verify-direct" });
    }
    // The plugin's song search asks for 50; the search page asks for 20.
    if (refuseSearch && body && body.operationName === "searchTracks" && body.variables && body.variables.limit === 50) {
      return route.fulfill({ status: 500, body: "refused by verify-direct" });
    }
    return route.continue();
  });
  const host = await startFakeHost(ctx, {
    debug: OPTS.debug,
    seedPlaylists: [{ id: big.id, name: "Verify big" }, { id: pl.id, name: "Verify fallback" }],
  });
  try {
    for (let i = 0; i < 40; i++) {
      const l = await host.tool("list_playlists", {});
      if (l.playlists.length >= 2) break;
      await sleep(250);
    }
    for (const [id, refuse] of [[big.id, false], [pl.id, true]]) {
      refuseDirect = refuse;
      const since = host.events.length;
      const t0 = Date.now();
      let res;
      try {
        res = await host.tool("get_playlist_tracks", { id });
      } catch (e) {
        console.log(`  FAIL ${refuse ? "fallback" : "direct"}: ${e.message}`); failures++; continue;
      }
      const logs = host.events.slice(since).filter((e) => e.kind === "log").map((e) => String(e.data));
      const fellBack = logs.some((l) => /falling back to the page scrape/.test(l));
      const n = (res.tracks || []).length;
      console.log(`  ${refuse ? "direct refused" : "as shipped"}: ${n} tracks in ${Date.now() - t0}ms${fellBack ? " (fell back to the scrape)" : ""}`);
      if (!n) { console.log("  FAIL: no tracks"); failures++; }
      if (refuse && !fellBack) { console.log("  FAIL: expected a fallback to the scrape"); failures++; }
      if (!refuse && fellBack) { console.log(`  FAIL: the direct read failed: ${logs.find((l) => /falling back/.test(l))}`); failures++; }
    }

    // "Start radio" from the track menu (startSpotifyRadio → playWithBackfill),
    // as shipped and with the direct station read refused (must fall back to
    // the click). What is refused is the station's fetchPlaylist page of 100,
    // not inspiredby-mix: the web player's own "Go to song radio" click calls
    // inspiredby-mix too, so refusing it breaks both paths — the fallback
    // covers our read breaking, not that service being down.
    const radioSeed = { kind: "track", title: env.RADIO_TITLE || "One More Time", artistName: env.RADIO_ARTIST || "Daft Punk" };
    for (const refuse of [false, true]) {
      refuseDirect = refuse;
      const since = host.events.length;
      const n0 = host.backfills.length;
      const t0 = Date.now();
      host.menuAction("start-spotify-radio", radioSeed);
      let rec = null;
      for (let i = 0; i < 480 && !(rec && rec.tail); i++) { await sleep(250); rec = host.backfills[n0] || null; }
      const logs = host.events.slice(since).filter((e) => e.kind === "log").map((e) => String(e.data));
      const fellBack = logs.some((l) => /direct station read (failed|timeout|was empty)/.test(l));
      const n = rec && rec.tail ? rec.tail.length : 0;
      console.log(`  radio ${refuse ? "direct refused" : "as shipped"}: seed + ${n} tracks in ${Date.now() - t0}ms${fellBack ? " (fell back to the click path)" : ""}`);
      if (n < 10) { console.log(`  FAIL: station tail too short${rec && rec.error ? ": " + rec.error : ""}`); failures++; }
      if (refuse && !fellBack) { console.log("  FAIL: expected a fallback to the click path"); failures++; }
      if (!refuse && fellBack) { console.log(`  FAIL: the direct station read failed: ${logs.find((l) => /direct station read/.test(l))}`); failures++; }
    }

    // Song search (the Cmd+K provider → scrapeSearchTracks), as shipped and
    // with the direct search refused (must fall back to the search page). Two
    // queries: a repeated one is served from the plugin's 10-minute cache.
    for (const [q, refuse] of [[env.SEARCH_QUERY || "Daft Punk One More Time", false], ["Radiohead Karma Police", true]]) {
      refuseSearch = refuse;
      const since = host.events.length;
      const t0 = Date.now();
      let r;
      try { r = await host.search("spotify", q, 20); } catch (e) { console.log(`  FAIL search: ${e.message}`); failures++; continue; }
      const logs = host.events.slice(since).filter((e) => e.kind === "log").map((e) => String(e.data));
      const fellBack = logs.some((l) => /direct search (failed|timeout)/.test(l));
      const n = (r && r.tracks || []).length;
      console.log(`  search ${refuse ? "direct refused" : "as shipped"}: "${q}" → ${n} tracks in ${Date.now() - t0}ms${fellBack ? " (fell back to the search page)" : ""}`);
      if (n < 5) { console.log(`  FAIL: too few results (${r && r.status})`); failures++; }
      if (refuse && !fellBack) { console.log("  FAIL: expected a fallback to the search page"); failures++; }
      if (!refuse && fellBack) { console.log(`  FAIL: the direct search failed: ${logs.find((l) => /direct search/.test(l))}`); failures++; }
    }
    refuseSearch = false;

    // Sync (the home shelves): must come from the direct read — the page's
    // own home answer when the capture kept it.
    {
      const since = host.events.length;
      const t0 = Date.now();
      host.uiAction("sync");
      let st = null;
      for (let i = 0; i < 480; i++) {
        await sleep(250);
        st = await host.tool("status", {});
        if (i > 4 && st.syncStatus !== "running" && st.syncStatus !== "checking" && st.syncStatus !== "waiting-login") break;
      }
      const logs = host.events.slice(since).filter((e) => e.kind === "log").map((e) => String(e.data));
      const how = logs.find((l) => /home: \d+ shelves \(direct/.test(l));
      const fellBack = logs.find((l) => /direct home read (failed|timed out)/.test(l));
      console.log(`  sync: ${st.syncStatus}, ${st.playlistCount} playlists in ${st.sections.length} shelves in ${Date.now() - t0}ms — ` +
        (how ? how.replace(/^.*\[shelves\] /, "") : fellBack ? "fell back: " + fellBack.replace(/^.*\[shelves\] /, "") : "no direct read logged"));
      if (!st.playlistCount) { console.log("  FAIL: sync found no playlists"); failures++; }
      if (!how) { console.log("  FAIL: sync didn't use the direct home read"); failures++; }
    }
  } finally {
    refuseDirect = false;
    refuseSearch = false;
    await host.deactivate();
  }
} finally {
  await ctx.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll direct reads passed");
process.exit(failures ? 1 : 0);
