import { JobDeclarationSchema, type JobDeclaration } from "@crossengin/jobs";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { EntityEvent } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { PostgresEntityEventSink } from "./entity-events.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function mockConn(calls: Call[], opts: { throws?: boolean } = {}): PgConnection {
  return {
    query: (async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      calls.push({ sql, params });
      if (opts.throws === true) throw new Error("db down");
      return { rows: [{ run_id: params?.[3] }], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async () => undefined) as unknown as PgConnection["transaction"],
    withAdvisoryLock: (async () => undefined) as unknown as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
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

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("INSERT INTO meta.job_runs");
    expect(calls[0]!.params?.[0]).toBe(TENANT);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.name).toBe("salesorder.placed");
    expect(enqueued[0]!.ids).toHaveLength(1);
  });

  it("enqueues nothing when no job matches the event name", async () => {
    const calls: Call[] = [];
    const sink = new PostgresEntityEventSink(mockConn(calls), [orderPlacedJob], { now: NOW });
    await sink.emit(event("salesorder.returned"));
    expect(calls).toHaveLength(0);
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
