/**
 * Wind data handler.
 * Ported from server/providers/wind.js
 *
 * Proxies global wind data (NOAA GFS via Open-Meteo) server-side to avoid
 * browser CORS restrictions. Cached at 1-hour TTL — wind data updates
 * every 6 hours from GFS model runs.
 *
 * Route:
 *   GET /api/wind?lat=...&lon=...  → wind speed/direction data
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const CACHE_TTL_MS = 60 * 60_000; // 1 hour

export async function handleWind(request) {
  const url = new URL(request.url);
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  const lat = parseFloat(url.searchParams.get('lat') ?? '');
  const lon = parseFloat(url.searchParams.get('lon') ?? '');

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: 'lat and lon query params required' }, { status: 400, headers: noStore });
  }

  const roundedLat = Math.round(lat * 2) / 2; // 0.5° grid
  const roundedLon = Math.round(lon * 2) / 2;
  const cacheKey = `wind:${roundedLat},${roundedLon}`;

  const cached = cacheGet(cacheKey, CACHE_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const params = new URLSearchParams({
      latitude: roundedLat,
      longitude: roundedLon,
      hourly: 'wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m,wind_speed_120m,wind_direction_120m',
      wind_speed_unit: 'ms',
      forecast_days: '2',
      timezone: 'UTC',
      models: 'gfs_seamless',
    });

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = await res.json();

    cacheSet(cacheKey, data);
    return Response.json(data, {
      headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' },
    });
  } catch (err) {
    console.warn('[wind] fetch failed:', err?.message);
    const stale = cacheGet(cacheKey, Infinity);
    if (stale) return Response.json(stale, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE' } });
    return Response.json({ error: 'wind data unavailable' }, { status: 502, headers: noStore });
  }
}
