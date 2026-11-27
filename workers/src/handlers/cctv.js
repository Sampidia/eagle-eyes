/**
 * CCTV camera registry handler for Cloudflare Workers.
 *
 * Routes:
 *   GET /api/cctv/sources       → {sources: [...], cameras: [...], count: ...}
 *   GET /api/cctv/health        → {status: 'ok', cameras: [...]}
 *   GET /api/cctv/frame/:id     → proxied JPEG/MJPEG frame or synthetic fallback SVG
 *   GET /api/cctv/frame         → frame via ?url= or ?id=
 *   GET /api/cctv/archive/:id   → 24h or 48h archived video streaming / redirect
 *   GET /api/cctv               → catalog payload
 */

import { cacheGet, cacheSet } from '../lib/cache.js';
import { BASE_CAMERAS } from './cctvCatalog.js';

const CATALOG_TTL_MS = 15 * 60_000; // 15 minutes
const FRAME_TIMEOUT_MS = 8_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024; // 4 MB

function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildSyntheticCctvSvg({ cameraId, label, city, status }) {
  const seed = hashSeed(`${cameraId}:${label}:${city}`);
  const hue = seed % 360;
  const hue2 = (hue + 46) % 360;
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const safeLabel = escapeXml(label || 'CAMERA');
  const safeCity = escapeXml(city || 'GLOBAL GRID');
  const safeId = escapeXml(cameraId || 'CAM');
  const safeStatus = escapeXml(status || 'STANDBY');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 35%, 10%)" />
      <stop offset="60%" stop-color="hsl(${hue2}, 42%, 6%)" />
      <stop offset="100%" stop-color="#020509" />
    </linearGradient>
    <pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="transparent" />
      <rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)" />
      <rect y="4" width="8" height="1" fill="rgba(255,255,255,0.05)" />
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)" />
  <rect width="960" height="540" fill="url(#scan)" />
  <g fill="none" stroke="rgba(180,248,255,0.25)" stroke-width="1">
    <rect x="50" y="50" width="860" height="440" rx="6" />
    <line x1="50" y1="270" x2="910" y2="270" stroke-dasharray="4 4" />
    <line x1="480" y1="50" x2="480" y2="490" stroke-dasharray="4 4" />
  </g>
  <g fill="#9cefff" font-family="monospace" text-transform="uppercase">
    <text x="64" y="80" font-size="16" letter-spacing="2">CCTV FEED · ${safeStatus}</text>
    <text x="64" y="470" font-size="15" letter-spacing="1.5">${safeLabel} [${safeCity}]</text>
    <text x="680" y="80" font-size="14" letter-spacing="1">${ts}</text>
    <text x="750" y="470" font-size="13" letter-spacing="1">${safeId}</text>
  </g>
