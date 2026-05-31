# Play Loading Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the host's loading modal while a Play/Enqueue on an un-fetched Spotify playlist scrapes its tracks, so the user gets visible feedback instead of an apparently-dead button.

**Architecture:** Plugin-only (`index.js`). Add a `fetchTracksWithLoading(pl)` helper that shows the host `PluginLoadingModal` via `api.requestAction("show-loading", { message })` before `ensureTracks` (only when `!tracksAreFresh(pl)`) and hides it via `api.requestAction("hide-loading", {})` on both resolve and reject. Rewire the four lazy-fetch handlers (`play-current`, `enqueue-current`, `play-playlist`, `enqueue-playlist`) through it, dropping the dead `showNotification` calls.

**Tech Stack:** Plain ES5 JS in a frozen WebView sandbox; gate via `node --check index.js`. No host change.

---

## Testing Approach (read before starting)

No test harness for this plugin. Each task gates on `node --check index.js` (exit 0) plus greps. Real validation is the manual in-host checkpoint at the end. Commit after each task.

Reference: design at `docs/superpowers/specs/2026-06-01-play-loading-feedback-design.md`.

## File Structure

Single file, two regions:
- **Modify:** `index.js`
  - Add `fetchTracksWithLoading(pl)` helper (near the play/enqueue handlers, ~line 2260).
  - Rewire the four handlers: `play-current` (~2262), `enqueue-current` (~2272), `play-playlist` (~2339), `enqueue-playlist` (~2349).

Ordering: Task 1 adds the helper (no behavior change yet — nothing calls it). Task 2 rewires the four handlers to use it.

---

## Task 1: Add the `fetchTracksWithLoading` helper

**Files:**
- Modify: `index.js` — insert a new function immediately ABOVE the `api.ui.onAction("play-current", …)` handler (~line 2262).

**Context:** `ensureTracks(pl)` returns a Promise of the track array; it opens a browse window + scrapes only when the playlist isn't cached/fresh. `tracksAreFresh(pl)` is the existing freshness check (24h TTL + tracks present) — the same gate `ensureTracks` uses internally, so it exactly predicts whether a scrape will run. `api.requestAction(action, payload)` is the host bridge call; `"show-loading"` shows a spinner modal with `payload.message`, `"hide-loading"` dismisses it.

- [ ] **Step 1: Insert the helper**

Find this exact line (the start of the first handler we'll rewire):
```javascript
  api.ui.onAction("play-current", function() {
```
Replace with (the helper, a blank line, then that same line):
```javascript
  // Fetch a playlist's tracks for a Play/Enqueue action, showing the host
  // loading modal while a real scrape runs. Shows the modal only when the
  // playlist isn't already cached/fresh (so cached playlists play instantly with
  // no flash) AND no modal is already active (so a second concurrent Play — which
  // withSpotifyWindow rejects — doesn't stomp the first's modal). Hides only the
  // modal it itself showed, on every settle path (success, empty, OR error), so
  // the blocking modal can never stick. Returns the tracks promise.
  function fetchTracksWithLoading(pl) {
    var showed = false;
    if (!tracksAreFresh(pl) && !loadingModalActive) {
      loadingModalActive = true;
      showed = true;
      api.requestAction("show-loading", { message: "Loading " + pl.name + "…" });
    }
    function done() {
      if (showed) { loadingModalActive = false; api.requestAction("hide-loading", {}); }
    }
    return ensureTracks(pl).then(function (tracks) {
      done();
      return tracks;
    }, function (e) {
      done();
      throw e;
    });
  }

  api.ui.onAction("play-current", function() {
```

> Requires a module-level `var loadingModalActive = false;` near the top of
> `activate` (next to `windowBusy`). It gates modal ownership so concurrent Plays
> don't show/hide each other's modal — added as part of this step.

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add fetchTracksWithLoading helper (host loading modal)"
```

---

## Task 2: Rewire the four play/enqueue handlers

**Files:**
- Modify: `index.js` — `play-current`, `enqueue-current`, `play-playlist`, `enqueue-playlist` handlers.

**Context:** Each handler currently calls the dead `api.ui.showNotification("Fetching tracks…")` then `ensureTracks(pl)`. Replace each with a call through `fetchTracksWithLoading(pl)` (Task 1). The `playTracks`/`insertTracks` payload and `pl` lookup are unchanged. The old "No tracks found" / "Failed to fetch tracks" `showNotification` calls were no-ops, so we drop them (failure → `console.error`; empty → silent return).

- [ ] **Step 1: Rewire `play-current`**

Find:
```javascript
  api.ui.onAction("play-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    api.ui.showNotification("Fetching tracks for " + pl.name + "…");
    ensureTracks(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) { api.ui.showNotification("No tracks found"); return; }
      api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));
    }).catch(function (e) { console.error(e); api.ui.showNotification((e && e.message) ? e.message : "Failed to fetch tracks"); });
  });
