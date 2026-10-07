import type { AbacEvaluationInput, AbacEvaluator, RoleDefinition } from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";
import {
  MapRedactionRegistry,
  RESPONSE_RECORD_SHAPES,
  computeRedactedFields,
  computeResponseRedaction,
  redactJsonValue,
  redactRecords,
  redactableResponseShapes,
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

/** ADR-0341: an obligation is refused before any evaluator runs when attributes were never resolved. */
function resolvedPrincipal(
  role: string,
  abacAttributes: Readonly<Record<string, unknown>> = {},
): ResolvedPrincipal {
  return { ...principal(role), abacAttributes };
}

const spec: ResponseRedactionSpec = {
  classifiedFields: [
    { name: "mrn", classification: "phi" },
    { name: "given_name", classification: "pii" },
    { name: "status" },
  ],
  roles: ROLES,
  rolesForPrincipal: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  recordShape: "record",
  policy: { privilegedRoles: ["clinician"] },
};

/**
 * A field `read` grant naming the caller's role and qualified by a policy key, so the role check
 * passes and the obligation is the only thing that can decide. The evaluator is a real record
 * predicate: `mrn` is readable only on a patient in the principal's own department.
 */
function departmentSpec(
  recordShape: ResponseRedactionSpec["recordShape"],
  seen?: AbacEvaluationInput[],
): ResponseRedactionSpec {
  const evaluator: AbacEvaluator = (input) => {
    seen?.push(input);
    if (input.record === undefined) return "deferred";
    const principalDept = input.principal.abacAttributes?.["department"];
    return input.record["department"] === principalDept ? "satisfied" : "denied";
  };
  return {
    classifiedFields: [
      { name: "mrn", classification: "phi" },
      { name: "given_name", classification: "pii" },
    ],
    roles: ROLES,
    rolesForPrincipal: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    recordShape,
    entityPermissions: {
      fields: { mrn: { read: { roles: ["clinician"], abac: "p.same_dept" } } },
    },
    policy: { privilegedRoles: ["clinician"] },
    abac: { entity: "Patient", evaluator },
  };
}

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

describe("computeResponseRedaction", () => {
  it("defers nothing when no grant carries an obligation", () => {
    expect(computeResponseRedaction(spec, principal("front_desk"))).toEqual({
      redacted: ["mrn", "given_name"],
      deferred: [],
    });
  });

  it("defers a record-bearing obligation asked with no record", () => {
    const s = departmentSpec("record");
    const result = computeResponseRedaction(s, resolvedPrincipal("clinician", { department: "a" }));
    expect(result.redacted).toContain("mrn");
    expect(result.deferred).toEqual(["mrn"]);
  });

  it("keeps `deferred` a subset of `redacted`", () => {
    const s = departmentSpec("record");
    const result = computeResponseRedaction(s, resolvedPrincipal("clinician", { department: "a" }));
    for (const field of result.deferred) expect(result.redacted).toContain(field);
  });

  it("does not defer a refusal a record cannot change", () => {
    // `front_desk` fails the grant's role check, so the obligation is never asked and re-asking
    // with a record could not help.
    const s = departmentSpec("record");
    const result = computeResponseRedaction(s, resolvedPrincipal("front_desk", { department: "a" }));
    expect(result.redacted).toContain("mrn");
    expect(result.deferred).toEqual([]);
  });

  it("threads the record to the evaluator verbatim", () => {
    // `toBe`, not `toEqual`: the stage is a courier, and a structural assertion would pass against
    // a defensive copy — which would quietly break a policy comparing by reference or reading a
    // non-enumerable field.
    const seen: AbacEvaluationInput[] = [];
    const s = departmentSpec("record", seen);
    const record = { id: "p1", department: "clinical" };
    computeResponseRedaction(s, resolvedPrincipal("clinician", { department: "clinical" }), record);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.record).toBe(record);
  });

  it("omits the record key entirely when the caller had none", () => {
    // Absent means "the caller had no record", never "an empty record" — `{}` would let a policy be
    // answered against fields nobody loaded.
    const seen: AbacEvaluationInput[] = [];
    const s = departmentSpec("record", seen);
    computeResponseRedaction(s, resolvedPrincipal("clinician", { department: "clinical" }));
    expect(seen).toHaveLength(1);
    expect(seen[0] !== undefined && "record" in seen[0]).toBe(false);
  });

  it("returns an obligated field once a matching record discharges it", () => {
    const s = departmentSpec("record");
    const result = computeResponseRedaction(
      s,
      resolvedPrincipal("clinician", { department: "clinical" }),
      { id: "p1", department: "clinical" },
    );
    expect(result.redacted).not.toContain("mrn");
    expect(result.deferred).toEqual([]);
  });

  it("keeps an obligated field redacted when the record does not match", () => {
    const s = departmentSpec("record");
    const result = computeResponseRedaction(
      s,
      resolvedPrincipal("clinician", { department: "clinical" }),
      { id: "p2", department: "billing" },
    );
    expect(result.redacted).toContain("mrn");
    // `denied` is not a deferral: a different record might match, but this one answered.
    expect(result.deferred).toEqual([]);
  });
});

