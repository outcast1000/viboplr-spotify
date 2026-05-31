# Plugin-View Scroll Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the host per-view scroll memory keyed by a plugin-supplied `scrollKey`, so the Spotify plugin's detail view opens at the top, Back restores the home scroll position, and progressive track updates don't reset scroll.

**Architecture:** Host (`outcast1000/viboplr`, worktree `/Users/alex/Code/viboplr/.claude/worktrees/2`) adds an optional `{ scrollKey }` to `setViewData`, stores it per view, and `PluginViewRenderer` saves/restores the `.plugin-view` element's `scrollTop` per key in a `useLayoutEffect`. Plugin (`viboplr-spotify`) tags its three `setViewData("spotify", …)` renders with `"home"` / `"playlist:<id>"`.

**Tech Stack:** Host = React/TypeScript (Tauri 2); typecheck via `node_modules/.bin/tsc --noEmit`. Plugin = ES5 JS in a frozen WebView sandbox; gate via `node --check`.

---

## Conventions / commit policy (read before starting)

- **Host edits go in worktree `/Users/alex/Code/viboplr/.claude/worktrees/2`** (branch `worktree-2`) and are **NOT committed** — leave them in the working tree for the user to review/commit. Run host commands from that dir. (The worktree already carries earlier uncommitted host work; that's expected — just don't commit.)
- **Plugin edits** (`/Users/alex/Code/viboplr-spotify`) are committed normally on the current branch.
- Backward-compatible: a view with no `scrollKey` behaves exactly as today (no save/restore).

Reference: design at `docs/superpowers/specs/2026-05-31-plugin-view-scroll-memory-design.md`.

## File Structure

- **Host (worktree-2, uncommitted)** — Task 1, all four files together (they typecheck as a unit):
  - `src/types/plugin.ts` — `setViewData` signature gains `opts?: { scrollKey?: string }`.
  - `src/hooks/usePlugins.ts` — store scrollKey in a parallel ref; add `getViewScrollKey`.
  - `src/components/PluginViewRenderer.tsx` — `scrollKey` prop + save/restore effect.
  - `src/App.tsx` — read + pass `scrollKey` to the sidebar `PluginViewRenderer`.
  - `.claude/rules/plugins.md` — document the opts arg.
- **Plugin (this repo, committed)** — Task 2:
  - `index.js` — thread `scrollKey` through the three `setViewData("spotify", …)` calls.

---

## Task 1: Host — per-view scroll memory (worktree-2, uncommitted)

**Files (all under `/Users/alex/Code/viboplr/.claude/worktrees/2`):**
- Modify: `src/types/plugin.ts`, `src/hooks/usePlugins.ts`, `src/components/PluginViewRenderer.tsx`, `src/App.tsx`, `.claude/rules/plugins.md`.

**Do all edits in the worktree, typecheck, then STOP — do NOT `git add`/`git commit` in the host repo.**

- [ ] **Step 1: Type the new opts arg** (`src/types/plugin.ts`)

Find this exact line:
```typescript
  setViewData(viewId: string, data: PluginViewData): void;
```
Replace with:
```typescript
  setViewData(viewId: string, data: PluginViewData, opts?: { scrollKey?: string }): void;
```

- [ ] **Step 2: Store the scrollKey + expose an accessor** (`src/hooks/usePlugins.ts`)

(a) Add a parallel ref next to `viewDataRef`. Find:
```typescript
  const viewDataRef = useRef<Map<string, PluginViewData>>(new Map());
```
Replace with:
```typescript
  const viewDataRef = useRef<Map<string, PluginViewData>>(new Map());
  const viewScrollKeyRef = useRef<Map<string, string>>(new Map());
```

(b) Capture the scrollKey in `setViewData`. Find:
```typescript
          setViewData: (viewId, data) => {
            const key = `${pluginId}:${viewId}`;
            viewDataRef.current.set(key, data);
            setViewData(new Map(viewDataRef.current));
          },
```
Replace with:
```typescript
          setViewData: (viewId, data, opts) => {
            const key = `${pluginId}:${viewId}`;
            viewDataRef.current.set(key, data);
            if (opts && typeof opts.scrollKey === "string") {
              viewScrollKeyRef.current.set(key, opts.scrollKey);
            } else {
              viewScrollKeyRef.current.delete(key);
            }
            setViewData(new Map(viewDataRef.current));
          },
```

(c) Add a `getViewScrollKey` accessor mirroring `getViewData`. Find:
```typescript
  const getViewData = useCallback(
    (pluginId: string, viewId: string): PluginViewData | undefined => {
      return viewData.get(`${pluginId}:${viewId}`);
    },
    [viewData],
  );
```
Replace with:
```typescript
  const getViewData = useCallback(
    (pluginId: string, viewId: string): PluginViewData | undefined => {
      return viewData.get(`${pluginId}:${viewId}`);
    },
    [viewData],
  );

  const getViewScrollKey = useCallback(
    (pluginId: string, viewId: string): string | undefined => {
      return viewScrollKeyRef.current.get(`${pluginId}:${viewId}`);
    },
    [viewData],
  );
```
(The `[viewData]` dep makes this re-evaluate on each view update, which is when `App.tsx` reads it; the ref holds the latest key.)

