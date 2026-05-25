import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresArchitectProposalStore } from "./proposal-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);
const TS = "2026-05-17T12:00:00.000Z";

function mockConnection(
  handler: (
    sql: string,
    params: readonly unknown[] | undefined,
  ) => PgQueryResult<Record<string, unknown>>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) =>
      handler(sql, params),
    ) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function proposalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    tenant_id: TENANT,
    session_id: SESSION,
    tool_invocation_id: null,
    target_path: "/tmp/m.json",
    is_new: true,
    old_hash: null,
    new_hash: HASH,
    entities_added: 1,
    entities_removed: 0,
    entities_modified: 0,
    decision: "interactive_approved",
    applied: true,
    denial_reason: null,
    proposed_at: TS,
    decided_at: TS,
    ...overrides,
  };
}

describe("PostgresArchitectProposalStore.append", () => {
  it("inserts and returns an approved+applied proposal", async () => {
    const conn = mockConnection((sql, params) => {
      expect(sql).toContain("INSERT INTO meta.architect_proposals");
      expect(params?.[10]).toBe("interactive_approved");
      expect(params?.[11]).toBe(true);
      return { rows: [proposalRow()], rowCount: 1 };
    });
    const store = new PostgresArchitectProposalStore(conn);
    const record = await store.append({
      tenantId: TENANT,
      sessionId: SESSION,
      toolInvocationId: null,
      targetPath: "/tmp/m.json",
      isNew: true,
      oldHash: null,
      newHash: HASH,
      entitiesAdded: 1,
      entitiesRemoved: 0,
      entitiesModified: 0,
      decision: "interactive_approved",
      applied: true,
      denialReason: null,
    });
    expect(record.decision).toBe("interactive_approved");
    expect(record.applied).toBe(true);
    expect(record.decidedAt).toBe(TS);
  });

  it("records a denied proposal with denialReason", async () => {
    const conn = mockConnection(() => ({
      rows: [
        proposalRow({
          decision: "interactive_denied",
          applied: false,
          denial_reason: "user_denied",
        }),
      ],
      rowCount: 1,
    }));
    const store = new PostgresArchitectProposalStore(conn);
    const record = await store.append({
      tenantId: TENANT,
      sessionId: SESSION,
      toolInvocationId: null,
      targetPath: "/tmp/m.json",
      isNew: false,
      oldHash: HASH,
      newHash: HASH,
      entitiesAdded: 0,
      entitiesRemoved: 0,
      entitiesModified: 1,
      decision: "interactive_denied",
      applied: false,
      denialReason: "user_denied",
    });
    expect(record.decision).toBe("interactive_denied");
    expect(record.applied).toBe(false);
    expect(record.denialReason).toBe("user_denied");
  });
});

describe("PostgresArchitectProposalStore.listForSession", () => {
  it("returns proposals ordered by proposed_at ASC", async () => {
    const conn = mockConnection((sql) => {
      expect(sql).toContain("ORDER BY proposed_at ASC");
      return {
        rows: [proposalRow(), proposalRow({ target_path: "/tmp/other.json" })],
        rowCount: 2,
      };
    });
    const store = new PostgresArchitectProposalStore(conn);
    const list = await store.listForSession(SESSION);
    expect(list).toHaveLength(2);
    expect(list[1]?.targetPath).toBe("/tmp/other.json");
  });
});
