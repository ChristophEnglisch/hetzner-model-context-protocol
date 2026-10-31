import { describe, expect, it } from "vitest";
import {
  HetznerApiError,
  type HetznerApiErrorInit,
  mapHetznerError,
  ToolError,
  type ToolErrorKind,
} from "../../src/hetzner/errors.js";

const apiErr = (init: Partial<HetznerApiErrorInit> & { status: number }) =>
  new HetznerApiError({ method: "GET", ...init });

// Every row of 01 §4.3 (global + operation-specific): status, code, kind, verbatim text up to the first placeholder.
const TABLE: [number, string, ToolErrorKind, string][] = [
  [
    400,
    "json_error",
    "bad_request",
    "Hetzner could not parse the request body as JSON. This is a bug in hetzner-model-context-protocol; please report it",
  ],
  [
    401,
    "unauthorized",
    "auth",
    "Hetzner rejected the API token (HTTP 401). Check HETZNER_TOKEN: it may be invalid or revoked, or its project may have been deleted",
  ],
  [
    403,
    "forbidden",
    "forbidden",
    "Hetzner denied the operation (HTTP 403): the API token lacks the permission. If it is a Read-only token, create a Read & Write token in the project (Security → API Tokens), or run with HETZNER_MCP_READ_ONLY=true",
  ],
  [
    403,
    "maintenance",
    "unavailable",
    "Hetzner cannot perform this operation right now because of maintenance. Try again later; do not retry in a loop",
  ],
  [403, "resource_limit_exceeded", "limit_exceeded", "The project has reached a resource limit"],
  [
    404,
    "not_found",
    "not_found",
    "Not found (HTTP 404): the resource does not exist in this project. Check the ID with the matching *_list tool",
  ],
  [
    405,
    "method_not_allowed",
    "unsupported",
    "Hetzner does not allow this request method. This is a bug in hetzner-model-context-protocol; please report it",
  ],
  [409, "uniqueness_error", "conflict", "A resource with the same unique value already exists"],
  [
    409,
    "conflict",
    "conflict",
    "The resource changed while the request was processed. Load it again and retry",
  ],
  [
    410,
    "deprecated_api_endpoint",
    "unsupported",
    "Hetzner has removed this API endpoint. Update hetzner-model-context-protocol to a newer version",
  ],
  [
    412,
    "resource_unavailable",
    "unavailable",
    "The requested resource is currently not available (for example not orderable in this location). Choose another type or location (see catalog_server_types)",
  ],
  [422, "invalid_input", "bad_request", "Hetzner rejected the input"],
  [
    422,
    "service_error",
    "server",
    "A Hetzner service reported an error while processing the request",
  ],
  [422, "unsupported_error", "unsupported", "This resource does not support the requested action"],
  [
    423,
    "locked",
    "locked",
    "The resource is locked because another action is running on it. Wait for that action (action_list / action_get) and retry",
  ],
  [
    423,
    "protected",
    "protected",
    "The resource is protected against this action. Protection is never removed automatically: ask the user whether to disable it with the matching *_protection_set tool, then retry",
  ],
  [429, "rate_limit_exceeded", "rate_limited", "Hetzner rate limit reached"],
  [500, "server_error", "server", "Hetzner reported an internal error. Try again later"],
  [
    502,
    "bad_gateway",
    "server",
    "Hetzner could not answer the request (bad gateway). Try again later; for write operations, first check with the matching *_get or action_list tool whether the change was applied (for a new resource: with the matching *_list tool, filtered by name)",
  ],
  [
    503,
    "unavailable",
    "unavailable",
    "A Hetzner service or product is currently unavailable. Try again later",
  ],
  [
    504,
    "timeout",
    "server",
    "Hetzner did not answer in time. For write operations, first check with the matching *_get or action_list tool whether the change was applied (for a new resource: with the matching *_list tool, filtered by name), then retry",
  ],
  // operation-specific (1.0 endpoints)
  [
    422,
    "server_not_stopped",
    "conflict",
    "The server must be powered off for this action. Shut it down with server_power, wait until it is off, and retry",
  ],
  [
    422,
    "invalid_server_type",
    "bad_request",
    "The server type does not fit this server or is deprecated. Choose a type with the same storage type and at least the same disk size (catalog_server_types)",
  ],
  [
    422,
    "placement_error",
    "unavailable",
    "Hetzner could not place the server. Try another location or server type",
  ],
  [
    412,
    "primary_ip_version_mismatch",
    "bad_request",
    "The specified Primary IP has the wrong IP version",
  ],
  [
    422,
    "primary_ip_assigned",
    "conflict",
    "The specified Primary IP is already assigned to a server",
  ],
  [
    422,
    "primary_ip_datacenter_mismatch",
    "bad_request",
    "The specified Primary IP is in a different location",
  ],
  [
    422,
    "no_space_left_in_location",
    "unavailable",
    "There is no volume space left in this location. Choose another location",
  ],
  [
    422,
    "resource_in_use",
    "conflict",
    "The firewall is still applied to resources. Remove it from all resources first, then delete it",
  ],
  [
    404,
    "firewall_resource_not_found",
    "not_found",
    "A resource the firewall should be applied to or removed from was not found",
  ],
  [
    422,
    "firewall_resource_not_found",
    "not_found",
    "A resource the firewall should be applied to or removed from was not found",
  ],
  [422, "firewall_already_applied", "conflict", "The firewall is already applied to this resource"],
  [
    422,
    "firewall_managed_by_label_selector",
    "conflict",
    "The firewall is applied to this server through a label selector and cannot be removed from it directly. Remove the label selector target instead",
  ],
  [
    422,
    "private_net_only_server",
    "bad_request",
    "The server has no public network interface; firewalls apply to public interfaces only",
  ],
  [
    422,
    "incompatible_network_type",
    "bad_request",
    "The network type of this resource is not supported by firewalls",
  ],
  [422, "server_already_added", "bad_request", "The same server was listed more than once"],
];

