import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { apiReadRateLimit } from "../lib/cors.js";
import { setContractPricesCacheHeaders } from "../lib/api-cache-headers.js";
import { parseInteger } from "../lib/parse.js";
import { first, type QueryRecord } from "./query.js";

interface ContractPriceApiRow {
  type_id: number;
  name: string | null;
  ask_count: number;
  ask_min: number | null;
  ask_median: number | null;
  is_bpc: number;
  runs_modal: number | null;
  updated_at: string;
}

// Shared column list and type-name join for the single-type and full-dump
// paths; each caller appends its own WHERE / ORDER BY clause.
const contractPriceSelect = `
  SELECT cp.type_id, t.name, cp.ask_count, cp.ask_min, cp.ask_median, cp.is_bpc, cp.runs_modal, cp.updated_at
  FROM contract_prices cp
  LEFT JOIN types t ON t.type_id = cp.type_id
`;

/**
 * Public dump of the contract-price rollup: ask
 * aggregates for types that trade only via contracts (faction BPCs above all).
 * Exists both for the LP calculator frontend and as a public dataset — the
 * third-party services publishing this data keep dying.
 */
export async function registerContractPriceRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/api/contract-prices", apiReadRateLimit, async (request, reply) => {
    setContractPricesCacheHeaders(reply);
    const query = request.query as QueryRecord;

    const typeRaw = first(query.type)?.trim();
    if (typeRaw !== undefined && typeRaw !== "") {
      const typeId = parseInteger(typeRaw);
      if (typeId === null) return reply.status(400).send({ error: "invalid_type_id" });
      const row = db
        .prepare(`${contractPriceSelect} WHERE cp.type_id = ?`)
        .get(typeId) as ContractPriceApiRow | undefined;
      if (!row) return reply.status(404).send({ error: "type_not_priced" });
      return { prices: [row] };
    }

    const prices = db
      .prepare(`${contractPriceSelect} ORDER BY cp.type_id`)
      .all() as ContractPriceApiRow[];
    return { count: prices.length, prices };
  });
}
