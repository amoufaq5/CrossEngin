import { describe, expect, it } from "vitest";
import {
  BACKFILL_STATUSES,
  BackfillJobSchema,
  BackfillLedgerEntrySchema,
  CONFLICT_RESOLUTIONS,
  LEDGER_OUTCOMES,
  backfillProgressPercent,
  canTransitionBackfill,
  isTerminal,
  ledgerOutcomeRate,
  type BackfillJob,
  type BackfillLedgerEntry,
} from "./backfill.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("BACKFILL_STATUSES has 7 entries", () => {
    expect(BACKFILL_STATUSES).toContain("completed_with_errors");
    expect(BACKFILL_STATUSES).toContain("paused");
  });

  it("CONFLICT_RESOLUTIONS has 4 entries", () => {
    expect(CONFLICT_RESOLUTIONS).toEqual([
      "skip_duplicate",
      "overwrite_existing",
      "fail_on_conflict",
      "merge_fields",
    ]);
  });

  it("LEDGER_OUTCOMES has 5 entries", () => {
    expect(LEDGER_OUTCOMES).toContain("inserted");
    expect(LEDGER_OUTCOMES).toContain("merged");
  });
});

describe("canTransitionBackfill", () => {
  it("queued -> running", () => {
    expect(canTransitionBackfill("queued", "running")).toBe(true);
  });

  it("running -> paused", () => {
    expect(canTransitionBackfill("running", "paused")).toBe(true);
  });

  it("running -> completed_with_errors", () => {
    expect(canTransitionBackfill("running", "completed_with_errors")).toBe(true);
  });

  it("failed -> running (retry)", () => {
    expect(canTransitionBackfill("failed", "running")).toBe(true);
  });

  it("completed is terminal", () => {
    expect(canTransitionBackfill("completed", "running")).toBe(false);
  });
});

describe("BackfillJobSchema", () => {
  const base: BackfillJob = {
    id: "job-1",
    tenantId: "t-1",
    sourceId: "src-1",
    mappingId: "map-1",
    status: "completed",
    conflictResolution: "skip_duplicate",
    batchSize: 500,
    parallelism: 4,
    queuedAt: "2026-05-14T10:00:00Z",
    startedAt: "2026-05-14T10:00:30Z",
    completedAt: "2026-05-14T10:30:00Z",
    durationSeconds: 1770,
    rowsProcessed: 1000,
    rowsInserted: 950,
    rowsUpdated: 50,
    rowsSkipped: 0,
    rowsFailed: 0,
    requestedBy: "u-1",
    cancelledBy: null,
  };

  it("accepts a valid completed job", () => {
    expect(() => BackfillJobSchema.parse(base)).not.toThrow();
  });

  it("rejects completed with rowsFailed > 0", () => {
    expect(() => BackfillJobSchema.parse({ ...base, rowsFailed: 5 })).toThrow(
      /use 'completed_with_errors'/,
    );
  });

  it("rejects completed_with_errors with rowsFailed=0", () => {
    expect(() =>
      BackfillJobSchema.parse({
        ...base,
        status: "completed_with_errors",
        rowsFailed: 0,
      }),
    ).toThrow(/rowsFailed > 0/);
  });

  it("rejects failed without lastError", () => {
    expect(() =>
      BackfillJobSchema.parse({
        ...base,
        status: "failed",
      }),
    ).toThrow(/lastError/);
  });

  it("rejects cancelled without cancelledBy + reason", () => {
    expect(() =>
      BackfillJobSchema.parse({
        ...base,
        status: "cancelled",
      }),
    ).toThrow(/cancelledBy/);
  });

  it("rejects running without startedAt", () => {
    expect(() =>
      BackfillJobSchema.parse({
        ...base,
        status: "running",
        startedAt: null,
        completedAt: null,
        rowsInserted: 50,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        rowsProcessed: 50,
      }),
    ).toThrow(/startedAt/);
  });

  it("rejects counter sum > rowsProcessed", () => {
    expect(() =>
      BackfillJobSchema.parse({
        ...base,
        rowsInserted: 600,
        rowsUpdated: 500,
      }),
    ).toThrow(/must not exceed rowsProcessed/);
  });
});

describe("BackfillLedgerEntrySchema", () => {
  const base: BackfillLedgerEntry = {
    backfillJobId: "job-1",
    sourceRowIndex: 0,
    idempotencyKey: "row-key-0",
    sourceRowSha256: SHA,
    targetEntity: "accounts",
    targetRowId: "row-uuid-1",
    outcome: "inserted",
    outcomeAt: "2026-05-14T10:01:00Z",
    retryCount: 0,
  };

  it("accepts a valid inserted entry", () => {
    expect(() => BackfillLedgerEntrySchema.parse(base)).not.toThrow();
  });

  it("rejects failed without errorMessage", () => {
    expect(() =>
      BackfillLedgerEntrySchema.parse({
        ...base,
        outcome: "failed",
        targetRowId: null,
      }),
    ).toThrow(/errorMessage/);
  });

  it("rejects inserted/updated/merged without targetRowId", () => {
    expect(() =>
      BackfillLedgerEntrySchema.parse({
        ...base,
        targetRowId: null,
      }),
    ).toThrow(/targetRowId/);
  });

  it("accepts skipped with errorMessage", () => {
    expect(() =>
      BackfillLedgerEntrySchema.parse({
        ...base,
        outcome: "skipped",
        targetRowId: null,
        errorMessage: "duplicate idempotency key",
      }),
    ).not.toThrow();
  });
});

describe("helpers", () => {
  const job: BackfillJob = {
    id: "job-1",
    tenantId: "t-1",
    sourceId: "src-1",
    mappingId: "map-1",
    status: "running",
    conflictResolution: "skip_duplicate",
    batchSize: 500,
    parallelism: 4,
    queuedAt: "2026-05-14T10:00:00Z",
    startedAt: "2026-05-14T10:00:30Z",
    completedAt: null,
    durationSeconds: null,
    totalRowsEstimate: 1000,
    rowsProcessed: 250,
    rowsInserted: 250,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    requestedBy: "u-1",
    cancelledBy: null,
  };

  it("backfillProgressPercent calculates from estimate", () => {
    expect(backfillProgressPercent(job)).toBe(25);
  });

  it("backfillProgressPercent returns null without estimate", () => {
    expect(backfillProgressPercent({ ...job, totalRowsEstimate: undefined })).toBeNull();
  });

  it("isTerminal returns true for completed states", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("completed_with_errors")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });

  it("ledgerOutcomeRate computes ratios", () => {
    const entries: BackfillLedgerEntry[] = [
      {
        backfillJobId: "j",
        sourceRowIndex: 0,
        idempotencyKey: "k0",
        sourceRowSha256: SHA,
        targetEntity: "x",
        targetRowId: "r0",
        outcome: "inserted",
        outcomeAt: "2026-05-14T10:00:00Z",
        retryCount: 0,
      },
      {
        backfillJobId: "j",
        sourceRowIndex: 1,
        idempotencyKey: "k1",
        sourceRowSha256: SHA,
        targetEntity: "x",
        targetRowId: null,
        outcome: "skipped",
        outcomeAt: "2026-05-14T10:00:00Z",
        retryCount: 0,
        errorMessage: "dup",
      },
    ];
    expect(ledgerOutcomeRate(entries, "inserted")).toBe(0.5);
    expect(ledgerOutcomeRate(entries, "skipped")).toBe(0.5);
    expect(ledgerOutcomeRate(entries, "failed")).toBe(0);
  });
});
