# Viboplr Spotify Plugin

Browse your Spotify library (liked songs and playlists) inside Viboplr by
scraping the Spotify web app via an embedded browser window. See `SPEC.md` for
architecture details.

Plugin id: `spotify-browse` (so an installed copy overrides the app's bundled
built-in of the same id).

## Install

In Viboplr: **Extensions → Install from URL** and paste this repo's URL, or it
auto-updates if already installed (the app checks `updateUrl` every 24h).

## Develop & Release

1. Edit `index.js` / `manifest.json`. Bump `version` in `manifest.json`.
2. Add a section to `CHANGELOG.md` (top-most `## vX.Y.Z` heading).
3. Build artifacts: `scripts/package.sh` → produces `spotify.zip` + `update.json`.
   - The zip MUST contain `manifest.json` at its root (the script guarantees this;
     verify via the printed `unzip -l`).
4. Publish:
   `gh release create vX.Y.Z spotify.zip update.json --repo outcast1000/viboplr-spotify --title "vX.Y.Z" --notes-file CHANGELOG.md`

The update endpoint is the permanent
`https://github.com/outcast1000/viboplr-spotify/releases/latest/download/update.json`.

## Keep the app's bundled copy in sync

The Viboplr app bundles a baseline copy at `src-tauri/plugins/spotify-browse/`.
On each release, copy `index.js` + `manifest.json` back into that folder so new
installs ship the latest baseline.
