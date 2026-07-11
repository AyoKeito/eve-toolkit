import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { createRequestId, flushProblemLogs, registerRequestObservability } from "../src/lib/request-observability.js";

function tempLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eve-http-problems-"));
}

async function readProblemLog(logDir: string): Promise<Array<Record<string, unknown>>> {
  await flushProblemLogs();
  const logPath = path.join(logDir, "http-problems.log");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("request observability stamps a fresh request id and ignores spoofed request ids", async () => {
  const app = Fastify({ genReqId: createRequestId, requestIdHeader: false });
  await registerRequestObservability(app, { logDir: tempLogDir(), echo: false });
  app.get("/api/ping", async () => ({ ok: true }));

  const first = await app.inject({ method: "GET", url: "/api/ping", headers: { "x-request-id": "spoofed" } });
  const second = await app.inject({ method: "GET", url: "/api/ping", headers: { "x-request-id": "spoofed" } });

  assert.match(String(first.headers["x-request-id"]), /^req_[A-Za-z0-9_-]{16,}$/);
  assert.match(String(second.headers["x-request-id"]), /^req_[A-Za-z0-9_-]{16,}$/);
  assert.notEqual(first.headers["x-request-id"], "spoofed");
  assert.notEqual(second.headers["x-request-id"], "spoofed");
  assert.notEqual(first.headers["x-request-id"], second.headers["x-request-id"]);

  await app.close();
});

test("request observability writes problem responses with client and request ids", async () => {
  const logDir = tempLogDir();
  const app = Fastify({
    genReqId: () => "req_testproblem123456",
    requestIdHeader: false,
    trustProxy: false
  });
  await registerRequestObservability(app, { logDir, echo: false });
  app.get("/api/fail", async (_request, reply) => reply.status(503).send({ error: "unavailable" }));

  const response = await app.inject({
    method: "GET",
    url: "/api/fail?corp=1000137",
    headers: {
      "user-agent": "node-test",
      referer: "https://example.test/lp/",
      "x-eve-client-id": "cli_testclient123456"
    }
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers["x-request-id"], "req_testproblem123456");

  const [entry] = await readProblemLog(logDir);
  assert.deepEqual(
    {
      component: entry?.component,
      event: entry?.event,
      request_id: entry?.request_id,
      client_id: entry?.client_id,
      method: entry?.method,
      url: entry?.url,
      status: entry?.status,
      user_agent: entry?.user_agent,
      referer: entry?.referer
    },
    {
      component: "http",
      event: "problem",
      request_id: "req_testproblem123456",
      client_id: "cli_testclient123456",
      method: "GET",
      url: "/api/fail?corp=1000137",
      status: 503,
      user_agent: "node-test",
      referer: "https://example.test/lp/"
    }
  );
  assert.equal(typeof entry?.duration_ms, "number");
  assert.equal(typeof entry?.ip, "string");

  await app.close();
});

test("request observability does not log successful responses or invalid client ids", async () => {
  const logDir = tempLogDir();
  const app = Fastify({ genReqId: () => "req_success123456789", requestIdHeader: false });
  await registerRequestObservability(app, { logDir, echo: false });
  app.get("/api/ping", async () => ({ ok: true }));
  app.get("/api/bad", async (_request, reply) => reply.status(404).send({ error: "not_found" }));

  await app.inject({ method: "GET", url: "/api/ping", headers: { "x-eve-client-id": "cli_valid123456789" } });
  await app.inject({ method: "GET", url: "/api/bad", headers: { "x-eve-client-id": "../not-a-client" } });

  const entries = await readProblemLog(logDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.status, 404);
  assert.equal("client_id" in (entries[0] ?? {}), false);

  await app.close();
});

test("request observability caps url, user-agent, and referer fields at 512 characters", async () => {
  const logDir = tempLogDir();
  const app = Fastify({ genReqId: () => "req_cap1234567890123", requestIdHeader: false });
  await registerRequestObservability(app, { logDir, echo: false });
  app.get("/api/probe", async (_request, reply) => reply.status(400).send({ error: "bad_request" }));

  const longValue = "A".repeat(1024);
  await app.inject({
    method: "GET",
    url: `/api/probe?q=${longValue}`,
    headers: {
      "user-agent": longValue,
      referer: longValue
    }
  });

  const [entry] = await readProblemLog(logDir);
  assert.ok(entry, "log entry present");
  assert.ok(typeof entry.url === "string" && entry.url.length <= 512, "url capped to 512");
  assert.ok(typeof entry.user_agent === "string" && entry.user_agent.length <= 512, "user_agent capped to 512");
  assert.ok(typeof entry.referer === "string" && entry.referer.length <= 512, "referer capped to 512");

  await app.close();
});

test("request observability writes log entries asynchronously without blocking", async () => {
  const logDir = tempLogDir();
  const app = Fastify({ genReqId: () => "req_async123456789", requestIdHeader: false });
  await registerRequestObservability(app, { logDir, echo: false });
  app.get("/api/async-probe", async (_request, reply) => reply.status(500).send({ error: "internal" }));

  // Fire multiple concurrent requests; all entries must be present after settling
  const requests = Array.from({ length: 5 }, () =>
    app.inject({ method: "GET", url: "/api/async-probe" })
  );
  const responses = await Promise.all(requests);
  for (const response of responses) {
    assert.equal(response.statusCode, 500);
  }

  const entries = await readProblemLog(logDir);
  assert.equal(entries.length, 5, "all 5 problem entries written");
  for (const entry of entries) {
    assert.equal(entry.status, 500);
  }

  await app.close();
});

test("request observability records thrown route errors without leaking request bodies", async () => {
  const logDir = tempLogDir();
  const app = Fastify({ genReqId: () => "req_throw1234567890", requestIdHeader: false });
  await registerRequestObservability(app, { logDir, echo: false });
  app.post("/api/boom", async () => {
    throw new Error("database unavailable");
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/boom",
    headers: { "content-type": "application/json" },
    payload: { adminToken: "secret", value: "sensitive" }
  });

  assert.equal(response.statusCode, 500);
  const [entry] = await readProblemLog(logDir);
  assert.equal(entry?.error, "database unavailable");
  assert.equal("body" in (entry ?? {}), false);
  assert.equal(JSON.stringify(entry).includes("secret"), false);

  await app.close();
});