- [ ] **Step 3: Export `getViewScrollKey` from the hook**

The hook returns an object of its public API. Find where `getViewData,` appears in the hook's return value (there is a returned object literal listing `viewData`, `getViewData`, etc. — search for `getViewData,` in a return/object context, NOT its definition). Add `getViewScrollKey,` right after it:
```typescript
    getViewData,
    getViewScrollKey,
```
> If `getViewData` is not listed in the returned object (e.g. the hook returns via a different mechanism), find how `getViewData` is exposed to consumers and expose `getViewScrollKey` the same way. `tsc` + the App.tsx usage in Step 5 will fail if it isn't exposed, catching any miss.

- [ ] **Step 4: Scroll memory in the renderer** (`src/components/PluginViewRenderer.tsx`)

(a) Add the React hooks import at the very top of the file (before the existing `import type …` lines):
```typescript
import { useRef, useLayoutEffect } from "react";
```

(b) Add `scrollKey?: string` to the props interface. Find:
```typescript
interface PluginViewRendererProps {
  pluginName: string;
  data: PluginViewData | undefined;
```
Replace with:
```typescript
interface PluginViewRendererProps {
  pluginName: string;
  data: PluginViewData | undefined;
  scrollKey?: string;
```

(c) Accept the prop and implement save/restore. Find the function signature + the `!data` guard:
```typescript
export function PluginViewRenderer({
  data,
  currentTrack,
  onPlayTrack,
  onAction,
  onTrackContextMenu,
  onTrackRowContextMenu,
  pluginMenuItems,
  onPluginAction,
}: PluginViewRendererProps) {
  if (!data) {
```
Replace with:
```typescript
export function PluginViewRenderer({
  data,
  scrollKey,
  currentTrack,
  onPlayTrack,
  onAction,
  onTrackContextMenu,
  onTrackRowContextMenu,
  pluginMenuItems,
  onPluginAction,
}: PluginViewRendererProps) {
  // Per-view scroll memory: when scrollKey changes (a navigation), save the
  // outgoing view's scrollTop and restore the incoming view's (0 if unseen).
  // Same key (e.g. progressive in-place updates) → no scroll change. No key →
  // no-op (legacy behavior). Session-only, bounded to the most-recent keys.
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const scrollPosRef = useRef<Map<string, number>>(new Map());
  const prevScrollKeyRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (scrollKey === undefined) return;
    const prev = prevScrollKeyRef.current;
    if (prev === scrollKey) return;
    const el = scrollElRef.current;
    if (el) {
      if (prev !== undefined) {
        const m = scrollPosRef.current;
        m.set(prev, el.scrollTop);
        // Bound the map to the 50 most-recent keys (Map preserves insertion
        // order; delete the oldest while over budget).
        while (m.size > 50) {
          const oldest = m.keys().next().value;
          if (oldest === undefined) break;
          m.delete(oldest);
        }
      }
      el.scrollTop = scrollPosRef.current.get(scrollKey) ?? 0;
    }
    prevScrollKeyRef.current = scrollKey;
  }, [scrollKey]);

  if (!data) {
```

(d) Attach the ref to the `.plugin-view` scroll container. Find (the content branch, NOT the empty-state one):
```tsx
      <div className="plugin-view">
        <div className="plugin-view-content">
          <PluginViewNode
            node={contentData}
```
Replace with:
```tsx
      <div className="plugin-view" ref={scrollElRef}>
        <div className="plugin-view-content">
          <PluginViewNode
            node={contentData}
```
> Note: there are two `<div className="plugin-view">` occurrences — the empty-state one (inside `if (!data)`) and this content one. Attach the ref ONLY to the content one shown above (the `data` is present case). The empty-state branch returns before the effect matters.

- [ ] **Step 5: Pass `scrollKey` from App.tsx** (`src/App.tsx`)

Find:
```tsx
            const data = plugins.getViewData(pluginId, viewId);
            return (
              <PluginViewRenderer
                pluginName={pluginState?.manifest.name ?? pluginId}
                data={data}
```
Replace with:
```tsx
            const data = plugins.getViewData(pluginId, viewId);
            const scrollKey = plugins.getViewScrollKey(pluginId, viewId);
            return (
              <PluginViewRenderer
                pluginName={pluginState?.manifest.name ?? pluginId}
                data={data}
                scrollKey={scrollKey}
```

- [ ] **Step 6: Document the opts arg** (`.claude/rules/plugins.md`)

Find this exact line:
```
- `setViewData(viewId, data)` — render plugin views (see `PluginViewData` types)
```
Replace with:
```
- `setViewData(viewId, data, opts?)` — render plugin views (see `PluginViewData` types). `opts.scrollKey?: string` enables per-view scroll memory: the host saves/restores the view's scroll position keyed by `scrollKey`. Change it on navigation (new sub-view → opens at top; returning to a prior key → scroll restored); keep it stable across in-place updates so the view doesn't jump.
```

- [ ] **Step 7: Typecheck gate**

