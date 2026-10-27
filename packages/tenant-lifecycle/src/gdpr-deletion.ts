import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const GDPR_LEGAL_BASES = [
  "article_17_right_to_erasure",
  "article_21_objection_to_processing",
  "data_subject_request",
  "consent_withdrawn",
  "contract_terminated",
  "no_lawful_basis_remaining",
] as const;
export type GdprLegalBasis = (typeof GDPR_LEGAL_BASES)[number];
export const GdprLegalBasisSchema = z.enum(GDPR_LEGAL_BASES);

export const RETENTION_OBLIGATIONS = [
  "tax_records_7y",
  "medical_records_10y",
  "audit_logs_3y",
  "financial_transactions_7y",
  "anti_money_laundering_5y",
  "none",
] as const;
export type RetentionObligation = (typeof RETENTION_OBLIGATIONS)[number];

export const DELETION_REQUEST_STATUSES = [
  "submitted",
  "verified",
  "in_progress",
  "completed",
  "rejected",
  "deferred",
] as const;
export type DeletionRequestStatus = (typeof DELETION_REQUEST_STATUSES)[number];
export const DeletionRequestStatusSchema = z.enum(DELETION_REQUEST_STATUSES);

export const DELETION_REQUEST_TRANSITIONS: Readonly<
  Record<DeletionRequestStatus, readonly DeletionRequestStatus[]>
> = Object.freeze({
  submitted: ["verified", "rejected"],
  verified: ["in_progress", "deferred", "rejected"],
  in_progress: ["completed", "rejected"],
  deferred: ["in_progress", "rejected"],
  completed: [],
  rejected: [],
});

export function canTransitionDeletionRequest(
  from: DeletionRequestStatus,
  to: DeletionRequestStatus,
): boolean {
  return DELETION_REQUEST_TRANSITIONS[from].includes(to);
}

