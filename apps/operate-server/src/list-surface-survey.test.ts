import { columnPlansForManifest } from "@crossengin/operate-runtime-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  formatListSurfaceReport,
  LIST_SURFACE_MAY_SERVE,
  LIST_SURFACE_VERDICTS,
  surveyListSurfaces,
} from "./list-surface-survey.js";

/**
 * A manifest whose Patient view declares every surface over a `phi` column — which is
 * `erp-healthcare`'s real shape, measured: `Patient.mrn` is filterable, sortable AND searchable.
 */
function manifest(opts: {
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly hidden?: boolean;
  readonly extraText?: boolean;
  readonly defaultSortMrn?: boolean;
}): Manifest {
  const columns: Array<Record<string, unknown>> = [
    {
      field: "mrn",
      label: { en: "MRN" },
      ...(opts.filterable === false ? { filterable: false } : {}),
      ...(opts.sortable === false ? { sortable: false } : {}),
      ...(opts.hidden === true ? { hidden: true } : {}),
    },
  ];
  if (opts.extraText === true) columns.push({ field: "family_name", label: { en: "Family name" } });
  return {
    manifestVersion: "1.0",
    meta: { slug: "t/surface", name: "Surface", version: "1.0.0" },
    entities: [
      {
        name: "Patient",
        fields: [
          { name: "mrn", type: { kind: "text" }, classification: "phi" },
          { name: "family_name", type: { kind: "text" }, classification: "pii" },
        ],
      },
    ],
    views: {
      "patient.list": {
        kind: "list",
        entity: "Patient",
        label: { en: "Patients" },
        permissions: "inherit",
        sort: [{ field: opts.defaultSortMrn === true ? "mrn" : "family_name", direction: "asc" }],
        columns,
      },
    },
  } as unknown as Manifest;
}

describe("LIST_SURFACE_MAY_SERVE", () => {
  it("covers every verdict", () => {
    expect(Object.keys(LIST_SURFACE_MAY_SERVE).sort()).toEqual([...LIST_SURFACE_VERDICTS].sort());
  });

  it("permits a boot for every verdict: this survey reports and never refuses", () => {
    // The decision, pinned rather than described. ADR-0338's "nothing served this correctly today"
    // does hold here — a pg-columns healthcare deployment answered `?mrn=` with every patient — and
    // what stops a refusal is the remedy: the surface is declared by a builtin pack's view, so an
    // operator meeting a boot refusal could not clear it without editing this repository.
    expect(Object.values(LIST_SURFACE_MAY_SERVE).every((v) => v)).toBe(true);
  });
});

describe("surveyListSurfaces — the store kind decides", () => {
  it("finds nothing on --store pg, where the same values are plaintext in the document", () => {
    const r = surveyListSurfaces(manifest({}), "pg");
    expect(r.verdict).toBe("all_surfaces_serveable");
    expect(r.gaps).toEqual([]);
  });

  it("finds nothing on --store memory, which compares records in process", () => {
    expect(surveyListSurfaces(manifest({}), "memory").verdict).toBe("all_surfaces_serveable");
  });

  it("finds the same manifest's surfaces unserveable on --store pg-columns", () => {
    // The same manifest, two store kinds, two answers — which is why this cannot be a kernel
    // validation rule and why `erp-healthcare` is not wrong to declare `mrn` filterable.
    const r = surveyListSurfaces(manifest({}), "pg-columns");
    expect(r.verdict).toBe("surfaces_refused");
    expect(r.gaps).toEqual([
      { entity: "Patient", field: "mrn", surfaces: ["filter", "sort", "search"] },
    ]);
  });
});

