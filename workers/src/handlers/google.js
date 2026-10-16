/**
 * Google Places & geocoding handler.
 * Ported from server/providers/places/google.js and routes.js
 *
 * Keeps the server-side Google API key off the browser. All cost-bearing
 * endpoints use the GOOGLE_MAPS_SERVER_API_KEY; falls back to
 * GOOGLE_MAPS_API_KEY if the server-side key is not set.
 *
 * Routes:
 *   GET  /api/google/nearby-places   → Google Places Nearby Search
 *   GET  /api/google/text-search     → Google Places Text Search
 *   GET  /api/google/geocode         → Google Geocoding API
 *   GET  /api/google/reverse-geocode → Google Reverse Geocoding
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const PLACES_CACHE_MS = 5 * 60_000;  // 5 min — places don't move quickly
const GEO_CACHE_MS    = 60 * 60_000; // 1 hour — addresses rarely change

function serverKey(env) {
  return String(env.GOOGLE_MAPS_SERVER_API_KEY || env.GOOGLE_MAPS_API_KEY || '').trim();
}

function cacheKey(path, params) {
  return `google:${path}:${new URLSearchParams([...params].sort()).toString()}`;
}

async function proxyToGoogle(googleUrl, cacheKeyStr, ttlMs) {
  const cached = cacheGet(cacheKeyStr, ttlMs);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${Math.floor(ttlMs / 1000)}`, 'X-GEV-Cache': 'HIT' },
    });
  }

  const upstream = await fetch(googleUrl, { signal: AbortSignal.timeout(10_000) });
  const data = await upstream.json().catch(() => null);

  if (!upstream.ok || !data) {
    return Response.json({ error: 'Google API request failed', status: upstream.status }, { status: upstream.status || 502 });
  }

  // Cache successful (OK / ZERO_RESULTS) responses
  if (data?.status === 'OK' || data?.status === 'ZERO_RESULTS') {
    cacheSet(cacheKeyStr, data);
  }

  return Response.json(data, {
    headers: { 'Cache-Control': `public, max-age=${Math.floor(ttlMs / 1000)}`, 'X-GEV-Cache': 'MISS' },
  });
}

export async function handleGoogle(request, env) {
  const url  = new URL(request.url);
  const path = url.pathname;
  const key  = serverKey(env);
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  if (!key) {
    return Response.json({ error: 'Google API key not configured', results: [], status: 'NO_KEY' }, { status: 503, headers: noStore });
  }

  // ── Nearby Places ─────────────────────────────────────────────────────────
  if (path === '/api/google/nearby-places') {
    const lat  = url.searchParams.get('lat');
    const lng  = url.searchParams.get('lng');
    const type = url.searchParams.get('type') || '';
    const radius = url.searchParams.get('radius') || '500';
    if (!lat || !lng) return Response.json({ error: 'lat and lng required' }, { status: 400, headers: noStore });

    const params = new URLSearchParams({ key, location: `${lat},${lng}`, radius, ...(type ? { type } : {}) });
    const googleUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`;
    return proxyToGoogle(googleUrl, cacheKey('nearby', params), PLACES_CACHE_MS);
  }

  // ── Text Search ───────────────────────────────────────────────────────────
  if (path === '/api/google/text-search') {
    const query  = url.searchParams.get('query') || '';
    const lat    = url.searchParams.get('lat');
    const lng    = url.searchParams.get('lng');
    if (!query) return Response.json({ error: 'query required' }, { status: 400, headers: noStore });

    const params = new URLSearchParams({ key, query, ...(lat && lng ? { location: `${lat},${lng}`, radius: '50000' } : {}) });
    const googleUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`;
    return proxyToGoogle(googleUrl, cacheKey('text', params), PLACES_CACHE_MS);
  }

  // ── Geocode ───────────────────────────────────────────────────────────────
  if (path === '/api/google/geocode') {
    const address = url.searchParams.get('address') || '';
    if (!address) return Response.json({ error: 'address required' }, { status: 400, headers: noStore });
    const params = new URLSearchParams({ key, address });
    const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json?${params}`;
    return proxyToGoogle(googleUrl, cacheKey('geocode', params), GEO_CACHE_MS);
  }

  // ── Reverse Geocode ───────────────────────────────────────────────────────
  if (path === '/api/google/reverse-geocode') {
    const lat = url.searchParams.get('lat');
    const lng = url.searchParams.get('lng');
    if (!lat || !lng) return Response.json({ error: 'lat and lng required' }, { status: 400, headers: noStore });
    const params = new URLSearchParams({ key, latlng: `${lat},${lng}` });
    const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json?${params}`;
    return proxyToGoogle(googleUrl, cacheKey('reverse', params), GEO_CACHE_MS);
  }

  return new Response('Not found', { status: 404 });
}
