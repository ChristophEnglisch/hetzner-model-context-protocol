// Toolset storage (02-tool-specs/storage.md): volumes, snapshots and backups.
// Cost-relevant tools (volume_create, volume_resize, snapshot_create, backup_enable) are write tools with
// costs: true; their preview texts are verbatim from 03 §2.7, cost lines and amounts come from
// src/pricing/estimate.ts. Domain types used only here live in this file (OE-28).

import { z } from "zod";
import { hasControlChars, keepScopeLabels, withScopeLabels } from "../guards.js";
import { ToolError } from "../hetzner/errors.js";
import { path } from "../hetzner/gateway.js";
import type { HetznerAction, HetznerServer, Labels } from "../hetzner/types.js";
import {
  backupEnableCost,
  backupEnableMonthly,
  loadPricing,
  snapshotCost,
  snapshotMonthlyUpperBound,
  volumeCreateCost,
  volumeCreateMonthly,
  volumeResizeCost,
  volumeResizeMonthly,
} from "../pricing/estimate.js";
import { labelsOut, locationRefOut, protectionOut } from "./projections.js";
import { loadServerTarget } from "./servers.js";
import {
  type CallContext,
  defineTool,
  idField,
  labelSelectorField,
  labelsField,
  nameField,
  newLabelsField,
  pageOf,
  paginationShape,
  quoteName,
  sortField,
  type Target,
  type ToolDefinition,
  toPage,
} from "./shared.js";

// --- raw API types (only what projections and previews read) ----------------------------------

/** Volume as returned by Hetzner (R§2.9). The deprecated `server` field is never read. */
export interface HetznerVolume {
  id: number;
  name: string;
  size: number;
  status: "available" | "creating";
  format: string | null;
  linux_device: string;
  location: { id: number; name: string };
  assignee: { id: number; type: string } | null;
  protection: { delete: boolean };
  labels: Labels;
  created: string;
}

/** Image (snapshot, backup, system or app) as returned by Hetzner. */
export interface HetznerImage {
  id: number;
  type: "snapshot" | "backup" | "system" | "app";
  status: "available" | "creating" | "unavailable";
  name: string | null;
  description: string;
  created: string;
  image_size: number | null;
  disk_size: number;
  bound_to: number | null;
  created_from: { id: number; name: string } | null;
  architecture: "x86" | "arm";
  protection: { delete: boolean };
  labels: Labels;
}

// --- output schemas and mappers ---------------------------------------------------------------

const volumeOut = z.object({
  id: z.number().int().describe("ID of the volume."),
  name: z.string().describe("Name of the volume (untrusted data)."),
  size: z.number().int().describe("Size in GB."),
  status: z.enum(["available", "creating"]).describe("Status of the volume."),
  format: z.string().nullable().describe("File system created on the volume, or null."),
  linux_device: z.string().describe("Device path of the volume inside an attached server."),
  location: locationRefOut.describe("Location of the volume."),
  assignee: z
    .object({
      id: z.number().int().describe("ID of the resource the volume is attached to."),
      type: z.string().describe("Type of that resource, e.g. server."),
    })
    .nullable()
    .describe("Resource the volume is attached to, or null if it is detached."),
  protection: z
    .object({ delete: protectionOut.shape.delete })
    .describe("Protection of the volume."),
  labels: labelsOut,
  created: z.string().describe("Creation time (ISO 8601)."),
});

const imageOut = z.object({
  id: z.number().int().describe("ID of the image."),
  type: z.enum(["snapshot", "backup", "system", "app"]).describe("Type of the image."),
  status: z.enum(["available", "creating", "unavailable"]).describe("Status of the image."),
  name: z.string().nullable().describe("Name of the image (untrusted data), or null."),
  description: z.string().describe("Description of the image (untrusted data)."),
  created: z.string().describe("Creation time (ISO 8601)."),
  image_size: z
    .number()
    .nullable()
    .describe("Size in GB in storage; billing basis of snapshots. Null while unknown."),
  disk_size: z.number().describe("Size in GB of the disk the image was taken from."),
  bound_to: z
    .number()
    .int()
    .nullable()
    .describe("ID of the server a backup belongs to; null for snapshots."),
  created_from: z
    .object({
      id: z.number().int().describe("ID of the server the image was created from."),
      name: z.string().describe("Name of that server (untrusted data)."),
    })
    .nullable()
    .describe("Server the image was created from, or null."),
  architecture: z.enum(["x86", "arm"]).describe("CPU architecture of the image."),
  protection: z.object({ delete: protectionOut.shape.delete }).describe("Protection of the image."),
  labels: labelsOut,
});