describe("surveyListSurfaces — verdicts", () => {
  it("reports search_narrowed when something is left to search", () => {
    // `mrn` is inexpressible and `family_name` is not, so `?q` still runs and returns correct rows
    // — a missed match rather than a wrong one, which is the only verdict that is not a refusal.
    const r = surveyListSurfaces(
      manifest({ filterable: false, sortable: false, extraText: true }),
      "pg-columns",
    );
    expect(r.verdict).toBe("search_narrowed");
    expect(r.narrowedSearchEntities).toEqual(["Patient"]);
    expect(r.gaps).toEqual([{ entity: "Patient", field: "mrn", surfaces: ["search"] }]);
  });

  it("reports surfaces_refused when the whole search group collapses", () => {
    // Every searchable field inexpressible: the OR group is dropped entirely and `?q` matched every
    // row, so this is the widening case and the store refuses it.
    const r = surveyListSurfaces(manifest({ filterable: false, sortable: false }), "pg-columns");
    expect(r.verdict).toBe("surfaces_refused");
    expect(r.narrowedSearchEntities).toEqual([]);
  });

  it("names a defaultSort over an encrypted column, which refuses every bare collection GET", () => {
    const r = surveyListSurfaces(manifest({ defaultSortMrn: true }), "pg-columns");
    expect(r.verdict).toBe("surfaces_refused");
    expect(r.gaps[0]!.surfaces).toContain("defaultSort");
  });

  it("finds nothing when the column is hidden, so no surface names it", () => {
    // A hidden column is in no surface list, so there is nothing to refuse — the field is still
    // ciphertext and simply not addressable.
    expect(surveyListSurfaces(manifest({ hidden: true }), "pg-columns").verdict).toBe(
      "all_surfaces_serveable",
    );
  });

  it("ranks a refusal above a narrowing when both hold", () => {
    // The verdict is the worst fact in hand: reporting `search_narrowed` while a filter is being
    // refused would understate what an operator will meet.
    const r = surveyListSurfaces(manifest({ extraText: true }), "pg-columns");
    expect(r.verdict).toBe("surfaces_refused");
    expect(r.narrowedSearchEntities).toEqual(["Patient"]);
  });

  it("covers a classified field contributed by a trait", () => {
    // `resolvedFields` and not `entityClassifiedFields`, which reads the entity's own fields only.
    const m = {
      manifestVersion: "1.0",
      meta: { slug: "t/trait", name: "Trait", version: "1.0.0" },
      traits: [{ name: "identified", fields: [{ name: "mrn", type: { kind: "text" }, classification: "phi" }] }],
      entities: [{ name: "Patient", traits: ["identified"], fields: [] }],
      views: {
        "patient.list": {
          kind: "list",
          entity: "Patient",
          label: { en: "Patients" },
          permissions: "inherit",
          columns: [{ field: "mrn", label: { en: "MRN" } }],
        },
      },
    } as unknown as Manifest;
    expect(surveyListSurfaces(m, "pg-columns").gaps[0]?.field).toBe("mrn");
  });
});

describe("CIPHERTEXT_CLASSIFICATIONS agrees with the column plan", () => {
  it("is exactly the set the column plan marks encryptAtRest", () => {
    // The pair is restated in this module because `column-plan.ts` derives the flag inline and
    // exports no predicate. This is what keeps the two from drifting: a manifest declaring one
    // field of every classification, compared against the plan's OWN answer.
    const m = {
      manifestVersion: "1.0",
      meta: { slug: "t/classes", name: "Classes", version: "1.0.0" },
      entities: [
        {
          name: "Sample",
          fields: [
            { name: "a", type: { kind: "text" }, classification: "public" },
            { name: "b", type: { kind: "text" }, classification: "internal" },
            { name: "c", type: { kind: "text" }, classification: "pii" },
            { name: "d", type: { kind: "text" }, classification: "phi" },
            { name: "e", type: { kind: "text" }, classification: "regulated" },
            { name: "f", type: { kind: "text" }, classification: "commercial_sensitive" },
          ],
        },
      ],
    } as unknown as Manifest;
    const plan = columnPlansForManifest(m, { schema: "public" }).get("Sample")!;
    const encrypted = plan.columns
      .filter((c) => c.encryptAtRest)
      .map((c) => c.field)
      .sort();
    expect(encrypted).toEqual(["d", "e"]);
  });
});

describe("formatListSurfaceReport", () => {
  it("is affirmative when there is nothing to report", () => {
    // "We checked and found nothing" cannot be claimed from the absence of a log line.
    const line = formatListSurfaceReport(surveyListSurfaces(manifest({}), "pg"));
    expect(line).toContain("all serveable");
    expect(line).toContain("--store pg");
  });

  it("names the entity, the field, every surface and the three remedies", () => {
    const line = formatListSurfaceReport(surveyListSurfaces(manifest({}), "pg-columns"));
    expect(line).toContain("Patient.mrn");
    expect(line).toContain("filter, sort, search");
    expect(line).toContain("refused 400 rather than answered with every row");
    expect(line).toContain("--store pg");
  });

  it("says a narrowed search is missed rather than refused", () => {
    const line = formatListSurfaceReport(
      surveyListSurfaces(manifest({ filterable: false, sortable: false, extraText: true }), "pg-columns"),
    );
    expect(line).toContain("?q is narrower than declared");
    expect(line).toContain("missed rather than refused");
    expect(line).not.toContain("refused 400");
  });
});
