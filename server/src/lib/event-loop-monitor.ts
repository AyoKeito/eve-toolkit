import { performance } from "node:perf_hooks";

export interface EventLoopMonitorOptions {
  /** Tick cadence; drift beyond this is a stall. Default 250ms. */
  intervalMs?: number;
  /** Log stalls at or above this. Default 250ms (env EVENT_LOOP_STALL_MS overrides). */
  stallThresholdMs?: number;
  log?: (line: string) => void;
}

/**
 * Logs event-loop stalls. better-sqlite3 is synchronous and the server is single-
 * threaded, so any long synchronous op (a big write transaction, a full-catalog
 * recompute, a large JSON build/compress) freezes request serving for its whole
 * duration. A periodic timer measures its own scheduling drift: if a tick lands far
 * later than scheduled, the loop was blocked in between. One JSON line per stall,
 * correlatable by timestamp with recompute/snapshot/fetcher logs.
 */
export function startEventLoopMonitor(options: EventLoopMonitorOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 250;
  const envThreshold = Number.parseInt(process.env.EVENT_LOOP_STALL_MS ?? "", 10);
  const threshold = options.stallThresholdMs ?? (Number.isInteger(envThreshold) && envThreshold > 0 ? envThreshold : 250);
  const log = options.log ?? ((line: string) => console.warn(line));

  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const stall = now - last - intervalMs;
    if (stall >= threshold) {
      log(JSON.stringify({ component: "event-loop-stall", stall_ms: Math.round(stall), at: new Date().toISOString() }));
    }
    last = now;
  }, intervalMs);
  // Never keep the process alive for the monitor alone.
  timer.unref();
  return () => clearInterval(timer);
}
