# EVE Toolkit

A self-hosted suite of EVE Online tools served from a single Node.js / Fastify process:

- a global **LP-store leaderboard** priced against live Jita market data with post-fee buy/sell ratios,
- a **mission & epic-arc** database with per-mission guides,
- an **NPC agent finder** grouped by system and ranked by hub density, and
- **public-contract / faction-BPC pricing** for items that trade only via contracts.

It imports the official JSON Lines SDE from developers.eveonline.com into SQLite, pulls loyalty-point
offers and market data from public ESI endpoints, computes depth-walked offer economics, and serves a
static vanilla-JS frontend from the same process.

The reference deployment runs at [eve.ayokei.to](https://eve.ayokei.to). This repository is the full
source; self-host your own instance with the steps below.

## Architecture

- **Backend:** Node.js 22, TypeScript, Fastify, SQLite via `better-sqlite3`.
- **Frontend:** static HTML/CSS/vanilla JS in `web/landing/`, `web/lp/`, `web/missions/`, and
  `web/agents/`. Dark mode default; the LP calculator has a desktop table and a mobile card layout.
- **Data:** the official EVE Online JSONL SDE, plus public ESI LP-store, market order, market
  history, and market price endpoints.
- **Runtime:** one HTTP process runs the API, the static frontend, the scheduler, and a startup
  data warmup.
- **Persistence:** `data/lp.db`, cached SDE ZIPs under `data/sde/`, daily SQLite backups under
  `backups/`, and scheduler / HTTP problem logs under `logs/`.

## Quick Start

Prerequisites:

- Node.js **22+** (`better-sqlite3` compiles a native addon — install/build on the OS that runs
  the app; a Linux host is recommended).
- Outbound network access to `https://esi.evetech.net` (ESI) and the SDE ZIP URL.

```bash
git clone <this-repo> eve-lp && cd eve-lp
cp .env.example .env          # then edit .env (see Environment below)
npm install
npm run build
npm start                     # serves http://localhost:3004
```

On first boot a non-blocking startup warmup imports the SDE, fills LP/market/history data, and
computes the leaderboard, so an empty database self-populates without any manual pipeline run. The
first SDE import can take a while on an empty volume — watch `logs/scheduler.log`. For a
containerized run, see [Docker](#docker-and-portainer) below.

## Environment

Required variables (the app refuses to boot without them):

```text
CONTACT_EMAIL=      # builds the ESI User-Agent; ESI requests are refused without it
APP_URL=            # deployment origin, e.g. https://example.com (not an app subpath)
ADMIN_TOKEN=        # secret for POST /api/refresh (sent as X-Admin-Token)
```

Set `APP_URL` to the origin root. The landing hub is served at `/`; the LP calculator at `/lp/`,
the missions frontend at `/missions/`, and the agent finder at `/agents/`.

Common optional variables:

```text
PORT=3004
HOST=0.0.0.0
TRUST_PROXY=0
API_READ_RATE_LIMIT_MAX=180
DB_PATH=./data/lp.db
LOG_DIR=./logs
LOG_LEVEL=info
SDE_JSONL_URL=https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip
BACKUP_RETENTION_DAYS=30
ESI_CACHE_MAX_ROWS=20000
ESI_REQUEST_TIMEOUT_MS=30000
CF_ZONE_ID=         # optional Cloudflare cache-purge integration
CF_API_TOKEN=       # token needs only Zone:Cache Purge:Edit
```

`.env.example` is the authoritative, fully commented list (it also covers the killmail-ingest and
public-contract-scan toggles). **Do not commit a real `.env`.**

The LP and missions headers show a browser-generated client ID persisted in local storage so
repeat reports from the same browser can be correlated; the server also returns a fresh
`X-Request-Id` per request and logs it for `4xx`/`5xx` responses in `logs/http-problems.log`.

## URL Layout

The landing hub is served at `/` from `web/landing/` (legacy root permalinks with a query string
301 to `/lp/`). The LP frontend is at `/lp/` from `web/lp/` (`/about` → `/lp/about.html`). The
missions frontend is at `/missions/` from `web/missions/`, with detail pages under `/missions/:id`
and arc timelines under `/missions/arc/:id`. The agent finder — NPC mission agents grouped by
solar system and ranked by hub density — is at `/agents/` from `web/agents/`.

The Fastify app keeps the public API at `/api/*`. LP calculator routes also have `/lp/api/*`
aliases; both `http://localhost:3004/api/health` and `/lp/api/health` are valid smoke checks.

## Development

From a checkout on the OS that will run the app:

```bash
npm install
npm run build
npm test
npm run lint
```

If you develop from a network-mounted checkout, run dependency installs and final verification in
the same OS that will run the app (the native `better-sqlite3` build is platform-specific).

Avoid leaving host-side `npm start` / `npm run dev` processes running against a shared checkout —
the app refuses to start a second live HTTP/scheduler runtime for the same data directory. For
short host-side checks use `npm run dev:timed` (a 20-minute-by-default wrapper that terminates the
dev process group when it expires). Inspect or clean up stray runtimes with `npm run ops:ps` and
`npm run ops:kill-extras`.

## Data Pipeline

The startup warmup imports missing SDE data, fills missing or stale LP/market/history data, and
recomputes the leaderboard before handing off to the normal scheduler cadence. To run the same
steps explicitly:

```bash
npm run import-sde
npm run fetch-lp
npm run fetch-prices -- --tier=cold
npm run fetch-history
npm run fetch-contracts
npm run compute
npm run snapshot
npm run build
npm start
```

Limited smoke tests are supported for the price and history fetchers:

```bash
npm run fetch-prices -- --tier=cold --limit=20
npm run fetch-history -- --limit=20
```

`npm run import-sde` streams selected members from the official JSONL SDE ZIP. The ZIP is cached
under `data/sde/` and is not extracted into the repo tree; import metadata lives in
`source_imports`.

`npm start` runs the HTTP API, startup warmup, and the built-in scheduler. Keep it running to
refresh hot prices every 15 minutes, cold prices hourly, public contracts every 30 minutes, LP
offers daily at 11:10, market history daily at 11:20, and snapshots daily at 11:45. Transient ESI
5xx responses are retried with exponential backoff, so one flaky type no longer aborts a whole
price refresh.

`npm run fetch-contracts` scans The Forge's public contracts (configurable via
`CONTRACT_PRICE_REGIONS`) and rolls scam-filtered ask aggregates into `contract_prices`, which
value contract-only LP products (faction blueprint copies) on the patient basis with a
`CONTRACT_PRICED` flag. The first run sweeps items for every active `item_exchange` contract
(~34k requests, roughly 40 minutes) and is **not** part of startup warmup — run it manually once
after deploying; the 30-minute cycle afterwards only touches new contracts.

## API

- `GET /api/offers/top` — ranked offer rows.
- `GET /api/offers/top.csv` — the same result as CSV.
- `GET /api/offers/:id` — a full calculation breakdown.
- `GET /api/corps` — corporation picker options.
- `GET /api/corp/:id` — one corporation plus its filtered rows.
- `GET /api/agents` — one corporation's NPC mission agents (requires `corp`) joined to systems,
  stations, constellations, regions, and divisions.
- `GET /api/contract-prices` — scam-filtered public-contract ask aggregates for contract-only
  types (optional `type`).
- `GET /api/missions` — mission list rows, filterable by level, faction, type, arc, and search.
- `GET /api/missions/:id` — mission details with pockets, NPCs, objectives, and neighbors.
- `GET /api/missions/health` — mission import status and row counts.
- `GET /api/arcs` — arc summaries.
- `GET /api/arcs/:id` — an ordered mission timeline for one arc.
- `GET /api/health` — fetcher freshness, database size, empty-table issues, and SDE metadata.
- `POST /api/refresh` — recomputes `calc`; requires `X-Admin-Token`.

LP surfaces exclude SDE corporations without an earnable LP source. Default leaderboard guardrails
show all risk tiers, standard LP only, `minVolume=0`, suspicious/vanity/blueprint-copy rows
hidden, faction warfare hidden, and Jita-4-4-only disabled unless requested. Selecting a specific
corporation or faction relaxes the discovery guardrails and returns that owner's full catalog.
Rows below 100 units and 250M ISK of average daily market volume stay visible by default with a
warning flag. Every row carries a queue-aware estimated fill time (`days_to_fill`); the opt-in
realistic-patient mode discounts sell-order valuations by fill time and relist fees.

## Docker And Portainer

The app runs as a single Compose service on port `3004`:

```bash
docker compose up -d --build
docker compose logs -f eve-lp
```

The stack mounts `data/`, `backups/`, and `logs/` from the host. Scheduler events are written as
JSON lines to `logs/scheduler.log` and to container stdout. The runtime image includes `curl`,
`jq`, `ps`, `ss`, and `sqlite3` for container-side debugging. Portainer deployment steps and
reverse-proxy notes are in [`docs/PORTAINER.md`](docs/PORTAINER.md); storage/retention bounds are
in [`docs/RETENTION.md`](docs/RETENTION.md).

## Deployment Notes (reference setup)

The reference deployment puts Cloudflare in front of an nginx reverse proxy that forwards to the
Node process on `127.0.0.1:3004`. These pieces are optional — the app runs fine directly on
`:3004` — but the repo ships the real config as a worked example:

- `deploy/nginx/eve.conf` — the nginx server block (TLS, real-IP restore behind Cloudflare,
  path allowlist). Replace `eve.ayokei.to` with your own hostname.
- `infra/cf-cache-ruleset.json` + `scripts/cf-ruleset.mjs` — versioned Cloudflare cache rules with
  `pull` / `diff` / `apply`. See [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md).
- `scripts/deploy.sh` (`npm run deploy`) — rebuilds the image, waits for the container to report
  healthy, then purges the Cloudflare edge from inside the fresh container. The zone-wide purge is
  load-bearing because the HTML app shells are edge-cached.

Cloudflare is entirely optional: leave `CF_ZONE_ID` / `CF_API_TOKEN` blank and every purge path
no-ops cleanly.

## Data Sources & Attribution

- Live game, market, and loyalty-point data comes from the public **EVE Swagger Interface (ESI)**.
- Static type/universe data comes from the official **EVE Online JSON Lines SDE** published by
  Fenris Creations (formerly CCP Games) at `developers.eveonline.com`.
- Mission and epic-arc reference data was assembled from community sources — chruker's EVE
  database and the [EVE University wiki](https://wiki.eveuniversity.org/) — and normalized into the
  seed files under `data/missions/`.
- The Anomic-burners guide content is credited to the **BEARS** community.

EVE Online and the EVE logo are trademarks of Fenris Creations (formerly CCP Games). All related
intellectual property — artwork, screenshots, characters, storylines, and world facts — belongs to
Fenris Creations. This is an unofficial fan project and is **not affiliated with or endorsed by
Fenris Creations**, which is in no way responsible for its content or functioning.

## License

Licensed under the **GNU General Public License v3.0**. See [`LICENSE`](LICENSE) for the full text.

Copyright © 2026 AyoKeito.
