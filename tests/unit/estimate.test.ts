// 03 §2.8 estimate.test.ts (E-1..E-27 without the dropped E-6): cost lines verbatim from 03 §2.6
// and the amount functions of 03 §2.6a. The fixture is checked in pricing.test.ts; deviations are
// set here by override, never by changing an expectation.
import { describe, expect, it } from "vitest";
import { formatDec, type MonthlyCost } from "../../src/hetzner/pricing.js";
import type { HetznerPricing } from "../../src/hetzner/types.js";
import { createLogger } from "../../src/logging.js";
import {
  backupEnableCost,
  backupEnableMonthly,
  COST_UNAVAILABLE,
  loadPricing,
  remainingAfterDelete,
  SAVINGS_UNAVAILABLE,
  type ServerLike,
  serverChangeTypeCost,
  serverChangeTypeMonthly,
  serverCreateCost,
  serverCreateMonthly,
  serverDeleteSavings,
  snapshotCost,
  snapshotMonthlyUpperBound,
  volumeCreateCost,
  volumeCreateMonthly,
  volumeResizeCost,
  volumeResizeMonthly,
} from "../../src/pricing/estimate.js";
import type { PreviewContext } from "../../src/tools/shared.js";
import { apiError, FakeHetzner, ok } from "../helpers/fake-hetzner.js";
import { makeConfig } from "../helpers/fakes.js";
import { type DeepPartial, fixture } from "../helpers/fixtures.js";
import { logFields } from "../helpers/harness.js";

const P0 = (overrides?: DeepPartial<HetznerPricing>): HetznerPricing =>
  fixture<{ pricing: HetznerPricing }>("get_pricing", overrides && { pricing: overrides }).pricing;

const zeroIpv6 = {
  type: "ipv6" as const,
  prices: [
    {
      location: "fsn1",
      price_hourly: { net: "0.0000", gross: "0.0000" },
      price_monthly: { net: "0.0000", gross: "0.0000" },
    },
  ],
};
/** E-4: P0 + primary_ips[1] = IPv6 at 0.0000. */
const withIpv6 = (): HetznerPricing => {
  const p = P0();
  return { ...p, primary_ips: [...p.primary_ips, zeroIpv6] };
};
/** E-13: P0 + server_types[1] = cpx32 at 2.5000 / 2.9750 in fsn1. */
const withCpx32 = (): HetznerPricing => {
  const p = P0();
  const cpx32 = {
    id: 105,
    name: "cpx32",
    prices: [
      {
        location: "fsn1",
        included_traffic: 654321,
        price_hourly: { net: "0.0040", gross: "0.0048" },
        price_monthly: { net: "2.5000", gross: "2.9750" },
      },
    ],
  };
  return { ...p, server_types: [...p.server_types, cpx32] };
};

const server = (overrides: Partial<ServerLike> = {}): ServerLike => ({
  server_type: { name: "cpx22" },
  location: { name: "fsn1" },
  backup_window: null,
  status: "running",
  volumes: [],
  public_net: { ipv4: { id: 5 }, ipv6: { id: 6 }, floating_ips: [] },
  ...overrides,
});

const E1_ARGS = { server_type: "cpx22", location: "fsn1", public_net: { enable_ipv6: false } };
const E1_LINE =
  "Estimated cost: 2.00 EUR/month net (2.38 gross) = server 1.00 EUR/month net (1.19 gross) + new Primary IPv4 1.00 EUR/month net (1.19 gross). Server hourly price: 1.0000 EUR/hour net (1.1900 gross).";

