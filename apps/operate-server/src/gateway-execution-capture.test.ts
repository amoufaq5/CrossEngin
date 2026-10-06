import type { PipelineExecution } from "@crossengin/api-gateway";
import { describe, expect, it, vi } from "vitest";

import { sampleValue, shouldRecordAudit } from "./audit-chain.js";
import {
  ESTIMATED_EXECUTION_ROW_BYTES,
  GatewayExecutionCaptureObserver,
  describeCaptureCost,
  parseGatewayExecutionCaptureConfig,
  shouldCaptureExecution,
} from "./gateway-execution-capture.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function execution(overrides: Partial<PipelineExecution> = {}): PipelineExecution {
  return {
    requestId: "req_test00000001",
    tenantId: TENANT,
    startedAt: "2026-05-16T12:00:00.000Z",
    completedAt: "2026-05-16T12:00:00.025Z",
    totalDurationMs: 25,
    finalStage: "emit_audit",
    finalOutcome: "pass",
    finalResponseStatus: 200,
    stages: [
      {
        stage: "receive",
        outcome: "pass",
        startedAt: "2026-05-16T12:00:00.000Z",
        completedAt: "2026-05-16T12:00:00.001Z",
        durationMs: 1,
        reason: "ok",
        appliedHeaders: {},
        problemTypeUri: null,
        responseStatus: null,
      },
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: null,
    routeOperationId: "invoice.create",
    resolvedApiVersion: "v1",
    correlationId: null,
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 200,
    ...overrides,
  };
}

/** A request id whose deterministic sample position is known to be below / above a threshold. */
function idBelow(rate: number): string {
  for (let i = 0; i < 5_000; i++) {
    const id = `req_probe${i.toString().padStart(8, "0")}`;
    if (sampleValue(id) < rate) return id;
  }
  throw new Error(`no probe id sampled below ${rate.toString()}`);
}
function idAbove(rate: number): string {
  for (let i = 0; i < 5_000; i++) {
    const id = `req_probe${i.toString().padStart(8, "0")}`;
    if (sampleValue(id) >= rate) return id;
  }
  throw new Error(`no probe id sampled at or above ${rate.toString()}`);
}

describe("GatewayExecutionCaptureConfigSchema", () => {
  it("accepts a rate in (0, 1]", () => {
    expect(parseGatewayExecutionCaptureConfig({ sampleRate: 0.01 }).sampleRate).toBe(0.01);
    expect(parseGatewayExecutionCaptureConfig({ sampleRate: 1 }).sampleRate).toBe(1);
  });

  it("has no default rate: a write volume must not be chosen by silence", () => {
    expect(() => parseGatewayExecutionCaptureConfig({})).toThrow();
  });

  it("refuses 0 rather than treating it as off, which omitting the flag already means", () => {
    expect(() => parseGatewayExecutionCaptureConfig({ sampleRate: 0 })).toThrow();
  });

  it("refuses a rate above 1", () => {
    expect(() => parseGatewayExecutionCaptureConfig({ sampleRate: 1.5 })).toThrow();
  });

  it("refuses an empty operations allowlist, which would capture nothing", () => {
    expect(() => parseGatewayExecutionCaptureConfig({ sampleRate: 1, operations: [] })).toThrow();
  });

  it("rejects an unknown key", () => {
    expect(() =>
      parseGatewayExecutionCaptureConfig({ sampleRate: 1, outcomes: ["deny"] }),
    ).toThrow();
  });
});

