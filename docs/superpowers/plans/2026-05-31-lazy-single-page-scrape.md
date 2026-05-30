# Lazy Single-Page Scrape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the eager section-discovery + per-playlist track-scrape pipeline with a single scrape of `open.spotify.com/home?facet=music-chip` (grouped by shelf) plus lazy, 24h-cached track fetching on View/Play/Enqueue.

**Architecture:** One `index.js` file runs inside the host WebView sandbox (`new Function(...)` body, ending in `return { activate, deactivate }`). Sync now loads one page and scrapes all playlist cards across shelves; tracks are fetched on demand via `ensureTracks(pl)` and cached on disk with a `tracksFetchedAt` timestamp. A shared `withSpotifyWindow(visible, fn)` helper wraps the kept login flow.

**Tech Stack:** Plain ES5-style JS (`var`/`function` by convention), no build step, frozen sandbox globals. Host bridge is `api.*` (no `fetch`, no DOM, no `require`). DOM scraping is done by `eval`-ing string scripts into an embedded browse window.

---

## Testing Approach (read before starting)

**There is no test harness for this plugin** — no `package.json`, no Node/browser dev environment. The sandbox runs inside the host app's WebView. Per `DEVELOPING.md`, the real dev loop is install/symlink into the host and reload.

Therefore each task uses a **two-gate** verification instead of unit tests:

1. **Automated gate (every task):** `node --check index.js` must pass (syntax). Node 22 is available.
2. **Manual gate (grouped checkpoints):** After the task groups marked **[MANUAL CHECKPOINT]**, reload the plugin in the host app and verify the described behavior. These are the real acceptance tests. If you cannot run the host app, mark the checkpoint as deferred and continue — do not block.

Commit after every task (the syntax gate having passed). Keep commits small.

**Reference docs in repo:** `SPEC.md` (architecture), `DEVELOPING.md` (reload loop, DevTools, `api.log`), `jsguide.md` (selectors), and the design at `docs/superpowers/specs/2026-05-31-lazy-single-page-scrape-design.md`.

---

## File Structure

This change is confined to a single file plus doc updates:

- **Modify:** `index.js` — all logic.
- **Modify:** `SPEC.md` — architecture doc (final task).
- **Modify:** `CHANGELOG.md` + `manifest.json` version (final task, via `scripts/bump.sh`).

`index.js` is one large file by existing convention; we keep it that way (the sandbox loads one file). New functions are added near related existing code; removals are noted with exact anchors.

### Ordering rationale

We build the new pieces **before** deleting the old ones so the file always parses and the plugin stays loadable:

1. Add the 24h cache field + helpers (data layer).
2. Add `withSpotifyWindow` + `SCRIPT_SCRAPE_SHELVES` + `syncPlaylists` (new sync).
3. Add `ensureTracks` (lazy tracks).
4. Rewire actions (View/Play/Enqueue/sync/auto-refresh) to the new functions.
5. Rewire rendering (derived sections, loading state, drop pinned Liked card).
6. Delete dead code (section discovery, Liked Songs, eager track phase, section-config actions).
7. Migration + cleanup, docs, version bump.

---

## Task 1: Add `tracksFetchedAt` to the on-disk meta + cache-freshness helper

**Files:**
- Modify: `index.js` — `savePlaylist` (~line 507), `loadPlaylistFromDisk` (~line 716), add a new helper near `formatSyncTime` (~line 882).

- [ ] **Step 1: Add the freshness constant + helper**

Add near the top of `activate`, just after the `state` object (after line 36) — a constant and a pure helper:

```javascript
  // Lazy-track cache TTL. Tracks scraped on demand are reused for this long
  // before a View/Play triggers a fresh scrape. See the lazy-single-page spec.
  var TRACKS_TTL_MS = 24 * 60 * 60 * 1000;

  // True if this playlist's cached tracks are still fresh (within TTL) AND we
  // actually have tracks in memory for it. Missing/old tracksFetchedAt => stale.
  function tracksAreFresh(pl) {
    if (!pl || !pl.tracksFetchedAt) return false;
    var t = Date.parse(pl.tracksFetchedAt);
    if (isNaN(t)) return false;
    var tracks = state.playlistTracks[pl.id];
    if (!tracks || tracks.length === 0) return false;
    return (Date.now() - t) < TRACKS_TTL_MS;
  }
```

- [ ] **Step 2: Persist `tracksFetchedAt` in `savePlaylist`**

In `savePlaylist` (the `writeJson` for `meta.json`, ~line 512-520), add the field. Find:

```javascript
      coverVersion: pl.coverVersion || null,
      lastSyncedAt: pl.lastSyncedAt || null,
    }).catch(function (e) { console.error("Failed to write meta:", pl.id, e); });
```

Replace with:

```javascript
      coverVersion: pl.coverVersion || null,
      lastSyncedAt: pl.lastSyncedAt || null,
      tracksFetchedAt: pl.tracksFetchedAt || null,
      cardSubtitle: pl.cardSubtitle || "",
    }).catch(function (e) { console.error("Failed to write meta:", pl.id, e); });
```

- [ ] **Step 3: Restore `tracksFetchedAt` in `loadPlaylistFromDisk`**

In `loadPlaylistFromDisk` (~line 750), the `playlist` object literal. Find:

```javascript
            coverVersion: meta.coverVersion || null,
            uri: "spotify://playlists/" + meta.id,
            lastSyncedAt: meta.lastSyncedAt || null,
          };
```

Replace with:

```javascript
            coverVersion: meta.coverVersion || null,
            uri: "spotify://playlists/" + meta.id,
            lastSyncedAt: meta.lastSyncedAt || null,
            tracksFetchedAt: meta.tracksFetchedAt || null,
            cardSubtitle: meta.cardSubtitle || "",
          };
```

- [ ] **Step 4: Syntax gate**

Run: `node --check index.js`
Expected: exits 0, no output.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: add tracksFetchedAt cache field + tracksAreFresh helper"
```

---

## Task 2: Add the `withSpotifyWindow` login helper

**Files:**
- Modify: `index.js` — add a new function just above `performScrape` (~line 1898, the `// ---- Consolidated scrape function ----` comment).

This extracts the open + login-poll + sign-in-banner flow (currently inlined in `performScrape` lines ~1962-2060) into a reusable helper. We do **not** delete `performScrape` yet — Task 6 removes it once nothing calls it.

- [ ] **Step 1: Add `withSpotifyWindow`**

Insert immediately before the `// ---- Consolidated scrape function ----` comment (~line 1898):

