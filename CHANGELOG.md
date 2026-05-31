# Changelog

## v1.12.1
- Fix playlists missing covers after sync: the home-page settle phase now
  oscillates (up then back down, repeating) and re-traverses the virtualized
  feed until every card has a cover or the pass budget runs out, giving lazy
  card images more chances to resolve.

## v1.12.0
- Sync now scrapes the Music home page (`home?facet=music-chip`) in a single
  pass, showing every shelf as a stacked heading + card grid (mirroring the
  Spotify page). Removed the fragile section-finder, the section tabs, and
  per-section configuration.
- Cards now show their Spotify subtitle and shelves their description text, so
  the panel looks populated before any tracks are fetched.
- Tracks are now fetched lazily on View/Play/Enqueue and cached for 24h
  (added a "Refresh tracks" card action to force a re-scrape).
- Removed the Liked Songs synthetic playlist.
- Auto-refresh now refreshes the playlist list only (no eager track scraping).

## v1.11.0
- Moved the plugin to its own repository with in-app auto-update.
- Prune orphan track thumbnails on refresh; preserve on-disk covers when a
  refresh yields no cover image.
- Write one human-readable log file per sync run (logs/YYYYMMDD-HHMMSS.log,
  newest 20 kept) instead of last_sync.log / sync-runs.json.
