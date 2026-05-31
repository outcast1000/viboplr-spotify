# Playlist Hero Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the playlist detail view a proper hero by feeding the host `detail-header` node the fields it already supports but we never pass — a crossfade `bgImages` background (cover + distinct local track arts), a native Enqueue button, and a description subtitle chip.

**Architecture:** Pure data-population in `renderPlaylist` (`index.js`). Add one small helper `buildHeroBackground(pl, tracks)` that returns the `bgImages` array (cover first, then up to 3 distinct LOCAL track album-arts), then pass `subtitle`, `bgImages`, and `enqueueAction` on the existing `detail-header` node. The host (`DetailHero.tsx`) owns all visual rendering; no host changes.

**Tech Stack:** Plain ES5-style JS (`var`/`function`), no build step, runs in the host WebView sandbox. UI via `api.ui.setViewData` host view-nodes.

---

## Testing Approach (read before starting)

**There is no test harness for this plugin** — no `package.json`, no Node/browser dev environment; the sandbox runs inside the host app's WebView. Per `DEVELOPING.md` the real loop is install/symlink into the host and reload.

Verification per task:

1. **Automated gate (every task):** `node --check index.js` must exit 0 (syntax).
2. **Logic check (Task 1):** a standalone `node` snippet exercises the pure helper `buildHeroBackground` against sample inputs (given in the task) — this is feasible because the helper is pure (no `api`/DOM).
3. **Manual gate (final checkpoint):** reload in the host and verify the hero visually. This is the real acceptance test; if you can't run the host, mark it deferred and continue.

Commit after every task. Reference: design at `docs/superpowers/specs/2026-05-31-playlist-hero-header-design.md`.

## File Structure

Single file, two regions:

- **Modify:** `index.js`
  - Add `buildHeroBackground(pl, tracks)` helper (near `renderPlaylist`, ~line 925).
  - Wire `subtitle` / `bgImages` / `enqueueAction` onto the `detail-header` node in `renderPlaylist` (~lines 940-950).

Ordering: helper first (Task 1, independently checkable), then wire it into the node (Task 2).

---

## Task 1: Add the `buildHeroBackground` helper

**Files:**
- Modify: `index.js` — add a new function immediately ABOVE `function renderPlaylist() {` (~line 926).

**Context:** The hero background (`bgImages`, host caps at 4) should be the cover first, then up to 3 distinct **local** track album-arts. "Local" means the url is NOT a remote Spotify URL — i.e. does not start with `"http"` (during a scrape, track `imageUrl`s are remote `https://…` CDN URLs; after `cacheAllImages` they become absolute local paths, sometimes with a `#v=` suffix). Track arts are de-duped (Spotify reuses album art across tracks) and must not duplicate the cover. The helper is PURE — it takes `pl` and `tracks` and returns an array of url strings; no `api`, no DOM, no `state`.

- [ ] **Step 1: Add the helper**

Find this exact line:

```javascript
  function renderPlaylist() {
```

Replace with (the new helper, a blank line, then the original line):

```javascript
  // Build the hero's crossfade background (bgImages, host caps at 4): the cover
  // first, then up to 3 DISTINCT LOCAL track album-arts. Track arts are included
  // only once cached locally (imageUrl not starting with "http") — during a
  // scrape they're remote CDN URLs, excluded so the background stays the cover
  // until images cache, then upgrades to the collage. De-duped; never repeats
  // the cover. Pure: no api/DOM/state.
  function buildHeroBackground(pl, tracks) {
    var bg = [];
    var seen = {};
    var cover = pl && pl.imageUrl;
    if (cover) { bg.push(cover); seen[cover] = true; }
    var list = tracks || [];
    for (var i = 0; i < list.length && bg.length < 4; i++) {
      var url = list[i] && list[i].imageUrl;
      if (!url) continue;
      if (url.indexOf("http") === 0) continue; // remote (not yet cached) — skip
      if (seen[url]) continue;
      seen[url] = true;
      bg.push(url);
    }
    return bg;
  }

  function renderPlaylist() {
```

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Logic check (pure helper)**

This exercises `buildHeroBackground` against four cases. Run this exact command:

