# Changelog

## v1.16.0
- **"Start Spotify radio" now starts playing immediately.** A song radio always
  opens with its seed — the very track you right-clicked — so that track starts
  straight away and the rest of the station fills in behind it. Previously you
  waited out the whole search → station → scrape flow (15–25s) behind a loading
  dialog before hearing anything.
- While the station is still loading, the playlist panel shows a "Filling in the
  rest…" row, and a notification confirms the track count once it lands. If the
  station can't be loaded, whatever is playing keeps playing and a notification
  explains why.
- Start a different radio (or anything else) while a station is still loading and
  the old one is discarded instead of being appended to what you switched to.
- Requires a Viboplr version with the backfill playback API; on older versions
  the action keeps its previous behaviour (loading dialog, then play).

## v1.15.0
- New **"Start Spotify radio"** action on the right-click menu of any track,
  anywhere in the app (library, queue, playlist, plugin views, search results).
  It searches Spotify for the track, opens its "Go to song radio" station, and
  scrapes the radio tracklist — then replaces the queue and starts playing it.
- The whole flow reuses the existing Spotify browse window (so it shares the
  sign-in prompt, the single-window limit, and cancellation) and the proven
  track-list scraper. Each step is best-effort: if the track can't be found, the
  radio menu item is missing, or the station comes back empty, a notification
  explains it and your current queue is left untouched.
- Dev tooling: `npm run verify:radio "<seed query>"` drives the radio flow
  against the live Spotify page to catch DOM/selector drift, and a Windows
  path-handling bug in the test scripts is fixed so `npm test` runs there too.


## v1.14.0
- Refresh now **prefetches the tracks of the last 5 playlists you actually
  loaded** (viewed / played / enqueued / force-refreshed), so a frequently-used
  playlist is ready to play instead of paying the full scrape delay on the next
  open. Runs after both a manual Sync and the silent auto-refresh.
- The prefetch is best-effort and headless: it warms playlists one at a time
  (respecting the single-browser-window limit), skips ones whose cached tracks
  are still fresh (no window opened), and logs+skips any that fail.
- It yields the browser window to you: opening/playing a playlist (or clicking
  Cancel) stops the remaining prefetch queue, so you're never stuck waiting on
  background warming — at most one already-running scrape.
- The recently-loaded list is remembered across sessions
  (`spotify_browse_recently_loaded`).

## v1.13.0
- On first activation of a fresh install, the plugin now starts the initial
  sync automatically and asks the user to sign in to Spotify in the embedded
  browser window if needed — no manual Sync click required. One-shot
  (`spotify_browse_first_run_done` guard); existing installs are unaffected.
- The first-run sync reports its outcome as notifications: a success toast
  ("Synced N playlists across M shelves…" with where to find them), and a
  guidance toast to open the Spotify view and click Sync if sign-in was
  abandoned or the sync failed.

## v1.12.9
- Playlist cards now keep the scraped subtitle (e.g. "With X, Y…") visible even
  after their tracks are fetched, instead of replacing it with the track count.
  The "N tracks · synced …" text is now only used as a fallback when a card has
  no scraped subtitle.

## v1.12.8
- Fix: the Music-home sync no longer adds phantom/duplicate-looking entries
  from the big "hero" promo tiles at the top of the page. The scrape now keeps
  only playlist cards that live inside an aria-labelled `<section>` (every real
  library/recommendation shelf), so the editorial hero tiles — and stray
  mix-card titles that were being mistaken for shelf headings — are dropped. A
  hero playlist that also appears as a genuine card in a real shelf is still
  captured there.
- Prevent audio leaking from the hidden scrape window: instead of muting after
  the fact, the embedded browser now re-imposes the browser autoplay policy, so
  Spotify's "resume last session" `play()` is rejected (no user gesture) and
  nothing ever sounds — while a real click during manual login still works.
- Sync now shows a live progress line in the toolbar ("Reading your Spotify
  home…", "Found N playlists across M shelves", "Caching images…") instead of a
  static "Waiting for login…".
- Faster sync on the common path: when the scrape window already opened on the
  Music-home page, skip the redundant re-navigation (and its reload-time
  autoplay attempt) and scrape the page that's already loaded.
- The hidden scrape window no longer briefly flashes for already-logged-in
  users — it is surfaced only when the page positively reports a signed-out
  state.

## v1.12.7
- Fix: clicking **Play** on an unfetched playlist now shows the "Loading…"
  modal while its tracks scrape, instead of appearing to do nothing until the
  queue silently filled seconds later. The loading modal called
  `api.requestAction` (which is undefined) instead of `api.ui.requestAction`,
  so it threw before the scrape and left the modal-guard stuck — suppressing
  feedback on every subsequent Play.

## v1.12.6
- New setting **"Include albums in sync"** (off by default). When enabled, Sync
  also captures album cards from the Music home alongside playlists; albums open
  a detail view with their tracklist and support Play / Enqueue / Save to
  Playlists, exactly like playlists. Disable it and re-sync to remove albums.

## v1.12.5
- Internal cleanup, no behavior change to syncing or scraping:
  - Removed the never-populated per-section/per-playlist diagnostics machinery
    (section status/attempts/snapshots, playlist failure lists) left over from
    the multi-section scraper. The single-page sync never wrote to it, so the
    Diagnostics panel no longer shows a misleading "(music-chip home) — pending"
    section, and the run report/log dropped the unused structured `log` array.
  - De-duplicated the playlist-by-id lookup (one `findPlaylistById` +
    `parsePlaylistId`) and the Spotify login-signal lists (one shared
    `POSITIVE/NEGATIVE_LOGIN_SIGNALS`), so they can no longer drift.
  - Removed the dead `getStatusText` branches and made `escapeHtml` escape
    quotes so it's safe in HTML attributes, not just text.
- Fix: a fresh install now correctly shows the "No playlists yet — click Sync"
  prompt and registers no phantom home shelf, instead of seeding a hardcoded
  "Made for You" section before the first sync.

## v1.12.4
- Fix dozens of phantom, cover-less playlists appearing after sync. Mix cards
  list their seed artists in the subtitle ("With Franz Ferdinand, Wunderhorse
  and more") as `/playlist/` links; the home-page scrape was mistaking these
  decorative credit links for real playlist cards. The scrape now skips any
  `/playlist/` link inside a card subtitle, so only browsable cards (which have
  their own cover) are captured.

## v1.12.1
- Fix playlists missing covers after sync: the home-page settle phase now
  oscillates (up then back down, repeating) and re-traverses the virtualized
  feed until every card has a cover or the pass budget runs out, giving lazy
  card images more chances to resolve.

## v1.12.0
- Sync now scrapes the Music home page (`home?facet=music-chip`) in a single
  pass, showing every shelf as a stacked heading + card grid (mirroring the
  Spotify page). Removed the fragile section-finder, the section tabs, and
  per-section configuration.
- Cards now show their Spotify subtitle and shelves their description text, so
  the panel looks populated before any tracks are fetched.
- Tracks are now fetched lazily on View/Play/Enqueue and cached for 24h
  (added a "Refresh tracks" card action to force a re-scrape).
- Removed the Liked Songs synthetic playlist.
- Auto-refresh now refreshes the playlist list only (no eager track scraping).

## v1.11.0
- Moved the plugin to its own repository with in-app auto-update.
- Prune orphan track thumbnails on refresh; preserve on-disk covers when a
  refresh yields no cover image.
- Write one human-readable log file per sync run (logs/YYYYMMDD-HHMMSS.log,
  newest 20 kept) instead of last_sync.log / sync-runs.json.