```javascript
  // ---- Shared browse-window + login helper ----

  // Open a Spotify browse window, wait until logged in (surfacing a sign-in
  // banner after a short grace period, exactly like the old performScrape), then
  // run fn(handle, ctx) and resolve with its result. The window is always closed
  // when fn settles, on cancel (generation bump), or if the user closes it.
  //
  //   url:     page to load (defaults to the music-chip home).
  //   visible: open the window visibly (else headless).
  //   fn:      function(handle, ctx) -> Promise. ctx exposes { gen } and
  //            registers a single message handler via ctx.setHandler(fn).
  //
  // Resolves null if the scrape was cancelled or the window closed before login.
  var MUSIC_CHIP_URL = "https://open.spotify.com/home?facet=music-chip";

  function withSpotifyWindow(opts, fn) {
    var url = (opts && opts.url) || MUSIC_CHIP_URL;
    var visible = !!(opts && opts.visible);

    return new Promise(function (resolve, reject) {
      var handle = null;
      var gen = ++scrapeGeneration;
      var loginTimer = null;
      var settled = false;
      var currentHandler = null;

      function cleanup() {
        if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
        if (handle) { handle.close().catch(console.error); handle = null; }
        activeScrapeHandle = null;
      }
      function finish(val) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      }
      function failWith(err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }

      var ctx = {
        gen: gen,
        setHandler: function (h) { currentHandler = h; },
        isStale: function () { return gen !== scrapeGeneration; },
      };

      api.network.openBrowseWindow(url, {
        title: "Spotify",
        width: 1200,
        height: 800,
        visible: visible,
      }).then(function (h) {
        handle = h;
        activeScrapeHandle = h;
        recordPageVisit(url, "open");
        if (h.onNavigation) {
          h.onNavigation(function (u) { recordPageVisit(u, "navigate"); });
        }

        var loginRetries = 0;
        var LOGIN_GRACE_POLLS = 2;
        var loginPromptShown = false;

        function promptForLogin() {
          if (loginPromptShown) return;
          loginPromptShown = true;
          plog("warn", "login", "Not logged in to Spotify — surfacing window for sign-in");
          h.eval(SCRIPT_LOGIN_BANNER);
          h.show().catch(function (e) { console.error("Failed to show Spotify window:", e); });
          api.ui.showNotification("Please log in to Spotify in the window that just opened, then it will continue.");
        }

        h.onMessage(function (msg) {
          if (msg.type === "window-closed") { finish(null); return; }
          if (msg.type === "dbg" && msg.data) {
            plog(msg.data.level || "info", "browser:" + (msg.data.tag || "?"), msg.data.msg || "", msg.data.data);
            return;
          }
          if (msg.type === "login-check" && msg.data && msg.data.loggedIn && loginTimer) {
            clearInterval(loginTimer); loginTimer = null;
            if (loginPromptShown) {
              h.eval(SCRIPT_REMOVE_LOGIN_BANNER);
              if (!visible) h.hide().catch(function (e) { console.error("Failed to re-hide Spotify window:", e); });
            }
            // Hand control to fn. Route subsequent messages to its handler.
            Promise.resolve()
              .then(function () { return fn(h, ctx); })
              .then(function (val) { finish(val); })
              .catch(function (e) { failWith(e); });
            return;
          }
          if (currentHandler) currentHandler(msg);
        });

        function checkLogin() {
          if (ctx.isStale() || !handle) {
            if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
            return;
          }
          loginRetries++;
          if (loginRetries > LOGIN_GRACE_POLLS) promptForLogin();
          h.eval(SCRIPT_CHECK_LOGIN);
        }
        loginTimer = setInterval(checkLogin, 3000);
        setTimeout(checkLogin, 1500);
      }).catch(failWith);
    });
  }
```

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add withSpotifyWindow shared login helper"
```

---

## Task 3: Add the `SCRIPT_SCRAPE_SHELVES` injected script

**Files:**
- Modify: `index.js` — add after `SCRIPT_SCRAPE_PLAYLISTS` (~line 1751, before `scriptNavigatePlaylist`).

This is the new DOM scraper: scroll the page to materialize lazy shelves, then walk each shelf container, read its heading, and collect playlist cards with covers. Reuses `DBG_HELPER` and `IMG_HELPER` (defined earlier in the file).

- [ ] **Step 1: Add the script**

Insert just before `function scriptNavigatePlaylist(id)` (~line 1753):

```javascript
  // Scrape all playlist cards on the music-chip home page, grouped by shelf.
  // Strategy: scroll to bottom to materialize lazy shelves, then for each shelf
  // container (section / heading + card row) read the heading text + description
  // and collect a[href*="/playlist/"] cards within it (with each card's subtitle
  // text). Dedupe by playlist id across shelves (first shelf wins as the
  // section). Sends a "shelves" message:
  //   { shelves: [{ section, description, playlists: [{id,name,subtitle,imageUrl}] }], total }
  var SCRIPT_SCRAPE_SHELVES = '(function(){try{' +
    DBG_HELPER +
    IMG_HELPER +
    'function findImgContainer(el){var node=el;for(var up=0;up<6&&node;up++){var img=bestImg(node);if(img)return img;node=node.parentElement;}return null;}' +
    // Find the heading text for a shelf container.
    'function shelfHeading(sec){' +
      'var h=sec.querySelector("h1,h2,h3,[role=\\"heading\\"]");' +
      'if(h){var t=(h.textContent||"").trim();if(t)return t;}' +
      'var aria=sec.getAttribute("aria-label");' +
      'return aria?aria.trim():"";' +
    '}' +
    // Shelf description: the gray text line near the heading. Heuristic — the
    // first <p> or <span> in the shelf whose text differs from the heading and
    // isn't itself a card subtitle (not inside a playlist link). Best-effort.
    'function shelfDescription(sec,title){' +
      'var cands=sec.querySelectorAll("p,span");' +
      'for(var d=0;d<cands.length;d++){' +
        'var c=cands[d];' +
        'if(c.closest("a[href*=\\"/playlist/\\"]"))continue;' +
        'var t=(c.textContent||"").trim();' +
        'if(t&&t!==title&&t.length>10&&t.length<200)return t;' +
      '}' +
      'return "";' +
    '}' +
    // Card subtitle: walk up from the playlist link to the card container, then
    // take the first text that differs from the card name. Best-effort.
    'function cardSubtitle(la,nm){' +
      'var card=la;' +
      'for(var up=0;up<5&&card;up++){if(card.parentElement)card=card.parentElement;else break;}' +
      'if(!card)return "";' +
      'var cands=card.querySelectorAll("p,span");' +
      'for(var i=0;i<cands.length;i++){' +
        'var t=(cands[i].textContent||"").trim();' +
        'if(t&&t!==nm&&nm.indexOf(t)===-1&&t.indexOf(nm)===-1&&t.length<200)return t;' +
      '}' +
      'return "";' +
    '}' +
    'function collect(){' +
      'var main=document.querySelector("main")||document.body;' +
      // Shelf containers: <section> elements are how Spotify groups home shelves.
      // Fall back to any element that directly holds a heading + playlist links.
      'var sections=main.querySelectorAll("section");' +
      '_dbg("shelves","sections found",{count:sections.length});' +
      'var shelves=[];var seen={};var total=0;' +
      'for(var s=0;s<sections.length;s++){' +
        'var sec=sections[s];' +
        'var title=shelfHeading(sec)||("Section "+(s+1));' +
        'var descr=shelfDescription(sec,title);' +
        'var links=sec.querySelectorAll("a[href*=\\"/playlist/\\"]");' +
        'var pls=[];' +
        'for(var i=0;i<links.length;i++){' +
          'var la=links[i];' +
          'var m=(la.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
          'if(!m||seen[m[1]])continue;seen[m[1]]=1;' +
          'var nm=(la.textContent||"").trim();' +
          'if(!nm)continue;' +
          'var img=findImgContainer(la);' +
          'var sub=cardSubtitle(la,nm);' +
          'pls.push({id:m[1],name:nm,subtitle:sub,imageUrl:img});total++;' +
        '}' +
        'if(pls.length>0)shelves.push({section:title,description:descr,playlists:pls});' +
      '}' +
      '_dbg("shelves","DONE",{shelfCount:shelves.length,total:total});' +
      'window.__viboplr.send("shelves",{shelves:shelves,total:total});' +
    '}' +
    // Scroll the page to bottom first so lazy shelves render, then collect.
    'var sc=document.scrollingElement||document.documentElement;' +
    'var ticks=0;var lastH=-1;var stable=0;' +
    'function scrollTick(){' +
      'ticks++;sc.scrollTop=sc.scrollHeight;' +
      'var h=sc.scrollHeight;' +
      'if(h===lastH){stable++;}else{stable=0;lastH=h;}' +
      'if(stable>=3||ticks>=40){sc.scrollTop=0;setTimeout(collect,400);return;}' +
      'setTimeout(scrollTick,300);' +
    '}' +
    'scrollTick();' +
    '}catch(e){window.__viboplr.send("error",{message:"scrape shelves: "+e})}})()';
