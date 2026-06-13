import { DEFAULT_DR_TIERS } from "@crossengin/dr";
import { describe, expect, it } from "vitest";

import {
  IllegalFailoverTransitionError,
  assessFailover,
  beginFailover,
  completeFailover,
  newFailoverRecord,
  revertFailover,
  transitionFailover,
  type NewFailoverInput,
} from "./failover.js";

const TIER1 = DEFAULT_DR_TIERS["tier_1_business_critical"]; // maxRpo 60, maxRto 900

function input(over: Partial<NewFailoverInput> = {}): NewFailoverInput {
  return {
    id: "fo-1",
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    triggeredBy: "ops",
    triggeredAt: "2026-06-13T00:00:00.000Z",
    fromRegion: "us-east",
    toRegion: "us-west",
    affectedApps: ["operate-server"],
    ...over,
  };
}

describe("failover lifecycle", () => {
  it("queues → in_progress → succeeded, computing duration", () => {
    const queued = newFailoverRecord(input());
    expect(queued.status).toBe("queued");
    const started = beginFailover(queued, "2026-06-13T00:00:00.000Z");
    expect(started.status).toBe("in_progress");
    const done = completeFailover(started, { at: "2026-06-13T00:05:00.000Z", actualRpoSeconds: 30, actualRtoSeconds: 300 });
    expect(done).toMatchObject({ status: "succeeded", actualRpoSeconds: 30, durationSeconds: 300 });
  });

  it("rejects an illegal transition (queued → succeeded directly)", () => {
    expect(() => transitionFailover(newFailoverRecord(input()), "succeeded")).toThrow(IllegalFailoverTransitionError);
  });

  it("requires an incident ticket for an outage-triggered failover", () => {
    expect(() => newFailoverRecord(input({ trigger: "primary_outage" }))).toThrow();
    expect(newFailoverRecord(input({ trigger: "primary_outage", incidentTicketId: "INC-1" })).status).toBe("queued");
  });

  it("reverts a succeeded failover", () => {
    const done = completeFailover(beginFailover(newFailoverRecord(input()), "2026-06-13T00:00:00.000Z"), {
      at: "2026-06-13T00:05:00.000Z",
      actualRpoSeconds: 30,
      actualRtoSeconds: 300,
    });
    const reverted = revertFailover(done, { at: "2026-06-13T01:00:00.000Z", revertedToFailoverId: "fo-2" });
    expect(reverted).toMatchObject({ status: "reverted", revertedToFailoverId: "fo-2" });
  });
});

describe("assessFailover", () => {
  function completed(rpo: number, rto: number) {
    return completeFailover(beginFailover(newFailoverRecord(input()), "2026-06-13T00:00:00.000Z"), {
      at: "2026-06-13T00:05:00.000Z",
      actualRpoSeconds: rpo,
      actualRtoSeconds: rto,
    });
  }

  it("meets the target when RPO + RTO are within the tier", () => {
    expect(assessFailover(completed(30, 300), TIER1)).toMatchObject({ rpoMet: true, rtoMet: true, met: true });
  });

  it("fails when RPO exceeds the tier", () => {
    expect(assessFailover(completed(120, 300), TIER1)).toMatchObject({ rpoMet: false, met: false });
  });

  it("fails when RTO exceeds the tier", () => {
    expect(assessFailover(completed(30, 1200), TIER1)).toMatchObject({ rtoMet: false, met: false });
  });
});
