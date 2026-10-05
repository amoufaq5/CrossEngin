import type { PgConnection } from "@crossengin/kernel-pg";
import {
  assembleTombstone,
  type AssemblyRefusal,
  type DeletionCapabilities,
  type DeletionAttestation,
  type TombstoneAnchor,
  type TombstoneKind,
  type TombstoneRecord,
} from "@crossengin/tenant-lifecycle";

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
 * back — so the `DROP SCHEMA`, the chain append and the tombstone insert can share one transaction.
 * Run separately there is a window in which the schema is gone and the record of its deletion is not,
 * and for a deletion that is cryptographically attested that window is the worst state the system can
 * reach: irreversible and unaccounted for. A failure anywhere rolls the drop back with it, and the
 * tenant is exactly as it was.
 *
 * What that buys, precisely: **there is no outcome in which a tenant's data is destroyed without a
 * stored, anchored, verified tombstone describing it.** Either both, or neither.
 *
 * It does *not* make the deletion reversible. Once committed the data is gone; the guarantee is that
 * the commit is all-or-nothing.
 */

export const PIPELINE_REFUSAL_STAGES = ["erase", "assemble", "store"] as const;
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

export interface DeleteTenantInput {
  readonly tenantId: string;
  readonly tombstoneId: string;
  readonly kind: TombstoneKind;
  readonly executedBy: string;
  readonly approvedBy: string;
  /**
   * Subsystems this deletion covers. `tenant_schema` is **always** added, because the pipeline erases
   * it: a caller cannot declare it out of scope and then have it erased anyway.
   */
  /**
   * What this *deployment* holds, declared once (ADR-0328) rather than listed per deletion.
   *
   * It replaced a `requiredSubsystems` list for one reason: the list was supplied by the caller, and
   * on the HTTP route the caller was the **request body** with `[]` as its default — so a remote
   * client chose how much of the deployment the Article 17 proof covered, and omitting the field
   * covered nothing. That is ADR-0321's defect exactly, in the field that decides a proof's reach:
   * the deadline is computed from the deployment rather than accepted from the body, and so is this.
   */
  readonly capabilities: DeletionCapabilities;
  /**
   * Attestations from every *other* subsystem. The pipeline supplies `tenant_schema`'s from its own
   * erasure — a caller passing one would be asserting what this transaction is about to measure.
   */
  readonly attestations?: readonly DeletionAttestation[];
  readonly subjectIdentifier?: string;
  readonly relatedDeletionRequestId?: string;
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
    }
  | { readonly ok: false; readonly refusals: readonly PipelineRefusal[] };

function attestationFor(
  erasure: Awaited<ReturnType<SchemaEraserWithin>>,
  attestedBy: string,
): DeletionAttestation {
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

function assemblyRefusals(refusals: readonly AssemblyRefusal[]): readonly PipelineRefusal[] {
  return refusals.map((r) => ({ stage: "assemble" as const, reason: r.reason, detail: r.detail }));
}

/**
 * Erase, attest, assemble, anchor and store — atomically.
 *
 * The anchor is **not** a parameter. ADR-0318 established that a tombstone's witness is the chain and
 * not its author, so the pipeline passes the assembler a placeholder and the store replaces it with
 * the entry it appends. The placeholder exists only because `TombstoneRecordSchema` requires at least
 * one anchor to parse, and it never reaches the database.
 *
 * `tenant_schema`'s attestation is produced here, from the erasure that just ran in this transaction,
 * for the reason ADR-0317 exists: an attestation a caller supplies about work this transaction is
 * about to do is not evidence, it is a prediction.
 */
export async function deleteTenantAtomically(
  conn: PgConnection,
  store: PostgresTombstoneStore,
  eraseWithin: SchemaEraserWithin,
  input: DeleteTenantInput,
): Promise<DeleteTenantOutcome> {
  const now = (input.clock ?? ((): Date => new Date()))().toISOString();
  const attestedBy = `tenant-lifecycle-pg/deletion:${input.executedBy}`;

  return conn.transaction(async (tx) => {
    const erasure = await eraseWithin(tx, input.tenantId, {
      executedBy: input.executedBy,
      approvedBy: input.approvedBy,
    });
    if (erasure.refusals.length > 0) {
      // Returned rather than thrown, and the transaction is left to roll back on its own: the erasure
      // refused before dropping anything, so there is nothing to undo and nothing to report but why.
      return {
        ok: false,
        refusals: erasure.refusals.map((r) => ({
          stage: "erase" as const,
          reason: r.reason,
          detail: r.detail,
        })),
      };
    }

    const attestations = [
      attestationFor(erasure, attestedBy),
      ...(input.attestations ?? []).filter((a) => a.subsystem !== "tenant_schema"),
    ];
    // The union with `tenant_schema` that used to stand here is gone with the list it guarded:
    // `DeletionCapabilitiesSchema` refuses `absent` for that subsystem, so `requiredSubsystemsFor`
    // always includes it and `assembleTombstone` derives the whole required set itself.
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
      // Throws, unlike an erase refusal: by here the drop has happened in this transaction, so the
      // only correct response is to abort it. Returning would commit a deletion with no tombstone,
      // which is the state this whole pipeline exists to make unreachable.
      throw new DeletionPipelineAborted(assemblyRefusals(assembled.refusals));
    }

    const stored = await store.writeWithin(tx, assembled.record, attestations);
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
 * Thrown to roll the transaction back once the drop has already happened inside it.
 *
 * Carries the refusals so a caller can report *why* without having to distinguish this from a
 * connection failure — and rolling back is the point: the alternative is committing a destroyed
 * schema with no record of its destruction.
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
