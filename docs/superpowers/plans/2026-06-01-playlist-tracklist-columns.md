# Playlist Tracklist Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Spotify plugin's playlist tracklist a `#` index, a column-header row, and an Album column (`# · TITLE[art+title+artist-subtitle] · ALBUM · DURATION`), matching the host's own playlist UX.

**Architecture:** Extend the host `track-row-list` node (its row design already matches the target): add `album?` to `TrackRowItem` and `numbered?`/`showHeader?` to the node; `PluginTrackRowList` renders an index cell, a header row, and an album cell (album column shown whenever `showHeader`). The plugin supplies `album`, makes the subtitle artist-only, and sets `numbered:true, showHeader:true`.

**Tech Stack:** Host = React/TypeScript (Tauri 2); typecheck via `node_modules/.bin/tsc --noEmit`. Plugin = ES5 JS in a frozen WebView sandbox; gate via `node --check`.

---

## Conventions / commit policy (read before starting)

- **Host edits go in worktree `/Users/alex/Code/viboplr/.claude/worktrees/2`** (branch `worktree-2`) and are **NOT committed** — leave them uncommitted for the user to review/commit. Run host commands from that dir.
- **Plugin edits** (`/Users/alex/Code/viboplr-spotify`) are committed normally.
- The new node flags/field are optional & additive: existing `track-row-list` users (no flags) render exactly as today.

Reference: design at `docs/superpowers/specs/2026-06-01-playlist-tracklist-columns-design.md`.

## File Structure

- **Host (worktree-2, uncommitted)** — Task 1, all five files (typecheck together):
  - `src/types/plugin.ts` — `album?` on `TrackRowItem`; `numbered?`/`showHeader?` on the node.
  - `src/components/PluginViewRenderer.tsx` — forward the two new props.
  - `src/components/pluginViews/pluginViews.tsx` — header row, index cell, album cell.
  - `src/components/PluginViewRenderer.css` — `ptr-header`, `ptr-num`, `ptr-album` styles.
  - `.claude/rules/plugins.md` — doc the new fields.
- **Plugin (this repo, committed)** — Task 2:
  - `index.js` — artist-only subtitle, add `album`, enable `numbered`/`showHeader`.

---

## Task 1: Host — `#` + header + Album column on track-row-list (worktree-2, uncommitted)

**Files (all under `/Users/alex/Code/viboplr/.claude/worktrees/2`).** Make all edits, typecheck, then STOP — **do NOT `git add`/`git commit` in the host repo.**

- [ ] **Step 1: Types** (`src/types/plugin.ts`)

(1a) Find:
```typescript
export interface TrackRowItem {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  duration?: string;
  action?: string;
  checked?: string[];
}
```
Replace with:
```typescript
export interface TrackRowItem {
  id: string;
  title: string;
  subtitle?: string;
  album?: string;
  imageUrl?: string;
  duration?: string;
  action?: string;
  checked?: string[];
}
```

(1b) Find:
```typescript
      type: "track-row-list";
      items: TrackRowItem[];
      selectable?: boolean;
      actions?: { id: string; label: string; icon?: string }[];
      categories?: string[];
    }
```
Replace with:
```typescript
      type: "track-row-list";
      items: TrackRowItem[];
      selectable?: boolean;
      actions?: { id: string; label: string; icon?: string }[];
      categories?: string[];
      numbered?: boolean;
      showHeader?: boolean;
    }
```

- [ ] **Step 2: Forward props in the renderer** (`src/components/PluginViewRenderer.tsx`)

Find:
```tsx
    case "track-row-list":
      return (
        <PluginTrackRowList
          items={node.items}
          selectable={node.selectable}
          actions={node.actions}
          categories={node.categories}
          onAction={onAction}
          onContextMenu={onTrackRowContextMenu}
        />
      );
```
Replace with:
```tsx
    case "track-row-list":
      return (
        <PluginTrackRowList
          items={node.items}
          selectable={node.selectable}
          actions={node.actions}
          categories={node.categories}
          numbered={node.numbered}
          showHeader={node.showHeader}
          onAction={onAction}
          onContextMenu={onTrackRowContextMenu}
        />
      );
```

- [ ] **Step 3: `PluginTrackRowList` — accept new props + render header** (`src/components/pluginViews/pluginViews.tsx`)

