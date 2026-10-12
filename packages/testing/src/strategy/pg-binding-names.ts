/**
 * Does a column's name agree with the name of the value bound into it?
 *
 * ADR-0354 derived, per catalogued column, the workspace **symbol** the SQL binds into it, and
 * compared that symbol against `VALUE_SET_DOMAINS`' declared domain. Its own first open end named
 * what that comparison cannot see: *a store writing `record.kind` into the `status` column passes
 * this rule and `pg-column-coverage.ts` both.* Both of those ask whether the column exists and
 * whether the value's **type** is right; neither asks whether the value is the one the column is
 * for. A transposition inside one `VALUES` list satisfies every rule in this directory.
 *
 * The signal is the names. This repo spells a column `snake_case` and its contract field
 * `camelCase`, and **682 of 764 bindings agree exactly** under that one transform. So agreement is
 * the default and every divergence is accounted for — by a *derivation* whose tightness this module
 * re-asserts on every run, or by a declaration carrying its reason.
 *
 * It reads the real workspace from disk, like its siblings, and consumes
 * `pg-column-bindings.ts`' extraction rather than scanning again: one extractor, two questions.
 */
import { z } from "zod";

import type { ColumnBinding } from "./pg-column-bindings.js";
import type { CatalogColumn, CatalogTable } from "./pg-column-coverage.js";

/* ------------------------------------------------------------ the transform */

