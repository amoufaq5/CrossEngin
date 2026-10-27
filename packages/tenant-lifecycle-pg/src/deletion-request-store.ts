import { readRows, textIdentity, unreadableDetail, type PgConnection } from "@crossengin/kernel-pg";
import {
  GdprDeletionRequestSchema,
  UNANSWERED_DELETION_REQUEST_STATUSES,
  canTransitionDeletionRequest,
  planDeadlineExtension,
  type DeadlineExtensionInput,
  type DeadlineExtensionRefusal,
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
  "deadline_extended_at",
  "deadline_extension_reason",
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

/**
 * A refusal: **this call left no row of its own in the database**, and the caller holds no request.
 *
 * The invariant used to be stated as a *position* — "every member is raised before any `INSERT` or
 * `UPDATE` is issued" — and that was false in the method directly above the one this class pairs
 * with. `submit` issues its `INSERT` and then reads the row back, so `not_found` and
 * `contract_violated` are both raised past a statement. They are still refusals, because the claim
 * that matters is about *state* and not about ordering, and each is true of its own case:
 *
 *   - `contract_violated` — the `INSERT` matched `ON CONFLICT (request_id) DO NOTHING`, so it wrote
 *     nothing, and the row that was already there is one the contract cannot represent.
 *   - `not_found` from `submit` — the row the `INSERT` wrote, or the row that blocked it, is gone by
 *     the read-back. Something removed it in between. Nothing this call wrote survives, so there is
 *     nothing to hand back and nothing to undo, and `submit` is idempotent on `request_id` so the
 *     caller's remedy is to submit again. It is **not** the "nothing was ever written" claim the
 *     three pre-statement members make, which is why it is named here rather than left to be
 *     generalised from them.
 *
 * It is deliberately *not* the vehicle for a committed write whose read-back cannot be represented —
 * `DeletionRequestCommittedUnreadable` is, and the whole point of a second class is that the two
 * state opposite things about whether a row this call wrote is now in the database. Handing a bare
 * `ZodError` to a caller, which is what `submit` did for a stored row the contract refuses, states
 * neither.
 */
export class DeletionRequestRefused extends Error {
  readonly refusal: RequestRefusal;

  constructor(refusal: RequestRefusal, detail: string) {
    super(`deletion request refused: ${detail}`);
    this.name = "DeletionRequestRefused";
    this.refusal = refusal;
  }
}

/**
 * The `UPDATE` **committed** and the row it returned cannot be represented.
 *
 * The name and the message both lead with the commit, because that is the entire information the
 * caller needs and the one thing a bare `ZodError` cannot carry. `transition` opens a transaction,
 * runs the guarded `UPDATE … RETURNING`, and the transaction **commits** — only then does
 * `rowToDeletionRequest` run on the returned row. A throw from that parse is therefore not a failed
 * write. It is a successful one this binary cannot read back, and `DeletionRunner` reported it as
 * `completed_unrecorded`, whose own definition reads "the `completed` write did not" — which was
 * false about the row and false in the direction that invites a human to re-drive a deletion that
 * has already happened.
 *
 * The rule: **a read-back that cannot be represented must not be reported as a write that did not
 * happen.** The two have opposite remedies — a failed write is re-driven, a committed one must not
 * be — so a caller that cannot tell them apart cannot act on either.
 *
 * Carrying `committedStatus` and not the row: the status is the one fact the `UPDATE` establishes
 * independently of anything the row reads as, since it is the value this call bound and the
 * predicate it committed under. Every column of a row the contract refused is of unestablished
 * trustworthiness, and handing one back invites a caller to act on it.
 *
 * `submit` raises it too, and only when its own `INSERT` reported a row — `committedStatus` is then
 * `"submitted"`, the literal that statement bound. When the `INSERT` matched `ON CONFLICT … DO
 * NOTHING` this call committed nothing, so the unreadable row it found belongs to an earlier one and
 * the honest answer is `DeletionRequestRefused("contract_violated")`. Claiming a commit this call
 * did not make would be the same wrong direction as the defect, reflected: a caller must not be told
 * not to retry a write that never landed.
 */
export class DeletionRequestCommittedUnreadable extends Error {
  readonly requestId: string;
  /** The status the `UPDATE` committed — true of the row whatever the row reads as. */
  readonly committedStatus: DeletionRequestStatus;
  /** Why the contract could not represent the returned row. */
  readonly parseMessage: string;

  constructor(requestId: string, committedStatus: DeletionRequestStatus, parseMessage: string) {
    super(
      `deletion request ${requestId} committed status '${committedStatus}' and its read-back ` +
        `cannot be represented: ${parseMessage}`,
    );
    this.name = "DeletionRequestCommittedUnreadable";
    this.requestId = requestId;
    this.committedStatus = committedStatus;
    this.parseMessage = parseMessage;
  }
}

/**
 * Article 12(3)'s extension was refused, and **nothing was written**.
 *
 * Its own class rather than a sixth `RequestRefusal`, because the two vocabularies answer different
 * questions: `REQUEST_REFUSALS` is about the *call* — a malformed id, a tenant that is not a uuid, a
 * row that is not there — while these five are about whether the regulation permits this extension
 * of this request. A route picks its status code off the refusal, so collapsing them would make an
 * unlawful extension and a malformed id indistinguishable to the one reader that has to tell them
 * apart.
 *
 * Every member is raised by `planDeadlineExtension` before any statement is issued, so the claim in
 * the first line is about position as well as state — unlike `DeletionRequestRefused`, whose own doc
 * had to retire that framing when `submit` grew a read-back.
 */
export class DeadlineExtensionRefused extends Error {
  readonly refusal: DeadlineExtensionRefusal;

  constructor(requestId: string, refusal: DeadlineExtensionRefusal, detail: string) {
    super(`deadline extension refused for ${requestId}: ${detail}`);
    this.name = "DeadlineExtensionRefused";
    this.refusal = refusal;
  }
}

/**
 * One row a sweep could not represent.
 *
 * Two fields and no more. `requestId` is the row's business key, so it is what a `WHERE` clause
 * needs and the only handle a remedy can name; `detail` is the cause. Every *other* column of a row
 * the contract refused is of unestablished trustworthiness — reporting a `tenant_id` read off such a
 * row invites an operator to scope a manual fix by a value that may be the reason it was refused —
 * which is ADR-0310's rule about what a finding's notice may carry, one surface over.
 *
 * `requestId` is `string | null` because the column itself may be what is wrong, and `null` says
 * *the row does not name one* rather than inventing a handle (ADR-0331).
 *
 * Structurally `kernel-pg`'s `UnreadableRow` with the identity named for what it is, and kept that
 * way deliberately: a reporter here is handed a *request*, and `requestId` is what the three
 * audiences — a scheduler, an HTTP route, an audit sweep — act on. What is **not** kept local is the
 * `detail`. This module computed it as `err.message`, and for an `invalid_enum_value` issue that
 * string *is* the stored value — so the rule argued three paragraphs above was broken by its own
 * implementation. `unreadableDetail` is imported for that, and the two sites that still build a
 * detail here go through it: both `DeletionRequestCommittedUnreadable` throws, whose message reaches
 * an HTTP body and the runner's log. The **list** reporter no longer builds one at all —
 * `readRequestRows` is `kernel-pg`'s `readRows`, which computes the detail itself, so the sweep path
 * cannot drift from the rule even by someone editing this file.
 */
export interface UnreadableRequestRow {
  readonly requestId: string | null;
  readonly detail: string;
}

/**
 * What a sweep does with a row it cannot represent.
 *
 * **Required** at every list method, never optional with a default: a reporter defaulting to "drop
 * it silently" is the defect restated as a default (ADR-0364's addendum, ADR-0371's `onRefused`),
 * and the row this would drop is a completed Article 17 erasure whose request record has stopped
 * being readable. Required also means the compiler names every call site when a list method is
 * added, where a constructor-level reporter would let a new method inherit one nobody chose — and
 * the three methods have three different audiences (a scheduler, an HTTP route, an audit sweep),
 * which one callback on the store would merge.
 */
export type UnreadableRowReporter = (row: UnreadableRequestRow) => void;

/**
 * A page into requests: every row that can be represented, and a report for every row that cannot.
 *
 * One rule, in one place, for all three list methods: **a sweep reports an unrepresentable row and
 * carries on; it does not take the other rows with it.** Before this, `result.rows.map(…)` meant one
 * row the contract refused threw out of the whole page, so a single hand-edited or
 * newer-binary-written row stopped `DeletionReconciler.auditCompleted` auditing every *other*
 * completed request — the sweep went silent in exactly the way an absence of findings is read as a
 * clean result. ADR-0289's rule (a parse failure is a finding, not an exception) and ADR-0327's (a
 * sweep that found a bad record has even less standing to act than one that found none).
 *
 * **This is `kernel-pg`'s `readRows` and no longer a local copy of its loop.** ADR-0373 lifted the
 * primitive and retired two copies, and this was a third it did not reach — verbatim apart from its
 * field name, and *missing the one property the primitive exists to hold*: `requestIdOf(row)` sat
 * inside the `catch` but not inside a `try` of its own, so a throw from the identity would have cost
 * every row behind it, which is the defect one level in from the one the loop fixes. Latent, because
 * `requestIdOf` could not throw — and that is exactly the argument for not keeping a copy, since the
 * next identity expression written here is under no such guarantee. `requestIdOf` is gone with it: it
 * was byte-identical to `textIdentity(row, "request_id")`, a fourth spelling of that predicate.
 *
 * **The whole of what is local is the mapping**, one line of it: the primitive answers
 * `UnreadableRow {identity, detail}` and this surface's reporter is handed `UnreadableRequestRow
 * {requestId, detail}`. The field name stays `requestId` deliberately — a reporter here is handed a
 * *request*, and that is what its three audiences (a scheduler, an HTTP route, an audit sweep) act on
 * — so `identity` is renamed at this one point rather than at three call sites, and the two types
 * stay structurally identical so the rename cannot quietly become a change of meaning.
 *
 * `read()` deliberately does **not** take this path; see its own comment for why.
 */
function readRequestRows(
  rows: readonly Record<string, unknown>[],
  onUnreadable: UnreadableRowReporter,
): readonly GdprDeletionRequest[] {
  return readRows(
    rows,
    rowToDeletionRequest,
    (row) => textIdentity(row, "request_id"),
    (unreadable) => onUnreadable({ requestId: unreadable.identity, detail: unreadable.detail }),
  );
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
 * Throws on a row the contract cannot represent, which is deliberate: the `tombstoneId` rule means a
 * `completed` row naming no tombstone is a contract violation, and that is exactly the shape of row a
 * hand-edit would leave. A shorter answer would hide it.
 *
 * The throw is the *detector* and never the policy, and every caller answers it differently on
 * purpose — `read` propagates, `readRequestRows` reports and carries on, `transition` re-throws as
 * `DeletionRequestCommittedUnreadable` because by then the write has committed, and `submit` picks
 * between those last two on whether its own `INSERT` reported a row. Each says why at its own site,
 * and there is deliberately no count here: this comment said "its three callers" while `submit` was
 * the fourth and was answering with a bare `ZodError`.
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
    deadlineExtendedAt: isoOrNull(row["deadline_extended_at"]),
    retentionObligations: jsonArray(row["retention_obligations"]) as RetentionObligation[],
    retainedDataCategories: jsonArray(row["retained_data_categories"]) as string[],
    tombstoneId: textOrNull(row["tombstone_id"]),
  };
  const rejected = textOrNull(row["rejected_reason"]);
  if (rejected !== null) candidate["rejectedReason"] = rejected;
  const deferral = textOrNull(row["deferral_reason"]);
  if (deferral !== null) candidate["deferralReason"] = deferral;
  const extension = textOrNull(row["deadline_extension_reason"]);
  if (extension !== null) candidate["deadlineExtensionReason"] = extension;
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
    const inserted = await this.conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [candidate.tenantId]);
      return tx.query(
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
    // `ON CONFLICT … DO NOTHING` makes the row count the one thing that says whether *this* call
    // wrote anything, and that is what decides which of the two classes an unreadable read-back is.
    // Without it the two cases are indistinguishable from here and the previous answer — a bare
    // `ZodError` out of `read` — was neither of them.
    const wrote = inserted.rowCount > 0;
    const row = await this.readRow(candidate.id);
    if (row === undefined) {
      // Past a committed `INSERT`, which the old message said in so many words ("vanished after
      // insert") inside a class whose doc claimed every member was raised before one. It stays a
      // refusal and the class now says why: whatever this call wrote is gone, so there is nothing to
      // hand back, nothing to undo, and `submit` is idempotent on `request_id` — the caller submits
      // again. It is not the "nothing was ever written" claim the pre-statement members make.
      throw new DeletionRequestRefused(
        "not_found",
        `request ${candidate.id} is absent from ${this.table} immediately after its insert` +
          `${wrote ? " committed" : " was skipped by ON CONFLICT"}; something removed it in between`,
      );
    }
    try {
      return rowToDeletionRequest(row);
    } catch (err) {
      const detail = unreadableDetail(err);
      // The whole of finding 3, and the split is the row count. Our `INSERT` landed, so a read-back
      // the contract cannot represent is a committed write this binary cannot read — never a
      // refusal, which would tell the caller to retry a row that exists.
      if (wrote) {
        throw new DeletionRequestCommittedUnreadable(candidate.id, "submitted", detail);
      }
      // Our `INSERT` wrote nothing, so the unreadable row belongs to an earlier submission and this
      // call changed nothing at all — a refusal, and the first producer `contract_violated` has ever
      // had. Reusing it rather than adding a member: the vocabulary already named this exact fact
      // and the member's own test called it unproduced.
      throw new DeletionRequestRefused(
        "contract_violated",
        `request ${candidate.id} already exists and the stored row cannot be represented, so this` +
          ` submission wrote nothing and there is no request to return: ${detail}`,
      );
    }
  }

  /**
   * The stored row for one request, unparsed, elevated the way every read here is.
   *
   * Split out so there is exactly one spelling of this `SELECT` and the **parse** is the caller's.
   * `read` propagates a parse failure, `submit` has to tell its two cases apart, and a shared
   * already-parsed helper could serve only one of them — which is how `submit` came to hand a raw
   * `ZodError` to an HTTP route.
   */
  private async readRow(requestId: string): Promise<Record<string, unknown> | undefined> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table} WHERE request_id = $1`,
        [requestId],
      );
      return result.rows[0];
    });
  }

  /**
   * One named request, or `null` if there is no such row.
   *
   * This is the one read that keeps **throwing** on a row it cannot represent, and the axis is
   * ADR-0345's: *who named the record*. A caller here named one, so a parse failure takes no other
   * row's answer with it, and the two outcomes it could be collapsed into are both worse. `null`
   * means *nobody ever held this id* — answering it for a row that exists and cannot be read is the
   * fail-open direction and would tell a data subject their erasure request does not exist
   * (ADR-0331). Dropping it from a list is the sweep's answer and is wrong for a singular read,
   * because there is nothing to carry on with.
   *
   * `transition` also reads through here, and must: the status guard it binds comes from
   * `current.status`, so a transition on a row the contract cannot represent has nothing to assert.
   */
  async read(requestId: string): Promise<GdprDeletionRequest | null> {
    const row = await this.readRow(requestId);
    return row === undefined ? null : rowToDeletionRequest(row);
  }

  /**
   * The next `verified` requests, nearest deadline first — the scheduler's claim.
   *
   * Ordered by deadline rather than submission because Article 12(3) is what the platform is late
   * against, and a request submitted later can be due sooner if it was verified sooner.
   *
   * `onUnreadable` precedes `limit` because it is required and `limit` keeps its default — a
   * required parameter cannot follow an optional one, and the order is what the requirement costs.
   */
  async dueForExecution(
    onUnreadable: UnreadableRowReporter,
    limit = 10,
  ): Promise<readonly GdprDeletionRequest[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table}
          WHERE status = 'verified' ORDER BY deadline_at, request_id LIMIT $1`,
        [Math.max(1, Math.min(100, Math.trunc(limit)))],
      );
      return readRequestRows(result.rows, onUnreadable);
    });
  }

  /**
   * Requests left `in_progress` since before `olderThan` — the ones a run stranded.
   *
   * `dueForExecution` only ever looks at `verified`, so without this a stranded request is never
   * seen again by anything (ADR-0321's open question, ADR-0322's answer). Ordered oldest first,
   * because the oldest is the one whose absence of evidence is most certainly conclusive.
   */
  async stranded(
    olderThan: string,
    onUnreadable: UnreadableRowReporter,
    limit = 50,
  ): Promise<readonly GdprDeletionRequest[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table}
          WHERE status = 'in_progress' AND in_progress_at < $1::timestamptz
          ORDER BY in_progress_at, request_id LIMIT $2`,
        [olderThan, Math.max(1, Math.min(200, Math.trunc(limit)))],
      );
      return readRequestRows(result.rows, onUnreadable);
    });
  }

  /**
   * Every request the data subject has **not yet been answered on**, nearest deadline first.
   *
   * The listing that did not exist, and the gap was not an oversight in one place: this store's
   * three queries named `verified`, `in_progress` and `completed`, so **`submitted` and `deferred`
   * were read by no query in the workspace** — a request nobody verifies sits past its Article 12(3)
   * deadline with nothing in the system looking at it, and the likeliest real breach path was the
   * one with no reader at all.
   *
   * The status set is **bound from `UNANSWERED_DELETION_REQUEST_STATUSES`**, which is derived from
   * `ARTICLE_12_ANSWER_INSTANT`, rather than written here as a literal like its three siblings. That
   * is the whole fix for the class: a literal is a second spelling a new status joins only if
   * somebody remembers, and forgetting here is exactly how `submitted` came to be unread.
   * `= ANY($1::text[])` for `job-claim.ts`' reason — one parameter for a set whose size is a
   * property of the contract and not of the call.
   *
   * **The ordering is what makes a bounded page safe.** `deadline_at ASC` puts the most overdue
   * first, so a page cut by `limit` can only drop requests that are *further* from their deadline —
   * a truncated sweep loses `within_deadline` rows before it loses a breach, and it loses a breach
   * only when there are more breaches than the limit. That is still a bounded reading and the
   * caller declares it (ADR-0367's `declares` arm); it is not a silent one.
   *
   * It is deliberately **not** filtered on the deadline. The same page is the operator's pending
   * list — the register's other half, since no route lists pending requests — and a healthy request
   * is a row an operator wants to see while a breach is a row a sweep wants to report. One query,
   * two readings, and the standing is computed by `assessDeadline` rather than by a `WHERE`.
   */
  async unanswered(
    onUnreadable: UnreadableRowReporter,
    limit = 100,
  ): Promise<readonly GdprDeletionRequest[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table}
          WHERE status = ANY($1::text[]) ORDER BY deadline_at, request_id LIMIT $2`,
        [[...UNANSWERED_DELETION_REQUEST_STATUSES], Math.max(1, Math.min(500, Math.trunc(limit)))],
      );
      return readRequestRows(result.rows, onUnreadable);
    });
  }

  /**
   * `rejected` requests whose refusal was recorded **after** their deadline, newest first.
   *
   * The third Article 12(3) breach shape, and the one nothing could see. `isOverdue` excused
   * `rejected` on the ground that "a refused request was answered rather than answered late", which
   * is the conflation that doc warns about one paragraph earlier and is wrong about the regulation:
   * Article 12(4) puts a refusal under the same one-month clock. So a request left alone until its
   * deadline passed and then rejected — which the reject route writes with `at: now` and no deadline
   * check, and which the runner writes for every deterministic pipeline refusal — is a breach that
   * `auditCompleted` cannot reach (it walks `completed`) and `unanswered` cannot reach (it walks the
   * four waiting statuses).
   *
   * A **comparison between two stored columns** rather than against the clock, which is what makes
   * this a historical audit like `completedWithTombstone` and not a queue like `dueForExecution` —
   * and why it is its own method: one query cannot be ordered by both a deadline and a refusal
   * instant, and the two pages mean different things when they are cut short.
   *
   * `status = 'rejected'` is a literal, as its three siblings are, and what keeps it honest is in
   * the contract: a test asserts that `rejected` is the *only* status whose answer instant is
   * `rejected_at`, so a seventh status answering through that column fails there and names this
   * query rather than silently falling outside every sweep.
   */
  async rejectedAfterDeadline(
    onUnreadable: UnreadableRowReporter,
    limit = 100,
  ): Promise<readonly GdprDeletionRequest[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table}
          WHERE status = 'rejected' AND rejected_at > deadline_at
          ORDER BY rejected_at DESC, request_id LIMIT $1`,
        [Math.max(1, Math.min(500, Math.trunc(limit)))],
      );
      return readRequestRows(result.rows, onUnreadable);
    });
  }

  /**
   * `completed` requests that name a tombstone, newest first — the audit's input (ADR-0323).
   *
   * Every completed request names one, because the contract requires it and `rowToDeletionRequest`
   * refuses a row that does not; the predicate is belt-and-braces against a row written before that
   * rule existed.
   *
   * This is the method the sweep rule matters most for, and the reason is what the page feeds: the
   * audit of the platform's standing claim that an Article 17 erasure was carried out and can be
   * evidenced. One refused row used to throw out of the `.map()` and stop every other claim being
   * checked, which is a silence indistinguishable from a clean audit.
   */
  async completedWithTombstone(
    onUnreadable: UnreadableRowReporter,
    limit = 100,
  ): Promise<readonly GdprDeletionRequest[]> {
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${REQUEST_COLUMNS.join(", ")} FROM ${this.table}
          WHERE status = 'completed' AND tombstone_id IS NOT NULL
          ORDER BY completed_at DESC, request_id LIMIT $1`,
        [Math.max(1, Math.min(500, Math.trunc(limit)))],
      );
      return readRequestRows(result.rows, onUnreadable);
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
    if (row === undefined) return null;
    // The parse is on the far side of the commit **by choice**, and the choice is the thing to know.
    // An earlier version of this comment said nothing could move it to the near side; that is false,
    // and a false impossibility invites the "fix" that reinstates the defect. `conn.transaction`
    // issues `BEGIN`, runs this callback and `ROLLBACK`s in its `catch`, so parsing inside the
    // callback would undo the `UPDATE` and make a refusal honest — measured in `kernel-pg`'s
    // `node-pg.ts`, not reasoned.
    //
    // It is not done because of what rolling back would discard, and that argument is **per `to`**:
    //
    //   - `completed` is the one that must not. By the time this runs the tenant's data is destroyed
    //     and the tombstone is anchored (ADR-0320), so discarding the status write would throw away
    //     the record of a deletion that happened and strand the request `in_progress` — a wrong
    //     answer in place of an awkward one.
    //   - `rejected`, `in_progress`, `verified` and `deferred` could roll back: nothing irreversible
    //     has happened at any of them. They do not, because this method's job is to say *what it
    //     committed*, and a store that kept some status writes and discarded others by target would
    //     be a second policy about the request's lifecycle sitting underneath the one the runner
    //     already owns — which maps each committed status to the outcome true of it
    //     (`OUTCOME_OF_COMMITTED_STATUS`). One policy, in the caller that has the context.
    //
    // So the rule here is about what a failure is allowed to *say* — **a read-back that cannot be
    // represented must not be reported as a write that did not happen.** Both facts are true at once
    // and only one of them is recoverable by re-driving, so a caller handed a bare `ZodError` picks
    // the wrong one: `DeletionRunner` reported `completed_unrecorded`, whose definition is "the
    // `completed` write did not", about a transaction that had committed.
    try {
      return rowToDeletionRequest(row);
    } catch (err) {
      throw new DeletionRequestCommittedUnreadable(
        requestId,
        to,
        unreadableDetail(err),
      );
    }
  }

  /**
   * Applies Article 12(3)'s two-further-months extension, **in place on `deadline_at`**.
   *
   * Until this there was no way to grant one at all: `deadline_at` appeared in no `SET` clause, the
   * submit route computes it as `now + deadlineDays` from a deployment-wide setting, and `deferred`
   * — the status whose `deferredUntil`/`deferralReason` read like the natural home for it — has **no
   * producer in the workspace**. So a request that lawfully earned more time had nowhere to record
   * it, which is what made the sweep beside this method a prerequisite rather than a follow-up: a
   * breach whose remedy does not exist is a finding nobody can act on (ADR-0334).
   *
   * **In place, and `planDeadlineExtension` is where that argument lives.** The short version: five
   * readers compare `deadline_at` and a second column holding the extended value would have made
   * every one of them wrong until it coalesced, so forgetting at a single site reports a lawfully
   * extended request as a breach — the hazard the register named, created by the fix.
   *
   * Two things guard the write and they guard different races. `status = $5` is the status this
   * method just read, so a request verified-then-rejected between the read and the write is the
   * reject's (ADR-0321: the row is the lock). `deadline_extended_at IS NULL` is the second
   * extension's guard, and it has to be in the predicate rather than only in the plan because two
   * concurrent extensions would both pass a pre-check and the later one would overwrite the earlier
   * one's reason while the regulation grants one extension.
   *
   * `null` therefore means *somebody else moved or extended it*, which is the convention
   * `transition` already sets, and a caller treats it as "not mine" rather than as an error.
   */
  async extendDeadline(
    requestId: string,
    input: DeadlineExtensionInput,
  ): Promise<GdprDeletionRequest | null> {
    const current = await this.read(requestId);
    if (current === null) {
      throw new DeletionRequestRefused("not_found", `no deletion request ${requestId}`);
    }
    const plan = planDeadlineExtension(current, input);
    if (!plan.ok) {
      throw new DeadlineExtensionRefused(requestId, plan.refusal, plan.detail);
    }
    // The scope the isolation policy's `WITH CHECK` needs, from the row this call already read, in a
    // transaction because `set_config(…, true)` is transaction-local — the three facts that made
    // every write on this table raise `42501` as a non-owner before ADR-0335.
    const result = await this.conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [current.tenantId]);
      return tx.query<Record<string, unknown>>(
        `UPDATE ${this.table}
            SET deadline_at = $2::timestamptz,
                deadline_extended_at = $3::timestamptz,
                deadline_extension_reason = $4
          WHERE request_id = $1 AND status = $5 AND deadline_extended_at IS NULL
          RETURNING ${REQUEST_COLUMNS.join(", ")}`,
        [
          requestId,
          input.deadlineAt,
          input.deadlineExtendedAt,
          input.deadlineExtensionReason,
          current.status,
        ],
      );
    });
    const row = result.rows[0];
    if (row === undefined) return null;
    try {
      return rowToDeletionRequest(row);
    } catch (err) {
      // Committed, and the status is the one it committed under — unchanged by an extension, which
      // is why `current.status` is the honest value to carry rather than a target this call has
      // none of. `transition`'s rule, for its reason: a read-back that cannot be represented must
      // not be reported as a write that did not happen, because only one of the two is re-drivable
      // and here re-driving would be refused `already_extended` on a row whose reason it cannot
      // read.
      throw new DeletionRequestCommittedUnreadable(
        requestId,
        current.status,
        unreadableDetail(err),
      );
    }
  }
}
