/**
 * Which of this manifest's declared `unique` fields this deployment will actually enforce.
 *
 * The declaration had **two** readers in the whole workspace and neither emitted anything:
 * `kernel`'s `ddl/diff.ts` reads it only to *throw* when it changes between two manifests, and
 * `operate-runtime`'s `ui-schema.ts` copies it onto the `UiSchema` — where `unique` occurs exactly
 * once in the whole `apps/operate-web` tree, as the type declaration in `lib/schema.ts`, and no
 * component reads it. So it was authored, validated, hashed into `manifestHash`, serialized to
 * every client and read by nobody at either end; not even a promise made to a browser, which would
 * at least have been something.
 *
 * Measured across the seven resolved packs: **45** distinct (entity, field) pairs declare it, of
 * which **2** are `phi`/`regulated` (`Patient.mrn`, `Citizen.national_id` — in different packs, so
 * no single deployment holds both) and **0** use the composite `{scope: [...]}` form.
 *
 * ## Why this module exists separately from the emitter
 *
 * `uniqueWithheldFor(plan)` in `@crossengin/operate-runtime-pg` answers the same question for a
 * table it is about to emit, and is exhaustive over what an `EntityTablePlan` can express — which
 * is `encrypted_at_rest` and nothing else. The deployment-level answer is strictly larger, because
 * **the two stores that enforce nothing have no plan to ask**: `--store pg` builds no entity tables
 * and `--store memory` builds no tables at all, so on those the emitter is never called and its
 * taxonomy has no producer. That is not a gap in it; it is where the question changes from *what
 * will this table carry* to *what will this deployment guarantee*.
 *
 * And the deployment-level answer is the one an operator needs, because it is the bigger number.
 * On `--store pg-columns` serving `erp-healthcare`, 33 of 34 declarations are enforced and one is
 * withheld. On `--store pg` serving `erp-core` — **the shipped compose default** — all 32 are
 * unenforceable, and nothing anywhere says so. A survey that only ever spoke about ciphertext
 * would have reported the small number on the deployment that is mostly right and printed nothing
 * at all on the deployment that is wholly wrong.
 *
 * ## Said either way, including when the figure is zero
 *
 * `boot-erasure-report.ts`' rule, for its reason: "we checked and found none" cannot be claimed
 * from the absence of a log line, and a line that appeared only when something was withheld would
 * print nothing on a manifest that declares no unique field — indistinguishable, in a boot log,
 * from a survey that did not run.
 *
 * This module decides nothing and emits no SQL. `emitUniqueIndexDdl` creates the indexes and
 * `uniqueWithheldFor` reports the per-table withholding; all that is here is the figure, the pairs
 * and the wording.
 */

import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { UniqueWithheldReason } from "@crossengin/operate-runtime-pg";
import { requiresEncryptionAtRest } from "@crossengin/types/meta-schema";

import type { StoreKind } from "./cli.js";

/**
 * How many pairs a withheld group names before it summarises the rest.
 *
 * `column-encryption.ts`' `nameFields` rule — the count is always exact even when the list is
 * truncated, because the number is what an operator compares between two boots. Eight rather than
 * that module's five because the list here is **per reason group** rather than per report, and a
 * `none_enforced` group holds every declaration the manifest makes: the point of the list is then
 * to show the *shape* of what is unprotected (document numbers, codes, external identifiers)
 * rather than to enumerate 32 of them, and five names is too few to show a shape.
 */
export const WITHHELD_FIELD_LIMIT = 8;

/**
 * Why a declared `unique` is not enforced, and the remedy for each.
 *
 * A total map, so a reason cannot be reported without a remedy beside it — and the remedy is in the
 * map rather than at the call site precisely because "a remedy that cannot work is worse than
 * none" (ADR-0334), and a sentence written where the line is formatted is a sentence that can drift
 * from the condition it claims to fix.
 */
