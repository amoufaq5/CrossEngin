import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import type { StoreKind } from "./cli.js";
import {
  formatUniqueEnforcementReport,
  surveyUniqueEnforcement,
  UNIQUE_ENFORCEMENT_MAY_SERVE,
  UNIQUE_ENFORCEMENT_REASONS,
  UNIQUE_ENFORCEMENT_VERDICTS,
  UNIQUE_SURVEY_STORE_KINDS,
  uniqueEnforcementIsSuspect,
  WITHHELD_FIELD_LIMIT,
} from "./unique-enforcement.js";

type FieldSpec = Record<string, unknown>;

function manifest(entities: ReadonlyArray<Record<string, unknown>>, traits?: unknown): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { slug: "t/unique", name: "Unique", version: "1.0.0" },
    entities,
    ...(traits !== undefined ? { traits } : {}),
  } as unknown as Manifest;
}

/** One entity, one field, with whatever `unique`/`classification` the case needs. */
function oneField(spec: FieldSpec): Manifest {
  return manifest([{ name: "Item", fields: [{ name: "sku", type: { kind: "text" }, ...spec }] }]);
}

/** `erp-healthcare`'s real shape: a classified unique beside a plain one. */
const MIXED = manifest([
  {
    name: "Patient",
    fields: [
      { name: "mrn", type: { kind: "text" }, unique: true, classification: "phi" },
      { name: "chart_no", type: { kind: "text" }, unique: true },
    ],
  },
]);

describe("UNIQUE_ENFORCEMENT_MAY_SERVE", () => {
  it("covers every verdict", () => {
    expect(Object.keys(UNIQUE_ENFORCEMENT_MAY_SERVE).sort()).toEqual(
      [...UNIQUE_ENFORCEMENT_VERDICTS].sort(),
    );
  });

  it("permits a boot on every verdict: this survey reports and never refuses", () => {
    expect(Object.values(UNIQUE_ENFORCEMENT_MAY_SERVE).every((v) => v)).toBe(true);
  });
});