```

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add SCRIPT_SCRAPE_SHELVES single-page shelf scraper"
```

---

## Task 4: Add `syncPlaylists()` — the new single-page sync

**Files:**
- Modify: `index.js` — add after `withSpotifyWindow` (Task 2's function, ~line 1898 region).

Produces `{ playlists, sections, sectionDescriptions }`. No tracks are scraped (those are lazy). Each playlist carries its derived `section` and the scraped `cardSubtitle` (shown on the card until tracks are fetched). `sectionDescriptions` maps section name → shelf description string. Reuses `beginReport`/`finishReport` for diagnostics.

- [ ] **Step 1: Add `syncPlaylists`**

Insert right after the closing `}` of `withSpotifyWindow`:

```javascript
  // New single-page sync: scrape the music-chip home page once, grouping
  // playlists by shelf. Resolves { playlists, sections, sectionDescriptions }
  // (no tracks — those are fetched lazily). Resolves null if cancelled / not
  // signed in.
  function syncPlaylists(visible, trigger) {
    beginReport(trigger || "sync", ["(music-chip home)"]);
    return withSpotifyWindow({ url: MUSIC_CHIP_URL, visible: visible }, function (h, ctx) {
      return new Promise(function (resolve) {
        // Give the SPA a moment to render the home shell before scraping.
        var done = false;
        function finishScrape(playlists, sections, sectionDescriptions) {
          if (done) return;
          done = true;
          resolve({ playlists: playlists, sections: sections, sectionDescriptions: sectionDescriptions || {} });
        }

        ctx.setHandler(function (msg) {
          if (msg.type === "error" && msg.data) {
            plog("warn", "shelves", "scrape error: " + msg.data.message);
            finishScrape([], [], {});
            return;
          }
          if (msg.type === "shelves" && msg.data && Array.isArray(msg.data.shelves)) {
            var shelves = msg.data.shelves;
            var playlists = [];
            var sections = [];
            var sectionDescriptions = {};
            var seen = {};
            for (var si = 0; si < shelves.length; si++) {
              var sec = shelves[si];
              var name = sec.section || ("Section " + (si + 1));
              if (sections.indexOf(name) === -1) {
                sections.push(name);
                if (sec.description) sectionDescriptions[name] = sec.description;
              }
              for (var pi = 0; pi < sec.playlists.length; pi++) {
                var raw = sec.playlists[pi];
                if (seen[raw.id]) continue;
                seen[raw.id] = true;
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
              }
            }
            dbg("flow", "music-chip scrape: " + playlists.length + " playlists across " + sections.length + " shelves");
            finishScrape(playlists, sections, sectionDescriptions);
          }
        });

        // Navigate to the music-chip page (the window opened there already, but
        // re-assert in case login redirected away), then scrape after render.
        setTimeout(function () {
          if (ctx.isStale()) { finishScrape([], [], {}); return; }
          h.eval('window.location.href=' + JSON.stringify(MUSIC_CHIP_URL));
          setTimeout(function () {
            if (ctx.isStale()) { finishScrape([], [], {}); return; }
            h.eval(SCRIPT_SCRAPE_SHELVES);
          }, 4000);
        }, 1000);
      });
    }).then(function (res) {
      finishReport(res ? "ok" : "cancelled");
      return res;
    }).catch(function (err) {
      finishReport("error", err && err.message ? err.message : String(err));
      throw err;
    });
  }
```

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add syncPlaylists single-page sync"
```

---

## Task 5: Add `ensureTracks(pl)` — lazy track fetch + cache

**Files:**
- Modify: `index.js` — add after `syncPlaylists` (Task 4).

Fetches one playlist's tracks on demand. Returns cached tracks if fresh; otherwise scrapes via the kept `scriptScrollThenScrape`, applies the keep-old-on-empty guard, stamps `tracksFetchedAt`, writes to disk, and caches images.

- [ ] **Step 1: Add `ensureTracks`**

Insert right after the closing `}` of `syncPlaylists`:

```javascript
  // Fetch & cache tracks for a single playlist on demand. Resolves the track
  // array. Uses the on-disk cache when fresh (within TRACKS_TTL_MS). On a fresh
  // scrape, keeps old tracks if the new scrape comes back empty (transient parse
  // guard), stamps tracksFetchedAt, persists, and caches images.
  //   force: bypass the freshness check and always re-scrape.
  function ensureTracks(pl, opts) {
    var force = !!(opts && opts.force);
    if (!force && tracksAreFresh(pl)) {
      return Promise.resolve(state.playlistTracks[pl.id] || []);
    }
    var visible = !!(opts && opts.visible);
    var oldTracks = state.playlistTracks[pl.id] || [];

    return withSpotifyWindow({ url: MUSIC_CHIP_URL, visible: visible }, function (h, ctx) {
      return new Promise(function (resolve) {
        var gen = ctx.gen;
        var settled = false;
        var trackTimeout = null;
        var attempts = 0;
        var isLikedSize = false; // no Liked Songs anymore; normal caps apply
        var maxSteps = 60;
        var timeoutMs = 45000;

        function settle(tracks, descr, coverUrl) {
          if (settled) return;
          settled = true;
          if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
          var finalTracks = tracks;
          // Keep-old guard: don't let an empty scrape clobber tracks we had.
          if ((!finalTracks || finalTracks.length === 0) && oldTracks.length > 0) {
            finalTracks = oldTracks;
          } else {
            if (descr) pl.description = descr;
            if (coverUrl) pl.imageUrl = coverUrl;
            pl.tracksFetchedAt = new Date().toISOString();
            pl.lastSyncedAt = pl.tracksFetchedAt;
          }
          state.playlistTracks[pl.id] = finalTracks;
          savePlaylist(pl).then(function () { cacheAllImages(); }).catch(console.error);
          resolve(finalTracks);
        }

        function arm() {
          trackTimeout = setTimeout(function () {
            if (ctx.isStale()) { settle(oldTracks); return; }
            plog("warn", "tracks", "Timeout scraping \"" + pl.name + "\" (" + pl.id + ")");
            retryOrFinish();
          }, timeoutMs);
        }
        function retryOrFinish() {
          if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
          if (attempts < 2) {
            attempts++;
            h.eval(scriptNavigatePlaylist(pl.id));
            setTimeout(function () {
              if (ctx.isStale()) { settle(oldTracks); return; }
              h.eval(scriptScrollThenScrape(pl.id, gen, { maxSteps: maxSteps }));
              arm();
            }, 4000);
            return;
          }
          settle(oldTracks);
        }

        ctx.setHandler(function (msg) {
          if (msg.type === "tracks" && msg.data && msg.data.playlistId === pl.id) {
            var tracks = msg.data.tracks || [];
            if (msg.data.error) { plog("warn", "tracks", "Scrape error: " + msg.data.error); retryOrFinish(); return; }
            if (tracks.length === 0) { retryOrFinish(); return; }
            settle(tracks, msg.data.description, msg.data.coverUrl);
          }
        });

        attempts = 1;
        h.eval(scriptNavigatePlaylist(pl.id));
        setTimeout(function () {
          if (ctx.isStale()) { settle(oldTracks); return; }
          h.eval(scriptScrollThenScrape(pl.id, gen, { maxSteps: maxSteps }));
          arm();
        }, 4000);
      });
    });
  }