export const VERIFICATION_METHODS = [
  "email_link",
  "phone_otp",
  "in_app_re_authentication",
  "government_id_check",
  "in_person",
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/**
 * Which stored instant answers *when was the data subject answered?*, per status.
 *
 * Article 12(3) is a deadline on **answering**, not on completing: 12(4) puts a refusal under the
 * same clock, so a request refused past its deadline is as much a breach as one erased past it. The
 * map is therefore over the answer and not over success, and the two terminal statuses carry the
 * instant in different columns — which is exactly why this is a map and not a pair of predicates.
 *
 * A total map rather than a list of "the terminal ones", because every reader of this question has
 * to answer it for every status and three of them used to answer it by writing the complement out by
 * hand: `isOverdue` named `completed` and `rejected` inline, the since-deleted `isCompletedLate`
 * named `completed` inline, and the store's three queries named `verified` / `in_progress` /
 * `completed` inline while
 * **nothing in the workspace named `submitted` or `deferred` at all**. A seventh status must declare
 * itself here or it inherits whichever branch an `if`-chain ended on.
 *
 * `unanswered` is the fourth kind of "not yet", and it is the one `deferred` holds today with no
 * producer: `DELETION_REQUEST_TRANSITIONS` offers `verified -> deferred` and nothing in the
 * workspace writes it, so its membership here is a statement about the contract rather than about
 * any deployment's rows.
 */
export const ARTICLE_12_ANSWER_INSTANTS = ["unanswered", "completed_at", "rejected_at"] as const;
export type Article12AnswerInstant = (typeof ARTICLE_12_ANSWER_INSTANTS)[number];

export const ARTICLE_12_ANSWER_INSTANT: Readonly<
  Record<DeletionRequestStatus, Article12AnswerInstant>
> = Object.freeze({
  submitted: "unanswered",
  verified: "unanswered",
  in_progress: "unanswered",
  deferred: "unanswered",
  completed: "completed_at",
  rejected: "rejected_at",
});

/**
 * The statuses on which the data subject is still waiting, derived rather than restated.
 *
 * This is the set the deadline sweep's `WHERE status = ANY(…)` binds, and deriving it is the whole
 * reason the map above exists: written as a literal it would be a second spelling that a new status
 * joins only if somebody remembers, which is how `submitted` and `deferred` came to be read by no
 * query in the workspace.
 */
export const UNANSWERED_DELETION_REQUEST_STATUSES: readonly DeletionRequestStatus[] =
  Object.freeze(
    DELETION_REQUEST_STATUSES.filter((s) => ARTICLE_12_ANSWER_INSTANT[s] === "unanswered"),
  );

/**
 * Article 12(3)'s outer bound: one month, extendable by two further months.
 *
 * `30 * 3.1` days rather than three calendar months, which is the figure
 * `GdprDeletionRequestSchema` has always enforced — exported so the schema's refinement and
 * `planDeadlineExtension` cannot drift. The `.1` is slack for month lengths and is deliberately
 * unchanged: tightening it would refuse rows that are already stored and were valid when written.
 */
export const ARTICLE_12_MAX_DEADLINE_MS = 30 * 86_400_000 * 3.1;

export const GdprDeletionRequestSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    subjectIdentifier: z.string().min(1),
    legalBasis: GdprLegalBasisSchema,
    status: DeletionRequestStatusSchema,
    submittedAt: Iso8601,
    submittedBy: z.string().min(1),
    deadlineAt: Iso8601,
    verificationMethod: z.enum(VERIFICATION_METHODS).nullable().default(null),
    verifiedAt: Iso8601.nullable().default(null),
    verifiedBy: z.string().min(1).nullable().default(null),
    inProgressAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    completionSha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    rejectedAt: Iso8601.nullable().default(null),
    rejectedReason: z.string().min(1).optional(),
    deferredUntil: Iso8601.nullable().default(null),
    deferralReason: z.string().min(1).optional(),
    /**
     * When Article 12(3)'s two-further-months extension was recorded, or `null` for a deadline still
     * at the commitment made on submission.
     *
     * The extension is applied to `deadlineAt` **in place** and this is the trace of it, which is the
     * decision rather than a convenience — see `planDeadlineExtension` for why a second deadline
     * column was refused. So `deadlineAt` is always the commitment *currently in force* and this says
     * whether it is the original one.
     *
     * What it is **not**: evidence that the subject was informed. Article 12(3) obliges the controller
     * to inform the data subject of the extension and its reasons within one month of receipt, and
     * this platform has no mail channel at all, so nothing here can carry that fact and nothing
     * refuses a late recording on its behalf. Claiming otherwise from this column would be the
     * falsely-true direction (ADR-0337).
     */
    deadlineExtendedAt: Iso8601.nullable().default(null),
    /** The reason Article 12(3) requires an extension to state. Required with the instant. */
    deadlineExtensionReason: z.string().min(1).optional(),
    retentionObligations: z.array(z.enum(RETENTION_OBLIGATIONS)).default(["none"]),
    retainedDataCategories: z.array(z.string().min(1)).default([]),
    notes: z.string().min(1).optional(),
    /**
     * The tombstone that completed this request (ADR-0321).
     *
     * `completionSha256` commits to the proof and cannot find it — a digest is not a lookup key — so
     * without this a `completed` request and the record of the deletion it asked for could not be
     * joined. The superRefine below makes the pair load-bearing in both directions: a completed
     * request must name its tombstone, and an uncompleted one must not.
     */
    tombstoneId: z
      .string()
      .regex(/^tomb_[A-Za-z0-9_-]{12,40}$/)
      .nullable()
      .default(null),
  })
  .superRefine((v, ctx) => {
    const submittedMs = new Date(v.submittedAt).getTime();
    const deadlineMs = new Date(v.deadlineAt).getTime();
    if (deadlineMs <= submittedMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "deadlineAt must be after submittedAt",
      });
    }
    if (v.status === "completed" && v.tombstoneId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tombstoneId"],
        message: "a completed deletion request must name the tombstone that completed it",
      });
    }
    if (v.status !== "completed" && v.tombstoneId !== null) {
      // A request that names a tombstone it has not been completed by is claiming a proof it does not
      // have, which is the ADR-0317 defect in a different record.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tombstoneId"],
        message: `status '${v.status}' must not name a tombstone`,
      });
    }
    if (deadlineMs - submittedMs > ARTICLE_12_MAX_DEADLINE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "GDPR Article 12(3) caps deadlineAt at 3 months from submittedAt",
      });
    }
    // The extension's two halves are load-bearing in both directions, `rejected`'s pair's shape:
    // an instant with no reason is an extension the regulation requires a reason for and this
    // record cannot state, and a reason with no instant is a reason for nothing.
    if (v.deadlineExtendedAt !== null && v.deadlineExtensionReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineExtensionReason"],
        message: "an extended deadline must state the reason Article 12(3) requires",
      });
    }
    if (v.deadlineExtendedAt === null && v.deadlineExtensionReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineExtendedAt"],
        message: "a deadline extension reason without an extension instant states a reason for nothing",
      });
    }
    // An extension recorded before the request arrived is an impossibility rather than an awkward
    // fact, which is the line ADR-0372 drew: a *late* recording is refused by nothing here, because
    // a controller that extended late did extend and destroying that evidence is worse than holding
    // it. Receiving the request is what starts the clock, so nothing can be extended before it.
    if (v.deadlineExtendedAt !== null) {
      const extendedMs = new Date(v.deadlineExtendedAt).getTime();
      if (extendedMs < submittedMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deadlineExtendedAt"],
          message: "deadlineExtendedAt must not precede submittedAt",
        });
      }
    }
    if (v.status === "verified" || v.status === "in_progress" || v.status === "completed" || v.status === "deferred") {
      if (v.verifiedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedAt"],
          message: `status '${v.status}' requires verifiedAt`,
        });
      }
      if (v.verifiedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verifiedBy"],
          message: `status '${v.status}' requires verifiedBy`,
        });
      }
      if (v.verificationMethod === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verificationMethod"],
          message: `status '${v.status}' requires verificationMethod`,
        });
      }
    }
    if (v.status === "in_progress" && v.inProgressAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inProgressAt"],
        message: "in_progress status requires inProgressAt",
      });
    }
    if (v.status === "completed") {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completed status requires completedAt",
        });
      }
      if (v.completionSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completionSha256"],
          message: "completed status requires completionSha256 (cryptographic proof)",
        });
      }
      // There is deliberately **no** refusal for `completedAt > deadlineAt`, and the absence is the
      // decision rather than an omission: a late completion is a fact that happened. Nothing in this
      // system prevents one — how long erasing a large tenant takes is not something a schema can
      // refuse — so the refusal that used to be here never prevented the breach. It only made the
      // record of it unreadable. A contract that refuses to represent a fact that happened does not
      // prevent the fact; it destroys the evidence.
      //
      // Measured, because the consequence was worse than an unwritable row.
      // `PostgresDeletionRequestStore.transition` runs its `UPDATE … RETURNING` inside
      // `conn.transaction`, which **commits**, and parses the returned row only afterwards. So for a
      // deletion that finished past its deadline: the tenant's data was destroyed, the tombstone was
      // written and anchored, the row was committed `completed` — and the call threw. `read()` then
      // threw for that row for ever, and `completedWithTombstone()` threw inside its own `.map()`, so
      // one late deletion stopped the reconciler auditing every *other* completed request.
      //
      // The breach is representable, therefore readable, therefore reportable:
      // `answeredAfterDeadline` is what answers for it, and `isOverdue` is the other half of the
      // pair. It generalises deliberately — Article 12(4) puts a *refusal* under the same clock, so
      // a reading that answered only for `completed` left a third breach shape unreadable.
    }
    if (v.status === "rejected") {
      if (v.rejectedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejectedAt"],
          message: "rejected status requires rejectedAt",
        });
      }
      if (v.rejectedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejectedReason"],
          message: "rejected status requires rejectedReason",
        });
      }
    }
    if (v.status === "deferred") {
      if (v.deferredUntil === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deferredUntil"],
          message: "deferred status requires deferredUntil",
        });
      }
      if (v.deferralReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deferralReason"],
          message: "deferred status requires deferralReason",
        });
      }
    }
    const obs = new Set<RetentionObligation>();
    v.retentionObligations.forEach((o, i) => {
      if (obs.has(o)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retentionObligations", i],
          message: `duplicate obligation '${o}'`,
        });
      }
      obs.add(o);
    });
    const hasRealObligation = v.retentionObligations.some((o) => o !== "none");
    if (hasRealObligation && v.retainedDataCategories.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataCategories"],
        message: "retentionObligations beyond 'none' must list retainedDataCategories",
      });
    }
    if (!hasRealObligation && v.retainedDataCategories.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataCategories"],
        message: "cannot retain data categories without a stated obligation",
      });
    }
  });
