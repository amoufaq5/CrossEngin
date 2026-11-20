import { ASSEMBLY_REFUSAL_REASONS, type AssemblyRefusalReason } from "@crossengin/tenant-lifecycle";

import {
  PIPELINE_INPUT_REFUSAL_REASONS,
  SCHEMA_ERASER_REFUSAL_REASONS,
  type PipelineInputRefusalReason,
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
  readonly erase: readonly string[];
  readonly assemble: readonly string[];
} = Object.freeze({
  input: PIPELINE_INPUT_REFUSAL_REASONS,
  erase: [...new Set<string>([...SHARED_TABLE_ERASURE_REFUSAL_REASONS, ...SCHEMA_ERASER_REFUSAL_REASONS])],
  assemble: ASSEMBLY_REFUSAL_REASONS,
});

function dispositionOf(stage: string, reason: string): DeletionRefusalDisposition {
  const byStage: Readonly<Record<string, DeletionRefusalDisposition>> | undefined =
    stage === "input" || stage === "erase" || stage === "assemble"
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
 * The refusals as one line, `stage/reason; …`, bounded to what the column and the contract hold.
 * One spelling for the runner and the synchronous route, so a reader of `last_attempt_refusal`
 * cannot meet two formats for one fact.
 */
export function formatRefusalReasons(
  refusals: readonly { readonly stage: string; readonly reason: string }[],
): string {
  const line = refusals.map((r) => `${r.stage}/${r.reason}`).join("; ");
  return (line.length === 0 ? "unclassified refusal" : line).slice(0, 500);
}
