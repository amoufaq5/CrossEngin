import { describe, expect, it } from "vitest";
import {
  isReindexComplete,
  nextEngineToReindex,
  reindexPercentComplete,
  ReindexProgressSchema,
  ReindexRequestSchema,
} from "./reindex.js";

const now = "2026-05-13T10:00:00.000Z";

describe("ReindexRequestSchema", () => {
  it("parses a tenant-wide request", () => {
    const r = ReindexRequestSchema.parse({
      id: "r_1",
      tenantId: "t_1",
      engine: "typesense",
      scope: "tenant",
      reason: "drift_detected",
      requestedBy: "u_1",
      requestedAt: now,
    });
    expect(r.priority).toBe("normal");
  });

  it("requires scopeTarget for entity / file / manifest_section", () => {
    expect(() =>
      ReindexRequestSchema.parse({
        id: "r",
        tenantId: "t",
        engine: "postgres_fts",
        scope: "entity",
        reason: "admin_force_reindex",
        requestedBy: "u",
        requestedAt: now,
      }),
    ).toThrow(/requires scopeTarget/);
  });

  it("rejects tenant scope with scopeTarget", () => {
    expect(() =>
      ReindexRequestSchema.parse({
        id: "r",
        tenantId: "t",
        engine: "postgres_fts",
        scope: "tenant",
        scopeTarget: "Prescription",
        reason: "admin_force_reindex",
        requestedBy: "u",
        requestedAt: now,
      }),
    ).toThrow(/must not declare a scopeTarget/);
  });
});

describe("ReindexProgressSchema + helpers", () => {
  const base = {
    requestId: "r_1",
    status: "running" as const,
    itemsTotal: 100,
    itemsProcessed: 25,
    startedAt: now,
    completedAt: null,
    errorMessage: null,
  };

  it("computes percent complete", () => {
    const p = ReindexProgressSchema.parse(base);
    expect(reindexPercentComplete(p)).toBe(25);
  });

  it("isReindexComplete returns false while running", () => {
    expect(isReindexComplete(ReindexProgressSchema.parse(base))).toBe(false);
  });

  it("isReindexComplete returns true on completed / failed / cancelled", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const p = ReindexProgressSchema.parse({
        ...base,
        status,
        completedAt: now,
      });
      expect(isReindexComplete(p)).toBe(true);
    }
  });

  it("handles zero-items total without divide-by-zero", () => {
    const p = ReindexProgressSchema.parse({ ...base, itemsTotal: 0, itemsProcessed: 0 });
    expect(reindexPercentComplete(p)).toBe(0);
  });
});

describe("nextEngineToReindex", () => {
  it("returns the first unfinished engine", () => {
    expect(nextEngineToReindex(["postgres_fts", "pgvector", "typesense"], ["postgres_fts"])).toBe(
      "pgvector",
    );
  });

  it("returns null when every engine is finished", () => {
    expect(nextEngineToReindex(["postgres_fts"], ["postgres_fts"])).toBeNull();
  });
});