/** `tenant_id` → `tenantId`: the one transform this repo's column and field names differ by. */
export function camelOfColumn(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `tenantId` → `tenant_id`, for asking whether a property names some *other* column. */
export function columnOfCamel(property: string): string {
  return property.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/* ------------------------------------------------------------ derivations */

/**
 * The divergences that follow from a rule rather than from a decision.
 *
 * Deliberately two, and the four that are **not** here were each refused on a measurement rather
 * than on taste — see `REFUSED_DERIVATIONS`, which keeps the numbers next to the refusal so nobody
 * reaches for them a second time.
 */
export const NAME_DERIVATIONS = ["business_key", "resolved_surrogate"] as const;
export type NameDerivation = (typeof NAME_DERIVATIONS)[number];

export interface DerivationRule {
  /** Whether this derivation explains binding `property` into `column` of `table`. */
  readonly admits: (column: CatalogColumn, property: string, table: CatalogTable) => boolean;
  /** Why the divergence is principled, in one sentence. */
  readonly because: string;
  /** Why the rule cannot admit a property into two columns of one table. */
  readonly tightness: string;
}

/**
 * A total map, so a third derivation cannot land without stating both why it is principled and why
 * it is tight — and `derivation_ambiguous` then checks the second claim against the catalog on
 * every run, rather than trusting a measurement taken once.
 */
export const DERIVATION_RULES: Readonly<Record<NameDerivation, DerivationRule>> = Object.freeze({
  business_key: {
    admits: (column, property) =>
      property === "id" &&
      column.name.endsWith("_id") &&
      column.unique &&
      column.references === null,
    because:
      "the column is the row's own business key — a single-column UNIQUE `*_id` referencing " +
      "nothing — and the contract that owns the record calls its own identity `id`.",
    tightness:
      "a column-level UNIQUE identifies the row, a foreign key identifies another row, and a " +
      "non-unique `*_id` identifies nothing; measured over the catalog, 72 tables declare exactly " +
      "one such column and 74 declare none, so `record.id` has at most one place to land. " +
      "Dropping the UNIQUE requirement is what makes this unsound: 72 tables have more than one " +
      "non-FK `*_id` column and one has eight.",
  },
  resolved_surrogate: {
    admits: (column, property) =>
      column.name.endsWith("_id") && property === `${camelOfColumn(column.name.slice(0, -3))}Uuid`,
    because:
      "the contract names a row by its business id and the column holds the UUID surrogate, so the " +
      "store resolves one to the other and names the local `<noun>Uuid`.",
    tightness:
      "the noun appears on both sides, so the property names its own column and no other; " +
      "measured, no bound property is admitted into more than one column of its table.",
  },
});

/**
 * Derivations measured and refused, with the measurement that refuses them.
 *
 * Kept as data rather than as prose in an ADR because each one is the *obvious* generalisation of a
 * rule that is here, and the counts are what separate them.
 */
export const REFUSED_DERIVATIONS: readonly { readonly rule: string; readonly refutation: string }[] =
  Object.freeze([
    {
      rule: "`*_id` <- `id` for any column with no foreign key",
      refutation:
        "72 of 146 tables have more than one non-FK `*_id` column — `meta.tenant_tombstones` has " +
        "four and one table has eight — so it would admit a record's own id into any of them. " +
        "`business_key` is this rule plus the column-level UNIQUE the catalog already declares.",
    },
    {
      rule: "the property is a camel-boundary suffix of the column name",
      refutation:
        "`id` is a suffix of 11 columns of `meta.workflow_events` (`event_id`, `instance_id`, " +
        "`causation_event_id`, …) and `at` of 4 of `meta.notification_deliveries`, so it admits " +
        "exactly the transposition this rule exists to catch.",
    },
    {
      rule: "the property and the column share a leading token of four characters or more",
      refutation:
        "138 bound properties are admitted into more than one column of their own table.",
    },
    {
      rule: "the property names a different column of the same table (as a *detector* rather than a derivation)",
      refutation:
        "it fires on 17 bindings of which 16 are `business_key`, because every catalogued table " +
        "carries both a UUID `id` surrogate and a TEXT business key; the declared **type** is what " +
        "separates them, which is why `property_names_sibling_column` requires the types to match.",
    },
  ]);

/** The derivation that explains this binding, or `null`. */
export function derivationFor(
  binding: ColumnBinding,
  table: CatalogTable,
): NameDerivation | null {
  const column = table.columns.find((c) => c.name === binding.column);
  if (column === undefined || binding.property === null) return null;
  for (const name of NAME_DERIVATIONS) {
    if (DERIVATION_RULES[name].admits(column, binding.property, table)) return name;
  }
  return null;
}

/** Every column of `table` the derivation would admit `property` into. */
export function derivationTargets(
  derivation: NameDerivation,
  property: string,
  table: CatalogTable,
): readonly string[] {
  return table.columns
    .filter((c) => DERIVATION_RULES[derivation].admits(c, property, table))
    .map((c) => c.name);
}

/* ---------------------------------------------------------- declarations */

/**
 * Why a column's name and its bound property's name differ, where no derivation explains it.
 *
 * **Settled from the adjudications rather than before them.** Every one of the 28 divergences was
 * read by an agent given the store, the catalogued column and the contract field and asked to name
 * the convention in its own words; **17 distinct convention names** came back, and these five are
 * what they collapse onto once the two derivations above are taken out. Four of the six kinds this
 * module was first drafted with had no member at all and are gone.
 *
 * The axis is *what a reader has to check*, which is why `act_parameter` and `qualifier_differs`
 * are separate: for the first the two names denote different things and the question is whether the
 * act's input really is this field, and for the second they denote the same thing and the question
 * is whether the qualifier changes which.
 */
export const NAME_DIVERGENCE_KINDS = [
  /**
   * A field lifted out of a sub-record, the column folding the sub-record's name in as a prefix:
   * `attestation_kind` <- `decision.attestation.kind`. Check: the prefix names the sub-record read.
   */
  "nested_record",
  /**
   * The bound value is an argument of the *act*, named in the act's vocabulary where the column
   * names the record's field: `status` <- a transition's `to`, `finalized_at` <- `at`. Check: the
   * act's parameter is this field and not another of the same type.
   */
  "act_parameter",
  /**
   * The two names denote the same fact and one carries a qualifier the other omits — in either
   * direction: `delivered_count` <- `delivered`, `decided_at` <- `decidedAtIso`. Check: the
   * qualifier does not change which fact it is.
   */
  "qualifier_differs",
  /**
   * The value is a constant or computed in the statement and is not a field of any record:
   * `error_message` <- `SUPERSEDED_ERROR_MESSAGE`. Check: the column may carry it.
   */
  "statement_local",
  /**
   * The column's **name denotes a different fact** than the value, deliberately, because the column
   * serves a second purpose: `started_at` holds a job's due instant. The one kind that admits the
   * name is wrong rather than merely vaguer, so it is the one a real transposition could hide in —
   * which is why `requiresCatalogComment` makes it cost something the next reader will see.
   */
  "column_overloaded",
] as const;
export type NameDivergenceKind = (typeof NAME_DIVERGENCE_KINDS)[number];

export interface DivergenceKindRule {
  /** What a reader must check to believe a declaration of this kind. */
  readonly check: string;
  /**
   * Whether the catalogued column must carry a source comment naming itself.
   *
   * Required for `column_overloaded` alone: that declaration asserts the column's name is wrong,
   * and a declaration living only in this directory leaves the catalog — where the next person
   * reads — still saying the wrong thing. The comment must contain the column's own name, so a
   * comment attributed from the line above cannot satisfy it.
   */
  readonly requiresCatalogComment: boolean;
}

/** A total map, so a sixth kind cannot land without saying what believing it requires. */
export const DIVERGENCE_KIND_RULES: Readonly<Record<NameDivergenceKind, DivergenceKindRule>> =
  Object.freeze({
    nested_record: {
      check: "the prefix names the sub-record the property was read off",
      requiresCatalogComment: false,
    },
    act_parameter: {
      check: "the act's parameter is this field and not another of the same type",
      requiresCatalogComment: false,
    },
    qualifier_differs: {
      check: "the qualifier one side omits does not change which fact it is",
      requiresCatalogComment: false,
    },
    statement_local: {
      check: "the column is one the constant may live in",
      requiresCatalogComment: false,
    },
    column_overloaded: {
      check:
        "nothing reads the column as its name says, and the catalog says so where the next reader looks",
      requiresCatalogComment: true,
    },
  });

export const BindingNameDivergenceSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  /** The property name, as the binding spells it — the receiver is deliberately not part of the key. */
  property: z.string().min(1),
  kind: z.enum(NAME_DIVERGENCE_KINDS),
  /** The evidence: what was read to decide this writes the right value. */
  note: z.string().min(40),
});
export type BindingNameDivergence = z.infer<typeof BindingNameDivergenceSchema>;

