import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const root = path.resolve("web/lp");
const sharedRoot = path.resolve("web/shared");
const compressible = new Set([".css", ".js", ".html", ".woff2", ".svg"]);
const lpCssBundle = ["theme.css", "style.css", "mobile.css", "polish.css"];

function buildLpCssBundle() {
  const sections = lpCssBundle.map((fileName) => {
    const source = fs.readFileSync(path.join(root, fileName), "utf8").trimEnd();
    return `/* ${fileName} */\n${source}`;
  });
  // Shared base styles load after theme tokens but before component styles, so the
  // app's own rules still win. The missions app loads the same file via /shared/base.css.
  const sharedBase = fs.readFileSync(path.join(sharedRoot, "base.css"), "utf8").trimEnd();
  sections.splice(1, 0, `/* shared/base.css */\n${sharedBase}`);
  fs.writeFileSync(path.join(root, "lp.css"), `${sections.join("\n\n")}\n`);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!compressible.has(path.extname(entry.name))) continue;
    const source = fs.readFileSync(fullPath);
    const compressed = brotliCompressSync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11
      }
    });
    fs.writeFileSync(`${fullPath}.br`, compressed);
  }
}

if (fs.existsSync(root)) {
  buildLpCssBundle();
  walk(root);
}
