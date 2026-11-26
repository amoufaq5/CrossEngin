import { ASSEMBLY_REFUSAL_REASONS, type AssemblyRefusalReason } from "@crossengin/tenant-lifecycle";

import {
  PIPELINE_CONNECT_REFUSAL_REASONS,
  PIPELINE_INPUT_REFUSAL_REASONS,
  PIPELINE_PREFLIGHT_REFUSAL_REASONS,
  SCHEMA_ERASER_REFUSAL_REASONS,
  type PipelineConnectRefusalReason,
  type PipelineInputRefusalReason,
  type PipelinePreflightRefusalReason,
  type SchemaEraserRefusalReason,
} from "./deletion-pipeline.js";
import {
  SHARED_TABLE_ERASURE_REFUSAL_REASONS,
  type SharedTableErasureRefusalReason,
} from "./shared-table-erasure.js";

/**
 * What a **proven** refused deletion does to its request (ADR-0453).
 *
 * Both dispositions apply only where nothing was destroyed — a returned refusal, or a
 * `DeletionPipelineAborted`, whose transaction provably rolled back. An unproven failure is neither:
 * it stays `in_progress` for the reconciler, and nothing here is consulted for it.
 *
 * - `retry`: the cause is a property of **this deployment** — its database role, its schema, its
 *   configuration, this binary's catalog — an operator can change it without the data subject doing
 *   anything, **and it is raised before the pipeline's first destructive statement**. The request is
 *   released back to `verified`, keeping its verification and its Article 12(3) deadline, so a later
 *   run tries again.
 * - `final`: either the cause is a property of **the request, its caller's body or the tenant's
 *   data**, so no change to the deployment would make a retry succeed; or the refusal is raised
 *   **after** destruction has begun inside the transaction. The request is `rejected`, as before.
 *
 * Two stages are wholly pre-destruction and so may be `retry` (ADR-0477): `connect`, where the
 * transaction never opened, and `preflight`, which asks the schema erasure's refusals before the
 * shared erasure's first `DELETE`.
 *
 * The second half of `final` is what bounds the cost of a retry, and it is a **type**, not a
 * convention: every reason the pipeline can only raise after the shared-table erasure has issued its
 * `DELETE`s — the schema eraser's four and every assembly reason — is typed `"final"` below. So a
 * released attempt costs the input checks, one `meta.tenants` read and the shared erasure's own
 * read-only `row_security_active` probe, and never a full erasure that is then rolled back (an
 * earlier draft marked `external_dependents` and most assembly reasons `retry`, which meant every
 * runner tick deleted and restored a stuck tenant's rows indefinitely). Several of those
 * post-destruction causes are the deployment's — `subsystem_unattested` from a capability
 * declaration, `external_dependents` from an object an operator can drop — and they are rejected
 * anyway, which is the pre-ADR-0453 answer; the static one is said at boot instead.
 *
 * The line is "who can fix it without a resubmission, before anything is destroyed", and it is
 * deliberately not "is it deterministic": `rls_would_confine_this_session` refuses identically on
 * every attempt until the deployment changes, and that is exactly the case retrying is for.
 */
export const DELETION_REFUSAL_DISPOSITIONS = ["retry", "final"] as const;
export type DeletionRefusalDisposition = (typeof DELETION_REFUSAL_DISPOSITIONS)[number];

/**
 * One total map per stage, over that stage's whole vocabulary, so a new reason anywhere is a compile
 * error here instead of a string the classifier treats as unknown. The erase stage is the union of
 * the shared-table erasure's reasons (all raised before its first `DELETE`) and the schema eraser's
 * (all raised after the shared erasure has deleted), which is how the pipeline reports both — and the
 * intersection type is what makes the second half `"final"` whatever a later edit writes, with
 * `four_eyes_violated`, which both raise, narrowed to `"final"` by both.
 */