/**
 * Every divergence in the workspace no derivation explains, with what was read to decide it.
 *
 * All 28 were adjudicated against the store, the catalogued column and the contract field, and
 * **none was a defect**: the two that read as suspicious were handed to an independent verifier
 * asked to refute them and both were dismissed on facts the first pass had not established — see
 * the `rate_limit_decisions.route` and `job_runs.started_at` notes, which carry those facts rather
 * than the suspicion.
 *
 * The key is `(table, column, property)` and deliberately not the call site: the same divergence in
 * an `INSERT` and in its `ON CONFLICT … DO UPDATE` arm is one decision, and `EXCLUDED.<col>`
 * resolves back through the same column list, so requiring two declarations would ask for the same
 * evidence twice.
 */
export const BINDING_NAME_DIVERGENCES: readonly BindingNameDivergence[] = Object.freeze([
  /* -------------------------------------------------- nested_record (6) */
  {
    table: "access_review_decisions",
    column: "attestation_kind",
    property: "kind",
    kind: "nested_record",
    note:
      "`att` is `decision.attestation`, whose `kind: z.enum(ATTESTATION_KINDS)` matches this " +
      "column's CHECK member for member. This is the one real transposition risk in the package — " +
      "the same statement also writes the top-level `kind` column from `decision.kind` " +
      "(DECISION_KINDS) — and it is not transposed: `decision.kind` is param 7 against column 7 " +
      "`kind` and `att.kind` is param 12 against column 12 `attestation_kind`. The two CHECK sets " +
      "are disjoint, so a swap would raise 23514 on every insert. `rowToDecision` reads it back as " +
      "`attestation.kind`.",
  },
  {
    table: "access_review_decisions",
    column: "attestation_signature_sha256",
    property: "signatureSha256",
    kind: "nested_record",
    note:
      "CHAR(64) with `IS NULL OR ~ '^[0-9a-f]{64}$'` against `signatureSha256` " +
      "(decisions.ts:67), the same pattern and the same nullability; the `attestation_` prefix is " +
      "the flattening of `decision.attestation`, and `rowToDecision` maps it back.",
  },
  {
    table: "access_review_decisions",
    column: "attestation_signing_key_fingerprint",
    property: "signingKeyFingerprint",
    kind: "nested_record",
    note:
      "The same CHAR(64) CHECK against `signingKeyFingerprint` (decisions.ts:68). A swap with the " +
      "signature column beside it would be undetectable by CHECK, both being 64 hex chars, so the " +
      "evidence here is positional: param 13 into column 13, param 14 into column 14, and " +
      "`rowToDecision` reads each back into its own field.",
  },
  {
    table: "access_review_items",
    column: "current_reviewer_user_id",
    property: "reviewerUserId",
    kind: "nested_record",
    note:
      "`reviewer` is `item.currentReviewer`, a nullable `ReviewerAssignmentState`; the bound " +
      "expression `reviewer?.reviewerUserId ?? null` matches the column's nullability and " +
      "`rowToItem` rebuilds the sub-record from it. The column keeps its `meta.users` FK rather " +
      "than being TEXT-ified under ADR-0335's rule because it records who is *currently assigned* " +
      "— live state about a person — not who performed a past act.",
  },
  {
    table: "access_review_items",
    column: "current_reviewer_kind",
    property: "reviewerKind",
    kind: "nested_record",
    note:
      "The column's CHECK is `REVIEWER_KINDS` exactly (items.ts:39) and the field is " +
      "`z.enum(REVIEWER_KINDS)`; `records.ts` even types the row field as " +
      "`NonNullable<AccessReviewItem[\"currentReviewer\"]>[\"reviewerKind\"] | null`. The " +
      "`IS NULL OR IN (…)` form admits the cleared case an unassigned item needs.",
  },
  {
    table: "access_review_items",
    column: "reviewer_assigned_at",
    property: "assignedAt",
    kind: "nested_record",
    note:
      "Holds `item.currentReviewer.assignedAt` — when the *current reviewer* was assigned, which " +
      "`assignAccessReviewItemReviewer` stamps at the moment of assignment — and is distinct from " +
      "this row's `created_at` and `opened_for_review_at`. The prefix is `reviewer_` where the two " +
      "kind columns say `current_reviewer_`, an inconsistency inside the flattening and not a " +
      "wrong value. All three move together in one `SET` list, so the row cannot be half-assigned.",
  },

  /* ------------------------------------------------- act_parameter (10) */
  {
    table: "architect_tenant_cost",
    column: "dollars_used",
    property: "dollars",
    kind: "act_parameter",
    note:
      "`addMonthly`'s `dollars` is a per-call delta and the column is a per-period cumulative " +
      "total — used as both on purpose: on the INSERT arm the row does not exist so the first " +
      "increment *is* the total, and on conflict the same value is re-read through " +
      "`EXCLUDED.dollars_used` and added, which is an atomic accumulate with no read-modify-write " +
      "race across nodes. Both callers pass a per-call cost and the wrapper returns early at or " +
      "below zero, so the `dollars_used >= 0` CHECK holds.",
  },
  {
    table: "job_runs",
    column: "status",
    property: "disposition",
    kind: "act_parameter",
    note:
      "`finalizeFailure`'s `disposition` is the two-member union `\"failed\" | \"dead-lettered\"`, " +
      "both members of this column's six-value CHECK; the sibling terminal paths write the others " +
      "(`status = 'completed'`, `status = 'cancelled'`). A single write path need not cover the " +
      "domain — this is `pg-column-bindings.ts`' legitimate inline-literal-subset case. The local " +
      "is the engine's word for the outcome it decided, persisted as the row's status.",
  },
  {
    table: "notification_deliveries",
    column: "finalized_at",
    property: "at",
    kind: "act_parameter",
    note:
      "`supersedeDeferred` moves the outcome from `deferred` to the terminal `suppressed` and " +
      "stamps the attempt's terminal instant in the same statement; `finalizedAt`'s own " +
      "`superRefine` only orders it after `sentAt`, and the sole caller passes `now`. The " +
      "parameter names the act's time, the column names the field.",
  },
  {
    table: "notification_digests",
    column: "assembled_at",
    property: "at",
    kind: "act_parameter",
    note:
      "`markAssembled` writes `status = 'assembled'` and this column in one UPDATE, which is " +
      "exactly what the contract's `superRefine` requires — `assembledAt` non-null for " +
      "`assembled`/`dispatched` and null otherwise — and it is defined as when the body was built, " +
      "distinct from `dispatchedAt` and from the summary dispatch's `completedAt`. Both callers " +
      "pass `now`.",
  },
  {
    table: "notification_dispatches",
    column: "completed_at",
    property: "at",
    kind: "act_parameter",
    note:
      "The contract is explicit that `completedAt` is the finalisation instant of *any* terminal " +
      "status and not only `completed`, and its `superRefine` requires it for every terminal " +
      "status and forbids it otherwise — so writing it beside `status = $3` on both the completed " +
      "and failed branches is the contract's own pairing rather than a mislabel.",
  },
  {
    table: "operate_sequences",
    column: "current_value",
    property: "start",
    kind: "act_parameter",
    note:
      "`RETURNING current_value` is handed straight back as the allocated value, so the invariant " +
      "is *the last value handed out* and not the next one; `SequenceAllocationInput.start` is " +
      "documented as the first value handed out for a fresh period, so on the INSERT arm the two " +
      "coincide and the ON CONFLICT arm continues with `current_value + 1`. Were the column a next " +
      "value this allocator would be off by one on every period's first allocation. The pure " +
      "`InMemorySequenceAllocator` runs the identical algorithm under the same invariant.",
  },
  {
    table: "tenants",
    column: "status",
    property: "to",
    kind: "act_parameter",
    note:
      "`transitionStatus(id, to, from)` writes `SET status = $2` while `from` populates only the " +
      "`WHERE … status IN (…)` candidate list (ADR-0321's \"the row is the lock\"), so `to` is the " +
      "destination state and is typed `TenantStatus` against the same five-value CHECK. The names " +
      "differ because `to`/`from` name the edge and the column names the state.",
  },
  {
    table: "users",
    column: "status",
    property: "to",
    kind: "act_parameter",
    note:
      "The same shape against `USER_STATUSES`. Table attribution confirmed: `this.users` is " +
      "`${schema}.users`, not `${schema}.user_tenant_membership`, whose status set is the " +
      "different `('active', 'invited', 'revoked')` — so the CHECK this `to` is typed against is " +
      "this column's and not the membership table's.",
  },
  {
    table: "workflow_activities",
    column: "claimed_by",
    property: "workerId",
    kind: "act_parameter",
    note:
      "`SET claimed_by = $3, claim_expires_at = $4::timestamptz` against " +
      "`[options.now, limit, options.workerId, claimExpiresAt]`, so the lease owner and the lease " +
      "expiry are not transposed. `workerId` is `hostname():pid` precisely so an operator can " +
      "answer \"which process holds this lease\" from the row alone; TEXT rather than a " +
      "`meta.users` FK because a worker process is not a user, and nullable because NULL is the " +
      "unclaimed state the claim predicate tests.",
  },
  {
    table: "workflow_timers",
    column: "claimed_by",
    property: "workerId",
    kind: "act_parameter",
    note:
      "Identical shape to the activity claim, and `ClaimDueTimersOptions.workerId` carries the doc " +
      "comment that settles it — \"Stable id of the claiming worker (recorded on the row for " +
      "observability + lease ownership)\". Nullable so NULL means unclaimed for the " +
      "`claimed_by IS NULL OR claim_expires_at < $1` predicate.",
  },

  /* --------------------------------------------- qualifier_differs (10) */
  {
    table: "billing_usage_records",
    column: "synced_to_stripe_at",
    property: "syncedAt",
    kind: "qualifier_differs",
    note:
      "The snake_case of `UsageRecord.syncedToStripeAt` *is* this column's name, and the only " +
      "reader — `listUnsynced`'s `WHERE synced_to_stripe_at IS NULL`, backed by " +
      "`idx_billing_usage_records_unsynced` — fixes the meaning as the instant the record was " +
      "reported to Stripe. The local is `markSynced`'s parameter, whose sole call site passes " +
      "`this.now().toISOString()` immediately after `createUsageRecord` returns; it drops only the " +
      "`_to_stripe` qualifier the Stripe-specific method already carries.",
  },
  {
    table: "crypto_keys",
    column: "fingerprint_sha256",
    property: "fingerprint",
    kind: "qualifier_differs",
    note:
      "The column is CHAR(64) with `IS NULL OR ~ '^[0-9a-f]{64}$'` and " +
      "`KeyRegistryRecordSchema.fingerprint` is the same predicate including the NULL arm, which is " +
      "live because the hmac algorithm has no public key to fingerprint. The value is genuinely a " +
      "sha256: `ed25519PublicKeyFingerprint` is `sha256(publicKeyBytes)` as 64 lowercase hex " +
      "chars, so the `_sha256` qualifier the property omits is a fact about it rather than a " +
      "different fact. `rowToKeyRegistryRecord` closes the round trip.",
  },
  {
    table: "dead_letter_jobs",
    column: "job_id",
    property: "jobDefinitionId",
    kind: "qualifier_differs",
    note:
      "`DeadLetterRecordSchema.jobId` *is* the `JobDeclaration.id`, which is what the local name " +
      "spells out; the local is the more explicit one because `recordDeadLetter`'s input carries " +
      "`runId` beside it. They are not swapped, and the casts are independent evidence: " +
      "`job_id <- $2` uncast against catalogued TEXT, `run_id <- $3::uuid` against catalogued " +
      "UUID. This is the one statement in the block where a transposition was structurally " +
      "available. `meta.job_runs.job_id` holds the declaration id too.",
  },
  {
    table: "gateway_routes",
    column: "created_by",
    property: "createdByUserId",
    kind: "qualifier_differs",
    note:
      "The catalog's own comment on this column names this binding: TEXT and unreferenced because " +
      "it records who did a thing, which must outlive the actor (ADR-0335), and \"a route is " +
      "registered by the *process* at boot … there is no person in this story at any point\". So " +
      "the column is the actor id, the parameter is the actor id, and the names differ by the " +
      "`UserId` suffix alone — which is also why a non-UUID process identity is acceptable here.",
  },
  {
    table: "notification_dispatches",
    column: "delivered_count",
    property: "delivered",
    kind: "qualifier_differs",
    note:
      "The local is `Number(counts[\"delivered_count\"])`, read **by alias name** from the " +
      "aggregate's `COUNT(*) FILTER (WHERE latest.outcome = 'delivered') AS delivered_count`: " +
      "alias, local and column are one name with the suffix dropped only in the local.",
  },
  {
    table: "notification_dispatches",
    column: "failed_count",
    property: "failed",
    kind: "qualifier_differs",
    note:
      "`Number(counts[\"failed_count\"])` against the aggregate alias for outcomes that are " +
      "neither delivered nor suppressed and are not awaiting retry. The check matters here because " +
      "`failed_count` and `suppressed_count` are both `INTEGER >= 0` and a swap would pass every " +
      "CHECK: the aggregate declares its aliases in the order delivered, suppressed, failed, " +
      "pending, and the locals are read **by name** from `rows[0]` rather than destructured " +
      "positionally, so that declaration order is inert.",
  },
  {
    table: "notification_dispatches",
    column: "suppressed_count",
    property: "suppressed",
    kind: "qualifier_differs",
    note:
      "`Number(counts[\"suppressed_count\"])` against the alias for `outcome = 'suppressed'`, read " +
      "by name and so not transposed with `failed_count`. The semantics agree with the statement's " +
      "own comment and with `SUPERSEDE_TO_OUTCOME`: a notice withheld by policy — an opt-out, or a " +
      "digest that carried it — is suppressed and must not land in the failure bucket.",
  },
  {
    table: "operate_tenant_manifests",
    column: "review_notes",
    property: "notes",
    kind: "qualifier_differs",
    note:
      "The column sits in the catalog's review block immediately after `reviewed_by`/`reviewed_at`, " +
      "and the same store reads it back into its own `reviewNotes` field. " +
      "`decide(id, 'approved' | 'rejected', {reviewedBy, notes})` is already scoped to a review " +
      "decision, so the parameter drops the prefix the column needs to distinguish it from the " +
      "manifest's `description`.",
  },
  {
    table: "rate_limit_decisions",
    column: "decided_at",
    property: "decidedAtIso",
    kind: "qualifier_differs",
    note:
      "`check()` fills it as `input.now.toISOString()` at the moment the decision is taken — the " +
      "same `input.now` the window arithmetic and `resetAt` come from — and the mirror field is " +
      "`decidedAt: z.string().datetime({offset: true})`. The property differs by an `Iso` suffix " +
      "naming the wire form, which is needed because the column is TIMESTAMPTZ and the record " +
      "carries a string. Distinct from `reset_at` on the same row, so the two instants are not " +
      "transposed.",
  },
  {
    table: "rate_limit_decisions",
    column: "route",
    property: "routeOperationId",
    kind: "qualifier_differs",
    note:
      "The decisive fact, which an adversarial pass established and the first reading missed: " +
      "`RouteDefinition` has **no path string**. It carries `pathSegments` of " +
      "literal/parameter/wildcard objects and the sole consumer of that array in the workspace " +
      "turns it into a `RegExp`; there is no path renderer anywhere in `packages/` or `apps/`. So " +
      "the operationId is not one of two close concepts — it is the only route identity that " +
      "exists as a string, is already unique, and already rides in `scope_key` on the same row. " +
      "The `RateLimitDecisionSchema.route` this column appears to mirror is not the contract the " +
      "value comes from: the checker imports `RateLimitDecision` from `@crossengin/api-gateway-" +
      "runtime`, which has no `route` field, and the `@crossengin/rate-limiting` schema has zero " +
      "consumers outside its own package. The column is vaguer than its sibling " +
      "`meta.gateway_pipeline_executions.route_operation_id`; see the source comment.",
  },

  /* ---------------------------------------------- statement_local (1) */
  {
    table: "notification_deliveries",
    column: "error_message",
    property: "SUPERSEDED_ERROR_MESSAGE",
    kind: "statement_local",
    note:
      "The constant's own doc comment states the purpose: written to the superseded attempt's " +
      "`error_message` so the trail says why the individual send never went out — the digest " +
      "replaced it. The column is plain nullable TEXT with no CHECK restricting it to failures and " +
      "is the only free-text column on the row (`error_code` is left null). A mild concept stretch " +
      "— `rolled_into_digest` is a policy reason, not an error — but deliberate, documented, and " +
      "with no alternative column to carry it.",
  },

  /* -------------------------------------------- column_overloaded (1) */
  {
    table: "job_runs",
    column: "started_at",
    property: "fireAt",
    kind: "column_overloaded",
    note:
      "The column is the queue's visibility column, not a start time: the enqueuer writes the " +
      "cron tick (`cronPrevOnOrBefore`, so <= now and immediately claimable), the claim filters " +
      "`started_at <= $1` and orders by it, and a retry pushes it **forward** to `now + backoff`, " +
      "a future instant relative to any start. Two facts make it the right value rather than a " +
      "defect, and an adversarial pass established both. First, the contract that would say " +
      "otherwise is dead: nothing in `packages/` or `apps/` constructs or serves a " +
      "`JobRunRecord`, and the producer provably does not implement it — " +
      "`JobRunTriggerInfoSchema`'s scheduled member is `{kind, scheduledFor}` and the writer emits " +
      "`{kind, cron, fireAt}`. Second, no read path can return the wrong field: every `SELECT` " +
      "against `meta.job_runs` names its columns and none names this one, so it appears only in " +
      "the claim predicate, the `ORDER BY` and the retry `SET`. `duration_ms` comes from an " +
      "in-process `execStart` and never from this column, and the tick is independently preserved " +
      "under its honest name inside the `trigger` JSONB as `fireAt`. The honest remedy is a " +
      "separate `due_at` column, which is a schema change and not a different source for this " +
      "parameter.",
  },
]);

