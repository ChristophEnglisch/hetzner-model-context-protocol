import type { HttpMethod } from "./gateway.js";

export type ToolErrorKind =
  | "auth" // 401
  | "forbidden" // 403 forbidden
  | "not_found" // 404
  | "conflict" // 409, operation-specific state conflicts
  | "locked" // 423 locked
  | "protected" // 423 protected
  | "bad_request" // 400/422 input
  | "limit_exceeded" // 403 resource_limit_exceeded
  | "rate_limited" // 429
  | "unavailable" // 403 maintenance, 412, 503, capacity
  | "unsupported" // 405, 410, 422 unsupported_error
  | "server" // 5xx, 422 service_error
  | "network"
  | "timeout" // own timeout
  | "cancelled" // MCP client cancelled the request
  | "action_failed" // an awaited action finished with status "error"
  | "guard" // own guards (scope, IaC, ids)
  | "confirmation_required"
  | "unexpected";

/** An error whose message is safe and useful to show to the model/user. */
export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  readonly status: number | undefined;

  constructor(kind: ToolErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ToolError";
    this.kind = kind;
    this.status = status;
  }
}

export interface RateLimitState {
  limit: number;
  remaining: number;
  /** epoch ms */
  resetAt: number;
}

export interface HetznerApiErrorInit {
  status: number;
  method: HttpMethod;
  code?: string | undefined;
  apiMessage?: string | undefined;
  details?: unknown;
  rateLimit?: RateLimitState | undefined;
  retryAfterMs?: number | undefined;
}

/** Raw HTTP failure from Hetzner. Its own `message` never carries API text, headers or the token. */
export class HetznerApiError extends Error {
  readonly status: number;
  /** Hetzner error.code */
  readonly code: string | undefined;
  /** Hetzner error.message (raw, untrusted) */
  readonly apiMessage: string | undefined;
  /** Hetzner error.details (raw) */
  readonly details: unknown;
  readonly rateLimit: RateLimitState | undefined;
  readonly retryAfterMs: number | undefined;
  readonly method: HttpMethod;

  constructor(init: HetznerApiErrorInit) {
    super(`Hetzner API request failed with HTTP ${init.status}`);
    this.name = "HetznerApiError";
    this.status = init.status;
    this.code = init.code;
    this.apiMessage = init.apiMessage;
    this.details = init.details;
    this.rateLimit = init.rateLimit;
    this.retryAfterMs = init.retryAfterMs;
    this.method = init.method;
  }
}

export interface ErrorContext {
  apiUrl?: string;
  timeoutMs?: number;
}

/** Own code for a 2xx body that is not JSON (01 §3.3 step 4); never shown as a Hetzner code. */
export const INVALID_RESPONSE = "invalid_response";

const MAX_MESSAGE = 300;
const MAX_FIELD = 120;
const MAX_FIELDS = 5;
/** A code is shown in `[hetzner: …]` only if it looks like a Hetzner code (it is untrusted text). */
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

// --- texts (4.3, verbatim) -------------------------------------------------------------------

const T = {
  json_error:
    "Hetzner could not parse the request body as JSON. This is a bug in hetzner-model-context-protocol; please report it",
  unauthorized:
    "Hetzner rejected the API token (HTTP 401). Check HETZNER_TOKEN: it may be invalid or revoked, or its project may have been deleted",
  forbidden:
    "Hetzner denied the operation (HTTP 403): the API token lacks the permission. If it is a Read-only token, create a Read & Write token in the project (Security → API Tokens), or run with HETZNER_MCP_READ_ONLY=true",
  maintenance:
    "Hetzner cannot perform this operation right now because of maintenance. Try again later; do not retry in a loop",
  not_found:
    "Not found (HTTP 404): the resource does not exist in this project. Check the ID with the matching *_list tool",
  method_not_allowed:
    "Hetzner does not allow this request method. This is a bug in hetzner-model-context-protocol; please report it",
  conflict: "The resource changed while the request was processed. Load it again and retry",
  resource_unavailable:
    "The requested resource is currently not available (for example not orderable in this location). Choose another type or location (see catalog_server_types)",
  service_error: "A Hetzner service reported an error while processing the request",
  unsupported_error: "This resource does not support the requested action",
  locked:
    "The resource is locked because another action is running on it. Wait for that action (action_list / action_get) and retry",
  protected:
    "The resource is protected against this action. Protection is never removed automatically: ask the user whether to disable it with the matching *_protection_set tool, then retry",
  server_error: "Hetzner reported an internal error. Try again later",
  bad_gateway:
    "Hetzner could not answer the request (bad gateway). Try again later; for write operations, first check with the matching *_get or action_list tool whether the change was applied (for a new resource: with the matching *_list tool, filtered by name)",
  unavailable: "A Hetzner service or product is currently unavailable. Try again later",
  timeout:
    "Hetzner did not answer in time. For write operations, first check with the matching *_get or action_list tool whether the change was applied (for a new resource: with the matching *_list tool, filtered by name), then retry",
  rate_limit_short:
    "Hetzner rate limit reached. Wait a few seconds before the next call and avoid polling",
} as const;

