import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fixture } from "../helpers/fixtures.js";

// Teststufe 2 (01 §9.5): an HTTP stub that serves the checked-in fixtures. Its only state is the
// action status: delivered actions are "running", GET /actions?id=... reports "success". It does not
// validate bodies and does not create, delete or count anything.

/** Throwaway token of the contract tests; the stub rejects every other one. */
export const STUB_TOKEN = "contract-token-SECRET";

type Method = "GET" | "POST" | "PUT" | "DELETE";
export interface StubReply {
  status: number;
  body?: unknown;
}
export interface StubCall {
  method: string;
  /** with the /v1 prefix, e.g. "/v1/servers" */
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
}

// method, pattern, operationId. POST always answers 201 (create and action endpoints), the rest 200.
// DELETE/204 endpoints have no fixture and no route.
export const ROUTES: readonly (readonly [Method, string, string])[] = [
  ["GET", "/actions", "get_actions"],
  ["GET", "/actions/{id}", "get_action"],
  ["GET", "/pricing", "get_pricing"],
  ["GET", "/servers", "list_servers"],
  ["POST", "/servers", "create_server"],
  ["GET", "/servers/{id}", "get_server"],
  ["PUT", "/servers/{id}", "update_server"],
  ["DELETE", "/servers/{id}", "delete_server"],
  ["GET", "/servers/{id}/actions", "list_server_actions"],
  ["POST", "/servers/{id}/actions/poweron", "poweron_server"],
  ["POST", "/servers/{id}/actions/shutdown", "shutdown_server"],
  ["POST", "/servers/{id}/actions/reboot", "reboot_server"],
  ["POST", "/servers/{id}/actions/poweroff", "poweroff_server"],
  ["POST", "/servers/{id}/actions/reset", "reset_server"],
  ["POST", "/servers/{id}/actions/rebuild", "rebuild_server"],
  ["POST", "/servers/{id}/actions/change_type", "change_server_type"],
  ["POST", "/servers/{id}/actions/change_protection", "change_server_protection"],
  ["POST", "/servers/{id}/actions/enable_backup", "enable_server_backup"],
  ["POST", "/servers/{id}/actions/disable_backup", "disable_server_backup"],
  ["POST", "/servers/{id}/actions/create_image", "create_server_image"],
  ["GET", "/server_types", "list_server_types"],
  ["GET", "/locations", "list_locations"],
  ["GET", "/images", "list_images"],
  ["GET", "/images/{id}", "get_image"],
  ["PUT", "/images/{id}", "update_image"],
  ["GET", "/images/{id}/actions", "list_image_actions"],
  ["POST", "/images/{id}/actions/change_protection", "change_image_protection"],
  ["GET", "/ssh_keys", "list_ssh_keys"],
  ["POST", "/ssh_keys", "create_ssh_key"],
  ["GET", "/ssh_keys/{id}", "get_ssh_key"],
  ["PUT", "/ssh_keys/{id}", "update_ssh_key"],
  ["GET", "/firewalls", "list_firewalls"],
  ["POST", "/firewalls", "create_firewall"],
  ["GET", "/firewalls/{id}", "get_firewall"],
  ["PUT", "/firewalls/{id}", "update_firewall"],
  ["GET", "/firewalls/{id}/actions", "list_firewall_actions"],
  ["POST", "/firewalls/{id}/actions/set_rules", "set_firewall_rules"],
  ["POST", "/firewalls/{id}/actions/apply_to_resources", "apply_firewall_to_resources"],
  ["POST", "/firewalls/{id}/actions/remove_from_resources", "remove_firewall_from_resources"],
  ["GET", "/volumes", "list_volumes"],
  ["POST", "/volumes", "create_volume"],
  ["GET", "/volumes/{id}", "get_volume"],
  ["PUT", "/volumes/{id}", "update_volume"],
  ["GET", "/volumes/{id}/actions", "list_volume_actions"],
  ["POST", "/volumes/{id}/actions/attach", "attach_volume"],
  ["POST", "/volumes/{id}/actions/detach", "detach_volume"],
  ["POST", "/volumes/{id}/actions/resize", "resize_volume"],
  ["POST", "/volumes/{id}/actions/change_protection", "change_volume_protection"],
  ["GET", "/primary_ips", "list_primary_ips"],
  ["GET", "/floating_ips", "list_floating_ips"],
  ["GET", "/networks", "list_networks"],
  ["GET", "/load_balancers", "list_load_balancers"],
];