export const DELETION_REFUSAL_RETRYABILITY: {
  readonly input: Readonly<Record<PipelineInputRefusalReason, DeletionRefusalDisposition>>;
  readonly connect: Readonly<Record<PipelineConnectRefusalReason, DeletionRefusalDisposition>>;
  readonly preflight: Readonly<Record<PipelinePreflightRefusalReason, DeletionRefusalDisposition>>;
  readonly erase: Readonly<
    Record<SharedTableErasureRefusalReason, DeletionRefusalDisposition> &
      Record<SchemaEraserRefusalReason, "final">
  >;
  readonly assemble: Readonly<Record<AssemblyRefusalReason, "final">>;
} = Object.freeze({
  input: Object.freeze({
    // The caller attested work this pipeline performs: a body mistake.
    performed_subsystem_attested: "final",
    // `--deletion-capabilities` declares a performed subsystem absent: the deployment's declaration,
    // refused before the transaction opens.
    performed_subsystem_self_exempted: "retry",
    // The synchronous route's body chose the kind; the runner's comes from a flag refused at parse.
    kind_claims_a_narrower_subject: "final",
    subject_named_on_a_tenant_wide_erasure: "final",
    // `meta.tenants` holds no row for the tenant: a fact about the tenant, which no setting fixes.
    tenant_state_unresolvable: "final",
    // A subsystem the deployment declares as holding the tenant's data has no attestation
    // (ADR-0477). The assembler refused the same fact after both erasures and it was rejected; asked
    // here it is the deployment's declaration — or the synchronous route's body — and the request is
    // still owed, so it is released rather than lost to a configuration mistake.
    declared_subsystem_unattested: "retry",
  }),
  // The transaction never opened, so nothing in it ran (ADR-0477): the deletion connection's
  // credential, role or reachability, every one the deployment's to restore.
  connect: Object.freeze({
    owner_connection_unavailable: "retry",
  }),
  // The schema erasure's refusals asked before the shared erasure's first `DELETE` (ADR-0477) —
  // the same causes the eraser's own four answer `final` for, because there they arrive after it.
  preflight: Object.freeze({
    schema_name_refused: "retry",
    schema_not_droppable: "retry",
    external_dependents: "retry",
    preflight_failed: "retry",
  }),
  erase: Object.freeze({
    // The shared-table erasure's own — every one established before it writes anything.
    invalid_tenant_id: "final",
    four_eyes_violated: "final",
    // The next four and `retention_entry_unresolved` are this binary's catalog disagreeing with its
    // own retention sets — empty by construction, and fixed by a release, not by a resubmission.
    unclassified_tenant_table: "retry",
    retention_entry_unresolved: "retry",
    retention_reason_unassigned: "retry",
    retention_reason_ambiguous: "retry",
    retained_table_blocks_erasure: "retry",
    // The boot manifest and the database the deployment serves.
    target_collides_with_catalog: "retry",
    boot_schema_target_invalid: "retry",
    boot_schema_order_unrunnable: "retry",
    table_missing: "retry",
    target_lacks_tenant_scope: "retry",
    boot_schema_table_undeclared: "retry",
    // The case this map exists for: the connection's role is confined (ADR-0424). Fixed by giving
    // the pipeline an unconfined owner connection, never by the data subject.
    rls_would_confine_this_session: "retry",
    // The connection's role lacks SELECT or DELETE on a target (ADR-0458): a grant the deployment
    // makes, asked before the first DELETE, so the same remedy shape as the confinement above.
    table_privilege_missing: "retry",
    // The schema eraser's four, raised after the shared erasure's `DELETE`s: a retry would repeat
    // that erasure and its rollback, so all four are final whatever their cause.
    not_a_tenant_schema: "final",
    schema_not_this_tenant: "final",
    external_dependents: "final",
  }),
  // Every assembly reason is raised after both erasures, inside the transaction.
  assemble: Object.freeze({
    subsystem_unattested: "final",
    duplicate_attestation: "final",
    invalid_attestation: "final",
    absent_subsystem_attested: "final",
    four_eyes_violated: "final",
    scope_empty: "final",
    no_anchors: "final",
    record_invalid: "final",
    proof_unverifiable: "final",
    scope_undeclared: "final",
    scope_declaration_ambiguous: "final",
    capabilities_invalid: "final",
    record_storage_undeclared: "final",
    record_storage_outside_proof: "final",
    record_storage_invalid: "final",
  }),
});

/** Every reason the map answers for, per stage — the vocabularies the compiler holds it to. */
export const DELETION_REFUSAL_VOCABULARY: {
  readonly input: readonly string[];
  readonly connect: readonly string[];
  readonly preflight: readonly string[];
  readonly erase: readonly string[];
  readonly assemble: readonly string[];
} = Object.freeze({
  input: PIPELINE_INPUT_REFUSAL_REASONS,
  connect: PIPELINE_CONNECT_REFUSAL_REASONS,
  preflight: PIPELINE_PREFLIGHT_REFUSAL_REASONS,
  erase: [...new Set<string>([...SHARED_TABLE_ERASURE_REFUSAL_REASONS, ...SCHEMA_ERASER_REFUSAL_REASONS])],
  assemble: ASSEMBLY_REFUSAL_REASONS,
});