(3a) Find the signature:
```tsx
export function PluginTrackRowList({
  items,
  selectable,
  actions,
  categories,
  onAction,
  onContextMenu,
}: {
  items: TrackRowItem[];
  selectable?: boolean;
  actions?: { id: string; label: string; icon?: string }[];
  categories?: string[];
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}) {
```
Replace with:
```tsx
export function PluginTrackRowList({
  items,
  selectable,
  actions,
  categories,
  numbered,
  showHeader,
  onAction,
  onContextMenu,
}: {
  items: TrackRowItem[];
  selectable?: boolean;
  actions?: { id: string; label: string; icon?: string }[];
  categories?: string[];
  numbered?: boolean;
  showHeader?: boolean;
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}) {
```

(3b) Find the body call (the header row goes right before it, the props get threaded into it):
```tsx
      <PluginTrackRowsBody
        items={items}
        selected={selected}
        toggleSelect={toggleSelect}
        selectable={selectable}
        categories={categories}
        itemCategories={itemCategories}
        toggleCategory={toggleCategory}
        onAction={onAction}
        onContextMenu={onContextMenu}
      />
```
Replace with:
```tsx
      {showHeader && (
        <div className="ptr-header">
          {numbered && <span className="ptr-num">#</span>}
          <span className="ptr-art" />
          <span className="ptr-info ptr-header-title">Title</span>
          <span className="ptr-album">Album</span>
          <span className="ptr-duration">Duration</span>
        </div>
      )}
      <PluginTrackRowsBody
        items={items}
        selected={selected}
        toggleSelect={toggleSelect}
        selectable={selectable}
        categories={categories}
        itemCategories={itemCategories}
        toggleCategory={toggleCategory}
        numbered={numbered}
        showAlbum={showHeader}
        onAction={onAction}
        onContextMenu={onContextMenu}
      />
```
> `showAlbum={showHeader}` ties album-column visibility to `showHeader` per the design (no separate flag). The header includes an empty `<span className="ptr-art" />` spacer matching the rows' 48px art cell so the columns line up (see the alignment addendum under Step 5). `ptr-header-title` is a hook for any header-specific tweak.

- [ ] **Step 4: `PluginTrackRowsBody` — accept new props, render index + album** (`src/components/pluginViews/pluginViews.tsx`)

(4a) Find the destructure + type (the block ending `onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;\n}) {` for `PluginTrackRowsBody`). The destructure currently is:
```tsx
export function PluginTrackRowsBody({
  items,
  selected,
  toggleSelect,
  selectable,
  categories,
  itemCategories,
  toggleCategory,
  onAction,
  onContextMenu,
}: {
```
Replace with:
```tsx
export function PluginTrackRowsBody({
  items,
  selected,
  toggleSelect,
  selectable,
  categories,
  itemCategories,
  toggleCategory,
  numbered,
  showAlbum,
  onAction,
  onContextMenu,
}: {
```

(4b) In that same props type object, find:
```tsx
  toggleCategory: (itemId: string, cat: string) => void;
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}) {
```
Replace with:
```tsx
  toggleCategory: (itemId: string, cat: string) => void;
  numbered?: boolean;
  showAlbum?: boolean;
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}) {
```

(4c) Add the row index: change the map to provide `i`. Find:
```tsx
    <div className={`ptr-rows${useCv ? " ptr-rows-cv" : ""}`}>
      {items.map(item => (
        <div
          key={item.id}
          className={`ptr-row${selected.has(item.id) ? " ptr-row-selected" : ""}`}
          onClick={() => item.action && onAction?.(item.action, { itemId: item.id })}
          onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, item); } : undefined}
        >
```
Replace with:
```tsx
    <div className={`ptr-rows${useCv ? " ptr-rows-cv" : ""}`}>
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`ptr-row${selected.has(item.id) ? " ptr-row-selected" : ""}`}
          onClick={() => item.action && onAction?.(item.action, { itemId: item.id })}
          onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, item); } : undefined}
        >
          {numbered && <span className="ptr-num">{i + 1}</span>}
```

