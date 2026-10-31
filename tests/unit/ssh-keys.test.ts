import { afterEach, describe, expect, it } from "vitest";
import { apiError, noContent, ok } from "../helpers/fake-hetzner.js";
import { fixture } from "../helpers/fixtures.js";
import { type Harness, logFields, startHarness, textOf } from "../helpers/harness.js";

const SCOPE = [{ key: "managed-by", value: "mcp" }];
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

type Key = Record<string, unknown>;
const key = (over: Key = {}): Key => ({
  ...(fixture<{ ssh_key: Key }>("get_ssh_key").ssh_key as Key),
  ...over,
});
const keyReply = (over: Key = {}, status = 200) => ok({ ssh_key: key(over) }, status);

const bodyOf = (t: Harness, method: "POST" | "PUT", pattern: string): Key =>
  (t.fake.requests(method, pattern)[0]?.body ?? {}) as Key;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function start(config: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  h = await startHarness(config);
  return h;
}

/** Calls without the harness's sensitive-marker assertion (for tests that plant SENSITIVE- values on purpose). */
async function rawCall(harness: Harness, name: string, args: Record<string, unknown>) {
  return (await harness.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
  };
}

describe("ssh_key_list", () => {
  it("ssh_key_list returns keys without public_key", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys", ok(fixture("list_ssh_keys")));
    const res = await t.call("ssh_key_list");
    const items = (res.structuredContent as { items: Key[] }).items;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0] as Key).sort()).toEqual([
      "created",
      "fingerprint",
      "id",
      "labels",
      "name",
    ]);
    expect(items[0]).not.toHaveProperty("public_key");
  });

  it("ssh_key_list forwards filters and pagination", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys", ok(fixture("list_ssh_keys")));
    await t.call("ssh_key_list", {
      name: "my-resource",
      fingerprint: "b7:2f:30:a0",
      label_selector: "env=prod",
      sort: "name:asc",
      page: 2,
      per_page: 10,
    });
    const q = t.fake.requests("GET", "/ssh_keys")[0]?.query;
    expect(q?.get("name")).toBe("my-resource");
    expect(q?.get("fingerprint")).toBe("b7:2f:30:a0");
    expect(q?.get("label_selector")).toBe("env=prod");
    expect(q?.get("sort")).toBe("name:asc");
    expect(q?.get("page")).toBe("2");
    expect(q?.get("per_page")).toBe("10");
  });

  it("ssh_key_list reports hasMore through next_page", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/ssh_keys",
      ok(fixture("list_ssh_keys", { meta: { pagination: { next_page: 2 } } })),
    );
    const res = await t.call("ssh_key_list");
    expect((res.structuredContent as { next_page: number }).next_page).toBe(2);
    expect(textOf(res).endsWith("More on page 2.")).toBe(true);
  });

  it("ssh_key_list is not filtered by the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    const base = fixture<{ ssh_keys: Key[] }>("list_ssh_keys");
    t.fake.on(
      "GET",
      "/ssh_keys",
      ok({
        ...base,
        ssh_keys: [key({ id: 1, labels: { "managed-by": "mcp" } }), key({ id: 2, labels: {} })],
      }),
    );
    const res = await t.call("ssh_key_list");
    expect((res.structuredContent as { items: Key[] }).items.map((i) => i.id)).toEqual([1, 2]);
  });

  it("ssh_key_list does not put names or fingerprints in the summary", async () => {
    const t = await start();
    t.fake.on(
      "GET",
      "/ssh_keys",
      ok({
        ...fixture<object>("list_ssh_keys"),
        ssh_keys: [key({ name: "SENSITIVE-name", fingerprint: "SENSITIVE-fp" })],
      }),
    );
    const res = await rawCall(t, "ssh_key_list", {});
    const summary = res.content.map((c) => c.text).join("");
    expect(summary).not.toContain("SENSITIVE-name");
    expect(summary).not.toContain("SENSITIVE-fp");
    expect(summary).toBe("Returned 1 SSH key(s) (page 3, 100 in total). More on page 4.");
  });

  it("ssh_key_list maps auth errors", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys", apiError(401, "unauthorized"));
    const res = await t.call("ssh_key_list");
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Hetzner rejected the API token \(HTTP 401\)/);
  });
});