```bash
node -e '
const fs=require("fs");
let code=fs.readFileSync("index.js","utf8").replace(
  "  loadInitialState();",
  "  globalThis.__BHB = buildHeroBackground;\n  loadInitialState();");
const fn=new Function("api","window","globalThis","self","document",code);
const chain=new Proxy(function(){},{get:()=>chain,apply:()=>Promise.resolve()});
const api=new Proxy({},{get:()=>chain});
try{ fn(api,{},globalThis,{},{}).activate(api); }catch(e){}
const B=globalThis.__BHB; if(!B){console.log("helper not captured");process.exit(2);}
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let ok=true;
function check(name,got,want){ if(!eq(got,want)){ok=false;console.log("FAIL "+name+": got "+JSON.stringify(got)+" want "+JSON.stringify(want));} else console.log("PASS "+name); }
// 1: cover only, no local arts (all remote)
check("cover+remote-only", B({imageUrl:"/c/cover.jpg"}, [{imageUrl:"https://cdn/a.jpg"},{imageUrl:"https://cdn/b.jpg"}]), ["/c/cover.jpg"]);
// 2: cover + distinct local arts, capped at 4 total
check("cover+locals-cap4", B({imageUrl:"/c/cover.jpg"}, [{imageUrl:"/c/t1.jpg"},{imageUrl:"/c/t2.jpg"},{imageUrl:"/c/t3.jpg"},{imageUrl:"/c/t4.jpg"}]), ["/c/cover.jpg","/c/t1.jpg","/c/t2.jpg","/c/t3.jpg"]);
// 3: de-dups repeated art and the cover
check("dedup", B({imageUrl:"/c/cover.jpg"}, [{imageUrl:"/c/t1.jpg"},{imageUrl:"/c/t1.jpg"},{imageUrl:"/c/cover.jpg"},{imageUrl:"/c/t2.jpg"}]), ["/c/cover.jpg","/c/t1.jpg","/c/t2.jpg"]);
// 4: no cover, some local arts
check("no-cover", B({imageUrl:null}, [{imageUrl:"/c/t1.jpg"},{imageUrl:null},{imageUrl:"/c/t2.jpg"}]), ["/c/t1.jpg","/c/t2.jpg"]);
process.exit(ok?0:1);
'
```
Expected: four `PASS` lines, exit 0. (A harmless `Failed to load state: TypeError…` line from the API stub may also print — ignore it. The capture is injected at `loadInitialState();`, after `buildHeroBackground` is defined.)

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: add buildHeroBackground helper for playlist hero bgImages"
```

---

## Task 2: Wire `subtitle` / `bgImages` / `enqueueAction` onto the hero node

**Files:**
- Modify: `index.js` — the `detail-header` node literal in `renderPlaylist` (~lines 940-950).

**Context:** `pl.description` is the playlist description (populated after a track scrape; empty otherwise). `loadingThis`/`tracks` are already in scope. `enqueue-current` is an existing registered action (the context menu uses it) — no new handler. The cover (`pl.imageUrl`) keeps its `#v=` suffix because we pass it verbatim and also feed it (verbatim) into `buildHeroBackground`.

- [ ] **Step 1: Replace the `detail-header` node**

Find this exact block:

```javascript
    var ch = [
      {
        type: "detail-header",
        title: pl.name,
        meta: headerMeta,
        imageUrl: pl.imageUrl || undefined,
        backAction: "go-home",
        playAction: (!loadingThis && tracks.length > 0) ? "play-current" : undefined,
        contextMenuActions: contextActions,
      },
    ];
```

Replace with:

```javascript
    var ch = [
      {
        type: "detail-header",
        title: pl.name,
        subtitle: pl.description || undefined,
        meta: headerMeta,
        imageUrl: pl.imageUrl || undefined,
        bgImages: buildHeroBackground(pl, tracks),
        backAction: "go-home",
        playAction: (!loadingThis && tracks.length > 0) ? "play-current" : undefined,
        enqueueAction: (!loadingThis && tracks.length > 0) ? "enqueue-current" : undefined,
        contextMenuActions: contextActions,
      },
    ];
```

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Confirm the wiring**

Run: `grep -n 'bgImages: buildHeroBackground\|subtitle: pl.description\|enqueueAction: (!loadingThis' index.js`
Expected: three matches (one per added field).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: proper playlist hero (bg collage, subtitle, native Enqueue)"
```

**[MANUAL CHECKPOINT — full acceptance]** — Reload the plugin in the host (`DEVELOPING.md`) and verify:
1. Open a playlist with a cover → hero shows a blurred cover background, the cover as foreground art, title, and "N tracks · synced X" meta.
2. After its tracks fetch (and images cache) → reopening shows the background upgrade to a cover+track-art crossfade collage, and a description chip appears (if the playlist has one).
3. Play AND Enqueue both appear as native hero buttons once tracks are loaded; both hidden while loading / when 0 tracks.
4. A playlist with no cover → hero renders its default background (no crash).
5. Back button still returns to the stacked-shelves home view; overflow/context menu still has Play/Enqueue/Save.

---

## Self-Review Notes

**Spec coverage** (design section → task):
- `bgImages` = cover + ≤3 distinct local track arts → Task 1 (`buildHeroBackground`) + Task 2 (`bgImages:` wiring).
- Local-only track-art rule (`!startsWith("http")`) → Task 1 (the `indexOf("http")===0` skip).
- De-dup vs cover and repeats → Task 1 (`seen` map).
- Native Enqueue, gated like Play → Task 2 (`enqueueAction`).
- Subtitle = description → Task 2 (`subtitle: pl.description || undefined`).
- Meta unchanged, artShape default square → Task 2 (meta kept; no artShape passed → host defaults to square).
- No-cover / no-description / loading edge cases → Task 1 (empty bg) + Task 2 (`|| undefined`, gating).
- Cover `#v=` preserved → Task 2 (passes `pl.imageUrl` verbatim to both `imageUrl` and the helper).

**Type/name consistency:** helper is `buildHeroBackground(pl, tracks)` in both tasks; it reads `pl.imageUrl` and `tracks[i].imageUrl` (matches the playlist/track object shapes used elsewhere in `renderPlaylist`). `enqueue-current` action name matches the existing handler. `loadingThis`/`tracks`/`headerMeta`/`contextActions` all already exist in `renderPlaylist`.

**Note on line numbers:** `~line N` references are pre-change; anchor on the quoted find-strings.