function toVolumeOut(raw: HetznerVolume): z.infer<typeof volumeOut> {
  return {
    id: raw.id,
    name: raw.name,
    size: Math.trunc(raw.size),
    status: raw.status,
    format: raw.format,
    linux_device: raw.linux_device,
    location: { id: raw.location.id, name: raw.location.name },
    assignee: raw.assignee ? { id: raw.assignee.id, type: raw.assignee.type } : null,
    protection: { delete: raw.protection.delete },
    labels: raw.labels,
    created: raw.created,
  };
}

function toImageOut(raw: HetznerImage): z.infer<typeof imageOut> {
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    name: raw.name,
    description: raw.description,
    created: raw.created,
    image_size: raw.image_size,
    disk_size: raw.disk_size,
    bound_to: raw.bound_to,
    created_from: raw.created_from
      ? { id: raw.created_from.id, name: raw.created_from.name }
      : null,
    architecture: raw.architecture,
    protection: { delete: raw.protection.delete },
    labels: raw.labels,
  };
}

const requestedProtectionOut = z
  .object({ delete: z.boolean().describe("Delete protection.") })
  .describe("Requested protection state; applied when the action succeeds.");

// --- shared input fields ----------------------------------------------------------------------

const volumeIdField = idField("volume");
const imageIdField = idField("image");
const serverIdField = idField("server");

const volumeSizeField = (describe: string) =>
  z.number().int().min(10).max(10240).describe(describe);

const descriptionField = (describe: string) =>
  z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !hasControlChars(v), "must not contain control characters")
    .describe(describe);

const protectedField = z.boolean().describe("true turns delete protection on; false turns it off.");

// --- loading targets --------------------------------------------------------------------------

async function loadVolume(id: number, ctx: CallContext): Promise<Target<HetznerVolume>> {
  const raw = await ctx.gateway.request<{ volume: HetznerVolume }>("GET", path`/volumes/${id}`, {
    signal: ctx.signal,
  });
  return {
    value: raw.volume,
    resources: [{ type: "volume" as const, id: raw.volume.id, labels: raw.volume.labels }],
  };
}

async function loadImage(id: number, ctx: CallContext): Promise<Target<HetznerImage>> {
  const raw = await ctx.gateway.request<{ image: HetznerImage }>("GET", path`/images/${id}`, {
    signal: ctx.signal,
  });
  return {
    value: raw.image,
    resources: [{ type: "image" as const, id: raw.image.id, labels: raw.image.labels }],
  };
}

/** 01 §5.5: first part of a delete preview when Hetzner will refuse because of delete protection. */
function protectionLine(protectedNow: boolean, type: string, id: number, tool: string): string {
  return protectedNow
    ? `Hetzner will refuse this: ${type} ${id} has delete protection enabled. Disable it first with ${tool}. `
    : "";
}

function protectionPreview(
  kind: "volume" | "snapshot",
  id: number,
  quotedName: string,
  turnOn: boolean,
  already: boolean,
): string {
  const text = turnOn
    ? `turn ON delete protection for ${kind} ${id} ${quotedName}. Hetzner will then refuse to delete it until protection is turned off.`
    : `turn OFF delete protection for ${kind} ${id} ${quotedName}. It can then be deleted (all data lost) without further protection.`;
  return already ? `${text} It already has this state; nothing will change.` : text;
}

const fieldList = (parts: Record<string, boolean>): string =>
  Object.entries(parts)
    .filter(([, set]) => set)
    .map(([name]) => name)
    .join(", ");

// --- volume tools -----------------------------------------------------------------------------

