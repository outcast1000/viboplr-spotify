// Verify the song-search scrape against the LIVE Spotify DOM, without the host
// app. Mirrors scrapeSearchTracks() in index.js: open /search/{q}/tracks and
// run the shared row parser (scriptScrollThenScrape) over the first screenfuls.
//
//   npm run verify:search                             # default query
//   node scripts/verify-search.mjs "Radiohead Creep"  # query as an arg
//   SEARCH_QUERY="..." npm run verify:search
//   VERIFY_HEADLESS=1 VERIFY_DEBUG=1 npm run verify:search
//
// Reuses the persisted login profile of verify:scrape / verify:radio
// (scripts/.spotify-profile/). First run: a headed Chromium opens; log into
// Spotify, then press Enter.
//
// The one fragile bit is whether the search page's rows still parse with the
// playlist row parser (track link, artist links, duration cell). If this fails
// while verify:scrape passes, the search page's markup diverged from the
// playlist page's and parseVisibleRows needs a search-specific fallback.
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, env, argv } from "node:process";
import { fileURLToPath } from "node:url";
import { extractScripts } from "./extract-scripts.mjs";

const PROFILE_DIR = fileURLToPath(new URL("./.spotify-profile/", import.meta.url));
const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

function envBool(name) {
  const v = env[name];
  if (v == null || v === "") return false;
  return /^(1|true|yes|on)$/i.test(v);
}
function envNum(name, dflt) {
  const n = Number(env[name]);
  return Number.isFinite(n) ? n : dflt;
}

const OPTS = {
  showBrowser: !envBool("VERIFY_HEADLESS"),
  debug: envBool("VERIFY_DEBUG"),
  channel: env.VERIFY_CHANNEL || "chrome",
  locale: env.VERIFY_LOCALE || "en-US",
  timezone: env.VERIFY_TIMEZONE || "America/New_York",
  stepTimeoutMs: envNum("VERIFY_STEP_TIMEOUT_MS", 30000),
  // Same as SEARCH_MAX_STEPS in index.js — the search is a few screenfuls, not
  // a full catalog walk.
  maxSteps: envNum("VERIFY_MAX_STEPS", 3),
};

const QUERY = (argv[2] && argv[2].trim()) || env.SEARCH_QUERY || "Daft Punk One More Time";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function prompt(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(q).finally(() => rl.close());
}

// window.__viboplr.send bridge the injected scripts expect (same shape as the
// other verify harnesses).
async function installBridge(page) {
  const queue = [];
  const waiters = [];
  await page.exposeFunction("__viboplrCollect", (msg) => {
    if (msg.type === "dbg" && OPTS.debug && msg.data) {
      console.log(`  [dbg:${msg.data.tag || "?"}] ${msg.data.msg || ""}`,
        msg.data.data !== undefined ? msg.data.data : "");
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
    wait: (type, timeoutMs = OPTS.stepTimeoutMs * 2) =>
      new Promise((resolve, reject) => {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) { resolve(queue.splice(i, 1)[0].data); return; }
        const timer = setTimeout(() => {
          const j = waiters.findIndex((w) => w.resolve === resolve);
          if (j >= 0) waiters.splice(j, 1);
          reject(new Error(`timed out waiting for "${type}"`));
        }, timeoutMs);
        waiters.push({ type, resolve, timer });
      }),
  };
}

async function main() {
  const S = extractScripts(INDEX_PATH);
  const evalIn = (page, script) => page.evaluate((s) => eval(s), script);

  let ctx;
  try {
    console.log("options:", JSON.stringify(OPTS));
    console.log("query:", JSON.stringify(QUERY));
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

    // --- Login (re-checked until the page has really rendered) ---
    await page.goto(S.MUSIC_CHIP_URL, { waitUntil: "domcontentloaded" });
    let login = { loggedIn: false };
    for (const deadline = Date.now() + OPTS.stepTimeoutMs; Date.now() < deadline; ) {
      await sleep(1500);
      await bridge.ensure();
      await evalIn(page, S.SCRIPT_CHECK_LOGIN);
      login = await bridge.wait("login-check").catch(() => ({ loggedIn: false }));
      if (login.loggedIn) break;
      if (OPTS.debug) console.log("  [login] not yet:", JSON.stringify(login.signals || {}));
    }
    if (!login.loggedIn) {
      await prompt("Not logged in. Log into Spotify in the window, then press Enter…");
      await bridge.ensure();
      await evalIn(page, S.SCRIPT_CHECK_LOGIN);
      login = await bridge.wait("login-check");
      if (!login.loggedIn) throw new Error("still not logged in after prompt");
    }
    console.log("✓ logged in");

    const failures = [];

    // --- Step 1: search page -> results rendered ---
    // No settle sleep: the gate script polls for a real track row itself. The
    // page paints placeholder rows first, which is why the row parser can't be
    // trusted to wait on its own.
    await page.goto(S.searchTracksUrl(QUERY), { waitUntil: "domcontentloaded" });
    await bridge.ensure();
    await evalIn(page, S.scriptWaitForSearchResults(1));
    const ready = await bridge.wait("search-ready").catch((e) => ({ error: e.message }));
    if (!ready || ready.error || !ready.ok) {
      failures.push(`search results never rendered: ${ready && ready.error ? ready.error : "not ok"}`);
      console.log("✗ ready:", JSON.stringify(ready));
    } else {
      console.log(`✓ results rendered: ${ready.url}`);
    }

    // --- Step 2: row parser ---
    let tracks = [];
    let data = null;
    if (ready && ready.ok) {
      await bridge.ensure();
      await evalIn(page, S.scriptScrollThenScrape("search-results", 1, { maxSteps: OPTS.maxSteps }));
      data = await bridge.wait("tracks").catch((e) => ({ error: e.message, tracks: [] }));
      tracks = (data && data.tracks) || [];
      if (data && data.error) failures.push(`search scrape error: ${data.error}`);
      if (tracks.length === 0) failures.push("search page scraped 0 tracks");
    }
    const noArtist = tracks.filter((t) => !t.artist).length;
    const noId = tracks.filter((t) => !t.spotifyId).length;
    if (tracks.length > 0 && noArtist > tracks.length / 2) failures.push(`${noArtist}/${tracks.length} rows have no artist — artist selector drifted`);
    if (tracks.length > 0 && noId > tracks.length / 2) failures.push(`${noId}/${tracks.length} rows have no Spotify id — track link selector drifted`);
    console.log(`search tracks: ${tracks.length} (url: ${page.url()}) — no artist: ${noArtist}, no id: ${noId}`);
    for (const t of tracks.slice(0, 8)) console.log(`  ♪ ${t.name || "?"} — ${t.artist || "?"}${t.album ? " · " + t.album : ""}${t.duration ? " · " + t.duration : ""}`);

    console.log("\n===== VERIFY SEARCH VERDICT =====");
    if (failures.length > 0) {
      console.log("✗ FAIL:\n  - " + failures.join("\n  - "));
      process.exitCode = 1;
    } else {
      console.log(`✓ PASS — search for "${QUERY}" produced ${tracks.length} tracks`);
    }
  } finally {
    if (ctx) await ctx.close();
  }
}

main().catch((e) => {
  console.error("\n✗ harness error:", e.message);
  process.exitCode = 1;
});
