/**
 * CORS headers for the Cloudflare Worker API.
 *
 * Vercel proxies /api/* to this Worker, so in production the browser only
 * ever sees the Vercel origin — the CORS headers here are for local dev
 * (wrangler dev on :8787, Vite on :4173) and any direct Worker access.
 */
const ALLOWED_ORIGINS = [
  // Production Vercel deployment — replace with real URL after first deploy
  'https://gods-eye-view.vercel.app',
  // Local development
  'http://localhost:4173',
  'http://localhost:5173',
  'http://localhost:3000',
];

/**
 * Returns CORS response headers appropriate for the incoming request's origin.
 * @param {Request} request
 * @returns {Record<string, string>}
 */
export function corsHeaders(request) {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Handle CORS preflight and attach CORS headers to any Response.
 * @param {Request} request
 * @param {Response} response
 * @returns {Response}
 */
export function withCors(request, response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Respond to an OPTIONS preflight with 204 + CORS headers. */
export function handlePreflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
