# Home-Shelf Card Subtitle = Description — Design

**Date:** 2026-05-31
**Status:** Approved (design); implementation pending
**Repos:** `outcast1000/viboplr` (host) + `viboplr-spotify` (plugin)

## Summary

When the Spotify plugin registers its playlists as Home-screen shelves
(`playlist-cards`), each card's subtitle currently shows "N tracks". It should
instead show the **playlist description**. This requires a small change in two
repos because the host both owns the rendering and lacks a field the plugin
could use to override the subtitle.

## Why a host change is needed

- The host's `HomeShelfItem` `playlist-cards` variant (`src/types/plugin.ts`)
  has only `{ id, name, coverUrl?, trackCount?, tracks }` — **no subtitle field**.
- The renderer hardcodes the subtitle from `trackCount`
  (`src/components/HomeShelf.tsx`): `{trackCount} tracks`.

So the plugin cannot supply a description through any existing field. The host
must expose an optional `subtitle` and prefer it over the track count.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Host field | Replace `trackCount?` with `subtitle?: string` on the `playlist-cards` `HomeShelfItem` (PoC — no backward-compat for `trackCount`) |
| Host render | Render `subtitle` (the only subtitle source); blank when absent |
| Plugin item | Set `subtitle: pl.description \|\| undefined`; drop `trackCount` |
| No-description card | Blank subtitle |
| Backward compat | Not required — project is a PoC; the host and plugin change together |
| Host commit | Edit in the host worktree `/Users/alex/Code/viboplr/.claude/worktrees/2` (branch `worktree-2`); **do not commit** there — leave for the user to review/commit |
| Plugin commit | Committed normally on this repo's branch |

## Host changes (`outcast1000/viboplr`, worktree-2 — uncommitted)

1. **`src/types/plugin.ts`** — in the `playlist-cards` variant of `HomeShelfItem`
   (the `// playlist-cards` block, currently `id/name/coverUrl?/trackCount?/tracks/sourcePluginId?`),
   replace `trackCount?: number;` with `subtitle?: string;`.

2. **`src/components/HomeShelf.tsx`** (the `displayKind === "playlist-cards"` block):
   - Change the inline cast (currently
     `const it = item as { id: string; name: string; coverUrl?: string; trackCount?: number };`)
     to `const it = item as { id: string; name: string; coverUrl?: string; subtitle?: string };`.
   - Replace the subtitle line (currently
     `{typeof it.trackCount === "number" && <div className="ds-card-subtitle">{it.trackCount} tracks</div>}`)
     with:
     ```jsx
     {it.subtitle && <div className="ds-card-subtitle">{it.subtitle}</div>}
     ```

3. **`.claude/rules/plugins.md`** — update the `playlist-cards` schema row in the
   display-kind table (currently `{ id, name, coverUrl?, trackCount?, tracks: PluginTrack[] }`)
   to `{ id, name, coverUrl?, subtitle?, tracks: PluginTrack[] }`.

> Verified blast radius (worktree-2): no host code constructs a `playlist-cards`
> `HomeShelfItem` with `trackCount` — the `trackCount:` usages in the repo are an
> unrelated saved-playlists API type, a delete-modal prop, and a search
> slot-allocator. The only consumer of the field is the `HomeShelf.tsx` render
> line being changed. So removing `trackCount` from the type is safe and breaks
> no other shelf.

## Plugin change (`viboplr-spotify`, this repo — committed)

4. **`buildShelfFetcher` (`index.js`)** — in the `items` map, set
   `subtitle: pl.description || undefined` and **remove** `trackCount` from the
   item object. The item keeps `id`, `name`, `coverUrl`, `tracks`, `subtitle`.

   Result: a playlist with a description shows it; one without (not yet scraped)
   shows nothing — because `trackCount` is no longer sent and the host renders
   `null` when both `subtitle` and `trackCount` are absent.

## Behavioral notes

- `pl.description` is populated only after a playlist's tracks are scraped (the
  description comes from the playlist page). So a not-yet-opened playlist shows a
  **blank** subtitle on the home shelf until its tracks are fetched. This matches
  the lazy model and the hero-header subtitle behavior.
- This concerns the **registered Home-screen shelves** (`buildShelfFetcher`),
  NOT the in-plugin stacked-shelf card grid (which uses the scraped
  `cardSubtitle` and is unchanged).
- **Version compatibility:** not a concern — the project is a PoC and the host +
  plugin change together. The host and plugin must both ship for the subtitle to
  appear; we don't support a mixed-version combination.

## Out of scope

- The in-plugin stacked-shelf card subtitle (`cardSubtitle`) — unchanged.
- Any other `displayKind` (album-cards/artist-cards/track-rows) — unchanged.
- Committing/merging the host change (left to the user).

## Testing

- Host: TypeScript compiles (the repo's own typecheck/build); the `playlist-cards`
  block renders `subtitle` when present, `trackCount` when not, nothing when
  neither.
- Plugin: `node --check index.js` (exit 0). No automated harness; real validation
  is reloading in the host (with the host change applied) and confirming Spotify
  shelf cards show descriptions, and blank for not-yet-scraped playlists.
