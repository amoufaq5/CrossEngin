import { z } from "zod";

import { RETENTION_OBLIGATIONS, type RetentionObligation } from "./gdpr-deletion.js";
import { populateTombstoneHashes, verifyTombstoneHashes } from "./tombstone-proof.js";
import {
  DeletionScopeSchema,
  TombstoneRecordSchema,
  asCapabilityDeclaration,
  proofVersionCoversRetentionClaim,
  type DeletionScope,
  type TombstoneAnchor,
  type TombstoneKind,
  type TombstoneRecord,
} from "./tombstones.js";

/**
 * Assembling a `TombstoneRecord` from what each subsystem actually destroyed.
 *
 * ADR-0316 made a tenant's own schema erasable and left the last step by hand: `erasureDeletionScope`
 * reported what it destroyed, and a human merged that into a `DeletionScope`, filled in the rest, and
 * signed it. Which is how the original defect happened. A tombstone is a cryptographic assertion that
 * named data is gone, and the thing that made it false was not a wrong number — it was a subsystem
 * nobody asked, whose silence read as nothing to delete.
 *
 * So the rule this module exists to enforce, and it is the whole module:
 *
 *   **Silence is not "none". A subsystem in scope must say what it destroyed, say it found nothing, or
 *   say it is lawfully keeping it. An absent attestation refuses the tombstone.**
 *
 * That is ADR-0316's `erasureDeletionScope` comment — "a zero from here would read as 'none' rather
 * than 'not asked'" — turned from a caller's responsibility into a check. A `DeletionScope` is never
 * written by hand here: every list and every count is composed from attestations, so the figures
 * cannot disagree with what was reported, and nothing can be added that nobody attested to.
 *
 * The assembler is pure, like the rest of this package: it takes reports, composes, hashes through
 * `populateTombstoneHashes`, validates through `TombstoneRecordSchema`, and — because this is the one
 * place the lesson applies hardest — **re-verifies its own output** before returning it. An assembler
 * that emitted a record whose proof does not check out would be the same class of bug one level up.
 *
 * ADR-0328 closed the last way around that rule. Refusing an unattested subsystem *in scope* left the
 * scope itself a list the caller passed, so forgetting a subsystem produced a tombstone that never
 * mentioned it and refused nothing — and every deletion in practice omitted four of the six. The
 * required list is now derived from `DeletionCapabilities`, which a deployment declares once and
 * totally: silence is not a disposition there either.
 *
 * `erased_and_retained` is the fourth outcome, and it exists because the alternative was a lie. A
 * subsystem could attest exactly one disposition, so `shared_tables` — which destroys 96 tables and
 * leaves 16 — could only call itself `erased` by defining the 16 as *not the tenant's data at all*.
 * That holds for a forensic chain entry and fails for a sales invoice under a tax obligation, so a
 * genuine statutory retention could be expressed only by quietly joining a set whose definition
 * denies it. The outcome splits the claim without touching the figures: the `scope` still reports
 * only what was destroyed, and the retained side carries obligations and a reference with no numeric
 * field at all.
 *
 * ADR-0331 took that `v3` decision. The capabilities path emits `crossengin.tombstone.content.v3`,
 * whose bytes carry the composed retention claim — the obligations, the prose and the reference — so
 * rewriting why a tenant's data survived moves `contentManifestSha256`. It is the version for **every**
 * capabilities-path assembly and not only for a deletion that kept something: a conditional version
 * would express "nothing was retained" by the absence of a tag, which no reader can tell from a record
 * written before the tag existed. The empty claim is signed. The `requiredSubsystems` path still emits
 * v1, and v1 and v2 bytes are untouched, so every stored digest verifies exactly as it did.
 */

/**
 * The subsystems that can hold a tenant's data. Each maps to the `DeletionScope` fields it owns, and
 * owning them is exclusive: nothing else may contribute to those fields, so a scope's provenance is
 * always one named subsystem.
 */
export const DELETION_SUBSYSTEMS = [
  /** The tenant's own Postgres schema (ADR-0314, erased by ADR-0316). */
  "tenant_schema",
  /** Rows in the shared boot schema and `meta.*` — the JSONB entity store, settings, sequences. */
  "shared_tables",
  /** `@crossengin/files` object storage. */
  "object_storage",
  /** Backup generations holding the tenant's data. */
  "backups",
  /** Search and vector indexes. */
  "search_indexes",
  /** Cache keys. */
  "caches",
] as const;
export type DeletionSubsystem = (typeof DELETION_SUBSYSTEMS)[number];
export const DeletionSubsystemSchema = z.enum(DELETION_SUBSYSTEMS);

/**
 * Which `DeletionScope` list each subsystem may contribute to.
 *
 * Declared rather than inferred so a subsystem cannot quietly widen its remit: `object_storage`
 * reporting a *schema* is a programming error, caught rather than merged.
 */
export const SUBSYSTEM_SCOPE_FIELDS: Readonly<
  Record<DeletionSubsystem, readonly (keyof DeletionScope)[]>
