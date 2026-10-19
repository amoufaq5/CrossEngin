import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  DeletionRequestCommittedUnreadable,
  DeletionRequestRefused,
  PostgresDeletionRequestStore,
  REQUEST_COLUMNS,
  rowToDeletionRequest,
  type UnreadableRequestRow,
} from "./deletion-request-store.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

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

/**
 * A `completed` row that names its tombstone and no digest — the shape `completedWithTombstone`'s
 * own predicate admits and the contract refuses ("completed status requires completionSha256").
 *
 * Reachable rather than contrived, and measured against the catalog: `meta.gdpr_deletion_requests`
 * carries **no cross-column CHECK of any kind**, so `completion_sha256` is a nullable column that
 * nothing pairs with `status`. A hand-edit, a restore, or a partial write leaves exactly this.
 *
 * Deliberately **not** a *late* completion, which is what the live defect was: slice 2a made a row
 * whose `completed_at` is past its `deadline_at` parse, so a late row would now pass for the new
 * reason instead of exercising the carry-on rule — a test that cannot fail. And deliberately not an
 * out-of-enum `legal_basis` either, which reads like the obvious "newer binary" shape and is
 * **unreachable**: that column's CHECK names all six values, so such a row is refused `23514` by the
 * database long before the contract sees it (ADR-0352's class).
 */
function unreadableCompletedRow(requestId = "dreq_unreadable01"): Record<string, unknown> {
  return rowOf({
    request_id: requestId,
    status: "completed",
    in_progress_at: "2026-10-03T00:00:00.000Z",
    completed_at: "2026-10-03T01:00:00.000Z",
    completion_sha256: null,
    tombstone_id: TOMB,
  });
}

/**
 * The same shape for a row whose status is not `completed`: a `verified`/`in_progress` request with
 * no `verification_method`, which the contract requires for both and the column leaves nullable.
 */
function unreadableRow(
  status: "verified" | "in_progress",
  requestId = "dreq_unreadable01",
): Record<string, unknown> {
  return rowOf({
    request_id: requestId,
    status,
    verification_method: null,
    ...(status === "in_progress" ? { in_progress_at: "2026-10-03T00:00:00.000Z" } : {}),
  });
}

/** A valid submission, so a test that varies the *stored* row is visibly varying only that. */
const SUBMIT = {
  requestId: REQ,
  tenantId: TENANT,
  subjectIdentifier: "subject@example.test",
  legalBasis: "article_17_right_to_erasure" as const,
  submittedBy: "subject@example.test",
  submittedAt: "2026-10-01T00:00:00.000Z",
  deadlineAt: "2026-10-28T00:00:00.000Z",
};

/** Collects what a sweep reports, so a test can assert the page *and* the report. */
function collector(): { reported: UnreadableRequestRow[]; report: (r: UnreadableRequestRow) => void } {
  const reported: UnreadableRequestRow[] = [];
  return { reported, report: (r) => reported.push(r) };
}

interface Fake {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
  readonly sql: () => string[];
}

/**
 * How many rows the `INSERT` reports, which the fake has to model because `submit` now reads it.
 *
 * `ON CONFLICT (request_id) DO NOTHING` makes that count the only thing saying whether *this* call
 * wrote anything, and it is what decides which of the two error classes an unreadable read-back is.
 * The fake used to let the `INSERT` fall through to a `{rows: [], rowCount: 0}` default — so it
 * answered "you wrote nothing" for every submission, including the ordinary one, which is the
 * "a fake that silently ignores a column is worse than no fake" lesson one field over (ADR-0333).
 * 1 is the default because an ordinary submission inserts.
 */
type InsertOutcome = 0 | 1;

