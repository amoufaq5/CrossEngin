import type {
  AbacBatchEvaluator,
  AbacEvaluationInput,
  AbacEvaluator,
  AbacOutcome,
  RoleDefinition,
} from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";
import {
  MapRedactionRegistry,
  RESPONSE_RECORD_SHAPES,
  computeRedactedFields,
  computeResponseRedaction,
  computeResponseRedactionForRecords,
  recordsIn,
  redactJsonValue,
  redactRecords,
  redactableResponseShapes,
  type ResponseRecordShape,
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

/** `mrn` and `given_name` are readable only on a record in the principal's own department. */
function sameDepartment(input: AbacEvaluationInput): AbacOutcome {
  if (input.record === undefined) return "deferred";
  return input.record["department"] === input.principal.abacAttributes?.["department"]
    ? "satisfied"
    : "denied";
}

/**
 * Two obligated fields, not one, because the batch's whole claim is a count: with F = 1 a pooled
 * call and a per-record call are indistinguishable. Both evaluators answer through one predicate,
 * so a difference in the bytes is a difference in the plumbing and never in two hand-written rules.
 *
 * `batchCalls` present is what switches the batch arm on, so one helper serves both regimes.
 */
function twoFieldSpec(
  recordShape: ResponseRecordShape,
  single: AbacEvaluationInput[],
  batchCalls?: (readonly AbacEvaluationInput[])[],
): ResponseRedactionSpec {
  const evaluator: AbacEvaluator = (input) => {
    single.push(input);
    return sameDepartment(input);
  };
  const evaluateBatch: AbacBatchEvaluator = (inputs) => {
    batchCalls?.push(inputs);
    return inputs.map((input, index) => ({ index, outcome: sameDepartment(input) }));
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
      fields: {
        mrn: { read: { roles: ["clinician"], abac: "p.same_dept" } },
        given_name: { read: { roles: ["clinician"], abac: "p.same_dept" } },
      },
    },
    policy: { privilegedRoles: ["clinician"] },
    abac: {
      entity: "Patient",
      evaluator,
      ...(batchCalls !== undefined ? { evaluateBatch } : {}),
    },
  };
}

const CLINICAL = { id: "p1", department: "clinical" };
const BILLING = { id: "p2", department: "billing" };

