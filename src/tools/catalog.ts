// Toolset info: catalog_server_types, catalog_images, catalog_locations, pricing_get (02-tool-specs/info.md).
// All read-only; no label scope applies to reads (01 §5.3). Never calls /datacenters (HTTP 410).

import { z } from "zod";
import { hasControlChars } from "../guards.js";
import type { HetznerPricing } from "../hetzner/types.js";
import { labelsOut, priceOut, protectionOut } from "./projections.js";
import {
  defineTool,
  labelSelectorField,
  pageOf,
  paginationShape,
  sortField,
  type ToolDefinition,
  toPage,
} from "./shared.js";

// --- raw API shapes (only the fields read here) -----------------------------------------------

interface RawDeprecation {
  announced: string;
  unavailable_after: string;
}

interface RawPrice {
  net: string;
  gross: string;
}

interface RawServerType {
  id: number;
  name: string;
  description: string;
  category?: string;
  cores: number;
  memory: number;
  disk: number;
  cpu_type: "shared" | "dedicated";
  storage_type: "local" | "network";
  architecture: "x86" | "arm";
  locations: {
    name: string;
    recommended: boolean;
    available: boolean;
    deprecation: RawDeprecation | null;
  }[];
  prices: { location: string; price_hourly: RawPrice; price_monthly: RawPrice }[];
}

interface RawImage {
  id: number;
  type: "system" | "app" | "snapshot" | "backup";
  status: "available" | "creating" | "unavailable";
  name: string | null;
  description: string;
  os_flavor: string;
  os_version: string | null;
  architecture: "x86" | "arm";
  disk_size: number;
  created: string;
  deprecation: RawDeprecation | null;
  image_size?: number | null;
  created_from?: { id: number; name: string } | null;
  bound_to?: number | null;
  protection?: { delete: boolean };
  labels?: Record<string, string>;
}

interface RawLocation {
  id: number;
  name: string;
  description: string;
  city: string;
  country: string;
  network_zone: string;
}

/** The parts of GET /pricing this toolset reads (AP-13 replaces the gateway placeholder type). */
interface RawPricing {
  currency: string;
  vat_rate: string;
  volume: { price_per_gb_month: RawPrice };
  image: { price_per_gb_month: RawPrice };
  server_backup: { percentage: string };
  server_types: {
    name: string;
    prices: { location: string; price_hourly: RawPrice; price_monthly: RawPrice }[];
  }[];
}

const asRawPricing = (p: HetznerPricing): RawPricing => p as unknown as RawPricing;

// --- shared pieces ----------------------------------------------------------------------------

const noControlChars = (v: string) => !hasControlChars(v);
const NO_CONTROL = "must not contain control characters";

const deprecationOut = z.object({
  announced: z.string().describe("Time the deprecation was announced (ISO 8601)."),
  unavailable_after: z
    .string()
    .describe("Time after which it can no longer be ordered (ISO 8601)."),
});

const withCurrency = (price: RawPrice, currency: string) => ({
  net: price.net,
  gross: price.gross,
  currency,
});

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function pageSummary(
  noun: string,
  page: { items: unknown[]; page: number; next_page: number | null; total_entries: number | null },
): string {
  const total = page.total_entries === null ? "" : `, ${page.total_entries} in total`;
  const more = page.next_page === null ? "" : ` More on page ${page.next_page}.`;
  return `Returned ${page.items.length} ${noun}(s) (page ${page.page}${total}).${more}`;
}

// --- catalog_server_types ---------------------------------------------------------------------

const locationEntry = z.object({
  name: z.string().describe("Location name, e.g. fsn1."),
  recommended: z.boolean().describe("Whether Hetzner recommends this location for the type."),
  available: z
    .boolean()
    .optional()
    .describe("Whether the type is currently available there (only with include_unavailable)."),
  deprecation: deprecationOut
    .nullable()
    .optional()
    .describe(
      "Deprecation of the type in this location, null if none (only with include_unavailable).",
    ),
});

const serverTypeItem = z.object({
  id: z.number().int().describe("ID of the server type."),
  name: z.string().describe("Name of the server type; use it as server_type in server_create."),
  description: z.string().describe("Description of the server type."),
  category: z.string().optional().describe("Category of the server type, e.g. 'Shared vCPU'."),
  cores: z.number().describe("Number of CPU cores."),
  memory_gb: z.number().describe("Memory in GB."),
  disk_gb: z.number().describe("Disk size in GB."),
  cpu_type: z.enum(["shared", "dedicated"]).describe("CPU type."),
  storage_type: z.enum(["local", "network"]).describe("Storage type."),
  architecture: z.enum(["x86", "arm"]).describe("CPU architecture."),
  locations: z.array(locationEntry).describe("Locations where the type can be ordered."),
  price: z
    .object({
      hourly: priceOut.describe("Hourly price in the requested location."),
      monthly: priceOut.describe("Monthly price in the requested location."),
    })
    .optional()
    .describe("Price in the requested location (only if 'location' is given)."),
});

