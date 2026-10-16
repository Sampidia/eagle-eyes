/**
 * FIRMS active-fire handler.
 * Ported from server/providers/firms.js
 *
 * Fetches NASA FIRMS CSV data for four VIIRS/MODIS sources, parses it, and
 * returns a JSON payload. In-memory cache with 30-minute TTL (mirrors original).
 * No disk cache — stale-from-cache is still served on upstream failure.
 *
 * Routes:
 *   GET /api/firms         → {fetchedAt, stale, ttlMs, sources, count, fires}
 *   GET /api/firms/status  → {hasKey, lastFetch, count, stale, ttlMs, transactions}
 */

import { cacheGet, cacheSet } from '../lib/cache.js';

const TTL_MS = 30 * 60_000;
const STATUS_TTL_MS = 5 * 60_000;

const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];

/** Parse a FIRMS CSV text into an array of fire objects. */
function parseFirmsCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map((h) => h.trim());
  const latIdx = headers.indexOf('latitude');
  const lonIdx = headers.indexOf('longitude');
  if (latIdx < 0 || lonIdx < 0) return null; // not a CSV (probably an HTML error page)

  const fires = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < headers.length) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = cols[j]?.trim();
    fires.push(obj);
  }
  return fires;
}

/** Keep only fires detected in the trailing 24 hours. */
function filterTrailing24h(fires, nowMs = Date.now()) {
  const cutoff = nowMs - 24 * 3600_000;
  return fires.filter((f) => {
    const acqDate = f.acq_date ?? '';
    const acqTime = String(f.acq_time ?? '').padStart(4, '0');
    try {
      const epoch = new Date(`${acqDate}T${acqTime.slice(0, 2)}:${acqTime.slice(2)}:00Z`).getTime();
      return Number.isFinite(epoch) && epoch >= cutoff;
    } catch {
      return true;
    }
  });
}

async function fetchSource(key, source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(55_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const records = parseFirmsCsv(text);
  if (records === null) throw new Error('non-CSV upstream response (key may be invalid)');
  return records;
}

async function refreshUpstream(key) {
  const now = Date.now();
  const sources = [];
  const fires = [];
  for (const source of SOURCES) {
    try {
      const records = filterTrailing24h(await fetchSource(key, source), now);
      for (const r of records) fires.push(r);
      sources.push({ source, count: records.length, ok: true });
    } catch (err) {
      console.warn(`[firms] ${source} failed:`, err?.message);
      sources.push({ source, count: 0, ok: false });
    }
  }
  if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
  return { at: now, sources, fires };
}

export async function handleFirms(request, env) {
  const url = new URL(request.url);
  const isStatus = url.pathname.endsWith('/status');
  const key = String(env.FIRMS_MAP_KEY || '').trim();

  const sendJson = (status, obj) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  // ── Status route ──────────────────────────────────────────────────────────
  if (isStatus) {
    if (!key) return sendJson(200, { hasKey: false, lastFetch: null, count: null, stale: false, ttlMs: TTL_MS, transactions: null });
    const cached = cacheGet('firms:data', Infinity); // any age for metadata
    let transactions = null;
    const statusCached = cacheGet('firms:status', STATUS_TTL_MS);
    if (statusCached) {
      transactions = statusCached;
    } else {
      try {
        const statusRes = await fetch(
          `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (statusRes.ok) {
          const body = await statusRes.json();
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          if (Number.isFinite(used) && Number.isFinite(limit)) {
            transactions = { used, limit };
            cacheSet('firms:status', transactions);
          }
        }
      } catch { /* best-effort */ }
    }
    return sendJson(200, {
      hasKey: true,
      lastFetch: cached?.at ?? null,
      count: cached?.fires?.length ?? null,
      stale: cached ? Date.now() - cached.at >= TTL_MS : false,
      ttlMs: TTL_MS,
      transactions,
    });
  }

  // ── No key ────────────────────────────────────────────────────────────────
  if (!key) return sendJson(503, { error: 'no_key' });

  // ── Cache hit ─────────────────────────────────────────────────────────────
  const cached = cacheGet('firms:data', TTL_MS);
  if (cached) {
    const fires = filterTrailing24h(cached.fires);
    return sendJson(200, { fetchedAt: cached.at, stale: false, ttlMs: TTL_MS, sources: cached.sources, count: fires.length, fires });
  }

  // ── Refresh upstream ──────────────────────────────────────────────────────
  try {
    const fresh = await refreshUpstream(key);
    cacheSet('firms:data', fresh);
    const fires = filterTrailing24h(fresh.fires);
    return sendJson(200, { fetchedAt: fresh.at, stale: false, ttlMs: TTL_MS, sources: fresh.sources, count: fires.length, fires });
  } catch (err) {
    console.warn('[firms] refresh failed:', err?.message);
    // Serve stale cache from this isolate's lifetime if available
    const stale = cacheGet('firms:data', Infinity);
    if (stale) {
      const fires = filterTrailing24h(stale.fires);
      return sendJson(200, { fetchedAt: stale.at, stale: true, ttlMs: TTL_MS, sources: stale.sources, count: fires.length, fires });
    }
    return sendJson(502, { error: 'firms fetch failed and no cache available' });
  }
}
