import type { PgConnection } from "@crossengin/kernel-pg";
import {
  assembleTombstone,
  type AssemblyRefusal,
  type DeletionCapabilities,
  type DeletionAttestation,
  type DeletionSubsystem,
  type TombstoneAnchor,
  type TombstoneKind,
  type TombstoneRecord,
} from "@crossengin/tenant-lifecycle";

import {
  eraseSharedTablesWithin,
  sharedTableErasureAttestation,
  sharedTableErasureScope,
  sharedTableRetention,
  type SharedTableErasure,
} from "./shared-table-erasure.js";
import { PostgresTombstoneStore, type StoredTombstone } from "./tombstone-store.js";

/**
 * Running a tenant deletion in one transaction, so the data and its proof cannot disagree.
 *
 * Three ADRs built the pieces and none of them ran in order. ADR-0316 erases a tenant's own schema and
 * measures it; ADR-0317 composes a `TombstoneRecord` from per-subsystem attestations; ADR-0318 stores
 * it and anchors it in the forensic chain. A caller had to invoke all three and carry the results
 * between them by hand, which is the shape of mistake every one of those ADRs was written about.
 *
 * **The whole thing commits together, and that is the decision.** Postgres DDL is transactional —
 * `probeCascadeCollateral` already depends on it, dropping a schema inside a savepoint and rolling it
 * back — so the `DROP SCHEMA`, the shared-table deletes, the chain append and the tombstone insert can
 * share one transaction. Run separately there is a window in which the data is gone and the record of
 * its deletion is not, and for a deletion that is cryptographically attested that window is the worst
 * state the system can reach: irreversible and unaccounted for. A failure anywhere rolls every
 * destructive statement back with it, and the tenant is exactly as it was.
 *
 * What that buys, precisely: **there is no outcome in which a tenant's data is destroyed without a
 * stored, anchored, verified tombstone describing it.** Either both, or neither.
 *
 * It does *not* make the deletion reversible. Once committed the data is gone; the guarantee is that
 * the commit is all-or-nothing.
 *
 * ADR-0329 added the second erasure — the tenant's rows in the shared schema — and with it the rule
 * that governs where a refusal is returned and where it must throw:
 *
 *   **A refusal is returned only while nothing has been destroyed. After the first destructive
 *   statement the sole exit is a throw, because returning would commit it.**
 *
 * That is why the shared-table erasure runs *first*: every one of its refusals is established before
 * it writes anything, and they are deployment-wide conditions (row-level security confining this
 * session, a table the catalog declares and the database lacks, a rotted retention entry) under which
 * no deletion in this deployment is safe. A misconfigured deployment therefore destroys nothing at
 * all, not even provisionally inside a rolled-back savepoint.
 */

export const PIPELINE_REFUSAL_STAGES = [
  /**
   * Settled before the transaction opens, so literally nothing happens. The stage exists because its
   * two refusals belong to neither an erasure nor the assembler: they are claims the **caller** made
   * about work this pipeline performs itself.
   */
  "input",
  "erase",
  "assemble",
  "store",
] as const;
export type PipelineRefusalStage = (typeof PIPELINE_REFUSAL_STAGES)[number];

export interface PipelineRefusal {
  readonly stage: PipelineRefusalStage;
  readonly reason: string;
  readonly detail: string;
}

/** The slice of the erasure this pipeline needs, so it imports no `operate-runtime-pg` types. */
export interface SchemaEraserWithin {
  (
    tx: PgConnection,
    tenantId: string,
    authority: { readonly executedBy: string; readonly approvedBy: string },
  ): Promise<{
    readonly schema: string;
    readonly erased: boolean;
    readonly alreadyAbsent: boolean;
    readonly refusals: readonly { readonly reason: string; readonly detail: string }[];
    readonly erasedRelations: readonly {
      readonly table: string;
      readonly rowCount: number;
      readonly storageBytes: number;
    }[];
    readonly rowCount: number;
    readonly storageBytes: number;
    readonly erasedAt: string;
  }>;
}

type SchemaErasure = Awaited<ReturnType<SchemaEraserWithin>>;

/**
 * The erasures this pipeline performs, each paired with the function that attests for it.
 *
 * ADR-0319 established the rule — an attestation a caller supplies about work this transaction is
 * about to do is a prediction, not evidence — and enforced it with the literal
 * `a.subsystem !== "tenant_schema"`. The pipeline then grew a second erasure, so the one other
 * subsystem that certainly holds a tenant's data had no protection at all: a deployment declaring
 * `shared_tables: "erases"` could hand in its own figures and have them signed and anchored.
 *
 * So the protected set is **the keys of this map**, and its values are the attesters. A subsystem this
 * pipeline performs cannot be missing from the protected set, because without an entry here it has no
 * attestation either. The two cannot drift apart, which is the property a second hand-written list
 * does not have — and is the lesson of `needsAuditEmitter` (ADR-0327), where a flag was missing from
 * both copies of itself and the per-flag test over the list could not see it.
 */
