import { describe, expect, it } from "vitest";

import {
  DomainEventSchema,
  enqueueKeyForEvent,
  matchEventJobs,
  planJobRunsForEvent,
  type DomainEvent,
} from "./enqueue.js";
import { JobDeclarationSchema, type JobDeclaration } from "./types.js";

function job(overrides: Partial<JobDeclaration> & { id: string }): JobDeclaration {
  return JobDeclarationSchema.parse({
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    trigger: overrides.trigger ?? { kind: "event", eventName: "retail.order_placed" },
    onFailure: overrides.onFailure ?? { strategy: "dead-letter" },
    ...overrides,
  });
}

const EVENT: DomainEvent = {
  name: "retail.order_placed",
  tenantId: "00000000-0000-4000-8000-000000000001",
  data: { order_id: "o-1", total: 42 },
  idempotencyKey: "evt-123",
  occurredAt: "2026-05-17T12:00:00.000Z",
};

describe("DomainEventSchema", () => {
  it("defaults data to {} and accepts an optional idempotencyKey", () => {
    const e = DomainEventSchema.parse({ name: "retail.order_placed", tenantId: "t" });
    expect(e.data).toEqual({});
    expect(e.idempotencyKey).toBeUndefined();
  });

  it("rejects an event name without a dot", () => {
    expect(DomainEventSchema.safeParse({ name: "orderplaced", tenantId: "t" }).success).toBe(false);
  });
});

describe("matchEventJobs", () => {
  it("matches event-trigger jobs by event name, skipping other triggers and deprecated jobs", () => {
    const jobs = [
      job({ id: "decrement-inventory" }),
      job({ id: "email-receipt", trigger: { kind: "event", eventName: "retail.order_shipped" } }),
      job({ id: "reminder", trigger: { kind: "scheduled", cron: "0 9 * * *" } }),
      job({ id: "legacy", deprecated: true }),
    ];
    expect(matchEventJobs(EVENT, jobs).map((j) => j.id)).toEqual(["decrement-inventory"]);
  });

  it("also matches delayed-trigger jobs by their afterEvent", () => {
    const jobs = [
      job({ id: "review-request", trigger: { kind: "delayed", afterEvent: "retail.order_placed", delay: "P1D" } }),
      job({ id: "other", trigger: { kind: "delayed", afterEvent: "retail.order_shipped", delay: "PT1H" } }),
    ];
    expect(matchEventJobs(EVENT, jobs).map((j) => j.id)).toEqual(["review-request"]);
  });
});

describe("enqueueKeyForEvent", () => {
  it("is deterministic and prefers the emitter idempotencyKey", () => {
    expect(enqueueKeyForEvent(EVENT, "decrement-inventory")).toBe(
      "retail.order_placed::evt-123::decrement-inventory",
    );
    expect(enqueueKeyForEvent(EVENT, "decrement-inventory")).toBe(
      enqueueKeyForEvent(EVENT, "decrement-inventory"),
    );
  });

  it("falls back to a stable payload hash-input when no idempotencyKey is present, key-order invariant", () => {
    const a: DomainEvent = { name: "retail.order_placed", tenantId: "t", data: { a: 1, b: 2 } };
    const b: DomainEvent = { name: "retail.order_placed", tenantId: "t", data: { b: 2, a: 1 } };
    expect(enqueueKeyForEvent(a, "j")).toBe(enqueueKeyForEvent(b, "j"));
    const c: DomainEvent = { name: "retail.order_placed", tenantId: "t", data: { a: 9 } };
    expect(enqueueKeyForEvent(a, "j")).not.toBe(enqueueKeyForEvent(c, "j"));
  });
});

describe("planJobRunsForEvent", () => {
  it("plans a pending run per matched job, carrying classes + event input + runKey", () => {
    const jobs = [job({ id: "decrement-inventory", inputDataClass: "commercial_sensitive" })];
    const [plan] = planJobRunsForEvent(EVENT, jobs);
    expect(plan).toEqual({
      jobId: "decrement-inventory",
      jobKind: "event",
      trigger: {
        kind: "event",
        eventName: "retail.order_placed",
        occurredAt: "2026-05-17T12:00:00.000Z",
        idempotencyKey: "evt-123",
      },
      input: { order_id: "o-1", total: 42 },
      inputDataClass: "commercial_sensitive",
      outputDataClass: "internal",
      delayMs: 0,
      runKey: "retail.order_placed::evt-123::decrement-inventory",
    });
  });

  it("plans a delayed run with delayMs from the trigger's ISO duration", () => {
    const jobs = [
      job({ id: "send-review-request", trigger: { kind: "delayed", afterEvent: "retail.order_placed", delay: "PT1H" } }),
    ];
    const [plan] = planJobRunsForEvent(EVENT, jobs);
    expect(plan?.jobKind).toBe("delayed");
    expect(plan?.delayMs).toBe(3_600_000);
    expect(plan?.trigger).toMatchObject({ kind: "delayed", eventName: "retail.order_placed", delay: "PT1H" });
  });

  it("returns an empty plan when nothing matches", () => {
    expect(planJobRunsForEvent(EVENT, [job({ id: "j", trigger: { kind: "scheduled", cron: "* * * * *" } })])).toEqual([]);
  });
});
