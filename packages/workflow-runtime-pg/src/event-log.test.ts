import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { WorkflowEvent } from "@crossengin/workflow-engine";
import { describe, expect, it, vi } from "vitest";

import { PostgresEventLog, UnreadableEventRowsError } from "./event-log.js";
import { WorkflowInstanceIdResolver } from "./id-mapping.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000111";

function fixtureEvent(o: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    id: o.id ?? "wfe_event0001",
    instanceId: o.instanceId ?? "wfi_inst0001",
    tenantId: o.tenantId ?? TENANT,
    sequenceNumber: o.sequenceNumber ?? 0,
    kind: o.kind ?? "instance_started",
    occurredAt: o.occurredAt ?? "2026-05-16T12:00:00.000Z",
    actorPrincipalId: o.actorPrincipalId ?? null,
    actorSystemId: o.actorSystemId ?? "engine",
    previousState: o.previousState ?? null,
    newState: o.newState ?? null,
    activityId: o.activityId ?? null,
    signalId: o.signalId ?? null,
    timerId: o.timerId ?? null,
    childInstanceId: o.childInstanceId ?? null,
    variableName: o.variableName ?? null,
    payload: o.payload ?? {},
    correlationId: o.correlationId ?? null,
    causationEventId: o.causationEventId ?? null,
  };
}

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult<Record<string, unknown>>,
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return handler(sql, params);
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function buildEventLog(): {
  log: PostgresEventLog;
  resolver: WorkflowInstanceIdResolver;
  capture: Array<{ sql: string; params: readonly unknown[] | undefined }>;
} {
  const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
  const resolver = new WorkflowInstanceIdResolver(conn);
  resolver.register("wfi_inst0001", INSTANCE_UUID);
  return { log: new PostgresEventLog({ conn, instanceResolver: resolver }), resolver, capture };
}

describe("PostgresEventLog.append", () => {
  it("inserts a row with the resolved UUID + JSON payload", async () => {
    const { log, capture } = buildEventLog();
    await log.append(fixtureEvent({ payload: { definitionId: "wfd_x" } }));
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.workflow_events"));
    expect(insert).toBeDefined();
    expect(insert?.params?.[0]).toBe("wfe_event0001");
    expect(insert?.params?.[1]).toBe(INSTANCE_UUID);
    expect(insert?.params?.[2]).toBe(TENANT);
    expect(insert?.params?.[3]).toBe(0);
    expect(insert?.params?.[4]).toBe("instance_started");
    expect(typeof insert?.params?.[15]).toBe("string");
    const payloadJson = JSON.parse(insert?.params?.[15] as string) as Record<string, unknown>;
    expect(payloadJson["definitionId"]).toBe("wfd_x");
  });

  it("rejects when instance row does not exist", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.workflow_instances")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    }, capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    await expect(log.append(fixtureEvent({ instanceId: "wfi_unknown01" }))).rejects.toThrow(
      /workflow instance not found/,
    );
  });
});

describe("PostgresEventLog.appendBatch", () => {
  it("appends events one-by-one (preserving order)", async () => {
    const { log, capture } = buildEventLog();
    await log.appendBatch([
      fixtureEvent({ id: "wfe_e1", sequenceNumber: 0 }),
      fixtureEvent({ id: "wfe_e2", sequenceNumber: 1, kind: "state_transitioned", newState: "approved" }),
    ]);
    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO meta.workflow_events"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.params?.[0]).toBe("wfe_e1");
    expect(inserts[1]?.params?.[0]).toBe("wfe_e2");
  });
});

