/**
 * OpenAI Realtime token handler.
 * Ported from server/providers/openai/realtime.js (createRealtimeTokenHandler)
 *
 * Routes:
 *   POST /api/realtime/token        → ephemeral Realtime client secret
 *   GET  /api/realtime/oauth-status → always returns unavailable (cloud mode)
 *   POST /api/realtime/oauth-login  → always returns unavailable (cloud mode)
 */

// Default constants from server/providers/openai/constants.js
const DEFAULTS = {
  model:       'gpt-realtime-2',
  modelMini:   'gpt-realtime-2.1-mini',
  voice:       'marin',
  reasoning:   'low',
  ctxTokens:   3000,
  ctxRetain:   0.5,
  transcribe:  'gpt-4o-mini-transcribe',
};

const REALTIME_ENDPOINT = 'https://api.openai.com/v1/realtime/client_secrets';

function resolveModel(env, tier) {
  if (tier === 'mini') {
    return String(env.OPENAI_REALTIME_MODEL_MINI || DEFAULTS.modelMini);
  }
  return String(env.OPENAI_REALTIME_MODEL || DEFAULTS.model);
}

function resolveTier(raw) {
  if (raw === 'mini') return 'mini';
  return 'standard';
}

export async function handleRealtime(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

  // ── OAuth routes: not available in cloud mode ─────────────────────────────
  if (path === '/api/realtime/oauth-status') {
    return Response.json({ available: false, error: 'ChatGPT OAuth is not available in cloud deployments.' }, { headers: noStore });
  }
  if (path === '/api/realtime/oauth-login') {
    return Response.json({ available: false, error: 'ChatGPT OAuth sign-in is not available in cloud deployments.' }, { status: 503, headers: noStore });
  }

  // ── Token endpoint ────────────────────────────────────────────────────────
  if (path !== '/api/realtime/token') {
    return new Response('Not found', { status: 404 });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: noStore });
  }

  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return Response.json({ error: 'OPENAI_API_KEY is not set' }, { status: 503, headers: noStore });
  }

  const tier  = resolveTier(url.searchParams.get('tier') ?? '');
  const model = resolveModel(env, tier);
  const voice = String(env.OPENAI_REALTIME_VOICE || DEFAULTS.voice);
  const effort = String(env.OPENAI_REALTIME_REASONING_EFFORT || DEFAULTS.reasoning);

  const ctxTokens = Math.round(
    Math.max(1000, Math.min(12000, Number(env.OPENAI_REALTIME_CONTEXT_TOKENS) || DEFAULTS.ctxTokens)),
  );
  const ctxRetain = Math.max(0.1, Math.min(1, Number(env.OPENAI_REALTIME_CONTEXT_RETENTION) || DEFAULTS.ctxRetain));
  const transcribeModel = String(env.OPENAI_REALTIME_TRANSCRIBE_MODEL || DEFAULTS.transcribe);
  const transcription = transcribeModel.toLowerCase() === 'off'
    ? {}
    : { transcription: { model: transcribeModel } };

  const sessionConfig = {
    session: {
      type: 'realtime',
      model,
      reasoning: { effort },
      truncation: {
        type: 'retention_ratio',
        retention_ratio: ctxRetain,
        token_limits: { post_instructions: ctxTokens },
      },
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          ...transcription,
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'low',
            create_response: true,
            interrupt_response: false,
          },
        },
        output: { voice },
      },
      tool_choice: 'auto',
    },
  };

  try {
    const upstream = await fetch(REALTIME_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': 'eagle-eyes-cloud-deploy',
      },
      body: JSON.stringify(sessionConfig),
    });

    const body = await upstream.text();
    const responseHeaders = {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'X-GEV-Voice-Tier': tier,
      'X-GEV-Voice-Model': model,
      'X-GEV-Voice-Auth': 'env',
      'X-GEV-Voice-Transcribe-Model': transcription.transcription ? transcribeModel : 'off',
    };

    if (!upstream.ok) {
      console.warn('[realtime-token] upstream HTTP', upstream.status);
      return new Response(JSON.stringify({ error: 'Failed to create Realtime token' }), {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    return new Response(body, { status: upstream.status, headers: responseHeaders });
  } catch (err) {
    console.warn('[realtime-token] mint failed:', err?.message);
    return Response.json({ error: 'Failed to create Realtime token' }, { status: 502, headers: noStore });
  }
}
