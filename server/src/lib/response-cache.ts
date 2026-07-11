import { compressBrotli } from "./compress.js";

export interface CachedResponse {
  body: Buffer;
  brotli?: Buffer;
  etag: string;
  contentType: string;
}

/**
 * Build a CachedResponse envelope: serialize `value` (strings pass through, others
 * JSON.stringify), precompress with brotli, and attach the etag/contentType. The
 * single builder for the in-process JSON/CSV caches (offers, agents, fits).
 */
export function buildCachedResponse(contentType: string, etag: string, value: unknown): CachedResponse {
  const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return { body, brotli: compressBrotli(body), etag, contentType };
}

/** buildCachedResponse specialized to `application/json; charset=utf-8`. */
export function jsonCachedResponse(value: unknown, etag: string): CachedResponse {
  return buildCachedResponse("application/json; charset=utf-8", etag, value);
}

interface CacheEntry {
  value?: CachedResponse;
  pending?: Promise<CachedResponse>;
  expiresAt: number;
}

export interface ResponseCacheOptions {
  maxEntries: number;
  ttlMs: number;
}

export class ResponseCache<K = string> {
  private readonly entries = new Map<K, CacheEntry>();

  constructor(private readonly options: ResponseCacheOptions) {}

  peek(key: K): CachedResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    if (entry.value) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry.value;
  }

  async getOrCreate(key: K, fill: () => Promise<CachedResponse> | CachedResponse): Promise<CachedResponse> {
    const cached = this.peek(key);
    if (cached) return cached;

    const existing = this.entries.get(key);
    if (existing?.pending && existing.expiresAt > Date.now()) return existing.pending;

    const expiresAt = Date.now() + this.options.ttlMs;
    const pending = Promise.resolve()
      .then(fill)
      .then((value) => {
        this.entries.set(key, { value, expiresAt });
        this.evict();
        return value;
      })
      .catch((error) => {
        this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, { pending, expiresAt });
    this.evict();
    return pending;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

const registeredCaches = new Set<ResponseCache<any>>();

export function registerResponseCache(cache: ResponseCache<any>): void {
  registeredCaches.add(cache);
}

export function clearResponseCaches(): void {
  for (const cache of registeredCaches) cache.clear();
}
