// Exact decimal arithmetic, price lookup and money formatting (03 §2.2, §2.3; replaces 01 §3.6).
// Pure: no I/O, no tool texts except formatMoney(). Prices are never floats: BigInt units with a
// decimal scale; rounding (half away from zero) happens only when formatting (05 K-13).

import type { HetznerPricing, LocationPrice, PriceStrings } from "./types.js";

// --- decimals (2.2) ---------------------------------------------------------------------------

/** Exact decimal: value = units / 10^scale. Never a float. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL = /^(-)?(\d{1,15})(?:\.(\d{1,20}))?$/;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** "1.0000" → {units: 10000n, scale: 4}. Anything else (exponent, comma, blanks, empty) → undefined. */
export function parseDec(text: string): Dec | undefined {
  if (typeof text !== "string") return undefined; // API values are untyped at runtime
  const m = DECIMAL.exec(text);
  if (!m) return undefined;
  const fraction = m[3] ?? "";
  return { units: BigInt(`${m[1] ?? ""}${m[2]}${fraction}`), scale: fraction.length };
}

/** For API numbers (image_size, volume size): finite and ≥ 0, via String(n); "1e-7" etc. → undefined. */
export function decFromNumber(n: number): Dec | undefined {
  if (!Number.isFinite(n) || n < 0) return undefined;
  return parseDec(String(n));
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

export function addDec(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { units: x + y, scale };
}

export function subDec(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { units: x - y, scale };
}

export function mulDec(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** a * pct / 100, exact (scale + 2). */
export function percentDec(a: Dec, pct: Dec): Dec {
  const product = mulDec(a, pct);
  return { units: product.units, scale: product.scale + 2 };
}

/** Half away from zero at `digits` places: 1.005 → 1.01, -1.785 → -1.79, 1.0049 → 1.00. */
export function roundDec(a: Dec, digits: number): Dec {
  if (a.scale <= digits) return { units: a.units * pow10(digits - a.scale), scale: digits };
  const q = pow10(a.scale - digits);
  const negative = a.units < 0n;
  const abs = negative ? -a.units : a.units;
  let r = abs / q;
  if ((abs % q) * 2n >= q) r += 1n;
  return { units: negative ? -r : r, scale: digits };
}

/** Rounds, then prints with exactly `digits` places. "-0.00" is printed as "0.00". signed: "+" for > 0. */
export function formatDec(a: Dec, digits: number, options: { signed?: boolean } = {}): string {
  const { units } = roundDec(a, digits);
  const abs = (units < 0n ? -units : units).toString().padStart(digits + 1, "0");
  const body = digits === 0 ? abs : `${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
  if (units < 0n) return `-${body}`;
  return options.signed === true && units > 0n ? `+${body}` : body;
}

// --- money (2.3) ------------------------------------------------------------------------------

/** Net and gross of one amount, exact. */
export interface Money {
  readonly net: Dec;
  readonly gross: Dec;
}

/** undefined if either string is not a decimal. */
export function toMoney(p: PriceStrings): Money | undefined {
  const net = parseDec(p.net);
  const gross = parseDec(p.gross);
  return net && gross ? { net, gross } : undefined;
}

export function addMoney(a: Money, b: Money): Money {
  return { net: addDec(a.net, b.net), gross: addDec(a.gross, b.gross) };
}

export function subMoney(a: Money, b: Money): Money {
  return { net: subDec(a.net, b.net), gross: subDec(a.gross, b.gross) };
}

/** e.g. GB * price per GB */
export function scaleMoney(a: Money, factor: Dec): Money {
  return { net: mulDec(a.net, factor), gross: mulDec(a.gross, factor) };
}

/** e.g. server price * 20.00 %; the same percentage applies to net and gross (03 §2.3). */
export function percentMoney(a: Money, pct: Dec): Money {
  return { net: percentDec(a.net, pct), gross: percentDec(a.gross, pct) };
}

// --- lookup (2.3) -----------------------------------------------------------------------------

function hourlyAndMonthly(
  prices: readonly LocationPrice[],
  location: string,
): { hourly: Money; monthly: Money } | undefined {
  const wanted = location.toLowerCase();
  const entry = prices.find((e) => e.location.toLowerCase() === wanted);
  if (!entry) return undefined;
  const hourly = toMoney(entry.price_hourly);
  const monthly = toMoney(entry.price_monthly);
  return hourly && monthly ? { hourly, monthly } : undefined;
}

/** Matches serverType against name or String(id); location against prices[].location (both case-insensitive). */
export function serverTypePrice(
  p: HetznerPricing,
  serverType: string,
  location: string,
): { hourly: Money; monthly: Money } | undefined {
  const wanted = serverType.toLowerCase();
  const type = p.server_types.find(
    (t) => t.name.toLowerCase() === wanted || String(t.id) === serverType,
  );
  return type ? hourlyAndMonthly(type.prices, location) : undefined;
}

export function primaryIpPrice(
  p: HetznerPricing,
  type: "ipv4" | "ipv6",
  location: string,
): { hourly: Money; monthly: Money } | undefined {
  const entry = p.primary_ips.find((e) => e.type === type);
  return entry ? hourlyAndMonthly(entry.prices, location) : undefined;
}

/** volume.price_per_gb_month (not per location, SPEC). */
export function volumePerGb(p: HetznerPricing): Money | undefined {
  return toMoney(p.volume.price_per_gb_month);
}

/** image.price_per_gb_month (not per location, SPEC). */
export function snapshotPerGb(p: HetznerPricing): Money | undefined {
  return toMoney(p.image.price_per_gb_month);
}

/** server_backup.percentage */
export function backupPercent(p: HetznerPricing): Dec | undefined {
  return parseDec(p.server_backup.percentage);
}

// --- formatting (2.2, 2.3) --------------------------------------------------------------------

export type PriceUnit = "month" | "hour" | "GB/month";

const DIGITS: Readonly<Record<PriceUnit, number>> = { month: 2, hour: 4, "GB/month": 4 };

/** The currency as printed: the API value if it matches ^[A-Z]{3}$, else "?" (never assumed). */
export function currencyLabel(currency: string): string {
  return /^[A-Z]{3}$/.test(currency) ? currency : "?";
}

/** "4.51 EUR/month net (5.37 gross)"; digits by unit (2.2); currency checked against ^[A-Z]{3}$, else "?". */
export function formatMoney(
  m: Money,
  currency: string,
  unit: PriceUnit,
  options: { signed?: boolean } = {},
): string {
  const digits = DIGITS[unit];
  const net = formatDec(m.net, digits, options);
  const gross = formatDec(m.gross, digits, options);
  return `${net} ${currencyLabel(currency)}/${unit} net (${gross} gross)`;
}

// --- cost limit (01 §5.9, 03 §2.6a) -----------------------------------------------------------

export type MonthlyCost =
  | { kind: "ok"; net: Dec; currency: string } // additional recurring net cost per month; ≤ 0 = no increase
  | { kind: "unavailable" } // pricing could not be loaded (03 §2.5)
  | { kind: "unknown" }; // a needed price is missing
