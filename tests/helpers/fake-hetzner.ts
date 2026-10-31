import {
  type GatewayConfig,
  HttpHetznerGateway,
  type HttpMethod,
} from "../../src/hetzner/gateway.js";
import type { HetznerAction } from "../../src/hetzner/types.js";
import type { Logger } from "../../src/logging.js";

export interface FakeRequest {
  method: HttpMethod;
  /** without apiUrl prefix, e.g. "/servers/42" */
  path: string;
  /** from the pattern, e.g. { id: "42" } */
  params: Record<string, string>;
  query: URLSearchParams;
  /** parsed JSON or undefined */
  body: unknown;
  headers: Headers;
}
/** `body` is sent as JSON; a string body is sent verbatim (for non-JSON responses). */
export interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export type FakeHandler = FakeReply | ((req: FakeRequest) => FakeReply | Promise<FakeReply>);

interface Route {
  method: HttpMethod;
  pattern: string;
  segments: string[];
  handlers: readonly FakeHandler[];
  next: number;
}

export const FAKE_API_URL = "https://api.hetzner.cloud/v1";
/** Obviously fake; never a real token in fixtures (00 §5). */
export const FAKE_TOKEN = "fake-token-not-a-real-secret";
export const FAKE_CLOCK_START = 1_800_000_000_000;

function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s !== "");
}

function match(route: Route, method: string, segments: string[]): Record<string, string> | null {
  if (route.method !== method || route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const want = route.segments[i] ?? "";
    const got = segments[i] ?? "";
    if (want.startsWith("{") && want.endsWith("}"))
      params[want.slice(1, -1)] = decodeURIComponent(got);
    else if (want !== got) return null;
  }
  return params;
}

/**
 * Route-table fake of the Hetzner API with a virtual clock (01 §9.1). Tests build a real
 * HttpHetznerGateway on top of it via `gateway()`; nothing waits for real except a hanging handler
 * together with a small `timeoutMs`.
 */
export class FakeHetzner {
  readonly calls: FakeRequest[] = [];
  /** "GET /x?y" for requests without route */
  readonly unmatched: string[] = [];
  /** every sleep() duration */
  readonly sleeps: number[] = [];
  /** virtual epoch ms */
  clock = FAKE_CLOCK_START;
  /** sent as headers on every reply; remaining is lowered by 1 per request */
  rateLimit: { limit: number; remaining: number } = { limit: 3600, remaining: 3599 };
  apiUrl = FAKE_API_URL;

  private readonly routes: Route[] = [];

  /** Pattern with {param} placeholders. A handler array is a sequence; the last element repeats. Later on() for the same route replaces it. */
  on(method: HttpMethod, pattern: string, handler: FakeHandler | readonly FakeHandler[]): this {
    const handlers: readonly FakeHandler[] = Array.isArray(handler)
      ? (handler as readonly FakeHandler[])
      : [handler as FakeHandler];
    if (handlers.length === 0) throw new Error("FakeHetzner.on: empty handler sequence");
    const existing = this.routes.findIndex((r) => r.method === method && r.pattern === pattern);
    const route: Route = { method, pattern, segments: splitPath(pattern), handlers, next: 0 };
    if (existing >= 0) this.routes[existing] = route;
    else this.routes.push(route);
    return this;
  }

  readonly now = (): number => this.clock;

  readonly sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    this.sleeps.push(ms);
    await Promise.resolve();
    if (signal?.aborted) throw signal.reason;
    this.clock += ms;
  };

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const basePath = new URL(this.apiUrl).pathname.replace(/\/+$/, "");
    const path = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length) || "/"
      : url.pathname;
    const method = (init?.method ?? "GET").toUpperCase() as HttpMethod;
    const rawBody = init?.body;
    let body: unknown;
    if (typeof rawBody === "string" && rawBody !== "") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;

    const segments = splitPath(path);
    let route: Route | undefined;
    let params: Record<string, string> = {};
    for (const r of this.routes) {
      const p = match(r, method, segments);
      if (p) {
        route = r;
        params = p;
        break;
      }
    }
    const req: FakeRequest = {
      method,
      path,
      params,
      query: new URLSearchParams(url.search),
      body,
      headers: new Headers(init?.headers),
    };
    this.calls.push(req);

    let reply: FakeReply;
    if (!route) {
      this.unmatched.push(`${method} ${path}${url.search}`);
      reply = { status: 599, body: { error: { code: "fake_unmatched", message: "no route" } } };
    } else {
      const handler = route.handlers[
        Math.min(route.next, route.handlers.length - 1)
      ] as FakeHandler;
      route.next++;
      const pending = Promise.resolve(typeof handler === "function" ? handler(req) : handler);
      reply = signal ? await raceAbort(pending, signal) : await pending;
    }
    return this.toResponse(reply);
  };

  private toResponse(reply: FakeReply): Response {
    const remaining = this.rateLimit.remaining;
    this.rateLimit.remaining = Math.max(0, remaining - 1);
    const headers = new Headers({
      "RateLimit-Limit": String(this.rateLimit.limit),
      "RateLimit-Remaining": String(remaining),
      "RateLimit-Reset": String(Math.floor(this.clock / 1000) + 3600 - remaining),
    });
    let payload: string | null = null;
    if (reply.status !== 204 && reply.body !== undefined) {
      payload = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      headers.set("Content-Type", "application/json");
    }
    for (const [k, v] of Object.entries(reply.headers ?? {})) headers.set(k, v);
    return new Response(payload, { status: reply.status, headers });
  }

  gateway(config: Partial<GatewayConfig> = {}, logger?: Logger): HttpHetznerGateway {
    if (config.apiUrl !== undefined) this.apiUrl = config.apiUrl;
    return new HttpHetznerGateway(
      { apiUrl: this.apiUrl, token: FAKE_TOKEN, timeoutMs: 30_000, ...config },
      { fetch: this.fetch, sleep: this.sleep, now: this.now, ...(logger && { logger }) },
    );
  }

  /** Requests of one method+pattern, for body assertions. */
  requests(method: HttpMethod, pattern: string): FakeRequest[] {
    const route: Route = { method, pattern, segments: splitPath(pattern), handlers: [], next: 0 };
    return this.calls.filter((c) => match(route, c.method, splitPath(c.path)) !== null);
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

export const ok = (body: unknown, status = 200): FakeReply => ({ status, body });
export const noContent = (): FakeReply => ({ status: 204 });
export const apiError = (
  status: number,
  code: string,
  message = code,
  details?: unknown,
): FakeReply => ({ status, body: { error: { code, message, details: details ?? null } } });

export const action = (
  id: number,
  status: HetznerAction["status"] = "running",
  progress = 0,
  command = "test_command",
): HetznerAction => ({
  id,
  command,
  status,
  progress: status === "running" || progress !== 0 ? progress : 100,
  started: "2026-01-01T00:00:00+00:00",
  finished: status === "running" ? null : "2026-01-01T00:00:10+00:00",
  resources: [],
  error: status === "error" ? { code: "action_failed", message: "Action failed" } : null,
});
