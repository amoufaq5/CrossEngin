import { z } from "zod";

import { RETENTION_OBLIGATIONS, type RetentionObligation } from "./gdpr-deletion.js";
// Type-only, so nothing is imported at runtime and the cycle `tombstone-assembly.ts` would otherwise
// make does not exist. It exists to pin the restated declaration shape below to its one source.
import type { DeletionCapabilities } from "./tombstone-assembly.js";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const TOMBSTONE_ID_REGEX = /^tomb_[A-Za-z0-9_-]{12,40}$/;

export const TOMBSTONE_KINDS = [
  "tenant_deletion",
  "user_deletion",
  "data_subject_erasure",
  "scheduled_purge",
  "abandoned_export_purge",
] as const;
export type TombstoneKind = (typeof TOMBSTONE_KINDS)[number];
export const TombstoneKindSchema = z.enum(TOMBSTONE_KINDS);

export const ANCHOR_KINDS = [
  "internal_audit_log",
  "trillian_log",
  "blockchain_anchor",
  "rfc3161_timestamp",
] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const TombstoneAnchorSchema = z
  .object({
    kind: z.enum(ANCHOR_KINDS),
    reference: z.string().min(1),
    anchoredAt: Iso8601,
    proofUrl: z.string().url().optional(),
  })
  .strict();
export type TombstoneAnchor = z.infer<typeof TombstoneAnchorSchema>;

/**
 * Which version of the content manifest a stored tombstone's digest was computed over.
 *
 * ADR-0328 made a deployment declare, totally, which of the six subsystems it `erases` / `retains` /
 * does not have at all — so a proof covering four subsystems by omission became impossible. The
 * declaration itself stayed **outside** the proof: a reader of a stored record could see its scope and
 * its attestations but not the claim that makes the scope's silence honest, and because nothing signed
 * it, rewriting it left every digest byte-identical. That is ADR-0323's `scope_tampered` in a second
 * place.
 *
 * `v2` carries the declaration inside the signed bytes, under its own domain tag. `v1` is left exactly
 * as it was: every tombstone already stored verifies against it, and changing what
 * `crossengin.tombstone.content.v1` commits to would make every stored digest fail — which is
 * indistinguishable, to `verifyStoredEvidence`, from the tamper the digest exists to detect.
 *
 * The version is an **explicit field** rather than inferred from whether a declaration is present.
 * Inference would read a *removed* declaration as an older record — a tamper that downgrades itself
 * and is then checked against the rules it escaped.
 *
 * `v3` adds the **retention claim** (ADR-0331), for the third instance of the same defect. ADR-0330
 * made a statutory retention expressible as a fourth attestation outcome, and the claim it produces —
 * `retainedObligations`, `retainedReason`, `retainedDataReference` — sat on the record and in neither
 * digest. So a stored proof could be made to say the data was kept for a different reason, or in a
 * different place, with `contentManifestSha256` and `proofSha256` byte-identical and the chain entry
 * untouched: exactly ADR-0323's `scope_tampered` with nothing able to see it.
 *
 * It is the **default for every capabilities-path assembly**, not only for a deletion that retained
 * something. A version emitted only when there is a retention to carry would make the version a
 * function of the data, and "nothing was lawfully retained" would then be expressed by the *absence*
 * of a v3 tag — indistinguishable from a record written before v3 existed. That is the distinction
 * this whole lineage exists to keep: ADR-0329 bought "we have no cache layer" versus "nobody asked",
 * and a conditional v3 would sell back "nothing is retained" versus "this proof cannot say". A v3
 * record signs the empty claim.
 *
 * `v4` adds the **record-storage declaration** (ADR-0351), for the fourth instance, and it is the
 * one the lineage's own machinery produced. ADR-0350 widened the `shared_tables` erasure to the boot
 * manifest's typed entity tables and made the target list a required parameter, which closed
 * "nobody looked" *in the mechanism* — and left it open in the proof, because an empty boot group
 * and no boot group compose byte-identical scopes. So a reader of a stored tombstone could not tell
 * a deployment whose tenant records are catalogued JSONB rows (there are no typed relations, and
 * the scope's silence about them is correct) from one whose column store holds 54 of them and whose
 * boot manifest declared none. Both are legitimate; one is a configuration error the boot report
 * warns about; and the proof said the same thing about both.
 */
