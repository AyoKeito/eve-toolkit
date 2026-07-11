# Cloudflare Configuration

Use this when Cloudflare fronts the Node origin. Replace `<your-domain>` with the public hostname for the deployment.

## Cache Rules

Cloudflare does not cache dynamic JSON or extension-less paths by default. The zone runs
four Cache Rules in the `http_request_cache_settings` phase (rule order matters — later
matching rules override earlier ones, which is why the cache rules carry an explicit
`ne "/api/missions/health"` guard instead of relying on the bypass rule alone):

```text
1. eve-api-cache-bypass — Bypass cache for EVE health and refresh endpoints
   http.request.uri.path in {"/api/health" "/api/refresh" "/api/missions/health"
                             "/lp/api/health" "/lp/api/refresh"}
   -> Cache eligibility: Bypass

2. eve-public-api-cache — Cache canonical API reads using origin cache headers
   (http.request.method in {"GET" "HEAD"} and
    (http.request.uri.path in {"/lp/api/offers/top" "/lp/api/offers/top.csv"
                               "/lp/api/corps" "/lp/api/movers"
                               "/api/missions" "/api/arcs" "/api/agents"
                               "/api/contract-prices" "/api/burners"}
     or http.request.uri.path wildcard r"/api/missions/*"
     or http.request.uri.path wildcard r"/api/arcs/*")
    and http.request.uri.path ne "/api/missions/health")
   -> Eligible for cache; Edge TTL: respect origin; Browser TTL: respect origin;
      Cache key: include query string

3. eve-static-assets-cache — Cache frontend static assets using origin cache headers
   wildcards for *.js *.css *.png *.jpg *.jpeg *.gif *.svg *.ico *.webp *.avif
   *.woff *.woff2 under /lp/ and /missions/, plus /shared/*.js, /shared/*.css,
   /agents/*.js and /agents/*.css
   -> Eligible for cache; Edge TTL: respect origin; Browser TTL: respect origin

4. eve-html-shell-cache — Cache navigated HTML shells using origin cache headers
   http.request.uri.path in {"/" "/lp/" "/lp/about.html" "/missions/"
                             "/missions/browse" "/agents/"}
   or  /missions/arc/*  or  /missions/* (numeric detail pages), excluding the
   static-asset extensions so only the HTML shells match
   -> Eligible for cache; Edge TTL: respect origin; Browser TTL: respect origin
```

The HTML shells were previously `DYNAMIC` (uncached) because no rule marked the
extension-less navigated routes eligible, so every navigation paid a full origin round trip
(measured 120–270 ms TTFB across regions on 2026-06-21 vs ~50 ms for an edge HIT). The shells
carry no dynamic data — they change only on deploy, which runs `purge_everything` — so this
rule lets the edge hold them (24 h `CDN-Cache-Control` from `staticCdnCacheControl()`).

All host conditions are `http.host eq "<your-domain>"`. With "respect origin" edge TTLs,
the origin's `CDN-Cache-Control` headers govern how long the edge holds each response.
The rules can be maintained via the ruleset API with the deployed token (see below):
`GET/PUT /zones/$CF_ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint` —
note `PUT` replaces the whole ruleset, so always start from the live `GET` result.

## Edge TTLs by endpoint

With "respect origin", each endpoint's `CDN-Cache-Control` (set in
`server/src/lib/api-cache-headers.ts`) is the edge TTL. The values are matched to how each
data source actually changes, not cargo-culted:

| Endpoint(s) | Edge `s-maxage` | Why |
| --- | --- | --- |
| `/lp/api/*` (offers/corps/movers) | 900 s (15 min) | Purged after every compute cycle anyway; the TTL is just a backstop. |
| `/api/contract-prices` | 1800 s (30 min) | One contract fetch cycle; nothing purges this path, so the TTL *is* the freshness bound. |
| `/api/missions`, `/api/arcs`, `/api/agents` (+ `/api/missions/*`, `/api/arcs/*`) | 86400 s (24 h) | No dynamic data — changes only on a deploy or an `import-missions`/`import-sde`, **both of which purge the `/api/` prefix**. Invalidation is purge-driven; the 24 h TTL is only a backstop that self-heals a missed purge or a lost tiered-cache re-seed race within a day. (Not made effectively-infinite like one might expect: a lost-race survivor here is stale data, low-severity, but a 24 h self-heal floor is cheap insurance. Static assets get a tighter 1 h bound because a lost-race stale JS module is a *broken page*.) |
| `/api/burners` | 86400 s (24 h) | Static editorial JSON seed baked into the docker image — changes only on a deploy, which zone-purges (`purge_everything`). Same purge-driven-with-24h-backstop policy as the missions/agents group above. |
| HTML shells (`/`, `/lp/`, `/lp/about.html`, `/missions/…`, `/agents/`) — set in `static-cache.ts`, not `api-cache-headers.ts` | 86400 s (24 h) | No dynamic data — the navigated app entrypoints change only on a deploy (`purge_everything`). Caching them turns the `DYNAMIC` origin round trip that gated every navigation's TTFB into an edge HIT. Browser stays `max-age=0, must-revalidate` (ETag) so a deploy's new shell is picked up on the next navigation. Requires the `eve-html-shell-cache` rule. A stale shell is low-severity (it references stable, purge-on-deploy asset URLs), so no tighter bound is needed. |

