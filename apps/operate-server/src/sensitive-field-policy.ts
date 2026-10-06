/**
 * The deployment-wide declaration of who may read and write a **classified entity field**, and
 * the boot-time survey that says what the declaration leaves closed.
 *
 * `SensitiveFieldPolicy` (`@crossengin/auth`) has carried `privilegedRoles` and
 * `privilegedRolesByClass` since ADR-0329, and `privilegedForClass` is deliberately one
 * function behind both the read redaction and the write mask — its own comment says why: *"so
 * the per-class rule cannot diverge between what a role may see and what it may change"*. What
 * was missing is a **producer**. `policyForEntity` is an option on `OperateRuntimeOptions` and
 * on the redaction builder, and nothing in this app ever passed one, so entity response
 * redaction has run with `policy = {}` in every deployment and the write mask has had no caller
 * at all. The only `SensitiveFieldPolicy` built anywhere served the `--audit-read-routes` trail.
 *
 * Measured across the seven packs — **46** sensitive-classified fields (24 pii, 17
 * commercial_sensitive, 4 phi, 1 regulated):
 *
 *   - **39 are unreadable by every role in every deployment.** Only the 7 carrying an explicit
 *     per-field `read` grant come back. Verified live: `clinical_admin` GETs a `Patient` and
 *     `mrn`, `given_name`, `family_name` and `date_of_birth` are all absent.
 *   - **39 are writable by anybody** holding entity `update`, because the classified write mask
 *     has no caller. Verified live: `front_desk` wrote and then blind-overwrote `Patient.mrn`.
 *
 * So the read side is fully closed and the write side fully open, from one missing declaration.
 *
 * This module is pure: it reads a manifest and a declaration and answers. It issues no SQL,
 * opens no socket and reads no environment variable — `node.ts` builds the policy from the
 * parsed flags and hands it to `compileOperateServer`.
 *
 * **No field value may appear in anything this module produces.** Findings and the formatted
 * survey carry entity names, field names, classifications and role names only. These are the
 * fields whose whole purpose is that their values are not disclosed, and a boot log is a
 * disclosure — `column-encryption.ts` draws the same line for the same reason.
 */

import {
  computeClassifiedFieldRedaction,
  rbacCheck,
  validateClassifiedWriteMask,
  validateWriteMask,
  type EntityPermissions,
  type Principal,
  type RoleDefinition,
  type RoleName,
  type SensitiveFieldPolicy,
} from "@crossengin/auth";
import { resolvedFields, type Manifest } from "@crossengin/kernel";
import {
  entityClassifiedFields,
  isSensitiveDataClass,
  type DataClassification,
} from "@crossengin/types/meta-schema";

/**
 * The wholesale grant: a role named here is privileged for every sensitive class that
 * `{@link SENSITIVE_FIELD_CLASS_FLAG}` does not name.
 *
 * Spelled as the entity-route counterpart of `--audit-read-sensitive-role`, deliberately down to
 * the repeatability and the empty-value meaning. Two grant vocabularies that look alike and
 * differ is worse than either, and the audit trail's pair is the one an operator has already met.
 */
export const SENSITIVE_FIELD_ROLE_FLAG = "--sensitive-field-role";

/**
 * The per-class grant, `<class>=<role>`, repeatable — the counterpart of
 * `--audit-read-sensitive-class`.
 *
 * ADR-0329's rule, which the parser must preserve exactly: **a class with an entry is
 * authoritative for that class**, and the wholesale grant reaches only classes with no entry. So
 * `--sensitive-field-class phi=` (a class with no role) withholds `phi` from everyone, including
 * a wholesale grantee. Read as a union instead, a wholesale grantee could never be withheld from
 * `phi`, which is the one narrowing the feature exists for — `{phi: []}` is a refusal, not a
 * fall-through.
 */
export const SENSITIVE_FIELD_CLASS_FLAG = "--sensitive-field-class";

/**
 * The flag {@link checkClassifiedWriteMask} gates. A constant rather than a string literal per
 * message, following `ALLOW_PLAINTEXT_PHI_FLAG`: a refusal must not be able to name a flag the
 * CLI does not parse.
 */
export const CLASSIFIED_WRITE_MASK_FLAG = "--classified-write-mask";