/* --------------------------------------------------------------- findings */

/**
 * What the audit can find.
 *
 * `transposed_pair` and `property_names_sibling_column` are first because they are the
 * transposition signature: a property naming a different column of the same table *with the same
 * declared type*, and — confirmed — two columns in one statement each bound from the other's name.
 * `transposed_pair` is the only finding no declaration can resolve.
 *
 * `sibling_unaddressed` and `overload_uncommented` are the price of the two declarations that could
 * otherwise wave the signature away: resolving a sibling collision requires naming the column it
 * could have been confused with, and declaring a column's name wrong requires the catalog to say so.
 */
export const BINDING_NAME_FINDING_KINDS = [
  "transposed_pair",
  "property_names_sibling_column",
  "sibling_unaddressed",
  "overload_uncommented",
  "derivation_ambiguous",
  "undeclared_divergence",
  "divergence_overtaken",
  "divergence_duplicate",
  "divergence_unknown_column",
] as const;
export type BindingNameFindingKind = (typeof BINDING_NAME_FINDING_KINDS)[number];

export const BindingNameFindingSchema = z.object({
  kind: z.enum(BINDING_NAME_FINDING_KINDS),
  table: z.string().min(1),
  column: z.string().min(1),
  detail: z.string().min(1),
});
export type BindingNameFinding = z.infer<typeof BindingNameFindingSchema>;

