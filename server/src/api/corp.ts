import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { listOfferCalcs, summarizeOfferCalc } from "../calc/ratio.js";
import { apiReadRateLimit } from "../lib/cors.js";
import { currentComputeGeneration, computeGenerationEtag } from "../lib/compute-generation.js";
import { sendCachedResponse, setApiCacheHeaders } from "../lib/api-cache-headers.js";
import { canonicalCorps, readMaterializedResponse, responseCacheKey } from "../lib/response-materialize.js";
import { parseOfferQuery } from "./query.js";
import { parseNonNegativeInteger } from "../lib/parse.js";

export async function registerCorpRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/api/corps", apiReadRateLimit, async (request, reply) => {
    const materialized = readMaterializedResponse(db, responseCacheKey("/api/corps", {}));
    if (materialized) return sendCachedResponse(request, reply, materialized);
    setApiCacheHeaders(reply, computeGenerationEtag(currentComputeGeneration(db)));
    return canonicalCorps(db);
  });

  app.get<{ Params: { id: string } }>("/api/corp/:id", apiReadRateLimit, async (request, reply) => {
    setApiCacheHeaders(reply, computeGenerationEtag(currentComputeGeneration(db)));
    const corpId = parseNonNegativeInteger(request.params.id);
    if (corpId === null) {
      reply.status(400);
      return { error: "invalid_corp_id" };
    }
    const corp = db
      .prepare("SELECT * FROM corporations WHERE corp_id=? AND has_lp_store=1 AND has_earnable_lp_source=1")
      .get(corpId);
    if (!corp) {
      reply.status(404);
      return { error: "not_found" };
    }
    const query = parseOfferQuery(request);
    const rows = listOfferCalcs(db, { ...query, corp: corpId }).map((row) => summarizeOfferCalc(row, query.basis));
    return { corp, rows };
  });
}
