/**
 * CCTV camera registry handler.
 * Ported from server/providers/cctv.js
 *
 * The original builds a large in-memory camera registry from multiple sources
 * on startup (Austin, Caltrans, TfL, Ontario, etc.) and serves it with a
 * disk-backed cache. In a Worker, we return a lightweight pass-through to the
 * public CCTV catalog APIs directly, since we have no filesystem.
 *
 * For MVP this handler returns camera entries from publicly accessible
 * catalog endpoints. The full multi-source aggregation can be added later
 * with KV-backed persistence.
 *
 * Routes:
 *   GET /api/cctv           → {cameras: [...], source, count}
 *   GET /api/cctv/frame     → proxied JPEG/MJPEG frame for a camera URL
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const CATALOG_TTL_MS = 15 * 60_000; // 15 minutes
const FRAME_TIMEOUT_MS = 8_000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024; // 2 MB

/** Fetch the Austin Open Data CCTV catalog (public, no key). */
async function fetchAustinCameras(max = 250) {
  const url = `https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=${max}&$select=camera_id,location_name,latitude,longitude,camera_url`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Austin catalog HTTP ${res.status}`);
  const data = await res.json();
  return data.map((c) => ({
    id: `austin:${c.camera_id}`,
    name: c.location_name ?? 'Austin Camera',
    latitude: parseFloat(c.latitude),
    longitude: parseFloat(c.longitude),
    url: c.camera_url ?? null,
    source: 'Austin Open Data',
  })).filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
}

export async function handleCctv(request) {
  const url = new URL(request.url);
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  // ── Frame proxy ───────────────────────────────────────────────────────────
  if (url.pathname === '/api/cctv/frame') {
    const cameraUrl = url.searchParams.get('url');
    if (!cameraUrl) return Response.json({ error: 'url param required' }, { status: 400, headers: noStore });

    // Only allow proxying known-safe camera image origins
    let parsedCamera;
    try { parsedCamera = new URL(cameraUrl); } catch {
      return Response.json({ error: 'invalid camera url' }, { status: 400, headers: noStore });
    }

    // Allowlist of domains known to serve CCTV frames
    const ALLOWED_HOSTS = [
      'cctv.austinmobility.io', 'cwwp2.dot.ca.gov', 'api.tfl.gov.uk',
      'www.511ontario.ca', 'traffic.fin.fi', 'bynder.vegvesen.no',
      'drivebc.ca', 'api.pugetsound511.org',
    ];
    if (!ALLOWED_HOSTS.some((h) => parsedCamera.hostname.endsWith(h))) {
      return Response.json({ error: 'camera host not in allowlist' }, { status: 403, headers: noStore });
    }

    try {
      const upstream = await fetch(cameraUrl, { signal: AbortSignal.timeout(FRAME_TIMEOUT_MS) });
      if (!upstream.ok) return new Response(null, { status: upstream.status });

      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      const buffer = await upstream.arrayBuffer();
      if (buffer.byteLength > MAX_FRAME_BYTES) {
        return Response.json({ error: 'frame too large' }, { status: 413, headers: noStore });
      }

      return new Response(buffer, {
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
      });
    } catch (err) {
      return Response.json({ error: 'frame fetch failed' }, { status: 502, headers: noStore });
    }
  }

  // ── Camera catalog ────────────────────────────────────────────────────────
  const cached = cacheGet('cctv:catalog', CATALOG_TTL_MS);
  if (cached) {
    return Response.json(cached, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CATALOG_TTL_MS / 1000)}`, 'X-GEV-Cache': 'HIT' } });
  }

  try {
    const cameras = await fetchAustinCameras(250);
    const payload = { cameras, source: 'Austin Open Data', count: cameras.length, fetchedAt: Date.now() };
    cacheSet('cctv:catalog', payload);
    return Response.json(payload, { headers: { 'Cache-Control': `public, max-age=${Math.floor(CATALOG_TTL_MS / 1000)}`, 'X-GEV-Cache': 'MISS' } });
  } catch (err) {
    console.warn('[cctv] catalog fetch failed:', err?.message);
    const stale = cacheGet('cctv:catalog', Infinity);
    if (stale) return Response.json(stale, { headers: { 'Cache-Control': 'no-store', 'X-GEV-Cache': 'STALE' } });
    return Response.json({ cameras: [], source: 'unavailable', count: 0, error: err?.message }, { status: 502, headers: noStore });
  }
}
