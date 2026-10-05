import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseCatalogSource,
  PG_SCAN_GAPS,
  type SqlStatement,
  type StatementTarget,
  type TableReference,
} from "./pg-column-coverage.js";
import {
  auditStorelessTables,
  CONSEQUENCE_BEARING_REASONS,
  countByReason,
  formatStorelessFindings,
  readersWithNoWriter,
  STORELESS_FINDING_KINDS,
  STORELESS_REASONS,
  STORELESS_TABLES,
  StorelessDeclarationSchema,
  StorelessTableFactsSchema,
  SUCCESSOR_BEARING_REASONS,
  WRITER_BEARING_REASONS,
  type StorelessDeclaration,
  type StorelessTableFacts,
} from "./pg-storeless-tables.js";
import { readCatalogSource, REPO_ROOT, scanWorkspaceSql } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ fixtures */

function facts(over: Partial<StorelessTableFacts> = {}): StorelessTableFacts {
  return StorelessTableFactsSchema.parse({
    table: "meta.widgets",
    written: false,
    read: false,
    ...over,
  });
}

function declaration(over: Partial<StorelessDeclaration> = {}): StorelessDeclaration {
  return StorelessDeclarationSchema.parse({
    table: "meta.widgets",
    reason: "static_catalog",
    owner: "widgets",
    note: "the rows are a compile-time constant in WIDGETS",
    ...over,
  });
}

/* ------------------------------------------------------------------ the shape */

describe("the declared shape", () => {
  it("names six reasons and seven finding kinds", () => {
    expect([...STORELESS_REASONS]).toEqual([
      "static_catalog",
      "superseded",
      "out_of_band",
      "dynamic_writer",
      "unbuilt_subsystem",
      "unwritten_table",
    ]);
    expect([...STORELESS_FINDING_KINDS]).toEqual([
      "undeclared",
      "overtaken",
      "unknown_table",
      "duplicate",
      "unsupported_dynamic_writer",
      "unknown_successor",
      "writerless_successor",
    ]);
  });

  it("partitions the reasons that bear a field, leaving exactly the two that bear none", () => {
    // ADR-0330's shape: the field-bearing sets are asserted disjoint and the remainder is named, so
    // a seventh reason added to neither fails here rather than quietly carrying any field it likes.
    const bearing = [
      ...SUCCESSOR_BEARING_REASONS,
      ...WRITER_BEARING_REASONS,
      ...CONSEQUENCE_BEARING_REASONS,
    ];
    expect(new Set(bearing).size).toBe(bearing.length);
    const remainder = STORELESS_REASONS.filter((r) => !bearing.includes(r));
    expect([...remainder]).toEqual(["static_catalog", "out_of_band"]);
  });

  it("requires a successor of a superseded declaration and forbids one otherwise", () => {
    expect(() =>
      StorelessDeclarationSchema.parse({ ...declaration(), reason: "superseded" }),
    ).toThrow();
    expect(() =>
      declaration({ reason: "superseded", supersededBy: ["meta.gadgets"] }),
    ).not.toThrow();
    expect(() =>
      StorelessDeclarationSchema.parse({ ...declaration(), supersededBy: ["meta.gadgets"] }),
    ).toThrow();
  });

  it("requires a consequence of a gap and forbids one otherwise", () => {
    // A gap that cannot be parked without saying what a deployment does not get.
    for (const reason of CONSEQUENCE_BEARING_REASONS) {
      expect(() => StorelessDeclarationSchema.parse({ ...declaration(), reason })).toThrow();
      expect(() => declaration({ reason, consequence: "nothing is recorded" })).not.toThrow();
    }
    expect(() =>
      StorelessDeclarationSchema.parse({ ...declaration(), consequence: "x" }),
    ).toThrow();
  });

  it("requires a dynamic writer to name the file, and only then", () => {
    expect(() =>
      StorelessDeclarationSchema.parse({ ...declaration(), reason: "dynamic_writer" }),
    ).toThrow();
    expect(() => declaration({ reason: "dynamic_writer", writtenVia: "a/b.ts" })).not.toThrow();
    expect(() => StorelessDeclarationSchema.parse({ ...declaration(), writtenVia: "a/b.ts" })).toThrow();
  });

  it("refuses an unqualified table name and a note with nothing in it", () => {
    expect(() => StorelessDeclarationSchema.parse({ ...declaration(), table: "widgets" })).toThrow();
    expect(() => StorelessDeclarationSchema.parse({ ...declaration(), note: "too short" })).toThrow();
  });
});

/* ------------------------------------------------------------------- the rule */

