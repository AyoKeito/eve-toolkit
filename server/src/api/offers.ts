import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { calculateOffer, createOfferCalcMemo, DEFAULT_LP_PER_HOUR, getMarketSnapshot, listOfferCalcs, summarizeOfferCalc } from "../calc/ratio.js";
import { apiReadRateLimit } from "../lib/cors.js";
import { currentComputeGeneration, responseEtag } from "../lib/compute-generation.js";
import { sendCachedResponse, setApiCacheHeaders } from "../lib/api-cache-headers.js";
import { readMaterializedResponse, responseCacheKey, offerRowsToCsv } from "../lib/response-materialize.js";
import { buildCachedResponse, registerResponseCache, ResponseCache } from "../lib/response-cache.js";
import { parseOfferQuery } from "./query.js";
import { parseNonNegativeInteger } from "../lib/parse.js";

const listResponseCache = new ResponseCache<string>({ maxEntries: 200, ttlMs: 15 * 60 * 1000 });
const detailResponseCache = new ResponseCache<string>({ maxEntries: 500, ttlMs: 15 * 60 * 1000 });
registerResponseCache(listResponseCache as ResponseCache<unknown>);
registerResponseCache(detailResponseCache as ResponseCache<unknown>);

export async function registerOfferRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/api/offers/top", apiReadRateLimit, async (request, reply) => {
    const query = parseOfferQuery(request);
    const key = responseCacheKey("/api/offers/top", query);
    const generation = currentComputeGeneration(db);
    // ETag fingerprints the served body: query shape (key) + the lpPerHour post-hoc
    // rewrite, so a replayed If-None-Match can never 304 onto a different-param body.
    // Normalize lpPerHour to the same signature the rewrite treats as default (absent
    // or 30000 → no rewrite), so equivalent bodies share an ETag.
    const lphSig = query.lpPerHour === undefined || query.lpPerHour === DEFAULT_LP_PER_HOUR ? "" : String(query.lpPerHour);
    const etag = responseEtag(generation, `${key}|lph=${lphSig}`);
    const materialized = readMaterializedResponse(db, key);
    if (materialized) return sendCachedResponse(request, reply, materialized, { lpPerHour: query.lpPerHour, basis: query.basis, etag });

    const cacheQuery = { ...query, lpPerHour: DEFAULT_LP_PER_HOUR };
    const cached = await listResponseCache.getOrCreate(`${generation}:${key}`, () =>
      buildCachedResponse("application/json; charset=utf-8", etag, {
        rows: listOfferCalcs(db, cacheQuery).map((row) => summarizeOfferCalc(row, query.basis))
      })
    );
    return sendCachedResponse(request, reply, cached, { lpPerHour: query.lpPerHour, basis: query.basis, etag });
  });

  app.get("/api/offers/top.csv", apiReadRateLimit, async (request, reply) => {
    const query = parseOfferQuery(request);
    const key = responseCacheKey("/api/offers/top.csv", query);
    const contentDisposition = "attachment; filename=lp-offers.csv";
    const generation = currentComputeGeneration(db);
    // CSV has no lpPerHour rewrite, so the query-shape key fully determines the body.
    const etag = responseEtag(generation, key);
    const materialized = readMaterializedResponse(db, key);
    if (materialized) return sendCachedResponse(request, reply, materialized, { contentDisposition, etag });

    const cached = await listResponseCache.getOrCreate(`${generation}:${key}`, () => {
      const rows = listOfferCalcs(db, query).map((row) => summarizeOfferCalc(row, query.basis));
      return buildCachedResponse("text/csv; charset=utf-8", etag, offerRowsToCsv(rows));
    });
    return sendCachedResponse(request, reply, cached, { contentDisposition, etag });
  });

  app.get<{ Params: { id: string } }>("/api/offers/:id", apiReadRateLimit, async (request, reply) => {
    const offerId = parseNonNegativeInteger(request.params.id);
    if (offerId === null) {
      reply.status(400);
      return { error: "invalid_offer_id" };
    }
    const generation = currentComputeGeneration(db);
    const query = parseOfferQuery(request);
    const key = `${generation}:/api/offers/${offerId}:${responseCacheKey("", query)}:lph=${query.lpPerHour}`;
    // The detail key already encodes generation + offerId + query + lpPerHour, so it
    // is the exact body signature.
    const etag = responseEtag(generation, key);

    const cached = detailResponseCache.peek(key);
    if (cached) return sendCachedResponse(request, reply, cached, { etag });

    // Resolve the offer before populating the cache so a missing offer yields a
    // fresh 404 each time, instead of poisoning the cache with a not_found body.
    const row = calculateOffer(db, offerId, query, createOfferCalcMemo(getMarketSnapshot(db)));
    if (!row) {
      setApiCacheHeaders(reply, etag);
      reply.status(404);
      return { error: "not_found" };
    }

    const response = await detailResponseCache.getOrCreate(key, () =>
      buildCachedResponse("application/json; charset=utf-8", etag, row)
    );
    return sendCachedResponse(request, reply, response, { etag });
  });
}
