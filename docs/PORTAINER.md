# Portainer Deployment Guide

This stack runs one EVE LP Calculator container. The HTTP API, static frontend, data pipeline CLI entrypoints, startup warmup, and scheduler all run from the same image; the long-running container starts `node dist/server/src/index.js` directly so there is no npm wrapper process.

The application process takes a heartbeat-based singleton lock in `/app/data/app.lock` before opening SQLite. A second live HTTP/scheduler runtime pointed at the same bind-mounted data directory refuses to start, which keeps duplicate schedulers from starving the refresh jobs. The Compose service uses a stable `eve-lp` hostname and records process start time in the lock so Docker replacements can reclaim a dead owner even when Linux reuses the same PID number. One-off CLI commands still use the separate refresh lock.

## Prerequisites

- Docker host can reach `https://esi.evetech.net`.
- Docker host can reach the official Fenris Creations (formerly CCP) SDE ZIP URL, or `SDE_JSONL_URL` points at an accessible mirror.
- Portainer can build from this repository, or the image has already been built and pushed to a registry.
- A `.env` file exists next to `docker-compose.yml` on the Docker host, or equivalent stack environment variables are configured in Portainer.

Use this `.env` shape:

```text
CONTACT_EMAIL=you@example.com
APP_URL=http://<docker-host>:3004
ADMIN_TOKEN=<long-random-token>
PORT=3004
HOST=0.0.0.0
TRUST_PROXY=0
API_READ_RATE_LIMIT_MAX=180
DB_PATH=/app/data/lp.db
LOG_DIR=/app/logs
LOG_LEVEL=info
SDE_JSONL_URL=https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip
BACKUP_RETENTION_DAYS=30
ESI_CACHE_MAX_ROWS=20000
ESI_REQUEST_TIMEOUT_MS=30000
CF_ZONE_ID=
CF_API_TOKEN=
```

Do not commit the real `.env` file.

## Path And Proxy Notes

The checked-in landing hub lives under `web/landing/` and is served at root `/`. The LP frontend lives under `web/lp/` and is served at `/lp/`; legacy root permalinks with a query string 301 to `/lp/` with the query preserved. The missions frontend lives under `web/missions/` and is served directly at `/missions/`, with mission detail pages under `/missions/:id` and arc timelines under `/missions/arc/:id`. The agent finder lives under `web/agents/` and is served at `/agents/` (API at `/api/agents`). Fastify also redirects `/about` to `/lp/about.html`, `/missions` to `/missions/`, and `/agents` to `/agents/`.

If the container is exposed directly on `:3004` with no reverse proxy, open `http://<host>:3004/` or `http://<host>:3004/missions/`. LP calculator API routes work at both `/api/*` and `/lp/api/*`; missions API routes are served under `/api/*`.

Set `TRUST_PROXY=1` only when the Fastify process is behind a trusted reverse proxy that strips client-supplied `X-Forwarded-*` headers and writes correct forwarded headers. The checked-in compose file currently sets `TRUST_PROXY: "1"` for proxied Portainer deployments; change it to `0` for direct host-port exposure.

For Cloudflare deployments, create a purge token with `Zone:Cache Purge:Edit` and put `CF_ZONE_ID` plus `CF_API_TOKEN` in Portainer environment variables. See `docs/CLOUDFLARE.md` for the Cache Rule, Tiered Cache setup, and `npm run cf:purge-static` deploy purge.

## Deploy From Portainer

1. Open Portainer.
2. Go to `Stacks` -> `Add stack`.
3. Name it `eve-lp`.
4. Use `Repository` mode and point Portainer at the repository containing this project.
5. Set the compose path to `docker-compose.yml`.
6. Add the environment variables from the `.env` shape above, or ensure the host-side `.env` file is present for the stack.
7. Confirm whether `TRUST_PROXY` should stay `1` for your proxy setup.
8. Deploy the stack.

If you use the web editor instead of repository mode, `build: .` will not have project files to build from. In that case, build and push an image first, then replace the compose `build:` block with that image name.

