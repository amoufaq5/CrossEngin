import { describe, expect, it } from "vitest";
import {
  FLAG_KINDS,
  FLAG_RISK_LEVELS,
  FLAG_STATUSES,
  FLAG_STATUS_TRANSITIONS,
  FlagDefinitionSchema,
  HIGH_RISK_FLAG_KINDS,
  canTransitionFlag,
  isFlagActive,
  isFlagInEnvironment,
  isHighRiskFlag,
  parseDefaultValue,
  parseKilledValue,
  type FlagDefinition,
} from "./flags.js";

const baseFlag: FlagDefinition = {
  id: "ff_newcheck01",
  tenantId: null,
  key: "checkout.new_flow",
  kind: "boolean",
  label: "New checkout flow",
  description: "Routes checkout traffic through the new flow handler.",
  status: "active",
  defaultValueJson: "false",
  killedValueJson: null,
  variants: [],
  environments: ["staging", "production"],
  riskLevel: "medium",
  ownerUserId: "22222222-2222-2222-2222-222222222222",
  ownerTeam: "checkout",
  tags: ["checkout", "rollout"],
  relatedDeploymentId: null,
  relatedIncidentId: null,
  targetingRuleIds: [],
  requiresFourEyesToToggle: false,
  requiresIncidentToKill: false,
  expiresAt: null,
  createdAt: "2026-05-15T10:00:00.000Z",
  createdBy: "22222222-2222-2222-2222-222222222222",
  updatedAt: "2026-05-15T10:00:00.000Z",
  archivedAt: null,
  archivedBy: null,
  archivedReason: null,
};

describe("constants", () => {
  it("has 7 flag kinds", () => {
    expect(FLAG_KINDS).toHaveLength(7);
  });
  it("has 4 flag statuses", () => {
    expect(FLAG_STATUSES).toHaveLength(4);
  });
  it("has 4 risk levels", () => {
    expect(FLAG_RISK_LEVELS).toHaveLength(4);
  });
  it("HIGH_RISK_FLAG_KINDS includes kill_switch", () => {
    expect(HIGH_RISK_FLAG_KINDS.has("kill_switch")).toBe(true);
  });
});

describe("canTransitionFlag", () => {
  it("allows draft → active", () => {
    expect(canTransitionFlag("draft", "active")).toBe(true);
  });
  it("blocks archived → active", () => {
    expect(canTransitionFlag("archived", "active")).toBe(false);
  });
  it("archived is terminal", () => {
    expect(FLAG_STATUS_TRANSITIONS.archived).toEqual([]);
  });
});

describe("FlagDefinitionSchema", () => {
  it("accepts a valid boolean flag", () => {
    expect(() => FlagDefinitionSchema.parse(baseFlag)).not.toThrow();
  });

  it("rejects multivariate with < 2 variants", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        kind: "multivariate",
        variants: [
          {
            key: "control",
            label: "Control",
            value: "a",
            weight: 10_000,
          },
        ],
      }),
    ).toThrow(/at least 2 variants/);
  });

  it("rejects multivariate weights not summing to 10000", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        kind: "multivariate",
        variants: [
          { key: "a", label: "A", value: "a", weight: 5000 },
          { key: "b", label: "B", value: "b", weight: 4000 },
        ],
      }),
    ).toThrow(/must sum to 10000/);
  });

  it("rejects duplicate variant keys", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        kind: "multivariate",
        variants: [
          { key: "a", label: "A", value: "a", weight: 5000 },
          { key: "a", label: "B", value: "b", weight: 5000 },
        ],
      }),
    ).toThrow(/duplicate variant key/);
  });

  it("rejects kill_switch without killedValueJson", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        kind: "kill_switch",
        requiresFourEyesToToggle: true,
        riskLevel: "high",
      }),
    ).toThrow(/killedValueJson/);
  });

  it("rejects kill_switch without four-eyes requirement", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        kind: "kill_switch",
        killedValueJson: "false",
        riskLevel: "high",
      }),
    ).toThrow(/four-eyes/);
  });

  it("rejects kill_switch with low risk level", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        kind: "kill_switch",
        killedValueJson: "false",
        requiresFourEyesToToggle: true,
        riskLevel: "low",
      }),
    ).toThrow(/high or critical risk/);
  });

  it("rejects boolean flag declaring variants", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        variants: [{ key: "x", label: "x", value: true, weight: 10_000 }],
      }),
    ).toThrow(/cannot declare variants/);
  });

  it("rejects archived without archivedReason", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        status: "archived",
        archivedAt: "2026-06-01T00:00:00.000Z",
        archivedBy: "33333333-3333-3333-3333-333333333333",
      }),
    ).toThrow(/archived flag requires/);
  });

  it("rejects invalid JSON defaultValueJson", () => {
    expect(() =>
      FlagDefinitionSchema.parse({
        ...baseFlag,
        defaultValueJson: "{not valid json",
      }),
    ).toThrow(/must be valid JSON/);
  });
});

describe("isFlagActive / isFlagInEnvironment / isHighRiskFlag", () => {
  const now = new Date("2026-05-16T10:00:00Z");

  it("isFlagActive true for active not expired", () => {
    expect(isFlagActive(baseFlag, now)).toBe(true);
  });

  it("isFlagActive false past expiresAt", () => {
    expect(isFlagActive({ ...baseFlag, expiresAt: "2026-05-15T00:00:00.000Z" }, now)).toBe(false);
  });

  it("isFlagInEnvironment matches declared", () => {
    expect(isFlagInEnvironment(baseFlag, "production")).toBe(true);
    expect(isFlagInEnvironment(baseFlag, "preview")).toBe(false);
  });

  it("isHighRiskFlag true for critical risk", () => {
    expect(isHighRiskFlag({ ...baseFlag, riskLevel: "critical" })).toBe(true);
  });

  it("isHighRiskFlag false for low risk boolean", () => {
    expect(isHighRiskFlag({ ...baseFlag, riskLevel: "low" })).toBe(false);
  });
});

describe("parseDefaultValue / parseKilledValue", () => {
  it("parses boolean default", () => {
    expect(parseDefaultValue(baseFlag)).toBe(false);
  });
  it("returns null for unset killed value", () => {
    expect(parseKilledValue(baseFlag)).toBeNull();
  });
});
