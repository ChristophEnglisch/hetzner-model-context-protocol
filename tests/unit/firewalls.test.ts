import { afterEach, describe, expect, it } from "vitest";
import { action, apiError, noContent, ok } from "../helpers/fake-hetzner.js";
import { fixture } from "../helpers/fixtures.js";
import { type Harness, startHarness, textOf } from "../helpers/harness.js";

const SCOPE = [{ key: "managed-by", value: "mcp" }];
const IN_SCOPE = { "managed-by": "mcp" };

type Obj = Record<string, unknown>;
const firewall = (over: Obj = {}): Obj => ({
  ...(fixture<{ firewall: Obj }>("get_firewall").firewall as Obj),
  ...over,
});
const fwReply = (over: Obj = {}, status = 200) => ok({ firewall: firewall(over) }, status);
const server = (over: Obj = {}) => ok({ server: { id: 7, labels: {}, ...over } });

const bodyOf = (t: Harness, method: "POST" | "PUT", pattern: string): Obj =>
  (t.fake.requests(method, pattern)[0]?.body ?? {}) as Obj;

const SSH_IN: Obj = { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0"] };

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function start(config: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  h = await startHarness(config);
  return h;
}

/** Routes for a set_rules/apply/remove call that creates running actions 1 and 2 and finishes them on polling. */
function actionRoutes(t: Harness, pattern: string, final: "success" | "error" = "success") {
  t.fake
    .on("POST", pattern, ok({ actions: [action(1, "running"), action(2, "running")] }, 201))
    .on("GET", "/actions", ok({ actions: [action(1, final), action(2, "success")] }));
}

describe("firewall_list", () => {
  it("firewall_list returns projected items", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls", ok(fixture("list_firewalls")));
    const res = await t.call("firewall_list");
    const items = (res.structuredContent as { items: Obj[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 42, rule_count: 1, applied_to_count: 1 });
    expect(items[0]).not.toHaveProperty("rules");
    expect(items[0]).not.toHaveProperty("applied_to");
    expect(textOf(res)).toBe("Found 1 firewall(s) on page 3; more pages available.");
  });

  it("firewall_list reports more pages", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/firewalls",
      ok(
        fixture("list_firewalls", {
          meta: { pagination: { page: 1, next_page: 2, total_entries: 30 } },
        }),
      ),
    );
    const res = await t.call("firewall_list");
    expect((res.structuredContent as { next_page: number }).next_page).toBe(2);
    expect(textOf(res)).toContain("more pages available");
  });

  it("firewall_list has no more-pages text on the last page", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/firewalls",
      ok(fixture("list_firewalls", { meta: { pagination: { page: 1, next_page: null } } })),
    );
    expect(textOf(await t.call("firewall_list"))).toBe("Found 1 firewall(s) on page 1.");
  });

  it("firewall_list passes filters and sort", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls", ok(fixture("list_firewalls")));
    await t.call("firewall_list", {
      name: "web",
      label_selector: "env=prod",
      sort: "name:desc",
      per_page: 50,
    });
    const q = t.fake.requests("GET", "/firewalls")[0]?.query;
    expect(q?.get("name")).toBe("web");
    expect(q?.get("label_selector")).toBe("env=prod");
    expect(q?.get("sort")).toBe("name:desc");
    expect(q?.get("per_page")).toBe("50");
  });

  it("firewall_list maps an API error", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls", apiError(401, "unauthorized"));
    const res = await t.call("firewall_list");
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Hetzner rejected the API token/);
  });
});

