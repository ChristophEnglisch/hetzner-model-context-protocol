import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiError, ok } from "../helpers/fake-hetzner.js";
import { fixture } from "../helpers/fixtures.js";
import { type Harness, startHarness, textOf } from "../helpers/harness.js";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON access in assertions
type Json = Record<string, any>;

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const sc = (r: { structuredContent?: unknown }): Json => r.structuredContent as Json;

// --- server types -----------------------------------------------------------------------------

const baseType = fixture<{ server_types: Json[] }>("list_server_types").server_types[0] as Json;
const deprecation = {
  announced: "2026-01-01T00:00:00Z",
  unavailable_after: "2026-06-01T00:00:00Z",
};

function serverType(
  name: string,
  loc: { available?: boolean; deprecation?: Json | null } = {},
  extra: Json = {},
): Json {
  return {
    ...baseType,
    name,
    description: name.toUpperCase(),
    locations: [
      {
        id: 1,
        name: "fsn1",
        recommended: true,
        available: loc.available ?? true,
        deprecation: loc.deprecation ?? null,
      },
    ],
    prices: [
      {
        location: "fsn1",
        price_hourly: { net: "0.0100", gross: "0.0119" },
        price_monthly: { net: "4.2900", gross: "5.1051" },
      },
    ],
    ...extra,
  };
}

const typesBody = (types: Json[], next: number | null = null) => ({
  server_types: types,
  meta: {
    pagination: {
      page: 1,
      per_page: 50,
      previous_page: null,
      next_page: next,
      last_page: 1,
      total_entries: types.length,
    },
  },
});

const threeTypes = () => [
  serverType("a1"),
  serverType("b2", { deprecation }),
  serverType("c3", { available: false }),
];

