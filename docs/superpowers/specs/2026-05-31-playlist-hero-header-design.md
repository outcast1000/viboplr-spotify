# Playlist Hero Header — Design

**Date:** 2026-05-31
**Status:** Approved (design); implementation pending
**Plugin:** `spotify-browse` (viboplr-spotify)
**Builds on:** `2026-05-31-lazy-single-page-scrape-design.md`, `2026-05-31-progressive-track-loading-design.md`

## Summary

The playlist detail view already renders a host `detail-header` node, but only
populates `title`, `meta`, `imageUrl`, `backAction`, `playAction`, and
`contextMenuActions` — leaving the hero visually flat. The host's
`detail-header` contract supports more: a crossfade background (`bgImages`), a
native Enqueue button (`enqueueAction`), and a subtitle chip (`subtitle`). This
change feeds those fields so the playlist page looks like a real hero.

This is pure data-population in `renderPlaylist` — the host owns all visual
rendering (`DetailHero.tsx`). No host changes; every field used is in the
verified `detail-header` type in the host's `src/types/plugin.ts`.

## The host `detail-header` contract (verified)

From `outcast1000/viboplr` `src/types/plugin.ts` (rendered by `DetailHero.tsx`
via `mapDetailHeader.ts`):

```
type: "detail-header";
title: string;
subtitle?: string;              // shown as a chip alongside meta
meta?: string;                  // shown as a chip
imageUrl?: string;              // foreground art only
bgImages?: string[];            // 0-4 crossfade background images
artShape?: "square" | "circle"; // defaults to "square"
actions?: {...}[];              // extra overflow items
backAction?: string;
playAction?: string;
enqueueAction?: string;         // wires the native Enqueue button
contextMenuActions?: {...}[];
```

`bgImages` and `imageUrl` both pass through the host's `resolveImageUrl`, which
handles local cached paths (incl. `#v=` cache-bust) and http/data URIs — so the
plugin's local `cover.jpg` / `track-*.jpg` paths work as backgrounds.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Background (`bgImages`) | Cover first, then up to 3 distinct **local** track album-arts (collage crossfade) |
| Track-art source | `state.playlistTracks[pl.id]`, only entries whose `imageUrl` is a local path (not `http…`) |
| Native Enqueue | Add `enqueueAction: "enqueue-current"`, gated like Play (`!loadingThis && tracks.length > 0`) |
| Subtitle chip | `subtitle: pl.description || undefined` |
| Meta chip | Unchanged: `"N tracks · synced X"` |
| `artShape` | Unchanged (defaults to `"square"`, correct for playlists) |

## Architecture

All changes are in `renderPlaylist` in `index.js`.

### 1. Build `bgImages` (cover + distinct local track arts)

Add a small local helper that assembles the background array:

- Start with the cover: if `pl.imageUrl` is truthy, it is element 0.
- Append track arts from `state.playlistTracks[pl.id]`: iterate tracks, take each
  `t.imageUrl` that **is a local path** (i.e. does NOT start with `"http"` — local
  paths are absolute filesystem paths or `…#v=` forms produced by `cacheAllImages`).
  Skip any url already in the array (Spotify reuses album art across tracks).
  Stop once the array has 4 entries total.
- Result: `bgImages` is `[cover]` during/just-after a scrape (track arts still
  remote), and upgrades to `[cover, art1, art2, art3]` after `cacheAllImages`
  localizes the track images on a later render.

Why "local only": this dovetails with the progressive-loading and image-caching
designs. During a scrape track `imageUrl`s are remote Spotify CDN URLs (the host
WebView may block them, and they'd cause crossfade churn every progress tick). By
including only localized arts, the background is stable (cover-only) until images
are cached, then becomes the collage exactly once.

### 2. Pass the new fields on the `detail-header` node

In the existing `detail-header` node literal, add:

- `subtitle: pl.description || undefined`
- `bgImages: <the array from step 1>` (omit / empty array is fine if no cover)
- `enqueueAction: (!loadingThis && tracks.length > 0) ? "enqueue-current" : undefined`

`title`, `meta`, `imageUrl`, `backAction`, `playAction`, `contextMenuActions`,
and the `playAction` gating are unchanged. `enqueue-current` is an existing
registered action (used by the context menu today) — no new handler needed.

## Data flow

```
renderPlaylist(pl)
  bgImages = [pl.imageUrl?]            // cover first
           + distinct local track arts from state.playlistTracks[pl.id] (≤3 more)
  detail-header node:
    title, imageUrl (cover), artShape default square,
    subtitle = pl.description || undefined,
    meta = "N tracks · synced X",
    bgImages,
    backAction, playAction (gated), enqueueAction (gated), contextMenuActions
  → api.ui.setViewData
```

Lifecycle interaction (no new state):
- First open (uncached): cover present, no local track arts yet → `bgImages=[cover]`,
  `subtitle` absent (description not yet scraped).
- After `ensureTracks` settles + `cacheAllImages` localizes images → next render
  yields `bgImages=[cover, …arts]` and `subtitle=description`. One-time upgrade.

## Error / edge handling

- **No cover** (`pl.imageUrl` falsy): `bgImages` starts empty; if no local track
  arts either, it's an empty array — the hero renders its default background. Fine.
- **No description**: `subtitle` is `undefined` → hero shows only the meta chip
  (current behavior).
- **Loading / 0 tracks**: `enqueueAction` (like `playAction`) is `undefined` →
  native Enqueue button hidden, matching the progressive-loading gating.
- **Duplicate art urls**: de-duped while building `bgImages`.
- The cover `#v=` cache-bust suffix is preserved (we pass `pl.imageUrl` verbatim).

## Out of scope

- `artShape: "circle"` (playlists are square).
- Animating/curating which track arts appear (just first-N distinct local).
- Remote track-art backgrounds during load (excluded by the local-only rule).
- Any change to the home/stacked-shelves view or the card grid.

## Known tradeoff

With the collage choice, a playlist's hero background visibly changes once —
cover-only on first view, then cover+track-art collage after the first
track-fetch caches images. This is a one-time per-playlist upgrade (not a flicker
loop) and reads as the page "coming alive" rather than jarring. Accepted.
