import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { collectSecrets } from "../../src/config.js";
import { path } from "../../src/hetzner/gateway.js";
import { createLogger } from "../../src/logging.js";
import { defineTool } from "../../src/tools/shared.js";
import { makeConfig, TEST_TOKEN } from "../helpers/fakes.js";
import { type Harness, startToolHarness } from "../helpers/harness.js";
import { findSensitive } from "../helpers/sensitive.js";

// T-S1..T-S4 depend on server_create and are written in AP-14 (OE-10).

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("sensitive data", () => {
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