export const TOMBSTONE_PROOF_VERSIONS = ["v1", "v2", "v3", "v4"] as const;
export type TombstoneProofVersion = (typeof TOMBSTONE_PROOF_VERSIONS)[number];
export const TombstoneProofVersionSchema = z.enum(TOMBSTONE_PROOF_VERSIONS);

/**
 * What each version's bytes carry, as **one total map** over the enum.
 *
 * It was three frozen membership lists until ADR-0351, and the reason given for that shape survives
 * while the shape does not. The reason: *a version names a domain tag, not an ordinal, and nothing
 * promises the next tag is a superset of this one* — so `>= "v2"` would decide that question for a
 * tag nobody has designed. True, and an ordering comparison is still refused here. But a **map** is
 * not an ordering comparison, and it buys the one thing the lists could not: adding a member to
 * `TOMBSTONE_PROOF_VERSIONS` is now a **compile error** until that member says what its bytes carry.
 *
 * That mattered, measurably. Adding `"v4"` to the enum and nothing else typechecked, passed every
 * test, and produced a tag that covered *nothing* — so a v4 record was structurally a v1 record, the
 * two refinements refused it for carrying a declaration or obligations, and `readDeclaredAbsences`
 * reported it `reason: "v1_proof"`. A silent regression of both v2 and v3. The test that existed for
 * exactly this said so in its own comment — *"a fourth tag added to neither list would silently sign
 * nothing new"* — and then asserted only that the predicates return a boolean, which they do for
 * every input. `ABAC_OUTCOME_ALLOWS` is a map for this reason and this is the same reason.
 *
 * The three arrays below are derived from it and still exported, so the exact-membership assertions
 * that pin the numbers keep working and no reader had to change.
 */
export const PROOF_VERSION_COVERAGE: Readonly<
  Record<
    TombstoneProofVersion,
    {
      readonly declaration: boolean;
      readonly retentionClaim: boolean;
      readonly recordStorage: boolean;
    }
  >
> = Object.freeze({
  /** The scope alone, and the only tag whose bytes carry nothing else. */
  v1: { declaration: false, retentionClaim: false, recordStorage: false },
  v2: { declaration: true, retentionClaim: false, recordStorage: false },
  v3: { declaration: true, retentionClaim: true, recordStorage: false },
  v4: { declaration: true, retentionClaim: true, recordStorage: true },
});

export const DECLARATION_BEARING_PROOF_VERSIONS: readonly TombstoneProofVersion[] = Object.freeze(
  TOMBSTONE_PROOF_VERSIONS.filter((v) => PROOF_VERSION_COVERAGE[v].declaration),
);
export const RETENTION_BEARING_PROOF_VERSIONS: readonly TombstoneProofVersion[] = Object.freeze(
  TOMBSTONE_PROOF_VERSIONS.filter((v) => PROOF_VERSION_COVERAGE[v].retentionClaim),
);
export const RECORD_STORAGE_BEARING_PROOF_VERSIONS: readonly TombstoneProofVersion[] =
  Object.freeze(TOMBSTONE_PROOF_VERSIONS.filter((v) => PROOF_VERSION_COVERAGE[v].recordStorage));

export function proofVersionCoversDeclaration(version: TombstoneProofVersion): boolean {
  return PROOF_VERSION_COVERAGE[version].declaration;
}

export function proofVersionCoversRetentionClaim(version: TombstoneProofVersion): boolean {
  return PROOF_VERSION_COVERAGE[version].retentionClaim;
}

export function proofVersionCoversRecordStorage(version: TombstoneProofVersion): boolean {
  return PROOF_VERSION_COVERAGE[version].recordStorage;
}

