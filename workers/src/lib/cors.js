/**
 * CORS headers for the Cloudflare Worker API.
 *
 * Vercel proxies /api/* to this Worker, so in production the browser only
 * ever sees the Vercel origin — the CORS headers here are for local dev
 * (wrangler dev on :8787, Vite on :4173) and any direct Worker access.
 */
const ALLOWED_ORIGINS = [
  'https://eagle-eyes-iota.vercel.app',
  'https://gods-eye-view.vercel.app',
  // Local development
  'http://localhost:4173',
  'http://localhost:5173',
  'http://localhost:3000',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow Vercel preview deployments for this project
  if (/^https:\/\/(eagle-eyes|gods-eye-view)[a-z0-9-]*\.vercel\.app$/i.test(origin)) {
    return true;
  }
  return false;
}

/**
 * Returns CORS response headers appropriate for the incoming request's origin.
 * @param {Request} request
 * @returns {Record<string, string>}
 */
export function corsHeaders(request) {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Handle CORS preflight and attach CORS headers to any Response.
 * Preserves explicit Access-Control-Allow-Origin headers set by handlers (e.g. '*').
 * @param {Request} request
 * @param {Response} response
 * @returns {Response}
 */
export function withCors(request, response) {
  const headers = new Headers(response.headers);
  const hasExplicitOrigin = headers.has('Access-Control-Allow-Origin');
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    if (k === 'Access-Control-Allow-Origin' && hasExplicitOrigin) continue;
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Respond to an OPTIONS preflight with 204 + CORS headers. */
export function handlePreflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