> = Object.freeze({
  tenant_schema: ["schemas", "tables", "rowCount", "storageBytes"],
  shared_tables: ["tables", "rowCount", "storageBytes"],
  object_storage: ["objectStorageBuckets", "fileCount", "storageBytes"],
  backups: ["backupGenerations", "storageBytes"],
  search_indexes: ["searchIndexes"],
  caches: ["cacheKeys"],
});

/**
 * What a deployment *holds*, declared once rather than listed per deletion.
 *
 * ADR-0317 closed the hole where a subsystem's silence read as "nothing to delete", by refusing a
 * tombstone whose in-scope subsystem did not attest. That left the same hole one level up: *scope*
 * was a list the caller passed, so a caller who forgot a subsystem got a tombstone that never
 * mentioned it and refused nothing. The defect moved rather than closing — and in practice every
 * deletion declared four of the six subsystems out of scope by simply omitting them.
 *
 * So the required list is **derived** from a deployment-level declaration. Forgetting a subsystem at
 * a call site stops being expressible, because no call site names subsystems any more.
 */
export const SUBSYSTEM_DISPOSITIONS = [
  /** This deployment has it and will erase it, so it must attest. */
  "erases",
  /** This deployment has it and is lawfully obliged to keep it, so it must attest too. */
  "retains",
  /** This deployment does not have this subsystem at all. The only disposition that leaves scope. */
  "absent",
] as const;
export type SubsystemDisposition = (typeof SUBSYSTEM_DISPOSITIONS)[number];
export const SubsystemDispositionSchema = z.enum(SUBSYSTEM_DISPOSITIONS);

/**
 * Written out one key per subsystem rather than as a `z.record` over the enum, because zod 3's record
 * validates the keys it is *given* and never notices a missing one — which is this module's defect in
 * a new shape. `satisfies Record<DeletionSubsystem, …>` makes a seventh subsystem a `tsc` failure here
 * instead of a silent `absent`.
 */
const CAPABILITY_SHAPE = {
  tenant_schema: SubsystemDispositionSchema,
  shared_tables: SubsystemDispositionSchema,
  object_storage: SubsystemDispositionSchema,
  backups: SubsystemDispositionSchema,
  search_indexes: SubsystemDispositionSchema,
  caches: SubsystemDispositionSchema,
} satisfies Record<DeletionSubsystem, typeof SubsystemDispositionSchema>;

/**
 * The declaration is **total**: every member of `DELETION_SUBSYSTEMS` must appear, and no key is
 * optional. An optional map would let an unmentioned subsystem mean whatever the reader assumed,
 * which is the silence ADR-0317 refused — only now in the configuration rather than in the evidence.
 *
 * `retains` stays **in scope**, which is why there are three dispositions and not two. A retention
 * obligation is a claim the proof has to carry — ADR-0317 gave it an outcome, a named
 * `RetentionObligation` and a reference for exactly that purpose — not a licence to go quiet about
 * the subsystem. Treating it as out of scope would reproduce the original defect with a lawful
 * excuse: the data is still there, and the proof would not say so.
 */
export const DeletionCapabilitiesSchema = z
  .object(CAPABILITY_SHAPE)
  .strict()
  .superRefine((v, ctx) => {
    if (v.tenant_schema === "absent") {
      // Every deployment has one (ADR-0314) and the pipeline erases and attests it unconditionally
      // (ADR-0319), so a declaration saying otherwise is a configuration error, not a deployment
      // shape. Refusing it here means the contradiction is caught at boot rather than by a tombstone
      // that omits the one subsystem the deletion definitely touched.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tenant_schema"],
        message:
          "tenant_schema cannot be 'absent': every deployment has one and the deletion pipeline" +
          " erases and attests it unconditionally",
      });
    }
    if (v.shared_tables === "absent") {
      // ADR-0329 made this the second performed subsystem, and the rule is `tenant_schema`'s for
      // the same reason: every deployment has a `meta` schema, 112 of its tables carry a
      // `tenant_id`, and `eraseSharedTablesWithin` erases and attests them unconditionally. A
      // declaration calling it absent is a configuration error, not a deployment shape.
      //
      // The refusal belongs **here** and not only in the pipeline, which is where it was first
      // enforced: a disposition the pipeline will reject is one a deployment should learn about at
      // boot, from the flag that declares it, rather than from the first tenant deletion it tries.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shared_tables"],
        message:
          "shared_tables cannot be 'absent': the platform's own tenant-scoped tables always exist" +
          " and the deletion pipeline erases and attests them unconditionally",
      });
    }
  });
export type DeletionCapabilities = z.infer<typeof DeletionCapabilitiesSchema>;

