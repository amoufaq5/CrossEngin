import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalizeForHash } from "./hash.js";
import {
  MANIFEST_SECTION_MEMBER_KEYING,
  MANIFEST_SECTION_MEMBER_KEYINGS,
  MANIFEST_SECTION_NAMES,
  MANIFEST_SECTION_PRESENCES,
  MANIFEST_SECTION_REACH,
  MANIFEST_SECTION_REACHES,
  MANIFEST_SECTION_REACH_MEANINGS,
  diffManifestSections,
  manifestSectionChangeMayWithhold,
  type ManifestSectionChange,
  type ManifestSectionMemberKeying,
  type ManifestSectionName,
} from "./sections.js";
import { ManifestSchema, type Manifest } from "./types.js";

const meta = { name: "T", slug: "t", version: "1.0.0" } as const;

/**
 * Fixtures go through `ManifestSchema.parse`, not past it. Every input this module sees in
 * production is a parsed manifest, and parsing is what fills the defaults a `ViewDeclaration`
 * carries — a hand-built literal is both unrepresentative and, for the richer sections, not
 * assignable to `Manifest` at all.
 */
function manifest(extra: Record<string, unknown> = {}): Manifest {
  return ManifestSchema.parse({
    manifestVersion: "1.0",
    meta,
    entities: [{ name: "Patient", fields: [{ name: "label", type: { kind: "text" } }] }],
    ...extra,
  });
}

/** Every section this answers for, as the schema declares it rather than as the module says. */
const SCHEMA_SECTION_KEYS: readonly string[] = Object.keys(ManifestSchema.shape).filter(
  (key) => key !== "manifestVersion",
);

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let i = 0; i < 8; i += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    break;
  }
  return current;
}

/**
 * The keying `ManifestSchema` implies, derived rather than read from the module under test. A
 * `named_array` is an array whose element schema declares a `name`; anything else array-shaped
 * has no key to report.
 */
function probeKeying(schema: z.ZodTypeAny): ManifestSectionMemberKeying | "unknown" {
  const unwrapped = unwrapSchema(schema);
  if (unwrapped instanceof z.ZodArray) {
    const element = unwrapSchema(unwrapped.element as z.ZodTypeAny);
    if (element instanceof z.ZodObject && "name" in element.shape) return "named_array";
    return "unkeyed_array";
  }
  if (unwrapped instanceof z.ZodRecord) return "record";
  if (unwrapped instanceof z.ZodObject) return "object_keys";
  return "unknown";
}

