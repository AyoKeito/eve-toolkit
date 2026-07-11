# Retention And Growth Bounds

The app is designed to run for long periods without unbounded disk or memory growth. Tune these values in staging or production environment variables when volume size or history requirements differ from the defaults.

| Surface | Default cap | Env var | Notes |
|---|---:|---|---|
| Daily DB backups | 30 days | `BACKUP_RETENTION_DAYS` | Roughly `lp.db size × N`; current default is about 6 GB at ~200 MB per backup. Values are clamped to `1..365`. |
| SQLite WAL file | 64 MB after checkpoint | SQLite pragma | `journal_size_limit = 67108864`; large transactions can expand WAL temporarily until checkpoint truncates it. |
| DB fragmentation | Monthly VACUUM | Scheduler cron | Runs at 03:00 UTC on the 1st of each month and can block SQLite briefly while reclaiming free pages. |
| `esi_cache` rows | 20,000 rows | `ESI_CACHE_MAX_ROWS` | Expired rows are removed first; overflow pruning removes rows with the earliest `expires_at`. Steady state is expected around 4,000 rows. Contract items responses bypass this cache entirely (`store: false`). |
| `contracts` + `contract_items` rows | 90 days after disappearance | Constant | The Forge holds ~35k active contracts (~265k item rows). Contracts vanished more than 90 days ago are pruned each fetch cycle; `contract_prices` rows go stale for the calc after 30 days and are pruned at 90. |
| `ResponseCache` list leaderboard | 200 entries | Constant | In-process LRU for list responses. |
| `ResponseCache` detail responses | 500 entries | Constant | In-process LRU for offer detail responses. |
| SQLite `response_cache` table | One generation | Internal rebuild | Rebuilt on each compute so stale materialized API responses do not accumulate. |
| App singleton lock | One directory | Internal heartbeat | `data/app.lock` is removed on graceful shutdown; a stale heartbeat can be reclaimed after startup recovery. |
| HTTP problem log | Operator-managed | `LOG_DIR` | `http-problems.log` receives one JSONL record per `4xx`/`5xx` response. Rotate or prune with the host log policy when public traffic is high. |
| Docker logs | 50 MB | `docker-compose.yml` | Five rotated files at 10 MB each. |
| API rate-limit store | Per-IP, 1 minute | `API_READ_RATE_LIMIT_*` | Fastify rate-limit store expires request counters on the rolling window. |

Operational checks:

```bash
node --input-type=module -e 'import("./dist/server/src/db.js").then(({ openDb, closeDb }) => { const db = openDb("./data/lp.db"); console.log(db.pragma("journal_size_limit", { simple: true })); closeDb(db); })'
sqlite3 data/lp.db "SELECT COUNT(*) FROM esi_cache;"
ls backups/lp-*.db | wc -l
```

Expected defaults: the app DB connection reports `67108864`, `esi_cache` stays at or below `20000` after fetcher cleanup, and backup count stays at or below `BACKUP_RETENTION_DAYS` after the next snapshot. A separate raw `sqlite3` connection may report its own default `journal_size_limit` unless that connection sets the pragma too.
