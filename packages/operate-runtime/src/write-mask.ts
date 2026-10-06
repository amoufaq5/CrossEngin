import {
  validateClassifiedWriteMask,
  type ClassifiedField,
  type EntityPermissions,
  type Principal,
  type RoleDefinition,
  type RoleName,
  type SensitiveFieldPolicy,
} from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel/manifest";
import { entityClassifiedFields, type DataClassification } from "@crossengin/types/meta-schema";

/**
 * Entity name → its classified fields, in `@crossengin/auth`'s `ClassifiedField`
 * shape. Built from `entityClassifiedFields`, which is the same source
 * `redactionSpecForEntity` reads, so what a role may *write* and what it may
 * *read* are derived from one declaration and cannot drift apart.
 *
 * Entities with no classified field are omitted; a caller reads `?? []` for
 * them, and the absence is not load-bearing — an explicit per-field `update`
 * grant on an unclassified field is still enforced, because {@link maskWrite}
 * takes its candidate set from the grants *and* the classifications rather than
 * from the classifications alone.
 */
export function buildClassifiedFieldIndex(
  manifest: Manifest,
): ReadonlyMap<string, readonly ClassifiedField[]> {
  const index = new Map<string, readonly ClassifiedField[]>();
  for (const entity of manifest.entities ?? []) {
    const classified = entityClassifiedFields(entity);
    if (classified.length === 0) continue;
    index.set(
      entity.name,
      classified.map((c) => ({ name: c.field, classification: c.classification })),
    );
  }
  return index;
}

export const WRITE_MASK_MODES = ["explicit_only", "classified"] as const;
export type WriteMaskMode = (typeof WRITE_MASK_MODES)[number];

export interface WriteMaskRefusal {
  readonly field: string;
  readonly classification?: DataClassification;
  /** Which rule refused: a declared grant, or the classification default. */
  readonly rule: "explicit_update_grant" | "classification_default";
}

/**
 * `validateClassifiedWriteMask` sets `rejectedField` on every refusal, but
 * `WriteMaskResult` types it optional, so this is the name used if a future
 * change there stops setting it. A refusal with no name is still a refusal:
 * resolving the gap by returning `null` would make a contract change in
 * `@crossengin/auth` silently disable field-level write authorization.
 */
const UNNAMED_REJECTED_FIELD = "(unnamed)";

export interface WriteMaskInput {
  readonly mode: WriteMaskMode;
  readonly principal: Principal;
  readonly entityPerms: EntityPermissions;
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly classifiedFields: readonly ClassifiedField[];
  /** The keys the **caller** wrote — never a server-filled default. */
  readonly writtenKeys: readonly string[];
  readonly policy?: SensitiveFieldPolicy;
}

/**
 * Refuses the first field the caller may not write, or null.
 *
 * Two modes, and the split is the decision rather than a configuration knob:
 *
 * - **`explicit_only`** (the default, always on) enforces *only* a per-field
 *   `update` grant the manifest actually declares. Across the seven packs that
 *   is 7 fields, every one somebody's deliberate restriction — notably
 *   `Citizen.national_id`, which `erp-government` declares `regulated` with
 *   `update: {roles: ["gov_admin"]}` and which a `case_worker` PATCH silently
 *   rewrote. It cannot make anything uncreatable, because a field with a
 *   declared grant has, by construction, a role that holds it. A declaration
 *   that does nothing is this repo's recurring defect; honouring one the
 *   manifest already carries needs no opt-in.
 *
 * - **`classified`** adds the classification default: a sensitive field with no
 *   `update` grant is writable only by a role privileged for its class. This is
 *   ADR-0329's symmetric rule — a role cannot write a class it may not read —
 *   and it is **opt-in** because the redaction policy has no producer in
 *   `apps/operate-server` today, so `policy` is `{}` and `privilegedForClass`
 *   answers false for everyone. 12 of the 46 sensitive fields in the packs are
 *   `required: true` with no `update` grant (`Patient.mrn`, `Lead.full_name`,
 *   `Opportunity.amount`, `Permit.fee_amount`, …), so switching the symmetric
 *   rule on against an empty policy makes `Employee`, `Lead`, `Opportunity`,
 *   `FixedAsset`, `Patient`, `Student` and `Permit` uncreatable by every role in
 *   every deployment. A mask that simply switched on is not shippable; a mode
 *   that says which half is in force is.
 */
export function maskWrite(input: WriteMaskInput): WriteMaskRefusal | null {
  const classificationOf = new Map<string, DataClassification | undefined>(
    input.classifiedFields.map((f) => [f.name, f.classification]),
  );
  const fieldPerms = input.entityPerms.fields;

  // Only a key that is classified, or that carries a declared `update` grant, can be refused by
  // either rule — so an ordinary field costs one map lookup and never reaches role resolution.
  const candidates: ClassifiedField[] = [];
  for (const key of input.writtenKeys) {
    const granted = fieldPerms?.[key]?.update !== undefined;
    const classification = classificationOf.get(key);
    if (!granted && classification === undefined) continue;
    // `explicit_only` is expressed by **stripping the classification**, not by a second
    // implementation of the explicit rule. That is exactly equivalent rather than a trick:
    // `validateClassifiedWriteMask` reads the explicit `update` grant without consulting
    // `classification` at all, and the first conjunct of its classification branch is
    // `field.classification !== undefined` — so an undefined classification skips that branch by
    // construction, and `defaultRedacts`/`privilegedForClass` are never called (a policy's
    // `redactByDefault` therefore cannot change this mode's answer either). One function owns the
    // explicit rule, so the two modes cannot disagree about it.
    candidates.push(
      input.mode === "explicit_only" || classification === undefined
        ? { name: key }
        : { name: key, classification },
    );
  }
  if (candidates.length === 0) return null;

  const result = validateClassifiedWriteMask(
    input.principal,
    input.entityPerms,
    input.roles,
    candidates,
    input.policy ?? {},
  );
  if (result.ok) return null;

  const field = result.rejectedField ?? UNNAMED_REJECTED_FIELD;
  // Which rule refused is re-derived from the same two inputs the rule itself read, in the same
  // order of precedence: an explicit grant wins, so a field that has one was refused by it.
  const rule =
    fieldPerms?.[field]?.update !== undefined
      ? ("explicit_update_grant" as const)
      : ("classification_default" as const);
  const classification = classificationOf.get(field);
  return {
    field,
    rule,
    ...(classification !== undefined ? { classification } : {}),
  };
}