```

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add ensureTracks lazy track fetch + 24h cache"
```

---

## Task 6: Rewire the `sync` action + `silentRefresh` to `syncPlaylists`

**Files:**
- Modify: `index.js` — `silentRefresh` (~line 2484), the `sync` action (~line 2515).

- [ ] **Step 1: Rewrite `silentRefresh`**

Replace the whole `silentRefresh` function (lines ~2484-2511) with:

```javascript
  function silentRefresh() {
    if (state.refreshing) return;
    state.refreshing = true;

    syncPlaylists(false, "auto-refresh").then(function (result) {
      state.refreshing = false;
      if (!result) {
        recordCheckResult(0, 1);
        api.ui.setBadge("spotify", { type: "dot", variant: "error" });
        return;
      }
      applySyncResult(result);
      recordCheckResult(result.playlists.length, 0);
      cacheAllImages();
      api.scheduler.complete("auto-refresh").catch(console.error);
      state.status = "done";
      render();
    }).catch(function (err) {
      state.refreshing = false;
      recordCheckResult(0, 1);
      console.error("Silent refresh failed:", err);
      api.ui.setBadge("spotify", { type: "dot", variant: "error" });
    });
  }
```

- [ ] **Step 2: Add the `applySyncResult` helper**

Insert immediately above `silentRefresh` (just before its `function silentRefresh()` line):

```javascript
  // Merge a syncPlaylists result into state: derive sections from the scrape,
  // replace the playlist list, and delete on-disk dirs for playlists that
  // dropped out. Track caches survive for playlists that are still present
  // (keyed by id); dropped playlists' dirs are removed.
  function applySyncResult(result) {
    var newPlaylists = result.playlists;
    var oldById = {};
    for (var oi = 0; oi < state.playlists.length; oi++) {
      oldById[state.playlists[oi].id] = state.playlists[oi];
    }
    // Carry over cached tracks + tracksFetchedAt for surviving playlists so a
    // list refresh doesn't invalidate already-fetched tracks.
    var newKeyed = {};
    for (var i = 0; i < newPlaylists.length; i++) {
      var np = newPlaylists[i];
      var old = oldById[np.id];
      if (old) {
        np.tracksFetchedAt = old.tracksFetchedAt || null;
        if (!np.imageUrl && old.imageUrl) np.imageUrl = old.imageUrl;
        if (!np.cardSubtitle && old.cardSubtitle) np.cardSubtitle = old.cardSubtitle;
      }
      newKeyed[playlistDir(np).join("/")] = true;
    }
    // Remove dirs for playlists/sections that no longer appear.
    for (var op = 0; op < state.playlists.length; op++) {
      var oldKey = playlistDir(state.playlists[op]).join("/");
      if (!newKeyed[oldKey]) deletePlaylistFiles(state.playlists[op]);
    }
    // Keep tracks for survivors; drop tracks for removed playlists.
    var survivingTracks = {};
    for (var k = 0; k < newPlaylists.length; k++) {
      var pid = newPlaylists[k].id;
      if (state.playlistTracks[pid]) survivingTracks[pid] = state.playlistTracks[pid];
    }
    state.playlists = newPlaylists;
    state.playlistTracks = survivingTracks;
    state.sections = result.sections;
    state.sectionDescriptions = result.sectionDescriptions || {};
    // Persist the derived section list + descriptions as a cold-start render
    // cache (so headings/order show before the first sync of a new session).
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    api.storage.set("spotify_browse_section_descriptions", state.sectionDescriptions).catch(console.error);
    saveState();
  }
```

> Note: there is no `activeTab` to reconcile — the view renders all shelves
> stacked (Task 10), so a changing shelf set needs no extra state.

- [ ] **Step 3: Rewrite the `sync` action**

Replace the entire `api.ui.onAction("sync", ...)` block (lines ~2515-2566) with:

```javascript
  api.ui.onAction("sync", function() {
    state.status = "waiting-login";
    state.errorMessage = "";
    state.refreshSummary = "";
    state.refreshing = true;
    dbg("flow", "starting single-page sync");
    render();

    syncPlaylists(state.showBrowserOnRefresh, "sync").then(function(result) {
      state.refreshing = false;
      if (!result) {
        state.status = "error";
        state.errorMessage = "Spotify sign-in was not completed. Click 'Sync' to try again.";
        render();
        return;
      }
      applySyncResult(result);
      state.refreshSummary = "Synced " + result.playlists.length + " playlist" +
        (result.playlists.length === 1 ? "" : "s") + " across " + result.sections.length + " shelves";
      recordCheckResult(result.playlists.length, 0);
      cacheAllImages();
      state.status = "done";
      render();
    }).catch(function(err) {
      state.refreshing = false;
      state.status = "error";
      state.errorMessage = "Sync failed: " + (err.message || err);
      recordCheckResult(0, 1);
      render();
    });
  });
```

- [ ] **Step 4: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: rewire sync + silentRefresh to single-page syncPlaylists"
```

---

## Task 7: Rewire View/Play/Enqueue actions to `ensureTracks`

**Files:**
- Modify: `index.js` — `openPlaylistById` (~line 2740), `view-playlist` (~line 2752), `play-current`/`enqueue-current` (~line 2786-2801), `play-playlist`/`enqueue-playlist` (~line 2860-2875), `play-track` (~line 2759), `renderPlaylist` (~line 1001).

- [ ] **Step 1: Add a `loadingTracks` flag to state**

In the `state` object (~line 10-36), add after `playlistSearch: {},`:

```javascript
    // Playlist id currently being lazily track-scraped (for the detail-view
    // loading state). Null when idle.
    loadingTracksFor: null,
    // Section name -> shelf description (gray text under the heading), from the
    // last scrape. Cold-start cache loaded at init.
    sectionDescriptions: {},
