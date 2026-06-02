# Design: "Include albums" setting + album parsing

**Date:** 2026-06-02
**Plugin:** spotify-browse (viboplr-spotify)
**Status:** Approved (brainstorming) — pending implementation plan

## Goal

Add a user-visible setting in the host app's plugin settings panel that lets the
user include **albums** (alongside playlists) when the plugin scrapes the
Spotify Music home page. Albums become first-class, fully-functional entities:
they appear as shelf cards, open a detail view with a scraped tracklist, and
support Play / Enqueue / Save to Playlists — exactly like playlists today.

**Out of scope:** artists. The host cannot play or open an artist card without a
host-side `libraryId` the plugin doesn't possess, and an artist page has no
tracklist in the row shape the scraper consumes. Artists remain skipped.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Entities to surface | **Albums only** | Albums have a `/album/<id>` tracklist scrapeable with the existing row selectors and are fully playable via track lists. Artists are a host no-op without a `libraryId`. |
| Default state | **Off (opt-in)** | Preserves today's behavior for existing users; no surprise extra cards or longer syncs. Matches the other scrape toggles. |
| When it applies | **Next sync** | Flipping the toggle changes only what the next Sync captures. Consistent with the existing "Show browser" / "Debug logging" toggles. No auto-resync. |
| Internal representation | **Approach A: albums are entries in `state.playlists` tagged with `kind`** | Reuses the entire playlist pipeline (caching, persistence, lazy-track fetch, search, save, home shelves). Minimal churn vs. a parallel `state.albums` array (Approach B) or a `playlists`→`items` rename (Approach C). |

## Host capabilities (verified against `../viboplr`)

- `CardGridItem.targetKind` supports `"playlist" | "album" | "artist"`
  (`src/types/plugin.ts:180`). So album cards are natively supported.
- An album home-card click: if the card carries a host `libraryId`, the host
  navigates to its own album detail page; **otherwise it plays the card's
  `tracks` array.** This plugin has no `libraryId`, so albums behave as
  track-list-backed cards — which is exactly what we want (we open our own
  detail view and play scraped tracks).
- There is **no** `api.albums` / `api.artists` save/follow namespace. "Save to
  Playlists" for an album therefore saves its tracks as an app playlist via the
  existing `api.playlists.save` — no new host API needed.
- Album track pages use the same Encore tracklist row component as playlists
  (`[role="row"]`, `a[href*="/track/"]`, `[role="gridcell"]`) and the same
  `og:image` cover, so the existing track scraper works with only a navigation
  URL change.

## Data model

Every entry in `state.playlists` gains:

```
kind: "playlist" | "album"   // default "playlist" when absent
```

- Absent/legacy entries default to `"playlist"`, so **no migration** is needed —
  existing on-disk data loads unchanged.
- Persisted in each entry's `meta.json`; read back by `loadPlaylistFromDisk`.
- The on-disk layout `playlists/{section}/{id}/` is unchanged; albums and
  playlists coexist there, keyed by id within their shelf section.

New preference:

```
includeAlbums: boolean   // default false
```

Stored in the existing `spotify_browse_preferences` KV blob alongside
`showBrowserOnRefresh` / `debugLogging` / `autoRefreshHours`.

## Setting (UI)

- A `toggle` node labeled **"Include albums in sync"**, rendered in the settings
  panel (`renderSettings`) immediately after the existing toggles.
- Handler `toggle-include-albums`: flips `state.includeAlbums`, calls
  `savePreferences()` + `renderSettings()`. No resync, no immediate change to
  already-scraped data.
- Preference load (init) reads `includeAlbums` from
  `spotify_browse_preferences` (default `false`).

## Scraping changes

### Shelf scraper — `SCRIPT_SCRAPE_SHELVES` → builder `scriptScrapeShelves(includeAlbums)`

Convert the constant string into a builder function (mirroring
`scriptScrollThenScrape`). When `includeAlbums` is true, the generated script:

- widens the sweep node selector and the `carousels()` link selector to match
  `a[href*="/playlist/"]` **or** `a[href*="/album/"]`;
- matches each card with `/\/(playlist|album)\/([a-zA-Z0-9]+)/`, capturing both
  the kind and the id;
