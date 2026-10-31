// Cost lines for previews and amounts for the cost limit (03 §2.5, §2.6, §2.6a). Calculates only and
// knows no tool. Per operation there is ONE internal calculation (`…Calc`) after 03 §2.4: the cost
// line formats its result, the amount function returns its net value as MonthlyCost (D-10).

import { mapHetznerError } from "../hetzner/errors.js";
import {
  addMoney,
  backupPercent,
  currencyLabel,
  type Dec,
  decFromNumber,
  formatDec,
  formatMoney,
  type Money,
  type MonthlyCost,
  percentMoney,
  primaryIpPrice,
  scaleMoney,
  serverTypePrice,
  snapshotPerGb,
  subMoney,
  volumePerGb,
} from "../hetzner/pricing.js";
import type { HetznerPricing } from "../hetzner/types.js";
import { type PreviewContext, quoteName } from "../tools/shared.js";

// --- loading (2.5) ----------------------------------------------------------------------------

/** Never throws, except when the caller cancelled the request. */
export async function loadPricing(ctx: PreviewContext): Promise<HetznerPricing | undefined> {
  try {
    return await ctx.gateway.getPricing({ signal: ctx.signal });
  } catch (error) {
    if (ctx.signal.aborted) throw error; // client cancelled → 'cancelled' (01 §4.5)
    ctx.logger.debug("pricing_unavailable", { kind: mapHetznerError(error).kind });
    return undefined;
  }
}

// --- fixed texts (2.6) ------------------------------------------------------------------------

export const COST_UNAVAILABLE =
  "Estimated cost: unavailable (Hetzner pricing could not be loaded); check pricing_get before confirming.";
export const SAVINGS_UNAVAILABLE = "Savings: unavailable (Hetzner pricing could not be loaded).";
/** 2.6: the `undefined` text of volumeResizeCost, serverChangeTypeCost and backupEnableCost. */
export const PRICE_CHANGE_UNAVAILABLE =
  "Price change: unavailable (Hetzner pricing could not be loaded).";

export interface ServerLike {
  // structural; the raw server object from target() satisfies it
  server_type: { name: string };
  location: { name: string };
  backup_window: string | null;
  status: string;
  volumes?: readonly number[];
  public_net: {
    ipv4: { id?: number } | null;
    ipv6: { id?: number } | null;
    floating_ips: readonly number[];
  };
}

// --- one internal calculation per operation (2.4) ---------------------------------------------

/** Result of an internal calculation: the reason names the FIRST missing part (2.5). */
type Calc<T> = { kind: "unavailable" } | { kind: "unknown"; reason: string } | ({ kind: "ok" } & T);

const UNAVAILABLE = { kind: "unavailable" } as const;
const unknown = (reason: string) => ({ kind: "unknown", reason }) as const;
const noServerPrice = (type: string, location: string) =>
  unknown(
    `Hetzner lists no price for server type ${quoteName(type)} in location ${quoteName(location)}`,
  );
const NO_VOLUME_PRICE = unknown("Hetzner lists no volume price");
const NO_SNAPSHOT_PRICE = unknown("Hetzner lists no snapshot price");
/** Not in 03 §2.6: backups are on but server_backup.percentage is not a decimal (reported as open question). */
const NO_BACKUP_PRICE = unknown("Hetzner lists no backup surcharge");

const hasBackups = (s: ServerLike): boolean => s.backup_window !== null;

/** Backup percentage if backups are on (`B`, 2.4); undefined without backups; missing if not a decimal. */
function backupsOf(p: HetznerPricing, s: ServerLike): Calc<{ pct: Dec | undefined }> {
  if (!hasBackups(s)) return { kind: "ok", pct: undefined };
  const pct = backupPercent(p);
  return pct ? { kind: "ok", pct } : NO_BACKUP_PRICE;
}

/** `S·(1 + B/100)` with backups, else `S` (2.4). */
const withSurcharge = (m: Money, pct: Dec | undefined): Money =>
  pct ? addMoney(m, percentMoney(m, pct)) : m;

export interface ServerCreateArgs {
  server_type: string;
  location: string; // location is required in server_create (05 K-14)
  public_net?: { enable_ipv4?: boolean; enable_ipv6?: boolean }; // 1.0 offers no Primary IP IDs (05 K-14)
}