/**
 * The "declare one of these" half of a refusal message, rendered from its own array.
 *
 * The three refusals below used to name their versions literally — `"declare proofVersion 'v2' or
 * 'v3'"` — and two of the three went stale the moment `v4` landed, telling an author to pick a
 * version while omitting a valid answer. A hand-maintained list of the thing standing next to it is
 * ADR-0288's `needsAuditEmitter` shape, and a *remedy* is the worst place for it: the reader is
 * being told what to do, so a list that has fallen behind sends them to do the wrong thing.
 *
 * An empty array renders as a statement rather than an instruction, because "declare proofVersion"
 * followed by nothing is not one — if no tag signs a field, the only remedy is the clause after it.
 */
function declareOneOf(versions: readonly TombstoneProofVersion[]): string {
  const quoted = versions.map((v) => `'${v}'`);
  const last = quoted.at(-1);
  if (last === undefined) return "no proof version signs it";
  const head = quoted.slice(0, -1);
  return `declare proofVersion ${head.length === 0 ? last : `${head.join(", ")} or ${last}`}`;
}

/**
 * Where a deployment keeps a tenant's own records — the fact the scope's silence depends on.
 *
 * Three members and not two, because a total map over a deployment's storage choices has to answer
 * for all of them. `no_durable_store` is unreachable from a stored proof today (the tenant deletion
 * routes refuse to mount on an in-memory store, so no proof is issued from one) and is here because
 * a map with a hole is what a total map exists to prevent — the same reason
 * `ABAC_DENIAL_EFFECT.entity_create` carries an answer for a position a boot refusal makes
 * unreachable.
 */
export const RECORD_STORAGE_MODELS = [
  /**
   * Typed per-entity relations, created from the manifest by the column store. These are the
   * relations ADR-0350's erasure empties by name, and the ones whose absence was unsayable.
   */
  "typed_tables",
  /**
   * Rows in a catalogued document table. The relations holding them are in `META_TABLES`, so the
   * shared-table erasure has reached them since ADR-0329 and there are no *typed* relations at all.
   */
  "document_rows",
  /** No durable store: the records live in one process and nothing on disk holds them. */
  "no_durable_store",
] as const;
export type RecordStorageModel = (typeof RECORD_STORAGE_MODELS)[number];
export const RecordStorageModelSchema = z.enum(RECORD_STORAGE_MODELS);

/**
 * What a proof says about where this deployment kept the tenant's own records.
 *
 * A **declaration**, like `capabilityDeclaration` and unlike the scope: every field is a property of
 * the deployment and its manifest, derivable before a single row is read. That provenance is what
 * keeps it out of the attestations — ADR-0317 gives each subsystem its scope fields exclusively, and
 * the comment on `DeletionAttestation.retainedObligations` states the rule those fields obey: *the
 * figures in a proof describe what was destroyed*. `relationCount` describes what the deployment
 * **has**, so a figure here cannot be read as part of the destroyed total, and it would have had to
 * be if it rode on an attestation beside `rowCount`.
 *
 * `relationCount` is the field that earns the version. The model alone separates ADR-0350's two
 * cases, but `typed_tables` with a count of **zero** is the third and least obvious one: a column
 * store serving a manifest that declares no entity, which is legitimate for a deployment where every
 * tenant activates its own manifest and is the signature of the wrong pack having loaded otherwise.
 * `boot-erasure-report.ts` warns about it at boot; without the count, a stored proof cannot say it.
 */
