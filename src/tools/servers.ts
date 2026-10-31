// Toolset core, part 1 (02-tool-specs/core.md): list, get, update, power, force power, protection.
// server_create/delete/rebuild/change_type follow in AP-14 and use the exports of this file.

import { z } from "zod";
import { hasControlChars, keepScopeLabels } from "../guards.js";
import { ToolError } from "../hetzner/errors.js";
import { path } from "../hetzner/gateway.js";
import type { HetznerAction, HetznerServer } from "../hetzner/types.js";
import { labelsOut, locationRefOut, protectionOut } from "./projections.js";
import {
  type CallContext,
  defineTool,
  hostnameField,
  idField,
  labelSelectorField,
  labelsField,
  pageOf,
  paginationShape,
  quoteName,
  sortField,
  type Target,
  type ToolDefinition,
  toPage,
} from "./shared.js";

// --- output schemas and mappers ---------------------------------------------------------------

const SERVER_STATUS = [
  "running",
  "initializing",
  "starting",
  "stopping",
  "off",
  "deleting",
  "migrating",
  "rebuilding",
  "unknown",
] as const;

const statusOut = z.enum(SERVER_STATUS).describe("Status of the server.");

const serverListItem = z.object({
  id: z.number().int().describe("ID of the server."),
  name: z.string().describe("Name of the server (untrusted data)."),
  status: statusOut,
  created: z.string().describe("Creation time (ISO 8601)."),
  server_type: z.string().describe("Name of the server type, e.g. cx22."),
  location: z.string().describe("Name of the location, e.g. fsn1."),
  ipv4: z.string().nullable().describe("Public IPv4 address, or null."),
  ipv6: z.string().nullable().describe("Public IPv6 network (/64), or null."),
  locked: z.boolean().describe("True while another action runs on the server."),
  labels: labelsOut,
  protection: protectionOut,
});

const ipOut = z.object({
  id: z.number().int().optional().describe("ID of the primary IP, if reported."),
  ip: z.string().describe("IP address (IPv6: the /64 network)."),
  blocked: z.boolean().describe("True if the IP is blocked."),
});

export const serverOut = serverListItem.omit({ server_type: true, location: true }).extend({
  server_type: z
    .object({
      id: z.number().int().describe("ID of the server type."),
      name: z.string().describe("Name of the server type."),
      cores: z.number().describe("Number of CPU cores."),
      memory_gb: z.number().describe("Memory in GB."),
      disk_gb: z.number().describe("Disk size in GB."),
      cpu_type: z.string().describe("CPU type, e.g. shared or dedicated."),
      architecture: z.string().describe("CPU architecture, e.g. x86 or arm."),
      storage_type: z.string().describe("Storage type, e.g. local or network."),
    })
    .describe("Server type without prices (use pricing_get for prices)."),
  location: locationRefOut,
  image: z
    .object({
      id: z.number().int().describe("ID of the image."),
      name: z.string().nullable().describe("Name of the image, or null."),
      type: z.string().describe("Image type, e.g. system or snapshot."),
      os_flavor: z.string().describe("OS flavor, e.g. ubuntu."),
      os_version: z.string().nullable().describe("OS version, or null."),
    })
    .nullable()
    .describe("Image the server was created from, or null."),
  public_net: z
    .object({
      ipv4: ipOut.nullable().describe("Public IPv4, or null."),
      ipv6: ipOut.nullable().describe("Public IPv6 network, or null."),
      floating_ips: z.array(z.number().int()).describe("IDs of assigned Floating IPs."),
      firewalls: z
        .array(
          z.object({
            id: z.number().int().describe("ID of the firewall."),
            status: z.enum(["applied", "pending"]).describe("Whether the firewall is applied."),
          }),
        )
        .describe("Firewalls applied to the server."),
    })
    .describe("Public network of the server."),
  private_net: z
    .array(
      z.object({
        network: z.number().int().describe("ID of the network."),
        ip: z.string().describe("Private IP of the server."),
        alias_ips: z.array(z.string()).describe("Additional IPs in the network."),
      }),
    )
    .describe("Private networks the server is attached to."),
  iso: z
    .object({
      id: z.number().int().describe("ID of the ISO."),
      name: z.string().nullable().describe("Name of the ISO, or null."),
    })
    .nullable()
    .describe("Attached ISO, or null."),
  rescue_enabled: z.boolean().describe("True if the rescue system is enabled."),
  backup_window: z.string().nullable().describe("Backup window, or null if backups are off."),
  outgoing_traffic: z
    .number()
    .int()
    .nullable()
    .describe("Outgoing traffic. Bytes for the current billing period."),
  ingoing_traffic: z
    .number()
    .int()
    .nullable()
    .describe("Ingoing traffic. Bytes for the current billing period."),
  included_traffic: z
    .number()
    .int()
    .nullable()
    .describe("Included traffic. Bytes for the current billing period."),
  volumes: z.array(z.number().int()).describe("IDs of attached volumes."),
  load_balancers: z.array(z.number().int()).describe("IDs of attached load balancers."),
  primary_disk_size: z.number().describe("Size of the primary disk in GB."),
  placement_group: z.number().int().nullable().describe("ID of the placement group, or null."),
});