describe("shouldCaptureExecution", () => {
  it("captures everything at rate 1", () => {
    expect(shouldCaptureExecution(execution(), { sampleRate: 1 })).toBe(true);
  });

  it("keeps a request whose deterministic sample falls under the rate", () => {
    const id = idBelow(0.5);
    expect(shouldCaptureExecution(execution({ requestId: id }), { sampleRate: 0.5 })).toBe(true);
  });

  it("drops a request whose deterministic sample is at or above the rate", () => {
    const id = idAbove(0.5);
    expect(shouldCaptureExecution(execution({ requestId: id }), { sampleRate: 0.5 })).toBe(false);
  });

  it("is deterministic: the same request id always decides the same way", () => {
    const e = execution({ requestId: idBelow(0.3) });
    const first = shouldCaptureExecution(e, { sampleRate: 0.3 });
    for (let i = 0; i < 20; i++) {
      expect(shouldCaptureExecution(e, { sampleRate: 0.3 })).toBe(first);
    }
  });

  it("honours an operations allowlist", () => {
    const cfg = { sampleRate: 1, operations: ["tenants.delete"] };
    expect(shouldCaptureExecution(execution({ routeOperationId: "tenants.delete" }), cfg)).toBe(true);
    expect(shouldCaptureExecution(execution({ routeOperationId: "invoice.create" }), cfg)).toBe(false);
  });

  it("excludes an unmatched request when an allowlist is set", () => {
    expect(
      shouldCaptureExecution(execution({ routeOperationId: null }), {
        sampleRate: 1,
        operations: ["tenants.delete"],
      }),
    ).toBe(false);
  });

  it("keeps an unmatched request when no allowlist is set", () => {
    expect(shouldCaptureExecution(execution({ routeOperationId: null }), { sampleRate: 1 })).toBe(
      true,
    );
  });

  /**
   * The nesting property, which is why `sampleValue` is imported rather than re-derived: at an equal
   * rate the capture and the audit chain keep the *same* requests, so a captured execution always
   * has a chain entry to sit beside.
   */
  it("samples the same requests as the audit chain at an equal rate", () => {
    const rate = 0.25;
    let agreed = 0;
    for (let i = 0; i < 200; i++) {
      const e = execution({ requestId: `req_nest${i.toString().padStart(8, "0")}` });
      const captured = shouldCaptureExecution(e, { sampleRate: rate });
      const audited = shouldRecordAudit(e, { sampleRate: rate });
      expect(captured).toBe(audited);
      if (captured) agreed += 1;
    }
    // Vacuity floor: an agreement that kept nothing would pass the assertion above trivially.
    expect(agreed).toBeGreaterThan(10);
  });

  /** And a lower capture rate is a strict subset, never a disjoint second sample. */
  it("is a subset of the chain's sample at a lower rate", () => {
    for (let i = 0; i < 200; i++) {
      const e = execution({ requestId: `req_sub${i.toString().padStart(9, "0")}` });
      if (shouldCaptureExecution(e, { sampleRate: 0.05 })) {
        expect(shouldRecordAudit(e, { sampleRate: 0.5 })).toBe(true);
      }
    }
  });
});

describe("describeCaptureCost", () => {
  it("names the per-row cost and both reference projections", () => {
    const line = describeCaptureCost({ sampleRate: 1 });
    expect(line).toContain(String(ESTIMATED_EXECUTION_ROW_BYTES));
    expect(line).toContain("100 req/s");
    expect(line).toContain("1,000 req/s");
  });

  it("projects the unsampled 1,000 req/s figure in tens of TB/year", () => {
    expect(describeCaptureCost({ sampleRate: 1 })).toContain("66.2 TB/yr");
  });

  it("scales linearly with the rate", () => {
    expect(describeCaptureCost({ sampleRate: 0.01 })).toContain("662.3 GB/yr");
  });

  it("says how many operations are captured when an allowlist is set", () => {
    expect(describeCaptureCost({ sampleRate: 1, operations: ["a", "b"] })).toContain(
      "2 operation(s)",
    );
  });

  it("says all operations when none is set", () => {
    expect(describeCaptureCost({ sampleRate: 1 })).toContain("all operations");
  });

  it("renders a full sample as 100%, not 1%", () => {
    // Found on the first live boot, and the reason the whole describe block above could not see it:
    // every assertion was about the byte figures or the operation count, and none about the
    // percentage. `(1 * 100).toPrecision(3)` is the integer "100" with no decimal point, so a
    // trailing-zero strip of `/\.?0+$/` left "1" — a 100% capture announcing itself as 1% beside a
    // byte figure that was right, in the one line whose job is to make the cost visible before an
    // operator accepts it.
    expect(describeCaptureCost({ sampleRate: 1 })).toContain("capturing 100% of executions");
  });

  it("renders every rate's percentage exactly, integral and fractional", () => {
    const pct = (sampleRate: number): string =>
      /capturing (\S+) of executions/.exec(describeCaptureCost({ sampleRate }))?.[1] ?? "";
    expect(pct(1)).toBe("100%");
    expect(pct(0.5)).toBe("50%");
    expect(pct(0.1)).toBe("10%");
    expect(pct(0.01)).toBe("1%");
    expect(pct(0.025)).toBe("2.5%");
    expect(pct(0.001)).toBe("0.1%");
    expect(pct(0.0001)).toBe("0.01%");
    // Three significant figures, so an awkward rate is rounded rather than printed in full.
    expect(pct(0.123456)).toBe("12.3%");
  });
});