export const TombstoneRecordStorageDeclarationSchema = z
  .object({
    model: RecordStorageModelSchema,
    /**
     * The schema those typed relations are in, and `null` for every other model.
     *
     * Not an optional key: `canonicalStringify` drops `undefined`, so an omitted key and an explicit
     * `null` would render identically and a *stripped* schema would be indistinguishable from a
     * model that never had one — ADR-0331's rule, which is the only reason the retention claim's
     * three fields are signable at all.
     */
    schema: z.string().min(1).nullable(),
    /**
     * How many typed per-entity relations the manifest declares — entity tables and m2m join tables
     * both, since the column store creates and the erasure empties both.
     *
     * Deliberately **not** a count of relations examined, which would be a measurement and belong to
     * the subsystem that measured it. It counts only *typed* relations, so `document_rows` answers 0
     * rather than naming the two catalogued tables that hold its documents: those are in
     * `META_TABLES`, their coverage is the catalogued half's, and a figure here that sometimes meant
     * "typed relations" and sometimes "all relations" would be the two-spellings defect inside a
     * signed claim.
     */
    relationCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.model === "typed_tables") {
      // The schema is the half an operator can cross-check: `--schema` feeds two stores with two
      // different defaults (`meta` for documents, `public` for columns), so a proof naming typed
      // relations and not where they are leaves the one misconfiguration this declaration could
      // have caught unsayable. A count of 0 is **not** refused — it is the third case the version
      // exists to express.
      if (v.schema === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schema"],
          message:
            "model 'typed_tables' must name the schema its relations are in; a proof that they" +
            " exist without saying where cannot be cross-checked against the store's own default",
        });
      }
      return;
    }
    // A model with no typed relations cannot name a schema for them or count them. Refused rather
    // than normalised, because normalising would let a caller hand in a contradiction and get a
    // signed claim that disagrees with what it was told.
    if (v.schema !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schema"],
        message:
          `model '${v.model}' has no typed per-entity relations, so it cannot name the schema they` +
          " are in; use model 'typed_tables' or carry a null schema",
      });
    }
    if (v.relationCount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relationCount"],
        message:
          `model '${v.model}' has no typed per-entity relations, so the count must be 0 (got` +
          ` ${v.relationCount.toString()})`,
      });
    }
  });
export type TombstoneRecordStorageDeclaration = z.infer<
  typeof TombstoneRecordStorageDeclarationSchema
>;

/**
 * The disposition vocabulary, restated rather than imported as a value: `tombstone-assembly.ts`
 * imports this module, so a runtime import back would be a cycle. `asCapabilityDeclaration` and
 * `asDeletionCapabilities` below pin the restatement in both directions — a subsystem or a disposition
 * added, removed or renamed over there fails `typecheck` here rather than drifting into a proof.
 */
const DispositionSchema = z.enum(["erases", "retains", "absent"]);

const CAPABILITY_DECLARATION_SHAPE = {
  tenant_schema: DispositionSchema,
  shared_tables: DispositionSchema,
  object_storage: DispositionSchema,
  backups: DispositionSchema,
  search_indexes: DispositionSchema,
  caches: DispositionSchema,
};

/**
 * The capability declaration as a **signed** field of a tombstone, structurally identical to
 * `DeletionCapabilities` and deliberately a separate name: one is a deployment's current
 * configuration, the other is the claim one particular proof commits to. They must have the same
 * shape; they are not the same fact, and a proof that quoted live configuration would prove nothing.
 */
export const TombstoneCapabilityDeclarationSchema = z
  .object(CAPABILITY_DECLARATION_SHAPE)
  .strict();
export type TombstoneCapabilityDeclaration = z.infer<
  typeof TombstoneCapabilityDeclarationSchema
>;
export type DeclaredSubsystem = keyof TombstoneCapabilityDeclaration;

const DECLARED_SUBSYSTEMS: readonly DeclaredSubsystem[] = Object.freeze(
  // Sorted so a reading's `absentSubsystems` is deterministic without the caller sorting it.
  (Object.keys(CAPABILITY_DECLARATION_SHAPE) as DeclaredSubsystem[]).sort(),
);

/** What a deployment declared, as the thing a proof may commit to. Half of the drift pin. */
export function asCapabilityDeclaration(
  capabilities: DeletionCapabilities,
): TombstoneCapabilityDeclaration {
  return capabilities;
}

/** What a proof committed to, as the thing `requiredSubsystemsFor` reads. The other half. */
export function asDeletionCapabilities(
  declaration: TombstoneCapabilityDeclaration,
): DeletionCapabilities {
  return declaration;
}

