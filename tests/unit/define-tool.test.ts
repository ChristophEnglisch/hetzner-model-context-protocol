import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Config } from "../../src/config.js";
import { ToolError } from "../../src/hetzner/errors.js";
import { path } from "../../src/hetzner/gateway.js";
import { type MonthlyCost, parseDec } from "../../src/hetzner/pricing.js";
import type { HetznerAction } from "../../src/hetzner/types.js";
import {
  type CallContext,
  defineTool,
  HOSTNAME_RE,
  idField,
  needsConfirmation,
  newLabelsField,
  pageOf,
  quoteName,
  type ToolDefinition,
  type ToolSpec,
  toPage,
} from "../../src/tools/shared.js";
import { action, apiError, noContent, ok } from "../helpers/fake-hetzner.js";
import { type Harness, logFields, startToolHarness, textOf } from "../helpers/harness.js";

// --- test tools -------------------------------------------------------------------------------

interface TestServer {
  id: number;
  name: string;
  labels: Record<string, string>;
}

const idInput = z.object({ id: idField("server") });
const idOutput = z.object({ id: z.number().int().describe("ID of the server.") });

async function loadServer(args: { id: number }, ctx: CallContext) {
  const body = await ctx.gateway.request<{ server: TestServer }>("GET", path`/servers/${args.id}`, {
    signal: ctx.signal,
  });
  return {
    value: body.server,
    resources: [{ type: "server" as const, id: body.server.id, labels: body.server.labels }],
  };
}

const serverReply = (labels: Record<string, string> = {}, id = 42) =>
  ok({ server: { id, name: "web-SENSITIVE-name", labels } });

function deleteTool(
  overrides: Partial<ToolSpec<typeof idInput, typeof idOutput, TestServer>> = {},
) {
  return defineTool({
    name: "test_delete",
    title: "Delete test server",
    description: "Deletes a test server.",
    kind: "destructive",
    input: idInput,
    output: idOutput,
    target: loadServer,
    preview: (_args, _ctx, server) => `delete server ${server.id}.`,
    handler: async (args, ctx) => {
      await ctx.gateway.request("DELETE", path`/servers/${args.id}`, { signal: ctx.signal });
      return { data: { id: args.id }, summary: `Deleted server ${args.id}.` };
    },
    ...overrides,
  });
}

function powerTool(overrides: Partial<ToolSpec<typeof idInput, typeof idOutput, TestServer>> = {}) {
  return defineTool({
    name: "test_power_on",
    title: "Power on test server",
    description: "Powers a test server on.",
    kind: "write",
    idempotent: true,
    input: idInput,
    output: idOutput,
    target: loadServer,
    actions: true,
    handler: async (args, ctx) => {
      const body = await ctx.gateway.request<{ action: HetznerAction }>(
        "POST",
        path`/servers/${args.id}/actions/poweron`,
        { signal: ctx.signal },
      );
      return {
        data: { id: args.id },
        summary: `Requested power on for server ${args.id}. Final action status is in 'actions'.`,
        actions: [body.action],
      };
    },
    ...overrides,
  });
}

/** MonthlyCost "ok" in EUR for a decimal string. */
const okCost = (net: string): MonthlyCost => ({
  kind: "ok",
  net: parseDec(net) ?? { units: 0n, scale: 0 },
  currency: "EUR",
});

const createInput = z.object({
  name: z.string().optional().describe("Name of the new server."),
  labels: newLabelsField.optional(),
});

function costTool(
  overrides: Partial<ToolSpec<typeof createInput, typeof idOutput, undefined>> = {},
) {
  return defineTool({
    name: "test_create",
    title: "Create test server",
    description: "Creates a test server (recurring cost).",
    kind: "write",
    costs: true,
    creates: true,
    input: createInput,
    output: idOutput,
    preview: () => "create a server.",
    monthlyCost: async () => okCost("1.00"),
    handler: async (_args, ctx) => {
      const body = await ctx.gateway.request<{ server: { id: number } }>("POST", "/servers", {
        body: {},
        signal: ctx.signal,
      });
      return { data: { id: body.server.id }, summary: `Created server ${body.server.id}.` };
    },
    ...overrides,
  });
}

