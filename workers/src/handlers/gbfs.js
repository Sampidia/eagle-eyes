/**
 * GBFS bike-share handler.
 * Ported from server/providers/gbfs.js
 *
 * Proxies General Bikeshare Feed Specification (GBFS) data from public
 * city feeds. GBFS feeds require no authentication and are public JSON,
 * but some have CORS restrictions.
 *
 * Route:
 *   GET /api/gbfs?feed=<url>  → proxied GBFS feed JSON
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const CACHE_TTL_MS = 60_000; // 1 minute — bike positions update frequently

// Allowlist of known GBFS feed URL patterns (prevent open proxy abuse)
const ALLOWED_GBFS_HOSTS = [
  'gbfs.lyft.com', 'gbfs.bird.co', 'gbfs.lime.bike',
  'gbfs.citibikenyc.com', 'gbfs.spin.pm', 'data.lime.bike',
  'gbfs.divvybikes.com', 'gbfs.bluebikes.com', 'gbfs.capitalbikeshare.com',
  'gbfs.baywheels.com', 'gbfs.bluebikes.com', 'gbfs.cogo.com',
  'mds.bird.co', 'gbfs.niceridefm.com', 'feeds.urbansharing.com',
  'api.bcycle.com', 'gbfs.veoride.com',
];

export async function handleGbfs(request) {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('feed');
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  if (!feedUrl) return Response.json({ error: 'feed param required' }, { status: 400, headers: noStore });

  let parsedFeed;
  try { parsedFeed = new URL(feedUrl); } catch {
    return Response.json({ error: 'invalid feed URL' }, { status: 400, headers: noStore });
  }

  if (!ALLOWED_GBFS_HOSTS.some((h) => parsedFeed.hostname.endsWith(h))) {
    return Response.json({ error: 'GBFS feed host not in allowlist' }, { status: 403, headers: noStore });
  }

  const cacheKey = `gbfs:${feedUrl}`;
  const cached = cacheGet(cacheKey, CACHE_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cacheSet(cacheKey, data);
    return Response.json(data, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[gbfs] fetch failed:', err?.message);
    const stale = cacheGet(cacheKey, Infinity);
    if (stale) return Response.json(stale, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE' } });
    return Response.json({ error: 'GBFS feed unavailable' }, { status: 502, headers: noStore });
  }
}
