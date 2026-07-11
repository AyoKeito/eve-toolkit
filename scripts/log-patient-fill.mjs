#!/usr/bin/env node
// Tuning logger for the patient-fill (realistic sell-order) valuation model.
//
// Each run appends one JSON line to logs/patient-fill/snapshots.jsonl with:
//   - the top-N leaderboard under default and realistic-patient valuations
//     (rank shifts between the two are the main tuning signal for theta/horizon)
//   - the days_to_fill distribution across all calc rows
//   - the top sell-book orders for the best product types, so successive
//     snapshots measure how often the front of the book is undercut — the
//     empirical replacement for the assumed 2-day relist interval
//
// Intended cadence: every 6 hours from host cron on the deployment box:
//   0 */6 * * * cd /srv/eve && node scripts/log-patient-fill.mjs >> logs/patient-fill/cron.log 2>&1
//
// Reads the live SQLite database read-only and the local HTTP API; never writes
// to either. Safe to run while the container is serving.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const apiBase = process.env.PATIENT_FILL_API ?? "http://localhost:3004";
const dbPath = process.env.DB_PATH ?? "./data/lp.db";
const outDir = process.env.PATIENT_FILL_LOG_DIR ?? "./logs/patient-fill";
const topN = 200;
const bookTypeLimit = 300;
const bookDepth = 3;

function trimRow(row) {
  return {
    offer_id: row.offer_id,
    rank: row.rank,
    offer: row.offer_name,
    corp: row.corp_name,
    instant: row.isk_per_lp_instant,
    patient: row.isk_per_lp_patient,
    best: row.isk_per_lp,
    days_to_fill: row.days_to_fill ?? null,
    fill_queue_ahead: row.fill_queue_ahead ?? null,
    avg_daily_volume_28d: row.avg_daily_volume_28d ?? null,
    flags: (row.flags ?? []).map((flag) => flag.code)
  };
}

async function fetchTop(params) {
  const response = await fetch(`${apiBase}/api/offers/top?n=${topN}${params}`);
  if (!response.ok) throw new Error(`offers/top${params}: HTTP ${response.status}`);
  const data = await response.json();
  return (data.rows ?? []).map(trimRow);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function fillSummary(db) {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(days_to_fill IS NOT NULL) AS with_fill,
              SUM(days_to_fill > 7) AS over_7d,
              SUM(days_to_fill > 28) AS over_28d
       FROM calc`
    )
    .get();
  const days = db
    .prepare("SELECT days_to_fill FROM calc WHERE days_to_fill IS NOT NULL ORDER BY days_to_fill")
    .all()
    .map((row) => row.days_to_fill);
  return {
    ...totals,
    p50: percentile(days, 50),
    p90: percentile(days, 90),
    p99: percentile(days, 99)
  };
}

// Top sell-book orders for the best patient-ratio product types. Comparing
// order_id at rank 0 across snapshots yields the measured undercut cadence.
function bookFront(db) {
  const typeIds = db
    .prepare(
      `SELECT DISTINCT primary_product_type_id AS type_id
       FROM calc
       WHERE primary_product_type_id IS NOT NULL
       ORDER BY isk_per_lp_patient DESC
       LIMIT ?`
    )
    .all(bookTypeLimit)
    .map((row) => row.type_id);
  const levels = db.prepare(
    `SELECT rank, order_id, price, qty
     FROM prices_book
     WHERE type_id=? AND side='sell' AND rank<?
     ORDER BY rank`
  );
  const updatedAt = db.prepare("SELECT updated_at FROM prices WHERE type_id=?");
  return typeIds.map((typeId) => ({
    type_id: typeId,
    updated_at: updatedAt.get(typeId)?.updated_at ?? null,
    sell: levels.all(typeId, bookDepth)
  }));
}

async function main() {
  const startedAt = new Date().toISOString();
  const [defaultRows, realisticRows] = await Promise.all([fetchTop(""), fetchTop("&realisticPatient=true")]);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let record;
  try {
    record = {
      v: 1,
      ts: startedAt,
      summary: fillSummary(db),
      default: defaultRows,
      realistic: realisticRows,
      book_front: bookFront(db)
    };
  } finally {
    db.close();
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "snapshots.jsonl");
  fs.appendFileSync(outFile, `${JSON.stringify(record)}\n`);

  const moved = new Map(realisticRows.map((row) => [row.offer_id, row.rank]));
  const shifts = defaultRows
    .filter((row) => moved.has(row.offer_id))
    .map((row) => Math.abs(row.rank - moved.get(row.offer_id)));
  console.log(
    JSON.stringify({
      component: "patient-fill-log",
      ts: startedAt,
      out: outFile,
      rows: { default: defaultRows.length, realistic: realisticRows.length },
      rank_shift_max: shifts.length ? Math.max(...shifts) : null,
      rank_shift_mean: shifts.length ? Number((shifts.reduce((a, b) => a + b, 0) / shifts.length).toFixed(2)) : null,
      fill: record.summary
    })
  );
}

main().catch((error) => {
  console.error(`patient-fill-log failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
