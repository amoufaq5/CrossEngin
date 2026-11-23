import type { PipelineExecution } from "@crossengin/api-gateway";
import type { AuditLogEntry } from "@crossengin/auth";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { EntityAuditUnrecorded, type EntityWriteAuditEvent } from "@crossengin/operate-runtime";
import { describe, expect, it, vi } from "vitest";

import { AmbientTransactions } from "./ambient-transaction.js";
import { EntityAuditRecorder, entityAuditEntry, type EntityAuditSink } from "./entity-audit-recorder.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

function event(over: Partial<EntityWriteAuditEvent> = {}): EntityWriteAuditEvent {
  return {
    requestId: "req_1",
    operationId: "patient.update",
    action: "update",
    entity: "Patient",
    tenantId: TENANT,
    recordId: "rec_1",
    actorUserId: USER,
    detail: null,
    before: { status: "a", mrn: { $redacted: "phi" } },
    after: { status: "b", mrn: { $redacted: "phi" } },
    diff: { status: { from: "a", to: "b" } },
    inTransaction: true,
    ...over,
  };
}

/** A pool whose transactions are distinguishable, so "which one did the row land on" is checkable. */
function pool(): { conn: PgConnection; txs: PgConnection[] } {
  const txs: PgConnection[] = [];
  const empty = async (): Promise<PgQueryResult> => ({ rows: [], rowCount: 0 });
  const conn: PgConnection = {
    query: empty as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const tx: PgConnection = {
        query: empty as PgConnection["query"],
        transaction: (async () => {
          throw new Error("nested transactions are not supported");
        }) as PgConnection["transaction"],
        withAdvisoryLock: (async <U>(_k: bigint, f: () => Promise<U>) => f()) as PgConnection["withAdvisoryLock"],
        close: (async () => undefined) as PgConnection["close"],
      };
      txs.push(tx);
      return fn(tx);
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, txs };
}

function sink(over: Partial<EntityAuditSink> = {}): EntityAuditSink & {
  within: { tx: PgConnection; entry: AuditLogEntry }[];
  own: AuditLogEntry[];
  removalReads: { tx: PgConnection | null }[];
} {
  const within: { tx: PgConnection; entry: AuditLogEntry }[] = [];
  const own: AuditLogEntry[] = [];
  const removalReads: { tx: PgConnection | null }[] = [];
  return {
    within,
    own,
    removalReads,
    emitWithin: async (tx, entry) => void within.push({ tx, entry }),
    emit: async (entry) => void own.push(entry),
    anchors: () => true,
    childDetachments: async () => {
      removalReads.push({ tx: null });
      return { removers: [USER], withheld: false };
    },
    childDetachmentsWithin: async (tx) => {
      removalReads.push({ tx });
      return { removers: [USER], withheld: false };
    },
    ...over,
  };
}

const REMOVAL_QUERY = {
  tenantId: TENANT,
  childEntity: "BillLine",
  parentField: "bill_id",
  parentId: "bill_1",
  parentCreatedAt: null,
};

function exec(requestId: string, status: number | null): PipelineExecution {
  return { requestId, finalResponseStatus: status } as PipelineExecution;
}

