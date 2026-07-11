type HeaderTarget = {
  header?: (name: string, value: string) => unknown;
  setHeader?: (name: string, value: string) => unknown;
};

function setHeader(target: HeaderTarget, name: string, value: string): void {
  if (typeof target.header === "function") {
    target.header(name, value);
    return;
  }
  target.setHeader?.(name, value);
}

export function staticCacheControl(_filePath: string): string {
  // Purge-driven invalidation: every static asset is revalidatable (via ETag), never
  // `immutable`. Cloudflare is busted on each deploy by `npm run cf:purge-static`; between
  // deploys browsers self-heal by revalidating against the origin ETag.
  // (Assets were previously `immutable, max-age=1yr` paired with manual `?v=` stamps, which
  // silently shipped nothing whenever the stamp was not bumped — see docs/CLOUDFLARE.md.)
  return "public, max-age=0, must-revalidate";
}

export function staticCdnCacheControl(filePath: string): string {
  // HTML shells (the navigated app entrypoints: "/", "/lp/", "/lp/about.html", "/missions/…",
  // "/agents/") carry no dynamic data — they change only on deploy, which runs
  // purge_everything. So the edge can hold them a full day, which on a low-traffic site
  // turns almost every navigation into an edge HIT instead of a full origin round trip
  // (DYNAMIC shells measured 120–270 ms TTFB across regions on 2026-06-21 vs ~50 ms for a
  // HIT). Requires the eve-html-shell-cache Cache Rule (docs/CLOUDFLARE.md) marking the
  // extensionless HTML routes cache-eligible; without that rule Cloudflare treats HTML as
  // DYNAMIC and ignores this header. The browser Cache-Control above stays
  // max-age=0,must-revalidate so a deploy's new shell is picked up on the next navigation.
  if (filePath.endsWith(".html")) return "public, s-maxage=86400, stale-while-revalidate=86400";
  // Other static assets (js/css/png/woff2…): browsers revalidate every load (header above),
  // but Cloudflare may hold them an hour and answer those revalidations at the edge — deploys
  // purge via cf:purge-static. One hour (not longer) bounds the damage when a tiered-cache
  // purge race re-seeds a colo with a pre-purge asset (observed 2026-06-10); refill is free.
  return "public, max-age=3600";
}

export function setStaticCacheHeaders(target: HeaderTarget, filePath: string): void {
  setHeader(target, "Cache-Control", staticCacheControl(filePath));
  setHeader(target, "CDN-Cache-Control", staticCdnCacheControl(filePath));
}