const volumeList = defineTool({
  name: "volume_list",
  title: "List volumes",
  description:
    "Lists block-storage volumes with size, status, location, the server each is attached to, labels and protection. Does not return the content or mount state of a volume. Supports filtering by name, status or label selector and paging.",
  kind: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => !hasControlChars(v), "must not contain control characters")
      .optional()
      .describe("Only volumes with exactly this name."),
    status: z.enum(["available", "creating"]).optional().describe("Only volumes in this status."),
    label_selector: labelSelectorField.optional(),
    sort: sortField(["id", "name", "created"]),
    ...paginationShape,
  }),
  output: pageOf(volumeOut),
  handler: async (args, ctx) => {
    const page = await ctx.gateway.page<HetznerVolume>("/volumes", "volumes", {
      query: {
        name: args.name,
        status: args.status,
        label_selector: args.label_selector,
        sort: args.sort,
      },
      page: args.page,
      perPage: args.per_page,
      signal: ctx.signal,
    });
    const more = page.next_page === null ? "" : "; more pages available";
    return {
      data: toPage(page, toVolumeOut),
      summary: `Found ${page.items.length} volume(s) on page ${page.page}${more}.`,
    };
  },
});

const volumeGet = defineTool({
  name: "volume_get",
  title: "Get a volume",
  description:
    "Returns one volume with size, status, location, attachment, device path, labels and delete protection. Does not return volume content or its action history.",
  kind: "read",
  input: z.object({ id: volumeIdField }),
  output: volumeOut,
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ volume: HetznerVolume }>(
      "GET",
      path`/volumes/${args.id}`,
      { signal: ctx.signal },
    );
    const v = raw.volume;
    const attached = v.assignee?.type === "server" ? `, attached to server ${v.assignee.id}` : "";
    return {
      data: toVolumeOut(v),
      summary: `Volume ${v.id}: ${Math.trunc(v.size)} GB, status ${v.status}${attached}.`,
    };
  },
});

const volumeCreate = defineTool({
  name: "volume_create",
  title: "Create a volume",
  description:
    "Creates a block-storage volume of 10 to 10240 GB, optionally attached to a server at creation. The volume is billed per GB and month from creation until it is deleted, even when unattached; it cannot be shrunk later. Provide exactly one of location or server_id; the volume is created in the server's location when server_id is given. Requires confirmation; the preview shows the estimated cost.",
  kind: "write",
  costs: true,
  creates: true,
  actions: true,
  input: z.object({
    name: nameField("volume", 64).describe(
      "Name of the volume: unique in the project, at most 64 characters; letters, digits, '-', '_' and '.', starting and ending with a letter or digit.",
    ),
    size: volumeSizeField("Size in GB (10 to 10240). Cannot be reduced later."),
    location: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Name of the location to create the volume in, e.g. 'fsn1' (see catalog_locations). Omit when server_id is given.",
      ),
    server_id: serverIdField
      .optional()
      .describe(
        "ID of a server to attach the volume to after creation. The volume is created in that server's location.",
      ),
    automount: z
      .boolean()
      .optional()
      .describe("Mount the volume automatically after attaching. Only together with server_id."),
    format: z
      .enum(["xfs", "ext4"])
      .optional()
      .describe("File system to create on the volume. Omit for an unformatted volume."),
    labels: newLabelsField.optional(),
  }),
  output: z.object({ volume: volumeOut.describe("The new volume.") }),
  target: async (args, ctx): Promise<Target<HetznerServer | undefined>> => {
    if (args.location === undefined && args.server_id === undefined) {
      throw new ToolError("bad_request", "Provide location or server_id.");
    }
    if (args.location !== undefined && args.server_id !== undefined) {
      throw new ToolError("bad_request", "Provide either location or server_id, not both.");
    }
    if (args.automount !== undefined && args.server_id === undefined) {
      throw new ToolError("bad_request", "automount requires server_id.");
    }
    if (args.server_id === undefined) return { value: undefined, resources: [] };
    return loadServerTarget(args.server_id, ctx);
  },
  preview: async (args, ctx) => {
    const placement =
      args.server_id !== undefined
        ? `attached to server ${args.server_id}`
        : `in location ${quoteName(args.location ?? "")}`;
    const format = args.format !== undefined ? `, formatted as ${args.format}` : "";
    const mount = args.automount === true ? ", mounted automatically" : "";
    const cost = volumeCreateCost(await loadPricing(ctx), args.size);
    return `create volume ${quoteName(args.name)} with ${args.size} GB ${placement}${format}${mount}. ${cost}`;
  },
  monthlyCost: async (args, ctx) => volumeCreateMonthly(await loadPricing(ctx), args.size),
  handler: async (args, ctx) => {
    const labels = withScopeLabels(ctx.config, args.labels);
    const raw = await ctx.gateway.request<{
      volume: HetznerVolume;
      action: HetznerAction;
      next_actions?: HetznerAction[];
    }>("POST", "/volumes", {
      body: {
        name: args.name,
        size: args.size,
        labels,
        ...(args.format !== undefined && { format: args.format }),
        ...(args.automount !== undefined && { automount: args.automount }),
        ...(args.server_id === undefined
          ? { location: args.location }
          : { assignee: { id: args.server_id, type: "server" } }),
      },
      signal: ctx.signal,
    });
    const attaching = args.server_id !== undefined ? `, attaching to server ${args.server_id}` : "";
    return {
      data: { volume: toVolumeOut(raw.volume) },
      summary: `Created volume ${raw.volume.id} (${Math.trunc(raw.volume.size)} GB)${attaching}.`,
      actions: [raw.action, ...(raw.next_actions ?? [])],
    };
  },
});

