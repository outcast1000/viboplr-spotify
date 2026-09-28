// The sign-in state behind the view header and the signed-out banner, driven
// through the REAL index.js activate(api) against a stub host (no browser, no
// network): the browse window is a fake handle the test feeds login-check
// messages to, and timers are mocked so the login poll runs on demand.
//
// What this pins: the state changes only on evidence (a login check), survives
// a restart through storage, never expires on a timer, and every change
// re-pushes the header and re-renders the banner.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));
const AUTH_KEY = "spotify_browse_auth";

function stub(over) {
  const fn = () => Promise.resolve(null);
  return new Proxy(fn, {
    get(_t, p) {
      if (p === "then" || typeof p === "symbol") return undefined;
      if (over && Object.prototype.hasOwnProperty.call(over, p)) return over[p];
      return stub(null);
    },
    apply() { return Promise.resolve(null); },
  });
}

function startHost(stored = {}) {
  const host = { headers: [], views: [], saved: {}, actions: {}, window: null };
  const store = { ...stored };
  const api = stub({
    ui: stub({
      setViewHeader: (id, h) => host.headers.push(h),
      setViewData: (id, d) => host.views.push(d),
      onAction: (id, f) => { host.actions[id] = f; },
    }),
    storage: stub({
      get: (k) => Promise.resolve(k in store ? store[k] : null),
      set: (k, v) => { store[k] = v; host.saved[k] = v; return Promise.resolve(); },
    }),
    network: stub({
      openBrowseWindow: () => {
        const w = { onMsg: null };
        w.handle = {
          eval: () => Promise.resolve(),
          onMessage: (cb) => { w.onMsg = cb; },
          onNavigation: () => {},
          show: () => Promise.resolve(),
          hide: () => Promise.resolve(),
          close: () => Promise.resolve(),
        };
        w.send = (type, data) => w.onMsg({ type, data });
        host.window = w;
        return Promise.resolve(w.handle);
      },
    }),
  });
  const plugin = new Function("api", "window", "globalThis", "self", "document", readFileSync(INDEX_PATH, "utf8"))(api, {}, {}, {}, {});
  plugin.activate(api);
  host.header = () => host.headers.at(-1);
  host.banner = () => (host.views.at(-1).children || []).find((c) => /ds-banner/.test(c.className || ""));
  return host;
}

const flush = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 10; i++) await flush(); }

function quietConsole(t) {
  // The stub storage returns null for the playlist library, which the init
  // path logs as an error; that noise is not what's under test.
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
}

test("a stored signed-out reading shows Signed out + the banner, and a timer never clears it", async (t) => {
  quietConsole(t);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());
  const host = startHost({ [AUTH_KEY]: { state: "signed-out", account: null } });
  await settle();
  assert.deepEqual(host.header().status, { variant: "warning", label: "Signed out" });
  const banner = host.banner();
  assert.ok(banner, "signed-out banner under the tabs");
  assert.equal(banner.children.find((c) => c.type === "button").action, "sync");

  const pushes = host.headers.length;
  mock.timers.tick(60 * 60 * 1000); // an hour: well past the 10-minute lookup throttle
  await settle();
  assert.equal(host.headers.length, pushes, "no push without new evidence");
  assert.equal(host.header().status.label, "Signed out");
});

test("a confirmed login flips to signed in with the account, drops the banner, and persists", async (t) => {
  quietConsole(t);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());
  const host = startHost({ [AUTH_KEY]: { state: "signed-out", account: null } });
  await settle();

  host.actions["sync"]();
  await settle();
  assert.equal(host.banner(), undefined, "banner hidden while the sync handles the sign-in");
  host.window.send("login-check", { loggedIn: true, loggedOut: false, account: "  Alex  O " });
  await settle();
  assert.equal(host.header().status.label, "Syncing…");
  assert.match(host.header().subtitle, /^Signed in as Alex O$/);
  assert.equal(host.saved[AUTH_KEY].state, "signed-in");
  assert.equal(host.saved[AUTH_KEY].account, "Alex O");

  host.window.send("window-closed");
  await settle();
  assert.equal(host.banner(), undefined);
  assert.notEqual(host.header().status.label, "Signed out");
});

test("a sync that finds Spotify signed out ends on Signed out + banner", async (t) => {
  quietConsole(t);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());
  const host = startHost({ [AUTH_KEY]: { state: "signed-in", account: "Alex" } });
  await settle();
  assert.match(host.header().subtitle, /Signed in as Alex/);

  host.actions["sync"]();
  await settle();
  mock.timers.tick(1500 + 3000 * 2); // three login polls: past the grace period
  await settle();
  host.window.send("login-check", { loggedIn: false, loggedOut: true });
  await settle();
  assert.equal(host.saved[AUTH_KEY].state, "signed-out");
  assert.equal(host.header().status.label, "Syncing…", "still waiting for the sign-in");

  host.window.send("window-closed"); // user gave up
  await settle();
  assert.deepEqual(host.header().status, { variant: "warning", label: "Signed out" });
  assert.doesNotMatch(host.header().subtitle, /Signed in/);
  assert.ok(host.banner());
});

test("nothing stored: unknown state, no banner, no Signed out", async (t) => {
  quietConsole(t);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());
  const host = startHost();
  await settle();
  assert.deepEqual(host.header().status, { variant: "muted", label: "Not synced" });
  assert.equal(host.banner(), undefined);
});