describe("ssh_key_get", () => {
  it("ssh_key_get returns the key with public key and fingerprint", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", ok(fixture("get_ssh_key")));
    const res = await t.call("ssh_key_get", { id: 42 });
    const k = (res.structuredContent as { ssh_key: Key }).ssh_key;
    expect(k.public_key).toBeTruthy();
    expect(k.fingerprint).toBeTruthy();
    expect(textOf(res)).toBe("Returned SSH key 42.");
  });

  it("ssh_key_get maps not found", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", apiError(404, "not_found"));
    const res = await t.call("ssh_key_get", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Not found \(HTTP 404\)/);
  });

  it("ssh_key_get strips undeclared fields", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ extra: "SENSITIVE-x" }));
    const res = await t.call("ssh_key_get", { id: 42 });
    expect((res.structuredContent as { ssh_key: Key }).ssh_key).not.toHaveProperty("extra");
  });
});

describe("ssh_key_create", () => {
  it("ssh_key_create creates a key and returns fingerprint and public key", async () => {
    const t = await start();
    t.fake.on("POST", "/ssh_keys", ok(fixture("create_ssh_key"), 201));
    const res = await t.call("ssh_key_create", { name: "laptop", public_key: PUB });
    expect((res.structuredContent as { ssh_key: Key }).ssh_key.fingerprint).toBeTruthy();
    expect(t.fake.requests("POST", "/ssh_keys")[0]?.body).toEqual({
      name: "laptop",
      public_key: PUB,
    });
    expect(textOf(res)).toBe("Created SSH key 42. Use its name in ssh_keys of server_create.");
  });

  it("ssh_key_create trims the public key before sending", async () => {
    const t = await start();
    t.fake.on("POST", "/ssh_keys", ok(fixture("create_ssh_key"), 201));
    await t.call("ssh_key_create", { name: "laptop", public_key: `  ${PUB} me@host\n` });
    const body = t.fake.requests("POST", "/ssh_keys")[0]?.body as { public_key: string };
    expect(body.public_key).toBe(`${PUB} me@host`);
  });

  it.each([
    ["empty string", ""],
    ["hello", "hello"],
    ["type only", "ssh-ed25519"],
    ["two lines", `${PUB}\n${PUB}`],
    ["too short", "ssh-rsa LEAKCHECK"],
  ])(
    "ssh_key_create rejects invalid public key formats at the schema: %s",
    async (_label, value) => {
      const t = await start();
      const res = await t.call("ssh_key_create", { name: "laptop", public_key: value });
      expect(res.isError).toBe(true);
      expect(t.fake.calls).toHaveLength(0);
      expect(textOf(res)).not.toContain("LEAKCHECK");
    },
  );

  it("ssh_key_create rejects invalid public key formats at the schema: private key", async () => {
    const t = await start();
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETBODYSECRETBODY\n-----END OPENSSH PRIVATE KEY-----";
    const res = await t.call("ssh_key_create", { name: "laptop", public_key: pem });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("private key");
    expect(textOf(res)).not.toContain("SECRETBODY");
    expect(t.fake.calls).toHaveLength(0);
  });

  it.each(["ssh-rsa", "ssh-ed25519", "ecdsa-sha2-nistp256", "sk-ssh-ed25519@openssh.com"])(
    "ssh_key_create accepts common key types: %s",
    async (type) => {
      const t = await start();
      t.fake.on("POST", "/ssh_keys", ok(fixture("create_ssh_key"), 201));
      const value = `${type} AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoq me@host`;
      const res = await t.call("ssh_key_create", { name: "laptop", public_key: value });
      expect(res.isError).toBeFalsy();
      expect(bodyOf(t, "POST", "/ssh_keys").public_key).toBe(value);
    },
  );

  it("ssh_key_create adds scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("POST", "/ssh_keys", ok(fixture("create_ssh_key"), 201));
    await t.call("ssh_key_create", { name: "laptop", public_key: PUB, labels: { env: "x" } });
    expect(bodyOf(t, "POST", "/ssh_keys").labels).toEqual({
      env: "x",
      "managed-by": "mcp",
    });
  });

  it("ssh_key_create rejects a conflicting scope label", async () => {
    const t = await start({ labelScope: SCOPE });
    const res = await t.call("ssh_key_create", {
      name: "laptop",
      public_key: PUB,
      labels: { "managed-by": "other" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Label 'managed-by' is reserved by HETZNER_MCP_LABEL_SCOPE/);
    expect(t.fake.requests("POST", "/ssh_keys")).toHaveLength(0);
  });

  it("ssh_key_create maps duplicates", async () => {
    const t = await start();
    t.fake.on(
      "POST",
      "/ssh_keys",
      apiError(409, "uniqueness_error", "x", { fields: [{ name: "public_key" }] }),
    );
    const res = await t.call("ssh_key_create", { name: "laptop", public_key: PUB });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /^A resource with the same unique value already exists: public_key\./,
    );
    expect(t.fake.requests("POST", "/ssh_keys")).toHaveLength(1);
  });

  it("ssh_key_create does not log or echo the key", async () => {
    const t = await start();
    t.fake.on("POST", "/ssh_keys", keyReply({ name: "secret-laptop-name" }, 201));
    const res = await rawCall(t, "ssh_key_create", {
      name: "secret-laptop-name",
      public_key: `${PUB} comment-xyz`,
    });
    const summary = res.content.map((c) => c.text).join("");
    expect(summary).not.toContain("secret-laptop-name");
    expect(summary).not.toContain("AAAAC3");
    const logged = t.logs.join("\n");
    expect(logged).not.toContain("AAAAC3");
    expect(logged).not.toContain("comment-xyz");
    expect(logged).not.toContain("public_key");
  });

  it("ssh_key_create runs under the confirmation-free write path", async () => {
    const t = await start();
    t.fake.on("POST", "/ssh_keys", ok(fixture("create_ssh_key"), 201));
    const res = await t.call("ssh_key_create", { name: "laptop", public_key: PUB });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toContain("Confirmation required");
  });
});

