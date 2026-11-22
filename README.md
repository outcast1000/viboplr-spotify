# Viboplr Spotify Plugin

Browse your Spotify library (liked songs and playlists) and search Spotify for
songs inside Viboplr by scraping the Spotify web app via an embedded browser
window. Search works from the box at the top of the Spotify view and from the
app's global search (Cmd+K). See `SPEC.md` for architecture details.

Plugin id: `spotify-browse` (installed from the Viboplr plugin gallery).

New to writing Viboplr plugins? See **[DEVELOPING.md](DEVELOPING.md)** for the
develop/reload/debug workflow.

## Spotify's private web-player API

Tracklists (playlists, albums, Liked Songs) and song-radio stations are read
straight from the endpoints the Spotify web player itself calls, from inside the
signed-in browse window — the page scrape is the fallback (SPEC.md "On-demand
track fetch"). The map of those endpoints comes from
**[SpotAPI](https://github.com/Aran404/SpotAPI)** (Python, GPL-3.0), which
documents them in code:

- `spotapi/operations.py` — every Pathfinder GraphQL operation name
  (`api-partner.spotify.com/pathfinder/v2/query`, persisted queries by sha256).
- `spotapi/_protocol/routes.py` — the spclient REST routes (`color-lyrics`,
  `inspiredby-mix`, `playlistextender`, `canvaz-cache`, `playlist/v2`,
  `connect-state`, …).
- `spotapi/session.py` + `spotapi/_protocol/totp.py` — how a client without a
  browser gets a token (TOTP secret from the web-player bundle → `/api/token` →
  `clienttoken`). We don't need this: the page already holds a token, which we
  copy from its own requests.
- `spotapi/_protocol/bundles.py` — the `"<op>","query","<sha256>"` pattern for
  finding persisted-query hashes in the web-player JS.

**Use it as a reference only — don't copy code.** SpotAPI is GPL-3.0; this
plugin reimplements what it needs. These endpoints are undocumented and
unauthorised by Spotify: they can change with any web-player release, which is
why every direct read has a page-scrape fallback and `npm run verify:direct` /
`verify:all` check them live. Read-only use so far; writing to the account
(likes, playlists, follows) would be a separate, opt-in decision.

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
