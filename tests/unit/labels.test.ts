import { describe, expect, it } from "vitest";
import {
  formatTerms,
  labelKeySchema,
  labelsSchema,
  matchesAll,
  matchingTerm,
  parseLabelTerms,
  splitSelector,
} from "../../src/labels.js";

const n63 = `a${"b".repeat(61)}c`;
const n64 = `a${"b".repeat(62)}c`;

describe("labels", () => {
  it.each([
    ["env", "prod", true],
    ["managed-by", "terraform", true],
    ["a.b_c-d", "x.y_z-1", true],
    ["example.com/role", "web", true],
    ["sub.example.com/x", "", true], // empty value is allowed
    [n63, n63, true],
    [n64, "x", false],
    ["x", n64, false],
    ["-env", "x", false],
    ["env-", "x", false],
    ["Example.com/x", "y", false], // prefix must be lower case
    ["a/b/c", "x", false],
    ["hetzner.cloud/x", "y", false], // reserved prefix
    ["", "x", false],
    ["env", "-x", false],
    ["env", "a b", false],
    ["env", "a=b", false],
  ])("validates label keys and values: %j=%j → %s", (key, value, valid) => {
    expect(labelsSchema.safeParse({ [key]: value }).success).toBe(valid);
  });

  it("names the reserved prefix", () => {
    const result = labelKeySchema.safeParse("hetzner.cloud/x");
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(
      "the prefix 'hetzner.cloud/' is reserved by Hetzner",
    );
  });

  it("splits selectors at top-level commas only", () => {
    expect(splitSelector("a=b,c in (x,y),!d")).toEqual(["a=b", "c in (x,y)", "!d"]);
    expect(splitSelector(" a=b , , c ")).toEqual(["a=b", "c"]);
    expect(splitSelector("")).toEqual([]);
  });

  it("parses equality terms and trims whitespace", () => {
    expect(parseLabelTerms(" a = b , c=d ", "VAR")).toEqual({
      terms: [
        { key: "a", value: "b" },
        { key: "c", value: "d" },
      ],
      issues: [],
    });
  });

  it.each(["a", "a==b", "a=", "=b", "a!=b"])("rejects the term %j", (raw) => {
    const { terms, issues } = parseLabelTerms(raw, "VAR");
    expect(terms).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^VAR: /);
  });

  it("rejects repeated keys only when asked to", () => {
    expect(parseLabelTerms("a=b,a=c", "VAR").issues).toEqual([]);
    expect(parseLabelTerms("a=b,a=c", "VAR", true).issues).toEqual(["VAR: key 'a' appears twice"]);
  });

  it("matches all terms (AND) and the first matching term (OR)", () => {
    const terms = [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ];
    expect(matchesAll(terms, { a: "1", b: "2", c: "3" })).toBe(true);
    expect(matchesAll(terms, { a: "1" })).toBe(false);
    expect(matchesAll([], {})).toBe(true);
    expect(matchingTerm(terms, { b: "2" })).toEqual({ key: "b", value: "2" });
    expect(matchingTerm(terms, { a: "2" })).toBeUndefined();
    expect(matchingTerm([{ key: "toString", value: "x" }], {})).toBeUndefined();
  });

  it("formats terms", () => {
    expect(
      formatTerms([
        { key: "a", value: "b" },
        { key: "c", value: "d" },
      ]),
    ).toBe("a=b,c=d");
  });
});
