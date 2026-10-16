/**
 * Aircraft handler — OpenSky Network global snapshot + ADSB-LOL regional fallback.
 * Ported from server/providers/aircraft/opensky.js
 *
 * Routes:
 *   GET /api/flights           → OpenSky global aircraft snapshot (JSON)
 *   GET /api/flights/track     → track history for a single MMSI (from adsb.lol)
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all?extended=1';
const OPENSKY_CACHE_MS = 9_000;
const ADSBLOL_CACHE_MS = 12_000;
const ADSBLOL_RADIUS_NM = 250;

/** In-isolate state for adaptive TTL and rate-limit cooldown. */
let _ttlMs = OPENSKY_CACHE_MS;
let _cooldownUntil = 0;

function adaptiveTtl(remaining) {
  if (!Number.isFinite(remaining)) return OPENSKY_CACHE_MS;
  if (remaining > 2400) return OPENSKY_CACHE_MS;
  if (remaining > 1200) return 30_000;
  if (remaining > 400)  return 90_000;
  return 300_000;
}

function cooldownFromResponse(response) {
  const header = response.headers.get('x-rate-limit-retry-after-seconds');
  const sec = header == null || header.trim() === '' ? NaN : Number(header);
  return Math.min(Math.max(Number.isFinite(sec) ? sec * 1000 : 120_000, 30_000), 30 * 60_000);
}

function buildHeaders({ cacheStatus, usedMode, reason }) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-OpenSky-Cache': cacheStatus,
    'X-OpenSky-Auth': usedMode,
    'X-OpenSky-Auth-Reason': reason,
  };
}

async function getOpenSkyToken(env) {
  const id = env.OPENSKY_CLIENT_ID;
  const secret = env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;

  const cached = cacheGet('opensky:token', 25 * 60_000); // 25-min margin
  if (cached) return cached;

  try {
    const res = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(10_000),
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
      },
    );
    const data = await res.json().catch(() => null);
    const token = data?.access_token;
    if (!res.ok || !token) return null;
    cacheSet('opensky:token', token);
    return token;
  } catch {
    return null;
  }
}

async function fetchAdsbLol(lat, lon) {
  const rLat = Math.round(lat * 4) / 4;
  const rLon = Math.round(lon * 4) / 4;
  const key = `adsblol:${rLat.toFixed(2)},${rLon.toFixed(2)}`;
  const cached = cacheGet(key, ADSBLOL_CACHE_MS);
  if (cached) return cached;

  const res = await fetch(
    `https://api.adsb.lol/v2/lat/${rLat}/lon/${rLon}/dist/${ADSBLOL_RADIUS_NM}`,
    {
      headers: { 'User-Agent': 'eagle-eyes-adsblol-fallback/1.0' },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) return null;
  const data = await res.json();
  cacheSet(key, data);
  return data;
}

export async function handleAdsb(request, env) {
  const url = new URL(request.url);

  // ── Track sub-route ──────────────────────────────────────────────────────
  if (url.pathname.startsWith('/api/flights/track')) {
    const lat = parseFloat(url.searchParams.get('lat') ?? '');
    const lon = parseFloat(url.searchParams.get('lon') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: 'lat and lon query params required', states: [] }, { status: 400 });
    }
    const data = await fetchAdsbLol(lat, lon).catch(() => null);
    if (!data) return Response.json({ error: 'adsb.lol unavailable', states: [] }, { status: 502 });
    return Response.json(data, { headers: { 'Cache-Control': 'no-store', 'X-Flight-Source': 'adsb.lol' } });
  }

  // ── Global OpenSky snapshot ───────────────────────────────────────────────
  const now = Date.now();
  const inCooldown = now < _cooldownUntil;
  const cached = cacheGet('opensky:states', _ttlMs);

  if (cached || inCooldown) {
    const status = cached?.status ?? 200;
    const body = cached?.body ?? JSON.stringify({ error: 'rate limited, no cache' });
    return new Response(body, {
      status,
      headers: buildHeaders({ cacheStatus: inCooldown ? 'STALE' : 'HIT', usedMode: cached?.usedMode ?? 'unknown', reason: inCooldown ? 'rate_limited_serving_stale' : 'cached' }),
    });
  }

  const headers = { Accept: 'application/json' };
  let usedMode = 'anon';

  const authMode = String(env.OPENSKY_AUTH_MODE || 'oauth').toLowerCase();
  if (authMode === 'oauth' || authMode === 'auto') {
    const token = await getOpenSkyToken(env);
    if (token) { headers['Authorization'] = `Bearer ${token}`; usedMode = 'oauth'; }
  }

  try {
    const upstream = await fetch(OPENSKY_STATES_URL, { headers, signal: AbortSignal.timeout(10_000) });

    if (upstream.status === 429) {
      _cooldownUntil = now + cooldownFromResponse(upstream);
      void upstream.body?.cancel().catch(() => {});
      const stale = cacheGet('opensky:states', Infinity);
      if (stale) return new Response(stale.body, { status: 200, headers: buildHeaders({ cacheStatus: 'STALE', usedMode: stale.usedMode, reason: 'rate_limited_serving_stale' }) });
      return Response.json({ error: 'OpenSky rate limited' }, { status: 429, headers: buildHeaders({ cacheStatus: 'COOLDOWN', usedMode, reason: 'rate_limited' }) });
    }

    const body = await upstream.text();
    if (upstream.ok) {
      const remaining = Number(upstream.headers.get('x-rate-limit-remaining'));
      _ttlMs = adaptiveTtl(remaining);
      _cooldownUntil = 0;
      cacheSet('opensky:states', { body, status: upstream.status, usedMode });
    }

    return new Response(body, {
      status: upstream.status,
      headers: buildHeaders({ cacheStatus: 'MISS', usedMode, reason: upstream.ok ? 'fresh' : `upstream_${upstream.status}` }),
    });
  } catch (err) {
    const stale = cacheGet('opensky:states', Infinity);
    if (stale) return new Response(stale.body, { status: 200, headers: buildHeaders({ cacheStatus: 'STALE', usedMode: stale.usedMode, reason: 'proxy_error_serving_stale' }) });
    return Response.json({ error: 'OpenSky proxy error' }, { status: 502, headers: buildHeaders({ cacheStatus: 'MISS', usedMode: 'error', reason: 'proxy_error' }) });
  }
}
