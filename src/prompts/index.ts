import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../tools/shared.js";

/** Registers MCP prompts. Empty in phase 0/1; prompts are always registered, also read-only (01 §8.2). */
export function registerPrompts(_server: McpServer, _ctx: ToolContext): void {}
