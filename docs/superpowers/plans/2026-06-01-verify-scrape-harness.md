# Verify-Scrape Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone Node script that runs the real scrape scripts pulled live from `index.js` against the live Spotify DOM in Playwright, and prints a pass/fail verdict — verifying scraping without the host app.

**Architecture:** Sentinel comments in `index.js` delimit the self-contained script-building block. The harness slices that text, evals it in a Node `vm` to recover the `SCRIPT_*` strings, then drives a headed persistent-profile Playwright Chromium: shim `window.__viboplr.send`, eval the scripts on `open.spotify.com`, collect messages, assert counts, exit non-zero on failure.

**Tech Stack:** Node 22 (ESM `.mjs`), Node built-in `vm`, Playwright (`launchPersistentContext`), `node --test` for the extraction unit test.

---

## File Structure

- `index.js` — **modify**: add two sentinel comment markers around the existing script block (lines ~1356–1819). Zero logic change.
- `package.json` — **create**: devDependency `playwright`, scripts `verify:scrape` and `test`.
- `.gitignore` — **modify**: add `node_modules/` and `scripts/.spotify-profile/`.
- `scripts/extract-scripts.mjs` — **create**: pure module that reads `index.js`, slices between markers, evals in a `vm`, and returns `{ SCRIPT_CHECK_LOGIN, SCRIPT_SCRAPE_SHELVES, scriptNavigatePlaylist, scriptScrollThenScrape, MUSIC_CHIP_URL }`. Isolated so it can be unit-tested without a browser.
- `scripts/verify-scrape.mjs` — **create**: the harness CLI. Imports `extract-scripts.mjs`, drives Playwright, prints verdict, sets exit code.
- `scripts/extract-scripts.test.mjs` — **create**: `node --test` unit test for extraction.
- `DEVELOPING.md` — **modify**: add a "Verifying scraping locally" section.

---

## Task 1: Add sentinel markers to index.js

**Files:**
- Modify: `index.js` (around line 1357 and line 1819)

- [ ] **Step 1: Add the START marker**

In `index.js`, find this block (~line 1356):

```js
  // ---- Injected scripts (plain strings for eval) ----

  var DBG_HELPER =
```

Replace it with:

```js
  // ---- Injected scripts (plain strings for eval) ----

  // >>> SCRAPE-SCRIPTS-START (do not remove: scripts/extract-scripts.mjs slices between these markers)
  var DBG_HELPER =
```

- [ ] **Step 2: Add the END marker**

In `index.js`, find this block (~line 1819):

```js
  var MUSIC_CHIP_URL = "https://open.spotify.com/home?facet=music-chip";

  function withSpotifyWindow(opts, fn) {
```

Replace it with:

```js
  var MUSIC_CHIP_URL = "https://open.spotify.com/home?facet=music-chip";
  // <<< SCRAPE-SCRIPTS-END

  function withSpotifyWindow(opts, fn) {
```

- [ ] **Step 3: Verify the markers bracket a self-contained block**

Run: `node -e 'const s=require("fs").readFileSync("index.js","utf8");const m=s.match(/SCRAPE-SCRIPTS-START[^\n]*\n([\s\S]*?)\n\s*\/\/ <<< SCRAPE-SCRIPTS-END/);console.log(m?"MATCH, "+m[1].length+" chars":"NO MATCH")'`
Expected: `MATCH, ` followed by a length around 30000–40000 chars (non-zero).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "chore: mark scrape-script block with extraction sentinels"
```

---

## Task 2: Project scaffolding (package.json, .gitignore)

**Files:**
- Create: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "viboplr-spotify-dev",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Dev tooling for the spotify-browse Viboplr plugin (NOT shipped in the plugin release)",
  "scripts": {
    "verify:scrape": "node scripts/verify-scrape.mjs",
    "test": "node --test scripts/"
  },
  "devDependencies": {
    "playwright": "^1.48.0"
  }
}
```

- [ ] **Step 2: Add dev artifacts to .gitignore**

Append these lines to `.gitignore`:

```
node_modules/
scripts/.spotify-profile/
```

- [ ] **Step 3: Install Playwright**