const volumeAttach = defineTool({
  name: "volume_attach",
  title: "Attach a volume to a server",
  description:
    "Attaches a volume to a server in the same location. Does not mount or format the volume unless automount is set. Fails if the volume is already attached or the server is in another location.",
  kind: "write",
  actions: true,
  input: z.object({
    id: volumeIdField,
    server_id: serverIdField.describe(
      "ID of the server to attach the volume to. It must be in the same location as the volume.",
    ),
    automount: z.boolean().optional().describe("Mount the volume automatically after attaching."),
  }),
  output: z.object({
    id: z.number().int().describe("ID of the volume."),
    server_id: z.number().int().describe("ID of the server the volume is attached to."),
  }),
  target: async (args, ctx) => {
    const volume = await loadVolume(args.id, ctx);
    const server = await loadServerTarget(args.server_id, ctx);
    return { value: undefined, resources: [...volume.resources, ...server.resources] };
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/volumes/${args.id}/actions/attach`,
      {
        body: {
          assignee: { id: args.server_id, type: "server" },
          ...(args.automount !== undefined && { automount: args.automount }),
        },
        signal: ctx.signal,
      },
    );
    return {
      data: { id: args.id, server_id: args.server_id },
      summary: `Attaching volume ${args.id} to server ${args.server_id}.`,
      actions: [raw.action],
    };
  },
});

const volumeDetach = defineTool({
  name: "volume_detach",
  title: "Detach a volume",
  description:
    "Detaches a volume from the server it is attached to. The volume and its data are kept and can be attached again later. Does not unmount the volume inside the server.",
  kind: "write",
  actions: true,
  input: z.object({ id: volumeIdField }),
  output: z.object({ id: z.number().int().describe("ID of the volume.") }),
  target: async (args, ctx) => {
    const volume = await loadVolume(args.id, ctx);
    const assignee = volume.value.assignee;
    if (assignee?.type !== "server") return { value: undefined, resources: volume.resources };
    const server = await loadServerTarget(assignee.id, ctx);
    return { value: undefined, resources: [...volume.resources, ...server.resources] };
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/volumes/${args.id}/actions/detach`,
      { signal: ctx.signal },
    );
    return {
      data: { id: args.id },
      summary: `Detaching volume ${args.id}.`,
      actions: [raw.action],
    };
  },
});

