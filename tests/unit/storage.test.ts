import { afterEach, describe, expect, it } from "vitest";
import { action, apiError, noContent, ok } from "../helpers/fake-hetzner.js";
import { fixture } from "../helpers/fixtures.js";
import { type Harness, logFields, startHarness, textOf } from "../helpers/harness.js";

const SCOPE = [{ key: "managed-by", value: "mcp" }];
const IN_SCOPE = { "managed-by": "mcp" };

type Obj = Record<string, unknown>;
const volume = (over: Obj = {}): Obj => ({
  ...(fixture<{ volume: Obj }>("get_volume").volume as Obj),
  ...over,
});
const volReply = (over: Obj = {}, status = 200) => ok({ volume: volume(over) }, status);
const image = (over: Obj = {}): Obj => ({
  ...(fixture<{ image: Obj }>("get_image").image as Obj),
  ...over,
});
const imgReply = (over: Obj = {}, status = 200) => ok({ image: image(over) }, status);
const server = (over: Obj = {}): Obj => ({
  ...(fixture<{ server: Obj }>("get_server").server as Obj),
  ...over,
});
const srvReply = (over: Obj = {}) => ok({ server: server(over) });
const pricing = () => ok(fixture("get_pricing"));

const bodyOf = (t: Harness, method: "POST" | "PUT", pattern: string): Obj =>
  (t.fake.requests(method, pattern)[0]?.body ?? {}) as Obj;
const writes = (t: Harness) => t.fake.calls.filter((c) => c.method !== "GET");

/** Action creation (201) plus a polling route that reports the action as finished. */
function actionRoutes(t: Harness, pattern: string, final: "success" | "running" = "success") {
  t.fake
    .on("POST", pattern, ok({ action: action(1, "running") }, 201))
    .on("GET", "/actions", ok({ actions: [action(1, final)] }));
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function start(config: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  h = await startHarness(config);
  return h;
}

/** Calls without the harness's sensitive-marker assertion (for tests that plant SENSITIVE- values on purpose, OE-29). */
async function rawCall(harness: Harness, name: string, args: Record<string, unknown>) {
  return (await harness.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
  };
}

describe("volume_list", () => {
  it("volume_list returns projected volumes", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes", ok(fixture("list_volumes")));
    const res = await t.call("volume_list");
    const items = (res.structuredContent as { items: Obj[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.assignee).toEqual({ id: 42, type: "server" });
    expect(items[0]).not.toHaveProperty("server");
    expect(textOf(res)).toBe("Found 1 volume(s) on page 3; more pages available.");
  });

  it("volume_list reports more pages", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/volumes",
      ok(fixture("list_volumes", { meta: { pagination: { next_page: 2 } } })),
    );
    const res = await t.call("volume_list");
    expect((res.structuredContent as { next_page: number }).next_page).toBe(2);
    expect(textOf(res)).toContain("more pages available");
  });

  it("volume_list passes status, name and sort", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes", ok(fixture("list_volumes")));
    await t.call("volume_list", { status: "available", name: "data", sort: "created:desc" });
    const q = t.fake.requests("GET", "/volumes")[0]?.query;
    expect(q?.get("status")).toBe("available");
    expect(q?.get("name")).toBe("data");
    expect(q?.get("sort")).toBe("created:desc");
  });

  it("volume_list maps an API error", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes", apiError(401, "unauthorized"));
    const res = await t.call("volume_list");
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Hetzner rejected the API token/);
  });
});

describe("volume_get", () => {
  it("volume_get returns the volume", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply());
    const res = await t.call("volume_get", { id: 42 });
    const out = res.structuredContent as Obj;
    expect(out).toMatchObject({ id: 42, size: 42, protection: { delete: false } });
    expect((out.location as Obj).name).toBe("fsn1");
    expect(out).not.toHaveProperty("server");
    expect(textOf(res)).toBe("Volume 42: 42 GB, status available, attached to server 42.");
  });

  it("volume_get handles an unattached volume", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ assignee: null }));
    const res = await t.call("volume_get", { id: 42 });
    expect(textOf(res)).not.toContain("attached to");
    expect((res.structuredContent as Obj).assignee).toBeNull();
  });

  it("volume_get maps 404", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", apiError(404, "not_found"));
    const res = await t.call("volume_get", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Not found \(HTTP 404\)/);
  });
});

