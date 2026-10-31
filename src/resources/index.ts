import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../tools/shared.js";

/** Registers MCP resources. Empty in phase 0/1; independent of HETZNER_MCP_TOOLSETS (01 §8.2). */
export function registerResources(_server: McpServer, _ctx: ToolContext): void {}