describe("auditStorelessTables", () => {
  const audit = (
    f: readonly StorelessTableFacts[],
    d: readonly StorelessDeclaration[],
    gaps: readonly string[] = [],
  ) => auditStorelessTables({ facts: f, declarations: d, scanGapFiles: gaps });

  it("passes a writerless table that is declared", () => {
    expect(audit([facts()], [declaration()])).toEqual([]);
  });

  it("passes a written table with no declaration", () => {
    expect(audit([facts({ written: true })], [])).toEqual([]);
  });

  it("reports a writerless table nothing declares — the fence", () => {
    const found = audit([facts()], []);
    expect(found.map((f) => f.kind)).toEqual(["undeclared"]);
    expect(found[0]?.detail).toContain("declared and unreachable");
  });

  it("says, of an undeclared table something reads, that its reader is served nothing", () => {
    const found = audit([facts({ read: true })], []);
    expect(found[0]?.detail).toContain("reader is being served nothing");
  });

  it("reports a declaration a store has overtaken", () => {
    const found = audit([facts({ written: true })], [declaration()]);
    expect(found.map((f) => f.kind)).toEqual(["overtaken"]);
  });

  it("reports a declaration for a table the catalog does not have", () => {
    expect(audit([], [declaration()]).map((f) => f.kind)).toEqual(["unknown_table"]);
  });

  it("reports the same table declared twice", () => {
    const found = audit([facts()], [declaration(), declaration({ reason: "out_of_band" })]);
    expect(found.map((f) => f.kind)).toEqual(["duplicate"]);
  });

  it("reports a dynamic writer no declared scan gap backs", () => {
    const d = declaration({ reason: "dynamic_writer", writtenVia: "a/b.ts" });
    expect(audit([facts()], [d], ["other/c.ts"]).map((f) => f.kind)).toEqual([
      "unsupported_dynamic_writer",
    ]);
    expect(audit([facts()], [d], ["a/b.ts"])).toEqual([]);
  });

  it("reports a successor the catalog does not declare", () => {
    const d = declaration({ reason: "superseded", supersededBy: ["meta.gadgets"] });
    expect(audit([facts()], [d]).map((f) => f.kind)).toEqual(["unknown_successor"]);
  });

  it("reports a successor that has no writer either", () => {
    // Pointing one writerless table at another is a reason that explains nothing — the record is
    // persisted on neither side.
    const d = declaration({ reason: "superseded", supersededBy: ["meta.gadgets"] });
    const found = audit([facts(), facts({ table: "meta.gadgets" })], [d]);
    // The successor is itself writerless and undeclared, so both findings land — which is right:
    // the pair is one broken reason and one table nothing has decided about.
    expect(found.map((f) => f.kind)).toEqual(["writerless_successor", "undeclared"]);
    expect(formatStorelessFindings(found)).toContain("the reason is wrong");
  });

  it("passes a successor that is written", () => {
    const d = declaration({ reason: "superseded", supersededBy: ["meta.gadgets"] });
    expect(audit([facts(), facts({ table: "meta.gadgets", written: true })], [d])).toEqual([]);
  });

  it("every finding kind is reachable", () => {
    const reached = new Set<string>([
      ...audit([facts()], []).map((f) => f.kind),
      ...audit([facts({ written: true })], [declaration()]).map((f) => f.kind),
      ...audit([], [declaration()]).map((f) => f.kind),
      ...audit([facts()], [declaration(), declaration()]).map((f) => f.kind),
      ...audit(
        [facts()],
        [declaration({ reason: "dynamic_writer", writtenVia: "a/b.ts" })],
        [],
      ).map((f) => f.kind),
      ...audit([facts()], [declaration({ reason: "superseded", supersededBy: ["meta.x"] })]).map(
        (f) => f.kind,
      ),
      ...audit(
        [facts(), facts({ table: "meta.gadgets" })],
        [declaration({ reason: "superseded", supersededBy: ["meta.gadgets"] })],
      ).map((f) => f.kind),
    ]);
    expect([...reached].sort()).toEqual([...STORELESS_FINDING_KINDS].sort());
  });

  it("names only the gap reasons as readers with no writer", () => {
    // An `out_of_band` table is *supposed* to be read without this workspace writing it; reporting
    // those would bury the two that matter.
    const f = [facts({ read: true }), facts({ table: "meta.gadgets", read: true })];
    const d = [
      declaration({ reason: "out_of_band" }),
      declaration({
        table: "meta.gadgets",
        reason: "unwritten_table",
        consequence: "its reader is served nothing",
      }),
    ];
    expect(readersWithNoWriter(f, d).map((x) => x.table)).toEqual(["meta.gadgets"]);
  });

  it("counts every reason, including the ones nothing uses", () => {
    const counts = countByReason([declaration()]);
    expect(counts.get("static_catalog")).toBe(1);
    expect(counts.get("unbuilt_subsystem")).toBe(0);
    expect([...counts.keys()].sort()).toEqual([...STORELESS_REASONS].sort());
  });
});