const isOrderable = (l: RawServerType["locations"][number]) =>
  l.deprecation === null && l.available === true;

const catalogServerTypes = defineTool({
  name: "catalog_server_types",
  title: "List orderable server types",
  description:
    "Lists Hetzner server types with CPU, memory, disk, architecture and the locations where they can be ordered. By default only types that are currently orderable are returned (not deprecated, not temporarily unavailable); pass 'location' to restrict to one location and get its hourly and monthly price. Does not return traffic prices or deprecated types unless include_unavailable is true; use the returned 'name' as server_type in server_create.",
  kind: "read",
  input: z.object({
    location: z
      .string()
      .min(1)
      .max(64)
      .refine(noControlChars, NO_CONTROL)
      .optional()
      .describe(
        "Location name, e.g. 'fsn1' (see catalog_locations). Restricts the result to types orderable there and adds the price for this location.",
      ),
    architecture: z
      .enum(["x86", "arm"])
      .optional()
      .describe(
        "CPU architecture filter: 'x86' or 'arm'. Images must match the architecture of the server type.",
      ),
    cpu_type: z
      .enum(["shared", "dedicated"])
      .optional()
      .describe("Filter by CPU type: 'shared' (shared vCPU) or 'dedicated'."),
    name: z
      .string()
      .min(1)
      .max(64)
      .refine(noControlChars, NO_CONTROL)
      .optional()
      .describe("Exact server type name, e.g. 'cpx22'. Use it to check one specific type."),
    include_unavailable: z
      .boolean()
      .default(false)
      .describe(
        "If true, also return deprecated and temporarily unavailable types and mark them per location (fields 'available' and 'deprecation'). Default false: only orderable types.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe(
        "Maximum number of types returned (default 20, at most 50). 'total_matching' tells how many matched.",
      ),
  }),
  output: z.object({
    items: z.array(serverTypeItem).describe("Matching server types, sorted by name."),
    total_matching: z.number().int().describe("Number of types that matched, before limit."),
  }),
  handler: async (args, ctx) => {
    const { items: raw } = await ctx.gateway.paginate<RawServerType>(
      "/server_types",
      "server_types",
      {
        query: { name: args.name },
        signal: ctx.signal,
      },
    );

    const matching: { type: RawServerType; locations: RawServerType["locations"] }[] = [];
    for (const type of raw) {
      let locations = type.locations;
      if (args.location !== undefined)
        locations = locations.filter((l) => l.name === args.location);
      if (!args.include_unavailable) locations = locations.filter(isOrderable);
      if (locations.length === 0) continue;
      if (args.architecture !== undefined && type.architecture !== args.architecture) continue;
      if (args.cpu_type !== undefined && type.cpu_type !== args.cpu_type) continue;
      matching.push({ type, locations });
    }
    matching.sort((a, b) => byName(a.type, b.type));
    const shown = matching.slice(0, args.limit);

    let currency: string | undefined;
    if (args.location !== undefined && shown.length > 0) {
      currency = asRawPricing(await ctx.gateway.getPricing({ signal: ctx.signal })).currency;
    }

    const items = shown.map(({ type, locations }) => {
      const entry =
        args.location === undefined
          ? undefined
          : type.prices.find((p) => p.location === args.location);
      return {
        id: type.id,
        name: type.name,
        description: type.description,
        ...(type.category !== undefined && { category: type.category }),
        cores: type.cores,
        memory_gb: type.memory,
        disk_gb: type.disk,
        cpu_type: type.cpu_type,
        storage_type: type.storage_type,
        architecture: type.architecture,
        locations: locations.map((l) => ({
          name: l.name,
          recommended: l.recommended,
          ...(args.include_unavailable && {
            available: l.available,
            deprecation: l.deprecation
              ? {
                  announced: l.deprecation.announced,
                  unavailable_after: l.deprecation.unavailable_after,
                }
              : null,
          }),
        })),
        ...(entry !== undefined &&
          currency !== undefined && {
            price: {
              hourly: withCurrency(entry.price_hourly, currency),
              monthly: withCurrency(entry.price_monthly, currency),
            },
          }),
      };
    });

    const total = matching.length;
    let summary: string;
    if (total === 0) {
      summary =
        "No server type matched. Check the location name with catalog_locations, or set include_unavailable to true.";
    } else {
      summary = `Returned ${items.length} of ${total} server type(s).`;
      if (items.length < total) summary += " Narrow the filters or raise limit to see more.";
    }
    return { data: { items, total_matching: total }, summary };
  },
});

