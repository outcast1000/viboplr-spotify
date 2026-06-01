// Verify the Spotify scrape scripts against the LIVE Spotify DOM, without the
// host app. Mirrors the in-app dbgTest flow (index.js): login-check, scrape
// shelves, then navigate + scrape one playlist's tracks.
//
//   npm run verify:scrape
//   VERIFY_HEADLESS=1 VERIFY_DEBUG=1 npm run verify:scrape   # change options inline
//
// Options ("plugin settings", emulated for the host-less harness) are resolved
// from DEFAULTS < scripts/verify-config.json < VERIFY_* env vars — see the
// options block below, and verify-config.example.json.
//
// First run: a headed Chromium opens; log into Spotify, then press Enter. The
// login persists in scripts/.spotify-profile/ (gitignored) for later runs.
//
// On finish it writes a visual report (scripts/verify-report.html, gitignored)
// — every shelf with each card's name, description, and cover thumbnail — and
// opens it in your browser. The report also calls out what's missing
// (cover-less, nameless, or id-only "phantom" cards) and any scrape errors.
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, platform, env } from "node:process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { extractScripts } from "./extract-scripts.mjs";

const PROFILE_DIR = new URL("./.spotify-profile/", import.meta.url).pathname;
const INDEX_PATH = new URL("../index.js", import.meta.url).pathname;
const REPORT_PATH = new URL("./verify-report.html", import.meta.url).pathname;
const CONFIG_PATH = new URL("./verify-config.json", import.meta.url).pathname;

// ---- Options ("plugin settings", emulated for the host-less harness) ----
//
// The host stores these in api.storage (spotify_browse_preferences) and lets
// the user toggle them in the settings panel. Here there is no host, so we
// surface the run-affecting equivalents as harness options, resolved with this
// precedence (later wins): built-in DEFAULTS < scripts/verify-config.json
// (optional, gitignored) < VERIFY_* environment variables. So you can change a
// setting for one run inline, e.g.
//   VERIFY_HEADLESS=1 VERIFY_DEBUG=1 npm run verify:scrape
// or persist a set in verify-config.json.
//
// Mapping to the plugin's real settings:
//   showBrowser  -> showBrowserOnRefresh (headed vs. headless window)
//   debug        -> debugLogging (surface the injected scripts' _dbg stream)
//   maxSteps     -> scrape depth (host uses 60; 999 = "scrape the full playlist")
//   channel/locale/timezone -> impersonation knobs (see launch comment below)
const DEFAULTS = {
  showBrowser: true,     // headed window; set false to run headless
  debug: false,          // log the page's _dbg messages to the console
  maxSteps: 999,         // track-scrape scroll budget for the sampled playlist
  channel: "chrome",     // real Chrome; "" or "chromium" for bundled Chromium
  locale: "en-US",
  timezone: "America/New_York",
  settleMs: 4500,        // post-navigation wait (host parity)
  stepTimeoutMs: 30000,  // per-message wait before a step is a timeout
};

// Read an optional JSON config file; missing/!invalid -> {} (warn, don't fail).
function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) || {};
  } catch (e) {
    console.error(`(ignoring invalid ${CONFIG_PATH}: ${e.message})`);
    return {};
  }
}

// Parse a "1/0/true/false/yes/no" env string to bool; undefined if unset.
function envBool(name) {
  const v = env[name];
  if (v == null || v === "") return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}
