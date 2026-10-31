// Toolset core (02-tool-specs/core.md): list, get, update, power, force power, protection (AP-12) and
// the server lifecycle create, delete, rebuild, change_type (AP-14). Lifecycle previews are verbatim
// from 03 §2.7, their cost lines come from src/pricing/estimate.ts (03 §2.6).

import { z } from "zod";
import {
  type GuardedResource,
  hasControlChars,
  keepScopeLabels,
  withScopeLabels,
} from "../guards.js";
import { ToolError } from "../hetzner/errors.js";
import { path } from "../hetzner/gateway.js";
import type { HetznerAction, HetznerServer, Labels } from "../hetzner/types.js";
import { formatTerms } from "../labels.js";
import {
  loadPricing,
  remainingAfterDelete,
  serverChangeTypeCost,
  serverChangeTypeMonthly,
  serverCreateCost,
  serverCreateMonthly,
  serverDeleteSavings,
} from "../pricing/estimate.js";
import { labelsOut, locationRefOut, protectionOut } from "./projections.js";
import {
  type CallContext,
  defineTool,
  hostnameField,
  idField,
  labelSelectorField,
  labelsField,
  nameOrIdField,
  newLabelsField,
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

// --- server lifecycle (AP-14) -------------------------------------------------------------------

/** Hetzner limit for cloud-init user data (SPEC: "limited to 32KiB"), counted in UTF-8 bytes. */
const USER_DATA_MAX_BYTES = 32_768;
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const userDataField = (describe: string) =>
  z
    .string()
    .refine((v) => utf8Bytes(v) <= USER_DATA_MAX_BYTES, "must be at most 32 KiB (UTF-8 bytes)")
    .optional()
    .describe(describe);

/** 01 §7.1: the fixed sentence when Hetzner returned a root password that was discarded. */
const ROOT_PASSWORD_DISCARDED =
  " Hetzner returned a root password; it was discarded and cannot be retrieved. Log in with the SSH key.";

/**
 * 01 §7.1 / 05 K-22: a root password in a response is never read further, returned or logged. Returns
 * the summary suffix (empty if Hetzner sent none).
 */
function discardRootPassword(
  response: { root_password?: unknown },
  tool: string,
  ctx: CallContext,
): string {
  if (typeof response.root_password !== "string") return "";
  ctx.logger.warn("root_password_discarded", { tool });
  return ROOT_PASSWORD_DISCARDED;
}

/** 01 §5.5: `{protection}` of 03 §2.7 (sentence plus space, or empty). */
const protectionNotice = (active: boolean, id: number, kind: "delete" | "rebuild"): string =>
  active
    ? `Hetzner will refuse this: server ${id} has ${kind} protection enabled. Disable it first with server_protection_set. `
    : "";

const userDataPart = (userData: string | undefined): string =>
  userData === undefined ? "" : `, with cloud-init user data (${utf8Bytes(userData)} bytes)`;

const serverIdOutput = z.object({ server_id: z.number().int().describe("ID of the server.") });

/** Only the labels are needed from attached resources (02 core, server_create target). */
interface Labelled {
  id: number;
  labels: Labels;
}

const serverCreate = defineTool({
  name: "server_create",
  title: "Create server",
  description:
    "Creates a new server from a server type, image and location, injecting the given SSH keys; root passwords are never created or returned, so at least one SSH key is required. The server starts after creation by default and bills from creation until it is deleted; the confirmation preview shows the estimated cost. It returns the preliminary server and the creation actions, not cloud-init user data.",
  kind: "write",
  costs: true,
  creates: true,
  actions: true,
  input: z.object({
    name: hostnameField,
    server_type: nameOrIdField("server type (see catalog_server_types)"),
    image: nameOrIdField("image (see catalog_images)"),
    location: z
      .string()
      .min(1)
      .max(64)
      .refine((v) => !hasControlChars(v), "must not contain control characters")
      .describe(
        "Name of the location, e.g. 'fsn1' (see catalog_locations). Required because prices differ per location.",
      ),
    ssh_keys: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .refine((v) => !hasControlChars(v), "must not contain control characters"),
      )
      .min(1)
      .describe(
        "Names of existing SSH keys to inject into the server (see ssh_key_list). At least one is required because root passwords are not supported.",
      ),
    user_data: userDataField(
      "Cloud-init user data (at most 32 KiB). It is sent to Hetzner but never shown in results, previews or logs.",
    ),
    labels: newLabelsField.optional(),
    public_net: z
      .object({
        enable_ipv4: z.boolean().optional().describe("Create a new public IPv4 (default true)."),
        enable_ipv6: z.boolean().optional().describe("Create a new public IPv6 (default true)."),
      })
      .optional()
      .describe(
        "Public network: set enable_ipv4 or enable_ipv6 to false to create the server without that public IP (a new Primary IP costs money; see the preview). At least one must stay enabled.",
      ),
    start_after_create: z
      .boolean()
      .default(true)
      .describe("Start the server after creation (default true)."),
    volumes: z
      .array(idField("volume"))
      .optional()
      .describe(
        "IDs of existing volumes to attach at creation. They must be in the same location.",
      ),
    automount: z.boolean().optional().describe("Mount the attached volumes automatically."),
    firewalls: z
      .array(idField("firewall"))
      .optional()
      .describe("IDs of existing firewalls to apply to the public network interface at creation."),
  }),
  output: serverOutput,
  // value = the labels of the new server (scope labels added; a conflicting scope label fails here,
  // before preview and confirmation).
  target: async (args, ctx) => {
    if (args.public_net?.enable_ipv4 === false && args.public_net?.enable_ipv6 === false) {
      throw new ToolError(
        "bad_request",
        "Keep at least one of public_net.enable_ipv4 or enable_ipv6 enabled; a server without a public IP is not reachable with the tools of this server.",
      );
    }
    const labels = withScopeLabels(ctx.config, args.labels);
    if (ctx.config.labelScope.length === 0 && ctx.config.iacPolicy === "off") {
      return { value: labels, resources: [] };
    }
    // Existing resources the call changes (01 §5.3); a 404 is not caught (4.3: not_found).
    const load = async (type: "volume" | "firewall", id: number): Promise<GuardedResource> => {
      const raw = await ctx.gateway.request<Record<string, Labelled>>(
        "GET",
        type === "volume" ? path`/volumes/${id}` : path`/firewalls/${id}`,
        { signal: ctx.signal },
      );
      return { type, id, labels: raw[type]?.labels ?? {} };
    };
    const resources = await Promise.all([
      ...(args.volumes ?? []).map((id) => load("volume", id)),
      ...(args.firewalls ?? []).map((id) => load("firewall", id)),
    ]);
    return { value: labels, resources };
  },
  preview: async (args, ctx) => {
    const parts = [
      `type ${quoteName(args.server_type)}`,
      `location ${quoteName(args.location)}`,
      `image ${quoteName(args.image)}`,
      `${args.ssh_keys.length} SSH key(s)`,
    ];
    if (args.volumes?.length) parts.push(`${args.volumes.length} volume(s)`);
    if (args.firewalls?.length) parts.push(`${args.firewalls.length} firewall(s)`);
    let details = parts.join(", ") + userDataPart(args.user_data);
    if (args.public_net?.enable_ipv4 === false) details += ", without public IPv4";
    if (args.public_net?.enable_ipv6 === false) details += ", without public IPv6";
    if (args.start_after_create === false) details += ", not started after creation";
    const scope =
      ctx.config.labelScope.length > 0
        ? ` It gets the labels ${formatTerms(ctx.config.labelScope)}.`
        : "";
    const cost = serverCreateCost(await loadPricing(ctx), args);
    return `create server ${quoteName(args.name)} (${details}).${scope} ${cost}`;
  },
  monthlyCost: async (args, ctx) => serverCreateMonthly(await loadPricing(ctx), args),
  handler: async (args, ctx, labels) => {
    const raw = await ctx.gateway.request<{
      server: HetznerServer;
      action: HetznerAction;
      next_actions?: HetznerAction[];
      root_password?: unknown;
    }>("POST", path`/servers`, {
      // Field names as in the SPEC; never datacenter, root_password or Primary IP IDs (05 K-14).
      body: {
        name: args.name,
        server_type: args.server_type,
        image: args.image,
        location: args.location,
        ssh_keys: args.ssh_keys,
        start_after_create: args.start_after_create,
        ...(args.user_data !== undefined && { user_data: args.user_data }),
        labels,
        ...(args.volumes !== undefined && { volumes: args.volumes }),
        ...(args.automount !== undefined && { automount: args.automount }),
        ...(args.firewalls !== undefined && {
          firewalls: args.firewalls.map((id) => ({ firewall: id })),
        }),
        ...(args.public_net !== undefined && {
          public_net: {
            ...(args.public_net.enable_ipv4 !== undefined && {
              enable_ipv4: args.public_net.enable_ipv4,
            }),
            ...(args.public_net.enable_ipv6 !== undefined && {
              enable_ipv6: args.public_net.enable_ipv6,
            }),
          },
        }),
      },
      signal: ctx.signal,
    });
    const discarded = discardRootPassword(raw, "server_create", ctx);
    const next = raw.next_actions ?? [];
    const followUp = next.length > 0 ? `, plus ${next.length} follow-up action(s)` : "";
    return {
      data: { server: toServerOut(raw.server) },
      summary: `Requested creation of server ${raw.server.id} (action ${raw.action.id}${followUp}). Final action status is in 'actions'.${discarded}`,
      actions: [raw.action, ...next],
    };
  },
});