export type GdprDeletionRequest = z.infer<typeof GdprDeletionRequestSchema>;

/**
 * When the data subject was answered, three-valued.
 *
 * The third case is the one a boolean cannot carry and the reason this is a discriminated union
 * rather than `string | null`: a terminal request whose answer instant is absent is **not** the same
 * fact as one that is still running, and collapsing them means either asserting a breach from a
 * record that gives no time (the claim a regulator would be shown) or reporting it as healthy. The
 * schema refuses both pairings, so `answer_instant_absent` is unreachable past validation — which is
 * precisely the state a hand-edit, a restore or a newer binary's row leaves, and
 * `rowToDeletionRequest` is the only thing between such a row and a reader.
 */
export type Article12Answer =
  | { readonly kind: "unanswered" }
  | { readonly kind: "answered"; readonly at: string; readonly from: Article12AnswerInstant }
  | { readonly kind: "answer_instant_absent"; readonly from: Article12AnswerInstant };

export function article12Answer(request: GdprDeletionRequest): Article12Answer {
  const from = ARTICLE_12_ANSWER_INSTANT[request.status];
  if (from === "unanswered") return { kind: "unanswered" };
  const at = from === "completed_at" ? request.completedAt : request.rejectedAt;
  return at === null ? { kind: "answer_instant_absent", from } : { kind: "answered", at, from };
}

