// vite.config.vercel.js
// Pure static build — no local provider middleware.
// All /api/* routes are handled by the Cloudflare Worker.
// Used by: npm run build:vercel (called by Vercel's build step).

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { createBrowserViteConfig } from './build/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(() => {
  return createBrowserViteConfig({
    // No local provider plugins — all /api/* goes to Cloudflare Worker
    plugins: [],
    googleApiKey:   process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken:    process.env.CESIUM_ION_TOKEN,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    command: 'build',
  });
});
