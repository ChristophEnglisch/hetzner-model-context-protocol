// Teststufe 2 (01 §9.5, CT-1..CT-8): the built dist/index.js as a child process, an SDK client over
// stdio, a stub HTTP server on 127.0.0.1. Run with `npm run test:contract` (builds first).
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { HetznerStub, STUB_TOKEN } from "../stub/hetzner-stub.js";

const ROOT = join(import.meta.dirname, "..", "..");

interface BuiltTool {
  name: string;
  costs?: boolean;
}

/** The tool definitions of the built server (dist/tools/index.js), not of src/. */
async function builtTools(): Promise<BuiltTool[]> {
  const mod = (await import(pathToFileURL(join(ROOT, "dist", "tools", "index.js")).href)) as {
    TOOLSETS: Record<string, readonly BuiltTool[]>;
  };
  return Object.values(mod.TOOLSETS).flat();
}

/** Everything the server sent back or wrote in all sessions of this file, for CT-7. */
const observed: string[] = [];

interface Session {
  stub: HetznerStub;
  client: Client;
  stderr: () => string;
  stdoutErrors: Error[];
}

const open: Session[] = [];

async function start(env: Record<string, string> = {}): Promise<Session> {
  const stub = new HetznerStub();
  await stub.start();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "dist", "index.js")],
    env: {
      HETZNER_TOKEN: STUB_TOKEN,
      HETZNER_API_URL: stub.apiUrl,
      HETZNER_MCP_TOOLSETS: "all",
      ...env,
    },
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  // A stdout line that is not JSON-RPC surfaces here.
  const stdoutErrors: Error[] = [];
  transport.onerror = (e) => stdoutErrors.push(e);
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  await client.connect(transport);
  const session: Session = { stub, client, stderr: () => err, stdoutErrors };
  open.push(session);
  return session;
}

afterEach(async () => {
  for (const s of open.splice(0)) {
    await s.client.close();
    await s.stub.stop();
    observed.push(s.stderr());
    // Every request of the server must have hit a route.
    expect(s.stub.unmatched).toEqual([]);
  }
});

const CREATE_ARGS = {
  name: "ct-server",
  server_type: "cpx22",
  image: "ubuntu-24.04",
  location: "fsn1",
  ssh_keys: ["ct-key"],
  public_net: { enable_ipv6: false },
};

async function call(s: Session, name: string, args: Record<string, unknown> = {}) {
  const res = await s.client.callTool({ name, arguments: args });
  observed.push(JSON.stringify(res));
  return res as {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };
}

