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
    version: env.QUIPPY_VERSION || 'dev',

    // Product analytics (PostHog). The project token is public (it also ships
    // to browsers); leave it blank to turn analytics off.
    posthog: { key: env.POSTHOG_KEY || '', host: trimSlash(env.POSTHOG_HOST) || 'https://us.i.posthog.com' },

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
      // A stronger model for the writing that has to make sense (Callback Club
      // prompts). Only used through the Vercel AI Gateway; '' = use `model`.
      smartModel: env.LLM_SMART_MODEL ?? 'anthropic/claude-fable-5.2',
      timeoutMs: num(env.LLM_TIMEOUT_MS, 30000),
      temperature: env.LLM_TEMPERATURE === undefined || env.LLM_TEMPERATURE === '' ? null : num(env.LLM_TEMPERATURE, null),
    },

    // Host voice-over, tried in order until one works:
    //   local      -> a local voice model with an OpenAI-style /audio/speech
    //                 endpoint (Kokoro-FastAPI, openedai-speech, ...)
    //   gateway    -> a speech model on the Vercel AI Gateway (AI SDK), using
    //                 AI_GATEWAY_API_KEY. Default: Gemini Flash TTS, cheap + steerable
    //   elevenlabs -> ElevenLabs with ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID
    //   browser    -> the TV browser's built-in speech voices (always last)
    // TTS_PROVIDER: auto (= local,gateway,elevenlabs) | local | gateway | elevenlabs | browser,
    // or an explicit route such as "elevenlabs,local".
    voice: {
      route: (() => {
        const p = (env.TTS_PROVIDER || 'auto').toLowerCase();
        const list = p === 'auto' ? ['local', 'gateway', 'elevenlabs'] : p.split(',').map((s) => s.trim());
        return list.filter((x) => ['local', 'gateway', 'elevenlabs'].includes(x));
      })(),
      localUrl: trimSlash(env.TTS_LOCAL_URL || 'http://localhost:8880/v1'),
      localVoice: env.TTS_LOCAL_VOICE || 'bm_george',
      localModel: env.TTS_LOCAL_MODEL || '',
      localSpeed: num(env.TTS_LOCAL_SPEED, 1.05),
      localKey: env.TTS_LOCAL_API_KEY || '',
      gatewayKey: env.AI_GATEWAY_API_KEY || '',
      gatewayModel: env.TTS_GATEWAY_MODEL || 'google/gemini-3.8-flash-tts',
      gatewayVoice: env.TTS_GATEWAY_VOICE || 'Charon',
      gatewayInstructions: env.TTS_GATEWAY_INSTRUCTIONS
        || 'You are Monty, a game-show host: dry, deadpan, faintly world-weary, quietly amused. Australian accent. Brisk pace, crisp comic timing, a slight pause before punchlines. Never shouty. Read the text exactly as written, word for word: keep misspellings, slang, typos and made-up words as they are, never correct, expand or rephrase anything.',
      elevenLabsKey: env.ELEVENLABS_API_KEY || '',
      elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID || '',
      elevenLabsModel: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    },

    // Image generation (Picture Duel), through the Vercel AI Gateway with the
    // same AI_GATEWAY_API_KEY. Without a key (or IMAGE_PROVIDER=none) games get
    // cheap SVG placeholders instead, and bots never call the model.
    //   IMAGE_MODEL  default bfl/flux-3-image-klein (~US$0.008 at 768px, ~5 s,
    //                takes a reference photo). Alternatives on the gateway:
    //                openai/gpt-image-1-mini (slower, flatter), recraft/recraft-v4.1-flash,
    //                bytedance/seedream-5.5, bfl/flux-3-image (pricier, sharper).
    //                Gemini "flash image" models are chat models on the gateway and
    //                aren't supported by this image path.
    image: {
      provider: (env.IMAGE_PROVIDER || 'auto').toLowerCase(), // auto | gateway | none
      gatewayKey: env.AI_GATEWAY_API_KEY || '',
      // GPT Image 2.5 Flare keeps people recognisable from a selfie and follows briefs
      // closely; "low" quality is ~12s and ~1.4c an image (2.5-sunburst: best likeness, ~17s).
      model: env.IMAGE_MODEL || 'openai/gpt-image-2.5-flare',
      quality: env.IMAGE_QUALITY || 'low',
      size: env.IMAGE_SIZE || '1024x1024',
      timeoutMs: num(env.IMAGE_TIMEOUT_MS, 90000),
    },

    // Default timings in seconds (answer time can be changed per room).
    timing: {
      answer: num(env.QUIPPY_ANSWER_SECONDS, 90),
      vote: num(env.QUIPPY_VOTE_SECONDS, 20),
      finalAnswer: num(env.QUIPPY_FINAL_ANSWER_SECONDS, 75),
      finalVote: num(env.QUIPPY_FINAL_VOTE_SECONDS, 30),
    },

    // Longest answer a player can write (rooms can change it in the lobby).
    answerChars: num(env.QUIPPY_ANSWER_CHARS, 200),

    roomTtlHours: num(env.QUIPPY_ROOM_TTL_HOURS, 24),
  };
}
