import type { Entity } from "@crossengin/types/meta-schema";
import type { EntityPermissions, RoleDefinition } from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";
import { computeRedactedFields } from "./redaction.js";
import {
  redactionRegistryFromManifest,
  redactionSpecForEntity,
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
  it("registers specs for classified entities under the default operation convention", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, { rolesForPrincipal, policyForEntity });
    expect(registry.specFor("patient.read")).not.toBeNull();
    expect(registry.specFor("patient.list")).not.toBeNull();
    expect(registry.specFor("patient.get")).not.toBeNull();
  });

  it("skips entities with no classified fields", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, { rolesForPrincipal, policyForEntity });
    expect(registry.specFor("widget.read")).toBeNull();
    expect(registry.specFor("widget.list")).toBeNull();
  });

  it("redacts PHI/PII for a non-privileged role and reveals for a privileged one", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, { rolesForPrincipal, policyForEntity });
    const spec = registry.specFor("patient.read");
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect([...computeRedactedFields(spec, principal("front_desk"))].sort()).toEqual([
      "given_name",
      "mrn",
    ]);
    expect(computeRedactedFields(spec, principal("clinician"))).toEqual([]);
  });

  it("threads the entity permissions into the spec", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, { rolesForPrincipal, policyForEntity });
    expect(registry.specFor("patient.read")?.entityPermissions).toBe(PATIENT_PERMS);
  });

  it("honours a custom operationsForEntity mapping", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, {
      rolesForPrincipal,
      policyForEntity,
      operationsForEntity: (name) => (name === "Patient" ? ["v1.patients.search"] : []),
    });
    expect(registry.specFor("v1.patients.search")).not.toBeNull();
    expect(registry.specFor("patient.read")).toBeNull();
  });

  it("omits a policy when none is supplied (fail-closed for everyone)", () => {
    const registry = redactionRegistryFromManifest(MANIFEST, { rolesForPrincipal });
    const spec = registry.specFor("patient.read");
    if (spec === null) throw new Error("expected spec");
    // no privileged roles -> sensitive fields redacted even for clinician
    expect([...computeRedactedFields(spec, principal("clinician"))].sort()).toEqual([
      "given_name",
      "mrn",
    ]);
  });
});