describe("contract over stdio", () => {
  it("CT-1 starts from dist and lists all tools", async () => {
    const s = await start();
    const listed = (await s.client.listTools()).tools.map((t) => t.name).sort();
    const expected = (await builtTools()).map((t) => t.name).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(listed).toEqual(expected);
    expect(s.stderr()).toContain("HETZNER_API_URL points to '127.0.0.1");
    expect(s.stdoutErrors).toEqual([]);
  });

  it("CT-2 reads through real HTTP", async () => {
    const s = await start();
    const res = await call(s, "server_list", { page: 2, per_page: 5 });
    expect(res.isError).toBeFalsy();
    const [req, ...more] = s.stub.requests("GET", "/v1/servers");
    expect(more).toEqual([]);
    expect(req?.query.get("page")).toBe("2");
    expect(req?.query.get("per_page")).toBe("5");
    expect(req?.headers.authorization).toBe(`Bearer ${STUB_TOKEN}`);
    expect(req?.headers["user-agent"]).toMatch(/^hetzner-model-context-protocol\//);
  });

  it("CT-3 runs the confirmation flow end to end", async () => {
    const s = await start();
    const preview = await call(s, "server_create", CREATE_ARGS);
    expect(preview.isError).toBe(true);
    const text = preview.content[0]?.text ?? "";
    expect(text).toContain("Confirmation required");
    // 03 §2.8 E-1 with the fixture pricing
    expect(text).toContain(
      "Estimated cost: 2.00 EUR/month net (2.38 gross) = server 1.00 EUR/month net (1.19 gross) + new Primary IPv4 1.00 EUR/month net (1.19 gross).",
    );
    expect(s.stub.requests("POST", "/v1/servers")).toHaveLength(0);

    const done = await call(s, "server_create", { ...CREATE_ARGS, confirm: true });
    expect(done.isError).toBeFalsy();
    expect(s.stub.requests("POST", "/v1/servers")).toHaveLength(1);
    const poll = s.stub.requests("GET", "/v1/actions");
    expect(poll.length).toBeGreaterThanOrEqual(1);
    expect(poll[0]?.query.getAll("id").length).toBeGreaterThan(0);
    const actions = done.structuredContent?.actions as { status: string }[];
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.status === "success")).toBe(true);
    expect(JSON.stringify(done)).not.toContain("root_password");
    expect(JSON.stringify(done)).not.toContain("SENSITIVE-");
  });

  it("CT-4 hides cost tools with HETZNER_MCP_ALLOW_COSTS=false", async () => {
    const s = await start({ HETZNER_MCP_ALLOW_COSTS: "false" });
    const listed = (await s.client.listTools()).tools.map((t) => t.name).sort();
    const tools = await builtTools();
    expect(listed).toEqual(
      tools
        .filter((t) => !t.costs)
        .map((t) => t.name)
        .sort(),
    );
    expect(listed).not.toContain("server_create");
    expect(tools.some((t) => t.costs)).toBe(true);

    const outcome = await s.client
      .callTool({ name: "server_create", arguments: { ...CREATE_ARGS, confirm: true } })
      .then(
        (r) => JSON.stringify(r),
        (e: unknown) => String(e),
      );
    expect(outcome).toMatch(/not found/i);

    await expect(
      s.client.getPrompt({ name: "provision_web_server", arguments: { name: "ct-web" } }),
    ).rejects.toThrow(
      "Prompt provision_web_server creates resources that cost money, but this server runs with HETZNER_MCP_ALLOW_COSTS=false.",
    );
    expect(s.stub.calls).toEqual([]);
  });

  it("CT-5 rejects a call above HETZNER_MCP_MAX_MONTHLY_COST without any write", async () => {
    const s = await start({ HETZNER_MCP_MAX_MONTHLY_COST: "0.50" });
    const res = await call(s, "server_create", { ...CREATE_ARGS, confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe(
      "Cost limit exceeded: this call adds an estimated 2.00 EUR/month net, above HETZNER_MCP_MAX_MONTHLY_COST=0.50. Nothing was changed. Tell the user; only the operator can raise the limit.",
    );
    expect(s.stub.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(s.stub.requests("POST", "/v1/servers")).toHaveLength(0);
  });

  it("CT-6 fails closed when pricing is unavailable", async () => {
    const s = await start({ HETZNER_MCP_MAX_MONTHLY_COST: "5" });
    s.stub.override("GET", "/pricing", {
      status: 503,
      body: { error: { code: "unavailable", message: "unavailable", details: null } },
    });
    const res = await call(s, "server_create", { ...CREATE_ARGS, confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe(
      "Cost limit check failed: Hetzner pricing could not be loaded, so the monthly cost of this call is unknown while HETZNER_MCP_MAX_MONTHLY_COST=5 is set. Nothing was changed. Try again later.",
    );
    expect(s.stub.requests("POST", "/v1/servers")).toHaveLength(0);
  });

  it("CT-8 reads resources and prompts through stdio", async () => {
    const s = await start();
    const pricing = await s.client.readResource({ uri: "hetzner://pricing" });
    observed.push(JSON.stringify(pricing));
    expect(pricing.contents.length).toBeGreaterThan(0);
    const prompt = await s.client.getPrompt({ name: "audit_project_security", arguments: {} });
    observed.push(JSON.stringify(prompt));
    expect(prompt.messages.length).toBeGreaterThan(0);
  });

  // Runs last: checks what all cases above produced.
  it("CT-7 never writes the token to stderr or results", async () => {
    const s = await start();
    await call(s, "server_list");
    await s.client.close();
    observed.push(s.stderr());
    expect(observed.length).toBeGreaterThan(8);
    expect(observed.filter((text) => text.includes(STUB_TOKEN))).toEqual([]);
  });
});