const serverDelete = defineTool({
  name: "server_delete",
  title: "Delete server",
  description:
    "Permanently deletes a server and all data on its disks; this cannot be undone. Attached volumes and floating IPs are detached but not deleted and keep billing; a Primary IP is deleted only if it has auto-deletion enabled. Requires confirmation; the preview shows the cost impact.",
  kind: "destructive",
  actions: true,
  input: z.object({ id: serverIdField }),
  output: serverIdOutput,
  target: async (args, ctx) => loadServerTarget(args.id, ctx),
  preview: async (args, ctx, server) => {
    const protection = protectionNotice(server.protection.delete, args.id, "delete");
    const savings = serverDeleteSavings(await loadPricing(ctx), server);
    return `${protection}delete server ${quoteName(server.name)} (ID ${args.id}) permanently, including its disk and its backup images. ${savings} ${remainingAfterDelete(server)}`;
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "DELETE",
      path`/servers/${args.id}`,
      { signal: ctx.signal },
    );
    return {
      data: { server_id: args.id },
      summary: `Requested deletion of server ${args.id} (action ${raw.action.id}). Final action status is in 'actions'.`,
      actions: [raw.action],
    };
  },
});

/**
 * GATED BY IT-05 (05 K-23, OWNER O-1): built and registered for tests, but released in 1.0 only after
 * a green IT-05 (are the SSH keys injected again after a rebuild? OP-17). If IT-05 fails, this tool is
 * removed before the release.
 */