export const UNIQUE_ENFORCEMENT_REASONS = {
  /**
   * The typed store holds this column as pgcrypto ciphertext, and `pgp_sym_encrypt` is
   * **non-deterministic**: two rows with the same plaintext encrypt to different bytes, so a UNIQUE
   * over them never fires. Emitting one anyway would be worse than emitting nothing, because an
   * operator reading `\d` would see a constraint that cannot do its job.
   *
   * The remedy is reclassification and **not** "serve it where the value is plaintext", which is
   * the obvious second half and is false: the only store that keeps a classified value as plaintext
   * is the document store, which withholds every unique for its own reason, so moving the field
   * there trades one withholding for another. There is no store in this repository that both
   * encrypts a column at rest and enforces uniqueness over it, and that is structural rather than
   * unbuilt — which is worth saying in the remedy, because it turns a reader's search for a
   * configuration into a choice between two guarantees.
   */
  encrypted_at_rest: {
    withheld:
      "the column holds pgcrypto ciphertext and pgp_sym_encrypt is non-deterministic, so a UNIQUE over it never fires",
    remedy:
      "reclassify the field below phi/regulated so it is stored as plaintext and gets an index;" +
      " no store here both encrypts a column at rest and enforces uniqueness over it, so this is a" +
      " choice between the two guarantees rather than a misconfiguration",
  },
  /**
   * The JSONB document store cannot carry the guarantee **at all** — blocked by shape, not by
   * ordering. Every entity's records share one catalogued table whose only UNIQUE is
   * `(tenant_id, entity, record_id)`; `PostgresEntityStore` has no `ensureSchema`, so there is no
   * DDL seam to hang an index on; and enforcing a *field* would need a partial unique expression
   * index per (entity, field) — `(tenant_id, (document->>'sku')) WHERE entity = 'Item'` — which
   * `META_TABLES` cannot declare, because the kernel catalog cannot know a manifest, and which
   * `kernel-pg`'s `diffSchema` would then report as an undeclared index on every drift check
   * forever.
   *
   * `pg-unreachable-stores.ts` keeps `prerequisite_of_unbuilt_surface` and
   * `contract_cannot_carry_the_surface` apart on exactly this distinction, on the stated grounds
   * that calling both "unwired" sends the next person to write the thing that cannot be written
   * honestly. This is the second kind.
   */
  document_store: {
    withheld:
      "the JSONB document store shares one table across every entity and has no DDL seam, so a" +
      " per-field UNIQUE cannot be declared there",
    remedy: "serve this manifest on --store pg-columns, which emits one unique index per field",
  },
  /**
   * `InMemoryEntityStore` is a `Map` keyed on the record id and nothing else: `create` assigns an
   * id and sets the entry, scanning no field of any record. So there is no mechanism, and there is
   * also nothing durable to corrupt — which is why this is the mildest of the three and still worth
   * saying out loud. A developer who tests against `--store memory` and finds that duplicates are
   * accepted will reach for the manifest rather than for the store, and the whole reason 45
   * declarations went unenforced for four phases is that nobody was told which layer owed the
   * guarantee.
   *
   * Its own member rather than sharing `document_store`'s: `memory` is not the document store, the
   * sentence would be false of it, and `boot-erasure-report.ts` refuses the same conflation for the
   * same reason — naming a schema for a deployment with no database invites a reader to believe
   * something is happening in it.
   */
  no_durable_store: {
    withheld:
      "--store memory keeps records in a Map keyed on the record id and scans no field, so nothing" +
      " checks a duplicate — and nothing is persisted, so no durable record is corrupted either",
    // The exposure is stated in `withheld` and deliberately not repeated here: the remedy is the
    // one clause an operator acts on, and the figure appended to it below has to be the last thing
    // on the line or it reads as qualifying the exposure instead of the store change.
    remedy: "serve on --store pg-columns for an enforced guarantee",
  },
} as const;

export type UniqueEnforcementReason = keyof typeof UNIQUE_ENFORCEMENT_REASONS;

/**
 * Every reason the emitter can report is a reason this module can explain.
 *
 * A **type**-level join rather than a runtime one, which is what keeps it honest in both
 * directions: the emitter gaining a third reason is a compile error here until it is given a
 * remedy, and a reason this module reports that the emitter never produces (`no_durable_store`,
 * which no `EntityTablePlan` can express) is still legal. Written as `extends` and not as a
 * `Record<UniqueWithheldReason, UniqueEnforcementReason>` because that form additionally breaks
 * whenever this package's `dist` is a build behind `operate-runtime-pg`'s source — the exact
 * conditional green ADR-0307 and ADR-0329 are about — and the property worth fencing is coverage,
 * not a one-to-one correspondence.
 *
 * The sentences are deliberately *not* imported from `UNIQUE_WITHHELD_REASONS`. They answer
 * different readers: the emitter's explains why a statement is not in the DDL, and this one has to
 * name an action a person running the server can take.
 */
type EmitterReasonsAreExplained = UniqueWithheldReason extends UniqueEnforcementReason
  ? true
  : never;
const _emitterReasonsAreExplained: EmitterReasonsAreExplained = true;
// `noUnusedLocals` is on, so the discard is what keeps the assertion in the file rather than a
// style choice: without it the fence itself fails the build and the obvious fix is to delete it.
void _emitterReasonsAreExplained;

