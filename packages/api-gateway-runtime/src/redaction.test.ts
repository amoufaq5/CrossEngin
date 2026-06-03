import type { RoleDefinition } from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";
import {
  MapRedactionRegistry,
  computeRedactedFields,
  redactJsonValue,
  type ResponseRedactionSpec,
} from "./redaction.js";

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["clinician", { name: "clinician" }],
  ["front_desk", { name: "front_desk" }],
]);

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

const spec: ResponseRedactionSpec = {
  classifiedFields: [
    { name: "mrn", classification: "phi" },
    { name: "given_name", classification: "pii" },
    { name: "status" },
  ],
  roles: ROLES,
  rolesForPrincipal: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  policy: { privilegedRoles: ["clinician"] },
};

describe("computeRedactedFields", () => {
  it("redacts sensitive fields for a non-privileged principal", () => {
    expect([...computeRedactedFields(spec, principal("front_desk"))].sort()).toEqual([
      "given_name",
      "mrn",
    ]);
  });

  it("redacts nothing for a privileged principal", () => {
    expect(computeRedactedFields(spec, principal("clinician"))).toEqual([]);
  });

  it("treats a null principal as unprivileged", () => {
    expect([...computeRedactedFields(spec, null)].sort()).toEqual(["given_name", "mrn"]);
  });
});

describe("redactJsonValue", () => {
  const redacted = new Set(["mrn", "given_name"]);

  it("strips redacted keys from a single record", () => {
    expect(redactJsonValue({ mrn: "X1", given_name: "Ada", status: "active" }, redacted)).toEqual({
      status: "active",
    });
  });

  it("strips redacted keys from every element of an array", () => {
    const out = redactJsonValue(
      [
        { mrn: "X1", status: "active" },
        { mrn: "X2", status: "inactive" },
      ],
      redacted,
    );
    expect(out).toEqual([{ status: "active" }, { status: "inactive" }]);
  });

  it("handles a { data: [...] } list wrapper", () => {
    const out = redactJsonValue(
      { data: [{ mrn: "X1", status: "active" }], cursor: "abc" },
      redacted,
    );
    expect(out).toEqual({ data: [{ status: "active" }], cursor: "abc" });
  });

  it("is a no-op when nothing is redacted", () => {
    const body = { mrn: "X1" };
    expect(redactJsonValue(body, new Set())).toBe(body);
  });

  it("leaves primitives untouched", () => {
    expect(redactJsonValue("hello", redacted)).toBe("hello");
    expect(redactJsonValue(42, redacted)).toBe(42);
  });
});

describe("MapRedactionRegistry", () => {
  it("returns a registered spec and null otherwise", () => {
    const registry = new MapRedactionRegistry().register("patients.read", spec);
    expect(registry.specFor("patients.read")).toBe(spec);
    expect(registry.specFor("invoices.read")).toBeNull();
  });
});
