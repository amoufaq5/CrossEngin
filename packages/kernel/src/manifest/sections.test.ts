import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalizeForHash } from "./hash.js";
import {
  MANIFEST_SECTION_ADDED_MAY_NARROW,
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

const LIFECYCLE = {
  kind: "entityLifecycle",
  entity: "Patient",
  stateField: "label",
  initialState: "draft",
  transitions: [],
} as const;
const INTEGRATION = (path: string): Record<string, unknown> => ({
  kind: "outbound.http",
  name: "I",
  auth: { kind: "none" },
  endpoint: "https://x",
  operations: [{ name: "o", method: "GET", path }],
});
const JOB = (cron: string): Record<string, unknown> => ({
  id: "nightly",
  name: "N",
  kind: "scheduled",
  trigger: { kind: "scheduled", cron },
  onFailure: { strategy: "dead-letter" },
});
const FILE_TYPE = (maxSize: string): Record<string, unknown> => ({
  name: "F",
  allowedMimeTypes: ["text/plain"],
  maxSize,
  storage: { bucket: "b", prefix: "p" },
  dataClass: "internal",
});
const DASHBOARD = (w: number): Record<string, unknown> => ({
  name: "D",
  cells: [{ x: 0, y: 0, w, h: 1, widget: { kind: "divider" } }],
});
const VIEW = (fields: readonly string[]): Record<string, unknown> => ({
  kind: "list",
  entity: "Patient",
  label: { en: "P" },
  columns: fields.map((field) => ({ field })),
  permissions: "inherit",
});
const WIDGET = (pkg: string): Record<string, unknown> => ({
  name: "W",
  package: pkg,
  render: "Widget",
  appliesTo: { kind: "entity", entity: "Patient" },
});

/**
 * One `[before, after]` value per section, so the byte-equality property can be driven per section
 * rather than from a handful of pairs that happen to vary two of them.
 *
 * Minimal rather than representative — each is the smallest value `ManifestSchema` accepts for that
 * section — and the `after` varies a field the schema **retains**, which is not automatic: a first
 * draft varied `integrations.i.name` and `dashboards.d.name`, neither of which survives the parse,
 * so both sides canonicalised identically. The test checks that per row rather than trusting it.
 */
const SECTION_VARIATIONS: Readonly<Record<ManifestSectionName, readonly [unknown, unknown]>> = {
  meta: [{ ...meta }, { ...meta, description: "d" }],
  entities: [
    [{ name: "Patient", fields: [{ name: "label", type: { kind: "text" } }] }],
    [
      {
        name: "Patient",
        fields: [
          { name: "label", type: { kind: "text" } },
          { name: "note", type: { kind: "text" } },
        ],
      },
    ],
  ],
  traits: [
    [{ name: "t", fields: [{ name: "f", type: { kind: "text" } }] }],
    [{ name: "t", fields: [{ name: "f", type: { kind: "text", maxLength: 10 } }] }],
  ],
  relations: [
    [{ kind: "many_to_one", from: "Patient", field: "label", to: "Patient" }],
    [
      { kind: "many_to_one", from: "Patient", field: "label", to: "Patient" },
      { kind: "many_to_one", from: "Patient", field: "note", to: "Patient" },
    ],
  ],
  roles: [{ r: { name: "r", label: { en: "R" } } }, { r: { name: "r", label: { en: "R2" } } }],
  permissions: [
    { Patient: { read: { roles: ["r"] } } },
    { Patient: { read: { roles: ["r", "s"] } } },
  ],
  workflows: [
    { wf: { ...LIFECYCLE, states: [{ name: "draft" }] } },
    { wf: { ...LIFECYCLE, states: [{ name: "draft" }, { name: "done" }] } },
  ],
  integrations: [{ i: INTEGRATION("/") }, { i: INTEGRATION("/v2") }],
  jobs: [{ nightly: JOB("0 3 * * *") }, { nightly: JOB("0 4 * * *") }],
  files: [{ f: FILE_TYPE("10KB") }, { f: FILE_TYPE("20KB") }],
  reports: [
    { r: { kind: "tabular", entity: "Patient" } },
    { r: { kind: "tabular", entity: "Patient", columns: ["label"] } },
  ],
  dashboards: [{ d: DASHBOARD(1) }, { d: DASHBOARD(2) }],
  views: [{ v: VIEW(["label", "id"]) }, { v: VIEW(["label"]) }],
  customWidgets: [{ w: WIDGET("p") }, { w: WIDGET("p2") }],
  theme: [{ density: "compact" }, { density: "comfortable" }],
  i18n: [{ translations: { en: {} } }, { translations: { en: { a: "b" } } }],
  search: [{ defaultDictionary: "simple" }, { defaultDictionary: "english" }],
};

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

/**
 * Every way `MANIFEST_SECTION_NAMES` and `ManifestSchema.shape` can disagree: a section the schema
 * declares and the array omits, one the array names and the schema does not, and a difference in
 * declaration order. Empty iff they agree.
 *
 * A named function because `sections.ts` cites it by name — it did so before this existed, which is
 * the thing being fixed: both that comment and the one on `MANIFEST_SECTION_MEMBER_KEYING` named a
 * helper that was nowhere in the workspace, so a reader grepping either found nothing and the
 * behaviour lived in an anonymous `it()` block. Returning the disagreements rather than asserting
 * inside follows the `strategy/` rules' shape, so the failure names what differs.
 */
export function manifestSectionsMatchSchema(): readonly string[] {
  const declared = [...MANIFEST_SECTION_NAMES] as readonly string[];
  const schema = [...SCHEMA_SECTION_KEYS];
  const out: string[] = [];
  for (const key of schema) {
    if (!declared.includes(key)) out.push(`section_undeclared: ${key}`);
  }
  for (const key of declared) {
    if (!schema.includes(key)) out.push(`section_not_in_schema: ${key}`);
  }
  if (out.length === 0 && declared.join(",") !== schema.join(",")) {
    out.push(`declaration_order_differs: ${declared.join(",")} vs ${schema.join(",")}`);
  }
  return out;
}

/**
 * Every way `MANIFEST_SECTION_MEMBER_KEYING` and the keying `ManifestSchema` implies can disagree,
 * in both directions. Empty iff they agree.
 *
 * The declaration is the authority at run time and this is the drift check its own comment
 * promises. What it can and cannot establish is worth knowing: it compares the keying, and for
 * `named_array` it only checks that `"name"` is a key of the element's shape — the same hardcoded
 * string the module uses, so the key's *identity* is assumed on both sides rather than derived.
 * Whether that key is required and non-empty is asserted separately, because `namedMemberKey`'s
 * silent-skip branch rests on it.
 */
export function manifestSectionMemberKeyingsMatchSchema(): readonly string[] {
  const out: string[] = [];
  for (const key of SCHEMA_SECTION_KEYS) {
    const probed = probeKeying(ManifestSchema.shape[key as keyof typeof ManifestSchema.shape]);
    if (probed === "unknown") {
      out.push(`shape_unreadable: ${key}`);
      continue;
    }
    const declared = MANIFEST_SECTION_MEMBER_KEYING[key as ManifestSectionName];
    if (declared !== probed) out.push(`keying_differs: ${key} declared ${declared}, shape ${probed}`);
  }
  for (const key of Object.keys(MANIFEST_SECTION_MEMBER_KEYING)) {
    if (!SCHEMA_SECTION_KEYS.includes(key)) out.push(`keying_not_in_schema: ${key}`);
  }
  return out;
}

describe("manifest section census", () => {
  it("names every section the schema declares, in declaration order", () => {
    expect(manifestSectionsMatchSchema()).toEqual([]);
    // Non-vacuity: the schema really does carry more than the handful the diff view covers, and the
    // comparison above really ran over all of them rather than over an empty list.
    expect(SCHEMA_SECTION_KEYS.length).toBe(17);
    expect([...MANIFEST_SECTION_NAMES]).toEqual([...SCHEMA_SECTION_KEYS]);
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
  });

  /**
   * The direction worth asserting, where the two loops this replaced asserted the other one.
   *
   * They checked that every declared value is a member of its vocabulary — which
   * `Record<ManifestSectionName, ManifestSectionReach>` already guarantees, so the only mutation
   * that could break them is one `tsc` refuses first and they added nothing over the compiler.
   * What no type can ask is whether a modelled member has **any** section: a reach or a keying
   * nothing answers is a judgement with no case left (ADR-0375), and it is how a vocabulary comes
   * to carry a value that reads as meaningful and decides nothing.
   */
  it("leaves no reach and no keying without a section", () => {
    const reaches = new Set(Object.values(MANIFEST_SECTION_REACH));
    expect([...MANIFEST_SECTION_REACHES].filter((r) => !reaches.has(r))).toEqual([]);
    const keyings = new Set(Object.values(MANIFEST_SECTION_MEMBER_KEYING));
    expect([...MANIFEST_SECTION_MEMBER_KEYINGS].filter((k) => !keyings.has(k))).toEqual([]);
  });

  it("agrees with the keying ManifestSchema implies, in both directions", () => {
    expect(manifestSectionMemberKeyingsMatchSchema()).toEqual([]);
    // Non-vacuity: 17 sections compared, none shape-unreadable, and the measured distribution — so
    // a reshaped section is visible as a count moving rather than as an empty disagreement list.
    const probed = SCHEMA_SECTION_KEYS.map((key) =>
      probeKeying(ManifestSchema.shape[key as keyof typeof ManifestSchema.shape]),
    );
    expect(probed).toHaveLength(17);
    expect(probed.filter((v) => v === "unknown")).toEqual([]);
    const counts = new Map<string, number>();
    for (const keying of probed) counts.set(keying, (counts.get(keying) ?? 0) + 1);
    expect(Object.fromEntries([...counts].sort())).toEqual({
      named_array: 2,
      object_keys: 4,
      record: 10,
      unkeyed_array: 1,
    });
  });

  /**
   * `namedMemberKey` skips a member whose `name` is absent or empty, and `membersOf`'s comment says
   * that is unreachable for a parsed manifest because both `named_array` element schemas require a
   * non-empty one. Nothing asserted it, and the probe above cannot: it checks `"name" in
   * element.shape`, which establishes that the key *exists* and says nothing about whether it is
   * required or may be `""` — the same hardcoded string the module uses, on both sides.
   *
   * The failure mode if it ever stops holding is a silent **under-count** rather than only an
   * unnamed member, because `countBefore`/`countAfter` for a keyed section are the `Map`'s size and
   * not the array's length: a skipped member leaves `countAfter: 0` for an array holding one.
   * Measured against a parse-bypassing object, a blank-named trait reports
   * `presence: "added", added: [], countBefore: 0, countAfter: 0` — a change with nothing in it.
   */
  it("requires a non-empty name on both named_array element schemas", () => {
    const named = MANIFEST_SECTION_NAMES.filter(
      (s) => MANIFEST_SECTION_MEMBER_KEYING[s] === "named_array",
    );
    expect([...named]).toEqual(["entities", "traits"]);
    for (const section of named) {
      const array = unwrapSchema(
        ManifestSchema.shape[section as keyof typeof ManifestSchema.shape],
      ) as z.ZodArray<z.ZodTypeAny>;
      const element = unwrapSchema(array.element) as z.ZodObject<z.ZodRawShape>;
      const name = element.shape["name"] as z.ZodTypeAny;
      expect(name.isOptional()).toBe(false);
      expect(name.safeParse("").success).toBe(false);
      expect(name.safeParse("ok_name").success || name.safeParse("OkName").success).toBe(true);
    }
  });

  /**
   * Checks the property the title claims, which the version this replaced did not.
   *
   * It asserted `meaning.length > 10` and that the sentence does not restate its own key — both
   * true of a meaning carrying a remedy, so the ADR-0334 rule the constant's own comment states
   * ("None of them names a remedy, deliberately") was fenced by nothing. Mutation-checked:
   * appending `"; narrow the view columns back to fix it"` to the `served` meaning passed all 25
   * tests before, and fails here.
   *
   * Two halves, because each catches what the other cannot. The exact three strings make **any**
   * edit a diff-visible decision rather than something a reviewer has to notice. The marker scan
   * generalises to a reach added later, when the literals above will have been updated to match
   * whatever was written — and it is word-bounded for a measured reason: `validated_only`'s
   * sentence contains "runtime", so an unbounded `run` reports a remedy in a correct string.
   */
  it("explains every reach and names no remedy", () => {
    // Imperatives, as a remedy is phrased wherever this repo prints one.
    const REMEDY_MARKERS = /\b(add|drop|rename|remove|pass|run|set|declare|fix|instead)\b/i;
    for (const reach of MANIFEST_SECTION_REACHES) {
      const meaning = MANIFEST_SECTION_REACH_MEANINGS[reach];
      expect(meaning.length).toBeGreaterThan(10);
      // A reach meaning that restated its own key would be a sentence saying nothing.
      expect(meaning).not.toContain(reach);
      expect(meaning).not.toMatch(REMEDY_MARKERS);
    }
    // A floor, so the scan cannot pass by matching nothing: the two shapes it exists to refuse.
    expect("validated only — drop the declaration").toMatch(REMEDY_MARKERS);
    expect("read by nothing; add 'auditable' instead").toMatch(REMEDY_MARKERS);
    expect(MANIFEST_SECTION_REACH_MEANINGS).toEqual({
      served: "a change here alters what a request gets",
      validated_only:
        "validated for coherence; no request path reads it, so a change serves nothing",
      unread: "not validated and no request path reads it, so a change serves nothing",
    });
  });

  /**
   * The map itself, not a count of its values.
   *
   * A count is blind to a **compensating pair**, and that is not hypothetical: mutation-checked,
   * flipping `files` to `unread` and `i18n` to `validated_only` together leaves the split
   * `{served: 9, unread: 3, validated_only: 5}` intact and passed all 25 tests before this. Those
   * two were reachable precisely because no test named either individually — `meta` and `theme`
   * are asserted elsewhere, and the register treats the served/validated_only line as a measured
   * claim, so this is its only fence.
   */
  it("holds the measured reach of every section", () => {
    expect(MANIFEST_SECTION_REACH).toEqual({
      meta: "served",
      entities: "served",
      traits: "served",
      relations: "served",
      roles: "served",
      permissions: "served",
      workflows: "served",
      integrations: "validated_only",
      jobs: "served",
      files: "validated_only",
      reports: "validated_only",
      dashboards: "validated_only",
      views: "served",
      customWidgets: "unread",
      theme: "unread",
      i18n: "unread",
      search: "validated_only",
    });
    // Kept beside it because the split is the figure this file's prose and the register both quote.
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

  /**
   * This test built the exact input the withholding predicate used to get wrong and never asked it.
   *
   * The predicate's unkeyed arm was a strictly shrinking count, so an equal-count edit answered
   * `false` — and the file documented that shape here, two describe blocks above the predicate, and
   * asserted only the counts. Asking it is one line and it is the line that would have caught it:
   * restoring the narrow reading now fails this test along with the five in
   * `manifestSectionChangeMayWithhold` below.
   */
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
    if (relations === undefined) throw new Error("unreachable");
    expect(manifestSectionChangeMayWithhold(relations)).toBe(true);
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
   * The property the whole module rests on, exercised seventeen times rather than three.
   *
   * It used to run over five hand-picked pairs, and measured, that was close to vacuous: **77
   * assertions executed, 72 of which compared `"null"` to `"null"`** because both sides lacked the
   * section, and the **5** substantive ones were all `entities` — a section no pair varied. The
   * sections it existed to protect were only reached by *not* being reported.
   *
   * Driven from a table instead, where the base carries **every** section at a declared value, so
   * varying one leaves the other sixteen present-and-equal on both sides: **272 substantive sibling
   * comparisons and 0 null/null**. And it asserts the direction nothing asserted at all — bytes
   * differ ⇒ the section is reported — which is the half a reviewer depends on, with the
   * non-vacuity of each pair checked rather than assumed: two fixtures varied a key
   * `IntegrationDeclarationSchema` and `DashboardDeclarationSchema` do not retain, so they parsed
   * to identical bytes and would have made their row pass while testing nothing.
   */
  it("reports exactly the sections whose canonical bytes moved, for all seventeen", () => {
    const canonical = (value: unknown): string => JSON.stringify(canonicalizeForHash(value) ?? null);
    const full = (overrides: Record<string, unknown> = {}): Manifest =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        ...Object.fromEntries(
          MANIFEST_SECTION_NAMES.map((s) => [s, SECTION_VARIATIONS[s][0]] as const),
        ),
        ...overrides,
      });

    let substantive = 0;
    for (const section of MANIFEST_SECTION_NAMES) {
      const before = full();
      const after = full({ [section]: SECTION_VARIATIONS[section][1] });
      // Non-vacuity for this row: the pair really does move this section's bytes.
      expect(canonical(before[section])).not.toBe(canonical(after[section]));

      const reported = new Set(diffManifestSections(before, after).map((c) => c.section));
      expect([...reported]).toEqual([section]);
      for (const other of MANIFEST_SECTION_NAMES) {
        if (other === section) continue;
        expect(canonical(before[other])).toBe(canonical(after[other]));
        expect(canonical(before[other])).not.toBe("null");
        substantive += 1;
      }
    }
    expect(substantive).toBe(272);
  });

  /**
   * Every change carries its reach's sentence, which is what gives
   * `MANIFEST_SECTION_REACH_MEANINGS` its first non-test reader.
   *
   * Asserted against the map rather than against three literals, because the point is that there
   * is **one** source: a consumer that renders `reachNote` cannot hold a sentence of its own to
   * drift from, and the two fields cannot disagree about one change.
   */
  it("carries the reach's own sentence on every change", () => {
    const before = manifest();
    const after = manifest({
      jobs: { nightly: JOB("0 3 * * *") },
      theme: { density: "compact" },
      reports: { r: { kind: "tabular", entity: "Patient" } },
    });
    const changes = diffManifestSections(before, after);
    // Non-vacuity: one change per reach, so each sentence is exercised rather than one of three.
    expect(new Set(changes.map((c) => c.reach))).toEqual(
      new Set(["served", "unread", "validated_only"]),
    );
    for (const change of changes) {
      expect(change.reachNote).toBe(MANIFEST_SECTION_REACH_MEANINGS[change.reach]);
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

  it("reads an unkeyed section appearing as not withholding, and every other presence as withholding", () => {
    const relation = { kind: "many_to_one", from: "Patient", field: "carer", to: "Patient" };
    const grew = only(diffManifestSections(manifest(), manifest({ relations: [relation] })));
    expect(grew.membersKeyed).toBe(false);
    expect(grew.presence).toBe("added");
    expect(manifestSectionChangeMayWithhold(grew)).toBe(false);

    const shrank = only(diffManifestSections(manifest({ relations: [relation] }), manifest()));
    expect(manifestSectionChangeMayWithhold(shrank)).toBe(true);
  });

  // The shapes the narrower reading — a strictly shrinking count — called safe. Its comment said a
  // shrinking count was the only withholding an unkeyed section could show; each of these takes
  // something away at a count that does not shrink.
  it("reads an unkeyed swap at equal count as withholding", () => {
    // One many_to_many replaced by another: eight association routes and a join table go.
    const before = { kind: "many_to_many", left: "Patient", right: "Tag" };
    const after = { kind: "many_to_many", left: "Patient", right: "Ward" };
    const change = only(
      diffManifestSections(manifest({ relations: [before] }), manifest({ relations: [after] })),
    );
    expect(change.presence).toBe("present");
    expect(change.countBefore).toBe(change.countAfter);
    expect(change.removed).toEqual([]);
    expect(change.changed).toEqual([]);
    expect(manifestSectionChangeMayWithhold(change)).toBe(true);
  });

  it("reads an unkeyed removal at a growing count as withholding", () => {
    const before = [{ kind: "many_to_many", left: "Patient", right: "Tag" }];
    const after = [
      { kind: "many_to_many", left: "Patient", right: "Ward" },
      { kind: "many_to_many", left: "Patient", right: "Carer" },
    ];
    const change = only(
      diffManifestSections(manifest({ relations: before }), manifest({ relations: after })),
    );
    expect(change.countAfter).toBeGreaterThan(change.countBefore);
    expect(manifestSectionChangeMayWithhold(change)).toBe(true);
  });

  it("reads an unkeyed onDelete narrowing as withholding", () => {
    // set_null → restrict makes a parent delete that used to succeed start failing.
    const relation = { kind: "many_to_one", from: "Patient", field: "carer", to: "Patient" };
    const change = only(
      diffManifestSections(
        manifest({ relations: [{ ...relation, onDelete: "set_null" }] }),
        manifest({ relations: [{ ...relation, onDelete: "restrict" }] }),
      ),
    );
    expect(change.countBefore).toBe(change.countAfter);
    expect(manifestSectionChangeMayWithhold(change)).toBe(true);
  });

  it("reads an unkeyed reorder as withholding, which a multiset difference would not", () => {
    // `relationDeleteIndex` is last-wins over `(from, field)`, so reordering two relations on one
    // pair changes the effective policy at identical contents — which is why the answer here is
    // `presence !== "added"` rather than a difference over the members.
    const cascade = {
      kind: "many_to_one",
      from: "Patient",
      field: "carer",
      to: "Patient",
      onDelete: "cascade",
    };
    const restrict = { ...cascade, onDelete: "restrict" };
    const change = only(
      diffManifestSections(
        manifest({ relations: [cascade, restrict] }),
        manifest({ relations: [restrict, cascade] }),
      ),
    );
    expect(change.countBefore).toBe(change.countAfter);
    expect(manifestSectionChangeMayWithhold(change)).toBe(true);
  });

  it("reads a view being added as withholding, where every other added member is not", () => {
    // A view overrides a derived default: `listConfigForEntity` answers from every text field with
    // no list view and from the view's visible columns with one, so the first view for an entity
    // narrows the searchable set and since ADR-0359 a dropped filter is a 400. The `jobs` test
    // above is the control — adding a member there declares something that did not exist.
    const view = { entity: "Patient", kind: "list", columns: [{ field: "label" }] };
    const change = only(diffManifestSections(manifest(), manifest({ views: { all: view } })));
    expect(change.section).toBe("views");
    expect(change.presence).toBe("added");
    expect(change.added).toEqual(["all"]);
    expect(manifestSectionChangeMayWithhold(change)).toBe(true);
  });

  it("names views as the one section where adding a member may narrow", () => {
    // Asserted as an exact set rather than key by key, so flipping one back fails here rather than
    // passing quietly — `ABAC_RECORD_AVAILABILITY`'s `never` set, one map over.
    const narrowing = MANIFEST_SECTION_NAMES.filter(
      (section) => MANIFEST_SECTION_ADDED_MAY_NARROW[section],
    );
    expect([...narrowing]).toEqual(["views"]);
    expect(Object.keys(MANIFEST_SECTION_ADDED_MAY_NARROW).sort()).toEqual(
      [...MANIFEST_SECTION_NAMES].sort(),
    );
  });

  it("is false for a validated_only section, not only an unread one", () => {
    const change = only(
      diffManifestSections(
        manifest({ reports: { aging: { kind: "tabular", entity: "Patient" } } }),
        manifest(),
      ),
    );
    expect(change.section).toBe("reports");
    expect(MANIFEST_SECTION_REACH.reports).toBe("validated_only");
    expect(change.presence).toBe("removed");
    expect(manifestSectionChangeMayWithhold(change)).toBe(false);
  });
});