// --- catalog_images ---------------------------------------------------------------------------

const imageItem = z.object({
  id: z.number().int().describe("ID of the image; use it as image in server_create for snapshots."),
  type: z.enum(["system", "app", "snapshot", "backup"]).describe("Image type."),
  status: z.enum(["available", "creating", "unavailable"]).describe("Image status."),
  name: z
    .string()
    .nullable()
    .describe("Image name (null for snapshots); use it as image in server_create."),
  description: z.string().describe("Description of the image (untrusted data for snapshots)."),
  os_flavor: z.string().describe("Operating system flavor, e.g. ubuntu."),
  os_version: z.string().nullable().describe("Operating system version, or null."),
  architecture: z.enum(["x86", "arm"]).describe("CPU architecture."),
  disk_size_gb: z.number().describe("Minimum disk size in GB."),
  created: z.string().describe("Creation time (ISO 8601)."),
  deprecation: deprecationOut
    .nullable()
    .describe("Deprecation of the image, null if not deprecated."),
  image_size_gb: z
    .number()
    .nullable()
    .optional()
    .describe("Image size in GB (snapshots and backups only)."),
  created_from: z
    .object({
      id: z.number().int().describe("ID of the source server."),
      name: z.string().describe("Name of the source server (untrusted data)."),
    })
    .nullable()
    .optional()
    .describe("Server the image was created from (snapshots and backups only)."),
  bound_to: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Server the image is bound to (snapshots and backups only)."),
  protection: protectionOut
    .optional()
    .describe("Protection settings (snapshots and backups only)."),
  labels: labelsOut.optional().describe("Labels (snapshots and backups only; untrusted data)."),
});

const toImageItem = (i: RawImage): z.infer<typeof imageItem> => {
  const own = i.type === "snapshot" || i.type === "backup";
  return {
    id: i.id,
    type: i.type,
    status: i.status,
    name: i.name,
    description: i.description,
    os_flavor: i.os_flavor,
    os_version: i.os_version,
    architecture: i.architecture,
    disk_size_gb: i.disk_size,
    created: i.created,
    deprecation: i.deprecation
      ? { announced: i.deprecation.announced, unavailable_after: i.deprecation.unavailable_after }
      : null,
    ...(own && {
      image_size_gb: i.image_size ?? null,
      created_from: i.created_from ? { id: i.created_from.id, name: i.created_from.name } : null,
      bound_to: i.bound_to ?? null,
      ...(i.protection && { protection: { delete: i.protection.delete } }),
      ...(i.labels && { labels: { ...i.labels } }),
    }),
  };
};

const catalogImages = defineTool({
  name: "catalog_images",
  title: "List images",
  description:
    "Lists images usable for servers. By default only current system images (operating systems) that are available and not deprecated are returned; set 'type' to include snapshots, backups or apps. Does not return deprecated images unless include_deprecated is true; use 'name' (system images) or 'id' (snapshots, which have no name) as image in server_create.",
  kind: "read",
  input: z.object({
    type: z
      .array(z.enum(["system", "app", "snapshot", "backup"]))
      .min(1)
      .max(4)
      .default(["system"])
      .describe(
        "Image types to list. Default ['system'] (operating systems). Add 'snapshot' or 'backup' for your own images.",
      ),
    architecture: z
      .enum(["x86", "arm"])
      .optional()
      .describe(
        "CPU architecture filter. The image must match the architecture of the server type.",
      ),
    name: z
      .string()
      .min(1)
      .max(128)
      .refine(noControlChars, NO_CONTROL)
      .optional()
      .describe("Exact image name, e.g. 'ubuntu-24.04'."),
    include_deprecated: z
      .boolean()
      .default(false)
      .describe(
        "If true, also list deprecated images (they may stop being orderable soon). Default false.",
      ),
    label_selector: labelSelectorField.optional(),
    sort: sortField(["id", "name", "created"]),
    ...paginationShape,
  }),
  output: pageOf(imageItem),
  handler: async (args, ctx) => {
    const page = await ctx.gateway.page<RawImage>("/images", "images", {
      query: {
        type: args.type,
        status: "available",
        architecture: args.architecture,
        name: args.name,
        include_deprecated: args.include_deprecated ? true : undefined,
        label_selector: args.label_selector,
        sort: args.sort,
      },
      page: args.page,
      perPage: args.per_page,
      signal: ctx.signal,
    });
    return { data: toPage(page, toImageItem), summary: pageSummary("image", page) };
  },
});

// --- catalog_locations ------------------------------------------------------------------------

