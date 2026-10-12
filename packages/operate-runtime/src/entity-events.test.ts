import {
  producibleEntityEventNames,
  resolveManifest,
  type Manifest,
  type ManifestRegistry,
} from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
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

const packRegistry: ManifestRegistry = {
  async getManifest(id) {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const resolvedCore = await resolveManifest(buildErpCorePack(), { registry: packRegistry });
const resolvedRetail = await resolveManifest(buildErpRetailPack(), { registry: packRegistry });

/** Every write a deployment serving this manifest can perform, as the effect would see it. */
function writesOf(manifest: Manifest): readonly WriteEffectInput[] {
  const writes: WriteEffectInput[] = [];
  for (const entity of manifest.entities ?? []) {
    for (const operation of ["create", "update", "delete"] as const) {
      writes.push(input({ operation, entity: entity.name }));
    }
  }
  for (const workflow of Object.values(manifest.workflows ?? {})) {
    if (workflow.kind !== "entityLifecycle") continue;
    for (const transition of workflow.transitions) {
      writes.push(
        input({ operation: "transition", entity: workflow.entity, transitionTo: transition.to }),
      );
    }
  }
  return writes;
}

async function namesEmittedFor(
  manifest: Manifest,
  eventPrefix?: string,
): Promise<ReadonlySet<string>> {
  const events: EntityEvent[] = [];
  const effect = entityEventEffect({
    sink: sinkOf(events),
    ...(eventPrefix !== undefined ? { eventPrefix } : {}),
  });
  for (const write of writesOf(manifest)) await effect(write);
  return new Set(events.map((e) => e.name));
}

describe("entityEventEffect ↔ producibleEntityEventNames", () => {
  // The join this grammar was moved into kernel for: the survey enumerates what a producer can
  // emit, so a divergence is a job declaration that reads as served and never fires. Asserted in
  // **both** directions over a real resolved pack — one way alone would pass while the set was
  // padded (or while a verb went unenumerated), which is the one-way comparison ADR-0335's
  // retention rule exists to avoid.
  it("emits exactly the producible set for resolved erp-core", async () => {
    const emitted = await namesEmittedFor(resolvedCore);
    expect([...emitted].sort()).toEqual([...producibleEntityEventNames(resolvedCore)].sort());
  });

  it("emits exactly the producible set for resolved erp-retail, prefix and all", async () => {
    const emitted = await namesEmittedFor(resolvedRetail, "retail");
    expect([...emitted].sort()).toEqual(
      [...producibleEntityEventNames(resolvedRetail, { eventPrefix: "retail" })].sort(),
    );
  });

  it("is 230 names for erp-core = 51 entities × 3 verbs + 77 distinct transition targets", async () => {
    const emitted = await namesEmittedFor(resolvedCore);
    expect(resolvedCore.entities).toHaveLength(51);
    expect(emitted.size).toBe(230);
    expect(emitted.size - (resolvedCore.entities ?? []).length * 3).toBe(77);
  });

  it("names a lifecycle target only where that pack declares it", async () => {
    // `salesorder.placed` belongs to retail's cart→placed lifecycle; core's SalesOrder goes
    // draft→confirmed, so the name is producible on one deployment and not the other. Pinned
    // because an enumeration taken from the wrong pack would read as working either way.
    const core = producibleEntityEventNames(resolvedCore);
    const retail = producibleEntityEventNames(resolvedRetail);
    expect(retail.has("salesorder.placed")).toBe(true);
    expect(core.has("salesorder.placed")).toBe(false);
    expect(core.has("salesorder.confirmed")).toBe(true);
    for (const shared of ["invoice.sent", "lead.created", "workorder.completed"]) {
      expect(core.has(shared)).toBe(true);
      expect(retail.has(shared)).toBe(true);
    }
  });

  it("produces none of the event names the pack's own job declarations match", async () => {
    // The live mismatch, derived from the manifest rather than from a hand-typed list: the
    // producer emits `<entity>.<verb>` while every declared `event` trigger is
    // `<domain>.<snake_case act>` (`erp.lead_created`, `erp.work_order_completed`), matched with
    // `===`. So not one of them can fire. Pinned here so neither side can be changed without this
    // test naming the other.
    const core = producibleEntityEventNames(resolvedCore);
    const declared = Object.values(resolvedCore.jobs ?? {})
      .map((job) => job.trigger)
      .filter((t): t is Extract<typeof t, { kind: "event" }> => t.kind === "event")
      .map((t) => t.eventName);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toContain("erp.lead_created");
    expect(declared.filter((name) => core.has(name))).toEqual([]);
  });
});