/** How many `entity.field` pairs a formatted line names before it summarises the rest. */
/**
 * How many `entity.field` pairs a survey line names before it truncates.
 *
 * Eight rather than `column-encryption.ts`'s five, and the two are deliberately separate
 * constants rather than one shared figure: that line names the `phi`/`regulated` fields of one
 * deployment's storage decision (four in the healthcare pack), while this one summarises **46**
 * sensitive fields across every class, so the same limit would truncate it to uselessness. Named
 * distinctly because both are re-exported from the app's barrel.
 */
export const SENSITIVE_SURVEY_FIELD_LIMIT = 8;

export interface SensitiveFieldDeclaration {
  /** Roles privileged for every sensitive class with no per-class entry. */
  readonly privilegedRoles: readonly RoleName[];
  /**
   * Per-class grants. A class present here is authoritative for that class, **including when its
   * list is empty** — see {@link SENSITIVE_FIELD_CLASS_FLAG}. The distinction between an absent
   * key and an empty array is the whole mechanism, so this is a `Partial` map rather than a total
   * one: a total map could not express "no entry".
   */
  readonly privilegedRolesByClass: Readonly<
    Partial<Record<DataClassification, readonly RoleName[]>>
  >;
}

/** A declaration that grants nothing — the state every deployment has been in until now. */
export const EMPTY_SENSITIVE_FIELD_DECLARATION: SensitiveFieldDeclaration = {
  privilegedRoles: [],
  privilegedRolesByClass: {},
};

/**
 * One policy for every entity: the declaration is deployment-wide, not per entity.
 *
 * The signature stays per-entity because that is the seam `policyForEntity` already is, and a
 * **per-entity** declaration is expressible later without moving it — `--sensitive-field-class
 * Patient.phi=clinician` would change this function's body and nothing downstream. Returning the
 * same object for every entity is therefore a property of today's flags, not of the seam.
 *
 * It never answers `undefined`. The `| undefined` arm belongs to the seam, which permits an
 * entity with no policy of its own; a deployment-wide declaration has no reason to withhold
 * itself from one entity, and answering `undefined` there would make that entity's classified
 * fields follow a different rule than every other entity's for no stated reason.
 */
export function buildSensitiveFieldPolicy(
  declaration: SensitiveFieldDeclaration,
): (entity: string) => SensitiveFieldPolicy | undefined {
  // Frozen once and shared: the policy is read on every request through the redaction registry,
  // and rebuilding it per entity per request would allocate without being able to differ.
  const policy: SensitiveFieldPolicy = {
    privilegedRoles: declaration.privilegedRoles,
    privilegedRolesByClass: declaration.privilegedRolesByClass,
    // `redactByDefault` is deliberately left unset, so `defaultRedacts` falls to
    // `isSensitiveDataClass`. A deployment-supplied override here would be a second place the
    // sensitive set is decided, and the dangerous direction is the one that declassifies a class.
  };
  return (): SensitiveFieldPolicy | undefined => policy;
}

export interface SensitiveFieldFinding {
  readonly entity: string;
  readonly field: string;
  readonly classification: DataClassification;
  readonly required: boolean;
  /** Roles (of those the deployment can present) that may write it. Empty = nobody. */
  readonly writableBy: readonly RoleName[];
  readonly readableBy: readonly RoleName[];
}

export interface SensitiveFieldSurvey {
  readonly findings: readonly SensitiveFieldFinding[];
  /** Sensitive + required + writable by no declared role: its entity is uncreatable. */
  readonly uncreatable: readonly SensitiveFieldFinding[];
  readonly totalSensitive: number;
  /**
   * The regime `writableBy` was measured under — the `classifiedWriteMask` input echoed back, so
   * a formatted survey says which of the two write rules it is describing. {@link uncreatable} is
   * **not** measured under it; see {@link surveySensitiveFields}.
   */
  readonly classifiedWriteMask: boolean;
}

/**
 * A principal carrying exactly one role.
 *
 * Inheritance is deliberately **not** flattened here: `validateClassifiedWriteMask` and
 * `computeClassifiedFieldRedaction` both call `resolveEffectiveRoles` internally, so naming the
 * role as `primaryRole` is enough and expanding `inherits` ourselves would be a second
 * implementation of the resolution — the exact defect shape this survey exists to answer. A
 * consequence worth expecting: a role that inherits a privileged one *is* privileged, so
 * `writableBy` can legitimately be longer than the declared grant and name roles the declaration
 * never mentions.
 */
