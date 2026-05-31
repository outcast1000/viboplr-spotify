# Home-Shelf Lazy Play Resolve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing a Home-screen card's play button for an un-fetched Spotify playlist should scrape its tracks (with a loading modal) and play them, instead of silently playing nothing.

**Architecture:** Add a host hook `api.home.onResolvePlay(shelfId, handler)` — a plugin-registered async resolver the host awaits (behind its `PluginLoadingModal`) when a `playlist-cards` item's `tracks` are empty, then plays the resolved tracks. Mirrors the existing `onItemClick`/`onFetchShelf` plumbing. The Spotify plugin's resolver runs `ensureTracks`.

**Tech Stack:** Host = React/TypeScript (Tauri 2); typecheck via `node_modules/.bin/tsc --noEmit`. Plugin = ES5 JS in a frozen WebView sandbox; gate via `node --check`.

---

## Conventions / commit policy (read before starting)

- **Host edits go in worktree `/Users/alex/Code/viboplr/.claude/worktrees/2`** (branch `worktree-2`) and are **NOT committed** — leave them uncommitted for the user to review/commit. Run host commands from that dir.
- **Plugin edits** (`/Users/alex/Code/viboplr-spotify`) are committed normally.
- The hook is optional/additive: shelves without a resolver behave exactly as today.

Reference: design at `docs/superpowers/specs/2026-06-01-home-shelf-lazy-play-design.md`.

## File Structure

- **Host (worktree-2, uncommitted)** — Task 1, four files (typecheck together):
  - `src/types/plugin.ts` — declare `onResolvePlay` on `PluginHomeAPI`.
  - `src/hooks/usePlugins.ts` — ref + `onResolvePlay` impl + teardown + `invokeHomeShelfResolvePlay` accessor + export.
  - `src/App.tsx` — await the resolver in `handleHomeShelfItemPlay`'s `"tracks"` case.
  - `.claude/rules/plugins.md` — document `onResolvePlay`.
- **Plugin (this repo, committed)** — Task 2:
  - `index.js` — add `findPlaylistById` helper + register `onResolvePlay` per shelf.

---

## Task 1: Host — `onResolvePlay` hook + lazy play path (worktree-2, uncommitted)

**Files (all under `/Users/alex/Code/viboplr/.claude/worktrees/2`).** Make all edits, typecheck, then STOP — **do NOT `git add`/`git commit` in the host repo.**

- [ ] **Step 1: Declare the hook** (`src/types/plugin.ts`)

In `PluginHomeAPI`, find:
```typescript
  onItemClick(
    shelfId: string,
    handler: (item: HomeShelfItem) => void | Promise<void>,
  ): () => void;
}
```
Replace with:
```typescript
  onItemClick(
    shelfId: string,
    handler: (item: HomeShelfItem) => void | Promise<void>,
  ): () => void;
  // Resolve the tracks to play for a card whose `tracks` arrived empty (lazy).
  // The host awaits this (behind a loading modal) only when the card's play
  // action is kind:"tracks" with an empty list. Return the tracks to play (or
  // [] to play nothing).
  onResolvePlay(
    shelfId: string,
    handler: (item: HomeShelfItem) => Promise<PluginTrack[]>,
  ): () => void;
}
```
(`PluginTrack` and `HomeShelfItem` are already defined in this file.)

- [ ] **Step 2: Add the handler ref** (`src/hooks/usePlugins.ts`)

Find:
```typescript
  const homeShelfClickHandlersRef = useRef(new Map<string, (item: HomeShelfItem) => void | Promise<void>>());
```
Replace with:
```typescript
  const homeShelfClickHandlersRef = useRef(new Map<string, (item: HomeShelfItem) => void | Promise<void>>());
  const homeShelfResolvePlayHandlersRef = useRef(new Map<string, (item: HomeShelfItem) => Promise<PluginTrack[]>>());
```
(`PluginTrack` is already imported at the top of this file.)

- [ ] **Step 3: Implement `onResolvePlay` in the plugin home API** (`src/hooks/usePlugins.ts`)