```

- [ ] **Step 2: Make the detail view auto-fetch on open**

Replace `openPlaylistById` (~line 2740-2750) with:

```javascript
  // Open a playlist's detail view by id. Auto-fetches tracks (lazy) if they're
  // not cached/fresh. Returns true if the playlist was found.
  function openPlaylistById(pid) {
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) {
        var pl = state.playlists[i];
        state.currentPlaylist = pl;
        state.currentView = "playlist";
        if (!tracksAreFresh(pl)) {
          state.loadingTracksFor = pl.id;
          renderPlaylist();
          ensureTracks(pl).then(function () {
            if (state.currentPlaylist && state.currentPlaylist.id === pl.id) {
              state.loadingTracksFor = null;
              renderPlaylist();
              render();
            }
          }).catch(function (e) {
            console.error("ensureTracks failed:", e);
            if (state.currentPlaylist && state.currentPlaylist.id === pl.id) {
              state.loadingTracksFor = null;
              renderPlaylist();
            }
          });
        } else {
          state.loadingTracksFor = null;
          renderPlaylist();
        }
        return true;
      }
    }
    return false;
  }
```

- [ ] **Step 3: Show the loading state in `renderPlaylist`**

In `renderPlaylist` (~line 1037), find the `else` branch that renders "No tracks scraped":

```javascript
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks scraped</p>" });
    }
```

Replace with:

```javascript
    } else if (state.loadingTracksFor === pl.id) {
      ch.push({ type: "text", content: "<p style='opacity:0.6'>Loading tracks…</p>" });
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks scraped</p>" });
    }
```

- [ ] **Step 3b: Show the scraped `cardSubtitle` on cards until tracks load**

In `buildPlaylistCards` (~line 894), find the subtitle construction:

```javascript
      var ts = state.playlistTracks[sp.id];
      var sub = ts ? ts.length + " tracks" : (sp.description || "");
      if (sp.lastSyncedAt) sub += " · synced " + formatSyncTime(sp.lastSyncedAt);
```

Replace with:

```javascript
      var ts = state.playlistTracks[sp.id];
      // Before tracks are fetched, show the scraped card subtitle (e.g. "With
      // X, Y…"). After a fetch, show the track count + synced stamp.
      var sub;
      if (ts && ts.length > 0) {
        sub = ts.length + " tracks";
        if (sp.lastSyncedAt) sub += " · synced " + formatSyncTime(sp.lastSyncedAt);
      } else {
        sub = sp.cardSubtitle || sp.description || "";
      }
```

- [ ] **Step 4: Make `play-current` / `enqueue-current` lazy**

Replace both actions (~line 2786-2801) with:

```javascript
  api.ui.onAction("play-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    api.ui.showNotification("Fetching tracks for " + pl.name + "…");
    ensureTracks(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) { api.ui.showNotification("No tracks found"); return; }
      api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));
    }).catch(function (e) { console.error(e); api.ui.showNotification("Failed to fetch tracks"); });
  });

  api.ui.onAction("enqueue-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    api.ui.showNotification("Fetching tracks for " + pl.name + "…");
    ensureTracks(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) { api.ui.showNotification("No tracks found"); return; }
      api.playback.insertTracks(toPluginTracks(tracks), -1);
    }).catch(function (e) { console.error(e); api.ui.showNotification("Failed to fetch tracks"); });
  });
```

- [ ] **Step 5: Make `play-playlist` / `enqueue-playlist` lazy**

Replace both card-menu actions (~line 2860-2875) with:

```javascript
  api.ui.onAction("play-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    api.ui.showNotification("Fetching tracks for " + pl.name + "…");
    ensureTracks(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) { api.ui.showNotification("No tracks found"); return; }
      api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));
    }).catch(function (e) { console.error(e); api.ui.showNotification("Failed to fetch tracks"); });
  });

  api.ui.onAction("enqueue-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    api.ui.showNotification("Fetching tracks for " + pl.name + "…");
    ensureTracks(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) { api.ui.showNotification("No tracks found"); return; }
      api.playback.insertTracks(toPluginTracks(tracks), -1);
    }).catch(function (e) { console.error(e); api.ui.showNotification("Failed to fetch tracks"); });
  });
```

- [ ] **Step 6: Add a "Refresh tracks" card-menu action**

In `buildPlaylistCards` (~line 907-919), find the menu construction:

```javascript
      var menu = [
        { id: "play-playlist", label: "Play" },
        { id: "enqueue-playlist", label: "Enqueue" },
        { id: "view-playlist", label: "View / Edit" },
      ];
```

Replace with (and remove the Liked-Songs branch that followed — handled in Task 9):

```javascript
      var menu = [
        { id: "play-playlist", label: "Play" },
        { id: "enqueue-playlist", label: "Enqueue" },
        { id: "view-playlist", label: "View / Edit" },
        { id: "refresh-tracks-ctx", label: "Refresh tracks" },
      ];
```

Then register the action near the other card actions (after `enqueue-playlist`, ~line 2875):

```javascript
  api.ui.onAction("refresh-tracks-ctx", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    api.ui.showNotification("Refreshing tracks for " + pl.name + "…");
    ensureTracks(pl, { force: true }).then(function () {
      if (state.currentPlaylist && state.currentPlaylist.id === pl.id) renderPlaylist();
      render();
      api.ui.showNotification("Refreshed " + pl.name);
    }).catch(function (e) { console.error(e); api.ui.showNotification("Failed to refresh"); });
  });
```

- [ ] **Step 7: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "feat: lazy track fetch on View/Play/Enqueue + Refresh tracks action"
```

**[MANUAL CHECKPOINT]** — Reload the plugin in the host (see `DEVELOPING.md`). Verify:
- Click **Sync** → window opens, you sign in if needed, the grid populates with playlists grouped into tabs named after the shelves. No per-playlist track scraping occurs (sync is fast).
- Click a playlist card (**View**) → detail view opens, shows "Loading tracks…", then the tracklist appears.
- Click **Play** on a card → "Fetching tracks…" notification, then playback starts. Second Play of the same playlist is instant (cached).

---

## Task 8: Remove the eager pipeline — `performScrape`, `processRefreshResults`, `applyKeepOld`, `refreshSectionByName`, section discovery scripts

**Files:**
- Modify: `index.js` — delete `performScrape` (~line 1900-2425), `applyKeepOld` (~line 2434), `processRefreshResults` (~line 2457), `refresh-section`/`refresh-liked` actions (~line 2581-2590), `refreshSectionByName` (~line 2592-2656), `scriptFindSection` (~line 1682), `SCRIPT_SCRAPE_PLAYLISTS` (~line 1724), `SCRIPT_CLICK_MUSIC` (~line 1589).

These are now unused (nothing calls `performScrape` after Task 6; `refresh-section` is replaced by per-card "Refresh tracks").

- [ ] **Step 1: Delete `performScrape`**

Delete the entire function from `// ---- Consolidated scrape function ----` (the comment, if it still precedes it — note Task 2 inserted `withSpotifyWindow` above it) through the closing `}` of `performScrape` at ~line 2425. Verify by checking the next line is `// ---- Refresh results ----`.

- [ ] **Step 2: Delete `applyKeepOld` and `processRefreshResults`**

Delete `applyKeepOld` (~line 2434-2455) and `processRefreshResults` (~line 2457-2480) in full. The `// ---- Refresh results ----` comment block can be removed too.

- [ ] **Step 3: Delete `refresh-liked`, `refresh-section`, `refreshSectionByName`**