describe("PostgresEventLog.listByInstance", () => {
  it("returns [] when the instance UUID can't be resolved", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.listByInstance("wfi_unknown01")).toEqual([]);
  });

  it("maps rows back to WorkflowEvent objects", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.workflow_events")) {
        return {
          rows: [
            {
              event_id: "wfe_event0001",
              tenant_id: TENANT,
              sequence_number: 0,
              kind: "instance_started",
              occurred_at: "2026-05-16T12:00:00.000Z",
              actor_principal_id: null,
              actor_system_id: "engine",
              previous_state: null,
              new_state: null,
              activity_id: null,
              signal_id: null,
              timer_id: null,
              child_instance_id: null,
              variable_name: null,
              payload: { definitionId: "wfd_x" },
              correlation_id: null,
              causation_event_id: null,
              instance_text_id: "wfi_inst0001",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }, capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    const events = await log.listByInstance("wfi_inst0001");
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("wfe_event0001");
    expect(events[0]?.instanceId).toBe("wfi_inst0001");
    expect((events[0]?.payload as Record<string, unknown>)["definitionId"]).toBe("wfd_x");
  });

  // The case every offline fake in this repo could not produce, and so the reason the defect lived:
  // node-postgres returns `occurred_at` as a `Date`, and a `WorkflowEvent.occurredAt` holding one
  // put a `Date` into every timestamp the projection derives from an event.
  it("renders a Date occurred_at as ISO text, keeping its milliseconds", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.workflow_events")) {
        return {
          rows: [
            {
              event_id: "wfe_event0001",
              tenant_id: TENANT,
              sequence_number: 0,
              kind: "instance_started",
              occurred_at: new Date("2026-05-16T12:00:00.456Z"),
              actor_principal_id: null,
              actor_system_id: null,
              previous_state: null,
              new_state: null,
              activity_id: null,
              signal_id: null,
              timer_id: null,
              child_instance_id: null,
              variable_name: null,
              payload: {},
              correlation_id: null,
              causation_event_id: null,
              instance_text_id: "wfi_inst0001",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    const events = await log.listByInstance("wfi_inst0001");
    expect(typeof events[0]?.occurredAt).toBe("string");
    expect(events[0]?.occurredAt).toBe("2026-05-16T12:00:00.456Z");
  });

  it("refuses a row whose NOT NULL occurred_at is absent", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.workflow_events")) {
        return {
          rows: [
            {
              event_id: "wfe_event0001",
              tenant_id: TENANT,
              sequence_number: 0,
              kind: "instance_started",
              occurred_at: null,
              payload: {},
              instance_text_id: "wfi_inst0001",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    await expect(log.listByInstance("wfi_inst0001")).rejects.toThrow(
      /missing required timestamp: occurred_at/,
    );
  });

  it("parses JSON-string payloads from libpq", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("FROM meta.workflow_events")) {
        return {
          rows: [
            {
              event_id: "wfe_event0001",
              tenant_id: TENANT,
              sequence_number: 0,
              kind: "instance_started",
              occurred_at: "2026-05-16T12:00:00.000Z",
              actor_principal_id: null,
              actor_system_id: null,
              previous_state: null,
              new_state: null,
              activity_id: null,
              signal_id: null,
              timer_id: null,
              child_instance_id: null,
              variable_name: null,
              payload: '{"a":42}',
              correlation_id: null,
              causation_event_id: null,
              instance_text_id: "wfi_inst0001",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    const events = await log.listByInstance("wfi_inst0001");
    expect((events[0]?.payload as Record<string, unknown>)["a"]).toBe(42);
  });
});

describe("PostgresEventLog reports a row it cannot represent", () => {
  /** One stored row in the spelling the `SELECT` aliases its columns to. */
  const eventRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    event_id: "wfe_event0001",
    tenant_id: TENANT,
    sequence_number: 0,
    kind: "instance_started",
    occurred_at: "2026-05-16T12:00:00.000Z",
    actor_principal_id: null,
    actor_system_id: "engine",
    previous_state: null,
    new_state: null,
    activity_id: null,
    signal_id: null,
    timer_id: null,
    child_instance_id: null,
    variable_name: null,
    payload: {},
    correlation_id: null,
    causation_event_id: null,
    instance_text_id: "wfi_inst0001",
    ...over,
  });

  function logOver(rows: readonly Record<string, unknown>[]): PostgresEventLog {
    const conn = mockConnection((sql) =>
      sql.includes("FROM meta.workflow_events")
        ? { rows: [...rows], rowCount: rows.length }
        : { rows: [], rowCount: 0 },
    );
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    return new PostgresEventLog({ conn, instanceResolver: resolver });
  }

  it("refuses an unknown kind, which used to be cast and folded away in silence", async () => {
    // `projectInstance` ignores a kind it does not recognise, so such a row was a hole the fold
    // could not see — the same class as a row that throws, in the direction that reports success.
    await expect(
      logOver([eventRow({ event_id: "wfe_bad00001", kind: "instance_teleported" })]).listByInstance(
        "wfi_inst0001",
      ),
    ).rejects.toThrow(/not a declared workflow event kind/);
  });

  it("refuses rather than fold a short log, because a fold is every other caller", async () => {
    // A projection rebuilt from a log with a hole in it is a projection of a different log that
    // reports success. `ProjectingEventLog.persistProjections` re-reads this on *every* append.
    await expect(
      logOver([eventRow(), eventRow({ event_id: "wfe_bad00002", occurred_at: null })]).listByInstance(
        "wfi_inst0001",
      ),
    ).rejects.toThrow(UnreadableEventRowsError);
  });

  it("the refusal names every unreadable row, where the mapper's throw named the first", async () => {
    // Two different refusals, which is the whole of what this mapper can refuse: a NOT NULL
    // timestamp that is absent, and a `kind` outside `EVENT_KINDS`. The other sixteen fields are
    // typed by `interface Row` and checked by `pg-record-reads.ts` rather than at runtime — see
    // `readEventRows` for why that trade was taken deliberately.
    const err = await logOver([
      eventRow({ event_id: "wfe_bad00003", occurred_at: null }),
      eventRow({ event_id: "wfe_bad00004", kind: "instance_teleported" }),
    ])
      .listByInstance("wfi_inst0001")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreadableEventRowsError);
    const rows = (err as UnreadableEventRowsError).unreadable;
    expect(rows.map((r) => r.identity)).toEqual(["wfe_bad00003", "wfe_bad00004"]);
  });

  it("listByInstanceWithUnreadable keeps the readable events and reports the rest", async () => {
    const read = await logOver([
      eventRow(),
      eventRow({ event_id: "wfe_bad00005", kind: "instance_teleported" }),
    ]).listByInstanceWithUnreadable("wfi_inst0001");
    expect(read.records.map((e) => e.id)).toEqual(["wfe_event0001"]);
    expect(read.unreadable).toEqual([
      {
        identity: "wfe_bad00005",
        detail: "row column kind is not a declared workflow event kind",
      },
    ]);
  });

  it("discloses no value from the refused row beyond its business key", async () => {
    const read = await logOver([
      eventRow({
        event_id: "wfe_bad00006",
        kind: "instance_teleported",
        correlation_id: "ord-88731",
        payload: { patientMrn: "MRN-1" },
      }),
    ]).listByInstanceWithUnreadable("wfi_inst0001");
    const rendered = JSON.stringify(read.unreadable);
    expect(rendered).toContain("wfe_bad00006");
    expect(rendered).not.toContain("instance_teleported");
    expect(rendered).not.toContain("ord-88731");
    expect(rendered).not.toContain("MRN-1");
  });

  it("admits it cannot name a row whose own event_id is what is wrong", async () => {
    const read = await logOver([
      eventRow({ event_id: null, occurred_at: null }),
    ]).listByInstanceWithUnreadable("wfi_inst0001");
    expect(read.unreadable[0]?.identity).toBeNull();
  });

  it("both forms ask the database the identical question", async () => {
    // The sibling exists to change what is done with a refused row, not what is asked — so a
    // predicate or an ORDER BY added to one and not the other fails here.
    const plainCapture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const pairedCapture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    for (const capture of [plainCapture, pairedCapture]) {
      const conn = mockConnection(() => ({ rows: [], rowCount: 0 }), capture);
      const resolver = new WorkflowInstanceIdResolver(conn);
      resolver.register("wfi_inst0001", INSTANCE_UUID);
      const log = new PostgresEventLog({ conn, instanceResolver: resolver });
      if (capture === plainCapture) await log.listByInstance("wfi_inst0001");
      else await log.listByInstanceWithUnreadable("wfi_inst0001");
    }
    expect(pairedCapture.map((c) => c.sql)).toEqual(plainCapture.map((c) => c.sql));
    expect(pairedCapture.map((c) => c.params)).toEqual(plainCapture.map((c) => c.params));
  });
});

describe("PostgresEventLog.latestSequence", () => {
  it("returns null when the instance is unknown", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.latestSequence("wfi_unknown01")).toBeNull();
  });

  it("returns the max sequence_number for the instance", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("MAX(sequence_number)")) {
        return { rows: [{ max: 7 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.latestSequence("wfi_inst0001")).toBe(7);
  });

  it("returns null when MAX(sequence_number) is null (no events yet)", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("MAX(sequence_number)")) {
        return { rows: [{ max: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.latestSequence("wfi_inst0001")).toBeNull();
  });
});

describe("PostgresEventLog.count", () => {
  it("returns the workflow_events total", async () => {
    const conn = mockConnection((sql) => {
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "13" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.count()).toBe(13);
  });

  it("returns 0 when no row is returned", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new WorkflowInstanceIdResolver(conn);
    const log = new PostgresEventLog({ conn, instanceResolver: resolver });
    expect(await log.count()).toBe(0);
  });
});