describe("volume_create", () => {
  it("volume_create previews the cost and creates nothing", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", pricing());
    const res = await t.call("volume_create", { name: "data", size: 10, location: "fsn1" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(
      /^Confirmation required\. This would: create volume "data" with 10 GB in location "fsn1"\./,
    );
    expect(text).toContain("Estimated cost: 10.00 EUR/month net");
    expect(writes(t)).toEqual([]);
  });

  it("volume_create preview names format, automount and server", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply({ id: 7 })).on("GET", "/pricing", pricing());
    const res = await t.call("volume_create", {
      name: "data",
      size: 20,
      server_id: 7,
      format: "ext4",
      automount: true,
    });
    expect(textOf(res)).toContain(
      'create volume "data" with 20 GB attached to server 7, formatted as ext4, mounted automatically. Estimated cost: 20.00 EUR/month net',
    );
  });

  it("volume_create creates an unattached volume in a location", async () => {
    const t = await start();
    actionRoutes(t, "/volumes");
    t.fake.on(
      "POST",
      "/volumes",
      ok({ volume: volume(), action: action(1, "running"), next_actions: [] }, 201),
    );
    const res = await t.call("volume_create", {
      name: "data",
      size: 10,
      location: "fsn1",
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(t, "POST", "/volumes")).toEqual({
      name: "data",
      size: 10,
      location: "fsn1",
      labels: {},
    });
    const out = res.structuredContent as { actions: Obj[]; volume: Obj };
    expect(out.actions).toHaveLength(1);
    expect(out.volume.id).toBe(42);
    expect(textOf(res)).toBe("Created volume 42 (42 GB).");
  });

  it("volume_create attaches to a server via assignee", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", srvReply({ id: 7 }))
      .on(
        "POST",
        "/volumes",
        ok(
          { volume: volume(), action: action(1, "running"), next_actions: [action(2, "running")] },
          201,
        ),
      )
      .on("GET", "/actions", ok({ actions: [action(1, "success"), action(2, "success")] }));
    const res = await t.call("volume_create", {
      name: "data",
      size: 10,
      server_id: 7,
      automount: true,
      confirm: true,
    });
    const body = bodyOf(t, "POST", "/volumes");
    expect(body.assignee).toEqual({ id: 7, type: "server" });
    expect(body.automount).toBe(true);
    expect(body).not.toHaveProperty("server");
    expect(body).not.toHaveProperty("location");
    expect((res.structuredContent as { actions: Obj[] }).actions).toHaveLength(2);
    expect(textOf(res)).toBe("Created volume 42 (42 GB), attaching to server 7.");
  });

  it.each(["fsn1\n", "fsn1\u202e"])(
    "volume_create rejects location with control characters",
    async (location) => {
      const t = await start();
      const res = await t.call("volume_create", {
        name: "data",
        size: 10,
        location,
        confirm: true,
      });
      expect(res.isError).toBe(true);
      expect(t.fake.calls).toHaveLength(0);
    },
  );

  it.each([9, 10241, 10.5])("volume_create rejects size %s", async (size) => {
    const t = await start();
    const res = await t.call("volume_create", {
      name: "data",
      size,
      location: "fsn1",
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("volume_create requires location or server_id", async () => {
    const t = await start();
    const cases: [Obj, string][] = [
      [{ name: "d", size: 10 }, "Provide location or server_id."],
      [
        { name: "d", size: 10, location: "fsn1", server_id: 7 },
        "Provide either location or server_id, not both.",
      ],
      [{ name: "d", size: 10, location: "fsn1", automount: true }, "automount requires server_id."],
    ];
    for (const [args, message] of cases) {
      const res = await t.call("volume_create", args);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(message);
    }
    expect(t.fake.calls).toHaveLength(0);
  });

  it("volume_create adds scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on(
      "POST",
      "/volumes",
      ok({ volume: volume(), action: action(1, "success"), next_actions: [] }, 201),
    );
    t.fake.on("GET", "/actions", ok({ actions: [action(1, "success")] }));
    await t.call("volume_create", {
      name: "data",
      size: 10,
      location: "fsn1",
      labels: { env: "x" },
      confirm: true,
    });
    expect(bodyOf(t, "POST", "/volumes").labels).toEqual({ env: "x", ...IN_SCOPE });
  });

  it("volume_create blocks an out-of-scope server", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", srvReply({ id: 7, labels: {} }));
    const res = await t.call("volume_create", {
      name: "data",
      size: 10,
      server_id: 7,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource server 7 is outside the label scope/);
    expect(writes(t)).toEqual([]);
  });

  it("volume_create maps no space left", async () => {
    const t = await start();
    t.fake.on("POST", "/volumes", apiError(422, "no_space_left_in_location"));
    const res = await t.call("volume_create", {
      name: "data",
      size: 10,
      location: "fsn1",
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^There is no volume space left in this location/);
  });

  it("volume_create is a costs tool, a write tool that confirms", async () => {
    const t = await start({ maxMonthlyCost: "9.99" });
    t.fake.on("GET", "/pricing", pricing());
    const res = await t.call("volume_create", {
      name: "data",
      size: 10,
      location: "fsn1",
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /^Cost limit exceeded: this call adds an estimated 10\.00 EUR\/month net/,
    );
    expect(writes(t)).toEqual([]);
  });

  it("volume_create preview without pricing still asks for confirmation", async () => {
    const t = await start();
    t.fake.on("GET", "/pricing", apiError(503, "unavailable"));
    const res = await t.call("volume_create", { name: "data", size: 10, location: "fsn1" });
    expect(textOf(res)).toMatch(/^Confirmation required\./);
    expect(textOf(res)).toContain("Estimated cost: unavailable");
  });
});

describe("volume_attach", () => {
  it("volume_attach attaches and waits", async () => {
    const t = await start();
    t.fake
      .on("GET", "/volumes/{id}", volReply({ assignee: null }))
      .on("GET", "/servers/{id}", srvReply({ id: 7 }));
    actionRoutes(t, "/volumes/{id}/actions/attach");
    const res = await t.call("volume_attach", { id: 42, server_id: 7 });
    expect(bodyOf(t, "POST", "/volumes/{id}/actions/attach")).toEqual({
      assignee: { id: 7, type: "server" },
    });
    const out = res.structuredContent as { actions: Obj[]; id: number; server_id: number };
    expect(out.actions[0]?.status).toBe("success");
    expect(out).toMatchObject({ id: 42, server_id: 7 });
    expect(textOf(res)).toBe("Attaching volume 42 to server 7.");
  });

  it("volume_attach checks scope of volume and server", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on("GET", "/volumes/{id}", volReply({ labels: IN_SCOPE }))
      .on("GET", "/servers/{id}", srvReply({ id: 7, labels: {} }));
    const res = await t.call("volume_attach", { id: 42, server_id: 7 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource server 7 is outside/);
    expect(writes(t)).toEqual([]);
  });

  it("volume_attach blocks an out-of-scope volume", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on("GET", "/volumes/{id}", volReply({ labels: {} }))
      .on("GET", "/servers/{id}", srvReply({ id: 7, labels: IN_SCOPE }));
    const res = await t.call("volume_attach", { id: 42, server_id: 7 });
    expect(textOf(res)).toMatch(/^Resource volume 42 is outside/);
    expect(writes(t)).toEqual([]);
  });

  it("volume_attach passes automount", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply()).on("GET", "/servers/{id}", srvReply({ id: 7 }));
    actionRoutes(t, "/volumes/{id}/actions/attach");
    await t.call("volume_attach", { id: 42, server_id: 7, automount: true });
    expect(bodyOf(t, "POST", "/volumes/{id}/actions/attach").automount).toBe(true);
  });

  it("volume_attach maps a locked volume", async () => {
    const t = await start();
    t.fake
      .on("GET", "/volumes/{id}", volReply())
      .on("GET", "/servers/{id}", srvReply({ id: 7 }))
      .on("POST", "/volumes/{id}/actions/attach", apiError(423, "locked"));
    const res = await t.call("volume_attach", { id: 42, server_id: 7 });
    expect(textOf(res)).toMatch(/^The resource is locked because another action is running/);
  });
});