describe("ssh_key_update", () => {
  it("ssh_key_update renames a key", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply());
    t.fake.on("PUT", "/ssh_keys/{id}", keyReply({ name: "new" }));
    const res = await t.call("ssh_key_update", { id: 42, name: "new" });
    expect(t.fake.requests("PUT", "/ssh_keys/{id}")[0]?.body).toEqual({ name: "new" });
    expect(textOf(res)).toBe("Updated SSH key 42.");
    expect(t.fake.requests("GET", "/ssh_keys/{id}")).toHaveLength(1);
    expect(t.fake.requests("PUT", "/ssh_keys/{id}")).toHaveLength(1);
  });

  it("ssh_key_update returns labels from the response", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply());
    t.fake.on("PUT", "/ssh_keys/{id}", ok({ ssh_key: { ...key(), labels: { a: "b" } } }));
    const res = await t.call("ssh_key_update", { id: 42, labels: { c: "d" } });
    expect((res.structuredContent as { ssh_key: Key }).ssh_key.labels).toEqual({ a: "b" });
  });

  it("ssh_key_update keeps scope labels", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ labels: { "managed-by": "mcp" } }));
    t.fake.on("PUT", "/ssh_keys/{id}", keyReply());
    await t.call("ssh_key_update", { id: 42, labels: { env: "x" } });
    expect(bodyOf(t, "PUT", "/ssh_keys/{id}").labels).toEqual({
      env: "x",
      "managed-by": "mcp",
    });
  });

  it("ssh_key_update refuses keys outside the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ labels: {} }));
    const res = await t.call("ssh_key_update", { id: 42, name: "new" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource ssh_key 42 is outside the label scope/);
    expect(t.fake.requests("PUT", "/ssh_keys/{id}")).toHaveLength(0);
  });

  it("ssh_key_update warns about IaC markers", async () => {
    const t = await start({ iacPolicy: "warn" });
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ labels: { "managed-by": "terraform" } }));
    t.fake.on("PUT", "/ssh_keys/{id}", keyReply());
    const res = await t.call("ssh_key_update", { id: 42, name: "new" });
    const warnings = (res.structuredContent as { warnings: string[] }).warnings;
    expect(warnings[0]).toContain("managed-by=terraform");
    expect(textOf(res).startsWith("Warning:")).toBe(true);
  });

  it("ssh_key_update blocks IaC-managed keys with policy block", async () => {
    const t = await start({ iacPolicy: "block" });
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ labels: { "managed-by": "terraform" } }));
    const res = await t.call("ssh_key_update", { id: 42, name: "new" });
    expect(res.isError).toBe(true);
    expect(t.fake.requests("PUT", "/ssh_keys/{id}")).toHaveLength(0);
  });

  it("ssh_key_update requires name or labels", async () => {
    const t = await start();
    const res = await t.call("ssh_key_update", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Provide at least one of 'name' or 'labels'.");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("ssh_key_update maps a taken name", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply());
    t.fake.on(
      "PUT",
      "/ssh_keys/{id}",
      apiError(409, "uniqueness_error", "x", { fields: [{ name: "name" }] }),
    );
    const res = await t.call("ssh_key_update", { id: 42, name: "taken" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^A resource with the same unique value already exists: name\./);
  });

  it("ssh_key_update loads the target once", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply());
    t.fake.on("PUT", "/ssh_keys/{id}", keyReply());
    await t.call("ssh_key_update", { id: 42, name: "new" });
    expect(t.fake.requests("GET", "/ssh_keys/{id}")).toHaveLength(1);
  });
});

