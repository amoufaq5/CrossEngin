import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APERTURE_BINDINGS,
  APERTURE_FINDING_KINDS,
  APERTURE_REJECTIONS,
  ApertureDeclarationSchema,
  CONSEQUENCE_BEARING_DIRECTIONS,
  DROPPED_BEARING_DIRECTIONS,
  ENTITY_FIELD_APERTURE,
  FIELD_APERTURE_DIRECTIONS,
  PROJECTED_MANIFEST_READERS,
  READER_ACCOUNTINGS,
  REFUSED_ANCHORS,
  RESOLUTION_CALLS,
  RESOLUTION_CONSTANTS,
  analyzeModuleApertures,
  auditEntityFieldAperture,
  countByDirection,
  entitySpellings,
  formatApertureFindings,
  functionSpans,
  manifestSpellings,
  openFailures,
  readerSubjectOf,
  scanEntityFieldApertures,
  type ApertureDeclaration,
} from "./entity-field-aperture.js";
import { REPO_ROOT } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ vocabulary */

describe("the vocabulary", () => {
  it("names the three directions, which are what decide defect from decision", () => {
    expect(FIELD_APERTURE_DIRECTIONS).toEqual(["fails_open", "fails_closed", "incomplete"]);
  });

  it("names the five ways the two halves of the rule can disagree", () => {
    expect(APERTURE_FINDING_KINDS).toEqual([
      "undeclared",
      "overtaken",
      "unknown_file",
      "unknown_symbol",
      "duplicate",
    ]);
  });

  it("partitions the directions into the two bearing sets with nothing left over", () => {
    // `pg-unreachable-stores.ts`' assertion: a direction added to neither set would silently carry
    // whichever field it liked, which is how a cost gets written where a safety claim belongs.
    const bearing = [...CONSEQUENCE_BEARING_DIRECTIONS, ...DROPPED_BEARING_DIRECTIONS];
    expect([...bearing].sort()).toEqual([...FIELD_APERTURE_DIRECTIONS].sort());
    for (const direction of CONSEQUENCE_BEARING_DIRECTIONS) {
      expect(DROPPED_BEARING_DIRECTIONS).not.toContain(direction);
    }
  });

  it("keeps the resolver calls and the trait map in separate lists", () => {
    // One joined alternation had to patch the difference back out of its own output: a call is
    // matched as `name(` and the map is reached as `BUILT_IN_TRAIT_FIELDS.get(...)`, which no `(`
    // arm matches.
    expect(RESOLUTION_CALLS).toContain("resolvedFields");
    expect(RESOLUTION_CALLS).toContain("resolvedClassifiedFields");
    expect(RESOLUTION_CONSTANTS).toEqual(["BUILT_IN_TRAIT_FIELDS"]);
    for (const name of RESOLUTION_CONSTANTS) expect(RESOLUTION_CALLS).not.toContain(name);
  });

  it("every direction has a real producer", () => {
    // The brief's rule and this directory's: a direction with no member is a dead branch that would
    // never be exercised, so it must be deleted rather than kept for symmetry.
    const counts = countByDirection(ENTITY_FIELD_APERTURE);
    for (const direction of FIELD_APERTURE_DIRECTIONS) {
      expect(counts.get(direction), direction).toBeGreaterThan(0);
    }
  });

  it("every rejection reason and accounting has a real producer too", () => {
    const scan = scanEntityFieldApertures();
    const reasons = new Set(scan.rejected.map((r) => r.reason));
    for (const reason of APERTURE_REJECTIONS) expect([...reasons], reason).toContain(reason);
    const accountings = new Set(scan.readers.map((r) => r.accounting));
    for (const accounting of READER_ACCOUNTINGS) {
      expect([...accountings], accounting).toContain(accounting);
    }
    const bindings = new Set(scan.readers.map((r) => r.binding));
    for (const binding of APERTURE_BINDINGS) expect([...bindings], binding).toContain(binding);
  });
});

