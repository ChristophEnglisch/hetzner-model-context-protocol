// hetzner://pricing (03 §6.4): compact, rounded price list.

import type { McpServer } from "@modelcontextprotocol/server";
import { currencyLabel, formatDec, parseDec } from "../hetzner/pricing.js";
import type { HetznerPricing, PriceStrings } from "../hetzner/types.js";
import type { ToolContext } from "../tools/shared.js";
import { guardedRead, jsonContents } from "./shared.js";

const NOTE =
  "Rounded for display: monthly 2 decimals, hourly and per GB 4 decimals. net excludes VAT, gross includes it.";

/** Rounded decimal string; a value that is not a decimal stays as delivered. */
function round(text: string, digits: number): string {
  const dec = parseDec(text);
  return dec ? formatDec(dec, digits) : text;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Priced {
  location: string;
  price_hourly: PriceStrings;
  price_monthly: PriceStrings;
}

function locationPrices(prices: readonly Priced[]) {
  return prices
    .map((p) => ({
      location: p.location,
      monthly_net: round(p.price_monthly.net, 2),
      monthly_gross: round(p.price_monthly.gross, 2),
      hourly_net: round(p.price_hourly.net, 4),
    }))
    .sort((a, b) => byText(a.location, b.location));
}

function perGb(p: PriceStrings) {
  return { net: round(p.net, 4), gross: round(p.gross, 4) };
}

/** Pure projection of GET /pricing; included traffic, traffic prices and load balancers are left out. */
export function toPricingResource(p: HetznerPricing) {
  return {
    currency: currencyLabel(p.currency),
    vat_rate: p.vat_rate,
    note: NOTE,
    server_types: p.server_types
      .map((t) => ({ name: t.name, prices: locationPrices(t.prices) }))
      .sort((a, b) => byText(a.name, b.name)),
    primary_ips: p.primary_ips.map((e) => ({ type: e.type, prices: locationPrices(e.prices) })),
    floating_ips: p.floating_ips.map((e) => ({
      type: e.type,
      prices: e.prices
        .map((x) => ({
          location: x.location,
          monthly_net: round(x.price_monthly.net, 2),
          monthly_gross: round(x.price_monthly.gross, 2),
        }))
        .sort((a, b) => byText(a.location, b.location)),
    })),
    volume_per_gb_month: perGb(p.volume.price_per_gb_month),
    snapshot_per_gb_month: perGb(p.image.price_per_gb_month),
    backup_percentage: round(p.server_backup.percentage, 2),
  };
}

export function registerPricingResource(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "pricing",
    "hetzner://pricing",
    {
      title: "Hetzner price list",
      description:
        "Compact price list of this Hetzner Cloud project (VAT and currency of the project owner): server types per location, Primary and Floating IPs, volumes, snapshots and the backup surcharge.",
      mimeType: "application/json",
    },
    async (uri, sdk) =>
      guardedRead(ctx, "pricing", [], async () =>
        jsonContents(
          uri,
          toPricingResource(await ctx.gateway.getPricing({ signal: sdk.mcpReq.signal })),
        ),
      ),
  );
}