/**
 * The declaration a deployment gets if it reaches for one: **every subsystem erases**.
 *
 * Deliberately not `absent` for the four subsystems whose erasures do not exist yet, and deliberately
 * an exported constant rather than a `z.default()` on the schema — a schema default is applied to
 * *silence*, which is the one thing this module exists to make impossible.
 *
 * The choice is between two ways of being wrong, and they are not symmetric:
 *
 *   - A wrong `erases` refuses the next deletion with `subsystem_unattested`, naming the subsystem.
 *     Inside the pipeline that refusal aborts the transaction, so nothing is destroyed. An operator
 *     meets it on the first deletion and answers it with one line of configuration.
 *   - A wrong `absent` succeeds, and signs an Article 17 proof that is silent about a place the
 *     tenant's data still is. Nobody meets it, and the proof is anchored before anyone could.
 *
 * A proof takes the loud failure every time. The quiet one is the defect.
 */
export const CONSERVATIVE_DELETION_CAPABILITIES: DeletionCapabilities = Object.freeze({
  tenant_schema: "erases",
  shared_tables: "erases",
  object_storage: "erases",
  backups: "erases",
  search_indexes: "erases",
  caches: "erases",
});

/**
 * The subsystems a deletion must hear from, derived from what the deployment declared.
 *
 * `erases` and `retains` are both in scope; only `absent` is out. The disposition says what the
 * deployment *has*, never what a given deletion found — a subsystem declared `erases` may perfectly
 * well attest `nothing_to_erase`, and one declared `retains` may attest `erased` once the obligation
 * lapses. What it may not do is stay quiet.
 *
 * `erased_and_retained` is admissible under either, and the vocabulary has no
 * `erases_and_retains` disposition to match it. That is the same looseness, not a gap papered over:
 * `shared_tables` destroys most of what it holds and keeps a statutory remainder, and which tables
 * fall on which side is a property of the catalog rather than of the deployment. The declaration
 * says the subsystem is *in scope and must speak*; the attestation says what it did.
 */
export function requiredSubsystemsFor(
  capabilities: DeletionCapabilities,
): readonly DeletionSubsystem[] {
  return DELETION_SUBSYSTEMS.filter((s) => capabilities[s] !== "absent");
}

/**
 * The subsystems this deployment declared it does not have.
 *
 * Carried out of the assembly so a reader of the result can tell "this deployment has no object
 * storage" from "nobody asked about object storage" — the two states ADR-0317's refusal is about,
 * which look identical in a scope that merely omits them.
 */
export function absentSubsystemsFor(
  capabilities: DeletionCapabilities,
): readonly DeletionSubsystem[] {
  return DELETION_SUBSYSTEMS.filter((s) => capabilities[s] === "absent");
}

export const ATTESTATION_OUTCOMES = [
  /** Something was destroyed; `scope` says what, measured. */
  "erased",
  /** The subsystem was asked and held nothing for this tenant. */
  "nothing_to_erase",
  /** The subsystem holds data it is lawfully required to keep. */
  "retained",
  /**
   * Part of it was destroyed and part of it is lawfully kept — one subsystem, one attestation, two
   * claims.
   *
   * ADR-0329 named this and deferred it, and the thing it was deferred *around* is why it exists.
   * `shared_tables` erases 96 of the catalog's 112 tenant-scoped tables and leaves 16, and the only
   * way to call that attestation `erased` without lying was to define the 16 as *not the tenant's
   * data at all* — true of a forensic chain entry, and false of a sales invoice under a seven-year
   * tax obligation. So a real retention could only be expressed by quietly adding a table to a set
   * defined as "not the tenant's data", which is a false statement inside a cryptographic proof. The
   * honest option was unavailable, and this is it.
   *
   * It is a **fourth outcome** and not a retention block riding along on `erased`, because the
   * outcome field is the single answer to "what happened here" and it has to stay total. An optional
   * field can be forgotten with the outcome unchanged — which is ADR-0317's silence in a new place,
   * `erased` meaning two different things depending on a field a reader may not check. A new enum
   * member is a *compile-time* demand on every exhaustive reader instead.
   *
   * The division of labour is the rule that keeps the proof honest: the **figures** describe only what
   * was destroyed (`scope`, exactly as on `erased`), and the retained side carries obligations and a
   * reference and has no numeric field at all.
   */
  "erased_and_retained",
] as const;
export type AttestationOutcome = (typeof ATTESTATION_OUTCOMES)[number];

/**
 * The outcomes that may carry measured figures. Everything else is refused a `scope` outright.
 *
 * Named rather than written as a disjunction at each of its four use sites: the rule "figures
 * describe only what was destroyed" is the whole provenance argument, and four copies of it is four
 * places to forget the fourth outcome.
 */
export const SCOPE_BEARING_OUTCOMES: readonly AttestationOutcome[] = Object.freeze([
  "erased",
  "erased_and_retained",
]);

/** The outcomes that assert a lawful retention, and must therefore name it and locate it. */
export const RETENTION_BEARING_OUTCOMES: readonly AttestationOutcome[] = Object.freeze([
  "retained",
  "erased_and_retained",
]);

function bearsScope(outcome: AttestationOutcome): boolean {
  return SCOPE_BEARING_OUTCOMES.includes(outcome);
}