/** 2.4: Hetzner does not charge Primary IPv6, so /pricing has no ipv6 entry; that alone means 0 (06 OE-48). */
const IPV6_NOT_LISTED = "IPv6: no charge listed by Hetzner.";
const listsIpv6 = (p: HetznerPricing): boolean => p.primary_ips.some((e) => e.type === "ipv6");

function serverCreateCalc(
  p: HetznerPricing | undefined,
  a: ServerCreateArgs,
): Calc<{
  server: { hourly: Money; monthly: Money };
  ip4?: Money;
  ip6?: Money;
  ip6Unlisted: boolean;
  total: Money;
}> {
  if (!p) return UNAVAILABLE;
  const server = serverTypePrice(p, a.server_type, a.location);
  if (!server) return noServerPrice(a.server_type, a.location);
  let total = server.monthly;
  let ip4: Money | undefined;
  let ip6: Money | undefined;
  if (a.public_net?.enable_ipv4 !== false) {
    ip4 = primaryIpPrice(p, "ipv4", a.location)?.monthly;
    if (!ip4) {
      return unknown(
        `Hetzner lists no price for a Primary IPv4 in location ${quoteName(a.location)}`,
      );
    }
    total = addMoney(total, ip4);
  }
  let ip6Unlisted = false;
  if (a.public_net?.enable_ipv6 !== false) {
    if (!listsIpv6(p)) {
      ip6Unlisted = true; // IP6 = 0: the total stays, the line says why
    } else {
      ip6 = primaryIpPrice(p, "ipv6", a.location)?.monthly;
      if (!ip6) {
        return unknown(
          `Hetzner lists no price for a Primary IPv6 in location ${quoteName(a.location)}`,
        );
      }
      total = addMoney(total, ip6);
    }
  }
  return { kind: "ok", server, total, ip6Unlisted, ...(ip4 && { ip4 }), ...(ip6 && { ip6 }) };
}

function serverDeleteCalc(
  p: HetznerPricing | undefined,
  s: ServerLike,
): Calc<{ monthly: Money; pct: Dec | undefined }> {
  if (!p) return UNAVAILABLE;
  const price = serverTypePrice(p, s.server_type.name, s.location.name);
  if (!price) return noServerPrice(s.server_type.name, s.location.name);
  const backups = backupsOf(p, s);
  if (backups.kind !== "ok") return backups;
  return { kind: "ok", monthly: withSurcharge(price.monthly, backups.pct), pct: backups.pct };
}

function serverChangeTypeCalc(
  p: HetznerPricing | undefined,
  s: ServerLike,
  newType: string,
): Calc<{ before: Money; after: Money; delta: Money; pct: Dec | undefined }> {
  if (!p) return UNAVAILABLE;
  const location = s.location.name;
  const oldPrice = serverTypePrice(p, s.server_type.name, location);
  if (!oldPrice) return noServerPrice(s.server_type.name, location);
  const newPrice = serverTypePrice(p, newType, location);
  if (!newPrice) return noServerPrice(newType, location);
  const backups = backupsOf(p, s);
  if (backups.kind !== "ok") return backups;
  const before = withSurcharge(oldPrice.monthly, backups.pct);
  const after = withSurcharge(newPrice.monthly, backups.pct);
  return { kind: "ok", before, after, delta: subMoney(after, before), pct: backups.pct };
}

function volumeCalc(p: HetznerPricing, sizeGb: number): Calc<{ perGb: Money; total: Money }> {
  const perGb = volumePerGb(p);
  const size = decFromNumber(sizeGb);
  if (!perGb || !size) return NO_VOLUME_PRICE;
  return { kind: "ok", perGb, total: scaleMoney(perGb, size) };
}

function volumeCreateCalc(p: HetznerPricing | undefined, sizeGb: number) {
  if (!p) return UNAVAILABLE;
  return volumeCalc(p, sizeGb);
}

function volumeResizeCalc(
  p: HetznerPricing | undefined,
  oldGb: number,
  newGb: number,
): Calc<{ before: Money; after: Money; delta: Money }> {
  if (!p) return UNAVAILABLE;
  const before = volumeCalc(p, oldGb);
  if (before.kind !== "ok") return before;
  const after = volumeCalc(p, newGb);
  if (after.kind !== "ok") return after;
  return {
    kind: "ok",
    before: before.total,
    after: after.total,
    delta: subMoney(after.total, before.total),
  };
}

