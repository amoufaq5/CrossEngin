import {
  validateClassifiedWriteMask,
  type AbacEvaluationInput,
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
import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  WRITE_MASK_MODES,
  buildClassifiedFieldIndex,
  maskWrite,
  type WriteMaskMode,
} from "./write-mask.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

// Only ever handed to `AbacEnforcement.entity`, which is what an evaluator is asked about.
const ENTITY = "Patient";

const ROLES: ReadonlyMap<RoleName, RoleDefinition> = new Map<RoleName, RoleDefinition>([
  ["clerk", { name: "clerk" }],
  ["clinician", { name: "clinician" }],
  ["compliance", { name: "compliance" }],
  // Inherits clinician, so an explicit grant naming `clinician` must reach it.
  ["chief", { name: "chief", inherits: ["clinician"] }],
]);

function principal(role: RoleName): Principal {
  return {
    kind: "user",
    tenantId: TENANT as Principal["tenantId"],
    userId: null,
    primaryRole: role,
    secondaryRoles: [],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
  };
}

// `mrn` is phi with an explicit `update` grant (the 7-field case); `given_name` is pii with no
// grant (the 39-field case); `nickname` is unclassified with a grant (an explicit restriction on
// an ordinary field); `status` is an ordinary field with neither.
const CLASSIFIED: readonly ClassifiedField[] = [
  { name: "mrn", classification: "phi" },
  { name: "given_name", classification: "pii" },
];

const PERMS: EntityPermissions = {
  create: { roles: ["clerk", "clinician", "chief"] },
  update: { roles: ["clerk", "clinician", "chief"] },
  fields: {
    mrn: { read: { roles: ["clinician"] }, update: { roles: ["clinician"] } },
    nickname: { update: { roles: ["clinician"] } },
    given_name: { read: { roles: ["clinician"] } },
  },
};

function mask(
  mode: WriteMaskMode,
  role: RoleName,
  writtenKeys: readonly string[],
  policy?: SensitiveFieldPolicy,
  writeOp: FieldWriteOperation = "update",
) {
  return maskWrite({
    mode,
    entity: ENTITY,
    principal: principal(role),
    entityPerms: PERMS,
    roles: ROLES,
    classifiedFields: CLASSIFIED,
    writtenKeys,
    writeOp,
    ...(policy !== undefined ? { policy } : {}),
  });
}

describe("WRITE_MASK_MODES", () => {
  it("has exactly the two modes, explicit_only first", () => {
    expect(WRITE_MASK_MODES).toEqual(["explicit_only", "classified"]);
  });
});