describe("manifest section census", () => {
  it("names every section the schema declares, in declaration order", () => {
    expect([...MANIFEST_SECTION_NAMES]).toEqual([...SCHEMA_SECTION_KEYS]);
    // Non-vacuity: the schema really does carry more than the handful the diff view covers.
    expect(SCHEMA_SECTION_KEYS.length).toBe(17);
  });

  it("excludes manifestVersion because the schema pins it to one literal", () => {
    // The whole justification for the one exclusion: two manifests that both parse cannot
    // disagree about it, so comparing it is provably vacuous rather than conventionally skipped.
    const version = ManifestSchema.shape.manifestVersion;
    expect(version).toBeInstanceOf(z.ZodLiteral);
    expect((version as z.ZodLiteral<string>).value).toBe("1.0");
    expect(MANIFEST_SECTION_NAMES).not.toContain("manifestVersion");
  });

  it("keeps meta in scope, because meta.extends decides lineage", () => {
    expect(MANIFEST_SECTION_NAMES).toContain("meta");
    expect(MANIFEST_SECTION_REACH.meta).toBe("served");
  });

  it("declares a reach and a keying for every section and for nothing else", () => {
    expect(Object.keys(MANIFEST_SECTION_REACH).sort()).toEqual([...SCHEMA_SECTION_KEYS].sort());
    expect(Object.keys(MANIFEST_SECTION_MEMBER_KEYING).sort()).toEqual(
      [...SCHEMA_SECTION_KEYS].sort(),
    );
    for (const reach of Object.values(MANIFEST_SECTION_REACH)) {
      expect(MANIFEST_SECTION_REACHES).toContain(reach);
    }
    for (const keying of Object.values(MANIFEST_SECTION_MEMBER_KEYING)) {
      expect(MANIFEST_SECTION_MEMBER_KEYINGS).toContain(keying);
    }
  });

  it("agrees with the keying ManifestSchema implies, in both directions", () => {
    const probed = new Map<string, ManifestSectionMemberKeying | "unknown">();
    for (const key of SCHEMA_SECTION_KEYS) {
      probed.set(key, probeKeying(ManifestSchema.shape[key as keyof typeof ManifestSchema.shape]));
    }
    // No section is shape-unreadable, so the declaration has a counterpart for all 17.
    expect([...probed.values()].filter((v) => v === "unknown")).toEqual([]);
    for (const [key, keying] of probed) {
      expect(MANIFEST_SECTION_MEMBER_KEYING[key as ManifestSectionName]).toBe(keying);
    }
    // And the measured distribution, so a reshaped section is visible as a count moving.
    const counts = new Map<string, number>();
    for (const keying of probed.values()) counts.set(keying, (counts.get(keying) ?? 0) + 1);
    expect(Object.fromEntries([...counts].sort())).toEqual({
      named_array: 2,
      object_keys: 4,
      record: 10,
      unkeyed_array: 1,
    });
  });

  it("explains every reach and names no remedy", () => {
    for (const reach of MANIFEST_SECTION_REACHES) {
      const meaning = MANIFEST_SECTION_REACH_MEANINGS[reach];
      expect(meaning.length).toBeGreaterThan(10);
      // A reach meaning that restated its own key would be a sentence saying nothing.
      expect(meaning).not.toContain(reach);
    }
  });

  it("holds the measured reach split", () => {
    const counts = new Map<string, number>();
    for (const reach of Object.values(MANIFEST_SECTION_REACH)) {
      counts.set(reach, (counts.get(reach) ?? 0) + 1);
    }
    expect(Object.fromEntries([...counts].sort())).toEqual({
      served: 9,
      unread: 3,
      validated_only: 5,
    });
  });
});

