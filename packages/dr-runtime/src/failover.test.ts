import { describe, expect, it } from "vitest";
import { DEFAULT_DR_TIERS, FailoverRecordSchema } from "@crossengin/dr";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import {
  FAILOVER_ID_PREFIX,
  FailoverExecutor,
  IllegalFailoverTransitionError,
  type PlanFailoverInput,
} from "./failover.js";

const TIER1 = DEFAULT_DR_TIERS.tier_1_business_critical;

function makeExecutor(): FailoverExecutor {
  return new FailoverExecutor({
    clock: new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
    ids: new CountingIdGenerator(),
  });
}

const BASE_INPUT: PlanFailoverInput = {
  tier: "tier_1_business_critical",
  trigger: "planned_drill",
  triggeredBy: "sre-oncall",
  fromRegion: "us-east",
  toRegion: "us-west",
  affectedApps: ["billing", "gateway"],
};

describe("planFailover", () => {
  it("produces a validated queued record with a fov_ id", () => {
    const record = makeExecutor().planFailover(BASE_INPUT);
    expect(record.status).toBe("queued");
    expect(record.id).toBe(`${FAILOVER_ID_PREFIX}_00000001`);
    expect(record.triggeredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.startedAt).toBeNull();
    expect(FailoverRecordSchema.parse(record)).toEqual(record);
  });

  it("carries incidentTicketId for primary_outage", () => {
    const record = makeExecutor().planFailover({
      ...BASE_INPUT,
      trigger: "primary_outage",
      incidentTicketId: "INC-2026-0001",
    });
    expect(record.incidentTicketId).toBe("INC-2026-0001");
  });

  it("rejects primary_outage without an incident ticket", () => {
    expect(() =>
      makeExecutor().planFailover({ ...BASE_INPUT, trigger: "regional_failure" }),
    ).toThrow();
  });

  it("rejects a same-region failover", () => {
    expect(() =>
      makeExecutor().planFailover({ ...BASE_INPUT, toRegion: "us-east" }),
    ).toThrow();
  });
});

describe("failover state machine", () => {
  it("drives queued -> in_progress -> succeeded with actuals", () => {
    const exec = makeExecutor();
    let record = exec.planFailover(BASE_INPUT);
    record = exec.startFailover(record);
    expect(record.status).toBe("in_progress");
    expect(record.startedAt).toBe("2026-01-01T00:00:00.000Z");
    record = exec.completeFailover(record, {
      actualRpoSeconds: 30,
      actualRtoSeconds: 300,
      completedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(record.status).toBe("succeeded");
    expect(record.actualRpoSeconds).toBe(30);
    expect(record.actualRtoSeconds).toBe(300);
    expect(record.durationSeconds).toBe(300);
  });

  it("fails an in-progress failover", () => {
    const exec = makeExecutor();
    let record = exec.startFailover(exec.planFailover(BASE_INPUT));
    record = exec.failFailover(record, { notes: "replica unreachable" });
    expect(record.status).toBe("failed");
  });

  it("aborts a queued failover", () => {
    const exec = makeExecutor();
    const record = exec.abortFailover(exec.planFailover(BASE_INPUT));
    expect(record.status).toBe("aborted");
  });

  it("reverts a succeeded failover", () => {
    const exec = makeExecutor();
    let record = exec.completeFailover(
      exec.startFailover(exec.planFailover(BASE_INPUT)),
      { actualRpoSeconds: 10, actualRtoSeconds: 60 },
    );
    record = exec.revertFailover(record, { revertedToFailoverId: "fov_00000099" });
    expect(record.status).toBe("reverted");
    expect(record.revertedToFailoverId).toBe("fov_00000099");
    expect(record.revertedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("throws IllegalFailoverTransitionError on an illegal transition", () => {
    const exec = makeExecutor();
    const queued = exec.planFailover(BASE_INPUT);
    expect(() => exec.completeFailover(queued, { actualRpoSeconds: 1, actualRtoSeconds: 1 })).toThrow(
      IllegalFailoverTransitionError,
    );
    expect(() => exec.revertFailover(queued, { revertedToFailoverId: "fov_x" })).toThrow(
      IllegalFailoverTransitionError,
    );
  });

  it("cannot start a succeeded failover", () => {
    const exec = makeExecutor();
    const done = exec.completeFailover(
      exec.startFailover(exec.planFailover(BASE_INPUT)),
      { actualRpoSeconds: 1, actualRtoSeconds: 1 },
    );
    expect(() => exec.startFailover(done)).toThrow(IllegalFailoverTransitionError);
  });
});

describe("failoverTierVerdict", () => {
  it("flags no breach when actuals are within the tier budget", () => {
    const exec = makeExecutor();
    const record = exec.completeFailover(
      exec.startFailover(exec.planFailover(BASE_INPUT)),
      { actualRpoSeconds: 30, actualRtoSeconds: 300 },
    );
    const verdict = exec.failoverTierVerdict(record, TIER1);
    expect(verdict).toEqual({ rpoBreached: false, rtoBreached: false, compliant: true });
  });

  it("flags an RPO breach when actual exceeds maxRpoSeconds", () => {
    const exec = makeExecutor();
    const record = exec.completeFailover(
      exec.startFailover(exec.planFailover(BASE_INPUT)),
      { actualRpoSeconds: 120, actualRtoSeconds: 300 },
    );
    const verdict = exec.failoverTierVerdict(record, TIER1);
    expect(verdict.rpoBreached).toBe(true);
    expect(verdict.compliant).toBe(false);
  });

  it("flags an RTO breach when actual exceeds maxRtoSeconds", () => {
    const exec = makeExecutor();
    const record = exec.completeFailover(
      exec.startFailover(exec.planFailover(BASE_INPUT)),
      { actualRpoSeconds: 30, actualRtoSeconds: 5_000 },
    );
    const verdict = exec.failoverTierVerdict(record, TIER1);
    expect(verdict.rtoBreached).toBe(true);
    expect(verdict.compliant).toBe(false);
  });
});
