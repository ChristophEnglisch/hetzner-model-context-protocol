import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../tools/shared.js";
import { registerInventoryResource } from "./inventory.js";
import { registerPricingResource } from "./pricing.js";
import { registerServerResource } from "./servers.js";

/** Registers MCP resources. Always registered, independent of HETZNER_MCP_TOOLSETS (01 §8.2, 03 §6.1). */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  registerInventoryResource(server, ctx);
  registerServerResource(server, ctx);
  registerPricingResource(server, ctx);
}