export const DeletionScopeSchema = z
  .object({
    schemas: z.array(z.string().min(1)).default([]),
    tables: z.array(z.string().min(1)).default([]),
    objectStorageBuckets: z.array(z.string().min(1)).default([]),
    backupGenerations: z.array(z.string().min(1)).default([]),
    searchIndexes: z.array(z.string().min(1)).default([]),
    cacheKeys: z.array(z.string().min(1)).default([]),
    rowCount: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeletionScope = z.infer<typeof DeletionScopeSchema>;

export const TombstoneRecordSchema = z
  .object({
    id: z.string().regex(TOMBSTONE_ID_REGEX),
    kind: TombstoneKindSchema,
    tenantId: z.string().min(1),
    subjectIdentifier: z.string().min(1).optional(),
    relatedDeletionRequestId: z.string().min(1).optional(),
    deletedAt: Iso8601,
    executedBy: z.string().min(1),
    approvedBy: z.string().min(1),
    scope: DeletionScopeSchema,
    /**
     * Which content manifest `contentManifestSha256` was computed over.
     *
     * Defaulted to `v1` so every row written before ADR-0329 still parses. The default is the honest
     * reading of a missing field: such a record *was* signed under the v1 tag. It is **not** a record
     * whose deployment declared nothing — see `readDeclaredAbsences`.
     */
    proofVersion: TombstoneProofVersionSchema.default("v1"),
    /**
     * What the deployment declared it holds, when the proof commits to it.
     *
     * Optional because a v1 record has none, and paired with `proofVersion` by the refinement below:
     * a v2 record must carry it and a v1 record must not. A v1 record *with* a declaration would be a
     * record asserting something its own bytes do not cover, which is the state ADR-0329 abolishes
     * rather than a shape to accept.
     */
    capabilityDeclaration: TombstoneCapabilityDeclarationSchema.optional(),
    /**
     * Which obligations keep data back, when the proof commits to them (ADR-0331).
     *
     * The **structured** half of the retention claim, and the field that makes the claim signable at
     * all: before this, the only machine-readable record of *why* data survived an Article 17 erasure
     * was a substring of `retainedReason`'s prose, recoverable only by re-reading the attestations.
     *
     * Optional because v1 and v2 bytes do not cover it, and paired with `proofVersion` in both
     * directions by the refinement below. An **empty array on a v3 record is a claim**, not a
     * placeholder: it is the signed assertion that this deletion kept nothing, which is the one thing
     * a v1 or v2 record can never say.
     */
    retainedObligations: z.array(z.enum(RETENTION_OBLIGATIONS)).optional(),
    /**
     * Where this deployment kept the tenant's own records, when the proof commits to it (ADR-0351).
     *
     * Optional because v1, v2 and v3 bytes do not cover it, and paired with `proofVersion` in both
     * directions by the refinement below. A `typed_tables` declaration with `relationCount: 0` is a
     * **claim** and not a placeholder — the signed assertion that this deployment's column store
     * serves a manifest declaring no entity — which is the one thing a v1, v2 or v3 record cannot
     * distinguish from a deployment that has no typed relations at all.
     */
    recordStorage: TombstoneRecordStorageDeclarationSchema.optional(),
    contentManifestSha256: z.string().regex(SHA256_REGEX),
    proofSha256: z.string().regex(SHA256_REGEX),
    anchors: z.array(TombstoneAnchorSchema).min(1),
    retainedReason: z.string().min(1).optional(),
    retainedDataReference: z.string().min(1).optional(),
    invalidationOfPriorTombstoneId: z
      .string()
      .regex(TOMBSTONE_ID_REGEX)
      .nullable()
      .default(null),
  })
  .superRefine((v, ctx) => {
    if (v.executedBy === v.approvedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedBy"],
        message: "executedBy and approvedBy must differ (four-eyes principle)",
      });
    }
    if (
      v.kind === "data_subject_erasure" &&
      v.relatedDeletionRequestId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedDeletionRequestId"],
        message: "data_subject_erasure tombstones must reference a deletion request",
      });
    }
    if (v.kind === "user_deletion" && v.subjectIdentifier === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subjectIdentifier"],
        message: "user_deletion tombstones must declare subjectIdentifier",
      });
    }
    if (v.kind === "tenant_deletion" || v.kind === "scheduled_purge") {
      const totalScope =
        v.scope.schemas.length +
        v.scope.tables.length +
        v.scope.objectStorageBuckets.length +
        v.scope.backupGenerations.length;
      if (totalScope === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope"],
          message: `kind '${v.kind}' must declare at least one schema/table/bucket/backup`,
        });
      }
    }
    if (v.scope.rowCount > 0 && v.scope.tables.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "tables"],
        message: "rowCount > 0 requires at least one table in scope",
      });
    }
    if (v.scope.fileCount > 0 && v.scope.objectStorageBuckets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "objectStorageBuckets"],
        message: "fileCount > 0 requires at least one objectStorageBucket in scope",
      });
    }
    if (proofVersionCoversDeclaration(v.proofVersion) && v.capabilityDeclaration === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilityDeclaration"],
        message:
          `proofVersion '${v.proofVersion}' commits to a capabilityDeclaration; without it the` +
          " digest covers a declaration the record does not carry",
      });
    }
    if (!proofVersionCoversDeclaration(v.proofVersion) && v.capabilityDeclaration !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proofVersion"],
        message:
          `a capabilityDeclaration on a '${v.proofVersion}' record is outside the signed bytes; ` +
          `${declareOneOf(DECLARATION_BEARING_PROOF_VERSIONS)}, or carry no declaration`,
      });
    }
    if (proofVersionCoversRetentionClaim(v.proofVersion)) {
      if (v.retainedObligations === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retainedObligations"],
          message:
            `proofVersion '${v.proofVersion}' commits to a retention claim; without` +
            " retainedObligations the digest covers a claim the record does not carry",
        });
      } else if (v.retainedObligations.includes("none")) {
        // `none` is the obligation enum's "no obligation", so a retention under it is not a
        // retention. ADR-0330 refused it on both retention-bearing attestation outcomes; refusing it
        // here too keeps the signed claim from asserting a lawful basis that says there is none.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retainedObligations"],
          message: "'none' is not an obligation; a signed retention claim cannot name it",
        });
      } else if ((v.retainedObligations.length > 0) !== (v.retainedReason !== undefined)) {
        // The two halves of one claim: the obligations are what a machine reads and the prose is what
        // a person reads, and a proof that signs one without the other is a proof that says data was
        // kept for no stated reason, or kept for a reason under no obligation. Both are the half-
        // truths ADR-0317 refused, now inside the bytes where they would be anchored.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retainedObligations"],
          message:
            "a signed retention claim names obligations and a retainedReason together, or neither" +
            ` (obligations: ${v.retainedObligations.length.toString()}, reason: ${
              v.retainedReason === undefined ? "absent" : "present"
            })`,
        });
      }
    } else if (v.retainedObligations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proofVersion"],
        message:
          `retainedObligations on a '${v.proofVersion}' record is outside the signed bytes; ` +
          `${declareOneOf(RETENTION_BEARING_PROOF_VERSIONS)}, or carry no obligations`,
      });
    }
    if (
      proofVersionCoversRetentionClaim(v.proofVersion) &&
      v.retainedObligations !== undefined &&
      v.retainedObligations.length === 0 &&
      v.retainedDataReference !== undefined
    ) {
      // An empty claim says nothing was kept, so a pointer to where the kept data is contradicts the
      // same sentence. Only refused on a version that *signs* the claim: on v1 and v2 the reference
      // is prose outside the bytes and tightening it now would refuse stored records retroactively.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataReference"],
        message:
          "a signed retention claim naming no obligations cannot locate retained data; the record" +
          " claims both that nothing was kept and where it is",
      });
    }
    if (v.retainedReason !== undefined && v.retainedDataReference === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataReference"],
        message: "retainedReason requires retainedDataReference (audit trail)",
      });
    }
    if (proofVersionCoversRecordStorage(v.proofVersion) && v.recordStorage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recordStorage"],
        message:
          `proofVersion '${v.proofVersion}' commits to a record-storage declaration; without it` +
          " the digest covers a claim the record does not carry",
      });
    }
    if (!proofVersionCoversRecordStorage(v.proofVersion) && v.recordStorage !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proofVersion"],
        message:
          `a recordStorage declaration on a '${v.proofVersion}' record is outside the signed bytes; ` +
          `${declareOneOf(RECORD_STORAGE_BEARING_PROOF_VERSIONS)}, or carry no declaration`,
      });
    }
    const anchorKinds = new Set<string>();
    v.anchors.forEach((a, i) => {
      const dedupKey = `${a.kind}|${a.reference}`;
      if (anchorKinds.has(dedupKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["anchors", i],
          message: `duplicate anchor (${a.kind}, ${a.reference})`,
        });
      }
      anchorKinds.add(dedupKey);
    });
  });
