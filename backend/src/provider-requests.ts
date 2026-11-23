import type { Config } from './config.js';
import { now, type Store } from './db.js';
import { chargeBudget } from './security.js';
import { HttpError } from './errors.js';

// Share admission budgets across endpoints. Distinct upstream services can
// recover independently (e.g. optional FACEIT stats and match history).
const providerOf = {
  steamHistory: 'steam',
  steamProfile: 'steam',
  steamOpenId: 'steam',
  steamGc: 'coordinator',
  steamFiles: 'steam',
  faceitData: 'faceit',
  faceitStats: 'faceit',
  faceitSigner: 'faceit',
  faceitFiles: 'faceit',
} as const;
export type ProviderService = keyof typeof providerOf;
type ReportResponse = (status: number, retryAfter?: string | null) => void;

export class ProviderRequests {
  private readonly state = {
    steam: { starts: [] as number[], active: 0 },
    faceit: { starts: [] as number[], active: 0 },
    coordinator: { starts: [] as number[], active: 0 },
  };
  private readonly failures = new Map<ProviderService, number>();
  private readonly downloads = { steam: 0, faceit: 0 };

  constructor(
    private readonly db: Store,
    private readonly limits: Config['providerLimits'],
  ) {}

  private key(service: ProviderService) {
    return service === 'steamHistory' ? 'steam_history_retry_at' : 'provider_retry_' + service;
  }

  retryAt(service: ProviderService) {
    return Number(
      this.db.one('SELECT value FROM settings WHERE key=?', this.key(service))?.value ?? 0,
    );
  }

  private report(service: ProviderService, status: number, hint?: string | null) {
    if (status !== 429 && status !== 502 && status !== 503 && status !== 504) return;
    const count = this.failures.get(service) ?? 0;
    const base = this.limits[providerOf[service]].backoff;
    const fallback = Math.min(3600, base * 2 ** count);
    const value = hint?.trim();
    const seconds =
      value && /^\d+$/.test(value) ? Number(value) : Date.parse(value ?? '') / 1000 - now();
    const delay =
      Number.isFinite(seconds) && seconds >= 0
        ? Math.min(7 * 86400, Math.max(1, Math.ceil(seconds)))
        : fallback;
    const until = now() + delay;
    // Simultaneous failed calls belong to the same outage. Never shorten a
    // cooldown already advertised to another member or to a previous process.
    if (this.retryAt(service) <= now()) this.failures.set(service, Math.min(count + 1, 12));
    this.db.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)',
      this.key(service),
      until,
    );
  }

  async run<T>(service: ProviderService, work: (report: ReportResponse) => Promise<T>): Promise<T> {
    const provider = providerOf[service];
    const state = this.state[provider];
    const limits = this.limits[provider];
    const retry = this.retryAt(service) - now();
    if (retry > 0)
      throw new HttpError(
        429,
        service === 'steamHistory'
          ? 'Steam match discovery is cooling down. Try again later.'
          : 'Too many requests. Try again later.',
        retry,
      );
    const time = Date.now();
    state.starts = state.starts.filter((start) => start > time - 60000);
    if (state.starts.length >= limits.perMinute)
      throw new HttpError(
        429,
        'Too many requests. Try again later.',
        Math.max(1, Math.ceil((state.starts[0] + 60000 - time) / 1000)),
      );
    const files =
      service === 'steamFiles' ? 'steam' : service === 'faceitFiles' ? 'faceit' : undefined;
    if (
      state.active >= limits.concurrent ||
      (files && this.downloads[files] >= this.limits[files].downloads)
    )
      throw new HttpError(429, 'Too many requests. Try again later.', 5);
    if (service === 'steamHistory' || service === 'steamProfile')
      this.db.transaction(() =>
        chargeBudget(this.db, 'steam-api-budget', 'instance', 90000, 86400),
      );
    state.active++;
    state.starts.push(time);
    if (files) this.downloads[files]++;
    try {
      let healthy = false;
      const result = await work((status, hint) => {
        healthy = status >= 200 && status < 300;
        this.report(service, status, hint);
      });
      // Headers alone say nothing about whether the response body completed.
      if (healthy && this.failures.has(service) && this.retryAt(service) <= now())
        this.failures.delete(service);
      return result;
    } catch (error) {
      if (error instanceof HttpError && !error.retryAfter) {
        const retry = this.retryAt(service) - now();
        if (retry > 0) throw new HttpError(error.statusCode, error.message, retry, error.code);
      }
      throw error;
    } finally {
      state.active--;
      if (files) this.downloads[files]--;
    }
  }
}
