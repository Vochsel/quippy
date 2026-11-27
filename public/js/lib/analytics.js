// Product analytics (PostHog) for the TV, phones and home page.
// The SDK is only fetched when env.js carries a PostHog key; without one every
// call is a no-op (and on a dev server it says so loudly in the console).
// Players are identified by their device id and TVs by their host id, the same
// distinct ids the server uses for its own events.

const env = window.QUIPPY || {};
const cfg = env.posthog;
let started = false;
const queue = [];

function ph(method, ...args) {
  if (!cfg?.key) return;
  if (window.posthog?.__loaded) window.posthog[method](...args);
  else queue.push([method, args]);
}

export function initAnalytics(surface) {
  if (started) return;
  started = true;
  if (!cfg?.key) {
    if (env.dev) console.error('POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_KEY is configured');
    return;
  }
  const s = document.createElement('script');
  s.src = '/vendor/posthog.js';
  s.async = true;
  s.onload = () => {
    const posthog = window.posthog;
    if (!posthog?.init) return;
    posthog.init(cfg.key, {
      api_host: cfg.host,
      defaults: '2025-11-30',
      person_profiles: 'identified_only',
      capture_exceptions: true,
      disable_session_recording: true, // phones type answers; keep replays off
      loaded: (p) => {
        p.register({ app: 'quippy', surface, app_version: env.version || 'dev' });
        for (const [method, args] of queue.splice(0)) p[method](...args);
      },
    });
  };
  document.head.append(s);
}

export function identify(id, props) { if (id) ph('identify', id, props); }
export function track(event, props) { ph('capture', event, props); }
export function trackError(error, props) { ph('captureException', error, props); }