describe("diffManifestSections", () => {
  it("reports nothing for an identical manifest", () => {
    const m = manifest();
    expect(diffManifestSections(m, m)).toEqual([]);
  });

  it("treats a null active as everything-added", () => {
    const changes = diffManifestSections(null, manifest());
    expect(changes.map((c) => c.section).sort()).toEqual(["entities", "meta"]);
    for (const change of changes) expect(change.presence).toBe("added");
  });

  // The register's named defect: the reviewer's diff view answers `impact: none` with every count
  // zero for each of these, which is byte-identical to "nothing changed".
  it("reports meta.extends being added, by name", () => {
    const changes = diffManifestSections(
      manifest(),
      manifest({ meta: { ...meta, extends: ["operate-erp/core"] } }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.section).toBe("meta");
    expect(changes[0]?.presence).toBe("present");
    expect(changes[0]?.added).toEqual(["extends"]);
    expect(changes[0]?.reach).toBe("served");
  });

  it("reports a job being removed, by name, as a served change", () => {
    const job = {
      id: "nightly",
      name: "Nightly",
      kind: "scheduled",
      trigger: { kind: "scheduled", cron: "0 3 * * *" },
      onFailure: { strategy: "dead-letter" },
    };
    const before = manifest({ jobs: { nightly: job } });
    const after = manifest({ jobs: {} });
    const changes = diffManifestSections(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.section).toBe("jobs");
    expect(changes[0]?.removed).toEqual(["nightly"]);
    expect(changes[0]?.countBefore).toBe(1);
    expect(changes[0]?.countAfter).toBe(0);
    expect(changes[0]?.reach).toBe("served");
  });

  it("reports a view being edited rather than only added or removed", () => {
    const view = {
      kind: "list",
      entity: "Patient",
      label: { en: "Patients" },
      columns: [{ field: "label" }, { field: "id" }],
      permissions: "inherit",
    };
    const before = manifest({ views: { "patient.list": view } });
    const after = manifest({
      views: { "patient.list": { ...view, columns: [{ field: "label" }] } },
    });
    const changes = diffManifestSections(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.section).toBe("views");
    expect(changes[0]?.changed).toEqual(["patient.list"]);
    expect(changes[0]?.added).toEqual([]);
    expect(changes[0]?.removed).toEqual([]);
  });

  it("distinguishes an absent section from an empty one", () => {
    const added = diffManifestSections(manifest(), manifest({ views: {} }));
    expect(added).toHaveLength(1);
    expect(added[0]?.presence).toBe("added");
    expect(added[0]?.added).toEqual([]);
    expect(added[0]?.countAfter).toBe(0);

    const removed = diffManifestSections(manifest({ views: {} }), manifest());
    expect(removed).toHaveLength(1);
    expect(removed[0]?.presence).toBe("removed");
  });

  it("keys a named array by name", () => {
    const trait = { name: "stamped", fields: [{ name: "stamp", type: { kind: "text" } }] };
    const changes = diffManifestSections(manifest(), manifest({ traits: [trait] }));
    const traits = changes.find((c) => c.section === "traits");
    expect(traits?.keying).toBe("named_array");
    expect(traits?.membersKeyed).toBe(true);
    expect(traits?.added).toEqual(["stamped"]);
  });

  it("reports relations with counts and says the members are not keyed", () => {
    const relation = {
      kind: "many_to_one",
      from: "Patient",
      field: "carer",
      to: "Patient",
    };
    const changes = diffManifestSections(manifest(), manifest({ relations: [relation] }));
    const relations = changes.find((c) => c.section === "relations");
    expect(relations?.keying).toBe("unkeyed_array");
    // Empty lists here mean "there is no key to name", never "nothing changed" — the change being
    // returned at all is the report. The counts are what a reader acts on.
    expect(relations?.membersKeyed).toBe(false);
    expect(relations?.added).toEqual([]);
    expect(relations?.changed).toEqual([]);
    expect(relations?.countBefore).toBe(0);
    expect(relations?.countAfter).toBe(1);
  });

  it("reports an edited relation, where no count moves", () => {
    const base = { kind: "many_to_one", from: "Patient", field: "carer", to: "Patient" };
    const changes = diffManifestSections(
      manifest({ relations: [base] }),
      manifest({ relations: [{ ...base, onDelete: "cascade" }] }),
    );
    const relations = changes.find((c) => c.section === "relations");
    expect(relations).toBeDefined();
    expect(relations?.countBefore).toBe(1);
    expect(relations?.countAfter).toBe(1);
  });

  it("ignores meta.manifestResolution, which the hash strips too", () => {
    const resolved = manifest({
      meta: { ...meta, manifestResolution: { parents: [{ slug: "p", version: "1.0.0", hash: "h", parentId: "id" }] } },
    });
    expect(diffManifestSections(manifest(), resolved)).toEqual([]);
  });

  it("reports every differing section rather than a chosen few", () => {
    const before = manifest();
    const after = manifest({
      meta: { ...meta, description: "d" },
      traits: [{ name: "t", fields: [{ name: "f", type: { kind: "text" } }] }],
      roles: { r: { name: "r", label: { en: "R" } } },
      theme: {},
      i18n: undefined,
    });
    const sections = diffManifestSections(before, after).map((c) => c.section);
    expect(sections.sort()).toEqual(["meta", "roles", "theme", "traits"]);
  });

  /**
   * The property the whole module rests on: equality here is `manifestHash`'s equality restricted
   * to one section, so an unchanged section's bytes cannot have moved under the reviewer.
   */
  it("reports a section unchanged only when its canonical bytes are unchanged", () => {
    const canonical = (value: unknown): string => JSON.stringify(canonicalizeForHash(value) ?? null);
    const pairs: readonly (readonly [Manifest, Manifest])[] = [
      [manifest(), manifest()],
      [manifest(), manifest({ meta: { ...meta, extends: ["p"] } })],
      [manifest({ views: {} }), manifest()],
      [
        manifest({ roles: { a: { name: "a", label: { en: "A" } } } }),
        manifest({ roles: { a: { name: "a", label: { en: "B" } } } }),
      ],
      [
        manifest({ traits: [{ name: "t", fields: [{ name: "f", type: { kind: "text" } }] }] }),
        manifest({ traits: [{ name: "t", fields: [{ name: "f", type: { kind: "integer" } }] }] }),
      ],
    ];
    for (const [before, after] of pairs) {
      const reported = new Set(diffManifestSections(before, after).map((c) => c.section));
      for (const section of MANIFEST_SECTION_NAMES) {
        if (reported.has(section)) continue;
        if (section === "meta") continue; // compared modulo manifestResolution, asserted above
        expect(canonical(before[section])).toBe(canonical(after[section]));
      }
    }
  });

  it("holds the presence vocabulary", () => {
    expect([...MANIFEST_SECTION_PRESENCES]).toEqual(["added", "removed", "present"]);
  });
});

describe("manifestSectionChangeMayWithhold", () => {
  const only = (changes: readonly ManifestSectionChange[]): ManifestSectionChange => {
    expect(changes).toHaveLength(1);
    const change = changes[0];
    if (change === undefined) throw new Error("unreachable");
    return change;
  };

  const job = {
    id: "nightly",
    name: "Nightly",
    kind: "scheduled",
    trigger: { kind: "scheduled", cron: "0 3 * * *" },
    onFailure: { strategy: "dead-letter" },
  };

  it("is true for a served member removed", () => {
    const change = only(
      diffManifestSections(manifest({ jobs: { nightly: job } }), manifest({ jobs: {} })),
    );
    expect(manifestSectionChangeMayWithhold(change)).toBe(true);
  });

  it("is true for a served member changed", () => {
    const change = only(
      diffManifestSections(
        manifest({ jobs: { nightly: job } }),
        manifest({ jobs: { nightly: { ...job, trigger: { kind: "scheduled", cron: "0 4 * * *" } } } }),
      ),
    );
    expect(manifestSectionChangeMayWithhold(change)).toBe(true);
  });

  it("is false for a served member only added", () => {
    const change = only(diffManifestSections(manifest(), manifest({ jobs: { nightly: job } })));
    expect(change.added).toEqual(["nightly"]);
    expect(manifestSectionChangeMayWithhold(change)).toBe(false);
  });

  it("is false for a section nothing serves, however it changed", () => {
    const change = only(
      diffManifestSections(manifest({ theme: { density: "compact" } }), manifest()),
    );
    expect(change.section).toBe("theme");
    expect(change.presence).toBe("removed");
    expect(MANIFEST_SECTION_REACH.theme).toBe("unread");
    expect(manifestSectionChangeMayWithhold(change)).toBe(false);
  });

  it("reads a shrinking unkeyed count as withholding and a growing one as not", () => {
    const relation = { kind: "many_to_one", from: "Patient", field: "carer", to: "Patient" };
    const grew = only(diffManifestSections(manifest(), manifest({ relations: [relation] })));
    expect(grew.membersKeyed).toBe(false);
    expect(manifestSectionChangeMayWithhold(grew)).toBe(false);

    const shrank = only(diffManifestSections(manifest({ relations: [relation] }), manifest()));
    expect(manifestSectionChangeMayWithhold(shrank)).toBe(true);
  });
});
