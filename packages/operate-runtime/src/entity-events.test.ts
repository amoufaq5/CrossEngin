import { describe, expect, it } from "vitest";

import { entityEventEffect, type EntityEvent, type EntityEventSink } from "./entity-events.js";
import type { WriteEffectInput } from "./write-effects.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function sinkOf(events: EntityEvent[], throwErr?: Error): EntityEventSink {
  return {
    emit: async (e) => {
      if (throwErr !== undefined) throw throwErr;
      events.push(e);
    },
  };
}

function input(overrides: Partial<WriteEffectInput> & Pick<WriteEffectInput, "operation">): WriteEffectInput {
  return {
    entity: "SalesOrder",
    tenantId: TENANT,
    id: "rec_1",
    before: null,
    after: { id: "rec_1", updated_at: "2026-05-17T12:00:00.000Z" },
    store: {} as WriteEffectInput["store"],
    ...overrides,
  };
}

describe("entityEventEffect", () => {
  it("names a create event <entity>.created and carries the record + a stable idempotencyKey", async () => {
    const events: EntityEvent[] = [];
    const effect = entityEventEffect({ sink: sinkOf(events) });
    await effect(input({ operation: "create" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "salesorder.created",
      tenantId: TENANT,
      operation: "create",
      recordId: "rec_1",
      idempotencyKey: "SalesOrder:create:rec_1:2026-05-17T12:00:00.000Z",
    });
    expect(events[0]!.data).toMatchObject({ id: "rec_1" });
  });

  it("names update/delete events with the right verb", async () => {
    const events: EntityEvent[] = [];
    const effect = entityEventEffect({ sink: sinkOf(events) });
    await effect(input({ operation: "update" }));
    await effect(input({ operation: "delete" }));
    expect(events.map((e) => e.name)).toEqual(["salesorder.updated", "salesorder.deleted"]);
  });

  it("names a transition event by its target state and carries toState", async () => {
    const events: EntityEvent[] = [];
    const effect = entityEventEffect({ sink: sinkOf(events) });
    await effect(input({ operation: "transition", transitionTo: "placed" }));
    expect(events[0]!.name).toBe("salesorder.placed");
    expect(events[0]!.toState).toBe("placed");
  });

  it("applies an optional event prefix", async () => {
    const events: EntityEvent[] = [];
    const effect = entityEventEffect({ sink: sinkOf(events), eventPrefix: "retail" });
    await effect(input({ operation: "transition", transitionTo: "placed" }));
    expect(events[0]!.name).toBe("retail.salesorder.placed");
  });

  it("sanitizes non-alphanumeric segments into valid dotted names", async () => {
    const events: EntityEvent[] = [];
    const effect = entityEventEffect({ sink: sinkOf(events) });
    await effect(input({ operation: "transition", entity: "Order-Line", transitionTo: "In Progress" }));
    expect(events[0]!.name).toBe("order_line.in_progress");
  });

  it("is best-effort: a sink error is routed to onError and never thrown (the write must not fail)", async () => {
    const errors: unknown[] = [];
    const effect = entityEventEffect({
      sink: sinkOf([], new Error("enqueue down")),
      onError: (e) => errors.push(e),
    });
    await expect(effect(input({ operation: "create" }))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("enqueue down");
  });

  it("falls back to the input id + verb when the record lacks id/updated_at", async () => {
    const events: EntityEvent[] = [];
    const effect = entityEventEffect({ sink: sinkOf(events) });
    await effect(input({ operation: "create", id: null, after: {} }));
    expect(events[0]!.recordId).toBeNull();
    expect(events[0]!.idempotencyKey).toBe("SalesOrder:create:new:created");
  });
});
