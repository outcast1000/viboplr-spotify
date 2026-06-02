# "Include albums" Setting + Album Parsing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-visible "Include albums in sync" setting that, when enabled, scrapes Spotify albums alongside playlists and surfaces them as fully-functional (view / play / enqueue / save) entities.

**Architecture:** Approach A — albums are entries in the existing `state.playlists` array tagged with a `kind: "playlist" | "album"` field (default `"playlist"`, so legacy data needs no migration). The entire playlist pipeline (scrape → lazy-track fetch → cache → persist → render → home shelves) is reused; only navigation URL, the `targetKind` on cards, and `uri`/`source` formatting branch on `kind`. The shelf scraper becomes a builder gated on the new `includeAlbums` preference.

**Tech Stack:** Plain ES5-style JS in `index.js` (runs in the host's `new Function` sandbox — no imports, ends with `return { activate, deactivate }`). Node test harness in `scripts/` (`extract-scripts.mjs` + `*.test.mjs`, run via `npm test`). Playwright verify harness `scripts/verify-scrape.mjs`.

**Testing reality:** `index.js` cannot be unit-tested in isolation (host sandbox). Automated coverage exists ONLY for the extracted scrape-script strings via `scripts/extract-scripts.test.mjs` (run with `npm test`) and for whole-file parse via the `new Function` wrapper. Tasks touching scrape scripts (3, 4) get real automated tests. Tasks touching host-only wiring (1, 2, 5, 6) are verified by: (a) the `new Function` parse check below, and (b) explicit manual host steps. This is a deliberate limitation of the plugin runtime, not a gap in the plan.

**Reusable verification commands (referenced by tasks):**

- **PARSE CHECK** (whole-file, host-equivalent — plain `node --check` fails because package.json sets `"type":"module"` and the file ends in a top-level `return`):
  ```bash
  node -e 'const fs=require("fs");new Function("api","window","globalThis","self","document",fs.readFileSync("index.js","utf8"));console.log("OK: parses inside new Function wrapper")'
  ```
- **UNIT TESTS:** `npm test` (runs `node --test "scripts/**/*.test.mjs"`)

---

### Task 1: Add the `includeAlbums` setting (state, persistence, toggle, UI)

Adds the preference and its visible toggle. No scraping behavior changes yet — this task only makes the setting exist, persist, and render.

**Files:**
- Modify: `index.js` — `state` object (`index.js:17-44`), `savePreferences` (`index.js:579-587`), settings UI (`index.js:864`), new action handler (after `index.js:2417` block), preferences load (`index.js:2627-2638`)

- [ ] **Step 1: Add `includeAlbums` to `state`**

In `index.js`, in the `state` object, add the field after `debugLogging: false,` (line 28):

```javascript
    debugLogging: false,
    // When true, Sync also captures album cards (kind:"album") alongside
    // playlists. Off by default; applies on the next sync. See the
    // include-albums design spec.
    includeAlbums: false,
```

- [ ] **Step 2: Persist it in `savePreferences`**

Replace the `savePreferences` body's object (`index.js:580-586`):

```javascript
  function savePreferences() {
    api.storage.set("spotify_browse_preferences", {
      showBrowserOnRefresh: state.showBrowserOnRefresh,
      autoRefreshHours: state.autoRefreshHours,
      debugLogging: state.debugLogging,
      includeAlbums: state.includeAlbums,
      lastCheckAt: state.lastCheckAt,
      lastCheckResult: state.lastCheckResult,
    }).catch(console.error);
  }
```

- [ ] **Step 3: Load it at init**

In the "Load preferences" block (`index.js:2628-2633`), add the read after the `debugLogging` line:

```javascript
      if (prefs.debugLogging !== undefined) state.debugLogging = !!prefs.debugLogging;
      if (prefs.includeAlbums !== undefined) state.includeAlbums = !!prefs.includeAlbums;
```

- [ ] **Step 4: Render the toggle**

In `renderSettings`, after the "Debug logging" toggle (`index.js:864`), add:

```javascript
    ch.push({ type: "toggle", label: "Debug logging", checked: state.debugLogging, action: "toggle-debug-logging" });
    ch.push({ type: "toggle", label: "Include albums in sync", checked: state.includeAlbums, action: "toggle-include-albums" });
```

- [ ] **Step 5: Add the action handler**

In `index.js`, immediately after the existing `toggle-debug-logging` handler (which ends at `index.js:2420` with `});`), add:

```javascript
  api.ui.onAction("toggle-include-albums", function() {
    state.includeAlbums = !state.includeAlbums;
    savePreferences();
    renderSettings();
  });
```

- [ ] **Step 6: PARSE CHECK**

Run the **PARSE CHECK** command (see header).
Expected: `OK: parses inside new Function wrapper`

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat: add includeAlbums setting (state, persist, toggle UI)"
```

---

### Task 2: Add `kind` to the data model (persistence + entitySource helper)

Threads the `kind` field through save/load and adds the `entitySource` helper used later for URIs. Albums aren't produced yet, so `kind` is always `"playlist"` after this task — but the persistence round-trips it.

**Files:**
- Modify: `index.js` — `savePlaylist` meta (`index.js:314-324`), `loadPlaylistFromDisk` playlist object (`index.js:550-561`), new `entitySource` helper (add near `playlistDir`, before `savePlaylist`)

- [ ] **Step 1: Add the `entitySource` helper**

In `index.js`, immediately before `function savePlaylist(pl) {` (line 309), add:

```javascript
  // Host source/URI scheme for an entry, by kind. Albums use spotify://albums/,
  // everything else (playlists) spotify://playlists/.
  function entitySource(pl) {
    return (pl && pl.kind === "album" ? "spotify://albums/" : "spotify://playlists/") + pl.id;
  }
```

- [ ] **Step 2: Write `kind` into meta.json**

In `savePlaylist`, add `kind` to the meta object after the `cardSubtitle` line (`index.js:323`):

```javascript
      cardSubtitle: pl.cardSubtitle || "",
      kind: pl.kind || "playlist",
```

- [ ] **Step 3: Read `kind` back in `loadPlaylistFromDisk`**

In `loadPlaylistFromDisk`, in the `playlist` object literal (`index.js:550-561`), change the `uri` line to use `entitySource` and add `kind`. Replace:

```javascript
          var playlist = {
            id: meta.id,
            name: meta.name,
            section: meta.section || sectionName,
            description: meta.description || "",
            imageUrl: versionedCover,
            coverVersion: meta.coverVersion || null,
            uri: "spotify://playlists/" + meta.id,
            lastSyncedAt: meta.lastSyncedAt || null,
            tracksFetchedAt: meta.tracksFetchedAt || null,
            cardSubtitle: meta.cardSubtitle || "",
          };
```

with:

```javascript
          var playlist = {
            id: meta.id,
            name: meta.name,
            section: meta.section || sectionName,
            description: meta.description || "",
            imageUrl: versionedCover,
            coverVersion: meta.coverVersion || null,
            kind: meta.kind || "playlist",
            lastSyncedAt: meta.lastSyncedAt || null,
            tracksFetchedAt: meta.tracksFetchedAt || null,
            cardSubtitle: meta.cardSubtitle || "",
          };
          playlist.uri = entitySource(playlist);
```

(Note: `uri` is now set after the object exists, because `entitySource` reads `playlist.kind`.)

- [ ] **Step 4: PARSE CHECK**

Run the **PARSE CHECK** command.
Expected: `OK: parses inside new Function wrapper`

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: add kind field to data model + entitySource helper"
```

---

### Task 3: Convert the shelf scraper to a builder that can include albums

Turns the `SCRIPT_SCRAPE_SHELVES` constant into `scriptScrapeShelves(includeAlbums)`, widens its selectors/regex to capture `/album/` cards when asked, stamps `kind` on each card, and updates all three callers + the extraction map. This task HAS automated tests.

**Files:**
- Modify: `index.js` — shelf-script constant→builder (`index.js:1354-1544`), three callers (`index.js:974`, `index.js:1889`), and the de-dup key in the sweep
- Modify: `scripts/extract-scripts.mjs` (`scripts/extract-scripts.mjs:30-34`)
- Modify: `scripts/extract-scripts.test.mjs` (`scripts/extract-scripts.test.mjs:13-25`)

- [ ] **Step 1: Write the failing tests**

In `scripts/extract-scripts.test.mjs`, replace the two assertions about `SCRIPT_SCRAPE_SHELVES` (lines 13-14) and the parse assertion (line 25). First, change line 13-14 from:

```javascript
  assert.match(s.SCRIPT_SCRAPE_SHELVES, /^\(function\(\)\{/);
  assert.ok(s.SCRIPT_SCRAPE_SHELVES.includes("__viboplr"), "scrape script uses the send bridge");
```

to:

```javascript
  assert.equal(typeof s.scriptScrapeShelves, "function", "scriptScrapeShelves is a builder");
  const shelvesPlaylistsOnly = s.scriptScrapeShelves(false);
  const shelvesWithAlbums = s.scriptScrapeShelves(true);
  assert.match(shelvesPlaylistsOnly, /^\(function\(\)\{/);
  assert.ok(shelvesPlaylistsOnly.includes("__viboplr"), "scrape script uses the send bridge");
  assert.ok(!shelvesPlaylistsOnly.includes("/album/"), "playlists-only build omits /album/ selectors");
  assert.ok(shelvesWithAlbums.includes("/album/"), "albums build includes /album/ selectors");
```

Then change line 25 from:

```javascript
  assert.doesNotThrow(() => new Function(s.SCRIPT_SCRAPE_SHELVES), "SCRIPT_SCRAPE_SHELVES parses");
```

to:

```javascript
  assert.doesNotThrow(() => new Function(s.scriptScrapeShelves(false)), "scriptScrapeShelves(false) parses");
  assert.doesNotThrow(() => new Function(s.scriptScrapeShelves(true)), "scriptScrapeShelves(true) parses");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `s.scriptScrapeShelves is not a function` (the extraction map still exports `SCRIPT_SCRAPE_SHELVES`).

- [ ] **Step 3: Convert the constant to a builder in `index.js`**

In `index.js`, change the declaration line (`index.js:1354`) from:

```javascript
  var SCRIPT_SCRAPE_SHELVES = '(function(){try{' +
```

to:

```javascript
  // Build the home-shelf scraper. When includeAlbums is true, the generated
  // script also captures /album/ cards (kind:"album"); otherwise only
  // /playlist/ cards (kind:"playlist"), byte-identical to the original behavior.
  function scriptScrapeShelves(includeAlbums) {
    // Selector + regex fragments widen to album links only when requested.
    var linkSel = includeAlbums
      ? 'a[href*=\\"/playlist/\\"],a[href*=\\"/album/\\"]'
      : 'a[href*=\\"/playlist/\\"]';
    // idRe is a normal string in index.js (NOT nested inside the page-script
    // literal), so single-escape the backslashes: the VALUE must be the regex
    // literal /\/(playlist|album)\/([a-zA-Z0-9]+)/.
    var idRe = includeAlbums ? '/\\/(playlist|album)\\/([a-zA-Z0-9]+)/' : '/\\/(playlist)\\/([a-zA-Z0-9]+)/';
    return '(function(){try{' +
```

- [ ] **Step 4: Use the fragments inside the script body**

The shelf-script body has hardcoded `a[href*=\\"/playlist/\\"]` selectors and a `/\\/playlist\\/([a-zA-Z0-9]+)/` match. Make these use the fragments. There are FOUR edits inside the returned string:

(a) The sweep node selector (`index.js:1416`). Change:

```javascript
      'var nodes=main.querySelectorAll("h1,h2,h3,[role=\\"heading\\"],a[href*=\\"/playlist/\\"]");' +
```

to:

```javascript
      'var nodes=main.querySelectorAll("h1,h2,h3,[role=\\"heading\\"],' + linkSel + '");' +
```

(b) The heading-inside-card guard (`index.js:1421`). Change:

```javascript
          'if(el.closest("a[href*=\\"/playlist/\\"]"))continue;' +
```

to:

```javascript
          'if(el.closest("' + linkSel + '"))continue;' +
```

(c) The card-id match + kind capture (`index.js:1428`). Change:

```javascript
        'var m=(el.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
        'if(!m)continue;' +
```

to:

```javascript
        'var m=(el.getAttribute("href")||"").match(' + idRe + ');' +
        'if(!m)continue;' +
        'var _kind=m[1]==="album"?"album":"playlist";var _id=m[2];' +
```

(d) The `carousels()` link selector (`index.js:1479`). Change:

```javascript
      'var links=mainEl.querySelectorAll("a[href*=\\"/playlist/\\"]");' +
```

to:

```javascript
      'var links=mainEl.querySelectorAll("' + linkSel + '");' +
```

- [ ] **Step 5: Update the record build + de-dup to use the captured id/kind**

The body currently keys by `m[1]` (old id group) and builds the record without kind. The match now puts kind in `m[1]` and id in `m[2]` (captured into `_id`/`_kind` in Step 4c). Update the dedup/backfill/record block (`index.js:1442-1453`). Change:

```javascript
        'var existing=byId[m[1]];' +
        'if(existing){' +
          'if(!existing.imageUrl&&img)existing.imageUrl=img;' +
          'if(!existing.subtitle&&sub)existing.subtitle=sub;' +
          'if(!existing.name&&nm)existing.name=nm;' +
          'continue;' +
        '}' +
        'if(!nm)continue;' +
        'if(!cur){if(!shelfByName["Playlists"]){shelfByName["Playlists"]={section:"Playlists",description:"",playlists:[]};shelfOrder.push("Playlists");}cur=shelfByName["Playlists"];}' +
        'var rec={id:m[1],name:nm,subtitle:sub,imageUrl:img};' +
        'byId[m[1]]=rec;cur.playlists.push(rec);total++;' +
```

to:

```javascript
        'var _key=_kind+":"+_id;' +
        'var existing=byId[_key];' +
        'if(existing){' +
          'if(!existing.imageUrl&&img)existing.imageUrl=img;' +
          'if(!existing.subtitle&&sub)existing.subtitle=sub;' +
          'if(!existing.name&&nm)existing.name=nm;' +
          'continue;' +
        '}' +
        'if(!nm)continue;' +
        'if(!cur){if(!shelfByName["Playlists"]){shelfByName["Playlists"]={section:"Playlists",description:"",playlists:[]};shelfOrder.push("Playlists");}cur=shelfByName["Playlists"];}' +
        'var rec={id:_id,name:nm,subtitle:sub,imageUrl:img,kind:_kind};' +
        'byId[_key]=rec;cur.playlists.push(rec);total++;' +
```

- [ ] **Step 6: Close the builder function**

The script string currently ends (`index.js:1544`) with:

```javascript
    '}catch(e){window.__viboplr.send("error",{message:"scrape shelves: "+e})}})()';
```

Change it to close the new function wrapper (add `;` and `}`):

```javascript
    '}catch(e){window.__viboplr.send("error",{message:"scrape shelves: "+e})}})()';
  }
```

- [ ] **Step 7: Update the three callers**

(a) Step-debugger (`index.js:974`). Change:

```javascript
        dbgEvalAndWait(SCRIPT_SCRAPE_SHELVES, "shelves", 30000, function (data) {
```

to:

```javascript
        dbgEvalAndWait(scriptScrapeShelves(state.includeAlbums), "shelves", 30000, function (data) {
```

(b) Sync (`index.js:1889`). Change:

```javascript
            h.eval(SCRIPT_SCRAPE_SHELVES);
```

to:

```javascript
            h.eval(scriptScrapeShelves(state.includeAlbums));
```

(c) The comment at `index.js:1749` mentions `SCRIPT_SCRAPE_SHELVES` — leave it (it's prose referencing the scraper concept; harmless).

- [ ] **Step 8: Update the extraction map**

In `scripts/extract-scripts.mjs`, change the `out` object (line 31) from:

```javascript
    SCRIPT_SCRAPE_SHELVES: sandbox.SCRIPT_SCRAPE_SHELVES,
```

to:

```javascript
    scriptScrapeShelves: sandbox.scriptScrapeShelves,
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (2 tests). If the extraction "produced no value" error fires, the builder name in `index.js` doesn't match the map key — reconcile.

- [ ] **Step 10: PARSE CHECK**

Run the **PARSE CHECK** command.
Expected: `OK: parses inside new Function wrapper`

- [ ] **Step 11: Commit**

```bash
git add index.js scripts/extract-scripts.mjs scripts/extract-scripts.test.mjs
git commit -m "feat: scriptScrapeShelves builder captures albums when enabled"
```

---

### Task 4: Track scraper navigates by kind

Adds a `kind` parameter to the navigation + scroll-scrape builders so album track pages load from `/album/<id>`. Album pages reuse the same row selectors. This task HAS an automated test.

**Files:**
- Modify: `index.js` — `scriptNavigatePlaylist` (`index.js:1546-1552`), `scriptScrollThenScrape` signature + nav diagnostics (`index.js:1554-...`), `ensureTracks` two call sites (`index.js:1959,1962,1995,1998`)
- Modify: `scripts/extract-scripts.test.mjs` (add album-nav assertions)

- [ ] **Step 1: Write the failing test**

In `scripts/extract-scripts.test.mjs`, after the existing `scriptNavigatePlaylist`/`scriptScrollThenScrape` assertions (lines 19-20), add:

```javascript
  assert.match(s.scriptNavigatePlaylist("abc123", "album"), /\/album\/abc123/);
  assert.match(s.scriptNavigatePlaylist("abc123", "playlist"), /\/playlist\/abc123/);
  assert.match(s.scriptNavigatePlaylist("abc123"), /\/playlist\/abc123/);
  assert.match(s.scriptScrollThenScrape("abc123", 7, { kind: "album" }), /\/album\//);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `scriptNavigatePlaylist("abc123","album")` still produces `/playlist/abc123` (no `/album/` match).

- [ ] **Step 3: Add `kind` to `scriptNavigatePlaylist`**

Replace `scriptNavigatePlaylist` (`index.js:1546-1552`):

```javascript
  function scriptNavigatePlaylist(id, kind) {
    var path = kind === "album" ? "/album/" : "/playlist/";
    return '(function(){' +
      DBG_HELPER +
      '_dbg("tracks","navigating to ' + path + id + '");' +
      'window.location.href="' + path + id + '"' +
    '})()';
  }
```

- [ ] **Step 4: Thread `kind` through `scriptScrollThenScrape` nav diagnostics**

In `scriptScrollThenScrape`, the `opts` already exists (`index.js:1555`: `var maxSteps = (opts && opts.maxSteps) || 60;`). Add a kind read on the next line:

```javascript
  function scriptScrollThenScrape(playlistId, gen, opts) {
    var maxSteps = (opts && opts.maxSteps) || 60;
    var entityPath = (opts && opts.kind === "album") ? "/album/" : "/playlist/";
```

Then find the START diagnostic line inside the returned string (it reads `'_dbg("tracks","=== START scrape for ' + playlistId + '"'`) and the navigation is driven by `ensureTracks` separately, so the only in-string use of the path is diagnostic. Locate the `=== START scrape` line and change its trailing context to include the path. Change:

```javascript
      '_dbg("tracks","=== START scrape for ' + playlistId + '",{url:location.href,gen:_gen});' +
```

to:

```javascript
      '_dbg("tracks","=== START scrape for ' + entityPath + playlistId + '",{url:location.href,gen:_gen});' +
```

(The scroll/parse selectors are kind-agnostic — album track rows use the same `[role="row"]` / `a[href*="/track/"]` shape, so no parsing changes are needed.)

- [ ] **Step 5: Pass `pl.kind` through `ensureTracks`**

`ensureTracks` calls the builders in two places (initial attempt + retry). Update all four lines.

Retry block (`index.js:1959-1962`). Change:

```javascript
            h.eval(scriptNavigatePlaylist(pl.id));
            setTimeout(function () {
              if (ctx.isStale()) { settle(oldTracks); return; }
              h.eval(scriptScrollThenScrape(pl.id, gen, { maxSteps: maxSteps }));
```

to:

```javascript
            h.eval(scriptNavigatePlaylist(pl.id, pl.kind));
            setTimeout(function () {
              if (ctx.isStale()) { settle(oldTracks); return; }
              h.eval(scriptScrollThenScrape(pl.id, gen, { maxSteps: maxSteps, kind: pl.kind }));
```

Initial-attempt block (`index.js:1995-1998`). Change:

```javascript
        h.eval(scriptNavigatePlaylist(pl.id));
        setTimeout(function () {
          if (ctx.isStale()) { settle(oldTracks); return; }
          h.eval(scriptScrollThenScrape(pl.id, gen, { maxSteps: maxSteps }));
```

to:

```javascript
        h.eval(scriptNavigatePlaylist(pl.id, pl.kind));
        setTimeout(function () {
          if (ctx.isStale()) { settle(oldTracks); return; }
          h.eval(scriptScrollThenScrape(pl.id, gen, { maxSteps: maxSteps, kind: pl.kind }));
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS (2 tests).

- [ ] **Step 7: PARSE CHECK**

Run the **PARSE CHECK** command.
Expected: `OK: parses inside new Function wrapper`

- [ ] **Step 8: Commit**

```bash
git add index.js scripts/extract-scripts.test.mjs
git commit -m "feat: track scraper navigates to /album/ for album entries"
```

---

### Task 5: Sync handler stamps `kind`; survivors carry it

Makes `syncPlaylists` copy each scraped card's `kind` onto the state entry (and set `uri` via `entitySource`), and makes `applySyncResult` carry `kind` over for surviving entries.

**Files:**
- Modify: `index.js` — `syncPlaylists` shelves handler (`index.js:1863-1874`), `applySyncResult` survivor carry-over (locate via grep)

- [ ] **Step 1: Stamp `kind` + `uri` on new entries in `syncPlaylists`**

In the shelves message handler, replace the `playlists.push({...})` object (`index.js:1863-1874`):

```javascript
                playlists.push({
                  id: raw.id,
                  name: raw.name,
                  section: name,
                  description: "",
                  cardSubtitle: raw.subtitle || "",
                  imageUrl: raw.imageUrl || null,
                  coverVersion: null,
                  uri: "spotify://playlists/" + raw.id,
                  lastSyncedAt: new Date().toISOString(),
                  tracksFetchedAt: null,
                });
```

with:

```javascript
                var np = {
                  id: raw.id,
                  name: raw.name,
                  section: name,
                  description: "",
                  cardSubtitle: raw.subtitle || "",
                  imageUrl: raw.imageUrl || null,
                  coverVersion: null,
                  kind: raw.kind === "album" ? "album" : "playlist",
                  lastSyncedAt: new Date().toISOString(),
                  tracksFetchedAt: null,
                };
                np.uri = entitySource(np);
                playlists.push(np);
```

- [ ] **Step 2: Carry `kind` over for survivors in `applySyncResult`**

Find the survivor carry-over block:

```bash
grep -n "np.tracksFetchedAt = old.tracksFetchedAt" index.js
```

It sits inside `applySyncResult` in a loop like:

```javascript
      var old = oldById[np.id];
      if (old) {
        np.tracksFetchedAt = old.tracksFetchedAt || null;
        if (!np.imageUrl && old.imageUrl) np.imageUrl = old.imageUrl;
        if (!np.cardSubtitle && old.cardSubtitle) np.cardSubtitle = old.cardSubtitle;
      }
```

Add a `kind` carry-over inside the `if (old)` block (after the `tracksFetchedAt` line), so a survivor that somehow arrived without kind keeps its prior one:

```javascript
        np.tracksFetchedAt = old.tracksFetchedAt || null;
        if (!np.kind && old.kind) np.kind = old.kind;
        if (!np.imageUrl && old.imageUrl) np.imageUrl = old.imageUrl;
        if (!np.cardSubtitle && old.cardSubtitle) np.cardSubtitle = old.cardSubtitle;
```

- [ ] **Step 3: PARSE CHECK**

Run the **PARSE CHECK** command.
Expected: `OK: parses inside new Function wrapper`

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sync stamps kind on scraped entries and carries it for survivors"
```

---

### Task 6: Rendering branches on `kind` (cards, shelves, sources, detail meta)

Surfaces albums correctly: `targetKind:"album"` on cards, `entitySource` for the context-menu/save sources, and an "Album · N tracks" detail header.

**Files:**
- Modify: `index.js` — `buildPlaylistCards` (`index.js:695-700`), `buildShelfFetcher` item (`index.js:2490-2498`), `playlistContextPayload` (`index.js:2288-2295`), `savePlaylistToApp` (`index.js:2374-2376`), `renderPlaylist` headerMeta (`index.js:780-781`)

- [ ] **Step 1: Card `targetKind` in `buildPlaylistCards`**

In the card object (`index.js:695-700`), change:

```javascript
        id: "playlist:" + sp.id,
        title: sp.name,
        subtitle: sub,
        imageUrl: sp.imageUrl,
        action: "view-playlist",
        targetKind: "playlist",
```

to:

```javascript
        id: "playlist:" + sp.id,
        title: sp.name,
        subtitle: sub,
        imageUrl: sp.imageUrl,
        action: "view-playlist",
        targetKind: sp.kind === "album" ? "album" : "playlist",
```

(The `id` prefix stays `"playlist:"` — it's an internal action-routing key parsed by `parsePlaylistId`, unrelated to entity kind. Changing it would break routing.)

- [ ] **Step 2: Home-shelf card `targetKind` in `buildShelfFetcher`**

In the `items.map` return object (`index.js:2490-2498`), add `targetKind`:

```javascript
          return {
            id: String(pl.id),
            name: pl.name || "Unknown",
            coverUrl: pl.imageUrl || null,
            subtitle: pl.description || undefined,
            targetKind: pl.kind === "album" ? "album" : "playlist",
            tracks: toPluginTracks(rawTracks),
          };
```

- [ ] **Step 3: `playlistContextPayload` source via `entitySource`**

In `playlistContextPayload` (`index.js:2292`), change:

```javascript
      source: "spotify://playlists/" + pl.id,
```

to:

```javascript
      source: entitySource(pl),
```

- [ ] **Step 4: `savePlaylistToApp` source via `entitySource`**

In `savePlaylistToApp` (`index.js:2376`), change:

```javascript
      source: "spotify://playlists/" + pl.id,
```

to:

```javascript
      source: entitySource(pl),
```

- [ ] **Step 5: Detail header meta in `renderPlaylist`**

Change the headerMeta init (`index.js:780`):

```javascript
    var headerMeta = tracks.length + " tracks";
```

to:

```javascript
    var headerMeta = (pl.kind === "album" ? "Album · " : "") + tracks.length + " tracks";
```

- [ ] **Step 6: PARSE CHECK**

Run the **PARSE CHECK** command.
Expected: `OK: parses inside new Function wrapper`

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat: render albums (targetKind, entity source, Album detail meta)"
```

---

### Task 7: Verify harness supports album scraping

Updates the Playwright harness to call the new builder and exposes an `includeAlbums` option so the report can exercise albums.

**Files:**
- Modify: `scripts/verify-scrape.mjs` — DEFAULTS (`scripts/verify-scrape.mjs` options block), `resolveOptions`, the shelf-scrape call (`scripts/verify-scrape.mjs:345`)

- [ ] **Step 1: Add `includeAlbums` to DEFAULTS**

In `scripts/verify-scrape.mjs`, in the `DEFAULTS` object, add after `debug:`:

```javascript
  debug: false,          // log the page's _dbg messages to the console
  includeAlbums: false,  // also scrape /album/ cards (kind:"album")
```

- [ ] **Step 2: Resolve it from env/file**

In `resolveOptions`, in the returned object (after the `debug:` line), add:

```javascript
    debug: pick("debug", envBool("VERIFY_DEBUG")),
    includeAlbums: pick("includeAlbums", envBool("VERIFY_ALBUMS")),
```

- [ ] **Step 3: Call the builder**

Change the shelf-scrape line (`scripts/verify-scrape.mjs:345`) from:

```javascript
    await page.evaluate((s) => eval(s), S.SCRIPT_SCRAPE_SHELVES);
```

to:

```javascript
    await page.evaluate((s) => eval(s), S.scriptScrapeShelves(OPTS.includeAlbums));
```

- [ ] **Step 4: Verify the harness parses**

Run: `node --check scripts/verify-scrape.mjs`
Expected: (no output — exit 0)

- [ ] **Step 5: Run unit tests (confirm extraction still matches)**

Run: `npm test`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-scrape.mjs
git commit -m "feat(verify): scrape albums when VERIFY_ALBUMS / includeAlbums set"
```

---

### Task 8: Version bump + CHANGELOG + manual verification

**Files:**
- Modify: `manifest.json`, `CHANGELOG.md` (via `scripts/bump.sh`)

- [ ] **Step 1: Bump the patch version**

Run: `bash scripts/bump.sh patch`
Expected: prints `Bumped 1.12.5 -> 1.12.6` (or current+1) and stamps a CHANGELOG section.

- [ ] **Step 2: Fill in the CHANGELOG entry**

In `CHANGELOG.md`, replace the `- TODO: describe changes` line under the new version with:

```markdown
- New setting **"Include albums in sync"** (off by default). When enabled, Sync
  also captures album cards from the Music home alongside playlists; albums open
  a detail view with their tracklist and support Play / Enqueue / Save to
  Playlists, exactly like playlists. Disable it and re-sync to remove albums.
```

- [ ] **Step 3: Manual host verification (record results)**

This cannot be automated (host sandbox). In the Viboplr host with this plugin loaded:
1. Settings → toggle **Include albums in sync** ON.
2. Click **Sync**. Expected: album cards appear in shelves alongside playlists.
3. Click an album card → detail view shows its tracklist (scraped from `/album/<id>`).
4. Press Play and Enqueue on the album → tracks load into the queue.
5. Context menu → **Save to Playlists** → album saved as an app playlist (album title + date).
6. Toggle the setting OFF → **Sync** again → albums disappear; playlists remain.

- [ ] **Step 4: Commit the release**

```bash
git add manifest.json CHANGELOG.md
git commit -m "Release v$(node -e 'console.log(require("./manifest.json").version)')"
```

---

## Self-review notes

- **Spec coverage:** setting+default+persist (Task 1), `kind` model+migration-free load (Task 2), shelf builder+album selectors (Task 3), album navigation (Task 4), sync stamping+survivor carry + removal-on-toggle-off via existing `applySyncResult` delete path (Task 5), rendering/targetKind/entitySource/save (Task 6), verify harness (Task 7), release (Task 8). All spec sections map to a task.
- **Type/name consistency:** `entitySource(pl)` defined in Task 2, used in Tasks 2/5/6. `scriptScrapeShelves(includeAlbums)` defined Task 3, used Tasks 3/7. `scriptNavigatePlaylist(id, kind)` / `scriptScrollThenScrape(id, gen, {kind})` defined Task 4, used Task 4. `kind` values are exactly `"playlist"|"album"` everywhere.
- **No placeholders:** every code step shows complete before/after.
- **Removal semantics:** no dedicated task — by design it falls out of the existing `applySyncResult` dir-deletion path (noted in Task 5 self-review line and the spec).