describe("server_create", () => {
  it("server_create with new IPv4, IPv6 disabled", () => {
    expect(serverCreateCost(P0(), E1_ARGS)).toBe(E1_LINE);
  });

  it("server_create by server type id", () => {
    expect(serverCreateCost(P0(), { ...E1_ARGS, server_type: "104" })).toBe(E1_LINE);
  });

  it("server_create with default public_net and no IPv6 price", () => {
    expect(serverCreateCost(P0(), { server_type: "cpx22", location: "fsn1" })).toBe(
      'Estimated cost: unknown (Hetzner lists no price for a Primary IPv6 in location "fsn1").',
    );
  });

  it("server_create with an IPv6 price of zero", () => {
    expect(serverCreateCost(withIpv6(), { server_type: "cpx22", location: "fsn1" })).toBe(
      "Estimated cost: 2.00 EUR/month net (2.38 gross) = server 1.00 EUR/month net (1.19 gross) + new Primary IPv4 1.00 EUR/month net (1.19 gross) + new Primary IPv6 0.00 EUR/month net (0.00 gross). Server hourly price: 1.0000 EUR/hour net (1.1900 gross).",
    );
  });

  it("server_create without public IPv4", () => {
    const args = { server_type: "cpx22", location: "fsn1", public_net: { enable_ipv4: false } };
    expect(serverCreateCost(withIpv6(), args)).toBe(
      "Estimated cost: 1.00 EUR/month net (1.19 gross) = server 1.00 EUR/month net (1.19 gross) + new Primary IPv6 0.00 EUR/month net (0.00 gross). Server hourly price: 1.0000 EUR/hour net (1.1900 gross).",
    );
  });

  it("server_create in a location without price", () => {
    expect(serverCreateCost(P0(), { ...E1_ARGS, location: "nbg1" })).toBe(
      'Estimated cost: unknown (Hetzner lists no price for server type "cpx22" in location "nbg1").',
    );
  });

  it("server_create without pricing", () => {
    expect(serverCreateCost(undefined, E1_ARGS)).toBe(COST_UNAVAILABLE);
  });
});

describe("server_delete", () => {
  it("server_delete savings without backups", () => {
    expect(serverDeleteSavings(P0(), server())).toBe("Saves 1.00 EUR/month net (1.19 gross).");
  });

  it("server_delete savings with backups", () => {
    expect(serverDeleteSavings(P0(), server({ backup_window: "22-02" }))).toBe(
      "Saves 1.20 EUR/month net (1.43 gross), including backups (+20.00 %).",
    );
    expect(serverDeleteSavings(undefined, server())).toBe(SAVINGS_UNAVAILABLE);
    expect(serverDeleteSavings(P0(), server({ server_type: { name: "cx99" } }))).toBe(
      'Savings: unknown (Hetzner lists no price for server type "cx99" in location "fsn1").',
    );
  });

  it("lists resources that keep running after delete", () => {
    const s = server({
      volumes: [7, 8],
      public_net: { ipv4: { id: 5 }, ipv6: null, floating_ips: [3] },
    });
    expect(remainingAfterDelete(s)).toBe(
      "Not deleted and still billed if present: 2 volume(s) (detached); 1 Floating IP(s) (detached); its Primary IPv4 unless auto_delete is enabled on it; snapshots created from it.",
    );
    expect(remainingAfterDelete(server())).toBe(
      "Not deleted and still billed if present: its Primary IPv4 and IPv6 unless auto_delete is enabled on them; snapshots created from it.",
    );
  });

  it("lists only snapshots for a server without extras", () => {
    const s = server({ volumes: [], public_net: { ipv4: null, ipv6: null, floating_ips: [] } });
    expect(remainingAfterDelete(s)).toBe(
      "Not deleted and still billed if present: snapshots created from it.",
    );
  });
});

describe("server_change_type", () => {
  it("change_type upgrade", () => {
    expect(serverChangeTypeCost(withCpx32(), server(), "cpx32")).toBe(
      "Price change: +1.50 EUR/month net (+1.79 gross): from 1.00 to 2.50 EUR/month net.",
    );
  });

  it("change_type downgrade", () => {
    const s = server({ server_type: { name: "cpx32" } });
    expect(serverChangeTypeCost(withCpx32(), s, "cpx22")).toBe(
      "Price change: -1.50 EUR/month net (-1.79 gross): from 2.50 to 1.00 EUR/month net.",
    );
  });

  it("change_type with backups", () => {
    expect(serverChangeTypeCost(withCpx32(), server({ backup_window: "22-02" }), "cpx32")).toBe(
      "Price change: +1.80 EUR/month net (+2.14 gross): from 1.20 to 3.00 EUR/month net, including backups (+20.00 %).",
    );
  });

  it("change_type to an unknown type", () => {
    expect(serverChangeTypeCost(withCpx32(), server(), "cx99")).toBe(
      'Price change: unknown (Hetzner lists no price for server type "cx99" in location "fsn1").',
    );
    expect(serverChangeTypeCost(undefined, server(), "cpx32")).toBe(
      "Price change: unavailable (Hetzner pricing could not be loaded).",
    );
  });
});

