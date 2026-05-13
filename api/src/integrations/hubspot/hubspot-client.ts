// N04 — HubSpot HTTP client
// Thin wrapper around fetch with retry logic, rate-limit tracking, and token injection.
// Stubs behind an interface so tests can inject a fake.

export interface HubspotClientOptions {
  accessToken: string;
  /** Called when the daily remaining quota drops below threshold */
  onRateLimitLow?: (remaining: number) => Promise<void>;
}

export interface HubspotResponse<T = unknown> {
  data: T;
  rateLimitDailyRemaining: number | null;
  rateLimitSecondlyRemaining: number | null;
}

export class HubspotApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`HubSpot API ${status}: ${body.slice(0, 200)}`);
    this.name = 'HubspotApiError';
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const BASE_URL = 'https://api.hubapi.com';

function backoffMs(attempt: number): number {
  const base = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
  const jitter = Math.random() * base * 0.5;
  return Math.min(base + jitter, 30_000);
}

export interface IHubspotClient {
  get<T>(path: string): Promise<HubspotResponse<T>>;
  post<T>(path: string, body: unknown): Promise<HubspotResponse<T>>;
  patch<T>(path: string, body: unknown): Promise<HubspotResponse<T>>;
}

export class HubspotClient implements IHubspotClient {
  private readonly token: string;
  private readonly onRateLimitLow?: (remaining: number) => Promise<void>;

  constructor(opts: HubspotClientOptions) {
    this.token = opts.accessToken;
    this.onRateLimitLow = opts.onRateLimitLow;
  }

  async get<T>(path: string): Promise<HubspotResponse<T>> {
    return this._request<T>('GET', path, undefined);
  }

  async post<T>(path: string, body: unknown): Promise<HubspotResponse<T>> {
    return this._request<T>('POST', path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<HubspotResponse<T>> {
    return this._request<T>('PATCH', path, body);
  }

  private async _request<T>(
    method: string,
    path: string,
    body: unknown,
    attempt = 0,
  ): Promise<HubspotResponse<T>> {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const dailyRemaining = res.headers.get('X-HubSpot-RateLimit-Daily-Remaining');
    const secondlyRemaining = res.headers.get('X-HubSpot-RateLimit-Secondly-Remaining');
    const dailyRemainingNum = dailyRemaining ? parseInt(dailyRemaining, 10) : null;
    const secondlyRemainingNum = secondlyRemaining ? parseInt(secondlyRemaining, 10) : null;

    if (dailyRemainingNum !== null && dailyRemainingNum < 1000 && this.onRateLimitLow) {
      await this.onRateLimitLow(dailyRemainingNum);
    }

    if (!res.ok) {
      const text = await res.text();
      if (RETRYABLE.has(res.status) && attempt < 4) {
        let wait = backoffMs(attempt);
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) wait = Math.max(wait, parseInt(retryAfter, 10) * 1000);
        await new Promise((r) => setTimeout(r, wait));
        return this._request<T>(method, path, body, attempt + 1);
      }
      throw new HubspotApiError(res.status, text);
    }

    const data = (await res.json()) as T;
    return { data, rateLimitDailyRemaining: dailyRemainingNum, rateLimitSecondlyRemaining: secondlyRemainingNum };
  }
}

/** Fake client for unit tests */
export class FakeHubspotClient implements IHubspotClient {
  public readonly calls: { method: string; path: string; body?: unknown }[] = [];
  private readonly responses: Map<string, unknown> = new Map();

  setResponse(method: string, path: string, data: unknown): void {
    this.responses.set(`${method}:${path}`, data);
  }

  async get<T>(path: string): Promise<HubspotResponse<T>> {
    this.calls.push({ method: 'GET', path });
    return { data: (this.responses.get(`GET:${path}`) ?? {}) as T, rateLimitDailyRemaining: 50000, rateLimitSecondlyRemaining: 100 };
  }

  async post<T>(path: string, body: unknown): Promise<HubspotResponse<T>> {
    this.calls.push({ method: 'POST', path, body });
    return { data: (this.responses.get(`POST:${path}`) ?? {}) as T, rateLimitDailyRemaining: 50000, rateLimitSecondlyRemaining: 100 };
  }

  async patch<T>(path: string, body: unknown): Promise<HubspotResponse<T>> {
    this.calls.push({ method: 'PATCH', path, body });
    return { data: (this.responses.get(`PATCH:${path}`) ?? {}) as T, rateLimitDailyRemaining: 50000, rateLimitSecondlyRemaining: 100 };
  }
}
