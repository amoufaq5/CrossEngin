import { JobDeclarationSchema, type JobDeclaration } from "@crossengin/jobs";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { EntityEvent } from "@crossengin/operate-runtime";
import { SET_TENANT_CONTEXT_SQL } from "@crossengin/workflow-runtime-pg";
import { describe, expect, it } from "vitest";

import { PostgresEntityEventSink } from "./entity-events.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

/** The two statement kinds this producer emits, selected by predicate rather than by index. */
const inserts = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((c) => c.sql.includes("INSERT INTO meta.job_runs"));
const contexts = (calls: readonly Call[]): readonly Call[] =>
  calls.filter((c) => c.sql.includes(SET_TENANT_CONTEXT_SQL));

/**
 * `transaction` must RUN its callback, handing it this same recording connection, or the whole
 * producer body is unobservable: `enqueueJobsForEvent` wraps its batch in `withTenantContext`, so a
 * `transaction` that discarded its callback recorded nothing and the assertions read an empty array
 * — which does not read as "the fake skipped the work" (CLAUDE.md's `Tests` convention, seventh
 * member).
 *
 * The `set_config` branch is **first** and returns before the fault injection, for two reasons. It
 * begins with `SELECT`, so any later branch keying on that word would hand it another statement's
 * rows (ADR-0363); and `throws` exists to fail an *enqueue*, which is the INSERT — before the
 * producer became tenant-scoped the only statement it issued was that INSERT, so failing the context
 * statement instead would quietly change what the best-effort test is about.
 */
function mockConn(calls: Call[], opts: { throws?: boolean } = {}): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      calls.push({ sql, params });
      if (sql.includes(SET_TENANT_CONTEXT_SQL)) return { rows: [], rowCount: 1 };
      if (opts.throws === true) throw new Error("db down");
      return { rows: [{ run_id: params?.[3] }], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

function event(name: string): EntityEvent {
  return {
    name,
    tenantId: TENANT,
    entity: "SalesOrder",
    operation: "transition",
    recordId: "rec_1",
    data: { id: "rec_1", state: "placed" },
    toState: "placed",
    idempotencyKey: "SalesOrder:transition:rec_1:2026",
  };
}

const orderPlacedJob: JobDeclaration = JobDeclarationSchema.parse({
  id: "decrement-inventory",
  name: "decrement-inventory",
  trigger: { kind: "event", eventName: "salesorder.placed" },
  onFailure: { strategy: "dead-letter" },
});

const NOW = () => new Date("2026-05-17T12:00:00.000Z");

describe("PostgresEntityEventSink", () => {
  it("enqueues pending runs for jobs whose eventName matches the emitted event", async () => {
    const calls: Call[] = [];
    const enqueued: Array<{ name: string; ids: readonly string[] }> = [];
    const sink = new PostgresEntityEventSink(mockConn(calls), [orderPlacedJob], {
      now: NOW,
      onEnqueue: (e, ids) => enqueued.push({ name: e.name, ids }),
    });

    await sink.emit(event("salesorder.placed"));

    const ins = inserts(calls);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.params?.[0]).toBe(TENANT);
    // Nothing but that insert and its tenant context is issued.
    expect(calls).toHaveLength(ins.length + contexts(calls).length);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.name).toBe("salesorder.placed");
    expect(enqueued[0]!.ids).toHaveLength(1);
  });

  it("enqueues nothing when no job matches the event name", async () => {
    const calls: Call[] = [];
    const sink = new PostgresEntityEventSink(mockConn(calls), [orderPlacedJob], { now: NOW });
    await sink.emit(event("salesorder.returned"));
    // Not one statement, so no transaction is opened and no context is set when nothing is planned.
    expect(calls).toHaveLength(0);
  });

  it("establishes the tenant RLS context, with the tenant bound rather than interpolated", async () => {
    const calls: Call[] = [];
    const sink = new PostgresEntityEventSink(mockConn(calls), [orderPlacedJob], { now: NOW });
    await sink.emit(event("salesorder.placed"));

    // `meta.job_runs` carries exactly one ALL-scope isolation policy with a NULL WITH CHECK, so its
    // USING doubles as the write check: with no context the predicate is `tenant_id = NULL`, never
    // true, and the INSERT is refused 42501 as any role but the table's owner (ADR-0389). This sink
    // swallows its failures by design, so without the context every served entity write silently
    // enqueued nothing.
    const ctx = contexts(calls);
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.sql).toBe(SET_TENANT_CONTEXT_SQL);
    // Bound as `$1`, never interpolated — a tenant id must not reach SQL text.
    expect(ctx[0]!.params).toEqual([TENANT]);
    expect(ctx[0]!.sql).not.toContain(TENANT);
    expect(ctx[0]!.sql).toContain("$1");
    // And it precedes the insert it exists to admit.
    expect(calls.indexOf(ctx[0]!)).toBeLessThan(calls.indexOf(inserts(calls)[0]!));
  });

  it("is best-effort: an enqueue failure is routed to onError and never thrown", async () => {
    const errors: unknown[] = [];
    const sink = new PostgresEntityEventSink(mockConn([], { throws: true }), [orderPlacedJob], {
      now: NOW,
      onError: (e) => errors.push(e),
    });
    await expect(sink.emit(event("salesorder.placed"))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("db down");
  });
});
