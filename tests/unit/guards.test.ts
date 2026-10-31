import { describe, expect, it } from "vitest";
import type { IacPolicy } from "../../src/config.js";
import {
  assertMutable,
  assertPathSegment,
  assertSelectorInScope,
  type GuardedResource,
  hasControlChars,
  keepScopeLabels,
  requireConfirmation,
  withScopeLabels,
} from "../../src/guards.js";
import { ToolError } from "../../src/hetzner/errors.js";

const scope = [
  { key: "managed-by", value: "mcp" },
  { key: "env", value: "x" },
];
const markers = [
  { key: "managed-by", value: "terraform" },
  { key: "managed_by", value: "terraform" },
];
const policy = (iacPolicy: IacPolicy, labelScope = scope) => ({
  labelScope,
  iacPolicy,
  iacMarkers: markers,
});
const server = (labels: Record<string, string>, id = 42): GuardedResource => ({
  type: "server",
  id,
  labels,
});

function guardError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
  throw new Error("expected a ToolError");
}

describe("assertMutable", () => {
  it("assertMutable rejects resources outside the scope", () => {
    const inScope = server({ "managed-by": "mcp", env: "x" }, 1);
    const outside = server({ "managed-by": "mcp", env: "y" }, 2);
    const error = guardError(() => assertMutable(policy("warn"), [inScope, outside]));
    expect(error.kind).toBe("guard");
    expect(error.message).toBe(
      "Resource server 2 is outside the label scope (HETZNER_MCP_LABEL_SCOPE=managed-by=mcp,env=x). Only resources carrying these labels may be changed. Nothing was changed.",
    );
  });

  it("assertMutable passes with empty scope", () => {
    expect(assertMutable(policy("warn", []), [server({})])).toEqual([]);
    expect(assertMutable(policy("block", []), [])).toEqual([]);
  });

  it.each([
    ["off", "managed-by"],
    ["off", "managed_by"],
    ["warn", "managed-by"],
    ["warn", "managed_by"],
    ["block", "managed-by"],
    ["block", "managed_by"],
  ] as const)(
    "assertMutable warns, blocks or ignores IaC markers by policy (%s, %s)",
    (iacPolicy, key) => {
      const config = policy(iacPolicy, []);
      const resources = [server({ [key]: "terraform" })];
      if (iacPolicy === "off") {
        expect(assertMutable(config, resources)).toEqual([]);
      } else if (iacPolicy === "warn") {
        expect(assertMutable(config, resources)).toEqual([
          `Warning: server 42 carries the infrastructure-as-code marker '${key}=terraform'; the next terraform/tofu apply may revert or conflict with this change.`,
        ]);
      } else {
        const error = guardError(() => assertMutable(config, resources));
        expect(error.kind).toBe("guard");
        expect(error.message).toBe(
          `Server 42 carries the infrastructure-as-code marker '${key}=terraform'. Changes are blocked (HETZNER_MCP_IAC_POLICY=block); change it in the infrastructure code instead. Nothing was changed.`,
        );
      }
    },
  );

  it("names resource types in the block text with display names", () => {
    const config = policy("block", []);
    const key: GuardedResource = { type: "ssh_key", id: 5, labels: { "managed-by": "terraform" } };
    expect(guardError(() => assertMutable(config, [key])).message).toMatch(/^SSH key 5 carries /);
    expect(assertMutable(policy("warn", []), [key])[0]).toMatch(/^Warning: ssh_key 5 carries /);
  });

  it("checks the scope before IaC markers", () => {
    const error = guardError(() =>
      assertMutable(policy("block"), [server({ "managed-by": "terraform" })]),
    );
    expect(error.message).toMatch(/outside the label scope/);
  });
});