/**
 * Whether the data subject was answered after the Article 12(3) deadline — the breach, after the
 * fact — or `null` when no comparison is possible.
 *
 * `null` covers both *still unanswered* and *answered at an instant the record does not state*, and
 * that is honest rather than a conflation: this function's question is a comparison, and in both
 * cases there is no comparison to report. A caller that has to tell the two apart reads
 * `article12Answer`, which is the discriminated reader, and `assessDeadline` does exactly that.
 *
 * Strictly `>`, matching the deadline's own meaning: answering exactly at it is on time.
 *
 * It takes **no clock**, where `isOverdue` and `daysUntilDeadline` both do, and the asymmetry is the
 * decision rather than an oversight: both operands are stored on the record, so the answer is a
 * property of the request itself and not of when anyone asks. A `now` parameter would be unread at
 * best, and at worst would invite a reader to make a settled historical fact drift with the clock.
 */
export function answeredAfterDeadline(request: GdprDeletionRequest): boolean | null {
  const answer = article12Answer(request);
  if (answer.kind !== "answered") return null;
  return new Date(answer.at).getTime() > new Date(request.deadlineAt).getTime();
}

/**
 * Whether this request is **still waiting on an answer** past its Article 12(3) deadline.
 *
 * It reads `ARTICLE_12_ANSWER_INSTANT` rather than naming `completed` and `rejected` inline, and the
 * change is behaviour-identical today for a measured reason — those two are exactly the complement
 * of the four `unanswered` statuses — while closing the thing the inline pair could not: a seventh
 * status would have been silently *overdue-able* here and silently *unanswered* to the sweep, and
 * the two would have disagreed about one row.
 *
 * `answeredAfterDeadline` is the companion, and the two are total over a deadline breach: this one
 * for a request nobody has answered, that one for a request somebody has. The pair is why this
 * function's `false` for a terminal status is honest rather than silent; on its own it was the only
 * reading available, and it looks identical to compliance.
 *
 * `rejected` used to be excused here on the ground that "a refused request was answered rather than
 * answered late". That is the same conflation this doc warns about one paragraph up, and it is wrong
 * about the regulation: Article 12(4) puts a refusal under the same one-month clock, so a rejection
 * recorded past the deadline is a breach and `rejectedReason` says why the request was refused, not
 * why the answer was late. It answers `false` here because such a request **is** answered — that is
 * this function's whole subject — and `answeredAfterDeadline` is what reports the lateness.
 */
