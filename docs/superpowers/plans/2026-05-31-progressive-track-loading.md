# Progressive Track Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the host `type:"loading"` spinner while a playlist's tracks are being scraped, and render track rows progressively as they're parsed, instead of a static "Loading tracks…" text until the scrape finishes.

**Architecture:** Three contained changes in `index.js`: (1) the injected `scriptScrollThenScrape` already emits a per-tick `tracks-progress` message with a running count — add the partial `tracks` array to it; (2) `ensureTracks` consumes `tracks-progress` to write partial tracks into in-memory state and re-render (no disk write, no TTL stamp); (3) `renderPlaylist` renders three states using the host `{type:"loading", message}` node. No host changes, no new storage.

**Tech Stack:** Plain ES5-style JS (`var`/`function`), no build step, runs in the host WebView sandbox. UI is host view-nodes via `api.ui.setViewData`. DOM scraping via `eval`-ed string scripts.

---

## Testing Approach (read before starting)

**There is no test harness for this plugin** — no `package.json`, no Node/browser dev environment; the sandbox runs inside the host app's WebView. Per `DEVELOPING.md` the real loop is install/symlink into the host and reload.

Each task uses a **two-gate** verification:

1. **Automated gate (every task):** `node --check index.js` must exit 0 (syntax). For tasks that change the injected `SCRIPT`/string concatenation, also run the **assembled-string parse check** given in Task 1, Step 4 — `node --check` only validates the outer file, not the runtime DOM-script string it builds.
2. **Manual gate (final checkpoint):** reload the plugin in the host and verify behavior. This is the real acceptance test. If you cannot run the host app, mark the checkpoint deferred and continue — do not block.

Commit after every task. Reference: the design at `docs/superpowers/specs/2026-05-31-progressive-track-loading-design.md`.

## File Structure

Single file, three regions:

- **Modify:** `index.js`
  - `scriptScrollThenScrape` — the `tracks-progress` emit line (~line 1821).
  - `ensureTracks` — its message handler (~line 2128).
  - `renderPlaylist` — the track-list / loading tail (~lines 962-992).

Ordering: scraper first (produces the data), then `ensureTracks` (routes it into state), then `renderPlaylist` (displays it). The file stays loadable after each task.

---

## Task 1: Scraper emits partial tracks in `tracks-progress`

**Files:**
- Modify: `index.js` — the `tracks-progress` emit inside `scriptScrollThenScrape` (~line 1821).

- [ ] **Step 1: Add the partial `tracks` array to the progress message**

Find this exact line (it is the only `tracks-progress` occurrence in the file):

```javascript
        'try{window.__viboplr.send("tracks-progress",{playlistId:"' + playlistId + '",found:allOut.length,gen:_gen})}catch(e){}' +
```

Replace with:

```javascript
        'try{window.__viboplr.send("tracks-progress",{playlistId:"' + playlistId + '",found:allOut.length,tracks:allOut,gen:_gen})}catch(e){}' +
```

(Only `tracks:allOut,` is added. `allOut` is the in-scope accumulator array of parsed track objects; the terminal `tracks` message already sends the same `allOut`.)

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0, no output.

- [ ] **Step 3: Confirm the change is present**

Run: `grep -n 'tracks:allOut,gen:_gen' index.js`
Expected: one match (the progress line).

- [ ] **Step 4: Assembled-string parse check**

