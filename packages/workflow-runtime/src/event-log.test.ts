import type { WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it } from "vitest";

import { InMemoryEventLog } from "./event-log.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function event(overrides: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    id: overrides.id ?? "wfe_00000001",
    instanceId: overrides.instanceId ?? "wfi_00000001",
    tenantId: overrides.tenantId ?? TENANT,
    sequenceNumber: overrides.sequenceNumber ?? 0,
    kind: overrides.kind ?? "instance_started",
    occurredAt: overrides.occurredAt ?? "2026-05-16T12:00:00.000Z",
    actorPrincipalId: overrides.actorPrincipalId ?? null,
    actorSystemId: overrides.actorSystemId ?? "engine",
    previousState: overrides.previousState ?? null,
    newState: overrides.newState ?? null,
    activityId: overrides.activityId ?? null,
    signalId: overrides.signalId ?? null,
    timerId: overrides.timerId ?? null,
    childInstanceId: overrides.childInstanceId ?? null,
    variableName: overrides.variableName ?? null,
    payload: overrides.payload ?? {},
    correlationId: overrides.correlationId ?? null,
    causationEventId: overrides.causationEventId ?? null,
  };
}

describe("InMemoryEventLog.append", () => {
  it("accepts the first event at sequence 0", async () => {
    const log = new InMemoryEventLog();
    await log.append(event({ sequenceNumber: 0 }));
    expect(await log.count()).toBe(1);
    expect(await log.latestSequence("wfi_00000001")).toBe(0);
  });

  it("rejects a duplicate sequence number", async () => {
    const log = new InMemoryEventLog();
    await log.append(event({ sequenceNumber: 0 }));
    await expect(log.append(event({ id: "wfe_00000002", sequenceNumber: 0 }))).rejects.toThrow(
      /non-monotonic/,
    );
  });

  it("rejects a non-contiguous sequence number", async () => {
    const log = new InMemoryEventLog();
    await log.append(event({ sequenceNumber: 0 }));
    await expect(log.append(event({ id: "wfe_00000002", sequenceNumber: 2 }))).rejects.toThrow(
      /non-monotonic/,
    );
  });

  it("rejects a non-zero starting sequence", async () => {
    const log = new InMemoryEventLog();
    await expect(log.append(event({ sequenceNumber: 5 }))).rejects.toThrow(/non-monotonic/);
  });

  it("scopes monotonic sequence per instance", async () => {
    const log = new InMemoryEventLog();
    await log.append(event({ id: "wfe_00000001", instanceId: "wfi_a0000001", sequenceNumber: 0 }));
    await log.append(event({ id: "wfe_00000002", instanceId: "wfi_b0000001", sequenceNumber: 0 }));
    expect(await log.latestSequence("wfi_a0000001")).toBe(0);
    expect(await log.latestSequence("wfi_b0000001")).toBe(0);
    expect(await log.count()).toBe(2);
  });
});

describe("InMemoryEventLog.appendBatch", () => {
  it("appends events atomically in sequence order", async () => {
    const log = new InMemoryEventLog();
    await log.appendBatch([
      event({ id: "wfe_00000001", sequenceNumber: 0 }),
      event({
        id: "wfe_00000002",
        sequenceNumber: 1,
        kind: "state_transitioned",
        previousState: "draft",
        newState: "approved",
      }),
    ]);
    expect(await log.count()).toBe(2);
    expect(await log.latestSequence("wfi_00000001")).toBe(1);
  });

  it("rejects a batch with a bad sequence (first failure halts subsequent appends)", async () => {
    const log = new InMemoryEventLog();
    await expect(
      log.appendBatch([
        event({ id: "wfe_00000001", sequenceNumber: 1 }),
        event({ id: "wfe_00000002", sequenceNumber: 2 }),
      ]),
    ).rejects.toThrow(/non-monotonic/);
  });
});

describe("InMemoryEventLog.listByInstance", () => {
  it("returns empty for an unknown instance", async () => {
    const log = new InMemoryEventLog();
    expect(await log.listByInstance("wfi_unknownx")).toEqual([]);
  });

  it("returns events in append order", async () => {
    const log = new InMemoryEventLog();
    await log.append(event({ id: "wfe_00000001", sequenceNumber: 0 }));
    await log.append(event({ id: "wfe_00000002", sequenceNumber: 1, kind: "instance_completed" }));
    const events = await log.listByInstance("wfi_00000001");
    expect(events.map((e) => e.id)).toEqual(["wfe_00000001", "wfe_00000002"]);
  });
});

describe("InMemoryEventLog.latestSequence", () => {
  it("returns null for an unknown instance", async () => {
    const log = new InMemoryEventLog();
    expect(await log.latestSequence("wfi_unknownx")).toBeNull();
  });

  it("returns the highest sequence appended", async () => {
    const log = new InMemoryEventLog();
    await log.append(event({ id: "wfe_00000001", sequenceNumber: 0 }));
    await log.append(event({ id: "wfe_00000002", sequenceNumber: 1, kind: "instance_completed" }));
    expect(await log.latestSequence("wfi_00000001")).toBe(1);
  });
});