export interface BindingNameAuditInput {
  readonly catalog: readonly CatalogTable[];
  readonly bindings: readonly ColumnBinding[];
  readonly divergences?: readonly BindingNameDivergence[];
}

export interface BindingNameSummary {
  /** Bindings whose column name and property name agree under the one transform. */
  readonly agreeing: number;
  /** Bindings a derivation explains, by derivation. */
  readonly derived: Readonly<Record<NameDerivation, number>>;
  /** Bindings a declaration explains. */
  readonly declared: number;
  /** Literal bindings, which carry no name to compare. */
  readonly literals: number;
  /** Bindings whose column the catalog does not declare, which this rule cannot judge. */
  readonly uncatalogued: number;
  readonly total: number;
}

function divergenceKey(d: { table: string; column: string; property: string }): string {
  return `${d.table}.${d.column}<-${d.property}`;
}

/** The bindings this rule has an opinion about: a named property into a catalogued column. */
function comparable(
  input: BindingNameAuditInput,
): readonly { readonly binding: ColumnBinding; readonly table: CatalogTable }[] {
  const byName = new Map(input.catalog.map((t) => [t.name, t]));
  const out: { binding: ColumnBinding; table: CatalogTable }[] = [];
  for (const binding of input.bindings) {
    if (binding.kind === "literal" || binding.property === null) continue;
    const table = byName.get(binding.table);
    if (table === undefined) continue;
    if (!table.columns.some((c) => c.name === binding.column)) continue;
    out.push({ binding, table });
  }
  return out;
}

