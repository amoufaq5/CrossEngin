import type { Entity } from "@crossengin/types/meta-schema";
import type {
  AbacBatchEvaluator,
  AbacEvaluator,
  EntityPermissions,
  RoleDefinition,
} from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";
import { computeRedactedFields } from "./redaction.js";
import {
  RedactionCoverageError,
  redactionRegistryFromManifest,
  redactionSpecForEntity,
  type RedactedOperation,
  type RedactionManifestInput,
} from "./manifest-redaction.js";

const PATIENT: Entity = {
  name: "Patient",
  traits: ["auditable"],
  fields: [
    { name: "id", type: { kind: "uuid" } },
    { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
    { name: "given_name", type: { kind: "text", maxLength: 100 }, classification: "pii" },
    { name: "status", type: { kind: "text", maxLength: 20 } },
  ],
};

const WIDGET: Entity = {
  name: "Widget",
  fields: [{ name: "label", type: { kind: "text", maxLength: 20 } }],
};

const ROLES: Readonly<Record<string, RoleDefinition>> = {
  clinician: { name: "clinician" },
  front_desk: { name: "front_desk" },
};

const PATIENT_PERMS: EntityPermissions = {
  read: { roles: ["clinician", "front_desk"] },
};

const MANIFEST: RedactionManifestInput = {
  entities: [PATIENT, WIDGET],
  permissions: { Patient: PATIENT_PERMS },
  roles: ROLES,
};

const rolesForPrincipal = (p: ResolvedPrincipal | null) => ({
  primaryRole: p?.grantedScopes[0] ?? "anonymous",
});

const policyForEntity = () => ({ privilegedRoles: ["clinician"] });

// `operationsForEntity` is required and has no default: a mapping computed from the entity name
// cannot name a lifecycle transition (its id comes from the manifest's workflow), so every default
// is wrong for exactly the write operations whose responses carry the record. This fixture plays
// the part `compileOperateServer` plays in production — every operation serving the entity, each
// with the shape of its own response, which the id itself does not say.
function crudOperations(prefix: string): readonly RedactedOperation[] {
  return [
    { operationId: `${prefix}.list`, recordShape: "page" },
    { operationId: `${prefix}.create`, recordShape: "record" },
    { operationId: `${prefix}.read`, recordShape: "record" },
    { operationId: `${prefix}.update`, recordShape: "record" },
    { operationId: `${prefix}.delete`, recordShape: "none" },
  ];
}
const OPS: Readonly<Record<string, readonly RedactedOperation[]>> = {
  Patient: [...crudOperations("patient"), { operationId: "patient.admit", recordShape: "record" }],
  Widget: crudOperations("widget"),
};
const operationsForEntity = (name: string): readonly RedactedOperation[] => OPS[name] ?? [];

/**
 * A principal whose attribute lookup actually happened. Since ADR-0341 an obligation is refused
 * before any evaluator is consulted when `abacAttributes` is absent, so a test that means to
 * exercise a policy has to resolve them — an absent record is "nobody looked", not "has none".
 */
function resolvedPrincipal(
  role: string,
  abacAttributes: Readonly<Record<string, unknown>> = {},
): ResolvedPrincipal {
  return { ...principal(role), abacAttributes };
}

function principal(role: string): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-000000000001",
    tenantId: "00000000-0000-4000-8000-0000000000aa",
    principalKind: "user",
    authScheme: "bearer_jwt",
    grantedScopes: [role],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

describe("redactionSpecForEntity", () => {
  it("returns null for an entity with no classified fields", () => {
    expect(redactionSpecForEntity(WIDGET, new Map(), { rolesForPrincipal })).toBeNull();
  });

  it("builds a spec from the entity's classified fields", () => {
    const spec = redactionSpecForEntity(PATIENT, new Map(Object.entries(ROLES)), {
      rolesForPrincipal,
      policyForEntity,
    });
    expect(spec?.classifiedFields).toEqual([
      { name: "mrn", classification: "phi" },
      { name: "given_name", classification: "pii" },
    ]);
  });
});

describe("redactionRegistryFromManifest", () => {
  it("registers the spec against every operation the caller names, writes and transitions included", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity,
    });
    for (const op of OPS["Patient"] ?? []) {
      expect(registry.specFor(op.operationId), op.operationId).not.toBeNull();
    }
  });

  it("registers each operation's own response shape", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity,
    });
    expect(registry.specFor("patient.list")?.recordShape).toBe("page");
    expect(registry.specFor("patient.read")?.recordShape).toBe("record");
    expect(registry.specFor("patient.admit")?.recordShape).toBe("record");
    expect(registry.specFor("patient.delete")?.recordShape).toBe("none");
  });

  it("registers nothing for an operationId the caller did not name", () => {
    // The inverse of the phantom `<entity>.get` the deleted default emitted: a spec is keyed off
    // the caller's derived ids and never off a convention, so an id no route serves stays unknown.
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity,
    });
    expect(registry.specFor("patient.get")).toBeNull();
    expect(registry.specFor("patient.search")).toBeNull();
  });

  it("skips entities with no classified fields", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity,
    });
    expect(registry.specFor("widget.read")).toBeNull();
    expect(registry.specFor("widget.update")).toBeNull();
  });

  it("refuses when a classified entity has no operation to register against", () => {
    // Fail closed: an empty list would leave the entity's records unredacted on every route that
    // serves them, and report success. The refusal names the entity.
    expect(() =>
      redactionRegistryFromManifest(MANIFEST, {
        rolesForPrincipal,
        policyForEntity,
        operationsForEntity: () => [],
      }),
    ).toThrow(RedactionCoverageError);
    expect(() =>
      redactionRegistryFromManifest(MANIFEST, {
        rolesForPrincipal,
        policyForEntity,
        operationsForEntity: () => [],
      }),
    ).toThrow(/Patient/);
  });

  it("redacts PHI/PII for a non-privileged role and reveals for a privileged one, on a write op", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity,
    });
    const spec = registry.specFor("patient.update");
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect([...computeRedactedFields(spec, principal("front_desk"))].sort()).toEqual([
      "given_name",
      "mrn",
    ]);
    expect(computeRedactedFields(spec, principal("clinician"))).toEqual([]);
  });

  it("threads the entity permissions into the spec", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity,
    });
    expect(registry.specFor("patient.read")?.entityPermissions).toBe(PATIENT_PERMS);
  });

  it("shares every member but the shape across an entity's operations", () => {
    // ADR-0338's identity assertion, weakened exactly as far as ADR-0342 forces and no further:
    // `recordShape` is a property of the *operation*, so the spec objects differ — but each is a
    // spread of one base, so the members that make it expensive to build are still the same
    // references. Asserting that keeps the sharing that does hold pinned, rather than dropping the
    // test and letting a future change rebuild the classified-field list per operation unnoticed.
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity,
    });
    const read = registry.specFor("patient.read");
    const create = registry.specFor("patient.create");
    const list = registry.specFor("patient.list");
    const admit = registry.specFor("patient.admit");
    if (read === null || create === null || list === null || admit === null) {
      throw new Error("expected specs");
    }
    for (const other of [create, list, admit]) {
      expect(other).not.toBe(read);
      expect(other.classifiedFields).toBe(read.classifiedFields);
      expect(other.entityPermissions).toBe(read.entityPermissions);
      expect(other.roles).toBe(read.roles);
      expect(other.rolesForPrincipal).toBe(read.rolesForPrincipal);
      expect(other.policy).toBe(read.policy);
      expect(other.abac).toBe(read.abac);
    }
    expect(list.recordShape).not.toBe(read.recordShape);
  });

  it("honours a custom operationsForEntity mapping", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity: (name) =>
        name === "Patient" ? [{ operationId: "v1.patients.search", recordShape: "page" }] : [],
    });
    expect(registry.specFor("v1.patients.search")).not.toBeNull();
    expect(registry.specFor("patient.read")).toBeNull();
  });

  it("omits a policy when none is supplied (fail-closed for everyone)", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, { rolesForPrincipal, operationsForEntity });
    const spec = registry.specFor("patient.read");
    if (spec === null) throw new Error("expected spec");
    // no privileged roles -> sensitive fields redacted even for clinician
    expect([...computeRedactedFields(spec, principal("clinician"))].sort()).toEqual([
      "given_name",
      "mrn",
    ]);
  });

  describe("abac obligations (ADR-0340)", () => {
    // An explicit field `read` grant naming the caller's role, qualified by a policy key. The role
    // check passes, so the obligation is the only thing that can decide.
    const OBLIGATED: RedactionManifestInput = {
      ...MANIFEST,
      permissions: {
        Patient: {
          read: { roles: ["clinician"] },
          fields: { mrn: { read: { roles: ["clinician"], abac: "p.owns_encounter" } } },
        },
      },
    };
    const specOf = (input: RedactionManifestInput, evaluator?: AbacEvaluator) =>
      redactionRegistryFromManifest(input, {
        rolesForPrincipal,
        operationsForEntity,
        ...(evaluator !== undefined ? { abacEvaluator: evaluator } : {}),
      }).specFor("patient.read");

    it("carries the entity unconditionally, with only the evaluator optional", () => {
      expect(specOf(MANIFEST)?.abac).toEqual({ entity: "Patient" });
      const evaluator: AbacEvaluator = () => "satisfied";
      expect(specOf(MANIFEST, evaluator)?.abac).toEqual({ entity: "Patient", evaluator });
    });

    it("redacts an obligated field when no evaluator can discharge it", () => {
      const spec = specOf(OBLIGATED);
      if (spec === null) throw new Error("expected spec");
      expect(computeRedactedFields(spec, principal("clinician"))).toContain("mrn");
    });

    it("returns an obligated field only on `satisfied`", () => {
      for (const outcome of ["denied", "undischargeable"] as const) {
        const spec = specOf(OBLIGATED, () => outcome);
        if (spec === null) throw new Error("expected spec");
        expect(computeRedactedFields(spec, resolvedPrincipal("clinician"))).toContain("mrn");
      }
      const ok = specOf(OBLIGATED, () => "satisfied");
      if (ok === null) throw new Error("expected spec");
      expect(computeRedactedFields(ok, resolvedPrincipal("clinician"))).not.toContain("mrn");
    });

    it("redacts an obligated field even on `satisfied` when attributes were never resolved", () => {
      // ADR-0341: the registry passes the resolved principal's attributes through, and an absent
      // record refuses the obligation before the evaluator runs — so a deployment with a policy but
      // no attribute directory redacts rather than answering from an input nobody gathered.
      const seen: string[] = [];
      const spec = specOf(OBLIGATED, () => {
        seen.push("called");
        return "satisfied";
      });
      if (spec === null) throw new Error("expected spec");
      expect(computeRedactedFields(spec, principal("clinician"))).toContain("mrn");
      expect(seen).toEqual([]);
    });

    it("asks the evaluator about the right entity, operation and field", () => {
      const seen: string[] = [];
      const spec = specOf(OBLIGATED, (input) => {
        seen.push(`${input.policyKey}|${input.entity}|${String(input.operation)}|${input.field ?? "-"}`);
        return "satisfied";
      });
      if (spec === null) throw new Error("expected spec");
      computeRedactedFields(spec, resolvedPrincipal("clinician", { department: "clinical" }));
      expect(seen).toEqual(["p.owns_encounter|Patient|read|mrn"]);
    });

    it("does not consult the evaluator for an unobligated grant", () => {
      let calls = 0;
      const spec = specOf(MANIFEST, () => {
        calls += 1;
        return "denied";
      });
      if (spec === null) throw new Error("expected spec");
      computeRedactedFields(spec, principal("clinician"));
      expect(calls).toBe(0);
    });

    describe("the batch evaluator, which is a sibling and not a replacement", () => {
      const evaluator: AbacEvaluator = () => "satisfied";
      const evaluateBatch: AbacBatchEvaluator = (inputs) =>
        inputs.map((_input, index) => ({ index, outcome: "satisfied" as const }));

      const specWith = (options: {
        readonly abacEvaluator?: AbacEvaluator;
        readonly abacBatchEvaluator?: AbacBatchEvaluator;
      }) =>
        redactionRegistryFromManifest(OBLIGATED, {
          rolesForPrincipal,
          operationsForEntity,
          ...options,
        }).specFor("patient.read");

      it("is absent from the spec when none is supplied", () => {
        // Not merely undefined: absent, so a deployment that declared no batch gets an enforcement
        // object indistinguishable from the one it got before the option existed.
        const spec = specWith({ abacEvaluator: evaluator });
        expect(spec?.abac).toEqual({ entity: "Patient", evaluator });
        expect(spec?.abac !== undefined && "evaluateBatch" in spec.abac).toBe(false);
      });

      it("rides onto the spec beside the single evaluator when supplied", () => {
        expect(specWith({ abacEvaluator: evaluator, abacBatchEvaluator: evaluateBatch })?.abac)
          .toEqual({ entity: "Patient", evaluator, evaluateBatch });
      });

      it("rides on alone, and leaves an obligated field redacted", () => {
        // Supplied without `abacEvaluator` it is carried faithfully rather than promoted into its
        // place, and the obligation stays undischargeable — the batch answers the fan-out of a
        // policy layer that exists, never the absence of one.
        const spec = specWith({ abacBatchEvaluator: evaluateBatch });
        expect(spec?.abac).toEqual({ entity: "Patient", evaluateBatch });
        if (spec === null) throw new Error("expected spec");
        expect(computeRedactedFields(spec, resolvedPrincipal("clinician"))).toContain("mrn");
      });
    });
  });
});