(4d) Add the album cell between the info block and the duration. Find:
```tsx
          <div className="ptr-info">
            <span className="ptr-title">{item.title}</span>
            {item.subtitle && <span className="ptr-subtitle">{item.subtitle}</span>}
          </div>
          {item.duration && <span className="ptr-duration">{item.duration}</span>}
```
Replace with:
```tsx
          <div className="ptr-info">
            <span className="ptr-title">{item.title}</span>
            {item.subtitle && <span className="ptr-subtitle">{item.subtitle}</span>}
          </div>
          {showAlbum && <span className="ptr-album">{item.album ?? ""}</span>}
          {item.duration && <span className="ptr-duration">{item.duration}</span>}
```
> Note: with `showAlbum`, the album cell renders even when `item.album` is empty (empty string) so columns align across rows. Duration still only renders when present — that's fine; the header's Duration label always shows and the cell is right-aligned/fixed-width, so absent durations just leave that cell blank-aligned.

(4e) Reserve the art column in album mode so rows without an image still align
(and align with the header spacer). Find:
```tsx
          {item.imageUrl && (
            <div className="ptr-art">
              <img src={resolveImageUrl(item.imageUrl)} alt="" loading="lazy" decoding="async" />
            </div>
          )}
```
Replace with:
```tsx
          {item.imageUrl ? (
            <div className="ptr-art">
              <img src={resolveImageUrl(item.imageUrl)} alt="" loading="lazy" decoding="async" />
            </div>
          ) : showAlbum ? (
            // Album/table mode reserves the art column even when an item has no
            // image, so every row's columns line up (and align with the header).
            <div className="ptr-art" />
          ) : null}
```

- [ ] **Step 5: CSS** (`src/components/PluginViewRenderer.css`)

After the existing `.ptr-duration { … }` rule, add:
```css
.ptr-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}
.ptr-num {
  flex-shrink: 0;
  width: 24px;
  text-align: right;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
/* Empty art cells (header spacer + the no-image placeholder in table mode)
   reserve the 48px art column for alignment but drop the gray fill. */
.ptr-art:empty {
  background: none;
}
/* In the header, the art cell is only a width spacer — don't let its 48px
   height inflate the header row (which only holds small-caps labels). */
.ptr-header .ptr-art {
  height: auto;
}
.ptr-album {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ptr-header .ptr-info,
.ptr-header-title {
  font-size: var(--fs-xs);
}
```
> **Alignment (review-fix addendum):** the row lays out `.ptr-num` (24px) →
> `.ptr-art` (48px) → `.ptr-info` (flex:1) → `.ptr-album` (flex:1) →
> `.ptr-duration` (40px). Because the rows have a fixed 48px art item the header
> would otherwise lack, the two flex:1 columns get different widths and the
> Album/Duration columns would NOT line up. Fix (applied during review):
> (1) the header includes an empty `<span className="ptr-art" />` spacer (added
> in Step 3b above), and (2) in album mode each row reserves the art column even
> with no image — `{item.imageUrl ? <div className="ptr-art"><img…></div> :
> showAlbum ? <div className="ptr-art" /> : null}` (Step 4d) — so every row and
> the header share identical fixed widths. The CSS adds `.ptr-art:empty {
> background: none; }` so the reserved/spacer cells are invisible (no gray box).

- [ ] **Step 6: Docs** (`.claude/rules/plugins.md`)

Find:
```
| `track-row-list` | Compact row list (selectable, per-row actions) |
```
Replace with:
```
| `track-row-list` | Compact row list (selectable, per-row actions). Items: `{ id, title, subtitle?, album?, imageUrl?, duration?, action? }`. Node flags: `numbered?` (leading `#` index), `showHeader?` (column-header row + Album column). |
```

- [ ] **Step 7: Typecheck gate**

Run (from the worktree):
```bash
cd /Users/alex/Code/viboplr/.claude/worktrees/2 && node_modules/.bin/tsc --noEmit
```
Expected: no errors. (Worktree may carry the user's other uncommitted work — confirm no NEW error references `numbered`, `showHeader`, `showAlbum`, `album`, `TrackRowItem`, `PluginTrackRow*`, or the changed files. `git stash` + re-run + `git stash pop` to compare if unsure.)

- [ ] **Step 8: Confirm edits, do NOT commit**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && git --no-pager diff --stat`
Expected: 5 files changed, all uncommitted. **Do not `git add`/`git commit` in the host repo.**