export function auditBindingNames(
  input: BindingNameAuditInput,
): readonly BindingNameFinding[] {
  const findings: BindingNameFinding[] = [];
  const declared = input.divergences ?? [];
  const byKey = new Map<string, BindingNameDivergence>();
  const byName = new Map(input.catalog.map((t) => [t.name, t]));

  for (const d of declared) {
    const key = divergenceKey(d);
    if (byKey.has(key)) {
      findings.push(
        BindingNameFindingSchema.parse({
          kind: "divergence_duplicate",
          table: d.table,
          column: d.column,
          detail: `BINDING_NAME_DIVERGENCES declares \`${key}\` twice`,
        }),
      );
      continue;
    }
    byKey.set(key, d);
    const table = byName.get(d.table);
    const column = table?.columns.find((c) => c.name === d.column);
    if (column === undefined) {
      findings.push(
        BindingNameFindingSchema.parse({
          kind: "divergence_unknown_column",
          table: d.table,
          column: d.column,
          detail: `BINDING_NAME_DIVERGENCES declares a divergence on a column the catalog does not declare`,
        }),
      );
      continue;
    }
    if (
      DIVERGENCE_KIND_RULES[d.kind].requiresCatalogComment &&
      !(column.comment ?? "").includes(d.column)
    ) {
      findings.push(
        BindingNameFindingSchema.parse({
          kind: "overload_uncommented",
          table: d.table,
          column: d.column,
          detail:
            `BINDING_NAME_DIVERGENCES declares \`${d.column}\` as \`${d.kind}\` — that the column's ` +
            `name denotes a different fact than the value — and the catalog carries no comment on ` +
            `it naming it. A declaration living only in this directory leaves the catalog, where ` +
            `the next person reads, still saying the wrong thing: ` +
            `${DIVERGENCE_KIND_RULES[d.kind].check}.`,
        }),
      );
    }
  }

  const matched = new Set<string>();
  const pairs = comparable(input);

  /* The transposition signature, needing no declaration. */
  const statements = new Map<string, { binding: ColumnBinding; table: CatalogTable }[]>();
  for (const pair of pairs) {
    const key = `${pair.binding.file}:${pair.binding.line.toString()}:${pair.binding.statement}:${pair.binding.table}`;
    statements.set(key, [...(statements.get(key) ?? []), pair]);
  }
  const reportedPair = new Set<string>();
  for (const [, group] of statements) {
    for (const a of group) {
      for (const b of group) {
        if (a === b) continue;
        if (
          columnOfCamel(a.binding.property ?? "") !== b.binding.column ||
          columnOfCamel(b.binding.property ?? "") !== a.binding.column
        ) {
          continue;
        }
        const key = [a.binding.column, b.binding.column].sort().join("<->");
        if (reportedPair.has(key)) continue;
        reportedPair.add(key);
        findings.push(
          BindingNameFindingSchema.parse({
            kind: "transposed_pair",
            table: a.binding.table,
            column: a.binding.column,
            detail:
              `${a.binding.file}:${a.binding.line.toString()} binds \`${a.binding.property ?? ""}\` into ` +
              `${a.binding.column} and \`${b.binding.property ?? ""}\` into ${b.binding.column} — ` +
              `each column is bound from the other's name, in one statement`,
          }),
        );
      }
    }
  }

  for (const { binding, table } of pairs) {
    const property = binding.property ?? "";
    if (property === camelOfColumn(binding.column)) continue;

    const derivation = derivationFor(binding, table);
    if (derivation !== null) {
      // The derivation's own tightness, re-asked against this catalog rather than trusted from a
      // measurement taken once. A second admissible column means the derivation has stopped being
      // an explanation and started being a guess.
      const targets = derivationTargets(derivation, property, table);
      if (targets.length > 1) {
        findings.push(
          BindingNameFindingSchema.parse({
            kind: "derivation_ambiguous",
            table: binding.table,
            column: binding.column,
            detail:
              `the \`${derivation}\` derivation admits \`${property}\` into ${targets.length.toString()} ` +
              `columns of meta.${binding.table} (${targets.join(", ")}), so it no longer says which; ` +
              `its tightness claim is: ${DERIVATION_RULES[derivation].tightness}`,
          }),
        );
      }
      continue;
    }

    const sibling = table.columns.find(
      (c) => c.name === columnOfCamel(property) && c.name !== binding.column,
    );
    const mine = table.columns.find((c) => c.name === binding.column);
    const key = divergenceKey({ table: binding.table, column: binding.column, property });
    if (sibling !== undefined && mine !== undefined && sibling.type === mine.type) {
      matched.add(key);
      const declaration = byKey.get(key);
      if (declaration === undefined) {
        findings.push(
          BindingNameFindingSchema.parse({
            kind: "property_names_sibling_column",
            table: binding.table,
            column: binding.column,
            detail:
              `${binding.file}:${binding.line.toString()} binds \`${property}\` into ${binding.column}, ` +
              `and meta.${binding.table} declares a column \`${sibling.name}\` of the same type ` +
              `(${mine.type ?? "?"}) — the transposition signature. Declare it with its evidence if ` +
              `the two really are different facts.`,
          }),
        );
      } else if (!declaration.note.includes(sibling.name)) {
        // The highest-risk declaration in the file, so it has to show its work: an adjudication
        // that did not look at the column this could have been confused with cannot have ruled the
        // confusion out, and a note that never mentions it is evidence that it did not.
        findings.push(
          BindingNameFindingSchema.parse({
            kind: "sibling_unaddressed",
            table: binding.table,
            column: binding.column,
            detail:
              `BINDING_NAME_DIVERGENCES resolves the \`${binding.column}\` <- \`${property}\` ` +
              `sibling collision, and its note never names \`${sibling.name}\` — the column of the ` +
              `same type (${mine.type ?? "?"}) the value could have belonged in. Say why it does not.`,
          }),
        );
      }
      continue;
    }

    matched.add(key);
    if (byKey.has(key)) continue;
    findings.push(
      BindingNameFindingSchema.parse({
        kind: "undeclared_divergence",
        table: binding.table,
        column: binding.column,
        detail:
          `${binding.file}:${binding.line.toString()} binds ` +
          `${binding.kind === "local" ? `local \`${property}\`` : `\`${binding.receiver ?? ""}.${property}\``} ` +
          `into ${binding.column}, whose name reads \`${camelOfColumn(binding.column)}\`; no derivation ` +
          `explains it, so declare it in BINDING_NAME_DIVERGENCES with what you read to decide it ` +
          `writes the right value`,
      }),
    );
  }

  for (const d of declared) {
    if (matched.has(divergenceKey(d))) continue;
    findings.push(
      BindingNameFindingSchema.parse({
        kind: "divergence_overtaken",
        table: d.table,
        column: d.column,
        detail: `BINDING_NAME_DIVERGENCES declares \`${divergenceKey(d)}\` and no binding diverges that way any more; delete the declaration`,
      }),
    );
  }

  const order = new Map(BINDING_NAME_FINDING_KINDS.map((k, i) => [k, i]));
  return [...findings].sort(
    (a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) || a.table.localeCompare(b.table),
  );
}

