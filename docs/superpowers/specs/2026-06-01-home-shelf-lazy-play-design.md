# Home-Shelf Lazy Play Resolve — Design

**Date:** 2026-06-01
**Status:** Approved (design); implementation pending
**Repos:** `outcast1000/viboplr` (host) + `viboplr-spotify` (plugin)

## Summary

Pressing the **play button on a host Home-screen card** for an un-fetched
Spotify playlist plays **nothing**. The Spotify plugin registers its playlists as
`playlist-cards` and supplies `tracks: toPluginTracks(state.playlistTracks[id])`
in `buildShelfFetcher` — but tracks are lazy, so for a not-yet-fetched playlist
that array is `[]`. The host's `handleHomeShelfItemPlay` synchronously plays
`item.tracks` (`resolveShelfPlayAction` → `{ kind: "tracks", tracks: [] }`),
enqueuing nothing, with no scrape and no feedback. The plugin can't intercept the
host's play button (its `onItemClick` only overrides the card-*body* click).

Fix: add a host hook `api.home.onResolvePlay(shelfId, handler)` — a
plugin-registered async resolver the host awaits (behind its own loading modal)
when a card's `tracks` are empty, then plays the resolved tracks. Mirrors the
existing `onFetchShelf`/`onItemClick` precedents. The Spotify plugin's resolver
runs the lazy `ensureTracks` scrape.

## Background: how this differs from "Radio" (host precedent)

The host's built-in **Radio** shelf already defers track production to play-time:
its `playlist-cards` items carry a `__radioSeed` sentinel on `tracks[0]`, and
`resolveShelfPlayAction` diverts them to `{ kind: "radio" }` → `startRadio(seed)`
→ a Rust `build_radio_for_track` call that builds the station synchronously. This
validates the "defer tracks to play-time" shape, but it is **host-internal and
bespoke** (a magic sentinel + hardcoded `kind` + a backend command) — a plugin
can't reuse it, and radio's generation is fast/local (no loading UI needed),
whereas the Spotify resolve opens a browse window and scrapes for seconds. So we
add a generic, plugin-facing async resolver rather than piggyback on radio.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Host hook | `api.home.onResolvePlay(shelfId, handler)` — `handler(item) => Promise<PluginTrack[]>` (mirrors `onFetchShelf`/`onItemClick` registration) |
| When the host invokes it | Only when the resolved play action is `kind:"tracks"` AND `item.tracks` is empty AND a resolver is registered for that shelf. Non-empty tracks play directly (instant, no resolver call). |
| Loading feedback | The **host** wraps the awaited resolve in its own `PluginLoadingModal` (show before await, hide after). The plugin's resolver does NO UI — it just scrapes + returns tracks. |
| Empty/error result | Host hides the modal and plays nothing (logs it). No crash, no partial queue. |
| Plugin resolver | Spotify registers `onResolvePlay` per shelf → looks the playlist up by `item.id` → `ensureTracks(pl)` → `toPluginTracks(tracks)`. |
| Radio / other kinds | Unaffected — the resolver path is only for `kind:"tracks"` with empty tracks; `radio`/`album-id`/`artist-id`/`none` are unchanged. |
| Concurrency | The plugin's `ensureTracks`/`withSpotifyWindow` single-window guard still applies; a resolve that rejects (e.g. busy) → host hides modal, plays nothing. |
| Host commit | worktree-2 (`/Users/alex/Code/viboplr/.claude/worktrees/2`), **uncommitted** |
| Plugin commit | committed on this repo's branch |

## Host changes (`outcast1000/viboplr`, worktree-2 — uncommitted)

### 1. `src/types/plugin.ts` — declare the hook