const serverRebuild = defineTool({
  name: "server_rebuild",
  title: "Rebuild server",
  description:
    "Overwrites a server's disk with an image (a fresh system image, a snapshot or a backup), destroying all data on the server; the server is powered off first. Root passwords are never returned. Requires confirmation.",
  kind: "destructive",
  actions: true,
  input: z.object({
    id: serverIdField,
    image: nameOrIdField("image to rebuild from (see catalog_images)"),
    user_data: userDataField(
      "Cloud-init user data (at most 32 KiB). If omitted, Hetzner reuses the previous value. It is never shown in results, previews or logs.",
    ),
  }),
  output: serverIdOutput,
  target: async (args, ctx) => loadServerTarget(args.id, ctx),
  preview: (args, _ctx, server) => {
    const protection = protectionNotice(server.protection.rebuild, args.id, "rebuild");
    return `${protection}rebuild server ${quoteName(server.name)} (ID ${args.id}) from image ${quoteName(args.image)}${userDataPart(args.user_data)}. This destroys all data on its disk; Hetzner powers the server off first. Create a snapshot first (snapshot_create) if any data on it is still needed. Hetzner does not document whether the SSH keys of the server are injected again; no root password will be shown, so the server may become unreachable. No price change (the server type stays the same).`;
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction; root_password?: unknown }>(
      "POST",
      path`/servers/${args.id}/actions/rebuild`,
      {
        body: {
          image: args.image,
          ...(args.user_data !== undefined && { user_data: args.user_data }),
        },
        signal: ctx.signal,
      },
    );
    const discarded = discardRootPassword(raw, "server_rebuild", ctx);
    return {
      data: { server_id: args.id },
      summary: `Requested rebuild of server ${args.id} (action ${raw.action.id}). Final action status is in 'actions'.${discarded}`,
      actions: [raw.action],
    };
  },
});