describe("volume_detach", () => {
  it("volume_detach detaches and waits", async () => {
    const t = await start();
    t.fake
      .on("GET", "/volumes/{id}", volReply({ assignee: { id: 5, type: "server" } }))
      .on("GET", "/servers/{id}", srvReply({ id: 5 }));
    actionRoutes(t, "/volumes/{id}/actions/detach");
    const res = await t.call("volume_detach", { id: 42 });
    expect(t.fake.requests("POST", "/volumes/{id}/actions/detach")[0]?.body).toBeUndefined();
    expect((res.structuredContent as { actions: Obj[] }).actions[0]?.status).toBe("success");
    expect(textOf(res)).toBe("Detaching volume 42.");
  });

  it("volume_detach also checks the attached server", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on(
        "GET",
        "/volumes/{id}",
        volReply({ labels: IN_SCOPE, assignee: { id: 5, type: "server" } }),
      )
      .on("GET", "/servers/{id}", srvReply({ id: 5, labels: {} }));
    const res = await t.call("volume_detach", { id: 42 });
    expect(textOf(res)).toMatch(/^Resource server 5 is outside/);
    expect(writes(t)).toEqual([]);
  });

  it("volume_detach works for an unattached volume without server lookup", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ assignee: null }));
    actionRoutes(t, "/volumes/{id}/actions/detach");
    const res = await t.call("volume_detach", { id: 42 });
    expect(res.isError).toBeFalsy();
    expect(t.fake.requests("GET", "/servers/{id}")).toHaveLength(0);
    expect(t.fake.requests("POST", "/volumes/{id}/actions/detach")).toHaveLength(1);
  });

  it("volume_detach blocks an out-of-scope volume", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/volumes/{id}", volReply({ labels: {}, assignee: null }));
    const res = await t.call("volume_detach", { id: 42 });
    expect(textOf(res)).toMatch(/^Resource volume 42 is outside/);
    expect(writes(t)).toEqual([]);
  });
});

describe("volume_resize", () => {
  it("volume_resize previews the price change", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ size: 10 })).on("GET", "/pricing", pricing());
    const res = await t.call("volume_resize", { id: 42, size: 50 });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(
      /^Confirmation required\. This would: resize volume "my-resource" \(ID 42\) from 10 GB to 50 GB\./,
    );
    expect(text).toContain("from 10 GB to 50 GB");
    expect(text).toContain("Price change: +40.00");
    expect(writes(t)).toEqual([]);
  });

  it("volume_resize resizes and waits", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ size: 10 }));
    actionRoutes(t, "/volumes/{id}/actions/resize");
    const res = await t.call("volume_resize", { id: 42, size: 20, confirm: true });
    expect(bodyOf(t, "POST", "/volumes/{id}/actions/resize")).toEqual({ size: 20 });
    expect(res.structuredContent).toMatchObject({ id: 42, size: 20 });
    expect((res.structuredContent as { actions: Obj[] }).actions[0]?.status).toBe("success");
    expect(textOf(res)).toBe("Resizing volume 42 to 20 GB.");
  });

  it("volume_resize maps shrinking as invalid input", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ size: 50 })).on(
      "POST",
      "/volumes/{id}/actions/resize",
      apiError(422, "invalid_input", "invalid", {
        fields: [{ name: "size", messages: ["must be greater"] }],
      }),
    );
    const res = await t.call("volume_resize", { id: 42, size: 20, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Hetzner rejected the input: size: must be greater");
  });

  it.each([9, 10241])("volume_resize rejects size %s", async (size) => {
    const t = await start();
    const res = await t.call("volume_resize", { id: 42, size, confirm: true });
    expect(res.isError).toBe(true);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("volume_resize blocks an out-of-scope volume", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/volumes/{id}", volReply({ labels: {} }));
    const res = await t.call("volume_resize", { id: 42, size: 20, confirm: true });
    expect(textOf(res)).toMatch(/^Resource volume 42 is outside/);
    expect(writes(t)).toEqual([]);
  });

  it("volume_resize checks the limit against the price increase", async () => {
    const t = await start({ maxMonthlyCost: "39.99" });
    t.fake.on("GET", "/volumes/{id}", volReply({ size: 10 })).on("GET", "/pricing", pricing());
    const res = await t.call("volume_resize", { id: 42, size: 50, confirm: true });
    expect(textOf(res)).toMatch(/^Cost limit exceeded: this call adds an estimated 40\.00 EUR/);
    expect(writes(t)).toEqual([]);
  });
});