function fakePg(
  rows: readonly Record<string, unknown>[] = [rowOf()],
  updateRows = rows,
  insertRowCount: InsertOutcome = 1,
): Fake {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      // The one thing interpreting the SQL cannot answer: whether the statement and its parameter
      // array agree about how many parameters there are. Postgres decides that in the bind step,
      // before the planner, so a fake that serves rows from a model of the table is otherwise
      // answering statements no real server would accept (ADR-0370).
      assertBindArity(sql, params);
      calls.push({ sql, params: params ?? [] });
      if (sql.startsWith("UPDATE")) return { rows: updateRows, rowCount: updateRows.length };
      if (sql.startsWith("INSERT INTO")) return { rows: [], rowCount: insertRowCount };
      if (sql.includes("SELECT request_id") || sql.includes("FROM meta.gdpr_deletion_requests")) {
        return { rows, rowCount: rows.length };
      }
      // The scope and elevation GUCs, and nothing else. A fallback that answered `{rows: []}` for an
      // unrecognised statement is how a shape change makes every assertion about what a statement
      // *found* pass vacuously — ADR-0350's rule, applied to this fake.
      if (sql.includes("set_config(")) return { rows: [], rowCount: 0 };
      throw new Error(`fake has no model for this statement: ${sql.slice(0, 80)}`);
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

  it("scopes the insert to the request's tenant, inside a transaction, before the INSERT", async () => {
    // The defect, observed live as a non-owner role: `gdpr_deletion_requests_isolation` is the only
    // policy with a `WITH CHECK` (the platform arm is SELECT-scoped), so an unscoped INSERT raised
    // 42501 and the whole asynchronous Article 17 flow was unreachable. The reads elevate through
    // `app.platform_audit` and worked, which is what hid it.
    //
    // Three things are asserted, each of which alone would leave the fix broken: the scope is set,
    // it names the *request's* tenant, and it is inside the transaction that carries the INSERT —
    // `set_config(…, true)` is transaction-local, so a bare `conn.query` would discard it first.
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
    const scopeAt = calls.findIndex((c) => c.sql === SET_TENANT_CONTEXT_SQL);
    const insertAt = calls.findIndex((c) => c.sql.startsWith("INSERT INTO"));
    expect(scopeAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(scopeAt);
    expect(calls[scopeAt]?.params).toEqual([TENANT]);
    expect(SET_TENANT_CONTEXT_SQL).toContain(", true)");
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

  it("reports an unreadable read-back after its own INSERT as committed, not as a refusal", async () => {
    // The class the increment names, in the method immediately above the one it fixed. `submit`'s
    // `INSERT` committed, so its read-back failing the contract is a successful write this binary
    // cannot read — and the old answer was a bare `ZodError`, which is neither of the two classes
    // whose whole purpose is to say which side of the commit the caller is on.
    const { conn } = fakePg([unreadableCompletedRow(REQ)], [unreadableCompletedRow(REQ)], 1);
    const err = await new PostgresDeletionRequestStore(conn).submit(SUBMIT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeletionRequestCommittedUnreadable);
    expect(err).not.toBeInstanceOf(DeletionRequestRefused);
    const committed = err as DeletionRequestCommittedUnreadable;
    expect(committed.requestId).toBe(REQ);
    // The literal the `INSERT` bound, which is true of the row whatever the row reads as.
    expect(committed.committedStatus).toBe("submitted");
    expect(committed.parseMessage).toMatch(/completionSha256/);
  });

  it("refuses contract_violated when ON CONFLICT skipped the insert — this call wrote nothing", async () => {
    // The other side of the split, and the first producer `contract_violated` has ever had. Claiming
    // a commit this call did not make is the defect reflected: a caller must not be told not to
    // retry a write that never landed.
    const { conn } = fakePg([unreadableCompletedRow(REQ)], [unreadableCompletedRow(REQ)], 0);
    const err = await new PostgresDeletionRequestStore(conn).submit(SUBMIT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeletionRequestRefused);
    expect(err).not.toBeInstanceOf(DeletionRequestCommittedUnreadable);
    expect((err as DeletionRequestRefused).refusal).toBe("contract_violated");
    expect((err as Error).message).toMatch(/wrote nothing/);
  });

  it("keeps not_found for a row that is gone by the read-back, and says the insert happened", async () => {
    const { conn } = fakePg([], [], 1);
    const err = await new PostgresDeletionRequestStore(conn).submit(SUBMIT).catch((e: unknown) => e);
    expect((err as DeletionRequestRefused).refusal).toBe("not_found");
    // The message admits the commit rather than implying nothing was written, which is what the
    // class doc now says of this one member.
    expect((err as Error).message).toMatch(/insert committed/);
  });

  it("issues one SELECT spelling for its read-back, elevated like every other read here", async () => {
    // `readRow` is the single `SELECT`, so `read` and `submit` cannot come to disagree about which
    // columns or which elevation the read-back uses — which is how `submit` ended up with a parse
    // it could not discriminate.
    const { conn, calls } = fakePg([rowOf({ status: "submitted", verified_at: null, verified_by: null })]);
    await new PostgresDeletionRequestStore(conn).submit(SUBMIT);
    const selects = calls.filter((c) => c.sql.startsWith("SELECT request_id"));
    expect(selects).toHaveLength(1);
    expect(selects[0]?.sql).toContain(REQUEST_COLUMNS.join(", "));
    const insertAt = calls.findIndex((c) => c.sql.startsWith("INSERT INTO"));
    const selectAt = calls.findIndex((c) => c.sql.startsWith("SELECT request_id"));
    expect(selectAt).toBeGreaterThan(insertAt);
    // Its own transaction, so the elevation the read needs is not set in the one carrying the write:
    // the platform arm is `SELECT`-scoped (ADR-0332) and must not sit beside an `INSERT`.
    expect(calls.filter((c) => c.sql === "COMMIT")).toHaveLength(2);
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
    await new PostgresDeletionRequestStore(conn).dueForExecution(collector().report);
    const select = calls.find((c) => c.sql.includes("ORDER BY"));
    // Article 12(3) is what the platform is late against, and a request submitted later can be due
    // sooner if it was verified sooner.
    expect(select?.sql).toContain("status = 'verified'");
    expect(select?.sql).toContain("ORDER BY deadline_at, request_id");
  });

  it("finds the requests a run stranded, oldest first", async () => {
    const { conn, calls } = fakePg([rowOf({ status: "in_progress", in_progress_at: "2026-10-03T12:00:00.000Z" })]);
    await new PostgresDeletionRequestStore(conn).stranded(
      "2026-10-03T13:00:00.000Z",
      collector().report,
      5,
    );
    const select = calls.find((c) => c.sql.includes("in_progress_at <"));
    // dueForExecution only looks at `verified`, so without this nothing ever sees these again.
    expect(select?.sql).toContain("status = 'in_progress'");
    expect(select?.sql).toContain("ORDER BY in_progress_at, request_id");
    // Oldest first, because the oldest is the one whose absence of evidence is most conclusive.
    expect(select?.params).toEqual(["2026-10-03T13:00:00.000Z", 5]);
  });

  it("lists completed requests that name a tombstone, newest first", async () => {
    const { conn, calls } = fakePg([
      rowOf({
        status: "completed",
        in_progress_at: "2026-10-03T00:00:00.000Z",
        completed_at: "2026-10-03T01:00:00.000Z",
        completion_sha256: SHA,
        tombstone_id: TOMB,
      }),
    ]);
    await new PostgresDeletionRequestStore(conn).completedWithTombstone(collector().report, 9);
    const select = calls.find((c) => c.sql.includes("status = 'completed'"));
    expect(select?.sql).toContain("tombstone_id IS NOT NULL");
    expect(select?.sql).toContain("ORDER BY completed_at DESC, request_id");
    expect(select?.params).toEqual([9]);
  });

  it("clamps the limit into a sane band", async () => {
    const { conn, calls } = fakePg();
    const store = new PostgresDeletionRequestStore(conn);
    await store.dueForExecution(collector().report, 0);
    await store.dueForExecution(collector().report, 10_000);
    const limits = calls.filter((c) => c.sql.includes("LIMIT")).map((c) => c.params[0]);
    expect(limits).toEqual([1, 100]);
  });
});

describe("a late completion round-trips", () => {
  it("reads back a deletion that finished past its Article 12(3) deadline", () => {
    // Slice 2a's change, observed from the store — and the proof the live cause of Part A is gone.
    // The schema used to refuse this row outright, so the tenant's data was destroyed, the
    // tombstone was written and anchored, the `completed` row committed, and *this* call threw.
    const parsed = rowToDeletionRequest(
      rowOf({
        status: "completed",
        in_progress_at: "2026-10-03T00:00:00.000Z",
        // Past `deadline_at`, which the fixture sets to 2026-10-28.
        completed_at: "2026-11-15T00:00:00.000Z",
        completion_sha256: SHA,
        tombstone_id: TOMB,
      }),
    );
    expect(parsed.completedAt).toBe("2026-11-15T00:00:00.000Z");
    expect(parsed.status).toBe("completed");
    // A vacuity floor, because this test's whole subject is the *relation* between two fixture
    // dates: edit either one the wrong way and the row stops being a late completion while every
    // assertion above still passes. The mutation that would refute this test lives in
    // `@crossengin/tenant-lifecycle`'s schema, so this is what can be fenced from here.
    expect(new Date(parsed.completedAt ?? 0).getTime()).toBeGreaterThan(
      new Date(parsed.deadlineAt).getTime(),
    );
  });
});

describe("a sweep carries on past a row it cannot represent", () => {
  it("returns the other rows and reports the unreadable one", async () => {
    const { reported, report } = collector();
    const { conn } = fakePg([
      unreadableCompletedRow("dreq_bad123456789"),
      rowOf({
        request_id: "dreq_good12345678",
        status: "completed",
        in_progress_at: "2026-10-03T00:00:00.000Z",
        completed_at: "2026-10-03T01:00:00.000Z",
        completion_sha256: SHA,
        tombstone_id: TOMB,
      }),
    ]);
    const page = await new PostgresDeletionRequestStore(conn).completedWithTombstone(report);
    // Before this the `.map()` threw out of the whole page, so one refused row stopped
    // `auditCompleted` examining every *other* completed request — and the audit's answer is the
    // *absence* of findings, so a throw and a clean audit were the same observation.
    expect(page.map((r) => r.id)).toEqual(["dreq_good12345678"]);
    expect(reported).toEqual([
      { requestId: "dreq_bad123456789", detail: expect.stringContaining("completionSha256") },
    ]);
  });

  it("reports the unreadable row first when it is first, so order is the page's not the report's", async () => {
    // The bad row is in the middle here. If the helper short-circuited, the third row would be lost
    // silently — which is the carry-on rule failing in the direction a count would not show.
    const { reported, report } = collector();
    const good = (id: string): Record<string, unknown> =>
      rowOf({
        request_id: id,
        status: "completed",
        in_progress_at: "2026-10-03T00:00:00.000Z",
        completed_at: "2026-10-03T01:00:00.000Z",
        completion_sha256: SHA,
        tombstone_id: TOMB,
      });
    const { conn } = fakePg([
      good("dreq_one12345678"),
      unreadableCompletedRow("dreq_bad123456789"),
      good("dreq_two12345678"),
    ]);
    const page = await new PostgresDeletionRequestStore(conn).completedWithTombstone(report);
    expect(page.map((r) => r.id)).toEqual(["dreq_one12345678", "dreq_two12345678"]);
    expect(reported.map((r) => r.requestId)).toEqual(["dreq_bad123456789"]);
  });

  it("carries on in dueForExecution, where the dropped row is a deletion that will never run", async () => {
    const { reported, report } = collector();
    const { conn } = fakePg([
      unreadableRow("verified", "dreq_bad123456789"),
      rowOf({ request_id: "dreq_good12345678" }),
    ]);
    const page = await new PostgresDeletionRequestStore(conn).dueForExecution(report);
    expect(page.map((r) => r.id)).toEqual(["dreq_good12345678"]);
    expect(reported.map((r) => r.requestId)).toEqual(["dreq_bad123456789"]);
    expect(reported[0]?.detail).toContain("verificationMethod");
  });

  it("carries on in stranded", async () => {
    const { reported, report } = collector();
    const { conn } = fakePg([
      unreadableRow("in_progress", "dreq_bad123456789"),
      rowOf({
        request_id: "dreq_good12345678",
        status: "in_progress",
        in_progress_at: "2026-10-03T00:00:00.000Z",
      }),
    ]);
    const page = await new PostgresDeletionRequestStore(conn).stranded(
      "2026-10-03T13:00:00.000Z",
      report,
    );
    expect(page.map((r) => r.id)).toEqual(["dreq_good12345678"]);
    expect(reported).toHaveLength(1);
  });

  it("reports the row's own id and nothing else off a row the contract refused", async () => {
    // Two fields and no more. Every other column of a refused row is of unestablished
    // trustworthiness, so handing back a `tenant_id` read off one invites an operator to scope a
    // manual fix by a value that may be the reason it was refused.
    const { reported, report } = collector();
    const { conn } = fakePg([unreadableCompletedRow("dreq_bad123456789")]);
    await new PostgresDeletionRequestStore(conn).completedWithTombstone(report);
    expect(Object.keys(reported[0] ?? {}).sort()).toEqual(["detail", "requestId"]);
  });

  it("answers requestId null when the row does not name one, rather than inventing a handle", async () => {
    const { reported, report } = collector();
    const row = unreadableCompletedRow();
    delete row["request_id"];
    const { conn } = fakePg([row]);
    const page = await new PostgresDeletionRequestStore(conn).completedWithTombstone(report);
    expect(page).toEqual([]);
    // `null` says the row does not name one (ADR-0331), where `"undefined"` would be a handle no
    // `WHERE` clause can use and that reads like a value.
    expect(reported[0]?.requestId).toBeNull();
  });

  /**
   * `readRequestRows` is `kernel-pg`'s `readRows` now rather than a third copy of its loop, and the
   * only thing still local is the one-line rename of `identity` to `requestId`. These pin that the
   * rename is behaviour-identical to the `requestIdOf` it replaced — the two were byte-identical
   * predicates — so the delegation cannot have quietly changed what the three sweeps report.
   *
   * The primitive's own property, that a throw from the identity costs only its own row's handle,
   * is held in `kernel-pg`'s test and deliberately not restated here: `textIdentity` cannot throw,
   * so there is nothing for a store-level test to exercise, and one definition wants one test.
   */
  it("answers requestId null for a column holding something that is not a handle", async () => {
    for (const raw of [42, "", null, {}, []]) {
      const { reported, report } = collector();
      const row = { ...unreadableCompletedRow(), request_id: raw };
      const { conn } = fakePg([row]);
      await new PostgresDeletionRequestStore(conn).completedWithTombstone(report);
      expect(reported).toHaveLength(1);
      expect(reported[0]?.requestId).toBeNull();
    }
  });

  it("reports nothing when every row reads", async () => {
    const { reported, report } = collector();
    const { conn } = fakePg([rowOf()]);
    const page = await new PostgresDeletionRequestStore(conn).dueForExecution(report);
    expect(page).toHaveLength(1);
    expect(reported).toEqual([]);
  });
});

describe("read is the one that still throws", () => {
  it("throws rather than answering null for a row it cannot represent", async () => {
    // ADR-0345's axis: *who named the record*. This caller named one, so a failure takes no other
    // row's answer with it — while `null` means *nobody ever held this id*, and answering it here
    // would tell a data subject their erasure request does not exist (ADR-0331).
    const { conn } = fakePg([unreadableCompletedRow()]);
    await expect(new PostgresDeletionRequestStore(conn).read(REQ)).rejects.toThrow(
      /completionSha256/,
    );
  });

  it("still answers null for a row that is genuinely not there", async () => {
    const { conn } = fakePg([]);
    expect(await new PostgresDeletionRequestStore(conn).read(REQ)).toBeNull();
  });

  it("refuses a transition on a row it cannot represent, before issuing the UPDATE", async () => {
    // `transition` reads through `read()` and must: the status guard it binds comes from
    // `current.status`, so a transition on an unrepresentable row has nothing to assert.
    const { conn, sql } = fakePg([unreadableRow("verified")]);
    await expect(
      new PostgresDeletionRequestStore(conn).transition(REQ, "in_progress", {
        at: "2026-10-03T00:00:00.000Z",
      }),
    ).rejects.toThrow(/verificationMethod/);
    expect(sql().some((s) => s.startsWith("UPDATE"))).toBe(false);
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
    // And the scope comes from the row this transition already read, so RLS is a second fence
    // beside the status guard rather than a replacement for it.
    const scope = calls.find((c) => c.sql === SET_TENANT_CONTEXT_SQL);
    expect(scope?.params).toEqual([TENANT]);
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

  it("reports a committed write whose read-back cannot be represented, and says it committed", async () => {
    // The defect, and the whole of Part A: the `UPDATE … RETURNING` runs inside
    // `conn.transaction`, which **commits**, and `rowToDeletionRequest` runs only afterwards. So a
    // throw from that parse is a *successful* write this binary cannot read back — and a bare
    // `ZodError` cannot say so, which is how `DeletionRunner` came to report `completed_unrecorded`
    // ("the `completed` write did not") about a transaction that had committed.
    const { conn } = fakePg(
      [rowOf({ status: "in_progress", in_progress_at: "2026-10-03T00:00:00.000Z" })],
      [unreadableCompletedRow()],
    );
    const err = await new PostgresDeletionRequestStore(conn)
      .transition(REQ, "completed", {
        at: "2026-10-03T01:00:00.000Z",
        tombstoneId: TOMB,
        completionSha256: SHA,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeletionRequestCommittedUnreadable);
    const committed = err as DeletionRequestCommittedUnreadable;
    // The name and the message are the information, not merely decoration: this is what a caller
    // reads to decide whether to re-drive an Article 17 erasure.
    expect(committed.name).toBe("DeletionRequestCommittedUnreadable");
    expect(committed.message).toContain("committed status 'completed'");
    expect(committed.requestId).toBe(REQ);
    // The status the UPDATE bound, which is true of the row whatever the row reads as.
    expect(committed.committedStatus).toBe("completed");
    expect(committed.parseMessage).toContain("completionSha256");
  });

  it("is not a DeletionRequestRefused, because a refusal means nothing was written", async () => {
    // Every member of REQUEST_REFUSALS is raised before any statement is issued. Reusing that class
    // — or its unproduced `contract_violated` member — would make the two indistinguishable, and
    // they state opposite things about whether the tenant's data is gone.
    const { conn } = fakePg(
      [rowOf({ status: "in_progress", in_progress_at: "2026-10-03T00:00:00.000Z" })],
      [unreadableCompletedRow()],
    );
    const err = await new PostgresDeletionRequestStore(conn)
      .transition(REQ, "completed", { at: "2026-10-03T01:00:00.000Z", tombstoneId: TOMB })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(DeletionRequestRefused);
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
