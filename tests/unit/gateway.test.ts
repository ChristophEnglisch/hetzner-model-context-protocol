import { describe, expect, it } from "vitest";
import { HetznerApiError, mapHetznerError, ToolError } from "../../src/hetzner/errors.js";
import { type HttpMethod, MAX_PER_PAGE, path } from "../../src/hetzner/gateway.js";
import type { HetznerAction } from "../../src/hetzner/types.js";
import { createLogger } from "../../src/logging.js";
import { VERSION } from "../../src/version.js";
import {
  action,
  apiError,
  FAKE_CLOCK_START,
  FAKE_TOKEN,
  type FakeHandler,
  FakeHetzner,
  noContent,
  ok,
} from "../helpers/fake-hetzner.js";
import { fixture } from "../helpers/fixtures.js";

const networkError: FakeHandler = () => {
  throw new TypeError("fetch failed");
};

const TRIGGERS: Record<string, FakeHandler> = {
  "429": apiError(429, "rate_limit_exceeded"),
  "503": apiError(503, "unavailable"),
  "502": apiError(502, "bad_gateway"),
  "504": apiError(504, "timeout"),
  "409 conflict": apiError(409, "conflict"),
  network: networkError,
};

async function callCount(
  method: HttpMethod,
  trigger: string,
): Promise<{ calls: number; sleeps: number[] }> {
  const fake = new FakeHetzner();
  const handler = TRIGGERS[trigger] as FakeHandler;
  fake.on(method, "/servers/{id}", handler);
  const gw = fake.gateway();
  const body = method === "PUT" ? { labels: {} } : undefined;
  await expect(gw.request(method, "/servers/1", body ? { body } : {})).rejects.toBeDefined();
  return { calls: fake.calls.length, sleeps: [...fake.sleeps] };
}

