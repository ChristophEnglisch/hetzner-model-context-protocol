import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_TOOLSETS, TOOLSET_NAMES } from "../../src/config.js";
import { selectTools, TOOLSETS } from "../../src/tools/index.js";
import { defineTool, TOOL_NAME, type ToolDefinition } from "../../src/tools/shared.js";
import { makeConfig } from "../helpers/fakes.js";
import { stubToolset } from "../helpers/harness.js";

// All expectations are derived from TOOLSETS; nothing here names a concrete tool (INV§7 point 1).

const all = Object.values(TOOLSETS).flat();
const names = (config = makeConfig()) => selectTools(config).map((t) => t.name);

const empty = z.object({});
const stubTools = [
  defineTool({
    name: "stub_read",
    title: "Stub read",
    description: "Read stub.",
    kind: "read",
    input: empty,
    output: empty,
    handler: async () => ({ data: {}, summary: "ok" }),
  }),
  defineTool({
    name: "stub_write",
    title: "Stub write",
    description: "Write stub.",
    kind: "write",
    creates: true,
    input: empty,
    output: empty,
    handler: async () => ({ data: {}, summary: "ok" }),
  }),
  defineTool({
    name: "stub_costly",
    title: "Stub costly",
    description: "Cost stub.",
    kind: "write",
    creates: true,
    costs: true,
    input: empty,
    output: empty,
    preview: () => "preview",
    monthlyCost: async () => ({ kind: "unknown" }),
    handler: async () => ({ data: {}, summary: "ok" }),
  }),
  defineTool({
    name: "stub_destructive",
    title: "Stub destructive",
    description: "Destructive stub.",
    kind: "destructive",
    creates: true,
    input: empty,
    output: empty,
    preview: () => "preview",
    handler: async () => ({ data: {}, summary: "ok" }),
  }),
];

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("toolset registry", () => {
  it("wires exactly the six toolsets", () => {
    expect(Object.keys(TOOLSETS)).toEqual([...TOOLSET_NAMES]);
  });

  it("enables the default toolsets", () => {
    const expected = DEFAULT_TOOLSETS.flatMap((name) => TOOLSETS[name]);
    expect(selectTools(makeConfig({ toolsets: new Set(DEFAULT_TOOLSETS) }))).toEqual(expected);
  });

  it("selects toolsets in registry order, not in configuration order", () => {
    const config = makeConfig({ toolsets: new Set(["storage", "core"]) });
    expect(selectTools(config)).toEqual([...TOOLSETS.core, ...TOOLSETS.storage]);
  });

  it("registers only read tools in read-only mode", () => {
    const selected = selectTools(makeConfig({ readOnly: true }));
    for (const tool of selected) expect(tool.kind).toBe("read");
    expect(selected).toHaveLength(all.filter((t) => t.kind === "read").length);
  });

  it("has unique tool names matching TOOL_NAME", () => {
    const list = all.map((t) => t.name);
    expect(new Set(list).size).toBe(list.length);
    for (const name of list) expect(name).toMatch(TOOL_NAME);
  });

  it("keeps the default tool count small", () => {
    // 01 §9.3 T-R5: guard rail from the brief; 21 in 1.0 (core 10, info 4, actions 2, ssh_keys 5).
    const defaults = DEFAULT_TOOLSETS.flatMap((name) => TOOLSETS[name]);
    expect(defaults.length).toBeLessThanOrEqual(22);
  });

  it("hides cost tools when costs are not allowed", () => {
    const costly = all.filter((t) => t.costs);
    const config = makeConfig({ allowCosts: false });
    const selected = selectTools(config);
    expect(selected.some((t) => t.costs)).toBe(false);
    expect(selected).toHaveLength(all.length - costly.length);
    for (const tool of all.filter((t) => !t.costs)) expect(selected).toContain(tool);
    const readOnly = selectTools(makeConfig({ allowCosts: false, readOnly: true }));
    expect(readOnly).toEqual(selectTools(makeConfig({ readOnly: true })));
    for (const tool of readOnly) expect(tool.kind).toBe("read");
  });

  describe("with a filled registry (stub tools in the storage toolset)", () => {
    const fill = (): ToolDefinition[] => {
      restore = stubToolset("storage", stubTools);
      return [...stubTools];
    };

    it("filters by toolset, read-only mode and allowCosts", () => {
      fill();
      expect(names(makeConfig({ toolsets: new Set(["storage"]) }))).toEqual([
        "stub_read",
        "stub_write",
        "stub_costly",
        "stub_destructive",
      ]);
      expect(names(makeConfig({ toolsets: new Set(["storage"]), readOnly: true }))).toEqual([
        "stub_read",
      ]);
      expect(names(makeConfig({ toolsets: new Set(["storage"]), allowCosts: false }))).toEqual([
        "stub_read",
        "stub_write",
        "stub_destructive",
      ]);
      expect(names(makeConfig({ toolsets: new Set(["core"]) }))).not.toContain("stub_read");
    });

    it("keeps the cost filter independent of the toolset selection", () => {
      fill();
      const config = makeConfig({ allowCosts: false });
      expect(selectTools(config).some((t) => t.costs)).toBe(false);
      expect(selectTools(makeConfig())).toContain(stubTools[2]);
    });
  });
});
