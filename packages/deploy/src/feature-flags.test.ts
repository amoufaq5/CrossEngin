import { describe, expect, it } from "vitest";
import {
  FLAG_KINDS,
  FeatureFlagSchema,
  FlagAuditRecordSchema,
  FlagRuleSchema,
  FlagVariantSchema,
  TARGETING_OPERATORS,
  TargetingRuleSchema,
  evaluateFlag,
  type EvaluationContext,
  type FeatureFlag,
} from "./feature-flags.js";

describe("constants", () => {
  it("FLAG_KINDS = boolean|string|number|json", () => {
    expect(FLAG_KINDS).toEqual(["boolean", "string", "number", "json"]);
  });

  it("TARGETING_OPERATORS = 5 operators", () => {
    expect(TARGETING_OPERATORS).toEqual(["eq", "neq", "in", "nin", "matches"]);
  });
});

describe("TargetingRuleSchema", () => {
  it("accepts eq with one value", () => {
    expect(() =>
      TargetingRuleSchema.parse({
        attribute: "tenant_id",
        operator: "eq",
        values: ["t1"],
      }),
    ).not.toThrow();
  });

  it("rejects eq with multiple values", () => {
    expect(() =>
      TargetingRuleSchema.parse({
        attribute: "tenant_id",
        operator: "eq",
        values: ["t1", "t2"],
      }),
    ).toThrow(/exactly one value/);
  });

  it("rejects matches with an invalid regex", () => {
    expect(() =>
      TargetingRuleSchema.parse({
        attribute: "role",
        operator: "matches",
        values: ["[unclosed"],
      }),
    ).toThrow(/valid JavaScript regex/);
  });

  it("accepts matches with a valid regex", () => {
    expect(() =>
      TargetingRuleSchema.parse({
        attribute: "role",
        operator: "matches",
        values: ["^admin.*$"],
      }),
    ).not.toThrow();
  });
});

describe("FlagVariantSchema / FlagRuleSchema", () => {
  it("accepts a variant with default rolloutPercent=100", () => {
    const v = FlagVariantSchema.parse({ key: "treatment", value: true });
    expect(v.rolloutPercent).toBe(100);
  });

  it("rejects a rule whose variants sum > 100", () => {
    expect(() =>
      FlagRuleSchema.parse({
        id: "rule-a",
        when: [],
        serve: [
          { key: "a", value: true, rolloutPercent: 80 },
          { key: "b", value: false, rolloutPercent: 30 },
        ],
      }),
    ).toThrow(/sums to 110/);
  });
});

describe("FeatureFlagSchema", () => {
  const base: FeatureFlag = {
    key: "feature.x",
    kind: "boolean",
    description: "Enable feature X",
    defaultValue: false,
    environments: ["preview", "staging", "production"],
    rules: [],
    enabled: true,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("accepts a valid boolean flag", () => {
    expect(() => FeatureFlagSchema.parse(base)).not.toThrow();
  });

  it("rejects a boolean flag with string defaultValue", () => {
    expect(() =>
      FeatureFlagSchema.parse({ ...base, defaultValue: "true" }),
    ).toThrow(/boolean defaultValue/);
  });

  it("rejects an archived flag that's still enabled", () => {
    expect(() =>
      FeatureFlagSchema.parse({
        ...base,
        archivedAt: "2026-01-02T00:00:00Z",
        enabled: true,
      }),
    ).toThrow(/archived flags must be enabled=false/);
  });

  it("rejects a malformed flag key", () => {
    expect(() => FeatureFlagSchema.parse({ ...base, key: "Feature.X" })).toThrow();
  });
});

describe("evaluateFlag", () => {
  const base: FeatureFlag = {
    key: "feature.x",
    kind: "boolean",
    description: "Enable feature X",
    defaultValue: false,
    environments: ["preview", "staging", "production"],
    rules: [],
    enabled: true,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const ctx: EvaluationContext = {
    tenantId: "t1",
    userId: "u1",
    environment: "production",
  };

  it("returns the default value when no rules match", () => {
    const r = evaluateFlag(base, ctx);
    expect(r.value).toBe(false);
    expect(r.reason).toBe("default");
  });

  it("returns 'archived' reason for archived flags", () => {
    const archived: FeatureFlag = { ...base, archivedAt: "2026-01-02T00:00:00Z", enabled: false };
    const r = evaluateFlag(archived, ctx);
    expect(r.reason).toBe("archived");
  });

  it("returns 'disabled' reason for disabled flags", () => {
    const r = evaluateFlag({ ...base, enabled: false }, ctx);
    expect(r.reason).toBe("disabled");
  });

  it("returns 'out_of_environment' for unsupported env", () => {
    const r = evaluateFlag({ ...base, environments: ["preview"] }, ctx);
    expect(r.reason).toBe("out_of_environment");
  });

  it("returns the matched rule's variant when a rule matches", () => {
    const flag: FeatureFlag = {
      ...base,
      rules: [
        {
          id: "rule-a",
          when: [{ attribute: "tenant_id", operator: "eq", values: ["t1"] }],
          serve: [{ key: "treatment", value: true, rolloutPercent: 100 }],
        },
      ],
    };
    const r = evaluateFlag(flag, ctx);
    expect(r.value).toBe(true);
    expect(r.reason).toBe("matched_rule");
    expect(r.variantKey).toBe("treatment");
    expect(r.ruleId).toBe("rule-a");
  });

  it("returns 'default' when no rule's when matches", () => {
    const flag: FeatureFlag = {
      ...base,
      rules: [
        {
          id: "rule-b",
          when: [{ attribute: "tenant_id", operator: "eq", values: ["t999"] }],
          serve: [{ key: "treatment", value: true, rolloutPercent: 100 }],
        },
      ],
    };
    const r = evaluateFlag(flag, ctx);
    expect(r.reason).toBe("default");
  });

  it("picks a consistent variant for the same (tenant, user, flag) seed", () => {
    const flag: FeatureFlag = {
      ...base,
      rules: [
        {
          id: "rule-c",
          when: [],
          serve: [
            { key: "a", value: true, rolloutPercent: 50 },
            { key: "b", value: false, rolloutPercent: 50 },
          ],
        },
      ],
    };
    const r1 = evaluateFlag(flag, ctx);
    const r2 = evaluateFlag(flag, ctx);
    expect(r1.variantKey).toBe(r2.variantKey);
  });
});

describe("FlagAuditRecordSchema", () => {
  it("accepts a valid record", () => {
    expect(() =>
      FlagAuditRecordSchema.parse({
        flagKey: "feature.x",
        changedAt: "2026-05-14T10:00:00Z",
        changedBy: "u1",
        before: false,
        after: true,
        reason: "manual override",
      }),
    ).not.toThrow();
  });

  it("rejects an invalid flagKey", () => {
    expect(() =>
      FlagAuditRecordSchema.parse({
        flagKey: "Feature.X",
        changedAt: "2026-05-14T10:00:00Z",
        changedBy: "u1",
        before: false,
        after: true,
      }),
    ).toThrow();
  });
});