Delete the `api.ui.onAction("refresh-liked", ...)` block (~line 2581-2584), the `api.ui.onAction("refresh-section", ...)` block (~line 2586-2590), and the entire `refreshSectionByName` function (~line 2592-2656).

- [ ] **Step 4: Delete the now-unused injected scripts**

Delete `SCRIPT_CLICK_MUSIC` (the `var SCRIPT_CLICK_MUSIC = ...;` block, ~line 1589-1606), `SCRIPT_SCRAPE_PLAYLISTS` (~line 1724-1751), and the `scriptFindSection` function (~line 1682-1722).

> Keep `scriptNavigatePlaylist`, `scriptScrollThenScrape`, `SCRIPT_CHECK_LOGIN`, `SCRIPT_LOGIN_BANNER`, `SCRIPT_REMOVE_LOGIN_BANNER`, `SCRIPT_FULL_DUMP`, `SNAPSHOT_HELPER`, `DBG_HELPER`, `IMG_HELPER` — all still used.

- [ ] **Step 5: Syntax gate**

Run: `node --check index.js`
Expected: exits 0. (If it fails with "X is not defined", you deleted something still referenced — re-check Steps 1-4 against the "keep" list.)

- [ ] **Step 6: Grep for dangling references**

Run: `grep -n "performScrape\|processRefreshResults\|applyKeepOld\|refreshSectionByName\|scriptFindSection\|SCRIPT_SCRAPE_PLAYLISTS\|SCRIPT_CLICK_MUSIC" index.js`
Expected: **no output** (all references gone).

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "refactor: remove eager scrape pipeline + section-discovery scripts"
```

---

## Task 9: Remove Liked Songs entirely

**Files:**
- Modify: `index.js` — `LIKED_SECTION`/`LIKED_PLAYLIST_ID`/`isLikedSection`/`makeLikedPlaylist`/`LIKED_COVER_SVG`/`ensureLikedCover` (~line 43-93), `getLikedPlaylist` (~line 874), pinned card in `renderHome` (~line 972-979), Liked branches in `cacheAllImages` (~line 545), `savePlaylist` coverFile (~line 511), `scriptNavigatePlaylist` (~line 1753), `syncHomeShelves` (~line 3096), `playlistContextPayload`/`isLiked` references, the migration in the sections loader (~line 3187).

- [ ] **Step 1: Delete the Liked Songs helpers + constants**

Delete `LIKED_SECTION`, `LIKED_PLAYLIST_ID`, `isLikedSection`, `makeLikedPlaylist`, `LIKED_COVER_SVG`, and `ensureLikedCover` (the whole block ~line 43-93).

- [ ] **Step 2: Delete `getLikedPlaylist`**

Delete the `getLikedPlaylist` function (~line 874-879).

- [ ] **Step 3: Remove the pinned Liked card in `renderHome`**

Delete the block (~line 972-979):

```javascript
    // Pinned Liked Songs card (rendered above the section tabs once it exists).
    var likedPl = getLikedPlaylist();
    if (likedPl) {
      view.push({
        type: "layout", direction: "vertical", style: { "padding": "12px 16px 0" },
        children: [{ type: "card-grid", items: buildPlaylistCards([likedPl]) }],
      });
    }
```

- [ ] **Step 4: Simplify `savePlaylist` coverFile**

In `savePlaylist` (~line 511), replace:

```javascript
    var coverFile = pl.id === LIKED_PLAYLIST_ID ? "cover.svg" : "cover.jpg";
```

with:

```javascript
    var coverFile = "cover.jpg";
```

- [ ] **Step 5: Remove Liked branch in `cacheAllImages`**

In `cacheAllImages` (~line 545-549), replace:

```javascript
        if (pl.id === LIKED_PLAYLIST_ID) {
          promises.push(ensureLikedCover(pl));
          // Liked Songs has no remote cover to fetch; track images are still
          // handled via the standard path below.
        } else if (pl.imageUrl && pl.imageUrl.indexOf("http") === 0) {
```

with:

```javascript
        if (pl.imageUrl && pl.imageUrl.indexOf("http") === 0) {
```

- [ ] **Step 6: Simplify `scriptNavigatePlaylist`**

Replace the whole `scriptNavigatePlaylist` function (~line 1753-1766) with:

```javascript
  function scriptNavigatePlaylist(id) {
    return '(function(){' +
      DBG_HELPER +
      '_dbg("tracks","navigating to /playlist/' + id + '");' +
      'window.location.href="/playlist/' + id + '"' +
    '})()';
  }
```

- [ ] **Step 7: Remove Liked handling in `syncHomeShelves`**

In `syncHomeShelves` (~line 3093-3102), replace:

```javascript
    var desired = {};
    // Liked Songs first if present.
    if (getLikedPlaylist()) {
      desired[shelfIdForSection(LIKED_SECTION)] = LIKED_SECTION;
    }
    for (var i = 0; i < state.sections.length; i++) {
      var name = state.sections[i];
      if (isLikedSection(name)) continue;
      desired[shelfIdForSection(name)] = name;
    }
```

with:

```javascript
    var desired = {};
    for (var i = 0; i < state.sections.length; i++) {
      var name = state.sections[i];
      desired[shelfIdForSection(name)] = name;
    }
```

- [ ] **Step 8: Remove `isLiked` in `buildShelfFetcher`**

In `buildShelfFetcher` (~line 3057-3065), replace:

```javascript
        var pls = isLikedSection(sectionName)
          ? (function () {
              var liked = getLikedPlaylist();
              return liked ? [liked] : [];
            })()
          : getPlaylistsForSection(sectionName);
```

with:

```javascript
        var pls = getPlaylistsForSection(sectionName);
```

- [ ] **Step 9: Remove Liked stripping in the sections loader + add one-time Liked dir cleanup**

In the sections loader (~line 3190-3204), replace the whole `.then` body:

```javascript
  api.storage.get("spotify_browse_sections").then(function(sections) {
    if (sections && Array.isArray(sections)) {
      state.sections = sections;
    }
    var filtered = [];
    var changed = false;
    for (var i = 0; i < state.sections.length; i++) {
      if (isLikedSection(state.sections[i])) { changed = true; continue; }
      filtered.push(state.sections[i]);
    }
    if (changed) {
      state.sections = filtered;
      api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    }
  }).catch(console.error);
```

with:

```javascript
  // Sections are now derived from the scrape, but we keep the last-known list +
  // descriptions as a cold-start render cache so shelves show before the first
  // sync of a session completes.
  api.storage.get("spotify_browse_sections").then(function(sections) {
    if (sections && Array.isArray(sections)) state.sections = sections;
    render();
  }).catch(console.error);
  api.storage.get("spotify_browse_section_descriptions").then(function(descs) {
    if (descs && typeof descs === "object") state.sectionDescriptions = descs;
  }).catch(console.error);

  // One-time cleanup: remove the old Liked Songs on-disk directory and its
  // synthetic playlist data (no longer supported). Safe no-op if absent.
  api.storage.files.remove(["playlists", "Liked Songs"]).catch(function () {});
```

- [ ] **Step 10: Syntax gate + dangling-ref grep**

Run: `node --check index.js`
Expected: exits 0.

Run: `grep -n "LIKED_\|isLikedSection\|getLikedPlaylist\|makeLikedPlaylist\|ensureLikedCover" index.js`
Expected: **no output**.

- [ ] **Step 11: Commit**

```bash
git add index.js
git commit -m "refactor: remove Liked Songs synthetic playlist entirely"
```

---

## Task 10: Replace tabs with stacked sections; remove section-config UI + actions

**Files:**
- Modify: `index.js` — `renderHome` (~line 935-999, rewrite to stack sections), `buildTabs` (~line 862-871, delete), all section-config actions (~line 2658-2731, 2930-2977), `switch-tab` (~line 2685), `pendingSectionInput` (~line 8), `state.activeTab` / `state.addingSectionViaTab` (~line 20, 30).

The view changes from "toolbar + tabs + one section's grid" to "toolbar + every shelf stacked (heading + card-grid), top to bottom." This removes all tab and active-tab state.

- [ ] **Step 1: Rewrite `renderHome` to stack all sections**

Replace the entire `renderHome` function (~line 935-999) with:

```javascript
  function renderHome() {
    api.ui.setBadge("spotify", null);
    var isActive = isActiveStatus();

    var toolbar = buildToolbar();
    toolbar.buttons.push({ label: state.showBrowserOnRefresh ? "Browser: ON" : "Browser: OFF", action: "toggle-show-browser-pref", variant: state.showBrowserOnRefresh ? "accent" : "secondary" });
    var view = [toolbar];

    // Empty state: nothing scraped yet.
    if (state.sections.length === 0) {
      if (!isActive && state.status === "idle") {
        view.push({ type: "text", content: "<p style='opacity:0.5;padding:16px'>No playlists yet. Click <b>Sync</b> to scrape your Spotify Music home.</p>" });
      }
      api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: view });
      return;
    }

    // One stacked block per shelf: heading (+ description) + card-grid.
    for (var i = 0; i < state.sections.length; i++) {
      var sectionName = state.sections[i];
      var secPlaylists = getPlaylistsForSection(sectionName);
      if (secPlaylists.length === 0) continue;
      var headerHtml = "<h3 style='margin:0 0 2px;font-size:var(--fs-md)'>" + escapeHtml(sectionName) + "</h3>";
      var descr = state.sectionDescriptions[sectionName];
      if (descr) headerHtml += "<p style='margin:0 0 6px;font-size:var(--fs-xs);color:var(--text-secondary)'>" + escapeHtml(descr) + "</p>";
      view.push({
        type: "layout", direction: "vertical", style: { "padding": "12px 16px 0" },
        children: [
          { type: "text", content: headerHtml },
          { type: "card-grid", items: buildPlaylistCards(secPlaylists) },
        ],
      });
    }

    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: view });
  }
