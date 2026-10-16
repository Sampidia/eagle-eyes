/**
 * Vessels handler — AIS live vessel feed (polling mode).
 * Ported from server/providers/vessels/ais-live.js
 *
 * The original proxy kept a persistent WebSocket to AISStream. Workers don't
 * support long-lived connections, so we use AISStream's REST snapshot endpoint
 * with a short TTL in-memory cache. The frontend already gracefully renders
 * stale/polling data via its `status: 'idle'` path.
 *
 * Routes:
 *   GET /api/vessels          → JSON snapshot {rows, source, status, ...}
 *   GET /api/vessels/track    → track history for a single vessel MMSI
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const CACHE_TTL_MS = 5_000; // match the frontend's poll interval

export async function handleVessels(request, env) {
  const url = new URL(request.url);
  const apiKey = env.AISSTREAM_API_KEY;

  // ── No key ────────────────────────────────────────────────────────────────
  if (!apiKey) {
    return Response.json(
      { rows: [], source: 'AISStream', status: 'missing-key', error: 'AISSTREAM_API_KEY is not set', refreshing: false },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Feed-Source': 'AISStream' } },
    );
  }

  // ── Track sub-route ───────────────────────────────────────────────────────
  if (url.pathname === '/api/vessels/track' || url.pathname.startsWith('/api/vessels/track/')) {
    const mmsi = String(url.searchParams.get('mmsi') || '').trim();
    if (!/^\d{5,10}$/.test(mmsi)) {
      return Response.json({ error: 'mmsi query param required', samples: [] }, { status: 400 });
    }
    // Workers have no in-memory track store; return empty samples so the UI
    // degrades gracefully. A KV-backed track store can be added in a fast-follow.
    return Response.json(
      { mmsi, samples: [], source: 'AISStream (cloud — track history not available in polling mode)', retainedSec: 0 },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ── Snapshot from cache ───────────────────────────────────────────────────
  const cached = cacheGet('ais:snapshot', CACHE_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': 'no-store', 'X-Feed-Source': 'AISStream', 'X-GEV-Cache': 'HIT' } });
  }

  // ── Fetch from AISStream REST API ─────────────────────────────────────────
  const maxRows = Math.min(
    parseInt(url.searchParams.get('maxRows') ?? '', 10) || 12000,
    Number(env.VITE_AIS_LIVE_MAX_ROWS) || 12000,
  );

  try {
    // AISStream provides vessel positions via their REST API
    const upstream = await fetch('https://api.aisstream.io/v0/mmsi', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport'],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.warn('[vessels] AISStream upstream error', upstream.status, errText.slice(0, 200));
      return Response.json(
        { rows: [], source: 'AISStream', status: 'error', error: `upstream HTTP ${upstream.status}`, refreshing: true },
        { status: 502, headers: { 'Cache-Control': 'no-store', 'X-Feed-Source': 'AISStream' } },
      );
    }

    const data = await upstream.json();
    const rows = Array.isArray(data) ? data.slice(0, maxRows) : (data?.vessels ?? []).slice(0, maxRows);

    const payload = {
      rows,
      source: 'AISStream',
      status: 'live',
      error: null,
      refreshing: false,
      newestPositionAt: rows.length > 0 ? Date.now() : null,
      lastMessageAt: Date.now(),
      staleAfterMs: 120_000,
      watchdog: 'polling',
    };

    cacheSet('ais:snapshot', payload);

    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store', 'X-Feed-Source': 'AISStream', 'X-GEV-Cache': 'MISS' },
    });
  } catch (err) {
    console.warn('[vessels] fetch failed:', err?.message);
    return Response.json(
      { rows: [], source: 'AISStream', status: 'error', error: err?.message ?? 'AIS fetch error', refreshing: true },
      { status: 502, headers: { 'Cache-Control': 'no-store', 'X-Feed-Source': 'AISStream' } },
    );
  }
}