const readTool = (handler: ToolSpec<typeof idInput, typeof idOutput>["handler"]) =>
  defineTool({
    name: "test_get",
    title: "Get test server",
    description: "Reads a test server.",
    kind: "read",
    input: idInput,
    output: idOutput,
    handler,
  });

// --- harness ----------------------------------------------------------------------------------

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function start(tools: ToolDefinition[], config: Partial<Config> = {}): Promise<Harness> {
  h = await startToolHarness(tools, config);
  return h;
}

const writes = (harness: Harness) => harness.fake.calls.filter((c) => c.method !== "GET");
const audit = (harness: Harness) => logFields(harness.logs, "tool_call");

// --- tests ------------------------------------------------------------------------------------

describe("defineTool at definition time", () => {
  const base: ToolSpec<z.ZodObject, z.ZodObject, undefined> = {
    name: "test_update",
    title: "Update",
    description: "Updates.",
    kind: "write",
    input: z.object({ id: idField("server") }),
    output: z.object({ id: z.number() }),
    target: async () => ({ value: undefined, resources: [] }),
    handler: async () => ({ data: { id: 1 }, summary: "ok" }),
  };
  const preview = () => "x.";
  const monthlyCost = async () => okCost("1.00");
  const noTarget = { target: undefined };

  it.each<[string, Partial<ToolSpec<z.ZodObject, z.ZodObject, undefined>>, string]>([
    [
      "bad name",
      { name: "Test-Update" },
      `name must match ${String(/^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/)}`,
    ],
    ["single segment", { name: "update" }, "name must match"],
    ["segment with leading digit", { name: "test_1x" }, "name must match"],
    [
      "destructive without preview",
      { kind: "destructive" },
      "destructive tools must define preview()",
    ],
    ["costs without preview", { costs: true }, "cost tools must define preview()"],
    ["costs without monthlyCost", { costs: true, preview }, "cost tools must define monthlyCost()"],
    [
      "monthlyCost without costs",
      { monthlyCost: async () => okCost("1.00") },
      "monthlyCost is only allowed for cost tools",
    ],
    [
      "input confirm",
      { input: z.object({ confirm: z.boolean() }) },
      "'confirm' is reserved and added automatically",
    ],
    [
      "input wait",
      { input: z.object({ wait: z.boolean() }) },
      "'wait' is reserved and added automatically",
    ],
    [
      "input project",
      { input: z.object({ project: z.string() }) },
      "'project' is reserved and added automatically",
    ],
    [
      "output warnings",
      { output: z.object({ warnings: z.array(z.string()) }) },
      "output key 'warnings' is reserved",
    ],
    [
      "output actions",
      { output: z.object({ actions: z.array(z.string()) }) },
      "output key 'actions' is reserved",
    ],
    [
      "write without target or creates",
      noTarget,
      "write tools must define target() or set creates: true",
    ],
    [
      "destructive without target or creates",
      { ...noTarget, kind: "destructive", preview },
      "write tools must define target() or set creates: true",
    ],
    [
      "read with target",
      { kind: "read" },
      "read tools must not define target/creates/costs/monthlyCost/preview/actions",
    ],
    [
      "read with creates",
      { ...noTarget, kind: "read", creates: true },
      "read tools must not define",
    ],
    [
      "read with costs",
      { ...noTarget, kind: "read", costs: true, preview },
      "read tools must not define",
    ],
    ["read with preview", { ...noTarget, kind: "read", preview }, "read tools must not define"],
    [
      "read with actions",
      { ...noTarget, kind: "read", actions: true },
      "read tools must not define",
    ],
  ])("rejects invalid specs at definition time: %s", (_case, change, message) => {
    const name = change.name ?? base.name;
    expect(() => defineTool({ ...base, ...change })).toThrow(`Tool ${name}: ${message}`);
  });

  it("accepts valid specs, including costs on destructive tools (05 K-28)", () => {
    expect(defineTool(base)).toMatchObject({ confirms: false, costs: false, actions: false });
    expect(defineTool({ ...base, target: undefined, creates: true })).toMatchObject({
      kind: "write",
    });
    expect(
      defineTool({ ...base, kind: "destructive", costs: true, preview, monthlyCost }),
    ).toMatchObject({
      confirms: true,
      costs: true,
    });
    expect(defineTool({ ...base, costs: true, preview, monthlyCost })).toMatchObject({
      confirms: true,
      costs: true,
    });
    expect(
      defineTool({ ...base, name: "test_ipv4_get", kind: "read", target: undefined }),
    ).toMatchObject({
      confirms: false,
    });
    expect(needsConfirmation({ kind: "write" })).toBe(false);
    expect(needsConfirmation({ kind: "write", costs: true })).toBe(true);
    expect(needsConfirmation({ kind: "destructive" })).toBe(true);
  });

  it.each(["root_password", "password", "wss_url", "user_data"])(
    "rejects output schemas declaring sensitive keys: %s",
    (key) => {
      const output: z.ZodObject = z.object({
        server: z
          .object({ meta: z.array(z.object({ [key]: z.string().nullable() })).optional() })
          .nullable(),
      });
      expect(() => defineTool({ ...base, output })).toThrow(
        `Tool test_update: output must not declare '${key}'`,
      );
    },
  );
});

