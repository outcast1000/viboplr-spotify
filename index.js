// Spotify Browse Plugin for Viboplr
// Opens open.spotify.com in an internal browse window, navigates to configurable
// sections, and scrapes all playlists and their tracks from the rendered DOM.

// Set by activate() to a function that closes any open browse windows. Called by
// deactivate() so a plugin reload/disable never strands an audible Spotify
// window (which would keep playing and stack with the next activation's window).
var closeOpenWindows = null;

function activate(api) {
  var activeScrapeHandle = null;
  var scrapeGeneration = 0;
  // Only one browse window may be open at a time. Set synchronously when a
  // withSpotifyWindow call starts so a second concurrent open (e.g. a lazy
  // track fetch overlapping an auto-refresh) is rejected rather than stranding
  // the first window and wedging the UI.
  var windowBusy = false;
  // Whether this plugin currently owns the single global host loading modal, so
  // concurrent Play/Enqueue actions don't show/hide each other's modal.
  var loadingModalActive = false;

  var state = {
    currentView: "home",
    // idle | waiting-login | done | error
    status: "idle",
    playlists: [],
    playlistTracks: {},   // playlistId -> [{ name, artist, album, duration, imageUrl, spotifyId }]
    currentPlaylist: null,
    errorMessage: "",
    refreshing: false,
    showBrowserOnRefresh: false,
    autoRefreshHours: 24,
    debugLogging: false,
    // When true, Sync also captures album cards (kind:"album") alongside
    // playlists. Off by default; applies on the next sync. See the
    // include-albums design spec.
    includeAlbums: false,
    lastCheckAt: null,
    lastCheckResult: null,
    refreshSummary: "",
    // Section names are derived from each scrape and persisted to
    // spotify_browse_sections (loaded back at init). Start empty so a fresh
    // install shows the "No playlists yet" prompt and registers no phantom
    // shelves before the first sync.
    sections: [],
    lastReport: null,
    showDiagnostics: false,
    // Per-playlist search query (only used in the detail view). Keyed by
    // playlist id so navigating away and back keeps the query.
    playlistSearch: {},
    // Playlist id currently being lazily track-scraped (for the detail-view
    // loading state). Null when idle.
    loadingTracksFor: null,
    // Section name -> shelf description (gray text under the heading), from the
    // last scrape. Cold-start cache loaded at init.
    sectionDescriptions: {},
  };

  // Lazy-track cache TTL. Tracks scraped on demand are reused for this long
  // before a View/Play triggers a fresh scrape. See the lazy-single-page spec.
  var TRACKS_TTL_MS = 24 * 60 * 60 * 1000;

  // True if this playlist's cached tracks are still fresh (within TTL) AND we
  // actually have tracks in memory for it. Missing/old tracksFetchedAt => stale.
  function tracksAreFresh(pl) {
    if (!pl || !pl.tracksFetchedAt) return false;
    var t = Date.parse(pl.tracksFetchedAt);
    if (isNaN(t)) return false;
    var tracks = state.playlistTracks[pl.id];
    if (!tracks || tracks.length === 0) return false;
    return (Date.now() - t) < TRACKS_TTL_MS;
  }

  // ---- Helpers ----

  // Escapes text for HTML. Also escapes quotes so the result is safe in an
  // attribute value, not just element text.
  function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---- Diagnostics: unified logger + run report ----

  var MAX_STORED_REPORTS = 5;
  var activeReport = null;

  function plog(level, tag, msg, data) {
    var line = "[" + tag + "] " + msg;
    if (data !== undefined) line += " " + safeStringify(data);
    if (level === "error") console.error("[spotify]", line);
    else if (level === "warn") console.warn("[spotify]", line);
    else console.log("[spotify]", line);
    api.log(level, line, "spotify-browse");
    if (activeReport) appendSyncLine(level, tag, msg, data);
  }

  // Human-readable per-run log accumulator. Lines are appended in order as the
  // sync progresses and persisted as a logs/YYYYMMDD-HHMMSS.log file on finishReport().
  function appendSyncLine(level, tag, msg, data) {
    if (!activeReport) return;
    if (!activeReport.formattedLog) activeReport.formattedLog = [];
    var ts = new Date().toISOString();
    var lvl = (level || "info").toUpperCase();
    var line = ts + " [" + lvl + "] [" + tag + "] " + msg;
    if (data !== undefined) line += " " + safeStringify(data);
    activeReport.formattedLog.push(line);
  }

  // Convenience: append a free-form info line without going through plog (used
  // for high-level sync summaries we want in the log but not in the live UI).
  function syncNote(tag, msg, data) {
    appendSyncLine("info", tag, msg, data);
  }

  function dbg(tag, msg, data) { plog("info", tag, msg, data); }

  function safeStringify(v) {
    try { return typeof v === "string" ? v : JSON.stringify(v); }
    catch (e) { return "[unstringifiable]"; }
  }

  function beginReport(trigger) {
    activeReport = {
      trigger: trigger,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: 0,
      outcome: "running",
      errorMessage: null,
      // Detailed sync trace (persisted as the per-run logs/YYYYMMDD-HHMMSS.log)
      formattedLog: [],
      pageVisits: [],   // [{url, phase, ts}]
    };
    syncNote("sync", "=== Spotify sync started ===", { trigger: trigger });
  }

  function recordPageVisit(url, phase) {
    if (!activeReport || !url) return;
    activeReport.pageVisits.push({ url: url, phase: phase || "", ts: Date.now() });
  }

  function buildLastSyncLog(report) {
    var lines = [];
    lines.push("=== Spotify Sync Log ===");
    lines.push("Trigger: " + (report.trigger || "?"));
    lines.push("Started: " + report.startedAt);
    lines.push("Ended: " + (report.endedAt || "?"));
    lines.push("Duration: " + Math.round((report.durationMs || 0) / 1000) + "s (" + report.durationMs + "ms)");
    lines.push("Outcome: " + report.outcome + (report.errorMessage ? " — " + report.errorMessage : ""));
    lines.push("");

    // Pages visited
    lines.push("--- Pages visited (" + (report.pageVisits || []).length + ") ---");
    for (var v = 0; v < (report.pageVisits || []).length; v++) {
      var pv = report.pageVisits[v];
      lines.push("  [" + (pv.phase || "?") + "] " + pv.url);
    }
    lines.push("");

    // Full ordered trace
    lines.push("--- Trace (" + (report.formattedLog || []).length + " lines) ---");
    for (var fl = 0; fl < (report.formattedLog || []).length; fl++) {
      lines.push(report.formattedLog[fl]);
    }

    return lines.join("\n");
  }

  function finishReport(outcome, errorMessage) {
    if (!activeReport) return;
    activeReport.endedAt = new Date().toISOString();
    activeReport.durationMs = new Date(activeReport.endedAt).getTime() - new Date(activeReport.startedAt).getTime();
    activeReport.outcome = outcome;
    if (errorMessage) activeReport.errorMessage = errorMessage;
    syncNote("sync", "=== Spotify sync finished ===", {
      outcome: outcome,
      errorMessage: errorMessage || null,
      durationMs: activeReport.durationMs,
    });
    var snapshot = activeReport;
    activeReport = null;
    persistReport(snapshot);
    writePerRunLog(snapshot);
  }

  var MAX_PER_RUN_LOGS = 20;

  // "YYYYMMDD-HHMMSS" from an ISO timestamp, using LOCAL time components to match
  // the formatSyncTime display. Falls back to "unknown" if the date is invalid so
  // a log still gets written.
  function logStampFromIso(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown";
    function p2(n) { return (n < 10 ? "0" : "") + n; }
    return "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
      "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }

  // Write one human-readable log file per finished run, named by local timestamp.
  // Debug-gated; replaces the old last_sync.log KV value and logs/sync-runs.json.
  function writePerRunLog(report) {
    if (!state.debugLogging) return;
    var text;
    try {
      text = buildLastSyncLog(report);
    } catch (e) {
      console.error("Failed to build per-run log:", e);
      return;
    }
    var fname = logStampFromIso(report.startedAt) + ".log";
    api.storage.files.writeText(["logs", fname], text).then(function () {
      prunePerRunLogs();
    }).catch(function (e) {
      console.error("Failed to write per-run log:", e);
    });
  }

  // Keep only the newest MAX_PER_RUN_LOGS timestamped logs. The regex matches ONLY
  // our YYYYMMDD-HHMMSS.log files, so any other file in logs/ is never touched.
  // Lexicographic sort == chronological for this fixed-width format.
  function prunePerRunLogs() {
    api.storage.files.list(["logs"]).then(function (entries) {
      if (!entries || !entries.length) return;
      var names = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.isDir) continue;
        if (/^\d{8}-\d{6}\.log$/.test(e.name)) names.push(e.name);
      }
      names.sort();
      var removals = [];
      for (var j = 0; j < names.length - MAX_PER_RUN_LOGS; j++) {
        (function (nm) {
          removals.push(api.storage.files.remove(["logs", nm]).catch(console.error));
        })(names[j]);
      }
      return Promise.all(removals);
    }).catch(console.error);
  }

  function persistReport(report) {
    api.storage.get("spotify_browse_reports").then(function (existing) {
      var list = Array.isArray(existing) ? existing.slice() : [];
      list.unshift(report);
      if (list.length > MAX_STORED_REPORTS) list.length = MAX_STORED_REPORTS;
      api.storage.set("spotify_browse_reports", list).catch(function (e) {
        console.error("Failed to save spotify report:", e);
      });
      state.lastReport = report;
      renderSettings();
    }).catch(function (e) { console.error("Failed to read reports:", e); });
  }

  function sectionsEqual(a, b) {
    return String(a || "Playlists").toLowerCase() === String(b || "Playlists").toLowerCase();
  }

  function getPlaylistsForSection(sectionName) {
    var result = [];
    for (var i = 0; i < state.playlists.length; i++) {
      if (sectionsEqual(state.playlists[i].section, sectionName)) {
        result.push(state.playlists[i]);
      }
    }
    return result;
  }

  // ---- Filesystem persistence ----
  // Layout: playlists/{section}/{playlist_id}/{meta.json,tracks.json,cover.jpg,track-*.jpg}

  function djb2Hash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & 0xFFFFFFFF;
    }
    var hex = (hash >>> 0).toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
  }

  // Section names can contain characters that are awkward on disk. Normalize
  // (but keep spaces, letters, digits, and common punctuation Spotify uses).
  function sanitizeSegment(s) {
    if (!s) return "_";
    var out = String(s).replace(/[/\\\0]/g, "_").replace(/[\x00-\x1f]/g, "").trim();
    if (!out) return "_";
    if (out.length > 200) out = out.substring(0, 200);
    return out;
  }

  function playlistDir(pl) {
    return ["playlists", sanitizeSegment(pl.section || "Playlists"), sanitizeSegment(pl.id)];
  }

  function serializeTracks(tracks) {
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      out.push({
        name: t.name || "",
        artist: t.artist || "",
        album: t.album || "",
        duration: t.duration || "",
        spotifyId: t.spotifyId || null,
        coverFile: t.coverFile || null,
        imageUrl: t.imageUrl && t.imageUrl.indexOf("http") === 0 ? t.imageUrl : null,
      });
    }
    return out;
  }

  // Host source/URI scheme for an entry, by kind. Albums use spotify://albums/,
  // everything else (playlists) spotify://playlists/.
  function entitySource(pl) {
    return (pl && pl.kind === "album" ? "spotify://albums/" : "spotify://playlists/") + pl.id;
  }

  // Backfill each track's album from the album entry's own title. Spotify's
  // album page omits the per-track album column (every track shares the album
  // shown in the page header), so the row scraper returns album="" for albums.
  // The album name is page-level metadata we already hold as pl.name. No-op for
  // playlists (their pages DO have a per-row album column, scraped correctly)
  // and never overwrites an album the scraper did find. Mutates + returns tracks.
  function fillAlbumName(pl, tracks) {
    if (!pl || pl.kind !== "album" || !pl.name || !tracks) return tracks;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i] && !tracks[i].album) tracks[i].album = pl.name;
    }
    return tracks;
  }

  // Persist a single playlist's files. Returns a promise that resolves when
  // meta + tracks are on disk and images are being fetched (images run in
  // the background and the promise settles independently from their success).
  function savePlaylist(pl) {
    var dir = playlistDir(pl);
    var tracks = state.playlistTracks[pl.id] || [];

    var coverFile = "cover.jpg";
    var metaP = api.storage.files.writeJson(dir.concat(["meta.json"]), {
      id: pl.id,
      name: pl.name,
      section: pl.section || null,
      description: pl.description || "",
      coverFile: coverFile,
      coverVersion: pl.coverVersion || null,
      lastSyncedAt: pl.lastSyncedAt || null,
      tracksFetchedAt: pl.tracksFetchedAt || null,
      cardSubtitle: pl.cardSubtitle || "",
      kind: pl.kind || "playlist",
    }).catch(function (e) { console.error("Failed to write meta:", pl.id, e); });

    var tracksP = api.storage.files.writeJson(dir.concat(["tracks.json"]), serializeTracks(tracks))
      .catch(function (e) { console.error("Failed to write tracks:", pl.id, e); });

    return Promise.all([metaP, tracksP]);
  }

  function saveAllPlaylists() {
    var promises = [];
    for (var i = 0; i < state.playlists.length; i++) {
      promises.push(savePlaylist(state.playlists[i]));
    }
    return Promise.all(promises);
  }

  // Download cover + track images into each playlist's directory, updating
  // track.imageUrl / pl.imageUrl to absolute local paths. Idempotent — skips
  // fetches for images already local.
  function cacheAllImages() {
    var promises = [];
    var stats = { covers: 0, tracks: 0, coverFails: 0, trackFails: 0 };
    for (var pi = 0; pi < state.playlists.length; pi++) {
      (function (pl) {
        var dir = playlistDir(pl);
        if (pl.imageUrl && pl.imageUrl.indexOf("http") === 0) {
          stats.covers++;
          var coverUrl = pl.imageUrl;
          promises.push(
            api.storage.files.download(dir.concat(["cover.jpg"]), coverUrl).then(function (path) {
              // Bump coverVersion so the WebView refetches the file even though
              // the on-disk path is unchanged. Without this, weekly-rotating
              // covers (Discover Weekly) keep showing last week's image.
              pl.coverVersion = Date.now();
              pl.imageUrl = path + "#v=" + pl.coverVersion;
            }).catch(function (e) {
              stats.coverFails++;
              api.log("warn", "Failed to cache playlist cover for " + pl.name + ": " + e + " | url: " + coverUrl.substring(0, 120));
              // Don't blank a cover we already have. If cover.jpg is on disk from
              // a prior successful cache, fall back to it (matches loadPlaylistFromDisk).
              return api.storage.files.exists(dir.concat(["cover.jpg"])).then(function (has) {
                if (!has) { pl.imageUrl = null; return; }
                return api.storage.files.getPath(dir.concat(["cover.jpg"])).then(function (p) {
                  if (!p) { pl.imageUrl = null; return; }
                  pl.imageUrl = pl.coverVersion ? p + "#v=" + pl.coverVersion : p;
                });
              // Silent catch: the primary download failure was already logged
              // above (api.log warn); an exists/getPath error here just means no
              // on-disk fallback is available, so we null the image and move on.
              }).catch(function () { pl.imageUrl = null; });
            })
          );
        }
        var tracks = state.playlistTracks[pl.id] || [];
        for (var ti = 0; ti < tracks.length; ti++) {
          (function (track) {
            if (track.imageUrl && track.imageUrl.indexOf("http") === 0) {
              stats.tracks++;
              var trackUrl = track.imageUrl;
              var filename = "track-" + djb2Hash(track.name + " - " + track.artist) + ".jpg";
              promises.push(
                api.storage.files.download(dir.concat([filename]), trackUrl).then(function (path) {
                  track.imageUrl = path;
                  track.coverFile = filename;
                }).catch(function (e) {
                  stats.trackFails++;
                  api.log("warn", "Failed to cache track image (" + track.name + "): " + e + " | url: " + trackUrl.substring(0, 120));
                  track.imageUrl = null;
                  track.coverFile = null;
                })
              );
            }
          })(tracks[ti]);
        }
      })(state.playlists[pi]);
    }

    if (promises.length > 0) {
      dbg("images", "Caching " + stats.covers + " covers + " + stats.tracks + " track images");
      Promise.all(promises).then(function () {
        if (stats.coverFails || stats.trackFails) {
          api.log("warn", "Image cache complete: " + stats.coverFails + "/" + stats.covers + " covers failed, " + stats.trackFails + "/" + stats.tracks + " tracks failed");
        } else {
          dbg("images", "All images cached successfully (" + stats.covers + " covers, " + stats.tracks + " tracks)");
        }
        pruneAllOrphanTrackImages();
        saveAllPlaylists();
        render();
      }).catch(function () {
        pruneAllOrphanTrackImages();
        saveAllPlaylists();
      });
    } else {
      pruneAllOrphanTrackImages();
    }
  }

  // Remove track-*.jpg files that no longer correspond to a track currently in
  // the playlist. Expected filenames are recomputed from the live tracklist
  // (same scheme as cacheAllImages), NOT read from track.coverFile — a track's
  // coverFile is often null after a transient download failure while its image
  // is validly on disk, so pruning by coverFile would delete still-valid files.
  // Non-"track-*.jpg" files (meta.json, tracks.json, cover.jpg/svg) are never
  // touched. Reconciling the whole directory each refresh also sweeps historical
  // orphans accumulated before this fix shipped.
  function pruneOrphanTrackImages(pl) {
    var dir = playlistDir(pl);
    var tracks = state.playlistTracks[pl.id] || [];
    var expected = {};
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      // Mirror the filename expression at cacheAllImages (index.js:544) EXACTLY
      // (no || "" guards) — any divergence would hash differently and delete a
      // valid file.
      expected["track-" + djb2Hash(t.name + " - " + t.artist) + ".jpg"] = true;
    }
    return api.storage.files.list(dir).then(function (entries) {
      if (!entries || !entries.length) return;
      var removals = [];
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        if (e.isDir) continue;
        if (e.name.indexOf("track-") !== 0) continue;
        if (e.name.lastIndexOf(".jpg") !== e.name.length - 4) continue;
        if (expected[e.name]) continue;
        (function (fname) {
          removals.push(
            api.storage.files.remove(dir.concat([fname])).catch(console.error)
          );
        })(e.name);
      }
      if (removals.length > 0) {
        dbg("images", "pruned " + removals.length + " orphan track images for \"" + pl.name + "\"");
      }
      return Promise.all(removals);
    }).catch(console.error);
  }

  function pruneAllOrphanTrackImages() {
    var promises = [];
    for (var i = 0; i < state.playlists.length; i++) {
      promises.push(pruneOrphanTrackImages(state.playlists[i]));
    }
    return Promise.all(promises);
  }

  function saveState() {
    saveAllPlaylists().catch(console.error);
  }

  // Walk playlists/** and load every {section, id, meta, tracks}. Resolves
  // track coverFile references to absolute paths for rendering.
  function loadPlaylistsFromDisk() {
    return api.storage.files.list(["playlists"]).then(function (sectionEntries) {
      var sections = [];
      for (var i = 0; i < sectionEntries.length; i++) {
        if (sectionEntries[i].isDir) sections.push(sectionEntries[i].name);
      }
      var playlistLoads = [];
      for (var s = 0; s < sections.length; s++) {
        (function (sec) {
          playlistLoads.push(
            api.storage.files.list(["playlists", sec]).then(function (plEntries) {
              var loads = [];
              for (var j = 0; j < plEntries.length; j++) {
                if (!plEntries[j].isDir) continue;
                (function (plId) {
                  loads.push(loadPlaylistFromDisk(sec, plId));
                })(plEntries[j].name);
              }
              return Promise.all(loads);
            })
          );
        })(sections[s]);
      }
      return Promise.all(playlistLoads);
    }).then(function (perSection) {
      var allPlaylists = [];
      var allTracks = {};
      for (var i = 0; i < perSection.length; i++) {
        var loaded = perSection[i];
        for (var j = 0; j < loaded.length; j++) {
          var entry = loaded[j];
          if (!entry) continue;
          allPlaylists.push(entry.playlist);
          allTracks[entry.playlist.id] = entry.tracks;
        }
      }
      return { playlists: allPlaylists, tracks: allTracks };
    });
  }

  function loadPlaylistFromDisk(sectionName, playlistIdSegment) {
    var dir = ["playlists", sectionName, playlistIdSegment];
    return Promise.all([
      api.storage.files.readJson(dir.concat(["meta.json"])),
      api.storage.files.readJson(dir.concat(["tracks.json"])),
    ]).then(function (results) {
      var meta = results[0];
      var tracks = results[1] || [];
      if (!meta) return null;

      // Resolve cover path
      var coverP = meta.coverFile
        ? api.storage.files.getPath(dir.concat([meta.coverFile]))
        : Promise.resolve(null);

      // Resolve each track's coverFile
      var trackPathPromises = [];
      for (var i = 0; i < tracks.length; i++) {
        (function (t) {
          if (t.coverFile) {
            trackPathPromises.push(
              api.storage.files.getPath(dir.concat([t.coverFile])).then(function (p) {
                if (p) t.imageUrl = p;
              })
            );
          }
        })(tracks[i]);
      }

      return coverP.then(function (coverPath) {
        return Promise.all(trackPathPromises).then(function () {
          var versionedCover = coverPath
            ? (meta.coverVersion ? coverPath + "#v=" + meta.coverVersion : coverPath)
            : null;
          var playlist = {
            id: meta.id,
            name: meta.name,
            section: meta.section || sectionName,
            description: meta.description || "",
            imageUrl: versionedCover,
            coverVersion: meta.coverVersion || null,
            kind: meta.kind || "playlist",
            lastSyncedAt: meta.lastSyncedAt || null,
            tracksFetchedAt: meta.tracksFetchedAt || null,
            cardSubtitle: meta.cardSubtitle || "",
          };
          playlist.uri = entitySource(playlist);
          return { playlist: playlist, tracks: tracks };
        });
      });
    }).catch(function (e) {
      console.error("Failed to load playlist:", sectionName, playlistIdSegment, e);
      return null;
    });
  }

  // Delete all on-disk data for a playlist (used when a refresh no longer
  // returns it from its section).
  function deletePlaylistFiles(pl) {
    return api.storage.files.remove(playlistDir(pl)).catch(function (e) {
      console.error("Failed to delete playlist dir:", pl.id, e);
    });
  }

  function savePreferences() {
    api.storage.set("spotify_browse_preferences", {
      showBrowserOnRefresh: state.showBrowserOnRefresh,
      autoRefreshHours: state.autoRefreshHours,
      debugLogging: state.debugLogging,
      includeAlbums: state.includeAlbums,
      lastCheckAt: state.lastCheckAt,
      lastCheckResult: state.lastCheckResult,
    }).catch(console.error);
  }

  function recordCheckResult(playlists, errors) {
    state.lastCheckAt = new Date().toISOString();
    state.lastCheckResult = playlists + " playlists";
    if (errors > 0) state.lastCheckResult += ", " + errors + " error" + (errors > 1 ? "s" : "");
    savePreferences();
  }

  // ---- Render ----

  function render() {
    if (typeof syncHomeShelves === "function") {
      try { syncHomeShelves(); } catch (e) { console.error("syncHomeShelves failed:", e); }
    }
    if (state.currentView === "playlist") { renderPlaylist(); return; }
    renderHome();
  }

  function isActiveStatus() {
    return state.status === "waiting-login";
  }

  function buildToolbar() {
    var buttons = [];
    var isActive = isActiveStatus();

    if (isActive) {
      buttons.push({ label: "Cancel", action: "cancel" });
    } else {
      buttons.push({ label: "Sync", action: "sync" });
    }


    var statusText = "";
    var statusVariant = "default";

    if (isActive) {
      statusText = "Waiting for login…";
    } else if (state.status === "error") {
      statusText = state.errorMessage;
      statusVariant = "error";
    } else if (state.refreshSummary) {
      statusText = state.refreshSummary;
    } else if (state.lastCheckResult) {
      statusText = state.lastCheckResult;
    }

    // Append the last-check timestamp to the status text rather than the title.
    if (!isActive && state.lastCheckAt && statusText) {
      statusText += " — " + formatSyncTime(state.lastCheckAt);
    }

    return {
      type: "toolbar",
      buttons: buttons,
      status: statusText || undefined,
      statusVariant: statusVariant,
    };
  }

  // Short "May 29, 14:32" style stamp for last-synced display.
  function formatSyncTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) +
      ", " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function buildPlaylistCards(playlists) {
    var cards = [];
    for (var pi = 0; pi < playlists.length; pi++) {
      var sp = playlists[pi];
      var ts = state.playlistTracks[sp.id];
      // Before tracks are fetched, show the scraped home-card subtitle (e.g.
      // "With X, Y…"). After a fetch, show the track count + synced stamp.
      // Do NOT fall back to pl.description — that's the long playlist-page
      // description (only non-empty for algorithmic Made-for-You playlists, and
      // carried over from the old plugin's meta.json), which is the wrong text
      // for a card subtitle and caused stale "old plugin" descriptions to show.
      var sub;
      if (ts && ts.length > 0) {
        sub = ts.length + " tracks";
        if (sp.lastSyncedAt) sub += " · synced " + formatSyncTime(sp.lastSyncedAt);
      } else {
        sub = sp.cardSubtitle || "";
      }
      var cardTracks = [];
      if (ts) {
        for (var ti = 0; ti < ts.length; ti++) {
          cardTracks.push({
            title: ts[ti].name || "",
            artistName: ts[ti].artist || null,
            albumName: ts[ti].album || null,
          });
        }
      }
      var menu = [
        { id: "play-playlist", label: "Play" },
        { id: "enqueue-playlist", label: "Enqueue" },
        { id: "view-playlist", label: "View / Edit" },
        { id: "refresh-tracks-ctx", label: "Refresh tracks" },
      ];
      menu.push({ id: "sep", label: "", separator: true });
      menu.push({ id: "save-playlist-ctx", label: "Save to Playlists" });

      cards.push({
        id: "playlist:" + sp.id,
        title: sp.name,
        subtitle: sub,
        imageUrl: sp.imageUrl,
        action: "view-playlist",
        targetKind: sp.kind === "album" ? "album" : "playlist",
        tracks: cardTracks,
        contextMenuActions: menu,
      });
    }
    return cards;
  }

  function renderHome() {
    api.ui.setBadge("spotify", null);
    var isActive = isActiveStatus();

    var toolbar = buildToolbar();
    toolbar.buttons.push({ label: state.showBrowserOnRefresh ? "Browser: ON" : "Browser: OFF", action: "toggle-show-browser-pref", variant: state.showBrowserOnRefresh ? "accent" : "secondary" });
    var view = [toolbar];

    // Empty state: nothing scraped yet.
    if (state.sections.length === 0) {
      if (!isActive && state.status === "idle") {
        view.push({ type: "text", content: "<p style='opacity:0.5;padding:16px'>No playlists yet. Click <b>Sync</b> to scrape your Spotify Music home.</p>" });
      }
      api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: view }, { scrollKey: "home" });
      return;
    }

    // One stacked block per shelf: heading (+ description) + card-grid.
    for (var i = 0; i < state.sections.length; i++) {
      var sectionName = state.sections[i];
      var secPlaylists = getPlaylistsForSection(sectionName);
      if (secPlaylists.length === 0) continue;
      var headerHtml = "<h3 style='margin:0 0 2px;font-size:var(--fs-md)'>" + escapeHtml(sectionName) + "</h3>";
      var descr = state.sectionDescriptions[sectionName];
      if (descr) headerHtml += "<p style='margin:0 0 6px;font-size:var(--fs-xs);color:var(--text-secondary)'>" + escapeHtml(descr) + "</p>";
      view.push({
        type: "layout", direction: "vertical", style: { "padding": "12px 16px 0" },
        children: [
          { type: "text", content: headerHtml },
          { type: "card-grid", items: buildPlaylistCards(secPlaylists) },
        ],
      });
    }

    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: view }, { scrollKey: "home" });
  }

  // Build the hero's crossfade background (bgImages, host caps at 4): the cover
  // first, then up to 3 DISTINCT LOCAL track album-arts. Track arts are included
  // only once cached locally (imageUrl not starting with "http") — during a
  // scrape they're remote CDN URLs, excluded so the background stays the cover
  // until images cache, then upgrades to the collage. De-duped; never repeats
  // the cover. Pure: no api/DOM/state.
  function buildHeroBackground(pl, tracks) {
    var bg = [];
    var seen = {};
    var cover = pl && pl.imageUrl;
    if (cover) { bg.push(cover); seen[cover] = true; }
    var list = tracks || [];
    for (var i = 0; i < list.length && bg.length < 4; i++) {
      var url = list[i] && list[i].imageUrl;
      if (!url) continue;
      if (url.indexOf("http") === 0) continue; // remote (not yet cached) — skip
      if (seen[url]) continue;
      seen[url] = true;
      bg.push(url);
    }
    return bg;
  }

  function renderPlaylist() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    var loadingThis = state.loadingTracksFor === pl.id;
    var query = (state.playlistSearch[pl.id] || "").trim().toLowerCase();
    var contextActions = [
      { id: "play-current", label: "Play" },
      { id: "enqueue-current", label: "Enqueue" },
      { id: "sep1", label: "", separator: true },
      { id: "save-playlist", label: "Save to Playlists" },
    ];
    var headerMeta = (pl.kind === "album" ? "Album · " : "") + tracks.length + " tracks";
    if (pl.lastSyncedAt) headerMeta += " · synced " + formatSyncTime(pl.lastSyncedAt);
    var ch = [
      {
        type: "detail-header",
        title: pl.name,
        subtitle: pl.description || undefined,
        meta: headerMeta,
        imageUrl: pl.imageUrl || undefined,
        bgImages: buildHeroBackground(pl, tracks),
        backAction: "go-home",
        playAction: (!loadingThis && tracks.length > 0) ? "play-current" : undefined,
        enqueueAction: (!loadingThis && tracks.length > 0) ? "enqueue-current" : undefined,
        contextMenuActions: contextActions,
      },
    ];

    // Show a search box for any playlist with enough tracks to make scanning
    // them painful. The threshold is conservative — the box is cheap.
    if (tracks.length > 50) {
      ch.push({
        type: "search-input",
        placeholder: "Filter " + tracks.length + " tracks…",
        action: "playlist-search",
        value: state.playlistSearch[pl.id] || "",
      });
    }

    if (tracks.length > 0) {
      var items = [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (query) {
          // Match against title, artist, album. Case-insensitive substring.
          var hay = ((t.name || "") + " " + (t.artist || "") + " " + (t.album || "")).toLowerCase();
          if (hay.indexOf(query) === -1) continue;
        }
        items.push({
          id: "track:" + i,
          title: t.name || "Unknown",
          subtitle: t.artist || "Unknown",
          album: t.album || "",
          imageUrl: t.imageUrl || undefined,
          duration: t.duration || "",
          action: "play-track",
        });
      }
      if (query && items.length === 0) {
        ch.push({ type: "text", content: "<p style='opacity:0.5;padding:12px 0'>No tracks match \"" + escapeHtml(query) + "\"</p>" });
      } else if (query) {
        ch.push({ type: "text", content: "<p style='font-size:var(--fs-xs);color:var(--text-secondary);margin:6px 0 0'>" + items.length + " of " + tracks.length + " tracks</p>" });
      }
      if (items.length > 0) {
        ch.push({ type: "track-row-list", items: items, numbered: true, showHeader: true });
      }
      // Still scraping more rows: spinner + live count footer (host loading node).
      if (loadingThis) {
        ch.push({ type: "loading", message: "Loading more… " + tracks.length + " tracks" });
      }
    } else if (loadingThis) {
      ch.push({ type: "loading", message: "Fetching tracks…" });
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks scraped</p>" });
    }
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch }, { scrollKey: "playlist:" + pl.id });
  }

  function renderSettings() {
    var ch = [];

    ch.push({
      type: "select", label: "Auto-refresh interval", action: "set-auto-refresh",
      value: "" + state.autoRefreshHours,
      options: [
        { value: "0", label: "Off" },
        { value: "6", label: "Every 6 hours" },
        { value: "12", label: "Every 12 hours" },
        { value: "24", label: "Every 24 hours" },
        { value: "48", label: "Every 2 days" },
        { value: "168", label: "Every week" },
      ],
    });

    ch.push({ type: "toggle", label: "Show browser window during refresh", checked: state.showBrowserOnRefresh, action: "toggle-show-browser-pref" });
    ch.push({ type: "toggle", label: "Debug logging", checked: state.debugLogging, action: "toggle-debug-logging" });
    ch.push({ type: "toggle", label: "Include albums in sync", checked: state.includeAlbums, action: "toggle-include-albums" });

    ch.push(buildDebugTestSection());
    ch.push(buildDiagnosticsSection());

    api.ui.setViewData("spotify-settings", {
      type: "layout", direction: "vertical", children: ch,
    });
  }

  function buildDiagnosticsSection() {
    var rep = state.lastReport;
    var children = [];

    children.push({
      type: "layout", direction: "horizontal", style: { "gap": "8px", "align-items": "center" },
      children: [
        { type: "button", label: state.showDiagnostics ? "Hide" : "Show Last Run", action: "toggle-diagnostics", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
        { type: "button", label: "Clear History", action: "clear-diagnostics", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
      ],
    });

    if (!state.showDiagnostics) {
      return { type: "section", title: "Diagnostics", children: children };
    }

    if (!rep) {
      children.push({ type: "text", content: "<p>No runs recorded yet. Click Sync or refresh a section to populate diagnostics.</p>" });
      return { type: "section", title: "Diagnostics", children: children };
    }

    var started = new Date(rep.startedAt);
    var header = "<p><b>" + escapeHtml(rep.trigger || "run") + "</b> — " +
      escapeHtml(started.toLocaleString()) + "<br/>" +
      "Outcome: <b>" + escapeHtml(rep.outcome) + "</b> in " + Math.round((rep.durationMs || 0) / 1000) + "s";
    if (rep.errorMessage) header += "<br/><b>Error:</b> " + escapeHtml(rep.errorMessage);
    header += "</p>";
    children.push({ type: "text", content: header });

    if (rep.pageVisits && rep.pageVisits.length) {
      children.push({ type: "text", content: "<p><b>Pages visited:</b> " + rep.pageVisits.length + "</p>" });
    }

    children.push({ type: "text", content: "<p><i>Detailed logs are written to the app log file (filter by spotify-browse). When Debug logging is on, each sync run is written as a timestamped <code>logs/YYYYMMDD-HHMMSS.log</code> file (newest 20 kept) in the plugin's data folder.</i></p>" });

    return { type: "section", title: "Diagnostics", children: children };
  }

  // ---- Interactive step-by-step debugger ----

  var dbgTest = {
    status: "idle", // idle | running | waiting | done
    currentStep: 0,
    steps: [],
    handle: null,
    playlists: [],
    selectedPlaylist: "",
  };

  // Expose window cleanup to deactivate(). Bumping the generation cancels any
  // in-flight scrape loop so it stops eval-ing into a closing window.
  closeOpenWindows = function () {
    scrapeGeneration++;
    if (activeScrapeHandle) { activeScrapeHandle.close().catch(function () {}); activeScrapeHandle = null; }
    if (dbgTest.handle) { dbgTest.handle.close().catch(function () {}); dbgTest.handle = null; }
    windowBusy = false;
  };

  var DBG_STEPS = [
    { id: "login", label: "1. Check Login" },
    { id: "scrape-shelves", label: "2. Scrape Shelves" },
    { id: "scrape-tracks", label: "3. Scrape Tracks" },
  ];

  // Login signal keys, mirrored by SCRIPT_CHECK_LOGIN (which produces the
  // signals object). Kept in one place so the JS-side login detection and the
  // diagnostics formatter never drift. The injected script copy is necessarily
  // a separate string literal.
  var POSITIVE_LOGIN_SIGNALS = ["sessionTag", "userWidget", "userBox", "avatar", "accountLink", "libraryBtn", "createPlaylist", "globalNav", "leftSidebar", "nowPlayingBar", "mainNav"];
  var NEGATIVE_LOGIN_SIGNALS = ["loginBtn", "signupBtn", "signupBar", "loginLink"];

  // True if `signals` has any of `keys` set. Null-safe.
  function anyLoginSignal(signals, keys) {
    if (!signals) return false;
    for (var i = 0; i < keys.length; i++) { if (signals[keys[i]]) return true; }
    return false;
  }

  function dbgStart() {
    dbgTest.status = "waiting";
    dbgTest.currentStep = 0;
    dbgTest.steps = [];
    dbgTest.playlists = [];
    dbgTest.selectedPlaylist = "";
    dbgOpenLiveWindow().then(function () {
      renderSettings();
    }).catch(function (e) {
      api.log("error", "Failed to open debug window: " + e);
      renderSettings();
    });
    renderSettings();
  }

  function dbgRunStep(stepId) {
    if (stepId === "login") {
      dbgTest.steps.push({ id: "login", status: "running", source: "live", log: [] });
      dbgTest.status = "running";
      renderSettings();
      dbgOpenLiveWindow().then(function () {
        dbgCheckLogin();
      }).catch(function (e) {
        dbgStepFail("login", "Failed to open window: " + e);
      });
    } else if (stepId === "scrape-shelves") {
      dbgTest.steps.push({ id: "scrape-shelves", status: "running", source: "live", log: [] });
      dbgTest.status = "running";
      renderSettings();
      dbgTest.handle.eval('window.location.href=' + JSON.stringify(MUSIC_CHIP_URL)).catch(console.error);
      setTimeout(function () {
        dbgEvalAndWait(scriptScrapeShelves(state.includeAlbums), "shelves", 30000, function (data) {
          var shelves = (data && data.shelves) || [];
          var pls = [];
          for (var s = 0; s < shelves.length; s++) {
            for (var p = 0; p < shelves[s].playlists.length; p++) pls.push(shelves[s].playlists[p]);
          }
          dbgTest.playlists = pls;
          if (pls.length > 0) dbgTest.selectedPlaylist = pls[0].id;
          dbgStepDone("scrape-shelves", "Found <b>" + shelves.length + "</b> shelf(s), <b>" + pls.length + "</b> playlist(s)");
        }, function () {
          dbgStepFail("scrape-shelves", "No shelves found (timeout)");
        });
      }, 4000);
    } else if (stepId === "scrape-tracks") {
      dbgTest.steps.push({ id: "scrape-tracks", status: "running", source: "live", log: [] });
      dbgTest.status = "running";
      renderSettings();
      var plId = dbgTest.selectedPlaylist;
      if (!plId) {
        dbgStepFail("scrape-tracks", "No playlist selected");
        return;
      }
      dbgTest.handle.eval(scriptNavigatePlaylist(plId)).catch(console.error);
      setTimeout(function () {
        dbgTest.handle.eval(scriptScrollThenScrape(plId, 999)).catch(console.error);
        dbgWaitForMessage("tracks", 30000, function (data) {
          if (data && data.tracks) {
            dbgStepDone("scrape-tracks", "Found <b>" + data.tracks.length + "</b> track(s)" + (data.error ? " (with error: " + escapeHtml(data.error) + ")" : ""));
          } else {
            dbgStepFail("scrape-tracks", "No tracks data received");
          }
        }, function () {
          dbgStepFail("scrape-tracks", "Track scrape timeout");
        });
      }, 5000);
    }
  }

  function dbgOpenLiveWindow() {
    if (dbgTest.handle) return Promise.resolve();
    return api.network.openBrowseWindow("https://open.spotify.com", {
      title: "Spotify Debug",
      width: 1200,
      height: 800,
      visible: true,
    }).then(function (h) {
      dbgTest.handle = h;
      h.eval(SCRIPT_MUTE_AUDIO).catch(function () {});
      if (h.onNavigation) {
        h.onNavigation(function () { h.eval(SCRIPT_MUTE_AUDIO).catch(function () {}); });
      }
      h.onMessage(function (msg) {
        if (msg.type === "dbg" && msg.data) {
          var step = dbgTest.steps[dbgTest.steps.length - 1];
          if (step) step.log.push("[" + (msg.data.tag || "?") + "] " + (msg.data.msg || ""));
        }
        if (dbgTest._msgHandler) dbgTest._msgHandler(msg);
      });
    });
  }

  // Collect the keys in `keys` that are truthy on `signals`.
  function presentLoginSignals(signals, keys) {
    var out = [];
    for (var i = 0; i < keys.length; i++) { if (signals[keys[i]]) out.push(keys[i]); }
    return out;
  }

  function dbgFormatLoginResult(data) {
    var details = "";
    if (data && data.signals) {
      var pos = presentLoginSignals(data.signals, POSITIVE_LOGIN_SIGNALS);
      var neg = presentLoginSignals(data.signals, NEGATIVE_LOGIN_SIGNALS);
      details = "<br/>Positive signals: <b>" + (pos.length > 0 ? pos.join(", ") : "none") + "</b>";
      details += "<br/>Negative signals: <b>" + (neg.length > 0 ? neg.join(", ") : "none") + "</b>";
      if (data.url) details += "<br/>URL: " + escapeHtml(data.url);
    }
    if (data && data.pageDump) {
      details += "<br/>Page dump: " + escapeHtml(safeStringify(data.pageDump)).substring(0, 300);
    }
    return details;
  }

  function dbgCheckLogin() {
    var retries = 0;
    var maxRetries = 15;
    var lastData = null;
    var pollTimer = null;

    function finish(success, message) {
      if (success) dbgStepDone("login", message);
      else dbgStepFail("login", message);
    }

    function attempt() {
      retries++;
      dbgTest._msgHandler = function (msg) {
        if (msg.type === "login-check" && msg.data) {
          lastData = msg.data;
          dbgTest._msgHandler = null;
          var hasNegative = anyLoginSignal(lastData.signals, NEGATIVE_LOGIN_SIGNALS);

          if (lastData.loggedIn) {
            if (pollTimer) clearInterval(pollTimer);
            var details = dbgFormatLoginResult(lastData);
            finish(true, "Logged in (attempt " + retries + "/" + maxRetries + ")" + details);
          } else if (hasNegative) {
            if (pollTimer) clearInterval(pollTimer);
            var details = dbgFormatLoginResult(lastData);
            finish(false, "Not logged in (attempt " + retries + "/" + maxRetries + ")" + details);
          } else if (retries >= maxRetries) {
            if (pollTimer) clearInterval(pollTimer);
            var details = dbgFormatLoginResult(lastData);
            finish(false, "No clear signal after " + maxRetries + " attempts" + details);
          }
          // else: no clear signal yet, keep polling
        }
      };
      dbgTest.handle.eval(SCRIPT_CHECK_LOGIN).catch(function () {
        if (retries >= maxRetries) {
          if (pollTimer) clearInterval(pollTimer);
          finish(false, "Script evaluation failed");
        }
      });
    }

    // Wait 2s for initial page load, then poll every 3s
    setTimeout(function () {
      attempt();
      pollTimer = setInterval(attempt, 3000);
    }, 2000);
  }

  function dbgEvalAndWait(script, msgType, timeout, onSuccess, onTimeout) {
    dbgWaitForMessage(msgType, timeout, onSuccess, onTimeout);
    dbgTest.handle.eval(script).catch(function (e) {
      onTimeout();
    });
  }

  function dbgWaitForMessage(msgType, timeout, onSuccess, onTimeout) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      dbgTest._msgHandler = null;
      onTimeout();
    }, timeout);

    dbgTest._msgHandler = function (msg) {
      if (msg.type === msgType) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        dbgTest._msgHandler = null;
        onSuccess(msg.data);
      }
    };
  }

  function dbgStepDone(stepId, message) {
    var step = dbgTest.steps.find(function (s) { return s.id === stepId; });
    if (step) { step.status = "done"; step.result = message; }
    dbgTest.status = "waiting";
    dbgTest.currentStep++;
    renderSettings();
  }

  function dbgStepFail(stepId, message) {
    var step = dbgTest.steps.find(function (s) { return s.id === stepId; });
    if (step) { step.status = "failed"; step.result = message; }
    dbgTest.status = "waiting";
    dbgTest.currentStep++;
    renderSettings();
  }

  function dbgStop() {
    if (dbgTest.handle) {
      dbgTest.handle.close().catch(console.error);
      dbgTest.handle = null;
    }
    dbgTest._msgHandler = null;
    dbgTest.status = "idle";
    dbgTest.steps = [];
    dbgTest.playlists = [];
    renderSettings();
  }

  function buildDebugTestSection() {
    var children = [];
    var running = dbgTest.status === "running";
    var waiting = dbgTest.status === "waiting";
    var idle = dbgTest.status === "idle";

    // Section name input + Start/Stop
    var headerButtons = [];
    if (running) {
      headerButtons.push({ type: "button", label: "Stop", action: "dbg-stop", variant: "secondary", style: { padding: "3px 14px" } });
    } else if (idle) {
      headerButtons.push({ type: "button", label: "Start", action: "dbg-start", variant: "accent", style: { padding: "3px 14px" } });
    } else {
      headerButtons.push({ type: "button", label: "Reset", action: "dbg-stop", variant: "secondary", style: { padding: "3px 10px" } });
    }
    if (dbgTest.handle) {
      headerButtons.push({ type: "button", label: "DevTools", action: "dbg-devtools", variant: "secondary", style: { padding: "3px 10px" } });
    }

    children.push({
      type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
      children: headerButtons,
    });

    // Step results
    for (var i = 0; i < dbgTest.steps.length; i++) {
      var step = dbgTest.steps[i];
      var icon = step.status === "done" ? "✓" : step.status === "failed" ? "✗" : "⋯";
      var color = step.status === "done" ? "var(--success)" : step.status === "failed" ? "var(--error)" : "var(--text-secondary)";
      var stepLabel = DBG_STEPS.find(function (s) { return s.id === step.id; });
      var content = "<div style=\"font-size:var(--fs-xs);padding:4px 0;border-bottom:1px solid var(--border)\">" +
        "<span style=\"color:" + color + ";font-weight:bold\">" + icon + "</span> " +
        "<b>" + (stepLabel ? stepLabel.label : step.id) + "</b>" +
        " <span style=\"opacity:0.6\">(" + step.source + ")</span>" +
        (step.result ? "<br/>" + step.result : "") +
        "</div>";
      children.push({ type: "text", content: content });

      // Show logs if step failed
      if (step.status === "failed" && step.log && step.log.length > 0) {
        var logHtml = step.log.slice(-10).map(function (l) {
          return "<p style=\"margin:1px 0;font-size:var(--fs-2xs);opacity:0.7\">" + escapeHtml(l) + "</p>";
        }).join("");
        children.push({ type: "text", content: "<div style=\"padding-left:16px\">" + logHtml + "</div>" });
      }
    }

    // Next step source choice (when waiting and steps remain)
    if (waiting && dbgTest.currentStep < DBG_STEPS.length) {
      var nextStep = DBG_STEPS[dbgTest.currentStep];
      children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);margin-top:8px\"><b>Next:</b> " + nextStep.label + "</p>" });

      // Playlist selector for track scraping step
      if (nextStep.id === "scrape-tracks" && dbgTest.playlists.length > 0) {
        children.push({
          type: "select", label: "Playlist to scrape", action: "dbg-select-playlist",
          value: dbgTest.selectedPlaylist,
          options: dbgTest.playlists.map(function (p) { return { value: p.id, label: p.name || p.id }; }),
        });
      }

      children.push({
        type: "button", label: "Run Step", action: "dbg-next-step", variant: "accent", style: { padding: "3px 14px", "margin-top": "4px" },
      });
    }

    // All done
    if (waiting && dbgTest.currentStep >= DBG_STEPS.length) {
      children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);margin-top:8px;color:var(--success)\"><b>All steps completed.</b></p>" });
    }

    return { type: "section", title: "Step-by-Step Debugger", children: children };
  }

  // ---- Injected scripts (plain strings for eval) ----

  // >>> SCRAPE-SCRIPTS-START (do not remove: scripts/extract-scripts.mjs slices between these markers)
  var DBG_HELPER =
    'function _dbg(tag,msg,data){' +
      'console.log("[spotify-dbg]",tag,msg,data);' +
      'try{if(window.__viboplr&&window.__viboplr.send)window.__viboplr.send("dbg",{tag:tag,msg:msg,data:data,level:"info"})}catch(e){}' +
    '}' +
    'function _dbgErr(tag,msg,data){' +
      'console.error("[spotify-dbg]",tag,msg,data);' +
      'try{if(window.__viboplr&&window.__viboplr.send)window.__viboplr.send("dbg",{tag:tag,msg:msg,data:data,level:"error"})}catch(e){}' +
    '}';

  // Injected when we open the window because the user isn't logged in. Adds a
  // fixed banner telling them what to do; the banner is removed automatically
  // once login is detected and scraping proceeds. Mirrors the google-image-search
  // captcha banner approach.
  var LOGIN_BANNER_ID = "__viboplr_spotify_login_banner";
  var SCRIPT_LOGIN_BANNER =
    '(function(){' +
      'var ID="' + LOGIN_BANNER_ID + '";' +
      'if(document.getElementById(ID))return;' +
      'var bar=document.createElement("div");' +
      'bar.id=ID;' +
      'bar.style.cssText="position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'background:#1DB954;color:#000;font-family:-apple-system,system-ui,sans-serif;' +
        'padding:12px 16px;font-size:14px;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,.3);";' +
      'bar.innerHTML="<b>Viboplr needs you to log in to Spotify.</b>' +
        '<br/>Please sign in to your Spotify account in this window. ' +
        'Once you are logged in, syncing continues automatically. ' +
        'You usually only need to do this once.";' +
      'document.documentElement.appendChild(bar);' +
      'document.body&&(document.body.style.paddingTop=(bar.offsetHeight+8)+"px");' +
    '})();';
  var SCRIPT_REMOVE_LOGIN_BANNER =
    '(function(){' +
      'var el=document.getElementById("' + LOGIN_BANNER_ID + '");' +
      'if(el&&el.parentNode)el.parentNode.removeChild(el);' +
      'if(document.body)document.body.style.paddingTop="";' +
    '})();';

  // Silence the Spotify web player living inside the scrape window. We only ever
  // read the DOM — audio is never wanted — but Spotify may autoplay/resume a
  // track, which is audible the moment the (normally hidden) window is shown and
  // can stack with another orphaned window. Mute every current and future
  // <audio>/<video> element, and re-mute on any attempt to unmute or play.
  var SCRIPT_MUTE_AUDIO =
    '(function(){' +
      'if(window.__viboplrMuted)return;window.__viboplrMuted=true;' +
      'function mute(el){try{el.muted=true;el.volume=0;if(!el.paused)el.pause();}catch(e){}}' +
      'function muteAll(){var m=document.querySelectorAll("audio,video");for(var i=0;i<m.length;i++)mute(m[i]);}' +
      'muteAll();' +
      // Re-mute whenever a media element starts playing or gets unmuted.
      'document.addEventListener("play",function(e){if(e.target&&e.target.muted!==undefined)mute(e.target);},true);' +
      'document.addEventListener("volumechange",function(e){var t=e.target;if(t&&(t.muted===false||t.volume>0))mute(t);},true);' +
      // Catch elements added later by the SPA.
      'try{var mo=new MutationObserver(muteAll);mo.observe(document.documentElement,{childList:true,subtree:true});}catch(e){}' +
      'setInterval(muteAll,1000);' +
    '})();';

  var IMG_HELPER =
    'function isValidImgUrl(u){' +
      'if(!u||u.length<20)return false;' +
      'if(u.indexOf("data:")===0||u.indexOf("blob:")===0)return false;' +
      'if(u.indexOf("pickasso.spotifycdn.com")!==-1&&u.split("/").length<10)return false;' +
      'return true;' +
    '}' +
    'function bestImg(el){' +
      'var imgs=el.querySelectorAll("img");' +
      'for(var k=0;k<imgs.length;k++){' +
        'var s=imgs[k].currentSrc||imgs[k].src||"";' +
        'if(isValidImgUrl(s))return s;' +
        'var ss=imgs[k].getAttribute("srcset");' +
        'if(ss){var parts=ss.split(",");for(var p=parts.length-1;p>=0;p--){' +
          'var u=parts[p].trim().split(/\\s+/)[0];if(isValidImgUrl(u))return u;' +
        '}}' +
        'var ds=imgs[k].getAttribute("data-src");' +
        'if(isValidImgUrl(ds))return ds;' +
      '}' +
      'var bgs=el.querySelectorAll("[style]");' +
      'for(var b=0;b<bgs.length;b++){' +
        'var bg=bgs[b].style.backgroundImage||"";' +
        'var bm=bg.match(/url\\([\\"\\\']*([^\\"\\\'\\)]+)/);' +
        'if(bm&&isValidImgUrl(bm[1]))return bm[1];' +
      '}' +
      'return null;' +
    '}';

  var SCRIPT_CHECK_LOGIN = '(function(){' +
    'console.log("[viboplr-login] script start");' +
    'try{' +
    'function qs(sel){try{return document.querySelector(sel)}catch(e){console.log("[viboplr-login] bad selector: "+sel+" err: "+e);return null}}' +
    'function qsa(sel){try{return document.querySelectorAll(sel)}catch(e){console.log("[viboplr-login] bad selector: "+sel+" err: "+e);return[]}}' +
    'var signals={};' +
    'var sessionEl=qs("script#session,script[data-testid=\\"session\\"]");' +
    'signals.sessionTag=false;' +
    'if(sessionEl){try{var sj=JSON.parse(sessionEl.textContent||"{}");signals.sessionTag=!!sj.accessToken}catch(e){}}' +
    'signals.userWidget=!!qs("[data-testid=\\"user-widget-link\\"]");' +
    'signals.userBox=!!qs(".main-userWidget-box");' +
    'signals.avatar=!!qs("img[alt*=\\"avatar\\"], img[alt*=\\"profile\\"]");' +
    'signals.accountLink=!!qs("a[href*=\\"/account\\"], button[data-testid=\\"user-widget-link\\"]");' +
    'signals.libraryBtn=!!qs("[data-testid=\\"your-library-button\\"], [aria-label=\\"Your Library\\"], [aria-label*=\\"library\\"]");' +
    'signals.createPlaylist=!!qs("[aria-label*=\\"Create\\"]");' +
    'signals.globalNav=!!qs("[data-testid=\\"global-nav-bar\\"], #global-nav-bar");' +
    'signals.leftSidebar=!!qs("[data-testid=\\"Desktop_LeftSidebar_Id\\"]");' +
    'signals.nowPlayingBar=!!qs("[data-testid=\\"now-playing-bar\\"], .Root__now-playing-bar");' +
    'signals.mainNav=!!qs("nav[aria-label=\\"Main\\"]");' +
    'signals.loginBtn=!!qs("[data-testid=\\"login-button\\"]");' +
    'signals.signupBtn=!!qs("[data-testid=\\"signup-button\\"], a[href*=\\"signup\\"]");' +
    'signals.signupBar=!!qs("[data-testid=\\"signup-bar\\"]");' +
    'signals.loginLink=!!qs("a[href*=\\"/login\\"]");' +
    'console.log("[viboplr-login] signals:",JSON.stringify(signals));' +
    'var pos=signals.sessionTag||signals.userWidget||signals.userBox||signals.avatar||signals.accountLink||signals.libraryBtn||signals.createPlaylist||signals.globalNav||signals.leftSidebar||signals.nowPlayingBar||signals.mainNav;' +
    'var neg=signals.loginBtn||signals.signupBtn||signals.signupBar||signals.loginLink;' +
    'var ok=pos&&!neg;' +
    'var pageDump=null;' +
    'if(!pos&&!neg){' +
      'var btns=qsa("button");' +
      'var btnTexts=[];for(var b=0;b<Math.min(btns.length,20);b++){btnTexts.push((btns[b].textContent||"").trim().substring(0,40)+"["+(btns[b].getAttribute("data-testid")||btns[b].getAttribute("aria-label")||"")+"]")}' +
      'var navs=qsa("nav a, nav button");' +
      'var navTexts=[];for(var n=0;n<Math.min(navs.length,20);n++){navTexts.push((navs[n].textContent||"").trim().substring(0,40))}' +
      'var testids=qsa("[data-testid]");' +
      'var tidList=[];for(var t=0;t<Math.min(testids.length,40);t++){tidList.push(testids[t].getAttribute("data-testid"))}' +
      'pageDump={buttons:btnTexts,navItems:navTexts,testids:tidList,bodyClasses:document.body.className,title:document.title};' +
      'console.log("[viboplr-login] NO CLEAR SIGNAL page dump:",JSON.stringify(pageDump));' +
    '}' +
    'console.log("[viboplr-login] result: loggedIn="+ok+" pos="+pos+" neg="+neg);' +
    'window.__viboplr.send("login-check",{loggedIn:ok,signals:signals,url:location.href,pageDump:pageDump});' +
    '}catch(e){' +
      'console.error("[viboplr-login] CAUGHT ERROR:",e,""+e,e.stack);' +
      'try{window.__viboplr.send("login-check",{loggedIn:false,error:""+e})}catch(e2){console.error("[viboplr-login] send also failed:",e2)}' +
    '}})()';

  // Scrape all playlist cards on the music-chip home page, grouped by shelf.
  // Strategy: find the real (nested) scroll container, then incrementally scroll
  // it one viewport at a time, sweeping <main> in DOCUMENT ORDER at each stop and
  // ACCUMULATING (Spotify virtualizes the feed, so cards unmount off-screen). A
  // heading (h1/h2/h3 or role=heading, not inside a card) starts a new shelf; the
  // playlist cards that follow it — until the next heading — belong to that shelf.
  // Dedupe ids across the whole run (first wins). Sends a "shelves" msg:
  //   { shelves: [{ section, description, playlists: [{id,name,subtitle,imageUrl,kind}] }], total }
  // Build the home-shelf scraper. When includeAlbums is true, the generated
  // script also captures /album/ cards (kind:"album"); otherwise only
  // /playlist/ cards (kind:"playlist"). The playlists-only build uses the same
  // selectors/regex as the original scraper (records additionally carry a
  // kind:"playlist" field, consumed by the kind data model).
  function scriptScrapeShelves(includeAlbums) {
    // Selector + regex fragments widen to album links only when requested.
    var linkSel = includeAlbums
      ? 'a[href*=\\"/playlist/\\"],a[href*=\\"/album/\\"]'
      : 'a[href*=\\"/playlist/\\"]';
    // idRe is a normal string in index.js (NOT nested inside the page-script
    // literal), so single-escape the backslashes: the VALUE must be the regex
    // literal /\/(playlist|album)\/([a-zA-Z0-9]+)/.
    var idRe = includeAlbums ? '/\\/(playlist|album)\\/([a-zA-Z0-9]+)/' : '/\\/(playlist)\\/([a-zA-Z0-9]+)/';
    return '(function(){try{' +
    DBG_HELPER +
    IMG_HELPER +
    'function findImgContainer(el){var node=el;for(var up=0;up<6&&node;up++){var img=bestImg(node);if(img)return img;node=node.parentElement;}return null;}' +
    // Shelf description from a heading: scan the heading's parent/grandparent for
    // a descriptive line that isn't a card subtitle. Best-effort.
    'function descFromHeading(h,title){' +
      'var scope=h.parentElement?(h.parentElement.parentElement||h.parentElement):null;' +
      'if(!scope)return "";' +
      'var cands=scope.querySelectorAll("p,span");' +
      'for(var d=0;d<cands.length;d++){' +
        'var c=cands[d];' +
        'if(c.closest("a[href*=\\"/playlist/\\"]"))continue;' +
        'var t=(c.textContent||"").trim();' +
        'if(t&&t!==title&&t.length>10&&t.length<200)return t;' +
      '}' +
      'return "";' +
    '}' +
    // Card subtitle: walk up from the playlist link to the card container, then
    // take the first text that differs from the card name. Best-effort.
    'function cardSubtitle(la,nm){' +
      'var card=la;' +
      'for(var up=0;up<5&&card;up++){if(card.parentElement)card=card.parentElement;else break;}' +
      'if(!card)return "";' +
      'var cands=card.querySelectorAll("p,span");' +
      'for(var i=0;i<cands.length;i++){' +
        'var t=(cands[i].textContent||"").trim();' +
        'if(t&&t!==nm&&nm.indexOf(t)===-1&&t.indexOf(nm)===-1&&t.length<200)return t;' +
      '}' +
      'return "";' +
    '}' +
    'function isHeading(el){var t=el.tagName;return t==="H1"||t==="H2"||t==="H3"||el.getAttribute("role")==="heading";}' +
    // Report a failure exactly once (used by the setTimeout callbacks below, whose
    // throws would otherwise escape the outer try/catch and hang the scrape).
    'function _fail(e){try{window.__viboplr.send("error",{message:"scrape shelves: "+e})}catch(_){}}' +
    // Find the element that actually scrolls. Spotify's app scrolls inside a
    // nested overflow container, NOT the document — scrolling document.body is a
    // no-op and the feed never lazy-loads. Walk up from <main> looking for an
    // ancestor with overflow-y auto/scroll and real overflow (mirrors the track
    // scraper's findScrollContainer).
    'function findScrollContainer(){' +
      'var mainEl=document.querySelector("main")||document.body;' +
      'var found=document.scrollingElement||document.documentElement;' +
      'var walker=mainEl;' +
      'while(walker&&walker!==document.body){' +
        'var cs=window.getComputedStyle(walker);' +
        'var ov=cs.overflowY;' +
        'if((ov==="auto"||ov==="scroll")&&walker.scrollHeight>walker.clientHeight){found=walker;break}' +
        'walker=walker.parentElement;' +
      '}' +
      'return found;' +
    '}' +
    // Accumulate across scroll stops: Spotify VIRTUALIZES the feed (unmounts
    // off-screen cards), so a single end-of-scroll collect misses most of them.
    // Sweep at each stop in document order — a heading (not inside a card) opens
    // a shelf; following playlist cards belong to it. Playlists are keyed by id
    // (shelf membership/order fixed by first-seen); each later sweep BACKFILLS a
    // still-missing cover/subtitle, because card images lazy-load a beat after
    // the card mounts (so the first sweep that sees a card often gets a null img).
    'var shelfByName={};var shelfOrder=[];var byId={};var total=0;' +
    'function sweep(){' +
      'var main=document.querySelector("main")||document.body;' +
      'var nodes=main.querySelectorAll("h1,h2,h3,[role=\\"heading\\"],' + linkSel + '");' +
      'var cur=null;' +
      'for(var i=0;i<nodes.length;i++){' +
        'var el=nodes[i];' +
        'if(isHeading(el)){' +
          'if(el.closest("' + linkSel + '"))continue;' +
          'var ht=(el.textContent||"").trim();' +
          'if(!ht)continue;' +
          'if(!shelfByName[ht]){shelfByName[ht]={section:ht,description:descFromHeading(el,ht),playlists:[]};shelfOrder.push(ht);}' +
          'cur=shelfByName[ht];' +
          'continue;' +
        '}' +
        'var m=(el.getAttribute("href")||"").match(' + idRe + ');' +
        'if(!m)continue;' +
        'var _kind=m[1]==="album"?"album":"playlist";var _id=m[2];' +
        // Skip seed/credit links embedded in a card SUBTITLE ("With Franz
        // Ferdinand, Wunderhorse and more" on a mix card). These are decorative
        // /playlist/ links living inside ANOTHER card\'s subtitle
        // ([data-encore-id="cardSubtitle"], id="card-subtitle-spotify:playlist:..."),
        // NOT browsable cards — they have no cover of their own (the cover belongs
        // to the parent mix card, captured separately) and previously produced
        // dozens of phantom, cover-less playlists. A real card TITLE link is never
        // inside a cardSubtitle.
        'if(el.closest("[data-encore-id=\\"cardSubtitle\\"],[id^=\\"card-subtitle\\"]"))continue;' +
        'var nm=(el.textContent||"").trim();' +
        'var img=findImgContainer(el);' +
        'var sub=cardSubtitle(el,nm);' +
        'var _key=_kind+":"+_id;' +
        'var existing=byId[_key];' +
        'if(existing){' +
          // Backfill fields that lazy-loaded after the first sighting.
          'if(!existing.imageUrl&&img)existing.imageUrl=img;' +
          'if(!existing.subtitle&&sub)existing.subtitle=sub;' +
          'if(!existing.name&&nm)existing.name=nm;' +
          'continue;' +
        '}' +
        'if(!nm)continue;' +
        'if(!cur){if(!shelfByName["Playlists"]){shelfByName["Playlists"]={section:"Playlists",description:"",playlists:[]};shelfOrder.push("Playlists");}cur=shelfByName["Playlists"];}' +
        'var rec={id:_id,name:nm,subtitle:sub,imageUrl:img,kind:_kind};' +
        'byId[_key]=rec;cur.playlists.push(rec);total++;' +
      '}' +
    '}' +
    'function countNoCover(){var n=0;for(var k in byId){if(byId.hasOwnProperty(k)&&!byId[k].imageUrl)n++;}return n;}' +
    'function emit(){' +
      'var out=[];var names=[];' +
      'for(var s=0;s<shelfOrder.length;s++){var sh=shelfByName[shelfOrder[s]];if(sh.playlists.length>0){out.push(sh);names.push(sh.section);}}' +
      '_dbg("shelves","DONE",{shelfCount:out.length,total:total,noCover:countNoCover(),sectionEls:document.querySelectorAll("section").length,headings:names});' +
      'window.__viboplr.send("shelves",{shelves:out,total:total});' +
    '}' +
    // Real (vertical) scroll container. CRITICAL: Spotify also lays each shelf out
    // as a HORIZONTAL CAROUSEL that virtualizes its cards — cards parked off the
    // right edge are never mounted, so their lazy <img> never enters a viewport,
    // never loads, and bestImg() returns null forever no matter how long we wait
    // vertically. So at each vertical stop we must scroll every visible carousel
    // fully left-to-right, sweeping (with a beat for lazy imgs) at each step.
    'var sc=findScrollContainer();' +
    'var vStep=Math.max(sc.clientHeight-50,200);' +
    'var ticks=0;var lastTop=-1;var stable=0;' +
    'sc.scrollTop=0;' +
    // Find each shelf's horizontal carousel: walk up from a playlist card to the
    // nearest ancestor that actually scrolls horizontally (overflow-x auto/scroll
    // with real overflow). De-duped. Recomputed each call because Spotify unmounts
    // shelves that scroll out of vertical view (and remounts them at scrollLeft 0).
    'function carousels(){' +
      'var mainEl=document.querySelector("main")||document.body;' +
      'var links=mainEl.querySelectorAll("' + linkSel + '");' +
      'var out=[];' +
      'for(var i=0;i<links.length;i++){' +
        'var node=links[i];' +
        'for(var up=0;up<10&&node&&node!==document.body;up++){' +
          'var cs=window.getComputedStyle(node);' +
          'var ox=cs.overflowX;' +
          'if((ox==="auto"||ox==="scroll")&&node.scrollWidth>node.clientWidth+4){if(out.indexOf(node)===-1)out.push(node);break;}' +
          'node=node.parentElement;' +
        '}' +
      '}' +
      'return out;' +
    '}' +
    // Advance every still-scrollable carousel one near-viewport step right (slight
    // overlap so a card gets >=2 sweeps). Returns how many moved (0 => all exhausted).
    'function advanceCarousels(){' +
      'var cs=carousels();var moved=0;' +
      'for(var i=0;i<cs.length;i++){var c=cs[i];' +
        'if(c.scrollLeft+c.clientWidth<c.scrollWidth-4){' +
          'c.scrollLeft=Math.min(c.scrollWidth,c.scrollLeft+Math.max(c.clientWidth-60,160));moved++;' +
        '}' +
      '}' +
      'return moved;' +
    '}' +
    // Exhaust all visible carousels horizontally at the current vertical stop,
    // sweeping at each step. Imgs from the previous step resolve during the delay
    // and are backfilled by the next sweep. hSteps is a global runaway cap.
    'var hSteps=0;' +
    'function hExhaust(done){' +
      'sweep();' +
      'if(hSteps>=140){done();return;}' +
      'var moved=advanceCarousels();' +
      'if(moved===0){done();return;}' +
      'hSteps++;' +
      'setTimeout(function(){try{hExhaust(done)}catch(e){_fail(e)}},250);' +
    '}' +
    // Final phase: OSCILLATE vertically (up, then back down, repeating) sweeping at
    // every stop until no card is missing a cover or the pass budget runs out. This
    // is the lazy-img backfill for cards near each carousel's start; horizontally-
    // distant cards were already captured during the descent.
    'var settleDir=-1;' +
    'function settlePass(passes){' +
      'sweep();' +
      'if(passes<=0||countNoCover()===0){emit();return;}' +
      'var atTop=sc.scrollTop<=0;' +
      'var atBot=sc.scrollTop+sc.clientHeight>=sc.scrollHeight-10;' +
      // Reverse at either edge so we keep re-traversing the whole feed.
      'if(atTop)settleDir=1;else if(atBot)settleDir=-1;' +
      'sc.scrollTop=Math.max(0,sc.scrollTop+settleDir*vStep);' +
      'setTimeout(function(){try{settlePass(passes-1)}catch(e){_fail(e)}},250);' +
    '}' +
    // Vertical descent: at each stop, fully sweep carousels horizontally, THEN
    // advance one viewport. Order matters — a carousel must be exhausted while its
    // shelf is mounted/visible, because Spotify virtualizes vertically too.
    'function descend(){try{' +
      'hExhaust(function(){' +
        'ticks++;' +
        'if(sc.scrollTop===lastTop){stable++;}else{stable=0;lastTop=sc.scrollTop;}' +
        'var atBottom=sc.scrollTop+sc.clientHeight>=sc.scrollHeight-10;' +
        'if(atBottom||stable>=3||ticks>=40){setTimeout(function(){try{settlePass(30)}catch(e){_fail(e)}},300);return;}' +
        'sc.scrollTop+=vStep;' +
        'setTimeout(descend,300);' +
      '});' +
    '}catch(e){_fail(e)}}' +
    'descend();' +
    '}catch(e){window.__viboplr.send("error",{message:"scrape shelves: "+e})}})()';
  }

  function scriptNavigatePlaylist(id, kind) {
    var path = kind === "album" ? "/album/" : "/playlist/";
    return '(function(){' +
      DBG_HELPER +
      '_dbg("tracks","navigating to ' + path + id + '");' +
      'window.location.href="' + path + id + '"' +
    '})()';
  }

  function scriptScrollThenScrape(playlistId, gen, opts) {
    var maxSteps = (opts && opts.maxSteps) || 60;
    var entityPath = (opts && opts.kind === "album") ? "/album/" : "/playlist/";
    return '(function(){try{' +
      DBG_HELPER +
      IMG_HELPER +
      'var _gen=' + gen + ';' +
      '_dbg("tracks","=== START scrape for ' + entityPath + playlistId + '",{url:location.href,gen:_gen});' +
      // Find the scroll container, retrying if the page hasn't rendered yet
      'var sc=null;var _waitAttempts=0;var _maxWait=16;' +
      'function findScrollContainer(){' +
        'var mainEl=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")' +
          '||document.querySelector("main")||document;' +
        'var found=document.scrollingElement;' +
        'var walker=mainEl;' +
        'while(walker&&walker!==document.body){' +
          'var cs=window.getComputedStyle(walker);' +
          'var ov=cs.overflowY;' +
          'if((ov==="auto"||ov==="scroll")&&walker.scrollHeight>walker.clientHeight){found=walker;break}' +
          'walker=walker.parentElement;' +
        '}' +
        'return found;' +
      '}' +
      'function waitForContent(){' +
        '_waitAttempts++;' +
        'sc=findScrollContainer();' +
        'var hasRows=!!document.querySelector("[role=\\"row\\"]");' +
        'var contentReady=(sc.tagName!=="HTML"&&sc.scrollHeight>sc.clientHeight)||hasRows;' +
        'if(!contentReady&&_waitAttempts<_maxWait){' +
          'setTimeout(waitForContent,500);return;' +
        '}' +
        'if(!contentReady){' +
          '_dbg("tracks","content not ready after wait, proceeding with fallback",{attempts:_waitAttempts,tag:sc.tagName,hasRows:hasRows,url:location.href,hasLogin:!!document.querySelector("[data-testid=\\"login-button\\"]")});' +
        '}' +
        '_dbg("tracks","scroll container",{tag:sc.tagName,testid:sc.getAttribute&&sc.getAttribute("data-testid"),scrollH:sc.scrollHeight,clientH:sc.clientHeight,overflow:window.getComputedStyle(sc).overflowY,waitAttempts:_waitAttempts});' +
        'beginScrape();' +
      '}' +
      'function beginScrape(){' +
      // Extract playlist cover. Prefer og:image (server-rendered, canonical for the URL)
      // because in-page <img> selectors can drift to track-row art for algorithmic
      // playlists like Discover Weekly / Release Radar.
      'var _coverUrl=null;var _coverRule=null;var _coverElement=null;' +
      'var _coverRuleAttempts=[];' +
      'function _markRule(rule,ok,detail){_coverRuleAttempts.push({rule:rule,ok:!!ok,detail:detail||null})}' +
      'var ogEl=document.querySelector("meta[property=\\"og:image\\"]");' +
      'if(ogEl){var ogVal=ogEl.getAttribute("content")||"";if(isValidImgUrl(ogVal)){_coverUrl=ogVal;_coverRule="og:image";_coverElement="meta[property=og:image]";_markRule("og:image",true,ogVal.substring(0,120))}else{_markRule("og:image",false,"invalid url: "+ogVal.substring(0,80))}}else{_markRule("og:image",false,"meta tag missing")}' +
      'if(!_coverUrl){' +
        'var coverElSel=null;var coverEl=null;' +
        'var sels=["[data-testid=\\"playlist-image\\"]","[data-testid=\\"entity-image\\"] img","main header img[draggable=\\"false\\"]","main picture img"];' +
        'for(var ci=0;ci<sels.length;ci++){var ce=document.querySelector(sels[ci]);if(ce){coverEl=ce;coverElSel=sels[ci];break}}' +
        'if(coverEl){var cu=coverEl.currentSrc||coverEl.src||null;if(cu&&cu.indexOf("data:")===0)cu=null;if(cu){_coverUrl=cu;_coverRule="dom-selector";_coverElement=coverElSel;_markRule("dom-selector",true,coverElSel)}else{_markRule("dom-selector",false,"matched "+coverElSel+" but no usable src")}}else{_markRule("dom-selector",false,"no selector matched")}' +
      '}' +
      // Last-resort scope: header only. Never `main section` — that wrapper contains
      // the tracklist, so bestImg() returns the first track row's album art.
      'if(!_coverUrl){' +
        'var headerEl=document.querySelector("[data-testid=\\"playlist-page\\"] header")||document.querySelector("main header");' +
        'if(headerEl){var hu=bestImg(headerEl);if(hu){_coverUrl=hu;_coverRule="header-bestImg";_coverElement="header";_markRule("header-bestImg",true,"header found")}else{_markRule("header-bestImg",false,"header had no usable img")}}else{_markRule("header-bestImg",false,"no header element")}' +
      '}' +
      'if(!_coverUrl){_dbg("tracks","cover NOT FOUND",_coverRuleAttempts)}' +
      // Incremental scroll: move one viewport at a time, scrape visible rows at each stop
      'var allOut=[];var seenKeys={};var n=0;var maxSteps=' + maxSteps + ';' +
      'var step=Math.max(sc.clientHeight-50,200);' +
      'sc.scrollTop=0;' +
      'function parseVisibleRows(){' +
        'var scope=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")||document.querySelector("main")||document;' +
        'var rows=scope.querySelectorAll("[role=\\"row\\"]");' +
        'var added=0;' +
        'for(var i=0;i<rows.length;i++){var r=rows[i];' +
          'var ne=r.querySelector("[data-testid=\\"internal-track-link\\"] div")' +
            '||r.querySelector("a[href*=\\"/track/\\"]")' +
            '||r.querySelector("[data-testid=\\"tracklist-row\\"] a");' +
          'if(!ne){var cells=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells.length>=2){ne=cells[1].querySelector("a")||cells[1].querySelector("div>div>span")||cells[1].querySelector("span")}}' +
          'var nm=ne?ne.textContent.trim():"";' +
          'if(!nm)continue;' +
          'var trkLink=r.querySelector("a[href*=\\"/track/\\"]");' +
          'var spId=trkLink?trkLink.getAttribute("href").split("/track/")[1].split("?")[0]:null;' +
          'var key=spId||nm;' +
          'if(seenKeys[key])continue;seenKeys[key]=1;' +
          'var aLinks=r.querySelectorAll("a[href*=\\"/artist/\\"]");' +
          'var arts=[];for(var j=0;j<aLinks.length;j++){var at=aLinks[j].textContent.trim();if(at&&arts.indexOf(at)===-1)arts.push(at)}' +
          'if(!arts.length){var cells2=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells2.length>=2){var spans=cells2[1].querySelectorAll("span");' +
              'for(var s=0;s<spans.length;s++){var st=spans[s].textContent.trim();' +
                'if(st&&st!==nm&&st.indexOf(nm)===-1&&nm.indexOf(st)===-1){arts.push(st);break}}}}' +
          'var alEl=r.querySelector("a[href*=\\"/album/\\"]");' +
          'var al=alEl?alEl.textContent.trim():"";' +
          'var du=r.querySelector("[data-testid=\\"tracklist-duration\\"]");' +
          'if(!du){var cells3=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells3.length>0){du=cells3[cells3.length-1]}}' +
          'var dur="";if(du){var dt=du.textContent.trim();if(/^\\d+:\\d{2}$/.test(dt))dur=dt}' +
          'var imgUrl=bestImg(r);' +
          'allOut.push({name:nm,artist:arts.join(", "),album:al,duration:dur,imageUrl:imgUrl,spotifyId:spId});' +
          'added++;' +
        '}' +
        'return added;' +
      '}' +
      'function tick(){try{' +
        'parseVisibleRows();n++;' +
        'var atBottom=sc.scrollTop+sc.clientHeight>=sc.scrollHeight-10;' +
        'if(n%5===0)_dbg("tracks","scrolling",{tick:n,found:allOut.length,scrollTop:sc.scrollTop,scrollH:sc.scrollHeight,atBottom:atBottom});' +
        // Emit a running track count so the UI can show progress without waiting
        // for the full scrape (large playlists like Liked Songs can take minutes).
        'try{window.__viboplr.send("tracks-progress",{playlistId:"' + playlistId + '",found:allOut.length,tracks:allOut,gen:_gen})}catch(e){}' +
        'if(atBottom||n>=maxSteps){' +
          'parseVisibleRows();' +
          'var descEl=document.querySelector("[data-testid=\\"playlist-description\\"]")||document.querySelector("main [data-testid=\\"entityTitle\\"] ~ span");' +
          'var desc=descEl?descEl.textContent.trim():"";' +
          'if(allOut.length===0){' +
            'var diag={rows:document.querySelectorAll("[role=\\"row\\"]").length,' +
              'trackLinks:document.querySelectorAll("a[href*=\\"/track/\\"]").length,' +
              'tracklist:!!document.querySelector("[data-testid=\\"playlist-tracklist\\"]"),' +
              'url:location.href,title:document.title,' +
              'mainText:(document.querySelector("main")?document.querySelector("main").textContent:"").substring(0,200)};' +
            '_dbg("tracks","=== EMPTY ' + playlistId + ' - page diagnostics",diag);' +
          '}' +
          '_dbg("tracks","=== DONE ' + playlistId + '",{parsed:allOut.length,steps:n,gen:_gen,desc:desc.substring(0,80),coverUrl:_coverUrl,coverRule:_coverRule,coverElement:_coverElement});' +
          'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:allOut,description:desc,coverUrl:_coverUrl,coverRule:_coverRule,coverElement:_coverElement,coverRuleAttempts:_coverRuleAttempts,gen:_gen});' +
        '}else{sc.scrollTop+=step;setTimeout(tick,600)}' +
      '}catch(e){' +
        '_dbg("tracks","=== ERROR in tick ' + playlistId + '",{error:""+e,step:n});' +
        'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:allOut,error:""+e,gen:_gen});' +
      '}}' +
      'setTimeout(tick,500);' +
      '}' +
      'waitForContent();' +
    '}catch(e){' +
      'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:[],error:"script error: "+e,gen:' + gen + '});' +
    '}})()';
  }

  // ---- Shared browse-window + login helper ----

  // Open a Spotify browse window, wait until logged in (surfacing a sign-in
  // banner after a short grace period, exactly like the old performScrape), then
  // run fn(handle, ctx) and resolve with its result. The window is always closed
  // when fn settles, on cancel (generation bump), or if the user closes it.
  //
  //   url:     page to load (defaults to the music-chip home).
  //   visible: open the window visibly (else headless).
  //   fn:      function(handle, ctx) -> Promise. ctx exposes { gen } and
  //            registers a single message handler via ctx.setHandler(fn).
  //
  // Resolves null if the scrape was cancelled or the window closed before login.
  var MUSIC_CHIP_URL = "https://open.spotify.com/home?facet=music-chip";
  // <<< SCRAPE-SCRIPTS-END

  function withSpotifyWindow(opts, fn) {
    var url = (opts && opts.url) || MUSIC_CHIP_URL;
    var visible = !!(opts && opts.visible);

    // Reject a concurrent open instead of clobbering the in-flight one. The
    // single global scrapeGeneration / activeScrapeHandle can only track one
    // window safely.
    if (windowBusy) {
      return Promise.reject(new Error("Spotify is busy — try again in a moment"));
    }
    windowBusy = true;

    return new Promise(function (resolve, reject) {
      var handle = null;
      var gen = ++scrapeGeneration;
      var loginTimer = null;
      var settled = false;
      var currentHandler = null;

      function cleanup() {
        if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
        if (handle) { handle.close().catch(console.error); handle = null; }
        activeScrapeHandle = null;
        // Release the single-window gate so the next action can open one.
        windowBusy = false;
      }
      function finish(val) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      }
      function failWith(err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }

      var ctx = {
        gen: gen,
        setHandler: function (h) { currentHandler = h; },
        isStale: function () { return gen !== scrapeGeneration; },
      };

      api.network.openBrowseWindow(url, {
        title: "Spotify",
        // Wider viewport so each shelf's horizontal carousel shows more cards per
        // step — fewer scroll steps to exhaust it, and fewer lazy <img>s racing the
        // sweep (the carousel scroll in SCRIPT_SCRAPE_SHELVES does the real work).
        width: 1600,
        height: 900,
        visible: visible,
      }).then(function (h) {
        handle = h;
        activeScrapeHandle = h;
        recordPageVisit(url, "open");
        h.eval(SCRIPT_MUTE_AUDIO).catch(function () {});
        if (h.onNavigation) {
          h.onNavigation(function (u) {
            recordPageVisit(u, "navigate");
            // Navigations reload the document and wipe injected scripts, so the
            // page can autoplay audio again — re-mute after each navigation.
            h.eval(SCRIPT_MUTE_AUDIO).catch(function () {});
          });
        }

        var loginRetries = 0;
        var LOGIN_GRACE_POLLS = 2;
        var loginPromptShown = false;

        function promptForLogin() {
          if (loginPromptShown) return;
          loginPromptShown = true;
          plog("warn", "login", "Not logged in to Spotify — surfacing window for sign-in");
          h.eval(SCRIPT_LOGIN_BANNER);
          h.show().catch(function (e) { console.error("Failed to show Spotify window:", e); });
          api.ui.showNotification("Please log in to Spotify in the window that just opened, then it will continue.");
        }

        h.onMessage(function (msg) {
          if (msg.type === "window-closed") { finish(null); return; }
          if (msg.type === "dbg" && msg.data) {
            plog(msg.data.level || "info", "browser:" + (msg.data.tag || "?"), msg.data.msg || "", msg.data.data);
            return;
          }
          if (msg.type === "login-check" && msg.data && msg.data.loggedIn && loginTimer) {
            clearInterval(loginTimer); loginTimer = null;
            if (loginPromptShown) {
              h.eval(SCRIPT_REMOVE_LOGIN_BANNER);
              if (!visible) h.hide().catch(function (e) { console.error("Failed to re-hide Spotify window:", e); });
            }
            // Hand control to fn. Route subsequent messages to its handler.
            Promise.resolve()
              .then(function () { return fn(h, ctx); })
              .then(function (val) { finish(val); })
              .catch(function (e) { failWith(e); });
            return;
          }
          if (currentHandler) currentHandler(msg);
        });

        function checkLogin() {
          if (ctx.isStale() || !handle) {
            if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
            return;
          }
          loginRetries++;
          if (loginRetries > LOGIN_GRACE_POLLS) promptForLogin();
          h.eval(SCRIPT_CHECK_LOGIN);
        }
        loginTimer = setInterval(checkLogin, 3000);
        setTimeout(checkLogin, 1500);
      }).catch(failWith);
    });
  }

  // New single-page sync: scrape the music-chip home page once, grouping
  // playlists by shelf. Resolves { playlists, sections, sectionDescriptions }
  // (no tracks — those are fetched lazily). Resolves null if cancelled / not
  // signed in.
  function syncPlaylists(visible, trigger) {
    beginReport(trigger || "sync");
    return withSpotifyWindow({ url: MUSIC_CHIP_URL, visible: visible }, function (h, ctx) {
      return new Promise(function (resolve) {
        // Give the SPA a moment to render the home shell before scraping.
        var done = false;
        // Backstop: if the page never sends shelves/error (stalled navigation or
        // an eval that silently failed to run), don't hang forever — resolve
        // empty after a generous timeout. The scroll+scrape itself can run long
        // now that each shelf's carousel is exhausted horizontally: the global
        // horizontal cap (~140 steps x 250ms = 35s) plus the vertical descent
        // (~40 x 300ms) plus the settle oscillation (~30 x 250ms) plus the 1s+4s
        // nav delays put the realistic worst case near ~75s, so allow margin.
        var scrapeTimeout = setTimeout(function () {
          if (done) return;
          plog("warn", "shelves", "music-chip scrape timed out — resolving empty");
          finishScrape([], [], {});
        }, 120000);
        function finishScrape(playlists, sections, sectionDescriptions) {
          if (done) return;
          done = true;
          clearTimeout(scrapeTimeout);
          resolve({ playlists: playlists, sections: sections, sectionDescriptions: sectionDescriptions || {} });
        }

        ctx.setHandler(function (msg) {
          if (msg.type === "error" && msg.data) {
            plog("warn", "shelves", "scrape error: " + msg.data.message);
            finishScrape([], [], {});
            return;
          }
          if (msg.type === "shelves" && msg.data && Array.isArray(msg.data.shelves)) {
            var shelves = msg.data.shelves;
            var playlists = [];
            var sections = [];
            var sectionDescriptions = {};
            var seen = {};
            for (var si = 0; si < shelves.length; si++) {
              var sec = shelves[si];
              var name = sec.section || ("Section " + (si + 1));
              if (sections.indexOf(name) === -1) {
                sections.push(name);
                if (sec.description) sectionDescriptions[name] = sec.description;
              }
              for (var pi = 0; pi < sec.playlists.length; pi++) {
                var raw = sec.playlists[pi];
                if (seen[raw.id]) continue;
                seen[raw.id] = true;
                var np = {
                  id: raw.id,
                  name: raw.name,
                  section: name,
                  description: "",
                  cardSubtitle: raw.subtitle || "",
                  imageUrl: raw.imageUrl || null,
                  coverVersion: null,
                  kind: raw.kind === "album" ? "album" : "playlist",
                  lastSyncedAt: new Date().toISOString(),
                  tracksFetchedAt: null,
                };
                np.uri = entitySource(np);
                playlists.push(np);
              }
            }
            dbg("flow", "music-chip scrape: " + playlists.length + " playlists across " + sections.length + " shelves");
            finishScrape(playlists, sections, sectionDescriptions);
          }
        });

        // Navigate to the music-chip page (the window opened there already, but
        // re-assert in case login redirected away), then scrape after render.
        setTimeout(function () {
          if (ctx.isStale()) { finishScrape([], [], {}); return; }
          h.eval('window.location.href=' + JSON.stringify(MUSIC_CHIP_URL));
          setTimeout(function () {
            if (ctx.isStale()) { finishScrape([], [], {}); return; }
            h.eval(scriptScrapeShelves(state.includeAlbums));
          }, 4000);
        }, 1000);
      });
    }).then(function (res) {
      finishReport(res ? "ok" : "cancelled");
      return res;
    }).catch(function (err) {
      finishReport("error", err && err.message ? err.message : String(err));
      throw err;
    });
  }

  // Fetch & cache tracks for a single playlist on demand. Resolves the track
  // array. Uses the on-disk cache when fresh (within TRACKS_TTL_MS). On a fresh
  // scrape, keeps old tracks if the new scrape comes back empty (transient parse
  // guard), stamps tracksFetchedAt, persists, and caches images.
  //   force: bypass the freshness check and always re-scrape.
  function ensureTracks(pl, opts) {
    var force = !!(opts && opts.force);
    if (!force && tracksAreFresh(pl)) {
      return Promise.resolve(state.playlistTracks[pl.id] || []);
    }
    var visible = !!(opts && opts.visible);
    var oldTracks = state.playlistTracks[pl.id] || [];

    return withSpotifyWindow({ url: MUSIC_CHIP_URL, visible: visible }, function (h, ctx) {
      return new Promise(function (resolve) {
        var gen = ctx.gen;
        var settled = false;
        var trackTimeout = null;
        var attempts = 0;
        var maxSteps = 60;
        var timeoutMs = 45000;

        function settle(tracks, descr, coverUrl) {
          if (settled) return;
          settled = true;
          if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
          var finalTracks = tracks;
          // Keep-old guard: don't let an empty scrape clobber tracks we had.
          // We deliberately do NOT stamp tracksFetchedAt here, so the cache stays
          // stale and the next View/Play retries soon (a failed scrape shouldn't
          // extend the 24h TTL).
          if ((!finalTracks || finalTracks.length === 0) && oldTracks.length > 0) {
            finalTracks = oldTracks;
          } else if (finalTracks && finalTracks.length > 0) {
            // Only a non-empty scrape refreshes metadata + the TTL stamp.
            if (descr) pl.description = descr;
            if (coverUrl) pl.imageUrl = coverUrl;
            pl.tracksFetchedAt = new Date().toISOString();
            pl.lastSyncedAt = pl.tracksFetchedAt;
          }
          // Album pages omit the per-row album column; backfill it from the
          // album's own title before persisting (no-op for playlists).
          fillAlbumName(pl, finalTracks);
          state.playlistTracks[pl.id] = finalTracks;
          savePlaylist(pl).then(function () { cacheAllImages(); }).catch(console.error);
          resolve(finalTracks);
        }

        function arm() {
          trackTimeout = setTimeout(function () {
            if (ctx.isStale()) { settle(oldTracks); return; }
            plog("warn", "tracks", "Timeout scraping \"" + pl.name + "\" (" + pl.id + ")");
            retryOrFinish();
          }, timeoutMs);
        }
        function retryOrFinish() {
          if (settled) return;
          if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
          if (attempts < 2) {
            attempts++;
            h.eval(scriptNavigatePlaylist(pl.id, pl.kind));
            setTimeout(function () {
              if (ctx.isStale()) { settle(oldTracks); return; }
              h.eval(scriptScrollThenScrape(pl.id, gen, { maxSteps: maxSteps, kind: pl.kind }));
              arm();
            }, 4000);
            return;
          }
          settle(oldTracks);
        }

        ctx.setHandler(function (msg) {
          // Progressive update: while scraping, the page posts partial track
          // arrays each scroll tick. Show them live WITHOUT persisting or
          // stamping the cache — only settle() (the terminal "tracks" message)
          // writes to disk / sets tracksFetchedAt, so an interrupted load never
          // leaves partial data cached or treated as fresh.
          if (msg.type === "tracks-progress" && msg.data && msg.data.playlistId === pl.id) {
            // Ignore once settled: a late progress message (still in flight as the
            // window closes) must not clobber the final settled tracks/metadata.
            if (settled) return;
            if (msg.data.gen !== gen) return;
            if (!Array.isArray(msg.data.tracks)) return;
            state.playlistTracks[pl.id] = fillAlbumName(pl, msg.data.tracks);
            if (state.currentPlaylist && state.currentPlaylist.id === pl.id) renderPlaylist();
            return;
          }
          if (msg.type === "tracks" && msg.data && msg.data.playlistId === pl.id) {
            var tracks = msg.data.tracks || [];
            if (msg.data.error) { plog("warn", "tracks", "Scrape error: " + msg.data.error); retryOrFinish(); return; }
            if (tracks.length === 0) { retryOrFinish(); return; }
            settle(tracks, msg.data.description, msg.data.coverUrl);
          }
        });

        attempts = 1;
        h.eval(scriptNavigatePlaylist(pl.id, pl.kind));
        setTimeout(function () {
          if (ctx.isStale()) { settle(oldTracks); return; }
          h.eval(scriptScrollThenScrape(pl.id, gen, { maxSteps: maxSteps, kind: pl.kind }));
          arm();
        }, 4000);
      });
    });
  }

  // ---- Refresh ----

  // Merge a syncPlaylists result into state: derive sections from the scrape,
  // replace the playlist list, and delete on-disk dirs for playlists that
  // dropped out. Track caches survive for playlists that are still present
  // (keyed by id); dropped playlists' dirs are removed.
  // Returns true if the result was applied, false if it was rejected as an
  // empty scrape that would have wiped an existing library.
  function applySyncResult(result) {
    var newPlaylists = result.playlists || [];
    // Guard: a scrape that came back empty (timeout / parse error / not really
    // signed in) must NOT wipe a library we already have. Only apply an empty
    // result when we had nothing to begin with (genuine first-run empty state).
    if (newPlaylists.length === 0 && state.playlists.length > 0) {
      plog("warn", "sync", "Scrape returned 0 playlists — keeping existing library");
      return false;
    }
    var oldById = {};
    for (var oi = 0; oi < state.playlists.length; oi++) {
      oldById[state.playlists[oi].id] = state.playlists[oi];
    }
    // Carry over cached tracks + tracksFetchedAt for surviving playlists so a
    // list refresh doesn't invalidate already-fetched tracks.
    var newKeyed = {};
    for (var i = 0; i < newPlaylists.length; i++) {
      var np = newPlaylists[i];
      var old = oldById[np.id];
      if (old) {
        np.tracksFetchedAt = old.tracksFetchedAt || null;
        if (!np.kind && old.kind) np.kind = old.kind;
        if (!np.imageUrl && old.imageUrl) np.imageUrl = old.imageUrl;
        if (!np.cardSubtitle && old.cardSubtitle) np.cardSubtitle = old.cardSubtitle;
      }
      newKeyed[playlistDir(np).join("/")] = true;
    }
    // Remove dirs for playlists/sections that no longer appear.
    for (var op = 0; op < state.playlists.length; op++) {
      var oldKey = playlistDir(state.playlists[op]).join("/");
      if (!newKeyed[oldKey]) deletePlaylistFiles(state.playlists[op]);
    }
    // Keep tracks for survivors; drop tracks for removed playlists.
    var survivingTracks = {};
    for (var k = 0; k < newPlaylists.length; k++) {
      var pid = newPlaylists[k].id;
      if (state.playlistTracks[pid]) survivingTracks[pid] = state.playlistTracks[pid];
    }
    state.playlists = newPlaylists;
    state.playlistTracks = survivingTracks;
    state.sections = result.sections;
    state.sectionDescriptions = result.sectionDescriptions || {};
    // Persist the derived section list + descriptions as a cold-start render
    // cache (so headings/order show before the first sync of a new session).
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    api.storage.set("spotify_browse_section_descriptions", state.sectionDescriptions).catch(console.error);
    saveState();
    return true;
  }

  function silentRefresh() {
    if (state.refreshing) return;
    state.refreshing = true;

    syncPlaylists(false, "auto-refresh").then(function (result) {
      state.refreshing = false;
      if (!result) {
        recordCheckResult(0, 1);
        api.ui.setBadge("spotify", { type: "dot", variant: "error" });
        return;
      }
      var applied = applySyncResult(result);
      recordCheckResult(applied ? result.playlists.length : state.playlists.length, applied ? 0 : 1);
      if (applied) cacheAllImages();
      api.scheduler.complete("auto-refresh").catch(console.error);
      state.status = "done";
      render();
    }).catch(function (err) {
      state.refreshing = false;
      recordCheckResult(0, 1);
      console.error("Silent refresh failed:", err);
      api.ui.setBadge("spotify", { type: "dot", variant: "error" });
    });
  }

  // ---- Actions ----

  api.ui.onAction("sync", function() {
    state.status = "waiting-login";
    state.errorMessage = "";
    state.refreshSummary = "";
    state.refreshing = true;
    dbg("flow", "starting single-page sync");
    render();

    syncPlaylists(state.showBrowserOnRefresh, "sync").then(function(result) {
      state.refreshing = false;
      if (!result) {
        state.status = "error";
        state.errorMessage = "Spotify sign-in was not completed. Click 'Sync' to try again.";
        render();
        return;
      }
      var applied = applySyncResult(result);
      if (applied) {
        state.refreshSummary = "Synced " + result.playlists.length + " playlist" +
          (result.playlists.length === 1 ? "" : "s") + " across " + result.sections.length + " shelves";
        recordCheckResult(result.playlists.length, 0);
        cacheAllImages();
      } else {
        state.refreshSummary = "Sync found no playlists — kept existing library";
        recordCheckResult(state.playlists.length, 1);
      }
      state.status = "done";
      render();
    }).catch(function(err) {
      state.refreshing = false;
      state.status = "error";
      state.errorMessage = "Sync failed: " + (err.message || err);
      recordCheckResult(0, 1);
      render();
    });
  });

  api.ui.onAction("cancel", function() {
    scrapeGeneration++;
    if (activeScrapeHandle) {
      activeScrapeHandle.close().catch(console.error);
      activeScrapeHandle = null;
    }
    windowBusy = false;
    state.status = "idle";
    state.refreshing = false;
    render();
  });

  api.ui.onAction("go-home", function() {
    state.currentPlaylist = null;
    state.currentView = "home";
    // Drop any in-flight loading flag so a later detail view doesn't show a
    // spurious "Loading…" from a fetch we navigated away from.
    state.loadingTracksFor = null;
    render();
  });

  // Look up a scraped playlist object by its Spotify id (null if not present).
  function findPlaylistById(pid) {
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) return state.playlists[i];
    }
    return null;
  }

  // Parse a "playlist:<id>" itemId from an action payload into the bare Spotify
  // id (null if absent or not a playlist item). Shared by the card actions.
  function parsePlaylistId(data) {
    if (!data || !data.itemId) return null;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist") return null;
    return parts.slice(1).join(":");
  }

  // Open a playlist's detail view by id. Auto-fetches tracks (lazy) if they're
  // not cached/fresh. Returns true if the playlist was found.
  function openPlaylistById(pid) {
    var pl = findPlaylistById(pid);
    if (!pl) return false;
    state.currentPlaylist = pl;
    state.currentView = "playlist";
    if (!tracksAreFresh(pl)) {
      state.loadingTracksFor = pl.id;
      renderPlaylist();
      ensureTracks(pl).then(function () {
        if (state.currentPlaylist && state.currentPlaylist.id === pl.id) {
          state.loadingTracksFor = null;
          renderPlaylist();
          render();
        }
      }).catch(function (e) {
        console.error("ensureTracks failed:", e);
        if (state.currentPlaylist && state.currentPlaylist.id === pl.id) {
          state.loadingTracksFor = null;
          renderPlaylist();
        }
      });
    } else {
      state.loadingTracksFor = null;
      renderPlaylist();
    }
    return true;
  }

  api.ui.onAction("view-playlist", function(data) {
    var pid = parsePlaylistId(data);
    if (pid) openPlaylistById(pid);
  });

  api.ui.onAction("play-track", function(data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "track") return;
    var index = parseInt(parts[1], 10);
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (index < 0 || index >= tracks.length) return;
    // Single-track click: load only that track into the queue rather than the
    // whole playlist. Use the "Play All" / header play button to load everything.
    api.playback.playTracks(toPluginTracks([tracks[index]]), 0);
  });

  api.ui.onAction("playlist-search", function(data) {
    var pl = state.currentPlaylist;
    if (!pl) return;
    // search-input sends { query }, text-input sends { value } — accept both.
    var value = "";
    if (data) {
      if (typeof data.query === "string") value = data.query;
      else if (typeof data.value === "string") value = data.value;
    }
    state.playlistSearch[pl.id] = value;
    renderPlaylist();
  });

  // Fetch a playlist's tracks for a Play/Enqueue action, showing the host
  // loading modal while a real scrape runs. Shows the modal only when the
  // playlist isn't already cached/fresh (so cached playlists play instantly with
  // no flash) AND no modal is already active (so a second concurrent Play — which
  // withSpotifyWindow rejects — doesn't stomp the first's modal). Hides only the
  // modal it itself showed, on every settle path (success, empty, OR error), so
  // the blocking modal can never stick. Returns the tracks promise.
  function fetchTracksWithLoading(pl) {
    var showed = false;
    if (!tracksAreFresh(pl) && !loadingModalActive) {
      loadingModalActive = true;
      showed = true;
      api.requestAction("show-loading", { message: "Loading " + pl.name + "…" });
    }
    function done() {
      if (showed) { loadingModalActive = false; api.requestAction("hide-loading", {}); }
    }
    return ensureTracks(pl).then(function (tracks) {
      done();
      return tracks;
    }, function (e) {
      done();
      throw e;
    });
  }

  api.ui.onAction("play-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    fetchTracksWithLoading(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) return;
      api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));
    }).catch(function (e) { console.error(e); });
  });

  api.ui.onAction("enqueue-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    fetchTracksWithLoading(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) return;
      api.playback.insertTracks(toPluginTracks(tracks), -1);
    }).catch(function (e) { console.error(e); });
  });

  // ---- Context menu actions for playlist cards ----

  function findPlaylistFromData(data) {
    var pid = parsePlaylistId(data);
    return pid ? findPlaylistById(pid) : null;
  }

  function playlistContextPayload(pl) {
    var meta = {};
    if (pl.section) meta.Section = pl.section;
    if (pl.description) meta.Description = pl.description;
    var title = pl.name;
    if (pl.lastSyncedAt) {
      var d = new Date(pl.lastSyncedAt);
      var dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      meta["Synced"] = dateStr;
      title = pl.name + " (" + dateStr + ")";
    }
    return {
      name: pl.name,
      playlistName: title,
      coverUrl: pl.imageUrl || undefined,
      source: entitySource(pl),
      description: pl.description || null,
      metadata: meta,
    };
  }

  function parseDuration(duration) {
    if (!duration) return null;
    var parts = duration.split(":");
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    return null;
  }

  function toPluginTracks(tracks) {
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      out.push({
        path: t.spotifyId ? "spotify://" + t.spotifyId : null,
        title: t.name || "Unknown",
        artist_name: t.artist || null,
        album_title: t.album || null,
        duration_secs: parseDuration(t.duration),
        image_url: t.imageUrl || null,
      });
    }
    return out;
  }

  api.ui.onAction("play-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    fetchTracksWithLoading(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) return;
      api.playback.playTracks(toPluginTracks(tracks), 0, playlistContextPayload(pl));
    }).catch(function (e) { console.error(e); });
  });

  api.ui.onAction("enqueue-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    fetchTracksWithLoading(pl).then(function (tracks) {
      if (!tracks || tracks.length === 0) return;
      api.playback.insertTracks(toPluginTracks(tracks), -1);
    }).catch(function (e) { console.error(e); });
  });

  api.ui.onAction("refresh-tracks-ctx", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    api.ui.showNotification("Refreshing tracks for " + pl.name + "…");
    ensureTracks(pl, { force: true }).then(function () {
      if (state.currentPlaylist && state.currentPlaylist.id === pl.id) renderPlaylist();
      render();
      api.ui.showNotification("Refreshed " + pl.name);
    }).catch(function (e) { console.error(e); api.ui.showNotification("Failed to refresh"); });
  });

  function savePlaylistToApp(pl) {
    var tracks = state.playlistTracks[pl.id] || [];
    var now = new Date();
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var dateStr = now.getDate() + " " + months[now.getMonth()] + " " + now.getFullYear();
    var name = pl.name + " " + dateStr;

    var trackPayloads = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      trackPayloads.push({
        title: t.name || "Unknown",
        artistName: t.artist || null,
        albumName: t.album || null,
        durationSecs: parseDuration(t.duration),
        source: null,
        imageUrl: t.imageUrl || null,
      });
    }

    var plMeta = { spotifyId: pl.id };
    if (pl.section) plMeta.section = pl.section;
    if (pl.lastSyncedAt) plMeta.sourceDate = pl.lastSyncedAt;

    api.playlists.save({
      name: name,
      source: entitySource(pl),
      imageUrl: pl.imageUrl || null,
      description: pl.description || null,
      metadata: plMeta,
      tracks: trackPayloads,
    }).then(function() {
      api.ui.showNotification("Saved to Playlists: " + name);
    }).catch(function(err) {
      console.error("Failed to save playlist:", err);
      api.ui.showNotification("Failed to save playlist");
    });
  }

  api.ui.onAction("save-playlist", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    savePlaylistToApp(pl);
  });

  api.ui.onAction("save-playlist-ctx", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    savePlaylistToApp(pl);
  });

  // ---- Settings actions ----

  api.ui.onAction("toggle-show-browser-pref", function() {
    state.showBrowserOnRefresh = !state.showBrowserOnRefresh;
    savePreferences();
    // If a scrape is in flight, apply the new visibility immediately to the
    // already-open browse window. Otherwise the change only takes effect on
    // the next sync, which surprises users.
    if (activeScrapeHandle) {
      var p = state.showBrowserOnRefresh ? activeScrapeHandle.show() : activeScrapeHandle.hide();
      p.catch(function (e) { console.error("Failed to toggle browse window visibility:", e); });
    }
    renderSettings();
    render();
  });

  api.ui.onAction("toggle-debug-logging", function() {
    state.debugLogging = !state.debugLogging;
    savePreferences();
    renderSettings();
  });

  api.ui.onAction("toggle-include-albums", function() {
    state.includeAlbums = !state.includeAlbums;
    savePreferences();
    renderSettings();
  });

  // Step-by-step debugger actions
  api.ui.onAction("dbg-start", dbgStart);
  api.ui.onAction("dbg-stop", dbgStop);

  api.ui.onAction("dbg-devtools", function() {
    if (dbgTest.handle && dbgTest.handle.devtools) {
      dbgTest.handle.devtools().catch(console.error);
    }
  });

  api.ui.onAction("dbg-select-playlist", function(data) {
    if (data && data.value !== undefined) {
      dbgTest.selectedPlaylist = data.value;
      renderSettings();
    }
  });

  api.ui.onAction("dbg-next-step", function() {
    if (dbgTest.status !== "waiting" || dbgTest.currentStep >= DBG_STEPS.length) return;
    dbgTest.status = "running";
    renderSettings();
    dbgRunStep(DBG_STEPS[dbgTest.currentStep].id);
  });

  api.ui.onAction("toggle-diagnostics", function() {
    state.showDiagnostics = !state.showDiagnostics;
    renderSettings();
  });

  api.ui.onAction("clear-diagnostics", function() {
    state.lastReport = null;
    api.storage.set("spotify_browse_reports", []).catch(console.error);
    renderSettings();
  });

  api.ui.onAction("set-auto-refresh", function(data) {
    if (!data || data.value === undefined) return;
    var hrs = parseInt(data.value, 10);
    state.autoRefreshHours = hrs;
    savePreferences();
    registerAutoRefresh();
    renderSettings();
  });

  // ---- Home Shelves (one per section) ----

  function shelfIdForSection(sectionName) {
    var safe = String(sectionName || "Playlists")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return "spotify-section-" + (safe || "playlists");
  }

  function buildShelfFetcher(sectionName) {
    return function (limit) {
      try {
        var pls = getPlaylistsForSection(sectionName);
        if (pls.length === 0) {
          return Promise.resolve({ status: "empty" });
        }
        var sorted = pls.slice().sort(function (a, b) {
          return (b.lastSyncedAt ? Date.parse(b.lastSyncedAt) : 0) - (a.lastSyncedAt ? Date.parse(a.lastSyncedAt) : 0);
        });
        var picked = sorted.slice(0, limit);
        var items = picked.map(function (pl) {
          var rawTracks = state.playlistTracks[pl.id] || [];
          return {
            id: String(pl.id),
            name: pl.name || "Unknown",
            coverUrl: pl.imageUrl || null,
            // Home-shelf card subtitle = playlist description (blank until the
            // playlist's tracks have been scraped). Replaces the old "N tracks".
            subtitle: pl.description || undefined,
            targetKind: pl.kind === "album" ? "album" : "playlist",
            tracks: toPluginTracks(rawTracks),
          };
        });
        return Promise.resolve({ status: "ok", items: items });
      } catch (e) {
        return Promise.resolve({ status: "error", message: String(e) });
      }
    };
  }

  // Track currently registered shelves so we can diff on each sync.
  var registeredShelves = {};

  function syncHomeShelves() {
    var desired = {};
    for (var i = 0; i < state.sections.length; i++) {
      var name = state.sections[i];
      desired[shelfIdForSection(name)] = name;
    }

    // Unregister shelves that should no longer be present.
    var prevIds = Object.keys(registeredShelves);
    for (var j = 0; j < prevIds.length; j++) {
      var prevId = prevIds[j];
      if (!desired.hasOwnProperty(prevId)) {
        api.home.unregisterShelf(prevId);
        delete registeredShelves[prevId];
      }
    }

    // Register new shelves.
    var desiredIds = Object.keys(desired);
    for (var k = 0; k < desiredIds.length; k++) {
      var id = desiredIds[k];
      var sectionName = desired[id];
      if (registeredShelves[id]) continue;
      api.home.registerShelf({
        id: id,
        title: "Spotify · " + sectionName,
        displayKind: "playlist-cards",
        limit: 20,
        icon: "spotify",
      });
      api.home.onFetchShelf(id, buildShelfFetcher(sectionName));
      // Clicking a card navigates into this plugin's view and opens the
      // playlist (instead of the host's default play-on-click). Guarded for
      // older hosts that don't expose onItemClick.
      if (typeof api.home.onItemClick === "function") {
        api.home.onItemClick(id, function (item) {
          if (!item || !item.id) return;
          api.ui.navigateToView("spotify");
          openPlaylistById(String(item.id));
        });
      }
      // Lazily resolve tracks when the host home-shelf play button is pressed for
      // an un-fetched playlist (its supplied tracks were empty). The host shows
      // its own loading modal while awaiting this. Guarded for older hosts.
      if (typeof api.home.onResolvePlay === "function") {
        api.home.onResolvePlay(id, function (item) {
          var pl = item && item.id ? findPlaylistById(String(item.id)) : null;
          if (!pl) return Promise.resolve([]);
          return ensureTracks(pl).then(function (tracks) {
            return toPluginTracks(tracks || []);
          });
        });
      }
      registeredShelves[id] = sectionName;
    }
  }

  // ---- Init: restore previous data ----

  // Load playlists from the filesystem layout (playlists/{section}/{id}/...).
  // Fall back to the legacy spotify_browse_state KV entry for a one-time
  // migration, then delete it.
  function loadInitialState() {
    loadPlaylistsFromDisk().then(function (result) {
      if (result.playlists.length > 0) {
        state.playlists = result.playlists;
        state.playlistTracks = result.tracks;
        state.status = "done";
        render();
        return;
      }
      // Fall back to legacy KV state for migration
      return api.storage.get("spotify_browse_state").then(function (saved) {
        if (saved && saved.playlists && saved.playlists.length > 0) {
          state.playlists = saved.playlists;
          state.playlistTracks = saved.playlistTracks || {};
          state.status = "done";
          // Persist into the new filesystem layout, then drop the KV entry
          saveAllPlaylists().then(function () {
            api.storage.delete("spotify_browse_state").catch(console.error);
          }).catch(console.error);
          render();
        } else {
          render();
        }
      });
    }).catch(function (err) {
      console.error("Failed to load state:", err);
      render();
    });
  }
  loadInitialState();
  // Make sure shelves register immediately if state.sections has any defaults,
  // even before loadInitialState resolves.
  syncHomeShelves();

  // The Archive feature has been removed. Clean up any leftover state from
  // older versions: the on-disk archives/ directory and the legacy KV key.
  api.storage.files.remove(["archives"]).catch(function () { /* no-op if missing */ });
  api.storage.delete("spotify_browse_archives").catch(console.error);

  // Sections are now derived from the scrape, but we keep the last-known list +
  // descriptions as a cold-start render cache so shelves show before the first
  // sync of a session completes.
  api.storage.get("spotify_browse_sections").then(function(sections) {
    if (sections && Array.isArray(sections)) state.sections = sections;
    render();
  }).catch(console.error);
  api.storage.get("spotify_browse_section_descriptions").then(function(descs) {
    if (descs && typeof descs === "object") state.sectionDescriptions = descs;
  }).catch(console.error);

  // One-time cleanup: remove the old Liked Songs on-disk directory and its
  // synthetic playlist data (no longer supported). Safe no-op if absent.
  api.storage.files.remove(["playlists", "Liked Songs"]).catch(function () {});

  // Load preferences
  api.storage.get("spotify_browse_preferences").then(function(prefs) {
    if (prefs) {
      state.showBrowserOnRefresh = !!prefs.showBrowserOnRefresh;
      if (prefs.autoRefreshHours !== undefined) state.autoRefreshHours = prefs.autoRefreshHours;
      if (prefs.debugLogging !== undefined) state.debugLogging = !!prefs.debugLogging;
      if (prefs.includeAlbums !== undefined) state.includeAlbums = !!prefs.includeAlbums;
      if (prefs.lastCheckAt) state.lastCheckAt = prefs.lastCheckAt;
      if (prefs.lastCheckResult) state.lastCheckResult = prefs.lastCheckResult;
      registerAutoRefresh();
      renderSettings();
      render();
    }
  }).catch(console.error);

  // One-time cleanup of older legacy archive keys
  api.storage.get("spotify_browse_archive_index").then(function(index) {
    if (!index || !index.length) return;
    var promises = [];
    for (var i = 0; i < index.length; i++) {
      promises.push(api.storage.delete("spotify_browse_archive:" + index[i].storageKey));
    }
    promises.push(api.storage.delete("spotify_browse_archive_index"));
    Promise.all(promises).catch(console.error);
  }).catch(console.error);

  // One-time cleanup: the old layout was plugin-cache/{plugin}/{playlistId}/...
  // (flat, one dir per playlist id at the root). The new layout nests under
  // "playlists/{section}/{id}/", so any top-level dir that isn't "playlists"
  // is orphaned flat-layout junk.
  api.storage.listCacheDirs().then(function (dirs) {
    if (!dirs || !dirs.length) return;
    for (var d = 0; d < dirs.length; d++) {
      if (dirs[d] !== "playlists") {
        api.storage.deleteCacheDir(dirs[d]).catch(console.error);
      }
    }
  }).catch(console.error);

  // One-time cleanup: per-run .log files replaced the old last_sync.log KV value
  // and logs/sync-runs.json. Remove both so they don't linger as stale junk.
  // Safe no-ops if already absent.
  api.storage.delete("last_sync.log").catch(function () { /* absent is fine */ });
  api.storage.files.remove(["logs", "sync-runs.json"]).catch(function () { /* absent is fine */ });

  function registerAutoRefresh() {
    if (state.autoRefreshHours > 0) {
      api.scheduler.register("auto-refresh", state.autoRefreshHours * 60 * 60 * 1000).catch(console.error);
    } else {
      api.scheduler.unregister("auto-refresh").catch(console.error);
    }
  }

  api.scheduler.onDue("auto-refresh", function() {
    silentRefresh();
  });
  registerAutoRefresh();

  // Load last diagnostics report
  api.storage.get("spotify_browse_reports").then(function (reports) {
    if (Array.isArray(reports) && reports.length > 0) {
      state.lastReport = reports[0];
      renderSettings();
    }
  }).catch(console.error);

  renderSettings();
}

function deactivate() {
  if (typeof closeOpenWindows === "function") {
    try { closeOpenWindows(); } catch (e) { console.error("spotify-browse deactivate cleanup failed:", e); }
  }
  closeOpenWindows = null;
}

return { activate: activate, deactivate: deactivate };
