import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { logDir as defaultLogDir } from "../config.js";
import { errorMessage } from "./parse.js";

export const requestIdHeader = "x-request-id";
export const clientIdHeader = "x-eve-client-id";

export interface RequestObservabilityOptions {
  echo?: boolean;
  logDir?: string;
  problemStatusCode?: number;
}

const requestIds = new WeakMap<FastifyRequest, string>();
const clientIds = new WeakMap<FastifyRequest, string>();
const requestStarts = new WeakMap<FastifyRequest, number>();
const requestErrors = new WeakMap<FastifyRequest, string>();

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createRequestId(): string {
  return `req_${crypto.randomBytes(12).toString("base64url")}`;
}

export function sanitizeDiagnosticId(value: unknown): string | undefined {
  if (Array.isArray(value)) return sanitizeDiagnosticId(value[0]);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{6,96}$/.test(trimmed) ? trimmed : undefined;
}

function durationMs(request: FastifyRequest): number {
  const started = requestStarts.get(request);
  return started ? Date.now() - started : 0;
}

const maxLogFieldLength = 512;

function capField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > maxLogFieldLength ? value.slice(0, maxLogFieldLength) : value;
}

function problemLogEntry(request: FastifyRequest, statusCode: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    component: "http",
    event: "problem",
    request_id: requestIds.get(request) ?? sanitizeDiagnosticId(request.id) ?? createRequestId(),
    client_id: clientIds.get(request),
    method: request.method,
    url: capField(request.url),
    route: request.routeOptions.url,
    status: statusCode,
    duration_ms: durationMs(request),
    ip: request.ip,
    user_agent: capField(firstHeader(request.headers["user-agent"])),
    referer: capField(firstHeader(request.headers.referer))
  };
  const error = requestErrors.get(request);
  if (error) entry.error = error;
  return entry;
}

// Problem-log writes happen off the response path (onResponse fires after the
// reply is sent), so we use async fs and never block the event loop. Writes are
// chained so concurrent problem responses can't interleave a partial line, and
// `flushProblemLogs` lets tests await all in-flight writes deterministically.
let pendingProblemLogs: Promise<unknown> = Promise.resolve();

export function flushProblemLogs(): Promise<unknown> {
  return pendingProblemLogs;
}

function writeProblemLog(logDir: string, entry: Record<string, unknown>): Promise<void> {
  const op = (async () => {
    await fs.promises.mkdir(logDir, { recursive: true });
    await fs.promises.appendFile(path.join(logDir, "http-problems.log"), `${JSON.stringify(entry)}\n`, "utf8");
  })();
  // Track every write (even failing ones) so flushProblemLogs awaits them all.
  pendingProblemLogs = Promise.allSettled([pendingProblemLogs, op]);
  return op;
}

export async function registerRequestObservability(
  app: FastifyInstance,
  options: RequestObservabilityOptions = {}
): Promise<void> {
  const echo = options.echo ?? true;
  const logDir = options.logDir ?? defaultLogDir;
  const problemStatusCode = options.problemStatusCode ?? 400;

  app.addHook("onRequest", async (request, reply) => {
    const requestId = sanitizeDiagnosticId(request.id) ?? createRequestId();
    const clientId = sanitizeDiagnosticId(request.headers[clientIdHeader]);
    requestStarts.set(request, Date.now());
    requestIds.set(request, requestId);
    if (clientId) clientIds.set(request, clientId);
    reply.header("X-Request-Id", requestId);
  });

  app.addHook("onError", async (request, _reply, error) => {
    requestErrors.set(request, errorMessage(error));
  });

  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < problemStatusCode) return;
    const entry = problemLogEntry(request, reply.statusCode);
    // Enqueue synchronously (before any await) so flushProblemLogs sees it.
    const op = writeProblemLog(logDir, entry);
    try {
      await op;
      if (echo) {
        if (reply.statusCode >= 500) {
          request.log.error(entry, "http problem");
        } else {
          request.log.warn(entry, "http problem");
        }
      }
    } catch (error) {
      request.log.error({ error }, "http problem logging failed");
    }
  });
}
