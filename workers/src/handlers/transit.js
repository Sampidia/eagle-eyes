/**
 * Transit proxy handler.
 * Ported from server/providers/transit.js
 *
 * Proxies GTFS-RT and static GTFS transit feeds to avoid CORS.
 * Public transit agencies publish open feeds; no auth required.
 *
 * Route:
 *   GET /api/transit?feed=<url>&format=json|protobuf
 *     → proxied GTFS or GTFS-RT feed
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const CACHE_TTL_MS = 30_000; // 30 seconds — GTFS-RT updates frequently

const ALLOWED_TRANSIT_HOSTS = [
  // Major transit agencies with open GTFS-RT feeds
  'api.511.org', 'api.wmata.com', 'data.sfmta.com',
  'gtfs.translink.ca', 'opendata.mtaregional.com',
  'developer.wmata.com', 'api.bart.gov', 'data.trilliumtransit.com',
  'opendata.mbtace.com', 'api.mbtace.com', 'cdn.mbta.com',
  'bustime.mta.info', 'gtfsrt.prod.obanyc.com',
  'gtfs.ovapi.nl', 'api.stb.lt', 'api.digitransit.fi',
];

export async function handleTransit(request) {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('feed');
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  if (!feedUrl) return Response.json({ error: 'feed param required' }, { status: 400, headers: noStore });

  let parsedFeed;
  try { parsedFeed = new URL(feedUrl); } catch {
    return Response.json({ error: 'invalid feed URL' }, { status: 400, headers: noStore });
  }

  if (!ALLOWED_TRANSIT_HOSTS.some((h) => parsedFeed.hostname.endsWith(h))) {
    return Response.json({ error: 'transit feed host not in allowlist' }, { status: 403, headers: noStore });
  }

  const cacheKey = `transit:${feedUrl}`;
  const cached = cacheGet(cacheKey, CACHE_TTL_MS);
  if (cached) {
    // For binary (protobuf) responses we store as base64
    if (typeof cached === 'string' && cached.startsWith('b64:')) {
      const buf = Uint8Array.from(atob(cached.slice(4)), (c) => c.charCodeAt(0));
      return new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-GEV-Cache': 'HIT' } });
    }
    return Response.json(cached, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      const data = await res.json();
      cacheSet(cacheKey, data);
      return Response.json(data, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'MISS' } });
    }

    // Binary (protobuf) — pass through
    const buf = await res.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    cacheSet(cacheKey, `b64:${b64}`);
    return new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[transit] fetch failed:', err?.message);
    return Response.json({ error: 'transit feed unavailable' }, { status: 502, headers: noStore });
  }
}
