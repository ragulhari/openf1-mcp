/**
 * Small HTTP client for the OpenF1 API.
 * - Builds query strings with comparison operators (>=, <, ...).
 * - Caches responses (historical data does not change).
 * - Spaces requests and retries on HTTP 429 / 5xx.
 */

export type FilterOp = "=" | ">" | ">=" | "<" | "<=";
export type Scalar = string | number | boolean;

export interface Filter {
  field: string;
  op: FilterOp;
  value: Scalar;
}

export interface ClientOptions {
  baseUrl?: string;
  /** Optional bearer token for the paid real-time tier. */
  token?: string;
  fetchImpl?: typeof fetch;
  /** Minimum time between two requests, in ms. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Cache TTL for queries that use "latest", in ms. */
  latestTtlMs?: number;
  /** Cache TTL for all other queries, in ms. */
  historicalTtlMs?: number;
  maxCacheEntries?: number;
}

export class OpenF1Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "OpenF1Error";
  }
}

interface CacheEntry {
  expires: number;
  data: unknown[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildQuery(params: Record<string, Scalar | Scalar[] | undefined>, filters: Filter[] = []): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  for (const f of filters) {
    // The operator must stay literal: OpenF1 parses "speed>=315" from the raw query string.
    parts.push(`${encodeURIComponent(f.field)}${f.op}${encodeURIComponent(String(f.value))}`);
  }
  return parts.join("&");
}

export class OpenF1Client {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly latestTtlMs: number;
  private readonly historicalTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<unknown[]>>();
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.openf1.org/v1").replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? 350;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.latestTtlMs = opts.latestTtlMs ?? 10_000;
    this.historicalTtlMs = opts.historicalTtlMs ?? 6 * 60 * 60 * 1000;
    this.maxCacheEntries = opts.maxCacheEntries ?? 500;
  }

  async get<T = Record<string, unknown>>(
    path: string,
    params: Record<string, Scalar | Scalar[] | undefined> = {},
    filters: Filter[] = [],
  ): Promise<T[]> {
    const qs = buildQuery(params, filters);
    const url = `${this.baseUrl}/${path}${qs ? `?${qs}` : ""}`;

    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.data as T[];

    const pending = this.inflight.get(url);
    if (pending) return (await pending) as T[];

    const p = this.fetchWithRetry(url);
    this.inflight.set(url, p);
    try {
      const data = await p;
      // "latest" queries change during a session; the calendar changes once a day.
      const ttl = /=latest(&|$)/.test(qs)
        ? this.latestTtlMs
        : path === "sessions" || path === "meetings"
          ? Math.min(this.historicalTtlMs, 10 * 60 * 1000)
          : this.historicalTtlMs;
      this.store(url, data, ttl);
      return data as T[];
    } finally {
      this.inflight.delete(url);
    }
  }

  private store(url: string, data: unknown[], ttl: number) {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, { expires: Date.now() + ttl, data });
  }

  /** Serializes requests so that they are at least minIntervalMs apart. */
  private async throttle(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async fetchWithRetry(url: string): Promise<unknown[]> {
    let attempt = 0;
    for (;;) {
      await this.throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: {
            accept: "application/json",
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) {
          attempt++;
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const msg = (err as Error).name === "AbortError" ? `timeout after ${this.timeoutMs} ms` : (err as Error).message;
        throw new OpenF1Error(`Network error: ${msg}`, undefined, url);
      }
      clearTimeout(timer);

      if (res.ok) {
        const body = await res.json();
        return Array.isArray(body) ? body : [body];
      }

      const text = await res.text().catch(() => "");
      const detail = extractDetail(text);

      // OpenF1 answers 404 "No results found." when a query matches nothing.
      if (res.status === 404 && /no results/i.test(detail)) return [];

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }

      throw new OpenF1Error(describeStatus(res.status, detail), res.status, url);
    }
  }
}

function extractDetail(text: string): string {
  try {
    const j = JSON.parse(text);
    if (typeof j?.detail === "string") return j.detail;
    if (j?.detail) return JSON.stringify(j.detail);
    if (typeof j?.error === "string") return j.error;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

function describeStatus(status: number, detail: string): string {
  const hint =
    status === 401 || status === 403
      ? " Real-time data needs a paid OpenF1 subscription (set OPENF1_TOKEN). Historical data (2023+) is free."
      : status === 422
        ? " The query is too large or not valid. Add filters (session_key, driver_number, date range)."
        : status === 429
          ? " Rate limit. Wait and try again."
          : "";
  return `OpenF1 API error ${status}: ${detail || "no detail"}.${hint}`;
}