describe("computeResponseRedactionForRecords", () => {
  const clinician = () => resolvedPrincipal("clinician", { department: "clinical" });

  it("returns an empty list for no records, and asks nothing", () => {
    const single: AbacEvaluationInput[] = [];
    const batchCalls: (readonly AbacEvaluationInput[])[] = [];
    expect(
      computeResponseRedactionForRecords(
        twoFieldSpec("page", single, batchCalls),
        clinician(),
        [],
      ),
    ).toEqual([]);
    expect(single).toEqual([]);
    expect(batchCalls).toEqual([]);
  });

  it("is positionally aligned with its records", () => {
    const results = computeResponseRedactionForRecords(
      twoFieldSpec("page", []),
      clinician(),
      [CLINICAL, BILLING, CLINICAL],
    );
    expect(results).toHaveLength(3);
    expect(results[0]?.redacted).toEqual([]);
    expect([...(results[1]?.redacted ?? [])].sort()).toEqual(["given_name", "mrn"]);
    expect(results[2]?.redacted).toEqual([]);
  });

  it("answers elementwise exactly as N separate singular calls do", () => {
    // The equality that lets one call replace N: the plural is a cost change and never a semantic
    // one, so if an evaluator is batched the answers must be indistinguishable from the slow path's.
    const records = [CLINICAL, BILLING, { id: "p3", department: "clinical" }];
    const plural = computeResponseRedactionForRecords(
      twoFieldSpec("page", []),
      clinician(),
      records,
    );
    const singular = records.map((record) =>
      computeResponseRedaction(twoFieldSpec("page", []), clinician(), record),
    );
    expect(plural).toEqual(singular);
  });

  it("treats a `null` element exactly as an absent record", () => {
    const plural = computeResponseRedactionForRecords(
      twoFieldSpec("page", []),
      clinician(),
      [null, CLINICAL],
    );
    // A deferral, not a denial: nothing was decided, so the record-free pass's own answer.
    expect(plural[0]).toEqual(computeResponseRedaction(twoFieldSpec("page", []), clinician()));
    expect(plural[0]?.deferred.length).toBeGreaterThan(0);
    expect(plural[1]?.redacted).toEqual([]);
  });

  it("pools every record × field request into one batch call", () => {
    const single: AbacEvaluationInput[] = [];
    const batchCalls: (readonly AbacEvaluationInput[])[] = [];
    const records = [CLINICAL, BILLING, { id: "p3", department: "clinical" }];
    computeResponseRedactionForRecords(
      twoFieldSpec("page", single, batchCalls),
      clinician(),
      records,
    );
    expect(batchCalls).toHaveLength(1);
    // 3 records × 2 obligated fields.
    expect(batchCalls[0]).toHaveLength(6);
    expect(single).toEqual([]);
    // Compared as a set, not a sequence: pooling order is not part of the contract — the answers
    // come back indexed — and pinning it here would fail a record-major pool against a field-major
    // one for no reason. What matters is that every cell is in the one call.
    expect(
      [...(batchCalls[0] ?? [])]
        .map((input) => `${String(input.record?.["id"])}|${input.field ?? "-"}`)
        .sort(),
    ).toEqual([
      "p1|given_name",
      "p1|mrn",
      "p2|given_name",
      "p2|mrn",
      "p3|given_name",
      "p3|mrn",
    ]);
  });

  it("falls back to the single evaluator once per request when no batch is supplied", () => {
    const single: AbacEvaluationInput[] = [];
    computeResponseRedactionForRecords(twoFieldSpec("page", single), clinician(), [
      CLINICAL,
      BILLING,
    ]);
    expect(single).toHaveLength(4);
  });

  it("answers the same with and without a batch evaluator", () => {
    const records = [CLINICAL, BILLING];
    const batched = computeResponseRedactionForRecords(
      twoFieldSpec("page", [], []),
      clinician(),
      records,
    );
    expect(batched).toEqual(
      computeResponseRedactionForRecords(twoFieldSpec("page", []), clinician(), records),
    );
  });

  it("does not let the spec's own `record` reach the plural evaluator", () => {
    // The records travel in the array, so the enforcement handed down carries none — a spec-level
    // record would otherwise answer for every position whose own record is absent.
    const single: AbacEvaluationInput[] = [];
    const spec = twoFieldSpec("page", single);
    const withSpecRecord: ResponseRedactionSpec = {
      ...spec,
      abac: { ...spec.abac, entity: "Patient", record: CLINICAL },
    };
    const results = computeResponseRedactionForRecords(withSpecRecord, clinician(), [null]);
    expect([...(results[0]?.redacted ?? [])].sort()).toEqual(["given_name", "mrn"]);
    expect(results[0]?.deferred.length).toBeGreaterThan(0);
    expect(single.every((input) => input.record === undefined)).toBe(true);
  });
});

/** What `redactRecords` actually asks about, so enumeration can be compared against the rebuild. */
function askedRecords(
  shape: ResponseRecordShape,
  body: unknown,
  base: ReadonlySet<string>,
): readonly Readonly<Record<string, unknown>>[] {
  const asked: Readonly<Record<string, unknown>>[] = [];
  redactRecords(shape, body, (record) => {
    if (record !== null) asked.push(record);
    return base;
  });
  return asked;
}

