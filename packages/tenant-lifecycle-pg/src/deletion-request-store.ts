import type { PgConnection } from "@crossengin/kernel-pg";
import {
  GdprDeletionRequestSchema,
  canTransitionDeletionRequest,
  type DeletionRequestStatus,
  type GdprDeletionRequest,
  type GdprLegalBasis,
  type RetentionObligation,
} from "@crossengin/tenant-lifecycle";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

/**
 * `meta.gdpr_deletion_requests` — the request a deletion answers, and the handle a caller holds while
 * it runs.
 *
 * ADR-0320 put the atomic pipeline behind an HTTP request and named the consequence: a large tenant's
 * deletion holds `ACCESS EXCLUSIVE` plus a full `count(*)` inside that request, so it can outlast a
 * proxy timeout — and the client then never learns the receipt it is obliged to keep. The fix is not
 * a longer timeout, it is for the caller to hold a **handle** rather than an open connection.
 *
 * This table has existed since Phase 1 with nothing writing it — the third instance of ADR-0300's
 * finding — and its state machine is exactly the one the job-backed flow needs:
 * `submitted → verified → in_progress → completed`.
 *
 * Three things it needed before it could be that handle (ADR-0321):
 *
 *  - **`request_id`**, free text, because `TombstoneRecord.relatedDeletionRequestId` is free text and
 *    a tombstone must be able to name the request that caused it. The surrogate `id` stays as the
 *    primary key.
 *  - **`verified_by` as TEXT with no reference.** It pointed at `meta.users` with `ON DELETE
 *    RESTRICT`, which would have made the verifier undeletable *because they verified the request to
 *    delete them* — ADR-0318's finding, in a second table.
 *  - **`tombstone_id`.** `completion_sha256` commits to the proof and cannot find it, so a completed
 *    request and the deletion it asked for could not be joined.
 *
 * Every read re-parses through `GdprDeletionRequestSchema` (ADR-0289), which is how a row edited into
 * a state the contract forbids — a `completed` naming no tombstone, say — reads as a finding rather
 * than as data.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REQUEST_ID_RE = /^dreq_[A-Za-z0-9_-]{8,40}$/;

/** GDPR Article 12(3): one month, extendable to three. The default this platform submits with. */
export const DEFAULT_DEADLINE_DAYS = 30;

export const REQUEST_COLUMNS = [
  "request_id",
  "tenant_id",
  "subject_identifier",
  "legal_basis",
  "status",
  "submitted_at",
  "submitted_by",
  "deadline_at",
  "verification_method",
  "verified_at",
  "verified_by",
  "in_progress_at",
  "completed_at",
  "completion_sha256",
  "rejected_at",
  "rejected_reason",
  "deferred_until",
  "deferral_reason",
  "retention_obligations",
  "retained_data_categories",
  "notes",
  "tombstone_id",
] as const;

export interface DeletionRequestStoreOptions {
  readonly schema?: string;
}

export const REQUEST_REFUSALS = [
  "illegal_transition",
  "invalid_request_id",
  "invalid_tenant_id",
  "not_found",
  "contract_violated",
] as const;
export type RequestRefusal = (typeof REQUEST_REFUSALS)[number];

export class DeletionRequestRefused extends Error {
  readonly refusal: RequestRefusal;

  constructor(refusal: RequestRefusal, detail: string) {
    super(`deletion request refused: ${detail}`);
    this.name = "DeletionRequestRefused";
    this.refusal = refusal;
  }
}

function isoOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return isoOf(value);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function jsonArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * One row into a request, re-parsed through the contract.
 *
 * Throws on a row the contract cannot represent, which is deliberate: the new `tombstoneId` rule
 * means a `completed` row naming no tombstone is now a contract violation, and that is exactly the
 * shape of row a hand-edit would leave. A shorter answer would hide it.
 */
export function rowToDeletionRequest(row: Record<string, unknown>): GdprDeletionRequest {
  const candidate: Record<string, unknown> = {
    id: String(row["request_id"]),
    tenantId: String(row["tenant_id"]),
    subjectIdentifier: String(row["subject_identifier"]),
    legalBasis: String(row["legal_basis"]) as GdprLegalBasis,
    status: String(row["status"]) as DeletionRequestStatus,
    submittedAt: isoOf(row["submitted_at"]),
    submittedBy: String(row["submitted_by"]),
    deadlineAt: isoOf(row["deadline_at"]),
    verificationMethod: textOrNull(row["verification_method"]),
    verifiedAt: isoOrNull(row["verified_at"]),
    verifiedBy: textOrNull(row["verified_by"]),
    inProgressAt: isoOrNull(row["in_progress_at"]),
    completedAt: isoOrNull(row["completed_at"]),
    completionSha256: textOrNull(row["completion_sha256"])?.trim() ?? null,
    rejectedAt: isoOrNull(row["rejected_at"]),
    deferredUntil: isoOrNull(row["deferred_until"]),
    retentionObligations: jsonArray(row["retention_obligations"]) as RetentionObligation[],
    retainedDataCategories: jsonArray(row["retained_data_categories"]) as string[],
    tombstoneId: textOrNull(row["tombstone_id"]),
  };
  const rejected = textOrNull(row["rejected_reason"]);
  if (rejected !== null) candidate["rejectedReason"] = rejected;
  const deferral = textOrNull(row["deferral_reason"]);
  if (deferral !== null) candidate["deferralReason"] = deferral;
  const notes = textOrNull(row["notes"]);
  if (notes !== null) candidate["notes"] = notes;
  return GdprDeletionRequestSchema.parse(candidate);
}

