import { brotliCompressSync, constants } from "node:zlib";

// Brotli quality 11 (the zlib default) is an exponential cliff: on the materialized
// response bodies it costs ~11.4s vs ~110ms at quality 6 — a 100x slowdown for ~19%
// smaller output. That compression runs synchronously on the single main thread, so
// quality 11 froze the whole server for ~11s on every recompute. These bodies are
// edge-cached (CDN s-maxage), so the extra KB never reaches most clients; the freeze
// did. Quality 6 sits below the cliff at near-max ratio. Overridable for tuning.
const BROTLI_QUALITY = clampQuality(Number.parseInt(process.env.BROTLI_QUALITY ?? "", 10), 6);

function clampQuality(value: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(11, Math.max(0, value));
}

export function compressBrotli(body: Buffer): Buffer {
  return brotliCompressSync(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length
    }
  });
}