In `PluginHomeAPI`, add (mirroring `onItemClick`'s shape):
```typescript
  // Resolve the tracks to play for a card whose `tracks` arrived empty (lazy).
  // The host awaits this (behind a loading modal) only when the card's play
  // action is kind:"tracks" with an empty list. Return the tracks to play (or
  // [] to play nothing).
  onResolvePlay(
    shelfId: string,
    handler: (item: HomeShelfItem) => Promise<PluginTrack[]>,
  ): () => void;
```

### 2. `src/hooks/usePlugins.ts` — store + expose the resolver

- Add `homeShelfResolvePlayHandlersRef = useRef(new Map<string, (item) => Promise<PluginTrack[]>>())` next to `homeShelfClickHandlersRef`.
- Implement `onResolvePlay(shelfId, handler)` in the plugin `home` API object exactly like `onItemClick` (key `${pluginId}:${shelfId}`, set/delete, `trackUnsubscribe`, return unsub). Clean it up in the same teardown loop that clears `homeShelfClickHandlersRef`.
- Add an `invokeHomeShelfResolvePlay(pluginId, shelfId, item): Promise<PluginTrack[]> | null` accessor (returns the handler's promise, or `null` if no resolver registered) — mirroring `invokeHomeShelfItemClick`. Export it from the hook's return object.

### 3. `src/App.tsx` — await the resolver in the play path

`handleHomeShelfItemPlay` currently, for `case "tracks"`, maps + plays
`action.tracks` synchronously. Change the `"tracks"` case to:

- If `action.tracks` is non-empty → play immediately (unchanged behavior).
- Else if `shelf.pluginId` and a resolver is registered → it's a lazy plugin card:
  - `setPluginLoadingMessage("Loading " + (item.name ?? "tracks") + "…")` (reuse the existing `PluginLoadingModal` state used by `requestAction("show-loading")`).
  - `await plugins.invokeHomeShelfResolvePlay(shelf.pluginId, shelfId, item)` (in a `try/finally` that always clears `pluginLoadingMessage`).
  - If the returned array is non-empty → `queueHook.playTracks(resolved.map(pluginTrackToQueueTrack), 0, action.context…)`.
  - If empty/throws → just clear the modal (play nothing); `console.error` on throw.
- Else (empty tracks, no resolver) → unchanged (plays nothing, as today).

`handleHomeShelfItemPlay` becomes `async` (it's a fire-and-forget click handler;
the host already `await`s elsewhere). `shelfId` is derived as in
`handleHomeShelfItemClick`: `shelf.id.slice(shelf.pluginId.length + 1)`.

### 4. `.claude/rules/plugins.md` — document `onResolvePlay`

Add it to the `api.home` section: "Resolve play tracks lazily — for a
`playlist-cards` item whose `tracks` you supplied empty, register
`onResolvePlay(shelfId, handler)`; the host awaits it (behind a loading modal)
when the user presses the card's play button, then plays the returned tracks."

## Plugin change (`viboplr-spotify`, this repo — committed)

### 5. `index.js` — register the resolver per shelf

There is no existing by-id lookup helper (`openPlaylistById` inlines the loop;
`findPlaylistFromData` takes the action `data` shape, not a bare id). Add a tiny
helper and reuse it:
```javascript
function findPlaylistById(pid) {
  for (var i = 0; i < state.playlists.length; i++) {
    if (state.playlists[i].id === pid) return state.playlists[i];
  }
  return null;
}
```
(Optionally refactor `openPlaylistById` to use it — not required.)

Then in `syncHomeShelves`, where each shelf registers `onFetchShelf` +
`onItemClick`, also register (guarded for older hosts):
```javascript
if (typeof api.home.onResolvePlay === "function") {
  api.home.onResolvePlay(id, function (item) {
    var pl = findPlaylistById(String(item.id));
    if (!pl) return Promise.resolve([]);
    return ensureTracks(pl).then(function (tracks) {
      return toPluginTracks(tracks || []);
    });
  });
}
```
The resolver does NOT show a modal (the host does that). `ensureTracks` is the
same lazy scrape the in-plugin Play uses, so a subsequent in-plugin View/Play of
the same playlist is now cached.

Note: `buildShelfFetcher` still supplies `tracks: toPluginTracks(rawTracks)` (the
already-cached tracks, often `[]`) — that's the signal the host uses to decide
whether to call the resolver. No change there.

## Data flow

```
Home card play ▶ (Spotify playlist, not yet fetched)
  host handleHomeShelfItemPlay → resolveShelfPlayAction = {kind:"tracks", tracks:[]}
    tracks empty + resolver registered:
      host: setPluginLoadingMessage("Loading <name>…")   // PluginLoadingModal
      host: await plugin.onResolvePlay(item)
         plugin: ensureTracks(pl)  // opens browse window, scrapes (seconds)
              → returns toPluginTracks(tracks)
      host: clear modal
      host: resolved.length ? playTracks(resolved, ctx{source:"playlist"}) : no-op
  (cached playlist: tracks non-empty → plays instantly, resolver never called)
```

## Error / edge handling

- **Cached/fresh playlist:** `item.tracks` non-empty → host plays directly; resolver not called. (When a previously-played playlist's tracks are cached, `buildShelfFetcher` already returns them.)
- **No resolver (other plugins / older host):** empty tracks → host plays nothing, as today. The plugin guards `onResolvePlay` with a `typeof` check so older hosts don't break.
- **Resolver returns []** (scrape empty / playlist not found): host hides modal, plays nothing. (Same "silent on empty" tradeoff as the in-plugin Play; acceptable.)
- **Resolver throws / rejected** (e.g. `withSpotifyWindow` busy, window closed): `try/finally` clears the modal; `console.error`. No stuck modal, no crash.
- **Concurrent:** the plugin's single-window guard rejects a second simultaneous scrape → that resolve rejects → host hides its modal. (The host loading modal is one global; only one resolve-play runs the modal at a time in practice since the user presses one play button.)
- **Radio and non-track kinds:** untouched — resolver only engages for `kind:"tracks"` with empty tracks.

### Known limitation (accepted for v1)

The host loading modal is a single global (`pluginLoadingMessage`), driven both by
this resolve-play path (`setPluginLoadingMessage`) and by the plugin's in-plugin
Play (`requestAction("show-loading"/"hide-loading")`). If the user triggers two
lazy plays within the same ~1–3s scrape window — two Home cards, or a Home card
then an in-plugin Play — the two operations share that one modal: the second
overwrites the message, and whichever settles first clears it (so the modal may
vanish while the other is still resolving). No crash; the requested tracks still
play (last play to finish wins the queue). A full fix is host-side modal
refcounting coordinating both channels; deferred as it's disproportionate to this
rare edge for a PoC. Code review confirmed no Critical issue.

## Out of scope

- Changing radio (`__radioSeed`) behavior.
- A queue/abort for overlapping resolves (single-window guard suffices).
- Wiring `api.ui.showNotification` to a toast (still a host no-op; not needed here — the host uses its loading modal directly).
- The in-plugin Play/Enqueue feedback (already shipped via `fetchTracksWithLoading`).

## Testing

- Host: `node_modules/.bin/tsc --noEmit` in worktree-2 (the hook + async play path compile).
- Plugin: `node --check index.js` (exit 0).
- No automated harness; real validation: build worktree-2, reload plugin, on the
  Home screen press a Spotify card's play button for a not-yet-opened playlist →
  loading modal appears, scrape runs, queue fills + playback starts; press play on
  an already-opened (cached) playlist → plays instantly, no modal.
