import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { WorkflowDefinitionIdResolver, WorkflowInstanceIdResolver } from "./id-mapping.js";

function mockConnection(
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
  rowsByKey?: Record<string, Array<Record<string, unknown>>>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      if (capture !== undefined) capture.push({ sql, params });
      const key = (params?.[0] as string | undefined) ?? "";
      const rows = rowsByKey?.[key] ?? [];
      return { rows, rowCount: rows.length };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("WorkflowInstanceIdResolver — register / cache", () => {
  it("returns null when not registered and not in DB", async () => {
    const r = new WorkflowInstanceIdResolver(mockConnection());
    expect(await r.resolve("wfi_unknown01")).toBeNull();
  });

  it("returns the registered UUID without hitting the DB", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const r = new WorkflowInstanceIdResolver(mockConnection(capture));
    r.register("wfi_inst0001", "00000000-0000-4000-8000-000000000001");
    expect(await r.resolve("wfi_inst0001")).toBe("00000000-0000-4000-8000-000000000001");
    expect(capture).toHaveLength(0);
  });

  it("falls back to DB lookup + caches the result", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture, {
      wfi_inst0001: [{ id: "00000000-0000-4000-8000-000000000111" }],
    });
    const r = new WorkflowInstanceIdResolver(conn);
    expect(await r.resolve("wfi_inst0001")).toBe("00000000-0000-4000-8000-000000000111");
    expect(await r.resolve("wfi_inst0001")).toBe("00000000-0000-4000-8000-000000000111");
    expect(capture).toHaveLength(1);
  });

  it("invalidate clears a cached entry", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture, {
      wfi_inst0001: [{ id: "00000000-0000-4000-8000-000000000111" }],
    });
    const r = new WorkflowInstanceIdResolver(conn);
    await r.resolve("wfi_inst0001");
    r.invalidate("wfi_inst0001");
    await r.resolve("wfi_inst0001");
    expect(capture).toHaveLength(2);
  });

  it("size() tracks cache entries", () => {
    const r = new WorkflowInstanceIdResolver(mockConnection());
    r.register("wfi_a000000001", "uuid-a");
    r.register("wfi_b000000001", "uuid-b");
    expect(r.size()).toBe(2);
  });

  it("requireResolve throws when unknown", async () => {
    const r = new WorkflowInstanceIdResolver(mockConnection());
    await expect(r.requireResolve("wfi_unknown01")).rejects.toThrow(/workflow instance not found/);
  });
});

describe("WorkflowDefinitionIdResolver", () => {
  it("returns null when not registered and not in DB", async () => {
    const r = new WorkflowDefinitionIdResolver(mockConnection());
    expect(await r.resolve("wfd_unknown")).toBeNull();
  });

  it("returns the registered UUID without hitting the DB", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const r = new WorkflowDefinitionIdResolver(mockConnection(capture));
    r.register("wfd_def0001", "00000000-0000-4000-8000-000000000999");
    expect(await r.resolve("wfd_def0001")).toBe("00000000-0000-4000-8000-000000000999");
    expect(capture).toHaveLength(0);
  });

  it("queries workflow_definitions on cache miss", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(capture, {
      wfd_def0002: [{ id: "00000000-0000-4000-8000-000000000888" }],
    });
    const r = new WorkflowDefinitionIdResolver(conn);
    expect(await r.resolve("wfd_def0002")).toBe("00000000-0000-4000-8000-000000000888");
    expect(capture[0]?.sql).toContain("workflow_definitions");
    expect(capture[0]?.params).toEqual(["wfd_def0002"]);
  });

  it("requireResolve throws when unknown", async () => {
    const r = new WorkflowDefinitionIdResolver(mockConnection());
    await expect(r.requireResolve("wfd_unknown")).rejects.toThrow(/workflow definition not found/);
  });
});