/**
 * What each store does with a declared `unique`.
 *
 * Keyed off `StoreKind` — `cli.ts`' own union, so there is one spelling of it and a fourth store is
 * a compile error here rather than a kind inheriting whichever branch a chain ended on. A **blanket
 * reason** is a property of the store and applies to every declaration whatever the field;
 * `encrypted_at_rest` is the other kind, a property of a field *given* a store, and the two are
 * never both in play — a store that enforces nothing has nothing to withhold for a second reason.
 *
 * `null` means this store enforces, and it is the only field saying so: an `enforces: boolean`
 * beside the reason would be two fields that must agree, and this repo has spent several increments
 * on pairs that could be stated inconsistently.
 */
const STORE_ENFORCEMENT: Readonly<
  Record<StoreKind, { readonly blanketReason: UniqueEnforcementReason | null; readonly mechanism: string }>
> = {
  memory: {
    blanketReason: "no_durable_store",
    mechanism: "records live in a process-local Map keyed on the record id",
  },
  pg: {
    blanketReason: "document_store",
    mechanism: "records are JSONB rows in one shared catalogued table",
  },
  "pg-columns": {
    blanketReason: null,
    // `(tenant_id, …)` and never `(col)` alone is why this could not be an inline `UNIQUE` copied
    // from the field: these tables carry a `(tenant_id, id)` primary key, so a bare `UNIQUE (col)`
    // would make one tenant's `employee_number` collide with another's. The guarantee a pack means
    // by `unique: true` is uniqueness *within* a tenant.
    mechanism:
      "one unique index per field on (tenant_id, …any declared scope, column), so the guarantee is" +
      " uniqueness within a tenant and never across tenants",
  },
};

/** The store kinds this survey answers for, as the total map's own keys. */
export const UNIQUE_SURVEY_STORE_KINDS: readonly StoreKind[] = Object.keys(
  STORE_ENFORCEMENT,
) as StoreKind[];

/** One field whose declared uniqueness this deployment will not enforce, and why. */
export interface WithheldUniqueField {
  readonly entity: string;
  readonly field: string;
  readonly reason: UniqueEnforcementReason;
  /**
   * The columns the declaration says the field is unique *within*: `[]` for tenant-wide, and
   * `["department_id"]` for `unique: {scope: ["department_id"]}`.
   *
   * Carried because reading it is the only thing that proves both forms of `UniqueHintSchema` were
   * read. `field.unique === true` would drop the composite form silently, which is this increment's
   * own class inside its own survey; measured, 0 of the 47 source declarations use it, so the cost
   * of reading it is nothing and the cost of not reading it is a future quiet miss.
   */
  readonly scope: readonly string[];
}

export const UNIQUE_ENFORCEMENT_VERDICTS = [
  /** The manifest declares no unique field, so there is no guarantee to enforce or withhold. */
  "no_declarations",
  /** Every declaration gets an index. */
  "all_enforced",
  /** Some are enforced and at least one is withheld — `pg-columns` with a classified unique field. */
  "partly_enforced",
  /** Declarations exist and this store enforces none of them. The headline for `pg` and `memory`. */
  "none_enforced",
] as const;
export type UniqueEnforcementVerdict = (typeof UNIQUE_ENFORCEMENT_VERDICTS)[number];

/**
 * Whether each verdict permits a boot. `LIST_SURFACE_MAY_SERVE`'s shape, and **every member is
 * `true`**: this survey reports and never refuses.
 *
 * ## The argument, measured rather than asserted
 *
 * ADR-0338 refuses PHI-without-encryption on the grounds that *nothing served PHI correctly today,
 * so the refusal breaks nothing that worked*, while ADR-0334 made `--tenant-status-gate` opt-in
 * because on-by-default would refuse a deployment that works. The first premise holds here —
 * **zero** unique constraints exist on any of the 54 tables and none ever has — so "breaks nothing
 * that worked" is satisfied and the safe default is in principle available. Two measurements take
 * it away again, and the second is the deciding one.
 *
 * **The remedy cannot work.** The declarations are in *builtin packs*. On `--store pg` serving
 * `erp-core`, which is the shipped compose default, 32 of 32 are unenforceable and an operator
 * cannot clear that by editing anything they own: they would have to edit `pack-erp-core` in this
 * repository, or migrate the deployment to `pg-columns`, which is a data migration and not a flag.
 * A refusal whose remedy is "change the product" refuses the shipped default with no action
 * available, and "a remedy that cannot work is worse than none" (ADR-0334) — the same reason
 * `list-surface-survey.ts` reports where ADR-0338 refuses.
 *
 * **And the degradation is permissive, not a wrong answer.** This is the sharper half and the real
 * distinction from ADR-0338. A plaintext PHI column is *incoherent*: the manifest says the value is
 * protected and it is not. An unenforced `unique` is a **missing constraint**: every read returns
 * the right rows, every write stores what it was given, and the only consequence is that a
 * duplicate can be created. ADR-0359 drew exactly this line one increment ago —
 * *a surface whose drop changes WHICH rows come back is refused; one whose drop changes only their
 * ORDER is reported* — and an absent unique index changes neither which rows come back nor their
 * order. It changes which rows can be *created*, and in the admitting direction, which is the
 * reporting side of this repo's own rule.
 *
 * So: reported, and `uniqueEnforcementIsSuspect` earns a `warn` wherever anything is withheld.
 */
