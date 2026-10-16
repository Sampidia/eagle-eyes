/**
 * Cyclone data handler.
 * Ported from server/providers/cyclones.js
 *
 * Fetches active tropical cyclone data from NOAA's National Hurricane Center.
 * Cached at 30-minute TTL.
 *
 * Route:
 *   GET /api/cyclones  → {cyclones: [...], fetchedAt, count}
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const CACHE_TTL_MS = 30 * 60_000;
// NOAA NHC GeoJSON feeds (public, no auth, no CORS on server)
const NHC_FEEDS = [
  'https://www.nhc.noaa.gov/CurrentStorms.json',
];

export async function handleCyclones() {
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  const cached = cacheGet('cyclones:active', CACHE_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const res = await fetch(NHC_FEEDS[0], { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`NHC HTTP ${res.status}`);
    const data = await res.json();

    // NHC returns { activeStorms: [...] }
    const cyclones = Array.isArray(data?.activeStorms) ? data.activeStorms : [];
    const payload = { cyclones, count: cyclones.length, fetchedAt: Date.now(), source: 'NOAA NHC' };
    cacheSet('cyclones:active', payload);
    return Response.json(payload, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[cyclones] fetch failed:', err?.message);
    const stale = cacheGet('cyclones:active', Infinity);
    if (stale) return Response.json(stale, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE' } });
    return Response.json({ cyclones: [], count: 0, error: 'cyclone data unavailable', fetchedAt: null }, { status: 502, headers: noStore });
  }
}
