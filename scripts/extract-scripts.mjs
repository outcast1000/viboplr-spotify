// Pulls the eval'd scrape scripts out of index.js so the verify harness always
// runs the SAME code the host app runs. The script-building block in index.js
// is delimited by sentinel comments and is self-contained (string concatenation
// + builder functions only — no dependency on `api`), so it can be eval'd in a
// bare vm context with a stub window/console.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const MARKER_RE =
  /\/\/ >>> SCRAPE-SCRIPTS-START[^\n]*\n([\s\S]*?)\n\s*\/\/ <<< SCRAPE-SCRIPTS-END/;

export function extractScripts(indexPath) {
  const source = readFileSync(indexPath, "utf8");
  const m = source.match(MARKER_RE);
  if (!m) {
    throw new Error(
      "SCRAPE-SCRIPTS markers not found in " + indexPath +
        " — cannot extract scrape scripts (see Task 1 of the verify-scrape plan)."
    );
  }

  // The block is written with `var`/`function` declarations. Eval it in a vm
  // whose global object we can read back afterward. `window`/`console` are
  // stubbed but never actually called during string assembly.
  const sandbox = { window: { __viboplr: { send() {} } }, console: { log() {}, error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: "index.js#scrape-scripts" });

  const out = {
    SCRIPT_CHECK_LOGIN: sandbox.SCRIPT_CHECK_LOGIN,
    scriptScrapeShelves: sandbox.scriptScrapeShelves,
    scriptNavigatePlaylist: sandbox.scriptNavigatePlaylist,
    scriptScrollThenScrape: sandbox.scriptScrollThenScrape,
    // Direct tracklist reads (Pathfinder) — the first attempt for playlists,
    // albums and Liked Songs; the scroll scrape above is the fallback.
    scriptDirectTracks: sandbox.scriptDirectTracks,
    // One Pathfinder query (search, getTrack, queryArtistOverview, home) and
    // the request capture withSpotifyWindow installs on every page.
    scriptPathfinder: sandbox.scriptPathfinder,
    SCRIPT_CAPTURE: sandbox.SCRIPT_CAPTURE,
    // The pure mappers from Pathfinder responses to the plugin's own shapes
    // (scripts/direct.test.mjs pins them against recorded responses).
    SEARCH_OPS: sandbox.SEARCH_OPS,
    searchVars: sandbox.searchVars,
    candidatesFromSearch: sandbox.candidatesFromSearch,
    tracksFromSearch: sandbox.tracksFromSearch,
    playsFromTrack: sandbox.playsFromTrack,
    listenersFromOverview: sandbox.listenersFromOverview,
    topTracksFromOverview: sandbox.topTracksFromOverview,
    albumTracksFromAlbum: sandbox.albumTracksFromAlbum,
    artistFactsFromOverview: sandbox.artistFactsFromOverview,
    bioSection: sandbox.bioSection,
    relatedSection: sandbox.relatedSection,
    statsSection: sandbox.statsSection,
    photosSection: sandbox.photosSection,
    concertsSection: sandbox.concertsSection,
    concertDate: sandbox.concertDate,
    creditsFromTrack: sandbox.creditsFromTrack,
    creditsSection: sandbox.creditsSection,
    lyricsFromColorLyrics: sandbox.lyricsFromColorLyrics,
    lyricsValue: sandbox.lyricsValue,
    lrcTime: sandbox.lrcTime,
    sameLength: sandbox.sameLength,
    pickTrackByLength: sandbox.pickTrackByLength,
    scriptSpclient: sandbox.scriptSpclient,
    homeVars: sandbox.homeVars,
    shelvesFromHome: sandbox.shelvesFromHome,
    mapTrackRow: sandbox.mapTrackRow,
    htmlToText: sandbox.htmlToText,
    formatMs: sandbox.formatMs,
    MUSIC_CHIP_URL: sandbox.MUSIC_CHIP_URL,
    // "Start Spotify radio" flow (search seed -> go-to-radio -> scrape tracklist).
    searchTracksUrl: sandbox.searchTracksUrl,
    scriptNavigateSearch: sandbox.scriptNavigateSearch,
    scriptSearchTopTrack: sandbox.scriptSearchTopTrack,
    scriptNavigateTrackPage: sandbox.scriptNavigateTrackPage,
    scriptGoToRadio: sandbox.scriptGoToRadio,
    scriptWaitForStation: sandbox.scriptWaitForStation,
    // Song search (results-rendered gate before the shared row parser).
    scriptWaitForSearchResults: sandbox.scriptWaitForSearchResults,
    // Catalog lookups (album tracklist, track plays, artist listeners): the
    // page scripts plus the pure pickers/parsers the plugin runs on their
    // output — the harness uses the same ones, so a pass means the plugin's
    // own matching works on today's pages.
    searchUrl: sandbox.searchUrl,
    scriptNavigateTo: sandbox.scriptNavigateTo,
    scriptSearchCandidates: sandbox.scriptSearchCandidates,
    scriptWaitForPage: sandbox.scriptWaitForPage,
    scriptReadTrackPlays: sandbox.scriptReadTrackPlays,
    scriptReadArtistListeners: sandbox.scriptReadArtistListeners,
    normalizeName: sandbox.normalizeName,
    coreTitle: sandbox.coreTitle,
    artistMatches: sandbox.artistMatches,
    pickTrackCandidate: sandbox.pickTrackCandidate,
    pickAlbumCandidate: sandbox.pickAlbumCandidate,
    pickArtistCandidate: sandbox.pickArtistCandidate,
    parseCount: sandbox.parseCount,
    pickListenerCount: sandbox.pickListenerCount,
  };

  for (const [k, v] of Object.entries(out)) {
    if (v == null) throw new Error("extraction produced no value for " + k);
  }
  return out;
}