export const UNIQUE_ENFORCEMENT_MAY_SERVE: Readonly<Record<UniqueEnforcementVerdict, true>> = {
  no_declarations: true,
  all_enforced: true,
  partly_enforced: true,
  none_enforced: true,
};

export interface UniqueEnforcementReport {
  readonly verdict: UniqueEnforcementVerdict;
  readonly storeKind: StoreKind;
  /** Every (entity, field) pair declaring a unique, whether or not it is enforced. */
  readonly declaredCount: number;
  /** How many of those this store will enforce. `declaredCount - withheld.length`. */
  readonly enforcedCount: number;
  readonly withheld: readonly WithheldUniqueField[];
  /**
   * How many of the same declarations `--store pg-columns` would enforce.
   *
   * It exists so the remedy printed for the two blanket reasons is **checked rather than claimed**:
   * on `erp-core` it is 32 of 32 and on `erp-healthcare` 33 of 34, because a classified field moves
   * from one withholding to the other rather than becoming enforced. Advising a store change
   * without that figure would be advising it for `Patient.mrn` too, where it buys nothing.
   */
  readonly enforceableOnColumnStore: number;
  readonly mayServe: boolean;
}

/**
 * The columns a field's `unique` hint says it is unique within, or `null` for a field declaring
 * none.
 *
 * Both forms of `UniqueHintSchema`, which is `boolean | {scope: string[]}` and has been since it
 * was written. `unique: false` is legal and means *not unique*, so it must answer `null` and not
 * `[]` — counting it as a declaration would inflate every figure here with fields nobody claimed a
 * guarantee for. Measured: 0 occurrences of the scoped form and 0 of `false` across the seven
 * packs, so today this function has exactly one live branch and is written for the other three
 * because the alternative is a silent miscount the first time one appears.
 */
function declaredScope(unique: boolean | { readonly scope: readonly string[] } | undefined):
  | readonly string[]
  | null {
  if (unique === undefined || unique === false) return null;
  if (unique === true) return [];
  return unique.scope;
}

/**
 * Surveys every declared `unique` against what the chosen store will enforce.
 *
 * Through `resolvedFields` and **not** `entity.fields`, because a unique field can arrive from a
 * trait and would then be a real column on the served table that the emitter indexes and this
 * survey never saw — one surface resolving traits while another reads the raw list is a live defect
 * class in this repo. No builtin trait declares `unique` today, so the live members all come from
 * the entities themselves; a custom trait or an activated per-tenant manifest can declare one, and
 * that is the case this reading exists for.
 *
 * `requiresEncryptionAtRest` is **called, not restated**: the set lives in
 * `ENCRYPT_AT_REST_DATA_CLASSIFICATIONS`, `column-plan.ts` derives the column's `encryptAtRest`
 * from the same predicate, and a second copy here would diverge silently in the direction that
 * claims an index exists over ciphertext.
 */
export function surveyUniqueEnforcement(
  manifest: Manifest,
  storeKind: StoreKind,
): UniqueEnforcementReport {
  const blanketReason = STORE_ENFORCEMENT[storeKind].blanketReason;
  const traits = manifest.traits ?? [];
  const withheld: WithheldUniqueField[] = [];
  let declaredCount = 0;
  let encryptedCount = 0;

  for (const entity of manifest.entities ?? []) {
    for (const field of resolvedFields(entity, traits)) {
      const scope = declaredScope(field.unique);
      if (scope === null) continue;
      declaredCount += 1;
      const classification = field.classification;
      const encrypted = classification !== undefined && requiresEncryptionAtRest(classification);
      if (encrypted) encryptedCount += 1;
      // The blanket reason wins where it applies, and it has to: on `pg` a classified field is
      // stored as plaintext, so reporting it under `encrypted_at_rest` would name a condition that
      // is not true of that deployment and a remedy — reclassify — that would change nothing.
      const reason = blanketReason ?? (encrypted ? "encrypted_at_rest" : null);
      if (reason !== null) withheld.push({ entity: entity.name, field: field.name, reason, scope });
    }
  }

  const enforcedCount = declaredCount - withheld.length;
  const verdict = decideVerdict(declaredCount, enforcedCount);
  return {
    verdict,
    storeKind,
    declaredCount,
    enforcedCount,
    withheld,
    enforceableOnColumnStore: declaredCount - encryptedCount,
    mayServe: UNIQUE_ENFORCEMENT_MAY_SERVE[verdict],
  };
}

