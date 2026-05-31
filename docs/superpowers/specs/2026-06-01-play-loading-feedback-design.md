# Play Loading Feedback — Design

**Date:** 2026-06-01
**Status:** Approved (design); implementation pending
**Plugin:** `spotify-browse` (viboplr-spotify) — plugin-only, no host change

## Summary

Pressing Play/Enqueue on a not-yet-fetched Spotify playlist opens a browse
window and scrapes its tracks before anything reaches the queue — a multi-second
delay during which **the user sees nothing**. The handlers already call
`api.ui.showNotification("Fetching tracks…")`, but **that host method is a no-op**
(`App.tsx`'s `showNotification` only `console.debug`s — it shows no UI). So Play
feels broken.

Fix: use the host's real loading surface — the **`PluginLoadingModal`**, shown via
`api.requestAction("show-loading", { message })` and dismissed via
`api.requestAction("hide-loading", {})`. It renders a spinner overlay with a
message. Show it around the lazy `ensureTracks` fetch for all four play/enqueue
actions, **only when a real scrape is needed** (skip for cached/fresh playlists).
Plugin-only change; the host already supports these actions.

## Host facility used (verified in `outcast1000/viboplr`)

- `api.requestAction(action, payload)` is exposed to plugins (`plugin.ts` →
  `ViboplrPluginAPI.requestAction`).
- The host's `requestAction` handler (`App.tsx`): `"show-loading"` sets a
  `pluginLoadingMessage` → renders `<PluginLoadingModal message=… />` (a
  `ds-modal-overlay` with `loading-card-spinner`, title "Loading...", and the
  message as sub-text); `"hide-loading"` clears it.
- (Why not `showNotification`: the host's `showNotification` callback is a
  `console.debug` no-op — no toast system exists. The loading modal is the
  intended surface for a plugin operation that takes time.)

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Mechanism | `requestAction("show-loading", { message })` / `requestAction("hide-loading", {})` (host `PluginLoadingModal`) |
| Actions covered | All four lazy-fetch actions: `play-playlist`, `enqueue-playlist`, `play-current`, `enqueue-current` |
| When to show | Only when `!tracksAreFresh(pl)` (a real scrape will run). Cached/fresh playlists play instantly with no modal flash. |
| Message | `"Loading " + pl.name + "…"` |
| Dismissal | `hide-loading` in BOTH the `.then` and `.catch` of `ensureTracks` (success, empty, and error all dismiss) so the blocking modal can never stick |
| Replace showNotification? | Yes — the dead `showNotification("Fetching tracks…")` lines in these four handlers are replaced by the modal. (Other `showNotification` calls elsewhere — refresh-tracks, save — are out of scope.) |

## Architecture

All in `index.js`. A small helper keeps the four handlers DRY:

```
// Module-level (inside activate): tracks whether THIS plugin currently owns the
// single global host loading modal, so concurrent Plays don't stomp each other.
var loadingModalActive = false;

// Show the host loading modal only when a fetch will actually run AND no modal is
// already showing; always hide (the modal we showed) when ensureTracks settles.
// Returns the ensureTracks promise.
function fetchTracksWithLoading(pl) {
  var showed = false;
  if (!tracksAreFresh(pl) && !loadingModalActive) {
    loadingModalActive = true;
    showed = true;
    api.requestAction("show-loading", { message: "Loading " + pl.name + "…" });
  }
  function done() { if (showed) { loadingModalActive = false; api.requestAction("hide-loading", {}); } }
  return ensureTracks(pl).then(function (tracks) {
    done();
    return tracks;
  }, function (e) {
    done();
    throw e;
  });
}
```
A call shows the modal only if a real fetch is needed AND no modal is already
active; it hides only the modal it itself showed (`showed`). A second concurrent
Play (which `withSpotifyWindow` rejects) sees `loadingModalActive` true → doesn't
show or hide → the first call's modal stays until the first call settles.

Each of the four handlers becomes:
```
var pl = …;
if (!pl) return;
fetchTracksWithLoading(pl).then(function (tracks) {
  if (!tracks || tracks.length === 0) { /* (optional) no-op or log */ return; }
  api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));  // or insertTracks(…, -1)
}).catch(function (e) { console.error(e); });
```

Notes:
- `tracksAreFresh(pl)` is the existing freshness check (24h TTL + tracks present),
  the same gate `ensureTracks` itself uses — so `needFetch` exactly predicts
  whether `ensureTracks` opens a window. No modal for the instant cached path.
- `hide-loading` is keyed on `needFetch` so we never send a stray hide when we
  never showed.
- The old "No tracks found" / "Failed to fetch tracks" `showNotification` calls
  were no-ops anyway; we drop them (replace with `console.error` on failure).
  The modal is the user-visible feedback now; its dismissal signals completion
  (the queue then fills, which the user sees).

## Why the modal can't get stuck

`ensureTracks` always settles: it resolves with tracks (or kept-old tracks on
empty), and `withSpotifyWindow` resolves `null`/`[]` on cancel or window-close;
its internal timeouts/retries bound the scrape. The `.then`+`.catch` (second arg
to `then`) covers resolve AND reject, so `hide-loading` always fires when a
fetch was shown. Even the cancel path (user closes the browse window) resolves
ensureTracks → hide fires.

## Error / edge handling

- **Cached/fresh playlist:** `needFetch` false → no modal; plays instantly (unchanged).
- **Empty/failed scrape:** modal hides; nothing queued; `console.error` on a thrown
  error. (User-facing "nothing happened" is acceptable here — rare, and the modal
  dismissing signals the attempt ended; a future toast could improve this once the
  host has one.)
- **Concurrent Play while one fetch is in flight:** `withSpotifyWindow`'s single-
  window guard rejects the second open. To prevent the second call's show/hide
  from stomping the first call's still-showing modal (the host modal is a single
  global), a module-level `loadingModalActive` flag gates ownership: a call only
  shows the modal if none is active, and only hides the modal it itself showed.
  So a second concurrent Play neither re-shows nor prematurely dismisses the
  first's modal; its rejection is just logged. (Re-surfacing a "Spotify is busy"
  message is intentionally NOT done — the host's `showNotification` is a no-op, so
  it would be invisible anyway.)
- **Progressive detail-view loading** (the in-view `{type:"loading"}` footer) is a
  separate, already-shipped feedback path and is unaffected — this modal is only
  for the Play/Enqueue-from-elsewhere case where there's no detail view open to
  show progress.

## Out of scope

- Wiring `api.ui.showNotification` to a real host toast (no toast system; bigger
  host change).
- A progress/percentage in the modal (it's a spinner + message).
- Changing `refresh-tracks-ctx` or `save-playlist` feedback.
- The detail-view progressive-loading UI (already done).

## Testing

- Plugin: `node --check index.js` (exit 0).
- No automated harness; real validation is reloading in the host: press Play on an
  uncached playlist → a "Loading <name>…" spinner modal appears, then dismisses
  as the queue fills; press Play on an already-played (cached) playlist → plays
  instantly with no modal.
