import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../tools/shared.js";
import { registerAuditProjectSecurity } from "./audit-project-security.js";
import { registerProvisionWebServer } from "./provision-web-server.js";
import { registerReviewCosts } from "./review-costs.js";

/** Registers MCP prompts. Always registered, also read-only; the guards act at prompts/get (05 K-20). */
export function registerPrompts(server: McpServer, ctx: ToolContext): void {
  registerAuditProjectSecurity(server, ctx);
  registerReviewCosts(server, ctx);
  registerProvisionWebServer(server, ctx);
}