describe("RESPONSE_RECORD_SHAPES", () => {
  it("is exactly record, page and none", () => {
    expect(RESPONSE_RECORD_SHAPES).toEqual(["record", "page", "none"]);
  });

  it("has one redactor per shape and no others", () => {
    expect([...redactableResponseShapes()].sort()).toEqual([...RESPONSE_RECORD_SHAPES].sort());
  });
});

describe("redactRecords", () => {
  const base = new Set(["mrn", "given_name"]);
  /** Discloses `mrn` on a clinical record, and nothing on anything else. */
  const byDepartment = (record: Readonly<Record<string, unknown>> | null): ReadonlySet<string> =>
    record !== null && record["department"] === "clinical" ? new Set(["given_name"]) : base;

  it("gives two records in one page different field sets", () => {
    // The headline: one response, two rows, two answers. `p1` is in the principal's department so
    // its `mrn` is disclosed; `p2` is not, so its `mrn` is withheld — which the single pre-ADR-0342
    // field set could not express at all.
    const out = redactRecords(
      "page",
      {
        data: [
          { id: "p1", department: "clinical", mrn: "MRN-1", given_name: "Ada", status: "active" },
          { id: "p2", department: "billing", mrn: "MRN-2", given_name: "Linus", status: "active" },
        ],
        page: { limit: 50, nextCursor: "abc" },
      },
      byDepartment,
    );
    expect(out).toEqual({
      data: [
        { id: "p1", department: "clinical", mrn: "MRN-1", status: "active" },
        { id: "p2", department: "billing", status: "active" },
      ],
      page: { limit: 50, nextCursor: "abc" },
    });
  });

  it("leaves the page wrapper's own keys untouched", () => {
    const out = redactRecords("page", { data: [], page: { limit: 50, nextCursor: null } }, () => base);
    expect(out).toEqual({ data: [], page: { limit: 50, nextCursor: null } });
  });

  it("redacts a record body with its own set", () => {
    expect(
      redactRecords(
        "record",
        { id: "p1", department: "clinical", mrn: "MRN-1", given_name: "Ada" },
        byDepartment,
      ),
    ).toEqual({ id: "p1", department: "clinical", mrn: "MRN-1" });
  });

  it("applies the base set to a `none`-shaped body", () => {
    expect(redactRecords("none", { count: 3, mrn: "leaked" }, byDepartment)).toEqual({ count: 3 });
  });

  it("still walks nested objects inside a record", () => {
    expect(
      redactRecords(
        "record",
        { id: "p1", department: "billing", contact: { mrn: "MRN-1", email: "a@b.c" } },
        byDepartment,
      ),
    ).toEqual({ id: "p1", department: "billing", contact: { email: "a@b.c" } });
  });

  describe("fail-closed fallbacks", () => {
    // Every one of these takes the record-free set, which is the stricter of the two by
    // construction: the per-record pass can only relax it.
    it("falls back to the base set for a non-object `record` body", () => {
      expect(redactRecords("record", "a string", byDepartment)).toBe("a string");
      expect(redactRecords("record", null, byDepartment)).toBe(null);
      expect(
        redactRecords("record", [{ department: "clinical", mrn: "MRN-1" }], byDepartment),
      ).toEqual([{ department: "clinical" }]);
    });

    it("falls back to the base set for a page with no `data` array", () => {
      expect(
        redactRecords("page", { department: "clinical", mrn: "MRN-1" }, byDepartment),
      ).toEqual({ department: "clinical" });
      expect(
        redactRecords("page", { data: { department: "clinical", mrn: "MRN-1" } }, byDepartment),
      ).toEqual({ data: { department: "clinical" } });
    });

    it("falls back to the base set for a non-object element of `data`", () => {
      // The nested element is an array, not a record, so it takes the base set and its own inner
      // object loses `mrn` — where a plain-object sibling in the same `data` keeps it on its own
      // answer. That is the fallback being observably stricter, not merely different.
      const out = redactRecords(
        "page",
        {
          data: [
            [{ department: "clinical", mrn: "MRN-nested" }],
            { department: "clinical", mrn: "MRN-1" },
          ],
        },
        byDepartment,
      );
      expect(out).toEqual({
        data: [[{ department: "clinical" }], { department: "clinical", mrn: "MRN-1" }],
      });
    });
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
