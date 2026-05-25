import { describe, expect, it } from "vitest";
import {
  PREVIEW_STATUSES,
  PreviewRowSchema,
  PreviewRunSchema,
  ROW_VALIDATION_OUTCOMES,
  canTransitionPreview,
  failureRate,
  summarizePreview,
  type PreviewRun,
} from "./previews.js";

describe("constants", () => {
  it("PREVIEW_STATUSES has 5 entries", () => {
    expect(PREVIEW_STATUSES).toEqual(["pending", "running", "completed", "failed", "cancelled"]);
  });

  it("ROW_VALIDATION_OUTCOMES has 6 entries", () => {
    expect(ROW_VALIDATION_OUTCOMES).toContain("valid");
    expect(ROW_VALIDATION_OUTCOMES).toContain("duplicate_idempotency_key");
  });
});

describe("canTransitionPreview", () => {
  it("pending -> running", () => {
    expect(canTransitionPreview("pending", "running")).toBe(true);
  });

  it("running -> completed", () => {
    expect(canTransitionPreview("running", "completed")).toBe(true);
  });

  it("completed is terminal", () => {
    expect(canTransitionPreview("completed", "running")).toBe(false);
  });

  it("running -> pending is not allowed", () => {
    expect(canTransitionPreview("running", "pending")).toBe(false);
  });
});

describe("PreviewRowSchema", () => {
  it("accepts a valid row", () => {
    expect(() =>
      PreviewRowSchema.parse({
        rowIndex: 0,
        outcome: "valid",
        issues: [],
      }),
    ).not.toThrow();
  });

  it("rejects valid outcome with issues", () => {
    expect(() =>
      PreviewRowSchema.parse({
        rowIndex: 0,
        outcome: "valid",
        issues: [{ field: "email", outcome: "type_mismatch", message: "x" }],
      }),
    ).toThrow(/must not have issues/);
  });

  it("rejects non-valid outcome without issues", () => {
    expect(() =>
      PreviewRowSchema.parse({
        rowIndex: 0,
        outcome: "type_mismatch",
        issues: [],
      }),
    ).toThrow(/at least one issue/);
  });
});

describe("PreviewRunSchema", () => {
  const base: PreviewRun = {
    id: "preview-1",
    tenantId: "t-1",
    sourceId: "csv-source",
    mappingId: "csv-mapping",
    status: "completed",
    requestedAt: "2026-05-14T10:00:00Z",
    requestedBy: "u-1",
    startedAt: "2026-05-14T10:00:01Z",
    completedAt: "2026-05-14T10:00:30Z",
    sampleSize: 100,
    rowsRead: 100,
    rowsValid: 95,
    rowsInvalid: 5,
    rowsSkipped: 0,
    rows: [],
  };

  it("accepts a valid completed run", () => {
    expect(() => PreviewRunSchema.parse(base)).not.toThrow();
  });

  it("rejects running without startedAt", () => {
    expect(() =>
      PreviewRunSchema.parse({
        ...base,
        status: "running",
        startedAt: null,
        completedAt: null,
      }),
    ).toThrow(/startedAt/);
  });

  it("rejects completed without completedAt", () => {
    expect(() => PreviewRunSchema.parse({ ...base, completedAt: null })).toThrow(/completedAt/);
  });

  it("rejects failed without errorMessage", () => {
    expect(() =>
      PreviewRunSchema.parse({
        ...base,
        status: "failed",
        completedAt: null,
      }),
    ).toThrow(/errorMessage/);
  });

  it("rejects counter sum > rowsRead", () => {
    expect(() =>
      PreviewRunSchema.parse({
        ...base,
        rowsValid: 60,
        rowsInvalid: 60,
      }),
    ).toThrow(/must not exceed rowsRead/);
  });

  it("rejects rowsRead > sampleSize", () => {
    expect(() => PreviewRunSchema.parse({ ...base, rowsRead: 200 })).toThrow(
      /must not exceed sampleSize/,
    );
  });

  it("rejects duplicate rowIndex", () => {
    expect(() =>
      PreviewRunSchema.parse({
        ...base,
        rows: [
          { rowIndex: 0, outcome: "valid", issues: [] },
          { rowIndex: 0, outcome: "valid", issues: [] },
        ],
      }),
    ).toThrow(/duplicate rowIndex/);
  });
});

describe("summarizePreview", () => {
  const base: PreviewRun = {
    id: "preview-1",
    tenantId: "t-1",
    sourceId: "csv-source",
    mappingId: "csv-mapping",
    status: "completed",
    requestedAt: "2026-05-14T10:00:00Z",
    requestedBy: "u-1",
    startedAt: "2026-05-14T10:00:01Z",
    completedAt: "2026-05-14T10:00:30Z",
    sampleSize: 100,
    rowsRead: 100,
    rowsValid: 99,
    rowsInvalid: 1,
    rowsSkipped: 0,
    rows: [
      { rowIndex: 0, outcome: "valid", issues: [] },
      {
        rowIndex: 1,
        outcome: "type_mismatch",
        issues: [{ field: "x", outcome: "type_mismatch", message: "x" }],
      },
    ],
  };

  it("readyToCommit when failure rate is below threshold", () => {
    expect(summarizePreview(base).readyToCommit).toBe(true);
  });

  it("not readyToCommit when failure rate exceeds threshold", () => {
    const bad = { ...base, rowsInvalid: 20, rowsValid: 80 };
    expect(summarizePreview(bad).readyToCommit).toBe(false);
  });

  it("not readyToCommit when status is failed", () => {
    const fail: PreviewRun = {
      ...base,
      status: "failed",
      errorMessage: "boom",
      completedAt: null,
    };
    expect(summarizePreview(fail).readyToCommit).toBe(false);
  });

  it("counts outcomes by category", () => {
    const r = summarizePreview(base);
    expect(r.issueByOutcome.valid).toBe(1);
    expect(r.issueByOutcome.type_mismatch).toBe(1);
  });
});

describe("failureRate", () => {
  it("returns 0 for empty run", () => {
    const run: PreviewRun = {
      id: "x",
      tenantId: "t",
      sourceId: "s",
      mappingId: "m",
      status: "pending",
      requestedAt: "2026-05-14T10:00:00Z",
      requestedBy: "u",
      startedAt: null,
      completedAt: null,
      sampleSize: 100,
      rowsRead: 0,
      rowsValid: 0,
      rowsInvalid: 0,
      rowsSkipped: 0,
      rows: [],
    };
    expect(failureRate(run)).toBe(0);
  });

  it("returns invalid/read ratio", () => {
    const run: PreviewRun = {
      id: "x",
      tenantId: "t",
      sourceId: "s",
      mappingId: "m",
      status: "completed",
      requestedAt: "2026-05-14T10:00:00Z",
      requestedBy: "u",
      startedAt: "2026-05-14T10:00:01Z",
      completedAt: "2026-05-14T10:00:30Z",
      sampleSize: 100,
      rowsRead: 100,
      rowsValid: 80,
      rowsInvalid: 20,
      rowsSkipped: 0,
      rows: [],
    };
    expect(failureRate(run)).toBe(0.2);
  });
});
