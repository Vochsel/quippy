// Runtime-agnostic configuration. Both runtimes (the Node server and the
// Cloudflare Worker) call buildConfig() with their environment variables.
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const trimSlash = (s) => (s || '').replace(/\/+$/, '');

export function buildConfig(env = {}) {
  return {
    // Public origin phones should open, e.g. https://quippy.party.
    // Leave blank to derive it from the request (handy on a LAN).
    publicUrl: trimSlash(env.PUBLIC_URL),
    defaultLocale: env.QUIPPY_LOCALE || 'en-AU',
    dev: env.QUIPPY_DEV === '1' || env.QUIPPY_DEV === 'true',

    // Language model for AI-flavoured games. Every provider is spoken to over
    // the OpenAI-compatible chat-completions protocol.
    //   auto     -> Vercel AI Gateway if AI_GATEWAY_API_KEY is set, otherwise a
    //               local Ollama / LM Studio server if one answers, otherwise
    //               the built-in template brain
    //   ollama   -> http://localhost:11434/v1
    //   lmstudio -> http://localhost:1234/v1
    //   vercel   -> https://ai-gateway.vercel.sh/v1 (AI_GATEWAY_API_KEY)
    //   openai-compatible -> set LLM_BASE_URL (+ LLM_API_KEY)
    //   none     -> never call a model
    llm: {
      provider: (env.LLM_PROVIDER || 'auto').toLowerCase(),
      baseUrl: trimSlash(env.LLM_BASE_URL),
      apiKey: env.LLM_API_KEY || '',
      gatewayKey: env.AI_GATEWAY_API_KEY || '',
      model: env.LLM_MODEL || '',
      timeoutMs: num(env.LLM_TIMEOUT_MS, 30000),
      temperature: env.LLM_TEMPERATURE === undefined || env.LLM_TEMPERATURE === '' ? null : num(env.LLM_TEMPERATURE, null),
    },

    // Host voice-over: "browser" = the TV browser's speech voices;
    // "elevenlabs" = a voice of your choosing via ElevenLabs (cached).
    voice: {
      provider: (env.TTS_PROVIDER || (env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'browser')).toLowerCase(),
      elevenLabsKey: env.ELEVENLABS_API_KEY || '',
      elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID || '',
      elevenLabsModel: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    },

    // Default timings in seconds (answer time can be changed per room).
    timing: {
      answer: num(env.QUIPPY_ANSWER_SECONDS, 90),
      vote: num(env.QUIPPY_VOTE_SECONDS, 20),
      finalAnswer: num(env.QUIPPY_FINAL_ANSWER_SECONDS, 75),
      finalVote: num(env.QUIPPY_FINAL_VOTE_SECONDS, 30),
    },

    roomTtlHours: num(env.QUIPPY_ROOM_TTL_HOURS, 24),
  };
}
