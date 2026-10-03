import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  DeletionRequestRefused,
  PostgresDeletionRequestStore,
  REQUEST_COLUMNS,
  rowToDeletionRequest,
} from "./deletion-request-store.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const REQ = "dreq_abcdefgh1234";
const TOMB = "tomb_aaaabbbbccccdddd";
const SHA = "b".repeat(64);

function rowOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: REQ,
    tenant_id: TENANT,
    subject_identifier: "subject@example.test",
    legal_basis: "article_17_right_to_erasure",
    status: "verified",
    submitted_at: "2026-10-01T00:00:00.000Z",
    submitted_by: "subject@example.test",
    deadline_at: "2026-10-28T00:00:00.000Z",
    verification_method: "email_link",
    verified_at: "2026-10-02T00:00:00.000Z",
    verified_by: "support-1",
    in_progress_at: null,
    completed_at: null,
    completion_sha256: null,
    rejected_at: null,
    rejected_reason: null,
    deferred_until: null,
    deferral_reason: null,
    retention_obligations: JSON.stringify(["none"]),
    retained_data_categories: JSON.stringify([]),
    notes: null,
    tombstone_id: null,
    ...over,
  };
}

interface Fake {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
  readonly sql: () => string[];
}

function fakePg(rows: readonly Record<string, unknown>[] = [rowOf()], updateRows = rows): Fake {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.startsWith("UPDATE")) return { rows: updateRows, rowCount: updateRows.length };
      if (sql.includes("SELECT request_id") || sql.includes("FROM meta.gdpr_deletion_requests")) {
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      calls.push({ sql: "BEGIN", params: [] });
      const out = await fn(conn);
      calls.push({ sql: "COMMIT", params: [] });
      return out;
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls, sql: () => calls.map((c) => c.sql) };
}

describe("the column list", () => {
  it("carries the request's own id and the tombstone that completes it", () => {
    expect(REQUEST_COLUMNS).toContain("request_id");
    expect(REQUEST_COLUMNS).toContain("tombstone_id");
    expect(REQUEST_COLUMNS).toHaveLength(22);
  });
});

