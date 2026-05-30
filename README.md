# Viboplr Spotify Plugin

Browse your Spotify library (liked songs and playlists) inside Viboplr by
scraping the Spotify web app via an embedded browser window. See `SPEC.md` for
architecture details.

Plugin id: `spotify-browse` (so an installed copy overrides the app's bundled
built-in of the same id).

New to writing Viboplr plugins? See **[DEVELOPING.md](DEVELOPING.md)** for the
develop/reload/debug workflow.

## Install

In Viboplr: **Extensions → Install from URL** and paste this repo's URL, or it
auto-updates if already installed (the app checks `updateUrl` every 24h).

## Develop & Release

For every release: edit `index.js` / `manifest.json`, **bump `version` in
`manifest.json`**, and add a `## vX.Y.Z` section at the top of `CHANGELOG.md`.
Then publish via CI (preferred) or manually.

Bump helper: `scripts/bump.sh <patch|minor|major|X.Y.Z>` rewrites the
`manifest.json` version and prepends a `## vX.Y.Z` CHANGELOG section (with a
`TODO` to fill in). It does not commit/tag/push — review, fill in the changelog,
then release.

### Release via CI (preferred)

A GitHub Actions workflow (`.github/workflows/release.yml`) builds and publishes
the release. It verifies the `manifest.json` version matches the release version
and that the zip has `manifest.json` at its root, then attaches `spotify.zip` +
`update.json`. Two ways to trigger it:

- **Push a tag:** after committing the version bump + changelog, run
  `git tag vX.Y.Z && git push origin vX.Y.Z`.
- **Manual dispatch:** GitHub → Actions → *Release* → *Run workflow*, enter the
  version (must equal `manifest.json`). CI creates the tag for you.

### Release manually (fallback)

1. `scripts/package.sh` → produces `spotify.zip` + `update.json`.
   - The zip MUST contain `manifest.json` at its root (the script guarantees this;
     verify via the printed `unzip -l`).
2. `gh release create vX.Y.Z spotify.zip update.json --repo outcast1000/viboplr-spotify --title "vX.Y.Z" --notes-file CHANGELOG.md`

The update endpoint is the permanent
`https://github.com/outcast1000/viboplr-spotify/releases/latest/download/update.json`.

## Keep the app's bundled copy in sync

The Viboplr app bundles a baseline copy at `src-tauri/plugins/spotify-browse/`.
On each release, copy `index.js` + `manifest.json` back into that folder so new
installs ship the latest baseline.
