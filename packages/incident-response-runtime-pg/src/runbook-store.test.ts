import { describe, expect, it } from "vitest";
import {
  RunbookExecutionSchema,
  type RunbookExecution,
} from "@crossengin/incident-response";

import {
  PostgresRunbookExecutionStore,
  RUNBOOK_EXECUTION_COLUMN_NAMES,
  RUNBOOK_EXECUTION_JSONB_COLUMNS,
  RunbookExecutionNotFoundError,
  rowToRunbookExecution,
  runbookExecutionPlaceholders,
  runbookExecutionRowValues,
  runbookExecutionUpdateAssignments,
} from "./runbook-store.js";
import { EMPTY, mockConnection, respondTo, type Captured } from "./test-fakes.js";

const T0 = "2026-09-30T10:00:00.000Z";
const T1 = "2026-09-30T10:05:00.000Z";
const T2 = "2026-09-30T10:09:00.000Z";

function execution(over: Record<string, unknown> = {}): RunbookExecution {
  return RunbookExecutionSchema.parse({
    id: "rbx-0001",
    incidentId: "INC-2026-0007",
    runbookId: "RB-0042",
    runbookVersion: "1.2.0",
    invokedAt: T0,
    invokedBy: "operate-server",
    status: "queued",
    ...over,
  });
}

const PASSED_STEP = {
  stepNumber: 1,
  title: "Drain the pool",
  startedAt: T1,
  completedAt: T2,
  outcome: "passed",
  executedByUserId: "oncall-1",
};

function succeeded(over: Record<string, unknown> = {}): RunbookExecution {
  return execution({
    status: "succeeded",
    startedAt: T1,
    completedAt: T2,
    durationSeconds: 240,
    steps: [PASSED_STEP],
    ...over,
  });
}

/** The row a stored execution comes back as, built through the projection the store writes. */
function executionRow(record: RunbookExecution): Record<string, unknown> {
  const values = runbookExecutionRowValues(record);
  const row: Record<string, unknown> = {};
  RUNBOOK_EXECUTION_COLUMN_NAMES.forEach((col, i) => {
    row[col] = values[i];
  });
  return row;
}

describe("column projection", () => {
  it("places the business key first, so an UPDATE can match on $1", () => {
    expect(RUNBOOK_EXECUTION_COLUMN_NAMES[0]).toBe("execution_id");
  });

  it("supplies exactly one value per column", () => {
    expect(runbookExecutionRowValues(succeeded())).toHaveLength(
      RUNBOOK_EXECUTION_COLUMN_NAMES.length,
    );
  });

  it("casts only the JSONB columns", () => {
    const placeholders = runbookExecutionPlaceholders().split(", ");
    placeholders.forEach((p, i) => {
      const col = RUNBOOK_EXECUTION_COLUMN_NAMES[i] ?? "";
      expect(p.endsWith("::jsonb")).toBe(RUNBOOK_EXECUTION_JSONB_COLUMNS.has(col));
    });
  });

  it("omits the key from the UPDATE assignments and starts them at $2", () => {
    const assignments = runbookExecutionUpdateAssignments();
    expect(assignments).not.toContain("execution_id =");
    expect(assignments.startsWith("incident_id = $2")).toBe(true);
  });

  it("assigns every non-key column exactly once", () => {
    expect(runbookExecutionUpdateAssignments().split(", ")).toHaveLength(
      RUNBOOK_EXECUTION_COLUMN_NAMES.length - 1,
    );
  });

  it("binds an absent abortedReason as NULL", () => {
    const values = runbookExecutionRowValues(execution());
    expect(values[RUNBOOK_EXECUTION_COLUMN_NAMES.indexOf("aborted_reason")]).toBeNull();
  });

  it("refuses to project a record the contract rejects", () => {
    const bad = { ...execution(), status: "aborted" } as RunbookExecution;
    expect(() => runbookExecutionRowValues(bad)).toThrow(/abortedAt/);
  });
});