Run (from the worktree):
```bash
cd /Users/alex/Code/viboplr/.claude/worktrees/2 && node_modules/.bin/tsc --noEmit
```
Expected: no errors referencing `scrollKey`, `getViewScrollKey`, `setViewData`, `PluginViewRenderer`, or the changed files. (If the worktree has pre-existing unrelated errors from other in-progress work, confirm none are NEW / reference these symbols; `git stash` + re-run + `git stash pop` to compare if unsure.)

- [ ] **Step 8: Confirm edits, do NOT commit**

Run (from the worktree):
```bash
cd /Users/alex/Code/viboplr/.claude/worktrees/2 && git --no-pager diff --stat
```
Expected: 5 files changed (`plugin.ts`, `usePlugins.ts`, `PluginViewRenderer.tsx`, `App.tsx`, `plugins.md`), all uncommitted. **Do not `git add`/`git commit` in the host repo.**

---

## Task 2: Plugin — tag renders with `scrollKey` (committed)

**Files:**
- Modify: `/Users/alex/Code/viboplr-spotify/index.js` — the three `setViewData("spotify", …)` calls.

**Context:** `renderHome` has two `setViewData("spotify", …)` calls (the empty-home early return and the normal home render); both are the home view → `scrollKey: "home"`. `renderPlaylist` has one → `scrollKey: "playlist:" + pl.id` (where `pl` is the in-scope `state.currentPlaylist`). Progressive track updates re-run `renderPlaylist` with the same key, so they won't reset scroll.

- [ ] **Step 1: Tag the empty-home render**

Find this exact line (the empty-state early return in `renderHome`):
```javascript
      api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: view });
      return;
```
Replace with:
```javascript
      api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: view }, { scrollKey: "home" });
      return;
```

- [ ] **Step 2: Tag the normal-home render**

Find this exact block (the end of `renderHome`):
```javascript
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: view });
  }
```
Replace with:
```javascript
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: view }, { scrollKey: "home" });
  }
```
> This matches only the `children: view` call ending a function. The `renderPlaylist` call uses `children: ch` (Step 3), so they're distinct.

- [ ] **Step 3: Tag the playlist render**

Find this exact block (the end of `renderPlaylist`):
```javascript
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
  }
```
Replace with:
```javascript
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch }, { scrollKey: "playlist:" + pl.id });
  }
```
(`pl` is `state.currentPlaylist`, declared at the top of `renderPlaylist`.)

- [ ] **Step 4: Syntax gate**

Run: `node --check index.js`
Expected: exits 0.

- [ ] **Step 5: Confirm wiring**

Run: `grep -n 'scrollKey: "home"\|scrollKey: "playlist:"' index.js`
Expected: three matches (two `"home"`, one `"playlist:"`).

- [ ] **Step 6: Commit (plugin repo only)**

```bash
cd /Users/alex/Code/viboplr-spotify
git add index.js
git commit -m "feat: tag plugin views with scrollKey for host scroll memory"
```

**[MANUAL CHECKPOINT — full acceptance]** — With the host change built (worktree-2) and the plugin reloaded:
1. Scroll the Spotify main panel down, click a playlist → detail view opens **at the top**.
2. Press **Back** → home is **restored** to the scroll position you left.
3. Open a large playlist → as tracks stream in, the view does **NOT** jump to the top.
4. Open a different playlist, Back, open it again → each opens at top (distinct keys), home stays restored.
5. Other plugins / the Spotify settings panel are unaffected (no `scrollKey` → unchanged scroll behavior).

---

## Self-Review Notes

**Spec coverage** (design section → task):
- `setViewData(viewId, data, { scrollKey })` API → Task 1 Steps 1-2.
- Renderer save/restore in `useLayoutEffect`, key-change-triggered, same-key no-op, no-key no-op → Task 1 Step 4c.
- Ref on `.plugin-view` content container → Task 1 Step 4d.
- App.tsx threads scrollKey → Task 1 Step 5.
- Map bound to ~50 keys → Task 1 Step 4c (the `while (m.size > 50)` evict).
- Docs → Task 1 Step 6.
- Host uncommitted in worktree-2 → Task 1 Steps 7-8 (typecheck, explicit no-commit).
- Plugin keys home / playlist:<id>, all three call sites → Task 2 Steps 1-3.
- Progressive updates don't reset → same `playlist:<id>` key (Task 2 Step 3 + the same-key no-op).
- Backward-compat (no scrollKey → unchanged) → Task 1 Step 2b (delete key when absent) + Step 4c (early return when `scrollKey === undefined`).

**Type/name consistency:** `scrollKey` (string) is the field name in plugin.ts (Step 1), the opts param (Step 2b), the ref-map key (Step 2a/2c), the renderer prop (Step 4b/4c), the App.tsx variable (Step 5), and the plugin calls (Task 2). `getViewScrollKey(pluginId, viewId)` defined in Step 2c, exported in Step 3, consumed in Step 5. `viewScrollKeyRef` / `scrollPosRef` / `prevScrollKeyRef` / `scrollElRef` are internal, each used consistently within its file.

**Note on line numbers:** find-strings are verbatim from current files; anchor on them.
