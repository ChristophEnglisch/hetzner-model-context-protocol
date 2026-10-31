import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolContext } from "../tools/shared.js";
import { DATA_NOTICE, missingToolHint, promptResult, q } from "./shared.js";

export function registerReviewCosts(server: McpServer, ctx: ToolContext): void {
  server.registerPrompt(
    "review_costs",
    {
      title: "Review costs",
      description:
        "Read-only review of what the Hetzner Cloud project costs per month, with a list of savings candidates (unused volumes, idle servers, old snapshots, backups).",
      argsSchema: z.object({
        snapshot_age_days: z
          .string()
          .regex(/^\d{1,4}$/)
          .optional()
          .describe("Snapshots older than this many days are reported as candidates (default 30)."),
      }),
    },
    ({ snapshot_age_days }) => {
      const project = q(ctx.config.projects[0].name);
      const days = snapshot_age_days ?? "30";
      const text = `Review the monthly costs of the Hetzner Cloud project ${project} and propose savings. Do not change or delete anything.

${DATA_NOTICE}
${missingToolHint("volume_list or snapshot_list", "storage")} Report which checks you could not perform because of this.

Prices: call pricing_get once. Report every amount per month as net and gross in the currency Hetzner returns; never assume a currency. Server prices depend on server type and location. Mark all amounts you compute as estimates.

1. server_list (page through all results): every server with server type, location and status. For servers with status off, ask whether they are still needed; do not claim that powering a server off saves money. Servers with backups enabled (backup_window is set) cost the server price plus server_backup.percentage from pricing_get.
2. volume_list: volumes without an assignee are not attached to any server and still cost volume.price_per_gb_month for every GB.
3. snapshot_list: snapshots older than ${days} day(s) with their image_size; snapshots cost image.price_per_gb_month per GB of image_size.
4. Primary IPs and Floating IPs cannot be listed with the tools of this server. If the user attached the resource hetzner://inventory, use its primary_ips and floating_ips entries (unassigned IDs); otherwise tell the user to check unassigned IPs in the Hetzner Console.

Present a table of savings candidates: resource type and ID, why it is a candidate, estimated monthly amount (net and gross), and the action that would end the cost (for example delete, or disable backups). Sort by amount, largest first, and give the total. Do not delete anything: destructive steps need the user's explicit approval later and run with confirm: true only after that.`;
      return promptResult(`Cost review of project ${ctx.config.projects[0].name}`, text);
    },
  );
}