describe("mapHetznerError", () => {
  it("covers all 21 global and 14 operation-specific codes (35 codes, 36 rows)", () => {
    expect(new Set(TABLE.map((r) => r[1])).size).toBe(35);
    expect(TABLE).toHaveLength(36);
  });

  it.each(TABLE)("maps every documented Hetzner code: HTTP %i %s", (status, code, kind, text) => {
    const result = mapHetznerError(apiErr({ status, code }));
    expect(result).toBeInstanceOf(ToolError);
    expect(result.kind).toBe(kind);
    expect(result.status).toBe(status);
    expect(result.message.startsWith(text)).toBe(true);
    expect(result.message.endsWith(`[hetzner: ${code}, HTTP ${status}]`)).toBe(true);
  });

  it("appends the Hetzner message for codes without details", () => {
    const result = mapHetznerError(
      apiErr({ status: 404, code: "not_found", apiMessage: "server not found" }),
    );
    expect(result.message).toBe(
      "Not found (HTTP 404): the resource does not exist in this project. Check the ID with the matching *_list tool. Hetzner says: server not found. [hetzner: not_found, HTTP 404]",
    );
  });

  it("lists invalid_input fields", () => {
    const result = mapHetznerError(
      apiErr({
        status: 422,
        code: "invalid_input",
        apiMessage: "invalid input in field 'name'",
        details: {
          fields: [
            { name: "name", messages: ["is too long"] },
            { name: "labels", messages: ["invalid"] },
          ],
        },
      }),
    );
    expect(result.kind).toBe("bad_request");
    expect(result.message).toBe(
      "Hetzner rejected the input: name: is too long; labels: invalid. [hetzner: invalid_input, HTTP 422]",
    );
    expect(result.message).not.toContain("Hetzner says");
  });

  it("falls back to the Hetzner message when invalid_input has no fields", () => {
    for (const details of [undefined, null, { fields: [] }, { fields: "x" }, "garbage", 42]) {
      const result = mapHetznerError(
        apiErr({ status: 422, code: "invalid_input", apiMessage: "bad thing", details }),
      );
      expect(result.message).toBe(
        "Hetzner rejected the input. Hetzner says: bad thing. [hetzner: invalid_input, HTTP 422]",
      );
    }
  });

  it("caps invalid_input at five fields", () => {
    const fields = Array.from({ length: 7 }, (_, i) => ({
      name: `f${i}`,
      messages: ["bad", "worse"],
    }));
    const result = mapHetznerError(
      apiErr({ status: 422, code: "invalid_input", details: { fields } }),
    );
    expect(result.message).toBe(
      "Hetzner rejected the input: f0: bad, worse; f1: bad, worse; f2: bad, worse; f3: bad, worse; f4: bad, worse; …. [hetzner: invalid_input, HTTP 422]",
    );
    const long = mapHetznerError(
      apiErr({
        status: 422,
        code: "invalid_input",
        details: { fields: [{ name: "n", messages: ["x".repeat(500)] }] },
      }),
    );
    const part = long.message.slice(
      "Hetzner rejected the input: ".length,
      long.message.indexOf(". [hetzner"),
    );
    expect(Array.from(part)).toHaveLength(120);
  });

  it("names uniqueness and limit fields", () => {
    const uniq = mapHetznerError(
      apiErr({
        status: 409,
        code: "uniqueness_error",
        apiMessage: "SSH key with the same fingerprint already exists",
        details: { fields: [{ name: "public_key" }, { name: "name" }] },
      }),
    );
    expect(uniq.kind).toBe("conflict");
    expect(uniq.message).toBe(
      "A resource with the same unique value already exists: public_key, name. Choose a different value or use the existing resource. [hetzner: uniqueness_error, HTTP 409]",
    );
    const limit = mapHetznerError(
      apiErr({
        status: 403,
        code: "resource_limit_exceeded",
        details: { limits: [{ name: "server_limit" }] },
      }),
    );
    expect(limit.kind).toBe("limit_exceeded");
    expect(limit.message).toBe(
      "The project has reached a resource limit: server_limit. Delete unused resources or ask Hetzner support to raise the limit. [hetzner: resource_limit_exceeded, HTTP 403]",
    );
    const none = mapHetznerError(
      apiErr({ status: 403, code: "resource_limit_exceeded", details: { limits: [{ nope: 1 }] } }),
    );
    expect(none.message).toBe(
      "The project has reached a resource limit. Delete unused resources or ask Hetzner support to raise the limit. [hetzner: resource_limit_exceeded, HTTP 403]",
    );
  });

  it("adds the announcement URL of deprecated endpoints only for https", () => {
    const withUrl = mapHetznerError(
      apiErr({
        status: 410,
        code: "deprecated_api_endpoint",
        details: { announcement: "https://docs.hetzner.cloud/changelog#x" },
      }),
    );
    expect(withUrl.message).toBe(
      "Hetzner has removed this API endpoint. Update hetzner-model-context-protocol to a newer version. See https://docs.hetzner.cloud/changelog#x. [hetzner: deprecated_api_endpoint, HTTP 410]",
    );
    const insecure = mapHetznerError(
      apiErr({
        status: 410,
        code: "deprecated_api_endpoint",
        details: { announcement: "javascript:alert(1)" },
      }),
    );
    expect(insecure.message).not.toContain("See");
  });

  const FALLBACKS: [number, ToolErrorKind, string][] = [
    [400, "bad_request", "Hetzner rejected the request as invalid"],
    [422, "bad_request", "Hetzner rejected the request as invalid"],
    [401, "auth", "Hetzner rejected the API token (HTTP 401)."],
    [403, "forbidden", "Hetzner denied the operation (HTTP 403)"],
    [404, "not_found", "Not found (HTTP 404)"],
    [409, "conflict", "Hetzner reported a conflict with the current state of the resource"],
    [412, "unavailable", "The requested resource is currently not available"],
    [423, "locked", "The resource is locked because another action is running on it"],
    [429, "rate_limited", "Hetzner rate limit reached"],
    [
      500,
      "server",
      "Hetzner reported a server error. Try again later; for write operations, first check whether the change was applied (the matching *_get tool, or for a new resource the matching *_list tool filtered by name)",
    ],
    [502, "server", "Hetzner reported a server error."],
    [503, "server", "Hetzner reported a server error."],
    [599, "server", "Hetzner reported a server error."],
    [418, "unexpected", "Unexpected response from Hetzner"],
    [302, "unexpected", "Unexpected response from Hetzner"],
  ];

  it.each(FALLBACKS)("falls back by status for unknown codes: HTTP %i", (status, kind, text) => {
    const unknown = mapHetznerError(apiErr({ status, code: "ip_not_available" }));
    expect(unknown.kind).toBe(kind);
    expect(unknown.message.startsWith(text)).toBe(true);
    expect(unknown.message.endsWith(`[hetzner: ip_not_available, HTTP ${status}]`)).toBe(true);
    const noCode = mapHetznerError(apiErr({ status }));
    expect(noCode.kind).toBe(kind);
    expect(noCode.message.startsWith(text)).toBe(true);
    expect(noCode.message.endsWith(`[HTTP ${status}]`)).toBe(true);
  });

  it("falls back for a 2xx body that is not JSON", () => {
    const result = mapHetznerError(apiErr({ status: 200, code: "invalid_response" }));
    expect(result.kind).toBe("unexpected");
    expect(result.message).toBe("Hetzner returned a response that is not valid JSON. [HTTP 200]");
  });

  it("does not treat prototype names or malformed codes as table rows", () => {
    expect(mapHetznerError(apiErr({ status: 422, code: "toString" })).kind).toBe("bad_request");
    const odd = mapHetznerError(apiErr({ status: 404, code: "Not Found <b>" }));
    expect(odd.kind).toBe("not_found");
    expect(odd.message.endsWith("[HTTP 404]")).toBe(true);
  });

  it("handles non-JSON error bodies", () => {
    const result = mapHetznerError(apiErr({ status: 502 }));
    expect(result.kind).toBe("server");
    expect(result.message.endsWith("[HTTP 502]")).toBe(true);
    expect(result.message).not.toContain("hetzner:");
  });

  it("sanitises and truncates Hetzner messages", () => {
    const dirty = `line1\nline2\t\u0000\u001b[31m   "quoted"\u007f end`;
    const result = mapHetznerError(apiErr({ status: 404, code: "not_found", apiMessage: dirty }));
    expect(result.message).toContain('Hetzner says: line1 line2 [31m "quoted" end.');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test asserts their absence
    expect(result.message).not.toMatch(/[\u0000-\u001f\u007f]/);

    const long = mapHetznerError(
      apiErr({ status: 404, code: "not_found", apiMessage: "a".repeat(1000) }),
    );
    const said = long.message.slice(
      long.message.indexOf("Hetzner says: ") + 14,
      long.message.lastIndexOf(" [hetzner"),
    );
    expect(Array.from(said.replace(/\.$/, "")).length).toBeLessThanOrEqual(300);
    expect(long.message.length).toBeLessThan(500);
  });

  it("formats rate limit errors with wait time", () => {
    const resetAt = Date.UTC(2027, 0, 15, 12, 0, 0);
    const result = mapHetznerError(
      apiErr({
        status: 429,
        code: "rate_limit_exceeded",
        rateLimit: { limit: 3600, remaining: 0, resetAt },
      }),
    );
    expect(result.kind).toBe("rate_limited");
    expect(result.message).toBe(
      "Hetzner rate limit reached (3600 requests per hour for this project, 0 left). Wait at least 1 s before the next call and avoid polling; the full quota is back at 2027-01-15T12:00:00.000Z. [hetzner: rate_limit_exceeded, HTTP 429]",
    );
    const retryAfter = mapHetznerError(
      apiErr({
        status: 429,
        code: "rate_limit_exceeded",
        rateLimit: { limit: 3600, remaining: 0, resetAt },
        retryAfterMs: 2500,
      }),
    );
    expect(retryAfter.message).toContain("Wait at least 3 s");
    const lowLimit = mapHetznerError(
      apiErr({
        status: 429,
        code: "rate_limit_exceeded",
        rateLimit: { limit: 600, remaining: 0, resetAt },
      }),
    );
    expect(lowLimit.message).toContain("Wait at least 6 s");
    const bare = mapHetznerError(apiErr({ status: 429, code: "rate_limit_exceeded" }));
    expect(bare.message).toBe(
      "Hetzner rate limit reached. Wait a few seconds before the next call and avoid polling. [hetzner: rate_limit_exceeded, HTTP 429]",
    );
  });

  it("maps TimeoutError, AbortError and network errors", () => {
    const timeout = mapHetznerError(new DOMException("timed out", "TimeoutError"), {
      timeoutMs: 30000,
    });
    expect(timeout.kind).toBe("timeout");
    expect(timeout.message).toBe(
      "The request to Hetzner timed out after 30000 ms. Increase HETZNER_MCP_TIMEOUT_MS or try again; for write operations, first check whether the change was applied.",
    );
    const wrapped = new Error("wrapped", { cause: new DOMException("t", "TimeoutError") });
    expect(mapHetznerError(wrapped).kind).toBe("timeout");

    const abort = mapHetznerError(new DOMException("aborted", "AbortError"));
    expect(abort.kind).toBe("cancelled");
    expect(abort.message).toBe(
      "The request was cancelled by the client. For write operations, check whether the change was applied before retrying.",
    );

    const ctx = { apiUrl: "https://api.hetzner.cloud/v1" };
    const network = [
      new TypeError("fetch failed"),
      new Error("connect ECONNREFUSED 127.0.0.1:443"),
      new Error("x", { cause: new Error("getaddrinfo ENOTFOUND api.hetzner.cloud") }),
      Object.assign(new Error("other"), { cause: { code: "EAI_AGAIN" } }),
      new Error("unable to verify the first certificate"),
    ];
    for (const error of network) {
      const result = mapHetznerError(error, ctx);
      expect(result.kind).toBe("network");
      expect(result.message).toBe(
        "Cannot reach the Hetzner API at https://api.hetzner.cloud/v1. Check network connectivity, proxy and TLS settings.",
      );
    }
    const other = mapHetznerError(new RangeError("boom"));
    expect(other.kind).toBe("unexpected");
    expect(other.message).toBe("An unexpected error occurred while talking to Hetzner.");
    expect(mapHetznerError("a string").kind).toBe("unexpected");
    expect(mapHetznerError(undefined).kind).toBe("unexpected");
  });

  it("passes ToolError through and never leaks the token", () => {
    const original = new ToolError("guard", "Invalid id: must be a positive integer.");
    expect(mapHetznerError(original)).toBe(original);

    const token = "SENSITIVE-hcloud-token-0123456789";
    const leaky: unknown[] = [
      new TypeError(`fetch failed: Authorization: Bearer ${token}`),
      new Error(`boom ${token}`, { cause: new Error(`Bearer ${token}`) }),
      Object.assign(new DOMException(`aborted ${token}`, "AbortError")),
      new DOMException(`timeout ${token}`, "TimeoutError"),
      { message: token, stack: token },
      apiErr({ status: 401, code: "unauthorized" }),
      apiErr({ status: 500, details: { token } }),
    ];
    for (const error of leaky) {
      const result = mapHetznerError(error, {
        apiUrl: "https://api.hetzner.cloud/v1",
        timeoutMs: 1000,
      });
      expect(result.message).not.toContain(token);
      expect(result.message).not.toContain("Bearer");
      expect(result.message).not.toMatch(/\n\s+at /);
    }
    const api = apiErr({ status: 503, code: "unavailable", apiMessage: "down" });
    expect(api.message).not.toContain("down");
  });
});
