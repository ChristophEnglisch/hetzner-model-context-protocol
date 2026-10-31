import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, type FakeHandler, type FakeReply, ok } from "../helpers/fake-hetzner.js";
import { fixture } from "../helpers/fixtures.js";
import { type Harness, logFields, startHarness } from "../helpers/harness.js";
import { findSensitive } from "../helpers/sensitive.js";

type Obj = Record<string, unknown>;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function start(): Promise<Harness> {
  h = await startHarness();
  return h;
}

/** A paginating list route: slices `items` by page/per_page and reports meta.pagination. */
function listRoute(key: string, items: readonly unknown[]): FakeHandler {
  return (req) => {
    const page = Number(req.query.get("page") ?? "1");
    const perPage = Number(req.query.get("per_page") ?? "25");
    const last = Math.max(1, Math.ceil(items.length / perPage));
    return ok({
      [key]: items.slice((page - 1) * perPage, page * perPage),
      meta: {
        pagination: {
          page,
          per_page: perPage,
          previous_page: page > 1 ? page - 1 : null,
          next_page: page < last ? page + 1 : null,
          last_page: last,
          total_entries: items.length,
        },
      },
    });
  };
}

interface InventoryData {
  servers?: readonly unknown[];
  volumes?: readonly unknown[];
  images?: readonly unknown[];
  firewalls?: readonly unknown[];
  primary_ips?: readonly unknown[];
  floating_ips?: readonly unknown[];
  ssh_keys?: readonly unknown[] | FakeHandler;
  networks?: readonly unknown[] | FakeHandler;
  load_balancers?: readonly unknown[] | FakeHandler;
}

function route(key: string, value: readonly unknown[] | FakeHandler | undefined): FakeHandler {
  if (value === undefined) return listRoute(key, []);
  return Array.isArray(value) ? listRoute(key, value) : (value as FakeHandler);
}

function inventoryRoutes(t: Harness, d: InventoryData = {}): void {
  for (const key of [
    "servers",
    "volumes",
    "images",
    "firewalls",
    "primary_ips",
    "floating_ips",
    "ssh_keys",
    "networks",
    "load_balancers",
  ] as const) {
    const path = key === "images" ? "/images" : `/${key}`;
    t.fake.on("GET", path, route(key, d[key]));
  }
}

const server = (id: number, status: string, over: Obj = {}): Obj => ({
  ...(fixture<{ server: Obj }>("get_server").server as Obj),
  id,
  status,
  name: `web-SENSITIVE-name-${id}`,
  labels: { owner: "SENSITIVE-label" },
  ...over,
});

async function readJson(t: Harness, uri: string): Promise<{ text: string; data: Obj }> {
  const res = await t.client.readResource({ uri });
  const first = res.contents[0];
  const text = first && "text" in first ? first.text : "";
  return { text, data: JSON.parse(text) as Obj };
}