function bearsRetention(outcome: AttestationOutcome): boolean {
  return RETENTION_BEARING_OUTCOMES.includes(outcome);
}

/** The contribution a subsystem may report. Every field optional; omitted means it owns nothing there. */
export const ScopeContributionSchema = z
  .object({
    schemas: z.array(z.string().min(1)).optional(),
    tables: z.array(z.string().min(1)).optional(),
    objectStorageBuckets: z.array(z.string().min(1)).optional(),
    backupGenerations: z.array(z.string().min(1)).optional(),
    searchIndexes: z.array(z.string().min(1)).optional(),
    cacheKeys: z.array(z.string().min(1)).optional(),
    rowCount: z.number().int().nonnegative().optional(),
    storageBytes: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ScopeContribution = z.infer<typeof ScopeContributionSchema>;

export const DeletionAttestationSchema = z
  .object({
    subsystem: DeletionSubsystemSchema,
    outcome: z.enum(ATTESTATION_OUTCOMES),
    /** Required for the scope-bearing outcomes, forbidden otherwise — see the superRefine. */
    scope: ScopeContributionSchema.optional(),
    /** Required for `retained`: which obligation keeps it. `none` is not an obligation. */
    retentionObligation: z.enum(RETENTION_OBLIGATIONS).optional(),
    /**
     * Required for `erased_and_retained`: the obligations keeping back the part that stayed.
     *
     * A list, and singular `retentionObligation` deliberately left alone, because the two outcomes
     * make different claims. `retained` holds a whole subsystem back under *the* obligation; a
     * partial retention is a *subset* chosen table by table, and a subset is exactly where two
     * obligations become possible — a tax retention over billing rows and a HIPAA one over clinical
     * rows are one subsystem's two reasons. Collapsing them to one field would force a producer to
     * either pick one (a proof that under-reports why data is still there) or refuse the deletion the
     * day a second obligation appears. One name per claim rather than one field for two claims.
     *
     * It carries no count, and there is no field here that could: the figures in a proof describe
     * what was **destroyed**. A retained row's existence is a legal fact with a pointer, not a
     * measurement in the erasure's scope, and a number on this side would be read as part of it.
     */
    retainedObligations: z.array(z.enum(RETENTION_OBLIGATIONS)).optional(),
    /** Required for both retention-bearing outcomes: where the retained data is, for the audit trail. */
    retainedDataReference: z.string().min(1).optional(),
    /** Who or what attested. Free text: a subsystem is not a `meta.users` row (ADR-0289). */
    attestedBy: z.string().min(1),
    attestedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (bearsScope(v.outcome) && v.scope === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: `an '${v.outcome}' attestation must report what it destroyed`,
      });
    }
    if (!bearsScope(v.outcome) && v.scope !== undefined) {
      // Otherwise a `nothing_to_erase` could smuggle figures into the proof, which is the
      // provenance hole this module closes.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: `outcome '${v.outcome}' must not report a scope`,
      });
    }
    if (v.outcome === "retained") {
      if (v.retentionObligation === undefined || v.retentionObligation === "none") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retentionObligation"],
          message: "a 'retained' attestation must name the obligation keeping the data ('none' is not one)",
        });
      }
    } else if (v.retentionObligation !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retentionObligation"],
        message:
          v.outcome === "erased_and_retained"
            ? "an 'erased_and_retained' attestation names its obligations in retainedObligations," +
              " which is a list because a partial retention can have more than one reason"
            : `outcome '${v.outcome}' must not declare retentionObligation`,
      });
    }
    if (v.outcome === "erased_and_retained") {
      // The retained side cannot be silent (ADR-0317). An empty list is the shape that would say
      // "something stayed" and name nothing, which is precisely the silence that reads as "none".
      if (v.retainedObligations === undefined || v.retainedObligations.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retainedObligations"],
          message:
            "an 'erased_and_retained' attestation must name at least one obligation keeping the" +
            " retained part back",
        });
      } else if (v.retainedObligations.includes("none")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retainedObligations"],
          message: "'none' is not an obligation; a retention with no obligation is not a retention",
        });
      }
    } else if (v.retainedObligations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedObligations"],
        message: `outcome '${v.outcome}' must not declare retainedObligations`,
      });
    }
    if (bearsRetention(v.outcome)) {
      if (v.retainedDataReference === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retainedDataReference"],
          message: `an '${v.outcome}' attestation must say where the retained data is`,
        });
      }
    } else if (v.retainedDataReference !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedDataReference"],
        message: `outcome '${v.outcome}' must not declare retainedDataReference`,
      });
    }
    if (bearsScope(v.outcome) && v.scope !== undefined) {
      const permitted = new Set<string>(SUBSYSTEM_SCOPE_FIELDS[v.subsystem]);
      for (const key of Object.keys(v.scope)) {
        if (!permitted.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scope", key],
            message: `${v.subsystem} does not own '${key}'`,
          });
        }
      }
    }
  });