export function isOverdue(
  request: GdprDeletionRequest,
  now: Date = new Date(),
): boolean {
  if (ARTICLE_12_ANSWER_INSTANT[request.status] !== "unanswered") return false;
  return now.getTime() > new Date(request.deadlineAt).getTime();
}

export function daysUntilDeadline(
  request: GdprDeletionRequest,
  now: Date = new Date(),
): number {
  const ms = new Date(request.deadlineAt).getTime() - now.getTime();
  return Math.floor(ms / 1000 / 86_400);
}

export function hasRetainedData(request: GdprDeletionRequest): boolean {
  return request.retainedDataCategories.length > 0;
}

/**
 * Where one request stands against its Article 12(3) deadline.
 *
 * Six standings over two branches, and the branch is `article12Answer`'s: while the subject is
 * waiting the **wall clock** decides, and once they have been answered a **stored instant** does. The
 * two that are not findings (`within_deadline`, `answered_in_time`) are named rather than left as an
 * absence, because a sweep's answer is the *absence* of findings and that claim can only be made
 * alongside how many requests were looked at (ADR-0323).
 */
export const DEADLINE_STANDINGS = [
  /** Still waiting, and the deadline has passed. */
  "breached",
  /** Still waiting, inside the warning horizon. The one standing an act can still change. */
  "approaching",
  /** Still waiting, outside the warning horizon. */
  "within_deadline",
  /** Answered after the deadline — the breach, after the fact, and unfixable by any later act. */
  "answered_late",
  /** Answered at or before the deadline. */
  "answered_in_time",
  /**
   * Terminal, and the record does not state when the subject was answered.
   *
   * Its own standing rather than folded into either answered case, for `Article12Answer`'s reason:
   * calling it `answered_in_time` would report a record that cannot say as compliant, and
   * `answered_late` would assert a breach from a record that gives no instant.
   */
  "answer_time_unstated",
] as const;
export type DeadlineStanding = (typeof DEADLINE_STANDINGS)[number];

/**
 * What each standing means for a caller: the compliance fact, the escalation axis, and whether a
 * sweep reports it.
 *
 * **`deadlineCanStillBeMet` is the escalation axis and is the whole reason this is three facts and
 * not one.** A breach has happened and no page fixes it — `DeadlineBreach`'s own doc comment made
 * that argument when it refused to be graded `sev1` — while an *approaching* deadline is the one
 * standing where waking somebody changes the outcome, because a `verified` request the runner has
 * not yet claimed can still be erased in time. So `breached` and `deadlineCanStillBeMet` are never
 * both true, which a test asserts over the enum rather than by inspection.
 *
 * One map to a record rather than three maps, so a seventh standing is a single compile error that
 * must answer all three questions — and `reported` is in it rather than derived from the other two
 * because `answer_time_unstated` is reported while being neither a breach nor meetable, so a derived
 * predicate would have had to special-case exactly the member a total map exists to stop anyone
 * special-casing.
 *
 * The **grade** is deliberately absent. In this repository the severity *is* the route
 * (`AlertPolicy` maps a grade to a channel set), so a package that named one would be choosing which
 * rotation a deployment's compliance findings wake; what belongs here is the fact that decides
 * whether paging is coherent at all, which is `deadlineCanStillBeMet`.
 */