```
Replace with:
```javascript
  api.ui.onAction("play-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    fetchTracksWithLoading(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) return;
      api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));
    }).catch(function (e) { console.error(e); });
  });
```

- [ ] **Step 2: Rewire `enqueue-current`**

Find:
```javascript
  api.ui.onAction("enqueue-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    api.ui.showNotification("Fetching tracks for " + pl.name + "…");
    ensureTracks(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) { api.ui.showNotification("No tracks found"); return; }
      api.playback.insertTracks(toPluginTracks(tracks), -1);
    }).catch(function (e) { console.error(e); api.ui.showNotification((e && e.message) ? e.message : "Failed to fetch tracks"); });
  });
```
Replace with:
```javascript
  api.ui.onAction("enqueue-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    fetchTracksWithLoading(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) return;
      api.playback.insertTracks(toPluginTracks(tracks), -1);
    }).catch(function (e) { console.error(e); });
  });
```

- [ ] **Step 3: Rewire `play-playlist`**

Find:
```javascript
  api.ui.onAction("play-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    api.ui.showNotification("Fetching tracks for " + pl.name + "…");
    ensureTracks(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) { api.ui.showNotification("No tracks found"); return; }
      api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));
    }).catch(function (e) { console.error(e); api.ui.showNotification((e && e.message) ? e.message : "Failed to fetch tracks"); });
  });
```
Replace with:
```javascript
  api.ui.onAction("play-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    fetchTracksWithLoading(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) return;
      api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));
    }).catch(function (e) { console.error(e); });
  });
```

- [ ] **Step 4: Rewire `enqueue-playlist`**

Find:
```javascript
  api.ui.onAction("enqueue-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    api.ui.showNotification("Fetching tracks for " + pl.name + "…");
    ensureTracks(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) { api.ui.showNotification("No tracks found"); return; }
      api.playback.insertTracks(toPluginTracks(tracks), -1);
    }).catch(function (e) { console.error(e); api.ui.showNotification((e && e.message) ? e.message : "Failed to fetch tracks"); });
  });
```
Replace with:
```javascript
  api.ui.onAction("enqueue-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    fetchTracksWithLoading(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) return;
      api.playback.insertTracks(toPluginTracks(tracks), -1);
    }).catch(function (e) { console.error(e); });
  });
```

- [ ] **Step 5: Syntax gate + grep**

Run: `node --check index.js`
Expected: exits 0.

Run: `grep -n 'fetchTracksWithLoading(pl)\.then' index.js`
Expected: 4 matches (the four handler call sites; the helper's `function fetchTracksWithLoading(pl) {` definition is excluded by the `.then` suffix).

Run: `grep -n 'Fetching tracks for\|No tracks found\|Failed to fetch tracks' index.js`
Expected: NO output (all dead showNotification strings in these handlers removed).

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: show loading modal on Play/Enqueue of un-fetched playlists"
```

**[MANUAL CHECKPOINT — full acceptance]** — Reload the plugin in the host. Verify:
1. Press **Play** on a playlist whose tracks have NOT been fetched → a centered "Loading… / Loading <name>…" spinner modal appears immediately, stays while it scrapes, then dismisses as the queue fills and playback starts.
2. Press **Play** on an already-played (cached, <24h) playlist → plays instantly, **no** modal.
3. Same for **Enqueue** (card menu) and the detail-header Play/Enqueue.
4. Close the browse window mid-fetch (cancel) → the modal dismisses (doesn't stick); nothing crashes.
5. A playlist that scrapes empty → modal dismisses; nothing queued (no error dialog).

---

## Self-Review Notes

**Spec coverage** (design → task):
- `show-loading`/`hide-loading` via `requestAction` → Task 1 helper.
- All four actions covered → Task 2 Steps 1-4.
- Show only when `!tracksAreFresh(pl)` → Task 1 (`needFetch` gate).
- Message `"Loading <name>…"` → Task 1.
- Hide in both resolve AND reject (no stuck modal) → Task 1 (`.then(onFulfilled, onRejected)` form, both call hide when `needFetch`).
- Replace dead showNotification calls → Task 2 (removed; failure → console.error, empty → return).
- Cached playlist plays instantly, no flash → Task 1 (`needFetch` false → no show/hide).

**Type/name consistency:** `fetchTracksWithLoading(pl)` defined in Task 1, called in all four handlers in Task 2. Uses existing `tracksAreFresh`, `ensureTracks`, `api.requestAction`, `toPluginTracks`, `playlistContextPayload`, `api.playback.playTracks`/`insertTracks`, `findPlaylistFromData`, `state.currentPlaylist` — all present. `show-loading`/`hide-loading` action names match the host's `requestAction` handler.

**Note on line numbers:** find-strings are verbatim from current files; anchor on them.
