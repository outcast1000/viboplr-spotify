// Verify the "Start Spotify radio" scrape flow against the LIVE Spotify DOM,
// without the host app. Mirrors startSpotifyRadio() in index.js:
//   search /tracks -> pick seed -> open track page -> "Go to song radio" ->
//   scrape the radio tracklist.
//
//   npm run verify:radio                              # default seed query
//   RADIO_QUERY="Daft Punk One More Time" npm run verify:radio
//   node scripts/verify-radio.mjs "Radiohead Creep"   # seed query as an arg
//   VERIFY_HEADLESS=1 VERIFY_DEBUG=1 npm run verify:radio
//
// Reuses the same persisted login profile as verify:scrape
// (scripts/.spotify-profile/). First run: a headed Chromium opens; log into
// Spotify, then press Enter.
//
// This is the harness to iterate the search / go-to-radio selectors in — the
// two risky bits are scriptSearchTopTrack (search results DOM) and scriptGoToRadio
// (the "..." menu item). Run with VERIFY_DEBUG=1 to see each script's _dbg stream
// (including the collected menu-item labels when the radio item isn't found).
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
  settleMs: envNum("VERIFY_SETTLE_MS", 4500),
  stepTimeoutMs: envNum("VERIFY_STEP_TIMEOUT_MS", 30000),
  maxSteps: envNum("VERIFY_MAX_STEPS", 40),
};

// Seed query: first CLI arg, else RADIO_QUERY env, else a stable default.
const QUERY = (argv[2] && argv[2].trim()) || env.RADIO_QUERY || "Daft Punk One More Time";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function prompt(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(q).finally(() => rl.close());
}

// Install the window.__viboplr.send bridge the injected scripts expect, funnelling
// each send() into a queue we can await by message type. (Same shape as
// verify-scrape.mjs installBridge.)
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

async function main() {
  const S = extractScripts(INDEX_PATH);
  const evalIn = (page, script) => page.evaluate((s) => eval(s), script);

  let ctx;
  try {
    console.log("options:", JSON.stringify(OPTS));
    console.log("seed query:", JSON.stringify(QUERY));
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

    // --- Login ---
    await page.goto(S.MUSIC_CHIP_URL, { waitUntil: "domcontentloaded" });
    await sleep(OPTS.settleMs);
    await bridge.ensure();
    await evalIn(page, S.SCRIPT_CHECK_LOGIN);
    let login = await bridge.wait("login-check");
    if (!login.loggedIn) {
      await prompt("Not logged in. Log into Spotify in the window, then press Enter…");
      await bridge.ensure();
      await evalIn(page, S.SCRIPT_CHECK_LOGIN);
      login = await bridge.wait("login-check");
      if (!login.loggedIn) throw new Error("still not logged in after prompt");
    }
    console.log("✓ logged in");

    const failures = [];

    // --- Step 1: search -> seed track ---
    await page.goto(S.searchTracksUrl(QUERY), { waitUntil: "domcontentloaded" });
    await sleep(OPTS.settleMs);
    await bridge.ensure();
    await evalIn(page, S.scriptSearchTopTrack(1));
    const seed = await bridge.wait("radio-seed").catch((e) => ({ error: e.message }));
    if (!seed || seed.error || !seed.trackId) {
      failures.push(`seed search failed: ${seed && seed.error ? seed.error : "no trackId"}`);
      console.log("✗ seed:", JSON.stringify(seed));
    } else {
      console.log(`✓ seed: "${seed.name}" — ${seed.artist} (${seed.trackId})`);
    }

    // --- Step 2: track page -> "Go to song radio" ---
    let go = null;
    if (seed && seed.trackId) {
      await evalIn(page, S.scriptNavigateTrackPage(seed.trackId));
      await sleep(OPTS.settleMs);
      await bridge.ensure();
      await evalIn(page, S.scriptGoToRadio(1));
      go = await bridge.wait("radio-go").catch((e) => ({ error: e.message }));
      if (!go || go.error || !go.ok) {
        failures.push(`go-to-radio failed: ${go && go.error ? go.error : "not ok"}`);
        console.log("✗ go-to-radio:", JSON.stringify(go));
        if (go && go.menuItems) console.log("  menu items seen:", JSON.stringify(go.menuItems));
      } else {
        console.log(`✓ opened radio via menu item: "${go.label}"`);
      }
    }

    // --- Step 3: scrape the radio tracklist ---
    let tracks = [];
    if (go && go.ok) {
      await sleep(OPTS.settleMs);
      await bridge.ensure();
      await evalIn(page, S.scriptScrollThenScrape("radio-station", 1, { maxSteps: OPTS.maxSteps }));
      const data = await bridge.wait("tracks").catch((e) => ({ error: e.message, tracks: [] }));
      tracks = (data && data.tracks) || [];
      if (data && data.error) failures.push(`radio scrape error: ${data.error}`);
      if (tracks.length === 0) failures.push("radio tracklist scraped 0 tracks");
      console.log(`radio tracks: ${tracks.length} (url: ${page.url()})`);
      for (const t of tracks.slice(0, 8)) console.log(`  ♪ ${t.name || "?"} — ${t.artist || "?"}`);
    }

    console.log("\n===== VERIFY RADIO VERDICT =====");
    if (failures.length > 0) {
      console.log("✗ FAIL:\n  - " + failures.join("\n  - "));
      process.exitCode = 1;
    } else {
      console.log(`✓ PASS — radio for "${QUERY}" produced ${tracks.length} tracks`);
    }
  } finally {
    if (ctx) await ctx.close();
  }
}

main().catch((e) => {
  console.error("\n✗ harness error:", e.message);
  process.exitCode = 1;
});
