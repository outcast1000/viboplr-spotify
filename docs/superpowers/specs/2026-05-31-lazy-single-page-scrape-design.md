# Lazy Single-Page Scrape — Design

**Date:** 2026-05-31
**Status:** Approved (design); implementation pending
**Plugin:** `spotify-browse` (viboplr-spotify)

## Summary

Replace the current eager, multi-phase scraping pipeline with a single-page
scrape plus lazy, cached track fetching.

Today, a sync: waits for login → for each user-configured section, navigates to
home and runs a fragile section-finder (with a "Music button" fallback and a
10-retry loop) → scrapes that section's playlist cards → then navigates into
**every** playlist and scroll-scrapes its tracks. This is slow (N playlists ×
page-load + scroll) and brittle (section discovery and per-playlist track
scraping are the two flakiest parts of the plugin).

The new model:

1. **Sync = one page load.** Open `open.spotify.com/home?facet=music-chip` (the
   home page with the **Music** chip active), wait for login, and scrape every
   playlist card across all shelves in the main content. Each shelf's heading
   becomes the playlist's "section". **No track scraping during sync.**
2. **Tracks are lazy.** Tracks for a playlist are scraped only when the user
   clicks **View**, **Play**, or **Enqueue**. Scraped tracks are written to disk
   and reused for **24 hours**, after which they are re-scraped on next demand.

This trades a slow, flaky eager pipeline for a fast, simple, lazy one.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Source page | `open.spotify.com/home?facet=music-chip` |
| Layout | Grouped by shelf (one section/tab per shelf heading) |
| Track caching | Cache to disk on first fetch; invalidate after 24h |
| Liked Songs | Dropped entirely |
| Card types | Playlists only (ignore album/artist cards) |
| Auto-refresh | Kept, but refreshes the **list only** (no track scraping) |
| View behavior | Auto-fetch tracks on opening the detail view |
| Browse window | Open/close per action (no persistent warm window) |

## Architecture

### Core model shift

- **Sync** populates `state.playlists` (with covers from the shelf cards) and
  derives `state.sections` from the shelf headings, in page order. The grid is
  fully populated and visual immediately — covers come from the cards already in
  the DOM, so no track scrape is needed to show the library.
- **Shelf heading → `section`.** This maps cleanly onto the existing `section`
  concept, so the on-disk layout (`playlists/{section}/{id}/…`), the tabs, the
  per-section card grids, and the home-shelf registration all keep working.
  The only change is that `state.sections` is **derived from the scrape**
  instead of user-configured.
- **Tracks** are populated lazily by `ensureTracks(pl)` and cached on disk with
  a `tracksFetchedAt` timestamp.

### Two scrape paths (replacing the 4-phase pipeline)

A shared helper centralizes the login machinery (the one part worth keeping
intact):

```
withSpotifyWindow(visible, fn) -> Promise
  open browse window at the music-chip URL
  run login check / grace-poll / sign-in banner (unchanged logic)
  on logged-in: resolve fn(handle)
  always close the window when fn settles (or on cancel / window-closed)
```

**`syncPlaylists()`** — `withSpotifyWindow` → navigate to the music-chip URL →
inject `SCRIPT_SCRAPE_SHELVES` → receive `[{ section, id, name, imageUrl }]`
grouped by shelf → update `state.sections` (page order) and `state.playlists`.
Deletes: `scriptFindSection`, `SCRIPT_CLICK_MUSIC`, `clickMusicThen`, the
per-section navigation loop, and the find/scrape-playlists retry loops.

**`ensureTracks(pl) -> Promise<tracks>`** — if `tracksFetchedAt` is < 24h old
and tracks exist, resolve immediately from memory/disk. Otherwise
`withSpotifyWindow` → `scriptNavigatePlaylist(id)` → `scriptScrollThenScrape`
(kept as-is — the proven part) → cache to disk with a fresh `tracksFetchedAt` →
resolve. The keep-old-tracks-on-empty guard moves here (single-playlist scope).

### New script: `SCRIPT_SCRAPE_SHELVES`

