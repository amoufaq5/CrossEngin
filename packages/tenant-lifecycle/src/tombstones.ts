import { z } from "zod";

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
 */
export const TOMBSTONE_PROOF_VERSIONS = ["v1", "v2"] as const;
export type TombstoneProofVersion = (typeof TOMBSTONE_PROOF_VERSIONS)[number];
export const TombstoneProofVersionSchema = z.enum(TOMBSTONE_PROOF_VERSIONS);

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
    if (v.proofVersion === "v2" && v.capabilityDeclaration === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilityDeclaration"],
        message:
          "proofVersion 'v2' commits to a capabilityDeclaration; without it the digest covers a" +
          " declaration the record does not carry",
      });
    }
    if (v.proofVersion === "v1" && v.capabilityDeclaration !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proofVersion"],
        message:
          "a capabilityDeclaration on a 'v1' record is outside the signed bytes; declare" +
          " proofVersion 'v2' or carry no declaration",
      });
    }
    if (v.retainedReason !== undefined && v.retainedDataReference === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataReference"],
        message: "retainedReason requires retainedDataReference (audit trail)",
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
  if (record.proofVersion !== "v2") {
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

export function isCryptographicallyAnchored(record: TombstoneRecord): boolean {
  return record.anchors.some(
    (a) =>
      a.kind === "trillian_log" ||
      a.kind === "blockchain_anchor" ||
      a.kind === "rfc3161_timestamp",
  );
}