const serverOutput = z.object({ server: serverOut });

function toServerListItem(raw: HetznerServer): z.infer<typeof serverListItem> {
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    created: raw.created,
    server_type: raw.server_type.name,
    location: raw.location.name,
    ipv4: raw.public_net.ipv4?.ip ?? null,
    ipv6: raw.public_net.ipv6?.ip ?? null,
    locked: raw.locked,
    labels: raw.labels,
    protection: { delete: raw.protection.delete, rebuild: raw.protection.rebuild },
  };
}

function toIp(ip: NonNullable<HetznerServer["public_net"]["ipv4"]>): z.infer<typeof ipOut> {
  return { ...(ip.id !== undefined && { id: ip.id }), ip: ip.ip, blocked: ip.blocked };
}

/** Output of server_get, server_update and (AP-14) server_create. */
export function toServerOut(raw: HetznerServer): z.infer<typeof serverOut> {
  const { server_type: type, image, iso } = raw;
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    created: raw.created,
    ipv4: raw.public_net.ipv4?.ip ?? null,
    ipv6: raw.public_net.ipv6?.ip ?? null,
    locked: raw.locked,
    labels: raw.labels,
    protection: { delete: raw.protection.delete, rebuild: raw.protection.rebuild },
    server_type: {
      id: type.id,
      name: type.name,
      cores: type.cores,
      memory_gb: type.memory,
      disk_gb: type.disk,
      cpu_type: type.cpu_type,
      architecture: type.architecture,
      storage_type: type.storage_type,
    },
    location: { id: raw.location.id, name: raw.location.name },
    image: image
      ? {
          id: image.id,
          name: image.name,
          type: image.type,
          os_flavor: image.os_flavor,
          os_version: image.os_version,
        }
      : null,
    public_net: {
      ipv4: raw.public_net.ipv4 ? toIp(raw.public_net.ipv4) : null,
      ipv6: raw.public_net.ipv6 ? toIp(raw.public_net.ipv6) : null,
      floating_ips: raw.public_net.floating_ips,
      firewalls: (raw.public_net.firewalls ?? []).map((f) => ({ id: f.id, status: f.status })),
    },
    private_net: raw.private_net.map((n) => ({
      network: n.network,
      ip: n.ip,
      alias_ips: n.alias_ips,
    })),
    iso: iso ? { id: iso.id, name: iso.name } : null,
    rescue_enabled: raw.rescue_enabled,
    backup_window: raw.backup_window,
    outgoing_traffic: raw.outgoing_traffic,
    ingoing_traffic: raw.ingoing_traffic,
    included_traffic: raw.included_traffic,
    volumes: raw.volumes ?? [],
    load_balancers: raw.load_balancers ?? [],
    primary_disk_size: raw.primary_disk_size,
    placement_group: raw.placement_group?.id ?? null,
  };
}

/** Shared by the tools that mutate an existing server (target hook, 01 §5.6). */
export async function loadServerTarget(
  id: number,
  ctx: CallContext,
): Promise<Target<HetznerServer>> {
  const raw = await ctx.gateway.request<{ server: HetznerServer }>("GET", path`/servers/${id}`, {
    signal: ctx.signal,
  });
  return {
    value: raw.server,
    resources: [{ type: "server" as const, id: raw.server.id, labels: raw.server.labels }],
  };
}

const serverIdField = idField("server");

// --- read tools -------------------------------------------------------------------------------