describe("buildClassifiedFieldIndex", () => {
  const manifest = {
    meta: { name: "ix", version: "1.0.0" },
    entities: [
      {
        name: "Patient",
        fields: [
          { name: "id", type: { kind: "uuid" } },
          { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
          { name: "status", type: { kind: "text", maxLength: 20 } },
        ],
      },
      {
        name: "Widget",
        fields: [
          { name: "id", type: { kind: "uuid" } },
          { name: "label", type: { kind: "text", maxLength: 20 } },
        ],
      },
    ],
  } as unknown as Manifest;

  it("maps an entity to its classified fields in auth's ClassifiedField shape", () => {
    const index = buildClassifiedFieldIndex(manifest);
    expect(index.get("Patient")).toEqual([{ name: "mrn", classification: "phi" }]);
  });

  it("omits an entity with no classified field", () => {
    const index = buildClassifiedFieldIndex(manifest);
    expect(index.has("Widget")).toBe(false);
    expect(index.size).toBe(1);
  });

  it("tolerates a manifest with no entities", () => {
    expect(buildClassifiedFieldIndex({ meta: { name: "e", version: "1.0.0" } } as unknown as Manifest).size).toBe(0);
  });
});

describe("maskWrite — explicit_only (the default, always on)", () => {
  it("refuses a declared-update field for an ungranted role", () => {
    expect(mask("explicit_only", "clerk", ["mrn"])).toEqual({
      field: "mrn",
      rule: "explicit_update_grant",
      classification: "phi",
    });
  });

  it("permits the same field for the granted role", () => {
    expect(mask("explicit_only", "clinician", ["mrn"])).toBeNull();
  });

  it("honours role inheritance: a role inheriting the grantee is granted", () => {
    expect(mask("explicit_only", "chief", ["mrn"])).toBeNull();
  });

  it("permits a sensitive field with no update grant", () => {
    // This is what keeps the 12 `required: true` sensitive fields in the packs creatable —
    // `Patient.mrn`, `Lead.full_name`, `Opportunity.amount`, `Permit.fee_amount` and the rest are
    // governed only by the classification default, and with no `policyForEntity` producer in the
    // deployment the symmetric rule refuses them for *every* role. Do not "tighten" this: it is
    // the whole reason the classified half is a separate, opt-in mode.
    expect(mask("explicit_only", "clerk", ["given_name"])).toBeNull();
  });

  it("enforces a declared update grant on an unclassified field too", () => {
    // The candidate set is grants ∪ classifications, not classifications alone.
    expect(mask("explicit_only", "clerk", ["nickname"])).toEqual({
      field: "nickname",
      rule: "explicit_update_grant",
    });
    expect(mask("explicit_only", "clinician", ["nickname"])).toBeNull();
  });

  it("ignores a field with neither a grant nor a classification", () => {
    expect(mask("explicit_only", "clerk", ["status"])).toBeNull();
  });

  it("refuses the first offending key in the order written", () => {
    expect(mask("explicit_only", "clerk", ["status", "nickname", "mrn"])?.field).toBe("nickname");
    expect(mask("explicit_only", "clerk", ["status", "mrn", "nickname"])?.field).toBe("mrn");
  });

  it("permits an empty write", () => {
    expect(mask("explicit_only", "clerk", [])).toBeNull();
  });

  it("is unaffected by a policy, because the classification branch is never reached", () => {
    // `defaultRedacts` / `privilegedForClass` are not called at all in this mode, so neither a
    // `redactByDefault` override nor a per-class grant can move its answer.
    const policy: SensitiveFieldPolicy = {
      privilegedRoles: ["clerk"],
      redactByDefault: () => true,
    };
    expect(mask("explicit_only", "clerk", ["mrn"], policy)?.field).toBe("mrn");
    expect(mask("explicit_only", "clerk", ["given_name"], policy)).toBeNull();
  });
});

describe("maskWrite — explicit_only is exactly validateClassifiedWriteMask with classifications stripped", () => {
  // The equivalence claimed in `write-mask.ts`, asserted rather than argued: the explicit branch
  // of `validateClassifiedWriteMask` does not read `classification`, and the first conjunct of its
  // classification branch is `field.classification !== undefined`. So one function owns the
  // explicit rule and the two modes cannot disagree about it.
  const keySets: readonly (readonly string[])[] = [
    ["mrn"],
    ["given_name"],
    ["nickname"],
    ["status"],
    ["status", "given_name", "mrn", "nickname"],
    [],
  ];

  for (const role of ["clerk", "clinician", "chief", "compliance"] as const) {
    for (const keys of keySets) {
      it(`${role} / [${keys.join(",")}] agrees with the stripped-classification call`, () => {
        const stripped = validateClassifiedWriteMask(
          principal(role),
          PERMS,
          ROLES,
          keys.map((name) => ({ name })),
        );
        const refusal = mask("explicit_only", role, keys);
        expect(refusal === null).toBe(stripped.ok);
        if (refusal !== null) expect(refusal.field).toBe(stripped.rejectedField);
      });
    }
  }
});

describe("maskWrite — classified (opt-in, ADR-0329's symmetric rule)", () => {
  it("refuses a sensitive field with no update grant", () => {
    expect(mask("classified", "clerk", ["given_name"])).toEqual({
      field: "given_name",
      rule: "classification_default",
      classification: "pii",
    });
  });

  it("permits it for a wholesale privilegedRoles holder", () => {
    expect(mask("classified", "compliance", ["given_name"], { privilegedRoles: ["compliance"] })).toBeNull();
  });

  it("permits it for a per-class privilegedRolesByClass holder", () => {
    expect(
      mask("classified", "clerk", ["given_name"], { privilegedRolesByClass: { pii: ["clerk"] } }),
    ).toBeNull();
  });

  it("a per-class grant is authoritative for its class: {phi: []} refuses a wholesale holder", () => {
    // ADR-0329's rule read in the direction it exists for. A class with an entry is authoritative
    // for that class, so an explicit empty list is a refusal and never a fall-through to
    // `privilegedRoles` — otherwise a wholesale grantee could never be withheld from phi, which is
    // the narrowing a HIPAA deployment needs.
    const policy: SensitiveFieldPolicy = {
      privilegedRoles: ["compliance"],
      privilegedRolesByClass: { phi: [] },
    };
    // `mrn` carries an explicit grant, so use a phi field governed only by the default.
    const refusal = maskWrite({
      mode: "classified",
      entity: ENTITY,
      principal: principal("compliance"),
      entityPerms: { fields: {} },
      roles: ROLES,
      classifiedFields: [{ name: "diagnosis_note", classification: "phi" }],
      writtenKeys: ["diagnosis_note"],
      writeOp: "update",
      policy,
    });
    expect(refusal).toEqual({
      field: "diagnosis_note",
      rule: "classification_default",
      classification: "phi",
    });
    // …and the same wholesale holder still reaches pii, which has no entry.
    expect(
      maskWrite({
        mode: "classified",
        entity: ENTITY,
        principal: principal("compliance"),
        entityPerms: { fields: {} },
        roles: ROLES,
        classifiedFields: [{ name: "given_name", classification: "pii" }],
        writtenKeys: ["given_name"],
        writeOp: "update",
        policy,
      }),
    ).toBeNull();
  });

  it("an explicit update grant still wins over the classification default", () => {
    // Both directions: the grant admits a role the default would refuse, and refuses one the
    // default would admit.
    const policy: SensitiveFieldPolicy = { privilegedRoles: ["compliance"] };
    expect(mask("classified", "clinician", ["mrn"], policy)).toBeNull();
    expect(mask("classified", "compliance", ["mrn"], policy)).toEqual({
      field: "mrn",
      rule: "explicit_update_grant",
      classification: "phi",
    });
  });

  it("leaves a non-sensitive classification alone", () => {
    expect(
      maskWrite({
        mode: "classified",
        entity: ENTITY,
        principal: principal("clerk"),
        entityPerms: { fields: {} },
        roles: ROLES,
        classifiedFields: [{ name: "memo", classification: "internal" }],
        writtenKeys: ["memo"],
        writeOp: "update",
      }),
    ).toBeNull();
  });

  it("refuses commercial_sensitive, which is sensitive and not PHI", () => {
    expect(
      maskWrite({
        mode: "classified",
        entity: ENTITY,
        principal: principal("clerk"),
        entityPerms: { fields: {} },
        roles: ROLES,
        classifiedFields: [{ name: "unit_cost", classification: "commercial_sensitive" }],
        writtenKeys: ["unit_cost"],
        writeOp: "update",
      })?.field,
    ).toBe("unit_cost");
  });

  it("still ignores an ordinary field", () => {
    expect(mask("classified", "clerk", ["status"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ABAC obligations on a per-field update grant.
//
// `rbacCheck` returned the obligation and nothing read it, so an abac-qualified grant granted
// unconditionally — the inverse of this repo's "fail closed" invariant. The obligation rides on the
// *explicit* grant, which ADR-0339 made authoritative and enforced always, so it is refused in BOTH
// modes: gating it on `classified` would leave that grant enforced as to roles and silently
// unconditional as to attributes.
// ---------------------------------------------------------------------------

const ABAC_KEY = "patient.in_care_team";

// `mrn` is phi *and* carries the obligation, so one field exercises both modes: under
// `explicit_only` its classification is stripped and the grant (with its obligation) still applies.
const ABAC_PERMS: EntityPermissions = {
  create: { roles: ["clerk", "clinician", "chief"] },
  update: { roles: ["clerk", "clinician", "chief"] },
  fields: {
    mrn: { read: { roles: ["clinician"] }, update: { roles: ["clinician"], abac: ABAC_KEY } },
    nickname: { update: { roles: ["clinician"] } },
  },
};

function answering(outcome: AbacOutcome, seen?: AbacEvaluationInput[]): AbacEvaluator {
  return (input) => {
    seen?.push(input);
    return outcome;
  };
}

function abacMask(
  mode: WriteMaskMode,
  role: RoleName,
  writtenKeys: readonly string[],
  abacEvaluator?: AbacEvaluator,
  record?: Readonly<Record<string, unknown>>,
  writeOp: FieldWriteOperation = "update",
) {
  return maskWrite({
    mode,
    entity: ENTITY,
    principal: principal(role),
    entityPerms: ABAC_PERMS,
    roles: ROLES,
    classifiedFields: CLASSIFIED,
    writtenKeys,
    writeOp,
    ...(abacEvaluator !== undefined ? { abacEvaluator } : {}),
    ...(record !== undefined ? { record } : {}),
  });
}

describe("maskWrite — an abac obligation is refused in both modes", () => {
  for (const mode of WRITE_MASK_MODES) {
    it(`${mode}: no evaluator refuses the granted role as undischargeable`, () => {
      expect(abacMask(mode, "clinician", ["mrn"])).toEqual({
        field: "mrn",
        rule: "abac_obligation",
        abacPolicyKey: ABAC_KEY,
        abacOutcome: "undischargeable",
        classification: "phi",
      });
    });

    it(`${mode}: a satisfied evaluator lets the write through`, () => {
      expect(abacMask(mode, "clinician", ["mrn"], answering("satisfied"))).toBeNull();
    });

    it(`${mode}: a denied evaluator refuses, distinguishably from undischargeable`, () => {
      const refusal = abacMask(mode, "clinician", ["mrn"], answering("denied"));
      expect(refusal?.rule).toBe("abac_obligation");
      expect(refusal?.abacOutcome).toBe("denied");
      expect(refusal?.abacPolicyKey).toBe(ABAC_KEY);
    });
  }

  it("reports the obligation as itself and never as the role rule that already passed", () => {
    // `clinician` *is* named by the grant, so `explicit_update_grant` would send an operator to
    // widen a grant that already reaches them and leave the real cause unnamed.
    expect(abacMask("explicit_only", "clinician", ["mrn"])?.rule).toBe("abac_obligation");
  });

  it("a role the grant does not name is refused by the role rule, with no obligation reported", () => {
    // The three refusals are distinct: the role check answers first, so a `clerk` never reaches
    // the obligation and the body carries neither abac field.
    const refusal = abacMask("explicit_only", "clerk", ["mrn"], answering("satisfied"));
    expect(refusal).toEqual({ field: "mrn", rule: "explicit_update_grant", classification: "phi" });
    expect(refusal).not.toHaveProperty("abacPolicyKey");
    expect(refusal).not.toHaveProperty("abacOutcome");
  });

  it("names the policy key, the entity, the update operation and the field to the evaluator", () => {
    // `AbacEnforcement.entity` is the only route the entity name has into the evaluation input —
    // the four field-level functions take `EntityPermissions`, which does not carry it.
    const seen: AbacEvaluationInput[] = [];
    abacMask("explicit_only", "clinician", ["mrn"], answering("satisfied", seen));
    expect(seen.map((i) => [i.policyKey, i.entity, i.operation, i.field])).toEqual([
      [ABAC_KEY, ENTITY, "update", "mrn"],
    ]);
  });

  it("leaves a grant with no obligation alone even when an evaluator is configured", () => {
    // `nickname`'s grant carries no `abac`, so there is nothing to discharge: a `denied` evaluator
    // must not refuse it, or configuring one would narrow every unqualified grant in the manifest.
    expect(abacMask("explicit_only", "clinician", ["nickname"], answering("denied"))).toBeNull();
    expect(abacMask("explicit_only", "clerk", ["nickname"], answering("satisfied"))?.rule).toBe(
      "explicit_update_grant",
    );
  });

  it("leaves an ordinary field alone, which never reaches a grant at all", () => {
    expect(abacMask("explicit_only", "clinician", ["status"], answering("denied"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The record a per-field obligation's policy is about (ADR-0341's open end #1).
//
// `AbacEvaluationInput` carried no record, so "owns this row" was inexpressible by any evaluator.
// A policy that needs one and is handed none answers `deferred`, which refuses — so the mask's job
// here is to pass the record through *verbatim* when it has one and to leave the key **absent**
// when it does not, because absent means "the caller had none" and not "the record is empty".
// ---------------------------------------------------------------------------

describe("maskWrite — the record the obligation's policy is about", () => {
  const STORED: Readonly<Record<string, unknown>> = { id: "pat-1", mrn: "MRN-1", care_team: ["dr-a"] };

  it("hands the record to the evaluator verbatim, beside the policy key and the field", () => {
    const seen: AbacEvaluationInput[] = [];
    abacMask("explicit_only", "clinician", ["mrn"], answering("satisfied", seen), STORED);
    expect(seen.length).toBe(1);
    // Identity, not a structural copy: a mask that rebuilt the record could drop a key the policy
    // reads, and the evaluator would then answer about a record the write is not landing on.
    expect(seen[0]?.record).toBe(STORED);
    expect([seen[0]?.policyKey, seen[0]?.field]).toEqual([ABAC_KEY, "mrn"]);
  });

  it("omits the key entirely when the caller had no record", () => {
    // `"record" in input === false`, not `record === undefined`: the distinction the whole
    // mechanism rests on is absent-vs-present, and an explicitly-undefined key would be a third
    // state nothing reads.
    const seen: AbacEvaluationInput[] = [];
    abacMask("explicit_only", "clinician", ["mrn"], answering("satisfied", seen));
    expect(seen.length).toBe(1);
    expect("record" in (seen[0] as object)).toBe(false);
  });

  it("passes an empty record through as present, which is a different fact from absent", () => {
    const seen: AbacEvaluationInput[] = [];
    abacMask("explicit_only", "clinician", ["mrn"], answering("satisfied", seen), {});
    expect("record" in (seen[0] as object)).toBe(true);
    expect(seen[0]?.record).toEqual({});
  });

  for (const mode of WRITE_MASK_MODES) {
    it(`${mode}: a deferred outcome refuses as an abac_obligation, naming the outcome`, () => {
      // `deferred` is the third refusing outcome and must surface as itself: reporting it as
      // `undischargeable` would send an operator to configure an evaluator they already have, and
      // reporting it as `explicit_update_grant` to widen a grant that already names them.
      expect(abacMask(mode, "clinician", ["mrn"], answering("deferred"))).toEqual({
        field: "mrn",
        rule: "abac_obligation",
        abacPolicyKey: ABAC_KEY,
        abacOutcome: "deferred",
        classification: "phi",
      });
    });
  }

  it("an evaluator that needs the record defers without it and admits with it", () => {
    // The pair the handler's re-ask is built on, at this layer: one evaluator, two answers,
    // differing in nothing but whether the record was supplied.
    const needsRecord: AbacEvaluator = (input) => (input.record === undefined ? "deferred" : "satisfied");
    expect(abacMask("explicit_only", "clinician", ["mrn"], needsRecord)?.abacOutcome).toBe("deferred");
    expect(abacMask("explicit_only", "clinician", ["mrn"], needsRecord, STORED)).toBeNull();
  });

  it("supplying a record does not reach a grant with no obligation", () => {
    // `nickname`'s grant carries no `abac`, so there is nothing to discharge and the record is
    // never consulted — passing one must not turn an unqualified grant into an evaluated one.
    const seen: AbacEvaluationInput[] = [];
    expect(
      abacMask("explicit_only", "clinician", ["nickname"], answering("denied", seen), STORED),
    ).toBeNull();
    expect(seen).toEqual([]);
  });

  it("the role check still answers before the record is ever handed over", () => {
    // A `clerk` is not named by `mrn`'s grant, so no evaluation happens and the record — which may
    // be a row they have no business being asked about — does not reach the deployment's policy.
    const seen: AbacEvaluationInput[] = [];
    expect(abacMask("explicit_only", "clerk", ["mrn"], answering("satisfied", seen), STORED)?.rule).toBe(
      "explicit_update_grant",
    );
    expect(seen).toEqual([]);
  });
});

describe("maskWrite — the create arm selects a different grant from the update arm", () => {
  // The registration shape, and the reason `FieldPermission` grew a third arm: a clerk **sets** the
  // medical record number they were handed and can neither read it back nor change it afterwards.
  // One role list could not say that — narrowing who may change a required field narrowed who may
  // create the record, which is how `erp-government` shipped a Citizen `case_worker` could not
  // create (ADR-0339 made an explicit grant authoritative with no flag).
  const SET_ONCE: EntityPermissions = {
    create: { roles: ["clerk", "clinician"] },
    update: { roles: ["clerk", "clinician"] },
    fields: {
      mrn: {
        read: { roles: ["clinician"] },
        update: { roles: ["clinician"] },
        create: { roles: ["clerk", "clinician"] },
      },
    },
  };

  const run = (role: RoleName, writeOp: FieldWriteOperation) =>
    maskWrite({
      mode: "classified",
      entity: ENTITY,
      principal: principal(role),
      entityPerms: SET_ONCE,
      roles: ROLES,
      classifiedFields: CLASSIFIED,
      writtenKeys: ["mrn"],
      writeOp,
    });

  it("admits the registrar on a create", () => {
    expect(run("clerk", "create")).toBeNull();
  });

  it("refuses the same registrar on an update", () => {
    expect(run("clerk", "update")).toEqual({
      field: "mrn",
      rule: "explicit_update_grant",
      classification: "phi",
    });
  });

  it("admits the clinician on both, since they hold every arm", () => {
    expect(run("clinician", "create")).toBeNull();
    expect(run("clinician", "update")).toBeNull();
  });

  it("falls back to update when no create arm is declared, so existing grants are unchanged", () => {
    // The property that let this arm land without touching a single shipped declaration: with no
    // `create` key, both moments read `update` and answer exactly as they did before.
    for (const op of ["create", "update"] as const) {
      expect(mask("classified", "clerk", ["mrn"], undefined, op)).toEqual({
        field: "mrn",
        rule: "explicit_update_grant",
        classification: "phi",
      });
      expect(mask("classified", "clinician", ["mrn"], undefined, op)).toBeNull();
    }
  });

  it("reads the create arm when it is the only declared write arm", () => {
    // The candidate filter asks `fieldWriteGrant`, not `update` — reading `update` here would drop
    // the key from the candidate list on a create and skip the one grant that governs it.
    const createOnly: EntityPermissions = {
      create: { roles: ["clerk", "clinician"] },
      update: { roles: ["clerk", "clinician"] },
      fields: { nickname: { read: { roles: ["clerk", "clinician"] }, create: { roles: ["clinician"] } } },
    };
    const only = (role: RoleName, writeOp: FieldWriteOperation) =>
      maskWrite({
        mode: "classified",
        entity: ENTITY,
        principal: principal(role),
        entityPerms: createOnly,
        roles: ROLES,
        classifiedFields: CLASSIFIED,
        writtenKeys: ["nickname"],
        writeOp,
      });
    expect(only("clerk", "create")?.field).toBe("nickname");
    expect(only("clinician", "create")).toBeNull();
    // `nickname` is unclassified and has no `update` arm, so on an update there is no rule at all
    // and nothing refuses — the fallback finding nothing is not the same as finding an empty grant.
    expect(only("clerk", "update")).toBeNull();
  });
});
