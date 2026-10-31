import { describe, expect, it } from "vitest";
import {
  ConfigError,
  collectSecrets,
  DEFAULT_TOOLSETS,
  loadConfig,
  TOOLSET_NAMES,
} from "../../src/config.js";

const base = { HETZNER_TOKEN: "tok-123" };

function issuesOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  it("fails without HETZNER_TOKEN and HCLOUD_TOKEN", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    const issues = issuesOf({});
    expect(issues.join("\n")).toContain("HETZNER_TOKEN");
    expect(issues.join("\n")).toContain("HCLOUD_TOKEN");
  });

  it("accepts HCLOUD_TOKEN as alias", () => {
    const config = loadConfig({ HCLOUD_TOKEN: "alias-tok" });
    expect(config.projects[0].token).toBe("alias-tok");
    expect(config.tokenSource).toBe("HCLOUD_TOKEN");
  });

  it("rejects different HETZNER_TOKEN and HCLOUD_TOKEN", () => {
    expect(issuesOf({ HETZNER_TOKEN: "a", HCLOUD_TOKEN: "b" })).toContain(
      "HETZNER_TOKEN and HCLOUD_TOKEN are both set to different values; set only one (each token belongs to exactly one project)",
    );
  });

  it("accepts identical HETZNER_TOKEN and HCLOUD_TOKEN", () => {
    const config = loadConfig({ HETZNER_TOKEN: "same", HCLOUD_TOKEN: "same" });
    expect(config.projects[0].token).toBe("same");
    expect(config.tokenSource).toBe("HETZNER_TOKEN");
  });

  it("treats blank values as unset", () => {
    expect(() => loadConfig({ HETZNER_TOKEN: "  ", HCLOUD_TOKEN: "" })).toThrow(/is required/);
    const config = loadConfig({
      ...base,
      HETZNER_API_URL: "  ",
      HETZNER_MCP_TOOLSETS: " ",
      HETZNER_MCP_READ_ONLY: "",
    });
    expect(config.apiUrl).toBe("https://api.hetzner.cloud/v1");
    expect(config.readOnly).toBe(false);
    expect([...config.toolsets]).toEqual([...DEFAULT_TOOLSETS]);
  });

  it("rejects tokens with whitespace or control characters", () => {
    expect(issuesOf({ HETZNER_TOKEN: "a b" })).toContain(
      "HETZNER_TOKEN: must not contain whitespace or control characters",
    );
    expect(issuesOf({ HCLOUD_TOKEN: "a\u0001b" })).toContain(
      "HCLOUD_TOKEN: must not contain whitespace or control characters",
    );
  });

  it("defaults toolsets to core, info, actions, ssh_keys", () => {
    expect([...loadConfig(base).toolsets]).toEqual([...DEFAULT_TOOLSETS]);
    expect([...DEFAULT_TOOLSETS]).toEqual(["core", "info", "actions", "ssh_keys"]);
  });

  it("resolves 'all' and rejects unknown toolsets", () => {
    expect([...loadConfig({ ...base, HETZNER_MCP_TOOLSETS: "all" }).toolsets]).toEqual([
      ...TOOLSET_NAMES,
    ]);
    expect(issuesOf({ ...base, HETZNER_MCP_TOOLSETS: "core,nope" })).toContain(
      "HETZNER_MCP_TOOLSETS: unknown toolset 'nope' (valid: core, info, actions, ssh_keys, firewalls, storage, all)",
    );
  });

  it("parses HETZNER_MCP_LABEL_SCOPE into AND terms", () => {
    const config = loadConfig({ ...base, HETZNER_MCP_LABEL_SCOPE: "a=b, c=d" });
    expect(config.labelScope).toEqual([
      { key: "a", value: "b" },
      { key: "c", value: "d" },
    ]);
    expect(loadConfig(base).labelScope).toEqual([]);
  });

  it.each(["a", "a!=b", "a in (b)", "a==b", "a=", "hetzner.cloud/x=y", "a=b,a=c", "-a=b"])(
    "rejects invalid label scope term %j",
    (scope) => {
      const issues = issuesOf({ ...base, HETZNER_MCP_LABEL_SCOPE: scope });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.startsWith("HETZNER_MCP_LABEL_SCOPE:"))).toBe(true);
    },
  );

  it("defaults IaC policy to warn with both terraform markers", () => {
    const config = loadConfig(base);
    expect(config.iacPolicy).toBe("warn");
    expect(config.iacMarkers).toEqual([
      { key: "managed-by", value: "terraform" },
      { key: "managed_by", value: "terraform" },
    ]);
  });

  it("rejects an invalid IaC policy", () => {
    expect(issuesOf({ ...base, HETZNER_MCP_IAC_POLICY: "maybe" })).toContain(
      "HETZNER_MCP_IAC_POLICY: must be one of: off, warn, block",
    );
  });

  it("rejects empty IaC labels while policy is not off", () => {
    expect(issuesOf({ ...base, HETZNER_MCP_IAC_LABELS: "," })).toContain(
      "HETZNER_MCP_IAC_LABELS: must not be empty while HETZNER_MCP_IAC_POLICY is not 'off'",
    );
    expect(() =>
      loadConfig({ ...base, HETZNER_MCP_IAC_LABELS: ",", HETZNER_MCP_IAC_POLICY: "off" }),
    ).not.toThrow();
  });

  it("requires https for HETZNER_API_URL except loopback", () => {
    for (const url of ["http://example.com", "http://127.example.com"]) {
      expect(issuesOf({ ...base, HETZNER_API_URL: url })).toContain(
        "HETZNER_API_URL: must be an https URL (http is only allowed for localhost)",
      );
    }
    for (const url of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"]) {
      expect(loadConfig({ ...base, HETZNER_API_URL: url }).apiUrl).toBe(url);
    }
    expect(loadConfig({ ...base, HETZNER_API_URL: "https://proxy.example/v1/" }).apiUrl).toBe(
      "https://proxy.example/v1",
    );
  });

  it("warns when HETZNER_API_URL is not api.hetzner.cloud", () => {
    expect(loadConfig(base).warnings).toEqual([]);
    expect(loadConfig({ ...base, HETZNER_API_URL: "http://127.0.0.1:8080/v1" }).warnings).toContain(
      "HETZNER_API_URL points to '127.0.0.1' instead of api.hetzner.cloud; the API token is sent to that host.",
    );
  });

  it("warns when confirmations are disabled", () => {
    expect(loadConfig({ ...base, HETZNER_MCP_REQUIRE_CONFIRMATION: "false" }).warnings).toContain(
      "HETZNER_MCP_REQUIRE_CONFIRMATION=false: destructive and cost-incurring tools run without confirmation and without a cost preview.",
    );
  });

  it.each(["HETZNER_MCP_TIMEOUT_MS", "HETZNER_MCP_ACTION_WAIT_MS"])(
    "validates %s bounds",
    (name) => {
      const bad =
        name === "HETZNER_MCP_TIMEOUT_MS"
          ? ["999", "300001", "-1", "abc"]
          : ["600001", "-1", "abc"];
      for (const value of bad) {
        expect(issuesOf({ ...base, [name]: value }).join("\n")).toContain(
          `${name}: must be an integer`,
        );
      }
    },
  );

  it("validates timeout and action wait bounds", () => {
    expect(issuesOf({ ...base, HETZNER_MCP_TIMEOUT_MS: "1000" })).toEqual([]);
    expect(issuesOf({ ...base, HETZNER_MCP_TIMEOUT_MS: "300000" })).toEqual([]);
    expect(loadConfig({ ...base, HETZNER_MCP_ACTION_WAIT_MS: "0" }).actionWaitMs).toBe(0);
    expect(loadConfig(base).timeoutMs).toBe(30_000);
    expect(loadConfig(base).actionWaitMs).toBe(50_000);
  });

  it("warns when action wait exceeds 55 s", () => {
    expect(loadConfig({ ...base, HETZNER_MCP_ACTION_WAIT_MS: "55000" }).warnings).toEqual([]);
    expect(loadConfig({ ...base, HETZNER_MCP_ACTION_WAIT_MS: "55001" }).warnings).toContain(
      "HETZNER_MCP_ACTION_WAIT_MS is above 55000 ms; MCP clients with a 60 s request timeout may drop waiting tool calls. Prefer wait=false plus action_get.",
    );
  });

  it("collects the token as secret", () => {
    expect(collectSecrets(loadConfig(base))).toEqual(["tok-123"]);
  });

  it("defaults firewall guard ports to 22", () => {
    expect(loadConfig(base).firewallGuardPorts).toEqual([22]);
    expect(
      loadConfig({ ...base, HETZNER_MCP_FIREWALL_GUARD_PORTS: "443, 22, 443" }).firewallGuardPorts,
    ).toEqual([22, 443]);
  });

  it.each(["0", "65536", "22,abc", "1,2,3,4,5,6,7,8,9,10,11", "22-25"])(
    "rejects invalid firewall guard ports %j",
    (ports) => {
      expect(issuesOf({ ...base, HETZNER_MCP_FIREWALL_GUARD_PORTS: ports })).toContain(
        `HETZNER_MCP_FIREWALL_GUARD_PORTS: '${ports}' must be a list of TCP ports between 1 and 65535 (comma-separated, at most 10)`,
      );
    },
  );

  it("defaults cost switches to allowed and unlimited", () => {
    const config = loadConfig(base);
    expect(config.allowCosts).toBe(true);
    expect(config.maxMonthlyCost).toBeUndefined();
  });

  it("parses HETZNER_MCP_ALLOW_COSTS and HETZNER_MCP_MAX_MONTHLY_COST", () => {
    expect(loadConfig({ ...base, HETZNER_MCP_ALLOW_COSTS: "false" }).allowCosts).toBe(false);
    for (const value of ["5", "5.00", "0", "0.0071400000000000"]) {
      expect(loadConfig({ ...base, HETZNER_MCP_MAX_MONTHLY_COST: value }).maxMonthlyCost).toBe(
        value,
      );
    }
    expect(issuesOf({ ...base, HETZNER_MCP_ALLOW_COSTS: "maybe" })).toContain(
      "HETZNER_MCP_ALLOW_COSTS: must be true or false",
    );
  });

  it.each(["-1", "1,00", "1e3", "1.", ".5", "abc", "5 EUR"])(
    "rejects invalid monthly cost limit %j",
    (value) => {
      expect(issuesOf({ ...base, HETZNER_MCP_MAX_MONTHLY_COST: value })).toContain(
        "HETZNER_MCP_MAX_MONTHLY_COST: must be a non-negative decimal number with '.' as separator (net amount per month in the pricing currency, e.g. 5.00)",
      );
    },
  );

  it("validates project name, read-only and log level", () => {
    expect(loadConfig(base).projects[0].name).toBe("default");
    expect(issuesOf({ ...base, HETZNER_MCP_PROJECT_NAME: "Prod" }).length).toBe(1);
    expect(issuesOf({ ...base, HETZNER_MCP_READ_ONLY: "x" })).toContain(
      "HETZNER_MCP_READ_ONLY: must be true or false",
    );
    expect(issuesOf({ ...base, HETZNER_MCP_LOG_LEVEL: "loud" })).toContain(
      "HETZNER_MCP_LOG_LEVEL: must be one of: debug, info, warn, error",
    );
  });

  it("collects all issues at once", () => {
    const issues = issuesOf({ HETZNER_MCP_READ_ONLY: "x", HETZNER_MCP_TIMEOUT_MS: "1" });
    expect(issues.length).toBe(3);
  });
});
