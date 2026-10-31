import { assertPathSegment } from "../guards.js";
import { type Logger, silentLogger } from "../logging.js";
import { VERSION } from "../version.js";
import {
  HetznerApiError,
  INVALID_RESPONSE,
  type RateLimitState,
  ToolError,
  tokenIntervalMs,
} from "./errors.js";
import type { HetznerAction, HetznerPagination, HetznerPricing } from "./types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

export interface RequestOptions {
  query?: Query;
  /** JSON-serialisable body; only for POST/PUT. */
  body?: unknown;
  /** Caller cancellation (MCP request signal). Combined with the per-attempt timeout. */
  signal?: AbortSignal;
}

export interface Page<T> {
  items: T[];
  page: number;
  per_page: number;
  next_page: number | null;
  total_entries: number | null;
}

export interface WaitOptions {
  /** Upper bound for the whole wait; 0 = do not poll. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called after every poll with the current states (also the initial ones). */
  onProgress?: (actions: readonly HetznerAction[]) => void | Promise<void>;
}

/** The only way to reach Hetzner. */
export interface HetznerGateway {
  /** One request. Resolves with the parsed JSON body (`undefined` for 204/empty). Throws HetznerApiError or a network/abort error. */
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;

  /** One list page. `key` is the array property in the response (e.g. "servers"). */
  page<T>(
    path: string,
    key: string,
    options?: { query?: Query; page?: number; perPage?: number; signal?: AbortSignal },
  ): Promise<Page<T>>;

  /** All pages (per_page=50) up to `maxItems` (default 500). For internal aggregations (resources, previews) and for
   *  list tools that filter client-side and return `items` + `total_matching` instead of a page (only
   *  catalog_server_types in 1.0, 05 K-03). Never for list tools that expose page/per_page. */
  paginate<T>(
    path: string,
    key: string,
    options?: { query?: Query; maxItems?: number; signal?: AbortSignal },
  ): Promise<{ items: T[]; truncated: boolean }>;

  /** Polls until every action is no longer "running" or the time budget is used up. Never throws because of status "error". */
  waitForActions(initial: readonly HetznerAction[], options: WaitOptions): Promise<HetznerAction[]>;

  /** GET /pricing, cached in memory for PRICING_TTL_MS, single-flight. */
  getPricing(options?: { signal?: AbortSignal }): Promise<HetznerPricing>;
}

export interface GatewayConfig {
  apiUrl: string;
  token: string;
  timeoutMs: number;
}

export interface GatewayOptions {
  /** tests: FakeHetzner.fetch */
  fetch?: typeof fetch;
  /** tests: virtual clock */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** tests: virtual clock */
  now?: () => number;
  logger?: Logger;
}

export const PRICING_TTL_MS = 3_600_000;
export const PAGINATE_MAX_ITEMS = 500;
/** R§2.5: maximum 50 in all 43 list parameters */
export const MAX_PER_PAGE = 50;
/** R§2.5: Hetzner default */
export const DEFAULT_PER_PAGE = 25;

/** 3.4: at most 2 retries (3 attempts); waits above this are not taken, the error is thrown. */
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 5000;

/** 3.5 */
const POLL_SCHEDULE_MS = (n: number) => Math.min(5000, Math.round(1000 * 1.5 ** n));
const LOW_QUOTA = 100;
const LOW_QUOTA_DELAY_MS = 5000;
const MAX_IDS_PER_POLL = 50;

// --- path -------------------------------------------------------------------------------------

/** path`/servers/${id}/actions/poweron` — numbers must be safe positive integers, strings pass assertPathSegment and are encodeURIComponent'ed. */
export function path(strings: TemplateStringsArray, ...values: (number | string)[]): string {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    let segment: string;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new ToolError("guard", "Invalid id: must be a positive integer.");
      }
      segment = String(value);
    } else if (typeof value === "string") {
      assertPathSegment(value);
      segment = encodeURIComponent(value);
    } else {
      throw new ToolError("guard", "Invalid id: must be a positive integer.");
    }
    out += segment + (strings[i + 1] ?? "");
  });
  return out;
}

const PATH_RE = /^\/[A-Za-z0-9_\-.~%/]*$/;

function assertApiPath(p: string): void {
  if (!PATH_RE.test(p) || p.split("/").some((s) => s === "." || s === "..")) {
    throw new Error("Invalid API path");
  }
}

// --- helpers ----------------------------------------------------------------------------------

function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function readRateLimit(headers: Headers): RateLimitState | undefined {
  const limit = headerNumber(headers, "RateLimit-Limit");
  const remaining = headerNumber(headers, "RateLimit-Remaining");
  const reset = headerNumber(headers, "RateLimit-Reset");
  if (limit === undefined || remaining === undefined || reset === undefined) return undefined;
  return { limit, remaining, resetAt: reset * 1000 };
}

