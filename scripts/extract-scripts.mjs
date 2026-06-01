// Pulls the eval'd scrape scripts out of index.js so the verify harness always
// runs the SAME code the host app runs. The script-building block in index.js
// is delimited by sentinel comments and is self-contained (string concatenation
// + builder functions only — no dependency on `api`), so it can be eval'd in a
// bare vm context with a stub window/console.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const MARKER_RE =
  /\/\/ >>> SCRAPE-SCRIPTS-START[^\n]*\n([\s\S]*?)\n\s*\/\/ <<< SCRAPE-SCRIPTS-END/;

export function extractScripts(indexPath) {
  const source = readFileSync(indexPath, "utf8");
  const m = source.match(MARKER_RE);
  if (!m) {
    throw new Error(
      "SCRAPE-SCRIPTS markers not found in " + indexPath +
        " — cannot extract scrape scripts (see Task 1 of the verify-scrape plan)."
    );
  }

  // The block is written with `var`/`function` declarations. Eval it in a vm
  // whose global object we can read back afterward. `window`/`console` are
  // stubbed but never actually called during string assembly.
  const sandbox = { window: { __viboplr: { send() {} } }, console: { log() {}, error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: "index.js#scrape-scripts" });

  const out = {
    SCRIPT_CHECK_LOGIN: sandbox.SCRIPT_CHECK_LOGIN,
    SCRIPT_SCRAPE_SHELVES: sandbox.SCRIPT_SCRAPE_SHELVES,
    scriptNavigatePlaylist: sandbox.scriptNavigatePlaylist,
    scriptScrollThenScrape: sandbox.scriptScrollThenScrape,
    MUSIC_CHIP_URL: sandbox.MUSIC_CHIP_URL,
  };

  for (const [k, v] of Object.entries(out)) {
    if (v == null) throw new Error("extraction produced no value for " + k);
  }
  return out;
}
