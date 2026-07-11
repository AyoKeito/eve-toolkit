import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Each HTML shell must modulepreload the full transitive import graph of its entry
// module. Without preloads the browser discovers ES-module imports level by level,
// and every level costs a full client -> edge -> origin round trip (the /missions
// shell had a 4-level waterfall that delayed API fetches by ~3 seconds).

const webRoot = path.resolve("web");

function urlToFile(url: string): string {
  return path.join(webRoot, url.replace(/^\//, ""));
}

function fileToUrl(filePath: string): string {
  return "/" + path.relative(webRoot, filePath).replaceAll(path.sep, "/");
}

function importSpecifiers(source: string): string[] {
  // Static import/re-export specifiers only (no dynamic import() in the front-ends).
  return [...source.matchAll(/^(?:import|export)[\s\S]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
}

function transitiveImports(entryUrl: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entryUrl];
  while (queue.length > 0) {
    const url = queue.pop() as string;
    const source = fs.readFileSync(urlToFile(url), "utf8");
    for (const specifier of importSpecifiers(source)) {
      const resolved = specifier.startsWith("/")
        ? specifier
        : fileToUrl(path.resolve(path.dirname(urlToFile(url)), specifier));
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return seen;
}

const pages: Array<{ html: string; entry: string }> = [
  { html: "web/lp/index.html", entry: "/lp/app.js" },
  { html: "web/agents/index.html", entry: "/agents/app.js" },
  { html: "web/missions/index.html", entry: "/missions/app.js" },
  { html: "web/missions/browse.html", entry: "/missions/browse.js" },
  { html: "web/missions/detail.html", entry: "/missions/detail.js" },
  { html: "web/missions/arc.html", entry: "/missions/arc.js" }
];

for (const { html, entry } of pages) {
  test(`${html} modulepreloads the full import graph of ${entry}`, () => {
    const markup = fs.readFileSync(path.resolve(html), "utf8");
    assert.match(markup, new RegExp(`<script src="${entry.replaceAll("/", "\\/").replaceAll(".", "\\.")}" type="module">`));

    const preloaded = new Set(
      [...markup.matchAll(/<link rel="modulepreload" href="([^"]+)" \/>/g)].map((match) => match[1])
    );
    const imports = transitiveImports(entry);

    for (const url of imports) {
      assert.ok(preloaded.has(url), `${html} is missing <link rel="modulepreload" href="${url}" />`);
    }
    for (const url of preloaded) {
      assert.ok(imports.has(url), `${html} preloads ${url}, which ${entry} does not import (stale preload)`);
    }
  });
}
