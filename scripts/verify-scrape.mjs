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
  // No lock needed: Node runs this single-threaded. wait() checks the queue and
  // registers its waiter synchronously (no await between), and exposeFunction
  // callbacks run as separate tasks — so a message either finds a waiting waiter
  // or lands in the queue that wait() checks first. The two can't interleave.
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

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    const bridge = await installBridge(page);

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
    let shelvesData;
    try {
      shelvesData = await bridge.wait("shelves");
    } catch (e) {
      console.error("✗ shelf scrape timed out — continuing to verdict:", e.message);
      shelvesData = { shelves: [] };
    }
    const shelves = shelvesData.shelves || [];
    const allPlaylists = shelves.flatMap((sh) => sh.playlists || []);

    // --- Step 3: scrape one playlist's tracks ---
    let tracksData = null;
    if (allPlaylists.length > 0) {
      const pl = allPlaylists[0];
      await page.evaluate((s) => eval(s), S.scriptNavigatePlaylist(pl.id));
      await sleep(SETTLE_MS + 500); // extra margin for the playlist page to settle
      await bridge.ensure();
      await page.evaluate((s) => eval(s), S.scriptScrollThenScrape(pl.id, 999)); // 999 = scrape the full playlist
      try {
        tracksData = await bridge.wait("tracks");
      } catch (e) {
        console.error("✗ track scrape timed out — continuing to verdict:", e.message);
        tracksData = { tracks: [] };
      }
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
    // Shape checks: catch the scrape returning objects of the wrong shape even
    // when counts look fine (the whole point of this harness is early warning).
    if (allPlaylists.length > 0 && !allPlaylists[0].id) failures.push("first playlist card missing .id (shape regression)");
    if (tracks.length > 0 && !tracks[0].name) failures.push("first track missing .name (shape regression)");

    if (failures.length > 0) {
      console.log("\n✗ FAIL:\n  - " + failures.join("\n  - "));
      process.exitCode = 1;
    } else {
      console.log("\n✓ PASS");
    }
  } finally {
    if (ctx) await ctx.close();
  }
}

main().catch((e) => {
  console.error("\n✗ harness error:", e.message);
  process.exitCode = 1;
});