describe("resources", () => {
  it("RS-1 lists inventory and pricing and the server template", async () => {
    const t = await start();
    const uris = (await t.client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain("hetzner://inventory");
    expect(uris).toContain("hetzner://pricing");
    expect(uris.some((u) => u.startsWith("hetzner://servers/"))).toBe(false);
    const templates = (await t.client.listResourceTemplates()).resourceTemplates;
    expect(templates.map((r) => r.uriTemplate)).toContain("hetzner://servers/{id}");
  });

  it("RS-2 counts inventory and caps id lists", async () => {
    const t = await start();
    const volumes = Array.from({ length: 25 }, (_, i) => ({
      id: 100 - i, // descending on purpose: the output must be ascending
      name: `vol-SENSITIVE-${i}`,
      assignee: null,
    }));
    inventoryRoutes(t, {
      servers: [server(3, "running"), server(2, "off"), server(1, "off")],
      volumes,
      firewalls: [{ id: 9, name: "fw-SENSITIVE", applied_to: [] }],
      primary_ips: [
        { id: 5, assignee_id: null },
        { id: 6, assignee_id: 3 },
      ],
      floating_ips: [{ id: 7, server: null }],
      ssh_keys: (): FakeReply => ({
        status: 200,
        body: { ssh_keys: [], meta: { pagination: { page: 1, per_page: 1, total_entries: 4 } } },
      }),
    });
    const { data } = await readJson(t, "hetzner://inventory");
    expect(data.project).toBe("test");
    expect(data.servers).toEqual({
      total: 3,
      by_status: { running: 1, off: 2 },
      off_ids: [1, 2],
    });
    const vols = data.volumes as { total: number; unattached: number; unattached_ids: number[] };
    expect(vols.total).toBe(25);
    expect(vols.unattached).toBe(25);
    expect(vols.unattached_ids).toHaveLength(20);
    expect(vols.unattached_ids).toEqual([...vols.unattached_ids].sort((a, b) => a - b));
    expect(vols.unattached_ids[0]).toBe(76);
    expect(data.firewalls).toEqual({ total: 1, unapplied: 1, unapplied_ids: [9] });
    expect(data.primary_ips).toEqual({ total: 2, unassigned: 1, unassigned_ids: [5] });
    expect(data.floating_ips).toEqual({ total: 1, unassigned: 1, unassigned_ids: [7] });
    expect(data.ssh_keys).toEqual({ total: 4 });
    expect(data.networks).toEqual({ total: 0 });
    expect(data.load_balancers).toEqual({ total: 0 });
    expect(data.truncated).toEqual([]);
    expect(data.id_lists_capped_at).toBe(20);
  });

  it("RS-3 sums snapshot sizes exactly", async () => {
    const t = await start();
    inventoryRoutes(t, {
      images: [
        { id: 1, image_size: 2.3 },
        { id: 2, image_size: 0.1 },
        { id: 3, image_size: null },
      ],
    });
    const { data } = await readJson(t, "hetzner://inventory");
    expect(data.snapshots).toEqual({ total: 3, total_image_size_gb: "2.40" });
    expect(t.fake.requests("GET", "/images")[0]?.query.get("type")).toBe("snapshot");
  });

  it("RS-4 reports truncated lists", async () => {
    const t = await start();
    const many = Array.from({ length: 501 }, (_, i) => server(i + 1, "running"));
    inventoryRoutes(t, { servers: many });
    const { data } = await readJson(t, "hetzner://inventory");
    expect(data.truncated).toEqual(["servers"]);
    expect((data.servers as { total: number }).total).toBe(500);
    expect(t.fake.requests("GET", "/servers")).toHaveLength(10);
  });

  it("RS-5 server resource equals server_get output", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", ok(fixture("get_server", { server: { id: 42 } })));
    const viaTool = await t.call("server_get", { id: 42 });
    const { text, data } = await readJson(t, "hetzner://servers/42");
    expect(data).toEqual(viaTool.structuredContent);
    expect(text).not.toContain("\n");
    expect(findSensitive(data, "")).toEqual([]);
    expect(text).not.toContain("root_password");
  });

  it("RS-6 pricing resource is compact and rounded", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", ok(fixture("get_pricing")));
    const { data } = await readJson(t, "hetzner://pricing");
    const types = data.server_types as { name: string; prices: Obj[] }[];
    expect(types[0]?.name).toBe("cpx22");
    expect(types[0]?.prices[0]).toEqual({
      location: "fsn1",
      monthly_net: "1.00",
      monthly_gross: "1.19",
      hourly_net: "1.0000",
    });
    expect(data.backup_percentage).toBe("20.00");
    expect(data.currency).toBe("EUR");
    expect(data.vat_rate).toBe("19.00");
    expect(data.volume_per_gb_month).toEqual({ net: "1.0000", gross: "1.1900" });
    expect(data.snapshot_per_gb_month).toEqual({ net: "1.0000", gross: "1.1900" });
    expect(JSON.stringify(data)).not.toContain("included_traffic");
    expect(JSON.stringify(data)).not.toContain("load_balancer");
  });

  it("RS-6 stays under 64 KiB for 60 types in 8 locations", async () => {
    const t = await start();
    const base = fixture<{ pricing: { server_types: Obj[] } }>("get_pricing");
    const price = { gross: "12.3456", net: "10.3745" };
    const prices = Array.from({ length: 8 }, (_, i) => ({
      location: `loc${i}`,
      included_traffic: 1,
      price_hourly: price,
      price_monthly: price,
      price_per_tb_traffic: price,
    }));
    base.pricing.server_types = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      name: `type${i}`,
      prices,
    }));
    t.fake.on("GET", "/pricing", ok(base));
    const { text } = await readJson(t, "hetzner://pricing");
    expect(text.length).toBeLessThan(65536);
  });

  it("RS-7 rejects invalid server ids", async () => {
    const t = await start();
    for (const id of ["0", "abc", "1.5", "99999999999999999"]) {
      await expect(t.client.readResource({ uri: `hetzner://servers/${id}` })).rejects.toThrow(
        /Invalid id/,
      );
    }
    expect(t.fake.calls).toHaveLength(0);
  });

  it("RS-8 maps API errors", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", apiError(404, "not_found", "server not found"));
    await expect(t.client.readResource({ uri: "hetzner://servers/7" })).rejects.toThrow(
      /Not found \(HTTP 404\): the resource does not exist in this project\./,
    );
    expect(logFields(t.logs, "resource_read")[0]?.outcome).toBe("not_found");
  });

  it("RS-9 writes one resource_read audit line without names", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", ok(fixture("get_server", { server: { id: 42 } })));
    await readJson(t, "hetzner://servers/42");
    inventoryRoutes(t, { servers: [server(1, "off")] });
    await readJson(t, "hetzner://inventory");
    t.fake.on("GET", "/pricing", ok(fixture("get_pricing")));
    await readJson(t, "hetzner://pricing");

    const lines = logFields(t.logs, "resource_read");
    expect(lines).toHaveLength(3);
    const [one, inv, pricing] = lines as [Obj, Obj, Obj];
    expect(Object.keys(one).sort()).toEqual([
      "durationMs",
      "outcome",
      "project",
      "resource",
      "targets",
    ]);
    expect(one).toMatchObject({
      resource: "server",
      project: "test",
      outcome: "ok",
      targets: ["server:42"],
    });
    expect(Object.keys(inv).sort()).toEqual(["durationMs", "outcome", "project", "resource"]);
    expect(inv.resource).toBe("inventory");
    expect(pricing.resource).toBe("pricing");
    expect(typeof one.durationMs).toBe("number");
    expect(findSensitive(t.logs, "")).toEqual([]);
    expect(t.logs.join("\n")).not.toContain("web-");
  });

  it("RS-10 inventory contains no names or labels", async () => {
    const t = await start();
    inventoryRoutes(t, {
      servers: [server(1, "off")],
      volumes: [
        { id: 2, name: "SENSITIVE-name", labels: { a: "SENSITIVE-label" }, assignee: null },
      ],
      firewalls: [
        { id: 3, name: "SENSITIVE-name", labels: { a: "SENSITIVE-label" }, applied_to: [] },
      ],
    });
    const { text } = await readJson(t, "hetzner://inventory");
    expect(text).not.toContain("SENSITIVE");
    expect(text).not.toContain("labels");
    expect(text).not.toContain('"name"');
  });

  it("N-10 inventory fails with forbidden when a list is not readable", async () => {
    const t = await start();
    inventoryRoutes(t, { networks: () => apiError(403, "forbidden", "insufficient permissions") });
    await expect(t.client.readResource({ uri: "hetzner://inventory" })).rejects.toThrow(
      /permission|forbidden/i,
    );
    expect(logFields(t.logs, "resource_read")[0]?.outcome).toBe("forbidden");
  });

  it("N-9 passes the client abort signal on to the gateway", async () => {
    const t = await start();
    let started = false;
    t.fake.on("GET", "/pricing", () => {
      started = true;
      return new Promise<FakeReply>(() => {});
    });
    const controller = new AbortController();
    const pending = t.client.readResource(
      { uri: "hetzner://pricing" },
      { signal: controller.signal },
    );
    pending.catch(() => {});
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    // The server callback only finishes (and audits) quickly if the signal reached the gateway.
    await vi.waitFor(() => expect(logFields(t.logs, "resource_read")).toHaveLength(1), {
      timeout: 2000,
    });
  });
});
