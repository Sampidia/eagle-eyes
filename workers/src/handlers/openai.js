/**
 * OpenAI HUD Summary handler.
 * Ported from server/providers/openai/hud-summary.js
 *
 * Generates a short AI-written HUD status summary from scene context
 * submitted by the client.
 *
 * Routes:
 *   POST /api/openai/hud-summary → {summary: string} or {error}
 */

const HUD_SUMMARY_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_BODY_BYTES = 64 * 1024; // 64 KB — sanity cap on client payload

export async function handleOpenAI(request, env) {
  const url = new URL(request.url);
  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  if (url.pathname !== '/api/openai/hud-summary') {
    return new Response('Not found', { status: 404 });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: noStore });
  }

  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return Response.json({ error: 'OPENAI_API_KEY is not set' }, { status: 503, headers: noStore });
  }

  // Read and size-cap the client body
  let clientBody;
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'Request body too large' }, { status: 413, headers: noStore });
    }
    clientBody = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: noStore });
  }

  const model = String(env.OPENAI_HUD_SUMMARY_MODEL || 'gpt-5-nano');
  const sceneContext = String(clientBody?.context || '').slice(0, 8000);

  if (!sceneContext) {
    return Response.json({ error: 'context field required' }, { status: 400, headers: noStore });
  }

  try {
    const upstream = await fetch(HUD_SUMMARY_ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 120,
        messages: [
          {
            role: 'system',
            content: 'You are a concise intelligence briefing assistant for a real-time geospatial platform. Write a 1-2 sentence HUD status summary of the current scene. Be factual, direct, and under 120 words.',
          },
          { role: 'user', content: sceneContext },
        ],
      }),
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok || !data) {
      console.warn('[hud-summary] upstream HTTP', upstream.status);
      return Response.json({ error: 'HUD summary generation failed' }, { status: upstream.status || 502, headers: noStore });
    }

    const summary = data?.choices?.[0]?.message?.content?.trim() ?? '';
    return Response.json({ summary, model }, { headers: noStore });
  } catch (err) {
    console.warn('[hud-summary] fetch failed:', err?.message);
    return Response.json({ error: 'HUD summary unavailable' }, { status: 502, headers: noStore });
  }
}