Find the end of the `onItemClick` impl (the `home` API object):
```typescript
          onItemClick(shelfId: string, handler: (item: HomeShelfItem) => void | Promise<void>): () => void {
            const key = `${pluginId}:${shelfId}`;
            homeShelfClickHandlersRef.current.set(key, handler);
            const unsub = () => {
              if (homeShelfClickHandlersRef.current.get(key) === handler) {
                homeShelfClickHandlersRef.current.delete(key);
              }
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
        },
```
Replace with:
```typescript
          onItemClick(shelfId: string, handler: (item: HomeShelfItem) => void | Promise<void>): () => void {
            const key = `${pluginId}:${shelfId}`;
            homeShelfClickHandlersRef.current.set(key, handler);
            const unsub = () => {
              if (homeShelfClickHandlersRef.current.get(key) === handler) {
                homeShelfClickHandlersRef.current.delete(key);
              }
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
          onResolvePlay(shelfId: string, handler: (item: HomeShelfItem) => Promise<PluginTrack[]>): () => void {
            const key = `${pluginId}:${shelfId}`;
            homeShelfResolvePlayHandlersRef.current.set(key, handler);
            const unsub = () => {
              if (homeShelfResolvePlayHandlersRef.current.get(key) === handler) {
                homeShelfResolvePlayHandlersRef.current.delete(key);
              }
            };
            trackUnsubscribe(unsub);
            return unsub;
          },
        },
```

- [ ] **Step 4: Clear resolvers in teardown** (`src/hooks/usePlugins.ts`)

Find:
```typescript
    // Clear home shelf item-click handlers for this plugin
    for (const key of Array.from(homeShelfClickHandlersRef.current.keys())) {
      if (key.startsWith(`${pluginId}:`)) {
        homeShelfClickHandlersRef.current.delete(key);
      }
    }
```
Replace with:
```typescript
    // Clear home shelf item-click handlers for this plugin
    for (const key of Array.from(homeShelfClickHandlersRef.current.keys())) {
      if (key.startsWith(`${pluginId}:`)) {
        homeShelfClickHandlersRef.current.delete(key);
      }
    }
    // Clear home shelf resolve-play handlers for this plugin
    for (const key of Array.from(homeShelfResolvePlayHandlersRef.current.keys())) {
      if (key.startsWith(`${pluginId}:`)) {
        homeShelfResolvePlayHandlersRef.current.delete(key);
      }
    }
```

- [ ] **Step 5: Add the invoke accessor + export** (`src/hooks/usePlugins.ts`)

Find:
```typescript
  const invokeHomeShelfItemClick = useCallback(
    (pluginId: string, shelfId: string, item: HomeShelfItem): boolean => {
      const handler = homeShelfClickHandlersRef.current.get(`${pluginId}:${shelfId}`);
      if (!handler) return false;
      try {
        const r = handler(item);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((e) => console.error(`[plugin:${pluginId}] home item click error:`, e));
        }
      } catch (e) {
        console.error(`[plugin:${pluginId}] home item click error:`, e);
      }
      return true;
    },
    [],
  );
```
Replace with:
```typescript
  const invokeHomeShelfItemClick = useCallback(
    (pluginId: string, shelfId: string, item: HomeShelfItem): boolean => {
      const handler = homeShelfClickHandlersRef.current.get(`${pluginId}:${shelfId}`);
      if (!handler) return false;
      try {
        const r = handler(item);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((e) => console.error(`[plugin:${pluginId}] home item click error:`, e));
        }
      } catch (e) {
        console.error(`[plugin:${pluginId}] home item click error:`, e);
      }
      return true;
    },
    [],
  );

  // Returns the resolver's promise of tracks, or null if no resolver is
  // registered for this shelf. The caller (App) awaits it to lazily resolve a
  // card whose tracks arrived empty.
  const invokeHomeShelfResolvePlay = useCallback(
    (pluginId: string, shelfId: string, item: HomeShelfItem): Promise<PluginTrack[]> | null => {
      const handler = homeShelfResolvePlayHandlersRef.current.get(`${pluginId}:${shelfId}`);
      if (!handler) return null;
      return Promise.resolve().then(() => handler(item));
    },
    [],
  );
```
Then find the return-object line:
```typescript
    invokeHomeShelfItemClick,
```
Replace with:
```typescript
    invokeHomeShelfItemClick,
    invokeHomeShelfResolvePlay,
```
(The `Promise.resolve().then(() => handler(item))` wrapper ensures a thrown handler becomes a rejected promise the caller can `.catch`, rather than throwing synchronously.)