function backupEnableCalc(
  p: HetznerPricing | undefined,
  s: ServerLike,
): Calc<{ base: Money; surcharge: Money; pct: Dec }> | { kind: "already" } {
  if (hasBackups(s)) return { kind: "already" }; // 2.6 case 1: no pricing needed
  if (!p) return UNAVAILABLE;
  const price = serverTypePrice(p, s.server_type.name, s.location.name);
  if (!price) return noServerPrice(s.server_type.name, s.location.name);
  const pct = backupPercent(p);
  if (!pct) return NO_BACKUP_PRICE;
  return { kind: "ok", base: price.monthly, surcharge: percentMoney(price.monthly, pct), pct };
}

function snapshotCalc(p: HetznerPricing | undefined): Calc<{ perGb: Money }> {
  if (!p) return UNAVAILABLE;
  const perGb = snapshotPerGb(p);
  return perGb ? { kind: "ok", perGb } : NO_SNAPSHOT_PRICE;
}

// --- cost lines (2.6, wording verbatim) -------------------------------------------------------

const month = (m: Money, p: HetznerPricing, signed = false) =>
  formatMoney(m, p.currency, "month", { signed });
const withBackups = (pct: Dec | undefined) =>
  pct ? `, including backups (+${formatDec(pct, 2)} %)` : "";
const change = (p: HetznerPricing, delta: Money, before: Money, after: Money) =>
  `Price change: ${month(delta, p, true)}: from ${formatDec(before.net, 2)} to ${formatDec(after.net, 2)} ${currencyLabel(p.currency)}/month net`;

export function serverCreateCost(p: HetznerPricing | undefined, a: ServerCreateArgs): string {
  const c = serverCreateCalc(p, a);
  if (c.kind === "unavailable" || !p) return COST_UNAVAILABLE;
  if (c.kind === "unknown") return `Estimated cost: unknown (${c.reason}).`;
  const parts = [`server ${month(c.server.monthly, p)}`];
  if (c.ip4) parts.push(`new Primary IPv4 ${month(c.ip4, p)}`);
  if (c.ip6) parts.push(`new Primary IPv6 ${month(c.ip6, p)}`);
  const hourly = formatMoney(c.server.hourly, p.currency, "hour");
  const ip6Note = c.ip6Unlisted ? ` ${IPV6_NOT_LISTED}` : "";
  return `Estimated cost: ${month(c.total, p)} = ${parts.join(" + ")}.${ip6Note} Server hourly price: ${hourly}.`;
}

export function serverDeleteSavings(p: HetznerPricing | undefined, s: ServerLike): string {
  const c = serverDeleteCalc(p, s);
  if (c.kind === "unavailable" || !p) return SAVINGS_UNAVAILABLE;
  if (c.kind === "unknown") return `Savings: unknown (${c.reason}).`;
  return `Saves ${month(c.monthly, p)}${withBackups(c.pct)}.`;
}

/** Pricing-independent. */
export function remainingAfterDelete(s: ServerLike): string {
  const parts: string[] = [];
  const volumes = s.volumes?.length ?? 0;
  if (volumes > 0) parts.push(`${volumes} volume(s) (detached)`);
  const floating = s.public_net.floating_ips.length;
  if (floating > 0) parts.push(`${floating} Floating IP(s) (detached)`);
  const v4 = s.public_net.ipv4 !== null;
  const v6 = s.public_net.ipv6 !== null;
  if (v4 && v6) parts.push("its Primary IPv4 and IPv6 unless auto_delete is enabled on them");
  else if (v4) parts.push("its Primary IPv4 unless auto_delete is enabled on it");
  else if (v6) parts.push("its Primary IPv6 unless auto_delete is enabled on it");
  parts.push("snapshots created from it");
  return `Not deleted and still billed if present: ${parts.join("; ")}.`;
}

export function serverChangeTypeCost(
  p: HetznerPricing | undefined,
  s: ServerLike,
  newType: string,
): string {
  const c = serverChangeTypeCalc(p, s, newType);
  if (c.kind === "unavailable" || !p) return PRICE_CHANGE_UNAVAILABLE;
  if (c.kind === "unknown") return `Price change: unknown (${c.reason}).`;
  return `${change(p, c.delta, c.before, c.after)}${withBackups(c.pct)}.`;
}