export interface DeadlineStandingFacts {
  /** Did the platform miss the deadline? The compliance fact a regulator is told. */
  readonly breached: boolean;
  /** Can the deadline still be met by acting now? True for exactly one standing. */
  readonly deadlineCanStillBeMet: boolean;
  /** Does a sweep report it? */
  readonly reported: boolean;
}

export const DEADLINE_STANDING_FACTS: Readonly<Record<DeadlineStanding, DeadlineStandingFacts>> =
  Object.freeze({
    breached: { breached: true, deadlineCanStillBeMet: false, reported: true },
    approaching: { breached: false, deadlineCanStillBeMet: true, reported: true },
    within_deadline: { breached: false, deadlineCanStillBeMet: false, reported: false },
    answered_late: { breached: true, deadlineCanStillBeMet: false, reported: true },
    answered_in_time: { breached: false, deadlineCanStillBeMet: false, reported: false },
    answer_time_unstated: { breached: false, deadlineCanStillBeMet: false, reported: true },
  });

/** Whether a sweep reports this standing. One reader of the map, so no caller re-derives it. */
export function isDeadlineFinding(standing: DeadlineStanding): boolean {
  return DEADLINE_STANDING_FACTS[standing].reported;
}

/**
 * How many days before its deadline a request starts being reported as `approaching`.
 *
 * An exported **starting point** and never a `z.default()` on anything
 * (`CONSERVATIVE_DELETION_CAPABILITIES`' shape, ADR-0328): seven days is a working week, which is
 * enough to verify a request and run the pipeline against an Article 12(3) month, and it is a
 * judgement rather than a measurement. `assessDeadline` **requires** the horizon so the judgement
 * cannot be made silently inside the computation; a sweep may default its option to this.
 */
export const DEFAULT_DEADLINE_WARNING_DAYS = 7;

export interface DeadlineAssessment {
  readonly standing: DeadlineStanding;
  /** Carried so a finding says which status the standing was read from. */
  readonly status: DeletionRequestStatus;
  /** The commitment **currently in force**, extension included. */
  readonly deadlineAt: string;
  /** When the subject was answered; `null` while unanswered or when the record does not say. */
  readonly answeredAt: string | null;
  /**
   * Signed milliseconds, **positive past the deadline** — so a breach is positive and an approaching
   * deadline is negative, and one spelling serves both rather than every surface re-deriving a
   * `lateByMs` of its own (`auditCompleted` used to subtract the same two instants inline beside a
   * late-completion predicate of its own).
   *
   * `null` for `answer_time_unstated` alone, where there is no instant to subtract: `0` would read
   * as "answered exactly at the deadline" and `NaN` would propagate into every figure a reader
   * renders.
   */
  readonly msPastDeadline: number | null;
  /** When Article 12(3)'s extension was recorded, so a reader knows the deadline in force moved. */
  readonly extendedAt: string | null;
  /** The horizon this assessment used, so `approaching` is legible without the caller's config. */
  readonly warningDays: number;
}

export interface AssessDeadlineOptions {
  readonly now: Date;
  /**
   * **Required**, with no default: this is the one input that decides whether a request is reported
   * at all, and an optional horizon defaulting to something is a judgement made where nobody chose
   * it (ADR-0364's addendum — an optional counter defaulting to *do not count* is the defect
   * restated as a default). `DEFAULT_DEADLINE_WARNING_DAYS` is the starting point a sweep may pass.
   */
  readonly warningDays: number;
}

