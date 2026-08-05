import { describe, expect, it } from "vitest";
// The permissions predicate exists in two bundles that can't import each other:
// the TS web app (src/lib/cli-config.ts) validates and stores the value, and the
// standalone .mjs runner (bin/lib/policy.mjs) decides from it whether to hand a
// CLI its permission-bypass flag. resolveRunConfig in bin/lib/providers.mjs
// applies the same rule inline a third time, on the claim payload, because
// policy.mjs already imports from providers.mjs and importing back would cycle.
//
// This test is the enforcement behind those duplications — the same role
// runtime-parity.test.ts plays for the runtime maps. Drift here is fail-safe by
// construction (any divergence collapses toward "enforced", never toward a
// bypass), but a copy that stopped recognizing "unrestricted" would silently
// ignore an operator's deliberate opt-out, so lock the three together.
import { normalizePermissions as runnerNormalize } from "../../bin/lib/policy.mjs";
import { resolveRunConfig } from "../../bin/lib/providers.mjs";
import { AGENT_PERMISSIONS, normalizePermissions as webNormalize } from "../lib/cli-config";

/** The claim-payload path, isolated to just its permissions decision. */
function payloadNormalize(value: unknown) {
  return resolveRunConfig({ agent: { cli: "claude", permissions: value }, job: {} }).permissions;
}

// Every input worth pinning: the two legal values, near-misses that must NOT be
// read as an opt-out, and the wrong-type cases an older server or a hand-edited
// DB can produce.
const CASES: unknown[] = [
  "enforced",
  "unrestricted",
  "Unrestricted",
  "UNRESTRICTED",
  " unrestricted",
  "unrestricted ",
  "unrestricted\n",
  "yolo",
  "",
  null,
  undefined,
  0,
  1,
  true,
  false,
  {},
  [],
  ["unrestricted"],
];

describe("permissions parity (cli-config.ts ↔ policy.mjs ↔ providers.mjs)", () => {
  it("all three implementations agree on every input", () => {
    for (const value of CASES) {
      const web = webNormalize(value);
      expect(runnerNormalize(value), `policy.mjs disagrees on ${JSON.stringify(value)}`).toBe(web);
      expect(
        payloadNormalize(value),
        `resolveRunConfig disagrees on ${JSON.stringify(value)}`,
      ).toBe(web);
    }
  });

  it("exactly one input yields unrestricted — the exact lowercase string", () => {
    const optOuts = CASES.filter((v) => webNormalize(v) === "unrestricted");
    expect(optOuts).toEqual(["unrestricted"]);
  });

  it("every other input fails closed to enforced", () => {
    for (const value of CASES) {
      if (value === "unrestricted") continue;
      expect(webNormalize(value), JSON.stringify(value)).toBe("enforced");
    }
  });

  it("normalization only ever returns a value the API would accept", () => {
    for (const value of CASES) {
      expect(AGENT_PERMISSIONS).toContain(webNormalize(value));
    }
  });

  it("the case battery is not vacuous — it exercises both outcomes", () => {
    const results = new Set(CASES.map(webNormalize));
    expect([...results].sort()).toEqual(["enforced", "unrestricted"]);
  });
});
