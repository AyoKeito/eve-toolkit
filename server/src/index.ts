import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import fs from "node:fs";
import path from "node:path";
import fastifyCompress from "@fastify/compress";
import fastifyEtag from "@fastify/etag";
import fastifyStatic from "@fastify/static";
import {
  agentsWebDir,
  fitsWebDir,
  landingWebDir,
  loadConfig,
  lpWebDir,
  missionsWebDir,
  rootDir,
  sharedWebDir
} from "./config.js";
import { openDb } from "./db.js";
import { acquireAppLock, AppLockBusyError, type AppLockHandle } from "./lib/app-lock.js";
import { registerApiRateLimit, registerCors } from "./lib/cors.js";
import { createRequestId, registerRequestObservability } from "./lib/request-observability.js";
import { inlineCriticalCss } from "./lib/inline-critical-css.js";
import { setStaticCacheHeaders } from "./lib/static-cache.js";
import { registerOfferRoutes } from "./api/offers.js";
import { registerCorpRoutes } from "./api/corp.js";
import { registerHealthRoutes } from "./api/health.js";
import { registerRefreshRoutes } from "./api/refresh.js";
import { registerMissionRoutes } from "./api/missions.js";
import { registerAgentRoutes } from "./api/agents.js";
import { registerContractPriceRoutes } from "./api/contract-prices.js";
import { registerFitRoutes } from "./api/fits.js";
import { registerBurnerRoutes } from "./api/burners.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startEventLoopMonitor } from "./lib/event-loop-monitor.js";

const config = loadConfig({ requireAdminToken: true, requireEsiIdentity: true });
const siteOrigin = config.appUrl.replace(/\/+$/, "");
const sitemapUrls = [
  `${siteOrigin}/`,
  `${siteOrigin}/lp/`,
  `${siteOrigin}/lp/about.html`,
  `${siteOrigin}/missions/`,
  `${siteOrigin}/missions/browse`,
  `${siteOrigin}/missions/burners`,
  `${siteOrigin}/agents/`
];
let appLock: AppLockHandle;
try {
  appLock = await acquireAppLock({ appRoot: rootDir, dbPath: config.dbPath });
} catch (error) {
  if (error instanceof AppLockBusyError) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "refusing to start duplicate app runtime",
        owner: error.owner
      })
    );
    process.exit(1);
  }
  throw error;
}
const db = openDb(config.dbPath);
const app = Fastify({
  logger: { level: config.logLevel },
  trustProxy: config.trustProxy,
  genReqId: createRequestId,
  requestIdHeader: false
});
const missionAssetFiles = new Set([
  "index.html",
  "app.js",
  "arc-meta.js",
  "browse.html",
  "browse.js",
  "burners.html",
  "burners.js",
  "burners-util.js",
  "burners.css",
  "arc-graph.js",
  "arc-order.js",
  "beta-notice.js",
  "combat-stats.js",
  "diagnostics.js",
  "dom-util.js",
  "fit-profile.js",
  "formatters.js",
  "missions-ewar.js",
  "missions-util.js",
  "style.css",
  "detail.html",
  "detail.js",
  "detail.css",
  "arc.html",
  "arc.js"
]);

async function registerLpApiRoutes(target: FastifyInstance): Promise<void> {
  await registerOfferRoutes(target, db);
  await registerCorpRoutes(target, db);
  await registerHealthRoutes(target, db);
}

async function registerApiRoutes(target: FastifyInstance): Promise<void> {
  await registerLpApiRoutes(target);
  await registerRefreshRoutes(target, db);
  await registerMissionRoutes(target, db);
  await registerAgentRoutes(target, db);
  await registerContractPriceRoutes(target, db);
  await registerFitRoutes(target, db);
  await registerBurnerRoutes(target);
}