Run: `npm install`
Expected: completes, creates `node_modules/` and `package-lock.json`. (Playwright's Chromium is already cached on this machine; if `npm run verify:scrape` later complains about a missing browser, run `npx playwright install chromium`.)

- [ ] **Step 4: Confirm release zip is unaffected**

Run: `grep -o 'zip -q spotify.zip[^\n]*' scripts/package.sh`
Expected: `zip -q spotify.zip manifest.json index.js SPEC.md jsguide.md` — note it lists files explicitly and does NOT include `package.json`/`node_modules`, so the plugin artifact stays clean.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: add dev package.json with playwright + verify:scrape script"
```

---

## Task 3: Script extraction module (with unit test)

**Files:**
- Create: `scripts/extract-scripts.mjs`
- Test: `scripts/extract-scripts.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/extract-scripts.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractScripts } from "./extract-scripts.mjs";

test("extracts the scrape scripts from index.js", () => {
  const s = extractScripts(new URL("../index.js", import.meta.url).pathname);

  // The two eval'd strings must be non-empty self-invoking functions.
  assert.match(s.SCRIPT_CHECK_LOGIN, /^\(function\(\)\{/);
  assert.match(s.SCRIPT_SCRAPE_SHELVES, /^\(function\(\)\{/);
  assert.ok(s.SCRIPT_SCRAPE_SHELVES.includes("__viboplr"), "scrape script uses the send bridge");

  // The two builders must be functions that produce eval'able strings.
  assert.equal(typeof s.scriptNavigatePlaylist, "function");
  assert.equal(typeof s.scriptScrollThenScrape, "function");
  assert.match(s.scriptNavigatePlaylist("abc123"), /abc123/);
  assert.match(s.scriptScrollThenScrape("abc123", 999), /abc123/);

  assert.equal(s.MUSIC_CHIP_URL, "https://open.spotify.com/home?facet=music-chip");
});

test("throws loudly when markers are missing", () => {
  assert.throws(
    () => extractScripts(new URL("../package.json", import.meta.url).pathname),
    /SCRAPE-SCRIPTS markers/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/extract-scripts.test.mjs`
Expected: FAIL — cannot find module `./extract-scripts.mjs`.

- [ ] **Step 3: Implement the extraction module**

Create `scripts/extract-scripts.mjs`:

```js
// Pulls the eval'd scrape scripts out of index.js so the verify harness always
// runs the SAME code the host app runs. The script-building block in index.js
// is delimited by sentinel comments and is self-contained (string concatenation
// + builder functions only — no dependency on `api`), so it can be eval'd in a
// bare vm context with a stub window/console.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const MARKER_RE =
  /\/\/ >>> SCRAPE-SCRIPTS-START[^\n]*\n([\s\S]*?)\n\s*\/\/ <<< SCRAPE-SCRIPTS-END/;

export function extractScripts(indexPath) {
  const source = readFileSync(indexPath, "utf8");
  const m = source.match(MARKER_RE);
  if (!m) {
    throw new Error(
      "SCRAPE-SCRIPTS markers not found in " + indexPath +
        " — cannot extract scrape scripts (see Task 1 of the verify-scrape plan)."
    );
  }

  // The block is written with `var`/`function` declarations. Eval it in a vm
  // whose global object we can read back afterward. `window`/`console` are
  // stubbed but never actually called during string assembly.
  const sandbox = { window: { __viboplr: { send() {} } }, console: { log() {}, error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: "index.js#scrape-scripts" });

  const out = {
    SCRIPT_CHECK_LOGIN: sandbox.SCRIPT_CHECK_LOGIN,
    SCRIPT_SCRAPE_SHELVES: sandbox.SCRIPT_SCRAPE_SHELVES,
    scriptNavigatePlaylist: sandbox.scriptNavigatePlaylist,
    scriptScrollThenScrape: sandbox.scriptScrollThenScrape,
    MUSIC_CHIP_URL: sandbox.MUSIC_CHIP_URL,
  };

  for (const [k, v] of Object.entries(out)) {
    if (v == null) throw new Error("extraction produced no value for " + k);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/extract-scripts.test.mjs`
Expected: PASS — both tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-scripts.mjs scripts/extract-scripts.test.mjs
git commit -m "feat: extract scrape scripts from index.js via sentinel markers"
```

---

## Task 4: The verify-scrape harness CLI

**Files:**
- Create: `scripts/verify-scrape.mjs`

- [ ] **Step 1: Implement the harness**

Create `scripts/verify-scrape.mjs`:

```js
// Verify the Spotify scrape scripts against the LIVE Spotify DOM, without the
// host app. Mirrors the in-app dbgTest flow (index.js): login-check, scrape
// shelves, then navigate + scrape one playlist's tracks.
//
//   npm run verify:scrape
//
// First run: a headed Chromium opens; log into Spotify, then press Enter. The
// login persists in scripts/.spotify-profile/ (gitignored) for later runs.
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { extractScripts } from "./extract-scripts.mjs";

const PROFILE_DIR = new URL("./.spotify-profile/", import.meta.url).pathname;
const INDEX_PATH = new URL("../index.js", import.meta.url).pathname;
const SETTLE_MS = 4500; // matches the host's post-navigation waits
const STEP_TIMEOUT_MS = 30000;

function prompt(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(q).finally(() => rl.close());
}

// Install the window.__viboplr.send bridge the scripts expect, funnelling every
// send() into a Node-side queue. Returns helpers to await a message by type.
async function installBridge(page) {
  const queue = [];
  const waiters = [];
  await page.exposeFunction("__viboplrCollect", (msg) => {
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg.data); }
    else queue.push(msg);
  });
  await page.addInitScript(() => {
    window.__viboplr = { send: (type, data) => window.__viboplrCollect({ type, data }) };
  });
  return {
    // Re-install after a navigation (addInitScript covers fresh docs, but eval
    // targets the current doc, so ensure the bridge object exists too).
    ensure: () =>
      page.evaluate(() => {
        if (!window.__viboplr) {
          window.__viboplr = { send: (type, data) => window.__viboplrCollect({ type, data }) };
        }
      }),
    wait: (type) =>
      new Promise((resolve, reject) => {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return resolve(queue.splice(i, 1)[0].data);
        const timer = setTimeout(() => {
          const j = waiters.findIndex((w) => w.timer === timer);
          if (j >= 0) waiters.splice(j, 1);
          reject(new Error(`timeout waiting for "${type}" message`));
        }, STEP_TIMEOUT_MS);
        waiters.push({ type, resolve, timer });
      }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const S = extractScripts(INDEX_PATH);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const bridge = await installBridge(page);

  try {
    // --- Step 1: login ---
    await page.goto(S.MUSIC_CHIP_URL, { waitUntil: "domcontentloaded" });
    await sleep(SETTLE_MS);
    await bridge.ensure();
    await page.evaluate((s) => eval(s), S.SCRIPT_CHECK_LOGIN);
    let login = await bridge.wait("login-check");
    if (!login.loggedIn) {
      await prompt("Not logged in. Log into Spotify in the window, then press Enter…");
      await page.goto(S.MUSIC_CHIP_URL, { waitUntil: "domcontentloaded" });
      await sleep(SETTLE_MS);
      await bridge.ensure();
      await page.evaluate((s) => eval(s), S.SCRIPT_CHECK_LOGIN);
      login = await bridge.wait("login-check");
      if (!login.loggedIn) throw new Error("still not logged in after prompt");
    }
    console.log("✓ logged in");

    // --- Step 2: scrape shelves ---
    await page.evaluate((s) => eval(s), S.SCRIPT_SCRAPE_SHELVES);
    const shelvesData = await bridge.wait("shelves");
    const shelves = shelvesData.shelves || [];
    const allPlaylists = shelves.flatMap((sh) => sh.playlists || []);

    // --- Step 3: scrape one playlist's tracks ---
    let tracksData = null;
    if (allPlaylists.length > 0) {
      const pl = allPlaylists[0];
      await page.evaluate((s) => eval(s), S.scriptNavigatePlaylist(pl.id));
      await sleep(SETTLE_MS + 500);
      await bridge.ensure();
      await page.evaluate((s) => eval(s), S.scriptScrollThenScrape(pl.id, 999));
      tracksData = await bridge.wait("tracks");
    }

    // --- Verdict ---
    // Emitted shapes (see index.js scrape scripts):
    //   shelf:    { section, description, playlists: [{ id, name, subtitle, imageUrl }] }
    //   track:    { name, artist, album, duration, imageUrl, spotifyId }
    // Note: SCRIPT_SCRAPE_SHELVES only emits shelves with >=1 playlist, so an
    // empty shelf can never appear here — don't assert on it.
    const totalCards = allPlaylists.length;
    const tracks = (tracksData && tracksData.tracks) || [];

    console.log("\n===== VERIFY SCRAPE VERDICT =====");
    console.log(`shelves: ${shelves.length}`);
    console.log(`total cards: ${totalCards}`);
    for (const sh of shelves) console.log(`  • ${sh.section}: ${(sh.playlists || []).length} cards`);
    if (allPlaylists.length > 0) {
      console.log(`sampled playlist: "${allPlaylists[0].name}" → ${tracks.length} tracks`);
      for (const t of tracks.slice(0, 3)) console.log(`  ♪ ${t.name || "?"} — ${t.artist || "?"}`);
    }

    const failures = [];
    if (shelves.length === 0) failures.push("0 shelves found");
    if (allPlaylists.length === 0) failures.push("0 playlist cards across all shelves");
    if (allPlaylists.length > 0 && tracks.length === 0) failures.push("sampled playlist returned 0 tracks");

    if (failures.length > 0) {
      console.log("\n✗ FAIL:\n  - " + failures.join("\n  - "));
      process.exitCode = 1;
    } else {
      console.log("\n✓ PASS");
    }
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error("\n✗ harness error:", e.message);
  process.exitCode = 1;
});
```

- [ ] **Step 2: First run — log in and observe the verdict**

Run: `npm run verify:scrape`
Expected: a Chromium window opens on Spotify. On first run you'll be prompted to log in — do so, return to the terminal, press Enter. The harness then prints the verdict block and exits. PASS if your account has Music-home shelves with cards and the first playlist has tracks.

> Note: this step needs a real Spotify login and a live network, so it is run manually by the developer — not in CI.

- [ ] **Step 3: Confirm the exit code is wired**

Run: `npm run verify:scrape; echo "exit=$?"`
Expected: `exit=0` on a healthy scrape (or `exit=1` with a FAIL block if scraping is broken — which is the whole point).

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-scrape.mjs
git commit -m "feat: add verify-scrape Playwright harness for live scrape checks"
```

---

## Task 5: Document the workflow

**Files:**
- Modify: `DEVELOPING.md`

- [ ] **Step 1: Add a "Verifying scraping locally" section**

Insert this section into `DEVELOPING.md` immediately after the `## 5. Debugging` section (before `## 6. Cleaning up`):

````markdown
---

## 5b. Verifying scraping locally (no host app)

Scraping runs against the live Spotify DOM, which changes without notice. To
check whether the scrape logic still works **without** installing into the host
app, run the harness:

```bash
npm install          # first time only (installs Playwright)
npm run verify:scrape
```

A headed Chromium opens on Spotify. On the **first run** you'll be prompted to
log in — do it in that window, then press Enter in the terminal. The login is
saved in `scripts/.spotify-profile/` (gitignored), so later runs are
non-interactive.

The harness runs the *actual* scrape scripts from `index.js` (sliced live
between the `SCRAPE-SCRIPTS-START/END` markers — don't remove those) and prints
a verdict: shelves found, cards per shelf, and the track count for one sampled
playlist. It exits non-zero if scraping is clearly broken (0 shelves, an empty
shelf, or 0 tracks), so `npm run verify:scrape; echo $?` is a quick health check.

This verifies scraping only — not host-app UI rendering or plugin load.
````

- [ ] **Step 2: Commit**

```bash
git add DEVELOPING.md
git commit -m "docs: document npm run verify:scrape workflow"
```

---

## Self-Review Notes

- **Spec coverage:** extraction seam (Task 1+3), `__viboplr` shim + persistent profile (Task 4), login→shelves→tracks sequence (Task 4), verdict + non-zero exit (Task 4), files list incl. package.json/.gitignore (Tasks 2,4) and DEVELOPING.md (Task 5) — all from the spec are covered.
- **Symbol consistency:** `extractScripts(indexPath)` returns exactly `{ SCRIPT_CHECK_LOGIN, SCRIPT_SCRAPE_SHELVES, scriptNavigatePlaylist, scriptScrollThenScrape, MUSIC_CHIP_URL }` — consumed with those same names in `verify-scrape.mjs`. The bridge message types (`login-check`, `shelves`, `tracks`) match the `window.__viboplr.send(...)` channels in `index.js`. Field names verified against the scrape script source: shelf is `{ section, description, playlists }`, playlist is `{ id, name, subtitle, imageUrl }`, track is `{ name, artist, album, duration, imageUrl, spotifyId }`. The "empty shelf" failure condition from the spec was dropped: `SCRIPT_SCRAPE_SHELVES` only emits shelves with ≥1 playlist (`if(sh.playlists.length>0)`), so it can't occur — replaced by a "0 total cards" check.
- **No placeholders:** every code/command step is complete.