</svg>`.trim();
}

/** Normalize Google Drive, Dropbox, or raw video link into a direct streaming URL */
export function normalizeVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  const driveMatch = trimmed.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([a-zA-Z0-9_-]+)/);
  if (driveMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  }
  if (/dropbox\.com\//i.test(trimmed) && /[?&]dl=0\b/.test(trimmed)) {
    return trimmed.replace(/([?&])dl=0\b/, '$1raw=1');
  }
  return trimmed;
}

/** Lookup archive video link from Worker env or Node process.env */
export function getArchiveUrl(env, cameraId, range) {
  if (!cameraId) return null;
  const numRange = String(range || '24').replace(/[^0-9]/g, '') || '24';
  const candidates = [
    `CAM-${cameraId}-${numRange}hrs`,
    `CAM-${cameraId}-${numRange}h`,
    `CAM_${cameraId.replace(/[^a-zA-Z0-9]/g, '_')}_${numRange}hrs`,
    `CAM_${cameraId.replace(/[^a-zA-Z0-9]/g, '_')}_${numRange}h`,
  ];

  if (env && typeof env === 'object') {
    for (const key of candidates) {
      if (env[key]) return env[key];
    }
  }

  if (typeof process !== 'undefined' && process.env) {
    for (const key of candidates) {
      if (process.env[key]) return process.env[key];
    }
  }

  return null;
}

function buildArchivesMeta(env, cameraId) {
  const raw24 = getArchiveUrl(env, cameraId, '24');
  const raw48 = getArchiveUrl(env, cameraId, '48');
  const url24h = raw24 ? normalizeVideoUrl(raw24) : null;
  const url48h = raw48 ? normalizeVideoUrl(raw48) : null;
  return {
    has24h: Boolean(url24h),
    has48h: Boolean(url48h),
    url24h,
    url48h,
  };
}

/** Attempt to fetch live Austin Open Data cameras; fails open to empty array */
async function fetchAustinCameras(max = 250) {
  try {
    const url = `https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=${max}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[cctv] Austin open data returned HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((c) => {
      const lat = parseFloat(c.latitude || c.location?.latitude || c.point?.coordinates?.[1]);
      const lon = parseFloat(c.longitude || c.location?.longitude || c.point?.coordinates?.[0]);
      const id = String(c.camera_id || c.id || '');
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return {
        id: `austin:${id}`,
        name: c.location_name || `Austin Cam ${id}`,
        city: 'Austin',
        cityId: 'austin',
        provider: 'Austin Transportation',
        lat,
        lon,
        headingDeg: 0,
        pitchDeg: -20,
        fovDeg: 56,
        rangeM: 200,
        mountHeightM: 10,
        groundElevationM: 150,
        feedType: 'image',
        url: c.camera_url || `https://cctv.austinmobility.io/image/${encodeURIComponent(id)}.jpg`,
        snapshotUrl: c.camera_url || `https://cctv.austinmobility.io/image/${encodeURIComponent(id)}.jpg`,
        sourceKind: 'austin-open-data',
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn('[cctv] Austin catalog fetch error:', err?.message);
    return [];
  }
}

export async function handleCctv(request, env = {}) {
  const url = new URL(request.url);
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  // 1. Archive video streaming route: /api/cctv/archive/:id
  if (url.pathname.startsWith('/api/cctv/archive/')) {
    const cameraId = decodeURIComponent(url.pathname.slice('/api/cctv/archive/'.length).trim());
    const rangeParam = url.searchParams.get('range') || '24';
    const numRange = rangeParam.includes('48') ? '48' : '24';
    const rawTarget = getArchiveUrl(env, cameraId, numRange);

    if (!rawTarget) {
      return Response.json(
        { error: `No archive configured for camera ${cameraId} (${numRange}h)` },
        { status: 404, headers: noStore },
      );
    }

    const videoUrl = normalizeVideoUrl(rawTarget);
    if (!videoUrl) {
      return Response.json(
        { error: `Invalid archive URL for camera ${cameraId} (${numRange}h)` },
        { status: 404, headers: noStore },
      );
    }

    // When ?proxy=1 is requested (e.g., 3D WebGL projection needing same-origin/CORS
    // access to a Dropbox/Drive video that lacks Access-Control-Allow-Origin),
    // stream upstream with Range support and a connect-only timeout.
    if (url.searchParams.get('proxy') === '1') {
      const rangeHeader = request.headers.get('range');
      const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      };
      if (rangeHeader) upstreamHeaders.Range = rangeHeader;

      const controller = new AbortController();
      const connectTimer = setTimeout(() => controller.abort(), 15_000);
      try {
        const upstream = await fetch(videoUrl, {
          headers: upstreamHeaders,
          signal: controller.signal,
        });
        clearTimeout(connectTimer);

        const responseHeaders = new Headers();
        responseHeaders.set(
          'Content-Type',
          upstream.headers.get('content-type') || 'video/mp4',
        );
        responseHeaders.set('Accept-Ranges', 'bytes');
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set(
          'Access-Control-Expose-Headers',
          'Content-Range, Content-Length, Accept-Ranges',
        );
        responseHeaders.set('Cache-Control', 'public, max-age=3600');
        if (upstream.headers.has('content-length')) {
          responseHeaders.set('Content-Length', upstream.headers.get('content-length'));
        }
        if (upstream.headers.has('content-range')) {
          responseHeaders.set('Content-Range', upstream.headers.get('content-range'));
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      } catch (err) {
        clearTimeout(connectTimer);
        console.warn('[cctv] Archive proxy stream error:', err?.message);
        return Response.json(
          { error: 'Archive proxy stream failed' },
          { status: 502, headers: noStore },
        );
      }
    }

    // Redirect directly to the media host so <video> streams natively with HTTP Range support
    // without hitting Worker stream timeouts or Vercel proxy body limits.
    return new Response(null, {
      status: 302,
      headers: {
        Location: videoUrl,
        'Cache-Control': 'no-store',
      },
    });
  }

  // 2. Frame proxy: /api/cctv/frame/:id or /api/cctv/frame?url=...
  if (url.pathname === '/api/cctv/frame' || url.pathname.startsWith('/api/cctv/frame/')) {
    let cameraId = '';
    if (url.pathname.startsWith('/api/cctv/frame/')) {
      cameraId = decodeURIComponent(url.pathname.slice('/api/cctv/frame/'.length).trim());
    } else {
      cameraId = url.searchParams.get('id') || '';
    }

    const camera = BASE_CAMERAS.find((c) => c.id === cameraId) || null;
    let cameraUrl = url.searchParams.get('url') || camera?.snapshotUrl || camera?.url || '';

    if (cameraUrl) {
      try {
        const parsedCamera = new URL(cameraUrl);
        const ALLOWED_HOSTS = [
          'cctv.austinmobility.io',
          'cwwp2.dot.ca.gov',
          'api.tfl.gov.uk',
          'www.511ontario.ca',
          'traffic.fin.fi',
          'bynder.vegvesen.no',
          'drivebc.ca',
          'api.pugetsound511.org',
          'ristmikud.tallinn.ee',
          'webcam.warendorf.de',
          'storage.googleapis.com',
          'googleapis.com',
        ];
        const isAllowed = ALLOWED_HOSTS.some((h) => parsedCamera.hostname.endsWith(h));
        if (isAllowed) {
          const upstream = await fetch(cameraUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(FRAME_TIMEOUT_MS),
          });
          if (upstream.ok) {
            const contentType = upstream.headers.get('content-type') || 'image/jpeg';
            const buffer = await upstream.arrayBuffer();
            if (buffer.byteLength <= MAX_FRAME_BYTES) {
              return new Response(buffer, {
                headers: {
                  'Content-Type': contentType,
                  'Cache-Control': 'no-store',
                  'X-CCTV-Source': 'upstream-image',
                },
              });
            }
          }
        }
      } catch (err) {
        console.warn('[cctv] frame fetch failed for', cameraId, err?.message);
      }
    }

    // Fallback: return SVG billboard placeholder so the image preloader succeeds
    const label = url.searchParams.get('label') || camera?.name || cameraId || 'CCTV Camera';
    const city = url.searchParams.get('city') || camera?.city || 'GLOBAL GRID';
    const svg = buildSyntheticCctvSvg({
      cameraId: cameraId || 'cctv-preview',
      label,
      city,
      status: cameraUrl ? 'UPSTREAM OFFLINE' : 'NO UPSTREAM FEED',
    });
    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-CCTV-Source': 'synthetic',
      },
    });
  }

  // 3. Health check route: /api/cctv/health
  if (url.pathname === '/api/cctv/health' || url.pathname.endsWith('/health')) {
    const healthList = BASE_CAMERAS.map((c) => ({
      id: c.id,
      status: 'ok',
      sourceKind: c.sourceKind || 'snapshot',
      label: c.provider || c.name,
      message: 'Active',
      updatedAt: Date.now(),
    }));
    return Response.json({ status: 'ok', cameras: healthList }, { headers: noStore });
  }

  // 4. Catalog sources: /api/cctv/sources, /api/cctv
  const cached = cacheGet('cctv:catalog', CATALOG_TTL_MS);
  if (cached) {
    // Dynamically attach archive availability based on live env
    const enrichedSources = cached.sources.map((cam) => ({
      ...cam,
      archives: buildArchivesMeta(env, cam.id),
    }));
    return Response.json(
      { ...cached, sources: enrichedSources, cameras: enrichedSources },
      {
        headers: {
          'Cache-Control': 'no-store',
          'X-GEV-Cache': 'HIT',
        },
      },
    );
  }

  // Merge base curated cameras with live Austin cameras if available
  const liveAustin = await fetchAustinCameras(100);
  const byId = new Map();
  for (const cam of BASE_CAMERAS) byId.set(cam.id, cam);
  for (const cam of liveAustin) byId.set(cam.id, cam);
  const allCameras = Array.from(byId.values()).map((cam) => ({
    ...cam,
    archives: buildArchivesMeta(env, cam.id),
  }));

  const payload = {
    sources: allCameras,
    cameras: allCameras,
    source: 'Gods Eye View CCTV Registry',
    count: allCameras.length,
    fetchedAt: Date.now(),
  };

  cacheSet('cctv:catalog', payload);
  return Response.json(payload, {
    headers: {
      'Cache-Control': 'no-store',
      'X-GEV-Cache': 'MISS',
    },
  });
}
