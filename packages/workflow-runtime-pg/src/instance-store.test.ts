import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { ProjectedInstance } from "@crossengin/workflow-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import {
  PostgresInstanceStore,
  cancellationProjectionFromRow,
  isoInstant,
  parseStringArray,
  type StoredCancellationColumns,
} from "./instance-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const DEF_UUID = "00000000-0000-4000-8000-000000000900";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000123";

function fixtureProjection(overrides: Partial<ProjectedInstance> = {}): ProjectedInstance {
  return {
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    definitionId: "wfd_def00001",
    definitionKey: "purchase.approval",
    definitionVersion: "1.0.0",
    status: "waiting_for_signal",
    currentState: "awaiting_approval",
    variables: { amount: 250 },
    correlationKey: "po-1",
    parentInstanceId: null,
    startedAt: "2026-05-16T12:00:00.000Z",
    startedByUserId: null,
    startedBySystem: "engine",
    lastTransitionAt: "2026-05-16T12:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancelledReason: null,
    // ADR-0329's cancellation fence and its disposition. The fence is distinct from `cancelledAt`:
    // it is set when the cancellation is *requested*, which is what stops a timer firing or a
    // signal transitioning the instance in the window before `instance_cancelled` is appended.
    cancellationRequestedAt: null,
    cancellationRequestedBy: null,
    cancellationDisposition: null,
    cancellationSignalledActivityIds: [],
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    suspendedAt: null,
    suspendedReason: null,
    compensationStartedAt: null,
    compensationCompletedAt: null,
    timeoutAt: "2026-05-17T12:00:00.000Z",
    sequenceCursor: 1,
    awaitingActivityIds: [],
    awaitingSignalNames: ["approve"],
    awaitingTimerNames: [],
    ...overrides,
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

describe("PostgresInstanceStore.create", () => {
  it("INSERTs and registers the resolved UUID", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("INSERT INTO meta.workflow_instances")) {
        return { rows: [{ id: INSTANCE_UUID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }, capture);
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    definitionResolver.register("wfd_def00001", DEF_UUID);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    const id = await store.create({
      projection: fixtureProjection(),
      definitionId: "wfd_def00001",
    });
    expect(id).toBe(INSTANCE_UUID);
    expect(await instanceResolver.resolve("wfi_inst0001")).toBe(INSTANCE_UUID);
    const insert = capture.find((c) => c.sql.includes("INSERT"));
    expect(insert?.params?.[0]).toBe("wfi_inst0001");
    expect(insert?.params?.[2]).toBe(DEF_UUID);
    expect(insert?.params?.[5]).toBe("waiting_for_signal");
  });

  it("serializes variables + awaiting arrays as JSON", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(
      () => ({ rows: [{ id: INSTANCE_UUID }], rowCount: 1 }),
      capture,
    );
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    definitionResolver.register("wfd_def00001", DEF_UUID);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await store.create({
      projection: fixtureProjection({
        variables: { amount: 250, currency: "USD" },
        awaitingActivityIds: ["wfa_a1"],
        awaitingSignalNames: ["approve", "reject"],
      }),
      definitionId: "wfd_def00001",
    });
    const insert = capture[0]!;
    expect(JSON.parse(insert.params?.[7] as string)).toEqual({ amount: 250, currency: "USD" });
    expect(JSON.parse(insert.params?.[16] as string)).toEqual(["wfa_a1"]);
    expect(JSON.parse(insert.params?.[17] as string)).toEqual(["approve", "reject"]);
  });

  it("threads relatedEntity when supplied", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(
      () => ({ rows: [{ id: INSTANCE_UUID }], rowCount: 1 }),
      capture,
    );
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    definitionResolver.register("wfd_def00001", DEF_UUID);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await store.create({
      projection: fixtureProjection(),
      definitionId: "wfd_def00001",
      relatedEntity: { kind: "purchase_request", id: "PR-001" },
    });
    expect(JSON.parse(capture[0]!.params?.[8] as string)).toEqual({
      kind: "purchase_request",
      id: "PR-001",
    });
  });

  it("rejects when definition UUID is unknown", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await expect(
      store.create({ projection: fixtureProjection(), definitionId: "wfd_unknown" }),
    ).rejects.toThrow(/workflow definition not found/);
  });

  it("throws when INSERT returns no row", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    definitionResolver.register("wfd_def00001", DEF_UUID);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await expect(
      store.create({ projection: fixtureProjection(), definitionId: "wfd_def00001" }),
    ).rejects.toThrow(/failed to insert/);
  });
});

