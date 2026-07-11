import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { parseIntegerEnv } from "../config.js";

export const apiReadRateLimitMax = 180;

export const apiReadRateLimit = {
  config: {
    rateLimit: {
      groupId: "api-read"
    }
  }
};

export function readRateLimitMax(): number {
  const max = parseIntegerEnv("API_READ_RATE_LIMIT_MAX", apiReadRateLimitMax);
  return max > 0 ? max : apiReadRateLimitMax;
}

export async function registerCors(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, X-EVE-Client-Id, X-Admin-Token");
    reply.header("Access-Control-Expose-Headers", "X-Request-Id, Retry-After");

    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });
}

export async function registerApiRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: true,
    max: readRateLimitMax(),
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
    allowList: (request) => !/^\/(?:lp\/)?api\//.test(request.url)
  });
}
