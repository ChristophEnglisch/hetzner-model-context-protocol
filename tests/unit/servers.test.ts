import { afterEach, describe, expect, it } from "vitest";
import type { HetznerPricing } from "../../src/hetzner/types.js";
import { COST_UNAVAILABLE } from "../../src/pricing/estimate.js";
import { action, apiError, ok } from "../helpers/fake-hetzner.js";
import { fixture } from "../helpers/fixtures.js";
import { type Harness, logFields, startHarness, textOf } from "../helpers/harness.js";

const SCOPE = [{ key: "managed-by", value: "mcp" }];
const IN_SCOPE = { "managed-by": "mcp" };

type Obj = Record<string, unknown>;
const server = (over: Obj = {}): Obj => ({
  ...(fixture<{ server: Obj }>("get_server").server as Obj),
  ...over,
});
const serverReply = (over: Obj = {}, status = 200) => ok({ server: server(over) }, status);

const bodyOf = (t: Harness, method: "POST" | "PUT", pattern: string): Obj =>
  (t.fake.requests(method, pattern)[0]?.body ?? {}) as Obj;
const out = (res: { structuredContent?: unknown }) => res.structuredContent as Obj;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function start(config: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  h = await startHarness(config);
  return h;
}

/** Routes for a power/protection call: GET target, POST creates running action `id`, GET /actions finishes it. */
function actionRoutes(
  t: Harness,
  endpoint: string,
  over: Obj = {},
  id = 7,
  final: "success" | "error" = "success",
) {
  t.fake
    .on("GET", "/servers/{id}", serverReply(over))
    .on("POST", `/servers/{id}/actions/${endpoint}`, ok({ action: action(id, "running") }, 201))
    .on("GET", "/actions", ok({ actions: [action(id, final)] }));
}

describe("server_list", () => {
  it("server_list returns projected items", async () => {
    const t = await start();
    t.fake.on("GET", "/servers", ok(fixture("list_servers")));
    const res = await t.call("server_list");
    const items = out(res).items as Obj[];
    const raw = fixture<{ servers: Obj[] }>("list_servers").servers[0] as {
      public_net: { ipv4: { ip: string } };
    };
    expect(Object.keys(items[0] as Obj).sort()).toEqual([
      "created",
      "id",
      "ipv4",
      "ipv6",
      "labels",
      "location",
      "locked",
      "name",
      "protection",
      "server_type",
      "status",
    ]);
    expect(items[0]).not.toHaveProperty("public_net");
    expect(items[0]).not.toHaveProperty("datacenter");
    expect(items[0]?.ipv4).toBe(raw.public_net.ipv4.ip);
    expect(typeof items[0]?.server_type).toBe("string");
  });

  it("server_list reports hasMore via next_page", async () => {
    const t = await start();
    const two = fixture<{ servers: Obj[] }>("list_servers").servers;
    t.fake.on(
      "GET",
      "/servers",
      ok({
        servers: [two[0], two[0]],
        meta: { pagination: { page: 1, per_page: 25, next_page: 2, total_entries: 60 } },
      }),
    );
    const res = await t.call("server_list");
    expect(out(res).next_page).toBe(2);
    expect(textOf(res)).toMatch(/more pages: yes\.$/);
    const q = t.fake.requests("GET", "/servers")[0]?.query;
    expect(q?.get("page")).toBe("1");
    expect(q?.get("per_page")).toBe("25");
  });

  it("server_list passes filters", async () => {
    const t = await start();
    t.fake.on("GET", "/servers", ok(fixture("list_servers")));
    await t.call("server_list", {
      name: "web-1",
      label_selector: "env=prod",
      status: ["off", "running"],
      sort: "name:desc",
    });
    const q = t.fake.requests("GET", "/servers")[0]?.query;
    expect(q?.get("name")).toBe("web-1");
    expect(q?.get("label_selector")).toBe("env=prod");
    expect(q?.getAll("status")).toEqual(["off", "running"]);
    expect(q?.get("sort")).toBe("name:desc");
  });

  it("server_list maps invalid_input", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/servers",
      apiError(422, "invalid_input", "invalid input", {
        fields: [{ name: "label_selector", messages: ["invalid"] }],
      }),
    );
    const res = await t.call("server_list", { label_selector: "!!" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Hetzner rejected the input: label_selector: invalid/);
  });

  it("server_list ignores label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    const s = fixture<{ servers: Obj[] }>("list_servers").servers[0] as Obj;
    t.fake.on(
      "GET",
      "/servers",
      ok({
        servers: [
          { ...s, id: 1, labels: {} },
          { ...s, id: 2, labels: {} },
        ],
        meta: { pagination: { page: 1, per_page: 25, next_page: null, total_entries: 2 } },
      }),
    );
    const res = await t.call("server_list");
    expect(out(res).items).toHaveLength(2);
    expect(t.fake.calls).toHaveLength(1);
    expect(textOf(res)).toBe("Returned 2 server(s) on page 1; total 2; more pages: no.");
  });
});