const volumeResize = defineTool({
  name: "volume_resize",
  title: "Resize a volume",
  description:
    "Increases the size of a volume to the given number of GB. Shrinking is not possible, so this cannot be undone, and the larger size is billed per GB and month. Does not grow the file system inside the server. Requires confirmation; the preview shows the price change.",
  kind: "write",
  costs: true,
  actions: true,
  input: z.object({
    id: volumeIdField,
    size: volumeSizeField(
      "New size in GB (at most 10240). Must be greater than the current size; shrinking is not possible.",
    ),
  }),
  output: z.object({
    id: z.number().int().describe("ID of the volume."),
    size: z.number().int().describe("Requested size in GB."),
  }),
  target: async (args, ctx) => loadVolume(args.id, ctx),
  preview: async (args, ctx, volume) => {
    const old = Math.trunc(volume.size);
    const cost = volumeResizeCost(await loadPricing(ctx), old, args.size);
    return `resize volume ${quoteName(volume.name)} (ID ${args.id}) from ${old} GB to ${args.size} GB. A volume cannot be shrunk again. ${cost}`;
  },
  monthlyCost: async (args, ctx, volume) =>
    volumeResizeMonthly(await loadPricing(ctx), Math.trunc(volume.size), args.size),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/volumes/${args.id}/actions/resize`,
      { body: { size: args.size }, signal: ctx.signal },
    );
    return {
      data: { id: args.id, size: args.size },
      summary: `Resizing volume ${args.id} to ${args.size} GB.`,
      actions: [raw.action],
    };
  },
});

const volumeUpdate = defineTool({
  name: "volume_update",
  title: "Update a volume's name or labels",
  description:
    "Renames a volume and/or replaces its complete label set. Does not change size, attachment or protection. Labels you send replace all existing labels, so include the ones to keep.",
  kind: "write",
  idempotent: true,
  input: z.object({
    id: volumeIdField,
    name: nameField("volume", 64)
      .optional()
      .describe("New name of the volume (unique in the project, at most 64 characters)."),
    labels: labelsField.optional(),
  }),
  output: volumeOut,
  target: async (args, ctx) => {
    if (args.name === undefined && args.labels === undefined) {
      throw new ToolError("bad_request", "Provide name, labels, or both.");
    }
    return loadVolume(args.id, ctx);
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ volume: HetznerVolume }>(
      "PUT",
      path`/volumes/${args.id}`,
      {
        // The labels sent are the complete set (OP-1): scope labels are re-added, nothing is merged here.
        body: {
          ...(args.name !== undefined && { name: args.name }),
          ...(args.labels !== undefined && { labels: keepScopeLabels(ctx.config, args.labels) }),
        },
        signal: ctx.signal,
      },
    );
    const fields = fieldList({ name: args.name !== undefined, labels: args.labels !== undefined });
    return { data: toVolumeOut(raw.volume), summary: `Updated volume ${args.id}: ${fields}.` };
  },
});

const volumeDelete = defineTool({
  name: "volume_delete",
  title: "Delete a volume",
  description:
    "Permanently deletes a volume; all data on it is irreversibly destroyed. The volume must be detached from its server and must not have delete protection enabled. Snapshots of the server do not contain volume data.",
  kind: "destructive",
  input: z.object({ id: volumeIdField }),
  output: z.object({
    id: z.number().int().describe("ID of the deleted volume."),
    deleted: z.boolean().describe("True once Hetzner confirmed the deletion."),
  }),
  target: async (args, ctx) => loadVolume(args.id, ctx),
  preview: (args, _ctx, volume) => {
    const attached =
      volume.assignee?.type === "server"
        ? ` It is still attached to server ${volume.assignee.id}; Hetzner will refuse until it is detached.`
        : "";
    return `${protectionLine(volume.protection.delete, "volume", args.id, "volume_protection_set")}permanently delete volume ${quoteName(volume.name)} (ID ${args.id}, ${Math.trunc(volume.size)} GB) and destroy ALL data on it, irreversibly.${attached} Billing for the volume stops.`;
  },
  handler: async (args, ctx) => {
    await ctx.gateway.request("DELETE", path`/volumes/${args.id}`, { signal: ctx.signal });
    return { data: { id: args.id, deleted: true }, summary: `Deleted volume ${args.id}.` };
  },
});

const volumeProtectionSet = defineTool({
  name: "volume_protection_set",
  title: "Set volume delete protection",
  description:
    "Turns delete protection of a volume on or off. With protection on, Hetzner refuses to delete the volume. Protection is never changed by other tools. Every call needs confirmation, also turning protection on, because the same tool can remove it.",
  kind: "destructive",
  actions: true,
  input: z.object({ id: volumeIdField, protected: protectedField }),
  output: z.object({
    id: z.number().int().describe("ID of the volume."),
    protection: requestedProtectionOut,
  }),
  target: async (args, ctx) => loadVolume(args.id, ctx),
  preview: (args, _ctx, volume) =>
    protectionPreview(
      "volume",
      args.id,
      quoteName(volume.name),
      args.protected,
      volume.protection.delete === args.protected,
    ),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/volumes/${args.id}/actions/change_protection`,
      { body: { delete: args.protected }, signal: ctx.signal },
    );
    return {
      data: { id: args.id, protection: { delete: args.protected } },
      summary: `Requested delete protection ${args.protected ? "on" : "off"} for volume ${args.id} (action ${raw.action.id}). Final action status is in 'actions'.`,
      actions: [raw.action],
    };
  },
});