The browser TTL for the missions/agents group stays short (`max-age=30`) so a user picks up
post-purge data near-instantly via a cheap edge-served revalidation — only the *edge* holds them
for the 24 h backstop window. The standalone import CLIs call `purgeMissionsAgentsEdge()`
(`canonicalMissionsPurgePrefixes()` → the bare-origin `/api/` prefix), mirroring how `compute`
purges the `/lp/api/` prefix, so a data import that ships without a full redeploy still goes live.

## Tiered Cache

Enable Cloudflare dashboard -> Caching -> Configuration -> Tiered Cache -> Smart Tiered Caching Topology.

## Redirect Rules

Do not redirect `https://<your-domain>/` to `/lp/` at the Cloudflare edge. The origin route at `/` serves the landing hub — the canonical Google-indexable site root — and the LP calculator's canonical home is `/lp/`. A root edge redirect will make Search Console classify the property URL as "Page with redirect" before the request reaches Fastify. Fastify itself 301s only legacy root permalinks that carry a query string (`/?corp=...` → `/lp/?corp=...`); a bare `/` always serves the hub.

## API Token

Two tokens, split by least privilege:

- **`CF_API_TOKEN` — runtime, always-on.** Scope it to **`Zone:Cache Purge:Edit` only**. This is
  all the app needs (compute-time prefix purges + the deploy `purge_everything`). It lives in the
  24/7 deployment environment (Portainer stack env or the service `.env`, loaded by the compose
  `env_file`), so it must NOT carry ruleset edit — a leak of a purge-only token can only evict
  cache, not rewrite the cache ruleset.
- **`CF_RULESET_API_TOKEN` — operator-only, occasional.** A separate token with ruleset edit
  (`Zone:Cache Rules`), used by `scripts/cf-ruleset.mjs` the 1–2 times a year you maintain the
  Cache Rules. Set it in your **shell** when running `cf:ruleset:*`; keep it OUT of `.env` and the
  compose `env_file` so the elevated scope never enters the always-on container. The tool falls
  back to `CF_API_TOKEN` (with a warning) for a transition period, but once `CF_API_TOKEN` is
  re-scoped to purge-only that fallback stops working by design.

```text
CF_ZONE_ID=<Cloudflare zone id>
CF_API_TOKEN=<token with Zone:Cache Purge:Edit ONLY>          # runtime, in .env / container
# CF_RULESET_API_TOKEN=<operator token with ruleset edit>     # shell-only, NOT in .env
```

## Cache Rule source of truth

The four Cache Rules are versioned in `infra/cf-cache-ruleset.json` and maintained with
`scripts/cf-ruleset.mjs` (which supersedes the old `tmp_ui/cf-rule-patch.py` read-patch-PUT
throwaway). Because a `PUT` replaces the whole `http_request_cache_settings` ruleset, always
start from the live `GET`:

```bash
npm run cf:ruleset:pull          # GET live ruleset -> infra/cf-cache-ruleset.json (authoritative)
npm run cf:ruleset:diff          # GET live, diff vs the committed file (exit 1 on drift)
npm run cf:ruleset:apply -- --yes  # PUT the committed file's rules to the zone
```

The committed file ships as a hand-reconstructed **seed** flagged `_unverified_reconstruction`;
`apply` refuses to PUT it until a real `pull` captures the authoritative live ruleset. Run
`cf:ruleset:pull` once on a host with CF creds to replace the seed before relying on `apply`.

The app no-ops when either value is missing. After each compute it purges the LP API prefix so updated materialized responses are not served stale. Prefix purge was historically a Cloudflare Enterprise feature (error code 9035 elsewhere), but the deployment zone accepts it (verified 2026-06-10) — so compute purges clear only the `/api/` prefix and leave static edge entries alone. The 9035 fallback remains: if prefix purge is ever rejected, the app automatically retries with a `purge_everything: true` request so cache correctness is maintained with at most one extra round-trip. The fallback is recorded with `method: "purge_everything-fallback"` in the persisted purge record (visible in `/lp/api/health` and the `cloudflare-purge` log line), so deployments on personal zones silently self-heal instead of warning on every compute cycle.

Every purge attempt is logged as a `{"component":"cloudflare-purge",...}` JSON line (including skips when credentials are missing) and the last result is persisted, exposed as `cloudflare_purge` in `/lp/api/health`, and rendered as the "Edge" staleness chip on the LP page. A failed purge adds a `cloudflare_purge_failed` health issue, so a rolled or invalid token surfaces within one compute cycle instead of silently serving edge-stale responses.