describe("recordsIn", () => {
  it("yields the body itself for a `record` shape", () => {
    const body = { id: "p1", mrn: "MRN-1" };
    expect(recordsIn("record", body)).toEqual([body]);
    expect(recordsIn("record", body)[0]).toBe(body);
  });

  it("yields nothing for a `record` shape whose body is not an object", () => {
    expect(recordsIn("record", null)).toEqual([]);
    expect(recordsIn("record", "a string")).toEqual([]);
    expect(recordsIn("record", [{ mrn: "MRN-1" }])).toEqual([]);
  });

  it("yields each plain-object element of `data`, in order", () => {
    const rows = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
    const found = recordsIn("page", { data: rows, page: { limit: 50 } });
    expect(found).toHaveLength(3);
    found.forEach((record, index) => expect(record).toBe(rows[index]));
  });

  it("skips non-object elements of `data`", () => {
    const row = { id: "p1" };
    expect(recordsIn("page", { data: ["x", 1, null, [row], row] })).toEqual([row]);
  });

  it("yields nothing for a page it cannot find records in", () => {
    expect(recordsIn("page", { mrn: "MRN-1" })).toEqual([]);
    expect(recordsIn("page", { data: { mrn: "MRN-1" } })).toEqual([]);
    expect(recordsIn("page", "a string")).toEqual([]);
    expect(recordsIn("page", null)).toEqual([]);
  });

  it("yields nothing for a `none` shape, whatever the body", () => {
    expect(recordsIn("none", { count: 3 })).toEqual([]);
    expect(recordsIn("none", { data: [{ id: "p1" }] })).toEqual([]);
    expect(recordsIn("none", null)).toEqual([]);
  });

  describe("agreement with the rebuild", () => {
    // The property the identity-keyed map in `applyResponseRedaction` rests on. It holds by
    // construction — `recordsIn` *runs* `redactRecords` — and this asserts it against a realistic
    // field set rather than the empty one the enumeration uses, which is where the two could in
    // principle part company.
    const base: ReadonlySet<string> = new Set(["mrn", "given_name"]);
    const bodies: readonly [string, ResponseRecordShape, unknown][] = [
      ["a record", "record", { id: "p1", mrn: "MRN-1" }],
      ["a non-object record body", "record", "a string"],
      ["a null record body", "record", null],
      ["an array record body", "record", [{ id: "p1" }]],
      ["a page", "page", { data: [{ id: "p1" }, { id: "p2" }], page: { limit: 50 } }],
      ["a page with mixed elements", "page", { data: [{ id: "p1" }, "x", [{ id: "p2" }]] }],
      ["a page with no data key", "page", { mrn: "MRN-1" }],
      ["a page whose data is not an array", "page", { data: { id: "p1" } }],
      ["a non-object page body", "page", 42],
      ["a none body", "none", { count: 3, mrn: "MRN-1" }],
      ["a none body carrying rows", "none", { data: [{ id: "p1" }] }],
    ];

    for (const [label, shape, body] of bodies) {
      it(`enumerates exactly what the rebuild asks about for ${label}`, () => {
        expect(askedRecords(shape, body, base)).toEqual(recordsIn(shape, body));
      });
    }

    it("enumerates a superset when the record-free set names a wrapper key", () => {
      // A classified field literally called `data` stops the rebuild descending into the array, so
      // it asks about no record at all while the enumeration still finds them. Superset, never the
      // other way round, which is the direction the identity lookup can survive: a spare entry in
      // the map costs nothing, a missing one would take the fail-closed fallback.
      const row = { id: "p1", mrn: "MRN-1" };
      const body = { data: [row], page: { limit: 50 } };
      expect(askedRecords("page", body, new Set(["data"]))).toEqual([]);
      expect(recordsIn("page", body)).toEqual([row]);
      expect(redactRecords("page", body, () => new Set(["data"]))).toEqual({ page: { limit: 50 } });
    });

    it("enumerates one position per appearance when a record is aliased", () => {
      const row = { id: "p1", department: "clinical" };
      const body = { data: [row, row] };
      const found = recordsIn("page", body);
      expect(found).toHaveLength(2);
      expect(found[0]).toBe(row);
      expect(found[1]).toBe(row);
    });
  });
});

describe("MapRedactionRegistry", () => {
  it("returns a registered spec and null otherwise", () => {
    const registry = new MapRedactionRegistry().register("patients.read", spec);
    expect(registry.specFor("patients.read")).toBe(spec);
    expect(registry.specFor("invoices.read")).toBeNull();
  });
});