/**
 * The verdict is the **worst** fact in hand, so `none_enforced` is tested before `partly_enforced`:
 * a deployment enforcing nothing and one enforcing most of its declarations want different first
 * sentences, and reporting the milder when both could be read would understate the headline.
 */
function decideVerdict(declaredCount: number, enforcedCount: number): UniqueEnforcementVerdict {
  if (declaredCount === 0) return "no_declarations";
  if (enforcedCount === declaredCount) return "all_enforced";
  if (enforcedCount === 0) return "none_enforced";
  return "partly_enforced";
}

/**
 * True when this report deserves a `warn` rather than an `info`: anything at all is withheld.
 *
 * Reads the same list the verdict is computed from, so the level an operator sees and the verdict
 * they read cannot disagree about one deployment — `bootErasureCoverageIsSuspect`' stated reason
 * for sharing its predicates with the arm above it.
 *
 * `no_declarations` and `all_enforced` both have an empty list and are both `info`, which is right
 * for two different reasons: the first has nothing to protect and the second protects everything.
 */
export function uniqueEnforcementIsSuspect(report: UniqueEnforcementReport): boolean {
  return report.withheld.length > 0;
}

/** `Entity.field`, or `Entity.field within (a, b)` where a scope is declared. */
function nameField(f: WithheldUniqueField): string {
  return f.scope.length === 0
    ? `${f.entity}.${f.field}`
    : `${f.entity}.${f.field} within (${f.scope.join(", ")})`;
}

/**
 * `A.b, C.d (+N more)` — names only, bounded, with the count always exact.
 *
 * A field *name* is in the manifest and is not a disclosure; a field **value** would be, and none
 * reaches this module — `WithheldUniqueField` has nowhere to put one.
 */
function nameFields(fields: readonly WithheldUniqueField[]): string {
  const shown = fields.slice(0, WITHHELD_FIELD_LIMIT).map(nameField);
  const hidden = fields.length - shown.length;
  return `${shown.join(", ")}${hidden > 0 ? ` (+${hidden.toString()} more)` : ""}`;
}

/**
 * The boot line, affirmative in both directions.
 *
 * Grouped by reason in the declaration order of `UNIQUE_ENFORCEMENT_REASONS`, so the output is
 * stable across boots and diffable between two manifests, and so each remedy is printed once
 * beside the fields it applies to rather than once per field.
 */
export function formatUniqueEnforcementReport(report: UniqueEnforcementReport): string {
  const store = `--store ${report.storeKind}`;
  if (report.verdict === "no_declarations") {
    return (
      `[unique] declared unique fields: none on ${store} — this manifest declares no unique field,` +
      ` so there is no guarantee to enforce or to withhold`
    );
  }
  const counts = `${report.enforcedCount.toString()} of ${report.declaredCount.toString()} enforced`;
  if (report.verdict === "all_enforced") {
    return (
      `[unique] declared unique fields: ${counts} on ${store} — ` +
      STORE_ENFORCEMENT[report.storeKind].mechanism
    );
  }

  const lines = [`[unique] declared unique fields: ${counts} on ${store}`];
  for (const reason of Object.keys(UNIQUE_ENFORCEMENT_REASONS) as UniqueEnforcementReason[]) {
    const group = report.withheld.filter((f) => f.reason === reason);
    if (group.length === 0) continue;
    const { withheld, remedy } = UNIQUE_ENFORCEMENT_REASONS[reason];
    lines.push(`  ${group.length.toString()} withheld (${reason}): ${withheld}`);
    lines.push(`    ${nameFields(group)}`);
    // The figure makes the store-change remedy checkable rather than aspirational: on a manifest
    // whose only withheld field is classified it is the same number that is withheld now, which is
    // the case where advising a different store would buy nothing.
    const checked =
      reason === "encrypted_at_rest"
        ? remedy
        : `${remedy}; measured on this manifest, that would enforce ` +
          `${report.enforceableOnColumnStore.toString()} of these ${report.declaredCount.toString()}`;
    lines.push(`    remedy: ${checked}`);
  }
  return lines.join("\n");
}
