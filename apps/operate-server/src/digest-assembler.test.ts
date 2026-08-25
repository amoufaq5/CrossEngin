import { NotificationDispatchSchema, type DigestBatch } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  assembleDueDigests,
  assembleForTenants,
  memberFromItem,
  type AssemblyDeliverySink,
  type AssemblyDigestSource,
  type AssemblyDispatchSink,
  type DigestAssemblyOptions,
} from "./digest-assembler.js";
import type { DigestItemRecord } from "./digest-store.js";
import type { DispatchInput } from "./notification-store.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-25T17:00:00.000Z");
const ADDR_A = "a".repeat(64);
const ADDR_B = "b".repeat(64);

function digest(overrides: Partial<DigestBatch> = {}): DigestBatch {
  return {
    id: `dgst_${"d".repeat(32)}`,
    tenantId: TENANT,
    userId: USER,
    channel: "in_app",
    frequency: "hourly",
    status: "open",
    openedAt: "2026-08-25T16:00:00.000Z",
    scheduledDispatchAt: "2026-08-25T17:00:00.000Z",
    assembledAt: null,
    dispatchedAt: null,
    itemCount: 2,
    maxItems: 50,
    dedupSha256: null,
    ...overrides,
  };
}

function item(n: number, address = ADDR_A): DigestItemRecord {
  return {
    dispatchRowId: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
    dispatchId: `disp_${String(n).padStart(32, "0")}`,
    templateId: "design_review.approved",
    category: "transactional",
    priority: "high",
    locale: "en",
    correlationId: null,
    queuedAt: `2026-08-25T16:0${String(n)}:00.000Z`,
    recipientAddressSha256: address,
  };
}

class FakeDigests implements AssemblyDigestSource {
  due: DigestBatch[] = [];
  items = new Map<string, DigestItemRecord[]>();
  readonly assembled: string[] = [];
  async dueForAssembly(): Promise<readonly DigestBatch[]> {
    return this.due;
  }
  async itemsFor(_t: string, digestId: string): Promise<readonly DigestItemRecord[]> {
    return this.items.get(digestId) ?? [];
  }
  async markAssembled(_t: string, digestId: string): Promise<boolean> {
    this.assembled.push(digestId);
    return true;
  }
}

class FakeDeliveries implements AssemblyDeliverySink {
  readonly superseded: Array<{ rowId: string; address: string }> = [];
  readonly reconciled: string[] = [];
  supersedeResult = true;
  async supersedeDeferred(_t: string, rowId: string, address: string): Promise<boolean> {
    this.superseded.push({ rowId, address });
    return this.supersedeResult;
  }
  async reconcile(_t: string, rowId: string): Promise<unknown> {
    this.reconciled.push(rowId);
    return { changed: true };
  }
}

class FakeDispatches implements AssemblyDispatchSink {
  readonly recorded: DispatchInput[] = [];
  result = true;
  async record(input: DispatchInput): Promise<boolean> {
    this.recorded.push(input);
    return this.result;
  }
}

function opts(
  digests: FakeDigests,
  deliveries: FakeDeliveries,
  dispatches: FakeDispatches,
): DigestAssemblyOptions {
  return { digests, deliveries, dispatches, clock: () => NOW };
}

describe("digest-assembler — memberFromItem", () => {
  it("maps a stored item onto the pure module's member shape", () => {
    const member = memberFromItem(item(1));
    expect(member.rowId).toBe(item(1).dispatchRowId);
    expect(member.dispatchId).toBe(item(1).dispatchId);
    expect(member.category).toBe("transactional");
    expect(member.priority).toBe("high");
  });
});

