// Builds the shared dependencies (store, model client, content, config) from a
// Worker's environment bindings. Cached per isolate.
import { buildConfig } from '../core/config.js';
import { ContentLibrary } from '../core/content.js';
import { LLM } from '../core/llm.js';
import { SqlStore } from '../core/sqlstore.js';
import { PACKS } from '../content/index.js';

function d1Driver(db) {
  return {
    all: async (sql, params) => (await db.prepare(sql).bind(...params).all()).results || [],
    get: async (sql, params) => (await db.prepare(sql).bind(...params).first()) ?? null,
    run: async (sql, params) => db.prepare(sql).bind(...params).run(),
  };
}

let cached = null;

export function workerDeps(env) {
  if (cached && cached.env === env) return cached.deps;
  const config = buildConfig(env);
  const base = config.publicUrl || 'https://quippy.party';
  const deps = {
    config,
    store: new SqlStore(d1Driver(env.DB)),
    llm: new LLM(config.llm),
    content: new ContentLibrary(PACKS, config.defaultLocale),
    joinUrl: (code) => `${base}/${code}`,
    log: (...args) => console.log(...args),
    ttsCache: env.MEDIA
      ? {
        get: async (key) => {
          const obj = await env.MEDIA.get(key);
          return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
        },
        put: async (key, bytes) => { await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: 'audio/mpeg' } }); },
      }
      : { get: async () => null, put: async () => {} },
  };
  cached = { env, deps };
  return deps;
}