export type TombstoneRecord = z.infer<typeof TombstoneRecordSchema>;

export function tombstoneAge(
  record: TombstoneRecord,
  now: Date = new Date(),
): number {
  return Math.floor(
    (now.getTime() - new Date(record.deletedAt).getTime()) / 1000 / 86_400,
  );
}

export function tombstonesByKind(
  records: readonly TombstoneRecord[],
  kind: TombstoneKind,
): readonly TombstoneRecord[] {
  return records.filter((r) => r.kind === kind);
}

export function tombstoneChainFor(
  records: readonly TombstoneRecord[],
  tenantId: string,
): readonly TombstoneRecord[] {
  return [...records]
    .filter((r) => r.tenantId === tenantId)
    .sort((a, b) => new Date(a.deletedAt).getTime() - new Date(b.deletedAt).getTime());
}

/**
 * What a stored tombstone says about the subsystems its deployment does not have.
 *
 * Three answers, two shapes. A v2 record's declaration is inside the signed bytes, so the reading is
 * `covered_by_proof` and carries the list — which may legitimately be empty, meaning "this deployment
 * holds all six, and that is signed". A v1 record's bytes say nothing about any declaration, so the
 * reading is `unknown_not_in_proof` and **carries no list at all**: there is deliberately no empty
 * array for a caller to mistake for "none absent". "We have no object storage" and "nobody asked" are
 * the two facts ADR-0317 is about, and the whole point of the v2 bytes is that a reader can tell them
 * apart.
 */