const ATTESTERS = {
  tenant_schema: tenantSchemaAttestation,
  shared_tables: sharedTablesAttestation,
} satisfies Partial<Record<DeletionSubsystem, unknown>>;

export type PipelinePerformedSubsystem = keyof typeof ATTESTERS;

/** The subsystems this pipeline erases itself, and therefore attests for itself. */
export const PIPELINE_PERFORMED_SUBSYSTEMS: readonly PipelinePerformedSubsystem[] = Object.freeze(
  Object.keys(ATTESTERS) as PipelinePerformedSubsystem[],
);

export interface DeleteTenantInput {
  readonly tenantId: string;
  readonly tombstoneId: string;
  readonly kind: TombstoneKind;
  readonly executedBy: string;
  readonly approvedBy: string;
  /**
   * What this *deployment* holds, declared once (ADR-0328) rather than listed per deletion.
   *
   * It replaced a `requiredSubsystems` list for one reason: the list was supplied by the caller, and
   * on the HTTP route the caller was the **request body** with `[]` as its default — so a remote
   * client chose how much of the deployment the Article 17 proof covered, and omitting the field
   * covered nothing. That is ADR-0321's defect exactly, in the field that decides a proof's reach:
   * the deadline is computed from the deployment rather than accepted from the body, and so is this.
   *
   * Every subsystem in `PIPELINE_PERFORMED_SUBSYSTEMS` must be declared `erases` or `retains` here.
   * `absent` is refused rather than honoured, because the pipeline erases those subsystems whatever
   * the declaration says, and a proof silent about a place it just destroyed data is ADR-0317's
   * defect with a configuration file in front of it.
   */
  readonly capabilities: DeletionCapabilities;
  /**
   * Attestations from every subsystem this pipeline does **not** perform. One for a performed
   * subsystem is refused at the `input` stage; see `PIPELINE_PERFORMED_SUBSYSTEMS`.
   */
  readonly attestations?: readonly DeletionAttestation[];
  readonly subjectIdentifier?: string;
  readonly relatedDeletionRequestId?: string;
  /**
   * The schema the platform's own tables live in, for the shared-table erasure. A deployment-level
   * identifier — not a scope choice: the set of tables within it is derived from the kernel catalog
   * and is not a parameter at all.
   */
  readonly schema?: string;
  readonly clock?: () => Date;
}

export type DeleteTenantOutcome =
  | {
      readonly ok: true;
      readonly stored: StoredTombstone;
      /** What the schema erasure destroyed, as it was measured under the lock. */
      readonly erased: {
        readonly schema: string;
        readonly tables: readonly string[];
        readonly rowCount: number;
        readonly storageBytes: number;
        readonly alreadyAbsent: boolean;
      };
      /** What the shared-table erasure destroyed, measured by the statements that destroyed it. */
      readonly erasedSharedTables: {
        readonly schema: string;
        readonly tables: readonly string[];
        readonly rowCount: number;
        readonly storageBytes: number;
        /** Every erasable table, so a reader can see the coverage the scope does not carry. */
        readonly examinedTables: readonly string[];
        /** Every table either retention set deliberately left in place. */
        readonly retainedTables: readonly string[];
        /**
         * The lawful retention the proof carries, or `null` when there is none.
         *
         * Reported because the deletion's 200 body is what an operator answers an Article 17
         * request from, and "we erased everything except these rows, under this obligation" is the
         * answer — not a figure. There is deliberately no count here, for the same reason the
         * attestation has no field for one.
         */
        readonly statutoryRetained: {
          readonly obligations: readonly string[];
          readonly dataReference: string;
        } | null;
      };
    }
  | { readonly ok: false; readonly refusals: readonly PipelineRefusal[] };

function tenantSchemaAttestation(erasure: SchemaErasure, attestedBy: string): DeletionAttestation {
  if (!erasure.erased) {
    // No scope, because nothing was destroyed. The assembler refuses a scope on anything but
    // `erased`, so this is honest at the source rather than merely refused downstream (ADR-0317).
    return {
      subsystem: "tenant_schema",
      outcome: "nothing_to_erase",
      attestedBy,
      attestedAt: erasure.erasedAt,
    };
  }
  return {
    subsystem: "tenant_schema",
    outcome: "erased",
    scope: {
      schemas: [erasure.schema],
      tables: erasure.erasedRelations.map((r) => `${erasure.schema}.${r.table}`),
      rowCount: erasure.rowCount,
      storageBytes: erasure.storageBytes,
    },
    attestedBy,
    attestedAt: erasure.erasedAt,
  };
}