describe("scope labels", () => {
  it("withScopeLabels adds scope labels and rejects conflicting values", () => {
    expect(withScopeLabels({ labelScope: scope })).toEqual({ "managed-by": "mcp", env: "x" });
    expect(withScopeLabels({ labelScope: scope }, { app: "web", env: "x" })).toEqual({
      app: "web",
      env: "x",
      "managed-by": "mcp",
    });
    expect(withScopeLabels({ labelScope: [] }, { app: "web" })).toEqual({ app: "web" });
    const error = guardError(() => withScopeLabels({ labelScope: scope }, { env: "prod" }));
    expect(error.kind).toBe("guard");
    expect(error.message).toBe(
      "Label 'env' is reserved by HETZNER_MCP_LABEL_SCOPE and must be 'x'. Remove it from the labels or use that value.",
    );
  });

  it("keepScopeLabels re-adds missing scope labels", () => {
    expect(keepScopeLabels({ labelScope: scope }, { app: "web" })).toEqual({
      app: "web",
      "managed-by": "mcp",
      env: "x",
    });
    expect(keepScopeLabels({ labelScope: scope }, {})).toEqual({ "managed-by": "mcp", env: "x" });
    expect(() => keepScopeLabels({ labelScope: scope }, { "managed-by": "other" })).toThrow(
      ToolError,
    );
  });

  it("assertSelectorInScope requires every scope term", () => {
    const config = { labelScope: [{ key: "managed-by", value: "mcp" }] };
    expect(() => assertSelectorInScope(config, "managed-by=mcp,env=x")).not.toThrow();
    expect(() => assertSelectorInScope(config, "managed-by==mcp")).not.toThrow();
    expect(() => assertSelectorInScope(config, "env in (a,b), managed-by = mcp")).not.toThrow();
    const error = guardError(() => assertSelectorInScope(config, "env=x"));
    expect(error.kind).toBe("guard");
    expect(error.message).toBe(
      "In label-scope mode a label selector must contain every scope term (managed-by=mcp) as its own term, so it cannot reach resources outside the scope.",
    );
    expect(() => assertSelectorInScope(config, "managed-by!=mcp")).toThrow(ToolError);
    expect(() => assertSelectorInScope(config, "managed-by in (mcp,other)")).toThrow(ToolError);
    expect(() => assertSelectorInScope(config, "managed-by=mcpx")).toThrow(ToolError);
    expect(() => assertSelectorInScope({ labelScope: [] }, "anything")).not.toThrow();
    expect(() => assertSelectorInScope({ labelScope: scope }, "managed-by=mcp")).toThrow(ToolError);
  });
});

describe("requireConfirmation", () => {
  it("requireConfirmation includes preview and warnings", () => {
    const error = guardError(() =>
      requireConfirmation({ requireConfirmation: true }, undefined, "delete server 42.", [
        "Warning: a.",
        "Warning: b.",
      ]),
    );
    expect(error.kind).toBe("confirmation_required");
    expect(error.message).toBe(
      "Confirmation required. This would: delete server 42. Warning: a. Warning: b. Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.",
    );
    expect(
      guardError(() => requireConfirmation({ requireConfirmation: true }, false, "x.")).message,
    ).toBe(
      "Confirmation required. This would: x. Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.",
    );
  });

  it("passes when confirmed or when confirmation is disabled", () => {
    expect(() => requireConfirmation({ requireConfirmation: true }, true, "x")).not.toThrow();
    expect(() => requireConfirmation({ requireConfirmation: false }, undefined, "x")).not.toThrow();
  });
});

describe("assertPathSegment", () => {
  it.each([
    "",
    ".",
    "..",
    "a/b",
    "a\\b",
    "../x",
    "a\nb",
    "a\u0000b",
    "a\u007fb",
    "a\u202eb",
    "a\u2028b",
    "x".repeat(256),
  ])("assertPathSegment rejects traversal and control characters: %j", (value) => {
    const error = guardError(() => assertPathSegment(value, "name"));
    expect(error.kind).toBe("guard");
    expect(error.message).toBe(
      "Invalid name: must be non-empty and must not contain '/', '\\', '..' or control characters.",
    );
  });

  it.each(["web-1", "my key", "a.b", "x".repeat(255)])("accepts %j", (value) => {
    expect(() => assertPathSegment(value)).not.toThrow();
  });

  it("detects control characters", () => {
    expect(hasControlChars("a\tb")).toBe(true);
    expect(hasControlChars("a\u007f")).toBe(true);
    expect(hasControlChars("äöü …")).toBe(false);
    for (const ch of ["\u0085", "\u2028", "\u2029", "\u200e", "\u202e", "\u2066", "\u2069"]) {
      expect(hasControlChars(`a${ch}b`)).toBe(true);
    }
    expect(hasControlChars("a\u00a0b")).toBe(false);
  });
});