/**
 * The standing of one request, and the figures a finding renders.
 *
 * Every comparison it makes is one of the readings above rather than a fourth spelling of the
 * subtraction: the unanswered branch is `isOverdue` and `daysUntilDeadline`, the answered branch is
 * `answeredAfterDeadline`. Measured before this: `isOverdue` and `daysUntilDeadline` had **zero**
 * non-test callers in the workspace, and the only one of the three that was read at all was a
 * `completed`-only predicate with a single caller. So this is where the Article 12(3) vocabulary
 * stops being a set of predicates nothing asks.
 *
 * `daysUntilDeadline` is day-granular and that is what fixes the horizon's unit: a warning measured
 * in days reads it directly rather than re-deriving a millisecond window beside it, and sub-day
 * precision on a deadline measured in months is noise. The ordering is load-bearing — `isOverdue`
 * first, because a passed deadline also satisfies `daysUntilDeadline <= warningDays` and would
 * otherwise read as `approaching`, which is the one standing that says the deadline can still be
 * met.
 */
export function assessDeadline(
  request: GdprDeletionRequest,
  opts: AssessDeadlineOptions,
): DeadlineAssessment {
  const base = {
    status: request.status,
    deadlineAt: request.deadlineAt,
    extendedAt: request.deadlineExtendedAt,
    warningDays: opts.warningDays,
  };
  const deadlineMs = new Date(request.deadlineAt).getTime();
  const answer = article12Answer(request);
  if (answer.kind === "unanswered") {
    const msPastDeadline = opts.now.getTime() - deadlineMs;
    if (isOverdue(request, opts.now)) {
      return { ...base, standing: "breached", answeredAt: null, msPastDeadline };
    }
    const standing =
      daysUntilDeadline(request, opts.now) <= opts.warningDays ? "approaching" : "within_deadline";
    return { ...base, standing, answeredAt: null, msPastDeadline };
  }
  if (answer.kind === "answer_instant_absent") {
    return {
      ...base,
      standing: "answer_time_unstated",
      answeredAt: null,
      msPastDeadline: null,
    };
  }
  const late = answeredAfterDeadline(request);
  return {
    ...base,
    standing: late === true ? "answered_late" : "answered_in_time",
    answeredAt: answer.at,
    msPastDeadline: new Date(answer.at).getTime() - deadlineMs,
  };
}

/**
 * Why a deadline extension is refused.
 *
 * Properties of the request and the proposed deadline **alone**, which is what decides that they
 * live here rather than at the store: ADR-0348's split — a rule decidable from the record is
 * decidable earlier, by a validator, by a test and by whatever surface offers the act — and all four
 * are checkable before any statement is issued, so a refusal means nothing was written.
 */
export const DEADLINE_EXTENSION_REFUSALS = [
  /**
   * The request has already been answered. Extending the deadline of a completed or rejected request
   * would move the line a settled fact is judged against, which is the one edit that can turn a
   * recorded breach into a recorded compliance (ADR-0323's tampered scope, in a second record).
   */
  "request_already_answered",
  /**
   * The deadline has been extended once already. Article 12(3) grants *an* extension of two further
   * months, singular, and one extension per request is what makes `deadlineExtendedAt` the instant
   * the notification obligation is read against rather than the latest of several.
   */
  "already_extended",
  /** The proposed deadline is not later than the one in force, so it extends nothing. */
  "not_an_extension",
  /** Article 12(3) caps the total at three months from receipt. */
  "exceeds_article_12_cap",
  /**
   * The extension is recorded as having been granted before the request arrived.
   *
   * Refused here rather than left to the schema, which also refuses it: past the write the row is
   * committed and unreadable, so a caller would be told a deletion request's deadline moved and that
   * the row cannot be read back — for an input that could have been refused before any statement.
   */
  "recorded_before_submission",
] as const;
export type DeadlineExtensionRefusal = (typeof DEADLINE_EXTENSION_REFUSALS)[number];