// --- snapshot and backup tools ----------------------------------------------------------------

const snapshotCreate = defineTool({
  name: "snapshot_create",
  title: "Create a snapshot of a server",
  description:
    "Creates a snapshot image of a server's disk. Snapshots survive deletion of the server and are billed per GB and month until deleted. For a consistent result shut the server down first; a running server may yield an unreadable image. Requires confirmation; the preview shows the price per GB.",
  kind: "write",
  costs: true,
  creates: true,
  actions: true,
  input: z.object({
    server_id: serverIdField,
    description: descriptionField(
      "Description of the snapshot. Generated by Hetzner if omitted.",
    ).optional(),
    labels: newLabelsField.optional(),
  }),
  output: z.object({ image: imageOut.describe("The new snapshot image.") }),
  target: async (args, ctx) => loadServerTarget(args.server_id, ctx),
  preview: async (args, ctx, server) => {
    const running =
      server.status === "running"
        ? " The server is running; Hetzner recommends shutting it down first so the disk content is consistent."
        : "";
    const cost = snapshotCost(await loadPricing(ctx));
    return `create a snapshot of server ${quoteName(server.name)} (ID ${args.server_id}); the snapshot survives the deletion of the server.${running} ${cost}`;
  },
  // Upper bound for the cost limit only (05 K-30); the preview does not show it.
  monthlyCost: async (_args, ctx, server) =>
    snapshotMonthlyUpperBound(await loadPricing(ctx), server.primary_disk_size),
  handler: async (args, ctx) => {
    const labels = withScopeLabels(ctx.config, args.labels);
    const raw = await ctx.gateway.request<{ image: HetznerImage; action: HetznerAction }>(
      "POST",
      path`/servers/${args.server_id}/actions/create_image`,
      {
        body: {
          type: "snapshot",
          labels,
          ...(args.description !== undefined && { description: args.description }),
        },
        signal: ctx.signal,
      },
    );
    return {
      data: { image: toImageOut(raw.image) },
      summary: `Creating snapshot image ${raw.image.id} of server ${args.server_id}.`,
      actions: [raw.action],
    };
  },
});