export interface SubmitDeletionRequestInput {
  readonly requestId: string;
  readonly tenantId: string;
  readonly subjectIdentifier: string;
  readonly legalBasis: GdprLegalBasis;
  readonly submittedBy: string;
  readonly submittedAt: string;
  readonly deadlineAt: string;
  readonly retentionObligations?: readonly RetentionObligation[];
  readonly notes?: string;
}

export class PostgresDeletionRequestStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: DeletionRequestStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.gdpr_deletion_requests`;
  }

  /** Records a `submitted` request. Idempotent on `request_id`: a resubmission returns the first. */
  async submit(input: SubmitDeletionRequestInput): Promise<GdprDeletionRequest> {
    if (!REQUEST_ID_RE.test(input.requestId)) {
      throw new DeletionRequestRefused(
        "invalid_request_id",
        `requestId must match ${REQUEST_ID_RE.source}, got ${JSON.stringify(input.requestId)}`,
      );
    }
    if (!UUID_RE.test(input.tenantId)) {
      throw new DeletionRequestRefused("invalid_tenant_id", "tenantId must be a uuid");
    }
    // Validated before the insert, so a deadline outside Article 12(3)'s cap is refused by the
    // contract rather than by a column that has no opinion about it.
    const candidate = GdprDeletionRequestSchema.parse({
      id: input.requestId,
      tenantId: input.tenantId,
      subjectIdentifier: input.subjectIdentifier,
      legalBasis: input.legalBasis,
      status: "submitted",
      submittedAt: input.submittedAt,
      submittedBy: input.submittedBy,
      deadlineAt: input.deadlineAt,
      retentionObligations: input.retentionObligations ?? ["none"],
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });

    // Scoped, and in a transaction so the scope survives to the statement it is for.
    //
    // This was the defect, and it is ADR-0321's store rather than this increment's: the only policy
    // on `meta.gdpr_deletion_requests` with a `WITH CHECK` is the isolation one (the platform arm is
    // `SELECT`-scoped, ADR-0332), and this write set no tenant context — so as a non-owner role
    // every submission raised `42501 new row violates row-level security policy` and the whole
    // asynchronous Article 17 flow was unreachable outside an owner connection. The reads were fine,
    // which is what hid it: they elevate through `app.platform_audit`, so an operator could list
    // requests and never create one. Observed live; `set_config` is transaction-local, so without
    // the wrapping transaction it would be discarded before the INSERT it was set for.
    await this.conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [candidate.tenantId]);
      await tx.query(
        `INSERT INTO ${this.table} (request_id, tenant_id, subject_identifier, legal_basis, status,
         submitted_at, submitted_by, deadline_at, retention_obligations, retained_data_categories, notes)
       VALUES ($1, $2::uuid, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz, $9::jsonb, $10::jsonb, $11)
       ON CONFLICT (request_id) DO NOTHING`,
        [
          candidate.id,
          candidate.tenantId,
          candidate.subjectIdentifier,
          candidate.legalBasis,
          candidate.status,
          candidate.submittedAt,
          candidate.submittedBy,
          candidate.deadlineAt,
          JSON.stringify(candidate.retentionObligations),
          JSON.stringify(candidate.retainedDataCategories),
          candidate.notes ?? null,
        ],
      );
    });
    const stored = await this.read(candidate.id);
    if (stored === null) {
      throw new DeletionRequestRefused("not_found", `request ${candidate.id} vanished after insert`);
    }
    return stored;
  }

  async read(requestId: string): Promise<GdprDeletionRequest | null> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table} WHERE request_id = $1`,
        [requestId],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToDeletionRequest(row);
    });
  }

  /**
   * The next `verified` requests, nearest deadline first — the scheduler's claim.
   *
   * Ordered by deadline rather than submission because Article 12(3) is what the platform is late
   * against, and a request submitted later can be due sooner if it was verified sooner.
   */
  async dueForExecution(limit = 10): Promise<readonly GdprDeletionRequest[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table}
          WHERE status = 'verified' ORDER BY deadline_at, request_id LIMIT $1`,
        [Math.max(1, Math.min(100, Math.trunc(limit)))],
      );
      return result.rows.map((row) => rowToDeletionRequest(row));
    });
  }

  /**
   * Requests left `in_progress` since before `olderThan` — the ones a run stranded.
   *
   * `dueForExecution` only ever looks at `verified`, so without this a stranded request is never
   * seen again by anything (ADR-0321's open question, ADR-0322's answer). Ordered oldest first,
   * because the oldest is the one whose absence of evidence is most certainly conclusive.
   */
  async stranded(olderThan: string, limit = 50): Promise<readonly GdprDeletionRequest[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table}
          WHERE status = 'in_progress' AND in_progress_at < $1::timestamptz
          ORDER BY in_progress_at, request_id LIMIT $2`,
        [olderThan, Math.max(1, Math.min(200, Math.trunc(limit)))],
      );
      return result.rows.map((row) => rowToDeletionRequest(row));
    });
  }

  /**
   * `completed` requests that name a tombstone, newest first — the audit's input (ADR-0323).
   *
   * Every completed request names one, because the contract requires it and `rowToDeletionRequest`
   * refuses a row that does not; the predicate is belt-and-braces against a row written before that
   * rule existed.
   */
  async completedWithTombstone(limit = 100): Promise<readonly GdprDeletionRequest[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table}
          WHERE status = 'completed' AND tombstone_id IS NOT NULL
          ORDER BY completed_at DESC, request_id LIMIT $1`,
        [Math.max(1, Math.min(500, Math.trunc(limit)))],
      );
      return result.rows.map((row) => rowToDeletionRequest(row));
    });
  }

  /**
   * Moves a request to `status`, refusing a transition the state machine forbids.
   *
   * The guard is re-asserted **inside the `UPDATE` predicate**, not merely checked before it: two
   * schedulers reading `verified` at the same time would both pass a pre-check, and only the one
   * whose `WHERE status = 'verified'` still matches may proceed. `rowCount === 0` is therefore
   * information — somebody else took it — and not a failure. Same shape as
   * `requestJobCancellation`'s in-predicate re-assertion (ADR-0315).
   */
  async transition(
    requestId: string,
    to: DeletionRequestStatus,
    fields: {
      readonly at: string;
      readonly verifiedBy?: string;
      readonly verificationMethod?: string;
      readonly tombstoneId?: string;
      readonly completionSha256?: string;
      readonly rejectedReason?: string;
      readonly deferredUntil?: string;
      readonly deferralReason?: string;
    },
  ): Promise<GdprDeletionRequest | null> {
    const current = await this.read(requestId);
    if (current === null) {
      throw new DeletionRequestRefused("not_found", `no deletion request ${requestId}`);
    }
    if (!canTransitionDeletionRequest(current.status, to)) {
      throw new DeletionRequestRefused(
        "illegal_transition",
        `${current.status} -> ${to} is not a legal deletion-request transition`,
      );
    }
    const sets = ["status = $2"];
    const params: unknown[] = [requestId, to];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace("$N", `$${params.length.toString()}`));
    };
    if (to === "verified") {
      push("verified_at = $N::timestamptz", fields.at);
      if (fields.verifiedBy !== undefined) push("verified_by = $N", fields.verifiedBy);
      if (fields.verificationMethod !== undefined) {
        push("verification_method = $N", fields.verificationMethod);
      }
    }
    if (to === "in_progress") push("in_progress_at = $N::timestamptz", fields.at);
    if (to === "completed") {
      push("completed_at = $N::timestamptz", fields.at);
      if (fields.tombstoneId !== undefined) push("tombstone_id = $N", fields.tombstoneId);
      if (fields.completionSha256 !== undefined) {
        push("completion_sha256 = $N", fields.completionSha256);
      }
    }
    if (to === "rejected") {
      push("rejected_at = $N::timestamptz", fields.at);
      if (fields.rejectedReason !== undefined) push("rejected_reason = $N", fields.rejectedReason);
    }
    if (to === "deferred") {
      if (fields.deferredUntil !== undefined) {
        push("deferred_until = $N::timestamptz", fields.deferredUntil);
      }
      if (fields.deferralReason !== undefined) push("deferral_reason = $N", fields.deferralReason);
    }

    params.push(current.status);
    // The same scope the submit needs, from the row this transition already read — so the scope is a
    // fact about the request rather than something the caller supplies. The in-predicate status
    // guard stays exactly as it was: the row is the lock (ADR-0321), and RLS is a second fence
    // beside it, not a replacement.
    const result = await this.conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [current.tenantId]);
      return tx.query<Record<string, unknown>>(
        `UPDATE ${this.table} SET ${sets.join(", ")}
        WHERE request_id = $1 AND status = $${params.length.toString()}
        RETURNING ${REQUEST_COLUMNS.join(", ")}`,
        params,
      );
    });
    const row = result.rows[0];
    // Null means another worker moved it between the read and the write. The caller treats that as
    // "not mine", never as an error.
    return row === undefined ? null : rowToDeletionRequest(row);
  }
}
