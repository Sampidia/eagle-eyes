/**
 * Space handler — CelesTrak TLE satellite data + Launch Library 2 rocket launches.
 * Ported from server/providers/space/celestrak.js and launch-library.js
 *
 * Routes:
 *   GET /api/celestrak/:group   → TLE text for a CelesTrak group
 *   GET /api/launches           → Launch Library 2 recent launches JSON
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const TLE_TTL_MS   = 6 * 3_600_000;  // 6 hours — CelesTrak's requested cadence
const LL2_TTL_MS   = 15 * 60_000;    // 15 minutes

// ── CelesTrak TLE ─────────────────────────────────────────────────────────

function celestrakTleUrl(group) {
  return `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
}

async function fetchTle(group) {
  const res = await fetch(celestrakTleUrl(group), {
    signal: AbortSignal.timeout(20_000),
    headers: {
      'User-Agent': 'eagle-eyes-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (!/^1 /m.test(body)) throw new Error('no TLE lines in response (may be error page)');
  return body;
}

async function handleCelestrak(url) {
  // pathname: /api/celestrak/active  →  group: 'active'
  const group = url.pathname.replace(/^\/api\/celestrak\/?/, '').split('?')[0];
  if (!/^[a-z0-9-]+$/i.test(group)) {
    return new Response('invalid group', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }

  const cacheKey = `celestrak:${group}`;
  const cached = cacheGet(cacheKey, TLE_TTL_MS);
  if (cached) {
    return new Response(cached, { headers: { 'Content-Type': 'text/plain', 'x-tle-cache': 'HIT' } });
  }

  try {
    const body = await fetchTle(group);
    cacheSet(cacheKey, body);
    return new Response(body, { headers: { 'Content-Type': 'text/plain', 'x-tle-cache': 'MISS' } });
  } catch (err) {
    console.warn('[celestrak] fetch failed:', err?.message);
    const stale = cacheGet(cacheKey, Infinity);
    if (stale) return new Response(stale, { headers: { 'Content-Type': 'text/plain', 'x-tle-cache': 'STALE-ERROR' } });
    return new Response('celestrak fetch failed and no cache available', { status: 502, headers: { 'Content-Type': 'text/plain', 'x-tle-cache': 'NONE' } });
  }
}

// ── Launch Library 2 ──────────────────────────────────────────────────────

function ll2Url() {
  // Fetch launches from the last 30 days and next 30 days
  const now = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 30);
  const end   = new Date(now); end.setDate(end.getDate() + 30);
  const fmt   = (d) => d.toISOString().split('T')[0];
  return `https://ll.thespacedevs.com/2.3.0/launches/?format=json&limit=100&net__gte=${fmt(start)}&net__lte=${fmt(end)}&ordering=net`;
}

async function handleLaunches(env) {
  const cached = cacheGet('launches:recent', LL2_TTL_MS);
  if (cached) {
    return new Response(cached, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', 'X-GEV-Cache': 'HIT' },
    });
  }

  const headers = { Accept: 'application/json' };
  const token = String(env.LL2_API_TOKEN || '').trim();
  if (token) headers['Authorization'] = `Token ${token}`;

  try {
    const res = await fetch(ll2Url(), { signal: AbortSignal.timeout(20_000), headers });
    const body = await res.text();
    if (!res.ok) {
      const stale = cacheGet('launches:recent', Infinity);
      if (stale) return new Response(stale, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', 'X-GEV-Cache': 'STALE-ERROR' } });
      return new Response(JSON.stringify({ error: 'Launch Library 2 unavailable' }), { status: res.status, headers: { 'Content-Type': 'application/json', 'X-GEV-Cache': 'NONE' } });
    }
    cacheSet('launches:recent', body);
    return new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', 'X-GEV-Cache': 'MISS' },
    });
  } catch (err) {
    console.warn('[launches] fetch failed:', err?.message);
    const stale = cacheGet('launches:recent', Infinity);
    if (stale) return new Response(stale, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', 'X-GEV-Cache': 'STALE-ERROR' } });
    return Response.json({ error: 'Launch Library 2 unavailable' }, { status: 502 });
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────

export async function handleSpace(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/celestrak')) return handleCelestrak(url);
  if (url.pathname.startsWith('/api/launches'))  return handleLaunches(env);
  return new Response('Not found', { status: 404 });
}