const serverList = defineTool({
  name: "server_list",
  title: "List servers",
  description:
    "Lists the servers of the Hetzner Cloud project, 25 per page by default, with status, type, location, public IPs, labels and protection. Filter by exact name, label selector or status. It does not return networking, image, traffic or volume details; use server_get for one server.",
  kind: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => !hasControlChars(v), "must not contain control characters")
      .optional()
      .describe("Only the server with exactly this name (names are unique per project)."),
    label_selector: labelSelectorField.optional(),
    status: z
      .array(z.enum(SERVER_STATUS))
      .min(1)
      .optional()
      .describe("Only servers in one of these states."),
    sort: sortField(["id", "name", "created"]),
    ...paginationShape,
  }),
  output: pageOf(serverListItem),
  handler: async (args, ctx) => {
    const page = await ctx.gateway.page<HetznerServer>("/servers", "servers", {
      query: {
        name: args.name,
        label_selector: args.label_selector,
        status: args.status,
        sort: args.sort,
      },
      page: args.page,
      perPage: args.per_page,
      signal: ctx.signal,
    });
    const total = page.total_entries === null ? "unknown" : String(page.total_entries);
    return {
      data: toPage(page, toServerListItem),
      summary: `Returned ${page.items.length} server(s) on page ${page.page}; total ${total}; more pages: ${page.next_page === null ? "no" : "yes"}.`,
    };
  },
});

const serverGet = defineTool({
  name: "server_get",
  title: "Get server",
  description:
    "Returns one server with status, type, location, image, public and private network, firewalls, volumes, traffic counters (bytes), labels and protection. It does not return prices, the root password or cloud-init user data. A locked server has another action running; follow it with the actions tools.",
  kind: "read",
  input: z.object({ id: serverIdField }),
  output: serverOutput,
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ server: HetznerServer }>(
      "GET",
      path`/servers/${args.id}`,
      { signal: ctx.signal },
    );
    return {
      data: { server: toServerOut(raw.server) },
      summary: `Server ${raw.server.id} is ${raw.server.status}; locked: ${raw.server.locked}.`,
    };
  },
});

// --- write tools ------------------------------------------------------------------------------

const serverUpdate = defineTool({
  name: "server_update",
  title: "Update server",
  description:
    "Renames a server and/or replaces its complete label set (labels not listed are removed; label-scope labels are kept automatically). Firewalls or other label selectors that matched a removed label stop applying to the server. It does not change type, power state or protection.",
  kind: "write",
  idempotent: true,
  input: z.object({
    id: serverIdField,
    name: hostnameField.optional(),
    labels: labelsField.optional(),
  }),
  output: serverOutput,
  target: async (args, ctx) => {
    if (args.name === undefined && args.labels === undefined) {
      throw new ToolError("bad_request", "Provide at least one of name or labels.");
    }
    return loadServerTarget(args.id, ctx);
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ server: HetznerServer }>(
      "PUT",
      path`/servers/${args.id}`,
      {
        // The labels sent are the complete set (OP-1): scope labels are re-added, nothing is merged here.
        body: {
          ...(args.name !== undefined && { name: args.name }),
          ...(args.labels !== undefined && { labels: keepScopeLabels(ctx.config, args.labels) }),
        },
        signal: ctx.signal,
      },
    );
    const fields = [args.name !== undefined && "name", args.labels !== undefined && "labels"]
      .filter(Boolean)
      .join(", ");
    return {
      data: { server: toServerOut(raw.server) },
      summary: `Updated server ${args.id} (${fields}).`,
    };
  },
});

const POWER_ENDPOINT = { on: "poweron", shutdown: "shutdown", reboot: "reboot" } as const;