function principalFor(role: RoleName): Principal {
  return {
    kind: "user",
    // The survey asks a question about roles, not about rows: no tenant is consulted by either
    // predicate, so a fixed placeholder is honest and a real tenant id would imply otherwise.
    tenantId: "00000000-0000-0000-0000-000000000000" as Principal["tenantId"],
    userId: null,
    primaryRole: role,
    secondaryRoles: [],
    // `null`, not `{}`: this is a boot survey over roles with no request and no membership behind
    // it, so nothing was resolved. `{}` would claim the surveyed role has no attributes, which
    // would let an obligated field read as answerable from a question nobody asked.
    abacAttributes: null,
    mfaProofAgeSeconds: null,
  };
}

/**
 * Whether `role` may write `field` on `entity`, asked of the real predicate.
 *
 * `resolveEffectiveRoles` throws `UnknownRoleError` for a role with no definition, and
 * `RoleInheritanceCycleError` for a broken inheritance graph. Both are caught and answered
 * **false**: the survey is a diagnostic that must not take a boot down, and a role the manifest
 * does not define genuinely cannot write anything, so false is the true answer and the
 * fail-closed one at once.
 */
function mayWrite(
  classifiedWriteMask: boolean,
  role: RoleName,
  perms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  field: string,
  classification: DataClassification,
  policy: SensitiveFieldPolicy,
): boolean {
  try {
    const principal = principalFor(role);
    // Two predicates because there are two regimes, and both are real: with the mask mounted the
    // classified rule applies, and without it `validateWriteMask` is literally what the handlers
    // call — a sensitive field with no explicit `update` grant is writable by anybody. Restating
    // either here would make the survey answer about code that does not run.
    //
    // `policy` is passed, and a test caught it being forgotten: `validateClassifiedWriteMask`
    // defaults it to `{}`, so omitting it answered "nobody may write" for a class the declaration
    // granted — the read side privileged and the write side closed, which is the live defect
    // inverted and would have refused a boot the declaration had already fixed.
    const result = classifiedWriteMask
      ? validateClassifiedWriteMask(
          principal,
          perms,
          roles,
          [{ name: field, classification }],
          policy,
        )
      : validateWriteMask(principal, perms, roles, [field]);
    return result.ok;
  } catch {
    return false;
  }
}

/** Whether `role` may read `field` unredacted, asked of the real predicate. */
function mayRead(
  role: RoleName,
  perms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  field: string,
  classification: DataClassification,
  policy: SensitiveFieldPolicy,
): boolean {
  try {
    const result = computeClassifiedFieldRedaction(
      principalFor(role),
      perms,
      roles,
      [{ name: field, classification }],
      policy,
    );
    return result.readable.includes(field);
  } catch {
    return false;
  }
}

