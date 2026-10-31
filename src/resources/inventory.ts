// hetzner://inventory (03 §6.2): counts, IDs, enums and sizes only; never a name or a label.

import type { McpServer } from "@modelcontextprotocol/server";
import { addDec, type Dec, decFromNumber, formatDec } from "../hetzner/pricing.js";
import type { HetznerServer } from "../hetzner/types.js";
import type { ToolContext } from "../tools/shared.js";
import { guardedRead, jsonContents } from "./shared.js";

const ID_LIST_CAP = 20;

interface IdLike {
  id: number;
}
interface RawVolume extends IdLike {
  assignee?: unknown;
}
interface RawImage {
  image_size?: number | null;
}
interface RawFirewall extends IdLike {
  applied_to?: unknown[];
}
interface RawPrimaryIp extends IdLike {
  assignee_id?: number | null;
}
interface RawFloatingIp extends IdLike {
  server?: number | null;
}

interface Unattached {
  total: number;
  ids: number[];
}

/** Ascending, at most 20 entries; the count covers all of them. */
function pick<T extends IdLike>(items: readonly T[], predicate: (item: T) => boolean): Unattached {
  const hits = items.filter(predicate).map((i) => i.id);
  hits.sort((a, b) => a - b);
  return { total: hits.length, ids: hits.slice(0, ID_LIST_CAP) };
}

/** Status is an API enum; anything outside [a-z_] is reported as "unknown" so no free text slips in. */
function statusKey(status: unknown): string {
  return typeof status === "string" && /^[a-z_]{1,32}$/.test(status) ? status : "unknown";
}

export function registerInventoryResource(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "inventory",
    "hetzner://inventory",
    {
      title: "Hetzner project inventory",
      description:
        "Counts of the resources in this Hetzner Cloud project by type, with the IDs of cost-relevant ones (servers off, unattached volumes, unassigned IPs). Contains no names or labels.",
      mimeType: "application/json",
    },
    async (uri, sdk) =>
      guardedRead(ctx, "inventory", [], async () => {
        const signal = sdk.mcpReq.signal;
        const { gateway } = ctx;
        const total = (path: string, key: string) =>
          gateway.page<unknown>(path, key, { perPage: 1, signal }).then((p) => p.total_entries);
        // One failing request fails the whole resource (no partial answer, 03 §7).
        const [
          servers,
          volumes,
          images,
          firewalls,
          primaryIps,
          floatingIps,
          sshKeys,
          networks,
          lbs,
        ] = await Promise.all([
          gateway.paginate<HetznerServer>("/servers", "servers", { signal }),
          gateway.paginate<RawVolume>("/volumes", "volumes", { signal }),
          gateway.paginate<RawImage>("/images", "images", {
            query: { type: "snapshot" },
            signal,
          }),
          gateway.paginate<RawFirewall>("/firewalls", "firewalls", { signal }),
          gateway.paginate<RawPrimaryIp>("/primary_ips", "primary_ips", { signal }),
          gateway.paginate<RawFloatingIp>("/floating_ips", "floating_ips", { signal }),
          total("/ssh_keys", "ssh_keys"),
          total("/networks", "networks"),
          total("/load_balancers", "load_balancers"),
        ]);

        const byStatus: Record<string, number> = {};
        for (const s of servers.items) {
          const key = statusKey(s.status);
          byStatus[key] = (byStatus[key] ?? 0) + 1;
        }
        const off = pick(servers.items, (s) => s.status === "off");
        const unattached = pick(volumes.items, (v) => v.assignee === null);
        const unapplied = pick(
          firewalls.items,
          (f) => Array.isArray(f.applied_to) && f.applied_to.length === 0,
        );
        const unassignedPrimary = pick(primaryIps.items, (p) => p.assignee_id === null);
        const unassignedFloating = pick(floatingIps.items, (f) => f.server === null);

        let size: Dec = { units: 0n, scale: 0 };
        for (const image of images.items) {
          const part =
            typeof image.image_size === "number" ? decFromNumber(image.image_size) : undefined;
          if (part) size = addDec(size, part);
        }

        const truncated = (
          [
            ["servers", servers],
            ["volumes", volumes],
            ["snapshots", images],
            ["firewalls", firewalls],
            ["primary_ips", primaryIps],
            ["floating_ips", floatingIps],
          ] as const
        )
          .filter(([, list]) => list.truncated)
          .map(([key]) => key);

        return jsonContents(uri, {
          project: ctx.config.projects[0].name,
          servers: { total: servers.items.length, by_status: byStatus, off_ids: off.ids },
          volumes: {
            total: volumes.items.length,
            unattached: unattached.total,
            unattached_ids: unattached.ids,
          },
          snapshots: { total: images.items.length, total_image_size_gb: formatDec(size, 2) },
          firewalls: {
            total: firewalls.items.length,
            unapplied: unapplied.total,
            unapplied_ids: unapplied.ids,
          },
          primary_ips: {
            total: primaryIps.items.length,
            unassigned: unassignedPrimary.total,
            unassigned_ids: unassignedPrimary.ids,
          },
          floating_ips: {
            total: floatingIps.items.length,
            unassigned: unassignedFloating.total,
            unassigned_ids: unassignedFloating.ids,
          },
          ssh_keys: { total: sshKeys },
          networks: { total: networks },
          load_balancers: { total: lbs },
          truncated,
          id_lists_capped_at: ID_LIST_CAP,
        });
      }),
  );
}