const FALLBACK = {
  bad_request: "Hetzner rejected the request as invalid",
  conflict: "Hetzner reported a conflict with the current state of the resource",
  server:
    "Hetzner reported a server error. Try again later; for write operations, first check whether the change was applied (the matching *_get tool, or for a new resource the matching *_list tool filtered by name)",
  unexpected: "Unexpected response from Hetzner",
  invalid_response: "Hetzner returned a response that is not valid JSON",
} as const;

/**
 * One row of 4.3. `text` builds the message body (before `.` and the bracket); `says` controls whether
 * ` Hetzner says: …` may follow (4.2: not for the three codes that carry details instead).
 */
interface Row {
  kind: ToolErrorKind;
  text: (e: HetznerApiError) => string;
  says: boolean;
}

const fixed = (kind: ToolErrorKind, text: string): Row => ({ kind, text: () => text, says: true });

const ROWS: Readonly<Record<string, Row>> = {
  // global codes (R§2.3)
  json_error: fixed("bad_request", T.json_error),
  unauthorized: fixed("auth", T.unauthorized),
  forbidden: fixed("forbidden", T.forbidden),
  maintenance: fixed("unavailable", T.maintenance),
  resource_limit_exceeded: {
    kind: "limit_exceeded",
    text: (e) =>
      `The project has reached a resource limit${nameList(e.details, "limits")}. Delete unused resources or ask Hetzner support to raise the limit`,
    says: false,
  },
  not_found: fixed("not_found", T.not_found),
  method_not_allowed: fixed("unsupported", T.method_not_allowed),
  uniqueness_error: {
    kind: "conflict",
    text: (e) =>
      `A resource with the same unique value already exists${nameList(e.details, "fields")}. Choose a different value or use the existing resource`,
    says: false,
  },
  conflict: fixed("conflict", T.conflict),
  deprecated_api_endpoint: {
    kind: "unsupported",
    text: (e) =>
      `Hetzner has removed this API endpoint. Update hetzner-model-context-protocol to a newer version${announcement(e.details)}`,
    says: true,
  },
  resource_unavailable: fixed("unavailable", T.resource_unavailable),
  invalid_input: {
    kind: "bad_request",
    // Without fields the ` Hetzner says:` addition applies (4.4); see invalidInputFields().
    text: (e) => `Hetzner rejected the input${invalidInputFields(e.details) ?? ""}`,
    says: false,
  },
  service_error: fixed("server", T.service_error),
  unsupported_error: fixed("unsupported", T.unsupported_error),
  locked: fixed("locked", T.locked),
  protected: fixed("protected", T.protected),
  rate_limit_exceeded: { kind: "rate_limited", text: rateLimitText, says: true },
  server_error: fixed("server", T.server_error),
  bad_gateway: fixed("server", T.bad_gateway),
  unavailable: fixed("unavailable", T.unavailable),
  timeout: fixed("server", T.timeout),

  // operation-specific codes of the 1.0 endpoints
  server_not_stopped: fixed(
    "conflict",
    "The server must be powered off for this action. Shut it down with server_power, wait until it is off, and retry",
  ),
  invalid_server_type: fixed(
    "bad_request",
    "The server type does not fit this server or is deprecated. Choose a type with the same storage type and at least the same disk size (catalog_server_types)",
  ),
  placement_error: fixed(
    "unavailable",
    "Hetzner could not place the server. Try another location or server type",
  ),
  primary_ip_version_mismatch: fixed(
    "bad_request",
    "The specified Primary IP has the wrong IP version",
  ),
  primary_ip_assigned: fixed(
    "conflict",
    "The specified Primary IP is already assigned to a server",
  ),
  primary_ip_datacenter_mismatch: fixed(
    "bad_request",
    "The specified Primary IP is in a different location",
  ),
  no_space_left_in_location: fixed(
    "unavailable",
    "There is no volume space left in this location. Choose another location",
  ),
  resource_in_use: fixed(
    "conflict",
    "The firewall is still applied to resources. Remove it from all resources first, then delete it",
  ),
  firewall_resource_not_found: fixed(
    "not_found",
    "A resource the firewall should be applied to or removed from was not found",
  ),
  firewall_already_applied: fixed("conflict", "The firewall is already applied to this resource"),
  firewall_managed_by_label_selector: fixed(
    "conflict",
    "The firewall is applied to this server through a label selector and cannot be removed from it directly. Remove the label selector target instead",
  ),
  private_net_only_server: fixed(
    "bad_request",
    "The server has no public network interface; firewalls apply to public interfaces only",
  ),
  incompatible_network_type: fixed(
    "bad_request",
    "The network type of this resource is not supported by firewalls",
  ),
  server_already_added: fixed("bad_request", "The same server was listed more than once"),
};

