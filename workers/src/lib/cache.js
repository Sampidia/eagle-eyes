/**
 * Lightweight in-memory cache for the Worker isolate lifetime.
 *
 * Workers are stateless across cold starts, but a warm isolate serving multiple
 * requests within its lifetime benefits from caching upstream responses to
 * avoid hammering rate-limited APIs. TTLs here mirror the original Node.js
 * proxy TTLs from server/providers/*.js.
 *
 * For persistence across cold starts, use Cloudflare KV (see kv.js).
 */

/** @type {Map<string, { at: number, data: unknown }>} */
const _store = new Map();

/**
 * Get a cached value if it exists and is still within TTL.
 * @param {string} key
 * @param {number} ttlMs
 * @returns {unknown | null}
 */
export function cacheGet(key, ttlMs) {
  const entry = _store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) return null;
  return entry.data;
}

/**
 * Store a value in the in-memory cache.
 * @param {string} key
 * @param {unknown} data
 */
export function cacheSet(key, data) {
  _store.set(key, { at: Date.now(), data });
}

/**
 * Return a cached value if fresh, otherwise call fetcher, cache the result
 * and return it. Throws if fetcher throws.
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<unknown>} fetcher
 * @returns {Promise<unknown>}
 */
export async function cacheFetch(key, ttlMs, fetcher) {
  const cached = cacheGet(key, ttlMs);
  if (cached !== null) return cached;
  const fresh = await fetcher();
  cacheSet(key, fresh);
  return fresh;
}

/**
 * Cloudflare KV helpers — used when the GEV_CACHE binding is available.
 * Falls back to the in-memory cache if KV is not bound (e.g. local dev
 * without a KV namespace created yet).
 */

/**
 * Read from KV with a fallback to in-memory.
 * @param {KVNamespace|undefined} kv
 * @param {string} key
 * @param {number} ttlMs
 * @returns {Promise<unknown|null>}
 */
export async function kvGet(kv, key, ttlMs) {
  if (!kv) return cacheGet(key, ttlMs);
  try {
    const raw = await kv.get(key, { type: 'json' });
    if (!raw) return null;
    if (typeof raw?.at === 'number' && Date.now() - raw.at > ttlMs) return null;
    return raw?.data ?? null;
  } catch {
    return cacheGet(key, ttlMs);
  }
}

/**
 * Write to KV and mirror to in-memory.
 * @param {KVNamespace|undefined} kv
 * @param {string} key
 * @param {unknown} data
 * @param {number} ttlSeconds Cloudflare KV expiration in seconds.
 */
export async function kvSet(kv, key, data, ttlSeconds) {
  cacheSet(key, data);
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify({ at: Date.now(), data }), {
      expirationTtl: ttlSeconds,
    });
  } catch {
    // KV write failures are non-fatal — in-memory cache still works
  }
}