describe("HttpHetznerGateway", () => {
  it("sends bearer token, accept, user agent and JSON body", async () => {
    const fake = new FakeHetzner();
    fake.on("POST", "/servers", ok({ server: { id: 1 } }, 201));
    fake.on("GET", "/servers/{id}", ok({ server: { id: 7 } }));
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
    const gw = fake.gateway({}, logger);

    const created = await gw.request<{ server: { id: number } }>("POST", "/servers", {
      body: { name: "web-1", labels: { env: "dev" } },
    });
    expect(created.server.id).toBe(1);
    const [req] = fake.requests("POST", "/servers");
    expect(req?.headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req?.headers.get("accept")).toBe("application/json");
    expect(req?.headers.get("user-agent")).toBe(`hetzner-model-context-protocol/${VERSION}`);
    expect(req?.headers.get("content-type")).toBe("application/json");
    expect(req?.body).toEqual({ name: "web-1", labels: { env: "dev" } });

    await gw.request("GET", "/servers/7", { query: { name: "secret-name" } });
    const get = fake.requests("GET", "/servers/{id}")[0];
    expect(get?.params).toEqual({ id: "7" });
    expect(get?.headers.get("content-type")).toBeNull();
    expect(get?.body).toBeUndefined();

    // debug log per attempt, without token, query or body
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("hetzner_request");
      expect(line).not.toContain(FAKE_TOKEN);
      expect(line).not.toContain("secret-name");
      expect(line).not.toContain("web-1");
    }
    expect(lines[1]).toContain('"path":"/servers/7"');
    expect(lines[1]).toContain('"status":200');
    expect(lines[1]).toContain('"attempt":1');
    expect(lines[1]).toContain('"rateLimitRemaining":3598');
    expect(fake.unmatched).toEqual([]);
  });

  it("encodes array query parameters as repeated keys", async () => {
    const fake = new FakeHetzner().on("GET", "/actions", ok({ actions: [] }));
    await fake.gateway().request("GET", "/actions", {
      query: { id: [1, 2], skip: undefined, flag: true, off: false, name: "a b&c" },
    });
    const [req] = fake.calls;
    expect(req?.query.getAll("id")).toEqual(["1", "2"]);
    expect(req?.query.has("skip")).toBe(false);
    expect(req?.query.get("flag")).toBe("true");
    expect(req?.query.get("off")).toBe("false");
    expect(req?.query.get("name")).toBe("a b&c");
    expect(fake.unmatched).toEqual([]);
  });

  it("returns undefined for 204", async () => {
    const fake = new FakeHetzner()
      .on("DELETE", "/ssh_keys/{id}", noContent())
      .on("GET", "/empty", { status: 200, body: "" });
    const gw = fake.gateway();
    await expect(gw.request("DELETE", "/ssh_keys/3")).resolves.toBeUndefined();
    await expect(gw.request("GET", "/empty")).resolves.toBeUndefined();
  });

  it("rejects a 2xx body that is not JSON", async () => {
    const fake = new FakeHetzner().on("GET", "/servers", { status: 200, body: "<html>" });
    const error = await fake
      .gateway()
      .request("GET", "/servers")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HetznerApiError);
    expect((error as HetznerApiError).code).toBe("invalid_response");
    expect(mapHetznerError(error).kind).toBe("unexpected");
  });

  it.each(["503", "502", "504", "409 conflict", "network"])(
    "retries GET on 503, 502, 504, 409 conflict and network errors at most twice: %s",
    async (trigger) => {
      const { calls, sleeps } = await callCount("GET", trigger);
      expect(calls).toBe(3);
      expect(sleeps).toEqual([500, 1500]);
    },
  );

  it("succeeds when a GET retry succeeds and does not retry uniqueness conflicts", async () => {
    const fake = new FakeHetzner().on("GET", "/servers/{id}", [
      apiError(503, "unavailable"),
      ok({ server: { id: 1 } }),
    ]);
    await expect(fake.gateway().request("GET", "/servers/1")).resolves.toEqual({
      server: { id: 1 },
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.sleeps).toEqual([500]);

    const uniq = new FakeHetzner().on("GET", "/x", apiError(409, "uniqueness_error"));
    await expect(uniq.gateway().request("GET", "/x")).rejects.toBeInstanceOf(HetznerApiError);
    expect(uniq.calls).toHaveLength(1);
  });

  it.each(["429", "503", "502", "network"])("never retries POST: %s", async (trigger) => {
    const fake = new FakeHetzner();
    fake.on("POST", "/servers", TRIGGERS[trigger] as FakeHandler);
    await expect(
      fake.gateway().request("POST", "/servers", { body: { name: "x" } }),
    ).rejects.toBeDefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.sleeps).toEqual([]);
  });

  it.each([
    ["PUT", "429", 3],
    ["PUT", "503", 3],
    ["PUT", "409 conflict", 3],
    ["PUT", "502", 1],
    ["PUT", "504", 1],
    ["PUT", "network", 1],
    ["DELETE", "429", 3],
    ["DELETE", "503", 3],
    ["DELETE", "409 conflict", 1],
    ["DELETE", "502", 1],
    ["DELETE", "504", 1],
    ["DELETE", "network", 1],
  ] as const)(
    "retries PUT and DELETE only on 429 and 503 (PUT also on 409 conflict): %s %s",
    async (method, trigger, expected) => {
      const { calls } = await callCount(method, trigger);
      expect(calls).toBe(expected);
    },
  );

  it("waits one token interval on 429", async () => {
    const fake = new FakeHetzner().on("GET", "/servers", [
      apiError(429, "rate_limit_exceeded"),
      ok({ servers: [] }),
    ]);
    await fake.gateway().request("GET", "/servers");
    expect(fake.sleeps).toEqual([1000]);

    const withHeader = new FakeHetzner().on("GET", "/servers", [
      { ...apiError(429, "rate_limit_exceeded"), headers: { "Retry-After": "3" } },
      ok({ servers: [] }),
    ]);
    await withHeader.gateway().request("GET", "/servers");
    expect(withHeader.sleeps).toEqual([3000]);

    const lowLimit = new FakeHetzner();
    lowLimit.rateLimit = { limit: 1200, remaining: 0 };
    lowLimit.on("GET", "/servers", [apiError(429, "rate_limit_exceeded"), ok({ servers: [] })]);
    await lowLimit.gateway().request("GET", "/servers");
    expect(lowLimit.sleeps).toEqual([3000]);
  });

  it("does not wait longer than 5 s", async () => {
    const fake = new FakeHetzner().on("GET", "/servers", {
      ...apiError(429, "rate_limit_exceeded"),
      headers: { "Retry-After": "30" },
    });
    const error = await fake
      .gateway()
      .request("GET", "/servers")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HetznerApiError);
    expect((error as HetznerApiError).retryAfterMs).toBe(30_000);
    expect((error as HetznerApiError).rateLimit).toEqual({
      limit: 3600,
      remaining: 3599,
      resetAt: (Math.floor(FAKE_CLOCK_START / 1000) + 1) * 1000,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.sleeps).toEqual([]);
    expect(mapHetznerError(error).message).toContain("Wait at least 30 s");
  });

  it("aborts on timeout without retry", async () => {
    const fake = new FakeHetzner().on("GET", "/servers", () => new Promise(() => {}));
    const error = await fake
      .gateway({ timeoutMs: 20 })
      .request("GET", "/servers")
      .catch((e: unknown) => e);
    expect((error as Error).name).toBe("TimeoutError");
    expect(fake.calls).toHaveLength(1);
    expect(fake.sleeps).toEqual([]);
    expect(mapHetznerError(error, { timeoutMs: 20 }).kind).toBe("timeout");
  });

  it("propagates caller cancellation", async () => {
    const fake = new FakeHetzner().on("GET", "/servers", () => new Promise(() => {}));
    const controller = new AbortController();
    const pending = fake.gateway().request("GET", "/servers", { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
    expect(fake.calls).toHaveLength(1);
    expect(mapHetznerError(error).kind).toBe("cancelled");

    // cancellation during a retry wait stops the retries
    const retrying = new FakeHetzner().on("GET", "/servers", apiError(503, "unavailable"));
    const c2 = new AbortController();
    c2.abort();
    const e2 = await retrying
      .gateway()
      .request("GET", "/servers", { signal: c2.signal })
      .catch((e: unknown) => e);
    expect((e2 as Error).name).toBe("AbortError");
    expect(retrying.calls).toHaveLength(0);
  });

  it("rejects unsafe path values", () => {
    expect(path`/servers/${42}/actions/poweron`).toBe("/servers/42/actions/poweron");
    expect(path`/zones/${"example.com"}`).toBe("/zones/example.com");
    expect(path`/zones/${"a b"}`).toBe("/zones/a%20b");
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => path`/servers/${bad}`).toThrow(ToolError);
      expect(() => path`/servers/${bad}`).toThrow("Invalid id: must be a positive integer.");
    }
    for (const bad of ["../x", "..", ".", "", "a/b", "a\\b", "a\nb"]) {
      let error: unknown;
      try {
        path`/zones/${bad}`;
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).kind).toBe("guard");
    }
  });

  it("rejects malformed API paths before any request", async () => {
    const fake = new FakeHetzner();
    const gw = fake.gateway();
    for (const bad of [
      "servers",
      "/servers/../x",
      "/servers/./x",
      "/servers?x=1",
      "/a b",
      "/../x",
    ]) {
      await expect(gw.request("GET", bad)).rejects.toThrow("Invalid API path");
    }
    await expect(gw.request("GET", "/servers", { body: {} })).rejects.toThrow(/only allowed/);
    expect(fake.calls).toEqual([]);
  });

  it("page() maps meta.pagination", async () => {
    const fake = new FakeHetzner().on("GET", "/ssh_keys", [
      ok(fixture("list_ssh_keys")),
      ok({
        ssh_keys: [],
        meta: {
          pagination: {
            page: 1,
            per_page: 25,
            previous_page: null,
            next_page: null,
            last_page: null,
            total_entries: null,
          },
        },
      }),
    ]);
    const gw = fake.gateway();
    const first = await gw.page<{ id: number }>("/ssh_keys", "ssh_keys", {
      page: 3,
      perPage: 25,
      query: { label_selector: "env=dev" },
    });
    expect(first.page).toBe(3);
    expect(first.per_page).toBe(25);
    expect(first.next_page).toBe(4);
    expect(first.total_entries).toBe(100);
    expect(first.items.length).toBeGreaterThan(0);
    expect(fake.calls[0]?.query.get("page")).toBe("3");
    expect(fake.calls[0]?.query.get("per_page")).toBe("25");
    expect(fake.calls[0]?.query.get("label_selector")).toBe("env=dev");

    const last = await gw.page("/ssh_keys", "ssh_keys");
    expect(last.next_page).toBeNull();
    expect(last.total_entries).toBeNull();
    expect(fake.calls[1]?.query.has("page")).toBe(false);

    fake.on("GET", "/ssh_keys", ok({ wrong: [] }));
    await expect(gw.page("/ssh_keys", "ssh_keys")).rejects.toBeInstanceOf(HetznerApiError);
  });

  it("paginate() follows next_page and stops at maxItems", async () => {
    const pageOf = (page: number, count: number, next: number | null) =>
      ok({
        servers: Array.from({ length: count }, (_, i) => ({ id: page * 100 + i })),
        meta: {
          pagination: {
            page,
            per_page: 50,
            previous_page: null,
            next_page: next,
            last_page: null,
            total_entries: null,
          },
        },
      });
    const fake = new FakeHetzner().on("GET", "/servers", (req) => {
      const page = Number(req.query.get("page"));
      return page < 3 ? pageOf(page, 50, page + 1) : pageOf(page, 20, null);
    });
    const gw = fake.gateway();

    const all = await gw.paginate<{ id: number }>("/servers", "servers");
    expect(all.items).toHaveLength(120);
    expect(all.truncated).toBe(false);
    expect(fake.calls.map((c) => c.query.get("per_page"))).toEqual(
      Array(3).fill(String(MAX_PER_PAGE)),
    );

    const capped = await gw.paginate<{ id: number }>("/servers", "servers", { maxItems: 75 });
    expect(capped.items).toHaveLength(75);
    expect(capped.truncated).toBe(true);
    expect(fake.calls).toHaveLength(5);

    const exact = await gw.paginate<{ id: number }>("/servers", "servers", { maxItems: 100 });
    expect(exact.items).toHaveLength(100);
    expect(exact.truncated).toBe(true); // a third page exists
  });

  it("waitForActions returns immediately for finished actions", async () => {
    const fake = new FakeHetzner();
    const progress: number[] = [];
    const result = await fake.gateway().waitForActions([action(1, "success"), action(2, "error")], {
      timeoutMs: 60_000,
      onProgress: (a) => {
        progress.push(a.length);
      },
    });
    expect(result.map((a) => a.status)).toEqual(["success", "error"]);
    expect(fake.calls).toHaveLength(0);
    expect(fake.sleeps).toEqual([]);
    expect(progress).toEqual([2]);

    const noBudget = await fake.gateway().waitForActions([action(3)], { timeoutMs: 0 });
    expect(noBudget[0]?.status).toBe("running");
    expect(fake.calls).toHaveLength(0);
  });

  it("waitForActions polls GET /actions?id= with growing intervals", async () => {
    const fake = new FakeHetzner().on("GET", "/actions", [
      ok({ actions: [action(1, "running", 10), action(2, "running", 20)] }),
      ok({ actions: [action(1, "success"), action(2, "running", 60)] }),
      ok({ actions: [action(2, "success")] }),
    ]);
    const seen: HetznerAction[][] = [];
    const result = await fake.gateway().waitForActions([action(1), action(2)], {
      timeoutMs: 60_000,
      onProgress: (a) => {
        seen.push([...a]);
      },
    });
    expect(fake.sleeps).toEqual([1000, 1500, 2250]);
    expect(fake.calls[0]?.query.getAll("id")).toEqual(["1", "2"]);
    expect(fake.calls[2]?.query.getAll("id")).toEqual(["2"]);
    expect(result.map((a) => a.status)).toEqual(["success", "success"]);
    expect(seen).toHaveLength(4);
    expect(seen.map((s) => s[1]?.progress)).toEqual([0, 20, 60, 100]);
    expect(fake.clock - FAKE_CLOCK_START).toBe(4750);
  });

  it("waitForActions polls more than 50 ids in blocks", async () => {
    const fake = new FakeHetzner().on("GET", "/actions", (req) =>
      ok({ actions: req.query.getAll("id").map((id) => action(Number(id), "success")) }),
    );
    const initial = Array.from({ length: 120 }, (_, i) => action(i + 1));
    const result = await fake.gateway().waitForActions(initial, { timeoutMs: 60_000 });
    expect(fake.calls.map((c) => c.query.getAll("id").length)).toEqual([50, 50, 20]);
    expect(result.every((a) => a.status === "success")).toBe(true);
    expect(fake.sleeps).toEqual([1000]);
  });

  it("waitForActions slows down on low remaining quota", async () => {
    const fake = new FakeHetzner();
    fake.rateLimit = { limit: 3600, remaining: 50 };
    fake.on("GET", "/servers/{id}", ok({ server: { id: 1 } }));
    fake.on("GET", "/actions", [
      ok({ actions: [action(1)] }),
      ok({ actions: [action(1, "success")] }),
    ]);
    const gw = fake.gateway();
    await gw.request("GET", "/servers/1"); // the gateway learns the quota from the last response
    await gw.waitForActions([action(1)], { timeoutMs: 60_000 });
    expect(fake.sleeps).toEqual([5000, 5000]);
  });

  it("waitForActions returns running actions when the budget is used up", async () => {
    const fake = new FakeHetzner().on(
      "GET",
      "/actions",
      ok({ actions: [action(1, "running", 40)] }),
    );
    const result = await fake.gateway().waitForActions([action(1)], { timeoutMs: 3000 });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("running");
    expect(result[0]?.progress).toBe(40);
    expect(fake.sleeps).toEqual([1000, 1500]);
    expect(fake.calls).toHaveLength(2);
  });

  it("waitForActions returns error actions without throwing", async () => {
    const failed = { ...action(1, "error"), error: { code: "server_error", message: "boom" } };
    const fake = new FakeHetzner().on("GET", "/actions", ok({ actions: [failed] }));
    const result = await fake.gateway().waitForActions([action(1)], { timeoutMs: 60_000 });
    expect(result[0]?.status).toBe("error");
    expect(result[0]?.error).toEqual({ code: "server_error", message: "boom" });

    // a poll failure that survives the GET retries is thrown
    const down = new FakeHetzner().on("GET", "/actions", apiError(500, "server_error"));
    await expect(
      down.gateway().waitForActions([action(1)], { timeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(HetznerApiError);
  });

  it("waitForActions honours cancellation during the wait", async () => {
    const fake = new FakeHetzner().on("GET", "/actions", ok({ actions: [action(1)] }));
    const controller = new AbortController();
    controller.abort();
    const error = await fake
      .gateway()
      .waitForActions([action(1)], { timeoutMs: 60_000, signal: controller.signal })
      .catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
    expect(fake.calls).toHaveLength(0);
  });

  it("getPricing caches for one hour and shares in-flight requests", async () => {
    const body = fixture<{ pricing: Record<string, unknown> }>("get_pricing");
    const fake = new FakeHetzner().on("GET", "/pricing", ok(body));
    const gw = fake.gateway();
    const [a, b] = await Promise.all([gw.getPricing(), gw.getPricing()]);
    expect(fake.calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a.currency).toBe(body.pricing.currency);

    fake.clock += 3_599_999;
    await gw.getPricing();
    expect(fake.calls).toHaveLength(1);
    fake.clock += 2; // 3_600_001 after the first fetch
    await gw.getPricing();
    expect(fake.calls).toHaveLength(2);

    // a cancelled caller does not cancel the shared request for others
    fake.clock += 3_600_001;
    const controller = new AbortController();
    const cancelled = gw.getPricing({ signal: controller.signal });
    const other = gw.getPricing();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(other).resolves.toEqual(body.pricing);
    expect(fake.calls).toHaveLength(3);
  });

  it("getPricing does not cache failures", async () => {
    const fake = new FakeHetzner().on("GET", "/pricing", [
      apiError(500, "server_error"),
      ok(fixture("get_pricing")),
    ]);
    const gw = fake.gateway();
    await expect(gw.getPricing()).rejects.toBeInstanceOf(HetznerApiError);
    await expect(gw.getPricing()).resolves.toHaveProperty("currency");
    expect(fake.calls).toHaveLength(2);
    await gw.getPricing();
    expect(fake.calls).toHaveLength(2);
  });

  it("is host-neutral: a second instance uses its own base URL and token", async () => {
    const fake = new FakeHetzner().on("GET", "/storage_boxes", ok({ storage_boxes: [] }));
    const gw = fake.gateway({ apiUrl: "https://api.hetzner.com/v1/", token: "other-fake-token" });
    await gw.request("GET", "/storage_boxes");
    expect(fake.calls[0]?.headers.get("authorization")).toBe("Bearer other-fake-token");
    expect(fake.unmatched).toEqual([]);
  });

  it("records unmatched requests in the fake", async () => {
    const fake = new FakeHetzner();
    await expect(
      fake.gateway().request("GET", "/nothing", { query: { a: 1 } }),
    ).rejects.toBeInstanceOf(HetznerApiError);
    expect(fake.unmatched).toEqual(["GET /nothing?a=1"]);
  });
});