describe("volume_update", () => {
  it("volume_update renames a volume", async () => {
    const t = await start();
    t.fake
      .on("GET", "/volumes/{id}", volReply())
      .on("PUT", "/volumes/{id}", volReply({ name: "renamed" }));
    const res = await t.call("volume_update", { id: 42, name: "renamed" });
    expect(bodyOf(t, "PUT", "/volumes/{id}")).toEqual({ name: "renamed" });
    expect((res.structuredContent as Obj).name).toBe("renamed");
    expect(textOf(res)).toBe("Updated volume 42: name.");
  });

  it("volume_update keeps scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on("GET", "/volumes/{id}", volReply({ labels: IN_SCOPE }))
      .on("PUT", "/volumes/{id}", volReply({ labels: IN_SCOPE }));
    await t.call("volume_update", { id: 42, labels: { env: "x" } });
    expect(bodyOf(t, "PUT", "/volumes/{id}").labels).toEqual({ env: "x", ...IN_SCOPE });
  });

  it("volume_update blocks out-of-scope volume", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/volumes/{id}", volReply({ labels: {} }));
    const res = await t.call("volume_update", { id: 42, name: "x" });
    expect(res.isError).toBe(true);
    expect(writes(t)).toEqual([]);
  });

  it("volume_update blocks terraform-managed volume with policy block", async () => {
    const t = await start({ iacPolicy: "block" });
    t.fake.on("GET", "/volumes/{id}", volReply({ labels: { "managed-by": "terraform" } }));
    const res = await t.call("volume_update", { id: 42, name: "x" });
    expect(res.isError).toBe(true);
    expect(writes(t)).toEqual([]);
  });

  it("volume_update requires a field", async () => {
    const t = await start();
    const res = await t.call("volume_update", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Provide name, labels, or both.");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("volume_update maps a name conflict", async () => {
    const t = await start();
    t.fake
      .on("GET", "/volumes/{id}", volReply())
      .on(
        "PUT",
        "/volumes/{id}",
        apiError(409, "uniqueness_error", "taken", { fields: [{ name: "name" }] }),
      );
    const res = await t.call("volume_update", { id: 42, name: "taken" });
    expect(textOf(res)).toContain("A resource with the same unique value already exists: name.");
  });
});

describe("volume_delete", () => {
  it("volume_delete asks for confirmation and names the data loss", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply());
    const res = await t.call("volume_delete", { id: 42 });
    const text = textOf(res);
    expect(text).toMatch(
      /^Confirmation required\. This would: permanently delete volume "my-resource" \(ID 42, 42 GB\)/,
    );
    expect(text).toContain("destroy ALL data");
    expect(text).toContain("still attached to server 42");
    expect(writes(t)).toEqual([]);
  });

  it("volume_delete deletes with confirm", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply()).on("DELETE", "/volumes/{id}", noContent());
    const res = await t.call("volume_delete", { id: 42, confirm: true });
    expect(res.structuredContent).toMatchObject({ id: 42, deleted: true });
    expect(textOf(res)).toBe("Deleted volume 42.");
  });

  it("volume_delete preview starts with the protection line", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ protection: { delete: true } }));
    const res = await t.call("volume_delete", { id: 42 });
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: Hetzner will refuse this: volume 42 has delete protection enabled\. Disable it first with volume_protection_set\. permanently delete volume/,
    );
  });

  it("volume_delete preview mentions an attached server", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ assignee: { id: 5, type: "server" } }));
    const res = await t.call("volume_delete", { id: 42 });
    expect(textOf(res)).toContain("still attached to server 5");
  });

  it("volume_delete preview omits the attached sentence for a detached volume", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ assignee: null }));
    const res = await t.call("volume_delete", { id: 42 });
    expect(textOf(res)).not.toContain("still attached");
  });

  it("volume_delete maps protected", async () => {
    const t = await start();
    t.fake
      .on("GET", "/volumes/{id}", volReply())
      .on("DELETE", "/volumes/{id}", apiError(423, "protected"));
    const res = await t.call("volume_delete", { id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^The resource is protected against this action/);
  });

  it("volume_delete blocks an out-of-scope volume", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/volumes/{id}", volReply({ labels: {} }));
    const res = await t.call("volume_delete", { id: 42 });
    expect(textOf(res)).toMatch(/^Resource volume 42 is outside/);
    expect(writes(t)).toEqual([]);
  });

  it("volume_delete warns about terraform marker in the confirmation", async () => {
    const t = await start({ iacPolicy: "warn" });
    t.fake.on("GET", "/volumes/{id}", volReply({ labels: { "managed-by": "terraform" } }));
    const res = await t.call("volume_delete", { id: 42 });
    expect(textOf(res)).toMatch(/^Confirmation required\./);
    expect(textOf(res)).toContain("Warning: volume");
  });
});