function missionContentType(fileName: string): string {
  if (fileName.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/html; charset=utf-8";
}

// Assembled navigated HTML shells with their render-blocking stylesheets inlined (see
// inlineCriticalCss). Built once per shell and reused: the source files only change on deploy,
// which restarts the process and clears this cache. @fastify/etag hashes the cached buffer, so
// 304 revalidation still works at each shell's canonical URL.
const shellHtmlCache = new Map<string, Buffer>();

async function buildShell(filePath: string): Promise<Buffer> {
  const cached = shellHtmlCache.get(filePath);
  if (cached) return cached;
  const html = await fs.promises.readFile(filePath, "utf8");
  const buffer = Buffer.from(await inlineCriticalCss(html), "utf8");
  shellHtmlCache.set(filePath, buffer);
  return buffer;
}

// Buffer-send a navigated HTML shell (rather than streaming) so @fastify/etag can hash the body and
// serve 304s at the page's canonical URL; paired with the revalidatable Cache-Control this keeps it
// fresh without ?v= stamps. With inline set, the shell also inlines its render-blocking stylesheets
// so the page is fully styled at first paint (no CSS race — see inlineCriticalCss).
async function sendHtmlShell(reply: FastifyReply, dir: string, options: { inline: boolean }): Promise<FastifyReply> {
  const filePath = path.join(dir, "index.html");
  setStaticCacheHeaders(reply, filePath);
  const body = options.inline ? await buildShell(filePath) : await fs.promises.readFile(filePath);
  return reply.type("text/html; charset=utf-8").send(body);
}

function sendLandingPage(reply: FastifyReply): Promise<FastifyReply> {
  // Deliberately served un-inlined (readFile, not buildShell) at the canonical "/" URL: the landing
  // hub carries no render-blocking stylesheet shell to assemble, so buffered-plus-ETag is enough.
  return sendHtmlShell(reply, landingWebDir, { inline: false });
}

function sendAgentsPage(reply: FastifyReply): Promise<FastifyReply> {
  return sendHtmlShell(reply, agentsWebDir, { inline: true });
}

function sendFitsPage(reply: FastifyReply): Promise<FastifyReply> {
  // Unlisted from the sitemap + llms.txt: it's an owner-only tool.
  return sendHtmlShell(reply, fitsWebDir, { inline: true });
}

async function sendMissionFile(reply: FastifyReply, fileName: string): Promise<FastifyReply> {
  // Read into a buffer (rather than streaming) so @fastify/etag can hash the body and serve
  // 304s; paired with the revalidatable Cache-Control this keeps the missions app fresh
  // without ?v= stamps. Cloudflare is busted on deploy via `npm run cf:purge-static`.
  // HTML shells additionally inline their stylesheets (see inlineCriticalCss); JS/CSS assets
  // are sent verbatim.
  const filePath = path.join(missionsWebDir, fileName);
  setStaticCacheHeaders(reply, filePath);
  const body = fileName.endsWith(".html")
    ? await buildShell(filePath)
    : await fs.promises.readFile(filePath);
  return reply.type(missionContentType(fileName)).send(body);
}

function sendMissionPage(reply: FastifyReply, fileName: string): Promise<FastifyReply> {
  return sendMissionFile(reply, fileName);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sitemapXml(): string {
  const urls = sitemapUrls.map((url) => `  <url>\n    <loc>${xmlEscape(url)}</loc>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function llmsTxt(): string {
  return `# EVE Tools

> EVE Online loyalty point store calculator and mission reference for comparing LP offers, Jita market value, fees, volume, access risk, and mission context.

## Primary Pages

- [LP Store Calculator](${siteOrigin}/lp/): Interactive leaderboard for EVE Online LP store offers ranked by ISK per LP.
- [Methodology](${siteOrigin}/lp/about.html): Pricing formulas, data sources, refresh cadence, cache behavior, and leaderboard guardrails.
- [Mission Reference](${siteOrigin}/missions/): Searchable EVE Online mission reference with faction, damage, resist, EWAR, and epic arc details.
- [Agent Finder](${siteOrigin}/agents/): Solar systems and stations ranked by mission agent density across all NPC corporations at once (or one corp at a time), with levels, divisions, security bands, locator agents, and a minimum-agents filter.

## Public Data Endpoints

- [Top LP Offers JSON](${siteOrigin}/api/offers/top): Ranked LP offer rows.
- [Top LP Offers CSV](${siteOrigin}/api/offers/top.csv): CSV export for the same ranked offer data.
- [Corporations](${siteOrigin}/api/corps): Corporation picker data.
- [Missions](${siteOrigin}/api/missions): Mission list data.
- [Agents](${siteOrigin}/api/agents): NPC mission agents joined to systems and stations. The corp query parameter is optional — omit it for the cross-corp view (every agent carries its owning corp), or pass a corp id to scope to one corporation.
- [Contract Prices](${siteOrigin}/api/contract-prices): Ask-price aggregates for contract-only items (faction blueprint copies), scam-filtered, from public contracts in The Forge.
- [Health](${siteOrigin}/api/health): Data freshness and fetcher health.

## Data Notes

Market and LP data come from public EVE ESI endpoints and Fenris Creations (formerly CCP Games) static data. Values are estimates based on Jita market depth, taxes, broker fees, required items, manufacturing inputs when enabled, and configured filters. Contract-only items (no market group, e.g. faction blueprint copies) are valued from scam-filtered public-contract asks and carry a CONTRACT_PRICED flag.
`;
}

await app.register(fastifyCompress, {
  global: true,
  threshold: 1024
});
await app.register(fastifyEtag);
await registerRequestObservability(app);
await registerCors(app);
await registerApiRateLimit(app);
await registerApiRoutes(app);
await app.register(
  async (scoped) => {
    await registerLpApiRoutes(scoped);
  },
  { prefix: "/lp" }
);

app.get("/robots.txt", async (_request, reply) =>
  reply
    .type("text/plain; charset=utf-8")
    .header("Cache-Control", "public, max-age=3600")
    .send(`User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin}/sitemap.xml\n`)
);
app.get("/sitemap.xml", async (_request, reply) =>
  reply.type("application/xml; charset=utf-8").header("Cache-Control", "public, max-age=3600").send(sitemapXml())
);
app.get("/llms.txt", async (_request, reply) =>
  reply.type("text/markdown; charset=utf-8").header("Cache-Control", "public, max-age=3600").send(llmsTxt())
);
app.get("/", async (request, reply) => {
  // The LP calculator lived at the root before the landing hub; shared permalinks carry
  // their filters in the query string, so forward any query to the calculator's
  // canonical home at /lp/ instead of dropping it on the hub.
  const query = request.raw.url?.split("?")[1];
  if (query) return reply.redirect(`/lp/?${query}`, 301);
  return sendLandingPage(reply);
});
// Firefox (unlike Chrome) probes /favicon.ico at the origin root even when a <link rel="icon">
// is declared, so without this route every Firefox visitor logs a root 404. Point it at the SVG.
app.get("/favicon.ico", async (_request, reply) => reply.redirect("/lp/favicon.svg", 301));
app.get("/about", async (_request, reply) => reply.redirect("/lp/about.html", 301));
app.get("/lp", async (_request, reply) => reply.redirect("/lp/", 301));
app.get("/lp/about", async (_request, reply) => reply.redirect("/lp/about.html", 301));
app.get("/agents", async (_request, reply) => reply.redirect("/agents/", 301));
app.get("/agents/", async (_request, reply) => sendAgentsPage(reply));
// Owner-only trending-fits tool. Intentionally absent from the landing hub, sitemap and
// llms.txt — reachable only by knowing the path (and allowlisted in nginx).
app.get("/fits", async (_request, reply) => reply.redirect("/fits/", 301));
app.get("/fits/", async (_request, reply) => sendFitsPage(reply));
app.get("/missions", async (_request, reply) => reply.redirect("/missions/", 301));
app.get("/missions/", async (_request, reply) => sendMissionPage(reply, "index.html"));
app.get("/missions/browse", async (_request, reply) => sendMissionPage(reply, "browse.html"));
app.get("/missions/burners", async (_request, reply) => sendMissionPage(reply, "burners.html"));
app.get<{ Params: { id: string } }>("/missions/arc/:id", async (request, reply) =>
  /^\d+$/.test(request.params.id) ? sendMissionPage(reply, "arc.html") : reply.callNotFound()
);
app.get<{ Params: { file: string } }>("/missions/:file", async (request, reply) => {
  if (missionAssetFiles.has(request.params.file)) return sendMissionFile(reply, request.params.file);
  return /^\d+$/.test(request.params.file) ? sendMissionPage(reply, "detail.html") : reply.callNotFound();
});

await app.register(fastifyStatic, {
  root: lpWebDir,
  prefix: "/lp/",
  decorateReply: false,
  cacheControl: false,
  setHeaders: setStaticCacheHeaders,
  preCompressed: true
});

// Catches nested missions assets (e.g. /missions/assets/*.png); single-segment files are
// served by the /missions/:file route above. Revalidatable headers + @fastify/static ETag.
await app.register(fastifyStatic, {
  root: missionsWebDir,
  prefix: "/missions/",
  decorateReply: false,
  cacheControl: false,
  setHeaders: setStaticCacheHeaders
});

// Agent finder assets (app.js, style.css); the shell itself is buffer-served by
// GET /agents/ above so it gets an ETag at its canonical navigated URL.
await app.register(fastifyStatic, {
  root: agentsWebDir,
  prefix: "/agents/",
  decorateReply: false,
  cacheControl: false,
  setHeaders: setStaticCacheHeaders
});

// Trending-fits page assets (app.js, style.css); the shell itself is buffer-served by
// GET /fits/ above so it gets an ETag at its canonical navigated URL.
await app.register(fastifyStatic, {
  root: fitsWebDir,
  prefix: "/fits/",
  decorateReply: false,
  cacheControl: false,
  setHeaders: setStaticCacheHeaders
});

// Front-end modules shared by both the lp and missions apps (e.g. diagnostics.js).
// Purge-driven: revalidatable headers + ETag, no ?v= stamps (see docs/CLOUDFLARE.md).
await app.register(fastifyStatic, {
  root: sharedWebDir,
  prefix: "/shared/",
  decorateReply: false,
  cacheControl: false,
  setHeaders: setStaticCacheHeaders
});

startEventLoopMonitor();
const scheduler = startScheduler(db, config.dbPath);

let shuttingDown = false;
type ShutdownReason = NodeJS.Signals | "unhandledRejection" | "uncaughtException";

const close = async (signal: ShutdownReason): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    scheduler.stop();
    await scheduler.waitForIdle();
    await app.close();
    db.close();
  } finally {
    appLock.release();
  }
};

function exitAfterClose(signal: ShutdownReason, exitCode: number): void {
  void close(signal).then(
    () => process.exit(exitCode),
    (error: unknown) => {
      app.log.error({ error, signal }, "shutdown failed");
      process.exit(1);
    }
  );
}

function handleSignal(signal: NodeJS.Signals): void {
  exitAfterClose(signal, 0);
}

function handleFatal(signal: "unhandledRejection" | "uncaughtException", error: unknown): void {
  app.log.error({ error, signal }, "fatal process error");
  exitAfterClose(signal, 1);
}

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);
process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
process.on("uncaughtException", (error) => handleFatal("uncaughtException", error));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  db.close();
  appLock.release();
  throw error;
}