/* -------------------------------------------------------------- the workspace */

/** `meta.x` → whether anything in the workspace writes it, and whether anything reads it. */
function tableFactsFromScan(
  tables: readonly { readonly schema: string; readonly name: string }[],
  statements: readonly SqlStatement[],
  targets: readonly StatementTarget[],
  references: readonly TableReference[],
): readonly StorelessTableFacts[] {
  const written = new Set<string>();
  const read = new Set<string>();
  const byName = new Map<string, { written: boolean; read: boolean }>();

  for (const s of statements) {
    const key = `${s.schema}.${s.table}`;
    if (s.kind === "select") read.add(key);
    else written.add(key);
  }
  for (const t of targets) written.add(`${t.schema}.${t.table}`);
  for (const r of references) {
    const isWrite = r.via === "into" || r.via === "update" || r.via === "delete" || r.via === "truncate";
    if (r.schema !== null) {
      if (isWrite) written.add(`${r.schema}.${r.table}`);
      else read.add(`${r.schema}.${r.table}`);
      continue;
    }
    // The schema was an interpolation this scan could not resolve while the table was spelled out.
    // The catalog declares one schema, so the name alone decides — and matching by name is the
    // liberal direction, which for a *reference* is the safe one only because a reference can never
    // make the fence narrower: it widens `written`/`read`, and a table wrongly counted as written
    // would be reported `overtaken` the moment it is declared. Both are loud.
    const entry = byName.get(r.table) ?? { written: false, read: false };
    if (isWrite) entry.written = true;
    else entry.read = true;
    byName.set(r.table, entry);
  }

  return tables.map((t) => {
    const key = `${t.schema}.${t.name}`;
    const named = byName.get(t.name);
    return StorelessTableFactsSchema.parse({
      table: key,
      written: written.has(key) || (named?.written ?? false),
      read: read.has(key) || (named?.read ?? false),
    });
  });
}