describe("firewall_get", () => {
  it("firewall_get returns rules and targets", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", ok(fixture("get_firewall")));
    const res = await t.call("firewall_get", { id: 42 });
    const out = res.structuredContent as { rules: Obj[]; applied_to: Obj[] };
    expect(out.rules[0]?.direction).toBe("in");
    expect(out.applied_to[0]).toMatchObject({
      type: "server",
      server_id: 42,
      label_selector: null,
      resource_server_ids: [42],
    });
    expect(textOf(res)).toBe("Firewall 42: 1 rule(s), applied to 1 target(s).");
  });

  it("firewall_get fills missing rule fields and labels", async () => {
    const t = await start();
    const bare = firewall({ rules: [{ direction: "in", protocol: "tcp" }] });
    delete bare.labels;
    t.fake.on("GET", "/firewalls/{id}", ok({ firewall: bare }));
    const res = await t.call("firewall_get", { id: 42 });
    const out = res.structuredContent as { rules: Obj[]; labels: Obj };
    expect(out.rules[0]).toMatchObject({
      port: null,
      description: null,
      source_ips: [],
      destination_ips: [],
    });
    expect(out.labels).toEqual({});
  });

  it("firewall_get maps 404", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", apiError(404, "not_found"));
    const res = await t.call("firewall_get", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Not found \(HTTP 404\)/);
  });
});

