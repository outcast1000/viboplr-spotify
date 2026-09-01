// Verify the Liked Songs scrape (the "Import Liked Songs" likes import) against
// the LIVE Spotify DOM, without the host app. Mirrors importLikedSongs in
// index.js: login-check, navigate to /collection/tracks, scroll-and-scrape.
//
//   npm run verify:liked
//   VERIFY_HEADLESS=1 VERIFY_MAX_STEPS=20 npm run verify:liked
//
// The load-bearing assumption under test: the Liked Songs collection page
// renders the same virtualized tracklist markup as a playlist page, so the
// shared scriptScrollThenScrape parses it (kind: "collection" only changes the
// navigation URL). A pass means rows come back with name + artist — the two
// fields the like import writes.
//
// First run: a headed Chromium opens; log into Spotify, then press Enter. The
// login persists in scripts/.spotify-profile/ (gitignored, shared with the
// other verify harnesses).
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, env } from "node:process";
import { fileURLToPath } from "node:url";
import { extractScripts } from "./extract-scripts.mjs";

// fileURLToPath, not URL.pathname: pathname keeps the leading slash on Windows
// ("/D:/…"), which resolves relative to the cwd drive as "D:\D:\…".
const PROFILE_DIR = fileURLToPath(new URL("./.spotify-profile/", import.meta.url));
const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

// Same impersonation knobs as verify-scrape (see the launch comment there);
// only the ones this harness needs are surfaced.
const OPTS = {
  showBrowser: !/^(1|true|yes|on)$/i.test(env.VERIFY_HEADLESS || ""),
  debug: /^(1|true|yes|on)$/i.test(env.VERIFY_DEBUG || ""),
  // Scroll budget. The host import uses 500; a smaller cap still proves the
  // parse and finishes fast on a big library.
  maxSteps: Number.isFinite(Number(env.VERIFY_MAX_STEPS)) && env.VERIFY_MAX_STEPS !== "" ? Number(env.VERIFY_MAX_STEPS) : 999,
  channel: env.VERIFY_CHANNEL !== undefined ? env.VERIFY_CHANNEL : "chrome",
  locale: "en-US",
  timezone: "America/New_York",
  settleMs: 4500,
  // Terminal-message wait. The scrape emits progress every scroll step but this
  // simple harness only awaits the terminal "tracks" message, so the budget
  // must cover the whole scroll (600ms/step + slack).
  stepTimeoutMs: 30000 + 800 * (Number.isFinite(Number(env.VERIFY_MAX_STEPS)) && env.VERIFY_MAX_STEPS !== "" ? Number(env.VERIFY_MAX_STEPS) : 999),
};

function prompt(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(q).finally(() => rl.close());
}

// Minimal copy of verify-scrape's bridge: funnel window.__viboplr.send into a
// Node-side queue, await a message by type.
async function installBridge(page) {
  const queue = [];
  const waiters = [];
  await page.exposeFunction("__viboplrCollect", (msg) => {
    if (msg.type === "dbg") {
      if (OPTS.debug && msg.data) {
        console.log(`  [dbg:${msg.data.tag || "?"}] ${msg.data.msg || ""}`,
          msg.data.data !== undefined ? msg.data.data : "");
      }
      return;
    }
    if (msg.type === "tracks-progress") {
      if (msg.data) stdout.write(`\r  reading… ${msg.data.found || 0} tracks so far`);
      return;
    }
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg.data); }
    else queue.push(msg);
  });
  await page.addInitScript(() => {
    window.__viboplr = { send: (type, data) => window.__viboplrCollect({ type, data }) };
  });
  return {
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
        }, OPTS.stepTimeoutMs);
        waiters.push({ type, resolve, timer });
      }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const S = extractScripts(INDEX_PATH);

  let ctx;
  try {
    console.log("options:", JSON.stringify(OPTS));
    const launchOpts = {
      headless: !OPTS.showBrowser,
      viewport: { width: 1280, height: 900 },
      locale: OPTS.locale,
      timezoneId: OPTS.timezone,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    };
    if (OPTS.channel && OPTS.channel !== "chromium") launchOpts.channel = OPTS.channel;
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
    const page = ctx.pages()[0] || (await ctx.newPage());
    const bridge = await installBridge(page);

    // --- Step 1: login ---
    await page.goto(S.MUSIC_CHIP_URL, { waitUntil: "domcontentloaded" });
    await sleep(OPTS.settleMs);
    await bridge.ensure();
    await page.evaluate((s) => eval(s), S.SCRIPT_CHECK_LOGIN);
    let login = await bridge.wait("login-check");
    if (!login.loggedIn) {
      await prompt("Not logged in. Log into Spotify in the window, then press Enter…");
      await page.goto(S.MUSIC_CHIP_URL, { waitUntil: "domcontentloaded" });
      await sleep(OPTS.settleMs);
      await bridge.ensure();
      await page.evaluate((s) => eval(s), S.SCRIPT_CHECK_LOGIN);
      login = await bridge.wait("login-check");
      if (!login.loggedIn) throw new Error("still not logged in after prompt");
    }
    console.log("✓ logged in");

    // --- Step 2: navigate to Liked Songs + scrape (host parity: same two
    // scripts importLikedSongs evals, same pseudo-id) ---
    await page.evaluate((s) => eval(s), S.scriptNavigatePlaylist("liked-songs", "collection"));
    await sleep(OPTS.settleMs + 500);
    await bridge.ensure();
    await page.evaluate((s) => eval(s), S.scriptScrollThenScrape("liked-songs", 999, { maxSteps: OPTS.maxSteps, kind: "collection" }));
    const tracksData = await bridge.wait("tracks");
    stdout.write("\n");

    // --- Verdict ---
    const tracks = (tracksData && tracksData.tracks) || [];
    console.log("\n===== VERIFY LIKED SONGS VERDICT =====");
    console.log(`tracks scraped: ${tracks.length}`);
    for (const t of tracks.slice(0, 5)) console.log(`  ♥ ${t.name || "?"} — ${t.artist || "?"}`);

    const failures = [];
    if (tracksData && tracksData.error) failures.push(`scrape reported error: ${tracksData.error}`);
    if (tracks.length === 0) failures.push("0 tracks scraped (empty Liked Songs is also a fail here — use a test account with likes)");
    // Shape checks: the like import writes exactly title + artist, so those two
    // fields are the contract.
    const nameless = tracks.filter((t) => !t.name).length;
    const artistless = tracks.filter((t) => !t.artist).length;
    if (nameless > 0) failures.push(`${nameless} track(s) missing .name (shape regression)`);
    if (artistless > 0) failures.push(`${artistless} track(s) missing .artist — the like key degrades to title-only`);

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