const serverPower = defineTool({
  name: "server_power",
  title: "Power server on, shut down or reboot",
  description:
    "Starts a server (on), shuts it down gracefully via ACPI (shutdown) or reboots it gracefully via ACPI (reboot). For shutdown and reboot, action status success only means the signal was sent, not that the server finished; check server_get for status off. For a hard power-off or reset use server_power_force.",
  kind: "write",
  actions: true,
  input: z.object({
    id: serverIdField,
    mode: z
      .enum(["on", "shutdown", "reboot"])
      .describe(
        "on starts the server; shutdown sends a graceful ACPI shutdown request; reboot sends a graceful ACPI reboot request. The guest OS must react to ACPI for the last two.",
      ),
  }),
  output: z.object({
    server_id: z.number().int().describe("ID of the server."),
    mode: z.enum(["on", "shutdown", "reboot"]).describe("Requested power operation."),
  }),
  target: async (args, ctx) => loadServerTarget(args.id, ctx),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/servers/${args.id}/actions/${POWER_ENDPOINT[args.mode]}`,
      { signal: ctx.signal },
    );
    const what = args.mode === "on" ? "power on" : args.mode;
    const note =
      args.mode === "on"
        ? ""
        : " Action success only means the ACPI signal was sent, not that the server finished; check server_get.";
    return {
      data: { server_id: args.id, mode: args.mode },
      summary: `Requested ${what} for server ${args.id} (action ${raw.action.id}).${note} Final action status is in 'actions'.`,
      actions: [raw.action],
    };
  },
});

const FORCE_ENDPOINT = { off: "poweroff", reset: "reset" } as const;

const serverPowerForce = defineTool({
  name: "server_power_force",
  title: "Force power off or hard reset server",
  description:
    "Cuts power to a server (off) or cuts power and starts it again (reset), without letting the operating system stop gracefully; this is like pulling the power cord and can lose unsaved data or corrupt files. Use it only if server_power shutdown or reboot does not work. Requires confirmation.",
  kind: "destructive",
  idempotent: false,
  actions: true,
  input: z.object({
    id: serverIdField,
    mode: z
      .enum(["off", "reset"])
      .describe(
        "off cuts the power and leaves the server stopped; reset cuts the power and starts the server again. Both can lose data.",
      ),
  }),
  output: z.object({
    server_id: z.number().int().describe("ID of the server."),
    mode: z.enum(["off", "reset"]).describe("Requested operation."),
  }),
  target: async (args, ctx) => loadServerTarget(args.id, ctx),
  preview: (args, _ctx, server) => {
    const verb = args.mode === "off" ? "power off" : "reset";
    const clause =
      args.mode === "off"
        ? "The server stays stopped until it is powered on again."
        : "The server starts again afterwards.";
    return `${verb} server ${args.id} ${quoteName(server.name)} (status ${server.status}) by cutting its power like pulling the power cord; data not yet written to disk can be lost. ${clause}`;
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/servers/${args.id}/actions/${FORCE_ENDPOINT[args.mode]}`,
      { signal: ctx.signal },
    );
    const what = args.mode === "off" ? "power off" : "reset";
    return {
      data: { server_id: args.id, mode: args.mode },
      summary: `Requested ${what} for server ${args.id} (action ${raw.action.id}). Final action status is in 'actions'.`,
      actions: [raw.action],
    };
  },
});

const serverProtectionSet = defineTool({
  name: "server_protection_set",
  title: "Set server protection",
  description:
    "Turns delete and rebuild protection of a server on or off together (Hetzner currently requires both to have the same value). With protection on, Hetzner refuses delete and rebuild requests. Protection is never changed by other tools. Every call needs confirmation, also turning protection on, because the same tool can remove it.",
  kind: "destructive",
  actions: true,
  input: z.object({
    id: serverIdField,
    protected: z
      .boolean()
      .describe("true turns delete and rebuild protection on; false turns both off."),
  }),
  output: z.object({
    server_id: z.number().int().describe("ID of the server."),
    protection: protectionOut.describe(
      "Requested protection state; applied when the action succeeds.",
    ),
  }),
  target: async (args, ctx) => loadServerTarget(args.id, ctx),
  preview: (args, _ctx, server) => {
    const name = quoteName(server.name);
    const text = args.protected
      ? `turn ON delete and rebuild protection for server ${args.id} ${name}. Hetzner will then refuse delete and rebuild requests until protection is turned off.`
      : `turn OFF delete and rebuild protection for server ${args.id} ${name}. The server can then be deleted or rebuilt (all data lost) without further protection.`;
    const unchanged =
      server.protection.delete === args.protected && server.protection.rebuild === args.protected;
    return unchanged ? `${text} It already has this state; nothing will change.` : text;
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/servers/${args.id}/actions/change_protection`,
      { body: { delete: args.protected, rebuild: args.protected }, signal: ctx.signal },
    );
    return {
      data: {
        server_id: args.id,
        protection: { delete: args.protected, rebuild: args.protected },
      },
      summary: `Requested protection ${args.protected ? "on" : "off"} for server ${args.id} (action ${raw.action.id}). Final action status is in 'actions'.`,
      actions: [raw.action],
    };
  },
});

/** Toolset core (part 1; AP-14 adds create, delete, rebuild and change_type). */
export const serverTools: readonly ToolDefinition[] = [
  serverList,
  serverGet,
  serverUpdate,
  serverPower,
  serverPowerForce,
  serverProtectionSet,
];
