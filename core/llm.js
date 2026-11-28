// One small client for every language model Quippy can use. Local servers
// (Ollama, LM Studio, llama.cpp, vLLM) and the Vercel AI Gateway all speak the
// OpenAI-compatible chat-completions protocol, so a single fetch-based client
// covers them, in Node and in Cloudflare Workers alike.
//
// Nothing in the game depends on a model being present: when no provider is
// reachable (or a call fails / times out) callers fall back to the built-in
// template brain, and the host screen shows which brain is in charge.

const PRESETS = {
  ollama: { baseUrl: 'http://localhost:11434/v1', label: 'Ollama (local)' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', label: 'LM Studio (local)' },
  vercel: { baseUrl: 'https://ai-gateway.vercel.sh/v1', label: 'Vercel AI Gateway', defaultModel: 'anthropic/claude-opus-5.5' },
  'openai-compatible': { baseUrl: '', label: 'OpenAI-compatible' },
};

// Preference order when picking a local model automatically.
const LOCAL_MODEL_PREFS = ['llama3.1', 'llama3.2', 'gemma3', 'qwen3', 'qwen2.5', 'mistral', 'phi4', 'llama3'];

export class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this.provider = 'none';
    this.baseUrl = '';
    this.model = '';
    this.apiKey = '';
    this.label = 'Built-in brain';
    this.lastError = null;
    this.calls = 0;
    this.failures = 0;
    this.lastLatencyMs = null;
    this.readyPromise = null;
  }

  available() { return this.provider !== 'none' && !!this.model; }

  status() {
    return {
      provider: this.provider, label: this.label, model: this.model || null, available: this.available(),
      calls: this.calls, failures: this.failures, lastError: this.lastError, lastLatencyMs: this.lastLatencyMs,
    };
  }

  init() {
    this.readyPromise ||= this.#detect().catch((e) => {
      this.lastError = String(e?.message || e);
      this.provider = 'none';
    });
    return this.readyPromise;
  }

  async #detect() {
    const c = this.cfg;
    const want = c.provider;
    if (want === 'none' || want === 'off') return;

    const use = async (name, baseUrl, apiKey, model) => {
      this.provider = name;
      this.baseUrl = baseUrl;
      this.apiKey = apiKey || '';
      this.label = PRESETS[name]?.label || name;
      this.model = model || c.model || PRESETS[name]?.defaultModel || '';
      if (!this.model) this.model = await this.#pickLocalModel();
      if (!this.model) {
        this.lastError = `No model available at ${baseUrl}. Set LLM_MODEL (e.g. "ollama pull llama3.1").`;
        this.provider = 'none';
      }
    };

    if (want === 'vercel' || (want === 'auto' && c.gatewayKey)) {
      if (!c.gatewayKey && !c.apiKey) {
        this.lastError = 'LLM_PROVIDER=vercel but AI_GATEWAY_API_KEY is not set';
        return;
      }
      return use('vercel', c.baseUrl || PRESETS.vercel.baseUrl, c.gatewayKey || c.apiKey);
    }
    if (want === 'openai-compatible' || (want === 'auto' && c.baseUrl)) {
      return use('openai-compatible', c.baseUrl, c.apiKey);
    }
    if (want === 'ollama' || want === 'lmstudio') {
      return use(want, c.baseUrl || PRESETS[want].baseUrl, c.apiKey);
    }
    if (want === 'auto') {
      for (const name of ['ollama', 'lmstudio']) {
        const base = PRESETS[name].baseUrl;
        if (await this.#reachable(base)) return use(name, base, c.apiKey);
      }
    }
  }

  async #reachable(baseUrl) {
    try {
      const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1200) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async #pickLocalModel() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.#headers(), signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return '';
      const body = await res.json();
      const ids = (body.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
      for (const pref of LOCAL_MODEL_PREFS) {
        const hit = ids.find((id) => id.toLowerCase().startsWith(pref));
        if (hit) return hit;
      }
      return ids[0] || '';
    } catch {
      return '';
    }
  }

  #headers() {
    const h = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  #isLocal() { return this.provider === 'ollama' || this.provider === 'lmstudio'; }

  // Ask for a JSON object. Returns the parsed object or throws.
  // smart: use the stronger model (cfg.smartModel) for this call, when the
  // gateway is in use; local models just use their one model.
  async json({ system, user, maxTokens = 1200, timeoutMs, smart = false }) {
    await this.init();
    if (!this.available()) throw new Error('no-llm');
    const body = {
      model: smart && this.provider === 'vercel' && this.cfg.smartModel ? this.cfg.smartModel : this.model,
      messages: [
        { role: 'system', content: `${system}\n\nRespond with a single JSON object and nothing else.` },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      stream: false,
    };
    // Local models are happier (and funnier) with a little heat and a JSON
    // grammar. Hosted models through the gateway get neither: some reject
    // sampling parameters outright, and the prompt already pins the format.
    const temp = this.cfg.temperature ?? (this.#isLocal() ? 0.9 : null);
    if (temp !== null && this.provider !== 'vercel') body.temperature = temp;
    if (this.#isLocal()) body.response_format = { type: 'json_object' };

    const started = Date.now();
    this.calls += 1;
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || this.cfg.timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error(`reply truncated at max_tokens=${maxTokens}`);
      const content = choice?.message?.content;
      const text = Array.isArray(content) ? content.map((p) => p.text || '').join('') : String(content || '');
      const parsed = extractJson(text);
      if (!parsed) throw new Error(`Model did not return JSON: ${text.slice(0, 120)}`);
      this.lastLatencyMs = Date.now() - started;
      this.lastError = null;
      return parsed;
    } catch (e) {
      this.failures += 1;
      this.lastError = String(e?.message || e).slice(0, 240);
      throw e;
    }
  }
}

// Pull the first JSON object out of a model reply, tolerating <think> blocks
// from reasoning models and ```json fences.
export function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
