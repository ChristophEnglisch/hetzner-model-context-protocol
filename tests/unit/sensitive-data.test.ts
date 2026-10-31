import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { collectSecrets } from "../../src/config.js";
import { path } from "../../src/hetzner/gateway.js";
import { createLogger } from "../../src/logging.js";
import { defineTool } from "../../src/tools/shared.js";
import { action, ok } from "../helpers/fake-hetzner.js";
import { makeConfig, TEST_TOKEN } from "../helpers/fakes.js";
import { fixture } from "../helpers/fixtures.js";
import {
  type Harness,
  logFields,
  startHarness,
  startToolHarness,
  textOf,
} from "../helpers/harness.js";
import { findSensitive } from "../helpers/sensitive.js";

// T-S1..T-S4 (01 §9.3) run against the real server_create (AP-14, OE-10); T-S5 is from AP-06.
const CREATE = {
  name: "web-1",
  server_type: "cpx22",
  image: "ubuntu-24.04",
  location: "fsn1",
  ssh_keys: ["admin"],
  public_net: { enable_ipv6: false },
};

async function createHarness(rootPassword: string | null): Promise<Harness> {
  const t = await startHarness();
  t.fake
    .on(
      "POST",
      "/servers",
      ok({ ...fixture<object>("create_server"), root_password: rootPassword }, 201),
    )
    .on("GET", "/actions", ok({ actions: [action(1, "success"), action(13, "success")] }))
    .on("GET", "/pricing", ok(fixture("get_pricing")));
  return t;
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("sensitive data", () => {
  it("never returns or logs root_password from server_create", async () => {
    h = await createHarness("SENSITIVE-root");
    const result = await h.call("server_create", { ...CREATE, confirm: true }); // harness checks too
    expect(result.isError).toBeFalsy();
    expect(findSensitive({ result, logs: h.logs }, TEST_TOKEN)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("root_password");
    expect(h.logs.join("\n")).not.toContain("SENSITIVE-root");
  });

  it("warns when Hetzner returns a root password despite SSH keys", async () => {
    h = await createHarness("SENSITIVE-root");
    const result = await h.call("server_create", { ...CREATE, confirm: true });
    expect(logFields(h.logs, "root_password_discarded")).toEqual([{ tool: "server_create" }]);
    expect(textOf(result)).toContain(
      "Hetzner returned a root password; it was discarded and cannot be retrieved. Log in with the SSH key.",
    );
    // Without a password: no warning, no sentence.
    await h.close();
    h = await createHarness(null);
    const clean = await h.call("server_create", { ...CREATE, confirm: true });
    expect(logFields(h.logs, "root_password_discarded")).toEqual([]);
    expect(textOf(clean)).not.toContain("root password");
  });

  it("never echoes user_data in preview, summary or logs", async () => {
    h = await createHarness(null);
    const args = { ...CREATE, user_data: "SENSITIVE-cloud-init" };
    const preview = await h.call("server_create", args);
    expect(textOf(preview)).toContain("with cloud-init user data (20 bytes)");
    const result = await h.call("server_create", { ...args, confirm: true });
    expect(result.isError).toBeFalsy();
    expect(findSensitive({ preview, result, logs: h.logs }, TEST_TOKEN)).toEqual([]);
    expect(h.fake.requests("POST", "/servers")[0]?.body).toMatchObject({
      user_data: "SENSITIVE-cloud-init",
    });
  });

  it("requires at least one SSH key for server_create", async () => {
    h = await startHarness();
    const result = await h.call("server_create", { ...CREATE, ssh_keys: [], confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ssh_keys");
    expect(h.fake.calls).toHaveLength(0);
  });

  it("masks the token in every log line", async () => {
    // The token reaches the logger through an error message (error path) and through a field.
    const probe = defineTool({
      name: "probe_read",
      title: "Probe",
      description: "Fails with the token in the message.",
      kind: "read",
      input: z.object({}),
      output: z.object({}),
      handler: async (_args, ctx) => {
        await ctx.gateway.request("GET", path`/probe`, { signal: ctx.signal });
        throw new Error(`boom ${TEST_TOKEN}`);
      },
    });
    h = await startToolHarness([probe]);
    h.fake.on("GET", "/probe", { status: 200, body: {} });
    const result = await h.call("probe_read", {});
    expect(result.isError).toBe(true);
    h.logger.error("manual", { note: `Bearer ${TEST_TOKEN}`, token: TEST_TOKEN });
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) expect(line).not.toContain(TEST_TOKEN);
    expect(h.logs.join("\n")).toContain("***");
  });

  it("masks every project token with the logger built from collectSecrets", () => {
    const config = makeConfig();
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      secrets: collectSecrets(config),
      write: (l) => lines.push(l),
    });
    logger.info(`plain ${TEST_TOKEN} text`, { authorization: `Bearer ${TEST_TOKEN}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(TEST_TOKEN);
    expect(lines[0]).toContain("***");
  });
});

describe("findSensitive", () => {
  it("reports sensitive keys, the token and the marker at any depth", () => {
    const findings = findSensitive({
      a: [{ root_password: "x" }],
      b: { c: `x ${TEST_TOKEN}` },
      d: "SENSITIVE-root",
    });
    expect(findings).toEqual([
      "a[0].root_password: sensitive key",
      "b.c: token",
      "d: SENSITIVE- marker",
    ]);
  });

  it("is empty for clean values", () => {
    expect(findSensitive({ ok: ["fine", { id: 1 }], none: null })).toEqual([]);
  });
});