```

- [ ] **Step 2: Delete `buildTabs`**

Delete the entire `buildTabs` function (~line 862-871). It is no longer referenced.

- [ ] **Step 3: Delete `switch-tab` and all section-config actions**

Delete these blocks entirely:
- `api.ui.onAction("switch-tab", ...)` (~line 2685-2695)
- `api.ui.onAction("remove-section-tab", ...)` (~line 2658-2683)
- `api.ui.onAction("section-tab-input", ...)` (~line 2697-2701)
- `api.ui.onAction("section-tab-input:submit", ...)` (~line 2703-2706)
- `api.ui.onAction("add-section-tab", ...)` (~line 2708-2710)
- `addSectionFromTab` function (~line 2712-2725)
- `api.ui.onAction("cancel-add-section", ...)` (~line 2727-2731)
- `api.ui.onAction("section-input", ...)` (~line 2930-2934)
- `api.ui.onAction("section-input:submit", ...)` (~line 2936-2948)
- `api.ui.onAction("add-section", ...)` (~line 2950-2961)
- `api.ui.onAction("remove-section", ...)` (~line 2963-2977)

- [ ] **Step 4: Remove now-dead state**

- Delete `var pendingSectionInput = "";` (~line 8).
- In the `state` object: delete `activeTab: "section:Made for You",` (~line 20) and `addingSectionViaTab: false,` (~line 30).

> `state.activeTab` is referenced only by the deleted tab code and `applySyncResult` (already cleaned in Task 6) — the next step's grep confirms none remain.

- [ ] **Step 5: Syntax gate + dangling-ref grep**

Run: `node --check index.js`
Expected: exits 0.

Run: `grep -n "pendingSectionInput\|addingSectionViaTab\|activeTab\|buildTabs\|remove-section\|add-section\|section-tab-input\|section-input\|cancel-add-section\|switch-tab\|__add__\|type: \"tabs\"" index.js`
Expected: **no output**. (If `activeTab` still appears, find its reference and remove it — nothing should read it anymore.)

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: replace section tabs with vertically stacked shelves"
```

**[MANUAL CHECKPOINT]** — Reload in host. Verify:
- The view shows each scraped shelf as a heading with its card-grid beneath, stacked vertically. **No** tab bar, no `+` tab, no "Remove Section" / "Refresh [section]" buttons.
- Scrolling shows every shelf.
- Auto-refresh (set a short interval in Settings, or trigger via host) re-scrapes the list only — no track windows pop.

---

## Task 11: Adapt the step-by-step debugger (find-section → scrape-shelves)

**Files:**
- Modify: `index.js` — `DBG_STEPS` (~line 1190), `dbgRunStep` (~line 1212), `buildDebugTestSection` (~line 1429, the section-name input + playlist selector).

The debugger's "Find Section" step referenced the deleted `scriptFindSection`. Replace it with a "Scrape Shelves" step using `SCRIPT_SCRAPE_SHELVES`.

- [ ] **Step 1: Update `DBG_STEPS`**

Replace `DBG_STEPS` (~line 1190-1195) with:

```javascript
  var DBG_STEPS = [
    { id: "login", label: "1. Check Login" },
    { id: "scrape-shelves", label: "2. Scrape Shelves" },
    { id: "scrape-tracks", label: "3. Scrape Tracks" },
  ];
```

- [ ] **Step 2: Replace the `find-section` + `scrape-playlists` branches in `dbgRunStep`**

In `dbgRunStep` (~line 1212-1271), delete the `else if (stepId === "find-section")` and `else if (stepId === "scrape-playlists")` branches, and insert a single new branch after the `login` branch:

```javascript
    } else if (stepId === "scrape-shelves") {
      dbgTest.steps.push({ id: "scrape-shelves", status: "running", source: "live", log: [] });
      dbgTest.status = "running";
      renderSettings();
      dbgTest.handle.eval('window.location.href=' + JSON.stringify(MUSIC_CHIP_URL)).catch(console.error);
      setTimeout(function () {
        dbgEvalAndWait(SCRIPT_SCRAPE_SHELVES, "shelves", 30000, function (data) {
          var shelves = (data && data.shelves) || [];
          var pls = [];
          for (var s = 0; s < shelves.length; s++) {
            for (var p = 0; p < shelves[s].playlists.length; p++) pls.push(shelves[s].playlists[p]);
          }
          dbgTest.playlists = pls;
          if (pls.length > 0) dbgTest.selectedPlaylist = pls[0].id;
          dbgStepDone("scrape-shelves", "Found <b>" + shelves.length + "</b> shelf(s), <b>" + pls.length + "</b> playlist(s)");
        }, function () {
          dbgStepFail("scrape-shelves", "No shelves found (timeout)");
        });
      }, 4000);
```