describe("the real workspace", () => {
  const catalog = parseCatalogSource(readCatalogSource());
  const scan = scanWorkspaceSql();
  const tableFacts = tableFactsFromScan(catalog, scan.statements, scan.targets, scan.references);
  const writerless = tableFacts.filter((f) => !f.written);

  it("read the catalog and walked the workspace, rather than silently doing neither", () => {
    // Every assertion below is vacuous if either input came back empty. ADR-0333's catalog parse
    // silently returned **0** tables once, because `META_TABLES`' opening bracket was found inside
    // `readonly TableDefinition[]`, and only a count assertion caught it.
    expect(catalog.length).toBeGreaterThanOrEqual(145);
    expect(scan.unhandledGlobs).toEqual([]);
    expect(scan.files).toBeGreaterThanOrEqual(700);
    expect(scan.statements.length).toBeGreaterThanOrEqual(200);
    expect(scan.references.length).toBeGreaterThanOrEqual(200);
  });

  it("found writers for most of the catalog and writerlessness for the rest", () => {
    // The fence is vacuous in exactly one direction: if `written` came back true for everything,
    // nothing would need declaring and this file would pass having examined nothing. So the
    // writerless count is asserted as a *floor* — the opposite of the usual shape, because here the
    // risk is over-counting writers.
    expect(tableFacts.filter((f) => f.written).length).toBeGreaterThanOrEqual(55);
    expect(writerless.length).toBeGreaterThanOrEqual(75);
    // And two tables known to have no writer in any form, so a blanket `written: true` fails here.
    for (const name of ["meta.sso_providers", "meta.ml_models", "meta.cdc_checkpoints"]) {
      expect(writerless.map((f) => f.table)).toContain(name);
    }
    // And two known to have one, so a blanket `written: false` fails too.
    for (const name of ["meta.tenants", "meta.workflow_timers"]) {
      expect(writerless.map((f) => f.table)).not.toContain(name);
    }
  });

  it("reads the three tables only a reference reaches", () => {
    // The floor that decides whether this whole census is trustworthy. The statement extractor
    // deliberately skips a `SELECT` with an unresolvable target, a join or a non-bare column list,
    // so three catalogued tables are reached by nothing else: `meta.access_review_evidence`
    // (certification.ts, through an unresolvable `${this.schema}`), and `meta.users` plus
    // `meta.user_tenant_membership` (recipient-resolver.ts, through a two-table join). Reading "no
    // statement names it" as "no SQL names it" would have declared all three deliberately
    // storeless, which is false of every one. If the reference collector ever stops working, this
    // fails here rather than being absorbed into a wrong declaration.
    const readOnly = writerless.filter((f) => f.read).map((f) => f.table).sort();
    expect(readOnly).toEqual([
      "meta.access_review_evidence",
      "meta.notification_preferences",
      "meta.operate_entity_records",
      "meta.user_tenant_membership",
      "meta.users",
    ]);
    const viaReference = new Set(
      scan.references
        .filter((r) => r.via === "from" || r.via === "join")
        .map((r) => r.table),
    );
    for (const name of ["users", "user_tenant_membership", "access_review_evidence"]) {
      expect(viaReference).toContain(name);
    }
  });

  it("no catalogued table is writerless without a declaration saying why", () => {
    // The assertion this increment exists for. A new Phase-1-style table with no writer fails here
    // at the moment it is added, rather than being discovered three years later having drifted
    // eighteen columns behind its contract (ADR-0300).
    const findings = auditStorelessTables({
      facts: tableFacts,
      declarations: STORELESS_TABLES,
      scanGapFiles: PG_SCAN_GAPS.map((g) => g.file),
    });
    expect(formatStorelessFindings(findings)).toBe("");
  });

  it("declares exactly the writerless tables, and every declaration parses", () => {
    expect(STORELESS_TABLES.length).toBe(writerless.length);
    expect(new Set(STORELESS_TABLES.map((d) => d.table)).size).toBe(STORELESS_TABLES.length);
    for (const d of STORELESS_TABLES) expect(() => StorelessDeclarationSchema.parse(d)).not.toThrow();
    // Every reason is used, so none is a dead branch, and the two decision reasons that should be
    // rare are rare.
    const counts = countByReason(STORELESS_TABLES);
    for (const reason of STORELESS_REASONS) {
      expect(counts.get(reason), `no declaration uses ${reason}`).toBeGreaterThan(0);
    }
    expect(counts.get("static_catalog")).toBeLessThanOrEqual(5);
    expect(counts.get("dynamic_writer")).toBeLessThanOrEqual(3);
  });

  it("would catch the defect it was written for", () => {
    // The fence finding nothing is indistinguishable from the fence being broken, so one real
    // declaration is removed and the rule is asked about it.
    const withoutSso = STORELESS_TABLES.filter((d) => d.table !== "meta.sso_providers");
    const findings = auditStorelessTables({
      facts: tableFacts,
      declarations: withoutSso,
      scanGapFiles: PG_SCAN_GAPS.map((g) => g.file),
    });
    expect(findings.map((f) => `${f.kind}:${f.table}`)).toEqual(["undeclared:meta.sso_providers"]);

    // And the other direction: a table with a live store cannot be parked as storeless.
    const overtaken = auditStorelessTables({
      facts: tableFacts,
      declarations: [
        ...STORELESS_TABLES,
        StorelessDeclarationSchema.parse({
          table: "meta.tenants",
          reason: "out_of_band",
          owner: "kernel",
          note: "a false claim, to prove the rule reads it",
        }),
      ],
      scanGapFiles: PG_SCAN_GAPS.map((g) => g.file),
    });
    expect(overtaken.map((f) => `${f.kind}:${f.table}`)).toEqual(["overtaken:meta.tenants"]);
  });

  it("names the two gaps whose reader is already being served nothing", () => {
    // The sharp subset, asserted exactly rather than reported: a third member means somebody added
    // a reader over a table nothing writes, which is the defect shape at its worst — a surface that
    // answers "nothing" indistinguishably from "nothing is there".
    expect(readersWithNoWriter(tableFacts, STORELESS_TABLES).map((d) => d.table)).toEqual([
      "meta.access_review_evidence",
      "meta.notification_preferences",
    ]);
  });

  it("every superseded declaration names a successor that is really written", () => {
    // Pinned separately from the audit so the reason stays meaningful: `superseded` is the one
    // reason that asserts something positive about another table, and it is the one that rots when
    // the successor is itself abandoned.
    const written = new Set(tableFacts.filter((f) => f.written).map((f) => f.table));
    const successors = STORELESS_TABLES.flatMap((d) => d.supersededBy ?? []);
    expect(successors.length).toBeGreaterThanOrEqual(8);
    for (const successor of successors) expect(written).toContain(successor);
  });

  it("every declaration's owner is a real workspace package", () => {
    // An owner nothing can be looked up in is a note rather than evidence, and a package renamed out
    // from under a declaration is how the reason silently stops being checkable.
    const owners = [...new Set(STORELESS_TABLES.map((d) => d.owner))].sort();
    expect(owners.length).toBeGreaterThanOrEqual(20);
    for (const owner of owners) {
      expect(
        existsSync(join(REPO_ROOT, "packages", owner)) || existsSync(join(REPO_ROOT, "apps", owner)),
        `owner '${owner}' is not a workspace package`,
      ).toBe(true);
    }
  });

  it("every dynamic-writer declaration names a file that exists", () => {
    for (const d of STORELESS_TABLES) {
      if (d.writtenVia === undefined) continue;
      expect(existsSync(join(REPO_ROOT, d.writtenVia)), d.writtenVia).toBe(true);
    }
  });
});