describe("PostgresInstanceStore.upsertProjection", () => {
  it("UPDATEs the workflow_instances row by instance_id", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    const store = new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
    await store.upsertProjection(
      fixtureProjection({ status: "completed", completedAt: "2026-05-16T13:00:00.000Z" }),
    );
    const update = capture[0]!;
    expect(update.sql).toContain("UPDATE meta.workflow_instances");
    expect(update.sql).toContain("WHERE instance_id = $25");
    expect(update.params?.[0]).toBe("completed");
    expect(update.params?.[5]).toBe("2026-05-16T13:00:00.000Z");
    expect(update.params?.[24]).toBe("wfi_inst0001");
  });

  it("writes the cancellation fence, so it survives a restart", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const store = new PostgresInstanceStore({
      conn,
      instanceResolver: new WorkflowInstanceIdResolver(conn),
      definitionResolver: new WorkflowDefinitionIdResolver(conn),
    });
    await store.upsertProjection(
      fixtureProjection({
        cancellationRequestedAt: "2026-05-16T12:30:00.000Z",
        cancellationRequestedBy: "00000000-0000-4000-8000-0000000000aa",
        cancellationDisposition: "compensate",
        cancellationSignalledActivityIds: ["wfa_a1", "wfa_a2"],
      }),
    );
    const update = capture[0]!;
    for (const assignment of [
      "cancellation_requested_at = $21",
      "cancellation_requested_by = $22",
      "cancellation_disposition = $23",
      "cancellation_signalled_activity_ids = $24::jsonb",
    ]) {
      expect(update.sql).toContain(assignment);
    }
    expect(update.params?.[20]).toBe("2026-05-16T12:30:00.000Z");
    expect(update.params?.[21]).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(update.params?.[22]).toBe("compensate");
    expect(JSON.parse(update.params?.[23] as string)).toEqual(["wfa_a1", "wfa_a2"]);
  });

  it("writes an uncancelled instance's fence as NULL, never as a sentinel", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const store = new PostgresInstanceStore({
      conn,
      instanceResolver: new WorkflowInstanceIdResolver(conn),
      definitionResolver: new WorkflowDefinitionIdResolver(conn),
    });
    await store.upsertProjection(fixtureProjection());
    const update = capture[0]!;
    expect(update.params?.[20]).toBeNull();
    expect(update.params?.[21]).toBeNull();
    expect(update.params?.[22]).toBeNull();
    expect(JSON.parse(update.params?.[23] as string)).toEqual([]);
  });

  it("preserves the signalled order it was handed", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const store = new PostgresInstanceStore({
      conn,
      instanceResolver: new WorkflowInstanceIdResolver(conn),
      definitionResolver: new WorkflowDefinitionIdResolver(conn),
    });
    await store.upsertProjection(
      fixtureProjection({ cancellationSignalledActivityIds: ["wfa_z", "wfa_a", "wfa_m"] }),
    );
    // The order is the log's, and the replayer compares it as a sequence; a store that sorted here
    // would make every healthy instance read as drifted.
    expect(JSON.parse(capture[0]!.params?.[23] as string)).toEqual(["wfa_z", "wfa_a", "wfa_m"]);
  });
});

function storedCancellation(
  over: Partial<StoredCancellationColumns> = {},
): StoredCancellationColumns {
  return {
    cancellation_requested_at: null,
    cancellation_requested_by: null,
    cancellation_disposition: null,
    cancellation_signalled_activity_ids: [],
    ...over,
  };
}

describe("isoInstant", () => {
  it("normalises the Date node-postgres hands back for a TIMESTAMPTZ", () => {
    // The whole reason this exists: a `Date` compared to the projection's string with `!==` is
    // unequal, so every row with a timestamp set read as drifted.
    expect(isoInstant(new Date("2026-05-16T12:30:00.000Z"))).toBe("2026-05-16T12:30:00.000Z");
  });

  it("canonicalises an equivalent spelling, so an offset form matches a Z form", () => {
    expect(isoInstant("2026-05-16T12:30:00+00:00")).toBe("2026-05-16T12:30:00.000Z");
  });

  it("reads an absent timestamp as absent", () => {
    expect(isoInstant(null)).toBeNull();
    expect(isoInstant(undefined)).toBeNull();
  });

  it("returns an unparseable value as it stands, so it cannot match an absent one", () => {
    expect(isoInstant("not a date")).toBe("not a date");
    expect(isoInstant("not a date")).not.toBeNull();
    expect(isoInstant(new Date("nope"))).toBe("Invalid Date");
  });
});