/** Whether any presented role may `create` the entity, ignoring the field mask entirely. */
function entityIsCreatable(
  manifest: Manifest,
  entity: string,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  presented: readonly RoleName[],
): boolean {
  const permissions = manifest.permissions ?? {};
  for (const role of presented) {
    try {
      if (
        rbacCheck({
          principal: principalFor(role),
          permissions,
          roles,
          entity,
          operation: "create",
        }).allowed
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Asks, for every sensitive field and every role the deployment can present, whether the write
 * mask and the read redaction would permit it.
 *
 * Three decisions are load-bearing:
 *
 *   - **The predicates are called, never restated.** `validateClassifiedWriteMask`,
 *     `validateWriteMask`, `computeClassifiedFieldRedaction` and `rbacCheck` are asked once per
 *     (field, role). A second copy of a rule is this repo's recurring defect, and the survey's
 *     whole value is that it answers with the same code the request path runs — a survey that
 *     agreed with a restatement and disagreed with the handler would be worse than none.
 *   - **Fields come from `resolvedFields`**, the function `validateManifest` uses, so a
 *     classified field arriving through a **trait** is found. Surveying `entity.fields` alone
 *     would be a blind spot of exactly the shape the fence exists to close: a field the
 *     validator sees, the emitted table has, and the survey does not.
 *   - **`uncreatable` is always measured with the write mask on**, whatever `classifiedWriteMask`
 *     says. It is what gates mounting the flag, and a refusal computed under the regime the
 *     caller is leaving could never gate the change: surveyed with the mask off, every sensitive
 *     field is writable by anybody, `uncreatable` would be empty, and the check would wave
 *     through the very configuration that 403s every create.
 */
export function surveySensitiveFields(input: {
  readonly manifest: Manifest;
  readonly declaration: SensitiveFieldDeclaration;
  /**
   * The roles the deployment can present. `node.ts` passes the **manifest's declared roles**
   * (`Object.keys(manifest.roles ?? {})`), which is the universe this question has to be asked
   * over: `uncreatable` answers *"can this required field be written by anybody at all"*, and a
   * JWT deployment can present any role the manifest defines. Passing a narrower set — the
   * api-key roles, say — would call a field uncreatable that a JWT holder writes perfectly well,
   * which is a **false boot refusal**, the worst outcome available here. The manifest-role
   * universe can only ever under-report uncreatability, which is the safe direction.
   */
  readonly roles: readonly RoleName[];
  readonly classifiedWriteMask: boolean;
}): SensitiveFieldSurvey {
  const { manifest, declaration, classifiedWriteMask } = input;
  const roleDefs = new Map<RoleName, RoleDefinition>(Object.entries(manifest.roles ?? {}));
  const policy = buildSensitiveFieldPolicy(declaration)("") ?? {};
  const traits = manifest.traits ?? [];

  // Deduped, input order preserved: the order a declaration was written in is the order an
  // operator reads a refusal in, and two spellings of one role must not double a `writableBy`.
  const presented = [...new Set(input.roles)];

  const findings: SensitiveFieldFinding[] = [];
  const uncreatable: SensitiveFieldFinding[] = [];

  for (const entity of manifest.entities ?? []) {
    const resolved = resolvedFields(entity, traits);
    const requiredByName = new Map(resolved.map((f) => [f.name, f.required === true]));
    // `entityClassifiedFields` is the one reader of a field's classification, asked over the
    // **resolved** field list rather than `entity.fields`. Synthesising the entity keeps both
    // halves borrowed: the kernel resolves which fields exist, and that function says which of
    // them are classified, so neither rule is spelled a second time here.
    const classified = entityClassifiedFields({ ...entity, fields: [...resolved] });
    const perms: EntityPermissions = manifest.permissions?.[entity.name] ?? {};
    let creatable: boolean | null = null;

    for (const { field, classification } of classified) {
      // `internal` and `public` are classified and not *sensitive*: neither predicate defaults
      // them to anything, so a finding about one would report a rule that never fires.
      if (!isSensitiveDataClass(classification)) continue;

      const required = requiredByName.get(field) ?? false;
      const writableBy = presented.filter((role) =>
        mayWrite(classifiedWriteMask, role, perms, roleDefs, field, classification, policy),
      );
      const readableBy = presented.filter((role) =>
        mayRead(role, perms, roleDefs, field, classification, policy),
      );
      const finding: SensitiveFieldFinding = {
        entity: entity.name,
        field,
        classification,
        required,
        writableBy,
        readableBy,
      };
      findings.push(finding);

      // Not required: writable by nobody is a legitimate posture — it is exactly what
      // `--sensitive-field-class phi=` asks for — so it stays an ordinary finding. Conflating the
      // two would refuse a boot the operator deliberately configured.
      if (!required) continue;
      const writableUnderMask = classifiedWriteMask
        ? writableBy.length > 0
        : presented.some((role) =>
            mayWrite(true, role, perms, roleDefs, field, classification, policy),
          );
      if (writableUnderMask) continue;
      // The entity-level `create` grant is the second conjunct, so the refusal stays **about this
      // declaration**: an entity no role may create is already uncreatable and the write mask is
      // not what made it so, and naming it here would send an operator to add a grant that
      // changes nothing. Computed once per entity, since it does not vary by field.
      creatable ??= entityIsCreatable(manifest, entity.name, roleDefs, presented);
      if (creatable) uncreatable.push(finding);
    }
  }

  return { findings, uncreatable, totalSensitive: findings.length, classifiedWriteMask };
}

/** `Entity.field, Entity.field (+N more)` — names only, never a value. */
function nameFields(findings: readonly SensitiveFieldFinding[]): string {
  const shown = findings
    .slice(0, SENSITIVE_SURVEY_FIELD_LIMIT)
    .map((f) => `${f.entity}.${f.field}`);
  const hidden = findings.length - shown.length;
  const suffix = hidden > 0 ? ` (+${hidden.toString()} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

/**
 * The boot lines. Both directions are printed, because the **asymmetry is the finding**: a field
 * writable by a role that cannot read it is precisely the live defect (39 fields closed to every
 * reader and open to every writer), and a survey that printed one side could not show it. So that
 * set gets its own line even though every one of its members already appears in the counts above.
 */
export function formatSensitiveFieldSurvey(survey: SensitiveFieldSurvey): string {
  if (survey.totalSensitive === 0) {
    return "[fields] no sensitive-classified fields in this manifest";
  }

  const byClass = new Map<DataClassification, number>();
  for (const f of survey.findings)
    byClass.set(f.classification, (byClass.get(f.classification) ?? 0) + 1);
  const classes = [...byClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, n]) => `${c} ${n.toString()}`)
    .join(", ");

  const unreadable = survey.findings.filter((f) => f.readableBy.length === 0);
  const unwritable = survey.findings.filter((f) => f.writableBy.length === 0);
  // Writable by somebody who cannot read it. Per role rather than per field: a field readable by
  // one role and writable by another is not the defect, and comparing only the list lengths would
  // report it as one.
  const asymmetric = survey.findings.filter((f) =>
    f.writableBy.some((role) => !f.readableBy.includes(role)),
  );

  const lines = [
    `[fields] ${survey.totalSensitive.toString()} sensitive-classified field(s): ${classes}` +
      ` (classified write mask ${survey.classifiedWriteMask ? "on" : "OFF"})`,
  ];
  if (unreadable.length > 0) {
    lines.push(
      `[fields] unreadable by every declared role: ${unreadable.length.toString()} — ${nameFields(unreadable)}`,
    );
  }
  if (unwritable.length > 0) {
    lines.push(
      `[fields] writable by no declared role: ${unwritable.length.toString()} — ${nameFields(unwritable)}`,
    );
  }
  if (asymmetric.length > 0) {
    lines.push(
      `[fields] writable by a role that cannot read it: ${asymmetric.length.toString()} — ` +
        `${nameFields(asymmetric)}`,
    );
  }
  if (survey.uncreatable.length > 0) {
    lines.push(
      `[fields] required and writable by no declared role, so their entity is uncreatable: ` +
        `${nameFields(survey.uncreatable)}`,
    );
  }
  return lines.join("\n");
}

export const CLASSIFIED_WRITE_MASK_REFUSALS = ["would_make_entity_uncreatable"] as const;
export type ClassifiedWriteMaskRefusal = (typeof CLASSIFIED_WRITE_MASK_REFUSALS)[number];

/**
 * Whether `--classified-write-mask` may be mounted against this manifest and declaration, or the
 * reason it may not.
 *
 * ADR-0334's conversion applied again: 12 fields across seven entities sit in the uncreatable
 * position today, so a deployment that turns the flag on with no declaration discovers it as a
 * **403 on create** with nothing saying which declaration is missing. Refusing at boot with the
 * entities and fields named *is* the migration guide — and there is no `--allow-…` opt-out here on
 * purpose, because the escape hatch already exists and is better: declare the roles, or do not
 * mount the mask.
 */
export function checkClassifiedWriteMask(
  survey: SensitiveFieldSurvey,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ClassifiedWriteMaskRefusal; readonly detail: string } {
  if (survey.uncreatable.length === 0) return { ok: true };

  // Grouped by entity, because the entity is what becomes uncreatable and a flat field list makes
  // an operator do that grouping by hand to find out how much of the deployment is affected.
  const byEntity = new Map<string, string[]>();
  for (const f of survey.uncreatable) {
    const fields = byEntity.get(f.entity) ?? [];
    fields.push(f.field);
    byEntity.set(f.entity, fields);
  }
  const named = [...byEntity.entries()]
    .map(([entity, fields]) => `${entity} (${fields.join(", ")})`)
    .join("; ");

  return {
    ok: false,
    reason: "would_make_entity_uncreatable",
    detail:
      `${CLASSIFIED_WRITE_MASK_FLAG} would make ${byEntity.size.toString()} entit${byEntity.size === 1 ? "y" : "ies"} ` +
      `uncreatable: ${named}. Each field is required, sensitive-classified and has no per-field ` +
      `update grant, so no role may write it — declare one with ${SENSITIVE_FIELD_ROLE_FLAG} or ` +
      `${SENSITIVE_FIELD_CLASS_FLAG} <class>=<role>.`,
  };
}