export type DeletionAttestation = z.infer<typeof DeletionAttestationSchema>;

export const ASSEMBLY_REFUSAL_REASONS = [
  "subsystem_unattested",
  "duplicate_attestation",
  "invalid_attestation",
  "four_eyes_violated",
  "no_anchors",
  "scope_empty",
  "record_invalid",
  "proof_unverifiable",
  /** Neither a `capabilities` declaration nor a `requiredSubsystems` list: nothing says who must speak. */
  "scope_undeclared",
  /** Both were given. One required list, one source — the same rule as one subsystem, one attestation. */
  "scope_declaration_ambiguous",
  /** The declaration itself does not parse: a missing subsystem, or `tenant_schema: "absent"`. */
  "capabilities_invalid",
  /** A subsystem the deployment declared it does not have reported anyway. */
  "absent_subsystem_attested",
] as const;
export type AssemblyRefusalReason = (typeof ASSEMBLY_REFUSAL_REASONS)[number];

export interface AssemblyRefusal {
  readonly reason: AssemblyRefusalReason;
  readonly detail: string;
}

const EMPTY_SCOPE: DeletionScope = {
  schemas: [],
  tables: [],
  objectStorageBuckets: [],
  backupGenerations: [],
  searchIndexes: [],
  cacheKeys: [],
  rowCount: 0,
  storageBytes: 0,
  fileCount: 0,
};

/** Mutable by return type, because `DeletionScope`'s lists are `z.array(...)` and so mutable. */
function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Folds the `erased` attestations into one `DeletionScope`.
 *
 * Lists are deduplicated and sorted — the content manifest sorts them anyway, and doing it here means
 * two subsystems naming the same table (the shared store and a tenant schema cannot, but a future
 * pair might) count it once. Counts sum. `nothing_to_erase` and `retained` contribute nothing by
 * construction, because they are refused a `scope` at all.
 *
 * An `erased_and_retained` attestation folds in exactly like an `erased` one, and that is the
 * provenance rule rather than a convenience: what enters a `DeletionScope` is what a subsystem
 * destroyed, so the half it kept contributes nothing here and cannot be read as part of the erasure.
 */
export function composeDeletionScope(
  attestations: readonly DeletionAttestation[],
): DeletionScope {
  const lists: Record<string, string[]> = {
    schemas: [],
    tables: [],
    objectStorageBuckets: [],
    backupGenerations: [],
    searchIndexes: [],
    cacheKeys: [],
  };
  let rowCount = 0;
  let storageBytes = 0;
  let fileCount = 0;

  for (const a of attestations) {
    if (!bearsScope(a.outcome) || a.scope === undefined) continue;
    for (const key of Object.keys(lists)) {
      const contributed = a.scope[key as keyof ScopeContribution];
      if (Array.isArray(contributed)) lists[key]?.push(...contributed);
    }
    rowCount += a.scope.rowCount ?? 0;
    storageBytes += a.scope.storageBytes ?? 0;
    fileCount += a.scope.fileCount ?? 0;
  }

  return {
    schemas: dedupeSorted(lists["schemas"] ?? []),
    tables: dedupeSorted(lists["tables"] ?? []),
    objectStorageBuckets: dedupeSorted(lists["objectStorageBuckets"] ?? []),
    backupGenerations: dedupeSorted(lists["backupGenerations"] ?? []),
    searchIndexes: dedupeSorted(lists["searchIndexes"] ?? []),
    cacheKeys: dedupeSorted(lists["cacheKeys"] ?? []),
    rowCount,
    storageBytes,
    fileCount,
  } satisfies DeletionScope;
}

export interface TombstoneAssemblyInput {
  readonly id: string;
  readonly kind: TombstoneKind;
  readonly tenantId: string;
  readonly subjectIdentifier?: string;
  readonly relatedDeletionRequestId?: string;
  readonly deletedAt: string;
  readonly executedBy: string;
  readonly approvedBy: string;
  readonly anchors: readonly TombstoneAnchor[];
  /**
   * What this deployment holds. The required list is derived from it, so a subsystem cannot be left
   * out of scope by being forgotten at a call site — which is the hole ADR-0317 left open.
   *
   * Exactly one of this and `requiredSubsystems` is supplied. Both is `scope_declaration_ambiguous`
   * and neither is `scope_undeclared`: a required list with two sources, or none, is the provenance
   * problem this module is about.
   */
  readonly capabilities?: DeletionCapabilities;
  /**
   * The subsystems this deletion covers, named per call. **Every one must attest**, and an absent
   * attestation is the refusal this module exists for — a `DeletionScope` is not allowed to be
   * silently short.
   *
   * Superseded by `capabilities`, and kept because it is what a caller that knows the exact subsystem
   * set of *one* deletion has: this list cannot say "we have no object storage", only "do not ask it
   * this time", and those are different claims.
   */
  readonly requiredSubsystems?: readonly DeletionSubsystem[];
  readonly attestations: readonly DeletionAttestation[];
  readonly invalidationOfPriorTombstoneId?: string | null;
}