describe("digest-assembler — assembleDueDigests", () => {
  it("queues one summary dispatch for a pool of two", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1), item(2)]);
    const deliveries = new FakeDeliveries();
    const dispatches = new FakeDispatches();

    const report = await assembleDueDigests(opts(digests, deliveries, dispatches), TENANT);

    expect(report.digests).toBe(1);
    expect(report.queued).toBe(1);
    expect(dispatches.recorded).toHaveLength(1);
  });

  it("writes a schema-valid dispatch correlated back to the digest", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1), item(2)]);
    const dispatches = new FakeDispatches();

    await assembleDueDigests(opts(digests, new FakeDeliveries(), dispatches), TENANT);

    const summary = dispatches.recorded[0];
    expect(() => NotificationDispatchSchema.parse(summary)).not.toThrow();
    expect(summary?.correlationId).toBe(d.id);
    expect(summary?.idempotencyKey).toBe(`digest:${d.id}`);
    expect(summary?.status).toBe("queued");
    expect(summary?.recipientCount).toBe(1);
  });

  it("keeps the summary non-suppressible when the pool was", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1), { ...item(2), category: "operational_digest" }]);
    const dispatches = new FakeDispatches();

    await assembleDueDigests(opts(digests, new FakeDeliveries(), dispatches), TENANT);

    expect(dispatches.recorded[0]?.category).toBe("transactional");
  });

  it("supersedes every pooled notice's pending retry", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1), item(2, ADDR_B)]);
    const deliveries = new FakeDeliveries();

    const report = await assembleDueDigests(
      opts(digests, deliveries, new FakeDispatches()),
      TENANT,
    );

    expect(report.superseded).toBe(2);
    expect(deliveries.superseded.map((s) => s.address)).toEqual([ADDR_A, ADDR_B]);
  });

  it("reconciles every member dispatch after superseding", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1), item(2)]);
    const deliveries = new FakeDeliveries();

    await assembleDueDigests(opts(digests, deliveries, new FakeDispatches()), TENANT);

    expect(deliveries.reconciled).toHaveLength(2);
  });

  it("queues the summary before retiring the individual notices", async () => {
    const order: string[] = [];
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1)]);
    const deliveries: AssemblyDeliverySink = {
      supersedeDeferred: async () => {
        order.push("supersede");
        return true;
      },
      reconcile: async () => {
        order.push("reconcile");
        return null;
      },
    };
    const dispatches: AssemblyDispatchSink = {
      record: async () => {
        order.push("record");
        return true;
      },
    };

    await assembleDueDigests({ digests, deliveries, dispatches, clock: () => NOW }, TENANT);

    expect(order).toEqual(["record", "supersede", "reconcile"]);
  });

  it("marks the digest assembled", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1)]);

    await assembleDueDigests(opts(digests, new FakeDeliveries(), new FakeDispatches()), TENANT);

    expect(digests.assembled).toEqual([d.id]);
  });

  it("closes an empty pool without queueing anything", async () => {
    const digests = new FakeDigests();
    const d = digest({ itemCount: 0 });
    digests.due = [d];
    const dispatches = new FakeDispatches();

    const report = await assembleDueDigests(
      opts(digests, new FakeDeliveries(), dispatches),
      TENANT,
    );

    expect(report.empty).toBe(1);
    expect(report.queued).toBe(0);
    expect(dispatches.recorded).toHaveLength(0);
    expect(digests.assembled).toEqual([d.id]);
  });

  it("reports queued: 0 when the summary already existed", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1)]);
    const dispatches = new FakeDispatches();
    dispatches.result = false;

    const report = await assembleDueDigests(
      opts(digests, new FakeDeliveries(), dispatches),
      TENANT,
    );

    expect(report.queued).toBe(0);
    // Still retires the pooled notices: the summary exists, it just wasn't written twice.
    expect(report.superseded).toBe(1);
  });

  it("names the same summary dispatch on a repeat assembly", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1), item(2)]);
    const dispatches = new FakeDispatches();

    await assembleDueDigests(opts(digests, new FakeDeliveries(), dispatches), TENANT);
    await assembleDueDigests(opts(digests, new FakeDeliveries(), dispatches), TENANT);

    expect(dispatches.recorded[0]?.id).toBe(dispatches.recorded[1]?.id);
  });

  it("counts a member whose retry was already gone as not superseded", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1)]);
    const deliveries = new FakeDeliveries();
    deliveries.supersedeResult = false;

    const report = await assembleDueDigests(
      opts(digests, deliveries, new FakeDispatches()),
      TENANT,
    );

    expect(report.superseded).toBe(0);
    expect(deliveries.reconciled).toHaveLength(1);
  });

  it("returns a zero report when nothing is due", async () => {
    const report = await assembleDueDigests(
      opts(new FakeDigests(), new FakeDeliveries(), new FakeDispatches()),
      TENANT,
    );
    expect(report).toMatchObject({ digests: 0, queued: 0, superseded: 0, empty: 0 });
  });

  it("assembles several due digests in one pass", async () => {
    const digests = new FakeDigests();
    const a = digest();
    const b = digest({ id: `dgst_${"e".repeat(32)}` });
    digests.due = [a, b];
    digests.items.set(a.id, [item(1)]);
    digests.items.set(b.id, [item(2)]);
    const dispatches = new FakeDispatches();

    const report = await assembleDueDigests(
      opts(digests, new FakeDeliveries(), dispatches),
      TENANT,
    );

    expect(report.digests).toBe(2);
    expect(report.queued).toBe(2);
    expect(new Set(dispatches.recorded.map((r) => r.id)).size).toBe(2);
  });
});

describe("digest-assembler — assembleForTenants", () => {
  it("aggregates across tenants", async () => {
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1)]);

    const report = await assembleForTenants(
      opts(digests, new FakeDeliveries(), new FakeDispatches()),
      [TENANT, TENANT],
    );

    expect(report.tenants).toBe(2);
    expect(report.digests).toBe(2);
    expect(report.queued).toBe(2);
  });

  it("routes one tenant's failure to onError and keeps sweeping", async () => {
    const errors: string[] = [];
    const digests = new FakeDigests();
    const d = digest();
    digests.due = [d];
    digests.items.set(d.id, [item(1)]);
    const failing: AssemblyDigestSource = {
      dueForAssembly: async (tenantId: string) => {
        if (tenantId === "bad") throw new Error("digests unreadable");
        return digests.dueForAssembly();
      },
      itemsFor: (t, id) => digests.itemsFor(t, id),
      markAssembled: (t, id) => digests.markAssembled(t, id),
    };

    const report = await assembleForTenants(
      {
        digests: failing,
        deliveries: new FakeDeliveries(),
        dispatches: new FakeDispatches(),
        clock: () => NOW,
        onError: (_e, t) => errors.push(t),
      },
      ["bad", TENANT],
    );

    expect(errors).toEqual(["bad"]);
    expect(report.tenants).toBe(1);
    expect(report.queued).toBe(1);
  });

  it("returns an empty report for no tenants", async () => {
    const report = await assembleForTenants(
      opts(new FakeDigests(), new FakeDeliveries(), new FakeDispatches()),
      [],
    );
    expect(report).toMatchObject({ tenants: 0, digests: 0, queued: 0 });
  });
});
