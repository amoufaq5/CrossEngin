import {
  fieldWriteGrant,
  fieldWriteGrantArm,
  validateClassifiedWriteMask,
  type AbacEvaluator,
  type AbacOutcome,
  type ClassifiedField,
  type EntityPermissions,
  type FieldWriteOperation,
  type Principal,
  type RoleDefinition,
  type RoleName,
  type SensitiveFieldPolicy,
} from "@crossengin/auth";
import { resolvedClassifiedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { DataClassification } from "@crossengin/types/meta-schema";

/**
 * Entity name → its classified fields, in `@crossengin/auth`'s `ClassifiedField`
 * shape, resolved **as the served table has them**: a classification a trait
 * contributes is a real column and is in the index.
 *
 * Built from `resolvedClassifiedFields`, and `compileOperateServer` hands *this
 * index* to the response-redaction registry as `classifiedFieldsForEntity`, so
 * what a role may write and what it may read are not merely derived alike — they
 * read one object. This comment used to claim that invariant over
 * `entityClassifiedFields`, and it was true and worthless: the read half resolved
 * nothing either, so the two agreed *in being wrong* — a trait-contributed `phi`
 * field was writable by anybody holding the entity's write grant while two other
 * surfaces reported it as classified. **Two readers agreeing is not either being
 * right when they share the narrowing**, which is why the agreement is now a
 * shared index rather than a shared habit.
 *
 * Entities with no classified field are omitted; a caller reads `?? []` for
 * them, and the absence is not load-bearing — an explicit per-field write grant
 * on an unclassified field is still enforced, because {@link maskWrite} takes its
 * candidate set from the grants *and* the classifications rather than from the
 * classifications alone.
 */
export function buildClassifiedFieldIndex(
  manifest: Manifest,
): ReadonlyMap<string, readonly ClassifiedField[]> {
  const index = new Map<string, readonly ClassifiedField[]>();
  const traits = manifest.traits ?? [];
  for (const entity of manifest.entities ?? []) {
    const classified = resolvedClassifiedFields(entity, traits);
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
  /**
   * Which rule refused. A third member rather than a flag on the other two, because an operator
   * acts on each differently: `explicit_update_grant` means the manifest named roles and this is
   * not one of them (fix the grant or the caller's role), `classification_default` means no grant
   * exists and the class is privileged (declare a grant or a privileged role), and
   * `abac_obligation` means the role *was* granted and a declared attribute policy was not
   * discharged — which on an `undischargeable` outcome is a deployment gap and not a permission.
   *
   * `explicit_create_grant` is the fourth on that same argument: its remedy is to widen the
   * field's `create` list — or to **delete** that list, so the field inherits `update` — which is
   * a different edit from widening `update`, and not one an operator told `explicit_update_grant`
   * would ever make. A fourth member and not a rename of the third, because a member is additive
   * on the wire where a rename is not.
   *
   * Which of the two the refusal names comes from {@link fieldWriteGrantArm}, the arm
   * `fieldWriteGrant` actually took, and never from `input.writeOp`: an **inherited** create (no
   * `create` key, falling back to `update`) refuses as `explicit_update_grant`, because the update
   * grant genuinely is what decided and widening `create` would not clear it.
   */
  readonly rule:
    | "explicit_create_grant"
    | "explicit_update_grant"
    | "classification_default"
    | "abac_obligation";
  /** The grant's opaque policy key, set iff `rule === "abac_obligation"`. */
  readonly abacPolicyKey?: string;
  /**
   * Which of the three refusing outcomes: `denied` (the attributes did not match),
   * `undischargeable` (no evaluator could answer) and `deferred` (the policy needs the stored
   * record and this call site had none). The third is the only one a caller can act on — an update
   * re-asks it inside the transaction with `before` supplied — and on a create it is **final**,
   * because the record the policy is about does not exist until the write commits.
   */
  readonly abacOutcome?: AbacOutcome;
}

/**
 * Which write arm refused → the rule that names it.
 *
 * A total map over `FIELD_WRITE_OPERATIONS` and not a ternary, so a third arm on
 * `FieldPermission` is a compile error at the one place that turns an arm into a label, rather
 * than a third refusal silently carrying one of these two names.
 */
const GRANT_ARM_RULE: Record<
  FieldWriteOperation,
  "explicit_create_grant" | "explicit_update_grant"
> = {
  create: "explicit_create_grant",
  update: "explicit_update_grant",
};

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
  /**
   * The entity this mask is for. Required rather than optional, and it exists only because
   * `AbacEnforcement.entity` is: an evaluator is consulted only when the entity is named, so an
   * optional field would make a caller that forgot it refuse every obligated field in a correctly
   * configured deployment. The compiler asks instead.
   */
  readonly entity: string;
  readonly principal: Principal;
  readonly entityPerms: EntityPermissions;
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly classifiedFields: readonly ClassifiedField[];
  /** The keys the **caller** wrote — never a server-filled default. */
  readonly writtenKeys: readonly string[];
  /**
   * Which write moment this is, so a field's `create` grant is read on a create and `update` on an
   * update. Required, for `entity`'s reason: `validateClassifiedWriteMask` defaults it to `update`
   * and fails closed, but a *handler* that forgot it would refuse a create its manifest permits,
   * and the compiler can ask here where it cannot there.
   */
  readonly writeOp: FieldWriteOperation;
  readonly policy?: SensitiveFieldPolicy;
  /**
   * Discharges an `abac` policy key carried by a per-field `update` grant. Absent means no
   * evaluator is configured, which `validateClassifiedWriteMask` resolves `undischargeable` —
   * a refusal, because an obligation nothing can answer is the "fail closed" case and granting
   * on it is the defect this seam exists to close.
   */
  readonly abacEvaluator?: AbacEvaluator;
  /**
   * The stored record the write lands on, when the caller has it. Absent means the call site had
   * none — not that the record is empty — and a per-field `update` grant whose policy needs one
   * then answers `deferred`, which refuses. A create has no record and never will.
   */
  readonly record?: Readonly<Record<string, unknown>>;
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
 *
 * An **ABAC obligation is refused in both modes**, and that is not a third mode.
 * An obligation rides on the per-field `update` grant, so the field reaching the
 * explicit rule is exactly the field that can carry one — and ADR-0339 made the
 * explicit grant authoritative and enforced always, with no flag. Gating the
 * obligation on `classified` would make that grant enforced as to *roles* and
 * silently unconditional as to *attributes*, which is the shape of the defect
 * this whole seam exists to close.
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
    // The **effective** grant for this write moment, not `update` unconditionally: a field whose
    // only declared arm is `create` carries no `update`, so reading that key would drop it from the
    // candidate list on a create and skip the one grant that applies to it.
    const granted = fieldWriteGrant(fieldPerms?.[key], input.writeOp) !== undefined;
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
    // Passed even with no evaluator. Omitting it answers `undischargeable` just the same, so
    // either way fails closed, but naming the entity is what lets the refusal say which policy on
    // which record was not discharged.
    // The record is spread conditionally rather than passed as `input.record`, because
    // `AbacEnforcement.record` draws the same distinction `AbacEvaluationInput` does: an absent key
    // means the caller had none, and an explicit `undefined` would be a third state nothing reads.
    {
      entity: input.entity,
      ...(input.abacEvaluator !== undefined ? { evaluator: input.abacEvaluator } : {}),
      ...(input.record !== undefined ? { record: input.record } : {}),
    },
    input.writeOp,
  );
  if (result.ok) return null;

  const field = result.rejectedField ?? UNNAMED_REJECTED_FIELD;
  const classification = classificationOf.get(field);
  // An undischarged obligation is reported as itself and never re-derived from the grant: the role
  // *passed* the role check, so reporting `explicit_update_grant` would send an operator to widen a
  // grant that already names them and leave the real cause — an evaluator this deployment does not
  // have — unnamed.
  if (result.abac !== undefined) {
    return {
      field,
      rule: "abac_obligation",
      abacPolicyKey: result.abac.policyKey,
      abacOutcome: result.abac.outcome,
      ...(classification !== undefined ? { classification } : {}),
    };
  }
  // Which rule refused is read from the **arm** the decision itself took, through the same
  // function: this derivation used to read `perm.update` while the rule read
  // `fieldWriteGrant(perm, writeOp)`, so a create refused by a field's own `create` arm reported
  // the *update* grant — sending an operator to widen a list that already named them. The same
  // mistake an undischarged obligation is reported as itself to avoid, one branch up.
  const arm = fieldWriteGrantArm(fieldPerms?.[field], input.writeOp);
  const rule: WriteMaskRefusal["rule"] =
    arm === undefined ? "classification_default" : GRANT_ARM_RULE[arm];
  return {
    field,
    rule,
    ...(classification !== undefined ? { classification } : {}),
  };
}
