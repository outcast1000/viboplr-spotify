# CLAUDE.md — viboplr-spotify

This file orients Claude Code working in this repository.

## What this repo is

This is a **plugin for the Viboplr desktop app** — NOT a standalone application.
Viboplr is a Tauri 2 desktop music app (Rust backend + React/TypeScript frontend);
its source lives in the separate host repo **`outcast1000/viboplr`** (likely not
checked out on this machine). This repo contains only the Spotify plugin and ships
it as a versioned release that the host app downloads and auto-updates.

- **Plugin id:** `spotify-browse` (set in `manifest.json`). An installed copy with
  this id overrides the app's bundled built-in copy of the same id.
- **What it does:** browses your Spotify library (liked songs + playlists) by
  scraping the Spotify web app in an embedded browser window the host provides.
  See `SPEC.md` for architecture.

## The plugin runtime (host-imposed — do not assume a normal Node/browser env)

The host runs `index.js` as the body of `new Function("api", "window", "globalThis",
"self", "document", code)` inside the app's WebView. Consequences:

- The file **must end with** `return { activate, deactivate };` (deactivate optional).
  The host calls `activate(api)` on load.
- `api` (the host bridge) is the ONLY way to talk to the app. Full API reference
  lives in the host repo's `PLUGIN-API-REFERENCE.md`; common pieces: `api.network.fetch`
  (proxied through Rust to bypass CORS — there is **no global `fetch`**),
  `api.network.openBrowseWindow` (the embedded webview used for scraping),
  `api.storage` (KV + nested files), `api.log(level, msg, section)`, `api.home`,
  `api.playback`, `api.playlists`, `api.ui.setViewData`.
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

## How to release (this is the canonical source; the host bundles a baseline copy)

See `README.md` → *Develop & Release*. In short:
1. Edit `index.js` / `manifest.json`; **bump the version** (`scripts/bump.sh patch|minor|major`).
2. Update `CHANGELOG.md` (top `## vX.Y.Z` section).
3. Push a tag `vX.Y.Z` (or run the *Release* GitHub Action manually) — CI builds
   `spotify.zip` + `update.json` and publishes the release. The host checks the
   permanent `releases/latest/download/update.json` every 24h.
4. The host app also bundles a baseline copy at `src-tauri/plugins/spotify-browse/`;
   after a release, sync `index.js` + `manifest.json` back into that host folder so
   fresh installs ship the latest baseline.

## Docs in this repo

- `README.md` — install + release flow
- `DEVELOPING.md` — plugin develop/debug workflow (sandbox, reload loop, DevTools, `api.log`)
- `SPEC.md` — this plugin's scraping architecture
- `jsguide.md` — DOM selectors / JS snippets used against the Spotify web app
