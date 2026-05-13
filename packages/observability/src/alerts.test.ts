import { describe, expect, it } from "vitest";
import {
  AlertConditionSchema,
  AlertPolicySchema,
  AlertRuleSchema,
  resolveRoute,
  SEVERITIES,
  SEVERITY_DESCRIPTIONS,
} from "./alerts.js";

describe("Severity", () => {
  it("declares P0-P3 in order", () => {
    expect(SEVERITIES).toEqual(["P0", "P1", "P2", "P3"]);
  });

  it("has a description for every tier", () => {
    for (const sev of SEVERITIES) {
      expect(SEVERITY_DESCRIPTIONS[sev]).toBeTruthy();
    }
  });
});

describe("AlertConditionSchema", () => {
  it("parses error_rate", () => {
    const c = AlertConditionSchema.parse({
      kind: "error_rate",
      surface: "kernel-api",
      comparison: "gt",
      thresholdPercent: 5,
      overWindow: "5m",
    });
    expect(c.kind).toBe("error_rate");
  });

  it("parses latency_breach", () => {
    const c = AlertConditionSchema.parse({
      kind: "latency_breach",
      sloId: "kernel-api",
      percentile: "p95",
      multiplier: 2,
      sustainedFor: "15m",
    });
    expect(c.kind).toBe("latency_breach");
  });

  it("parses cross_tenant_query_attempt with defaults", () => {
    const c = AlertConditionSchema.parse({ kind: "cross_tenant_query_attempt" });
    expect(c.kind).toBe("cross_tenant_query_attempt");
    if (c.kind === "cross_tenant_query_attempt") {
      expect(c.minCount).toBe(1);
      expect(c.overWindow).toBe("1m");
    }
  });

  it("parses ai_cost_spike", () => {
    const c = AlertConditionSchema.parse({
      kind: "ai_cost_spike",
      multiplierOfRolling: 10,
      rollingWindow: "week",
    });
    expect(c.kind).toBe("ai_cost_spike");
  });

  it("parses synthetic_check_failure", () => {
    const c = AlertConditionSchema.parse({
      kind: "synthetic_check_failure",
      checkId: "ai-architect-smoke",
      consecutiveFailures: 3,
    });
    expect(c.kind).toBe("synthetic_check_failure");
  });

  it("rejects an unknown condition kind", () => {
    expect(() => AlertConditionSchema.parse({ kind: "nope" })).toThrow();
  });
});

describe("AlertPolicySchema", () => {
  it("parses a multi-route policy", () => {
    const p = AlertPolicySchema.parse({
      id: "default",
      routes: [
        {
          severity: "P0",
          channels: [{ kind: "pagerduty_phone", serviceKey: "abc" }],
        },
        {
          severity: "P2",
          channels: [{ kind: "slack", channel: "#alerts" }],
        },
      ],
    });
    expect(p.routes).toHaveLength(2);
  });

  it("rejects duplicate severity routes", () => {
    expect(() =>
      AlertPolicySchema.parse({
        id: "x",
        routes: [
          {
            severity: "P1",
            channels: [{ kind: "slack", channel: "#alerts" }],
          },
          {
            severity: "P1",
            channels: [{ kind: "email_digest", recipients: ["x@y.com"], cadence: "hourly" }],
          },
        ],
      }),
    ).toThrow(/duplicate route/);
  });

  it("rejects a route with zero channels", () => {
    expect(() =>
      AlertPolicySchema.parse({
        id: "x",
        routes: [{ severity: "P3", channels: [] }],
      }),
    ).toThrow();
  });
});

describe("AlertRuleSchema", () => {
  it("defaults enabled to true", () => {
    const r = AlertRuleSchema.parse({
      id: "kernel-error-rate",
      condition: {
        kind: "error_rate",
        surface: "kernel-api",
        comparison: "gt",
        thresholdPercent: 5,
        overWindow: "5m",
      },
      severity: "P2",
      policyId: "default",
    });
    expect(r.enabled).toBe(true);
  });
});

describe("resolveRoute", () => {
  const policy = AlertPolicySchema.parse({
    id: "default",
    routes: [
      {
        severity: "P0",
        channels: [{ kind: "pagerduty_phone", serviceKey: "abc" }],
      },
      {
        severity: "P2",
        channels: [{ kind: "slack", channel: "#alerts" }],
      },
    ],
  });

  it("returns the matching route", () => {
    const r = resolveRoute(policy, "P0");
    expect(r?.channels[0]?.kind).toBe("pagerduty_phone");
  });

  it("returns null for a severity with no route", () => {
    expect(resolveRoute(policy, "P3")).toBeNull();
  });
});
