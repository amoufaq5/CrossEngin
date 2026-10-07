import {
  isSensitiveDataClass,
  type DataClassification,
} from "@crossengin/types/meta-schema";
import {
  ABAC_OUTCOME_ALLOWS,
  dischargeAbac,
  dischargeAbacBatch,
  isAbacDeferred,
} from "./abac.js";
import type { AbacBatchRequest, AbacEnforcement, AbacEvaluationInput } from "./abac.js";
import { resolveEffectiveRoles } from "./roles.js";
import { fieldWriteGrant } from "./types.js";
import type {
  AbacDischarge,
  EntityPermissions,
  FieldRedactionResult,
  FieldWriteOperation,
  OperationName,
  Principal,
  RoleDefinition,
  RoleName,
  WriteMaskResult,
} from "./types.js";

/**
 * The one spelling of a field-level evaluation input, so the per-field discharge and the batch
 * planner cannot build different questions about the same grant. Two spellings here would let the
 * single-record and the per-record read paths disagree about one field policy, which is the shape
 * ADR-0339 found between the read and write halves of `privilegedForClass`.
 */
function fieldEvaluationContext(
  principal: Principal,
  operation: OperationName,
  field: string,
  abac: Pick<AbacEnforcement, "entity">,
  record: Readonly<Record<string, unknown>> | undefined,
): Omit<AbacEvaluationInput, "policyKey"> {
  return {
    principal,
    entity: abac.entity,
    operation,
    field,
    ...(record !== undefined ? { record } : {}),
  };
}

/**
 * The one spelling of a field-level grant's obligation for the three functions here that ask one
 * question at a time. The classified read path pools its questions instead and goes through
 * `planClassifiedRead`, which is why both build their evaluation input through the one
 * {@link fieldEvaluationContext}.
 *
 * An **omitted** `abac` parameter is a caller that has no evaluator — not a way to skip the
 * obligation — so it answers `undischargeable`, identically to a named entity with no evaluator.
 * Reading it the other way would reproduce the defect this closes, one parameter over. It
 * short-circuits before `dischargeAbac` because `AbacEvaluationInput.entity` is required and this
 * caller has no entity to name; no evaluator is consulted on that path either way.
 *
 * An **absent** `abac.record` is not a skip either: a record-bearing policy answers `deferred`,
 * which `obligationAdmits` refuses through the same total map. So the two ways a caller can be
 * under-equipped — no evaluator, no record — both land on a refusal rather than a pass-through,
 * through two different outcomes that name two different remedies.
 */
function dischargeFieldObligation(
  policyKey: string | undefined,
  principal: Principal,
  operation: OperationName,
  field: string,
  abac: AbacEnforcement | undefined,
): AbacDischarge | null {
  if (policyKey === undefined) return null;
  if (abac === undefined) return { policyKey, outcome: "undischargeable" };
  return dischargeAbac(
    policyKey,
    fieldEvaluationContext(principal, operation, field, abac, abac.record),
    abac.evaluator,
  );
}

function obligationAdmits(discharge: AbacDischarge | null): boolean {
  return discharge === null || ABAC_OUTCOME_ALLOWS[discharge.outcome];
}

/**
 * Classification-unaware read redaction, superseded by {@link computeClassifiedFieldRedaction}.
 *
 * It takes no batch arm deliberately: it is callerless, so an arm here would equip dead code and
 * leave the two read paths with different costs for the same policy.
 */
export function computeFieldRedaction(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  fieldNames: readonly string[],
  abac?: AbacEnforcement,
): FieldRedactionResult {
  const effective = resolveEffectiveRoles(principal, roles);
  const fields = entityPerms.fields;
  const readable: string[] = [];
  const redacted: string[] = [];
  const deferred: string[] = [];

  for (const name of fieldNames) {
    const rule = fields?.[name]?.read;
    if (rule === undefined) {
      readable.push(name);
      continue;
    }
    if (!rule.roles.some((r) => effective.has(r))) {
      redacted.push(name);
      continue;
    }
    // Only after the roles check passes: there is nothing to learn from an evaluation that a
    // redaction was already owed.
    const discharge = dischargeFieldObligation(rule.abac, principal, "read", name, abac);
    if (obligationAdmits(discharge)) readable.push(name);
    else {
      redacted.push(name);
      // Reported from inside this arm, so only a field the roles admitted can ever be deferred:
      // the roles refusal above returns before a discharge exists, which is what keeps `deferred`
      // answering "a record could change this" rather than "something refused this".
      if (isAbacDeferred(discharge)) deferred.push(name);
    }
  }

  return { readable, redacted, deferred };
}