- [ ] **Step 6: Await the resolver in the play path** (`src/App.tsx`)

Find the `"tracks"` case in `handleHomeShelfItemPlay`:
```typescript
      case "tracks": {
        const queueTracks = action.tracks.map(pluginTrackToQueueTrack);
        queueHook.playTracks(queueTracks, 0, action.context ? { name: action.context.name, imagePath: action.context.imagePath ?? null, source: action.context.source ?? null } : undefined);
        return;
      }
```
Replace with:
```typescript
      case "tracks": {
        const ctx = action.context ? { name: action.context.name, imagePath: action.context.imagePath ?? null, source: action.context.source ?? null } : undefined;
        if (action.tracks.length > 0) {
          queueHook.playTracks(action.tracks.map(pluginTrackToQueueTrack), 0, ctx);
          return;
        }
        // Empty tracks: a lazy plugin card. If the plugin registered a resolver,
        // await it (behind a loading modal) and play the result.
        if (shelf.pluginId) {
          const shelfId = shelf.id.slice(shelf.pluginId.length + 1);
          const resolved = plugins.invokeHomeShelfResolvePlay(shelf.pluginId, shelfId, item);
          if (resolved) {
            const label = (item as { name?: string }).name ?? "tracks";
            setPluginLoadingMessage("Loading " + label + "…");
            resolved.then((tracks) => {
              if (tracks && tracks.length > 0) {
                queueHook.playTracks(tracks.map(pluginTrackToQueueTrack), 0, ctx);
              }
            }).catch((e) => {
              console.error("[home] resolve-play failed:", e);
            }).finally(() => {
              setPluginLoadingMessage(null);
            });
          }
        }
        return;
      }
```
(`pluginTrackToQueueTrack`, `queueHook`, `plugins`, and `setPluginLoadingMessage` are all already in scope in `App.tsx`. `setPluginLoadingMessage` is the same state that drives `PluginLoadingModal` via `requestAction("show-loading")`.)

- [ ] **Step 7: Document the hook** (`.claude/rules/plugins.md`)

Find the `onItemClick` bullet in the `api.home` section (search for `onItemClick(shelfId, handler)`), and add a sibling bullet right after it:
```
- `onResolvePlay(shelfId, handler)` — resolve play tracks lazily. For a `playlist-cards` item whose `tracks` you supplied empty, register a resolver; when the user presses the card's play button the host awaits `handler(item) => Promise<PluginTrack[]>` (behind a loading modal) and plays the returned tracks. Use for plugins that fetch tracks on demand. Returns an unsubscriber.
```
(If the doc lists `onItemClick` in a table row rather than a bullet, add an equivalent row for `onResolvePlay` in the same style.)

- [ ] **Step 8: Typecheck gate**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && node_modules/.bin/tsc --noEmit`
Expected: no errors. (Confirm no NEW error references `onResolvePlay`, `invokeHomeShelfResolvePlay`, `homeShelfResolvePlayHandlersRef`, or the changed files.)

- [ ] **Step 9: Confirm edits, do NOT commit**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && git --no-pager diff --stat`
Expected: 4 files changed, all uncommitted. **Do not `git add`/`git commit` in the host repo.**

---

## Task 2: Plugin — register the resolver per shelf (committed)

**Files:**
- Modify: `/Users/alex/Code/viboplr-spotify/index.js` — add `findPlaylistById` helper + `onResolvePlay` registration in `syncHomeShelves`.

**Context:** `syncHomeShelves` registers each shelf's `onFetchShelf` + `onItemClick`. `ensureTracks(pl)` is the lazy scrape (returns Promise<tracks>); `toPluginTracks` converts scraped tracks to the host shape; `state.playlists` holds the playlist objects.

- [ ] **Step 1: Add a `findPlaylistById` helper**

There is no by-id lookup helper today (`openPlaylistById` inlines the loop;
`findPlaylistFromData` takes the action `data` shape). Find `openPlaylistById`:
```javascript
  function openPlaylistById(pid) {
```
Insert a new helper immediately ABOVE it (use the Edit tool: old_string = that line, new_string = the helper + blank line + that line):
```javascript
  // Look up a scraped playlist object by its Spotify id (null if not present).
  function findPlaylistById(pid) {
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) return state.playlists[i];
    }
    return null;
  }

  function openPlaylistById(pid) {
```

