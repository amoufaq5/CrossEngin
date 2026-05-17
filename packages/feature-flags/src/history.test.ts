import { describe, expect, it } from "vitest";
import {
  CHANGE_KINDS,
  FLAG_CHANGE_OUTCOMES,
  FlagChangeSchema,
  HIGH_RISK_CHANGE_KINDS,
  isHighRiskChange,
  summarizeChangeHistory,
  type FlagChange,
} from "./history.js";

const baseChange: FlagChange = {
  id: "fch_chg000001",
  tenantId: null,
  flagId: "ff_newcheck01",
  flagKey: "checkout.new_flow",
  kind: "flag_activated",
  occurredAt: "2026-05-16T10:00:00.000Z",
  actorUserId: "22222222-2222-2222-2222-222222222222",
  actorSystemId: null,
  coActorUserId: null,
  coActorAttestedAt: null,
  beforeValueJson: null,
  afterValueJson: null,
  changeReason: "Activation after staging soak.",
  relatedDeploymentId: null,
  relatedIncidentId: null,
  relatedTargetingRuleId: null,
  relatedKillSwitchId: null,
  outcome: "succeeded",
  requiredFourEyes: false,
  fourEyesAttested: false,
  blockedReason: null,
};

describe("constants", () => {
  it("has 23 change kinds", () => {
    expect(CHANGE_KINDS).toHaveLength(23);
  });
  it("has 4 outcomes", () => {
    expect(FLAG_CHANGE_OUTCOMES).toHaveLength(4);
  });
  it("HIGH_RISK includes default + killed + rollout + kill_trigger", () => {
    expect(HIGH_RISK_CHANGE_KINDS.has("default_value_changed")).toBe(true);
    expect(HIGH_RISK_CHANGE_KINDS.has("kill_switch_triggered")).toBe(true);
    expect(HIGH_RISK_CHANGE_KINDS.has("flag_activated")).toBe(false);
  });
});

describe("FlagChangeSchema", () => {
  it("accepts a flag_activated change", () => {
    expect(() => FlagChangeSchema.parse(baseChange)).not.toThrow();
  });

  it("rejects without actor user or system", () => {
    expect(() =>
      FlagChangeSchema.parse({ ...baseChange, actorUserId: null }),
    ).toThrow(/either actorUserId or actorSystemId/);
  });

  it("rejects requiredFourEyes succeeded without attestation", () => {
    expect(() =>
      FlagChangeSchema.parse({ ...baseChange, requiredFourEyes: true }),
    ).toThrow(/cannot succeed without fourEyesAttested/);
  });

  it("rejects four-eyes attested with co-actor same as actor", () => {
    expect(() =>
      FlagChangeSchema.parse({
        ...baseChange,
        requiredFourEyes: true,
        fourEyesAttested: true,
        coActorUserId: baseChange.actorUserId,
        coActorAttestedAt: "2026-05-16T10:00:01.000Z",
      }),
    ).toThrow(/co-actor must differ/);
  });

  it("rejects default_value_changed without before + after", () => {
    expect(() =>
      FlagChangeSchema.parse({
        ...baseChange,
        kind: "default_value_changed",
      }),
    ).toThrow(/requires both beforeValueJson and afterValueJson/);
  });

  it("rejects kill_switch_triggered without relatedKillSwitchId", () => {
    expect(() =>
      FlagChangeSchema.parse({
        ...baseChange,
        kind: "kill_switch_triggered",
      }),
    ).toThrow(/relatedKillSwitchId/);
  });

  it("rejects targeting_rule_added without relatedTargetingRuleId", () => {
    expect(() =>
      FlagChangeSchema.parse({
        ...baseChange,
        kind: "targeting_rule_added",
      }),
    ).toThrow(/relatedTargetingRuleId/);
  });

  it("rejects blocked_by_policy without blockedReason", () => {
    expect(() =>
      FlagChangeSchema.parse({
        ...baseChange,
        outcome: "blocked_by_policy",
      }),
    ).toThrow(/blockedReason/);
  });

  it("accepts default_value_changed with before + after", () => {
    expect(() =>
      FlagChangeSchema.parse({
        ...baseChange,
        kind: "default_value_changed",
        beforeValueJson: "false",
        afterValueJson: "true",
        requiredFourEyes: true,
        fourEyesAttested: true,
        coActorUserId: "33333333-3333-3333-3333-333333333333",
        coActorAttestedAt: "2026-05-16T10:00:01.000Z",
      }),
    ).not.toThrow();
  });

  it("rejects invalid beforeValueJson", () => {
    expect(() =>
      FlagChangeSchema.parse({
        ...baseChange,
        kind: "default_value_changed",
        beforeValueJson: "{not valid",
        afterValueJson: "true",
      }),
    ).toThrow(/must be valid JSON/);
  });
});

describe("summarizeChangeHistory", () => {
  it("returns zero metrics for empty input", () => {
    const s = summarizeChangeHistory([]);
    expect(s.totalChanges).toBe(0);
    expect(s.firstAt).toBeNull();
  });

  it("aggregates outcomes + risk + kinds + range", () => {
    const c1 = baseChange;
    const c2: FlagChange = {
      ...baseChange,
      id: "fch_chg000002",
      occurredAt: "2026-05-16T11:00:00.000Z",
      kind: "default_value_changed",
      beforeValueJson: "false",
      afterValueJson: "true",
      requiredFourEyes: true,
      fourEyesAttested: true,
      coActorUserId: "33333333-3333-3333-3333-333333333333",
      coActorAttestedAt: "2026-05-16T11:00:01.000Z",
    };
    const c3: FlagChange = {
      ...baseChange,
      id: "fch_chg000003",
      occurredAt: "2026-05-16T12:00:00.000Z",
      kind: "rollout_rolled_back",
      outcome: "rolled_back",
    };
    const c4: FlagChange = {
      ...baseChange,
      id: "fch_chg000004",
      occurredAt: "2026-05-16T13:00:00.000Z",
      kind: "flag_archived",
      outcome: "blocked_by_policy",
      blockedReason: "active rollout in progress",
    };
    const s = summarizeChangeHistory([c1, c2, c3, c4]);
    expect(s.totalChanges).toBe(4);
    expect(s.succeededCount).toBe(2);
    expect(s.rolledBackCount).toBe(1);
    expect(s.blockedCount).toBe(1);
    expect(s.highRiskChangeCount).toBe(2);
    expect(s.firstAt).toBe("2026-05-16T10:00:00.000Z");
    expect(s.lastAt).toBe("2026-05-16T13:00:00.000Z");
  });
});

describe("isHighRiskChange", () => {
  it("default_value_changed is high risk", () => {
    expect(isHighRiskChange("default_value_changed")).toBe(true);
  });
  it("owner_transferred is not high risk", () => {
    expect(isHighRiskChange("owner_transferred")).toBe(false);
  });
});
