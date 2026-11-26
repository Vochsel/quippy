// Localised content packs: prompts, final-round prompts, personalised prompts,
// panic-button answers, callback templates and the host's lines. A pack lives
// in content/locales/<locale>/ and is registered in content/index.js.
//
// Lookups fall back from the requested locale to any pack with the same
// language (en-NZ -> en-AU) and finally to the default locale, file by file,
// so a new locale can start with just a few files and borrow the rest.
import { fill, hash, pick, shuffle } from './util.js';

const FILES = ['prompts', 'final', 'personal', 'panic', 'callbacks', 'host', 'pictures'];

export class ContentLibrary {
  constructor(packs, defaultLocale = 'en-AU') {
    this.packs = packs;
    this.defaultLocale = packs[defaultLocale] ? defaultLocale : Object.keys(packs)[0];
    this.cache = new Map();
  }

  locales() {
    return Object.entries(this.packs).map(([id, p]) => ({
      id, name: p.meta?.name || id, label: p.meta?.label || id, flag: p.meta?.flag || '',
      prompts: (p.prompts?.prompts || []).length,
    }));
  }

  resolveLocale(locale) {
    if (locale && this.packs[locale]) return locale;
    const lang = String(locale || '').split('-')[0];
    const sameLang = Object.keys(this.packs).find((k) => k.split('-')[0] === lang);
    return sameLang || this.defaultLocale;
  }

  #chain(locale) {
    const first = this.resolveLocale(locale);
    const lang = first.split('-')[0];
    const chain = [first, ...Object.keys(this.packs).filter((k) => k !== first && k.split('-')[0] === lang), this.defaultLocale];
    return [...new Set(chain)];
  }

  pack(locale) {
    const id = this.resolveLocale(locale);
    if (this.cache.has(id)) return this.cache.get(id);
    const chain = this.#chain(id);
    const get = (file) => {
      for (const l of chain) if (this.packs[l]?.[file]) return { locale: l, data: this.packs[l][file] };
      return { locale: id, data: null };
    };
    const keyed = (file, field = 'prompts') => {
      const { locale: l, data } = get(file);
      return (data?.[field] || []).map((p) => {
        const item = typeof p === 'string' ? { text: p, tags: [] } : p;
        return { ...item, tags: item.tags || [], key: `${l}:${file}:${hash(item.text)}` };
      });
    };
    const meta = { ...(this.packs[this.defaultLocale]?.meta || {}), ...(this.packs[id]?.meta || {}), id };
    const pack = {
      id,
      meta,
      prompts: keyed('prompts'),
      final: keyed('final'),
      personal: keyed('personal'),
      pictures: keyed('pictures'), // visual briefs for Picture Duel
      panic: get('panic').data?.answers || [],
      callbacks: get('callbacks').data || { templates: [] },
      host: get('host').data?.lines || {},
    };
    this.cache.set(id, pack);
    return pack;
  }

  forRoom({ locale, family }) {
    return new RoomContent(this.pack(locale), !!family);
  }
}

export class RoomContent {
  constructor(pack, family) {
    this.pack = pack;
    this.meta = pack.meta;
    this.family = family;
    const ok = (p) => !(family && p.tags.includes('spicy'));
    this.prompts = pack.prompts.filter(ok);
    this.final = pack.final.filter(ok);
    this.personal = pack.personal.filter(ok);
    this.pictures = (pack.pictures || []).filter(ok);
  }

  // Choose n prompts, preferring ones this crew hasn't seen and spreading tags.
  #choose(pool, n, used) {
    const fresh = shuffle(pool.filter((p) => !used?.has(p.key)));
    const stale = shuffle(pool.filter((p) => used?.has(p.key)));
    const ordered = [...fresh, ...stale];
    const chosen = [];
    const tagCount = new Map();
    for (const p of ordered) {
      if (chosen.length >= n) break;
      const main = p.tags[0] || 'misc';
      if ((tagCount.get(main) || 0) >= Math.max(2, Math.ceil(n / 3)) && ordered.length > n * 3) continue;
      tagCount.set(main, (tagCount.get(main) || 0) + 1);
      chosen.push(p);
    }
    for (const p of ordered) {
      if (chosen.length >= n) break;
      if (!chosen.includes(p)) chosen.push(p);
    }
    return chosen;
  }

  pickPrompts(n, used) { return this.#choose(this.prompts, n, used); }
  pickFinal(used) { return this.#choose(this.final.length ? this.final : this.prompts, 1, used)[0]; }
  pickPersonal(n, used) { return this.#choose(this.personal, n, used); }
  // Visual briefs (falls back to the regular prompts if a pack has none).
  pickPictures(n, used) { return this.#choose(this.pictures.length ? this.pictures : this.prompts, n, used); }
  freshCount(used) { return this.prompts.filter((p) => !used?.has(p.key)).length; }

  panic() {
    return this.pack.panic.length ? pick(this.pack.panic) : 'Something, probably';
  }

  callbackTemplates() { return this.pack.callbacks.templates || []; }

  // A host line for an event, with {placeholders} filled. Returns '' if the
  // pack has nothing for that event.
  line(key, vars = {}) {
    const options = this.pack.host[key];
    if (!options?.length) return '';
    return fill(pick(options), vars);
  }
}