export function volumeCreateCost(p: HetznerPricing | undefined, sizeGb: number): string {
  const c = volumeCreateCalc(p, sizeGb);
  if (c.kind === "unavailable" || !p) return COST_UNAVAILABLE;
  if (c.kind === "unknown") return `Estimated cost: unknown (${c.reason}).`;
  const perGb = formatMoney(c.perGb, p.currency, "GB/month");
  return `Estimated cost: ${month(c.total, p)} for ${sizeGb} GB at ${perGb}.`;
}

export function volumeResizeCost(
  p: HetznerPricing | undefined,
  oldGb: number,
  newGb: number,
): string {
  const c = volumeResizeCalc(p, oldGb, newGb);
  if (c.kind === "unavailable" || !p) return PRICE_CHANGE_UNAVAILABLE;
  if (c.kind === "unknown") return `Price change: unknown (${c.reason}).`;
  return `${change(p, c.delta, c.before, c.after)}.`;
}

export function backupEnableCost(p: HetznerPricing | undefined, s: ServerLike): string {
  const c = backupEnableCalc(p, s);
  if (c.kind === "already") {
    return "Backups are already enabled (backup window set); the price does not change.";
  }
  if (c.kind === "unavailable" || !p) return PRICE_CHANGE_UNAVAILABLE;
  if (c.kind === "unknown") return `Price change: unknown (${c.reason}).`;
  return `Price change: ${month(c.surcharge, p, true)}, ${formatDec(c.pct, 2)} % of the server price of ${month(c.base, p)}.`;
}

export function snapshotCost(p: HetznerPricing | undefined): string {
  const c = snapshotCalc(p);
  if (c.kind === "unavailable" || !p) return COST_UNAVAILABLE;
  if (c.kind === "unknown") return `Estimated cost: unknown (${c.reason}).`;
  const perGb = formatMoney(c.perGb, p.currency, "GB/month");
  return `Estimated cost: ${perGb} per GB of snapshot size; Hetzner reports the size (image_size) after creation.`;
}

// --- amount functions for the cost limit (2.6a) -----------------------------------------------

const ZERO: Dec = { units: 0n, scale: 0 };

/** Maps an internal calculation to MonthlyCost; `net` picks the value the line shows as total/Δ. */
function amount<T>(
  p: HetznerPricing | undefined,
  c: Calc<T>,
  net: (ok: { kind: "ok" } & T) => Dec,
): MonthlyCost {
  if (c.kind === "unavailable" || !p) return { kind: "unavailable" };
  if (c.kind === "unknown") return { kind: "unknown" };
  return { kind: "ok", net: net(c), currency: p.currency };
}

export function serverCreateMonthly(
  p: HetznerPricing | undefined,
  a: Parameters<typeof serverCreateCost>[1],
): MonthlyCost {
  return amount(p, serverCreateCalc(p, a), (c) => c.total.net);
}

export function serverChangeTypeMonthly(
  p: HetznerPricing | undefined,
  s: ServerLike,
  newType: string,
): MonthlyCost {
  return amount(p, serverChangeTypeCalc(p, s, newType), (c) => c.delta.net);
}

export function volumeCreateMonthly(p: HetznerPricing | undefined, sizeGb: number): MonthlyCost {
  return amount(p, volumeCreateCalc(p, sizeGb), (c) => c.total.net);
}

export function volumeResizeMonthly(
  p: HetznerPricing | undefined,
  oldGb: number,
  newGb: number,
): MonthlyCost {
  return amount(p, volumeResizeCalc(p, oldGb, newGb), (c) => c.delta.net);
}

export function backupEnableMonthly(p: HetznerPricing | undefined, s: ServerLike): MonthlyCost {
  const c = backupEnableCalc(p, s);
  if (c.kind === "already") return { kind: "ok", net: ZERO, currency: p?.currency ?? "" };
  return amount(p, c, (ok) => ok.surcharge.net);
}

/** Upper bound for the limit only: primaryDiskGb × image.price_per_gb_month (01 OP-19, 05 K-30). */
export function snapshotMonthlyUpperBound(
  p: HetznerPricing | undefined,
  primaryDiskGb: number,
): MonthlyCost {
  const c = snapshotCalc(p);
  const size = decFromNumber(primaryDiskGb);
  if (c.kind === "ok" && !size) return { kind: "unknown" };
  return amount(p, c, (ok) => scaleMoney(ok.perGb, size ?? ZERO).net);
}