describe("insert", () => {
  it("writes every column with the derived placeholder list", async () => {
    const capture: Captured[] = [];
    const store = new PostgresRunbookExecutionStore(mockConnection(capture));
    const record = succeeded();
    expect(await store.insert(record)).toBe(record);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.incident_runbook_executions");
    expect(capture[0]?.sql).toContain(RUNBOOK_EXECUTION_COLUMN_NAMES.join(", "));
    expect(capture[0]?.params).toHaveLength(RUNBOOK_EXECUTION_COLUMN_NAMES.length);
  });

  it("binds the contract id into execution_id, not the surrogate uuid", async () => {
    const capture: Captured[] = [];
    await new PostgresRunbookExecutionStore(mockConnection(capture)).insert(execution());
    expect(capture[0]?.params?.[0]).toBe("rbx-0001");
  });

  it("refuses an invalid record before any SQL runs", async () => {
    const capture: Captured[] = [];
    const store = new PostgresRunbookExecutionStore(mockConnection(capture));
    const bad = { ...succeeded(), steps: [] } as RunbookExecution;
    await expect(store.insert(bad)).rejects.toThrow(/step results/);
    expect(capture).toHaveLength(0);
  });
});

describe("update", () => {
  it("matches on execution_id and assigns the remaining columns", async () => {
    const capture: Captured[] = [];
    await new PostgresRunbookExecutionStore(mockConnection(capture)).update(succeeded());
    expect(capture[0]?.sql).toContain("UPDATE meta.incident_runbook_executions SET");
    expect(capture[0]?.sql).toContain("WHERE execution_id = $1");
  });

  it("binds the same value list as an insert, with no extra guard parameter", async () => {
    const capture: Captured[] = [];
    const record = succeeded();
    await new PostgresRunbookExecutionStore(mockConnection(capture)).update(record);
    expect(capture[0]?.params).toEqual(runbookExecutionRowValues(record));
  });

  it("treats a zero-row update as a missing row, named in the error", async () => {
    const conn = mockConnection(undefined, respondTo([["UPDATE", EMPTY]]));
    const store = new PostgresRunbookExecutionStore(conn);
    await expect(store.update(succeeded())).rejects.toThrow(RunbookExecutionNotFoundError);
    await expect(store.update(succeeded())).rejects.toThrow(/'rbx-0001'/);
  });

  it("refuses an invalid transition target before any SQL runs", async () => {
    const capture: Captured[] = [];
    const store = new PostgresRunbookExecutionStore(mockConnection(capture));
    const bad = { ...execution(), status: "running", startedAt: null } as RunbookExecution;
    await expect(store.update(bad)).rejects.toThrow(/startedAt/);
    expect(capture).toHaveLength(0);
  });
});

describe("load", () => {
  it("selects by execution_id and round-trips the record", async () => {
    const record = succeeded();
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["SELECT", { rows: [executionRow(record)], rowCount: 1 }]]),
    );
    const loaded = await new PostgresRunbookExecutionStore(conn).load("rbx-0001");
    expect(loaded).toEqual(record);
    expect(capture[0]?.params).toEqual(["rbx-0001"]);
  });

  it("returns null for a missing execution", async () => {
    const conn = mockConnection(undefined, respondTo([["SELECT", EMPTY]]));
    expect(await new PostgresRunbookExecutionStore(conn).load("rbx-9999")).toBeNull();
  });
});

describe("listForIncident", () => {
  it("filters by incident and orders by invocation time", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresRunbookExecutionStore(conn).listForIncident("INC-2026-0007", 5);
    expect(capture[0]?.sql).toContain("WHERE incident_id = $1");
    expect(capture[0]?.sql).toContain("ORDER BY invoked_at ASC");
    expect(capture[0]?.params).toEqual(["INC-2026-0007", 5]);
  });

  it("defaults the limit to 100", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresRunbookExecutionStore(conn).listForIncident("INC-2026-0007");
    expect(capture[0]?.params?.[1]).toBe(100);
  });

  it("rejects a non-positive limit before querying", async () => {
    const capture: Captured[] = [];
    const store = new PostgresRunbookExecutionStore(mockConnection(capture));
    await expect(store.listForIncident("INC-2026-0007", 0)).rejects.toThrow(/positive/);
    expect(capture).toHaveLength(0);
  });

  it("re-validates every row it returns", async () => {
    const record = succeeded();
    const conn = mockConnection(
      undefined,
      respondTo([["SELECT", { rows: [executionRow(record), executionRow(execution())], rowCount: 2 }]]),
    );
    const rows = await new PostgresRunbookExecutionStore(conn).listForIncident("INC-2026-0007");
    expect(rows.map((r) => r.status)).toEqual(["succeeded", "queued"]);
  });
});