describe("catalog_server_types", () => {
  it("catalog_server_types returns orderable types with the price of the location", async () => {
    h.fake.on("GET", "/server_types", ok(typesBody(threeTypes())));
    h.fake.on("GET", "/pricing", ok(fixture("get_pricing")));
    const r = await h.call("catalog_server_types", { location: "fsn1" });
    expect(r.isError).toBeUndefined();
    const out = sc(r);
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.name).toBe("a1");
    expect(item.price.monthly).toEqual({ net: "4.2900", gross: "5.1051", currency: "EUR" });
    expect(item.price.hourly.currency).toBe("EUR");
    expect(item.locations).toEqual([{ name: "fsn1", recommended: true }]);
    expect(item).not.toHaveProperty("deprecated");
    expect(item).not.toHaveProperty("deprecation");
    expect(item).not.toHaveProperty("prices");
    expect(textOf(r)).toBe("Returned 1 of 1 server type(s).");
  });

  it("catalog_server_types without location sends no pricing request", async () => {
    h.fake.on("GET", "/server_types", ok(typesBody(threeTypes())));
    const out = sc(await h.call("catalog_server_types"));
    expect(out.items[0]).not.toHaveProperty("price");
    expect(h.fake.requests("GET", "/pricing")).toEqual([]);
  });

  it("catalog_server_types filters by architecture and cpu_type client-side", async () => {
    h.fake.on(
      "GET",
      "/server_types",
      ok(
        typesBody([
          serverType("x-sh", {}, { architecture: "x86", cpu_type: "shared" }),
          serverType("x-de", {}, { architecture: "x86", cpu_type: "dedicated" }),
          serverType("a-sh", {}, { architecture: "arm", cpu_type: "shared" }),
          serverType("a-de", {}, { architecture: "arm", cpu_type: "dedicated" }),
        ]),
      ),
    );
    const arm = sc(await h.call("catalog_server_types", { architecture: "arm" }));
    expect(arm.items.map((i: Json) => i.name)).toEqual(["a-de", "a-sh"]);
    const ded = sc(await h.call("catalog_server_types", { cpu_type: "dedicated" }));
    expect(ded.items.map((i: Json) => i.name)).toEqual(["a-de", "x-de"]);
    for (const req of h.fake.requests("GET", "/server_types")) {
      expect(req.query.has("architecture")).toBe(false);
      expect(req.query.has("cpu_type")).toBe(false);
    }
  });

  it("catalog_server_types include_unavailable marks deprecated and unavailable types", async () => {
    h.fake.on("GET", "/server_types", ok(typesBody(threeTypes())));
    h.fake.on("GET", "/pricing", ok(fixture("get_pricing")));
    const out = sc(
      await h.call("catalog_server_types", { location: "fsn1", include_unavailable: true }),
    );
    const byName = Object.fromEntries(out.items.map((i: Json) => [i.name, i]));
    expect(Object.keys(byName).sort()).toEqual(["a1", "b2", "c3"]);
    expect(byName.a1.locations[0]).toMatchObject({ available: true, deprecation: null });
    expect(byName.b2.locations[0].deprecation).toEqual(deprecation);
    expect(byName.c3.locations[0].available).toBe(false);
  });

  it("catalog_server_types forwards name as query parameter", async () => {
    let seen: string | null = null;
    h.fake.on("GET", "/server_types", (req) => {
      seen = req.query.get("name");
      return ok(typesBody([serverType("cpx22")]));
    });
    const out = sc(await h.call("catalog_server_types", { name: "cpx22" }));
    expect(seen).toBe("cpx22");
    expect(out.items[0].name).toBe("cpx22");
  });

  it("catalog_server_types truncates to limit and reports total_matching", async () => {
    h.fake.on(
      "GET",
      "/server_types",
      ok(typesBody([serverType("c"), serverType("a"), serverType("b")])),
    );
    const r = await h.call("catalog_server_types", { limit: 2 });
    const out = sc(r);
    expect(out.items.map((i: Json) => i.name)).toEqual(["a", "b"]);
    expect(out.total_matching).toBe(3);
    expect(textOf(r).endsWith("see more.")).toBe(true);
  });

  it("catalog_server_types aggregates all API pages", async () => {
    h.fake.on("GET", "/server_types", [
      ok(typesBody([serverType("a")], 2)),
      ok(typesBody([serverType("b")], null)),
    ]);
    const out = sc(await h.call("catalog_server_types"));
    expect(out.items.map((i: Json) => i.name)).toEqual(["a", "b"]);
    expect(h.fake.requests("GET", "/server_types")).toHaveLength(2);
  });

  it("catalog_server_types reports no match for an unknown location", async () => {
    h.fake.on("GET", "/server_types", ok(typesBody(threeTypes())));
    const r = await h.call("catalog_server_types", { location: "mars1" });
    expect(r.isError).toBeUndefined();
    expect(sc(r)).toEqual({ items: [], total_matching: 0 });
    expect(textOf(r)).toBe(
      "No server type matched. Check the location name with catalog_locations, or set include_unavailable to true.",
    );
    expect(h.fake.requests("GET", "/pricing")).toEqual([]);
  });

  it("catalog_server_types maps auth errors", async () => {
    h.fake.on("GET", "/server_types", apiError(401, "unauthorized"));
    const r = await h.call("catalog_server_types");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Hetzner rejected the API token \(HTTP 401\)/);
  });
});

// --- images -----------------------------------------------------------------------------------

const baseImage = fixture<{ images: Json[] }>("list_images").images[0] as Json;
const systemImage: Json = { ...baseImage, type: "system", deprecation: null };
const snapshotImage: Json = {
  ...baseImage,
  id: 77,
  type: "snapshot",
  name: null,
  deprecation: null,
  image_size: 2.3,
  bound_to: 5,
  created_from: { id: 1, name: "web" },
  protection: { delete: true },
  labels: { env: "prod" },
};
const SNAPSHOT_ONLY = ["image_size_gb", "created_from", "bound_to", "protection", "labels"];