export type TombstoneAssembly =
  | {
      readonly ok: true;
      readonly record: TombstoneRecord;
      readonly scope: DeletionScope;
      /**
       * The declaration the scope was derived from, when there was one — present iff `capabilities`
       * was supplied, so its absence means "named per call" rather than "nothing declared absent".
       *
       * Since ADR-0329 the declaration is also **in** the record, inside the signed bytes, so
       * this field is a convenience rather than the only way to read it: `record.proofVersion` is
       * `"v3"` (`"v2"` for a record written before ADR-0331) and `readDeclaredAbsences(record)`
       * answers from the proof itself. It is kept because
       * a caller that supplied `capabilities` and wants them back should not have to know which
       * proof version the assembler chose, and because the `requiredSubsystems` path still emits v1
       * and so has no declaration in its bytes at all — there, the absence of this field and the
       * absence from the proof mean the same thing, which is the honest reading.
       */
      readonly declaration?: DeletionCapabilities;
    }
  | { readonly ok: false; readonly refusals: readonly AssemblyRefusal[] };

/**
 * Builds a signed, self-verifying `TombstoneRecord` from subsystem attestations — or refuses, with
 * every reason it found rather than the first.
 *
 * The order of checks is deliberate: everything that can refuse does so **before** a hash is
 * computed, so this function never produces a content-manifest digest over a scope it is about to
 * reject. A hash that exists is a hash of something assembled correctly.
 *
 * The last check is the one ADR-0316 earned: the assembled record is run back through
 * `verifyTombstoneHashes`, and a mismatch is a `proof_unverifiable` refusal rather than a returned
 * record. It should be unreachable — `populateTombstoneHashes` computes exactly what the verifier
 * recomputes — which is precisely why it is worth asserting: the failure mode it guards is a signed
 * proof that does not check out, discovered by whoever relies on it rather than by us.
 */
