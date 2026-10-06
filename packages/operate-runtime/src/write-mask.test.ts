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
import { describe, expect, it } from "vitest";

import {
  WRITE_MASK_MODES,
  buildClassifiedFieldIndex,
  maskWrite,
  type WriteMaskMode,
} from "./write-mask.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

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
) {
  return maskWrite({
    mode,
    principal: principal(role),
    entityPerms: PERMS,
    roles: ROLES,
    classifiedFields: CLASSIFIED,
    writtenKeys,
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
      principal: principal("compliance"),
      entityPerms: { fields: {} },
      roles: ROLES,
      classifiedFields: [{ name: "diagnosis_note", classification: "phi" }],
      writtenKeys: ["diagnosis_note"],
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
        principal: principal("compliance"),
        entityPerms: { fields: {} },
        roles: ROLES,
        classifiedFields: [{ name: "given_name", classification: "pii" }],
        writtenKeys: ["given_name"],
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
        principal: principal("clerk"),
        entityPerms: { fields: {} },
        roles: ROLES,
        classifiedFields: [{ name: "memo", classification: "internal" }],
        writtenKeys: ["memo"],
      }),
    ).toBeNull();
  });

  it("refuses commercial_sensitive, which is sensitive and not PHI", () => {
    expect(
      maskWrite({
        mode: "classified",
        principal: principal("clerk"),
        entityPerms: { fields: {} },
        roles: ROLES,
        classifiedFields: [{ name: "unit_cost", classification: "commercial_sensitive" }],
        writtenKeys: ["unit_cost"],
      })?.field,
    ).toBe("unit_cost");
  });

  it("still ignores an ordinary field", () => {
    expect(mask("classified", "clerk", ["status"])).toBeNull();
  });
});