The edge is purged on every deploy, after the build has produced `dist/`. Use the committed
wrapper so the load-bearing purge can never be skipped by a forgetful hand-deploy:

```bash
npm run deploy   # scripts/deploy.sh: docker compose up -d --build → wait healthy → cf:purge-all
```

`scripts/deploy.sh` rebuilds the image, waits for the new `eve-lp` container to report healthy,
then runs the purge from *inside* that fresh container (which already has `dist/` and the `CF_*`
creds via `env_file`). The zone-wide purge is the only thing that reliably evicts the flapping
Smart Tiered Cache JS variant and flushes the non-enumerable per-id shells (`/missions/:id`,
`/missions/arc/:id`), so it must run on every deploy. The underlying steps still work standalone
on a host with a built `dist/`:

```bash
npm run build
npm run cf:purge-all
```

`npm run cf:purge-all` sends a single zone-wide `purge_everything` request. This is the deploy purge **by experience, not caution**: targeted URL purges repeatedly (4× as of 2026-06-10) left one Smart Tiered Cache variant serving a stale JS module across hard reloads — fresh CSS plus old JS, while `curl` and no-store fetches saw the new file — and only `purge_everything` reliably evicted the flapping variant. The zone serves this one low-traffic site, so full eviction is cheap and the edge re-fills on demand. Unlike the other purge paths, the script exits non-zero when credentials are missing (a silently skipped deploy purge means stale assets *will* be served).

`npm run cf:purge-static` remains for surgical, non-deploy invalidation: it purges the query-less HTML/CSS/JS files across all five front-end namespaces (the landing hub at `/`, `/lp`, `/shared`, `/missions`, `/agents`) from `APP_URL`, and exits without making an API call when `CF_ZONE_ID` or `CF_API_TOKEN` is missing. The list now exceeds Cloudflare's 30-URL-per-request cap; `purgeCloudflare()` splits file purges into sequential requests of 30, so the list in `canonicalPurgeStaticUrls()` may grow freely. It runs **two purge passes** ~25 s apart (`CF_PURGE_SETTLE_MS` overrides the delay) because a request landing between the first purge and tier propagation can re-seed a colo with the pre-purge asset — its `Age` carries over, so it looks like the purge never happened (observed 2026-06-10, when a stale `detail.js` survived a purge this way). Even the second pass does not always catch the variant flap, which is why deploys use `cf:purge-all` instead.
Set `APP_URL` to the site origin, such as `https://<your-domain>`, not `https://<your-domain>/lp`. The static URL list lives in `canonicalPurgeStaticUrls()` (`server/src/lib/cloudflare-purge.ts`); add a line there whenever a new served asset is introduced (requests are chunked at Cloudflare's 30-URL-per-request limit).

## Static Asset Cache Invalidation (purge-driven)

Static assets carry **no `?v=` cache-bust query strings**. Instead:

- The server serves every static asset (`/lp`, `/shared`, `/missions`) as **revalidatable for browsers** — `Cache-Control: public, max-age=0, must-revalidate` plus an `ETag` (see `staticCacheControl()` in `server/src/lib/static-cache.ts`). Browsers revalidate against the origin and self-heal whenever content changes.
- Cloudflare additionally receives `CDN-Cache-Control: public, max-age=3600` (`staticCdnCacheControl()`), so the edge holds assets for an hour and answers browser revalidations without an origin round trip. Deploy purges are what actually invalidate the edge; the one-hour TTL bounds staleness when a purge is skipped or when the tiered-cache purge race (below) re-seeds a colo with a pre-purge asset.
- Deploys bust Cloudflare immediately via `npm run cf:purge-all` (zone-wide `purge_everything` — see above for why targeted purges proved insufficient), so a fresh module is never combined with a stale dependency. `cf:purge-static` and its URL list in `canonicalPurgeStaticUrls()` remain for surgical invalidation.
- Each HTML shell `modulepreload`s the full transitive import graph of its entry module (guarded by `server/test/modulepreload.test.ts`), so ES-module discovery costs one parallel round trip instead of a per-level waterfall. When an import chain changes, update the `<link rel="modulepreload">` list in the page head.

When adding a **new** served front-end asset, add it to `canonicalPurgeStaticUrls()` and, if it lives under `/missions`, to `missionAssetFiles` in `server/src/index.ts`. Do **not** reintroduce `?v=` tokens — the markup tests (`frontend-markup.test.ts`, `missions-frontend.test.ts`) guard against them.

## Smoke

After deploying the cache rule and env vars:

```bash
npm run compute
curl -sI "https://<your-domain>/lp/api/offers/top?n=100"
curl -sI "https://<your-domain>/lp/api/offers/top?n=100" | grep -i cf-cache-status
```

The second request should show `cf-cache-status: HIT` once the rule is active.
