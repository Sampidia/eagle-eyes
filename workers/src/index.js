/**
 * Cloudflare Worker — Eagle Eyes API router
 *
 * All /api/* routes from the Vercel frontend are rewritten to this Worker.
 * The Worker dispatches to individual handler modules, attaches CORS headers,
 * and returns a 404 for unknown routes.
 *
 * Adding a new route:
 *   1. Create workers/src/handlers/myfeature.js exporting handleMyFeature
 *   2. Import it below and add an entry to ROUTES
 *   3. wrangler deploy
 */

import { handleAdsb }      from './handlers/adsb.js';
import { handleVessels }   from './handlers/vessels.js';
import { handleFirms }     from './handlers/firms.js';
import { handleSpace }     from './handlers/space.js';
import { handleRealtime }  from './handlers/realtime.js';
import { handleOpenAI }    from './handlers/openai.js';
import { handleGoogle }    from './handlers/google.js';
import { handleTomTom }    from './handlers/tomtom.js';
import { handleTerrain }   from './handlers/terrain.js';
import { handleWeather }   from './handlers/weather.js';
import { handleWind }      from './handlers/wind.js';
import { handleCctv }      from './handlers/cctv.js';
import { handleOverpass }  from './handlers/overpass.js';
import { handleMilitary }  from './handlers/military.js';
import { handleMapillary } from './handlers/mapillary.js';
import { handleRadio }     from './handlers/radio.js';
import { handleGbfs }      from './handlers/gbfs.js';
import { handleTransit }   from './handlers/transit.js';
import { handleCyclones }  from './handlers/cyclones.js';
import { handleGnss }      from './handlers/gnss.js';
import { withCors, handlePreflight } from './lib/cors.js';

/**
 * Route table: [urlPathPrefix, handlerFn]
 * Handlers receive (request, env, ctx) and return a Response.
 * The first matching prefix wins.
 */
const ROUTES = [
  // Aircraft
  ['/api/flights',        handleAdsb],
  // Vessels
  ['/api/vessels',        handleVessels],
  // Fires
  ['/api/firms',          handleFirms],
  // Space: satellites + launches (two prefixes, same handler)
  ['/api/celestrak',      handleSpace],
  ['/api/launches',       handleSpace],
  // Voice / AI
  ['/api/realtime/',      handleRealtime],
  ['/api/openai/',        handleOpenAI],
  // Maps / geo
  ['/api/google/',        handleGoogle],
  ['/api/tomtom/',        handleTomTom],
  ['/api/terrain',        handleTerrain],
  // Atmosphere
  ['/api/weather',        handleWeather],
  ['/api/wind',           handleWind],
  // Cameras
  ['/api/cctv',           handleCctv],
  // OSM
  ['/api/overpass',       handleOverpass],
  ['/api/military',       handleMilitary],
  // Street-level
  ['/api/mapillary',      handleMapillary],
  // Media & mobility
  ['/api/radio/',         handleRadio],
  ['/api/gbfs',           handleGbfs],
  ['/api/transit',        handleTransit],
  // Hazards
  ['/api/cyclones',       handleCyclones],
  ['/api/gnss',           handleGnss],
];

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight for all routes
    if (request.method === 'OPTIONS') return handlePreflight(request);

    const { pathname } = new URL(request.url);

    // Health check
    if (pathname === '/health' || pathname === '/api/health') {
      return withCors(request, Response.json({ status: 'ok', ts: Date.now() }));
    }

    for (const [prefix, handler] of ROUTES) {
      if (pathname === prefix || pathname.startsWith(prefix)) {
        try {
          const response = await handler(request, env, ctx);
          return withCors(request, response);
        } catch (err) {
          console.error(`[Worker] Unhandled error in ${prefix}:`, err?.message ?? err);
          return withCors(
            request,
            Response.json({ error: 'Internal Worker error' }, { status: 500 }),
          );
        }
      }
    }

    return withCors(request, new Response('Not found', { status: 404 }));
  },
};
