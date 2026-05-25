import { describe, expect, it } from "vitest";
import {
  SCALING_DECISIONS,
  SCALING_SIGNALS,
  ScalingEventSchema,
  ScalingPolicySchema,
  proposeScalingDecision,
  type ScalingEvent,
  type ScalingPolicy,
} from "./autoscaling.js";

describe("constants", () => {
  it("SCALING_SIGNALS has 7 entries", () => {
    expect(SCALING_SIGNALS).toHaveLength(7);
    expect(SCALING_SIGNALS).toContain("cpu_pct");
    expect(SCALING_SIGNALS).toContain("p99_latency_ms");
  });

  it("SCALING_DECISIONS has 4 entries", () => {
    expect(SCALING_DECISIONS).toContain("scale_up");
    expect(SCALING_DECISIONS).toContain("throttled");
  });
});

describe("ScalingPolicySchema", () => {
  const base: ScalingPolicy = {
    id: "policy-web-cpu",
    appId: "web",
    region: "eu-central",
    signal: "cpu_pct",
    scaleUpThreshold: 75,
    scaleDownThreshold: 40,
    scaleUpStep: 2,
    scaleDownStep: 1,
    cooldownSeconds: 60,
    minReplicas: 2,
    maxReplicas: 20,
    evaluationWindowSeconds: 60,
    enabled: true,
  };

  it("accepts a valid policy", () => {
    expect(() => ScalingPolicySchema.parse(base)).not.toThrow();
  });

  it("rejects minReplicas > maxReplicas", () => {
    expect(() => ScalingPolicySchema.parse({ ...base, minReplicas: 30 })).toThrow(
      /minReplicas cannot exceed maxReplicas/,
    );
  });

  it("rejects flapping thresholds (down >= up)", () => {
    expect(() => ScalingPolicySchema.parse({ ...base, scaleDownThreshold: 80 })).toThrow(
      /strictly less than scaleUpThreshold/,
    );
  });

  it("rejects percentage signals with threshold > 100", () => {
    expect(() => ScalingPolicySchema.parse({ ...base, scaleUpThreshold: 150 })).toThrow(/0\.\.100/);
  });

  it("accepts non-percentage signals with thresholds above 100", () => {
    expect(() =>
      ScalingPolicySchema.parse({
        ...base,
        signal: "rps",
        scaleUpThreshold: 1000,
        scaleDownThreshold: 200,
      }),
    ).not.toThrow();
  });
});

describe("ScalingEventSchema", () => {
  const base: ScalingEvent = {
    id: "event-1",
    policyId: "policy-1",
    appId: "web",
    region: "eu-central",
    signal: "cpu_pct",
    observedValue: 85,
    decision: "scale_up",
    reason: "threshold_exceeded",
    fromReplicas: 5,
    toReplicas: 7,
    occurredAt: "2026-05-14T10:00:00Z",
    completedAt: "2026-05-14T10:00:30Z",
    durationMs: 30_000,
  };

  it("accepts a valid scale_up event", () => {
    expect(() => ScalingEventSchema.parse(base)).not.toThrow();
  });

  it("rejects scale_up with toReplicas <= fromReplicas", () => {
    expect(() => ScalingEventSchema.parse({ ...base, toReplicas: 5 })).toThrow(
      /scale_up decision requires toReplicas > fromReplicas/,
    );
  });

  it("rejects scale_down with toReplicas >= fromReplicas", () => {
    expect(() =>
      ScalingEventSchema.parse({
        ...base,
        decision: "scale_down",
        reason: "threshold_recovered",
        fromReplicas: 5,
        toReplicas: 5,
      }),
    ).toThrow(/scale_down decision requires toReplicas < fromReplicas/);
  });

  it("rejects hold decision that changes replicas", () => {
    expect(() =>
      ScalingEventSchema.parse({
        ...base,
        decision: "hold",
        reason: "cooldown_active",
      }),
    ).toThrow(/hold decision must keep replicas unchanged/);
  });

  it("rejects scale_up with non-threshold reason", () => {
    expect(() => ScalingEventSchema.parse({ ...base, reason: "cooldown_active" })).toThrow(
      /threshold_exceeded or manual_override/,
    );
  });

  it("rejects completedAt without durationMs", () => {
    expect(() => ScalingEventSchema.parse({ ...base, durationMs: null })).toThrow(/durationMs/);
  });
});

describe("proposeScalingDecision", () => {
  const policy: ScalingPolicy = {
    id: "p",
    appId: "web",
    region: "eu-central",
    signal: "cpu_pct",
    scaleUpThreshold: 75,
    scaleDownThreshold: 40,
    scaleUpStep: 2,
    scaleDownStep: 1,
    cooldownSeconds: 60,
    minReplicas: 2,
    maxReplicas: 20,
    evaluationWindowSeconds: 60,
    enabled: true,
  };

  const now = new Date("2026-05-14T10:00:00Z");

  it("scales up when observed exceeds scaleUpThreshold", () => {
    const r = proposeScalingDecision(policy, {
      observedValue: 85,
      currentReplicas: 5,
      lastEventAt: null,
      now,
    });
    expect(r.decision).toBe("scale_up");
    expect(r.reason).toBe("threshold_exceeded");
    expect(r.toReplicas).toBe(7);
  });

  it("caps scale-up at maxReplicas", () => {
    const r = proposeScalingDecision(policy, {
      observedValue: 85,
      currentReplicas: 19,
      lastEventAt: null,
      now,
    });
    expect(r.toReplicas).toBe(20);
  });

  it("returns hold when at maxReplicas and would scale up", () => {
    const r = proposeScalingDecision(policy, {
      observedValue: 85,
      currentReplicas: 20,
      lastEventAt: null,
      now,
    });
    expect(r.decision).toBe("hold");
    expect(r.reason).toBe("max_replicas_reached");
  });

  it("scales down when observed below scaleDownThreshold", () => {
    const r = proposeScalingDecision(policy, {
      observedValue: 30,
      currentReplicas: 10,
      lastEventAt: null,
      now,
    });
    expect(r.decision).toBe("scale_down");
    expect(r.toReplicas).toBe(9);
  });

  it("floors scale-down at minReplicas", () => {
    const r = proposeScalingDecision(policy, {
      observedValue: 30,
      currentReplicas: 2,
      lastEventAt: null,
      now,
    });
    expect(r.decision).toBe("hold");
    expect(r.reason).toBe("min_replicas_reached");
  });

  it("returns throttled during cooldown", () => {
    const r = proposeScalingDecision(policy, {
      observedValue: 85,
      currentReplicas: 5,
      lastEventAt: new Date("2026-05-14T09:59:30Z"),
      now,
    });
    expect(r.decision).toBe("throttled");
    expect(r.reason).toBe("cooldown_active");
  });

  it("returns hold within dead zone", () => {
    const r = proposeScalingDecision(policy, {
      observedValue: 60,
      currentReplicas: 5,
      lastEventAt: null,
      now,
    });
    expect(r.decision).toBe("hold");
  });

  it("returns hold when policy is disabled", () => {
    const r = proposeScalingDecision(
      { ...policy, enabled: false },
      { observedValue: 100, currentReplicas: 5, lastEventAt: null, now },
    );
    expect(r.decision).toBe("hold");
  });
});