/**
 * Delegated, because the claim and the two retention sets it is derived from belong together — the
 * outcome depends on which tables the deployment lawfully keeps, and that is the erasure module's
 * fact, not the pipeline's. What stays here is *when* it is called: after the erasure ran in this
 * transaction, never from a caller's input (ADR-0319).
 */
function sharedTablesAttestation(
  erasure: SharedTableErasure,
  attestedBy: string,
): DeletionAttestation {
  return sharedTableErasureAttestation(erasure, attestedBy);
}

function assemblyRefusals(refusals: readonly AssemblyRefusal[]): readonly PipelineRefusal[] {
  return refusals.map((r) => ({ stage: "assemble" as const, reason: r.reason, detail: r.detail }));
}

function eraseRefusals(
  refusals: readonly { readonly reason: string; readonly detail: string }[],
): readonly PipelineRefusal[] {
  return refusals.map((r) => ({ stage: "erase" as const, reason: r.reason, detail: r.detail }));
}

/**
 * Everything refusable about the *input*, settled before the transaction opens.
 *
 * Both refusals are the caller claiming something about a subsystem this pipeline performs itself, and
 * answering them here rather than mid-transaction means they cost nothing and destroy nothing.
 */
function inputRefusals(input: DeleteTenantInput): readonly PipelineRefusal[] {
  const out: PipelineRefusal[] = [];
  const performed = new Set<DeletionSubsystem>(PIPELINE_PERFORMED_SUBSYSTEMS);
  for (const attestation of input.attestations ?? []) {
    if (!performed.has(attestation.subsystem)) continue;
    // Refused rather than dropped, which is what ADR-0319 did with the one subsystem it protected.
    // A drop was safe — the pipeline's own measurement overrode it — but it told the caller nothing,
    // and a caller that believes it is contributing evidence and is silently not is the precise shape
    // of ADR-0317's defect. With two performed subsystems it is also no longer unambiguous: a caller
    // supplying one may believe its deployment erases that subsystem by some other means, which is a
    // disagreement about what exists, and `absent_subsystem_attested` already treats exactly that as
    // unresolvable rather than something to pick a winner from.
    out.push({
      stage: "input",
      reason: "performed_subsystem_attested",
      detail:
        `${attestation.subsystem} is erased by this pipeline, so its attestation is produced here;` +
        " an attestation about work this transaction is about to do is a prediction, not evidence",
    });
  }
  for (const subsystem of PIPELINE_PERFORMED_SUBSYSTEMS) {
    if (input.capabilities[subsystem] !== "absent") continue;
    out.push({
      stage: "input",
      reason: "performed_subsystem_absent",
      detail:
        `${subsystem} is declared absent in this deployment and this pipeline erases it anyway;` +
        " declare it 'erases' (or 'retains') so the proof covers what the deletion destroys",
    });
  }
  return out;
}

/**
 * Erase, attest, assemble, anchor and store — atomically.
 *
 * The anchor is **not** a parameter. ADR-0318 established that a tombstone's witness is the chain and
 * not its author, so the pipeline passes the assembler a placeholder and the store replaces it with
 * the entry it appends. The placeholder exists only because `TombstoneRecordSchema` requires at least
 * one anchor to parse, and it never reaches the database.
 *
 * Both performed subsystems' attestations are produced here, from the erasures that just ran in this
 * transaction, for the reason ADR-0317 exists: an attestation a caller supplies about work this
 * transaction is about to do is not evidence, it is a prediction.
 */
