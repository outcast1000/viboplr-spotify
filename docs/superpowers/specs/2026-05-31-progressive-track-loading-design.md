# Progressive Track Loading — Design

**Date:** 2026-05-31
**Status:** Approved (design); implementation pending
**Plugin:** `spotify-browse` (viboplr-spotify)
**Builds on:** `2026-05-31-lazy-single-page-scrape-design.md`

## Summary

When a user opens a playlist whose tracks are not cached/fresh, the detail view
currently shows a static "Loading tracks…" text node until the entire scrape
finishes (seconds, longer for big playlists). This change makes the wait
informative:

1. **Before any tracks are parsed**, show the host's spinner with a "Fetching
   tracks…" message.
2. **While scraping**, render track rows progressively as they are parsed, with
   a spinner + live count footer ("Loading more… N tracks").
3. **When done (or already cached)**, show the full list with no loading
   indicator — exactly as today.

This reuses the host-provided `type: "loading"` view node (a shared spinner
primitive) rather than any hand-rolled animation, and requires no host changes.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Animation primitive | Host `type: "loading"` view node (`{ type, message? }`) — renders `.plugin-loading` spinner + message |
| Track images during load | Text-only rows while loading; images appear after the scrape finishes and `cacheAllImages` localizes them |
| Re-render cadence | Every scroll tick (~600ms); throttle is a trivial follow-up if janky on huge playlists |
| Cached/fresh playlists | Unchanged — instant full render, no loading indicator |
| Before-first-rows state | Whole detail body = `type: "loading"` (header still rendered above it) |
| While-scraping footer | `type: "loading"` with `message: "Loading more… N tracks"` (not `progress-bar` — total is unknown mid-scrape) |

## Host primitives used (verified in `outcast1000/viboplr`)

- `{ type: "loading", message?: string }` → `PluginLoading` renders
  `<div class="plugin-loading"><div class="plugin-loading-spinner"/>{message}</div>`
  (`src/components/pluginViews/pluginViews.tsx`, declared in `src/types/plugin.ts`).
  Skin-aware, host-owned. This is the recommended primitive.
- (Noted, not used here) `{ type: "progress-bar", value, max, label? }` exists for
  determinate progress; rejected because the playlist's total track count is
  unknown until the scrape ends, so any `max` would be a misleading guess.

Aligns with the host convention "operations that take >500ms must show feedback;
use progress indicators for multi-step operations" (`.claude/rules/conventions.md`).

## Architecture

Three small, contained changes in `index.js`. No new storage, no schema change,
no architectural shift.

### 1. Scraper emits partial tracks (`scriptScrollThenScrape`)

The scraper already accumulates parsed rows in `allOut` and emits a
`tracks-progress` message every scroll tick carrying only `{ playlistId, found,
gen }`. Extend that message to also carry the partial array:

```
window.__viboplr.send("tracks-progress", { playlistId, found: allOut.length, tracks: allOut, gen })
```

The final `tracks` message (sent at bottom/timeout) is unchanged. This is the
only scraper change.

### 2. `ensureTracks` consumes progress (in-memory only)

`ensureTracks`'s message handler currently only handles the terminal `tracks`
message. Add a `tracks-progress` branch:

- Ignore if `msg.data.gen !== gen` (stale) or `msg.data.playlistId !== pl.id`.
- Write `msg.data.tracks` into `state.playlistTracks[pl.id]` (in memory only).
- Call `renderPlaylist()` so the rows show.

Critically, the progress branch does **NOT** call `savePlaylist`, does **NOT**
stamp `tracksFetchedAt`, and does **NOT** touch `pl.imageUrl`/`description`.
Persistence, the TTL stamp, image caching, and the keep-old-on-empty guard all
remain on the terminal `settle()` path exactly as today. Consequences:

- Partial data is never written to disk and never treated as fresh
  (`tracksAreFresh` requires `tracksFetchedAt`), so an interrupted load (cancel,
  navigate away, window closed) cannot leave a half-scraped playlist cached.
- The keep-old guard is unaffected: `oldTracks` is snapshotted at `ensureTracks`
  entry, before any progressive write.

### 3. `renderPlaylist` shows three states

`renderPlaylist` already renders `state.playlistTracks[pl.id]` as a
`track-row-list`. Replace the current tail logic (the `else if (loadingTracksFor)`
→ "Loading tracks…" text and the `else` → "No tracks scraped" text) with:

- **tracks.length > 0:** render the `track-row-list` as today. Additionally, if
  `state.loadingTracksFor === pl.id`, append a footer node
  `{ type: "loading", message: "Loading more… " + tracks.length + " tracks" }`.
- **tracks.length === 0 and `loadingTracksFor === pl.id`:** render
  `{ type: "loading", message: "Fetching tracks…" }` (replaces the old
  "Loading tracks…" text node).
- **tracks.length === 0 and not loading:** render the existing "No tracks
  scraped" text node, unchanged.

The `detail-header` (cover + title + actions) is always rendered first, so the
playlist identity is visible immediately in every state. The existing
search-input (shown when tracks > 50) and search-filtering logic are untouched.

### Images during load

Track rows render text-only while loading: each track's `imageUrl` is still a
remote Spotify CDN URL at scrape time and is only downloaded to a local
`track-*.jpg` by `cacheAllImages` after `settle()`. `track-row-list` items pass
`imageUrl: t.imageUrl || undefined`; mid-load this is a remote URL the host
WebView may not load, so rows will simply show without art until the final
render. This is intentional and avoids broken-image flicker.

## Data flow

```
openPlaylistById(pl)  [not fresh]
  → state.loadingTracksFor = pl.id; renderPlaylist()   // state 2: "Fetching tracks…"
  → ensureTracks(pl)
       → scrape ticks: "tracks-progress" {tracks, found, gen}
            → state.playlistTracks[pl.id] = partial; renderPlaylist()  // state 1: rows + "Loading more… N"
       → terminal "tracks" {tracks, ...}
            → settle(): final tracks, stamp tracksFetchedAt, savePlaylist, cacheAllImages
            → loadingTracksFor = null; renderPlaylist(); render()       // state 3: full list + images
```

Cached/fresh path: `tracksAreFresh(pl)` short-circuits in `openPlaylistById`;
`loadingTracksFor` stays null; full list renders instantly. No change.

## Error / edge handling (all via existing paths)

- **Scrape error / empty:** terminal `tracks` message → `retryOrFinish` →
  eventually `settle(oldTracks)`; keep-old guard restores prior tracks; footer
  clears when `loadingTracksFor` is reset.
- **Cancel / navigate home / new window:** `gen` bumps → progress branch ignores
  stale messages; `go-home` already clears `loadingTracksFor`.
- **Window closed before login:** `withSpotifyWindow` resolves; `settle` path
  clears loading state.
- Any new `.catch` uses `console.error` per host conventions.

## Out of scope

- Showing remote track images during load (decided: text-only until done).
- A determinate progress bar (total count unknown mid-scrape).
- Throttling the per-tick re-render (only if it proves janky on huge playlists —
  trivial timestamp-guard follow-up).
- Progress UI anywhere other than the playlist detail view.

## Known tradeoff

Re-rendering the full (growing) `track-row-list` via `setViewData` on every
scroll tick may feel sluggish near the end of very large playlists (e.g. a
multi-thousand-track playlist). Accepted per the cadence decision; mitigated by a
one-line throttle if observed in-host.
