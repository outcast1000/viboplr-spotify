# Verify-Scrape Harness — Design

**Date:** 2026-06-01
**Status:** Approved, pending implementation plan

## Problem

After every change to the scraping logic in `index.js`, the only way to know
whether it still works is to install the plugin into the Viboplr host app, reload
it, and look — a human-in-the-loop step. The host app isn't even checked out on
this machine, and there is no plugin dev harness. The failure we most need to
catch is **scraping breaks**: Spotify ships DOM changes and our selectors silently
return empty/wrong data.

The scrape logic is favorably structured for automation: it lives as
self-contained JavaScript **strings** (`SCRIPT_CHECK_LOGIN`,
`SCRIPT_SCRAPE_SHELVES`, `scriptNavigatePlaylist`, `scriptScrollThenScrape`) that
the host `eval`s in a browser on `open.spotify.com`, and they report results
through one narrow channel: `window.__viboplr.send(channel, payload)`. Anything
that can open a logged-in Spotify page, shim that `send`, and eval those exact
strings can verify scraping without the host app.

## Goal

A standalone, on-demand Node script that runs the **actual production scrape
scripts** (pulled live from `index.js`) against the **real live Spotify DOM** in
Playwright Chromium, and prints a pass/fail verdict with counts. Claude (or a
human) runs it after editing and reads the verdict directly — no host app, no
human in the loop for the happy path.

Non-goals: verifying host-app UI rendering, plugin activation/load, or
state/caching logic. This harness is scraping-only (the #1 pain point). Offline
fixture replay and CI integration are explicitly deferred.

## Approach

A Node script `scripts/verify-scrape.mjs`, run via `npm run verify:scrape`. It
drives a real logged-in Spotify session in a headed Playwright Chromium with a
persistent (gitignored) browser profile, so login is a one-time manual step that
persists across runs.

### 1. Script extraction (the seam)

The script-building region of `index.js` (currently ~lines 1357–1819: `DBG_HELPER`
through `MUSIC_CHIP_URL`, including the `scriptNavigatePlaylist` /
`scriptScrollThenScrape` builder functions) is wrapped in sentinel comments:

```js
// >>> SCRAPE-SCRIPTS-START  (do not remove: scripts/extract-scripts.mjs slices between these)
var DBG_HELPER = ...
...
var MUSIC_CHIP_URL = "https://open.spotify.com/home?facet=music-chip";
// <<< SCRAPE-SCRIPTS-END
```

Extraction is factored into a small standalone module, `scripts/extract-scripts.mjs`
(so it is unit-testable on its own); the harness imports it. The module reads
`index.js`, slices the text between the two markers, and evaluates that block in a
Node `vm` context with a minimal `window` / `console` stub. The block only performs
string concatenation and function definitions and has **no dependency on `api`**, so
the stub is never actually exercised at build time. It then reads these symbols out
of the VM context:

- `SCRIPT_CHECK_LOGIN` (string)
- `SCRIPT_SCRAPE_SHELVES` (string)
- `scriptNavigatePlaylist` (function → string)
- `scriptScrollThenScrape` (function → string)
- `MUSIC_CHIP_URL` (string)

This keeps the harness automatically in sync with production — no copy-paste, no
regex drift. The only coupling is the two marker comments.

**Failure mode (accepted):** if the markers are missing or the block fails to
eval, the harness errors loudly and exits non-zero. It never silently tests stale
or partial code.

### 2. Browser session & the `__viboplr` shim

- Playwright `launchPersistentContext("scripts/.spotify-profile/")`, headed.
- The profile directory is gitignored and persists the Spotify login across runs.
- On startup the harness evals `SCRIPT_CHECK_LOGIN`; if not logged in, it prints
  `Log into Spotify in the opened window, then press Enter.` and waits on stdin.
  After login it re-checks before proceeding.
- Before evaluating any scrape script, the harness installs the bridge the
  scripts expect:
  ```js
  window.__viboplr = { send: (type, data) => window.__viboplrCollect({ type, data }) };
  ```
  where `__viboplrCollect` is a Playwright `exposeFunction` callback that pushes
  each message into a Node-side queue. This mirrors how the host's
  `handle.onMessage` receives `send(...)` payloads.

### 3. Verification sequence (mirrors the in-app `dbgTest` flow)

This reproduces the proven sequence already used by the in-app debug harness
(`dbgRunStep` in `index.js`, steps `login` / `scrape-shelves` / `scrape-tracks`):

1. **Login:** navigate to `MUSIC_CHIP_URL`, wait for load, eval
   `SCRIPT_CHECK_LOGIN`, await a `login-check` message. If `loggedIn` is false,
   prompt for manual login (section 2) and retry.
2. **Shelves:** eval `SCRIPT_SCRAPE_SHELVES`, await a `shelves` message (30s
   timeout). Collect `shelves[]` and flatten to a playlist list.
3. **Tracks:** pick the first scraped playlist id, eval
   `scriptNavigatePlaylist(id)`, wait, eval `scriptScrollThenScrape(id, 999)`,
   await a `tracks` message (30s timeout).

Waits use a fixed settle delay after navigation (matching the host's 4–5s waits)
plus a message-or-timeout race per step.

### 4. Verdict & exit code

Prints a human-readable summary to stdout:

- shelves found (count)
- total cards across all shelves
- cards-per-shelf breakdown
- sampled playlist: track count + a sample of 3 parsed tracks (title / artist)

**Exit non-zero** if any of:

- script extraction failed (missing markers / eval error)
- not logged in after the manual-login prompt
- 0 shelves found
- 0 playlist cards across all shelves (note: the scrape script only emits
  shelves that already have ≥1 card, so "an empty shelf" can't occur — we assert
  on the total instead)
- 0 tracks on the sampled playlist

Otherwise exit 0. This makes the verdict machine-readable for Claude or CI.

## Files

**New:**
- `scripts/verify-scrape.mjs` — the harness CLI (Playwright driver + verdict).
- `scripts/extract-scripts.mjs` — the extraction seam (slice + vm-eval), imported
  by the harness and unit-tested independently.
- `scripts/extract-scripts.test.mjs` — `node --test` unit test for extraction.
- `package.json` — repo currently has none (the plugin ships without one). Adds
  `playwright` as a `devDependency` and `verify:scrape` + `test` scripts. The plugin
  release artifact is unaffected (`scripts/package.sh` zips only plugin files).
- `.gitignore` additions: `scripts/.spotify-profile/`, `node_modules/`.

**Edited:**
- `index.js` — add the two sentinel marker comments around the existing
  script-building block. **Zero logic change.**

**Docs:**
- `DEVELOPING.md` — a short "Verifying scraping locally" section (one-time login,
  `npm run verify:scrape`, reading the verdict).

## Risks & mitigations

- **Marker comments deleted by future edits** → harness fails loudly (safe).
- **Spotify login expires** → harness detects via `SCRIPT_CHECK_LOGIN` and prompts
  re-login; profile re-persists.
- **Playwright Chromium version drift vs. host WebView** → acceptable: we test the
  scrape *logic* against live DOM, not pixel-identical rendering. Chromium is
  already cached locally.
- **Builder block grows an `api` dependency later** → the VM stub would throw at
  extraction time, surfacing it immediately rather than silently.

## Deferred (not in this work)

- Offline DOM-snapshot fixtures + headless replay (fast CI regression checks).
- Wiring into `scripts/bump.sh` / release flow or a git pre-push hook.
