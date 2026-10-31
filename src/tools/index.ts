import type { McpServer } from "@modelcontextprotocol/server";
import type { Config, ToolsetName } from "../config.js";
import { actionTools } from "./actions.js";
import { catalogTools } from "./catalog.js";
import { firewallTools } from "./firewalls.js";
import { serverTools } from "./servers.js";
import type { ToolContext, ToolDefinition } from "./shared.js";
import { sshKeyTools } from "./ssh-keys.js";
import { storageTools } from "./storage.js";

/** Every toolset and its tools. A new tool only needs to be added to its domain file. */
export const TOOLSETS: Record<ToolsetName, readonly ToolDefinition[]> = {
  core: serverTools,
  info: catalogTools,
  actions: actionTools,
  ssh_keys: sshKeyTools,
  firewalls: firewallTools,
  storage: storageTools,
};

/**
 * Tools enabled by config: selected toolsets, minus write tools in read-only mode, minus cost tools
 * when allowCosts is false (01 §8.2, 05 K-27). Order = key order of TOOLSETS.
 */
export function selectTools(
  config: Pick<Config, "toolsets" | "readOnly" | "allowCosts">,
): ToolDefinition[] {
  return Object.entries(TOOLSETS)
    .filter(([name]) => config.toolsets.has(name as ToolsetName))
    .flatMap(([, tools]) => tools)
    .filter((tool) => !config.readOnly || tool.kind === "read")
    .filter((tool) => config.allowCosts || !tool.costs);
}

/** Registration must not call the gateway (the docs generator passes a stub that throws). */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of selectTools(ctx.config)) {
    tool.register(server, ctx);
  }
}