describe("defineTool at call time", () => {
  it("loads the target once and passes it to preview and handler", async () => {
    const preview = vi.fn((_a: unknown, _c: unknown, s: TestServer) => `delete server ${s.id}.`);
    const handler = vi.fn(async (args: { id: number }, ctx: CallContext, server: TestServer) => {
      await ctx.gateway.request("DELETE", path`/servers/${server.id}`, { signal: ctx.signal });
      return { data: { id: args.id }, summary: "Deleted." };
    });
    const harness = await start([deleteTool({ preview, handler })]);
    harness.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("DELETE", "/servers/{id}", noContent());

    const first = await harness.call("test_delete", { id: 42 });
    expect(first.isError).toBe(true);
    expect(harness.fake.requests("GET", "/servers/{id}")).toHaveLength(1);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]?.[2]).toMatchObject({ id: 42, labels: {} });
    expect(handler).not.toHaveBeenCalled();

    const second = await harness.call("test_delete", { id: 42, confirm: true });
    expect(second.isError).toBeFalsy();
    expect(harness.fake.requests("GET", "/servers/{id}")).toHaveLength(2);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[2]).toMatchObject({ id: 42 });
    expect(harness.fake.requests("DELETE", "/servers/{id}")).toHaveLength(1);
  });

  it("checks the scope before asking for confirmation", async () => {
    const preview = vi.fn(() => "delete.");
    const harness = await start([deleteTool({ preview })], {
      labelScope: [{ key: "managed-by", value: "mcp" }],
    });
    harness.fake.on("GET", "/servers/{id}", serverReply({ "managed-by": "someone-else" }));

    for (const confirm of [undefined, true]) {
      const result = await harness.call("test_delete", { id: 42, confirm });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "Resource server 42 is outside the label scope (HETZNER_MCP_LABEL_SCOPE=managed-by=mcp). Only resources carrying these labels may be changed. Nothing was changed.",
      );
    }
    expect(preview).not.toHaveBeenCalled();
    expect(writes(harness)).toEqual([]);
    expect(audit(harness).map((a) => a.outcome)).toEqual(["guard", "guard"]);
  });

  it("returns preview and IaC warnings as confirmation_required", async () => {
    const harness = await start([deleteTool()]);
    harness.fake.on("GET", "/servers/{id}", serverReply({ "managed-by": "terraform" }));

    const result = await harness.call("test_delete", { id: 42 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Confirmation required. This would: delete server 42. Warning: server 42 carries the infrastructure-as-code marker 'managed-by=terraform'; the next terraform/tofu apply may revert or conflict with this change. Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.",
    );
    expect(writes(harness)).toEqual([]);
    expect(audit(harness)[0]).toMatchObject({ outcome: "confirmation_required", confirmed: false });
  });

  it("gives preview a read-only gateway", async () => {
    const harness = await start([
      deleteTool({
        preview: async (args, ctx) => {
          await ctx.gateway.request("GET", path`/servers/${args.id}`, { signal: ctx.signal });
          await ctx.gateway.request("POST", path`/servers/${args.id}/actions/poweroff`);
          return "never.";
        },
      }),
    ]);
    harness.fake.on("GET", "/servers/{id}", serverReply());

    const result = await harness.call("test_delete", { id: 42 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("An unexpected error occurred while talking to Hetzner.");
    expect(harness.fake.requests("GET", "/servers/{id}")).toHaveLength(2); // target + preview GET
    expect(writes(harness)).toEqual([]);
    expect(audit(harness)[0]).toMatchObject({ outcome: "unexpected" });
    expect(logFields(harness.logs, "Unexpected tool failure")).toEqual([
      { tool: "test_delete", error: "preview must not write" },
    ]);
  });

  it("strips undeclared output fields", async () => {
    const harness = await start([
      readTool(async (args) => ({
        data: { id: args.id, extra: "x", root_password: "SENSITIVE-root" } as { id: number },
        summary: "Read.",
      })),
    ]);
    const result = await harness.call("test_get", { id: 7 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: 7 });
    expect(textOf(result)).toBe("Read.");
  });

  it("adds warnings to output and summary of write tools", async () => {
    const update = (harnessLabels: Record<string, string>) => harnessLabels;
    const tool = defineTool({
      name: "test_update",
      title: "Update",
      description: "Updates a test server.",
      kind: "write",
      input: idInput,
      output: idOutput,
      target: loadServer,
      handler: async (args, ctx) => {
        await ctx.gateway.request("PUT", path`/servers/${args.id}`, {
          body: {},
          signal: ctx.signal,
        });
        return { data: { id: args.id }, summary: `Updated server ${args.id}.` };
      },
    });
    const harness = await start([tool]);
    harness.fake
      .on("GET", "/servers/{id}", [serverReply(update({ managed_by: "terraform" })), serverReply()])
      .on("PUT", "/servers/{id}", serverReply());

    const warned = await harness.call("test_update", { id: 42 });
    const warning =
      "Warning: server 42 carries the infrastructure-as-code marker 'managed_by=terraform'; the next terraform/tofu apply may revert or conflict with this change.";
    expect(warned.structuredContent).toEqual({ id: 42, warnings: [warning] });
    expect(textOf(warned)).toBe(`${warning}\nUpdated server 42.`);

    const clean = await harness.call("test_update", { id: 42 });
    expect(clean.structuredContent).toEqual({ id: 42 });
    expect(textOf(clean)).toBe("Updated server 42.");
  });

  it("waits for actions by default and reports progress", async () => {
    const harness = await start([powerTool()]);
    harness.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/poweron", ok({ action: action(7, "running", 0) }, 201))
      .on("GET", "/actions", [
        ok({ actions: [action(7, "running", 50)] }),
        ok({ actions: [action(7, "success")] }),
      ]);
    const progress: number[] = [];

    const result = await harness.call(
      "test_power_on",
      { id: 42 },
      { onprogress: (p) => progress.push(p.progress) },
    );
    expect(result.isError).toBeFalsy();
    expect(progress).toEqual([0, 50, 100]);
    const out = result.structuredContent as { actions: { id: number; status: string }[] };
    expect(out.actions).toMatchObject([{ id: 7, status: "success", progress: 100 }]);
    expect(textOf(result)).toBe(
      "Requested power on for server 42. Final action status is in 'actions'.",
    );
    expect(harness.fake.requests("GET", "/actions")[0]?.query.getAll("id")).toEqual(["7"]);
    expect(audit(harness)[0]).toMatchObject({ actions: [7], pending: 0 });
  });

  it("skips waiting with wait=false", async () => {
    const harness = await start([powerTool()]);
    harness.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/poweron", ok({ action: action(7, "running", 10) }, 201));

    const result = await harness.call("test_power_on", { id: 42, wait: false });
    expect(result.isError).toBeFalsy();
    expect(harness.fake.requests("GET", "/actions")).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({ actions: [{ id: 7, status: "running" }] });
    expect(audit(harness)[0]).toMatchObject({ actions: [7], pending: 1 });
  });

  it("reports still-running actions without error", async () => {
    const harness = await start([powerTool()], { actionWaitMs: 3000 });
    harness.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/poweron", ok({ action: action(7, "running", 0) }, 201))
      .on("GET", "/actions", ok({ actions: [action(7, "running", 30)] }));

    const result = await harness.call("test_power_on", { id: 42 });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(
      "Requested power on for server 42. Final action status is in 'actions'. Still running after 3 s; follow up with action_get.",
    );
    expect(result.structuredContent).toMatchObject({
      actions: [{ status: "running", progress: 30 }],
    });
    expect(audit(harness)[0]).toMatchObject({ outcome: "ok", pending: 1 });
  });

  it("turns failed actions into action_failed", async () => {
    const harness = await start([powerTool()]);
    harness.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/poweron", ok({ action: action(7, "running", 0) }, 201))
      .on("GET", "/actions", ok({ actions: [action(7, "error")] }));

    const result = await harness.call("test_power_on", { id: 42 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Hetzner action 7 (test_command) failed: action_failed: Action failed",
    );
    expect(audit(harness)[0]).toMatchObject({ outcome: "action_failed", actions: [7], pending: 0 });
  });

  it("fails when an action tool returns no actions", async () => {
    const harness = await start([
      powerTool({ handler: async (args) => ({ data: { id: args.id }, summary: "x" }) }),
    ]);
    harness.fake.on("GET", "/servers/{id}", serverReply());
    const result = await harness.call("test_power_on", { id: 42 });
    expect(textOf(result)).toBe("An unexpected error occurred while talking to Hetzner.");
    expect(logFields(harness.logs, "Unexpected tool failure")[0]).toEqual({
      tool: "test_power_on",
      error: "Tool test_power_on: actions missing",
    });
  });

  it("writes one audit line with targets, confirmed and actions", async () => {
    const tool = defineTool({
      name: "test_rebuild",
      title: "Rebuild",
      description: "Rebuilds a test server.",
      kind: "destructive",
      input: idInput.extend({ image: z.string().describe("Image name.") }),
      output: idOutput,
      target: loadServer,
      actions: true,
      preview: (args) => `rebuild server ${args.id}.`,
      handler: async (args, ctx) => {
        const body = await ctx.gateway.request<{ action: HetznerAction }>(
          "POST",
          path`/servers/${args.id}/actions/rebuild`,
          { body: { image: args.image }, signal: ctx.signal },
        );
        return { data: { id: args.id }, summary: "Requested rebuild.", actions: [body.action] };
      },
    });
    const harness = await start([
      tool,
      readTool(async (a) => ({ data: { id: a.id }, summary: "x" })),
    ]);
    harness.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/rebuild", ok({ action: action(9, "success") }, 201));

    await harness.call("test_rebuild", { id: 42, image: "image-arg-marker", confirm: true });
    await harness.call("test_get", { id: 5 });

    const lines = audit(harness);
    expect(lines).toHaveLength(2);
    expect(Object.keys(lines[0] ?? {})).toEqual([
      "tool",
      "project",
      "outcome",
      "targets",
      "confirmed",
      "actions",
      "pending",
      "durationMs",
    ]);
    expect(lines[0]).toMatchObject({
      tool: "test_rebuild",
      project: "test",
      outcome: "ok",
      targets: ["server:42"],
      confirmed: true,
      actions: [9],
      pending: 0,
    });
    expect(typeof lines[0]?.durationMs).toBe("number");
    expect(Object.keys(lines[1] ?? {})).toEqual(["tool", "project", "outcome", "durationMs"]);
    const auditText = harness.logs.filter((l) => l.includes(" tool_call ")).join("\n");
    expect(auditText).not.toContain("image-arg-marker");
    expect(auditText).not.toContain("web-");
  });

  it("logs unexpected failures without stack or values", async () => {
    const harness = await start([
      readTool(async (args) => {
        if (args.id === 1) throw new Error("boom");
        return { data: { id: "SENSITIVE-value" } as unknown as { id: number }, summary: "x" };
      }),
    ]);

    const thrown = await harness.call("test_get", { id: 1 });
    expect(thrown.isError).toBe(true);
    expect(textOf(thrown)).toBe("An unexpected error occurred while talking to Hetzner.");
    const mismatch = await harness.call("test_get", { id: 2 });
    expect(textOf(mismatch)).toBe("An unexpected error occurred while talking to Hetzner.");

    expect(logFields(harness.logs, "Unexpected tool failure")).toEqual([
      { tool: "test_get", error: "boom" },
      { tool: "test_get", error: "schema mismatch", issues: ["id: invalid_type"] },
    ]);
    expect(harness.logs.join("\n")).not.toMatch(/\n\s+at |Error: boom/);
    expect(audit(harness).map((a) => a.outcome)).toEqual(["unexpected", "unexpected"]);
  });

  it("forwards client cancellation to the gateway", async () => {
    const harness = await start([powerTool()]);
    harness.fake.on("GET", "/servers/{id}", () => new Promise(() => {})); // hangs
    const controller = new AbortController();

    const pending = harness.call("test_power_on", { id: 42 }, { signal: controller.signal });
    await vi.waitFor(() => expect(harness.fake.calls).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(audit(harness)).toHaveLength(1));
    expect(audit(harness)[0]).toMatchObject({ tool: "test_power_on", outcome: "cancelled" });
    expect(writes(harness)).toEqual([]);
  });

  it("asks cost tools for confirmation without destructiveHint", async () => {
    const preview = vi.fn(() => "create a server.");
    const definition = costTool({ preview });
    expect(definition).toMatchObject({ kind: "write", confirms: true, costs: true });
    const harness = await start([definition]);
    harness.fake.on("POST", "/servers", ok({ server: { id: 99 } }, 201));

    const { tools } = await harness.client.listTools();
    const listed = tools.find((t) => t.name === "test_create");
    expect(listed?.annotations).toEqual({
      title: "Create test server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(Object.keys(listed?.inputSchema.properties ?? {})).toContain("confirm");
    expect(listed?.inputSchema.required ?? []).not.toContain("confirm");

    const result = await harness.call("test_create", { name: "web" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Confirmation required. This would: create a server. Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.",
    );
    expect(harness.fake.calls).toEqual([]);
    expect(audit(harness)[0]).toEqual({
      tool: "test_create",
      project: "test",
      outcome: "confirmation_required",
      confirmed: false,
      durationMs: expect.any(Number),
    });

    const confirmed = await harness.call("test_create", { name: "web", confirm: true });
    expect(confirmed.structuredContent).toEqual({ id: 99 });
    expect(audit(harness)[1]).toMatchObject({ outcome: "ok", confirmed: true });
  });

  it("runs cross-field checks in target before any request", async () => {
    const preview = vi.fn(() => "create a server.");
    const harness = await start([
      costTool({
        preview,
        target: async (args) => {
          if (args.name === undefined && args.labels === undefined) {
            throw new ToolError("bad_request", "Provide at least one of 'name' or 'labels'.");
          }
          return { value: undefined, resources: [] };
        },
      }),
    ]);

    const rejected = await harness.call("test_create", { confirm: true });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toBe("Provide at least one of 'name' or 'labels'.");
    expect(harness.fake.calls).toEqual([]);
    expect(preview).not.toHaveBeenCalled();
    // 6.7: targets and confirmed are only set once target() returned.
    expect(Object.keys(audit(harness)[0] ?? {})).toEqual([
      "tool",
      "project",
      "outcome",
      "durationMs",
    ]);
    expect(audit(harness)[0]).toMatchObject({ outcome: "bad_request" });

    const passed = await harness.call("test_create", { name: "web" });
    expect(textOf(passed)).toMatch(/^Confirmation required/);
    expect(audit(harness)[1]).toMatchObject({ targets: [], confirmed: false });
  });

  it("rejects calls above the cost limit before confirmation, even with confirm: true", async () => {
    const preview = vi.fn(() => "create a server.");
    const monthlyCost = vi.fn(async () => okCost("3.00"));
    const harness = await start([costTool({ preview, monthlyCost })], { maxMonthlyCost: "2.00" });

    for (const args of [{ name: "web" }, { name: "web", confirm: true }]) {
      const result = await harness.call("test_create", args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "Cost limit exceeded: this call adds an estimated 3.00 EUR/month net, above HETZNER_MCP_MAX_MONTHLY_COST=2.00. Nothing was changed. Tell the user; only the operator can raise the limit.",
      );
    }
    expect(monthlyCost).toHaveBeenCalledTimes(2);
    expect(preview).not.toHaveBeenCalled();
    expect(writes(harness)).toEqual([]);
    expect(audit(harness).map((a) => a.outcome)).toEqual(["guard", "guard"]);
  });

  it("fails closed when the cost cannot be determined", async () => {
    const cases: [MonthlyCost, RegExp][] = [
      [{ kind: "unavailable" }, /^Cost limit check failed: Hetzner pricing could not be loaded/],
      [{ kind: "unknown" }, /^Cost limit check failed: Hetzner lists no price for a part/],
    ];
    for (const [cost, text] of cases) {
      const tool = costTool({ monthlyCost: async () => cost });
      const limited = await start([tool], { maxMonthlyCost: "2.00" });
      const rejected = await limited.call("test_create", { name: "web", confirm: true });
      expect(textOf(rejected)).toMatch(text);
      expect(audit(limited)[0]).toMatchObject({ outcome: "guard" });
      expect(writes(limited)).toEqual([]);
      await limited.close();

      const unlimited = await start([tool]);
      const asked = await unlimited.call("test_create", { name: "web" });
      expect(textOf(asked)).toMatch(/^Confirmation required/);
      expect(audit(unlimited)[0]).toMatchObject({ outcome: "confirmation_required" });
      await unlimited.close();
      h = undefined;
    }
  });

  it("skips the cost check without a limit", async () => {
    const monthlyCost = vi.fn(async (_args: unknown, ctx: CallContext) => {
      await ctx.gateway.getPricing({ signal: ctx.signal });
      return okCost("3.00");
    });
    const harness = await start([costTool({ monthlyCost })], { maxMonthlyCost: undefined });
    harness.fake.on("POST", "/servers", ok({ server: { id: 99 } }, 201));

    const result = await harness.call("test_create", { name: "web", confirm: true });
    expect(result.structuredContent).toEqual({ id: 99 });
    expect(monthlyCost).not.toHaveBeenCalled();
    expect(harness.fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /servers"]);
  });

  it("applies the cost limit also when confirmation is disabled", async () => {
    const harness = await start([costTool({ monthlyCost: async () => okCost("3.00") })], {
      maxMonthlyCost: "2.00",
      requireConfirmation: false,
    });
    const result = await harness.call("test_create", { name: "web" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Cost limit exceeded: this call adds an estimated 3\.00 EUR/);
    expect(audit(harness)[0]).toMatchObject({ outcome: "guard" });
    expect(writes(harness)).toEqual([]);
  });

  it("maps Hetzner errors of the handler to isError", async () => {
    const harness = await start([deleteTool()]);
    harness.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("DELETE", "/servers/{id}", apiError(423, "protected", "server is protected"));
    const result = await harness.call("test_delete", { id: 42, confirm: true });
    expect(result.isError).toBe(true);
    expect(audit(harness)[0]).toMatchObject({ outcome: "protected" });
  });

  it("skips the preview when confirmation is disabled", async () => {
    const preview = vi.fn(() => "delete.");
    const harness = await start([deleteTool({ preview })], { requireConfirmation: false });
    harness.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("DELETE", "/servers/{id}", noContent());
    const result = await harness.call("test_delete", { id: 42 });
    expect(result.isError).toBeFalsy();
    expect(preview).not.toHaveBeenCalled();
    expect(audit(harness)[0]).toMatchObject({ outcome: "ok", confirmed: false });
  });
});

describe("shared helpers", () => {
  it("quotes names for previews", () => {
    expect(quoteName("web-1")).toBe('"web-1"');
    expect(quoteName('a\n"b"\u0007')).toBe('"a\\"b\\""');
    expect(quoteName("a\u0085b\u2028c\u202ed\u2066e")).toBe('"abcde"');
    const long = quoteName("x".repeat(100));
    expect(JSON.parse(long)).toBe(`${"x".repeat(63)}…`);
    expect([...JSON.parse(quoteName("ä".repeat(64)))]).toHaveLength(64);
  });

  it("validates hostnames", () => {
    expect(HOSTNAME_RE.test("web-1.example.com")).toBe(true);
    expect(HOSTNAME_RE.test("-web")).toBe(false);
    expect(HOSTNAME_RE.test("web_1")).toBe(false);
    expect(HOSTNAME_RE.test("a".repeat(64))).toBe(false);
  });

  it("builds pages", () => {
    const schema = pageOf(z.object({ id: z.number() }));
    const page = toPage(
      { items: [{ id: 1, name: "x" }], page: 1, per_page: 25, next_page: null, total_entries: 1 },
      (raw) => ({ id: raw.id }),
    );
    expect(schema.parse(page)).toEqual({
      items: [{ id: 1 }],
      page: 1,
      per_page: 25,
      next_page: null,
      total_entries: 1,
    });
  });
});