/** Retry-After as delta seconds or HTTP date (RFC 9110); whether Hetzner sends it is not documented. */
function readRetryAfter(headers: Headers, now: number): number | undefined {
  const raw = headers.get("Retry-After")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function parseErrorBody(text: string): { code?: string; message?: string; details?: unknown } {
  try {
    const body = JSON.parse(text) as unknown;
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error !== "object" || error === null) return {};
    const e = error as Record<string, unknown>;
    return {
      ...(typeof e.code === "string" && { code: e.code }),
      ...(typeof e.message === "string" && { message: e.message }),
      details: e.details,
    };
  } catch {
    return {};
  }
}

function isAbortLike(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;
}

/** Real sleep for production; honours the signal and rejects with its reason. */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Lets one caller stop waiting for a shared promise without cancelling it for the others. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

type RetryDecision = { retry: false } | { retry: true; waitMs: number };

// --- gateway ----------------------------------------------------------------------------------

/** Host-neutral (OP-16): one instance per base URL and token. */
export class HttpHetznerGateway implements HetznerGateway {
  private readonly config: GatewayConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: Logger;
  private rateLimitState: RateLimitState | undefined;
  private pricingCache: { value: HetznerPricing; expiresAt: number } | undefined;
  private pricingInflight: Promise<HetznerPricing> | undefined;

