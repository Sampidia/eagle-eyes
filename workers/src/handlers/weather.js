/**
 * Weather effects handler.
 * Ported from server/providers/weather.js and server/providers/regional/weather-effects.js
 *
 * Proxies weather data requests server-side (no API key needed for most
 * public weather sources; avoids CORS from the browser).
 *
 * Routes:
 *   GET /api/weather          → current weather / weather effects data
 *   GET /api/weather/effects  → regional weather effects for a lat/lon
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const CACHE_TTL_MS = 10 * 60_000; // 10 minutes

/** Open-Meteo: free, no key, no CORS restrictions from server. */
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
      'precipitation', 'weather_code', 'wind_speed_10m', 'wind_direction_10m',
      'wind_gusts_10m', 'cloud_cover', 'visibility',
    ].join(','),
    hourly: 'cloud_cover,precipitation,wind_speed_10m',
    forecast_days: '1',
    timezone: 'UTC',
  });
  const res = await fetch(`${OPEN_METEO_URL}?${params}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

export async function handleWeather(request) {
  const url = new URL(request.url);
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  const lat = parseFloat(url.searchParams.get('lat') ?? '');
  const lon = parseFloat(url.searchParams.get('lon') ?? '');

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: 'lat and lon query params required' }, { status: 400, headers: noStore });
  }

  const roundedLat = Math.round(lat * 10) / 10;
  const roundedLon = Math.round(lon * 10) / 10;
  const cacheKey = `weather:${roundedLat},${roundedLon}`;

  const cached = cacheGet(cacheKey, CACHE_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const data = await fetchOpenMeteo(lat, lon);
    cacheSet(cacheKey, data);
    return Response.json(data, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[weather] fetch failed:', err?.message);
    const stale = cacheGet(cacheKey, Infinity);
    if (stale) return Response.json(stale, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE' } });
    return Response.json({ error: 'weather data unavailable' }, { status: 502, headers: noStore });
  }
}