const UNAUTHORIZED = {
  error: { code: "unauthorized", message: "unable to authenticate", details: null },
};

const segmentsOf = (p: string): string[] => p.split("/").filter((s) => s !== "");

function matches(pattern: string, path: string): boolean {
  const want = segmentsOf(pattern);
  const got = segmentsOf(path);
  return (
    want.length === got.length &&
    want.every((w, i) => (w.startsWith("{") && w.endsWith("}")) || w === got[i])
  );
}

/** Every action the stub delivers is still running; the polling endpoint reports the end. */
function asRunning(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const out: Record<string, unknown> = { ...body };
  const run = (a: unknown): unknown =>
    typeof a === "object" && a !== null
      ? { ...a, status: "running", progress: 0, finished: null, error: null }
      : a;
  for (const key of ["action", "actions", "next_actions"]) {
    const v = out[key];
    if (Array.isArray(v)) out[key] = v.map(run);
    else if (v !== undefined) out[key] = run(v);
  }
  return out;
}

function polled(ids: string[]): unknown {
  const base = fixture<{ actions: Record<string, unknown>[] }>("get_actions").actions[0] ?? {};
  return {
    actions: ids.map((id) => ({
      ...base,
      id: Number(id),
      status: "success",
      progress: 100,
      error: null,
    })),
  };
}

export class HetznerStub {
  readonly calls: StubCall[] = [];
  /** "GET /v1/x?y" for requests without route */
  readonly unmatched: string[] = [];
  private readonly overrides = new Map<string, StubReply>();
  private server: Server | undefined;
  /** e.g. http://127.0.0.1:41234/v1 */
  apiUrl = "";

  /** Replaces the answer of one route (status and body), e.g. override("GET", "/pricing", {status: 503}). */
  override(method: Method, pattern: string, reply: StubReply): this {
    this.overrides.set(`${method} ${pattern}`, reply);
    return this;
  }

  requests(method: string, path: string): StubCall[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const reply = this.answer(req);
      const payload = reply.body === undefined ? undefined : JSON.stringify(reply.body);
      res.writeHead(reply.status, payload ? { "Content-Type": "application/json" } : {});
      res.end(payload);
      req.resume();
    });
    const server = this.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private answer(req: IncomingMessage): StubReply {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    this.calls.push({ method, path: url.pathname, query: url.searchParams, headers: req.headers });

    const h = req.headers;
    const transportOk =
      h.authorization === `Bearer ${STUB_TOKEN}` &&
      h.accept === "application/json" &&
      (h["user-agent"] ?? "").startsWith("hetzner-model-context-protocol/") &&
      (req.headers["content-length"] === undefined ||
        req.headers["content-length"] === "0" ||
        h["content-type"] === "application/json");
    if (!transportOk) return { status: 401, body: UNAUTHORIZED };

    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
    const route = ROUTES.find(([m, p]) => m === method && matches(p, path));
    if (!route) {
      this.unmatched.push(`${method} ${url.pathname}${url.search}`);
      return { status: 599, body: { error: { code: "stub_unmatched", message: "no route" } } };
    }
    const [, pattern, operationId] = route;
    const override = this.overrides.get(`${method} ${pattern}`);
    if (override) return override;
    if (method === "GET" && pattern === "/actions") {
      return { status: 200, body: polled(url.searchParams.getAll("id")) };
    }
    return {
      status: method === "POST" ? 201 : 200,
      body: asRunning(fixture(operationId)),
    };
  }
}
