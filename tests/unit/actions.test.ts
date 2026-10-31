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
const getAction = (over: Json) => ok(fixture("get_action", { action: over }));

describe("action_get", () => {
  it("action_get returns a running action", async () => {
    h.fake.on(
      "GET",
      "/actions/{id}",
      getAction({ status: "running", progress: 40, finished: null, error: null }),
    );
    const r = await h.call("action_get", { id: 42 });
    expect(r.isError).toBeUndefined();
    expect(sc(r).action.status).toBe("running");
    expect(textOf(r)).toBe(
      "Action 42 (start_resource) is running, 40% done. Check again with action_get in a few seconds.",
    );
  });

  it("action_get returns a finished action", async () => {
    h.fake.on("GET", "/actions/{id}", getAction({ status: "success", progress: 100, error: null }));
    const r = await h.call("action_get", { id: 42 });
    expect(textOf(r)).toBe("Action 42 (start_resource) finished successfully.");
  });

  it("action_get returns a failed action as data", async () => {
    h.fake.on(
      "GET",
      "/actions/{id}",
      getAction({
        status: "error",
        error: { code: "server_error", message: "free text from the API" },
      }),
    );
    const r = await h.call("action_get", { id: 42 });
    expect(r.isError).toBeUndefined();
    expect(sc(r).action.error.code).toBe("server_error");
    expect(textOf(r)).not.toContain("free text from the API");
    expect(textOf(r)).toBe("Action 42 (start_resource) failed; see 'action.error' in the result.");
  });

  it("action_get adds the ACPI note for shutdown", async () => {
    h.fake.on(
      "GET",
      "/actions/{id}",
      getAction({ command: "shutdown_server", status: "success", error: null }),
    );
    expect(textOf(await h.call("action_get", { id: 42 }))).toContain("ACPI signal");
  });

  it("action_get uses the non-deprecated endpoint", async () => {
    h.fake.on("GET", "/actions/{id}", getAction({ status: "success", error: null }));
    await h.call("action_get", { id: 42 });
    expect(h.fake.requests("GET", "/actions/{id}")).toHaveLength(1);
    expect(h.fake.calls.map((c) => c.path)).toEqual(["/actions/42"]);
    expect(h.fake.unmatched).toEqual([]);
  });

  it("action_get maps not found", async () => {
    h.fake.on("GET", "/actions/{id}", apiError(404, "not_found"));
    const r = await h.call("action_get", { id: 42 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Not found \(HTTP 404\)/);
  });

  it("action_get rejects non-positive ids at the schema", async () => {
    const r = await h.call("action_get", { id: 0 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Input validation error");
    expect(h.fake.calls).toEqual([]);
  });
});

const list = (over: Json = {}) => ok(fixture("list_server_actions", over));

describe("action_list", () => {
  it("action_list returns the actions of a server newest first", async () => {
    h.fake.on("GET", "/servers/{id}/actions", list());
    const r = await h.call("action_list", { resource_type: "server", resource_id: 42 });
    const q = h.fake.requests("GET", "/servers/{id}/actions")[0]?.query as URLSearchParams;
    expect(q.get("sort")).toBe("started:desc");
    expect(q.get("page")).toBe("1");
    expect(q.get("per_page")).toBe("25");
    expect(sc(r).items[0]).toMatchObject({ id: 13, command: "start_server", status: "success" });
    expect(textOf(r)).toBe("Returned 1 action(s) (page 1, 21 in total).");
  });

  it.each([
    ["server", "servers"],
    ["volume", "volumes"],
    ["firewall", "firewalls"],
    ["image", "images"],
  ])("action_list routes every resource type to its endpoint (%s)", async (type, segment) => {
    h.fake.on("GET", `/${segment}/{id}/actions`, list());
    await h.call("action_list", { resource_type: type, resource_id: 7 });
    expect(h.fake.calls.map((c) => c.path)).toEqual([`/${segment}/7/actions`]);
    expect(h.fake.unmatched).toEqual([]);
  });

  it("action_list sends repeated status keys", async () => {
    h.fake.on("GET", "/servers/{id}/actions", list());
    await h.call("action_list", {
      resource_type: "server",
      resource_id: 42,
      status: ["running", "error"],
    });
    const q = h.fake.requests("GET", "/servers/{id}/actions")[0]?.query as URLSearchParams;
    expect(q.getAll("status")).toEqual(["running", "error"]);
  });

  it("action_list reports hasMore through next_page", async () => {
    h.fake.on("GET", "/servers/{id}/actions", list({ meta: { pagination: { next_page: 2 } } }));
    const r = await h.call("action_list", { resource_type: "server", resource_id: 42 });
    expect(sc(r).next_page).toBe(2);
    expect(textOf(r).endsWith("More on page 2.")).toBe(true);
  });

  it("action_list counts running actions in the summary", async () => {
    const base = fixture<{ actions: Json[] }>("list_server_actions").actions[0] as Json;
    h.fake.on(
      "GET",
      "/servers/{id}/actions",
      list({
        actions: [
          { ...base, id: 1, status: "running", progress: 10, finished: null, error: null },
          { ...base, id: 2, status: "success", error: null },
        ],
      }),
    );
    const r = await h.call("action_list", { resource_type: "server", resource_id: 42 });
    expect(textOf(r)).toContain(" 1 still running.");
  });

  it("action_list does not call deprecated per-action endpoints", async () => {
    h.fake.on("GET", "/servers/{id}/actions", list());
    await h.call("action_list", { resource_type: "server", resource_id: 42 });
    expect(h.fake.calls.map((c) => c.path)).toEqual(["/servers/42/actions"]);
    expect(h.fake.unmatched).toEqual([]);
  });

  it("action_list maps not found", async () => {
    h.fake.on("GET", "/servers/{id}/actions", apiError(404, "not_found"));
    const r = await h.call("action_list", { resource_type: "server", resource_id: 42 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Not found \(HTTP 404\)/);
  });

  it("action_list rejects an unknown resource type at the schema", async () => {
    const r = await h.call("action_list", { resource_type: "network", resource_id: 1 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Input validation error");
    expect(h.fake.calls).toEqual([]);
  });
});
