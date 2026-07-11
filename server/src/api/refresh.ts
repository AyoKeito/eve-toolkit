import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { loadConfig } from "../config.js";
import { recomputeAndPersist } from "../calc/ratio.js";
import { clearComputeDirtyIfUnchanged, readComputeDirty } from "../lib/compute-generation.js";
import { RefreshLockBusyError, withRefreshLock } from "../lib/refresh-lock.js";

export function tokenMatches(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string") return false;
  const received = Buffer.from(header);
  const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

export async function registerRefreshRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.post("/api/refresh", async (request, reply) => {
    const config = loadConfig({ requireAdminToken: true });
    if (!tokenMatches(request.headers["x-admin-token"], config.adminToken)) {
      reply.status(401);
      return { error: "unauthorized" };
    }
    try {
      const rows = await withRefreshLock({ job: "api:refresh", waitMs: 0 }, () => {
        const observedDirty = readComputeDirty(db);
        const count = recomputeAndPersist(db);
        if (observedDirty) clearComputeDirtyIfUnchanged(db, observedDirty.seq);
        return count;
      });
      return { status: "ok", rows };
    } catch (error) {
      if (error instanceof RefreshLockBusyError) {
        reply.status(409);
        return {
          error: "refresh_busy",
          lock_owner: error.owner
            ? {
                acquired_at: error.owner.acquired_at,
                hostname: error.owner.hostname,
                job: error.owner.job,
                pid: error.owner.pid
              }
            : null
        };
      }
      throw error;
    }
  });
}