describe("GatewayExecutionCaptureObserver", () => {
  it("records a captured execution through the store", async () => {
    const record = vi.fn(async () => undefined);
    const obs = new GatewayExecutionCaptureObserver({ store: { record }, config: { sampleRate: 1 } });
    obs.record(execution());
    await obs.drain();
    expect(record).toHaveBeenCalledTimes(1);
    expect(obs.report().written).toBe(1);
  });

  it("counts a filtered execution without touching the store", async () => {
    const record = vi.fn(async () => undefined);
    const obs = new GatewayExecutionCaptureObserver({
      store: { record },
      config: { sampleRate: 1, operations: ["other.op"] },
    });
    obs.record(execution());
    await obs.drain();
    expect(record).not.toHaveBeenCalled();
    expect(obs.report()).toMatchObject({ written: 0, filtered: 1 });
  });

  it("never throws out of record when the store fails", async () => {
    const obs = new GatewayExecutionCaptureObserver({
      store: {
        record: async () => {
          throw new Error("foreign key violation on tenant_id");
        },
      },
      config: { sampleRate: 1 },
    });
    expect(() => {
      obs.record(execution());
    }).not.toThrow();
    await obs.drain();
    expect(obs.report()).toMatchObject({ written: 0, failed: 1 });
    expect(obs.report().firstFailure).toContain("foreign key");
  });

  it("routes the failure to onError with the execution that caused it", async () => {
    const onError = vi.fn();
    const obs = new GatewayExecutionCaptureObserver({
      store: {
        record: async () => {
          throw new Error("down");
        },
      },
      config: { sampleRate: 1 },
      onError,
    });
    obs.record(execution({ requestId: "req_failing0001" }));
    await obs.drain();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ requestId: "req_failing0001" });
  });

  it("keeps only the first failure message, so a flood does not rewrite the diagnosis", async () => {
    let n = 0;
    const obs = new GatewayExecutionCaptureObserver({
      store: {
        record: async () => {
          n += 1;
          throw new Error(`failure ${n.toString()}`);
        },
      },
      config: { sampleRate: 1 },
    });
    obs.record(execution({ requestId: "req_aaaaaaaa0001" }));
    await obs.drain();
    obs.record(execution({ requestId: "req_bbbbbbbb0002" }));
    await obs.drain();
    expect(obs.report()).toMatchObject({ failed: 2, firstFailure: "failure 1" });
  });

  it("sheds rather than queueing once maxInFlight writes are outstanding", async () => {
    const gateControl: { release: () => void } = { release: () => undefined };
    const gate = new Promise<void>((resolve) => {
      gateControl.release = resolve;
    });
    const obs = new GatewayExecutionCaptureObserver({
      store: { record: async () => gate },
      config: { sampleRate: 1 },
      maxInFlight: 2,
    });
    for (let i = 0; i < 5; i++) obs.record(execution({ requestId: `req_shed${i.toString().padStart(8, "0")}` }));
    expect(obs.pending()).toBe(2);
    expect(obs.report().shed).toBe(3);
    gateControl.release();
    await obs.drain();
    expect(obs.report()).toMatchObject({ written: 2, shed: 3 });
  });

  it("accepts again once the in-flight writes settle", async () => {
    const obs = new GatewayExecutionCaptureObserver({
      store: { record: async () => undefined },
      config: { sampleRate: 1 },
      maxInFlight: 1,
    });
    obs.record(execution({ requestId: "req_first00000001" }));
    await obs.drain();
    obs.record(execution({ requestId: "req_second0000001" }));
    await obs.drain();
    expect(obs.report()).toMatchObject({ written: 2, shed: 0 });
  });

  it("drain resolves when nothing is in flight", async () => {
    const obs = new GatewayExecutionCaptureObserver({
      store: { record: async () => undefined },
      config: { sampleRate: 1 },
    });
    await expect(obs.drain()).resolves.toBeUndefined();
  });

  it("asExecutionSink is a void callback that does not throw", async () => {
    const record = vi.fn(async () => undefined);
    const obs = new GatewayExecutionCaptureObserver({ store: { record }, config: { sampleRate: 1 } });
    const sink = obs.asExecutionSink();
    expect(sink(execution())).toBeUndefined();
    await obs.drain();
    expect(record).toHaveBeenCalledTimes(1);
  });
});