export function summarizeBindingNames(input: BindingNameAuditInput): BindingNameSummary {
  const derived: Record<NameDerivation, number> = { business_key: 0, resolved_surrogate: 0 };
  let agreeing = 0;
  let declaredCount = 0;
  let literals = 0;
  let uncatalogued = 0;
  const byName = new Map(input.catalog.map((t) => [t.name, t]));
  const keys = new Set((input.divergences ?? []).map((d) => divergenceKey(d)));

  for (const binding of input.bindings) {
    if (binding.kind === "literal" || binding.property === null) {
      literals += 1;
      continue;
    }
    const table = byName.get(binding.table);
    if (table === undefined || !table.columns.some((c) => c.name === binding.column)) {
      uncatalogued += 1;
      continue;
    }
    if (binding.property === camelOfColumn(binding.column)) {
      agreeing += 1;
      continue;
    }
    const derivation = derivationFor(binding, table);
    if (derivation !== null) {
      derived[derivation] += 1;
      continue;
    }
    if (keys.has(divergenceKey({ ...binding, property: binding.property }))) declaredCount += 1;
  }
  return {
    agreeing,
    derived,
    declared: declaredCount,
    literals,
    uncatalogued,
    total: input.bindings.length,
  };
}

export function formatBindingNameFindings(findings: readonly BindingNameFinding[]): string {
  return findings.map((f) => `${f.kind}: ${f.table}.${f.column} — ${f.detail}`).join("\n");
}