const serverChangeType = defineTool({
  name: "server_change_type",
  title: "Change server type",
  description:
    "Changes the server type (cores, RAM, and optionally disk size) of a server that is powered off; Hetzner copies the disk and starts the server again. With upgrade_disk true the disk is enlarged and the server can never be moved to a smaller type again. Requires confirmation; the preview shows the price change.",
  kind: "destructive",
  costs: true, // 05 K-28: under HETZNER_MCP_ALLOW_COSTS and the cost limit
  actions: true,
  input: z.object({
    id: serverIdField,
    server_type: nameOrIdField("new server type (see catalog_server_types)").describe(
      "Name or ID of the server type to change to (see catalog_server_types). It needs the same storage type and an equal or larger disk.",
    ),
    upgrade_disk: z
      .boolean()
      .default(false)
      .describe(
        "If true, the disk is enlarged to the new type's size and the server can never be downgraded again. If false (default), only cores and RAM change and a later downgrade stays possible.",
      ),
  }),
  output: serverIdOutput,
  target: async (args, ctx) => loadServerTarget(args.id, ctx),
  preview: async (args, ctx, server) => {
    const disk = args.upgrade_disk
      ? "upgrading the disk (the server can then no longer be downgraded to a type with a smaller disk)"
      : "keeping the disk size (a later downgrade stays possible)";
    const running =
      server.status !== "off"
        ? ` The server is currently ${server.status}; Hetzner will refuse the change until it is off (use server_power with mode shutdown first).`
        : "";
    const cost = serverChangeTypeCost(await loadPricing(ctx), server, args.server_type);
    return `change server ${quoteName(server.name)} (ID ${args.id}) from type ${quoteName(server.server_type.name)} to ${quoteName(args.server_type)}, ${disk}. The server must be powered off; Hetzner copies its disk and starts it again.${running} ${cost}`;
  },
  monthlyCost: async (args, ctx, server) =>
    serverChangeTypeMonthly(await loadPricing(ctx), server, args.server_type),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/servers/${args.id}/actions/change_type`,
      {
        body: { server_type: args.server_type, upgrade_disk: args.upgrade_disk },
        signal: ctx.signal,
      },
    );
    return {
      data: { server_id: args.id },
      summary: `Requested type change for server ${args.id} (action ${raw.action.id}). Final action status is in 'actions'.`,
      actions: [raw.action],
    };
  },
});

/** Toolset core (10 tools). server_rebuild is gated by IT-05 (see above). */
export const serverTools: readonly ToolDefinition[] = [
  serverList,
  serverGet,
  serverUpdate,
  serverPower,
  serverPowerForce,
  serverProtectionSet,
  serverCreate,
  serverDelete,
  serverRebuild,
  serverChangeType,
];