describe("volume_protection_set", () => {
  it("volume_protection_set sends the delete flag", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ protection: { delete: true } }));
    actionRoutes(t, "/volumes/{id}/actions/change_protection");
    const res = await t.call("volume_protection_set", { id: 42, protected: false, confirm: true });
    expect(bodyOf(t, "POST", "/volumes/{id}/actions/change_protection")).toEqual({ delete: false });
    expect((res.structuredContent as { protection: Obj }).protection).toEqual({ delete: false });
    expect(textOf(res)).toBe(
      "Requested delete protection off for volume 42 (action 1). Final action status is in 'actions'.",
    );
  });

  it("volume_protection_set previews turning protection off", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ protection: { delete: true } }));
    const res = await t.call("volume_protection_set", { id: 42, protected: false });
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: turn OFF delete protection for volume 42 "my-resource"\./,
    );
    expect(writes(t)).toEqual([]);
  });

  it("volume_protection_set notes an unchanged state", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ protection: { delete: true } }));
    const res = await t.call("volume_protection_set", { id: 42, protected: true });
    expect(textOf(res)).toContain("turn ON delete protection for volume 42");
    expect(textOf(res)).toContain("It already has this state; nothing will change.");
  });

  it("volume_protection_set respects the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/volumes/{id}", volReply({ labels: {} }));
    const res = await t.call("volume_protection_set", { id: 42, protected: true, confirm: true });
    expect(textOf(res)).toMatch(/^Resource volume 42 is outside/);
    expect(writes(t)).toEqual([]);
  });
});

describe("snapshot_create", () => {
  it("snapshot_create previews the price per GB", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply()).on("GET", "/pricing", pricing());
    const res = await t.call("snapshot_create", { server_id: 42 });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(
      /^Confirmation required\. This would: create a snapshot of server "my-resource" \(ID 42\); the snapshot survives the deletion of the server\./,
    );
    expect(text).toContain("per GB of snapshot size");
    expect(text).toContain("The server is running; Hetzner recommends shutting it down first");
    expect(text).not.toContain("40.00");
    expect(writes(t)).toEqual([]);
  });

  it("snapshot_create omits the running note for a stopped server", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply({ status: "off" })).on("GET", "/pricing", pricing());
    const res = await t.call("snapshot_create", { server_id: 42 });
    expect(textOf(res)).not.toContain("The server is running");
  });

  it("snapshot_create checks the limit against the disk-size upper bound", async () => {
    const t = await start({ maxMonthlyCost: "39.99" });
    t.fake
      .on("GET", "/servers/{id}", srvReply({ primary_disk_size: 40 }))
      .on("GET", "/pricing", pricing());
    const res = await t.call("snapshot_create", { server_id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("40.00 EUR/month net");
    expect(textOf(res)).toMatch(/^Cost limit exceeded/);
    expect(writes(t)).toEqual([]);
    await h?.close();

    const t2 = await start({ maxMonthlyCost: "40.00" });
    t2.fake
      .on("GET", "/servers/{id}", srvReply({ primary_disk_size: 40 }))
      .on("GET", "/pricing", pricing())
      .on(
        "POST",
        "/servers/{id}/actions/create_image",
        ok({ image: image(), action: action(1, "success") }, 201),
      )
      .on("GET", "/actions", ok({ actions: [action(1, "success")] }));
    const allowed = await t2.call("snapshot_create", { server_id: 42, confirm: true });
    expect(allowed.isError).toBeFalsy();
    expect(t2.fake.requests("POST", "/servers/{id}/actions/create_image")).toHaveLength(1);
  });

  it("snapshot_create creates and waits", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", srvReply())
      .on(
        "POST",
        "/servers/{id}/actions/create_image",
        ok({ image: image(), action: action(1, "running") }, 201),
      )
      .on("GET", "/actions", ok({ actions: [action(1, "success")] }));
    const res = await t.call("snapshot_create", {
      server_id: 42,
      description: "before upgrade",
      confirm: true,
    });
    expect(bodyOf(t, "POST", "/servers/{id}/actions/create_image")).toEqual({
      type: "snapshot",
      description: "before upgrade",
      labels: {},
    });
    const out = res.structuredContent as { image: Obj; actions: Obj[] };
    expect(out.image.type).toBe("snapshot");
    expect(out.actions[0]?.status).toBe("success");
    expect(textOf(res)).toBe("Creating snapshot image 42 of server 42.");
  });

  it("snapshot_create reports a still running action", async () => {
    const t = await start({ actionWaitMs: 1000 });
    t.fake
      .on("GET", "/servers/{id}", srvReply())
      .on(
        "POST",
        "/servers/{id}/actions/create_image",
        ok({ image: image(), action: action(1, "running") }, 201),
      )
      .on("GET", "/actions", ok({ actions: [action(1, "running")] }));
    const res = await t.call("snapshot_create", { server_id: 42, confirm: true });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("Still running after");
  });

  it("snapshot_create adds scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on("GET", "/servers/{id}", srvReply({ labels: IN_SCOPE }))
      .on(
        "POST",
        "/servers/{id}/actions/create_image",
        ok({ image: image(), action: action(1, "success") }, 201),
      )
      .on("GET", "/actions", ok({ actions: [action(1, "success")] }));
    await t.call("snapshot_create", { server_id: 42, confirm: true });
    expect(bodyOf(t, "POST", "/servers/{id}/actions/create_image").labels).toEqual(IN_SCOPE);
  });

  it("snapshot_create blocks an out-of-scope server", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", srvReply({ labels: {} }));
    const res = await t.call("snapshot_create", { server_id: 42, confirm: true });
    expect(textOf(res)).toMatch(/^Resource server 42 is outside/);
    expect(writes(t)).toEqual([]);
  });

  it("snapshot_create maps a locked server", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", srvReply())
      .on("POST", "/servers/{id}/actions/create_image", apiError(423, "locked"));
    const res = await t.call("snapshot_create", { server_id: 42, confirm: true });
    expect(textOf(res)).toMatch(/^The resource is locked/);
  });

  it("snapshot_create warns on terraform-managed server", async () => {
    const t = await start({ iacPolicy: "warn" });
    t.fake
      .on("GET", "/servers/{id}", srvReply({ labels: { "managed-by": "terraform" } }))
      .on(
        "POST",
        "/servers/{id}/actions/create_image",
        ok({ image: image(), action: action(1, "success") }, 201),
      )
      .on("GET", "/actions", ok({ actions: [action(1, "success")] }));
    const res = await t.call("snapshot_create", { server_id: 42, confirm: true });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { warnings: string[] }).warnings[0]).toMatch(
      /^Warning: server/,
    );
  });
});

