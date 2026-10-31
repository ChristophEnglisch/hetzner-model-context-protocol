// 03 §2.8 pricing.test.ts (P-1..P-9): exact decimals, rounding only when formatting, lookup.
import { describe, expect, it } from "vitest";
import {
  ceilDec,
  type Dec,
  decFromNumber,
  formatDec,
  formatMoney,
  type Money,
  parseDec,
  percentDec,
  primaryIpPrice,
  scaleMoney,
  serverTypePrice,
  subDec,
  toMoney,
} from "../../src/hetzner/pricing.js";
import type { HetznerPricing } from "../../src/hetzner/types.js";
import { type DeepPartial, fixture } from "../helpers/fixtures.js";

const P0 = (overrides?: DeepPartial<HetznerPricing>): HetznerPricing =>
  fixture<{ pricing: HetznerPricing }>("get_pricing", overrides && { pricing: overrides }).pricing;

const dec = (text: string): Dec => {
  const d = parseDec(text);
  if (!d) throw new Error(`not a decimal: ${text}`);
  return d;
};
const money = (net: string, gross: string): Money => ({ net: dec(net), gross: dec(gross) });

describe("fixture get_pricing (03 §2.8)", () => {
  it("has the shape the expectations assume", () => {
    const p = P0();
    expect(p.currency).toBe("EUR");
    expect(p.vat_rate).toBe("19.00");
    expect(p.server_backup.percentage).toBe("20.00");
    expect(p.server_types.map((t) => [t.id, t.name, t.prices.map((e) => e.location)])).toEqual([
      [104, "cpx22", ["fsn1"]],
    ]);
    expect(p.primary_ips.map((e) => [e.type, e.prices.map((x) => x.location)])).toEqual([
      ["ipv4", ["fsn1"]],
    ]);
    expect(p.volume.price_per_gb_month).toEqual({ net: "1.0000", gross: "1.1900" });
    expect(p.image.price_per_gb_month).toEqual({ net: "1.0000", gross: "1.1900" });
  });
});

describe("decimals", () => {
  it("parses decimal strings and rejects everything else", () => {
    expect(parseDec("1.0000")).toEqual({ units: 10000n, scale: 4 });
    expect(parseDec("0.0071400000000000")).toEqual({ units: 71400000000000n, scale: 16 });
    expect(parseDec("12")).toEqual({ units: 12n, scale: 0 });
    for (const bad of ["1e3", "1,00", " 1.0", "", "-", "1."]) expect(parseDec(bad)).toBeUndefined();
    expect(decFromNumber(40)).toEqual({ units: 40n, scale: 0 });
    for (const bad of [1e-7, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decFromNumber(bad)).toBeUndefined();
    }
  });

  it("rounds half away from zero only when formatting", () => {
    expect(formatDec(dec("1.0050"), 2)).toBe("1.01");
    expect((1.005).toFixed(2)).toBe("1.00"); // what a float would print
    expect(formatDec(dec("1.0049"), 2)).toBe("1.00");
    expect(formatDec(dec("-1.785"), 2)).toBe("-1.79");
    expect(formatDec(dec("0.0071400000000000"), 4)).toBe("0.0071");
    expect(formatDec(dec("-0.004"), 2)).toBe("0.00");
    expect(formatDec(dec("12"), 2)).toBe("12.00");
    expect(formatDec(percentDec(dec("1.0000"), dec("20.00")), 2)).toBe("0.20");
  });

  it("multiplies without truncating long fractions", () => {
    const perGb = money("0.0523600000000000", "0.0623084000000000");
    expect(formatMoney(scaleMoney(perGb, dec("100")), "EUR", "month")).toBe(
      "5.24 EUR/month net (6.23 gross)",
    );
    // 4-place truncation after the former 01 §3.6 rule: 0.0523 * 100 = 5.23.
    expect(formatDec({ units: 523n * 100n, scale: 4 }, 2)).toBe("5.23");
  });

  it("subtracts exactly", () => {
    expect(formatDec(subDec(dec("2.9750"), dec("1.1900")), 2)).toBe("1.79");
  });

  it("formats signed amounts", () => {
    const signed = (net: string, gross: string) =>
      formatMoney(money(net, gross), "EUR", "month", { signed: true });
    expect(signed("1.5", "1.785")).toBe("+1.50 EUR/month net (+1.79 gross)");
    expect(signed("-1.5", "-1.785")).toBe("-1.50 EUR/month net (-1.79 gross)");
    expect(signed("0", "0")).toBe("0.00 EUR/month net (0.00 gross)");
  });
});

describe("lookup and formatting", () => {
  it("finds server type prices by name or id, case-insensitive", () => {
    const p = P0();
    for (const type of ["cpx22", "104", "CPX22"]) {
      const price = serverTypePrice(p, type, "FSN1");
      expect(price && formatMoney(price.monthly, p.currency, "month")).toBe(
        "1.00 EUR/month net (1.19 gross)",
      );
      expect(price && formatMoney(price.hourly, p.currency, "hour")).toBe(
        "1.0000 EUR/hour net (1.1900 gross)",
      );
    }
    expect(serverTypePrice(p, "cpx22", "nbg1")).toBeUndefined();
    expect(serverTypePrice(p, "cpx22", "1")).toBeUndefined(); // location ID matches nothing
    expect(primaryIpPrice(p, "ipv4", "fsn1")).toBeDefined();
    expect(primaryIpPrice(p, "ipv6", "fsn1")).toBeUndefined(); // missing in the fixture
  });

  it("replaces an invalid currency with ?", () => {
    const p = P0({ currency: "eur1" });
    const m = toMoney({ net: "1.0000", gross: "1.1900" });
    expect(m && formatMoney(m, p.currency, "month")).toBe("1.00 ?/month net (1.19 gross)");
  });

  it("treats a broken price string as missing", () => {
    const base = P0();
    const [type] = base.server_types;
    const [entry] = type?.prices ?? [];
    if (!type || !entry) throw new Error("fixture changed");
    const p = P0({
      server_types: [
        { ...type, prices: [{ ...entry, price_monthly: { net: "n/a", gross: "1.1900" } }] },
      ],
    });
    expect(serverTypePrice(p, "cpx22", "fsn1")).toBeUndefined();
  });

  it("rounds sizes up with ceilDec", () => {
    const up = (n: number) => {
      const d = decFromNumber(n);
      if (!d) throw new Error(`not a decimal: ${n}`);
      return formatDec(ceilDec(d, 2), 2);
    };
    expect([0.6102520576171875, 0.6, 0, 2].map(up)).toEqual(["0.62", "0.60", "0.00", "2.00"]);
  });
});