- [ ] **Step 2: Register `onResolvePlay` alongside `onItemClick`**

In `syncHomeShelves`, find:
```javascript
      if (typeof api.home.onItemClick === "function") {
        api.home.onItemClick(id, function (item) {
          if (!item || !item.id) return;
          api.ui.navigateToView("spotify");
          openPlaylistById(String(item.id));
        });
      }
      registeredShelves[id] = sectionName;
```
Replace with:
```javascript
      if (typeof api.home.onItemClick === "function") {
        api.home.onItemClick(id, function (item) {
          if (!item || !item.id) return;
          api.ui.navigateToView("spotify");
          openPlaylistById(String(item.id));
        });
      }
      // Lazily resolve tracks when the host home-shelf play button is pressed for
      // an un-fetched playlist (its supplied tracks were empty). The host shows
      // its own loading modal while awaiting this. Guarded for older hosts.
      if (typeof api.home.onResolvePlay === "function") {
        api.home.onResolvePlay(id, function (item) {
          var pl = item && item.id ? findPlaylistById(String(item.id)) : null;
          if (!pl) return Promise.resolve([]);
          return ensureTracks(pl).then(function (tracks) {
            return toPluginTracks(tracks || []);
          });
        });
      }
      registeredShelves[id] = sectionName;
```

- [ ] **Step 3: Syntax gate + grep**

Run: `node --check index.js`
Expected: exits 0.

Run: `grep -n 'onResolvePlay\|function findPlaylistById' index.js`
Expected: `function findPlaylistById` (1) + `api.home.onResolvePlay` registration (2 — the `typeof` guard + the call).

- [ ] **Step 4: Commit (plugin repo only)**

```bash
cd /Users/alex/Code/viboplr-spotify
git add index.js
git commit -m "feat: lazily resolve home-shelf play for un-fetched playlists"
```

**[MANUAL CHECKPOINT — full acceptance]** — With the host change built (worktree-2) and the plugin reloaded, on the Home screen:
1. Press the **play button** on a Spotify card for a playlist NOT yet opened/fetched → a "Loading <name>…" modal appears, the scrape runs, then the queue fills and playback starts.
2. Press play on an already-opened (cached, tracks present) playlist card → plays instantly, **no** modal (resolver not called).
3. A playlist that scrapes empty → modal dismisses, nothing queued (no crash).
4. Close the browse window mid-resolve / rapid double-press → modal dismisses; no stuck modal.
5. Card-body click (not the play button) still navigates into the Spotify view and opens the playlist (unchanged `onItemClick`).
6. Built-in Radio shelf + other plugins' shelves are unaffected.

---

## Self-Review Notes

**Spec coverage** (design → task):
- `onResolvePlay(shelfId, handler)` hook → Task 1 Steps 1-3.
- Host invokes only when `kind:"tracks"` + empty tracks + resolver registered → Task 1 Step 6 (`action.tracks.length > 0` plays direct; else resolver).
- Host shows its own loading modal; empty/error → hide + no-op → Task 1 Step 6 (`setPluginLoadingMessage` + `.finally` clear; empty/throw → no play).
- Plugin resolver = ensureTracks (no UI) → Task 2 Step 2.
- Cached playlist plays instantly, resolver not called → Task 1 Step 6 (non-empty branch).
- Older host / no resolver → unchanged → Task 1 (`invokeHomeShelfResolvePlay` returns null) + Task 2 (`typeof` guard).
- Radio/other kinds untouched → Task 1 only changes the `"tracks"` case.
- Teardown clears resolvers → Task 1 Step 4.
- findPlaylistById lookup → Task 2 Step 1.

**Type/name consistency:** `onResolvePlay` (plugin.ts hook, usePlugins impl, plugin call); `homeShelfResolvePlayHandlersRef` (decl, impl, teardown, accessor); `invokeHomeShelfResolvePlay(pluginId, shelfId, item) → Promise<PluginTrack[]> | null` (accessor, export, App call); `findPlaylistById(pid)` (helper def + resolver call). `PluginTrack`/`HomeShelfItem` already imported in both host files. `setPluginLoadingMessage`/`pluginTrackToQueueTrack`/`queueHook`/`plugins` in scope in App.tsx.

**Note on line numbers:** find-strings are verbatim from current files; anchor on them.