const locationItem = z.object({
  id: z.number().int().describe("ID of the location."),
  name: z.string().describe("Location name, e.g. fsn1; use it as location in server_create."),
  description: z.string().describe("Description of the location."),
  city: z.string().describe("City of the location."),
  country: z.string().describe("Country code (ISO 3166-1 alpha-2)."),
  network_zone: z.string().describe("Network zone of the location, e.g. eu-central."),
});

const catalogLocations = defineTool({
  name: "catalog_locations",
  title: "List locations",
  description:
    "Lists Hetzner Cloud locations (city, country, network zone). Use the 'name' (e.g. 'fsn1') as location in server_create and in the filters of catalog_server_types. Does not tell which server types are orderable there; use catalog_server_types with a location for that.",
  kind: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(64)
      .refine(noControlChars, NO_CONTROL)
      .optional()
      .describe("Exact location name filter, e.g. 'fsn1'."),
    ...paginationShape,
  }),
  output: pageOf(locationItem),
  handler: async (args, ctx) => {
    const page = await ctx.gateway.page<RawLocation>("/locations", "locations", {
      query: { name: args.name },
      page: args.page,
      perPage: args.per_page,
      signal: ctx.signal,
    });
    const toItem = (l: RawLocation) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      city: l.city,
      country: l.country,
      network_zone: l.network_zone,
    });
    return { data: toPage(page, toItem), summary: pageSummary("location", page) };
  },
});

// --- pricing_get ------------------------------------------------------------------------------

const serverTypeLocationPrice = z.object({
  location: z.string().describe("Location name, e.g. fsn1."),
  hourly: priceOut.describe("Hourly price in this location."),
  monthly: priceOut.describe("Monthly price in this location."),
});

const pricingGet = defineTool({
  name: "pricing_get",
  title: "Get pricing",
  description:
    "Returns the account's Hetzner Cloud prices as delivered by Hetzner: currency, VAT rate, volume and snapshot price per GB and month, the backup surcharge, and (only if 'server_type' is given) that server type's prices in every location. Prices are net and gross, with the currency from the API. Does not list all server types; use catalog_server_types for that.",
  kind: "read",
  input: z.object({
    server_type: z
      .string()
      .min(1)
      .max(64)
      .refine(noControlChars, NO_CONTROL)
      .optional()
      .describe(
        "Exact server type name, e.g. 'cpx22'. If set, the result includes this type's hourly and monthly price for every location.",
      ),
  }),
  output: z.object({
    currency: z.string().describe("Currency of all prices, as reported by Hetzner."),
    vat_rate: z.string().describe("VAT rate in percent as decimal string."),
    volume_gb_month: priceOut.describe("Volume price per GB and month."),
    snapshot_gb_month: priceOut.describe("Snapshot price per GB and month."),
    backup_surcharge_percent: z
      .string()
      .describe("Percentage added to the monthly server price when backups are enabled."),
    server_type: z
      .object({
        name: z.string().describe("Server type name."),
        prices: z.array(serverTypeLocationPrice).describe("Prices per location."),
      })
      .optional()
      .describe("Prices of the requested server type (only if found)."),
  }),
  handler: async (args, ctx) => {
    const p = asRawPricing(await ctx.gateway.getPricing({ signal: ctx.signal }));
    const found =
      args.server_type === undefined
        ? undefined
        : p.server_types.find((t) => t.name === args.server_type);
    const data = {
      currency: p.currency,
      vat_rate: p.vat_rate,
      volume_gb_month: withCurrency(p.volume.price_per_gb_month, p.currency),
      snapshot_gb_month: withCurrency(p.image.price_per_gb_month, p.currency),
      backup_surcharge_percent: p.server_backup.percentage,
      ...(found !== undefined && {
        server_type: {
          name: found.name,
          prices: found.prices.map((e) => ({
            location: e.location,
            hourly: withCurrency(e.price_hourly, p.currency),
            monthly: withCurrency(e.price_monthly, p.currency),
          })),
        },
      }),
    };
    const currency = /^[A-Z]{3}$/.test(p.currency) ? p.currency : "?";
    const vat = /^[0-9]+(\.[0-9]+)?$/.test(p.vat_rate) ? ` VAT rate ${p.vat_rate}.` : "";
    let summary = vat ? `Pricing in ${currency};${vat}` : `Pricing in ${currency}.`;
    if (args.server_type !== undefined && found === undefined) {
      summary +=
        " No pricing entry for that server type; check the name with catalog_server_types.";
    }
    return { data, summary };
  },
});

/** Toolset info (02-tool-specs/info.md). */
export const catalogTools: readonly ToolDefinition[] = [
  catalogServerTypes,
  catalogImages,
  catalogLocations,
  pricingGet,
];