This proves the runtime DOM-script string that `scriptScrollThenScrape` builds is still valid JS (the outer `node --check` doesn't see inside the string). Run:

```bash
node -e '
const fs=require("fs");
let code=fs.readFileSync("index.js","utf8").replace(
  "  loadInitialState();",
  "  try{var __s=scriptScrollThenScrape(\"testid\",1,{maxSteps:1});new Function(__s);globalThis.__OK=__s.length;}catch(e){globalThis.__ERR=String(e&&e.message||e);}\n  loadInitialState();");
const fn=new Function("api","window","globalThis","self","document",code);
const chain=new Proxy(function(){},{get:()=>chain,apply:()=>Promise.resolve()});
const api=new Proxy({},{get:()=>chain});
try{ fn(api,{},globalThis,{},{}).activate(api); }catch(e){}
if(globalThis.__ERR){console.log("ASSEMBLED SCRIPT SYNTAX ERROR:",globalThis.__ERR);process.exit(1);}
console.log("ASSEMBLED scriptScrollThenScrape PARSES OK ("+globalThis.__OK+" chars)");
'
```
Expected: `ASSEMBLED scriptScrollThenScrape PARSES OK (...)`.
(The capture is injected at `loadInitialState();` — late in `activate`, AFTER `DBG_HELPER`/`IMG_HELPER` are assigned — so the helpers inline with real values rather than `undefined`. A harmless `Failed to load state: TypeError…` line from the API stub may also print; ignore it. If you see the SYNTAX ERROR line, the edit broke the script.)

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: include partial tracks array in tracks-progress message"
```

---

## Task 2: `ensureTracks` consumes `tracks-progress` (in-memory only)

**Files:**
- Modify: `index.js` — the `ctx.setHandler` callback inside `ensureTracks` (~line 2128).

**Context:** `ensureTracks(pl, opts)` runs inside `withSpotifyWindow`. Inside it: `gen` is the window generation; `state` is the plugin state; `renderPlaylist` re-renders the detail view; `pl` is the playlist being fetched. The handler currently only processes the terminal `tracks` message. We add a `tracks-progress` branch ABOVE it. The branch must NOT persist, NOT stamp `tracksFetchedAt`, NOT touch `pl.imageUrl`/`description` — those stay on `settle()` only (see design §2).

- [ ] **Step 1: Add the `tracks-progress` branch**

Find this exact block:

```javascript
        ctx.setHandler(function (msg) {
          if (msg.type === "tracks" && msg.data && msg.data.playlistId === pl.id) {
            var tracks = msg.data.tracks || [];
            if (msg.data.error) { plog("warn", "tracks", "Scrape error: " + msg.data.error); retryOrFinish(); return; }
            if (tracks.length === 0) { retryOrFinish(); return; }
            settle(tracks, msg.data.description, msg.data.coverUrl);
          }
        });
```

Replace with:

```javascript
        ctx.setHandler(function (msg) {
          // Progressive update: while scraping, the page posts partial track
          // arrays each scroll tick. Show them live WITHOUT persisting or
          // stamping the cache — only settle() (the terminal "tracks" message)
          // writes to disk / sets tracksFetchedAt, so an interrupted load never
          // leaves partial data cached or treated as fresh.
          if (msg.type === "tracks-progress" && msg.data && msg.data.playlistId === pl.id) {
            // Ignore once settled: a late progress message (still in flight as the
            // window closes) must not clobber the final settled tracks/metadata.
            if (settled) return;
            if (msg.data.gen !== gen) return;
            if (!Array.isArray(msg.data.tracks)) return;
            state.playlistTracks[pl.id] = msg.data.tracks;
            if (state.currentPlaylist && state.currentPlaylist.id === pl.id) renderPlaylist();
            return;
          }
          if (msg.type === "tracks" && msg.data && msg.data.playlistId === pl.id) {
            var tracks = msg.data.tracks || [];
            if (msg.data.error) { plog("warn", "tracks", "Scrape error: " + msg.data.error); retryOrFinish(); return; }
            if (tracks.length === 0) { retryOrFinish(); return; }
            settle(tracks, msg.data.description, msg.data.coverUrl);
          }
        });
```

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: ensureTracks renders partial tracks from tracks-progress"
```

---

## Task 3: `renderPlaylist` shows three loading states via `type:"loading"`

**Files:**
- Modify: `index.js` — the track-list / loading tail of `renderPlaylist` (~lines 962-992).

**Context:** `renderPlaylist` builds an array `ch` of view nodes and calls `api.ui.setViewData("spotify", {type:"layout", direction:"vertical", children: ch})`. The `detail-header` is always pushed first (identity visible in every state). `state.loadingTracksFor === pl.id` is true while a lazy fetch is in flight (set in `openPlaylistById`, cleared on settle/go-home). The host node `{ type: "loading", message }` renders a spinner + message (verified in host repo).

- [ ] **Step 1: Replace the track-list / loading tail**

Find this exact block:

```javascript
    if (tracks.length > 0) {
      var items = [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (query) {
          // Match against title, artist, album. Case-insensitive substring.
          var hay = ((t.name || "") + " " + (t.artist || "") + " " + (t.album || "")).toLowerCase();
          if (hay.indexOf(query) === -1) continue;
        }
        items.push({
          id: "track:" + i,
          title: t.name || "Unknown",
          subtitle: (t.artist || "Unknown") + (t.album ? " — " + t.album : ""),
          imageUrl: t.imageUrl || undefined,
          duration: t.duration || "",
          action: "play-track",
        });
      }
      if (query && items.length === 0) {
        ch.push({ type: "text", content: "<p style='opacity:0.5;padding:12px 0'>No tracks match \"" + escapeHtml(query) + "\"</p>" });
      } else if (query) {
        ch.push({ type: "text", content: "<p style='font-size:var(--fs-xs);color:var(--text-secondary);margin:6px 0 0'>" + items.length + " of " + tracks.length + " tracks</p>" });
      }
      if (items.length > 0) {
        ch.push({ type: "track-row-list", items: items });
      }
    } else if (state.loadingTracksFor === pl.id) {
      ch.push({ type: "text", content: "<p style='opacity:0.6'>Loading tracks…</p>" });
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks scraped</p>" });
    }
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
```

Replace with:

```javascript
    var loadingThis = state.loadingTracksFor === pl.id;
    if (tracks.length > 0) {
      var items = [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (query) {
          // Match against title, artist, album. Case-insensitive substring.
          var hay = ((t.name || "") + " " + (t.artist || "") + " " + (t.album || "")).toLowerCase();
          if (hay.indexOf(query) === -1) continue;
        }
        items.push({
          id: "track:" + i,
          title: t.name || "Unknown",
          subtitle: (t.artist || "Unknown") + (t.album ? " — " + t.album : ""),
          imageUrl: t.imageUrl || undefined,
          duration: t.duration || "",
          action: "play-track",
        });
      }
      if (query && items.length === 0) {
        ch.push({ type: "text", content: "<p style='opacity:0.5;padding:12px 0'>No tracks match \"" + escapeHtml(query) + "\"</p>" });
      } else if (query) {
        ch.push({ type: "text", content: "<p style='font-size:var(--fs-xs);color:var(--text-secondary);margin:6px 0 0'>" + items.length + " of " + tracks.length + " tracks</p>" });
      }
      if (items.length > 0) {
        ch.push({ type: "track-row-list", items: items });
      }
      // Still scraping more rows: spinner + live count footer (host loading node).
      if (loadingThis) {
        ch.push({ type: "loading", message: "Loading more… " + tracks.length + " tracks" });
      }
    } else if (loadingThis) {
      ch.push({ type: "loading", message: "Fetching tracks…" });
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks scraped</p>" });
    }
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
```

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Confirm the old static loading text is gone**

Run: `grep -n "Loading tracks…" index.js`
Expected: NO output (the old "Loading tracks…" text node was replaced by the `type:"loading"` nodes).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: progressive loading states in playlist detail view"
```

- [ ] **Step 5: (review follow-up) Disable Play in the header while loading**

Code review noted the detail-header Play button becomes enabled as soon as
`tracks.length > 0` mid-load, but clicking it opens a second browse window that
the `windowBusy` gate rejects → Play silently fails until the load finishes.
Gate it on `loadingThis`. Two sub-edits:

1. Hoist `loadingThis` to the top of `renderPlaylist` (and remove its later
   re-declaration before the `if (tracks.length > 0)`). Add after the `tracks`
   line:
   ```javascript
       var tracks = state.playlistTracks[pl.id] || [];
       var loadingThis = state.loadingTracksFor === pl.id;
   ```
   and change the tail's `var loadingThis = state.loadingTracksFor === pl.id;`
   back to just `if (tracks.length > 0) {` (no re-declaration).
2. Gate the header `playAction`:
   ```javascript
           playAction: (!loadingThis && tracks.length > 0) ? "play-current" : undefined,
   ```

Then `node --check index.js` (exit 0) and commit:
```bash
git add index.js
git commit -m "fix: disable header Play while tracks still loading"
```

**[MANUAL CHECKPOINT — full acceptance]** — Reload the plugin in the host (`DEVELOPING.md`) and verify:
1. Open an **uncached** playlist → first a centered spinner + "Fetching tracks…".
2. As scraping proceeds → track rows appear and grow, with a spinner + "Loading more… N tracks" footer. Rows show text-only (no art yet).
3. When the scrape finishes → footer disappears, full list shows, track images fill in.
4. Open an **already-loaded** playlist (within 24h) → full list renders instantly, no spinner.
5. Open a playlist, then click **back** before it finishes → no stuck spinner; reopening behaves correctly.
6. A playlist that scrapes empty/errors → falls back to old tracks (if any) or "No tracks scraped"; no stuck spinner.

---

## Self-Review Notes

**Spec coverage** (design section → task):
- `type:"loading"` primitive, before-first-rows state → Task 3 ("Fetching tracks…").
- Progressive rows while scraping + footer → Task 1 (partial array) + Task 2 (route to state) + Task 3 (footer node).
- In-memory only, no persist / no `tracksFetchedAt` stamp → Task 2 (branch writes only `state.playlistTracks`, returns before `settle`).
- Text-only images during load → Task 3 (rows pass `imageUrl: t.imageUrl || undefined`; mid-load that's a remote URL, localized after settle — no code needed beyond existing behavior).
- Per-tick re-render cadence → Task 2 (renders on every `tracks-progress`).
- Cached/fresh unchanged → no task touches the `tracksAreFresh` short-circuit in `openPlaylistById`; Task 3's `loadingThis` is false for cached playlists.
- Stale-gen / cancel / go-home handled → Task 2 (`gen` guard + `currentPlaylist.id` guard); `go-home` already clears `loadingTracksFor` (existing code).
- Error/empty via existing paths → unchanged (`retryOrFinish`/`settle`/keep-old guard untouched).

**Type/name consistency:** `tracks-progress` message shape `{playlistId, found, tracks, gen}` (Task 1) matches the consumer in Task 2 (`msg.data.gen`, `msg.data.tracks`, `msg.data.playlistId`). `state.loadingTracksFor`, `state.currentPlaylist`, `state.playlistTracks`, `renderPlaylist`, `gen`, `settle`, `retryOrFinish` all already exist in the surrounding code. View node `{type:"loading", message}` matches the host `plugin.ts` definition.

**Note on line numbers:** `~line N` references are pre-change and drift; anchor on the quoted find-strings and function names.
