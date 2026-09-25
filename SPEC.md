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

### Search box (hoisted under the toolbar, home + results views)
- A submit-only `search-input` ("Search Spotify for songs…", `spotify-search`).
  It is the view's **first top-level search-input**, which is what the host
  fills in and submits when the Cmd+K no-match state opens this view with a
  query — so that entry point searches with no extra wiring.
- Submitting switches to the **Search Results view** (see *Song search* below),
  laid out like the yt-dlp plugin's search tab: the same toolbar (plus a Home
  button) + box, and the results directly underneath as a **selectable
  `track-row-list`** with list actions **Play / Queue / Radio** (Radio seeds a
  Spotify song radio from the first selected row). The list's own All / None
  toolbar covers "play everything", so there is no separate header. A plain row
  click plays that one song; rows carry `path` / `artistName` / `durationSecs`
  so the host's native right-click menu, artwork lookup and drag-to-queue work
  without a DB id. Loading is the host `loading` node; "No results.", errors and
  the idle hint are `ds-empty` text. While a search runs the button reads
  **Cancel** and submitting aborts it (generation bump + window close, like the
  toolbar's Cancel). An empty query returns to the home view.

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
- Include albums in sync toggle
- **Liked Songs** section: "Import Liked Songs" (see *Liked Songs import* below);
  shown only when the host exposes the batch like APIs
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
3. Script checks for positive signals (`[data-testid="user-widget-link"]` — its
   `aria-label` is the username — `[aria-label="Your Library"]`,
   `[data-testid="now-playing-bar"]`, the global nav) and negative signals
   (`login-button`, `signup-button`). Verified against the live DOM 2026-09-21;
   the old `.main-userWidget-box` / avatar-image signals are gone, and
   `a[href*="/account"]` was dropped because some regions render a consumer-law
   footer link to `spotify.com/account/cancel/` whether or not you are signed in.
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
   artist(s), album, duration (the last grid cell's `m:ss`), image. The grid's
   `aria-rowcount` (rows + 1 header) is the list length: the scroll stops as
   soon as that many rows are parsed and every `tracks-progress` / `tracks`
   message carries it as `total` (null when the attribute is missing, in which
   case the loop runs to the bottom as before). Cover: og:image, else
   `[data-testid="playlist-image"] img`, else the largest hero `<img>` outside
   the tracklist. Description: the first free-standing text between
   `[data-testid="entityTitle"]` and the `[data-testid="creator-link"]` line —
   there is no description testid. All verified live 2026-09-21.
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

1. **search → seed** — the window is opened at
   `searchTracksUrl(title + " " + artist)` (`/search/{q}/tracks`), so the page is
   already loading; it is only re-navigated when login bounced it elsewhere
   (`ctx.loginUrl`). `scriptSearchTopTrack` takes the first track row's Spotify
   id (`radio-seed`).
2. **go-radio** — navigate to `/track/{id}`, inject `scriptGoToRadio` which
   clicks the `…` more menu's "Go to song radio" item (`radio-go`). That click
   navigates to the radio tracklist page.
3. **station** — `scriptWaitForStation` waits until the page has actually left
   the seed's track page (`radio-station`). Skipping this would scrape the track
   page's own `[role="row"]` list — the artist's popular tracks — as if it were
   the station.
4. **scrape** — reuse `scriptScrollThenScrape` (keyed by the synthetic id
   `radio-station`) to scrape the radio tracklist.

**Every step polls the page; none of them sleep for a fixed interval.** Spotify's
SPA renders when it renders, and a fixed settle time reports "no track results"
for a page that was merely slow (this is how v1.16.0 broke on a slow
connection). Each script `_poll`s for what it needs (~25s budget) and each is
guarded by `runOnce` + a page check, so the host can re-fire it every 3s ("pump")
until it lands on a document that survives — a script eval'd while a navigation
is committing dies with the old document and would otherwise never answer. Step
timeouts are the real cap: 45s seed, 45s go-radio, 30s station, 60s scrape.

`scrapeRadioTracks` resolves `{ tracks, seedId }` — `seedId` being the Spotify id
Spotify itself matched in step 1.

**The menu click is the only way to the station page — do not "optimise" it into
a navigation.** Spotify's client-side router knows `/station/track/{id}`, but a
fresh load of that URL (logged in) redirects to `/track/{id}?autoplay_ok=1` and
starts the radio *in the player* without ever rendering a tracklist. Only the
"Go to song radio" click renders the station, and it lands on a real
`/playlist/{id}` page (which is why the shared row parser works on it).

**Radio starts playback by design.** "Go to song radio" is a play action, so the
station page is entitled to make sound; the plugin's eval'd autoplay gate cannot
stop it (nor DRM/worker playback paths). Silence comes from the host, which mutes
browse windows at the engine level from v1.0.66 (`_setPageMuted:` on WKWebView,
`IsMuted` on WebView2). On an older host the radio flow is audible for a few
seconds in a hidden window; there is nothing the plugin can do about that.

**Never navigate the window to a non-`http(s)` URL.** Spotify's page will hand
off to the desktop app (`spotify:…`) given the chance, and a WKWebView that is
allowed to navigate to an unsupported scheme passes it to LaunchServices — which
is how a hidden scrape launched the Spotify app. The host blocks this centrally
(`browse_window.rs::is_navigable`, in Viboplr builds after 1.0.14); the plugin's
own navigations stay on `open.spotify.com`.

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

### Song search (`scrapeSearchTracks`)

Spotify's `/search/{q}/tracks` page is a plain tracklist — the same
`[role="row"]` markup the playlist pages use, which the radio flow already
parses to pick its seed — so the rows are read by the shared
`scriptScrollThenScrape`. The one search-specific script is a **readiness
gate**, and it exists because of a measured failure: the search page paints a
few placeholder `[role="row"]`s long before any result lands, and the row
parser's own "content ready" check accepts any row — so injected directly it
scraped an empty list (3 rows, 0 track links, empty `<main>`). Same shape as
the radio flow, and for the same reason: poll for the thing you need, never
sleep a fixed interval.

1. `withSpotifyWindow({ url: searchTracksUrl(q) })` opens the window at the
   search URL (login flow, single-window gate, generation guard as everywhere).
   If the login check reports the page is NOT on `/search/` (login bounced it),
   `scriptNavigateSearch(q)` re-navigates first.
2. **ready** — pump `scriptWaitForSearchResults(gen)` every 3s (`runOnce` +
   `_poll`, ~25s budget) until it posts `search-ready` — `{ok}` once a
   `[role="row"] a[href*="/track/"]` exists in `<main>`, or `{error, loggedOut}`
   when the budget runs out. 45s step timeout.
3. **scrape** — inject `scriptScrollThenScrape("search-results", gen,
   { maxSteps: 3 })`; 30s timeout. Rows are capped at `SEARCH_MAX_RESULTS` (50)
   and their thumbnails upgraded to 640px, like radio rows. Any timeout resolves
   `[]` — a miss, never a reject.
4. Non-empty results are kept in an in-memory cache for 10 minutes keyed by the
   normalized query, so the view box and the Cmd+K provider don't each open a
   window for the same text.

Two consumers share it:

- **The view box** (`runSearch`): shows the results view in its loading state,
  scrapes, renders. A search started while another is in flight supersedes it
  (the result is dropped if `state.search.query` moved on). A busy reject from
  `withSpotifyWindow` renders as an error line, not a silent miss.
- **The Cmd+K provider** (`contributes.searchProviders` `spotify`, handler via
  `api.search.onQuery`): the host only calls it when the user picks the
  "Search … on Spotify" row, so the window it opens is always asked for. Returns
  `ok` (trimmed to the host's `limit`), `empty`, or `error` with the same
  message. Guarded on `api.search` existing; older hosts ignore the manifest
  entry.

Results are metadata-only `PluginTrack`s (`spotify://{id}` path), so playback
rides the host's stream-resolver chain exactly like a playlist row. Verified
against the live DOM by `npm run verify:search`, which also fails when most rows
come back without an artist or a Spotify id (selector drift).

### Catalog lookups — album tracklist, plays, monthly listeners

Three features share one shape: **search → pick an entity → open its page →
read one thing**, driven through a single browse window by `makeStepper`
(eval a page script, re-fire it every 3s until the page answers, per-step
timeout). All page scripts and pickers live in the SCRAPE-SCRIPTS block, so
`npm run verify:all` runs them unchanged against the live site.

- **Page scripts report, host code decides.** `scriptSearchCandidates` posts
  every entity it can identify on a `/search/{q}/{facet}` page (track rows with
  their `/album/` link; album and artist cards via `[data-encore-id="cardTitle"]`)
  and nothing else. The choice is made by pure, unit-tested pickers
  (`pickTrackCandidate` / `pickAlbumCandidate` / `pickArtistCandidate`) over
  `normalizeName` (accents, case, `&`, a leading "the") and `coreTitle`
  (edition noise: `(Remastered)`, ` - 2007 Remaster`). The artist must match —
  lead name of a credit string counts — so a wrong artist's numbers are never
  shown; a miss is `not_found`.
- **Every page script checks its own page.** The first eval after a
  navigation usually lands on the page being left, and an album page has track
  rows of its own. `scriptSearchCandidates` only runs on its facet's search
  URL; the track/artist/page-ready scripts match `location.pathname` exactly
  (`PATH_HELPER`, `/intl-xx` stripped).
- **Spotify's "No songs found for …" page is reported** (`noResults`), because
  after a burst of searches Spotify throttles by answering with nothing. The
  plugin logs it, and the harness says "throttled?" instead of "selectors
  drifted".

**Album tracklist** (`lookupSpotifyAlbum`, menu item **Play the Full Album
(Spotify)** + assistant tool `get_album_tracks`): with an album name, search the
`/albums` facet and pick the card; otherwise, or when that misses (a
compilation's card says "Various Artists"), search `/tracks` and follow the
matching row's album link (album name as a tie-break hint). Then open
`/album/{id}`, wait for a real track row (`scriptWaitForPage`), and run the
shared `scriptScrollThenScrape` with `kind: "album"`; `fillAlbumName` backfills
the album column the album page omits. The tracklist's `aria-rowcount` makes the
scrape definite (12/12 on OK Computer). Results are memoized for an hour. The
menu action blocks behind the host loading modal — the clicked track is rarely
the opener, so there is no head to start early — then `playTracks` with
`source: "album"` and `track_number` in album order.

**Plays / monthly listeners** (info types `spotify_track_plays` and
`spotify_artist_listeners`, both `title_line`, 7-day TTL; tools
`get_track_plays` / `get_artist_listeners`): the track page prints the all-time
count in `[data-testid="playcount"]` (absent under ~1,000 plays → `not_found`);
the artist hero prints "N monthly listeners" twice — compact and a
visually-hidden exact figure — and `pickListenerCount` prefers the exact one.
Album pages show **no** per-track plays, and Spotify has **no** per-track
listener figure (that is Last.fm's stat), so neither is offered.

These run in the **background** whenever a detail page opens, so:
- `withSpotifyWindow({ quiet: true })` never surfaces the window: a signed-out
  page rejects with `SIGNED_OUT` (and `signedOutUntil` skips lookups for 10
  minutes; any confirmed login clears it), and a login check that never
  settles gives up after 25s.
- `infoLookup` serializes them (one queue), waits up to 90s for a user action's
  window instead of failing "busy", and de-duplicates by key — the artist page
  asks for its title line from two components at once, and they share one
  window (asserted by `plugin:track-plays`).
- They are **paced**: at least 4s apart, and after 3 consecutive Spotify
  "no results" pages (one is often just an obscure track) background lookups
  pause for 10 minutes (`throttledUntil`). They fire on every detail page, and
  a throttled Spotify search would also break the user's own search and radio.
  The user-initiated album action is not paced.

### Liked Songs import (`importLikedSongs`)

Settings-panel action that turns the user's Spotify **Liked Songs** into Viboplr
likes. Runs inside `withSpotifyWindow` (login flow, single-window gate,
generation guard) like every other scrape:

1. Navigate to `/collection/tracks` — a fixed URL with no entity id, but the
   page renders the same virtualized tracklist markup as a playlist page, so the
   shared `scriptScrollThenScrape` parses it unchanged (`kind: "collection"`
   only changes the navigation URL). Scroll budget `LIKED_MAX_STEPS` (500).
   The scrape knows when it is **done**: the tracklist grid publishes
   `aria-rowcount` (rows + 1 header row), the shared parser stops once it has
   parsed that many rows and reports it as `total`, and the settings panel
   shows "N of M". The timeout is **stall-based** (`LIKED_STALL_MS`, 45s with
   no new rows) rather than total-duration — a large list legitimately takes
   minutes — and is the fallback for a page that stops rendering rows short of
   its published count.
2. Dedupe rows by normalized title+artist (the host's like store key).
3. `api.library.getTrackLikeStates` → **skip** rows already liked or disliked
   locally. The scrape carries no per-row "date added", so an unconditional
   write would stamp every existing like with a fresh `updated_at` (reordering
   the host's Liked Tracks system playlist) and silently flip deliberate local
   dislikes. Skipping keeps the import strictly additive.
4. Remaining rows go to `api.library.setTrackLikesBatch` in chunks of
   `LIKED_BATCH` (200) — the host's newer-wins merge, the same one behind its
   Import-likes file path — with a progress line per chunk.

Cancel sets a flag checked on every progress tick **and** closes the scrape
window (the host emits `window-closed` on any window Destroyed, which resolves
`withSpotifyWindow` with `null` — this is what unblocks a cancel parked at the
sign-in wait). Cancelling is not a failure: the import returns to idle, keeping
whatever chunks already landed (the merge is idempotent, so re-running finishes
the job). The result line reports added / already-liked / skipped-as-disliked
counts. Verified against the live DOM by `npm run verify:liked`.

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

### Search Actions
| Action | Context | Behavior |
|--------|---------|----------|
| `spotify-search` | Search box (home + results views); also fired by the host's Cmd+K view seed | `runSearch(query)` — results view in loading state → `scrapeSearchTracks` → render; empty query returns home. While a search runs: `cancelSearch()` |
| `play-search-track` | Result row click (`itemId`) | Play that one row |
| `search-play` / `search-queue` | Row-list actions on the selection (`selectedIds`) | Play (with a `source: "search"` context) / enqueue the selected rows |
| `search-radio` | Row-list action | `startSpotifyRadio` seeded from the first selected row |
| `go-home` | Results view Home button | Back to the shelves (shared with the playlist view) |

### Track Actions (universal context menu)
| Action | Context | Behavior |
|--------|---------|----------|
| `start-spotify-radio` | Any track’s right-click menu (library / queue / playlist / plugin / search) | `startSpotifyRadio(title, artist)` — plays the seed immediately, then search → go-to-radio → scrape → append the station (legacy hosts: scrape first, then replace the queue; see *Start Spotify radio*) |
| `play-spotify-album` | Any track’s right-click menu | `playSpotifyAlbum(target)` — find the track's album on Spotify (by `albumTitle`, else via the track row), scrape it, replace the queue in album order (see *Catalog lookups*) |

## Injected Scripts

| Script | Purpose | Key Selector |
|--------|---------|-------------|
| `SCRIPT_CHECK_LOGIN` | Detect login state | `[data-testid="user-widget-link"]`, `[data-testid="login-button"]` |
| `SCRIPT_SCRAPE_SHELVES` | Scrape all shelves on the music-chip home (heading, description, cards) | document-order sweep over `h1,h2,h3,[role="heading"]` + `a[href*="/playlist/"]` |
| `scriptNavigatePlaylist(id)` | Navigate to playlist page | Direct URL assignment |
| `scriptScrollThenScrape(id, gen)` | Scroll + parse tracks (also reused for the radio tracklist) | `[role="row"]` inside `[data-testid="playlist-tracklist"]` |
| `scriptNavigateSearch(query)` | Navigate to the `/search/{q}/tracks` page (radio seed) | direct URL assignment |
| `scriptSearchTopTrack(gen[, budgetMs])` | Poll for results, pick the top track → `radio-seed {trackId,name,artist}` (or `{error,loggedOut}`) | first `a[href*="/track/"]` in `main` |
| `scriptNavigateTrackPage(id)` | Navigate to `/track/{id}` (radio seed) | direct URL assignment |
| `scriptGoToRadio(gen, trackId[, budgetMs])` | On the seed's track page only: poll for the `…` menu, click "Go to song radio" → `radio-go` | `button[data-testid="more-button"]` + `[role="menuitem"]` matching `/radio/i` |
| `scriptWaitForSearchResults(gen[, budgetMs])` | On the search `/tracks` page: poll until a real track row has rendered → `search-ready {ok,url}` (or `{error,loggedOut}`); gates the row parser, which the page's placeholder rows would otherwise satisfy early | `main [role="row"] a[href*="/track/"]` |
| `scriptWaitForStation(gen, trackId[, budgetMs])` | Wait until the page has left the seed's track page → `radio-station {url}` | `location.pathname` vs `/track/{id}` (exact, `/intl-xx` stripped — the station lives at `/station/track/{id}`) |
| `scriptSearchCandidates(gen, facet[, budgetMs])` | On `/search/{q}/{facet}` only: every track row / album card / artist card → `search-candidates {candidates, noResults?, loggedOut?}` | `[role="row"]` links; `[data-testid^="search-category-card-"]` + `[data-encore-id="cardTitle"]` |
| `scriptWaitForPage(gen, path, withTracklist)` | Wait until the document is `path` (and has a real track row) → `page-ready` | `location.pathname`; tracklist `a[href*="/track/"]` |
| `scriptReadTrackPlays(gen, trackId)` | On `/track/{id}`: the all-time play count → `track-plays {raw}` / `{missing}` | `[data-testid="playcount"]` |
| `scriptReadArtistListeners(gen, artistId)` | On `/artist/{id}`: every "… monthly listeners" text → `artist-listeners {texts}` | text match in `main` (English UI) |
| `SCRIPT_LOGIN_BANNER` | Inject "please sign in" banner when not logged in | fixed-position `<div>` prepended to `<html>` |
| `SCRIPT_REMOVE_LOGIN_BANNER` | Remove the sign-in banner once logged in | by element id |

## Known Limitations

- Spotify OAuth is non-functional; the plugin relies on the user being logged in via the browser session
- DOM selectors may break when Spotify updates their web app — `npm run verify:all` checks every one of them (see DEVELOPING.md §5b)
- Monthly-listener parsing matches English UI text ("monthly listeners"), like the radio flow's menu-label match
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
  **no cover image** (no og:image, no hero `<img>` outside the tracklist), so the
  radio queue banner shows the title only — per-row track art still resolves. Re-run
  `verify:radio` if `scriptSearchTopTrack` / `scriptGoToRadio` ever stop finding a
  seed or the radio menu item (Spotify DOM drift).