export function assembleTombstone(input: TombstoneAssemblyInput): TombstoneAssembly {
  const refusals: AssemblyRefusal[] = [];

  // Who must speak is settled before anything is read, because every later check depends on it. The
  // declaration is re-parsed even though it is typed: it arrives from a deployment's configuration,
  // and a totality rule enforced only at the boundary is a totality rule one `as` defeats.
  let declaration: DeletionCapabilities | undefined;
  if (input.capabilities !== undefined) {
    const parsedCapabilities = DeletionCapabilitiesSchema.safeParse(input.capabilities);
    if (parsedCapabilities.success) {
      declaration = parsedCapabilities.data;
    } else {
      refusals.push({
        reason: "capabilities_invalid",
        detail: parsedCapabilities.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    }
    if (input.requiredSubsystems !== undefined) {
      refusals.push({
        reason: "scope_declaration_ambiguous",
        detail:
          "both capabilities and requiredSubsystems were declared; the required list has one source" +
          " or the narrower of the two silently wins",
      });
    }
  } else if (input.requiredSubsystems === undefined) {
    refusals.push({
      reason: "scope_undeclared",
      detail:
        "neither capabilities nor requiredSubsystems was declared; nothing says which subsystems" +
        " must attest, and an empty required list claims a deletion nobody checked",
    });
  }

  // Validate each attestation first: a malformed one must not be folded into a scope, and its own
  // rules (an `erased` with no figures, a `retained` with no obligation) are where provenance is won.
  const parsed: DeletionAttestation[] = [];
  input.attestations.forEach((candidate, index) => {
    const result = DeletionAttestationSchema.safeParse(candidate);
    if (!result.success) {
      refusals.push({
        reason: "invalid_attestation",
        detail:
          `attestation ${index.toString()}: ` +
          result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    parsed.push(result.data);
  });

  const seen = new Map<DeletionSubsystem, number>();
  for (const a of parsed) {
    const count = (seen.get(a.subsystem) ?? 0) + 1;
    seen.set(a.subsystem, count);
    if (count === 2) {
      // Two reports from one subsystem would double its counts and leave no single provenance for
      // its fields. One subsystem, one attestation.
      refusals.push({
        reason: "duplicate_attestation",
        detail: `${a.subsystem} attested more than once`,
      });
    }
  }

  const required = new Set(
    declaration !== undefined ? requiredSubsystemsFor(declaration) : (input.requiredSubsystems ?? []),
  );
  for (const subsystem of [...required].sort()) {
    if (!seen.has(subsystem)) {
      refusals.push({
        reason: "subsystem_unattested",
        detail:
          `${subsystem} is in scope and did not attest; its silence is not 'nothing to delete'` +
          " and the tombstone cannot claim otherwise",
      });
    }
  }
  if (declaration !== undefined) {
    for (const subsystem of absentSubsystemsFor(declaration)) {
      if (seen.has(subsystem)) {
        // The declaration and the evidence contradict each other, and there is no safe way to pick a
        // winner: either the deployment grew a subsystem nobody declared, or something attested for
        // one that does not exist. Folding the report in would put figures in the proof from a
        // subsystem the same proof says is absent.
        refusals.push({
          reason: "absent_subsystem_attested",
          detail:
            `${subsystem} is declared absent in this deployment and attested anyway;` +
            " the declaration and the evidence disagree about what exists",
        });
      }
    }
  }

  if (input.executedBy === input.approvedBy) {
    refusals.push({
      reason: "four_eyes_violated",
      detail: "executedBy and approvedBy must differ (four-eyes principle)",
    });
  }
  if (input.anchors.length === 0) {
    refusals.push({
      reason: "no_anchors",
      detail: "a tombstone nothing anchors is a claim with no witness",
    });
  }

  const scope = composeDeletionScope(parsed);
  const scopeIsEmpty =
    scope.schemas.length +
      scope.tables.length +
      scope.objectStorageBuckets.length +
      scope.backupGenerations.length +
      scope.searchIndexes.length +
      scope.cacheKeys.length ===
    0;
  const retained = parsed.filter((a) => bearsRetention(a.outcome));
  if (scopeIsEmpty && retained.length === 0) {
    // Every subsystem attested and every one of them found nothing, with nothing retained either.
    // That is not a deletion; `TombstoneRecordSchema` would refuse it for `tenant_deletion` anyway,
    // and refusing here says why rather than reporting a schema violation.
    refusals.push({
      reason: "scope_empty",
      detail: "every subsystem reported nothing erased and nothing retained; there is no deletion to attest",
    });
  }

  if (refusals.length > 0) return { ok: false, refusals };

  const first = retained[0];
  const candidate = {
    id: input.id,
    kind: input.kind,
    tenantId: input.tenantId,
    ...(input.subjectIdentifier !== undefined ? { subjectIdentifier: input.subjectIdentifier } : {}),
    ...(input.relatedDeletionRequestId !== undefined
      ? { relatedDeletionRequestId: input.relatedDeletionRequestId }
      : {}),
    deletedAt: input.deletedAt,
    executedBy: input.executedBy,
    approvedBy: input.approvedBy,
    scope,
    anchors: [...input.anchors],
    // Derived from the attestations rather than remembered by the caller: the contract requires the
    // reason/reference pair, and deriving it means a retained subsystem cannot be reported as
    // deleted by a caller who simply forgot to carry it across.
    ...(first !== undefined
      ? {
          retainedReason: retainedReasonFor(retained),
          retainedDataReference: retained.map((a) => a.retainedDataReference ?? "").join("; "),
        }
      : {}),
    invalidationOfPriorTombstoneId: input.invalidationOfPriorTombstoneId ?? null,
    // The declaration goes **inside the signed bytes** (ADR-0329), which is what makes a declared
    // `absent` part of the claim rather than a note beside it. ADR-0328 left this open for a reason
    // worth restating: the figures in a scope are composed from attestations, so a subsystem that
    // attests is covered by the proof — but a subsystem declared `absent` attests *nothing*, and
    // under v1 the digest could not tell "this deployment has no object storage" from "nobody
    // asked", which is ADR-0317's original defect surviving one level up.
    //
    // It is a **version**, not an added field, because `crossengin.tombstone.content.v1` bytes are
    // what every stored digest commits to: appending to them in place would stop every existing
    // tombstone verifying. So the capabilities path emits `v2` and the legacy `requiredSubsystems`
    // path stays `v1` — and the schema refuses the two mixed in either direction, so a relabelling
    // tamper cannot pass itself off as an older record.
    //
    // ADR-0331 moves the same path to `v3`, which adds the **retention claim** to those bytes for the
    // reason that keeps recurring: the claim was derived from the attestations, written onto the
    // record, and covered by neither digest — so a stored proof's answer to "why is this data still
    // here" could be rewritten with every hash and the chain entry byte-identical. `retainedObligations`
    // is the structured half, and the empty array is a *claim* rather than a placeholder: it is the
    // signed assertion that nothing was kept, which v1 and v2 bytes cannot make.
    ...(declaration !== undefined
      ? {
          proofVersion: "v3" as const,
          capabilityDeclaration: asCapabilityDeclaration(declaration),
          retainedObligations: [...retainedObligations(parsed)],
        }
      : {}),
  };

  const validated = TombstoneRecordSchema.safeParse(populateTombstoneHashes(candidate));
  if (!validated.success) {
    return {
      ok: false,
      refusals: [
        {
          reason: "record_invalid",
          detail: validated.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
      ],
    };
  }

  const verified = verifyTombstoneHashes(validated.data);
  if (!verified.contentManifestOk || !verified.proofOk) {
    return {
      ok: false,
      refusals: [
        {
          reason: "proof_unverifiable",
          detail:
            "the assembled record's own hashes do not verify" +
            ` (contentManifest ${verified.contentManifestOk ? "ok" : "bad"},` +
            ` proof ${verified.proofOk ? "ok" : "bad"})`,
        },
      ],
    };
  }

  return {
    ok: true,
    record: validated.data,
    scope,
    ...(declaration !== undefined ? { declaration } : {}),
  };
}

/**
 * The obligations one attestation names, whichever shape it names them in.
 *
 * The single place that knows `retained` says it in `retentionObligation` and
 * `erased_and_retained` in `retainedObligations`. `none` is filtered out rather than reported: the
 * schema refuses it on both outcomes, so one here would mean a record that bypassed validation, and
 * the honest answer for a reader is "this names no obligation" rather than "it names 'none'".
 */
export function attestationRetainedObligations(
  attestation: DeletionAttestation,
): readonly RetentionObligation[] {
  const named =
    attestation.outcome === "retained"
      ? attestation.retentionObligation === undefined
        ? []
        : [attestation.retentionObligation]
      : attestation.outcome === "erased_and_retained"
        ? (attestation.retainedObligations ?? [])
        : [];
  return [...new Set(named.filter((o) => o !== "none"))].sort();
}

/** One readable sentence naming every obligation keeping data back. */
function retainedReasonFor(retained: readonly DeletionAttestation[]): string {
  const parts = retained.map((a) => {
    const obligations = attestationRetainedObligations(a);
    // "unspecified" is unreachable past the schema and kept for the same reason the assembler
    // re-verifies its own hashes: the failure it stands for is a proof whose retention prose names
    // nothing, and a reader meeting the word knows the record is wrong rather than reading a blank.
    return `${a.subsystem}: ${obligations.length === 0 ? "unspecified" : obligations.join(", ")}`;
  });
  return `retained under legal obligation — ${parts.join("; ")}`;
}

/**
 * The obligations that keep data back in this assembly, deduplicated. For a deletion-request record
 * that has to carry them separately from the tombstone's prose.
 */
export function retainedObligations(
  attestations: readonly DeletionAttestation[],
): readonly RetentionObligation[] {
  const out = new Set<RetentionObligation>();
  for (const a of attestations) {
    for (const obligation of attestationRetainedObligations(a)) out.add(obligation);
  }
  return [...out].sort();
}

/**
 * Re-checks a stored tombstone against the attestations it was built from.
 *
 * The record commits to a scope; this answers whether that scope is still the one those reports
 * compose to. A drift means the record and its evidence disagree — which is the question an auditor
 * actually asks, and which `verifyTombstoneHashes` alone cannot answer, because it only proves the
 * record is internally consistent with whatever it was given.
 *
 * On a **v3** record it also compares the obligations, and that closes a hole the scope comparison
 * structurally cannot see (ADR-0331). A retention-bearing attestation contributes *nothing* to a
 * `DeletionScope` — by design, since the figures describe only what was destroyed — so deleting one
 * from the stored `attestations` column left the recomposed scope identical, the record's own digests
 * untouched, and both detectors satisfied. The record's signed `retainedObligations` is the first
 * thing that disagrees with evidence missing a retention.
 *
 * The **prose is deliberately not compared**, here, even though v3 signs it. `retainedReason` is
 * rendered by `retainedReasonFor` in the attestations' own order, so comparing it would make a
 * mismatch depend on array ordering and on a wording choice; the digest already covers it exactly.
 * Two detectors, each asserting what it can assert without a false positive — and a false positive
 * here pages somebody at `sev1` (ADR-0324).
 */
export function tombstoneMatchesAttestations(
  record: TombstoneRecord,
  attestations: readonly DeletionAttestation[],
): boolean {
  const recomposed = DeletionScopeSchema.safeParse(composeDeletionScope(attestations));
  if (!recomposed.success) return false;
  if (
    JSON.stringify(canonicalScope(recomposed.data)) !== JSON.stringify(canonicalScope(record.scope))
  ) {
    return false;
  }
  if (!proofVersionCoversRetentionClaim(record.proofVersion)) return true;
  const claimed = record.retainedObligations;
  // Only reachable past `TombstoneRecordSchema`, which pairs the field with the version. A v3 record
  // with no obligations at all does not agree with any evidence, including none.
  if (claimed === undefined) return false;
  return (
    JSON.stringify([...new Set(claimed)].sort()) ===
    JSON.stringify([...retainedObligations(attestations)])
  );
}

function canonicalScope(scope: DeletionScope): Record<string, unknown> {
  return {
    schemas: [...scope.schemas].sort(),
    tables: [...scope.tables].sort(),
    objectStorageBuckets: [...scope.objectStorageBuckets].sort(),
    backupGenerations: [...scope.backupGenerations].sort(),
    searchIndexes: [...scope.searchIndexes].sort(),
    cacheKeys: [...scope.cacheKeys].sort(),
    rowCount: scope.rowCount,
    storageBytes: scope.storageBytes,
    fileCount: scope.fileCount,
  };
}

/** The empty scope, exported so a caller can show "nothing attested yet" without inventing one. */
export const EMPTY_DELETION_SCOPE: DeletionScope = Object.freeze(EMPTY_SCOPE);