describe("server_get", () => {
  it("server_get returns the projected server", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", ok(fixture("get_server")));
    const res = await t.call("server_get", { id: 42 });
    const s = out(res).server as Obj;
    expect(Object.keys(s).sort()).toEqual([
      "backup_window",
      "created",
      "id",
      "image",
      "included_traffic",
      "ingoing_traffic",
      "ipv4",
      "ipv6",
      "iso",
      "labels",
      "load_balancers",
      "location",
      "locked",
      "name",
      "outgoing_traffic",
      "placement_group",
      "primary_disk_size",
      "private_net",
      "protection",
      "public_net",
      "rescue_enabled",
      "server_type",
      "status",
      "volumes",
    ]);
    expect((s.image as Obj).name).toBe("ubuntu-24.04");
    expect(s.server_type).toHaveProperty("memory_gb");
    expect(s.server_type).not.toHaveProperty("prices");
    expect(s).not.toHaveProperty("datacenter");
    expect(textOf(res)).toMatch(/^Server 42 is \w+; locked: (true|false)\.$/);
  });

  it("server_get maps 404", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", apiError(404, "not_found"));
    const res = await t.call("server_get", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Not found \(HTTP 404\)/);
  });

  it("server_get rejects non-positive ids", async () => {
    const t = await start();
    for (const id of [0, 1.5]) {
      const res = await t.client.callTool({ name: "server_get", arguments: { id } });
      expect(res.isError).toBe(true);
    }
    expect(t.fake.calls).toHaveLength(0);
  });

  it("server_get tolerates missing optional fields", async () => {
    const t = await start();
    const raw = server();
    delete raw.volumes;
    delete raw.load_balancers;
    delete raw.placement_group;
    delete (raw.public_net as Obj).firewalls;
    t.fake.on("GET", "/servers/{id}", ok({ server: raw }));
    const s = out(await t.call("server_get", { id: 42 })).server as Obj;
    expect(s.volumes).toEqual([]);
    expect(s.load_balancers).toEqual([]);
    expect(s.placement_group).toBeNull();
    expect((s.public_net as Obj).firewalls).toEqual([]);
  });
});

describe("server_update", () => {
  it("server_update renames and returns the server", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("PUT", "/servers/{id}", ok(fixture("update_server")));
    const res = await t.call("server_update", { id: 42, name: "new-name" });
    expect(bodyOf(t, "PUT", "/servers/{id}")).toEqual({ name: "new-name" });
    expect(textOf(res)).toBe("Updated server 42 (name).");
    expect((out(res).server as Obj).id).toBe(42);
  });

  it("server_update sends the full label set and keeps scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    const reply = serverReply({ labels: { ...IN_SCOPE, a: "1" } });
    t.fake.on("GET", "/servers/{id}", reply).on("PUT", "/servers/{id}", reply);
    const res = await t.call("server_update", { id: 42, labels: { a: "2" } });
    expect(bodyOf(t, "PUT", "/servers/{id}")).toEqual({ labels: { a: "2", ...IN_SCOPE } });
    expect((out(res).server as Obj).labels).toEqual({ ...IN_SCOPE, a: "1" });
    expect(textOf(res)).toBe("Updated server 42 (labels).");
  });

  it("server_update rejects a changed scope label", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: IN_SCOPE }));
    const res = await t.call("server_update", { id: 42, labels: { "managed-by": "other" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Label 'managed-by' is reserved/);
    expect(t.fake.requests("PUT", "/servers/{id}")).toHaveLength(0);
  });

  it("server_update refuses servers outside the scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: {} }));
    const res = await t.call("server_update", { id: 42, name: "x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource server 42 is outside the label scope/);
    expect(t.fake.requests("PUT", "/servers/{id}")).toHaveLength(0);
  });

  it("server_update warns for IaC-managed servers", async () => {
    const t = await start({ iacPolicy: "warn" });
    const reply = serverReply({ labels: { managed_by: "terraform" } });
    t.fake.on("GET", "/servers/{id}", reply).on("PUT", "/servers/{id}", reply);
    const res = await t.call("server_update", { id: 42, name: "x" });
    expect(res.isError).toBeFalsy();
    expect((out(res).warnings as string[])[0]).toContain(
      "infrastructure-as-code marker 'managed_by=terraform'",
    );
    expect(textOf(res)).toMatch(/^Warning:/);
  });

  it("server_update blocks IaC-managed servers with policy block", async () => {
    const t = await start({ iacPolicy: "block" });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: { managed_by: "terraform" } }));
    const res = await t.call("server_update", { id: 42, name: "x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Server 42 carries the infrastructure-as-code marker/);
    expect(t.fake.requests("PUT", "/servers/{id}")).toHaveLength(0);
  });

  it("server_update requires name or labels", async () => {
    const t = await start();
    const res = await t.call("server_update", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Provide at least one of name or labels.");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("server_update maps uniqueness_error", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on(
        "PUT",
        "/servers/{id}",
        apiError(409, "uniqueness_error", "taken", { fields: [{ name: "name" }] }),
      );
    const res = await t.call("server_update", { id: 42, name: "taken" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("A resource with the same unique value already exists: name.");
    expect(textOf(res)).toContain("[hetzner: uniqueness_error, HTTP 409]");
    expect(t.fake.requests("PUT", "/servers/{id}")).toHaveLength(1);
  });
});