describe("rowToDeletionRequest", () => {
  it("round-trips a verified request", () => {
    const parsed = rowToDeletionRequest(rowOf());
    expect(parsed.id).toBe(REQ);
    expect(parsed.status).toBe("verified");
    expect(parsed.verifiedBy).toBe("support-1");
    expect(parsed.tombstoneId).toBeNull();
  });

  it("round-trips a completed request naming its tombstone", () => {
    const parsed = rowToDeletionRequest(
      rowOf({
        status: "completed",
        in_progress_at: "2026-10-03T00:00:00.000Z",
        completed_at: "2026-10-03T01:00:00.000Z",
        completion_sha256: SHA,
        tombstone_id: TOMB,
      }),
    );
    expect(parsed.tombstoneId).toBe(TOMB);
    expect(parsed.completionSha256).toBe(SHA);
  });

  it("throws on a completed row that names no tombstone", () => {
    // Exactly the row a hand-edit leaves, and the contract rule ADR-0321 added. A shorter answer
    // would hide it.
    expect(() =>
      rowToDeletionRequest(
        rowOf({
          status: "completed",
          in_progress_at: "2026-10-03T00:00:00.000Z",
          completed_at: "2026-10-03T01:00:00.000Z",
          completion_sha256: SHA,
        }),
      ),
      // Everything else about the row is valid, so the throw can only be the tombstone rule.
    ).toThrow(/must name the tombstone/);
  });

  it("trims the CHAR(64) padding on the completion digest", () => {
    const parsed = rowToDeletionRequest(
      rowOf({
        status: "completed",
        completed_at: "2026-10-03T01:00:00.000Z",
        completion_sha256: `${SHA}  `,
        tombstone_id: TOMB,
      }),
    );
    expect(parsed.completionSha256).toBe(SHA);
  });

  it("accepts Dates, as node-postgres returns them", () => {
    const parsed = rowToDeletionRequest(rowOf({ submitted_at: new Date("2026-10-01T00:00:00Z") }));
    expect(parsed.submittedAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("submit", () => {
  it("inserts a submitted request, idempotent on request_id", async () => {
    const { conn, calls } = fakePg([rowOf({ status: "submitted", verified_at: null, verified_by: null })]);
    await new PostgresDeletionRequestStore(conn).submit({
      requestId: REQ,
      tenantId: TENANT,
      subjectIdentifier: "subject@example.test",
      legalBasis: "article_17_right_to_erasure",
      submittedBy: "subject@example.test",
      submittedAt: "2026-10-01T00:00:00.000Z",
      deadlineAt: "2026-10-28T00:00:00.000Z",
    });
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("ON CONFLICT (request_id) DO NOTHING");
    expect(insert?.sql).toContain("$2::uuid");
    expect(insert?.sql).toContain("::jsonb");
  });

  it("refuses an id the column's CHECK would reject", async () => {
    const { conn, sql } = fakePg();
    const err = await new PostgresDeletionRequestStore(conn)
      .submit({
        requestId: "not-a-dreq",
        tenantId: TENANT,
        subjectIdentifier: "s",
        legalBasis: "article_17_right_to_erasure",
        submittedBy: "s",
        submittedAt: "2026-10-01T00:00:00.000Z",
        deadlineAt: "2026-10-28T00:00:00.000Z",
      })
      .catch((e: unknown) => e);
    expect((err as DeletionRequestRefused).refusal).toBe("invalid_request_id");
    expect(sql()).toEqual([]);
  });

  it("refuses a deadline outside Article 12(3), via the contract", async () => {
    const { conn, sql } = fakePg();
    await expect(
      new PostgresDeletionRequestStore(conn).submit({
        requestId: REQ,
        tenantId: TENANT,
        subjectIdentifier: "s",
        legalBasis: "article_17_right_to_erasure",
        submittedBy: "s",
        submittedAt: "2026-10-01T00:00:00.000Z",
        // Over three months.
        deadlineAt: "2027-06-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/Article 12\(3\)/);
    // Refused by the contract, not by a column that has no opinion about it.
    expect(sql().some((s) => s.startsWith("INSERT"))).toBe(false);
  });

  it("refuses a non-uuid tenant id", async () => {
    const { conn } = fakePg();
    const err = await new PostgresDeletionRequestStore(conn)
      .submit({
        requestId: REQ,
        tenantId: "nope",
        subjectIdentifier: "s",
        legalBasis: "article_17_right_to_erasure",
        submittedBy: "s",
        submittedAt: "2026-10-01T00:00:00.000Z",
        deadlineAt: "2026-10-28T00:00:00.000Z",
      })
      .catch((e: unknown) => e);
    expect((err as DeletionRequestRefused).refusal).toBe("invalid_tenant_id");
  });
});

describe("read and dueForExecution", () => {
  it("elevates with app.platform_audit, since a completed request outlives its tenant", async () => {
    const { conn, sql } = fakePg();
    await new PostgresDeletionRequestStore(conn).read(REQ);
    expect(sql().some((s) => s.includes("set_config('app.platform_audit', 'on', true)"))).toBe(true);
  });

  it("orders due requests by deadline, not submission", async () => {
    const { conn, calls } = fakePg();
    await new PostgresDeletionRequestStore(conn).dueForExecution();
    const select = calls.find((c) => c.sql.includes("ORDER BY"));
    // Article 12(3) is what the platform is late against, and a request submitted later can be due
    // sooner if it was verified sooner.
    expect(select?.sql).toContain("status = 'verified'");
    expect(select?.sql).toContain("ORDER BY deadline_at, request_id");
  });

  it("clamps the limit into a sane band", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresDeletionRequestStore(conn);
    await store.dueForExecution(0);
    await store.dueForExecution(10_000);
    const limits = calls.filter((c) => c.sql.includes("LIMIT")).map((c) => c.params[0]);
    expect(limits).toEqual([1, 100]);
  });
});

describe("transition", () => {
  it("re-asserts the current status inside the UPDATE predicate", async () => {
    const { conn, calls } = fakePg(
      [rowOf()],
      [rowOf({ status: "in_progress", in_progress_at: "2026-10-03T00:00:00.000Z" })],
    );
    await new PostgresDeletionRequestStore(conn).transition(REQ, "in_progress", {
      at: "2026-10-03T00:00:00.000Z",
    });
    const update = calls.find((c) => c.sql.startsWith("UPDATE"));
    // Two schedulers reading `verified` would both pass a pre-check; only the one whose predicate
    // still matches may proceed. The row is the lock.
    expect(update?.sql).toContain("WHERE request_id = $1 AND status = $");
    expect(update?.params[update.params.length - 1]).toBe("verified");
  });

  it("returns null when another worker moved it first", async () => {
    const { conn } = fakePg([rowOf()], []);
    const out = await new PostgresDeletionRequestStore(conn).transition(REQ, "in_progress", {
      at: "2026-10-03T00:00:00.000Z",
    });
    // Information, not a failure.
    expect(out).toBeNull();
  });

  it("refuses a transition the state machine forbids", async () => {
    const { conn, sql } = fakePg([
      rowOf({
        status: "completed",
        in_progress_at: "2026-10-03T00:00:00.000Z",
        completed_at: "2026-10-03T01:00:00.000Z",
        completion_sha256: SHA,
        tombstone_id: TOMB,
      }),
    ]);
    const err = await new PostgresDeletionRequestStore(conn)
      .transition(REQ, "in_progress", { at: "2026-10-03T00:00:00.000Z" })
      .catch((e: unknown) => e);
    expect((err as DeletionRequestRefused).refusal).toBe("illegal_transition");
    expect(sql().some((s) => s.startsWith("UPDATE"))).toBe(false);
  });

  it("refuses a transition on a request that is not there", async () => {
    const { conn } = fakePg([]);
    const err = await new PostgresDeletionRequestStore(conn)
      .transition(REQ, "verified", { at: "2026-10-03T00:00:00.000Z" })
      .catch((e: unknown) => e);
    expect((err as DeletionRequestRefused).refusal).toBe("not_found");
  });

  it("writes the tombstone and digest on completion", async () => {
    const completed = rowOf({
      status: "completed",
      in_progress_at: "2026-10-03T00:00:00.000Z",
      completed_at: "2026-10-03T01:00:00.000Z",
      completion_sha256: SHA,
      tombstone_id: TOMB,
    });
    const { conn, calls } = fakePg(
      [rowOf({ status: "in_progress", in_progress_at: "2026-10-03T00:00:00.000Z" })],
      [completed],
    );
    const out = await new PostgresDeletionRequestStore(conn).transition(REQ, "completed", {
      at: "2026-10-03T01:00:00.000Z",
      tombstoneId: TOMB,
      completionSha256: SHA,
    });
    expect(out?.tombstoneId).toBe(TOMB);
    const update = calls.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("tombstone_id =");
    expect(update?.sql).toContain("completion_sha256 =");
  });

  it("stamps only the timestamp its target status implies", async () => {
    const { conn, calls } = fakePg(
      [rowOf()],
      [rowOf({ status: "in_progress", in_progress_at: "2026-10-03T00:00:00.000Z" })],
    );
    await new PostgresDeletionRequestStore(conn).transition(REQ, "in_progress", {
      at: "2026-10-03T00:00:00.000Z",
    });
    const update = calls.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("in_progress_at =");
    expect(update?.sql).not.toContain("completed_at =");
    expect(update?.sql).not.toContain("verified_at =");
  });
});