---

## Task 2: Plugin — supply album, artist-only subtitle, enable columns (committed)

**Files:**
- Modify: `/Users/alex/Code/viboplr-spotify/index.js` — `renderPlaylist`'s track-item map + the `track-row-list` node push.

- [ ] **Step 1: Item: artist-only subtitle + album field**

Find:
```javascript
        items.push({
          id: "track:" + i,
          title: t.name || "Unknown",
          subtitle: (t.artist || "Unknown") + (t.album ? " — " + t.album : ""),
          imageUrl: t.imageUrl || undefined,
          duration: t.duration || "",
          action: "play-track",
        });
```
Replace with:
```javascript
        items.push({
          id: "track:" + i,
          title: t.name || "Unknown",
          subtitle: t.artist || "Unknown",
          album: t.album || "",
          imageUrl: t.imageUrl || undefined,
          duration: t.duration || "",
          action: "play-track",
        });
```

- [ ] **Step 2: Node: enable numbered + header**

Find:
```javascript
      if (items.length > 0) {
        ch.push({ type: "track-row-list", items: items });
```
Replace with:
```javascript
      if (items.length > 0) {
        ch.push({ type: "track-row-list", items: items, numbered: true, showHeader: true });
```
> (This is the opening of the `if`; the closing `}` and `}` that follow are unchanged.)

- [ ] **Step 3: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 4: Confirm wiring**

Run: `grep -n 'numbered: true, showHeader: true\|album: t.album' index.js`
Expected: two matches (the node push + the item album field). Also `grep -n 'subtitle: (t.artist' index.js` → NO output (old combined subtitle gone).

- [ ] **Step 5: Commit (plugin repo only)**

```bash
cd /Users/alex/Code/viboplr-spotify
git add index.js
git commit -m "feat: playlist tracklist columns (#, header, Album; artist-only subtitle)"
```

**[MANUAL CHECKPOINT — full acceptance]** — With the host change built (worktree-2) and the plugin reloaded, open a playlist:
1. A column-header row shows `# · TITLE · ALBUM · DURATION` (uppercase), aligned over the rows.
2. Each row shows its 1-based index, art + title, **artist as the subtitle** under the title, the **album in its own column**, and duration.
3. No separate Artist column; album appears once (in its column, not in the subtitle).
4. Search still filters (title/artist/album); the "N of M tracks" text still shows when filtering.
5. Single-click a row still plays; context menu still works.
6. Other plugins / views using `track-row-list` (without the flags) are unchanged — no header, no index, no album cell.

---

## Self-Review Notes

**Spec coverage** (design → task):
- `album?` on TrackRowItem → Task 1 Step 1a.
- `numbered?`/`showHeader?` on node → Task 1 Step 1b; forwarded Step 2.
- Header row (#, Title, Album, Duration, uppercase) → Task 1 Step 3b + CSS Step 5.
- `#` index per row → Task 1 Step 4c (map `(item, i)` + `ptr-num` `{i+1}`).
- Album cell (shown when showAlbum=showHeader, empty-safe) → Task 1 Step 4d.
- Album-visibility tied to showHeader (no 3rd flag) → Task 1 Step 3b (`showAlbum={showHeader}`).
- Host-decided uppercase casing → CSS `text-transform: uppercase` on `.ptr-header` (Step 5).
- Plugin: artist-only subtitle + album + flags → Task 2 Steps 1-2.
- Search/"N of M" preserved → untouched in Task 2 (only the item fields + node flags change).
- Additive/safe for other plugins → optional props default falsy (Task 1 Steps 1-4 all gated).

**Type/name consistency:** node flags `numbered`/`showHeader` (plugin.ts, renderer, PluginTrackRowList); `PluginTrackRowsBody` receives `numbered`/`showAlbum` (showAlbum derived from showHeader at the call site); item field `album` (plugin.ts TrackRowItem, plugin index.js, rendered via `item.album`); CSS classes `ptr-header`/`ptr-num`/`ptr-album` defined (Step 5) and used (Steps 3b/4c/4d). All consistent.

**Note on line numbers:** find-strings are verbatim from current files; anchor on them.