function envNum(name) {
  const v = env[name];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function envStr(name) {
  const v = env[name];
  return v == null || v === "" ? undefined : v;
}

// Resolve final options: DEFAULTS < file < env. `undefined` overrides are
// dropped by the ?? chain so an unset env var never clobbers a file/default.
function resolveOptions() {
  const file = readConfigFile();
  const pick = (key, envVal) => (envVal !== undefined ? envVal : (file[key] !== undefined ? file[key] : DEFAULTS[key]));
  return {
    showBrowser: pick("showBrowser", envBool("VERIFY_HEADLESS") === undefined ? undefined : !envBool("VERIFY_HEADLESS")),
    debug: pick("debug", envBool("VERIFY_DEBUG")),
    maxSteps: pick("maxSteps", envNum("VERIFY_MAX_STEPS")),
    channel: pick("channel", envStr("VERIFY_CHANNEL")),
    locale: pick("locale", envStr("VERIFY_LOCALE")),
    timezone: pick("timezone", envStr("VERIFY_TIMEZONE")),
    settleMs: pick("settleMs", envNum("VERIFY_SETTLE_MS")),
    stepTimeoutMs: pick("stepTimeoutMs", envNum("VERIFY_STEP_TIMEOUT_MS")),
  };
}

const OPTS = resolveOptions();
const SETTLE_MS = OPTS.settleMs;
const STEP_TIMEOUT_MS = OPTS.stepTimeoutMs;

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
    // debugLogging equivalent: the injected scrape scripts emit "dbg" messages
    // (the host routes these to api.log). Surface them to the console when the
    // debug option is on; they are diagnostic only, never awaited as a step.
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

// Escape text for safe interpolation into HTML (text or attribute).
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// A card is "phantom" if it has an id but no name — these are the decorative
// /playlist/ credit links the shelf scraper is supposed to skip. Catching any
// here flags a regression in that filter.
function cardIssues(pl) {
  const issues = [];
  if (!pl.name) issues.push("no name" + (pl.id ? " (phantom — id only)" : ""));
  if (!pl.imageUrl) issues.push("no cover");
  if (!pl.id) issues.push("no id");
  return issues;
}

// Build a self-contained HTML report: one block per shelf, a thumbnail grid of
// its cards (name, description/subtitle, cover), plus a summary of what's
// missing and any scrape errors. `sampled` is { name, trackCount, error } for
// the one playlist whose tracks were scraped (or null).
function buildReportHtml({ shelves, errors, sampled, login }) {
  const allCards = shelves.flatMap((sh) => sh.playlists || []);
  const noCover = allCards.filter((p) => !p.imageUrl);
  const noName = allCards.filter((p) => !p.name);
  const generatedAt = new Date().toISOString();

  const card = (pl) => {
    const issues = cardIssues(pl);
    const flagged = issues.length > 0;
    const img = pl.imageUrl
      ? `<img class="cover" src="${esc(pl.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"/>`
      : `<div class="cover missing">no cover</div>`;
    return `
      <div class="card${flagged ? " flagged" : ""}">
        ${img}
        <div class="meta">
          <div class="name">${esc(pl.name || "(no name)")}</div>
          ${pl.subtitle ? `<div class="sub">${esc(pl.subtitle)}</div>` : ""}
          <div class="id">${esc(pl.id || "—")}</div>
          ${flagged ? `<div class="issues">⚠ ${esc(issues.join(", "))}</div>` : ""}
        </div>
      </div>`;
  };

  const shelfBlocks = shelves.map((sh) => {
    const cards = sh.playlists || [];
    return `
    <section class="shelf">
      <h2>${esc(sh.section || "(unnamed shelf)")} <span class="count">${cards.length} card${cards.length === 1 ? "" : "s"}</span></h2>
      ${sh.description ? `<p class="shelf-desc">${esc(sh.description)}</p>` : ""}
      <div class="grid">${cards.map(card).join("")}</div>
    </section>`;
  }).join("");

  const errorBlock = errors.length
    ? `<ul class="err-list">${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
    : `<p class="ok">No errors recorded.</p>`;

  const leftOutBlock = (noCover.length || noName.length)
    ? `<ul class="err-list">
        ${noName.length ? `<li><b>${noName.length}</b> card(s) with no name (phantom / id-only)</li>` : ""}
        ${noCover.length ? `<li><b>${noCover.length}</b> card(s) with no cover image</li>` : ""}
       </ul>`
    : `<p class="ok">Every card has a name and a cover.</p>`;

  const sampledBlock = sampled
    ? `<p>Sampled playlist <b>${esc(sampled.name)}</b> → <b>${sampled.trackCount}</b> tracks${sampled.error ? ` <span class="bad">(error: ${esc(sampled.error)})</span>` : ""}.</p>`
    : `<p>No playlist track-scrape was sampled.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>Spotify scrape verify — ${esc(generatedAt)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background:#0f0f10; color:#e8e8e8; }
  header { padding: 20px 24px; border-bottom: 1px solid #2a2a2c; position: sticky; top: 0; background:#0f0f10; z-index: 2; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header .gen { color:#9a9a9a; font-size: 12px; }
  .summary { display:flex; flex-wrap:wrap; gap: 24px; padding: 16px 24px; border-bottom:1px solid #2a2a2c; }
  .summary .box { min-width: 220px; }
  .summary h3 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing:.04em; color:#9a9a9a; }
  .stat { font-size: 28px; font-weight: 700; }
  .ok { color:#1db954; } .bad { color:#ff6b6b; }
  .err-list { margin: 0; padding-left: 18px; } .err-list li { color:#ffb4b4; }
  main { padding: 8px 24px 48px; }
  .shelf { margin: 28px 0; }
  .shelf h2 { font-size: 16px; margin: 0 0 2px; }
  .shelf h2 .count { color:#9a9a9a; font-weight: 400; font-size: 13px; }
  .shelf-desc { color:#9a9a9a; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
  .card { background:#19191b; border:1px solid #2a2a2c; border-radius: 10px; overflow: hidden; }
  .card.flagged { border-color:#7a3030; background:#241a1a; }
  .cover { width: 100%; aspect-ratio: 1; object-fit: cover; display:block; background:#262628; }
  .cover.missing { display:flex; align-items:center; justify-content:center; color:#777; font-size:12px; }
  .meta { padding: 8px 10px 10px; }
  .name { font-weight: 600; font-size: 13px; word-break: break-word; }
  .sub { color:#b0b0b0; font-size: 12px; margin-top: 2px; word-break: break-word; }
  .id { color:#666; font-size: 11px; margin-top: 4px; font-family: ui-monospace, monospace; }
  .issues { color:#ffb4b4; font-size: 12px; margin-top: 6px; }
</style></head><body>
<header>
  <h1>Spotify scrape verification report</h1>
  <div class="gen">Generated ${esc(generatedAt)} · logged in: ${login && login.loggedIn ? "yes" : "no"}</div>
  <div class="gen">options: ${esc(JSON.stringify(OPTS))}</div>
</header>
<div class="summary">
  <div class="box"><h3>Shelves</h3><div class="stat">${shelves.length}</div></div>
  <div class="box"><h3>Total cards</h3><div class="stat">${allCards.length}</div></div>
  <div class="box"><h3>Sampled tracks</h3><div class="stat">${sampled ? sampled.trackCount : "—"}</div></div>
  <div class="box" style="flex:1 1 320px"><h3>What's left out</h3>${leftOutBlock}</div>
  <div class="box" style="flex:1 1 320px"><h3>Errors</h3>${errorBlock}${sampledBlock}</div>
</div>
<main>${shelfBlocks || "<p>No shelves scraped.</p>"}</main>
</body></html>`;
}

// Open a file in the OS default browser. Best-effort: a launch failure is
// logged, not thrown (the report is already written to disk).
function openInBrowser(path) {
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", path] : [path];
  execFile(cmd, args, (err) => {
    if (err) console.error(`(could not auto-open report: ${err.message})`);
  });
}

async function main() {
  const S = extractScripts(INDEX_PATH);

  let ctx;
  try {
    // Run impersonated so Spotify's bot detection doesn't flag the automation
    // (a flagged session can silently serve a logged-out / degraded DOM, making
    // the scrape verdict meaningless). Four levers, in order of impact:
    //   1. channel "chrome" — drive real Google Chrome, not bundled Chromium, so
    //      the User-Agent + Client Hints are a genuine consumer fingerprint.
    //      Deliberately do NOT also set `userAgent`: overriding it desyncs the UA
    //      string from the real Client Hints and is *more* detectable.
    //   2. ignoreDefaultArgs ['--enable-automation'] — drop the flag that flips
    //      navigator.webdriver on and shows the "controlled by automation" bar.
    //   3. --disable-blink-features=AutomationControlled — belt-and-suspenders
    //      for navigator.webdriver.
    //   4. locale/timezone — a plausible, consistent regional fingerprint.
    // All four (plus headed/headless) are configurable via OPTS — see the
    // options block at the top of this file.
    console.log("options:", JSON.stringify(OPTS));
    const launchOpts = {
      headless: !OPTS.showBrowser,
      viewport: { width: 1280, height: 900 },
      locale: OPTS.locale,
      timezoneId: OPTS.timezone,
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    };
    // Empty/"chromium" channel => use Playwright's bundled Chromium.
    if (OPTS.channel && OPTS.channel !== "chromium") launchOpts.channel = OPTS.channel;
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
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

    // Collected for the HTML report's "Errors" section (in addition to the
    // console). Every failure path pushes a human-readable line here.
    const errors = [];

    // --- Step 2: scrape shelves ---
    await page.evaluate((s) => eval(s), S.SCRIPT_SCRAPE_SHELVES);
    let shelvesData;
    try {
      shelvesData = await bridge.wait("shelves");
    } catch (e) {
      console.error("✗ shelf scrape timed out — continuing to verdict:", e.message);
      errors.push(`shelf scrape timed out: ${e.message}`);
      shelvesData = { shelves: [] };
    }
    const shelves = shelvesData.shelves || [];
    const allPlaylists = shelves.flatMap((sh) => sh.playlists || []);

    // --- Step 3: scrape one playlist's tracks ---
    let tracksData = null;
    let sampled = null;
    if (allPlaylists.length > 0) {
      const pl = allPlaylists[0];
      await page.evaluate((s) => eval(s), S.scriptNavigatePlaylist(pl.id));
      await sleep(SETTLE_MS + 500); // extra margin for the playlist page to settle
      await bridge.ensure();
      // gen arg is irrelevant here (single run); maxSteps from OPTS (999 = full).
      await page.evaluate((s) => eval(s), S.scriptScrollThenScrape(pl.id, 999, { maxSteps: OPTS.maxSteps }));
      try {
        tracksData = await bridge.wait("tracks");
      } catch (e) {
        console.error("✗ track scrape timed out — continuing to verdict:", e.message);
        errors.push(`track scrape timed out for "${pl.name || pl.id}": ${e.message}`);
        tracksData = { tracks: [] };
      }
      if (tracksData && tracksData.error) {
        errors.push(`track scrape reported error for "${pl.name || pl.id}": ${tracksData.error}`);
      }
      sampled = {
        name: pl.name || pl.id,
        trackCount: (tracksData && tracksData.tracks ? tracksData.tracks : []).length,
        error: tracksData && tracksData.error ? tracksData.error : null,
      };
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
    // Cards the scrape returned but couldn't fully populate count as "left out".
    const incomplete = allPlaylists.filter((p) => cardIssues(p).length > 0);
    if (incomplete.length > 0) failures.push(`${incomplete.length} card(s) missing name/cover/id (see report)`);

    // Fold verdict failures into the report's error list too.
    for (const f of failures) errors.push(f);

    // --- Write + open the HTML report ---
    const html = buildReportHtml({ shelves, errors, sampled, login });
    writeFileSync(REPORT_PATH, html, "utf8");
    console.log(`\nReport written: ${REPORT_PATH}`);
    openInBrowser(REPORT_PATH);

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
