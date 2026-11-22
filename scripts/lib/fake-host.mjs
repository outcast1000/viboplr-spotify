// Run the REAL plugin (index.js activate(api)) in Node against a stand-in host
// whose browse window is a Playwright page. Everything the plugin's own flow
// code does — withSpotifyWindow's login gate, makeStepper's re-fire loop, the
// info-lookup queue — runs exactly as shipped; only the host bridge is fake.
//
// The api is a recursive stub: any namespace/method the plugin touches exists
// and resolves to null, so activate()'s init work (storage, shelves, scheduler)
// no-ops. The pieces a check needs are real and recorded:
//   network.openBrowseWindow  → a Playwright page (hidden = headless context)
//   informationTypes.onFetch  → host.infoFetch(typeId, entity)
//   contextMenu.onAction      → host.menuAction(id, target)
//   assistant.onTool          → host.tool(name, args)
//   playback.playTracks       → host.played[]
//   ui.showNotification / requestAction / log → host.events[]
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_PATH } from "./harness.mjs";

function stubNamespace(overrides, path = []) {
  const fn = () => Promise.resolve(null);
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined; // not a thenable
      if (typeof prop === "symbol") return undefined;
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      return stubNamespace(null, path.concat(String(prop)));
    },
    apply() { return Promise.resolve(null); },
  });
}