describe("firewall_create", () => {
  it("firewall_create posts name, rules and labels", async () => {
    const t = await start();
    t.fake.on("POST", "/firewalls", ok({ ...fixture<Obj>("create_firewall"), actions: [] }, 201));
    const res = await t.call("firewall_create", {
      name: "web",
      rules: [SSH_IN],
      labels: { env: "x" },
    });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(t, "POST", "/firewalls");
    expect(body).toEqual({ name: "web", rules: [SSH_IN], labels: { env: "x" } });
    expect(body).not.toHaveProperty("apply_to");
    expect((res.structuredContent as { id: number }).id).toBeTypeOf("number");
    expect(textOf(res)).toMatch(
      /^Created firewall \d+ with \d+ rule\(s\)\. It is not applied to any server yet\.$/,
    );
  });

  it("firewall_create adds scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("POST", "/firewalls", ok(fixture("create_firewall"), 201));
    await t.call("firewall_create", { name: "web" });
    expect((bodyOf(t, "POST", "/firewalls").labels as Obj)["managed-by"]).toBe("mcp");
  });

  it("firewall_create rejects conflicting scope label", async () => {
    const t = await start({ labelScope: SCOPE });
    const res = await t.call("firewall_create", { name: "web", labels: { "managed-by": "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Label 'managed-by' is reserved/);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("firewall_create rejects 51 rules", async () => {
    const t = await start();
    const res = await t.call("firewall_create", {
      name: "web",
      rules: Array.from({ length: 51 }, () => SSH_IN),
    });
    expect(res.isError).toBe(true);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("firewall_create rejects rule with destination_ips on direction in", async () => {
    const t = await start();
    const res = await t.call("firewall_create", {
      name: "web",
      rules: [{ ...SSH_IN, destination_ips: ["0.0.0.0/0"] }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("rule 1: destination_ips is not allowed");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("firewall_create rejects a port on icmp", async () => {
    const t = await start();
    const res = await t.call("firewall_create", {
      name: "web",
      rules: [SSH_IN, { direction: "in", protocol: "icmp", port: "1", source_ips: ["::/0"] }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("rule 2: port is not allowed");
  });

  it("firewall_create maps duplicate name", async () => {
    const t = await start();
    t.fake.on(
      "POST",
      "/firewalls",
      apiError(409, "uniqueness_error", "x", { fields: [{ name: "name" }] }),
    );
    const res = await t.call("firewall_create", { name: "web" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^A resource with the same unique value already exists: name\./);
  });
});

describe("firewall_update", () => {
  it("firewall_update renames and returns the response labels", async () => {
    const t = await start();
    t.fake
      .on("GET", "/firewalls/{id}", fwReply())
      .on("PUT", "/firewalls/{id}", fwReply({ name: "renamed", labels: { from: "response" } }));
    const res = await t.call("firewall_update", { id: 42, name: "renamed" });
    expect(bodyOf(t, "PUT", "/firewalls/{id}")).toEqual({ name: "renamed" });
    expect(res.structuredContent).toMatchObject({ name: "renamed", labels: { from: "response" } });
    expect(textOf(res)).toBe("Updated firewall 42: name.");
  });

  it("firewall_update keeps scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on("GET", "/firewalls/{id}", fwReply({ labels: IN_SCOPE }))
      .on("PUT", "/firewalls/{id}", fwReply({ labels: IN_SCOPE }));
    await t.call("firewall_update", { id: 42, labels: { env: "x" } });
    expect(bodyOf(t, "PUT", "/firewalls/{id}").labels).toEqual({ env: "x", "managed-by": "mcp" });
  });

  it("firewall_update blocks out-of-scope firewall", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/firewalls/{id}", fwReply({ labels: {} }));
    const res = await t.call("firewall_update", { id: 42, name: "x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource firewall 42 is outside the label scope/);
    expect(t.fake.requests("PUT", "/firewalls/{id}")).toHaveLength(0);
  });

  it("firewall_update warns on terraform marker", async () => {
    const t = await start({ iacPolicy: "warn" });
    const labels = { "managed-by": "terraform" };
    t.fake
      .on("GET", "/firewalls/{id}", fwReply({ labels }))
      .on("PUT", "/firewalls/{id}", fwReply({ labels }));
    const res = await t.call("firewall_update", { id: 42, name: "x" });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { warnings: string[] }).warnings[0]).toMatch(
      /^Warning: firewall/,
    );
  });

  it("firewall_update blocks terraform marker with policy block", async () => {
    const t = await start({ iacPolicy: "block" });
    t.fake.on("GET", "/firewalls/{id}", fwReply({ labels: { "managed-by": "terraform" } }));
    const res = await t.call("firewall_update", { id: 42, name: "x" });
    expect(res.isError).toBe(true);
    expect(t.fake.requests("PUT", "/firewalls/{id}")).toHaveLength(0);
  });

  it("firewall_update requires a field", async () => {
    const t = await start();
    const res = await t.call("firewall_update", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Provide name, labels, or both.");
    expect(t.fake.calls).toHaveLength(0);
  });
});

describe("firewall_set_rules", () => {
  it("firewall_set_rules asks for confirmation with a preview", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", ok(fixture("get_firewall")));
    const res = await t.call("firewall_set_rules", { id: 42, rules: [SSH_IN, SSH_IN] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      // {n} counts rules after de-duplication (03 §3.6): two identical rules are one.
      /^Confirmation required\. This would: replace all 1 rule\(s\) of firewall "new-name" \(ID 42\) with 1 rule\(s\); it is applied to 1 server\(s\)\./,
    );
    expect(textOf(res)).toContain("Nothing was changed");
    expect(t.fake.requests("POST", "/firewalls/{id}/actions/set_rules")).toHaveLength(0);
  });

  it("firewall_set_rules with an empty list", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", ok(fixture("get_firewall")));
    const res = await t.call("firewall_set_rules", { id: 42, rules: [] });
    expect(textOf(res)).toContain("with 0 rule(s)");
  });

  it("firewall_set_rules counts distinct servers in the preview", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/firewalls/{id}",
      fwReply({
        applied_to: [
          { type: "server", server: { id: 1 } },
          {
            type: "label_selector",
            label_selector: { selector: "a=b" },
            applied_to_resources: [
              { type: "server", server: { id: 1 } },
              { type: "server", server: { id: 2 } },
            ],
          },
        ],
      }),
    );
    const res = await t.call("firewall_set_rules", { id: 42, rules: [] });
    expect(textOf(res)).toContain("it is applied to 2 server(s).");
  });

  it("firewall_set_rules sends the rules and waits for all actions", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", ok(fixture("get_firewall")));
    actionRoutes(t, "/firewalls/{id}/actions/set_rules");
    const res = await t.call("firewall_set_rules", { id: 42, rules: [SSH_IN], confirm: true });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(t, "POST", "/firewalls/{id}/actions/set_rules")).toEqual({ rules: [SSH_IN] });
    const out = res.structuredContent as { actions: Obj[]; rule_count: number };
    expect(out.rule_count).toBe(1);
    expect(out.actions.map((a) => a.status)).toEqual(["success", "success"]);
    expect(textOf(res)).toBe("Set 1 rule(s) on firewall 42.");
  });

  it("firewall_set_rules with wait=false returns running actions", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", ok(fixture("get_firewall")));
    actionRoutes(t, "/firewalls/{id}/actions/set_rules");
    const res = await t.call("firewall_set_rules", {
      id: 42,
      rules: [SSH_IN],
      confirm: true,
      wait: false,
    });
    expect(t.fake.requests("GET", "/actions")).toHaveLength(0);
    const out = res.structuredContent as { actions: Obj[] };
    expect(out.actions.map((a) => a.status)).toEqual(["running", "running"]);
  });

  it("firewall_set_rules turns a failed action into action_failed", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", ok(fixture("get_firewall")));
    actionRoutes(t, "/firewalls/{id}/actions/set_rules", "error");
    const res = await t.call("firewall_set_rules", { id: 42, rules: [SSH_IN], confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Hetzner action/);
  });

  it("firewall_set_rules blocks out-of-scope firewall before the preview", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/firewalls/{id}", fwReply({ labels: {} }));
    const res = await t.call("firewall_set_rules", { id: 42, rules: [] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource firewall 42 is outside the label scope/);
    expect(textOf(res)).not.toContain("Confirmation required");
  });

  it("firewall_set_rules rejects more than 50 rules", async () => {
    const t = await start();
    const res = await t.call("firewall_set_rules", {
      id: 42,
      rules: Array.from({ length: 51 }, () => SSH_IN),
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("firewall_set_rules is hidden in read-only mode", async () => {
    const t = await start({ readOnly: true });
    const names = (await t.client.listTools()).tools.map((x) => x.name);
    expect(names).toContain("firewall_get");
    expect(names).not.toContain("firewall_set_rules");
  });
});

describe("firewall_apply_to_resources", () => {
  it("firewall_apply_to_resources applies servers and selectors", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", fwReply()).on("GET", "/servers/{id}", server());
    actionRoutes(t, "/firewalls/{id}/actions/apply_to_resources");
    const res = await t.call("firewall_apply_to_resources", {
      id: 42,
      server_ids: [7, 8],
      label_selectors: ["env=prod"],
    });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(t, "POST", "/firewalls/{id}/actions/apply_to_resources")).toEqual({
      apply_to: [
        { type: "server", server: { id: 7 } },
        { type: "server", server: { id: 8 } },
        { type: "label_selector", label_selector: { selector: "env=prod" } },
      ],
    });
    expect(t.fake.requests("GET", "/servers/{id}")).toHaveLength(2);
    const out = res.structuredContent as { actions: Obj[] };
    expect(out.actions.map((a) => a.status)).toEqual(["success", "success"]);
    // The fixture firewall only allows port 80, so the F-03 note for port 22 follows (03 §3.6).
    expect(textOf(res)).toBe(
      "Applying firewall 42 to 2 server(s) and 1 label selector(s). Note: firewall 42 does not allow inbound TCP port 22; servers it is applied to are reachable on that port only if another firewall on them allows it.",
    );
  });

  it("firewall_apply_to_resources rejects a call without targets", async () => {
    const t = await start();
    const res = await t.call("firewall_apply_to_resources", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Provide at least one of server_ids or label_selectors.");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("firewall_apply_to_resources blocks a server outside the scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on("GET", "/firewalls/{id}", fwReply({ labels: IN_SCOPE }))
      .on("GET", "/servers/{id}", server({ labels: {} }));
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource server 7 is outside the label scope/);
    expect(t.fake.requests("POST", "/firewalls/{id}/actions/apply_to_resources")).toHaveLength(0);
  });

  it("firewall_apply_to_resources requires scope terms in the selector", async () => {
    const t = await start({ labelScope: SCOPE });
    const res = await t.call("firewall_apply_to_resources", {
      id: 42,
      label_selectors: ["env=x"],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /^In label-scope mode a label selector must contain every scope term/,
    );
    expect(t.fake.calls).toHaveLength(0);
  });

  it("firewall_apply_to_resources accepts a selector containing the scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/firewalls/{id}", fwReply({ labels: IN_SCOPE }));
    actionRoutes(t, "/firewalls/{id}/actions/apply_to_resources");
    const res = await t.call("firewall_apply_to_resources", {
      id: 42,
      label_selectors: ["managed-by=mcp,env=x"],
    });
    expect(res.isError).toBeFalsy();
  });

  it("firewall_apply_to_resources warns on terraform-managed server", async () => {
    const t = await start({ iacPolicy: "warn" });
    t.fake
      .on("GET", "/firewalls/{id}", fwReply())
      .on("GET", "/servers/{id}", server({ labels: { "managed-by": "terraform" } }));
    actionRoutes(t, "/firewalls/{id}/actions/apply_to_resources");
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { warnings: string[] }).warnings[0]).toMatch(
      /^Warning: server 7/,
    );
  });

  it("firewall_apply_to_resources maps already applied", async () => {
    const t = await start();
    t.fake
      .on("GET", "/firewalls/{id}", fwReply())
      .on("GET", "/servers/{id}", server())
      .on(
        "POST",
        "/firewalls/{id}/actions/apply_to_resources",
        apiError(422, "firewall_already_applied"),
      );
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("The firewall is already applied to this resource");
  });

  it("firewall_apply_to_resources maps a missing resource", async () => {
    const t = await start();
    t.fake
      .on("GET", "/firewalls/{id}", fwReply())
      .on("GET", "/servers/{id}", server())
      .on(
        "POST",
        "/firewalls/{id}/actions/apply_to_resources",
        apiError(404, "firewall_resource_not_found"),
      );
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(
      "A resource the firewall should be applied to or removed from was not found",
    );
  });

  it("firewall_apply_to_resources rejects duplicate server IDs", async () => {
    const t = await start();
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7, 7] });
    expect(res.isError).toBe(true);
    expect(t.fake.calls).toHaveLength(0);
  });
});

describe("firewall_remove_from_resources", () => {
  it("firewall_remove_from_resources removes servers and waits", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", fwReply()).on("GET", "/servers/{id}", server());
    actionRoutes(t, "/firewalls/{id}/actions/remove_from_resources");
    const res = await t.call("firewall_remove_from_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(t, "POST", "/firewalls/{id}/actions/remove_from_resources")).toEqual({
      remove_from: [{ type: "server", server: { id: 7 } }],
    });
    const out = res.structuredContent as { actions: Obj[] };
    expect(out.actions.map((a) => a.status)).toEqual(["success", "success"]);
    expect(textOf(res)).toBe("Removing firewall 42 from 1 server(s) and 0 label selector(s).");
  });

  it("firewall_remove_from_resources rejects a call without targets", async () => {
    const t = await start();
    const res = await t.call("firewall_remove_from_resources", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Provide at least one of server_ids or label_selectors.");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("firewall_remove_from_resources blocks an out-of-scope server", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on("GET", "/firewalls/{id}", fwReply({ labels: IN_SCOPE }))
      .on("GET", "/servers/{id}", server({ labels: {} }));
    const res = await t.call("firewall_remove_from_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource server 7 is outside the label scope/);
    expect(t.fake.requests("POST", "/firewalls/{id}/actions/remove_from_resources")).toHaveLength(
      0,
    );
  });

  it("firewall_remove_from_resources requires scope terms in the selector", async () => {
    const t = await start({ labelScope: SCOPE });
    const res = await t.call("firewall_remove_from_resources", {
      id: 42,
      label_selectors: ["env=x"],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^In label-scope mode a label selector must contain/);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("firewall_remove_from_resources maps the selector conflict", async () => {
    const t = await start();
    t.fake
      .on("GET", "/firewalls/{id}", fwReply())
      .on("GET", "/servers/{id}", server())
      .on(
        "POST",
        "/firewalls/{id}/actions/remove_from_resources",
        apiError(422, "firewall_managed_by_label_selector"),
      );
    const res = await t.call("firewall_remove_from_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^The firewall is applied to this server through a label selector/);
  });
});

describe("firewall_delete", () => {
  it("firewall_delete asks for confirmation", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", ok(fixture("get_firewall")));
    const res = await t.call("firewall_delete", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: permanently delete firewall "new-name" \(ID 42\) with 1 rule\(s\)\. It is currently applied to 1 target\(s\)/,
    );
    expect(t.fake.requests("DELETE", "/firewalls/{id}")).toHaveLength(0);
  });

  it("firewall_delete deletes with confirm", async () => {
    const t = await start();
    t.fake
      .on("GET", "/firewalls/{id}", ok(fixture("get_firewall")))
      .on("DELETE", "/firewalls/{id}", noContent());
    const res = await t.call("firewall_delete", { id: 42, confirm: true });
    expect(res.structuredContent).toEqual({ id: 42, deleted: true });
    expect(textOf(res)).toBe("Deleted firewall 42.");
  });

  it("firewall_delete preview warns when still applied", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", ok(fixture("get_firewall")));
    expect(textOf(await t.call("firewall_delete", { id: 42 }))).toContain(
      "; deletion will fail until it is removed from all of them.",
    );
  });

  it("firewall_delete preview has no failure hint when unused", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", fwReply({ applied_to: [] }));
    const text = textOf(await t.call("firewall_delete", { id: 42 }));
    expect(text).toContain("applied to 0 target(s).");
    expect(text).not.toContain("deletion will fail");
  });

  it("firewall_delete maps resource_in_use", async () => {
    const t = await start();
    t.fake
      .on("GET", "/firewalls/{id}", ok(fixture("get_firewall")))
      .on("DELETE", "/firewalls/{id}", apiError(422, "resource_in_use"));
    const res = await t.call("firewall_delete", { id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("The firewall is still applied to resources");
  });

  it("firewall_delete blocks an out-of-scope firewall", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/firewalls/{id}", fwReply({ labels: {} }));
    const res = await t.call("firewall_delete", { id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource firewall 42 is outside the label scope/);
    expect(t.fake.requests("DELETE", "/firewalls/{id}")).toHaveLength(0);
  });

  it("firewall_delete with requireConfirmation=false skips the confirmation", async () => {
    const t = await start({ requireConfirmation: false });
    t.fake
      .on("GET", "/firewalls/{id}", ok(fixture("get_firewall")))
      .on("DELETE", "/firewalls/{id}", noContent());
    const res = await t.call("firewall_delete", { id: 42 });
    expect(res.isError).toBeFalsy();
    expect(t.fake.requests("DELETE", "/firewalls/{id}")).toHaveLength(1);
  });
});

describe("firewalls toolset", () => {
  it("registers eight tools with the specified kinds and annotations", async () => {
    const t = await start();
    const tools = (await t.client.listTools()).tools.filter((x) => x.name.startsWith("firewall_"));
    const a = (name: string) => tools.find((x) => x.name === name)?.annotations;
    expect(tools).toHaveLength(8);
    expect(a("firewall_list")).toMatchObject({ readOnlyHint: true });
    expect(a("firewall_update")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(a("firewall_create")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(a("firewall_set_rules")).toMatchObject({ destructiveHint: true });
    expect(a("firewall_delete")).toMatchObject({ destructiveHint: true });
  });
});

describe("F-03 firewall diff and lock-out texts (03 §3.6, AP-16)", () => {
  const any = ["0.0.0.0/0", "::/0"];
  const rule = (port: string | undefined, ips: string[] = any): Obj => ({
    direction: "in",
    protocol: "tcp",
    ...(port !== undefined && { port }),
    source_ips: ips,
  });
  const APPLIED_2 = [
    { type: "server", server: { id: 1 } },
    {
      type: "label_selector",
      label_selector: { selector: "a=b" },
      applied_to_resources: [
        { type: "server", server: { id: 1 } },
        { type: "server", server: { id: 2 } },
      ],
    },
  ];
  const F8_OLD = [rule("22"), rule("443")];
  const F8_NEW = [rule("443")];
  const edge = (rules: Obj[], appliedTo: unknown[] = APPLIED_2) =>
    fwReply({ id: 42, name: "edge", rules, applied_to: appliedTo });
  const WARN_22 =
    "Warning: after this change, firewall 42 no longer allows inbound TCP port 22 from any address; the 2 server(s) it is applied to lose access on that port unless another firewall on them allows it.";
  const API =
    "Firewall rules can be changed again through the API at any time, even if SSH is blocked.";
  const NO_INBOUND =
    "The new rules contain no inbound rule; Hetzner then drops all inbound traffic to the servers this firewall is applied to.";
  const CONFIRM =
    "Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.";

  it("set_rules preview shows the rule diff and creates no action", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge(F8_OLD));
    const res = await t.call("firewall_set_rules", { id: 42, rules: F8_NEW });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      `Confirmation required. This would: replace all 2 rule(s) of firewall "edge" (ID 42) with 1 rule(s); it is applied to 2 server(s). Rule changes (order and descriptions ignored): 0 added, 1 removed, 1 unchanged. Removed: in tcp 22 from 0.0.0.0/0, ::/0. ${WARN_22} ${API} ${CONFIRM}`,
    );
    expect(t.fake.requests("POST", "/firewalls/{id}/actions/set_rules")).toHaveLength(0);
  });

  it("set_rules summary repeats the lockout warning", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge(F8_OLD));
    actionRoutes(t, "/firewalls/{id}/actions/set_rules");
    const res = await t.call("firewall_set_rules", { id: 42, rules: F8_NEW, confirm: true });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe(`Set 1 rule(s) on firewall 42. ${WARN_22}`);
    expect((res.structuredContent as { warnings?: string[] }).warnings ?? []).toEqual([]);
  });

  it("set_rules summary names the missing inbound rule without the API sentence", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge(F8_OLD));
    actionRoutes(t, "/firewalls/{id}/actions/set_rules");
    const res = await t.call("firewall_set_rules", { id: 42, rules: [], confirm: true });
    expect(textOf(res)).toBe(`Set 0 rule(s) on firewall 42. ${WARN_22} ${NO_INBOUND}`);
  });

  it("set_rules preview for an empty list (F-9)", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge(F8_OLD));
    const res = await t.call("firewall_set_rules", { id: 42, rules: [] });
    expect(textOf(res)).toContain(
      "0 added, 2 removed, 0 unchanged. Removed: in tcp 22 from 0.0.0.0/0, ::/0; in tcp 443 from 0.0.0.0/0, ::/0.",
    );
    expect(textOf(res)).toContain(`${WARN_22} ${NO_INBOUND} ${API} Nothing was changed.`);
  });

  it("set_rules preview without lockout but without inbound rule (F-13)", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge([rule("80", ["0.0.0.0/0"])]));
    const res = await t.call("firewall_set_rules", { id: 42, rules: [] });
    expect(textOf(res)).toContain(`in tcp 80 from 0.0.0.0/0. ${NO_INBOUND} Nothing was changed.`);
    expect(textOf(res)).not.toContain("Warning:");
    expect(textOf(res)).not.toContain(API);
  });

  it("set_rules preview for a firewall that is not applied (F-14)", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge(F8_OLD, []));
    const res = await t.call("firewall_set_rules", { id: 42, rules: F8_NEW });
    expect(textOf(res)).toContain(
      "it is applied to 0 server(s). Rule changes (order and descriptions ignored): 0 added, 1 removed, 1 unchanged. Removed: in tcp 22 from 0.0.0.0/0, ::/0. The firewall is not applied to any server, so no server is affected now. Nothing was changed.",
    );
    expect(textOf(res)).not.toContain("Warning:");
  });

  it("set_rules preview names a lost address family (F-10)", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge([rule("22")]));
    const res = await t.call("firewall_set_rules", { id: 42, rules: [rule("22", ["::/0"])] });
    expect(textOf(res)).toContain(
      "Added: in tcp 22 from ::/0. Removed: in tcp 22 from 0.0.0.0/0, ::/0. Warning: after this change, firewall 42 no longer allows inbound TCP port 22 over IPv4 (only IPv6 sources remain). Firewall rules can be changed again",
    );
  });

  it("set_rules preview ignores order, duplicates and descriptions", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge(F8_OLD));
    const res = await t.call("firewall_set_rules", {
      id: 42,
      rules: [
        { ...rule("443"), description: "web" },
        rule("22-22", ["::/0", "0.0.0.0/0"]),
        rule("443"),
      ],
    });
    expect(textOf(res)).toContain(
      'replace all 2 rule(s) of firewall "edge" (ID 42) with 2 rule(s); it is applied to 2 server(s). Rule changes (order and descriptions ignored): 0 added, 0 removed, 2 unchanged. Nothing was changed.',
    );
  });

  it("set_rules preview lists at most 10 rules (F-22)", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge([]));
    const rules = Array.from({ length: 12 }, (_, i) => rule(String(1000 + i), ["0.0.0.0/0"]));
    const res = await t.call("firewall_set_rules", { id: 42, rules });
    const listed = Array.from({ length: 10 }, (_, i) => `in tcp ${1000 + i} from 0.0.0.0/0`);
    expect(textOf(res)).toContain(
      `12 added, 0 removed, 0 unchanged. Added: ${listed.join("; ")}; … and 2 more.`,
    );
  });

  it("apply notes a firewall without SSH rule", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge([rule("80")])).on("GET", "/servers/{id}", server());
    actionRoutes(t, "/firewalls/{id}/actions/apply_to_resources");
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe(
      "Applying firewall 42 to 1 server(s) and 0 label selector(s). Note: firewall 42 does not allow inbound TCP port 22; servers it is applied to are reachable on that port only if another firewall on them allows it.",
    );
  });

  it("apply adds no note when the guarded port is allowed", async () => {
    const t = await start();
    t.fake.on("GET", "/firewalls/{id}", edge([rule("22")])).on("GET", "/servers/{id}", server());
    actionRoutes(t, "/firewalls/{id}/actions/apply_to_resources");
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7] });
    expect(textOf(res)).toBe("Applying firewall 42 to 1 server(s) and 0 label selector(s).");
  });

  it("apply does not note port 22 for a tcp rule with port any", async () => {
    const t = await start();
    t.fake
      .on("GET", "/firewalls/{id}", edge([rule("any", ["0.0.0.0/0"])]))
      .on("GET", "/servers/{id}", server());
    actionRoutes(t, "/firewalls/{id}/actions/apply_to_resources");
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7] });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("Applying firewall 42 to 1 server(s) and 0 label selector(s).");
    expect(textOf(res)).not.toContain("Note:");
  });

  it("uses configured guard ports", async () => {
    const t = await start({ firewallGuardPorts: [2222] });
    t.fake.on("GET", "/firewalls/{id}", edge([rule("22"), rule("2222")]));
    const res = await t.call("firewall_set_rules", { id: 42, rules: [rule("22")] });
    expect(textOf(res)).toContain(
      "Warning: after this change, firewall 42 no longer allows inbound TCP port 2222 from any address;",
    );
    expect(textOf(res)).not.toContain("inbound TCP port 22 ");
  });

  it("uses configured guard ports for the apply note", async () => {
    const t = await start({ firewallGuardPorts: [22, 2222] });
    t.fake.on("GET", "/firewalls/{id}", edge([rule("22")])).on("GET", "/servers/{id}", server());
    actionRoutes(t, "/firewalls/{id}/actions/apply_to_resources");
    const res = await t.call("firewall_apply_to_resources", { id: 42, server_ids: [7] });
    expect(textOf(res)).toContain("Note: firewall 42 does not allow inbound TCP port 2222;");
    expect(textOf(res)).not.toContain("inbound TCP port 22;");
  });
});