- stamps `kind` onto each emitted card: `{id, name, subtitle, imageUrl, kind}`;
- keys the de-dup map by `kind + ":" + id` (guards against any theoretical
  cross-kind id collision; ids don't collide in practice).

When `includeAlbums` is false, output is byte-for-byte today's behavior (kind
omitted/defaulted to "playlist" downstream).

The existing cardSubtitle skip-guard (`el.closest('[data-encore-id="cardSubtitle"],[id^="card-subtitle"]')`)
matches by the subtitle *container*, not by link kind, so it already excludes
`/album/` links embedded in another card's subtitle. **No selector change to the
guard is needed** — only the card-discovery selector/regex widens.

### Track scraper — `scriptNavigatePlaylist(id, kind)` and `scriptScrollThenScrape(id, gen, opts)`

- `scriptNavigatePlaylist` navigates to `/album/<id>` when `kind === "album"`,
  else `/playlist/<id>`.
- `scriptScrollThenScrape` takes the path/kind (via `opts` or a param) so its
  navigation/diagnostics use the right URL. Row parsing, cover (`og:image`), and
  the `[role="row"]` fallback scope are unchanged. The
  `[data-testid="playlist-description"]` selector simply yields empty on albums
  (acceptable — albums have no playlist-style description).

## Lazy-track fetch / persistence / rendering

- **`ensureTracks(pl, opts)`**: pass `pl.kind` through to the two script builders.
  All other logic (keep-old guard, TTL stamp, progressive updates, retry) is
  identical for albums.
- **`savePlaylist`**: write `kind: pl.kind || "playlist"` into `meta.json`.
- **`loadPlaylistFromDisk`**: read `kind: meta.kind || "playlist"`.
- **`applySyncResult`**: carry `kind` over for surviving entries (same as it does
  `tracksFetchedAt`). Album removal on toggle-off is automatic: when albums are
  excluded from a scrape, they drop out and `applySyncResult` deletes their dirs
  through the existing path.
- **`syncPlaylists`** message handler: copy `raw.kind` (default "playlist") onto
  each new entry.

### Rendering branches on `kind` (formatting only)

- New helper **`entitySource(pl)`** → `"spotify://albums/<id>"` for albums, else
  `"spotify://playlists/<id>"`. Used at the four enumerated touchpoints:
  `loadPlaylistFromDisk` (`uri`), `syncPlaylists` (`uri`),
  `playlistContextPayload` (`source`), `savePlaylistToApp` (`source`).
- **`buildPlaylistCards`** and **`buildShelfFetcher`**: album entries set
  `targetKind: "album"`. Card body / subtitle / tracks / context menu unchanged.
- **`renderPlaylist`** (detail view): structurally unchanged; album header `meta`
  reads "Album · N tracks" (minor cosmetic touch).
- **Save to Playlists**: works for albums unchanged — saves the album's scraped
  tracks as a new app playlist (album title + date stamp), since the host has no
  album-save API.
- Context menu actions (Play / Enqueue / View / Refresh tracks / Save) are all
  track-list operations and need no per-kind change.

## Verify harness impact

- `extract-scripts.mjs`: `SCRIPT_SCRAPE_SHELVES` becomes the builder
  `scriptScrapeShelves`; update the extraction map accordingly.
- `verify-scrape.mjs`: call `scriptScrapeShelves(includeAlbums)`; add an
  `includeAlbums` harness option (defaulting off) so the verify report can
  exercise album scraping. The HTML report's card flagging already handles
  `kind`-agnostic name/cover checks; optionally show `kind` per card.
- The `SCRAPE-SCRIPTS-START/END` markers stay in place.

## Testing

- **Unit (no host):** extend `extract-scripts.test.mjs` to confirm
  `scriptScrapeShelves` extracts and that `scriptScrapeShelves(true)` includes
  `/album/` selectors while `scriptScrapeShelves(false)` does not.
- **Harness (live):** run `verify:scrape` with albums on; confirm album cards
  appear with covers and a sampled album yields tracks.
- **Manual (host):** toggle on → Sync → albums appear as cards; open one →
  tracklist; Play / Enqueue / Save work; toggle off → Sync → albums removed.

## Release

- Bump patch version; add CHANGELOG entry under a new `## vX.Y.Z` section.
- No data migration (legacy entries default `kind: "playlist"`).
