import { describe, expect, it } from "vitest";
import {
  ROUTING_DECISIONS,
  ROUTING_STRATEGIES,
  RoutingRuleSchema,
  RoutingTableSchema,
  pickRegion,
  rulesForCountry,
  type RoutingRule,
} from "./routing.js";

describe("constants", () => {
  it("ROUTING_STRATEGIES has 5 entries", () => {
    expect(ROUTING_STRATEGIES).toEqual([
      "geo_dns",
      "anycast",
      "latency_based",
      "region_pinned",
      "weighted",
    ]);
  });

  it("ROUTING_DECISIONS has 4 entries", () => {
    expect(ROUTING_DECISIONS).toContain("primary");
    expect(ROUTING_DECISIONS).toContain("blackhole");
  });
});

describe("RoutingRuleSchema", () => {
  const base: RoutingRule = {
    id: "eu-default",
    strategy: "geo_dns",
    priority: 10,
    sourceCountries: ["DE", "FR"],
    sourceCidrs: [],
    primaryRegions: ["eu-central"],
    failoverRegions: ["eu-west"],
    weights: [],
    decision: "primary",
  };

  it("accepts a valid geo_dns rule", () => {
    expect(() => RoutingRuleSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate primary regions", () => {
    expect(() =>
      RoutingRuleSchema.parse({
        ...base,
        primaryRegions: ["eu-central", "eu-central"],
      }),
    ).toThrow(/duplicate primary region/);
  });

  it("rejects region that appears in both primary and failover", () => {
    expect(() =>
      RoutingRuleSchema.parse({
        ...base,
        failoverRegions: ["eu-central"],
      }),
    ).toThrow(/both primaryRegions and failoverRegions/);
  });

  it("requires geo_dns to declare source countries", () => {
    expect(() =>
      RoutingRuleSchema.parse({ ...base, sourceCountries: [] }),
    ).toThrow(/source country/);
  });

  it("requires weighted strategy to declare weights summing to 100", () => {
    expect(() =>
      RoutingRuleSchema.parse({
        ...base,
        strategy: "weighted",
        sourceCountries: [],
        weights: [
          { region: "eu-central", weight: 60 },
          { region: "us-east", weight: 30 },
        ],
      }),
    ).toThrow(/summing to 100/);
  });

  it("accepts weighted strategy with weights summing to 100", () => {
    expect(() =>
      RoutingRuleSchema.parse({
        ...base,
        strategy: "weighted",
        sourceCountries: [],
        weights: [
          { region: "eu-central", weight: 60 },
          { region: "us-east", weight: 40 },
        ],
        primaryRegions: ["eu-central", "us-east"],
      }),
    ).not.toThrow();
  });

  it("rejects region_pinned with more than one primary region", () => {
    expect(() =>
      RoutingRuleSchema.parse({
        ...base,
        strategy: "region_pinned",
        sourceCountries: [],
        primaryRegions: ["eu-central", "eu-west"],
        failoverRegions: [],
      }),
    ).toThrow(/exactly one primary region/);
  });

  it("rejects blackhole decision with failover regions", () => {
    expect(() =>
      RoutingRuleSchema.parse({ ...base, decision: "blackhole" }),
    ).toThrow(/blackhole decision/);
  });

  it("rejects invalid country code", () => {
    expect(() =>
      RoutingRuleSchema.parse({ ...base, sourceCountries: ["DEU"] }),
    ).toThrow();
  });
});

describe("RoutingTableSchema", () => {
  const rule = (id: string, priority: number, countries: string[]): RoutingRule => ({
    id,
    strategy: "geo_dns",
    priority,
    sourceCountries: countries,
    sourceCidrs: [],
    primaryRegions: ["eu-central"],
    failoverRegions: [],
    weights: [],
    decision: "primary",
  });

  it("accepts non-overlapping rules", () => {
    expect(() =>
      RoutingTableSchema.parse([rule("r1", 10, ["DE"]), rule("r2", 10, ["US"])]),
    ).not.toThrow();
  });

  it("rejects duplicate rule ids", () => {
    expect(() =>
      RoutingTableSchema.parse([rule("r1", 10, ["DE"]), rule("r1", 20, ["FR"])]),
    ).toThrow(/duplicate routing rule id/);
  });

  it("rejects two rules matching the same country at the same priority", () => {
    expect(() =>
      RoutingTableSchema.parse([
        rule("r1", 10, ["DE"]),
        rule("r2", 10, ["DE"]),
      ]),
    ).toThrow(/same priority/);
  });

  it("allows the same country at different priorities (failover)", () => {
    expect(() =>
      RoutingTableSchema.parse([
        rule("r1", 10, ["DE"]),
        rule("r2", 20, ["DE"]),
      ]),
    ).not.toThrow();
  });
});

describe("helpers", () => {
  const table = [
    {
      id: "eu",
      strategy: "geo_dns" as const,
      priority: 10,
      sourceCountries: ["DE", "FR"],
      sourceCidrs: [],
      primaryRegions: ["eu-central" as const],
      failoverRegions: [],
      weights: [],
      decision: "primary" as const,
    },
    {
      id: "default",
      strategy: "latency_based" as const,
      priority: 100,
      sourceCountries: [],
      sourceCidrs: [],
      primaryRegions: ["us-east" as const],
      failoverRegions: [],
      weights: [],
      decision: "primary" as const,
    },
  ];

  it("rulesForCountry returns matching rules sorted by priority", () => {
    expect(rulesForCountry(table, "DE").map((r) => r.id)).toEqual(["eu", "default"]);
  });

  it("rulesForCountry returns only the catch-all for unmatched country", () => {
    expect(rulesForCountry(table, "JP").map((r) => r.id)).toEqual(["default"]);
  });

  it("pickRegion returns the first primary for non-weighted strategies", () => {
    expect(pickRegion(table[0]!)).toBe("eu-central");
  });

  it("pickRegion returns null for blackhole decision", () => {
    expect(
      pickRegion({
        ...table[0]!,
        decision: "blackhole",
      }),
    ).toBeNull();
  });

  it("pickRegion respects weights", () => {
    const rule: RoutingRule = {
      id: "split",
      strategy: "weighted",
      priority: 10,
      sourceCountries: [],
      sourceCidrs: [],
      primaryRegions: ["eu-central", "us-east"],
      failoverRegions: [],
      weights: [
        { region: "eu-central", weight: 60 },
        { region: "us-east", weight: 40 },
      ],
      decision: "primary",
    };
    expect(pickRegion(rule, 0.0)).toBe("eu-central");
    expect(pickRegion(rule, 0.59)).toBe("eu-central");
    expect(pickRegion(rule, 0.7)).toBe("us-east");
  });
});
