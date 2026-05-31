# Plugin-View Scroll Memory — Design

**Date:** 2026-05-31
**Status:** Approved (design); implementation pending
**Repos:** `outcast1000/viboplr` (host) + `viboplr-spotify` (plugin)

## Summary

When the Spotify plugin navigates from the main panel (scrolled down) into a
playlist detail view, the detail view opens already-scrolled instead of at the
top. Root cause: the plugin renders both home and the playlist into the **same
view id** (`"spotify"`) via `api.ui.setViewData`; the host's scroll container
(`.plugin-view`) stays mounted across the content swap and keeps its `scrollTop`.
The plugin has no DOM access to reset it.

Fix: give the host **per-view scroll memory** keyed by a plugin-supplied
`scrollKey`. The host saves/restores `scrollTop` per key, browser-style:

- home → playlist (new key) → opens at **top**.
- playlist → **Back** → home (known key) → home scroll **restored**.
- progressive track updates (same key, ~600ms) → **no** scroll change.

Generic host feature (any plugin swapping content within one view benefits);
the Spotify plugin opts in by tagging its renders.

## Why this mechanism

The host can't naively "reset scroll when data changes" — the plugin calls
`setViewData` repeatedly for the *same* logical view (progressive track loading).
A plugin-declared `scrollKey` that changes only on navigation is the precise
signal. An imperative `scrollToTop` was considered but rejected: it can't
*restore* the previous home position on Back (that requires host-side memory).

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Mechanism | Per-view scroll memory keyed by a plugin-supplied `scrollKey` |
| Host API | `api.ui.setViewData(viewId, data, opts?: { scrollKey?: string })` |
| Save/restore timing | Scroll-restoration pattern: a `useLayoutEffect` keyed on `scrollKey` restores the incoming key's saved position (0 if unseen) and attaches a `scroll` listener that continuously records the current key's `scrollTop`. Saving continuously (not at navigation time) is required because a post-commit effect can't read the *outgoing* view's scroll — the new content has already replaced the container's children. |
| Same key | No scroll change (progressive updates untouched) |
| No `scrollKey` | Unchanged behavior — scroll persists as today (backward-compatible) |
| Persistence | Session-only (in-memory; cleared on app restart / plugin reload) |
| Memory bound | Cap the saved-positions map (keep most-recent ~50 keys) |
| Plugin keys | home → `"home"`; playlist detail → `"playlist:" + pl.id` |
| Host commit | worktree-2 (`/Users/alex/Code/viboplr/.claude/worktrees/2`), **uncommitted** |
| Plugin commit | committed on this repo's branch |

## Host changes (`outcast1000/viboplr`, worktree-2 — uncommitted)

### 1. `src/hooks/usePlugins.ts` — carry `scrollKey` through `setViewData`

`setViewData: (viewId, data) => { … }` (~line 445) stores data in
`viewDataRef.current` keyed by `${pluginId}:${viewId}`. Add an optional third
arg and store the scroll key in a parallel ref map:

- Add `scrollKey?: string` opts param.
- Keep a `scrollKeyRef = useRef<Map<string,string>>` (key `${pluginId}:${viewId}`
  → latest `scrollKey`), set on each call.
- Expose the current scroll key to the renderer the same way `getViewData`
  exposes data (a `getViewScrollKey(pluginId, viewId)` accessor, or include it
  in the value returned by `getViewData`). Whichever fits the existing pattern;
  the renderer needs `(data, scrollKey)` for the mounted view.

### 2. `src/types/plugin.ts` — type the new arg

In `ViboplrPluginAPI.ui`, change `setViewData`'s signature to
`setViewData(viewId: string, data: PluginViewData, opts?: { scrollKey?: string }): void`.

### 3. `src/components/PluginViewRenderer.tsx` — scroll memory

The component renders `<div className="plugin-view">` — the scroll container.
Add a new prop `scrollKey?: string` and:

- A `ref` on the `.plugin-view` div.
- A persisted `Map<string, number>` of saved scroll positions (a `useRef` map so
  it survives re-renders; bounded to ~50 entries — evict oldest on insert).
- A `useLayoutEffect` keyed on `scrollKey` (no-op when `scrollKey` is undefined):
  - restore: `el.scrollTop = map.get(scrollKey) ?? 0`,
  - attach a passive `scroll` listener that records `map.set(scrollKey, el.scrollTop)`
    on each scroll (re-inserting the key so recently-used keys survive the
    size-bound eviction), removed on cleanup.
  Continuous recording means the position is always saved *before* navigation,
  avoiding the post-commit timing problem. Same-key re-renders re-run the effect
  harmlessly (restore to the already-current position).

### 4. `src/App.tsx` — pass `scrollKey` to the sidebar `PluginViewRenderer`

At the `plugin:` view mount (~line 2725), it already does
`const data = plugins.getViewData(pluginId, viewId)`. Also read the scroll key
(via the accessor from change 1) and pass `scrollKey={…}` to `PluginViewRenderer`.

### 5. `.claude/rules/plugins.md` — document the opts arg

Update the `setViewData` reference to note the optional
`{ scrollKey }` — "host saves/restores scroll position per `scrollKey`; change
it on navigation, keep it stable on in-place updates."

## Plugin change (`viboplr-spotify`, this repo — committed)

### 6. `index.js` — tag each render with a `scrollKey`

The plugin calls `api.ui.setViewData("spotify", …)` from `renderHome` (two
sites: the empty-home early return and the normal home render) and
`renderPlaylist`. Pass `{ scrollKey }`:

- `renderHome` (both `setViewData("spotify", …)` calls) → `{ scrollKey: "home" }`.
- `renderPlaylist` → `{ scrollKey: "playlist:" + pl.id }`.

`renderSettings` writes a different view id (`"spotify-settings"`) — leave it
alone (no scrollKey needed; that panel isn't the navigation in question).

Because progressive track updates re-run `renderPlaylist` with the same
`"playlist:<id>"` key, scroll is not reset during loading.

## Data flow

```
home scrolled 800px   setViewData("spotify", home, {scrollKey:"home"})
  → click playlist 42  setViewData("spotify", detail, {scrollKey:"playlist:42"})
       host: key home→playlist:42 changed → save home=800, restore playlist:42=0 (unseen) → top
  → tracks stream in   setViewData("spotify", detail, {scrollKey:"playlist:42"})  (×N)
       host: key unchanged → no scroll change
  → Back               setViewData("spotify", home, {scrollKey:"home"})
       host: key playlist:42→home changed → save playlist:42, restore home=800 → restored
```

## Error / edge handling

- **No `scrollKey`** (other plugins, or this plugin's settings view): host skips
  save/restore entirely; scroll persists as today. Backward-compatible.
- **`.plugin-view` ref null** (not yet mounted): effect guards on the ref; no-op.
- **Unseen key**: restores to 0 (top) — correct for a freshly-opened detail.
- **Map growth**: bounded to ~50 most-recent keys; evict oldest.
- **App restart / plugin reload**: memory cleared (session-only) — opens at top,
  acceptable.

## Out of scope

- Persisting scroll across app restarts.
- Scroll memory for the settings panel (`spotify-settings`).
- Animated/smooth scroll restoration (instant set, pre-paint).
- Any other plugin adopting `scrollKey` (they can later; no change forced).

## Testing

- Host: `tsc --noEmit` in worktree-2 (the signature + prop changes typecheck).
- Plugin: `node --check index.js` (exit 0).
- No automated harness; real validation is reloading in the host (with the host
  change built) and confirming: scroll home → open playlist → at top; Back →
  home restored; loading a big playlist → no scroll jump mid-load.
