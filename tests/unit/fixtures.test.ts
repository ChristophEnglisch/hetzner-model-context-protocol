import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixture } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = join(ROOT, "tests", "fixtures");
const SCRIPT = join(ROOT, "scripts", "extract-fixtures.mjs");

// Operations with 204 and no body have no fixture (01 §9.4). None of the 52 listed ones is such.
const NO_BODY: string[] = [];

const { OPERATION_IDS } = (await import(SCRIPT)) as { OPERATION_IDS: string[] };

describe("fixtures", () => {
  it("lists the 52 binding operationIds", () => {
    expect(OPERATION_IDS).toHaveLength(52);
    expect(new Set(OPERATION_IDS).size).toBe(52);
  });

  it.each(OPERATION_IDS.filter((id) => !NO_BODY.includes(id)))("has a file for %s", (id) => {
    expect(existsSync(join(FIXTURE_DIR, `${id}.json`))).toBe(true);
  });

  it("has no fixture files outside the list", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(
      OPERATION_IDS.filter((id) => !NO_BODY.includes(id)).sort(),
    );
  });

  it("removes the $source header", () => {
    expect(fixture("get_server")).not.toHaveProperty("$source");
  });

  it("returns an independent deep clone", () => {
    const a = fixture<{ server: { name: string } }>("get_server");
    a.server.name = "changed";
    expect(fixture<{ server: { name: string } }>("get_server").server.name).not.toBe("changed");
  });

  it("deep-merges objects and replaces arrays", () => {
    type S = { server: { labels: Record<string, string>; volumes: number[]; id: number } };
    const base = fixture<S>("get_server");
    const merged = fixture<S>("get_server", {
      server: { labels: { "managed-by": "terraform" }, volumes: [7, 8] },
    });
    expect(merged.server.labels["managed-by"]).toBe("terraform");
    expect(merged.server.volumes).toEqual([7, 8]);
    expect(merged.server.id).toBe(base.server.id);
  });

  it("keeps pricing in the shape 03 §2.8 expects", () => {
    const p = fixture<{
      pricing: {
        currency: string;
        vat_rate: string;
        server_types: { name: string; id: number }[];
        primary_ips: { type: string }[];
      };
    }>("get_pricing").pricing;
    expect(p.currency).toBe("EUR");
    expect(p.vat_rate).toBe("19.00");
    expect(p.server_types).toHaveLength(1);
    expect(p.server_types[0]).toMatchObject({ name: "cpx22", id: 104 });
    expect(p.primary_ips[0]?.type).toBe("ipv4");
  });

  it("marks root passwords as sensitive", () => {
    for (const id of ["create_server", "rebuild_server"]) {
      expect(fixture<{ root_password: string }>(id).root_password).toBe("SENSITIVE-root_password");
    }
  });
});