describe("catalog_images", () => {
  it("catalog_images defaults to available system images", async () => {
    h.fake.on("GET", "/images", ok(fixture("list_images", { images: [systemImage] })));
    const out = sc(await h.call("catalog_images"));
    const q = h.fake.requests("GET", "/images")[0]?.query as URLSearchParams;
    expect(q.getAll("type")).toEqual(["system"]);
    expect(q.get("status")).toBe("available");
    expect(q.has("include_deprecated")).toBe(false);
    for (const key of ["labels", "protection", "created_from"]) {
      expect(out.items[0]).not.toHaveProperty(key);
    }
  });

  it("catalog_images sends repeated type keys and optional filters", async () => {
    h.fake.on("GET", "/images", ok(fixture("list_images")));
    await h.call("catalog_images", {
      type: ["system", "snapshot"],
      architecture: "arm",
      name: "ubuntu-24.04",
      sort: "name:asc",
    });
    const q = h.fake.requests("GET", "/images")[0]?.query as URLSearchParams;
    expect(q.getAll("type")).toEqual(["system", "snapshot"]);
    expect(q.get("architecture")).toBe("arm");
    expect(q.get("name")).toBe("ubuntu-24.04");
    expect(q.get("sort")).toBe("name:asc");
  });

  it("catalog_images adds snapshot fields only for snapshots", async () => {
    h.fake.on(
      "GET",
      "/images",
      ok(fixture("list_images", { images: [systemImage, snapshotImage] })),
    );
    const out = sc(await h.call("catalog_images", { type: ["system", "snapshot"] }));
    const [sys, snap] = out.items;
    for (const key of SNAPSHOT_ONLY) expect(sys).not.toHaveProperty(key);
    expect(snap).toMatchObject({
      image_size_gb: 2.3,
      created_from: { id: 1, name: "web" },
      bound_to: 5,
      protection: { delete: true },
      labels: { env: "prod" },
    });
    expect(snap.name).toBeNull();
  });

  it("catalog_images sends include_deprecated only when true", async () => {
    h.fake.on("GET", "/images", ok(fixture("list_images")));
    await h.call("catalog_images");
    await h.call("catalog_images", { include_deprecated: true });
    const [first, second] = h.fake.requests("GET", "/images");
    expect(first?.query.has("include_deprecated")).toBe(false);
    expect(second?.query.get("include_deprecated")).toBe("true");
  });

  it("catalog_images reports hasMore through next_page", async () => {
    h.fake.on(
      "GET",
      "/images",
      ok(fixture("list_images", { meta: { pagination: { next_page: 2 } } })),
    );
    const r = await h.call("catalog_images");
    expect(sc(r).next_page).toBe(2);
    expect(textOf(r).endsWith("More on page 2.")).toBe(true);
  });

  it("catalog_images maps invalid input", async () => {
    h.fake.on(
      "GET",
      "/images",
      apiError(422, "invalid_input", "x", {
        fields: [{ name: "architecture", messages: ["invalid"] }],
      }),
    );
    const r = await h.call("catalog_images");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      "Hetzner rejected the input: architecture: invalid. [hetzner: invalid_input, HTTP 422]",
    );
  });

  it("catalog_images does not read the legacy deprecated field", async () => {
    h.fake.on(
      "GET",
      "/images",
      ok(
        fixture("list_images", {
          images: [{ ...systemImage, deprecated: "2018-02-28T00:00:00Z", deprecation: null }],
        }),
      ),
    );
    const out = sc(await h.call("catalog_images"));
    expect(out.items[0].deprecation).toBeNull();
    expect(out.items[0]).not.toHaveProperty("deprecated");
  });
});

// --- locations --------------------------------------------------------------------------------

describe("catalog_locations", () => {
  it("catalog_locations returns compact locations", async () => {
    h.fake.on("GET", "/locations", ok(fixture("list_locations")));
    const out = sc(await h.call("catalog_locations"));
    expect(Object.keys(out.items[0]).sort()).toEqual([
      "city",
      "country",
      "description",
      "id",
      "name",
      "network_zone",
    ]);
    expect(out.items[0]).not.toHaveProperty("latitude");
    expect(out.items[0]).not.toHaveProperty("longitude");
  });

  it("catalog_locations forwards name and pagination", async () => {
    h.fake.on("GET", "/locations", ok(fixture("list_locations")));
    await h.call("catalog_locations", { name: "fsn1" });
    const q = h.fake.requests("GET", "/locations")[0]?.query as URLSearchParams;
    expect(q.get("name")).toBe("fsn1");
    expect(q.get("page")).toBe("1");
    expect(q.get("per_page")).toBe("25");
  });

  it("catalog_locations reports hasMore through next_page", async () => {
    h.fake.on(
      "GET",
      "/locations",
      ok(fixture("list_locations", { meta: { pagination: { next_page: 2 } } })),
    );
    expect(sc(await h.call("catalog_locations")).next_page).toBe(2);
  });

  it("catalog_locations maps rate limiting", async () => {
    h.fake.on("GET", "/locations", apiError(429, "rate_limit_exceeded"));
    const r = await h.call("catalog_locations");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Hetzner rate limit reached/);
  });
});