describe("server_power", () => {
  it("server_power on starts the server and waits", async () => {
    const t = await start();
    actionRoutes(t, "poweron");
    const res = await t.call("server_power", { id: 42, mode: "on" });
    expect(res.isError).toBeFalsy();
    expect((out(res).actions as Obj[])[0]?.status).toBe("success");
    expect(textOf(res)).toMatch(/^Requested power on for server 42 \(action 7\)\./);
    expect(textOf(res)).toContain("Final action status is in 'actions'.");
  });

  it("server_power shutdown states that success means signal sent", async () => {
    const t = await start();
    actionRoutes(t, "shutdown");
    const res = await t.call("server_power", { id: 42, mode: "shutdown" });
    expect(textOf(res)).toContain("only means the ACPI signal was sent");
  });

  it.each([
    ["on", "poweron"],
    ["shutdown", "shutdown"],
    ["reboot", "reboot"],
  ] as const)("server_power maps mode %s to its endpoint", async (mode, endpoint) => {
    const t = await start();
    actionRoutes(t, endpoint);
    await t.call("server_power", { id: 42, mode });
    expect(t.fake.requests("POST", `/servers/{id}/actions/${endpoint}`)).toHaveLength(1);
    expect(t.fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("server_power skips waiting with wait=false", async () => {
    const t = await start();
    actionRoutes(t, "reboot");
    const res = await t.call("server_power", { id: 42, mode: "reboot", wait: false });
    expect(t.fake.requests("GET", "/actions")).toHaveLength(0);
    expect((out(res).actions as Obj[])[0]?.status).toBe("running");
  });

  it("server_power refuses servers outside the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: {} }));
    const res = await t.call("server_power", { id: 42, mode: "on" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource server 42 is outside the label scope/);
    expect(t.fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("server_power maps locked", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/poweron", apiError(423, "locked"));
    const res = await t.call("server_power", { id: 42, mode: "on" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^The resource is locked because another action is running/);
  });

  it("server_power turns a failed action into action_failed", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/poweron", ok({ action: action(7, "running") }, 201))
      .on("GET", "/actions", {
        status: 200,
        body: {
          actions: [{ ...action(7, "error"), error: { code: "x", message: "y" } }],
        },
      });
    const res = await t.call("server_power", { id: 42, mode: "on" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Hetzner action 7 \(.*\) failed: x: y/);
  });
});

describe("server_power_force", () => {
  it("server_power_force asks for confirmation first", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", serverReply({ name: "web-1" }));
    const res = await t.call("server_power_force", { id: 42, mode: "off" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Confirmation required\. This would: power off server 42 "web-1"/);
    expect(t.fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("server_power_force resets after confirm", async () => {
    const t = await start();
    actionRoutes(t, "reset", {}, 9);
    const res = await t.call("server_power_force", { id: 42, mode: "reset", confirm: true });
    expect(res.isError).toBeFalsy();
    expect(t.fake.requests("POST", "/servers/{id}/actions/reset")).toHaveLength(1);
    expect((out(res).actions as Obj[])[0]?.status).toBe("success");
  });

  it.each([
    ["off", "poweroff"],
    ["reset", "reset"],
  ] as const)("server_power_force maps mode %s to its endpoint", async (mode, endpoint) => {
    const t = await start();
    actionRoutes(t, endpoint);
    await t.call("server_power_force", { id: 42, mode, confirm: true });
    expect(t.fake.requests("POST", `/servers/{id}/actions/${endpoint}`)).toHaveLength(1);
  });

  it("server_power_force checks scope before the preview", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: {} }));
    const res = await t.call("server_power_force", { id: 42, mode: "off" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource server 42 is outside the label scope/);
    expect(t.fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("server_power_force shows IaC warning in the confirmation", async () => {
    const t = await start({ iacPolicy: "warn" });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: { "managed-by": "terraform" } }));
    const res = await t.call("server_power_force", { id: 42, mode: "off" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("infrastructure-as-code marker 'managed-by=terraform'");
  });

  it("server_power_force runs without confirm if REQUIRE_CONFIRMATION=false", async () => {
    const t = await start({ requireConfirmation: false });
    actionRoutes(t, "poweroff");
    const res = await t.call("server_power_force", { id: 42, mode: "off" });
    expect(res.isError).toBeFalsy();
    expect(t.fake.requests("POST", "/servers/{id}/actions/poweroff")).toHaveLength(1);
  });

  it("server_power_force maps 503 without retry on POST", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/poweroff", apiError(503, "unavailable"));
    const res = await t.call("server_power_force", { id: 42, mode: "off", confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("[hetzner: unavailable, HTTP 503]");
    expect(t.fake.requests("POST", "/servers/{id}/actions/poweroff")).toHaveLength(1);
  });

  it("server_power_force quotes the name and strips control characters in the preview", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", serverReply({ name: "a\u0007b" }));
    const res = await t.call("server_power_force", { id: 42, mode: "off" });
    expect(textOf(res)).toContain('"ab"');
  });
});

describe("server_power_force annotations", () => {
  it("server_power_force is destructive and not idempotent", async () => {
    const t = await start();
    const tools = (await t.client.listTools()).tools;
    const a = tools.find((x) => x.name === "server_power_force")?.annotations;
    expect(a?.destructiveHint).toBe(true);
    expect(a?.idempotentHint).toBe(false);
  });
});

describe("server_rebuild annotations", () => {
  it("server_rebuild is destructive and not idempotent", async () => {
    const t = await start();
    const a = (await t.client.listTools()).tools.find(
      (x) => x.name === "server_rebuild",
    )?.annotations;
    expect(a?.destructiveHint).toBe(true);
    expect(a?.idempotentHint).toBe(false);
  });
});

describe("server_protection_set", () => {
  it("server_protection_set sends both flags together", async () => {
    const t = await start();
    actionRoutes(t, "change_protection", {}, 3);
    const res = await t.call("server_protection_set", { id: 42, protected: true, confirm: true });
    expect(bodyOf(t, "POST", "/servers/{id}/actions/change_protection")).toEqual({
      delete: true,
      rebuild: true,
    });
    expect(out(res).protection).toEqual({ delete: true, rebuild: true });
    expect(textOf(res)).toMatch(/^Requested protection on for server 42 \(action 3\)\./);
  });

  it("server_protection_set previews turning protection off", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", serverReply({ protection: { delete: true, rebuild: true } }));
    const res = await t.call("server_protection_set", { id: 42, protected: false });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: turn OFF delete and rebuild protection for server 42/,
    );
    expect(t.fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("server_protection_set notes an unchanged state", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", serverReply({ protection: { delete: true, rebuild: true } }));
    const res = await t.call("server_protection_set", { id: 42, protected: true });
    expect(textOf(res)).toContain("It already has this state");
  });

  it("server_protection_set respects the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: {} }));
    const res = await t.call("server_protection_set", { id: 42, protected: true, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource server 42 is outside the label scope/);
    expect(t.fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("server_protection_set maps locked", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/change_protection", apiError(423, "locked"));
    const res = await t.call("server_protection_set", { id: 42, protected: true, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("[hetzner: locked, HTTP 423]");
  });
});

// --- server lifecycle (AP-14) ----------------------------------------------------------------------

const P0 = (): HetznerPricing => fixture<{ pricing: HetznerPricing }>("get_pricing").pricing;
/** 03 E-13: P0 + cpx32 at 2.5000 / 2.9750 in fsn1. */
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
const pricingReply = (p: HetznerPricing = P0()) => ok({ pricing: p });

const E1_LINE =
  "Estimated cost: 2.00 EUR/month net (2.38 gross) = server 1.00 EUR/month net (1.19 gross) + new Primary IPv4 1.00 EUR/month net (1.19 gross). Server hourly price: 1.0000 EUR/hour net (1.1900 gross).";

const CREATE = {
  name: "web-1",
  server_type: "cpx22",
  image: "ubuntu-24.04",
  location: "fsn1",
  ssh_keys: ["admin"],
  public_net: { enable_ipv6: false },
};

/** create_server fixture without root password, with the given next_actions. */
const createReply = (over: Obj = {}) =>
  ok({ ...fixture<Obj>("create_server"), root_password: null, ...over }, 201);

function createRoutes(t: Harness, over: Obj = {}) {
  t.fake
    .on("POST", "/servers", createReply({ next_actions: [action(2, "running")], ...over }))
    .on("GET", "/actions", ok({ actions: [action(1, "success"), action(2, "success")] }));
}

const posts = (t: Harness, pattern: string) => t.fake.requests("POST", pattern).length;
const outcomeOf = (t: Harness) => logFields(t.logs, "tool_call").at(-1)?.outcome;

describe("server_create", () => {
  it("server_create previews before creating", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", pricingReply());
    const res = await t.call("server_create", CREATE);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Confirmation required\. This would: create server "web-1"/);
    expect(textOf(res)).toContain('SSH key "admin"');
    expect(textOf(res)).toContain("Estimated cost:");
    expect(posts(t, "/servers")).toBe(0);
  });

  it("server_create preview shows the cost and creates nothing (E-T1)", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", pricingReply());
    const res = await t.call("server_create", CREATE);
    expect(outcomeOf(t)).toBe("confirmation_required");
    expect(textOf(res)).toBe(
      `Confirmation required. This would: create server "web-1" (type "cpx22", location "fsn1", image "ubuntu-24.04", SSH key "admin", without public IPv6). ${E1_LINE} Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.`,
    );
    expect(posts(t, "/servers")).toBe(0);
  });

  it("server_create preview without pricing still asks for confirmation (E-T2)", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", apiError(503, "unavailable"));
    const res = await t.call("server_create", CREATE);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(COST_UNAVAILABLE);
    expect(textOf(res)).toMatch(/^Confirmation required\./);
    expect(outcomeOf(t)).toBe("confirmation_required");
    expect(posts(t, "/servers")).toBe(0);
  });

  it("server_create preview lists all optional parts", async () => {
    const t = await start({ iacPolicy: "off" }); // no volume/firewall reads
    t.fake.on("GET", "/pricing", pricingReply());
    const res = await t.call("server_create", {
      ...CREATE,
      ssh_keys: ["a", "b"],
      volumes: [7],
      firewalls: [3, 4],
      user_data: "#cloud-config\n",
      public_net: { enable_ipv4: false },
      start_after_create: false,
    });
    expect(textOf(res)).toContain(
      'create server "web-1" (type "cpx22", location "fsn1", image "ubuntu-24.04", SSH keys "a", "b", 1 volume(s), 2 firewall(s), with cloud-init user data (14 bytes), without public IPv4, not started after creation). Estimated cost: unknown (Hetzner lists no price for a Primary IPv6 in location "fsn1").',
    );
  });

  it("server_create preview names every SSH key (OE-39)", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", pricingReply());
    const res = await t.call("server_create", {
      ...CREATE,
      ssh_keys: ["laptop", "12345", 'x" key'],
    });
    expect(textOf(res)).toContain(
      'image "ubuntu-24.04", SSH keys "laptop", 12345, "x\\" key", without public IPv6).',
    );
    // Control characters in a key name never reach the preview: the schema rejects them first.
    const bad = await t.call("server_create", { ...CREATE, ssh_keys: ["evil\u0007key\u202e"] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).not.toContain("Confirmation required");
    expect(t.fake.requests("GET", "/pricing")).toHaveLength(1);
    expect(posts(t, "/servers")).toBe(0);
  });

  it("previews load pricing once per process (E-T5)", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", pricingReply());
    await t.call("server_create", CREATE);
    await t.call("server_create", CREATE);
    expect(t.fake.requests("GET", "/pricing")).toHaveLength(1);
  });

  it("confirm: true skips the pricing request (E-T6)", async () => {
    const t = await start();
    createRoutes(t);
    const res = await t.call("server_create", { ...CREATE, confirm: true });
    expect(res.isError).toBeFalsy();
    expect(t.fake.requests("GET", "/pricing")).toHaveLength(0);
  });

  it("server_create is a cost tool, not destructive", async () => {
    const t = await start();
    const tool = (await t.client.listTools()).tools.find((x) => x.name === "server_create");
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(false);
    expect(tool?.inputSchema.properties).toHaveProperty("confirm");
    expect(tool?.inputSchema.properties).toHaveProperty("wait");
  });

  it("server_create rejects disabling both public IPs", async () => {
    const t = await start();
    const res = await t.call("server_create", {
      ...CREATE,
      public_net: { enable_ipv4: false, enable_ipv6: false },
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Keep at least one of public_net\.enable_ipv4/);
    expect(outcomeOf(t)).toBe("bad_request");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("server_create sends enable_ipv4 false", async () => {
    const t = await start();
    createRoutes(t);
    await t.call("server_create", { ...CREATE, public_net: { enable_ipv4: false }, confirm: true });
    expect(bodyOf(t, "POST", "/servers").public_net).toEqual({ enable_ipv4: false });
    const { public_net: _omit, ...withoutNet } = CREATE;
    await t.call("server_create", { ...withoutNet, confirm: true });
    expect(t.fake.requests("POST", "/servers")[1]?.body).not.toHaveProperty("public_net");
  });

  it("server_create creates the server and waits for all actions", async () => {
    const t = await start();
    createRoutes(t);
    const res = await t.call("server_create", { ...CREATE, confirm: true });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(t, "POST", "/servers");
    expect(body).toMatchObject({
      name: "web-1",
      server_type: "cpx22",
      image: "ubuntu-24.04",
      ssh_keys: ["admin"],
      location: "fsn1",
      start_after_create: true,
      labels: {},
    });
    expect(body).not.toHaveProperty("datacenter");
    expect(body).not.toHaveProperty("root_password");
    expect(body).not.toHaveProperty("user_data");
    const actions = out(res).actions as Obj[];
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.status === "success")).toBe(true);
    expect((out(res).server as Obj).id).toBe(42);
    expect(textOf(res)).toBe(
      "Requested creation of server 42 (action 1, plus 1 follow-up action(s)). Final action status is in 'actions'.",
    );
  });

  it("server_create sends volumes, automount and firewalls as objects", async () => {
    const t = await start({ iacPolicy: "off" });
    createRoutes(t, { next_actions: [] });
    t.fake.on("GET", "/actions", ok({ actions: [action(1, "success")] }));
    const res = await t.call("server_create", {
      ...CREATE,
      volumes: [7],
      automount: true,
      firewalls: [3],
      confirm: true,
    });
    expect(bodyOf(t, "POST", "/servers")).toMatchObject({
      volumes: [7],
      automount: true,
      firewalls: [{ firewall: 3 }],
    });
    expect(textOf(res)).toBe(
      "Requested creation of server 42 (action 1). Final action status is in 'actions'.",
    );
  });

  it("server_create discards a returned root password", async () => {
    const t = await start();
    createRoutes(t, { root_password: "SENSITIVE-root" });
    const res = await t.call("server_create", { ...CREATE, confirm: true }); // harness: no leak (T-S1)
    expect(logFields(t.logs, "root_password_discarded")).toEqual([{ tool: "server_create" }]);
    expect(textOf(res)).toMatch(/Log in with the SSH key\.$/);
  });

  it("server_create requires at least one SSH key", async () => {
    const t = await start();
    for (const ssh_keys of [[], undefined]) {
      const res = await t.call("server_create", { ...CREATE, ssh_keys, confirm: true });
      expect(res.isError).toBe(true);
    }
    expect(t.fake.calls).toHaveLength(0);
  });

  it("server_create never echoes user_data", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", pricingReply());
    createRoutes(t);
    const args = { ...CREATE, user_data: "SENSITIVE-cloud-init" };
    const preview = await t.call("server_create", args);
    expect(textOf(preview)).toContain("with cloud-init user data (20 bytes)");
    const res = await t.call("server_create", { ...args, confirm: true });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(t, "POST", "/servers").user_data).toBe("SENSITIVE-cloud-init");
  });

  it("server_create rejects oversized user_data", async () => {
    const t = await start();
    for (const user_data of ["x".repeat(32_769), "ä".repeat(16_385)]) {
      const res = await t.call("server_create", { ...CREATE, user_data, confirm: true });
      expect(res.isError).toBe(true);
    }
    expect(t.fake.calls).toHaveLength(0);
  });

  it("server_create adds scope labels to the new server", async () => {
    const t = await start({ labelScope: [{ key: "managed-by", value: "hetzner-mcp" }] });
    t.fake.on("GET", "/pricing", pricingReply());
    createRoutes(t);
    const args = { ...CREATE, labels: { a: "1" } };
    const preview = await t.call("server_create", args);
    expect(textOf(preview)).toContain("It gets the labels managed-by=hetzner-mcp.");
    await t.call("server_create", { ...args, confirm: true });
    expect(bodyOf(t, "POST", "/servers").labels).toEqual({ a: "1", "managed-by": "hetzner-mcp" });
  });

  it("server_create rejects a conflicting scope label", async () => {
    const t = await start({ labelScope: [{ key: "managed-by", value: "hetzner-mcp" }] });
    const res = await t.call("server_create", { ...CREATE, labels: { "managed-by": "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Label 'managed-by' is reserved/);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("server_create checks attached volumes and firewalls against the scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/volumes/{id}", ok(fixture("get_volume")));
    const res = await t.call("server_create", { ...CREATE, volumes: [7], confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource volume 7 is outside the label scope/);
    expect(posts(t, "/servers")).toBe(0);
  });

  it("server_create does not read volumes or firewalls without scope or IaC policy", async () => {
    const t = await start({ iacPolicy: "off" });
    createRoutes(t);
    await t.call("server_create", { ...CREATE, volumes: [7], firewalls: [3], confirm: true });
    expect(t.fake.requests("GET", "/volumes/{id}")).toHaveLength(0);
    expect(t.fake.requests("GET", "/firewalls/{id}")).toHaveLength(0);
    expect(bodyOf(t, "POST", "/servers").volumes).toEqual([7]);
  });

  it("server_create blocks an IaC-marked firewall with policy block", async () => {
    const t = await start({ iacPolicy: "block" });
    t.fake.on(
      "GET",
      "/firewalls/{id}",
      ok(fixture("get_firewall", { firewall: { id: 3, labels: { "managed-by": "terraform" } } })),
    );
    const res = await t.call("server_create", { ...CREATE, firewalls: [3], confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Firewall 3 carries the infrastructure-as-code marker/);
    expect(posts(t, "/servers")).toBe(0);
  });

  it("server_create does not check the new server itself against IaC markers", async () => {
    const t = await start({ iacPolicy: "block" });
    createRoutes(t);
    const res = await t.call("server_create", {
      ...CREATE,
      labels: { "managed-by": "terraform" },
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    expect(t.fake.calls.filter((c) => c.method === "GET" && c.path !== "/actions")).toHaveLength(0);
  });

  it("server_create maps uniqueness_error and does not retry", async () => {
    const t = await start();
    t.fake.on(
      "POST",
      "/servers",
      apiError(409, "uniqueness_error", "taken", { fields: [{ name: "name" }] }),
    );
    const res = await t.call("server_create", { ...CREATE, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("A resource with the same unique value already exists: name.");
    expect(posts(t, "/servers")).toBe(1);
  });

  it("server_create never retries POST on 503", async () => {
    const t = await start();
    t.fake.on("POST", "/servers", apiError(503, "unavailable"));
    const res = await t.call("server_create", { ...CREATE, confirm: true });
    expect(res.isError).toBe(true);
    expect(outcomeOf(t)).toBe("unavailable");
    expect(posts(t, "/servers")).toBe(1);
  });

  it("server_create points to server_list filtered by name after a 502", async () => {
    const t = await start();
    t.fake.on("POST", "/servers", apiError(502, "bad_gateway"));
    const res = await t.call("server_create", { ...CREATE, confirm: true });
    expect(textOf(res)).toContain("with the matching *_list tool, filtered by name");
    expect(posts(t, "/servers")).toBe(1);
  });

  it("server_create respects HETZNER_MCP_MAX_MONTHLY_COST", async () => {
    const t = await start({ maxMonthlyCost: "1.99" });
    t.fake.on("GET", "/pricing", pricingReply());
    const res = await t.call("server_create", { ...CREATE, confirm: true });
    expect(res.isError).toBe(true);
    expect(outcomeOf(t)).toBe("guard");
    expect(textOf(res)).toMatch(
      /^Cost limit exceeded: this call adds an estimated 2\.00 EUR\/month net/,
    );
    expect(posts(t, "/servers")).toBe(0);
    await t.close();
    h = undefined;

    const t2 = await start({ maxMonthlyCost: "2.00" });
    t2.fake.on("GET", "/pricing", pricingReply());
    createRoutes(t2);
    const ok2 = await t2.call("server_create", { ...CREATE, confirm: true });
    expect(ok2.isError).toBeFalsy();
    expect(posts(t2, "/servers")).toBe(1);
  });

  it("server_create maps resource_limit_exceeded", async () => {
    const t = await start();
    t.fake.on(
      "POST",
      "/servers",
      apiError(403, "resource_limit_exceeded", "limit", { limits: [{ name: "server_count" }] }),
    );
    const res = await t.call("server_create", { ...CREATE, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("server_count");
  });

  it("server_create skips waiting with wait=false", async () => {
    const t = await start();
    t.fake.on("POST", "/servers", createReply({ next_actions: [action(2, "running")] }));
    const res = await t.call("server_create", { ...CREATE, confirm: true, wait: false });
    expect(t.fake.requests("GET", "/actions")).toHaveLength(0);
    expect((out(res).actions as Obj[]).map((a) => a.status)).toEqual(["running", "running"]);
  });

  it("server_create rejects invalid hostnames", async () => {
    const t = await start();
    const res = await t.call("server_create", { ...CREATE, name: "bad_name", confirm: true });
    expect(res.isError).toBe(true);
    expect(t.fake.calls).toHaveLength(0);
  });
});

/** E-T3 base: backups on, one volume, Primary IPv4 only, no Floating IP, protection off. */
const deleteTarget = (over: Obj = {}) =>
  serverReply({
    name: "web-1",
    backup_window: "22-02",
    volumes: [7],
    public_net: { ...(server().public_net as Obj), ipv6: null, floating_ips: [] },
    protection: { delete: false, rebuild: false },
    ...over,
  });

describe("server_delete", () => {
  it("server_delete asks for confirmation and does not delete", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", deleteTarget()).on("GET", "/pricing", pricingReply());
    const res = await t.call("server_delete", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: delete server "web-1" \(ID 42\) permanently/,
    );
    expect(t.fake.requests("DELETE", "/servers/{id}")).toHaveLength(0);
    expect(logFields(t.logs, "tool_call").at(-1)?.confirmed).toBe(false);
  });

  it("server_delete preview matches the documented example (E-T3)", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", deleteTarget()).on("GET", "/pricing", pricingReply());
    const res = await t.call("server_delete", { id: 42 });
    expect(textOf(res)).toBe(
      'Confirmation required. This would: delete server "web-1" (ID 42) permanently, including its disk and its backup images. Saves 1.20 EUR/month net (1.43 gross), including backups (+20.00 %). Not deleted and still billed if present: 1 volume(s) (detached); its Primary IPv4 unless auto_delete is enabled on it; snapshots created from it. Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.',
    );
  });

  it("server_delete deletes after confirm and waits", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("DELETE", "/servers/{id}", ok({ action: action(5, "running") }))
      .on("GET", "/actions", ok({ actions: [action(5, "success")] }));
    const res = await t.call("server_delete", { id: 42, confirm: true });
    expect(t.fake.requests("DELETE", "/servers/{id}")).toHaveLength(1);
    expect((out(res).actions as Obj[])[0]?.status).toBe("success");
    expect(out(res).server_id).toBe(42);
    expect(textOf(res)).toBe(
      "Requested deletion of server 42 (action 5). Final action status is in 'actions'.",
    );
  });

  it("server_delete preview warns about delete protection (E-T4)", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", deleteTarget({ protection: { delete: true, rebuild: true } }))
      .on("GET", "/pricing", pricingReply());
    const res = await t.call("server_delete", { id: 42 });
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: Hetzner will refuse this: server 42 has delete protection enabled\. Disable it first with server_protection_set\. delete server/,
    );
    expect(outcomeOf(t)).toBe("confirmation_required");
  });

  it("server_delete maps protected on confirm", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply({ protection: { delete: true, rebuild: true } }))
      .on("DELETE", "/servers/{id}", apiError(423, "protected"));
    const res = await t.call("server_delete", { id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(outcomeOf(t)).toBe("protected");
    expect(textOf(res)).toContain("*_protection_set");
  });

  it("server_delete refuses servers outside the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: {} }));
    const res = await t.call("server_delete", { id: 42 });
    expect(textOf(res)).toMatch(/^Resource server 42 is outside the label scope/);
    expect(t.fake.requests("DELETE", "/servers/{id}")).toHaveLength(0);
  });

  it("server_delete lists detached resources", async () => {
    const t = await start();
    t.fake
      .on(
        "GET",
        "/servers/{id}",
        deleteTarget({
          volumes: [7],
          public_net: { ...(server().public_net as Obj), floating_ips: [3] },
        }),
      )
      .on("GET", "/pricing", pricingReply());
    const res = await t.call("server_delete", { id: 42 });
    expect(textOf(res)).toContain("1 volume(s) (detached); 1 Floating IP(s) (detached)");
  });

  it("server_delete does not retry DELETE on 502", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("DELETE", "/servers/{id}", apiError(502, "bad_gateway"));
    const res = await t.call("server_delete", { id: 42, confirm: true });
    expect(t.fake.requests("DELETE", "/servers/{id}")).toHaveLength(1);
    expect(textOf(res)).toContain("check with the matching *_get");
  });

  it("server_delete blocks IaC-managed servers with policy block", async () => {
    const t = await start({ iacPolicy: "block" });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: { "managed-by": "terraform" } }));
    const res = await t.call("server_delete", { id: 42, confirm: true });
    expect(textOf(res)).toMatch(/^Server 42 carries the infrastructure-as-code marker/);
    expect(t.fake.requests("DELETE", "/servers/{id}")).toHaveLength(0);
  });
});

describe("server_rebuild", () => {
  const rebuildRoutes = (t: Harness, over: Obj = {}) =>
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on(
        "POST",
        "/servers/{id}/actions/rebuild",
        ok({ ...fixture<Obj>("rebuild_server"), root_password: null, ...over }, 201),
      )
      .on("GET", "/actions", ok({ actions: [action(13, "success")] }));

  it("server_rebuild previews data loss before acting", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", serverReply({ name: "web-1" }));
    const res = await t.call("server_rebuild", { id: 42, image: "ubuntu-24.04" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'Confirmation required. This would: rebuild server "web-1" (ID 42) from image "ubuntu-24.04". This destroys all data on its disk; Hetzner powers the server off first. Create a snapshot first (snapshot_create) if any data on it is still needed. Hetzner does not document whether the SSH keys of the server are injected again; no root password will be shown, so the server may become unreachable. No price change (the server type stays the same). Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.',
    );
    expect(posts(t, "/servers/{id}/actions/rebuild")).toBe(0);
  });

  it("server_rebuild rebuilds after confirm and waits", async () => {
    const t = await start();
    rebuildRoutes(t);
    const res = await t.call("server_rebuild", { id: 42, image: "ubuntu-24.04", confirm: true });
    expect(bodyOf(t, "POST", "/servers/{id}/actions/rebuild")).toEqual({ image: "ubuntu-24.04" });
    expect((out(res).actions as Obj[])[0]?.status).toBe("success");
    expect(textOf(res)).toBe(
      "Requested rebuild of server 42 (action 13). Final action status is in 'actions'.",
    );
    expect(logFields(t.logs, "root_password_discarded")).toEqual([]);
  });

  it("server_rebuild discards a returned root password", async () => {
    const t = await start();
    rebuildRoutes(t, { root_password: "SENSITIVE-root" });
    const res = await t.call("server_rebuild", { id: 42, image: "ubuntu-24.04", confirm: true });
    expect(logFields(t.logs, "root_password_discarded")).toEqual([{ tool: "server_rebuild" }]);
    expect(textOf(res)).toMatch(/Log in with the SSH key\.$/);
  });

  it("server_rebuild never echoes user_data", async () => {
    const t = await start();
    rebuildRoutes(t);
    const args = { id: 42, image: "ubuntu-24.04", user_data: "SENSITIVE-cloud-init" };
    const preview = await t.call("server_rebuild", args);
    expect(textOf(preview)).toContain("with cloud-init user data (20 bytes)");
    await t.call("server_rebuild", { ...args, confirm: true });
    expect(bodyOf(t, "POST", "/servers/{id}/actions/rebuild").user_data).toBe(
      "SENSITIVE-cloud-init",
    );
  });

  it("server_rebuild preview warns about rebuild protection", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", serverReply({ protection: { delete: true, rebuild: true } }));
    const res = await t.call("server_rebuild", { id: 42, image: "ubuntu-24.04" });
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: Hetzner will refuse this: server 42 has rebuild protection enabled\./,
    );
  });

  it("server_rebuild maps protected", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/rebuild", apiError(423, "protected"));
    const res = await t.call("server_rebuild", { id: 42, image: "x", confirm: true });
    expect(res.isError).toBe(true);
    expect(outcomeOf(t)).toBe("protected");
  });

  it("server_rebuild respects the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: {} }));
    const res = await t.call("server_rebuild", { id: 42, image: "x", confirm: true });
    expect(textOf(res)).toMatch(/^Resource server 42 is outside the label scope/);
    expect(posts(t, "/servers/{id}/actions/rebuild")).toBe(0);
  });
});

describe("server_change_type", () => {
  const changeRoutes = (t: Harness, over: Obj = {}) =>
    t.fake
      .on("GET", "/servers/{id}", serverReply(over))
      .on("POST", "/servers/{id}/actions/change_type", ok({ action: action(4, "running") }, 201))
      .on("GET", "/actions", ok({ actions: [action(4, "success")] }));

  it("server_change_type previews price change and disk irreversibility", async () => {
    const t = await start();
    t.fake
      .on(
        "GET",
        "/servers/{id}",
        serverReply({
          name: "web-1",
          status: "off",
          backup_window: null,
          server_type: { ...(server().server_type as Obj), name: "cpx22" },
          location: { ...(server().location as Obj), name: "fsn1" },
        }),
      )
      .on("GET", "/pricing", pricingReply(withCpx32()));
    const res = await t.call("server_change_type", {
      id: 42,
      server_type: "cpx32",
      upgrade_disk: true,
    });
    expect(textOf(res)).toBe(
      'Confirmation required. This would: change server "web-1" (ID 42) from type "cpx22" to "cpx32", upgrading the disk (the server can then no longer be downgraded to a type with a smaller disk). The server must be powered off; Hetzner copies its disk and starts it again. Price change: +1.50 EUR/month net (+1.79 gross): from 1.00 to 2.50 EUR/month net. Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.',
    );
    expect(posts(t, "/servers/{id}/actions/change_type")).toBe(0);
  });

  it("server_change_type defaults upgrade_disk to false", async () => {
    const t = await start();
    changeRoutes(t);
    await t.call("server_change_type", { id: 42, server_type: "cpx32", confirm: true });
    expect(bodyOf(t, "POST", "/servers/{id}/actions/change_type")).toEqual({
      server_type: "cpx32",
      upgrade_disk: false,
    });
  });

  it("server_change_type changes the type after confirm and waits", async () => {
    const t = await start();
    changeRoutes(t);
    const res = await t.call("server_change_type", { id: 42, server_type: "cpx32", confirm: true });
    expect(posts(t, "/servers/{id}/actions/change_type")).toBe(1);
    expect((out(res).actions as Obj[])[0]?.status).toBe("success");
    expect(textOf(res)).toBe(
      "Requested type change for server 42 (action 4). Final action status is in 'actions'.",
    );
  });

  it("server_change_type preview notes a running server", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply({ status: "running" }))
      .on("GET", "/pricing", pricingReply());
    const res = await t.call("server_change_type", { id: 42, server_type: "cpx32" });
    expect(textOf(res)).toContain(
      "The server is currently running; Hetzner will refuse the change until it is off (use server_power with mode shutdown first).",
    );
    expect(textOf(res)).toContain("keeping the disk size (a later downgrade stays possible)");
  });

  it("server_change_type maps server_not_stopped", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/change_type", apiError(422, "server_not_stopped"));
    const res = await t.call("server_change_type", { id: 42, server_type: "cpx32", confirm: true });
    expect(outcomeOf(t)).toBe("conflict");
    expect(textOf(res)).toMatch(/^The server must be powered off for this action\./);
  });

  it("server_change_type maps invalid_server_type", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", serverReply())
      .on("POST", "/servers/{id}/actions/change_type", apiError(422, "invalid_server_type"));
    const res = await t.call("server_change_type", { id: 42, server_type: "cx99", confirm: true });
    expect(outcomeOf(t)).toBe("bad_request");
    expect(textOf(res)).toContain("catalog_server_types");
  });

  it("server_change_type never blocks a downgrade by the cost limit", async () => {
    const typed = (name: string) => ({
      backup_window: null,
      server_type: { ...(server().server_type as Obj), name },
      location: { ...(server().location as Obj), name: "fsn1" },
    });
    const t = await start({ maxMonthlyCost: "0" });
    t.fake.on("GET", "/pricing", pricingReply(withCpx32()));
    changeRoutes(t, typed("cpx32"));
    const down = await t.call("server_change_type", {
      id: 42,
      server_type: "cpx22",
      confirm: true,
    });
    expect(down.isError).toBeFalsy();
    expect(posts(t, "/servers/{id}/actions/change_type")).toBe(1);

    t.fake.on("GET", "/servers/{id}", serverReply(typed("cpx22")));
    const up = await t.call("server_change_type", { id: 42, server_type: "cpx32", confirm: true });
    expect(up.isError).toBe(true);
    expect(outcomeOf(t)).toBe("guard");
    expect(textOf(up)).toMatch(/^Cost limit exceeded: this call adds an estimated 1\.50 EUR/);
    expect(posts(t, "/servers/{id}/actions/change_type")).toBe(1);
  });

  it("server_change_type respects the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", serverReply({ labels: {} }));
    const res = await t.call("server_change_type", { id: 42, server_type: "cpx32" });
    expect(textOf(res)).toMatch(/^Resource server 42 is outside the label scope/);
    expect(posts(t, "/servers/{id}/actions/change_type")).toBe(0);
  });
});

describe("server lifecycle annotations", () => {
  it("lifecycle tools confirm; only server_create is not destructive", async () => {
    const t = await start();
    const tools = (await t.client.listTools()).tools;
    for (const name of ["server_delete", "server_rebuild", "server_change_type"]) {
      const tool = tools.find((x) => x.name === name);
      expect(tool?.annotations?.destructiveHint).toBe(true);
      expect(tool?.annotations?.idempotentHint).toBe(name !== "server_rebuild");
      expect(tool?.inputSchema.properties).toHaveProperty("confirm");
      expect(tool?.inputSchema.properties).toHaveProperty("wait");
    }
  });

  it("cost tools disappear with HETZNER_MCP_ALLOW_COSTS=false", async () => {
    const t = await start({ allowCosts: false });
    const names = (await t.client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain("server_create");
    expect(names).not.toContain("server_change_type");
    expect(names).toContain("server_delete");
    expect(names).toContain("server_rebuild");
  });
});
