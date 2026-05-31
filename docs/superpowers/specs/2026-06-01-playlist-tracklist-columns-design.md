# Playlist Tracklist Columns — Design

**Date:** 2026-06-01
**Status:** Approved (design); implementation pending
**Repos:** `outcast1000/viboplr` (host) + `viboplr-spotify` (plugin)

## Summary

Make the Spotify plugin's playlist tracklist consistent with the host's own
playlist UX: a **column-header row**, a **`#` index** per track, and an
**Album column** — laid out as `# · TITLE (art + title + artist subtitle) ·
ALBUM · DURATION` (matching the host's `TrackList.tsx`; **no** separate Artist
column — artist is the subtitle under the title).

The plugin renders tracks via the host `track-row-list` node (`PluginTrackRowList`),
whose row design (art + title + subtitle + duration) already matches the target.
But the node has no album field, no index, and no header row. So this is a small
**host change** to `track-row-list` plus a plugin change to supply album + enable
the new modes.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Node | Extend the existing `track-row-list` (its row design already matches the screenshot) |
| New item field | `album?: string` on `TrackRowItem` |
| New node flags | `numbered?: boolean` (the `#` index) and `showHeader?: boolean` (the column-header row) — independent booleans |
| Columns | `# · TITLE (art + title + artist subtitle) · ALBUM · DURATION`. No Artist column. |
| Title subtitle | Artist only (album moves to its own column) |
| Header casing | Host decides — labels are plain (`Title`/`Album`/`Duration`); the host's header CSS uppercases them (mirrors `.track-header { text-transform: uppercase }`) |
| Album header label | "Album" (rendered uppercased by host CSS) |
| Backward compat | Not required (PoC); but the flags are optional/additive so existing `track-row-list` users are unaffected anyway |
| Host commit | worktree-2 (`/Users/alex/Code/viboplr/.claude/worktrees/2`), **uncommitted** |
| Plugin commit | committed on this repo's branch |

## Host changes (`outcast1000/viboplr`, worktree-2 — uncommitted)

### 1. `src/types/plugin.ts`

(a) `TrackRowItem` (currently `{ id, title, subtitle?, imageUrl?, duration?, action?, checked? }`):
add `album?: string;`.

(b) The `track-row-list` node type (currently `{ type, items, selectable?, actions?, categories? }`):
add `numbered?: boolean;` and `showHeader?: boolean;`.

### 2. `src/components/PluginViewRenderer.tsx`

The `case "track-row-list":` passes node fields to `PluginTrackRowList`. Forward
the two new props: `numbered={node.numbered}` and `showHeader={node.showHeader}`.

### 3. `src/components/pluginViews/pluginViews.tsx` — `PluginTrackRowList` + `PluginTrackRowsBody`

- Add `numbered?: boolean` and `showHeader?: boolean` to both components' props;
  thread `numbered`/`showHeader` from `PluginTrackRowList` into `PluginTrackRowsBody`.
- **Album-mode rule (resolves alignment ambiguity):** treat "show the album
  column" as ON whenever `showHeader` is true. In that mode the header row and
  every data row render an album cell (empty string if the item has no `album`),
  so columns always align. When `showHeader` is false, no album cell is rendered
  (today's behavior). (We tie album-column visibility to `showHeader` rather than
  add a third flag — the plugin always sets both together; keeps the API to two
  flags.)
- **Header row:** when `showHeader`, render a header row above the rows with cells
  matching the row layout: a leading index cell (only when `numbered`; header
  text "#"), then "Title", "Album", "Duration". Use a class (e.g. `ptr-header`)
  styled like `.track-header` (uppercase via CSS, secondary color, bottom border).
- **Index:** when `numbered`, render a leading `ptr-num` cell per row showing the
  1-based row index (`i + 1`, the item's position in `items`).
- **Album cell:** when in album mode (see rule above), render `item.album || ""`
  in a `ptr-album` cell positioned between the title/info block and the duration.
- Keep existing behavior intact: art thumbnail, `ptr-title`/`ptr-subtitle`,
  `ptr-duration`, single-click → `item.action`, context menu, selection,
  categories, `content-visibility` virtualization for >100 rows.
- **Alignment:** the header cells and row cells must use the same column widths
  so the header lines up with the rows. The rows are flex with a fixed 48px art
  cell; for the header to align, (a) in album/table mode every row reserves the
  48px art column even when it has no image (render an empty `.ptr-art`), and
  (b) the header includes a matching empty `.ptr-art` spacer. Empty art cells
  (`.ptr-art:empty`) drop the gray fill so they're invisible spacers. This makes
  the #, Title, Album, and Duration columns line up between header and rows.

### 4. `PluginViewRenderer.css` (or wherever `ptr-*` styles live)

Add styles for `ptr-header` (uppercase, `--text-secondary`, border-bottom),
`ptr-num` (fixed narrow width, secondary color), and `ptr-album` (flexible
width, secondary color, ellipsis). Match the spacing/typography of the host
`TrackList` columns so the plugin view looks native.

### 5. `.claude/rules/plugins.md`

Update the `track-row-list` entry to document `numbered?`, `showHeader?`, and the
item `album?` field.

## Plugin change (`viboplr-spotify`, this repo — committed)

### 6. `index.js` — `renderPlaylist` track items + node

In the track-item loop:
- `subtitle: t.artist || "Unknown"` (artist only — drop the `" — " + album` part).
- add `album: t.album || ""`.

On the `track-row-list` node push: add `numbered: true, showHeader: true`.

The search filter (matching title/artist/album) stays as-is. The "N of M tracks"
filter-result text stays.

## Data flow

```
renderPlaylist:
  items[i] = { id:"track:"+i, title, subtitle: artist, album, imageUrl, duration, action:"play-track" }
  node = { type:"track-row-list", numbered:true, showHeader:true, items }
host PluginTrackRowList:
  showHeader → render header row (# | TITLE | ALBUM | DURATION, uppercased)
  numbered   → leading index cell (i+1) per row
  per row    → [num] [art] (title / artist-subtitle) [album] [duration]
```

## Error / edge handling

- **Missing album** (`t.album` empty): album cell renders empty; columns still
  align. Header still shows.
- **No tracks / loading / search-empty:** unchanged — the track-row-list isn't
  rendered in those states (the existing loading/empty/`No tracks match` paths
  handle them), so the header only appears with rows.
- **Other plugins using `track-row-list`** without the new flags: `numbered`/
  `showHeader` default falsy → no header, no index, no album cell → identical to
  today. Additive and safe.
- **Index vs. search filter:** the `#` is the row's position in the *rendered*
  (possibly filtered) list (`i + 1`), consistent with how the rows are built.

## Out of scope

- Sortable headers / clickable artist-album links (host `TrackList` has these;
  the plugin node does not — not requested).
- A separate Artist column.
- Changing the home/stacked-shelves card grid or any other view.
- Backward-compat shims (PoC; changes are additive regardless).

## Testing

- Host: `node_modules/.bin/tsc --noEmit` in worktree-2 (type + prop changes
  compile); visual check that header aligns with rows and matches `TrackList`.
- Plugin: `node --check index.js` (exit 0).
- No automated harness; real validation is reloading in the host (with the host
  change built) and confirming the playlist view shows `# | TITLE | ALBUM |
  DURATION` headers, numbered rows, artist as subtitle, album in its column —
  matching the host's own playlist pages.
