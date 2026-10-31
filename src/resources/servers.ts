// hetzner://servers/{id} (03 §6.3): exactly the server_get projection.

import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { path } from "../hetzner/gateway.js";
import type { HetznerServer } from "../hetzner/types.js";
import { serverOut, toServerOut } from "../tools/servers.js";
import type { ToolContext } from "../tools/shared.js";
import { guardedRead, idVariable, jsonContents } from "./shared.js";

export function registerServerResource(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "server",
    // list: undefined keeps servers out of resources/list; hetzner://inventory carries the IDs.
    new ResourceTemplate("hetzner://servers/{id}", { list: undefined }),
    {
      title: "Hetzner server",
      description:
        "One server with the same fields as the server_get tool (no root password, no user data).",
      mimeType: "application/json",
    },
    async (uri, variables, sdk) => {
      let id: number | undefined;
      let invalid: unknown;
      try {
        id = idVariable(variables.id);
      } catch (error) {
        invalid = error;
      }
      return guardedRead(ctx, "server", id === undefined ? [] : [`server:${id}`], async () => {
        if (id === undefined) throw invalid;
        const raw = await ctx.gateway.request<{ server: HetznerServer }>(
          "GET",
          path`/servers/${id}`,
          { signal: sdk.mcpReq.signal },
        );
        // Same mapper and same schema parse (strips unknown keys) as server_get.
        return jsonContents(uri, { server: serverOut.parse(toServerOut(raw.server)) });
      });
    },
  );
}