/**
 * Classification-unaware write mask, superseded by {@link validateClassifiedWriteMask}.
 *
 * It takes no batch arm, and that is a rule rather than an omission: first refusal wins, so a batch
 * would have to evaluate the fields *past* the rejection — more work, and it would hand the
 * deployment's policy layer questions whose answers are never needed. Same reason `rbacCheck`
 * consults the evaluator only after the role check passes (ADR-0340).
 */
export function validateWriteMask(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  patchFields: readonly string[],
  abac?: AbacEnforcement,
): WriteMaskResult {
  const effective = resolveEffectiveRoles(principal, roles);
  const fields = entityPerms.fields;

  for (const name of patchFields) {
    const rule = fields?.[name]?.update;
    if (rule === undefined) continue;
    if (!rule.roles.some((r) => effective.has(r))) {
      return { ok: false, rejectedField: name };
    }
    const discharge = dischargeFieldObligation(rule.abac, principal, "update", name, abac);
    if (discharge !== null && !ABAC_OUTCOME_ALLOWS[discharge.outcome]) {
      return { ok: false, rejectedField: name, abac: discharge };
    }
  }

  return { ok: true };
}

export interface ClassifiedField {
  readonly name: string;
  readonly classification?: DataClassification;
}

export interface SensitiveFieldPolicy {
  /**
   * Roles privileged for **every** sensitive class. Its meaning is unchanged, deliberately: a
   * deployment that grants `--audit-read-sensitive-role` today reads pii *and* phi, and narrowing
   * this field would silently revoke access it already has.
   */
  readonly privilegedRoles?: readonly RoleName[];
  /**
   * Per-class grants, which `privilegedRoles` cannot express (ADR-0329).
   *
   * The gap: a support role that should read a customer's `pii` and never a patient's `phi` had no
   * way to say so — the grant was wholesale, so a deployment either exposed every class to that role
   * or redacted every class from it, and the second is what a HIPAA deployment is forced into.
   *
   * **A class with an entry here is authoritative for that class**, and `privilegedRoles` applies
   * only to classes with no entry. That is what makes the narrowing possible at all: read as a union
   * instead, a wholesale grantee could never be withheld from `phi`, which is the whole point. So
   * `{phi: []}` withholds phi from everyone including a wholesale grantee, and an empty array is a
   * refusal rather than "fall through" — the fail-closed reading of an explicit empty list.
   */
  readonly privilegedRolesByClass?: Readonly<
    Partial<Record<DataClassification, readonly RoleName[]>>
  >;
  readonly redactByDefault?: (classification: DataClassification) => boolean;
}

/**
 * Whether the principal's effective roles may read a value of this class.
 *
 * One function, two callers (read redaction and the write mask), so the per-class rule cannot
 * diverge between what a role may see and what it may change.
 */
function privilegedForClass(
  policy: SensitiveFieldPolicy,
  effective: ReadonlySet<RoleName>,
  classification: DataClassification,
): boolean {
  const perClass = policy.privilegedRolesByClass?.[classification];
  const granted = perClass ?? policy.privilegedRoles ?? [];
  return granted.some((r) => effective.has(r));
}

function defaultRedacts(policy: SensitiveFieldPolicy, c: DataClassification): boolean {
  return policy.redactByDefault !== undefined
    ? policy.redactByDefault(c)
    : isSensitiveDataClass(c);
}

/**
 * What the planner decided about one field without having asked an evaluator anything.
 *
 * `obligated` carries the *position* of its question in the shared request array rather than the
 * question itself, which is what lets one batch span several records: every planned field across
 * every record points into one pool, and the assembler reads its answer back by that position.
 */
type FieldVerdict =
  | { readonly kind: "readable" }
  | { readonly kind: "redacted" }
  | { readonly kind: "obligated"; readonly request: number };

interface PlannedField {
  readonly name: string;
  readonly verdict: FieldVerdict;
}

/**
 * Decide every field for one record, appending each obligation to the shared `requests` pool.
 *
 * The ordered single pass is what makes three properties readable rather than merely tested: the
 * three output arrays are filled from this list in field order, and `deferred` is pushed from inside
 * the redacted arm, so it is a **subsequence** of `redacted` and not merely a subset. A field
 * refused on roles returns before any request is appended, so it can never reach the evaluator and
 * can never appear in `deferred`; the classification default carries no obligation and so cannot
 * either.
 */