describe("snapshot_list", () => {
  it("snapshot_list requests snapshots and backups by default", async () => {
    const t = await start();
    t.fake.on("GET", "/images", ok(fixture("list_images")));
    await t.call("snapshot_list");
    expect(t.fake.requests("GET", "/images")[0]?.query.getAll("type")).toEqual([
      "snapshot",
      "backup",
    ]);
  });

  it("snapshot_list filters one type and server", async () => {
    const t = await start();
    t.fake.on("GET", "/images", ok(fixture("list_images")));
    await t.call("snapshot_list", { type: "backup", server_id: 7 });
    const q = t.fake.requests("GET", "/images")[0]?.query;
    expect(q?.getAll("type")).toEqual(["backup"]);
    expect(q?.get("bound_to")).toBe("7");
  });

  it("snapshot_list projects image fields", async () => {
    const t = await start();
    t.fake.on("GET", "/images", ok(fixture("list_images")));
    const res = await t.call("snapshot_list");
    const item = (res.structuredContent as { items: Obj[] }).items[0] as Obj;
    expect(item).toMatchObject({
      image_size: 2.3,
      bound_to: null,
      created_from: { id: 1, name: "Server" },
    });
    expect(item).not.toHaveProperty("os_flavor");
    expect(textOf(res)).toBe("Found 1 image(s) on page 3; more pages available.");
  });

  it("snapshot_list reports more pages", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/images",
      ok(fixture("list_images", { meta: { pagination: { next_page: 2 } } })),
    );
    const res = await t.call("snapshot_list");
    expect((res.structuredContent as { next_page: number }).next_page).toBe(2);
  });

  it("snapshot_list maps an API error", async () => {
    const t = await start();
    t.fake.on("GET", "/images", apiError(401, "unauthorized"));
    const res = await t.call("snapshot_list");
    expect(res.isError).toBe(true);
  });
});

describe("snapshot_update", () => {
  it("snapshot_update changes the description", async () => {
    const t = await start();
    t.fake
      .on("GET", "/images/{id}", imgReply())
      .on("PUT", "/images/{id}", imgReply({ description: "new" }));
    const res = await t.call("snapshot_update", { id: 42, description: "new" });
    expect(bodyOf(t, "PUT", "/images/{id}")).toEqual({ description: "new" });
    expect((res.structuredContent as Obj).description).toBe("new");
    expect(textOf(res)).toBe("Updated image 42: description.");
  });

  it("snapshot_update keeps scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake
      .on("GET", "/images/{id}", imgReply({ labels: IN_SCOPE }))
      .on("PUT", "/images/{id}", imgReply({ labels: IN_SCOPE }));
    await t.call("snapshot_update", { id: 42, labels: { env: "x" } });
    expect(bodyOf(t, "PUT", "/images/{id}").labels).toEqual({ env: "x", ...IN_SCOPE });
  });

  it("snapshot_update blocks out-of-scope image", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/images/{id}", imgReply({ labels: {} }));
    const res = await t.call("snapshot_update", { id: 42, description: "x" });
    expect(textOf(res)).toMatch(/^Resource image 42 is outside/);
    expect(writes(t)).toEqual([]);
  });

  it("snapshot_update requires a field", async () => {
    const t = await start();
    const res = await t.call("snapshot_update", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Provide description, labels, or both.");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("snapshot_update maps an API refusal for system images", async () => {
    const t = await start();
    t.fake
      .on("GET", "/images/{id}", imgReply({ type: "system" }))
      .on("PUT", "/images/{id}", apiError(422, "invalid_input"));
    const res = await t.call("snapshot_update", { id: 42, description: "x" });
    expect(textOf(res)).toContain("Hetzner rejected the input");
  });
});