export type DeclaredAbsenceReading =
  | {
      readonly declarationState: "covered_by_proof";
      readonly absentSubsystems: readonly DeclaredSubsystem[];
      readonly declaration: TombstoneCapabilityDeclaration;
    }
  | {
      readonly declarationState: "unknown_not_in_proof";
      /**
       * `v1_proof` is the ordinary case: the record's bytes predate declarations entirely.
       * `declaration_missing` is a record labelled v2 that carries none — only reachable past the
       * schema, and reported as its own reason rather than as a v1 record, because calling it v1
       * would be the self-downgrading tamper this field exists to make legible.
       */
      readonly reason: "v1_proof" | "declaration_missing";
    };

export function readDeclaredAbsences(record: TombstoneRecord): DeclaredAbsenceReading {
  const declaration = record.capabilityDeclaration;
  // Asked of the membership list and never of the string, because v3 carries the declaration too
  // (ADR-0331). A literal `!== "v2"` here would have reported every v3 proof as having no declaration
  // in its bytes, which is the self-downgrading misreading the explicit version field exists to stop
  // — arrived at by the verifier rather than by a tamper.
  if (!proofVersionCoversDeclaration(record.proofVersion)) {
    return { declarationState: "unknown_not_in_proof", reason: "v1_proof" };
  }
  if (declaration === undefined) {
    return { declarationState: "unknown_not_in_proof", reason: "declaration_missing" };
  }
  return {
    declarationState: "covered_by_proof",
    absentSubsystems: DECLARED_SUBSYSTEMS.filter((s) => declaration[s] === "absent"),
    declaration,
  };
}