function planClassifiedRead(
  principal: Principal,
  effective: ReadonlySet<RoleName>,
  entityPerms: EntityPermissions,
  fields: readonly ClassifiedField[],
  policy: SensitiveFieldPolicy,
  abac: Omit<AbacEnforcement, "record"> | undefined,
  record: Readonly<Record<string, unknown>> | undefined,
  requests: AbacBatchRequest[],
): readonly PlannedField[] {
  const fieldPerms = entityPerms.fields;
  const planned: PlannedField[] = [];

  for (const field of fields) {
    const rule = fieldPerms?.[field.name]?.read;
    if (rule !== undefined) {
      // Before anything else, and before an obligation is even recorded: there is nothing to learn
      // from an evaluation a redaction was already owed, and asking would hand the deployment's
      // policy layer a principal it has no business seeing (ADR-0340).
      if (!rule.roles.some((r) => effective.has(r))) {
        planned.push({ name: field.name, verdict: { kind: "redacted" } });
        continue;
      }
      if (rule.abac === undefined) {
        planned.push({ name: field.name, verdict: { kind: "readable" } });
        continue;
      }
      // An omitted `abac` parameter is a caller with no evaluator, not a way to skip the obligation
      // — and it cannot even be asked, because `AbacEvaluationInput.entity` is required and this
      // caller has no entity to name. Redacted and **not** deferred: a record would not help.
      if (abac === undefined) {
        planned.push({ name: field.name, verdict: { kind: "redacted" } });
        continue;
      }
      const request = requests.length;
      requests.push({
        policyKey: rule.abac,
        context: fieldEvaluationContext(principal, "read", field.name, abac, record),
      });
      planned.push({ name: field.name, verdict: { kind: "obligated", request } });
      continue;
    }
    if (field.classification !== undefined && defaultRedacts(policy, field.classification)) {
      // Asked per class, not once per principal: a role may be privileged for `pii` and not for
      // `phi`, and a single `hasPrivilege` computed outside the loop could not express that.
      //
      // This arm never contributes to `deferred`: a classification default is answered
      // from roles alone and carries no obligation, so no record could overturn it.
      const verdict: FieldVerdict = privilegedForClass(policy, effective, field.classification)
        ? { kind: "readable" }
        : { kind: "redacted" };
      planned.push({ name: field.name, verdict });
      continue;
    }
    planned.push({ name: field.name, verdict: { kind: "readable" } });
  }

  return planned;
}

/**
 * Fill the three arrays from one record's plan and the pooled discharges.
 *
 * A discharge the plan's index does not reach **redacts**, even though both come from the same
 * array: fail closed is the direction a reader of this function should not have to reason about.
 */
function assembleRedaction(
  planned: readonly PlannedField[],
  discharges: readonly AbacDischarge[],
): FieldRedactionResult {
  const readable: string[] = [];
  const redacted: string[] = [];
  const deferred: string[] = [];

  for (const { name, verdict } of planned) {
    if (verdict.kind === "readable") {
      readable.push(name);
      continue;
    }
    if (verdict.kind === "redacted") {
      redacted.push(name);
      continue;
    }
    const discharge = discharges[verdict.request];
    if (discharge !== undefined && ABAC_OUTCOME_ALLOWS[discharge.outcome]) {
      readable.push(name);
      continue;
    }
    redacted.push(name);
    if (isAbacDeferred(discharge)) deferred.push(name);
  }

  return { readable, redacted, deferred };
}

/**
 * Like {@link computeFieldRedaction} but classification-aware: a sensitive
 * field (pii/phi/regulated/commercial_sensitive by default) with no explicit
 * `read` grant defaults to redacted unless the principal holds a privileged
 * role. Explicit per-field `read` rules still win.
 *
 * One record, so one plan and one pool — the same three steps the plural entry point takes, over the
 * record on `abac.record`. It is deliberately **not** a wrapper that re-enters
 * {@link computeClassifiedFieldRedactionForRecords} and indexes `[0]`: that needs either a non-null
 * assertion or an arm for an empty array that cannot happen.
 */
export function computeClassifiedFieldRedaction(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  fields: readonly ClassifiedField[],
  policy: SensitiveFieldPolicy = {},
  abac?: AbacEnforcement,
): FieldRedactionResult {
  const effective = resolveEffectiveRoles(principal, roles);
  const requests: AbacBatchRequest[] = [];
  const planned = planClassifiedRead(
    principal,
    effective,
    entityPerms,
    fields,
    policy,
    abac,
    abac?.record,
    requests,
  );
  const discharges = dischargeAbacBatch(requests, abac?.evaluator, abac?.evaluateBatch);
  return assembleRedaction(planned, discharges);
}