describe("snapshot_delete", () => {
  it("snapshot_delete asks for confirmation", async () => {
    const t = await start();
    t.fake.on("GET", "/images/{id}", imgReply({ type: "snapshot" }));
    const res = await t.call("snapshot_delete", { id: 42 });
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: permanently delete snapshot image "ubuntu-24\.04" \(ID 42, 2\.30 GB\)\. It cannot be recovered\./,
    );
    expect(writes(t)).toEqual([]);
  });

  it("snapshot_delete deletes with confirm", async () => {
    const t = await start();
    t.fake.on("GET", "/images/{id}", imgReply()).on("DELETE", "/images/{id}", noContent());
    const res = await t.call("snapshot_delete", { id: 42, confirm: true });
    expect(res.structuredContent).toMatchObject({ id: 42, deleted: true });
    expect(textOf(res)).toBe("Deleted image 42.");
  });

  it("snapshot_delete preview names the backup server", async () => {
    const t = await start();
    t.fake.on("GET", "/images/{id}", imgReply({ type: "backup", bound_to: 7 }));
    const res = await t.call("snapshot_delete", { id: 42 });
    expect(textOf(res)).toContain("backup of server 7");
  });

  it("snapshot_delete preview rounds the image size up", async () => {
    const t = await start();
    t.fake.on("GET", "/images/{id}", imgReply({ image_size: 0.6102520576171875 }));
    const res = await t.call("snapshot_delete", { id: 42 });
    expect(textOf(res)).toContain("(ID 42, 0.62 GB)");
  });

  it("snapshot_delete preview falls back to the description and an unknown size", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/images/{id}",
      imgReply({ name: null, image_size: null, description: "weekly" }),
    );
    const res = await t.call("snapshot_delete", { id: 42 });
    expect(textOf(res)).toContain('image "weekly" (ID 42, unknown size)');
  });

  it("snapshot_delete preview starts with the protection line", async () => {
    const t = await start();
    t.fake.on("GET", "/images/{id}", imgReply({ protection: { delete: true } }));
    const res = await t.call("snapshot_delete", { id: 42 });
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: Hetzner will refuse this: image 42 has delete protection enabled\. Disable it first with snapshot_protection_set\. permanently delete/,
    );
  });

  it("snapshot_delete maps protected", async () => {
    const t = await start();
    t.fake
      .on("GET", "/images/{id}", imgReply())
      .on("DELETE", "/images/{id}", apiError(423, "protected"));
    const res = await t.call("snapshot_delete", { id: 42, confirm: true });
    expect(textOf(res)).toMatch(/^The resource is protected against this action/);
  });

  it("snapshot_delete blocks an out-of-scope image", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/images/{id}", imgReply({ labels: {} }));
    const res = await t.call("snapshot_delete", { id: 42 });
    expect(textOf(res)).toMatch(/^Resource image 42 is outside/);
    expect(writes(t)).toEqual([]);
  });
});

describe("snapshot_protection_set", () => {
  it("snapshot_protection_set sends the delete flag", async () => {
    const t = await start();
    t.fake.on("GET", "/images/{id}", imgReply({ protection: { delete: true } }));
    actionRoutes(t, "/images/{id}/actions/change_protection");
    const res = await t.call("snapshot_protection_set", {
      id: 42,
      protected: false,
      confirm: true,
    });
    expect(bodyOf(t, "POST", "/images/{id}/actions/change_protection")).toEqual({ delete: false });
    expect((res.structuredContent as { protection: Obj }).protection).toEqual({ delete: false });
    expect(textOf(res)).toBe(
      "Requested delete protection off for snapshot 42 (action 1). Final action status is in 'actions'.",
    );
  });

  it("snapshot_protection_set previews turning protection off", async () => {
    const t = await start();
    t.fake.on("GET", "/images/{id}", imgReply({ protection: { delete: true } }));
    const res = await t.call("snapshot_protection_set", { id: 42, protected: false });
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: turn OFF delete protection for snapshot 42 /,
    );
    expect(writes(t)).toEqual([]);
  });

  it("snapshot_protection_set respects the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/images/{id}", imgReply({ labels: {} }));
    const res = await t.call("snapshot_protection_set", { id: 42, protected: true, confirm: true });
    expect(textOf(res)).toMatch(/^Resource image 42 is outside/);
    expect(writes(t)).toEqual([]);
  });
});

describe("backup_enable", () => {
  it("backup_enable enables and waits", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply());
    actionRoutes(t, "/servers/{id}/actions/enable_backup");
    const res = await t.call("backup_enable", { server_id: 42, confirm: true });
    expect((res.structuredContent as { actions: Obj[] }).actions[0]?.status).toBe("success");
    expect(textOf(res)).toBe("Enabling automatic backups for server 42.");
  });

  it("backup_enable sends no body", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply());
    actionRoutes(t, "/servers/{id}/actions/enable_backup");
    await t.call("backup_enable", { server_id: 42, confirm: true });
    expect(t.fake.requests("POST", "/servers/{id}/actions/enable_backup")[0]?.body).toBeUndefined();
  });

  it("backup_enable blocks an out-of-scope server", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", srvReply({ labels: {} }));
    const res = await t.call("backup_enable", { server_id: 42, confirm: true });
    expect(textOf(res)).toMatch(/^Resource server 42 is outside/);
    expect(writes(t)).toEqual([]);
  });

  it("backup_enable warns on terraform-managed server", async () => {
    const t = await start({ iacPolicy: "warn" });
    t.fake.on("GET", "/servers/{id}", srvReply({ labels: { "managed-by": "terraform" } }));
    actionRoutes(t, "/servers/{id}/actions/enable_backup");
    const res = await t.call("backup_enable", { server_id: 42, confirm: true });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { warnings: string[] }).warnings[0]).toMatch(
      /^Warning: server/,
    );
  });

  it("backup_enable maps a locked server", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", srvReply())
      .on("POST", "/servers/{id}/actions/enable_backup", apiError(423, "locked"));
    const res = await t.call("backup_enable", { server_id: 42, confirm: true });
    expect(textOf(res)).toMatch(/^The resource is locked/);
  });

  it("backup_enable previews the surcharge", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", srvReply({ backup_window: null }))
      .on("GET", "/pricing", pricing());
    const res = await t.call("backup_enable", { server_id: 42 });
    const text = textOf(res);
    expect(text).toMatch(
      /^Confirmation required\. This would: enable daily backups for server "my-resource" \(ID 42\)/,
    );
    expect(text).toContain("20.00 % of the server price");
    expect(text).toContain("Price change: +0.20 EUR/month net");
    expect(writes(t)).toEqual([]);
  });

  it("backup_enable preview says backups are already enabled", async () => {
    const t = await start();
    t.fake
      .on("GET", "/servers/{id}", srvReply({ backup_window: "22-02" }))
      .on("GET", "/pricing", pricing());
    const res = await t.call("backup_enable", { server_id: 42 });
    expect(textOf(res)).toContain(
      "Backups are already enabled (backup window set); the price does not change.",
    );
  });

  it("backup_enable passes the cost limit when backups are already enabled", async () => {
    const t = await start({ maxMonthlyCost: "0.00" });
    t.fake
      .on("GET", "/servers/{id}", srvReply({ backup_window: "22-02" }))
      .on("GET", "/pricing", pricing());
    actionRoutes(t, "/servers/{id}/actions/enable_backup");
    const res = await t.call("backup_enable", { server_id: 42, confirm: true });
    expect(res.isError).toBeFalsy();
  });

  it("backup_enable checks the limit against the surcharge", async () => {
    const t = await start({ maxMonthlyCost: "0.19" });
    t.fake
      .on("GET", "/servers/{id}", srvReply({ backup_window: null }))
      .on("GET", "/pricing", pricing());
    const res = await t.call("backup_enable", { server_id: 42, confirm: true });
    expect(textOf(res)).toMatch(/^Cost limit exceeded: this call adds an estimated 0\.20 EUR/);
    expect(writes(t)).toEqual([]);
  });
});