/**
 * The three facts an extension states.
 *
 * Named for the **columns** they are bound into rather than for the act — `transition`'s sibling
 * `fields.at` convention would have read naturally here and is refused for a measured reason: the
 * store's `UPDATE … SET` assignments are read by `pg-binding-names.ts`, and `deadline_at <- to` is
 * exactly its `act_parameter` divergence kind, so the house convention would have owed three
 * declarations in a workspace rule to say that three names which could simply agree do not.
 * Agreement is the norm here (682 of 764 bindings), and mirroring the record's own field names also
 * makes the call site say which commitment each value is.
 */
export interface DeadlineExtensionInput {
  /** The new deadline, which replaces the one in force. */
  readonly deadlineAt: string;
  /** When the extension was granted. */
  readonly deadlineExtendedAt: string;
  /** The reason Article 12(3) obliges the controller to state. */
  readonly deadlineExtensionReason: string;
}

export type DeadlineExtensionPlan =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: DeadlineExtensionRefusal; readonly detail: string };

/**
 * Whether Article 12(3)'s extension may be applied to this request, and why not.
 *
 * **The extension is applied to `deadlineAt` in place, and that is the decision.** A second column
 * holding an extended deadline beside the submitted one was refused on a measurement: `deadlineAt`
 * has five readers that compare it (the schema's cap, `isOverdue`, `answeredAfterDeadline`,
 * `daysUntilDeadline`, and the store's `ORDER BY deadline_at`) plus the partial index behind the
 * scheduler's claim, and every one of them would have had to coalesce. Forgetting at any single site
 * reports a lawfully extended request as a breach — which is the exact hazard the register named,
 * created by the fix rather than closed by it. Mutating in place makes every existing reader correct
 * by construction and leaves `deadlineExtendedAt` as the trace.
 *
 * The cost is stated rather than hidden: **the original deadline is not stored.** It is not
 * load-bearing for any Article 12 check — the cap is measured from `submittedAt`, which is
 * immutable — and the act is a privileged one whose audit row carries the before and after, which is
 * where a history belongs (the store holds the commitment in force; the trail holds how it moved).
 */
export function planDeadlineExtension(
  request: GdprDeletionRequest,
  input: DeadlineExtensionInput,
): DeadlineExtensionPlan {
  if (ARTICLE_12_ANSWER_INSTANT[request.status] !== "unanswered") {
    return {
      ok: false,
      refusal: "request_already_answered",
      detail: `status '${request.status}' has already answered the data subject`,
    };
  }
  if (request.deadlineExtendedAt !== null) {
    return {
      ok: false,
      refusal: "already_extended",
      detail: `the deadline was already extended at ${request.deadlineExtendedAt}`,
    };
  }
  const toMs = new Date(input.deadlineAt).getTime();
  const currentMs = new Date(request.deadlineAt).getTime();
  if (!(toMs > currentMs)) {
    return {
      ok: false,
      refusal: "not_an_extension",
      detail: `${input.deadlineAt} is not later than the deadline in force (${request.deadlineAt})`,
    };
  }
  const submittedMs = new Date(request.submittedAt).getTime();
  if (toMs - submittedMs > ARTICLE_12_MAX_DEADLINE_MS) {
    return {
      ok: false,
      refusal: "exceeds_article_12_cap",
      detail: "GDPR Article 12(3) caps the deadline at 3 months from submission",
    };
  }
  if (new Date(input.deadlineExtendedAt).getTime() < submittedMs) {
    return {
      ok: false,
      refusal: "recorded_before_submission",
      detail: `${input.deadlineExtendedAt} precedes the request's submittedAt (${request.submittedAt})`,
    };
  }
  return { ok: true };
}
