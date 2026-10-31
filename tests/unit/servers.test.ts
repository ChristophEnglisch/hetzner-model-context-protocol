import { afterEach, describe, expect, it } from "vitest";
import { action, apiError, ok } from "../helpers/fake-hetzner.js";
import { fixture } from "../helpers/fixtures.js";
import { type Harness, startHarness, textOf } from "../helpers/harness.js";

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