describe("listUnfinished", () => {
  it("selects only the non-terminal statuses", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresRunbookExecutionStore(conn).listUnfinished();
    expect(capture[0]?.sql).toContain("status IN ('queued', 'running', 'paused')");
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresRunbookExecutionStore(mockConnection());
    await expect(store.listUnfinished(-1)).rejects.toThrow(/positive/);
  });
});

describe("rowToRunbookExecution re-validation", () => {
  it("accepts a row the store itself wrote", () => {
    const record = succeeded();
    expect(rowToRunbookExecution(executionRow(record))).toEqual(record);
  });

  it("omits an absent abortedReason rather than reading it back as null", () => {
    const loaded = rowToRunbookExecution(executionRow(execution()));
    expect("abortedReason" in loaded).toBe(false);
  });

  it("round-trips an optional field that is present", () => {
    const record = execution({ artifactStorageUri: "s3://runs/rbx-0001" });
    const loaded = rowToRunbookExecution(executionRow(record));
    expect(loaded.artifactStorageUri).toBe("s3://runs/rbx-0001");
    expect("abortedReason" in loaded).toBe(false);
  });

  it("reads TIMESTAMPTZ columns handed back as Date objects", () => {
    const row = { ...executionRow(succeeded()), invoked_at: new Date(T0) };
    expect(rowToRunbookExecution(row).invokedAt).toBe(T0);
  });

  it("reads steps handed back as JSON text or as a parsed array alike", () => {
    const row = executionRow(succeeded());
    const parsed = { ...row, steps: JSON.parse(String(row["steps"])) as unknown };
    expect(rowToRunbookExecution(parsed)).toEqual(rowToRunbookExecution(row));
  });

  it("refuses a succeeded row whose steps were emptied by hand", () => {
    const row = { ...executionRow(succeeded()), steps: "[]" };
    expect(() => rowToRunbookExecution(row)).toThrow(/step results/);
  });

  it("refuses a succeeded row holding a failed step — a CHECK constraint cannot see this", () => {
    const row = {
      ...executionRow(succeeded()),
      steps: JSON.stringify([{ ...PASSED_STEP, outcome: "failed" }]),
    };
    expect(() => rowToRunbookExecution(row)).toThrow(/non-failed/);
  });

  it("refuses an aborted row with no reason", () => {
    const row = {
      ...executionRow(execution({ status: "aborted", abortedAt: T2, abortedReason: "stopped" })),
      aborted_reason: null,
    };
    expect(() => rowToRunbookExecution(row)).toThrow(/abortedReason/);
  });

  it("refuses a running row with no started_at", () => {
    const row = {
      ...executionRow(execution({ status: "running", startedAt: T1 })),
      started_at: null,
    };
    expect(() => rowToRunbookExecution(row)).toThrow(/startedAt/);
  });

  it("refuses a failed row with no durationSeconds", () => {
    const row = {
      ...executionRow(execution({
        status: "failed",
        startedAt: T1,
        completedAt: T2,
        durationSeconds: 240,
      })),
      duration_seconds: null,
    };
    expect(() => rowToRunbookExecution(row)).toThrow(/durationSeconds/);
  });

  it("refuses duplicate step numbers inside the JSONB blob", () => {
    const row = {
      ...executionRow(succeeded()),
      steps: JSON.stringify([PASSED_STEP, { ...PASSED_STEP, title: "Again" }]),
    };
    expect(() => rowToRunbookExecution(row)).toThrow(/duplicate stepNumber/);
  });

  it("refuses a manual_override step with no notes", () => {
    const row = {
      ...executionRow(succeeded()),
      steps: JSON.stringify([{ ...PASSED_STEP, outcome: "manual_override" }]),
    };
    expect(() => rowToRunbookExecution(row)).toThrow(/manual_override outcome requires notes/);
  });

  it("refuses a step completed before it started", () => {
    const row = {
      ...executionRow(succeeded()),
      steps: JSON.stringify([{ ...PASSED_STEP, startedAt: T2, completedAt: T1 }]),
    };
    expect(() => rowToRunbookExecution(row)).toThrow(/before startedAt/);
  });
});