/**
 * {@link computeClassifiedFieldRedaction} for several records at once, one result per record and
 * **positionally aligned** to `records`.
 *
 * One call to `dischargeAbacBatch` for the whole call — every (record, field) obligation pooled — so
 * a page of N records with F obligated fields costs one evaluator call rather than N×F. Roles are
 * resolved once for the whole call, not per record.
 *
 * A `null` element means **this call site had no record here**, identical in meaning to an absent
 * `AbacEnforcement.record`: a record-bearing policy answers `deferred` for that element and
 * `FieldRedactionResult.deferred` names the fields, exactly as on the singular path.
 *
 * The enforcement parameter is `Omit<AbacEnforcement, "record">` **deliberately**: it makes supplying
 * the record twice structurally impossible. A plural caller that could also set `abac.record` would
 * create two sources for one fact, and the only ways out are a silent precedence rule or a refusal
 * for a mistake the type can simply prevent.
 */
export function computeClassifiedFieldRedactionForRecords(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  fields: readonly ClassifiedField[],
  policy: SensitiveFieldPolicy | undefined,
  abac: Omit<AbacEnforcement, "record"> | undefined,
  records: readonly (Readonly<Record<string, unknown>> | null)[],
): readonly FieldRedactionResult[] {
  const effective = resolveEffectiveRoles(principal, roles);
  const requests: AbacBatchRequest[] = [];
  const planned = records.map((record) =>
    planClassifiedRead(
      principal,
      effective,
      entityPerms,
      fields,
      policy ?? {},
      abac,
      record ?? undefined,
      requests,
    ),
  );
  // After every record is planned, so the pool is complete and the batch is asked exactly once.
  const discharges = dischargeAbacBatch(requests, abac?.evaluator, abac?.evaluateBatch);
  return planned.map((p) => assembleRedaction(p, discharges));
}

/**
 * Write-mask that additionally defaults sensitive fields (no explicit
 * `update` grant) to writable only by a privileged role. Explicit `update`
 * rules still win.
 *
 * No batch arm, for the same reason as {@link validateWriteMask} and unlike the read path it is
 * paired with: first refusal wins, so pooling the obligations would ask about fields whose answer is
 * never needed — the refusal is returned before the later fields are reached at all.
 */
export function validateClassifiedWriteMask(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  patchFields: readonly ClassifiedField[],
  policy: SensitiveFieldPolicy = {},
  abac?: AbacEnforcement,
  /**
   * Which of the two write moments this is, so the `create` arm is read on a create and `update` on
   * an update. `fieldWriteGrant` owns the fallback, so this function does not restate it.
   *
   * Trailing and defaulted rather than required, which is a departure from `operationsForEntity`
   * (ADR-0338) and defensible for the opposite reason: that default could not possibly be correct,
   * and this one is correct for the update path and **fails closed** for the other. A forgotten
   * argument enforces the *change* grant on a create, and for every field where the two arms differ
   * the change grant is the narrower one — so the mistake refuses a create it should have admitted
   * rather than admitting one it should have refused. That is the direction an omitted
   * `AbacEnforcement` already fails in on this same function.
   */
  writeOp: FieldWriteOperation = "update",
): WriteMaskResult {
  const effective = resolveEffectiveRoles(principal, roles);
  const fieldPerms = entityPerms.fields;

  for (const field of patchFields) {
    const rule = fieldWriteGrant(fieldPerms?.[field.name], writeOp);
    if (rule !== undefined) {
      if (!rule.roles.some((r) => effective.has(r))) {
        return { ok: false, rejectedField: field.name };
      }
      const discharge = dischargeFieldObligation(
        rule.abac,
        principal,
        writeOp,
        field.name,
        abac,
      );
      if (discharge !== null && !obligationAdmits(discharge)) {
        return { ok: false, rejectedField: field.name, abac: discharge };
      }
      continue;
    }
    if (
      field.classification !== undefined &&
      defaultRedacts(policy, field.classification) &&
      // The same per-class question the read path asks, through the same function, so a role cannot
      // end up able to *write* a class it may not read (ADR-0329).
      !privilegedForClass(policy, effective, field.classification)
    ) {
      return { ok: false, rejectedField: field.name };
    }
  }

  return { ok: true };
}
