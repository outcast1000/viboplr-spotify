# Spotify Browse Plugin

## Purpose

Scrapes playlists from the Spotify web app (`open.spotify.com`) via an embedded
browser window. Spotify does not provide a public API for personalized sections
like "Made for You", so the plugin navigates the DOM directly.

The plugin loads the **Music home page** (`open.spotify.com/home?facet=music-chip`)
in a single pass and scrapes every playlist card across all shelves, grouping
them by shelf heading. The sync itself does **not** scrape track listings — a
playlist's tracks are scraped lazily the first time the user views, plays, or
enqueues it, and cached on disk for 24 hours. As an optimization, after each
refresh the plugin **prefetches the tracks of the last few playlists the user
actually loaded** (see *Refresh Prefetch* below) so those stay warm. Users can
save playlists to the app's saved-playlists store and play/enqueue scraped
tracks through Viboplr's fallback resolution.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Spotify Plugin (index.js)                      │
│                                                 │
│  State ─── Render ─── Actions ─── Scraper       │
│    │          │          │            │          │
│    │     setViewData     │     openBrowseWindow  │
│    │          │          │         eval()        │
│    │          ▼          │            │          │
│    │   PluginViewRenderer│     ┌──────▼───────┐  │
│    │   (toolbar, tabs,   │     │ Spotify Web  │  │
│    │    card-grid, etc.) │     │ (headless or │  │
│    │          │          │     │  visible)    │  │
│    ▼          │          ▼     └──────────────┘  │
│  plugin_storage     api.playlists                │
│  (preferences,      (Save to Playlists)          │
│   sections)                                      │
└─────────────────────────────────────────────────┘
```

### Key Components

- **State** — single `state` object holding all UI and data state; persisted across sessions via `api.storage`
- **Scraper** — opens the Music home page in a browse window, injects JS scripts
  to check login, scrape all shelves (`SCRIPT_SCRAPE_SHELVES`), and lazily scroll
  + scrape one playlist's tracks on demand (`scriptScrollThenScrape`). The shared
  `withSpotifyWindow(opts, fn)` helper centralizes the open + login-poll + banner
  flow for both the list sync (`syncPlaylists`) and the lazy track fetch (`ensureTracks`).
- **Renderer** — builds plugin view data (toolbar, stacked shelf sections, card
  grids, track row lists) and calls `api.ui.setViewData`

## UI Structure

### Toolbar (hoisted, always visible)
- **Title:** "Spotify"
- **Buttons:** "Sync" (idle/done) or "Cancel" (during scrape), plus a "Browser: ON/OFF" toggle
- **Status text:** Live scrape progress during activity, last check time + results when idle, error messages on failure

### Stacked Shelves (the main view)
- The view mirrors the Spotify Music home page: one **section per shelf**, stacked
  vertically, each as a heading (the shelf name) + an optional gray description
  line + a playlist **card grid**. There are no tabs and no user-configured sections.
- Sections (their names, order, and descriptions) are **derived from the scrape**,
  not configured. Empty sections are skipped.
- Cards show the scraped Spotify subtitle (e.g. "With X, Y…") until tracks are
  fetched, then switch to the track count + last-synced stamp.
- Card context menu: Play, Enqueue, View/Edit, Refresh tracks, Save to Playlists.
- Empty state ("No playlists yet… click Sync") when nothing has been scraped.

### Playlist Detail View
- Back button, Save to Playlists button
- Playlist name, track count, cover image
- Opening the view **auto-fetches tracks lazily** if not cached/fresh, showing a
  "Loading tracks…" placeholder until the scrape completes.
- Track row list

### Settings Panel (`spotify-settings`)
- Auto-refresh interval select (Off / 6h / 12h / 24h / 2 days / weekly)
- Show browser window during refresh toggle
- Debug logging toggle (writes a per-run `logs/YYYYMMDD-HHMMSS.log`)
- Step-by-step debugger: Check Login → Scrape Shelves → Scrape Tracks

## Scraping Flow

### Phase 0: First activation (one-shot)
On the very first activation of a fresh install (no on-disk playlists, no
legacy KV state, never synced), the plugin starts the initial sync
automatically instead of waiting for a manual Sync click, and shows a
notification explaining what's happening. The normal login-check flow
(Phase 1) then asks the user to sign in in the embedded browser window if
they aren't logged in; with an existing session the sync completes headlessly.
This is guarded by the `spotify_browse_first_run_done` storage key so it runs
at most once — established installs (existing library or a prior
`lastCheckAt`) just set the flag silently and never see an unexpected popup.
A failed initial-state load is treated as "has data" so a transient disk
error can't trigger the popup for an established user.

Because a fresh user isn't watching the plugin view (where sync status
renders) and the one-shot flag means there is no re-prompt, the first-run
sync closes the loop with notifications: a success toast summarizing what was
synced and where to find it, and a guidance toast ("open the Spotify view and
click Sync") when sign-in wasn't completed (window closed) or the sync
failed. Manual syncs show none of these — their status lives in the toolbar.

### Phase 1: Login Check
1. Open `open.spotify.com` in browse window (visible or headless)
2. Poll every 3s by injecting `SCRIPT_CHECK_LOGIN`
3. Script checks for positive signals (`user-widget-link`, library button, avatar) and negative signals (`login-button`, `signup-button`)
4. If `positive && !negative` → logged in, proceed
5. If still not logged in after a short grace period (~2 polls), the window is surfaced (`handle.show()`), a sign-in banner is injected (`SCRIPT_LOGIN_BANNER`), and a notification is shown. Polling then continues **indefinitely** — when the user logs in, the banner is removed (`SCRIPT_REMOVE_LOGIN_BANNER`), a headless window is re-hidden, and scraping proceeds; if the user closes the window first, the scrape aborts. This applies to both user-initiated Sync and silent auto-refresh.

### Phase 2: Single-page shelf scrape (`syncPlaylists`)
1. Navigate to `open.spotify.com/home?facet=music-chip` (the window opened there
   already; the URL is re-asserted in case login redirected away).
2. Wait ~4s for the SPA to render, then inject `SCRIPT_SCRAPE_SHELVES`.
3. The script scrolls the page to the bottom to materialize lazy shelves, then
   walks each `<section>` container: reads the heading (the section name) and a
   gray description line, and collects `a[href*="/playlist/"]` cards within it —
   capturing each card's playlist id, name, subtitle, and cover image.
4. Playlists are deduplicated by id across shelves (**first shelf wins** as the
   section). Station/album/artist cards are ignored (playlists only).
5. The result `{ playlists, sections, sectionDescriptions }` is merged into state
   by `applySyncResult`, which derives the section list/order from the scrape and
   carries over cached tracks for surviving playlists. **No track listings are
   scraped during sync.** A scrape that returns zero playlists while a library
   already exists is rejected (it does not wipe the library).
6. A 60s backstop timeout resolves the scrape empty if the page never responds.

### On-demand track fetch (`ensureTracks`)
A playlist's tracks are scraped only when the user **views, plays, or enqueues**
it (or clicks "Refresh tracks"):
1. If cached tracks are fresh (within the 24h TTL) they are returned immediately.
2. Otherwise open a browse window, navigate to `/playlist/{id}`, wait 4s, inject
   `scriptScrollThenScrape(playlistId, gen)`.
3. Auto-scroll to load all tracks; scope to `[data-testid="playlist-tracklist"]`
   or `<main>` to avoid the sidebar; parse each `[role="row"]` for track name,
   artist(s), album, duration, image.
4. 45s timeout with up to 2 attempts (reload + re-scrape). On empty/error, old
   cached tracks are kept (transient-parse guard) **without** refreshing the TTL
   stamp, so the next view retries soon.
5. A non-empty scrape stamps `tracksFetchedAt`, persists to disk, and caches images.

### Start Spotify radio (`startSpotifyRadio`)

A **universal track context-menu item** ("Start Spotify radio", registered via
`api.contextMenu.registerItem` on the `track` target) starts a Spotify radio
seeded from any track in the app. The app-side `PluginContextMenuTarget` carries
only `title` + `artistName` (no Spotify id), so the flow searches for the seed
first. The scrape (`scrapeRadioTracks`) runs inside `withSpotifyWindow` (so it
inherits the login flow, the single-window gate, and the generation guard) as a
small state machine driven by the message bridge:

1. **search → seed** — open at `searchTracksUrl(title + " " + artist)`
   (`/search/{q}/tracks`), inject `scriptSearchTopTrack`, take the first track
   row's Spotify id (`radio-seed`).
2. **go-radio** — navigate to `/track/{id}`, inject `scriptGoToRadio` which
   clicks the `…` more menu's "Go to song radio" item (`radio-go`). That click
   navigates to the radio tracklist page.
3. **scrape** — after the page settles, reuse `scriptScrollThenScrape` (keyed by
   the synthetic id `radio-station`) to scrape the radio tracklist.

`scrapeRadioTracks` resolves `{ tracks, seedId }` — `seedId` being the Spotify id
Spotify itself matched in step 1.

**The seed plays before the scrape finishes.** A song radio always opens with its
seed, and the seed here is the track the user right-clicked — known before any
scraping starts. So on hosts that expose it, the flow calls
`api.playback.playWithBackfill({ head: [seed], context, resolveTail })`: the seed
starts immediately (metadata-only — the host's stream-resolver chain resolves it
on play, as it would have for track 1 anyway) under the
`{ name: "Spotify radio · {title}", source: "radio" }` banner, and the scraped
station is appended when it lands, 15–25s later. No loading modal. The host owns
the staleness guard, so a station that resolves after the user has played
something else is discarded instead of spliced into their queue. `stripSeedRow`
drops the station's opening row when its Spotify id equals `seedId`, so the seed
can't play twice even when the scraped title reads differently from the app-side
one. Failure messaging lives in the plugin (it can distinguish
`withSpotifyWindow` busy-reject from "page changed"), so no `tailErrorMessage` is
passed — otherwise the user would get two toasts.

Hosts without `playWithBackfill` keep the original behaviour: the whole flow runs
behind the loading modal, then the scraped tracks (seed row included) replace the
queue via `api.playback.playTracks(tracks, 0, context)`. Every failure path (seed
not found, radio menu item missing, empty tracklist, busy-reject) shows a
notification; on the legacy path the queue is left untouched, on the backfill path
the seed keeps playing. Each step has its own timeout and the generation guard
aborts stale work exactly like `ensureTracks`.

Because the search-results DOM and the "Go to song radio" menu item are the two
selector-fragile bits, `npm run verify:radio [seed query]` drives this exact flow
against the live Spotify DOM (headed, reusing the `verify:scrape` login profile)
and prints where it fails — including the menu-item labels it saw when the radio
item isn't found. Run it with `VERIFY_DEBUG=1` to surface the injected scripts'
`_dbg` stream.

### Refresh Prefetch (warm recently-loaded playlists)

Because the sync only refreshes the playlist *list*, the first View/Play/Enqueue
of any playlist after its 24h track cache expires pays the full scroll-scrape
latency. To hide that for the playlists a user actually uses, the plugin keeps a
small **most-recently-loaded** list and warms it on refresh:

1. Every user-initiated load of a playlist — View (`openPlaylistById`),
   Play/Enqueue (`fetchTracksWithLoading`), a Home-shelf play
   (`onResolvePlay`), or a force "Refresh tracks" (`refresh-tracks-ctx`) — calls
   `noteRecentlyLoaded(pl)`, which moves the id to the front of an MRU
   (deduped, capped at `RECENT_MAX = 10`, persisted to
   `spotify_browse_recently_loaded`).
2. After a refresh completes (both the manual `startSync` and the silent
   auto-refresh `silentRefresh`), `prefetchRecentlyLoaded()` warms the top
   `PREFETCH_COUNT = 5` still-existing playlists **sequentially** (the
   single-window constraint forbids parallel scrapes). Playlists whose cached
   tracks are still fresh are skipped without opening a window, so it's a no-op
   when nothing has expired.
3. It is **best-effort and headless**: per-playlist failures are logged and
   skipped, and the whole chain is superseded/cancelled via a `prefetchToken`.
4. **Yields the window to the user:** every user-initiated load (and the Cancel
   button / deactivate) calls `cancelPrefetch()`, which stops the loop from
   enqueuing further scrapes. The one scrape already in flight is left to settle
   and cache normally, so a user click is at worst stuck behind a single
   in-flight scrape, never the whole queue.

### Generation Guard & single-window serialization
- `scrapeGeneration` increments on each new browse-window open (`withSpotifyWindow`)
  and on cancel. All async callbacks check `ctx.isStale()` (`gen !== scrapeGeneration`)
  to abort stale operations.
- Only **one** browse window may be open at a time: `withSpotifyWindow` sets a
  `windowBusy` flag synchronously and **rejects** a concurrent open (e.g. a lazy
  track fetch overlapping an auto-refresh) rather than stranding the in-flight
  window. The flag is released when the window settles or on `cancel`. Lazy
  Play/View/Enqueue surface a "Spotify is busy" notification if rejected.

## Data Model

### Plugin Storage Keys

| Key | Shape | Purpose |
|-----|-------|---------|
| `spotify_browse_sections` | `string[]` | Last-scraped section names + order (cold-start render cache; derived from the scrape, not user-configured) |
| `spotify_browse_section_descriptions` | `{ [section]: string }` | Last-scraped shelf description lines (cold-start render cache) |
| `spotify_browse_preferences` | `{ showBrowserOnRefresh, autoRefreshHours, debugLogging, lastCheckAt, lastCheckResult }` | User preferences + last check info |
| `spotify_browse_first_run_done` | `boolean` | One-shot guard for the first-activation auto-sync / sign-in prompt |
| `spotify_browse_recently_loaded` | `string[]` | MRU of playlist ids the user loaded (most-recent first, capped at `RECENT_MAX`). Drives the refresh prefetch. |

The authoritative playlist/track store is the on-disk layout
`playlists/{section}/{id}/{meta.json,tracks.json,cover.jpg,track-*.jpg}`.

### Debug Log Files (written only when "Debug logging" is on)

| File | Contents | Trim |
|------|----------|------|
| `logs/YYYYMMDD-HHMMSS.log` | One human-readable report per sync run (trigger, timing, per-section/playlist status, trace) | last 20 runs |

### Playlist Object (scraped / on disk)
```
{ id, name, description, cardSubtitle, imageUrl, uri, section, lastSyncedAt, tracksFetchedAt }
```
`cardSubtitle` is the scraped shelf-card subtitle (shown until tracks load).
`tracksFetchedAt` is the ISO timestamp of the last successful non-empty track
scrape; it drives the 24h lazy-cache TTL (`tracksAreFresh`).

### Track Object (scraped)
```
{ name, artist, album, duration, imageUrl }
```

## Track Retention

Tracks are fetched lazily and cached for 24h (`TRACKS_TTL_MS`). If a fresh track
scrape returns zero tracks while the playlist previously had tracks, the old
tracks are kept (transient-parse guard) and the TTL stamp is deliberately **not**
refreshed, so the next view/play retries soon. `tracksAreFresh` treats a playlist
with no cached tracks as stale regardless of timestamp, so a genuinely-empty or
failed scrape is always retried on next demand.

Each playlist records `lastSyncedAt` (ISO timestamp): set at list-scrape time and
refreshed on a successful non-empty track scrape. Shown as "synced <date>, <time>"
on cards and the detail header. A failed track scrape is retried up to twice
(reload + re-scrape) before giving up.

## Image Caching

- Playlist covers: cached as `{pluginCacheDir}/spotify-browse/{playlistId}/cover.jpg`
- Track images: cached as `{pluginCacheDir}/spotify-browse/{playlistId}/{djb2hash}.jpg`
- Orphaned cache directories (playlists no longer in state) are cleaned up on startup
- Images are cached after each scrape via `plugin_cache_image` command

## Auto-Refresh

- Configurable interval: 0 (off), 6, 12, 24, 48, or 168 hours
- Uses `api.scheduler.register("auto-refresh", intervalMs)`
- Silent refresh runs headless and refreshes the **playlist list only**
  (`syncPlaylists`) — it does **not** scrape tracks for the whole library.
  Cached tracks expire on their own 24h timer.
- After the list refresh, `prefetchRecentlyLoaded()` warms the tracks of the
  last `PREFETCH_COUNT` playlists the user loaded (see *Refresh Prefetch*), so
  frequently-used playlists are ready without paying scrape latency on the next
  open. This runs after both auto-refresh and a manual Sync.
- Badge shows error dot on failure

## Actions Reference

### Toolbar Actions
| Action | Trigger | Behavior |
|--------|---------|----------|
| `sync` | Sync button | Single-page shelf scrape (headless unless Browser toggle is ON) |
| `cancel` | Cancel button | Increment generation, close browser |
| `toggle-show-browser-pref` | Browser ON/OFF toggle | Toggle visible-browser preference |

### Playlist Actions
| Action | Context | Behavior |
|--------|---------|----------|
| `play-playlist` | Card context menu | Lazily fetch tracks (`ensureTracks`), then play |
| `enqueue-playlist` | Card context menu | Lazily fetch tracks, then enqueue |
| `view-playlist` | Card click/menu | Show detail view; auto-fetch tracks if stale |
| `refresh-tracks-ctx` | Card context menu | Force re-scrape this playlist's tracks (`ensureTracks(pl, {force:true})`) |
| `save-playlist` | Detail view button | Save to app playlists via `api.playlists.save` |
| `save-playlist-ctx` | Card context menu | Save to app playlists |

### Track Actions (universal context menu)
| Action | Context | Behavior |
|--------|---------|----------|
| `start-spotify-radio` | Any track’s right-click menu (library / queue / playlist / plugin / search) | `startSpotifyRadio(title, artist)` — plays the seed immediately, then search → go-to-radio → scrape → append the station (legacy hosts: scrape first, then replace the queue; see *Start Spotify radio*) |

## Injected Scripts

| Script | Purpose | Key Selector |
|--------|---------|-------------|
| `SCRIPT_CHECK_LOGIN` | Detect login state | `[data-testid="user-widget-link"]`, `[data-testid="login-button"]` |
| `SCRIPT_SCRAPE_SHELVES` | Scrape all shelves on the music-chip home (heading, description, cards) | document-order sweep over `h1,h2,h3,[role="heading"]` + `a[href*="/playlist/"]` |
| `scriptNavigatePlaylist(id)` | Navigate to playlist page | Direct URL assignment |
| `scriptScrollThenScrape(id, gen)` | Scroll + parse tracks (also reused for the radio tracklist) | `[role="row"]` inside `[data-testid="playlist-tracklist"]` |
| `scriptNavigateSearch(query)` | Navigate to the `/search/{q}/tracks` page (radio seed) | direct URL assignment |
| `scriptSearchTopTrack(gen)` | Pick the top track result → `radio-seed {trackId,name,artist}` | first `a[href*="/track/"]` in `main` |
| `scriptNavigateTrackPage(id)` | Navigate to `/track/{id}` (radio seed) | direct URL assignment |
| `scriptGoToRadio(gen)` | Open the `…` menu, click "Go to song radio" → `radio-go` | `button[data-testid="more-button"]` + `[role="menuitem"]` matching `/radio/i` |
| `SCRIPT_LOGIN_BANNER` | Inject "please sign in" banner when not logged in | fixed-position `<div>` prepended to `<html>` |
| `SCRIPT_REMOVE_LOGIN_BANNER` | Remove the sign-in banner once logged in | by element id |

## Known Limitations

- Spotify OAuth is non-functional; the plugin relies on the user being logged in via the browser session
- DOM selectors may break when Spotify updates their web app
- Headless scraping requires an existing login session (cookies persisted by the browse window)
- Track matching for playback uses title+artist fuzzy matching via fallback resolution, not Spotify track IDs
- **Lazy shelf rendering:** each shelf is a single horizontal row (~10 cards) with
  a "Show all" link; the rest aren't in the DOM until expanded. v1 captures the
  cards rendered after a vertical page scroll — per-shelf "Show all" expansion is
  a future enhancement.
- **First-play latency:** the first View/Play/Enqueue of an uncached (or
  24h-expired) playlist pays the full scroll-scrape time (seconds), mitigated by
  caching + loading states + the refresh prefetch of recently-loaded playlists,
  but not eliminated (a playlist the user hasn't loaded recently, or one loaded
  beyond `PREFETCH_COUNT`, still scrapes on first demand).
- **Empty-scrape guard:** a sync that returns zero playlists while a library
  already exists is rejected to avoid wiping it on a timeout/parse error. The
  tradeoff is that a genuinely-emptied Spotify account keeps showing the old
  library until a non-empty scrape succeeds.
- **Start Spotify radio** was verified against live Spotify via
  `npm run verify:radio` (search seed → "Go to song radio" → 50-track scrape).
  Spotify's song radio resolves to a real `/playlist/{id}` page, so the reused
  `scriptScrollThenScrape` parser handles it as a normal tracklist. That page has
  **no cover image** (og:image absent, `playlist-image` has no usable src), so the
  radio queue banner shows the title only — per-row track art still resolves. Re-run
  `verify:radio` if `scriptSearchTopTrack` / `scriptGoToRadio` ever stop finding a
  seed or the radio menu item (Spotify DOM drift).