describe("parseStringArray", () => {
  it("accepts a parsed array and a JSON string of one", () => {
    expect(parseStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(parseStringArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseStringArray([])).toEqual([]);
  });

  it("answers null for anything that is not an array of strings", () => {
    // `null`, not `[]`: an unreadable column and an empty list are different facts, and collapsing
    // them would make a tampered column compare equal on every instance that signalled nothing.
    expect(parseStringArray(null)).toBeNull();
    expect(parseStringArray(undefined)).toBeNull();
    expect(parseStringArray({})).toBeNull();
    expect(parseStringArray(3)).toBeNull();
    expect(parseStringArray("not json")).toBeNull();
    expect(parseStringArray(["a", 2])).toBeNull();
  });
});

describe("cancellationProjectionFromRow", () => {
  it("reads the fence back off a row", () => {
    expect(
      cancellationProjectionFromRow(
        storedCancellation({
          cancellation_requested_at: "2026-05-16T12:30:00.000Z",
          cancellation_requested_by: "engine",
          cancellation_disposition: "abandon",
          cancellation_signalled_activity_ids: ["wfa_a1"],
        }),
      ),
    ).toEqual({
      cancellationRequestedAt: "2026-05-16T12:30:00.000Z",
      cancellationRequestedBy: "engine",
      cancellationDisposition: "abandon",
      cancellationSignalledActivityIds: ["wfa_a1"],
    });
  });

  it("reads a Date-valued fence column, which is what a real row carries", () => {
    const read = cancellationProjectionFromRow(
      storedCancellation({ cancellation_requested_at: new Date("2026-05-16T12:30:00.000Z") }),
    );
    expect(read.cancellationRequestedAt).toBe("2026-05-16T12:30:00.000Z");
  });

  it("reads an uncancelled row as no fence at all", () => {
    expect(cancellationProjectionFromRow(storedCancellation())).toEqual({
      cancellationRequestedAt: null,
      cancellationRequestedBy: null,
      cancellationDisposition: null,
      cancellationSignalledActivityIds: [],
    });
  });

  it("accepts a system slug in requested_by, which is why the column is not a users reference", () => {
    const read = cancellationProjectionFromRow(
      storedCancellation({ cancellation_requested_by: "service_account:abc" }),
    );
    expect(read.cancellationRequestedBy).toBe("service_account:abc");
  });

  it("reads an unrecognised disposition as unknown, never as one of the two", () => {
    for (const value of ["rollback", "COMPENSATE", "", "1"]) {
      expect(
        cancellationProjectionFromRow(storedCancellation({ cancellation_disposition: value }))
          .cancellationDisposition,
      ).toBeNull();
    }
  });

  it("accepts both declared dispositions", () => {
    for (const value of ["compensate", "abandon"] as const) {
      expect(
        cancellationProjectionFromRow(storedCancellation({ cancellation_disposition: value }))
          .cancellationDisposition,
      ).toBe(value);
    }
  });

  it("keeps the stored order of the signalled ids rather than normalising it", () => {
    expect(
      cancellationProjectionFromRow(
        storedCancellation({ cancellation_signalled_activity_ids: ["wfa_z", "wfa_a"] }),
      ).cancellationSignalledActivityIds,
    ).toEqual(["wfa_z", "wfa_a"]);
  });
});

describe("PostgresInstanceStore.upsertProjection — whether a row was there", () => {
  function storeOver(rowCount: number): PostgresInstanceStore {
    const conn = mockConnection(() => ({ rows: [], rowCount }));
    const instanceResolver = new WorkflowInstanceIdResolver(conn);
    const definitionResolver = new WorkflowDefinitionIdResolver(conn);
    return new PostgresInstanceStore({ conn, instanceResolver, definitionResolver });
  }

  it("answers true when the UPDATE matched the instance's row", async () => {
    expect(await storeOver(1).upsertProjection(fixtureProjection())).toBe(true);
  });

  it("answers false when it matched nothing, rather than reading as success", async () => {
    // It is an UPDATE, so an absent instance row means it wrote nothing — and `UPDATE … WHERE
    // instance_id = $n` matching zero rows is indistinguishable from matching one unless the count
    // is read. ADR-0333's `INSERT 0 0` in a second place: the replayer used to report
    // `upserts.instance: true` here, i.e. claim the one repair it had not made.
    expect(await storeOver(0).upsertProjection(fixtureProjection())).toBe(false);
  });
});