/** Fallback for unknown codes or a missing body, by HTTP status (4.3). */
function fallbackRow(status: number): Row {
  switch (status) {
    case 400:
    case 422:
      return fixed("bad_request", FALLBACK.bad_request);
    case 401:
      return fixed("auth", T.unauthorized);
    case 403:
      return fixed("forbidden", T.forbidden);
    case 404:
      return fixed("not_found", T.not_found);
    case 409:
      return fixed("conflict", FALLBACK.conflict);
    case 412:
      return fixed("unavailable", T.resource_unavailable);
    case 423:
      return fixed("locked", T.locked);
    case 429:
      return { kind: "rate_limited", text: rateLimitText, says: true };
    default:
      return status >= 500
        ? fixed("server", FALLBACK.server)
        : fixed("unexpected", FALLBACK.unexpected);
  }
}

// --- helpers ---------------------------------------------------------------------------------

/**
 * The one definition of "control character" (OE-24): C0, DEL, C1, U+2028/U+2029 and the bidi
 * controls U+200E/U+200F, U+202A–U+202E, U+2066–U+2069. Used by sanitizeApiText, quoteName,
 * hasControlChars (guards.ts) and thereby the name and path validation. Lives here because
 * guards.ts imports this module (no import cycle).
 */
export function isControlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** 4.2: control characters → space, collapse whitespace, cut to `max` characters. Quotes stay. */
export function sanitizeApiText(text: string, max = MAX_MESSAGE): string {
  let out = "";
  for (const char of text) {
    out += isControlChar(char) ? " " : char;
  }
  out = out.replace(/\s+/g, " ").trim();
  const chars = Array.from(out);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : out;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function entries(details: unknown, key: "fields" | "limits"): Record<string, unknown>[] {
  const list = record(details)?.[key];
  if (!Array.isArray(list)) return [];
  return list.map(record).filter((x): x is Record<string, unknown> => x !== undefined);
}

function joinCapped(parts: string[], separator: string): string {
  const shown = parts.slice(0, MAX_FIELDS).join(separator);
  return parts.length > MAX_FIELDS ? `${shown}${separator}…` : shown;
}

/** `: <name1>, <name2>` for uniqueness_error / resource_limit_exceeded (4.4), empty if none. */
function nameList(details: unknown, key: "fields" | "limits"): string {
  const names = entries(details, key)
    .map((e) => (typeof e.name === "string" ? sanitizeApiText(e.name, MAX_FIELD) : ""))
    .filter((n) => n !== "");
  return names.length > 0 ? `: ${joinCapped(names, ", ")}` : "";
}

/** `: <name>: <m1>, <m2>; <name>: …` (4.4), or undefined if there are no usable fields. */
function invalidInputFields(details: unknown): string | undefined {
  const parts: string[] = [];
  for (const field of entries(details, "fields")) {
    const name = typeof field.name === "string" ? field.name : "";
    const messages = Array.isArray(field.messages)
      ? field.messages.filter((m): m is string => typeof m === "string")
      : [];
    const raw = messages.length > 0 ? `${name}: ${messages.join(", ")}` : name;
    const part = sanitizeApiText(raw, MAX_FIELD);
    if (part !== "") parts.push(part);
  }
  return parts.length > 0 ? `: ${joinCapped(parts, "; ")}` : undefined;
}

/** `. See <url>` only for an https URL without whitespace (4.4). */
function announcement(details: unknown): string {
  const url = record(details)?.announcement;
  if (typeof url !== "string" || !/^https:\/\/[^\s"<>]+$/.test(url) || url.length > MAX_MESSAGE) {
    return "";
  }
  return `. See ${url}`;
}

/** Fallback wait when Retry-After is absent: one token interval, at least 1 s (3.4). */
export function tokenIntervalMs(limit: number | undefined): number {
  return limit !== undefined && limit > 0 ? Math.max(1000, Math.ceil(3_600_000 / limit)) : 1000;
}

function rateLimitText(e: HetznerApiError): string {
  const rl = e.rateLimit;
  if (!rl) return T.rate_limit_short;
  const retryInS = Math.ceil((e.retryAfterMs ?? tokenIntervalMs(rl.limit)) / 1000);
  const resetIso = Number.isFinite(rl.resetAt) ? new Date(rl.resetAt).toISOString() : "unknown";
  return `Hetzner rate limit reached (${rl.limit} requests per hour for this project, ${rl.remaining} left). Wait at least ${retryInS} s before the next call and avoid polling; the full quota is back at ${resetIso}`;
}

function hetznerSays(apiMessage: string | undefined): string {
  if (typeof apiMessage !== "string") return "";
  const clean = sanitizeApiText(apiMessage);
  if (clean === "") return "";
  return ` Hetzner says: ${/[.!?…]$/.test(clean) ? clean : `${clean}.`}`;
}

function mapHttp(e: HetznerApiError): ToolError {
  const code = typeof e.code === "string" && CODE_RE.test(e.code) ? e.code : undefined;

  if (code === INVALID_RESPONSE && e.status >= 200 && e.status < 300) {
    return new ToolError(
      "unexpected",
      `${FALLBACK.invalid_response}. [HTTP ${e.status}]`,
      e.status,
    );
  }

  const row =
    (code !== undefined && Object.hasOwn(ROWS, code) ? ROWS[code] : undefined) ??
    fallbackRow(e.status);
  let says = row.says;
  if (code === "invalid_input" && invalidInputFields(e.details) === undefined) says = true;

  const bracket =
    code !== undefined ? `[hetzner: ${code}, HTTP ${e.status}]` : `[HTTP ${e.status}]`;
  const tail = says ? hetznerSays(e.apiMessage) : "";
  return new ToolError(row.kind, `${row.text(e)}.${tail} ${bracket}`, e.status);
}

function errorName(value: unknown): string | undefined {
  const name = record(value)?.name;
  return typeof name === "string" ? name : undefined;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  const message = record(value)?.message;
  return typeof message === "string" ? message : "";
}

const NETWORK_RE = /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|certificate/i;

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const cause = record(error)?.cause;
  const causeCode = record(cause)?.code;
  const text = `${errorMessage(error)} ${errorMessage(cause)} ${typeof causeCode === "string" ? causeCode : ""}`;
  return NETWORK_RE.test(text);
}

/** Idempotent: ToolError passes through unchanged. Never leaks stack traces, tokens or request bodies. */
export function mapHetznerError(error: unknown, ctx: ErrorContext = {}): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof HetznerApiError) return mapHttp(error);

  // TimeoutError before AbortError (4.5): AbortSignal.timeout() yields TimeoutError.
  if (errorName(error) === "TimeoutError" || errorName(record(error)?.cause) === "TimeoutError") {
    const after = ctx.timeoutMs !== undefined ? ` after ${ctx.timeoutMs} ms` : "";
    return new ToolError(
      "timeout",
      `The request to Hetzner timed out${after}. Increase HETZNER_MCP_TIMEOUT_MS or try again; for write operations, first check whether the change was applied.`,
    );
  }
  if (errorName(error) === "AbortError") {
    return new ToolError(
      "cancelled",
      "The request was cancelled by the client. For write operations, check whether the change was applied before retrying.",
    );
  }
  if (isNetworkError(error)) {
    const at = ctx.apiUrl !== undefined ? ` at ${ctx.apiUrl}` : "";
    return new ToolError(
      "network",
      `Cannot reach the Hetzner API${at}. Check network connectivity, proxy and TLS settings.`,
    );
  }
  return new ToolError("unexpected", "An unexpected error occurred while talking to Hetzner.");
}
