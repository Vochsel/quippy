// Registers the locale content packs. Static imports keep this bundle-able for
// Cloudflare Workers. To add a locale: copy content/locales/en-AU to e.g.
// content/locales/en-GB, translate/rewrite, and add it here. Missing files fall
// back to the same language, then to the default locale.
import enAUmeta from './locales/en-AU/meta.json' with { type: 'json' };
import enAUprompts from './locales/en-AU/prompts.json' with { type: 'json' };
import enAUfinal from './locales/en-AU/final.json' with { type: 'json' };
import enAUpersonal from './locales/en-AU/personal.json' with { type: 'json' };
import enAUpanic from './locales/en-AU/panic.json' with { type: 'json' };
import enAUcallbacks from './locales/en-AU/callbacks.json' with { type: 'json' };
import enAUhost from './locales/en-AU/host.json' with { type: 'json' };

export const PACKS = {
  'en-AU': {
    meta: enAUmeta,
    prompts: enAUprompts,
    final: enAUfinal,
    personal: enAUpersonal,
    panic: enAUpanic,
    callbacks: enAUcallbacks,
    host: enAUhost,
  },
};