/* ----------------------------------------------------------------- declarations */

describe("the declaration shape", () => {
  it("parses every declaration", () => {
    for (const declaration of ENTITY_FIELD_APERTURE) {
      expect(() => ApertureDeclarationSchema.parse(declaration), readerSubjectOf(declaration)).not.toThrow();
    }
  });

  const base = {
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/defaults.ts",
    symbol: "literalDefaultPlans",
    note: "a note that is comfortably past the twenty-character floor",
  };

  it("demands a consequence of the two gap directions, in both directions", () => {
    for (const direction of CONSEQUENCE_BEARING_DIRECTIONS) {
      expect(() => ApertureDeclarationSchema.parse({ ...base, direction })).toThrow(/consequence/);
      expect(() =>
        ApertureDeclarationSchema.parse({
          ...base,
          direction,
          consequence: "a consequence that is long enough to say something",
        }),
      ).not.toThrow();
    }
    expect(() =>
      ApertureDeclarationSchema.parse({
        ...base,
        direction: "fails_closed",
        dropped: "what is dropped and why that is safe, at length",
        consequence: "a consequence that does not belong on a fails_closed member",
      }),
    ).toThrow(/consequence/);
  });

  it("demands a `dropped` safety argument of fails_closed alone, in both directions", () => {
    expect(() => ApertureDeclarationSchema.parse({ ...base, direction: "fails_closed" })).toThrow(
      /dropped/,
    );
    expect(() =>
      ApertureDeclarationSchema.parse({
        ...base,
        direction: "incomplete",
        consequence: "a consequence that is long enough to say something",
        dropped: "a safety argument that does not belong on a gap member",
      }),
    ).toThrow(/dropped/);
  });

  it("refuses a file outside the member it names, and a traversing path", () => {
    expect(() =>
      ApertureDeclarationSchema.parse({
        ...base,
        pkg: "packages/kernel",
        direction: "incomplete",
        consequence: "a consequence that is long enough to say something",
      }),
    ).toThrow(/not inside/);
    expect(() =>
      ApertureDeclarationSchema.parse({
        ...base,
        file: "packages/operate-runtime/../kernel/src/x.ts",
        direction: "incomplete",
        consequence: "a consequence that is long enough to say something",
      }),
    ).toThrow();
  });

  it("names a file that exists, inside a member that exists", () => {
    for (const declaration of ENTITY_FIELD_APERTURE) {
      expect(
        existsSync(join(REPO_ROOT, declaration.file)),
        `${declaration.file} does not exist`,
      ).toBe(true);
      expect(existsSync(join(REPO_ROOT, declaration.pkg, "package.json")), declaration.pkg).toBe(
        true,
      );
    }
  });

  it("declares each subject once", () => {
    const subjects = ENTITY_FIELD_APERTURE.map(readerSubjectOf);
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it("keeps every refused anchor beside the count that refused it", () => {
    // `pg-binding-names.ts`' `REFUSED_DERIVATIONS` shape: a measurement without its number is an
    // opinion, and the next person re-runs the experiment.
    expect(REFUSED_ANCHORS.length).toBeGreaterThanOrEqual(4);
    for (const refused of REFUSED_ANCHORS) {
      expect(refused.anchor.length).toBeGreaterThan(10);
      expect(refused.refutation.length).toBeGreaterThan(60);
      expect(refused.refutation, refused.anchor).toMatch(/\d/);
    }
  });
});

/* ------------------------------------------------------------- the pure audit */

const reader = (over: Record<string, unknown> = {}): Parameters<typeof auditEntityFieldAperture>[0]["readers"][number] =>
  ({
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/defaults.ts",
    symbol: "literalDefaultPlans",
    receiver: "entity",
    binding: "annotation",
    detail: "entity:Entity",
    lines: [12],
    accounting: "raw",
    ...over,
  }) as Parameters<typeof auditEntityFieldAperture>[0]["readers"][number];

const declaration = (over: Partial<ApertureDeclaration> = {}): ApertureDeclaration =>
  ApertureDeclarationSchema.parse({
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/defaults.ts",
    symbol: "literalDefaultPlans",
    direction: "incomplete",
    consequence: "a consequence that is long enough to say something",
    note: "a note that is comfortably past the twenty-character floor",
    ...over,
  });

const audit = (
  readers: readonly ReturnType<typeof reader>[],
  declarations: readonly ApertureDeclaration[],
  symbols: readonly string[] = ["literalDefaultPlans"],
): ReturnType<typeof auditEntityFieldAperture> =>
  auditEntityFieldAperture({
    readers,
    declarations,
    scannedFiles: ["packages/operate-runtime/src/defaults.ts"],
    symbolsByFile: new Map([
      ["packages/operate-runtime/src/defaults.ts", new Set(symbols)],
    ]),
  });

describe("auditEntityFieldAperture", () => {
  it("passes when a raw reader is declared", () => {
    expect(audit([reader()], [declaration()])).toEqual([]);
  });

  it("reports a raw reader with no declaration", () => {
    const findings = audit([reader()], []);
    expect(findings.map((f) => f.kind)).toEqual(["undeclared"]);
    expect(findings[0]?.subject).toBe("packages/operate-runtime/src/defaults.ts::literalDefaultPlans");
  });

  it("reports a declaration whose reader now resolves — and says to delete the line", () => {
    const findings = audit([reader({ accounting: "resolver_called" })], [declaration()]);
    expect(findings.map((f) => f.kind)).toEqual(["overtaken"]);
    expect(findings[0]?.detail).toMatch(/delete the declaration/);
  });

  it("calls a trait-aware reader accounted for, not overtaken-by-resolution", () => {
    expect(audit([reader({ accounting: "trait_aware" })], [])).toEqual([]);
  });

  it("separates a renamed symbol from a resolved one", () => {
    // The split this rule got wrong first. A sibling change made `list-query.ts` resolve its traits
    // mid-increment, and the finding said the function had been *removed* — whose remedy is to go
    // looking for it. `overtaken` is the right finding and its remedy is deleting the declaration.
    const resolved = audit([reader({ accounting: "resolver_called" })], [declaration()]);
    expect(resolved.map((f) => f.kind)).toEqual(["overtaken"]);
    const renamed = audit([], [declaration()], ["somethingElse"]);
    expect(renamed.map((f) => f.kind)).toEqual(["unknown_symbol"]);
    expect(renamed[0]?.detail).toMatch(/declares no function named/);
  });

  it("reports a declaration for a file the scan never read", () => {
    const findings = auditEntityFieldAperture({
      readers: [],
      declarations: [declaration({ file: "packages/operate-runtime/src/gone.ts" })],
      scannedFiles: ["packages/operate-runtime/src/defaults.ts"],
      symbolsByFile: new Map(),
    });
    expect(findings.map((f) => f.kind)).toEqual(["unknown_file"]);
  });

  it("reports a duplicate rather than letting two directions both pass", () => {
    const findings = audit(
      [reader()],
      [declaration(), declaration({ direction: "fails_open" })],
    );
    expect(findings.map((f) => f.kind)).toEqual(["duplicate"]);
  });

  it("formats a finding with its kind", () => {
    expect(formatApertureFindings(audit([reader()], []))).toMatch(/^\[undeclared\] /);
  });
});

/* --------------------------------------------------------- the scanner, on strings */

const SRC = { pkg: "packages/example", file: "packages/example/src/x.ts" };

describe("the scanner — negative controls", () => {
  it("reports a raw read on an Entity-typed parameter, and exactly that one", () => {
    // The control that proves the scan is live: if this stops producing a reader, every assertion
    // about the real workspace below is passing on an empty population.
    const text = [
      'import type { Entity } from "@crossengin/types/meta-schema";',
      "export function narrow(entity: Entity): readonly string[] {",
      "  return entity.fields.map((f) => f.name);",
      "}",
    ].join("\n");
    const { readers, rejected } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toHaveLength(1);
    expect(rejected).toEqual([]);
    expect(readers[0]?.symbol).toBe("narrow");
    expect(readers[0]?.accounting).toBe("raw");
    expect(readers[0]?.binding).toBe("annotation");
    expect(readers[0]?.lines).toEqual([3]);
  });

  it("reports nothing when the same function resolves its traits", () => {
    const text = [
      'import { resolvedFields } from "@crossengin/kernel/ddl";',
      'import type { Entity, Trait } from "@crossengin/types/meta-schema";',
      "export function wide(entity: Entity, traits: readonly Trait[]): readonly string[] {",
      "  return resolvedFields(entity, traits).map((f) => f.name);",
      "}",
    ].join("\n");
    expect(analyzeModuleApertures({ ...SRC, text }).readers).toEqual([]);
  });

  it("accounts for a function that reads raw *and* resolves as resolved, never as raw", () => {
    // `raw` is the claim that nothing in the body resolves, so one read that proves otherwise must
    // win regardless of which was scanned first.
    const text = [
      'import { resolvedFields } from "@crossengin/kernel/ddl";',
      'import type { Entity } from "@crossengin/types/meta-schema";',
      "export function mixed(entity: Entity): number {",
      "  const own = entity.fields.length;",
      "  return own + resolvedFields(entity, []).length;",
      "}",
    ].join("\n");
    const { readers } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toHaveLength(1);
    expect(readers[0]?.accounting).toBe("resolver_called");
  });

  it("exempts a function handed the trait contribution in its own signature", () => {
    // `checkEntityFieldNames(entity, traitFields)` reads `entity.fields` in order to compare it
    // against the wide half it was given; resolving it would make every trait-bearing entity collide
    // with itself.
    const text = [
      'import type { Entity, Field } from "@crossengin/types/meta-schema";',
      "export function collide(entity: Entity, traitFields: readonly Field[]): void {",
      "  const names = new Set(traitFields.map((f) => f.name));",
      "  for (const field of entity.fields) if (names.has(field.name)) throw new Error(field.name);",
      "}",
    ].join("\n");
    expect(analyzeModuleApertures({ ...SRC, text }).readers[0]?.accounting).toBe("trait_aware");
  });
});

describe("the scanner — the anchor rejects what it should", () => {
  it("rejects a read on a foreign type that happens to have `fields`", () => {
    const text = [
      'import type { EntityPermissions } from "@crossengin/auth";',
      "export function perms(entityPerms: EntityPermissions): unknown {",
      "  return entityPerms.fields;",
      "}",
    ].join("\n");
    const { readers, rejected } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["foreign_type"]);
    expect(rejected[0]?.detail).toBe("entityPerms:EntityPermissions");
  });

  it("rejects an `.entities` iteration whose root is not a manifest", () => {
    // The measured false positive that a name-based rule produces: `apps/operate-web` iterates
    // `schema.entities` over a `UiSchema`, and reads `entity.fields` on the result.
    const text = [
      'import type { UiSchema } from "./schema.js";',
      "export function reverse(schema: UiSchema): readonly string[] {",
      "  const out: string[] = [];",
      "  for (const entity of schema.entities) {",
      "    for (const field of entity.fields) out.push(field.name);",
      "  }",
      "  return out;",
      "}",
    ].join("\n");
    const { readers, rejected } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["root_not_a_manifest"]);
  });

  it("accepts the same iteration once the root is a manifest", () => {
    const text = [
      'import type { Manifest } from "@crossengin/kernel/manifest";',
      "export function wideish(manifest: Manifest): readonly string[] {",
      "  const out: string[] = [];",
      "  for (const entity of manifest.entities ?? []) {",
      "    for (const field of entity.fields) out.push(field.name);",
      "  }",
      "  return out;",
      "}",
    ].join("\n");
    const { readers } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toHaveLength(1);
    expect(readers[0]?.binding).toBe("manifest_rooted");
  });

  it("reads an optional-chained `entity?.fields`", () => {
    // `manifest-diff.ts` writes both of its reads this way, and a matcher without the `?.` arm
    // missed two members the brief had named by line number.
    const text = [
      'import type { Manifest } from "@crossengin/kernel/manifest";',
      'type ManifestEntity = NonNullable<Manifest["entities"]>[number];',
      "export function index(entity: ManifestEntity | undefined): number {",
      "  let n = 0;",
      "  for (const field of entity?.fields ?? []) n += field.name.length;",
      "  return n;",
      "}",
    ].join("\n");
    const { readers } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toHaveLength(1);
    expect(readers[0]?.detail).toBe("entity:ManifestEntity");
  });

  it("accepts an inline structural root, which is a stronger anchor than a nominal Manifest", () => {
    const text = [
      'import type { Entity } from "@crossengin/types/meta-schema";',
      "export function lookup(manifest: { readonly entities?: readonly Entity[] }): number {",
      "  let n = 0;",
      "  for (const entity of manifest.entities ?? []) n += entity.fields.length;",
      "  return n;",
      "}",
    ].join("\n");
    const { readers } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toHaveLength(1);
    expect(readers[0]?.binding).toBe("manifest_rooted");
  });

  it("does not read a `.fields` that only appears in a comment or a string", () => {
    // ADR-0337's own widened scan read a doc comment as a construction site, and this rule read its
    // own declaration prose as a member. Both arms pinned.
    const text = [
      'import type { Entity } from "@crossengin/types/meta-schema";',
      "/** Never read `entity.fields` here; use resolvedFields. */",
      "export function described(entity: Entity): string {",
      '  return "do not read entity.fields" + String(entity.name);',
      "}",
    ].join("\n");
    const { readers, rejected } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("still resolves an indexed-access type whose own spelling contains a string literal", () => {
    // The interaction that cost two members: `blankStringBodies` blanks the `"entities"` inside
    // `NonNullable<Manifest["entities"]>[number]`, so the spellings must be extracted *before* it.
    const text = [
      'import type { Manifest } from "@crossengin/kernel/manifest";',
      'type ManifestEntity = NonNullable<Manifest["entities"]>[number];',
      "export function count(entity: ManifestEntity): number {",
      "  return entity.fields.length;",
      "}",
    ].join("\n");
    expect([...entitySpellings(text)]).toContain("ManifestEntity");
    expect(analyzeModuleApertures({ ...SRC, text }).readers).toHaveLength(1);
  });

  it("scopes the type lookup to the enclosing function", () => {
    // ADR-0354's bare-name defect, which this scan reproduced before it was fixed: one file may
    // annotate the same identifier as an entity in one function and as something else in another,
    // and a file-wide lookup takes whichever was scanned first.
    const text = [
      'import type { Entity } from "@crossengin/types/meta-schema";',
      'import type { EntityPermissions } from "@crossengin/auth";',
      "export function a(entity: Entity): number {",
      "  return entity.fields.length;",
      "}",
      "export function b(entity: EntityPermissions): unknown {",
      "  return entity.fields;",
      "}",
    ].join("\n");
    const { readers, rejected } = analyzeModuleApertures({ ...SRC, text });
    expect(readers.map((r) => r.symbol)).toEqual(["a"]);
    expect(rejected.map((r) => `${r.reason}:${r.detail}`)).toEqual([
      "foreign_type:entity:EntityPermissions",
    ]);
  });

  it("groups several reads in one function into one reader", () => {
    const text = [
      'import type { Entity } from "@crossengin/types/meta-schema";',
      "export function twice(entity: Entity): number {",
      "  const names = new Set(entity.fields.map((f) => f.name));",
      "  return names.size + entity.fields.length;",
      "}",
    ].join("\n");
    const { readers } = analyzeModuleApertures({ ...SRC, text });
    expect(readers).toHaveLength(1);
    expect(readers[0]?.lines).toEqual([3, 4]);
  });
});

describe("functionSpans / spellings", () => {
  it("finds function declarations and const arrows, and not a bare call", () => {
    const code = [
      "export function one() {}",
      "const two = (a: number) => {",
      "  return a;",
      "};",
      "export const three = async function () {};",
      "declare function four(): void;",
      "one();",
    ].join("\n");
    expect(functionSpans(code).map((s) => s.name)).toEqual(["one", "two", "three"]);
  });

  it("attributes a read to the innermost named function, not a nested callback", () => {
    // A `.fields` read inside `entity.fields.map((f) => …)` belongs to the function holding the
    // entity, which is the unit a declaration is written against.
    const text = [
      'import type { Entity } from "@crossengin/types/meta-schema";',
      "export function outer(entity: Entity): readonly string[] {",
      "  const inner = (f: { name: string }): string => f.name;",
      "  return entity.fields.map(inner);",
      "}",
    ].join("\n");
    expect(analyzeModuleApertures({ ...SRC, text }).readers[0]?.symbol).toBe("outer");
  });

  it("always admits the nominal spellings", () => {
    expect([...entitySpellings("const x: Entity = y;")]).toEqual(["Entity"]);
    expect([...manifestSpellings("const x = 1;")].sort()).toEqual(["Manifest", "ResolvedManifest"]);
  });
});

/* -------------------------------------------------------- the real workspace */

describe("the real workspace", () => {
  const scan = scanEntityFieldApertures();
  const raw = scan.readers.filter((r) => r.accounting === "raw");

  it("walked the workspace and resolved every read it found", () => {
    // The vacuity guard, and the floor is on the **population** rather than on the findings, for a
    // reason specific to this rule: if the anchor narrowed or the read matcher broke, the population
    // would collapse and all 12 declarations would come back `overtaken` — whose documented remedy,
    // established by ADR-0336 and ADR-0337, is to *delete the line*. Following that remedy would
    // silently empty the rule, so a collapse is the one failure whose own instructions are
    // destructive. The ceiling on the other side guards the opposite break: an anchor that widened
    // to admit the 25 `UiEntitySchema` reads would trip it, and that failure is loud anyway because
    // it arrives as an `undeclared` storm.
    expect(scan.unhandledGlobs).toEqual([]);
    expect(scan.files).toBeGreaterThanOrEqual(900);
    expect(scan.readers.length).toBeGreaterThanOrEqual(14);
    expect(scan.readers.length).toBeLessThanOrEqual(40);
    expect(raw.length).toBeGreaterThanOrEqual(10);
    // The rejected bucket is three times the population, so it is where a break shows up first. A
    // collapse here means the read matcher stopped examining and the population survived by luck.
    expect(scan.rejected.length).toBeGreaterThanOrEqual(45);
    for (const r of scan.readers) {
      expect(READER_ACCOUNTINGS, readerSubjectOf(r)).toContain(r.accounting);
      expect(APERTURE_BINDINGS, readerSubjectOf(r)).toContain(r.binding);
      expect(scan.scannedFiles, r.file).toContain(r.file);
    }
    for (const r of scan.rejected) expect(APERTURE_REJECTIONS, r.detail).toContain(r.reason);
  });

  it("finds nothing", () => {
    const findings = auditEntityFieldAperture({
      readers: scan.readers,
      declarations: ENTITY_FIELD_APERTURE,
      scannedFiles: scan.scannedFiles,
      symbolsByFile: scan.symbolsByFile,
    });
    expect(
      findings.map((f) => `${f.kind}:${f.subject}`),
      formatApertureFindings(findings),
    ).toEqual([]);
  });

  it("declares exactly the raw readers the workspace has, both ways", () => {
    expect([...ENTITY_FIELD_APERTURE.map(readerSubjectOf)].sort()).toEqual(
      [...raw.map(readerSubjectOf)].sort(),
    );
  });

  it("reads the kernel's own resolver as resolved, which is the one read that must never be a member", () => {
    const resolver = scan.readers.find(
      (r) => r.file === "packages/kernel/src/ddl/resolution.ts" && r.symbol === "resolvedFields",
    );
    expect(resolver?.accounting).toBe("resolver_called");
  });

  it("is precise: the type anchor rejects three reads for every one it keeps", () => {
    // The measurement that decides whether this rule is worth having. A bare `\\.fields\\b` scan over
    // the same files is 24% precise; anchoring on the type is 100% on a population checked by hand.
    const total = scan.readers.reduce((n, r) => n + r.lines.length, 0) + scan.rejected.length;
    expect(total).toBeGreaterThanOrEqual(70);
    expect(scan.rejected.length).toBeGreaterThan(scan.readers.length * 2);
    const foreignTypes = new Set(
      scan.rejected.filter((r) => r.reason === "foreign_type").map((r) => r.detail.split(":")[1]),
    );
    // Each of these really does carry a `fields` property, which is why the receiver's *name* could
    // never have decided this.
    for (const type of ["EntityPermissions", "UiEntitySchema", "ListQuery", "EntityClassification"]) {
      expect([...foreignTypes], type).toContain(type);
    }
  });

  it("rejects every one of operate-web's reads, measured rather than assumed", () => {
    // The largest population the anchor has to turn down, and the reason the scan reads a member
    // that `readWorkspaceSources` cannot reach: if `operate-web` were simply never walked, the
    // exclusion would be an accident of the walk rather than a property of the anchor.
    const web = scan.scannedFiles.filter((f) => f.startsWith("apps/operate-web/"));
    expect(web.length).toBeGreaterThanOrEqual(30);
    expect(scan.readers.filter((r) => r.file.startsWith("apps/operate-web/"))).toEqual([]);
    const rejectedThere = scan.rejected.filter((r) => r.file.startsWith("apps/operate-web/"));
    expect(rejectedThere.length).toBeGreaterThanOrEqual(20);
    expect(
      rejectedThere.filter((r) => r.detail.endsWith(":UiEntitySchema")).length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("keeps the second population out, and asserts it is still the other shape", () => {
    // `PROJECTED_MANIFEST_READERS` hold no `Entity` and cannot call the resolver: blocked by shape,
    // not by wiring. If one of them starts holding a typed entity it becomes a member of this rule,
    // and this is what says so.
    for (const file of PROJECTED_MANIFEST_READERS) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(text, file).toMatch(/\[["']fields["']\]/);
      expect(scan.readers.filter((r) => r.file === file), file).toEqual([]);
    }
  });

  it("ranks the three open failures, and each says whether it is live", () => {
    const open = openFailures(ENTITY_FIELD_APERTURE);
    expect(open.length).toBe(3);
    for (const member of open) {
      expect(member.consequence, readerSubjectOf(member)).toBeDefined();
      // Every `fails_open` member states its liveness, because two of the three are latent — their
      // own callers do not exist — and a reader deciding what to fix first needs that in the note.
      expect(member.note, readerSubjectOf(member)).toMatch(/\b(?:[Ll]ive|[Ll]atent)\b/);
    }
    expect(open.map(readerSubjectOf)).toContain(
      "apps/architect-cli/src/refusal.ts::detectEncryptionWeakening",
    );
  });

  it("every declaration's lines are still readable in its file", () => {
    // A declaration naming a symbol whose file no longer reads raw is caught by `overtaken`; this
    // catches the weaker drift of a note that has gone stale about *where*.
    for (const d of ENTITY_FIELD_APERTURE) {
      const found = raw.find((r) => readerSubjectOf(r) === readerSubjectOf(d));
      expect(found, readerSubjectOf(d)).toBeDefined();
      const lines = readFileSync(join(REPO_ROOT, d.file), "utf8").split("\n");
      for (const line of found?.lines ?? []) {
        expect(lines[line - 1] ?? "", `${d.file}:${line}`).toMatch(/\.\s*fields\b/);
      }
    }
  });
});