describe("volumes, backups, snapshots", () => {
  it("volume_create", () => {
    expect(volumeCreateCost(P0(), 10)).toBe(
      "Estimated cost: 10.00 EUR/month net (11.90 gross) for 10 GB at 1.0000 EUR/GB/month net (1.1900 gross).",
    );
    expect(volumeCreateCost(undefined, 10)).toBe(COST_UNAVAILABLE);
    expect(volumeCreateCost(P0({ volume: { price_per_gb_month: { net: "x" } } }), 10)).toBe(
      "Estimated cost: unknown (Hetzner lists no volume price).",
    );
  });

  it("volume_resize", () => {
    expect(volumeResizeCost(P0(), 10, 50)).toBe(
      "Price change: +40.00 EUR/month net (+47.60 gross): from 10.00 to 50.00 EUR/month net.",
    );
    expect(volumeResizeCost(undefined, 10, 50)).toBe(
      "Price change: unavailable (Hetzner pricing could not be loaded).",
    );
    expect(volumeResizeCost(P0({ volume: { price_per_gb_month: { gross: "" } } }), 10, 50)).toBe(
      "Price change: unknown (Hetzner lists no volume price).",
    );
  });

  it("backup_enable", () => {
    expect(backupEnableCost(P0(), server())).toBe(
      "Price change: +0.20 EUR/month net (+0.24 gross), 20.00 % of the server price of 1.00 EUR/month net (1.19 gross).",
    );
    expect(backupEnableCost(undefined, server())).toBe(
      "Price change: unavailable (Hetzner pricing could not be loaded).",
    );
    expect(backupEnableCost(P0(), server({ location: { name: "nbg1" } }))).toBe(
      'Price change: unknown (Hetzner lists no price for server type "cpx22" in location "nbg1").',
    );
  });

  it("backup_enable when already enabled", () => {
    const text = "Backups are already enabled (backup window set); the price does not change.";
    expect(backupEnableCost(P0(), server({ backup_window: "22-02" }))).toBe(text);
    expect(backupEnableCost(undefined, server({ backup_window: "22-02" }))).toBe(text);
  });

  it("snapshot cost per GB", () => {
    expect(snapshotCost(P0())).toBe(
      "Estimated cost: 1.0000 EUR/GB/month net (1.1900 gross) per GB of snapshot size; Hetzner reports the size (image_size) after creation.",
    );
    expect(snapshotCost(undefined)).toBe(COST_UNAVAILABLE);
    expect(snapshotCost(P0({ image: { price_per_gb_month: { net: "1e3" } } }))).toBe(
      "Estimated cost: unknown (Hetzner lists no snapshot price).",
    );
  });
});

describe("loadPricing", () => {
  function previewContext(fake: FakeHetzner, signal: AbortSignal) {
    const logs: string[] = [];
    const logger = createLogger({ level: "debug", write: (line) => logs.push(line) });
    const ctx: PreviewContext = {
      config: makeConfig(),
      gateway: fake.gateway({}, logger),
      logger,
      signal,
      project: "test",
    };
    return { ctx, logs };
  }

  it("loadPricing returns undefined on API errors", async () => {
    const fake = new FakeHetzner().on("GET", "/pricing", apiError(503, "unavailable"));
    const { ctx, logs } = previewContext(fake, new AbortController().signal);
    await expect(loadPricing(ctx)).resolves.toBeUndefined();
    expect(fake.calls.filter((c) => c.path === "/pricing")).toHaveLength(3); // retry 01 §3.4
    expect(logFields(logs, "pricing_unavailable")).toEqual([{ kind: "unavailable" }]);
  });

  it("loadPricing rethrows when the caller cancelled", async () => {
    const fake = new FakeHetzner().on("GET", "/pricing", ok({ pricing: P0() }));
    const controller = new AbortController();
    controller.abort();
    const { ctx, logs } = previewContext(fake, controller.signal);
    await expect(loadPricing(ctx)).rejects.toThrow();
    expect(logFields(logs, "pricing_unavailable")).toEqual([]);
  });

  it("loads pricing through the gateway", async () => {
    const fake = new FakeHetzner().on("GET", "/pricing", ok({ pricing: P0() }));
    const { ctx } = previewContext(fake, new AbortController().signal);
    expect((await loadPricing(ctx))?.currency).toBe("EUR");
  });
});

