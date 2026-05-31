# Home-Shelf Description Subtitle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the playlist **description** (not "N tracks") as the subtitle on the Spotify plugin's Home-screen `playlist-cards`.

**Architecture:** Two repos. The host (`outcast1000/viboplr`, worktree at `/Users/alex/Code/viboplr/.claude/worktrees/2`) replaces the `playlist-cards` item's `trackCount?: number` with `subtitle?: string` and renders it directly (PoC — no backward-compat). The plugin (`viboplr-spotify`, this repo) sends `subtitle: pl.description || undefined` instead of `trackCount` on its shelf items.

**Tech Stack:** Host = React/TypeScript (Tauri 2 app); typecheck via `tsc --noEmit`. Plugin = plain ES5 JS in a frozen WebView sandbox; gate via `node --check`.

---

## Conventions / commit policy (read before starting)

- **Host repo edits go in the worktree `/Users/alex/Code/viboplr/.claude/worktrees/2`** (branch `worktree-2`) and are **NOT committed** — leave them in the working tree for the user to review/commit. Run host commands from that directory.
- **Plugin repo edits** (`/Users/alex/Code/viboplr-spotify`) are committed normally on the current branch.
- No backward-compat required (PoC): `trackCount` is removed from the `playlist-cards` item, not kept as a fallback.
- **Verified blast radius:** no host code constructs a `playlist-cards` `HomeShelfItem` with `trackCount` (the repo's other `trackCount:` usages are an unrelated saved-playlists type, a delete-modal prop, and a search slot-allocator). Removing it from the type is safe.

Reference: design at `docs/superpowers/specs/2026-05-31-home-shelf-description-subtitle-design.md`.

## File Structure

- **Host (worktree-2, uncommitted):**
  - `src/types/plugin.ts` — the `playlist-cards` variant of `HomeShelfItem` (type).
  - `src/components/HomeShelf.tsx` — the `displayKind === "playlist-cards"` render block.
  - `.claude/rules/plugins.md` — the display-kind schema doc row.
- **Plugin (this repo, committed):**
  - `index.js` — `buildShelfFetcher`'s item map.

Task 1 = host (all three host files, one logical change, typechecked together, left uncommitted). Task 2 = plugin (committed).

---

## Task 1: Host — replace `trackCount` with `subtitle` on playlist-cards

**Files (all under `/Users/alex/Code/viboplr/.claude/worktrees/2`):**
- Modify: `src/types/plugin.ts` — `HomeShelfItem` playlist-cards variant.
- Modify: `src/components/HomeShelf.tsx` — playlist-cards render block.
- Modify: `.claude/rules/plugins.md` — schema doc row.

**Do all edits in the worktree, then typecheck, then STOP — do NOT `git commit` or `git add` in the host repo.**

- [ ] **Step 1: Type — swap `trackCount?` for `subtitle?`**

In `src/types/plugin.ts`, find this exact block:

```typescript
  | {
      // playlist-cards
      id: string;
      name: string;
      coverUrl?: string;
      trackCount?: number;
      tracks: PluginTrack[];
      sourcePluginId?: string;
    }
```

Replace with:

```typescript
  | {
      // playlist-cards
      id: string;
      name: string;
      coverUrl?: string;
      subtitle?: string;
      tracks: PluginTrack[];
      sourcePluginId?: string;
    }
```

- [ ] **Step 2: Renderer — render `subtitle` instead of `trackCount`**

In `src/components/HomeShelf.tsx`, find this exact block:

```tsx
  if (shelf.displayKind === "playlist-cards") {
    const it = item as { id: string; name: string; coverUrl?: string; trackCount?: number };
    const src = resolveImagePath(it.coverUrl ?? null);
    return (
      <div key={`${idx}-${it.id}`} className="ds-card home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          {src ? <img src={src} alt={it.name} /> : <div className="home-shelf-card-fallback">{it.name[0]?.toUpperCase() ?? "?"}</div>}
          {playButton(shelf, item, ctx)}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
          {typeof it.trackCount === "number" && <div className="ds-card-subtitle">{it.trackCount} tracks</div>}
        </div>
      </div>
    );
  }
```

Replace with:

```tsx
  if (shelf.displayKind === "playlist-cards") {
    const it = item as { id: string; name: string; coverUrl?: string; subtitle?: string };
    const src = resolveImagePath(it.coverUrl ?? null);
    return (
      <div key={`${idx}-${it.id}`} className="ds-card home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          {src ? <img src={src} alt={it.name} /> : <div className="home-shelf-card-fallback">{it.name[0]?.toUpperCase() ?? "?"}</div>}
          {playButton(shelf, item, ctx)}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
          {it.subtitle && <div className="ds-card-subtitle">{it.subtitle}</div>}
        </div>
      </div>
    );
  }
```

- [ ] **Step 3: Docs — update the schema row**

In `.claude/rules/plugins.md`, find this exact line:

```
| `playlist-cards` | `{ id, name, coverUrl?, trackCount?, tracks: PluginTrack[] }` — clicking plays the tracks with `{ name, coverUrl, source: "playlist" }` context |
```

Replace with:

```
| `playlist-cards` | `{ id, name, coverUrl?, subtitle?, tracks: PluginTrack[] }` — `subtitle` shown under the title; clicking plays the tracks with `{ name, coverUrl, source: "playlist" }` context |
```

- [ ] **Step 4: Typecheck gate**

Run (from the worktree):
```bash
cd /Users/alex/Code/viboplr/.claude/worktrees/2 && node_modules/.bin/tsc --noEmit
```
Expected: no errors mentioning `HomeShelfItem`, `playlist-cards`, `HomeShelf.tsx`, or `trackCount`.

> Note: `tsc --noEmit` typechecks the whole host app. If it reports **pre-existing** errors unrelated to these three files (the worktree may have other in-progress work), that's acceptable — what matters is that NO new error references `trackCount`, `subtitle`, `HomeShelfItem`, or `HomeShelf.tsx`. If you're unsure whether an error is pre-existing, `git stash` the changes, re-run `tsc --noEmit`, compare, then `git stash pop`.

- [ ] **Step 5: Confirm edits, do NOT commit**

Run (from the worktree):
```bash
cd /Users/alex/Code/viboplr/.claude/worktrees/2 && git --no-pager diff --stat
```
Expected: three files changed (`src/types/plugin.ts`, `src/components/HomeShelf.tsx`, `.claude/rules/plugins.md`), all still unstaged/uncommitted. **Do not run `git add` or `git commit` in this repo** — the user reviews/commits the host change.

---

## Task 2: Plugin — send `subtitle: pl.description` instead of `trackCount`

**Files:**
- Modify: `/Users/alex/Code/viboplr-spotify/index.js` — `buildShelfFetcher`'s item map.

**Context:** `buildShelfFetcher(sectionName)` returns a fetch handler that maps the section's playlists to `playlist-cards` `HomeShelfItem`s. `pl.description` is the scraped playlist description (empty until the playlist's tracks have been fetched). `toPluginTracks` is an existing helper. We replace `trackCount` with `subtitle`.

