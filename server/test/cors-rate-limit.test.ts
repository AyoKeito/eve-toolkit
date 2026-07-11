import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { apiReadRateLimit, readRateLimitMax, registerApiRateLimit, registerCors } from "../src/lib/cors.js";

test("read rate limit ignores spoofed X-Forwarded-For when trustProxy is disabled", async () => {
  const app = Fastify({ trustProxy: false });
  await registerCors(app);
  await registerApiRateLimit(app);
  app.get("/api/ping", apiReadRateLimit, async () => ({ ok: true }));

  for (let index = 0; index < 180; index += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { "x-forwarded-for": `203.0.113.${index}` }
    });
    assert.equal(response.statusCode, 200);
  }

  const limited = await app.inject({
    method: "GET",
    url: "/api/ping",
    headers: { "x-forwarded-for": "203.0.113.250" }
  });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers["retry-after"]);
  assert.equal(limited.headers["x-ratelimit-limit"], "180");

  await app.close();
});

test("cors allows diagnostic client ids and exposes request ids", async () => {
  const app = Fastify({ trustProxy: false });
  await registerCors(app);
  app.get("/api/ping", async (_request, reply) => {
    reply.header("X-Request-Id", "req_test123456789");
    return { ok: true };
  });

  const options = await app.inject({
    method: "OPTIONS",
    url: "/api/ping",
    headers: { "access-control-request-headers": "X-EVE-Client-Id" }
  });
  assert.equal(options.statusCode, 204);
  assert.match(String(options.headers["access-control-allow-headers"]), /X-EVE-Client-Id/);
  assert.match(String(options.headers["access-control-expose-headers"]), /X-Request-Id/);

  const response = await app.inject({ method: "GET", url: "/api/ping" });
  assert.match(String(response.headers["access-control-expose-headers"]), /X-Request-Id/);

  await app.close();
});

test("read rate limit max can be overridden from environment", async () => {
  const original = process.env.API_READ_RATE_LIMIT_MAX;
  process.env.API_READ_RATE_LIMIT_MAX = "3";
  const app = Fastify({ trustProxy: false });
  await registerCors(app);
  await registerApiRateLimit(app);
  app.get("/api/ping", apiReadRateLimit, async () => ({ ok: true }));

  try {
    assert.equal(readRateLimitMax(), 3);
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({ method: "GET", url: "/api/ping" });
      assert.equal(response.statusCode, 200);
    }

    const limited = await app.inject({ method: "GET", url: "/api/ping" });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["x-ratelimit-limit"], "3");
  } finally {
    if (original === undefined) delete process.env.API_READ_RATE_LIMIT_MAX;
    else process.env.API_READ_RATE_LIMIT_MAX = original;
    await app.close();
  }
});

test("non-api routes are not read-rate limited", async () => {
  const app = Fastify();
  await registerCors(app);
  await registerApiRateLimit(app);
  app.get("/status", async () => ({ ok: true }));

  for (let index = 0; index < 185; index += 1) {
    const response = await app.inject({ method: "GET", url: "/status" });
    assert.equal(response.statusCode, 200);
  }

  await app.close();
});

test("unconfigured GET API routes still receive the shared read rate limit", async () => {
  const app = Fastify({ trustProxy: false });
  await registerCors(app);
  await registerApiRateLimit(app);
  app.get("/api/accidental", async () => ({ ok: true }));

  for (let index = 0; index < 180; index += 1) {
    const response = await app.inject({ method: "GET", url: "/api/accidental" });
    assert.equal(response.statusCode, 200);
  }

  const limited = await app.inject({ method: "GET", url: "/api/accidental" });
  assert.equal(limited.statusCode, 429);

  await app.close();
});

test("LP-prefixed API routes receive the shared read rate limit", async () => {
  const app = Fastify({ trustProxy: false });
  await registerCors(app);
  await registerApiRateLimit(app);
  app.get("/lp/api/ping", async () => ({ ok: true }));

  for (let index = 0; index < 180; index += 1) {
    const response = await app.inject({ method: "GET", url: "/lp/api/ping" });
    assert.equal(response.statusCode, 200);
  }

  const limited = await app.inject({ method: "GET", url: "/lp/api/ping" });
  assert.equal(limited.statusCode, 429);

  await app.close();
});

test("POST /api/refresh is rate-limited after sustained flooding from one IP", async () => {
  const app = Fastify({ trustProxy: false });
  await registerCors(app);
  await registerApiRateLimit(app);
  // Stub the refresh route — auth is irrelevant for the rate-limit test
  app.post("/api/refresh", async (_request, reply) => reply.status(401).send({ error: "unauthorized" }));

  let limited = false;
  for (let index = 0; index <= 180; index += 1) {
    const response = await app.inject({ method: "POST", url: "/api/refresh" });
    if (response.statusCode === 429) {
      limited = true;
      assert.ok(response.headers["retry-after"], "retry-after header present on 429");
      break;
    }
  }
  assert.ok(limited, "POST /api/refresh should be rate-limited after flooding");

  await app.close();
});
