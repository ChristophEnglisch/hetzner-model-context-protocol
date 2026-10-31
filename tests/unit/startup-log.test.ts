import { describe, expect, it } from "vitest";
import { startupFields } from "../../src/config.js";
import { makeConfig, TEST_TOKEN } from "../helpers/fakes.js";

describe("startup log fields", () => {
  it("carries the fields of 01 §2.4 and no token", () => {
    const fields = startupFields(
      makeConfig({
        labelScope: [
          { key: "managed-by", value: "mcp" },
          { key: "env", value: "x" },
        ],
        maxMonthlyCost: "5.00",
        tokenSource: "HCLOUD_TOKEN",
        readOnly: true,
        allowCosts: false,
        toolsets: new Set(["core", "info"]),
      }),
      "1.2.3",
    );
    expect(fields).toEqual({
      version: "1.2.3",
      apiUrl: "https://api.hetzner.test/v1",
      project: "test",
      tokenSource: "HCLOUD_TOKEN",
      readOnly: true,
      toolsets: ["core", "info"],
      labelScope: "managed-by=mcp,env=x",
      iacPolicy: "warn",
      allowCosts: false,
      maxMonthlyCost: "5.00",
    });
    expect(JSON.stringify(fields)).not.toContain(TEST_TOKEN);
  });

  it("omits maxMonthlyCost when unset and prints an empty scope as empty string", () => {
    const fields = startupFields(makeConfig(), "1.0.0");
    expect(Object.hasOwn(fields, "maxMonthlyCost")).toBe(false);
    expect(fields.labelScope).toBe("");
  });
});
