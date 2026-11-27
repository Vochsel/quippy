// Product analytics (PostHog) over plain fetch, so it runs on Node and on
// Cloudflare alike. Events use the same distinct ids as the browser: a phone's
// device id for players, the TV's host id for crews.
//
// No POSTHOG_KEY: every call is a no-op (production), with one loud error in
// development so missing analytics don't go unnoticed.

export class Analytics {
  constructor({ key, host, dev, version, runtime, log } = {}) {
    this.key = key || '';
    this.host = (host || 'https://us.i.posthog.com').replace(/\/+$/, '');
    this.base = { app: 'quippy', app_version: version || 'dev', runtime: runtime || 'server', $lib: 'quippy-server' };
    this.log = log || (() => {});
    if (!this.key && dev) {
      console.error('POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_KEY is configured');
    }
  }

  get enabled() { return !!this.key; }

  // Returns a promise that never rejects (hand it to waitUntil where there is one).
  capture(distinctId, event, properties = {}) {
    if (!this.key || !distinctId || !event) return Promise.resolve();
    const body = {
      api_key: this.key,
      event,
      distinct_id: String(distinctId),
      properties: { ...this.base, ...properties },
      timestamp: new Date().toISOString(),
    };
    return fetch(`${this.host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).then(() => {}, (e) => this.log('analytics', String(e?.message || e)));
  }

  captureException(distinctId, error, properties = {}) {
    const e = error instanceof Error ? error : new Error(String(error));
    return this.capture(distinctId || 'quippy-server', '$exception', {
      ...properties,
      $exception_list: [{ type: e.name || 'Error', value: String(e.message || e).slice(0, 500), mechanism: { handled: true, synthetic: false }, stacktrace: { type: 'raw', frames: [] } }],
      $exception_stack_trace_raw: String(e.stack || '').slice(0, 4000),
    });
  }
}

export const noAnalytics = new Analytics({});
