# CLAUDE.md — viboplr-spotify

This file orients Claude Code working in this repository.

## What this repo is

This is a **plugin for the Viboplr desktop app** — NOT a standalone application.
Viboplr is a Tauri 2 desktop music app (Rust backend + React/TypeScript frontend);
its source lives in the separate host repo **`outcast1000/viboplr`** (likely not
checked out on this machine). This repo contains only the Spotify plugin and ships
it as a versioned release that the host app downloads and auto-updates.

- **Plugin id:** `spotify-browse` (set in `manifest.json`). This plugin is installed
  from the Viboplr plugin gallery (it is not bundled in the app).
- **What it does:** browses your Spotify library (liked songs + playlists) by
  scraping the Spotify web app in an embedded browser window the host provides.
  See `SPEC.md` for architecture.

## The plugin runtime (host-imposed — do not assume a normal Node/browser env)

A plugin is a folder with `manifest.json` + `index.js`. The host runs `index.js`
as the body of `new Function("api", "window", "globalThis", "self", "document",
code)` inside the app's WebView. Consequences:

- The file **must end with** `return { activate, deactivate };` (deactivate optional).
  The host calls `activate(api)` on load.
- `api` (the host bridge) is the ONLY way to talk to the app — you cannot `import`
  anything, and never touch React, the DOM, or host CSS directly. Common pieces:
  `api.network.fetch` (proxied through Rust to bypass CORS — there is **no global
  `fetch`**), `api.network.openBrowseWindow` (the embedded webview used for
  scraping), `api.storage` (KV + nested files), `api.log(level, msg, section)`,
  `api.home`, `api.playback`, `api.playlists`, `api.ui.setViewData`. See
  *Authoritative references* below for the full contract.
- The sandbox is a **frozen** set of globals: `console`, `Math`, `JSON`, `Date`,
  `Promise`, `Object`, `Array`, `String`, `Number`, `RegExp`, `Error`, timers,
  `encode/decodeURIComponent`, `parseInt/parseFloat/isNaN/isFinite`. **No** `require`/
  `import`, no real DOM, no filesystem. Modern JS syntax is fine (no transpile step),
  but this file uses `var`/`function` style by convention — match it.

## Critical gotchas (have caused real bugs)

- **Manifest id vs folder name:** when the host loads a plugin from a "dev folder",
  it keys the plugin by the **manifest `id`** (`spotify-browse`), not the directory
  name (`viboplr-spotify`). Keep `manifest.json`'s `"id": "spotify-browse"` unchanged.
- **Release zip layout:** `spotify.zip` MUST have `manifest.json` at its ROOT (the
  host's installer does not strip a wrapper folder). `scripts/package.sh` guarantees
  this — never hand-zip a folder.
- **No browser/Tauri dev harness exists** for plugins. The realistic dev loop is to
  install/symlink this folder into the host app and reload. See `DEVELOPING.md`.

## Building UI

Render UI by calling `api.ui.setViewData(viewId, data)` where `data` is a
`PluginViewData` node (a discriminated union). The host renders it with native,
skin-aware components. Available node types include:

- Containers: `layout` (vertical/horizontal), `section`, `spacer`, `tabs`,
  `toolbar`, `settings-row`
- Content: `text`, `stats-grid`, `track-list`, `track-row-list`, `card-grid`,
  `detail-header` (native detail hero: crossfade background via `bgImages[]`, FX
  effects, `artShape`, Play/Enqueue, overflow menu)
- Controls: `button`, `toggle` (uses `checked`, NOT `value`), `select`,
  `search-input`, `text-input`
- Feedback: `loading` (spinner + message), `progress-bar`, `confirm`

Handle clicks/changes by giving nodes an `action` string and registering
`api.ui.onAction(actionId, handler)`.

### UI rules

- Prefer the built-in node types over custom styling. `text`/`button`/`layout`
  accept an optional `className`, and the host's stable design-system classes
  (`ds-btn`, `ds-spinner`, `ds-card`, …) are available globally — but treat
  internal class names as non-stable; the node types are the real contract.
- Never hardcode colors. The host is skinnable; rendered components already use
  skin CSS variables.
- For spinners use `{ type: "loading", message }`; for determinate progress use
  `{ type: "progress-bar", value, max, label }`. Don't reinvent these.
- For detail-page metadata tabs (artist bio, lyrics, stats…), don't build a view —
  contribute an information type and return data via
  `api.informationTypes.onFetch(id, handler)`.
- For Home-page shelves use `api.home` (`registerShelf` / `onFetchShelf` /
  `onItemClick`); keep fetch handlers under the 5s timeout.
- Every track surface you render should support context menus
  (`api.contextMenu.onAction`); plugin-registered menu items appear everywhere.

## Authoritative references (in the host repo `outcast1000/viboplr` — read, don't guess)

1. `PLUGIN-API-REFERENCE.md` — prose API reference for the whole `api` surface.
2. `src/types/plugin.ts` — THE canonical type contract. Always verify a symbol
   exists here before using it. Read especially:
   - `PluginViewData` (every UI node shape)
   - `ViboplrPluginAPI` (the full `api` object: `ui`, `home`, `playback`,
     `library`, `contextMenu`, `storage`, `network`, `informationTypes`,
     `imageProviders`, `downloads`, `scheduler`, `system`, `env`)
   - `PluginTrack`, `CardGridItem`, `HomeShelfItem`/`HomeShelfResult`,
     `PluginContextMenuTarget`, `PluginManifestContributes`
3. `src/types/informationTypes.ts` — `DisplayKind` + the data shape for each
   information-section renderer (rich_text, html, entity_list, stat_grid, lyrics,
   ranked_list, image_gallery, title_line, …).
4. `.claude/rules/plugins.md` — prose guide: every `api.*` namespace, the "Plugin
   View Rendering" table, display-kind schemas, home-shelf and context-menu
   contracts, the plugin lifecycle.
5. `.claude/rules/ui.md` — host UI conventions to match (entity rendering modes,
   `.ds-*` design-system classes, skin variables, detail-page layout).
6. `src/types/skin.ts` — skin color keys, only if you style by class.

### Example plugins to copy patterns from (host repo `src-tauri/plugins/`)

- `auto-tagger` — richest UI: `tabs`, `track-row-list`, `select`, `toggle`,
  `section`, `loading`, `progress-bar`, `settings-row`.
- `lastfm`, `youtube` — settings-panel UIs.
- For `detail-header` heroes + per-section home shelves, **this repo's own
  `index.js`** is the canonical consumer.

## How to release

See `README.md` → *Develop & Release*. In short:

1. Edit `index.js` / `manifest.json`; **bump the version** (`scripts/bump.sh patch|minor|major`).
2. Update `CHANGELOG.md` (top `## vX.Y.Z` section).
3. Push a tag `vX.Y.Z` (or run the *Release* GitHub Action manually) — CI builds
   `spotify.zip` + `update.json` and publishes the release. The host checks the
   permanent `releases/latest/download/update.json` every 24h.

## Docs in this repo

- `README.md` — install + release flow
- `DEVELOPING.md` — plugin develop/debug workflow (sandbox, reload loop, DevTools, `api.log`)
- `SPEC.md` — this plugin's scraping architecture
- `jsguide.md` — DOM selectors / JS snippets used against the Spotify web app