function dispositionOf(stage: string, reason: string): DeletionRefusalDisposition {
  const byStage: Readonly<Record<string, DeletionRefusalDisposition>> | undefined =
    stage === "input" ||
    stage === "connect" ||
    stage === "preflight" ||
    stage === "erase" ||
    stage === "assemble"
      ? DELETION_REFUSAL_RETRYABILITY[stage]
      : undefined;
  // An own-property test, so a reason named `constructor` is unknown rather than a prototype member.
  if (byStage === undefined || !Object.prototype.hasOwnProperty.call(byStage, reason)) return "final";
  return byStage[reason] ?? "final";
}

/**
 * Whether a proven refusal releases its request for another attempt or rejects it.
 *
 * `retry` only when **every** refusal is retryable: one final cause means a retry would refuse again
 * whatever the deployment does, so releasing would only delay the answer the data subject is owed.
 * An empty list, an unknown stage and an unknown reason are all `final`, because `final` is the
 * behaviour before ADR-0453 — a refusal nobody can classify keeps the answer it always had rather
 * than holding a tenant in `pending_deletion` on a guess.
 */
export function deletionRefusalDisposition(
  refusals: readonly { readonly stage: string; readonly reason: string }[],
): DeletionRefusalDisposition {
  if (refusals.length === 0) return "final";
  return refusals.every((r) => dispositionOf(r.stage, r.reason) === "retry") ? "retry" : "final";
}

/**
 * The shape every `last_attempt_refusal` a release writes has: `stage/reason` codes joined by `; `.
 *
 * A release is written only when `deletionRefusalDisposition` answered `retry`, which it does only
 * when **every** refusal's stage and reason is a member of the map above — so the line is made of
 * vocabulary codes and nothing else, and carries no tenant id, table name or count. The store refuses
 * a release whose reasons do not match, so that property is enforced where the value is written
 * rather than inferred from who calls it (ADR-0458), and the read routes surface it on that basis.
 */
export const RELEASE_REASONS_RE = /^[a-z_]+\/[a-z_]+(?:; [a-z_]+\/[a-z_]+)*$/;

/**
 * How long a released request waits before the scheduler may claim it again (ADR-0458).
 *
 * Exponential from `baseMs` and capped at `capMs`, over the number of releases so far — the first
 * release waits `baseMs`, each later one twice the last. Without it a released request was
 * re-claimed on every runner tick: a still-unfixed cause (a confined role, a missing grant) cost a
 * claim, a probe and a release write per tick per request for as long as it stayed unfixed.
 *
 * The cap is small against an Article 12(3) deadline measured in days, and that is the trade: a
 * fixed cause is picked up within one cap of the fix, and a stuck one costs one attempt per cap.
 */
export interface DeletionRetryBackoff {
  readonly baseMs: number;
  readonly capMs: number;
}

export const DEFAULT_DELETION_RETRY_BACKOFF: DeletionRetryBackoff = Object.freeze({
  baseMs: 60_000,
  capMs: 3_600_000,
});

/** The wait after the `releaseCount`-th release: `min(cap, base × 2^(releaseCount − 1))`. */
export function deletionRetryBackoffMs(
  releaseCount: number,
  policy: DeletionRetryBackoff = DEFAULT_DELETION_RETRY_BACKOFF,
): number {
  if (!Number.isInteger(releaseCount) || releaseCount < 1) {
    throw new Error(`a release count is a positive integer, got ${String(releaseCount)}`);
  }
  if (
    !Number.isFinite(policy.baseMs) ||
    !Number.isFinite(policy.capMs) ||
    policy.baseMs < 0 ||
    policy.capMs < policy.baseMs
  ) {
    throw new Error(
      `a retry backoff needs 0 <= baseMs <= capMs, got ${String(policy.baseMs)} and ${String(policy.capMs)}`,
    );
  }
  // Exponent bounded before it is raised, so a long-stuck request cannot overflow to Infinity.
  const exponent = Math.min(releaseCount - 1, 52);
  return Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
}

/**
 * The refusals as one line, `stage/reason; …`, bounded to the column's 500 characters on a whole-code
 * boundary and de-duplicated. One spelling for the runner and the synchronous route, so a reader of
 * `last_attempt_refusal` cannot meet two formats for one fact.
 */
export function formatRefusalReasons(
  refusals: readonly { readonly stage: string; readonly reason: string }[],
): string {
  // De-duplicated, and bounded on a whole `stage/reason` boundary: a code cut in half is neither
  // a code nor something `RELEASE_REASONS_RE` admits, so a slice would make a long release refuse.
  const codes = [...new Set(refusals.map((r) => `${r.stage}/${r.reason}`))];
  let line = "";
  for (const code of codes) {
    const next = line.length === 0 ? code : `${line}; ${code}`;
    if (next.length > 500) break;
    line = next;
  }
  return line.length === 0 ? "unclassified refusal" : line;
}