  constructor(config: GatewayConfig, options: GatewayOptions = {}) {
    this.config = { ...config, apiUrl: config.apiUrl.replace(/\/+$/, "") };
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  /** Rate-limit headers of the most recent response that carried them (3.3 step 6). */
  get lastRateLimit(): RateLimitState | undefined {
    return this.rateLimitState;
  }

  async request<T>(method: HttpMethod, apiPath: string, options: RequestOptions = {}): Promise<T> {
    assertApiPath(apiPath);
    const hasBody = options.body !== undefined;
    if (hasBody && method !== "POST" && method !== "PUT") {
      throw new Error("A request body is only allowed for POST and PUT");
    }
    const url = `${this.config.apiUrl}${apiPath}${buildQuery(options.query)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/json",
      "User-Agent": `hetzner-model-context-protocol/${VERSION}`,
    };
    if (hasBody) headers["Content-Type"] = "application/json";
    const body = hasBody ? JSON.stringify(options.body) : undefined;

    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      const started = this.now();

      let response: Response;
      let text: string;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(body !== undefined && { body }),
          signal,
          redirect: "error",
        });
        text = await response.text();
      } catch (error) {
        this.logger.debug("hetzner_request", {
          method,
          path: apiPath,
          status: null,
          attempt,
          durationMs: this.now() - started,
          rateLimitRemaining: this.rateLimitState?.remaining ?? null,
          error: isAbortLike(error, "TimeoutError")
            ? "timeout"
            : isAbortLike(error, "AbortError")
              ? "aborted"
              : "network",
        });
        // Own timeout and caller cancellation are never retried; network errors only for GET.
        if (timeout.aborted || options.signal?.aborted || isAbortLike(error, "AbortError")) {
          throw error;
        }
        if (method !== "GET" || attempt >= MAX_ATTEMPTS) throw error;
        await this.sleep(500 * 3 ** (attempt - 1), options.signal);
        continue;
      }

      const rateLimit = readRateLimit(response.headers);
      if (rateLimit) this.rateLimitState = rateLimit;
      const retryAfterMs = readRetryAfter(response.headers, this.now());
      this.logger.debug("hetzner_request", {
        method,
        path: apiPath,
        status: response.status,
        attempt,
        durationMs: this.now() - started,
        rateLimitRemaining: this.rateLimitState?.remaining ?? null,
      });

      if (response.ok) {
        if (response.status === 204 || text.trim() === "") return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HetznerApiError({ status: response.status, method, code: INVALID_RESPONSE });
        }
      }

      const parsed = parseErrorBody(text);
      const error = new HetznerApiError({
        status: response.status,
        method,
        code: parsed.code,
        apiMessage: parsed.message,
        details: parsed.details,
        rateLimit,
        retryAfterMs,
      });
      const decision = this.retryDecision(method, error, attempt);
      if (!decision.retry) throw error;
      await this.sleep(decision.waitMs, options.signal);
    }
  }

  /** Retry policy 3.4. */
  private retryDecision(
    method: HttpMethod,
    error: HetznerApiError,
    attempt: number,
  ): RetryDecision {
    if (attempt >= MAX_ATTEMPTS || method === "POST") return { retry: false };
    const { status } = error;
    let retry = false;
    if (status === 429 || status === 503) retry = true;
    else if (status === 502 || status === 504) retry = method === "GET";
    else if (status === 409 && error.code === "conflict")
      retry = method === "GET" || method === "PUT";
    if (!retry) return { retry: false };

    const waitMs =
      status === 429
        ? (error.retryAfterMs ??
          tokenIntervalMs(error.rateLimit?.limit ?? this.rateLimitState?.limit))
        : 500 * 3 ** (attempt - 1);
    return waitMs > MAX_RETRY_WAIT_MS ? { retry: false } : { retry: true, waitMs };
  }

  async page<T>(
    apiPath: string,
    key: string,
    options: { query?: Query; page?: number; perPage?: number; signal?: AbortSignal } = {},
  ): Promise<Page<T>> {
    const body = await this.request<unknown>("GET", apiPath, {
      query: { ...options.query, page: options.page, per_page: options.perPage },
      ...(options.signal && { signal: options.signal }),
    });
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const items = record[key];
    if (!Array.isArray(items)) {
      throw new HetznerApiError({ status: 200, method: "GET", code: INVALID_RESPONSE });
    }
    const pagination = (record.meta as { pagination?: Partial<HetznerPagination> } | undefined)
      ?.pagination;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    return {
      items: items as T[],
      page: num(pagination?.page) ?? options.page ?? 1,
      per_page: num(pagination?.per_page) ?? options.perPage ?? DEFAULT_PER_PAGE,
      next_page: num(pagination?.next_page),
      total_entries: num(pagination?.total_entries),
    };
  }

  async paginate<T>(
    apiPath: string,
    key: string,
    options: { query?: Query; maxItems?: number; signal?: AbortSignal } = {},
  ): Promise<{ items: T[]; truncated: boolean }> {
    const maxItems = options.maxItems ?? PAGINATE_MAX_ITEMS;
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const result = await this.page<T>(apiPath, key, {
        ...(options.query && { query: options.query }),
        page,
        perPage: MAX_PER_PAGE,
        ...(options.signal && { signal: options.signal }),
      });
      items.push(...result.items);
      const more = result.next_page !== null && result.next_page > result.page;
      if (items.length >= maxItems) {
        return { items: items.slice(0, maxItems), truncated: items.length > maxItems || more };
      }
      if (!more || result.next_page === null) return { items, truncated: false };
      page = result.next_page;
    }
  }

  async waitForActions(
    initial: readonly HetznerAction[],
    options: WaitOptions,
  ): Promise<HetznerAction[]> {
    let current = [...initial];
    const started = this.now();
    await options.onProgress?.(current);
    const done = () => current.every((a) => a.status !== "running");
    if (done() || options.timeoutMs <= 0) return current;

    for (let n = 0; ; n++) {
      const remaining = this.rateLimitState?.remaining;
      const delay =
        remaining !== undefined && remaining < LOW_QUOTA ? LOW_QUOTA_DELAY_MS : POLL_SCHEDULE_MS(n);
      if (this.now() - started + delay > options.timeoutMs) return current;
      await this.sleep(delay, options.signal);

      const ids = [...new Set(current.filter((a) => a.status === "running").map((a) => a.id))];
      const polled = new Map<number, HetznerAction>();
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_POLL) {
        const body = await this.request<{ actions?: HetznerAction[] }>("GET", "/actions", {
          query: { id: ids.slice(i, i + MAX_IDS_PER_POLL) },
          ...(options.signal && { signal: options.signal }),
        });
        for (const a of Array.isArray(body?.actions) ? body.actions : []) polled.set(a.id, a);
      }
      current = current.map((a) => polled.get(a.id) ?? a);
      await options.onProgress?.(current);
      if (done()) return current;
    }
  }

  async getPricing(options: { signal?: AbortSignal } = {}): Promise<HetznerPricing> {
    const cached = this.pricingCache;
    if (cached && this.now() < cached.expiresAt) return cached.value;
    // The shared request carries no caller signal: one cancelled caller must not fail the others.
    this.pricingInflight ??= this.request<{ pricing?: unknown }>("GET", "/pricing")
      .then((body) => {
        const pricing = body?.pricing;
        if (typeof pricing !== "object" || pricing === null) {
          throw new HetznerApiError({ status: 200, method: "GET", code: INVALID_RESPONSE });
        }
        const value = pricing as HetznerPricing;
        this.pricingCache = { value, expiresAt: this.now() + PRICING_TTL_MS };
        return value;
      })
      .finally(() => {
        this.pricingInflight = undefined;
      });
    return withSignal(this.pricingInflight, options.signal);
  }
}