const snapshotList = defineTool({
  name: "snapshot_list",
  title: "List snapshots and backups",
  description:
    "Lists snapshot and backup images of the project with size, status, labels and the server they were created from. Does not list system or app images; use the image catalog for those. Image size in GB determines the monthly cost of snapshots.",
  kind: "read",
  input: z.object({
    type: z
      .enum(["snapshot", "backup"])
      .optional()
      .describe("Only images of this type. Omit to list snapshots and backups."),
    server_id: serverIdField
      .optional()
      .describe("Only backups bound to this server ID. Snapshots are not bound to a server."),
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => !hasControlChars(v), "must not contain control characters")
      .optional()
      .describe("Only images with exactly this name."),
    label_selector: labelSelectorField.optional(),
    sort: sortField(["id", "name", "created"]),
    ...paginationShape,
  }),
  output: pageOf(imageOut),
  handler: async (args, ctx) => {
    const page = await ctx.gateway.page<HetznerImage>("/images", "images", {
      query: {
        type: args.type === undefined ? ["snapshot", "backup"] : [args.type],
        bound_to: args.server_id === undefined ? undefined : String(args.server_id),
        name: args.name,
        label_selector: args.label_selector,
        sort: args.sort,
      },
      page: args.page,
      perPage: args.per_page,
      signal: ctx.signal,
    });
    const more = page.next_page === null ? "" : "; more pages available";
    return {
      data: toPage(page, toImageOut),
      summary: `Found ${page.items.length} image(s) on page ${page.page}${more}.`,
    };
  },
});

const snapshotUpdate = defineTool({
  name: "snapshot_update",
  title: "Update a snapshot or backup",
  description:
    "Changes the description and/or replaces the complete label set of a snapshot or backup image. Only images of type snapshot and backup can be updated. Labels you send replace all existing labels, so include the ones to keep.",
  kind: "write",
  idempotent: true,
  input: z.object({
    id: imageIdField,
    description: descriptionField("New description of the image.").optional(),
    labels: labelsField.optional(),
  }),
  output: imageOut,
  target: async (args, ctx) => {
    if (args.description === undefined && args.labels === undefined) {
      throw new ToolError("bad_request", "Provide description, labels, or both.");
    }
    return loadImage(args.id, ctx);
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ image: HetznerImage }>(
      "PUT",
      path`/images/${args.id}`,
      {
        body: {
          ...(args.description !== undefined && { description: args.description }),
          ...(args.labels !== undefined && { labels: keepScopeLabels(ctx.config, args.labels) }),
        },
        signal: ctx.signal,
      },
    );
    const fields = fieldList({
      description: args.description !== undefined,
      labels: args.labels !== undefined,
    });
    return { data: toImageOut(raw.image), summary: `Updated image ${args.id}: ${fields}.` };
  },
});

const snapshotDelete = defineTool({
  name: "snapshot_delete",
  title: "Delete a snapshot or backup",
  description:
    "Permanently deletes a snapshot or backup image. Only images of type snapshot and backup can be deleted, and not while delete protection is enabled. The image cannot be recovered; servers created from it earlier are not affected.",
  kind: "destructive",
  input: z.object({
    id: imageIdField.describe("ID of the snapshot or backup image (see snapshot_list)."),
  }),
  output: z.object({
    id: z.number().int().describe("ID of the deleted image."),
    deleted: z.boolean().describe("True once Hetzner confirmed the deletion."),
  }),
  target: async (args, ctx) => loadImage(args.id, ctx),
  preview: (args, _ctx, image) => {
    const size = image.image_size === null ? "unknown size" : `${image.image_size} GB`;
    const backup =
      image.type === "backup" && image.bound_to !== null
        ? `; it is the backup of server ${image.bound_to}`
        : "";
    return `${protectionLine(image.protection.delete, "image", args.id, "snapshot_protection_set")}permanently delete ${image.type} image ${quoteName(image.name ?? image.description)} (ID ${args.id}, ${size}). It cannot be recovered${backup}.`;
  },
  handler: async (args, ctx) => {
    await ctx.gateway.request("DELETE", path`/images/${args.id}`, { signal: ctx.signal });
    return { data: { id: args.id, deleted: true }, summary: `Deleted image ${args.id}.` };
  },
});

