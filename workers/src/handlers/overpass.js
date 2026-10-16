/**
 * Overpass API proxy handler.
 * Ported from server/providers/overpass.js
 *
 * Routes Overpass QL queries through the Worker to avoid browser CORS
 * restrictions and to allow use of custom Overpass instances via
 * OVERPASS_UPSTREAMS env var.
 *
 * Route:
 *   POST /api/overpass  → body: {query: string} → Overpass JSON response
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

// Public Overpass instances — the first healthy one is used
const DEFAULT_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes — OSM data changes slowly
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MB

function resolveUpstreams(env) {
  const custom = String(env.OVERPASS_UPSTREAMS || '').trim();
  if (custom) {
    const urls = custom.split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length > 0) return urls;
  }
  return DEFAULT_UPSTREAMS;
}

async function queryOverpass(upstreams, query) {
  let lastErr;
  for (const upstream of upstreams) {
    try {
      const res = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(55_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Size-cap the response
      const reader = res.body?.getReader();
      if (!reader) throw new Error('no response body');
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) { reader.cancel(); throw new Error('response too large'); }
        chunks.push(value);
      }
      const buffer = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder().decode(buffer);
    } catch (err) {
      console.warn(`[overpass] ${upstream} failed:`, err?.message);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('all Overpass upstreams failed');
}

export async function handleOverpass(request, env) {
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  if (request.method !== 'POST') {
    return Response.json({ error: 'POST required' }, { status: 405, headers: noStore });
  }

  let query;
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_QUERY_BYTES) {
      return Response.json({ error: 'query too large' }, { status: 413, headers: noStore });
    }
    const body = JSON.parse(new TextDecoder().decode(buffer));
    query = String(body?.query || '').trim();
  } catch {
    return Response.json({ error: 'invalid JSON body — expected {query: string}' }, { status: 400, headers: noStore });
  }

  if (!query) return Response.json({ error: 'query field required' }, { status: 400, headers: noStore });

  // Cache based on query fingerprint (simple hash via btoa for short queries)
  const cacheKey = `overpass:${btoa(query).slice(0, 64)}`;
  const cached = cacheGet(cacheKey, CACHE_TTL_MS);
  if (cached) {
    return new Response(cached, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const upstreams = resolveUpstreams(env);
    const result = await queryOverpass(upstreams, query);
    cacheSet(cacheKey, result);
    return new Response(result, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[overpass] query failed:', err?.message);
    return Response.json({ error: `Overpass query failed: ${err?.message}` }, { status: 502, headers: noStore });
  }
}