/**
 * What a stored tombstone says about data it lawfully kept — and whether the proof covers the answer.
 *
 * Deliberately the same two-state shape as `DeclaredAbsenceReading`, for the same reason. A v3
 * record's claim is inside the signed bytes, so `covered_by_proof` carries it — including the
 * legitimately empty case, which is the signed assertion that *nothing* was kept. A v1 or v2 record's
 * bytes say nothing about a retention, so the reading is `unknown_not_in_proof` and carries **no
 * claim at all**: there is no empty list for a caller to mistake for "nothing was retained", because
 * such a record may well carry retention prose that simply was not signed. "We kept nothing" and
 * "this proof cannot say what we kept" are the two facts ADR-0331 exists to separate.
 */
export type RetentionClaimReading =
  | {
      readonly claimState: "covered_by_proof";
      readonly obligations: readonly RetentionObligation[];
      readonly retainedReason: string | null;
      readonly retainedDataReference: string | null;
    }
  | {
      readonly claimState: "unknown_not_in_proof";
      /**
       * `pre_v3_proof` is the ordinary case: the record's bytes predate retention claims entirely,
       * and its `retainedReason` — if it has one — is on the record's face and nowhere else.
       * `obligations_missing` is a record labelled v3 carrying none, only reachable past the schema,
       * and reported as its own reason rather than as an older proof for the reason the version field
       * is explicit at all.
       */
      readonly reason: "pre_v3_proof" | "obligations_missing";
    };

export function readRetentionClaim(record: TombstoneRecord): RetentionClaimReading {
  if (!proofVersionCoversRetentionClaim(record.proofVersion)) {
    return { claimState: "unknown_not_in_proof", reason: "pre_v3_proof" };
  }
  const obligations = record.retainedObligations;
  if (obligations === undefined) {
    return { claimState: "unknown_not_in_proof", reason: "obligations_missing" };
  }
  return {
    claimState: "covered_by_proof",
    obligations: [...new Set(obligations)].sort(),
    retainedReason: record.retainedReason ?? null,
    retainedDataReference: record.retainedDataReference ?? null,
  };
}

/**
 * What a stored tombstone says about where the tenant's records were — and whether the proof covers
 * the answer.
 *
 * The third reading in this shape, for the third version that added a declaration, and the shape is
 * the same for the same reason: there is **no default declaration** on the unknown arm. A v1, v2 or
 * v3 record's bytes say nothing about the storage model, and inventing `document_rows` for it would
 * be the most dangerous possible guess — it asserts that no typed relations existed, which is
 * exactly the claim ADR-0350's gap made unavailable and the one a reader must not be handed for
 * free.
 */
export type RecordStorageReading =
  | {
      readonly declarationState: "covered_by_proof";
      readonly recordStorage: TombstoneRecordStorageDeclaration;
    }
  | {
      readonly declarationState: "unknown_not_in_proof";
      /**
       * `pre_v4_proof` is the ordinary case: the record's bytes predate the declaration entirely.
       * `record_storage_missing` is a record labelled v4 carrying none — only reachable past the
       * schema, and its own reason rather than an older proof, for the reason the version field is
       * explicit at all.
       */
      readonly reason: "pre_v4_proof" | "record_storage_missing";
    };

export function readRecordStorage(record: TombstoneRecord): RecordStorageReading {
  if (!proofVersionCoversRecordStorage(record.proofVersion)) {
    return { declarationState: "unknown_not_in_proof", reason: "pre_v4_proof" };
  }
  const recordStorage = record.recordStorage;
  if (recordStorage === undefined) {
    return { declarationState: "unknown_not_in_proof", reason: "record_storage_missing" };
  }
  return { declarationState: "covered_by_proof", recordStorage };
}

export function isCryptographicallyAnchored(record: TombstoneRecord): boolean {
  return record.anchors.some(
    (a) =>
      a.kind === "trillian_log" ||
      a.kind === "blockchain_anchor" ||
      a.kind === "rfc3161_timestamp",
  );
}
