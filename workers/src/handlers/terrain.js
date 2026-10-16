/**
 * Terrain heights handler.
 * Ported from server/providers/terrain.js
 *
 * Proxies lon/lat → ellipsoidal height lookups to Re:Earth terrain API.
 * Results are cached in-memory with a 30-day TTL (terrain doesn't move).
 * Requests are chunked at 64 points per call to match upstream latency limits.
 *
 * Route:
 *   GET /api/terrain/heights?points=lon,lat;lon,lat;...
 *     → {results: [{longitude, latitude, height},...], omitted: number}
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const TTL_MS = 30 * 24 * 3_600_000; // 30 days
const CHUNK  = 64;
const MAX_POINTS = 2000;
const REEARTH_URL = 'https://terrain.reearth.land/heights.json';

/** Parse "lon,lat;lon,lat;..." into [[lon,lat],...] or null. */
function parsePoints(raw) {
  if (!raw) return null;
  const pairs = raw.split(';').map((p) => p.split(',').map(Number));
  if (pairs.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat))) return null;
  return pairs;
}

/** Canonical cache key for a single point. */
function pointKey([lon, lat]) {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

async function fetchChunk(chunk) {
  const body = JSON.stringify({ coordinates: chunk.map(([lon, lat]) => ({ longitude: lon, latitude: lat })) });
  const res = await fetch(REEARTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.heights) ? data.heights : null;
}

export async function handleTerrain(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/terrain/heights') return new Response('Not found', { status: 404 });

  const rawPoints = url.searchParams.get('points');
  const points = parsePoints(rawPoints);
  if (!points) {
    return Response.json({ error: 'invalid points parameter — expected "lon,lat;lon,lat;…"' }, { status: 400 });
  }
  if (points.length > MAX_POINTS) {
    return Response.json({ error: `too many points (${points.length}); max ${MAX_POINTS}` }, { status: 400 });
  }

  // Split into cached vs missing points
  const results = new Array(points.length).fill(null);
  const missing = [];

  for (let i = 0; i < points.length; i++) {
    const key = pointKey(points[i]);
    const cached = cacheGet(`terrain:${key}`, TTL_MS);
    if (cached !== null) {
      results[i] = cached;
    } else {
      missing.push({ i, point: points[i], key });
    }
  }

  // Fetch missing points in chunks
  let omitted = 0;
  for (let c = 0; c < missing.length; c += CHUNK) {
    const chunk = missing.slice(c, c + CHUNK);
    try {
      const heights = await fetchChunk(chunk.map((m) => m.point));
      for (let j = 0; j < chunk.length; j++) {
        const h = heights?.[j];
        const result = h != null ? { longitude: chunk[j].point[0], latitude: chunk[j].point[1], height: h } : null;
        results[chunk[j].i] = result;
        if (result !== null) {
          cacheSet(`terrain:${chunk[j].key}`, result);
        } else {
          omitted++;
        }
      }
    } catch (err) {
      console.warn('[terrain] chunk failed:', err?.message);
      omitted += chunk.length;
    }
  }

  return Response.json(
    { results, omitted, requestedPoints: points.length, cachedPoints: points.length - missing.length },
    { headers: { 'Content-Type': 'application/json' } },
  );
}
