/**
 * Military installations proxy handler.
 * Ported from server/providers/military-installations.js
 *
 * Fetches military installation boundaries from OpenStreetMap via Overpass.
 * Results are cached at 24-hour TTL (installations don't change often).
 *
 * Route:
 *   GET /api/military?bbox=minLon,minLat,maxLon,maxLat
 *     → {installations: [...], count, fetchedAt}
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const TTL_MS = 24 * 3_600_000; // 24 hours
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const ELEMENT_CAP = 500;

function buildQuery(minLon, minLat, maxLon, maxLat) {
  // Quantize to 0.25° grid to maximize cache hits for nearby views
  const q = (v, r) => (Math.round(v / r) * r).toFixed(2);
  const bbox = `${q(minLat, 0.25)},${q(minLon, 0.25)},${q(maxLat, 0.25)},${q(maxLon, 0.25)}`;
  return `[out:json][timeout:50];(relation["landuse"="military"](${bbox});way["landuse"="military"](${bbox}););out geom ${ELEMENT_CAP};`;
}

export async function handleMilitary(request) {
  const url = new URL(request.url);
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  const bbox = url.searchParams.get('bbox') ?? '';
  const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);

  if ([minLon, minLat, maxLon, maxLat].some((v) => !Number.isFinite(v))) {
    return Response.json({ error: 'bbox param required: minLon,minLat,maxLon,maxLat' }, { status: 400, headers: noStore });
  }

  const cacheKey = `military:${buildQuery(minLon, minLat, maxLon, maxLat).slice(0, 80)}`;
  const cached = cacheGet(cacheKey, TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const query = buildQuery(minLon, minLat, maxLon, maxLat);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(55_000),
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const data = await res.json();
    const payload = {
      installations: data?.elements ?? [],
      count: data?.elements?.length ?? 0,
      fetchedAt: Date.now(),
      bbox: { minLon, minLat, maxLon, maxLat },
    };
    cacheSet(cacheKey, payload);
    return Response.json(payload, { headers: { 'Cache-Control': `public, max-age=${Math.floor(TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[military] fetch failed:', err?.message);
    const stale = cacheGet(cacheKey, Infinity);
    if (stale) return Response.json(stale, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE' } });
    return Response.json({ error: 'military installations unavailable', installations: [], count: 0 }, { status: 502, headers: noStore });
  }
}