export async function deleteTenantAtomically(
  conn: PgConnection,
  store: PostgresTombstoneStore,
  eraseWithin: SchemaEraserWithin,
  input: DeleteTenantInput,
): Promise<DeleteTenantOutcome> {
  const refusedInput = inputRefusals(input);
  if (refusedInput.length > 0) return { ok: false, refusals: refusedInput };

  const clock = input.clock ?? ((): Date => new Date());
  const now = clock().toISOString();
  const attestedBy = `tenant-lifecycle-pg/deletion:${input.executedBy}`;
  const authority = { executedBy: input.executedBy, approvedBy: input.approvedBy };

  return conn.transaction(async (tx) => {
    // First, because every one of its refusals is established before it writes anything — so the one
    // ordering that keeps "a returned refusal means nothing was destroyed" true for both erasures.
    const shared = await eraseSharedTablesWithin(tx, input.tenantId, authority, {
      ...(input.schema !== undefined ? { schema: input.schema } : {}),
      clock,
    });
    if (shared.refusals.length > 0) {
      return { ok: false, refusals: eraseRefusals(shared.refusals) };
    }

    const erasure = await eraseWithin(tx, input.tenantId, authority);
    if (erasure.refusals.length > 0) {
      // Throws, unlike the shared erasure's refusal above: by here rows have been deleted in this
      // transaction, and returning would commit a destruction with no tombstone describing it. The
      // refusals ride along on the exception, so a caller still learns why without having to
      // distinguish this from a connection failure.
      //
      // Unconditionally, and not only when the shared erasure actually removed something: whether a
      // refusal is reported as a return or a throw must not depend on how much data the tenant
      // happened to hold, or one condition answers two shapes for reasons the caller cannot see.
      throw new DeletionPipelineAborted(eraseRefusals(erasure.refusals));
    }

    const attestations = [
      ATTESTERS.tenant_schema(erasure, attestedBy),
      ATTESTERS.shared_tables(shared, attestedBy),
      ...(input.attestations ?? []),
    ];
    // Nothing is filtered out of the caller's attestations any more: one for a performed subsystem is
    // refused at the `input` stage, before this transaction opened.
    const assembled = assembleTombstone({
      id: input.tombstoneId,
      kind: input.kind,
      tenantId: input.tenantId,
      ...(input.subjectIdentifier !== undefined ? { subjectIdentifier: input.subjectIdentifier } : {}),
      ...(input.relatedDeletionRequestId !== undefined
        ? { relatedDeletionRequestId: input.relatedDeletionRequestId }
        : {}),
      deletedAt: now,
      executedBy: input.executedBy,
      approvedBy: input.approvedBy,
      // Replaced by the store with the chain entry it appends; present only because the contract
      // requires one to parse (ADR-0318).
      anchors: [PLACEHOLDER_ANCHOR(now)],
      capabilities: input.capabilities,
      attestations,
    });
    if (!assembled.ok) {
      // Throws for the same reason the erase refusal above does: destruction has happened inside this
      // transaction, so the only correct response is to abort it. Returning would commit a deletion
      // with no tombstone, which is the state this whole pipeline exists to make unreachable.
      throw new DeletionPipelineAborted(assemblyRefusals(assembled.refusals));
    }

    const stored = await store.writeWithin(tx, assembled.record, attestations);
    const sharedScope = sharedTableErasureScope(shared);
    return {
      ok: true,
      stored,
      erased: {
        schema: erasure.schema,
        tables: erasure.erasedRelations.map((r) => `${erasure.schema}.${r.table}`),
        rowCount: erasure.rowCount,
        storageBytes: erasure.storageBytes,
        alreadyAbsent: erasure.alreadyAbsent,
      },
      erasedSharedTables: {
        schema: shared.schema,
        tables: sharedScope.tables,
        rowCount: sharedScope.rowCount,
        storageBytes: sharedScope.storageBytes,
        examinedTables: shared.examinedTables,
        retainedTables: shared.retainedTables,
        statutoryRetained: sharedTableRetention(shared),
      },
    };
  });
}

const PLACEHOLDER_ANCHOR = (at: string): TombstoneAnchor => ({
  kind: "internal_audit_log",
  // Never stored: `writeWithin` replaces the whole array with the chain entry it appends. Named so
  // that a row somehow carrying it is obviously wrong rather than plausibly real.
  reference: "pending-chain-append",
  anchoredAt: at,
});

/**
 * Thrown to roll the transaction back once destruction has already happened inside it.
 *
 * Carries the refusals so a caller can report *why* without having to distinguish this from a
 * connection failure — and rolling back is the point: the alternative is committing destroyed data
 * with no record of its destruction.
 */
export class DeletionPipelineAborted extends Error {
  readonly refusals: readonly PipelineRefusal[];

  constructor(refusals: readonly PipelineRefusal[]) {
    super(
      `tenant deletion rolled back: ${refusals.map((r) => `${r.stage}/${r.reason}`).join("; ")}`,
    );
    this.name = "DeletionPipelineAborted";
    this.refusals = refusals;
  }
}

/** Whether a stored record came out of this pipeline — i.e. it is anchored by a real chain entry. */
export function isAnchoredByChain(stored: StoredTombstone): boolean {
  if (stored.chainEntryHash === null) return false;
  return stored.record.anchors.some((a) => a.reference === stored.chainEntryHash);
}

/** Re-exported so a caller need not reach into the contracts package for the one type it passes. */
export type { TombstoneRecord };
