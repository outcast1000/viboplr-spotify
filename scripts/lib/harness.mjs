// Shared plumbing for the live-DOM verify harnesses: launch a persistent-login
// Chromium, install the window.__viboplr.send bridge the injected scripts
// expect, confirm login, and drive scripts step by step the way the plugin
// does (index.js makeStepper): eval, re-fire every 3s until the page answers.
//
// The login profile is scripts/.spotify-profile/ (gitignored), shared by every
// harness. First run: a headed browser opens; log into Spotify, press Enter.
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, env } from "node:process";
import { fileURLToPath } from "node:url";

export const PROFILE_DIR = fileURLToPath(new URL("../.spotify-profile/", import.meta.url));
export const INDEX_PATH = fileURLToPath(new URL("../../index.js", import.meta.url));

export function envBool(name) {
  const v = env[name];
  return v != null && v !== "" && /^(1|true|yes|on)$/i.test(v);
}
export function envNum(name, dflt) {
  const n = Number(env[name]);
  return env[name] != null && env[name] !== "" && Number.isFinite(n) ? n : dflt;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function prompt(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(q).finally(() => rl.close());
}

export function harnessOptions() {
  return {
    showBrowser: !envBool("VERIFY_HEADLESS"),
    debug: envBool("VERIFY_DEBUG"),
    // "chrome" impersonates best; some machines only have Playwright's own
    // build — VERIFY_CHANNEL=chromium.
    channel: env.VERIFY_CHANNEL || "chrome",
    locale: env.VERIFY_LOCALE || "en-US",
    timezone: env.VERIFY_TIMEZONE || "America/New_York",
    stepTimeoutMs: envNum("VERIFY_STEP_TIMEOUT_MS", 30000),
  };
}

export async function launch(opts) {
  const launchOpts = {
    headless: !opts.showBrowser,
    // Same width the plugin's browse window uses (withSpotifyWindow).
    viewport: { width: 1600, height: 900 },
    locale: opts.locale,
    timezoneId: opts.timezone,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };
  if (opts.channel && opts.channel !== "chromium") launchOpts.channel = opts.channel;
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

// Messages the page posts land in a queue; wait() takes the first one of a
// type (or any of an array of types) that passes `match`, resolving with its
// data plus `__type`. reset() drops leftovers so one check can't be answered
// by a late message from the previous one.
export async function installBridge(page, opts) {
  let queue = [];
  const waiters = [];
  await page.exposeFunction("__viboplrCollect", (msg) => {
    if (msg.type === "dbg") {
      if (opts.debug && msg.data) {
        console.log(`    [dbg:${msg.data.tag || "?"}] ${msg.data.msg || ""}`,
          msg.data.data !== undefined ? JSON.stringify(msg.data.data).slice(0, 300) : "");
      }
      return;
    }
    const i = waiters.findIndex((w) => w.types.includes(msg.type) && (!w.match || w.match(msg.data || {})));
    if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve({ ...(msg.data || {}), __type: msg.type }); }
    else queue.push(msg);
  });
  await page.addInitScript(() => {
    window.__viboplr = { send: (type, data) => window.__viboplrCollect({ type, data }) };
  });
  return {
    ensure: () => page.evaluate(() => {
      if (!window.__viboplr) window.__viboplr = { send: (type, data) => window.__viboplrCollect({ type, data }) };
    }).catch(() => { /* page navigating — the init script covers the next document */ }),
    reset: () => { queue = []; },
    wait: (type, timeoutMs, match) => new Promise((resolve, reject) => {
      const types = Array.isArray(type) ? type : [type];
      const i = queue.findIndex((m) => types.includes(m.type) && (!match || match(m.data || {})));
      if (i >= 0) { const m = queue.splice(i, 1)[0]; resolve({ ...(m.data || {}), __type: m.type }); return; }
      const w = { types, match, resolve };
      w.timer = setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j >= 0) waiters.splice(j, 1);
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for "${types.join('" / "')}"`));
      }, timeoutMs);
      waiters.push(w);
    }),
  };
}

export async function evalIn(page, script) {
  try {
    await page.evaluate((s) => { (0, eval)(s); }, script);
    return true;
  } catch {
    // Context destroyed mid-navigation: expected, the pump re-fires.
    return false;
  }
}

// Mirror of the plugin's makeStepper step(): eval `script`, re-fire it every
// 3s (unless pump:false) until a `type` message passing `match` arrives.
export async function step(page, bridge, script, type, { timeoutMs = 30000, pump = true, match } = {}) {
  const answer = bridge.wait(type, timeoutMs, match);
  await bridge.ensure();
  await evalIn(page, script);
  let timer = null;
  if (pump) {
    timer = setInterval(() => { bridge.ensure().then(() => evalIn(page, script)); }, 3000);
  }
  try {
    return await answer;
  } finally {
    if (timer) clearInterval(timer);
  }
}

// Navigate the way the plugin does (location.href from inside the page), so
// the scripts see the same document lifecycle as in the host.
export async function navigate(page, S, url) {
  await evalIn(page, S.scriptNavigateTo(url));
}

export async function ensureLoggedIn(page, bridge, S, opts) {
  await page.goto(S.MUSIC_CHIP_URL, { waitUntil: "domcontentloaded" });
  let login = { loggedIn: false };
  for (const deadline = Date.now() + opts.stepTimeoutMs; Date.now() < deadline; ) {
    await sleep(1500);
    await bridge.ensure();
    await evalIn(page, S.SCRIPT_CHECK_LOGIN);
    login = await bridge.wait("login-check", 5000).catch(() => ({ loggedIn: false }));
    if (login.loggedIn) return login;
  }
  if (!opts.showBrowser) throw new Error("not logged in — run once without VERIFY_HEADLESS to sign in");
  await prompt("Not logged in. Log into Spotify in the window, then press Enter…");
  await bridge.ensure();
  await evalIn(page, S.SCRIPT_CHECK_LOGIN);
  login = await bridge.wait("login-check", 10000);
  if (!login.loggedIn) throw new Error("still not logged in after prompt");
  return login;
}