Walks `<main>` and iterates shelf containers (`<section>` / heading + card-row).
For each shelf:

1. Read the heading text (the section name).
2. Collect `a[href*="/playlist/"]` cards within the shelf, extracting playlist
   id (from href), name (text content), and cover (reusing the existing
   `IMG_HELPER` / `findImgContainer` walk).
3. Dedupe playlist ids across shelves — **first shelf wins** as the playlist's
   section.

To handle lazy-rendered shelves, the script first scrolls the page vertically to
the bottom (same pattern as the track scraper) so all shelves materialize before
collecting.

### On-demand UX

- **View** → opens the detail view instantly with header/cover, shows a
  "Loading tracks…" state, calls `ensureTracks`, then renders the tracklist.
- **Play / Enqueue** (card menu or detail header) → async: show a transient
  "Fetching tracks…" notification, `ensureTracks`, then
  `playTracks` / `insertTracks`. First play of an uncached playlist is slow;
  cached plays are instant.
- **Refresh tracks** menu item forces a re-scrape before the 24h expiry.

## What gets removed

- **Section discovery:** `scriptFindSection`, `SCRIPT_CLICK_MUSIC`,
  `clickMusicThen`, the find/scrape-playlists retry loops.
- **User-configured sections:** the `+` tab, `add-section-tab`,
  `remove-section-tab`, the add branch of `switch-tab`, `section-tab-input*`,
  `section-input*`, `add-section`, `remove-section`. The
  `spotify_browse_sections` storage key is no longer authoritative (sections are
  derived; it may be retained only as a cold-start render cache).
- **Liked Songs entirely:** `LIKED_SECTION`, `LIKED_PLAYLIST_ID`,
  `makeLikedPlaylist`, `ensureLikedCover`, `LIKED_COVER_SVG`, `isLikedSection`,
  `getLikedPlaylist`, `refresh-liked`, the pinned card, and all
  `LIKED_PLAYLIST_ID` branches throughout.
- **Eager track phase:** `scrapeAllTracks` and its multi-playlist keep-old
  retry orchestration (logic moves into `ensureTracks`).

## What stays

- **Login flow** (check / banner / grace-poll) — preserved, wrapped in
  `withSpotifyWindow`.
- **`scriptScrollThenScrape`** — unchanged; the proven track scraper.
- **On-disk layout** `playlists/{section}/{id}/{meta.json,tracks.json,cover.jpg,track-*.jpg}`
  — plus a new `tracksFetchedAt` (ISO) field in `meta.json`.
- **Image caching** (covers + track images), orphan pruning.
- **Home-shelf registration** — sections derived from the scrape.
- **Diagnostics / run reports**, per-run logs, page-debug dumps.
- **Step-by-step debugger** — adapted: the "find section" step becomes a
  "scrape shelves" step; the rest (login, tracks) is unchanged.
- **Auto-refresh** — kept; `silentRefresh` calls `syncPlaylists()` only (list
  refresh, no track scraping). Cached tracks expire on their own 24h timer.

## Migration

- Existing on-disk playlists keep rendering on load (cold start unchanged).
- The first new-style sync re-groups playlists under scraped shelf names. Old
  user-defined section directories that no longer match any shelf are cleaned up
  the same way dropped playlists are today.
- Liked Songs data on disk (the `Liked Songs` section dir + synthetic playlist)
  is removed on upgrade.
- `meta.json` gains `tracksFetchedAt`; absent on legacy entries → treated as
  expired (re-scraped on first demand).

## Known limitations / risks (accepted for v1)

1. **Lazy shelf rendering.** Horizontal shelves may only render the first ~10
   cards without a "Show all" click. v1 captures what's rendered after a
   vertical page scroll; per-shelf expansion is a future enhancement.
2. **Play latency.** First Play/View of an uncached (or expired) playlist pays
   the full scroll-scrape time — seconds for normal playlists, longer for very
   large ones. Mitigated by 24h caching + loading states, not eliminated.

## Out of scope

- Albums and artists (playlists only).
- A persistent warm browse window (open/close per action).
- Per-shelf "Show all" expansion.
