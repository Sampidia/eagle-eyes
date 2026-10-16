/**
 * Radio Browser proxy handler.
 * Ported from server/providers/radio.js
 *
 * Radio Browser is a community API with no authentication. Proxied here
 * to avoid CORS restrictions in the browser.
 *
 * Routes:
 *   GET /api/radio/stations?lat=...&lon=...&limit=50
 *     → Radio Browser stations near a location
 *   GET /api/radio/search?name=...
 *     → Radio Browser text search
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const RADIO_BASE = 'https://de1.api.radio-browser.info/json';
const CACHE_TTL_MS = 30 * 60_000; // 30 minutes

function radioCacheKey(path, params) {
  return `radio:${path}:${new URLSearchParams([...params].sort()).toString()}`;
}

async function proxyRadio(apiPath, params, cacheKey) {
  const cached = cacheGet(cacheKey, CACHE_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  const url = `${RADIO_BASE}/${apiPath}?${params}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'eagle-eyes/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cacheSet(cacheKey, data);
    return Response.json(data, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[radio] fetch failed:', err?.message);
    const stale = cacheGet(cacheKey, Infinity);
    if (stale) return Response.json(stale, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE' } });
    return Response.json({ error: 'Radio Browser unavailable' }, { status: 502 });
  }
}

export async function handleRadio(request) {
  const url = new URL(request.url);
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  if (url.pathname === '/api/radio/stations') {
    const lat   = url.searchParams.get('lat');
    const lon   = url.searchParams.get('lon');
    const limit = url.searchParams.get('limit') || '50';
    if (!lat || !lon) return Response.json({ error: 'lat and lon required' }, { status: 400, headers: noStore });
    const params = new URLSearchParams({ lat, long: lon, limit, hidebroken: 'true' });
    return proxyRadio('stations/bylatlong', params, radioCacheKey('bylatlong', params));
  }

  if (url.pathname === '/api/radio/search') {
    const name  = url.searchParams.get('name') || '';
    const limit = url.searchParams.get('limit') || '30';
    if (!name) return Response.json({ error: 'name param required' }, { status: 400, headers: noStore });
    const params = new URLSearchParams({ name, limit, hidebroken: 'true' });
    return proxyRadio('stations/search', params, radioCacheKey('search', params));
  }

  return new Response('Not found', { status: 404 });
}
