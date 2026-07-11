import type { Db } from "../db.js";
import { loadConfig } from "../config.js";
import { bumpComputeGeneration } from "../lib/compute-generation.js";
import { canonicalPurgePrefixes, purgeCloudflareWithRetries, recordCloudflarePurge } from "../lib/cloudflare-purge.js";
import { clearResponseCaches } from "../lib/response-cache.js";
import { materializeCanonicalResponses } from "../lib/response-materialize.js";
import { countFlags, suspicious } from "./flags.js";
import { lineSignature, targetSignature } from "./offer-types.js";
import { summarizeOfferCalc } from "./offer-calc.js";
import { listOfferCalcs } from "./offer-list.js";

let pendingCloudflarePurge: Promise<void> = Promise.resolve();

export function waitForPendingCloudflarePurge(): Promise<void> {
  return pendingCloudflarePurge;
}

export function recomputeAndPersist(db: Db): number {
  const startedAt = Date.now();
  const rows = listOfferCalcs(db, {
    n: 1_000_000,
    all: true,
    maxRiskTier: "NULLSEC",
    minVolume: 0,
    includeFW: true,
    includeSpecial: true,
    bpc: "all",
    hideSuspicious: false,
    hideVanity: false,
    hideNoSecurity: false,
    runs: 1,
    sortBy: "instant"
  });
  const calcMs = Date.now() - startedAt;

  const insert = db.prepare(`
    INSERT INTO calc(
      offer_id, corp_id, offer_name, product_signature, required_signature,
      primary_product_type_id, risk_tier, access_risk_tier, lp_source_tier, required_standing, is_fw,
      flags_json, warn_flag_count, strong_flag_count, is_suspicious,
      is_vanity, has_manufactured_bpc, contract_priced, api_summary_json,
      isk_per_lp_instant, isk_per_lp_patient,
      product_value_instant, product_value_patient, input_cost, build_cost, job_cost,
      net_profit_instant, net_profit_patient, capital_required,
      roi_instant, roi_patient, days_of_supply, days_to_fill, avg_daily_volume_28d, cargo_m3, computed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(offer_id) DO UPDATE SET
      corp_id=excluded.corp_id,
      offer_name=excluded.offer_name,
      product_signature=excluded.product_signature,
      required_signature=excluded.required_signature,
      primary_product_type_id=excluded.primary_product_type_id,
      risk_tier=excluded.risk_tier,
      access_risk_tier=excluded.access_risk_tier,
      lp_source_tier=excluded.lp_source_tier,
      required_standing=excluded.required_standing,
      is_fw=excluded.is_fw,
      flags_json=excluded.flags_json,
      warn_flag_count=excluded.warn_flag_count,
      strong_flag_count=excluded.strong_flag_count,
      is_suspicious=excluded.is_suspicious,
      is_vanity=excluded.is_vanity,
      has_manufactured_bpc=excluded.has_manufactured_bpc,
      contract_priced=excluded.contract_priced,
      api_summary_json=excluded.api_summary_json,
      isk_per_lp_instant=excluded.isk_per_lp_instant,
      isk_per_lp_patient=excluded.isk_per_lp_patient,
      product_value_instant=excluded.product_value_instant,
      product_value_patient=excluded.product_value_patient,
      input_cost=excluded.input_cost,
      build_cost=excluded.build_cost,
      job_cost=excluded.job_cost,
      net_profit_instant=excluded.net_profit_instant,
      net_profit_patient=excluded.net_profit_patient,
      capital_required=excluded.capital_required,
      roi_instant=excluded.roi_instant,
      roi_patient=excluded.roi_patient,
      days_of_supply=excluded.days_of_supply,
      days_to_fill=excluded.days_to_fill,
      avg_daily_volume_28d=excluded.avg_daily_volume_28d,
      cargo_m3=excluded.cargo_m3,
      computed_at=excluded.computed_at
  `);

  const updateRanks = db.transaction(() => {
    db.prepare("DELETE FROM calc").run();
    try {
      db.prepare("DELETE FROM offer_search_fts").run();
    } catch {
      db.prepare("INSERT INTO offer_search_fts(offer_search_fts) VALUES('delete-all')").run();
    }
    const insertSearch = db.prepare(`
      INSERT INTO offer_search_fts(rowid, offer_name, corp_name, product_names)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of rows) {
      const { warn: warnFlagCount, strong: strongFlagCount } = countFlags(row.flags);
      const productSignature = targetSignature(row.sales_targets).join("|");
      const requiredSignature = lineSignature(row.input_lines).join("|");
      insert.run(
        row.offer_id,
        row.corp_id,
        row.offer_name,
        productSignature,
        requiredSignature,
        row.sales_targets[0]?.type_id ?? null,
        row.risk_tier,
        row.access_risk_tier,
        row.lp_source_tier,
        row.required_standing,
        row.is_fw ? 1 : 0,
        JSON.stringify(row.flags),
        warnFlagCount,
        strongFlagCount,
        suspicious(row.flags) ? 1 : 0,
        row.is_vanity ? 1 : 0,
        row.sales_targets.some((target) => target.is_bpc) ? 1 : 0,
        row.contract_priced ? 1 : 0,
        JSON.stringify(summarizeOfferCalc(row)),
        row.isk_per_lp_instant,
        row.isk_per_lp_patient,
        row.product_value_instant,
        row.product_value_patient,
        row.input_cost,
        row.build_cost,
        row.job_cost,
        row.net_profit_instant,
        row.net_profit_patient,
        row.capital_required,
        row.roi_instant,
        row.roi_patient,
        row.days_of_supply,
        row.days_to_fill,
        row.avg_daily_volume_28d,
        row.cargo_m3,
        row.computed_at
      );
      insertSearch.run(
        row.offer_id,
        row.offer_name,
        row.corp_name,
        [
          ...row.products.map((product) => product.type_name),
          ...row.sales_targets.map((target) => target.name),
          ...row.sales_targets.map((target) => target.source_name)
        ].join(" ")
      );
    }

    db.prepare("UPDATE prices SET rank_hot=NULL").run();
    const updateHot = db.prepare("UPDATE prices SET rank_hot=? WHERE type_id=? AND (rank_hot IS NULL OR rank_hot>?)");
    rows.slice(0, 500).forEach((row, index) => {
      const rank = index + 1;
      const hotTypeIds = new Set<number>();
      for (const line of [...row.sales_targets, ...row.input_lines, ...row.build_lines]) {
        hotTypeIds.add(line.type_id);
      }
      for (const typeId of hotTypeIds) {
        updateHot.run(rank, typeId, rank);
      }
    });
  });

  const persistStart = Date.now();
  updateRanks();
  const persistMs = Date.now() - persistStart;
  const generation = bumpComputeGeneration(db);
  clearResponseCaches();
  const materializeStart = Date.now();
  materializeCanonicalResponses(db, generation);
  const materializeMs = Date.now() - materializeStart;
  // No explicit snapshot pre-warm needed: the full-catalog listOfferCalcs pass at the
  // top built and cached the snapshot at the current data version, and recompute does
  // not bump that version, so it stays warm for the post-recompute serving path.
  console.log(
    JSON.stringify({
      component: "recompute",
      rows: rows.length,
      calc_ms: calcMs,
      persist_ms: persistMs,
      materialize_ms: materializeMs,
      duration_ms: Date.now() - startedAt
    })
  );
  const newPurge = purgeCloudflareWithRetries({ prefixes: canonicalPurgePrefixes(loadConfig().appUrl) })
    .then((result) => {
      recordCloudflarePurge(db, result);
    })
    .catch((error) => console.warn("cloudflare purge record failed", error));
  // Chain rather than replace so waitForPendingCloudflarePurge() covers all
  // in-flight purges, not just the latest. A rejected earlier purge is already
  // swallowed by the .catch above, so it cannot poison the chain.
  pendingCloudflarePurge = pendingCloudflarePurge.then(() => newPurge);
  return rows.length;
}