describe("ssh_key_delete", () => {
  it("ssh_key_delete asks for confirmation first", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ name: "my key" }));
    const res = await t.call("ssh_key_delete", { id: 42 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /^Confirmation required\. This would: delete SSH key 42 "my key" from the project\./,
    );
    expect(t.fake.requests("DELETE", "/ssh_keys/{id}")).toHaveLength(0);
  });

  it("ssh_key_delete deletes with confirm true", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply());
    t.fake.on("DELETE", "/ssh_keys/{id}", noContent());
    const res = await t.call("ssh_key_delete", { id: 42, confirm: true });
    expect(res.structuredContent).toMatchObject({ id: 42, deleted: true });
    expect(textOf(res)).toBe("Deleted SSH key 42.");
    expect(t.fake.requests("GET", "/ssh_keys/{id}")).toHaveLength(1);
    expect(t.fake.requests("DELETE", "/ssh_keys/{id}")).toHaveLength(1);
  });

  it("ssh_key_delete quotes the name in the preview", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ name: 'a\u0007b "x"' }));
    const res = await t.call("ssh_key_delete", { id: 42 });
    expect(textOf(res)).toContain('delete SSH key 42 "ab \\"x\\"" from the project.');
  });

  it("ssh_key_delete refuses keys outside the label scope", async () => {
    const t = await start({ labelScope: SCOPE });
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ labels: {} }));
    const res = await t.call("ssh_key_delete", { id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Resource ssh_key 42 is outside the label scope/);
    expect(textOf(res)).not.toContain("Confirmation required");
    expect(t.fake.requests("DELETE", "/ssh_keys/{id}")).toHaveLength(0);
  });

  it("ssh_key_delete shows IaC warnings in the preview", async () => {
    const t = await start({ iacPolicy: "warn" });
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ labels: { "managed-by": "terraform" } }));
    const res = await t.call("ssh_key_delete", { id: 42 });
    expect(textOf(res)).toContain(
      "Warning: ssh_key 42 carries the infrastructure-as-code marker 'managed-by=terraform'",
    );
  });

  it("ssh_key_delete blocks IaC-managed keys with policy block", async () => {
    const t = await start({ iacPolicy: "block" });
    t.fake.on("GET", "/ssh_keys/{id}", keyReply({ labels: { "managed-by": "terraform" } }));
    const res = await t.call("ssh_key_delete", { id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(t.fake.requests("DELETE", "/ssh_keys/{id}")).toHaveLength(0);
  });

  it("ssh_key_delete skips confirmation when disabled", async () => {
    const t = await start({ requireConfirmation: false });
    t.fake.on("GET", "/ssh_keys/{id}", keyReply());
    t.fake.on("DELETE", "/ssh_keys/{id}", noContent());
    const res = await t.call("ssh_key_delete", { id: 42 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ id: 42, deleted: true });
  });

  it("ssh_key_delete maps not found", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", apiError(404, "not_found"));
    const res = await t.call("ssh_key_delete", { id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Not found \(HTTP 404\)/);
  });

  it("ssh_key_delete does not retry the DELETE on 502", async () => {
    const t = await start();
    t.fake.on("GET", "/ssh_keys/{id}", keyReply());
    t.fake.on("DELETE", "/ssh_keys/{id}", apiError(502, "bad_gateway"));
    const res = await t.call("ssh_key_delete", { id: 42, confirm: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(
      "check with the matching *_get or action_list tool whether the change was applied",
    );
    expect(t.fake.requests("DELETE", "/ssh_keys/{id}")).toHaveLength(1);
    expect(logFields(t.logs, "tool_call").at(-1)?.tool).toBe("ssh_key_delete");
  });
});

describe("ssh_keys tool metadata", () => {
  it("lists five tools with the specified kinds as annotations", async () => {
    const t = await start();
    const { tools } = await t.client.listTools();
    const mine = tools.filter((x) => x.name.startsWith("ssh_key_"));
    expect(mine.map((x) => x.name).sort()).toEqual([
      "ssh_key_create",
      "ssh_key_delete",
      "ssh_key_get",
      "ssh_key_list",
      "ssh_key_update",
    ]);
    const a = (n: string) => mine.find((x) => x.name === n)?.annotations;
    expect(a("ssh_key_list")).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(a("ssh_key_create")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(a("ssh_key_update")).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(a("ssh_key_delete")).toMatchObject({ destructiveHint: true });
  });
});