// --- pricing ----------------------------------------------------------------------------------

const price = (net: string, gross: string) => ({ net, gross });

describe("pricing_get", () => {
  it("pricing_get returns compact pricing without server types by default", async () => {
    h.fake.on("GET", "/pricing", ok(fixture("get_pricing")));
    const r = await h.call("pricing_get");
    const out = sc(r);
    expect(out).toMatchObject({
      currency: "EUR",
      vat_rate: "19.00",
      volume_gb_month: { net: "1.0000", gross: "1.1900", currency: "EUR" },
      snapshot_gb_month: { currency: "EUR" },
      backup_surcharge_percent: "20.00",
    });
    expect(out).not.toHaveProperty("server_type");
    for (const key of ["server_types", "primary_ips", "floating_ips"]) {
      expect(out).not.toHaveProperty(key);
    }
    expect(textOf(r)).toBe("Pricing in EUR; VAT rate 19.00.");
  });

  it("pricing_get returns all locations for one server type", async () => {
    const entry = (location: string) => ({
      location,
      price_hourly: price("0.0100", "0.0119"),
      price_monthly: price("4.2900", "5.1051"),
    });
    h.fake.on(
      "GET",
      "/pricing",
      ok(
        fixture("get_pricing", {
          pricing: {
            server_types: [{ id: 1, name: "cpx22", prices: [entry("fsn1"), entry("nbg1")] }],
          },
        }),
      ),
    );
    const out = sc(await h.call("pricing_get", { server_type: "cpx22" }));
    expect(out.server_type.name).toBe("cpx22");
    expect(out.server_type.prices).toHaveLength(2);
    for (const p of out.server_type.prices) {
      expect(p.hourly.currency).toBe("EUR");
      expect(p.monthly.currency).toBe("EUR");
    }
  });

  it("pricing_get keeps prices as decimal strings", async () => {
    h.fake.on(
      "GET",
      "/pricing",
      ok(
        fixture("get_pricing", { pricing: { volume: { price_per_gb_month: { net: "4.2900" } } } }),
      ),
    );
    expect(sc(await h.call("pricing_get")).volume_gb_month.net).toBe("4.2900");
  });

  it("pricing_get reports an unknown server type without error", async () => {
    h.fake.on("GET", "/pricing", ok(fixture("get_pricing")));
    const r = await h.call("pricing_get", { server_type: "nope" });
    expect(r.isError).toBeUndefined();
    expect(sc(r)).not.toHaveProperty("server_type");
    expect(textOf(r)).toContain("No pricing entry");
  });

  it("pricing_get uses the gateway cache", async () => {
    h.fake.on("GET", "/pricing", ok(fixture("get_pricing")));
    await h.call("pricing_get");
    await h.call("pricing_get");
    expect(h.fake.requests("GET", "/pricing")).toHaveLength(1);
  });

  it("pricing_get replaces an invalid currency in the summary", async () => {
    h.fake.on("GET", "/pricing", ok(fixture("get_pricing", { pricing: { currency: "eur!" } })));
    const r = await h.call("pricing_get");
    expect(textOf(r)).toContain("?");
    expect(textOf(r)).not.toContain("eur!");
    expect(sc(r).currency).toBe("eur!");
  });

  it("pricing_get maps auth errors", async () => {
    h.fake.on("GET", "/pricing", [apiError(401, "unauthorized"), ok(fixture("get_pricing"))]);
    const r = await h.call("pricing_get");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Hetzner rejected the API token \(HTTP 401\)/);
    const again = await h.call("pricing_get");
    expect(again.isError).toBeUndefined();
    expect(h.fake.requests("GET", "/pricing")).toHaveLength(2);
  });
});
