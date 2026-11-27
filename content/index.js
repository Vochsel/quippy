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
import enAUpictures from './locales/en-AU/pictures.json' with { type: 'json' };
// Host personas (see core/tones.js); regenerate with scripts/gen-tones.mjs.
import enAUtoneSexy from './locales/en-AU/tones/sexy.json' with { type: 'json' };
import enAUtoneArgumentative from './locales/en-AU/tones/argumentative.json' with { type: 'json' };
import enAUtoneTherapist from './locales/en-AU/tones/therapist.json' with { type: 'json' };
import enAUtoneChaplain from './locales/en-AU/tones/chaplain.json' with { type: 'json' };

export const PACKS = {
  'en-AU': {
    meta: enAUmeta,
    prompts: enAUprompts,
    final: enAUfinal,
    personal: enAUpersonal,
    panic: enAUpanic,
    callbacks: enAUcallbacks,
    host: enAUhost,
    pictures: enAUpictures,
    tones: { sexy: enAUtoneSexy, argumentative: enAUtoneArgumentative, therapist: enAUtoneTherapist, chaplain: enAUtoneChaplain },
  },
};
