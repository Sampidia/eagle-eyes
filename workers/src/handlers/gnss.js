/**
 * GNSS integrity proxy handler.
 * Ported from server/providers/gnssIntegrity.js
 *
 * Fetches GPS/GNSS signal integrity data from public sources.
 * Cached at 5-minute TTL.
 *
 * Route:
 *   GET /api/gnss  → {regions: [...], fetchedAt, source}
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const CACHE_TTL_MS = 5 * 60_000;

// GPSJam.org provides GNSS interference data as GeoJSON (public, no auth)
const GPSJAM_URL = 'https://gpsjam.org/geo.json';

export async function handleGnss() {
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  const cached = cacheGet('gnss:integrity', CACHE_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const res = await fetch(GPSJAM_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GPSJam HTTP ${res.status}`);
    const data = await res.json();

    const payload = {
      type: data?.type ?? 'FeatureCollection',
      features: data?.features ?? [],
      count: data?.features?.length ?? 0,
      fetchedAt: Date.now(),
      source: 'GPSJam.org',
    };
    cacheSet('gnss:integrity', payload);
    return Response.json(payload, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[gnss] fetch failed:', err?.message);
    const stale = cacheGet('gnss:integrity', Infinity);
    if (stale) return Response.json(stale, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE' } });
    return Response.json({ features: [], count: 0, error: 'GNSS data unavailable', fetchedAt: null }, { status: 502, headers: noStore });
  }
}