describe("backup_disable", () => {
  const countRoute = (t: Harness, total: number | null) =>
    t.fake.on(
      "GET",
      "/images",
      ok(fixture("list_images", { meta: { pagination: { total_entries: total } } } as Obj)),
    );

  it("backup_disable asks for confirmation with the backup count", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply());
    countRoute(t, 3);
    const res = await t.call("backup_disable", { server_id: 42 });
    const text = textOf(res);
    expect(text).toMatch(
      /^Confirmation required\. This would: disable automatic backups for server "my-resource" \(ID 42\)/,
    );
    expect(text).toContain("permanently delete 3 existing backup image(s)");
    const q = t.fake.requests("GET", "/images")[0]?.query;
    expect(q?.get("type")).toBe("backup");
    expect(q?.get("bound_to")).toBe("42");
    expect(q?.get("per_page")).toBe("1");
    expect(writes(t)).toEqual([]);
  });

  it("backup_disable preview falls back when the total is unknown", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply());
    countRoute(t, null);
    const res = await t.call("backup_disable", { server_id: 42 });
    expect(textOf(res)).toContain("delete all existing backup image(s)");
  });

  it("backup_disable disables with confirm and waits", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply());
    actionRoutes(t, "/servers/{id}/actions/disable_backup");
    const res = await t.call("backup_disable", { server_id: 42, confirm: true });
    expect((res.structuredContent as { actions: Obj[] }).actions[0]?.status).toBe("success");
    expect(textOf(res)).toBe(
      "Disabling automatic backups for server 42; existing backups are being deleted.",
    );
  });

  it("backup_disable preview notes that backups are not enabled", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply({ backup_window: null }));
    countRoute(t, 0);
    const res = await t.call("backup_disable", { server_id: 42 });
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: Backups are not enabled for this server\. disable automatic backups/,
    );
  });

  it("backup_disable blocks an out-of-scope server", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/servers/{id}", srvReply({ labels: {} }));
    const res = await t.call("backup_disable", { server_id: 42 });
    expect(textOf(res)).toMatch(/^Resource server 42 is outside/);
    expect(t.fake.requests("GET", "/images")).toHaveLength(0);
    expect(writes(t)).toEqual([]);
  });

  it("backup_disable preview does not write", async () => {
    const t = await start();
    t.fake.on("GET", "/servers/{id}", srvReply());
    countRoute(t, 1);
    await t.call("backup_disable", { server_id: 42 });
    expect(writes(t)).toEqual([]);
    expect(t.fake.unmatched).toEqual([]);
  });
});

describe("storage toolset registration", () => {
  it("lists all 16 tools; costs tools are write tools without destructiveHint", async () => {
    const t = await start();
    const { tools } = await t.client.listTools();
    const storage = tools.filter((x) => /^(volume|snapshot|backup)_/.test(x.name));
    expect(storage).toHaveLength(16);
    for (const name of ["volume_create", "volume_resize", "snapshot_create", "backup_enable"]) {
      const tool = storage.find((x) => x.name === name);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      const props = (tool?.inputSchema as { properties?: Obj } | undefined)?.properties ?? {};
      expect(Object.keys(props)).toContain("confirm");
    }
  });

  it("HETZNER_MCP_ALLOW_COSTS=false drops exactly the four costs tools", async () => {
    const t = await start({ allowCosts: false });
    const names = (await t.client.listTools()).tools.map((x) => x.name);
    for (const name of ["volume_create", "volume_resize", "snapshot_create", "backup_enable"]) {
      expect(names).not.toContain(name);
    }
    for (const name of ["volume_delete", "backup_disable", "volume_update", "snapshot_delete"]) {
      expect(names).toContain(name);
    }
  });

  it("summaries carry no API names or descriptions", async () => {
    const t = await start();
    t.fake.on("GET", "/volumes/{id}", volReply({ name: "SENSITIVE-volname" }));
    const res = await rawCall(t, "volume_get", { id: 42 });
    expect(res.content.map((c) => c.text).join("")).not.toContain("SENSITIVE-volname");
    expect(logFields(t.logs, "tool_call")[0]).toMatchObject({ tool: "volume_get", outcome: "ok" });
    expect(JSON.stringify(t.logs)).not.toContain("SENSITIVE-volname");
  });
});