describe("UNIQUE_ENFORCEMENT_REASONS", () => {
  it("gives every reason both a withheld sentence and a remedy", () => {
    for (const [reason, entry] of Object.entries(UNIQUE_ENFORCEMENT_REASONS)) {
      expect(entry.withheld.length, reason).toBeGreaterThan(20);
      expect(entry.remedy.length, reason).toBeGreaterThan(20);
    }
  });

  it("never advises the document store as a remedy for a ciphertext column", () => {
    // The obvious second half of that remedy — "serve it where the value is plaintext" — trades the
    // guarantee rather than resolving it: the document store indexes the field only by not
    // encrypting it, which ADR-0338 refuses at boot without --allow-plaintext-phi. So this asserts
    // the remedy does not offer that store.
    expect(UNIQUE_ENFORCEMENT_REASONS.encrypted_at_rest.remedy).not.toContain("--store pg");
    expect(UNIQUE_ENFORCEMENT_REASONS.encrypted_at_rest.remedy).toContain("reclassify");
  });

  it("explains every reason the DDL emitter can report", () => {
    // The cross-rule join, read from disk as text rather than imported: a rule that is green only
    // after a build is not a rule, and this one has to hold while `operate-runtime-pg`'s `dist` is
    // a build behind its source. The type-level `extends` fence in the module covers the compiler's
    // half; this covers the case where the emitter's map grows and nothing here is recompiled.
    const here = dirname(fileURLToPath(import.meta.url));
    const emitter = resolve(here, "../../../packages/operate-runtime-pg/src/entity-ddl.ts");
    const src = readFileSync(emitter, "utf8");
    const DECL = "export const UNIQUE_WITHHELD_REASONS = {";
    const start = src.indexOf(DECL);
    expect(start, `${emitter} no longer declares UNIQUE_WITHHELD_REASONS`).toBeGreaterThanOrEqual(0);
    const body = src.slice(start + DECL.length);
    const end = body.indexOf("\n} as const;");
    expect(end, "UNIQUE_WITHHELD_REASONS is not a closed `as const` object").toBeGreaterThan(0);
    const stripped = body
      .slice(0, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const emitterReasons = [...stripped.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(
      (m) => m[1],
    );
    // Vacuity guard: an extraction that returned nothing would satisfy the loop below trivially,
    // which is this directory's own both-directions rule — one way round is what made
    // `needsAuditEmitter` wrong three times.
    expect(emitterReasons).toContain("encrypted_at_rest");
    for (const reason of emitterReasons) {
      expect(Object.keys(UNIQUE_ENFORCEMENT_REASONS), `emitter reason ${String(reason)}`).toContain(
        reason,
      );
    }
  });
});

describe("UNIQUE_SURVEY_STORE_KINDS", () => {
  it("answers for every store kind, taken from the total map's own keys", () => {
    // Iterating the map rather than a hand-written list is what makes a fourth `StoreKind` a
    // failure here: the map is `Record<StoreKind, …>`, so its keys *are* the union.
    expect([...UNIQUE_SURVEY_STORE_KINDS].sort()).toEqual(["memory", "pg", "pg-columns"]);
  });

  it("surveys every store kind without throwing and keeps the counts consistent", () => {
    for (const store of UNIQUE_SURVEY_STORE_KINDS) {
      const r = surveyUniqueEnforcement(MIXED, store, []);
      expect(r.storeKind, store).toBe(store);
      expect(r.enforcedCount + r.withheld.length, store).toBe(r.declaredCount);
      expect(r.mayServe, store).toBe(true);
    }
  });
});

describe("surveyUniqueEnforcement — what each store enforces", () => {
  it("enforces every plain declaration on the column store", () => {
    const r = surveyUniqueEnforcement(oneField({ unique: true }), "pg-columns", []);
    expect(r.verdict).toBe("all_enforced");
    expect(r).toMatchObject({ declaredCount: 1, enforcedCount: 1, withheld: [] });
  });

  it("withholds a phi column on the column store and enforces the plain one beside it", () => {
    const r = surveyUniqueEnforcement(MIXED, "pg-columns", []);
    expect(r.verdict).toBe("partly_enforced");
    expect(r.declaredCount).toBe(2);
    expect(r.enforcedCount).toBe(1);
    expect(r.withheld).toEqual([
      { entity: "Patient", field: "mrn", reason: "encrypted_at_rest", scope: [] },
    ]);
  });

  it("withholds a regulated column too, not only phi", () => {
    const r = surveyUniqueEnforcement(
      oneField({ unique: true, classification: "regulated" }),
      "pg-columns",
      [],
    );
    expect(r.withheld[0]?.reason).toBe("encrypted_at_rest");
  });

  it("enforces a pii or commercial_sensitive column: classified is not encrypted-at-rest", () => {
    for (const classification of ["pii", "commercial_sensitive", "internal", "public"]) {
      const r = surveyUniqueEnforcement(oneField({ unique: true, classification }), "pg-columns", []);
      expect(r.verdict, classification).toBe("all_enforced");
    }
  });

  it("enforces every declaration on the document store when its boot built every index", () => {
    // This was `none_enforced` under `document_store` until H-09: the store had no mechanism. It
    // builds one partial unique expression index per field now, so with nothing observed refused
    // the survey answers what the store established.
    const r = surveyUniqueEnforcement(MIXED, "pg", []);
    expect(r.verdict).toBe("all_enforced");
    expect(r).toMatchObject({ declaredCount: 2, enforcedCount: 2, withheld: [] });
  });

  it("enforces a classified field on pg, never withholding it as encrypted_at_rest", () => {
    // On `pg` a classified value is plaintext, so its index is built like any other; naming the
    // ciphertext reason would state a condition untrue of that deployment.
    const r = surveyUniqueEnforcement(oneField({ unique: true, classification: "phi" }), "pg", []);
    expect(r.verdict).toBe("all_enforced");
  });

  it("reports what the document store's boot observed it could not build, field by field", () => {
    const r = surveyUniqueEnforcement(MIXED, "pg", [
      { entity: "Patient", field: "chart_no", reason: "existing_duplicates" },
    ]);
    expect(r.verdict).toBe("partly_enforced");
    expect(r.withheld).toEqual([
      { entity: "Patient", field: "chart_no", reason: "existing_duplicates", scope: [] },
    ]);
  });

  it("answers none_enforced on pg when no index could be built", () => {
    const r = surveyUniqueEnforcement(MIXED, "pg", [
      { entity: "Patient", field: "mrn", reason: "index_not_owner" },
      { entity: "Patient", field: "chart_no", reason: "index_not_owner" },
    ]);
    expect(r.verdict).toBe("none_enforced");
  });

  it("ignores an observation on a store whose blanket reason already withholds the field", () => {
    const r = surveyUniqueEnforcement(MIXED, "memory", [
      { entity: "Patient", field: "mrn", reason: "index_failed" },
    ]);
    expect(r.withheld.map((f) => f.reason)).toEqual(["no_durable_store", "no_durable_store"]);
  });

  it("withholds every declaration on the memory store, under its own reason", () => {
    const r = surveyUniqueEnforcement(MIXED, "memory", []);
    expect(r.verdict).toBe("none_enforced");
    expect(r.withheld.map((f) => f.reason)).toEqual(["no_durable_store", "no_durable_store"]);
  });
});

describe("surveyUniqueEnforcement — reading the declaration", () => {
  it("reads the composite {scope} form of UniqueHintSchema, not just `true`", () => {
    const r = surveyUniqueEnforcement(
      oneField({ unique: { scope: ["warehouse_id"] }, classification: "phi" }),
      "pg-columns",
      [],
    );
    expect(r.declaredCount).toBe(1);
    expect(r.withheld).toEqual([
      { entity: "Item", field: "sku", reason: "encrypted_at_rest", scope: ["warehouse_id"] },
    ]);
  });

  it("counts a scoped declaration as enforced on the column store", () => {
    const r = surveyUniqueEnforcement(oneField({ unique: { scope: ["warehouse_id"] } }), "pg-columns", []);
    expect(r).toMatchObject({ verdict: "all_enforced", declaredCount: 1, enforcedCount: 1 });
  });

  it("counts neither an absent `unique` key nor an explicit `unique: false`", () => {
    // `unique: false` is legal and means *not unique*, so it must not inflate the figures with
    // fields nobody claimed a guarantee for.
    for (const store of UNIQUE_SURVEY_STORE_KINDS) {
      for (const spec of [{}, { unique: false }]) {
        const r = surveyUniqueEnforcement(oneField(spec), store, []);
        expect(r.verdict, store).toBe("no_declarations");
        expect(r.declaredCount, store).toBe(0);
      }
    }
  });

  it("sees a unique field supplied by a custom trait", () => {
    // `resolvedFields` and not `entity.fields`: a trait field is a real column the emitter indexes,
    // so a survey reading the raw list would report a guarantee as absent that is being enforced —
    // or, on `pg`, report nothing at all about a field that is unprotected.
    const m = manifest(
      [{ name: "Item", fields: [{ name: "name", type: { kind: "text" } }], traits: ["coded"] }],
      [{ name: "coded", fields: [{ name: "code", type: { kind: "text" }, unique: true }] }],
    );
    expect(surveyUniqueEnforcement(m, "pg-columns", [])).toMatchObject({
      declaredCount: 1,
      verdict: "all_enforced",
    });
    expect(
      surveyUniqueEnforcement(m, "pg", [{ entity: "Item", field: "code", reason: "index_failed" }]).withheld,
    ).toEqual([{ entity: "Item", field: "code", reason: "index_failed", scope: [] }]);
  });

  it("sees a classified unique field supplied by a custom trait", () => {
    const m = manifest(
      [{ name: "Patient", fields: [{ name: "name", type: { kind: "text" } }], traits: ["mrn"] }],
      [
        {
          name: "mrn",
          fields: [{ name: "mrn", type: { kind: "text" }, unique: true, classification: "phi" }],
        },
      ],
    );
    expect(surveyUniqueEnforcement(m, "pg-columns", []).withheld).toEqual([
      { entity: "Patient", field: "mrn", reason: "encrypted_at_rest", scope: [] },
    ]);
  });

  it("prefers the entity's own field over a trait's of the same name", () => {
    // `resolvedFields`' own rule, and it decides a figure here: the entity's `unique: false` wins,
    // so the pair is not a declaration at all.
    const m = manifest(
      [
        {
          name: "Item",
          fields: [{ name: "code", type: { kind: "text" }, unique: false }],
          traits: ["coded"],
        },
      ],
      [{ name: "coded", fields: [{ name: "code", type: { kind: "text" }, unique: true }] }],
    );
    expect(surveyUniqueEnforcement(m, "pg-columns", []).declaredCount).toBe(0);
  });

  it("answers no_declarations for a manifest with no entities at all", () => {
    expect(surveyUniqueEnforcement(manifest([]), "pg", []).verdict).toBe("no_declarations");
  });
});

describe("enforceableOnColumnStore", () => {
  it("counts what a store change would buy, excluding the classified ones", () => {
    // The figure that makes the store-change remedy checkable: on this manifest it is 1 of 2,
    // because the phi field moves from one withholding to the other rather than becoming enforced.
    expect(surveyUniqueEnforcement(MIXED, "pg", []).enforceableOnColumnStore).toBe(1);
    expect(surveyUniqueEnforcement(MIXED, "memory", []).enforceableOnColumnStore).toBe(1);
  });

  it("equals the enforced count when already on the column store", () => {
    for (const m of [MIXED, oneField({ unique: true }), oneField({})]) {
      const r = surveyUniqueEnforcement(m, "pg-columns", []);
      expect(r.enforceableOnColumnStore).toBe(r.enforcedCount);
    }
  });
});

describe("uniqueEnforcementIsSuspect", () => {
  it("is false when nothing is withheld, in both zero directions", () => {
    expect(uniqueEnforcementIsSuspect(surveyUniqueEnforcement(oneField({}), "pg", []))).toBe(false);
    expect(
      uniqueEnforcementIsSuspect(surveyUniqueEnforcement(oneField({ unique: true }), "pg-columns", [])),
    ).toBe(false);
  });

  it("is true wherever anything is withheld", () => {
    for (const store of ["memory", "pg-columns"] as const) {
      expect(uniqueEnforcementIsSuspect(surveyUniqueEnforcement(MIXED, store, [])), store).toBe(true);
    }
    expect(uniqueEnforcementIsSuspect(surveyUniqueEnforcement(MIXED, "pg", []))).toBe(false);
    expect(
      uniqueEnforcementIsSuspect(
        surveyUniqueEnforcement(MIXED, "pg", [{ entity: "Patient", field: "mrn", reason: "index_invalid" }]),
      ),
    ).toBe(true);
  });
});

describe("formatUniqueEnforcementReport", () => {
  const lineFor = (m: Manifest, store: StoreKind): string =>
    formatUniqueEnforcementReport(surveyUniqueEnforcement(m, store, []));

  it("is affirmative when the manifest declares none", () => {
    const line = lineFor(oneField({}), "pg");
    expect(line).toContain("[unique] declared unique fields: none on --store pg");
    expect(line).toContain("no guarantee to enforce or to withhold");
  });

  it("is affirmative when everything is enforced, and names the mechanism", () => {
    const line = lineFor(oneField({ unique: true }), "pg-columns");
    expect(line).toContain("1 of 1 enforced on --store pg-columns");
    expect(line).toContain("(tenant_id,");
    expect(line).toContain("never across tenants");
  });

  it("is affirmative on the document store and names its mechanism", () => {
    const line = lineFor(MIXED, "pg");
    expect(line).toBe(
      "[unique] declared unique fields: 2 of 2 enforced on --store pg — one partial unique index per" +
        " field on the shared table, over (tenant_id, …any declared scope, document ->> 'field')" +
        " where entity matches, so the guarantee is uniqueness within a tenant and never across tenants",
    );
  });

  it("names an index the document store could not build and its remedy", () => {
    const line = formatUniqueEnforcementReport(
      surveyUniqueEnforcement(MIXED, "pg", [
        { entity: "Patient", field: "chart_no", reason: "existing_duplicates" },
      ]),
    );
    expect(line.split("\n")[0]).toBe("[unique] declared unique fields: 1 of 2 enforced on --store pg");
    expect(line).toContain("1 withheld (existing_duplicates)");
    expect(line).toContain("Patient.chart_no");
    expect(line).toContain("remedy: deduplicate those records");
    expect(line).not.toContain("measured on this manifest");
  });

  it("carries the memory remedy, its mitigating fact and the checked figures", () => {
    const line = lineFor(MIXED, "memory");
    expect(line).toContain("2 withheld (no_durable_store)");
    expect(line).toContain("nothing is persisted");
    expect(line).toContain("remedy: serve on --store pg or --store pg-columns");
    expect(line).toContain("--store pg would enforce all 2 and --store pg-columns 1 of them");
  });

  it("carries the reclassify remedy for a ciphertext column", () => {
    const line = lineFor(MIXED, "pg-columns");
    expect(line).toContain("1 withheld (encrypted_at_rest)");
    expect(line).toContain("Patient.mrn");
    expect(line).toContain("remedy: reclassify the field below phi/regulated");
    expect(line).toContain("choice between the two guarantees");
  });

  it("names a declared scope in the withheld list", () => {
    const line = lineFor(oneField({ unique: { scope: ["warehouse_id"] } }), "memory");
    expect(line).toContain("Item.sku within (warehouse_id)");
  });

  it("bounds the named fields and still reports the exact count", () => {
    const many = manifest([
      {
        name: "Doc",
        fields: Array.from({ length: WITHHELD_FIELD_LIMIT + 4 }, (_, i) => ({
          name: `f${String(i)}`,
          type: { kind: "text" },
          unique: true,
        })),
      },
    ]);
    const line = lineFor(many, "memory");
    expect(line).toContain(`${String(WITHHELD_FIELD_LIMIT + 4)} withheld (no_durable_store)`);
    expect(line).toContain("(+4 more)");
    expect(line).toContain("Doc.f0");
    expect(line).not.toContain(`Doc.f${String(WITHHELD_FIELD_LIMIT)}`);
  });

  it("groups a mixed report in map order, one remedy per reason", () => {
    // Only `pg-columns` can hold two reasons at once in principle; today it cannot, because a
    // blanket reason excludes the per-field one. So this pins the single-group shape: exactly one
    // `remedy:` line, which is what keeps the output from repeating itself per field.
    const line = lineFor(MIXED, "pg-columns");
    expect(line.split("\n").filter((l) => l.includes("remedy:"))).toHaveLength(1);
    expect(line).not.toContain("no_durable_store");
  });

  it("names every withheld field of a real-shaped manifest — a negative control", () => {
    // Would pass trivially if the survey examined nothing: a report over an eight-entity manifest
    // whose every entity declares a unique must name all eight and count them.
    const eight = manifest(
      Array.from({ length: 8 }, (_, i) => ({
        name: `E${String(i)}`,
        fields: [{ name: "code", type: { kind: "text" }, unique: true }],
      })),
    );
    const r = surveyUniqueEnforcement(eight, "memory", []);
    expect(r.declaredCount).toBe(8);
    const line = formatUniqueEnforcementReport(r);
    for (let i = 0; i < 8; i += 1) expect(line).toContain(`E${String(i)}.code`);
    expect(line).not.toContain("more)");
  });
});
