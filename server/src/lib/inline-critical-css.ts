import fs from "node:fs";
import path from "node:path";

import { agentsWebDir, fitsWebDir, lpWebDir, missionsWebDir, sharedWebDir } from "../config.js";

// Root-absolute stylesheet href prefix -> the web dir it is served from. Only these local
// asset namespaces are eligible for inlining; anything else (a remote href) is left untouched.
const stylesheetRoots: Array<[string, string]> = [
  ["/lp/", lpWebDir],
  ["/shared/", sharedWebDir],
  ["/agents/", agentsWebDir],
  ["/fits/", fitsWebDir],
  ["/missions/", missionsWebDir]
];

function resolveStylesheetHref(href: string): string | null {
  for (const [prefix, dir] of stylesheetRoots) {
    if (!href.startsWith(prefix)) continue;
    const filePath = path.join(dir, href.slice(prefix.length));
    // Never escape the mapped web dir — a crafted "../" href must not inline arbitrary files.
    const rel = path.relative(dir, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return filePath;
  }
  return null;
}

// Matches the one stylesheet-link form every shell uses: <link rel="stylesheet" href="…" />.
const STYLESHEET_LINK = /<link rel="stylesheet" href="([^"]+)"\s*\/>/g;

/**
 * Replace each render-blocking `<link rel="stylesheet">` that points at a local web asset with an
 * inline `<style>` holding the file's contents, preserving source order (so the cascade is
 * unchanged).
 *
 * A page's own stylesheet is the largest sheet and the only one unique to it, so on a cold load it
 * straggles behind the cache-warm shared theme/base sheets (those are served as tiny 304s because
 * every page links them). A browser that paints in that window — Firefox, after its paint
 * suppression timeout — shows the shell styled by theme+base only, i.e. bare native form controls
 * flowing as pills, until the page sheet lands. That is the FOUC observed on /agents/.
 *
 * Inlining removes the CSS network round trips entirely: the navigated HTML carries its own styles,
 * so the shell is fully styled at first paint and there is nothing left to straggle. It is also
 * faster (three render-blocking requests collapse into the one HTML download, which is edge-cached).
 *
 * The .css files stay the single source of truth — still authored separately and still served at
 * their URLs — we only splice their contents in when assembling the navigated HTML shell.
 */
export async function inlineCriticalCss(html: string): Promise<string> {
  const links = [...html.matchAll(STYLESHEET_LINK)];
  if (links.length === 0) return html;

  const inlineByTag = new Map<string, string>();
  for (const [tag, href] of links) {
    if (inlineByTag.has(tag)) continue;
    const filePath = resolveStylesheetHref(href);
    if (!filePath) continue; // unknown / remote href — leave the link as-is
    try {
      const css = (await fs.promises.readFile(filePath, "utf8")).trimEnd();
      inlineByTag.set(tag, `<style data-inlined-from="${href}">\n${css}\n    </style>`);
    } catch {
      // Source file missing — keep the original <link> so the page still styles itself.
    }
  }

  // A function replacement returns its value verbatim, so "$"-bearing CSS can't be misread as a
  // replacement pattern. Each tag is matched literally via the map key.
  return html.replace(STYLESHEET_LINK, (tag) => inlineByTag.get(tag) ?? tag);
}