describe("amount functions (03 §2.6a)", () => {
  const net2 = (cost: MonthlyCost) =>
    cost.kind === "ok" ? [formatDec(cost.net, 2), cost.currency] : [cost.kind];

  it("amount functions match the cost lines", () => {
    // Each pair: the line and the amount come from the same internal calculation.
    const cases: [string, MonthlyCost, string][] = [
      [serverCreateCost(P0(), E1_ARGS), serverCreateMonthly(P0(), E1_ARGS), "2.00"],
      [
        serverCreateCost(withIpv6(), { ...E1_ARGS, public_net: { enable_ipv4: false } }),
        serverCreateMonthly(withIpv6(), { ...E1_ARGS, public_net: { enable_ipv4: false } }),
        "1.00",
      ],
      [
        serverChangeTypeCost(withCpx32(), server(), "cpx32"),
        serverChangeTypeMonthly(withCpx32(), server(), "cpx32"),
        "1.50",
      ],
      [
        serverChangeTypeCost(withCpx32(), server({ server_type: { name: "cpx32" } }), "cpx22"),
        serverChangeTypeMonthly(withCpx32(), server({ server_type: { name: "cpx32" } }), "cpx22"),
        "-1.50",
      ],
      [
        serverChangeTypeCost(withCpx32(), server({ backup_window: "22-02" }), "cpx32"),
        serverChangeTypeMonthly(withCpx32(), server({ backup_window: "22-02" }), "cpx32"),
        "1.80",
      ],
      [volumeCreateCost(P0(), 10), volumeCreateMonthly(P0(), 10), "10.00"],
      [volumeResizeCost(P0(), 10, 50), volumeResizeMonthly(P0(), 10, 50), "40.00"],
      [backupEnableCost(P0(), server()), backupEnableMonthly(P0(), server()), "0.20"],
    ];
    for (const [line, cost, expected] of cases) {
      expect(net2(cost)).toEqual([expected, "EUR"]);
      // the net total (or Δ) the line shows first, unsigned for comparison
      const shown = /^(?:Estimated cost|Price change): ([+-]?[\d.]+) /.exec(line)?.[1];
      expect(shown?.replace(/^\+/, "")).toBe(expected);
    }
  });

  it("amount functions report missing prices as unknown", () => {
    expect(serverCreateMonthly(P0(), { server_type: "cpx22", location: "fsn1" })).toEqual({
      kind: "unknown",
    });
    expect(serverCreateMonthly(P0(), { ...E1_ARGS, location: "nbg1" })).toEqual({
      kind: "unknown",
    });
    expect(serverChangeTypeMonthly(withCpx32(), server(), "cx99")).toEqual({ kind: "unknown" });
  });

  it("amount functions report missing pricing as unavailable", () => {
    const unavailable = { kind: "unavailable" };
    expect(serverCreateMonthly(undefined, E1_ARGS)).toEqual(unavailable);
    expect(serverChangeTypeMonthly(undefined, server(), "cpx32")).toEqual(unavailable);
    expect(volumeCreateMonthly(undefined, 10)).toEqual(unavailable);
    expect(volumeResizeMonthly(undefined, 10, 50)).toEqual(unavailable);
    expect(backupEnableMonthly(undefined, server())).toEqual(unavailable);
    expect(snapshotMonthlyUpperBound(undefined, 40)).toEqual(unavailable);
    const already = backupEnableMonthly(undefined, server({ backup_window: "22-02" }));
    expect(already.kind === "ok" && already.net.units).toBe(0n);
  });

  it("snapshot upper bound uses the primary disk size", () => {
    expect(net2(snapshotMonthlyUpperBound(P0(), 40))).toEqual(["40.00", "EUR"]);
    expect(snapshotMonthlyUpperBound(P0(), Number.NaN)).toEqual({ kind: "unknown" });
  });
});