describe("AmbientTransactions", () => {
  it("answers the transaction a callback is running inside, through awaits, and nothing outside", async () => {
    const { conn, txs } = pool();
    const ambient = new AmbientTransactions();
    const wrapped = ambient.wrap(conn);
    expect(ambient.current()).toBeUndefined();
    let seen: PgConnection | undefined;
    await wrapped.transaction(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      seen = ambient.current();
    });
    expect(seen).toBe(txs[0]);
    expect(ambient.current()).toBeUndefined();
  });

  it("keeps two concurrent transactions apart", async () => {
    const { conn, txs } = pool();
    const ambient = new AmbientTransactions();
    const wrapped = ambient.wrap(conn);
    const seen: (PgConnection | undefined)[] = [];
    await Promise.all(
      [0, 1].map((i) =>
        wrapped.transaction(async () => {
          await new Promise((r) => setTimeout(r, i === 0 ? 5 : 1));
          seen[i] = ambient.current();
        }),
      ),
    );
    expect(seen[0]).toBe(txs[0]);
    expect(seen[1]).toBe(txs[1]);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("EntityAuditRecorder", () => {
  it("writes an in-transaction event on the write's OWN transaction", async () => {
    const { conn, txs } = pool();
    const ambient = new AmbientTransactions();
    const s = sink();
    const rec = new EntityAuditRecorder({
      sink: s,
      currentTransaction: () => ambient.current(),
      onRefused: vi.fn(),
      newId: () => ID,
    });
    await ambient.wrap(conn).transaction(() => rec.record(event()));
    expect(s.within).toHaveLength(1);
    expect(s.within[0]!.tx).toBe(txs[0]);
    expect(s.own).toHaveLength(0);
  });

  it("REFUSES an in-transaction event it cannot join, rather than writing it elsewhere", async () => {
    const s = sink();
    const onRefused = vi.fn();
    const rec = new EntityAuditRecorder({ sink: s, currentTransaction: () => undefined, onRefused });
    await expect(rec.record(event())).rejects.toBeInstanceOf(EntityAuditUnrecorded);
    expect(s.within).toHaveLength(0);
    expect(s.own).toHaveLength(0);
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  it("writes an out-of-transaction event (a link) in a transaction of its own", async () => {
    const s = sink();
    const rec = new EntityAuditRecorder({ sink: s, currentTransaction: () => undefined, onRefused: vi.fn() });
    await rec.record(event({ action: "link", inTransaction: false, detail: "Tag" }));
    expect(s.own).toHaveLength(1);
    expect(s.own[0]!.reason).toBe("link:Tag");
  });

  it("turns a sink failure into EntityAuditUnrecorded and reports a reason carrying no driver message", async () => {
    const leaky = Object.assign(new Error('duplicate key value (mrn)=(MRN-SECRET)'), { code: "23505" });
    const onRefused = vi.fn();
    const ambient = new AmbientTransactions();
    const rec = new EntityAuditRecorder({
      sink: sink({ emitWithin: async () => Promise.reject(leaky) }),
      currentTransaction: () => ambient.current(),
      onRefused,
    });
    const err = await ambient
      .wrap(pool().conn)
      .transaction(() => rec.record(event()))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntityAuditUnrecorded);
    expect((err as Error).message).not.toContain("MRN-SECRET");
    expect(onRefused.mock.calls[0]![1]).toBe("Error 23505");
  });

  it("supersedes the request-level entry exactly once, and only for a 2xx", async () => {
    const ambient = new AmbientTransactions();
    const rec = new EntityAuditRecorder({ sink: sink(), currentTransaction: () => ambient.current(), onRefused: vi.fn() });
    const tx = ambient.wrap(pool().conn);
    await tx.transaction(() => rec.record(event({ requestId: "req_ok" })));
    await tx.transaction(() => rec.record(event({ requestId: "req_failed_commit" })));
    expect(rec.pendingSupersedes()).toBe(2);
    expect(rec.supersedes(exec("req_ok", 200))).toBe(true);
    expect(rec.supersedes(exec("req_ok", 200))).toBe(false);
    // Recorded and then rolled back (the response was not 2xx): the request keeps its entry.
    expect(rec.supersedes(exec("req_failed_commit", 500))).toBe(false);
    expect(rec.supersedes(exec("req_never_recorded", 200))).toBe(false);
    expect(rec.pendingSupersedes()).toBe(0);
  });

  it("marks nothing when the sink does not anchor, so the request-level entry stays the anchor", async () => {
    const ambient = new AmbientTransactions();
    const rec = new EntityAuditRecorder({
      sink: sink({ anchors: () => false }),
      currentTransaction: () => ambient.current(),
      onRefused: vi.fn(),
    });
    await ambient.wrap(pool().conn).transaction(() => rec.record(event()));
    expect(rec.pendingSupersedes()).toBe(0);
    expect(rec.supersedes(exec("req_1", 200))).toBe(false);
  });

  it("marks no supersede for a write background work made, since no request will consume it", async () => {
    const ambient = new AmbientTransactions();
    const rec = new EntityAuditRecorder({ sink: sink(), currentTransaction: () => ambient.current(), onRefused: vi.fn() });
    const origin = { kind: "job" as const, jobId: "erp-core-depreciation-run", runId: "run-1" };
    await ambient.wrap(pool().conn).transaction(() => rec.record(event({ requestId: "req_job_1", origin })));
    expect(rec.pendingSupersedes()).toBe(0);
  });

  it("bounds the marks, evicting the oldest", async () => {
    const ambient = new AmbientTransactions();
    const rec = new EntityAuditRecorder({
      sink: sink(),
      currentTransaction: () => ambient.current(),
      onRefused: vi.fn(),
      maxPendingSupersedes: 2,
    });
    const tx = ambient.wrap(pool().conn);
    for (const id of ["a", "b", "c"]) await tx.transaction(() => rec.record(event({ requestId: id })));
    expect(rec.pendingSupersedes()).toBe(2);
    expect(rec.supersedes(exec("a", 200))).toBe(false);
    expect(rec.supersedes(exec("c", 200))).toBe(true);
  });
});

describe("EntityAuditRecorder.childRemovers", () => {
  it("reads inside the caller's transaction, so an approval holding the parent lock takes no second connection", async () => {
    const ambient = new AmbientTransactions();
    const s = sink();
    const rec = new EntityAuditRecorder({ sink: s, currentTransaction: () => ambient.current(), onRefused: vi.fn() });
    const out = await ambient.wrap(pool().conn).transaction(() => rec.childRemovers(REMOVAL_QUERY));
    expect(out).toEqual({ kind: "read", removers: [USER] });
    expect(s.removalReads).toHaveLength(1);
    expect(s.removalReads[0]!.tx).not.toBeNull();
  });

  it("opens its own scoped read outside a transaction", async () => {
    const s = sink();
    const rec = new EntityAuditRecorder({ sink: s, currentTransaction: () => undefined, onRefused: vi.fn() });
    expect(await rec.childRemovers(REMOVAL_QUERY)).toEqual({ kind: "read", removers: [USER] });
    expect(s.removalReads).toEqual([{ tx: null }]);
  });

  it("answers unreadable, never an empty list, when the read fails or a parent reference is withheld", async () => {
    const leaky = Object.assign(new Error("relation detail MRN-SECRET"), { code: "42501" });
    const failing = new EntityAuditRecorder({
      sink: sink({ childDetachments: async () => Promise.reject(leaky) }),
      currentTransaction: () => undefined,
      onRefused: vi.fn(),
    });
    const a = await failing.childRemovers(REMOVAL_QUERY);
    expect(a).toEqual({ kind: "unreadable", reason: "Error 42501" });
    const withheld = new EntityAuditRecorder({
      sink: sink({ childDetachments: async () => ({ removers: [], withheld: true }) }),
      currentTransaction: () => undefined,
      onRefused: vi.fn(),
    });
    const b = await withheld.childRemovers(REMOVAL_QUERY);
    expect(b.kind).toBe("unreadable");
    expect(b.kind === "unreadable" ? b.reason : "").toContain("withheld");
  });
});

describe("entityAuditEntry", () => {
  it("files under the operationId with the record id, the person and all three payloads", () => {
    const e = entityAuditEntry(event({ action: "transition", detail: "admit" }), {
      id: ID,
      occurredAt: "2026-11-17T10:00:00.000Z",
    });
    expect(e).toMatchObject({
      tenantId: TENANT,
      operation: "patient.update",
      entity: "Patient",
      entityId: "rec_1",
      actor: { kind: "user", userId: USER },
      reason: "transition:admit",
    });
    expect(e.before).toEqual({ status: "a", mrn: { $redacted: "phi" } });
    expect(e.diff).toEqual({ status: { from: "a", to: "b" } });
  });

  it("names no person for a credential that names nobody, and carries no reason when there is no detail", () => {
    const e = entityAuditEntry(event({ actorUserId: null }), { id: ID, occurredAt: "2026-11-17T10:00:00.000Z" });
    expect(e.actor).toMatchObject({ kind: "system", userId: null });
    expect("reason" in e).toBe(false);
  });

  it("names the job run that made a write, so a job's row and a bare api-key's are told apart", () => {
    const origin = { kind: "job" as const, jobId: "erp-core-overdue-invoice-reminder", runId: "run-9" };
    const plain = entityAuditEntry(event({ actorUserId: null, origin }), { id: ID, occurredAt: "2026-11-17T10:00:00.000Z" });
    expect(plain.actor).toMatchObject({ kind: "system", userId: null });
    expect(plain.reason).toBe("job:erp-core-overdue-invoice-reminder run:run-9");
    const moved = entityAuditEntry(event({ actorUserId: null, origin, action: "transition", detail: "mark_overdue" }), {
      id: ID,
      occurredAt: "2026-11-17T10:00:00.000Z",
    });
    expect(moved.reason).toBe("job:erp-core-overdue-invoice-reminder run:run-9 transition:mark_overdue");
  });

  it("names the provisioning that made a write, and never as a job", () => {
    const origin = {
      kind: "provisioning" as const,
      operation: "starter_chart" as const,
      provisioningId: "11111111-1111-4111-8111-111111111111",
    };
    const at = { id: ID, occurredAt: "2026-11-17T10:00:00.000Z" };
    const plain = entityAuditEntry(event({ actorUserId: null, origin }), at);
    expect(plain.actor).toMatchObject({ kind: "system", userId: null });
    expect(plain.reason).toBe("provisioning:starter_chart id:11111111-1111-4111-8111-111111111111");
    expect(plain.reason).not.toContain("job:");
    const moved = entityAuditEntry(event({ actorUserId: null, origin, action: "transition", detail: "activate" }), at);
    expect(moved.reason).toBe("provisioning:starter_chart id:11111111-1111-4111-8111-111111111111 transition:activate");
  });

  it("names the maintenance run that made a write, as neither a job nor a provisioning", () => {
    const origin = { kind: "maintenance" as const, operation: "bill_withholding_backfill" as const, runId: "bwb_7" };
    const plain = entityAuditEntry(event({ actorUserId: null, origin }), { id: ID, occurredAt: "2026-11-17T10:00:00.000Z" });
    expect(plain.actor).toMatchObject({ kind: "system", userId: null });
    expect(plain.reason).toBe("maintenance:bill_withholding_backfill run:bwb_7");
  });
});