## Runtime Paths

The compose file bind-mounts these host directories:

```text
./data    -> /app/data
./backups -> /app/backups
./logs    -> /app/logs
```

SQLite, ESI cache rows, cached SDE ZIPs, daily snapshots, scheduler logs, and HTTP problem logs survive container restarts as long as those host directories remain in place.

Daily backup storage is roughly `BACKUP_RETENTION_DAYS x lp.db size`; at the default `30` and a ~200 MB database, plan for about 6 GB in `./backups`. `ESI_CACHE_MAX_ROWS` defaults to `20000` and prevents cache growth if an upstream response gets an unexpectedly long expiry. `ESI_REQUEST_TIMEOUT_MS` defaults to `30000` and bounds individual ESI HTTP requests. See `docs/RETENTION.md` for the full bounded-storage table.

## Initial Bootstrap

On startup, the container launches a non-blocking `startup-warmup` scheduler job. It imports missing SDE data, fills missing or stale LP offers, cold prices, hot prices, and history, then recomputes the leaderboard. Use these one-off commands only when you want to bootstrap or repair data explicitly from a container console:

```bash
npm run import-sde
npm run fetch-lp
npm run fetch-prices -- --tier=cold
npm run fetch-history
npm run compute
npm run snapshot
```

For a lighter connectivity check:

```bash
npm run fetch-prices -- --tier=cold --limit=20
npm run fetch-history -- --limit=20
```

The scheduler keeps data fresh after startup warmup finishes. The first SDE import can still take a while on an empty volume, so check the scheduler log before treating an empty leaderboard as final.

## Checking Regular Ingest

Portainer:

1. Open the `eve-lp` container.
2. Check `Logs` for JSON lines with `component:"scheduler"`.
3. Open `Console` and run:

```bash
tail -f /app/logs/scheduler.log
```

Expected scheduler cadence:

```text
startup-warmup   once when the server process begins
esi-prices-hot   every 15 minutes
esi-prices-cold  hourly at minute 7
esi-lp           daily at 11:10
esi-history      daily at 11:20
snapshot         daily at 11:45
vacuum           monthly at 03:00 UTC on the 1st
```

Each job writes `start` and then either `success` or `failure` to `/app/logs/scheduler.log`. Public HTTP `4xx` and `5xx` responses write one JSON line to `/app/logs/http-problems.log` with `request_id`, optional `client_id`, method, URL, status, duration, IP, user agent, and referrer. The LP, price, and history fetchers also update `fetcher_status`.

The runtime image includes lightweight operator tools: `curl`, `jq`, `ps`, `ss`, and `sqlite3`. For example:

```bash
docker exec eve-lp ps -ef
docker exec eve-lp ss -ltnp
docker exec eve-lp curl -s http://127.0.0.1:3004/api/health | jq
docker exec eve-lp sqlite3 /app/data/lp.db "SELECT name, last_success FROM fetcher_status ORDER BY name;"
```

Health and data freshness checks:

```bash
curl http://localhost:3004/api/health
sqlite3 /app/data/lp.db "SELECT source, build_number, release_date, imported_at FROM source_imports;"
sqlite3 /app/data/lp.db "SELECT max(updated_at) FROM prices; SELECT max(computed_at) FROM calc;"
sqlite3 /app/data/lp.db "SELECT name, last_success, last_error_at, last_error_msg FROM fetcher_status ORDER BY name;"
```

If `esi-prices-hot` fails with ESI `429`, leave only one stack/container running and let the next scheduled run retry after the upstream error window cools down.

## CLI Equivalent

From the repository directory on the Docker host:

```bash
docker compose up -d --build
docker compose logs -f eve-lp
tail -f logs/scheduler.log
```

Stop it with:

```bash
docker compose down
```

If host-side test runs accidentally leave `npm start`, `node dist/server/src/index.js`, or `tsx server/src/index.ts` processes behind in the staging checkout, inspect and clean them up from the repository directory:

```bash
npm run ops:ps
npm run ops:kill-extras
```
