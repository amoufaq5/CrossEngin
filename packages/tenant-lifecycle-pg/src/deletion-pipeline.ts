import type { PgConnection } from "@crossengin/kernel-pg";
import {
  assembleTombstone,
  type ActionTrigger,
  type AssemblyRefusal,
  type DeletionCapabilities,
  type DeletionAttestation,
  type DeletionSubsystem,
  type TombstoneAnchor,
  type TenantLifecycleState,
  type TombstoneKind,
  type TombstoneRecord,
} from "@crossengin/tenant-lifecycle";

import {
  PostgresLifecycleEventStore,
  lifecycleEventFor,
  readTenantState,
  transitionWasLegal,
} from "./lifecycle-event-store.js";
import {
  eraseSharedTablesWithin,
  sharedTableErasureAttestation,
  sharedTableErasureScope,
  sharedTableRetention,
  type BootSchemaErasureInput,
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
 *
 * ADR-0350 widened that erasure to the boot manifest's own entity tables, which until then **nothing
 * erased at all** on `--store pg-columns` — the catalogued half is `meta.*` and the schema erasure
 * only ever drops a `t_<hex>` schema a boot-manifest tenant does not have, so the pipeline signed and
 * anchored proofs over records still on disk. The target list arrives as a second structural seam
 * beside `SchemaEraserWithin` and for its reason: the function that creates those tables is the only
 * thing entitled to name them, and this package depends on nothing that could. It is one subsystem
 * doing what its vocabulary always said, so `ATTESTERS` stays at two keys and one merged target list
 * keeps the rule above true across both halves of it.
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
  /**
   * The boot manifest's own entity tables, which `shared_tables` also erases (ADR-0350).
   *
   * The **second structural seam**, beside `SchemaEraserWithin` and for the same reason: the column
   * store is what creates these tables and so is the only thing entitled to name them
   * (ADR-0284/0285), and this package does not depend on it and must not start. So the list travels
   * as `{schema, table}` pairs the caller supplies, exactly as the schema erasure travels as a
   * function the caller supplies.
   *
   * **Required**, unlike every other optional field here, because the defect this closes is a place
   * nobody looked: an optional list would be forgotten at a call site the same way the whole group
   * was forgotten in the erasure, and the symptom either way is a signed proof over live records.
   * An empty list is legitimate and is the assertion that there are none — which is what `--store
   * pg` passes, its records being the catalogued `meta.operate_entity_records`.
   *
   * It carries the order's own verdict beside the list, because an order the database will refuse
   * partway through is worse than no list at all: the refused `DELETE` aborts this transaction,
   * which ADR-0321's runner records as `aborted` and leaves `in_progress` for a human.
   */
  readonly bootSchema: BootSchemaErasureInput;
  readonly clock?: () => Date;
  /**
   * Where to record the `… -> deleted` transition, and what to say about it.
   *
   * **One optional block whose every field is required once it is present**, rather than four
   * optional fields with defaults. The trigger and the reason are facts about *why* this tenant was
   * deleted and only the caller holds them; a `z.default()` on either would be ADR-0317's silence
   * deciding what the permanent record says. So the choice offered is "record it, and say these
   * things" or "do not record it" — and the outcome reports which, because a trail that is quietly
   * not written is the defect this closes.
   *
   * `fromState` is **not** here. It is read from `meta.tenants.status` inside the transaction, for
   * ADR-0328's reason: a caller-supplied source state lets the request body choose what the trail
   * says happened, which is exactly the field that ADR found a remote client deciding.
   */
  readonly lifecycle?: {
    readonly store: PostgresLifecycleEventStore;
    /** A UUID; the column is `UUID` and the id has to be nameable by whatever joins to it. */
    readonly eventId: string;
    readonly trigger: ActionTrigger;
    readonly reason: string;
    readonly relatedIncidentId?: string;
    readonly notificationChannel?: "email" | "in_app" | "phone" | "none";
    readonly notes?: string;
  };
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
      /**
       * What the shared-table erasure destroyed, measured by the statements that destroyed it —
       * the platform's own tenant-scoped rows **and** the boot manifest's entity tables, which is
       * why every list here is schema-qualified and `schema` names only the catalogued half.
       */
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
      /**
       * The `… -> deleted` transition as recorded, or `null` when no lifecycle block was supplied.
       *
       * Reported rather than assumed, for the reason this increment exists: a trail that is silently
       * not written is indistinguishable from a tenant that never existed, which is
       * `PLATFORM_RECORD_TABLES`' own sentence about this table.
       *
       * `transitionLegal` is `canTransitionLifecycle(fromState, 'deleted')` — **reported, never
       * enforced**. It is false on the synchronous deletion route, which still deletes straight from
       * `active` because ADR-0334 moved the tenant to `pending_deletion` on the asynchronous route's
       * verify only. Refusing would drop the only record of a deletion that happened; recording it
       * silently would hide the gap.
       */
      readonly lifecycleEvent: {
        readonly id: string;
        readonly fromState: TenantLifecycleState;
        readonly toState: TenantLifecycleState;
        readonly transitionLegal: boolean;
      } | null;
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
    /**
     * The tenant's state, read **before the first destructive statement**, so an unresolvable one is
     * a *returned* refusal and not a throw.
     *
     * That placement is the whole ordering argument on this side. The `fromState` has to be read
     * while `meta.tenants` still holds the row, and the row is retired by the caller *after* this
     * pipeline commits (ADR-0316, because the audit record's `tenant_id` references it) — so the
     * only window in which the source state is knowable is inside this transaction and before the
     * erasures. Reading it first also keeps the pipeline's own rule intact: a refusal is returned
     * only while nothing has been destroyed.
     */
    let fromState: TenantLifecycleState | null = null;
    if (input.lifecycle !== undefined) {
      fromState = await readTenantState(
        tx,
        input.tenantId,
        input.schema ?? "meta",
      );
      if (fromState === null) {
        return {
          ok: false,
          refusals: [
            {
              stage: "input" as const,
              reason: "tenant_state_unresolvable",
              detail:
                `${input.schema ?? "meta"}.tenants holds no row for ${input.tenantId}, so the` +
                " transition this deletion performs has no source state; substituting one would" +
                " put a fabricated fact in the only record that outlives the tenant",
            },
          ],
        };
      }
    }

    // First, because every one of its refusals is established before it writes anything — so the one
    // ordering that keeps "a returned refusal means nothing was destroyed" true for both erasures.
    const shared = await eraseSharedTablesWithin(tx, input.tenantId, authority, {
      ...(input.schema !== undefined ? { schema: input.schema } : {}),
      bootSchema: input.bootSchema,
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

    /**
     * The transition, appended **last and in the same transaction**.
     *
     * Last, because the tombstone is the proof and this is the index to it: an event naming a
     * tombstone that the assembler then refused would be a trail pointing at nothing. Inside the
     * transaction, because of what was measured — `tenant_id` is `ON DELETE CASCADE` into
     * `meta.tenants`, so an event written before the tenant row is retired is destroyed *with* it
     * and one written after raises a foreign-key violation. There is no point *outside* this
     * transaction at which a durable `… -> deleted` event exists, and the patch that removes the
     * reference (following `meta.tenant_tombstones`, which carries none for exactly this reason) is
     * what makes *inside* durable rather than merely atomic.
     *
     * **It throws rather than reporting.** This is the opposite of ADR-0320's `tenantRetired: false`
     * and the difference is where the work sits: retiring the tenant row happens *after* the
     * pipeline commits, so the deletion has already happened and a 5xx would claim otherwise. Here
     * nothing has committed, so a failed append rolls the erasures back and the tenant is exactly as
     * it was — and the alternative is committing a destruction whose trail the caller was told would
     * exist. The append's own refusals (contract, four-eyes, id shape) are raised before any
     * statement is sent, so they cost nothing.
     */
    let lifecycleEvent: {
      readonly id: string;
      readonly fromState: TenantLifecycleState;
      readonly toState: TenantLifecycleState;
      readonly transitionLegal: boolean;
    } | null = null;
    if (input.lifecycle !== undefined && fromState !== null) {
      const event = lifecycleEventFor({
        id: input.lifecycle.eventId,
        tenantId: input.tenantId,
        action: "execute_deletion",
        fromState,
        trigger: input.lifecycle.trigger,
        occurredAt: now,
        reason: input.lifecycle.reason,
        // The executor and the approver, which the tombstone store has already refused as equal
        // (`four_eyes_violated`) — so the event's own four-eyes check cannot fail here, and is kept
        // as the second of the three layers rather than removed because it is currently redundant.
        actorUserId: input.executedBy,
        approvedByUserId: input.approvedBy,
        approvedAt: now,
        ...(input.lifecycle.relatedIncidentId !== undefined
          ? { relatedIncidentId: input.lifecycle.relatedIncidentId }
          : {}),
        ...(input.lifecycle.notificationChannel !== undefined
          ? { notificationChannel: input.lifecycle.notificationChannel }
          : {}),
        ...(input.lifecycle.notes !== undefined ? { notes: input.lifecycle.notes } : {}),
      });
      await input.lifecycle.store.appendWithin(tx, event);
      lifecycleEvent = {
        id: event.id,
        fromState: event.fromState,
        toState: event.toState,
        transitionLegal: transitionWasLegal(event),
      };
    }

    const sharedScope = sharedTableErasureScope(shared);
    return {
      ok: true,
      stored,
      lifecycleEvent,
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
