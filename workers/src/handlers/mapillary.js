/**
 * Mapillary street-level imagery handler.
 * Ported from server/providers/mapillary.js
 *
 * Proxies Mapillary API requests server-side to keep the client token
 * off public network requests (even though it's a public token by design,
 * this avoids it appearing in browser devtools when routing through Vercel).
 *
 * Routes:
 *   GET /api/mapillary/*  → proxied Mapillary Graph API response
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const MAPILLARY_BASE = 'https://graph.mapillary.com';
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export async function handleMapillary(request, env) {
  const url = new URL(request.url);
  const token = String(env.MAPILLARY_CLIENT_TOKEN || '').trim();
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  if (!token) {
    return Response.json({ error: 'MAPILLARY_CLIENT_TOKEN not configured' }, { status: 503, headers: noStore });
  }

  // Strip /api/mapillary to get the Graph API path
  const graphPath = url.pathname.replace(/^\/api\/mapillary\/?/, '');
  const forwardParams = new URLSearchParams(url.searchParams);
  forwardParams.set('access_token', token);

  const mapillaryUrl = `${MAPILLARY_BASE}/${graphPath}?${forwardParams}`;
  const cacheKey = `mapillary:${graphPath}:${url.searchParams.toString()}`;

  const cached = cacheGet(cacheKey, CACHE_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const upstream = await fetch(mapillaryUrl, { signal: AbortSignal.timeout(10_000) });
    const data = await upstream.json().catch(() => null);

    if (!upstream.ok || !data) {
      return Response.json({ error: `Mapillary API error ${upstream.status}` }, { status: upstream.status || 502, headers: noStore });
    }

    cacheSet(cacheKey, data);
    return Response.json(data, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[mapillary] fetch failed:', err?.message);
    return Response.json({ error: 'Mapillary unavailable' }, { status: 502, headers: noStore });
  }
}
