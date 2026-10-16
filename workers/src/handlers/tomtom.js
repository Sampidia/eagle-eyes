/**
 * TomTom live traffic tile proxy.
 * Ported from server/providers/traffic.js
 *
 * Keeps the TomTom API key server-side. The browser fetches same-origin
 * /api/tomtom/* tiles; this Worker appends the key and forwards to TomTom.
 * No tile-budget counter (would require KV) — the TomTom free tier
 * (200k tiles/month) is enforced at the provider level.
 *
 * Routes:
 *   GET /api/tomtom/*  → proxied TomTom tile or API response
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

// Tile responses are safe to cache for 2 minutes (traffic changes slowly)
const TILE_CACHE_MS = 2 * 60_000;

export async function handleTomTom(request, env) {
  const url = new URL(request.url);
  const apiKey = String(env.TOMTOM_API_KEY || '').trim();

  // No key: return a flag body so the client shows its built-in simulation
  if (!apiKey) {
    return Response.json(
      { error: 'no_key', message: 'TOMTOM_API_KEY not configured — traffic layer is running in simulation mode' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Strip the /api/tomtom prefix to get the real TomTom path
  const tomtomPath = url.pathname.replace(/^\/api\/tomtom\/?/, '');
  const forwardParams = new URLSearchParams(url.searchParams);
  forwardParams.set('key', apiKey);

  const tomtomUrl = `https://api.tomtom.com/${tomtomPath}?${forwardParams}`;
  const cacheKey  = `tomtom:${tomtomPath}:${url.searchParams.toString()}`;

  // Return cached tile if fresh
  const cached = cacheGet(cacheKey, TILE_CACHE_MS);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': `public, max-age=${Math.floor(TILE_CACHE_MS / 1000)}`,
        'X-GEV-Cache': 'HIT',
      },
    });
  }

  try {
    const upstream = await fetch(tomtomUrl, { signal: AbortSignal.timeout(10_000) });

    if (!upstream.ok) {
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('content-type') || 'text/plain', 'Cache-Control': 'no-store' },
      });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const body = await upstream.arrayBuffer();

    cacheSet(cacheKey, { body, contentType });

    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${Math.floor(TILE_CACHE_MS / 1000)}`,
        'X-GEV-Cache': 'MISS',
      },
    });
  } catch (err) {
    console.warn('[tomtom] fetch failed:', err?.message);
    return Response.json({ error: 'TomTom proxy error' }, { status: 502 });
  }
}