The `scrape-tracks` branch (which follows) is unchanged.

- [ ] **Step 3: Remove the section-name input from `buildDebugTestSection`**

In `buildDebugTestSection` (~line 1448-1453), the section-name text-input is no longer meaningful. Replace:

```javascript
    children.push({
      type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
      children: [
        { type: "text-input", placeholder: "Section name (e.g. Made for You)", action: "dbg-section-name", value: dbgTest.sectionName, style: { flex: "1" }, disabled: running || waiting },
      ].concat(headerButtons),
    });
```

with:

```javascript
    children.push({
      type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
      children: headerButtons,
    });
```

- [ ] **Step 4: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

Run: `grep -n "find-section\|scrape-playlists\|dbgTest.sectionName" index.js`
Expected: `dbgTest.sectionName` may still appear in the `dbg-section-name` action + the `dbgTest` object init — that's harmless dead state, but remove it for cleanliness: delete `sectionName: "Made for You",` from the `dbgTest` object (~line 1182) and the `api.ui.onAction("dbg-section-name", ...)` block (~line 3000-3002). Re-run the grep; expected: no output.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "refactor: adapt step debugger to scrape-shelves step"
```

---

## Task 12: Update docs + version bump

**Files:**
- Modify: `SPEC.md`, `CHANGELOG.md`, `manifest.json` (via `scripts/bump.sh`).

- [ ] **Step 1: Rewrite the affected `SPEC.md` sections**

Update `SPEC.md` to reflect the new model. Specifically:
- **Purpose / Architecture:** sync scrapes one page (`home?facet=music-chip`) grouped by shelf; tracks are lazy + 24h-cached.
- **UI Structure:** replace the "Tabs / Section Tab Content" description with "stacked sections" — the panel renders each shelf as a heading (+ gray description) followed by a card-grid, vertically, mirroring the Spotify Music home page. Remove the toolbar's per-section Refresh/Remove and the `+` tab.
- **Scraping Flow:** replace Phases 2-4 with: "Phase 2: Single-page shelf scrape (`SCRIPT_SCRAPE_SHELVES`)" capturing per-shelf heading + description and per-card name + subtitle + cover, and "On-demand track fetch (`ensureTracks`)". Remove the section-finder, Music-button fallback, and eager track phase descriptions.
- **Data Model:** add `tracksFetchedAt` and `cardSubtitle` to the meta fields; add the `spotify_browse_section_descriptions` storage key; remove the Liked Songs row and change the `spotify_browse_sections` semantics from "configured section names" to "derived render cache".
- **Injected Scripts table:** remove `scriptFindSection`, `SCRIPT_SCRAPE_PLAYLISTS`, `SCRIPT_CLICK_MUSIC`; add `SCRIPT_SCRAPE_SHELVES`. Keep `scriptScrollThenScrape`.
- **Known Limitations:** add the two accepted v1 risks (lazy shelf rendering may capture only first ~10 cards per shelf; first Play/View of an uncached playlist pays full scrape latency). Note that station/album/artist cards (e.g. the "Recommended Stations" shelf) are intentionally skipped.

Make these edits directly in `SPEC.md` matching its existing heading structure.

- [ ] **Step 2: Add a CHANGELOG entry**

Prepend a new section to `CHANGELOG.md` (above the current top entry):

```markdown
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
```

- [ ] **Step 3: Bump the version**

Run: `scripts/bump.sh minor`
Expected: `manifest.json` version goes `1.11.0` → `1.12.0` (a minor bump — this is a behavioral change, not a breaking API change). Verify:

Run: `grep '"version"' manifest.json`
Expected: `"version": "1.12.0",`

> If `scripts/bump.sh minor` errors or bumps wrong, edit `manifest.json` `"version"` to `"1.12.0"` by hand.

- [ ] **Step 4: Final syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add SPEC.md CHANGELOG.md manifest.json
git commit -m "docs: update SPEC + CHANGELOG for lazy single-page scrape (v1.12.0)"
```

**[MANUAL CHECKPOINT — full acceptance]** — Reload in host and run the full flow one more time:
1. Fresh **Sync** → fast; shelves render stacked (heading + description + card grid), no track windows. Cards show their Spotify subtitle text.
2. **View** a playlist → loading state → tracklist (card subtitle replaced by track count).
3. **Play** from a card → fetch notification → playback; repeat → instant (cached).
4. **Refresh tracks** on a card → re-scrapes even if < 24h.
5. Open **Settings** → step debugger: Login → Scrape Shelves → Scrape Tracks all pass.
6. Confirm no Liked Songs card, no `+` tab, no Remove/Refresh-section buttons, and the layout resembles the Spotify Music home page.

---

## Self-Review Notes

**Spec coverage** (each design section → task):
- Source page `home?facet=music-chip` → Task 3 (`MUSIC_CHIP_URL`), Task 4.
- Grouped-by-shelf **stacked** layout (no tabs) → Task 3 (script), Task 4 (sections derived), Task 10 (`renderHome` stacked sections, tabs removed).
- Card subtitles + shelf descriptions → Task 3 (`cardSubtitle`/`shelfDescription` in script), Task 4 (threaded into playlists + `sectionDescriptions`), Task 7 Step 3b (`buildPlaylistCards`), Task 10 (description under heading).
- Cache tracks, 24h TTL → Task 1 (`tracksAreFresh`, `tracksFetchedAt`), Task 5 (`ensureTracks`).
- Drop Liked Songs → Task 9.
- Playlists only (skip station/album/artist) → Task 3 (only `a[href*="/playlist/"]`).
- Auto-refresh = list only → Task 6 (`silentRefresh` → `syncPlaylists`).
- Auto-fetch tracks on View → Task 7 (`openPlaylistById`).
- Open/close window per action → Task 2 (`withSpotifyWindow` closes on settle); each `ensureTracks`/`syncPlaylists` call opens its own.
- Migration → Task 9 (Liked dir cleanup), Task 6 (`applySyncResult` drops stale dirs), Task 1 (absent `tracksFetchedAt` → stale).
- Login flow kept → Task 2.
- `scriptScrollThenScrape` kept → Task 5 uses it.
- Diagnostics kept → Task 4 (`beginReport`/`finishReport`).
- Step debugger adapted → Task 11.
- Known limitations documented → Task 12.

**Type/name consistency:** `withSpotifyWindow(opts, fn)`, `syncPlaylists(visible, trigger)` → `{playlists, sections, sectionDescriptions}`, `ensureTracks(pl, opts)` → `Promise<tracks>`, `applySyncResult(result)`, `tracksAreFresh(pl)`, `MUSIC_CHIP_URL`, `TRACKS_TTL_MS`, `SCRIPT_SCRAPE_SHELVES`, `state.loadingTracksFor`, `state.sectionDescriptions`, playlist `cardSubtitle` field, storage key `spotify_browse_section_descriptions` — all used consistently across tasks.

**Note on line numbers:** all `~line N` references are from the pre-change `index.js` and will drift as tasks delete code. Anchor on the quoted code snippets and function names, not the numbers.
