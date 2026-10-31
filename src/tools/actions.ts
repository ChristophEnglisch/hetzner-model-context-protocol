// Toolset actions: action_get, action_list (02-tool-specs/actions.md). There is no action_wait (05 K-02).
// Only non-deprecated endpoints: GET /actions/{id} and GET /{res}/{id}/actions.

import { z } from "zod";
import { path } from "../hetzner/gateway.js";
import type { HetznerAction } from "../hetzner/types.js";
import { actionOut, toActionOut } from "./projections.js";
import {
  defineTool,
  idField,
  pageOf,
  paginationShape,
  sortField,
  type ToolDefinition,
  toPage,
} from "./shared.js";

/** resource_type -> path segment; the path never comes from free text. */
const SEGMENTS = {
  server: "servers",
  volume: "volumes",
  firewall: "firewalls",
  image: "images",
} as const;

const ACPI_COMMANDS: ReadonlySet<string> = new Set(["shutdown_server", "reboot_server"]);

const actionGet = defineTool({
  name: "action_get",
  title: "Get an action",
  description:
    "Returns the current state of one Hetzner action (status, progress, error) by ID. Use it to follow up when a write tool reported status 'running'; reading a failed action is not an error. Does not wait: call it again later instead of polling quickly.",
  kind: "read",
  input: z.object({ id: idField("action") }),
  output: z.object({ action: actionOut.describe("Current state of the action.") }),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "GET",
      path`/actions/${args.id}`,
      { signal: ctx.signal },
    );
    const a = raw.action;
    let summary: string;
    if (a.status === "running") {
      summary = `Action ${a.id} (${a.command}) is running, ${a.progress}% done. Check again with action_get in a few seconds.`;
    } else if (a.status === "success") {
      summary = `Action ${a.id} (${a.command}) finished successfully.`;
      if (ACPI_COMMANDS.has(a.command)) {
        summary +=
          " For shutdown and reboot this only means the ACPI signal was sent; check the server status with server_get.";
      }
    } else {
      summary = `Action ${a.id} (${a.command}) failed; see 'action.error' in the result.`;
    }
    return { data: { action: toActionOut(a) }, summary };
  },
});

const actionList = defineTool({
  name: "action_list",
  title: "List actions of a resource",
  description:
    "Lists the Hetzner actions (power, rebuild, attach, snapshot and similar operations) of one server, volume, firewall or image, newest first by default. Use it to see what is running on a resource, for example after a 'locked' error. Does not list actions across the whole project.",
  kind: "read",
  input: z.object({
    resource_type: z
      .enum(["server", "volume", "firewall", "image"])
      .describe("Type of the resource whose actions to list."),
    resource_id: idField("resource"),
    status: z
      .array(z.enum(["running", "success", "error"]))
      .min(1)
      .max(3)
      .optional()
      .describe("Only actions with one of these statuses, e.g. ['running']."),
    sort: sortField(["id", "command", "status", "started", "finished"]),
    ...paginationShape,
  }),
  output: pageOf(actionOut),
  handler: async (args, ctx) => {
    const segment = SEGMENTS[args.resource_type];
    const page = await ctx.gateway.page<HetznerAction>(
      path`/${segment}/${args.resource_id}/actions`,
      "actions",
      {
        query: { status: args.status, sort: args.sort ?? "started:desc" },
        page: args.page,
        perPage: args.per_page,
        signal: ctx.signal,
      },
    );
    const total = page.total_entries === null ? "" : `, ${page.total_entries} in total`;
    const more = page.next_page === null ? "" : ` More on page ${page.next_page}.`;
    const running = page.items.filter((a) => a.status === "running").length;
    const still = running > 0 ? ` ${running} still running.` : "";
    return {
      data: toPage(page, toActionOut),
      summary: `Returned ${page.items.length} action(s) (page ${page.page}${total}).${more}${still}`,
    };
  },
});

/** Toolset actions (02-tool-specs/actions.md). */
export const actionTools: readonly ToolDefinition[] = [actionGet, actionList];