// seedPlaylists: [{ id, name, kind? }] — saved playlists the plugin finds on
// "disk" at activate (section "Verify", no cached tracks, so the first read of
// each one goes to Spotify). Default: an empty first-run install.
export async function startFakeHost(browserCtx, { debug = false, seedPlaylists = [] } = {}) {
  const SEED_SECTION = "Verify";
  const seedById = Object.fromEntries(seedPlaylists.map((p) => [p.id, p]));
  const seededList = (path) => {
    if (!seedPlaylists.length) return [];
    if (path.length === 1 && path[0] === "playlists") return [{ name: SEED_SECTION, isDir: true }];
    if (path.length === 2 && path[0] === "playlists" && path[1] === SEED_SECTION) {
      return seedPlaylists.map((p) => ({ name: p.id, isDir: true }));
    }
    return [];
  };
  const seededJson = (path) => {
    if (path.length !== 4 || path[0] !== "playlists" || path[1] !== SEED_SECTION) return null;
    const p = seedById[path[2]];
    if (!p) return null;
    if (path[3] === "tracks.json") return [];
    if (path[3] !== "meta.json") return null;
    return { id: p.id, name: p.name, section: SEED_SECTION, description: "", coverFile: null, kind: p.kind || "playlist", tracksFetchedAt: null };
  };
  const host = {
    infoHandlers: {},
    menuHandlers: {},
    toolHandlers: {},
    played: [],
    backfills: [],
    uiHandlers: {},
    imageHandlers: {},
    nowPlayingItems: {},
    queue: { tracks: [], index: 0 },
    trackStartedHandlers: [],
    nowPlayingHandlers: {},
    searchHandlers: {},
    events: [],
    windows: 0,
    pendingCloses: [],
  };
  const note = (kind, data) => {
    host.events.push({ kind, data, at: Date.now() });
    if (debug) console.log(`    [host:${kind}]`, typeof data === "string" ? data : JSON.stringify(data).slice(0, 200));
  };

  async function openBrowseWindow(url, opts) {
    host.windows++;
    note("open-window", { url, visible: !!(opts && opts.visible) });
    const page = await browserCtx.newPage();
    let onMsg = null;
    let onNav = null;
    await page.exposeFunction("__viboplrCollect", (msg) => { if (onMsg) onMsg(msg); });
    await page.addInitScript(() => {
      window.__viboplr = { send: (type, data) => window.__viboplrCollect({ type, data }) };
    });
    page.on("framenavigated", (f) => { if (f === page.mainFrame() && onNav) onNav(f.url()); });
    page.goto(url, { waitUntil: "commit" }).catch(() => { /* navigation raced a close */ });
    return {
      eval: (script) => page.evaluate((s) => { (0, eval)(s); }, script).catch((e) => { throw e; }),
      close: () => {
        const p = closeWindow();
        host.pendingCloses.push(p);
        return p;
      },
      show: () => { note("show-window", url); return Promise.resolve(); },
      hide: () => Promise.resolve(),
      onMessage: (cb) => { onMsg = cb; },
      onNavigation: (cb) => { onNav = cb; },
    };
    async function closeWindow() {
        note("close-window", url);
        if (debug) {
          // What the plugin's window showed at the end — the first thing to
          // look at when a lookup comes back empty.
          const shot = join(tmpdir(), `viboplr-spotify-window-${host.windows}.png`);
          await page.screenshot({ path: shot }).catch(() => {});
          const info = await page.evaluate(() => ({
            url: location.href,
            rows: document.querySelectorAll('main [role="row"]').length,
            trackLinks: document.querySelectorAll('main a[href*="/track/"]').length,
            text: ((document.querySelector("main") || document.body).textContent || "").slice(0, 200),
          })).catch((e) => ({ error: String(e) }));
          note("window-state", { shot, ...info });
        }
        return page.close().catch(() => {});
    }
  }

  const api = stubNamespace({
    appVersion: "1.0.72",
    log: (level, msg, section) => note("log", `${level} ${section ? section + " " : ""}${msg}`),
    network: stubNamespace({ openBrowseWindow }),
    // An empty first-run install: no saved playlists, nothing in storage.
    storage: stubNamespace({
      // First-run already done: otherwise activate() starts its initial sync,
      // which competes with the check for the single browse window.
      get: (key) => Promise.resolve(key === "spotify_browse_first_run_done" ? true : null),
      listCacheDirs: () => Promise.resolve([]),
      files: stubNamespace({
        list: (path) => Promise.resolve(seededList(path || [])),
        readJson: (path) => Promise.resolve(seededJson(path || [])),
        exists: () => Promise.resolve(false),
      }),
    }),
    informationTypes: stubNamespace({
      onFetch: (id, h) => { host.infoHandlers[id] = h; return () => {}; },
    }),
    contextMenu: stubNamespace({
      onAction: (id, h) => { host.menuHandlers[id] = h; return () => {}; },
      registerItem: (item) => { note("menu-item", item.id); return () => {}; },
    }),
    nowPlayingInfo: stubNamespace({
      registerItem: (item) => { host.nowPlayingItems[item.id] = item; return () => {}; },
      onFetch: (id, h) => { host.nowPlayingHandlers[id] = h; return () => {}; },
    }),
    imageProviders: stubNamespace({
      onFetch: (entity, h) => { host.imageHandlers[entity] = h; return () => {}; },
    }),
    search: stubNamespace({
      onQuery: (id, h) => { host.searchHandlers[id] = h; return () => {}; },
    }),
    assistant: stubNamespace({
      onTool: (name, h) => { host.toolHandlers[name] = h; return () => {}; },
    }),
    playback: stubNamespace({
      // The queue the plugin reads (host.queue = { tracks, index }) and the
      // track-start event (host.startTrack(track) fires it).
      getQueue: () => host.queue,
      onTrackStarted: (h) => { host.trackStartedHandlers.push(h); return () => {}; },
      playTracks: (tracks, startIndex, context) => { host.played.push({ tracks, startIndex, context }); note("play", { n: tracks.length, context }); },
      // Like the host: the head plays at once, then resolveTail's tracks are
      // appended. Resolves with how many landed; each play is recorded with its
      // head and tail so a check can wait for the tail (host.backfills).
      playWithBackfill: (opts) => {
        const rec = { head: opts.head || [], context: opts.context, tail: null, error: null };
        host.backfills.push(rec);
        note("backfill-start", { head: rec.head.length, context: opts.context });
        return Promise.resolve(opts.resolveTail()).then((tail) => {
          rec.tail = tail || [];
          note("backfill-tail", { n: rec.tail.length });
          return rec.tail.length;
        }, (e) => { rec.error = String(e); rec.tail = []; return 0; });
      },
    }),
    ui: stubNamespace({
      onAction: (id, h) => { host.uiHandlers[id] = h; return () => {}; },
      showNotification: (m) => note("notify", m),
      requestAction: (a, p) => note("request-action", { a, p }),
    }),
  });

  // Same shape as the host loader: new Function(api, window, globalThis,
  // self, document, code) with a frozen stand-in window.
  const code = readFileSync(INDEX_PATH, "utf8");
  const standIn = Object.freeze({ setTimeout, clearTimeout, setInterval, clearInterval, console, Math, JSON, Date, Promise });
  const plugin = new Function("api", "window", "globalThis", "self", "document", code)(api, standIn, standIn, standIn, undefined);
  plugin.activate(api);

  host.infoFetch = (typeId, entity) => {
    const h = host.infoHandlers[typeId];
    if (!h) throw new Error(`plugin registered no info handler "${typeId}" (has: ${Object.keys(host.infoHandlers).join(", ")})`);
    return h(entity);
  };
  host.menuAction = (id, target) => {
    const h = host.menuHandlers[id];
    if (!h) throw new Error(`plugin registered no menu action "${id}"`);
    return h(target);
  };
  // An image request the way the host's chain makes it: (name, artistName?).
  host.image = (entity, name, artistName) => {
    const h = host.imageHandlers[entity];
    if (!h) throw new Error(`plugin registered no image provider for "${entity}"`);
    return h(name, artistName);
  };
  host.startTrack = (track) => { for (const h of host.trackStartedHandlers) h(track); };
  // A Now Playing info item, asked the way the host asks: (PluginTrack).
  host.nowPlaying = (id, track) => {
    const h = host.nowPlayingHandlers[id];
    if (!h) throw new Error(`plugin registered no now-playing item "${id}"`);
    return h(track);
  };
  host.uiAction = (id, data) => {
    const h = host.uiHandlers[id];
    if (!h) throw new Error(`plugin registered no ui action "${id}"`);
    return h(data);
  };
  host.search = (providerId, query, limit) => {
    const h = host.searchHandlers[providerId];
    if (!h) throw new Error(`plugin registered no search provider "${providerId}"`);
    return h(query, limit);
  };
  host.tool = (name, args) => {
    const h = host.toolHandlers[name];
    if (!h) throw new Error(`plugin registered no assistant tool "${name}"`);
    return h(args || {});
  };
  // Resolve once the plugin has called playTracks (the album action returns
  // nothing — it plays when the scrape lands) or reported a failure.
  host.waitForPlayOrNotify = (sinceIdx, timeoutMs) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const ev = host.events.slice(sinceIdx).find((e) => e.kind === "play" || (e.kind === "notify" && /couldn|busy|no artist/i.test(e.data)));
      if (ev) { resolve(ev); return; }
      if (Date.now() - t0 > timeoutMs) { reject(new Error(`no play/notify within ${timeoutMs / 1000}s`)); return; }
      setTimeout(poll, 250);
    })();
  });
  // The plugin never awaits close(); wait for those here so the browser isn't
  // torn down mid-screenshot.
  host.deactivate = async () => {
    try { if (plugin.deactivate) plugin.deactivate(); } catch { /* best effort */ }
    await Promise.all(host.pendingCloses);
  };
  return host;
}
