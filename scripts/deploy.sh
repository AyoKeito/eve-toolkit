#!/usr/bin/env bash
#
# Canonical eve-lp deploy. Rebuilds the image, waits for the new container to report healthy,
# then purges the Cloudflare edge from INSIDE the fresh container (which already has the compiled
# dist/ and the CF_* creds via env_file) so the edge re-fills from the new origin.
#
# The zone-wide purge is load-bearing: it is the only thing that reliably evicts the flapping
# Smart Tiered Cache JS variant AND flushes the non-enumerable per-id shells (/missions/:id,
# /missions/arc/:id) that the static URL list can't target. cf-purge-all.mjs exits non-zero if
# creds are missing or CF rejects the purge, and `set -e` makes that fail the whole deploy —
# so a botched purge can't silently ship a stale edge.
#
# Usage:  bash scripts/deploy.sh        (or: npm run deploy)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[deploy] building + (re)starting eve-lp…"
docker compose up -d --build

echo "[deploy] waiting for eve-lp to report healthy…"
status="unknown"
for _ in $(seq 1 45); do
  status="$(docker inspect -f '{{.State.Health.Status}}' eve-lp 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 2
done
if [ "$status" != "healthy" ]; then
  echo "[deploy] eve-lp did not become healthy (status=$status); aborting before purge." >&2
  exit 1
fi

echo "[deploy] purging Cloudflare edge (purge_everything) from the new container…"
docker compose exec -T eve-lp node scripts/cf-purge-all.mjs

echo "[deploy] done — new image live and edge purged."