const snapshotProtectionSet = defineTool({
  name: "snapshot_protection_set",
  title: "Set snapshot delete protection",
  description:
    "Turns delete protection of a snapshot on or off. With protection on, Hetzner refuses to delete the snapshot. Protection is never changed by other tools. Every call needs confirmation, also turning protection on, because the same tool can remove it. Works for snapshot images only; Hetzner rejects other image types.",
  kind: "destructive",
  actions: true,
  input: z.object({ id: imageIdField, protected: protectedField }),
  output: z.object({
    id: z.number().int().describe("ID of the image."),
    protection: requestedProtectionOut,
  }),
  target: async (args, ctx) => loadImage(args.id, ctx),
  preview: (args, _ctx, image) =>
    protectionPreview(
      "snapshot",
      args.id,
      quoteName(image.name ?? image.description),
      args.protected,
      image.protection.delete === args.protected,
    ),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/images/${args.id}/actions/change_protection`,
      { body: { delete: args.protected }, signal: ctx.signal },
    );
    return {
      data: { id: args.id, protection: { delete: args.protected } },
      summary: `Requested delete protection ${args.protected ? "on" : "off"} for snapshot ${args.id} (action ${raw.action.id}). Final action status is in 'actions'.`,
      actions: [raw.action],
    };
  },
});

const backupEnable = defineTool({
  name: "backup_enable",
  title: "Enable automatic backups for a server",
  description:
    "Enables the automatic daily backup option for a server, which keeps up to seven backup images. This raises the server's price by a fixed percentage (currently 20 %, see pricing) for as long as backups stay enabled. Does not create a backup immediately and returns no backup list; use snapshot_list with type backup. Requires confirmation; the preview shows the price change.",
  kind: "write",
  costs: true,
  actions: true,
  input: z.object({ server_id: serverIdField }),
  output: z.object({ server_id: z.number().int().describe("ID of the server.") }),
  target: async (args, ctx) => loadServerTarget(args.server_id, ctx),
  preview: async (args, ctx, server) => {
    const cost = backupEnableCost(await loadPricing(ctx), server);
    return `enable daily backups for server ${quoteName(server.name)} (ID ${args.server_id}); Hetzner keeps up to seven backup images. ${cost}`;
  },
  monthlyCost: async (_args, ctx, server) => backupEnableMonthly(await loadPricing(ctx), server),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/servers/${args.server_id}/actions/enable_backup`,
      { signal: ctx.signal },
    );
    return {
      data: { server_id: args.server_id },
      summary: `Enabling automatic backups for server ${args.server_id}.`,
      actions: [raw.action],
    };
  },
});

const backupDisable = defineTool({
  name: "backup_disable",
  title: "Disable automatic backups for a server",
  description:
    "Disables the automatic backup option of a server and immediately deletes ALL its existing backup images, irreversibly. Snapshots are not affected. The backup surcharge on the server price stops.",
  kind: "destructive",
  actions: true,
  input: z.object({ server_id: serverIdField }),
  output: z.object({ server_id: z.number().int().describe("ID of the server.") }),
  target: async (args, ctx) => loadServerTarget(args.server_id, ctx),
  preview: async (args, ctx, server) => {
    const backups = await ctx.gateway.page<HetznerImage>("/images", "images", {
      query: { type: "backup", bound_to: String(args.server_id) },
      perPage: 1,
      signal: ctx.signal,
    });
    const count = backups.total_entries === null ? "all" : String(backups.total_entries);
    const notEnabled =
      server.backup_window === null ? "Backups are not enabled for this server. " : "";
    return `${notEnabled}disable automatic backups for server ${quoteName(server.name)} (ID ${args.server_id}) and permanently delete ${count} existing backup image(s) of this server. This cannot be undone. Snapshots are kept.`;
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ action: HetznerAction }>(
      "POST",
      path`/servers/${args.server_id}/actions/disable_backup`,
      { signal: ctx.signal },
    );
    return {
      data: { server_id: args.server_id },
      summary: `Disabling automatic backups for server ${args.server_id}; existing backups are being deleted.`,
      actions: [raw.action],
    };
  },
});

/** Toolset storage (02-tool-specs/storage.md). */
export const storageTools: readonly ToolDefinition[] = [
  volumeList,
  volumeGet,
  volumeCreate,
  volumeAttach,
  volumeDetach,
  volumeResize,
  volumeUpdate,
  volumeDelete,
  volumeProtectionSet,
  snapshotCreate,
  snapshotList,
  snapshotUpdate,
  snapshotDelete,
  snapshotProtectionSet,
  backupEnable,
  backupDisable,
];
