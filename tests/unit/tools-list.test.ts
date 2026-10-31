import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLSETS } from "../../src/tools/index.js";
import { defineTool, type ToolDefinition } from "../../src/tools/shared.js";
import { type Harness, startHarness, stubToolset } from "../helpers/harness.js";

// Every expectation is derived from TOOLSETS and ToolDefinition; no tool name is hard-coded.

type Schema = {
  properties?: Record<string, JsonSchema>;
  required?: string[];
};
type JsonSchema = Record<string, unknown> & Schema;

const registered = (): ToolDefinition[] => Object.values(TOOLSETS).flat();

const idInput = z.object({ id: z.number().int().describe("ID of the thing.") });
const out = z.object({ id: z.number().int().describe("ID of the thing.") });
const handler = async () => ({ data: { id: 1 }, summary: "ok" });

/** One tool per kind/flag combination, so the checks bite even while the real toolsets are empty. */
const stubTools: ToolDefinition[] = [
  defineTool({
    name: "stub_read",
    title: "Stub read",
    description: "Read stub.",
    kind: "read",
    input: idInput,
    output: out,
    handler,
  }),
  defineTool({
    name: "stub_create",
    title: "Stub create",
    description: "Create stub.",
    kind: "write",
    creates: true,
    input: idInput,
    output: out,
    handler,
  }),
  defineTool({
    name: "stub_costly",
    title: "Stub costly",
    description: "Cost stub.",
    kind: "write",
    creates: true,
    costs: true,
    actions: true,
    input: idInput,
    output: out,
    preview: () => "preview",
    handler: async () => ({ data: { id: 1 }, summary: "ok", actions: [] }),
  }),
  defineTool({
    name: "stub_delete",
    title: "Stub delete",
    description: "Delete stub.",
    kind: "destructive",
    creates: true,
    input: idInput,
    output: out,
    preview: () => "preview",
    handler,
  }),
];

let h: Harness | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  restore?.();
  restore = undefined;
});

/** Runs each check against the real registry and against the registry filled with stub tools. */
describe.each([
  ["registry as built", false],
  ["registry with stub tools", true],
] as const)("tools/list (%s)", (_label, stubbed) => {
  const start = async (overrides = {}) => {
    if (stubbed) restore = stubToolset("storage", stubTools);
    h = await startHarness(overrides);
    return (await h.client.listTools()).tools;
  };

  it("publishes exactly the registered tools", async () => {
    const tools = await start();
    expect(tools.map((t) => t.name)).toEqual(registered().map((t) => t.name));
    if (stubbed) expect(tools.length).toBeGreaterThan(0);
  });

  it("publishes title, description and outputSchema for every tool", async () => {
    for (const tool of await start()) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("describes every input field", async () => {
    for (const tool of await start()) {
      const props = (tool.inputSchema as Schema).properties ?? {};
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field} needs a description`).toBeTruthy();
      }
    }
  });

  it("derives annotations from kind", async () => {
    const tools = await start();
    const byName = new Map(registered().map((d) => [d.name, d]));
    for (const tool of tools) {
      const def = byName.get(tool.name);
      expect(def, tool.name).toBeDefined();
      const a = tool.annotations;
      expect(a?.readOnlyHint, tool.name).toBe(def?.kind === "read");
      expect(a?.destructiveHint, tool.name).toBe(def?.kind === "destructive");
      expect(a?.idempotentHint, tool.name).toBeTypeOf("boolean");
      if (def?.kind === "read" || def?.kind === "destructive") {
        expect(a?.idempotentHint, tool.name).toBe(true);
      }
      expect(a?.openWorldHint, tool.name).toBe(true);
    }
  });

  it("adds confirm only to tools that need confirmation and wait only to action tools", async () => {
    const tools = await start();
    const byName = new Map(registered().map((d) => [d.name, d]));
    for (const tool of tools) {
      const def = byName.get(tool.name);
      const schema = tool.inputSchema as Schema;
      expect(Object.hasOwn(schema.properties ?? {}, "confirm"), `${tool.name} confirm`).toBe(
        def?.confirms,
      );
      expect(Object.hasOwn(schema.properties ?? {}, "wait"), `${tool.name} wait`).toBe(
        def?.actions,
      );
      expect(schema.required ?? [], tool.name).not.toContain("confirm");
      expect(schema.required ?? [], tool.name).not.toContain("wait");
    }
  });

  it("uses closed output schemas only", async () => {
    for (const tool of await start()) {
      const open = findOpenSchemas(tool.outputSchema, "outputSchema");
      expect(open, tool.name).toEqual([]);
    }
  });

  it("hides write tools in read-only mode", async () => {
    const tools = await start({ readOnly: true });
    const defs = registered();
    expect(tools.map((t) => t.name)).toEqual(
      defs.filter((d) => d.kind === "read").map((d) => d.name),
    );
    for (const def of defs.filter((d) => d.kind !== "read")) {
      await expect(h?.call(def.name, {})).rejects.toThrow(/not found/i);
    }
  });

  it("hides cost tools when costs are not allowed", async () => {
    const tools = await start({ allowCosts: false });
    const defs = registered();
    expect(tools.map((t) => t.name)).toEqual(defs.filter((d) => !d.costs).map((d) => d.name));
    for (const def of defs.filter((d) => d.costs)) {
      await expect(h?.call(def.name, {})).rejects.toThrow(/not found/i);
    }
  });
});

describe("tools/list without registered tools", () => {
  it("rejects an unknown tool as a protocol error", async () => {
    h = await startHarness();
    await expect(h.call("no_such_tool", {})).rejects.toThrow(/not found/i);
  });

  it("states the instructions of the server", async () => {
    h = await startHarness();
    const instructions = h.client.getInstructions();
    expect(instructions).toContain("Hetzner Cloud project");
    expect(instructions).toContain("confirm: true");
    expect(instructions).toContain("Root passwords are never returned");
  });
});

/** JSON-Schema paths that are open: additionalProperties true, an empty schema, or a typed-free record. */
function findOpenSchemas(schema: unknown, at: string): string[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => findOpenSchemas(s, `${at}[${i}]`));
  if (typeof schema !== "object" || schema === null) return [];
  const s = schema as Record<string, unknown>;
  const found: string[] = [];
  const ap = s.additionalProperties;
  if (ap === true) found.push(`${at}.additionalProperties: true`);
  if (typeof ap === "object" && ap !== null) {
    const record = ap as Record<string, unknown>;
    if (Object.keys(record).length === 0) found.push(`${at}.additionalProperties: {}`);
    else if (record.type !== "string") found.push(`${at}.additionalProperties: not type string`);
  }
  for (const [key, value] of Object.entries(s)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const [prop, child] of Object.entries(value)) {
        if (typeof child === "object" && child !== null && Object.keys(child).length === 0) {
          found.push(`${at}.properties.${prop}: {}`);
        }
        found.push(...findOpenSchemas(child, `${at}.properties.${prop}`));
      }
    } else if (key !== "additionalProperties") {
      found.push(...findOpenSchemas(value, `${at}.${key}`));
    }
  }
  return found;
}