- [ ] **Step 1: Swap `trackCount` for `subtitle` in the item map**

In `index.js`, find this exact block:

```javascript
        var items = picked.map(function (pl) {
          var rawTracks = state.playlistTracks[pl.id] || [];
          return {
            id: String(pl.id),
            name: pl.name || "Unknown",
            coverUrl: pl.imageUrl || null,
            trackCount: rawTracks.length,
            tracks: toPluginTracks(rawTracks),
          };
        });
```

Replace with:

```javascript
        var items = picked.map(function (pl) {
          var rawTracks = state.playlistTracks[pl.id] || [];
          return {
            id: String(pl.id),
            name: pl.name || "Unknown",
            coverUrl: pl.imageUrl || null,
            // Home-shelf card subtitle = playlist description (blank until the
            // playlist's tracks have been scraped). Replaces the old "N tracks".
            subtitle: pl.description || undefined,
            tracks: toPluginTracks(rawTracks),
          };
        });
```

(`rawTracks` is still used by `toPluginTracks(rawTracks)`, so its declaration stays.)

- [ ] **Step 2: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 3: Confirm the wiring**

Run: `grep -n 'subtitle: pl.description || undefined' index.js`
Expected: at least one match in `buildShelfFetcher`. Also run `grep -n 'trackCount: rawTracks.length' index.js` → expected NO output (the old field is gone).

- [ ] **Step 4: Commit (plugin repo only)**

```bash
cd /Users/alex/Code/viboplr-spotify
git add index.js
git commit -m "feat: home-shelf card subtitle = playlist description"
```

**[MANUAL CHECKPOINT — full acceptance]** — With the host change applied (worktree-2 build) and the plugin reloaded, on the Home screen:
1. A Spotify playlist shelf card whose playlist has a description (i.e. its tracks have been fetched) shows the **description** as the subtitle.
2. A playlist not yet opened/scraped shows a **blank** subtitle (no "N tracks").
3. Clicking a card still plays the playlist (unchanged); the in-plugin stacked-shelf card grid is unaffected (still uses `cardSubtitle`).

---

## Self-Review Notes

**Spec coverage** (design section → task):
- Host: replace `trackCount?` with `subtitle?` on the type → Task 1 Step 1.
- Host: render `subtitle` only (blank when absent) → Task 1 Step 2.
- Host: doc schema row → Task 1 Step 3.
- Host edits uncommitted in worktree-2 → Task 1 Steps 4-5 (typecheck, then explicit no-commit).
- Plugin: `subtitle: pl.description || undefined`, drop `trackCount` → Task 2 Step 1.
- Blank-when-no-description → falls out of plugin dropping `trackCount` + host rendering only `subtitle` (no fallback).
- Stacked-shelf `cardSubtitle` unchanged → no task touches `buildPlaylistCards`.
- No backward-compat → `trackCount` removed, not kept (Task 1 Step 1, Task 2 Step 1).

**Type/name consistency:** the host type field is `subtitle?: string` (Task 1 Step 1), the renderer reads `it.subtitle` (Step 2), the doc says `subtitle?` (Step 3), and the plugin sends `subtitle` (Task 2). All four agree on the field name `subtitle`. `pl.description` is the existing playlist field used elsewhere (hero subtitle); `toPluginTracks`/`rawTracks`/`picked` are unchanged existing symbols.

**Note on line numbers:** find-strings are verbatim from the current files; anchor on them, not line numbers.
