import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditUnreadableRows,
  bodyEnd,
  buildFunctionIndex,
  COST_BEARING_REASONS,
  CONSUMER_BEARING_REASONS,
  conversionExpression,
  conversionName,
  countDeclarationsByReason,
  countSitesByVerdict,
  declaredScopes,
  FENCE_BEARING_REASONS,
  formatUnreadableRowFindings,
  INLINE_GUARDS,
  inlineGuard,
  isNonProductionSource,
  isReturned,
  isRowPage,
  PAGE_READ_VERDICTS,
  PageReadSiteSchema,
  PRIMITIVE_MODULE,
  productionSources,
  REASONS_FOR_VERDICT,
  recordTypeOf,
  REFUSAL_BEARING_REASONS,
  REFUSED_ROW_PAGE_ANCHORS,
  resolveFunction,
  ROW_CONVERSION_SHAPES,
  rowPageBindingsIn,
  scanModuleForPageReads,
  scanWorkspacePageReads,
  siteKey,
  splitArguments,
  swallowsItsOwnRefusal,
  THROW_EVIDENCE_KINDS,
  throwEvidence,
  TOTAL_CALLS,
  unboundedThrowingSites,
  UNREADABLE_ROW_FINDING_KINDS,
  UNREADABLE_ROW_REASONS,
  UNREADABLE_ROW_SITES,
  UnreadableRowDeclarationSchema,
  VERDICT_DESCRIPTIONS,
  VERDICT_NEEDS_DECLARATION,
  type PageReadSite,
  type UnreadableRowDeclaration,
} from "./pg-unreadable-rows.js";
import { readWorkspaceSources, REPO_ROOT, type WorkspaceSourceFile } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ fixtures */

function site(over: Partial<PageReadSite> = {}): PageReadSite {
  return PageReadSiteSchema.parse({
    file: "packages/widgets-pg/src/widget-store.ts",
    line: 10,
    scope: "listRecent",
    conversion: "rowToWidget",
    shape: "array_map",
    verdict: "record_throwing",
    recordType: "Widget",
    evidence: [{ kind: "zod_parse", symbol: "WidgetSchema.parse" }],
    bounded: true,
    ...over,
  });
}

function declaration(over: Partial<UnreadableRowDeclaration> = {}): UnreadableRowDeclaration {
  return UnreadableRowDeclarationSchema.parse({
    file: "packages/widgets-pg/src/widget-store.ts",
    scope: "listRecent",
    conversion: "rowToWidget",
    reason: "unmigrated",
    consequence: "one refused widget costs the page",
    note: "the backlog entry for the widget store's list read",
    ...over,
  });
}

const audit = (
  sites: readonly PageReadSite[],
  declarations: readonly UnreadableRowDeclaration[],
  over: {
    readonly files?: readonly string[];
    readonly sources?: ReadonlyMap<string, string>;
    readonly unannotatedConversions?: readonly string[];
  } = {},
) =>
  auditUnreadableRows({
    sites,
    declarations,
    files: over.files ?? [],
    sources: over.sources ?? new Map(),
    unannotatedConversions: over.unannotatedConversions ?? [],
  });

/** A whole module as text, so the scan can be exercised on shapes the workspace does not hold. */
function source(
  text: string,
  file = "packages/widgets-pg/src/widget-store.ts",
): WorkspaceSourceFile {
  return { package: "@crossengin/widgets-pg", file, text };
}

function scanOne(
  text: string,
  extra: readonly WorkspaceSourceFile[] = [],
): ReturnType<typeof scanModuleForPageReads> {
  const main = source(text);
  return scanModuleForPageReads(main, buildFunctionIndex([main, ...extra]));
}

/* ------------------------------------------------------------------ the shape */

describe("the declared shape", () => {
  it("names six verdicts, five reasons, six evidence kinds and three shapes", () => {
    expect([...PAGE_READ_VERDICTS]).toEqual([
      "guarded_by_primitive",
      "guarded_in_place",
      "record_throwing",
      "record_total",
      "record_dropping",
      "projection",
    ]);
    expect([...UNREADABLE_ROW_REASONS]).toEqual([
      "page_refusal_declared",
      "page_is_indivisible",
      "record_asserted_not_parsed",
      "row_dropped_deliberately",
      "unmigrated",
    ]);
    expect([...THROW_EVIDENCE_KINDS]).toEqual([
      "zod_parse",
      "json_parse",
      "explicit_throw",
      "throwing_callee",
      "unresolved_callee",
      "swallowing_callee",
    ]);
    expect([...ROW_CONVERSION_SHAPES]).toEqual(["array_map", "row_loop", "primitive"]);
    expect([...INLINE_GUARDS]).toEqual(["none", "reports", "drops"]);
  });

  it("answers for every verdict in all three total maps, and the maps agree", () => {
    for (const verdict of PAGE_READ_VERDICTS) {
      expect(typeof VERDICT_NEEDS_DECLARATION[verdict], verdict).toBe("boolean");
      expect(VERDICT_DESCRIPTIONS[verdict].length, verdict).toBeGreaterThan(10);
      // A verdict needs a declaration iff some reason may be given for it — two maps, one rule, so a
      // sixth verdict cannot be added to one and forgotten in the other.
      expect(REASONS_FOR_VERDICT[verdict].length > 0, verdict).toBe(
        VERDICT_NEEDS_DECLARATION[verdict],
      );
    }
    const admissible = new Set(PAGE_READ_VERDICTS.flatMap((v) => [...REASONS_FOR_VERDICT[v]]));
    expect([...admissible].sort()).toEqual([...UNREADABLE_ROW_REASONS].sort());
  });

  it("partitions the field-bearing reasons, leaving none that bears nothing", () => {
    // ADR-0330's shape: the field-bearing sets are asserted and the remainder named, so a sixth
    // reason added to none of them fails here rather than quietly carrying any field it likes.
    const bearing = new Set([
      ...REFUSAL_BEARING_REASONS,
      ...CONSUMER_BEARING_REASONS,
      ...FENCE_BEARING_REASONS,
      ...COST_BEARING_REASONS,
    ]);
    expect(UNREADABLE_ROW_REASONS.filter((r) => !bearing.has(r))).toEqual([]);
    // `page_refusal_declared` is the one reason bearing no consequence, because nothing is lost.
    expect([...COST_BEARING_REASONS].sort()).toEqual([
      "record_asserted_not_parsed",
      "row_dropped_deliberately",
      "unmigrated",
    ]);
  });

  it("requires a declared refusal to name both its code and the file that answers it", () => {
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...declaration(), reason: "page_refusal_declared" }),
    ).toThrow();
    expect(() =>
      declaration({
        reason: "page_refusal_declared",
        consequence: undefined,
        refusalCode: "page_unreadable",
        refusedIn: "apps/operate-server/src/routes.ts",
      }),
    ).not.toThrow();
    // And forbids them otherwise, so a backlog entry cannot borrow a refusal's credibility.
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...declaration(), refusalCode: "x_unreadable" }),
    ).toThrow();
  });

  it("requires an indivisible page to name its consumer, and a gap to name its cost", () => {
    expect(() =>
      UnreadableRowDeclarationSchema.parse({
        file: "packages/widgets-pg/src/widget-store.ts",
        scope: "counts",
        conversion: "<inline>",
        reason: "page_is_indivisible",
        note: "an aggregate cannot be served partial",
      }),
    ).toThrow();
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...declaration(), consequence: undefined }),
    ).toThrow();
  });

  it("refuses a fencedBy that is prose rather than a symbol, and admits 'nothing'", () => {
    // The field's whole purpose is that the rule looks the symbol up; a sentence there would be
    // unverifiable, and `nothing` is the one admissible non-symbol — an admission the census counts.
    const base = {
      file: "packages/widgets-pg/src/widget-store.ts",
      scope: "listRecent",
      conversion: "rowToWidget",
      reason: "record_asserted_not_parsed" as const,
      consequence: "a malformed widget is served",
      note: "the mapper returns a bare literal typed as Widget",
    };
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...base, fencedBy: "WidgetSchema" }),
    ).not.toThrow();
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...base, fencedBy: "nothing" }),
    ).not.toThrow();
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...base, fencedBy: "the write path checks it" }),
    ).toThrow();
    expect(() => UnreadableRowDeclarationSchema.parse(base)).toThrow();
  });

  it("refuses a path outside the workspace members and a note with nothing in it", () => {
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...declaration(), file: "../etc/passwd.ts" }),
    ).toThrow();
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...declaration(), file: "src/widget-store.ts" }),
    ).toThrow();
    expect(() =>
      UnreadableRowDeclarationSchema.parse({ ...declaration(), note: "too short" }),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------- the rule */

describe("auditUnreadableRows", () => {
  it("passes a throwing site that is declared", () => {
    expect(audit([site()], [declaration()])).toEqual([]);
  });

  it("passes a guarded site and a projection with no declaration", () => {
    expect(audit([site({ verdict: "guarded_by_primitive", evidence: [] })], [])).toEqual([]);
    expect(audit([site({ verdict: "projection", recordType: null, evidence: [] })], [])).toEqual([]);
  });

  it("reports an undeclared throwing map — the fence", () => {
    const found = audit([site()], []);
    expect(found.map((f) => f.kind)).toEqual(["undeclared_throwing_map"]);
    expect(found[0]?.detail).toContain("zod_parse:WidgetSchema.parse");
    expect(found[0]?.detail).toContain("readRows");
  });

  it("says, of an unbounded throwing read, that it has no LIMIT", () => {
    // The field is reported and never part of a verdict, so this is where it is visible.
    expect(audit([site({ bounded: false })], [])[0]?.detail).toContain("no LIMIT");
    expect(audit([site({ bounded: true })], [])[0]?.detail).not.toContain("no LIMIT");
  });

  it("reports an asserted record and a dropped row as their own kinds", () => {
    expect(audit([site({ verdict: "record_total", evidence: [] })], []).map((f) => f.kind)).toEqual([
      "undeclared_asserted_record",
    ]);
    const dropped = audit(
      [
        site({
          verdict: "record_dropping",
          evidence: [{ kind: "swallowing_callee", symbol: "tryWidgetFromRow" }],
        }),
      ],
      [],
    );
    expect(dropped.map((f) => f.kind)).toEqual(["undeclared_dropped_row"]);
    expect(dropped[0]?.detail).toContain("nothing is told");
  });

  it("reports an undeclared local guard as the convergence backlog, not as a defect", () => {
    const found = audit([site({ verdict: "guarded_in_place" })], []);
    expect(found.map((f) => f.kind)).toEqual(["unconverged_local_guard"]);
    expect(found[0]?.detail).toContain("second spelling");
  });

  it("reports a declaration the primitive has overtaken", () => {
    const found = audit([site({ verdict: "guarded_by_primitive", evidence: [] })], [declaration()]);
    expect(found.map((f) => f.kind)).toEqual(["overtaken"]);
    expect(found[0]?.detail).toContain("delete the declaration");
  });

  it("reports a declaration for a site the scan cannot find", () => {
    const found = audit([], [declaration()]);
    expect(found.map((f) => f.kind)).toEqual(["unknown_site"]);
    expect(found[0]?.detail).toContain("re-point or delete");
  });

  it("reports the same site declared twice", () => {
    const found = audit([site()], [declaration(), declaration({ reason: "unmigrated" })]);
    expect(found.map((f) => f.kind)).toEqual(["duplicate"]);
  });

  it("reports a reason that contradicts the verdict the scan derived", () => {
    // A site that provably cannot throw may not be declared a *refusal*: there is nothing to refuse.
    const found = audit(
      [site({ verdict: "record_total", evidence: [] })],
      [
        declaration({
          reason: "page_refusal_declared",
          consequence: undefined,
          refusalCode: "widget_page_unreadable",
          refusedIn: "apps/operate-server/src/routes.ts",
        }),
      ],
    );
    expect(found.map((f) => f.kind)).toContain("reason_contradicts_verdict");
  });

  it("reports a refusal code the named handler does not answer with, and a handler that is gone", () => {
    const refusal = declaration({
      reason: "page_refusal_declared",
      consequence: undefined,
      refusalCode: "widget_page_unreadable",
      refusedIn: "apps/operate-server/src/routes.ts",
    });
    expect(
      audit([site()], [refusal], {
        files: ["apps/operate-server/src/routes.ts"],
        sources: new Map([
          ["apps/operate-server/src/routes.ts", 'json(500, {error: "something_else"})'],
        ]),
      }).map((f) => f.kind),
    ).toEqual(["refusal_code_absent"]);
    expect(audit([site()], [refusal]).map((f) => f.kind)).toEqual(["refusal_handler_missing"]);
    // And passes when the handler really answers it, which is the whole cost of the reason.
    expect(
      audit([site()], [refusal], {
        files: ["apps/operate-server/src/routes.ts"],
        sources: new Map([
          ["apps/operate-server/src/routes.ts", 'json(500, {error: "widget_page_unreadable"})'],
        ]),
      }),
    ).toEqual([]);
  });

  it("reports a fence symbol nothing in the workspace declares, and admits 'nothing'", () => {
    const asserted = site({ verdict: "record_total", evidence: [] });
    const fenced = declaration({
      reason: "record_asserted_not_parsed",
      fencedBy: "validateWidget",
      consequence: "a malformed widget is served",
    });
    expect(audit([asserted], [fenced]).map((f) => f.kind)).toEqual(["fence_symbol_missing"]);
    expect(
      audit([asserted], [fenced], {
        sources: new Map([["a/b.ts", "export function validateWidget() {}"]]),
      }),
    ).toEqual([]);
    // `nothing` asserts no symbol, so it is never reported missing — it is the admission itself.
    expect(
      audit(
        [asserted],
        [
          declaration({
            reason: "record_asserted_not_parsed",
            fencedBy: "nothing",
            consequence: "a malformed widget is served",
          }),
        ],
      ),
    ).toEqual([]);
  });

  it("reports a conversion whose return type could not be read, rather than skipping it", () => {
    const found = audit([site()], [declaration()], {
      unannotatedConversions: ["packages/widgets-pg/src/widget-store.ts::listRecent::rowToWidget"],
    });
    expect(found.map((f) => f.kind)).toEqual(["conversion_unresolved"]);
    expect(found[0]?.detail).toContain("decided by failing to read it");
  });

  it("every finding kind is reachable", () => {
    const refusal = declaration({
      reason: "page_refusal_declared",
      consequence: undefined,
      refusalCode: "widget_page_unreadable",
      refusedIn: "apps/operate-server/src/routes.ts",
    });
    const reached = new Set<string>([
      ...audit([site()], []).map((f) => f.kind),
      ...audit([site({ verdict: "record_total", evidence: [] })], []).map((f) => f.kind),
      ...audit([site({ verdict: "record_dropping" })], []).map((f) => f.kind),
      ...audit([site({ verdict: "guarded_in_place" })], []).map((f) => f.kind),
      ...audit([site({ verdict: "guarded_by_primitive", evidence: [] })], [declaration()]).map(
        (f) => f.kind,
      ),
      ...audit([], [declaration()]).map((f) => f.kind),
      ...audit([site()], [declaration(), declaration()]).map((f) => f.kind),
      ...audit([site({ verdict: "record_total", evidence: [] })], [refusal]).map((f) => f.kind),
      ...audit([site()], [refusal]).map((f) => f.kind),
      ...audit([site()], [refusal], {
        files: ["apps/operate-server/src/routes.ts"],
        sources: new Map([["apps/operate-server/src/routes.ts", "nothing"]]),
      }).map((f) => f.kind),
      ...audit(
        [site({ verdict: "record_total", evidence: [] })],
        [
          declaration({
            reason: "record_asserted_not_parsed",
            fencedBy: "absentSymbol",
            consequence: "a malformed widget is served",
          }),
        ],
      ).map((f) => f.kind),
      ...audit([site()], [declaration()], { unannotatedConversions: ["a::b::c"] }).map((f) => f.kind),
    ]);
    expect([...reached].sort()).toEqual([...UNREADABLE_ROW_FINDING_KINDS].sort());
  });

  it("counts every verdict and every reason, including the ones nothing uses", () => {
    const verdicts = countSitesByVerdict([site()]);
    expect(verdicts.get("record_throwing")).toBe(1);
    expect(verdicts.get("record_dropping")).toBe(0);
    expect([...verdicts.keys()].sort()).toEqual([...PAGE_READ_VERDICTS].sort());
    const reasons = countDeclarationsByReason([declaration()]);
    expect(reasons.get("unmigrated")).toBe(1);
    expect(reasons.get("page_refusal_declared")).toBe(0);
    expect([...reasons.keys()].sort()).toEqual([...UNREADABLE_ROW_REASONS].sort());
  });

  it("names the unbounded throwing sites and only those", () => {
    const sites = [
      site({ bounded: false }),
      site({ scope: "other", bounded: true }),
      site({ scope: "third", bounded: false, verdict: "record_total", evidence: [] }),
    ];
    expect(unboundedThrowingSites(sites).map((s) => s.scope)).toEqual(["listRecent"]);
  });
});

/* ------------------------------------------------------------------ the scan */

describe("scanning a module", () => {
  it("finds a mapper passed by reference, which carries no call at all", () => {
    // **The shape that was wrong first.** `rows.map(rowToWidget)` passes the mapper by reference, so
    // the argument text holds no call, and a scan over calls found no evidence and read the site as
    // total — the fence quietly not fencing, on 12 of 20 apparent `record_total` sites. Asserted on
    // the bare-reference form explicitly, because the arrow form every real store also uses passes
    // whether or not this works.
    const result = scanOne(`
      function rowToWidget(row: Record<string, unknown>): Widget {
        return WidgetSchema.parse({ id: row["id"] });
      }
      export class PostgresWidgetStore {
        async listRecent(): Promise<readonly Widget[]> {
          const result = await this.conn.query("SELECT * FROM w LIMIT 10");
          return result.rows.map(rowToWidget);
        }
      }
    `);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]?.verdict).toBe("record_throwing");
    expect(result.sites[0]?.conversion).toBe("rowToWidget");
    expect(result.sites[0]?.evidence.map((e) => e.kind)).toEqual(["throwing_callee"]);
    expect(result.sites[0]?.recordType).toBe("Widget");
    expect(result.sites[0]?.bounded).toBe(true);
  });

  it("reads a throw one level down, through a guard that is not a zod parse", () => {
    // `requireIsoInstant` and its siblings throw a plain Error, so a scan looking only for `.parse`
    // misses them — and they are what most of this repo's row mappers are built out of.
    const result = scanOne(`
      function requireText(row: Record<string, unknown>, c: string): string {
        const v = row[c];
        if (typeof v !== "string") throw new Error("missing column");
        return v;
      }
      function rowToWidget(row: Record<string, unknown>): Widget {
        return { id: requireText(row, "id") };
      }
      async function listRecent(conn: PgConnection): Promise<readonly Widget[]> {
        const result = await conn.query("SELECT 1");
        return result.rows.map((row) => rowToWidget(row));
      }
    `);
    expect(result.sites[0]?.verdict).toBe("record_throwing");
    expect(result.sites[0]?.evidence.map((e) => e.symbol)).toEqual(["rowToWidget"]);
  });

  it("calls a bare object literal typed as the contract an asserted record, not a projection", () => {
    const result = scanOne(`
      function rowToWidget(row: Record<string, unknown>): Widget {
        return { id: String(row["id"]), kind: String(row["kind"]) };
      }
      async function listRecent(conn: PgConnection): Promise<readonly Widget[]> {
        const result = await conn.query("SELECT 1");
        return result.rows.map(rowToWidget);
      }
    `);
    expect(result.sites[0]?.verdict).toBe("record_total");
    expect(result.sites[0]?.recordType).toBe("Widget");
  });

  it("calls a column read a projection, and counts it rather than skipping it", () => {
    const result = scanOne(`
      async function listIds(conn: PgConnection): Promise<readonly string[]> {
        const result = await conn.query("SELECT id FROM w");
        return result.rows.map((r) => String(r.id));
      }
    `);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]?.verdict).toBe("projection");
    expect(result.sites[0]?.recordType).toBeNull();
  });

  it("separates a conversion that reports its refusal from one that drops it", () => {
    const reporting = scanOne(`
      function rowToWidget(row: Record<string, unknown>): Widget {
        return WidgetSchema.parse(row);
      }
      async function listRecent(conn: PgConnection, report: Reporter): Promise<readonly Widget[]> {
        const result = await conn.query("SELECT 1");
        const out: Widget[] = [];
        for (const row of result.rows) {
          try {
            out.push(rowToWidget(row));
          } catch (err) {
            report(String(row["id"]));
          }
        }
        return out;
      }
    `);
    expect(reporting.sites[0]?.verdict).toBe("guarded_in_place");

    const dropping = scanOne(`
      function rowToWidget(row: Record<string, unknown>): Widget {
        return WidgetSchema.parse(row);
      }
      function tryWidgetFromRow(row: Record<string, unknown>): Widget | null {
        try {
          return rowToWidget(row);
        } catch {
          return null;
        }
      }
      async function listRecent(conn: PgConnection): Promise<readonly Widget[]> {
        const result = await conn.query("SELECT 1");
        const out: Widget[] = [];
        for (const row of result.rows) {
          const w = tryWidgetFromRow(row);
          if (w !== null) out.push(w);
        }
        return out;
      }
    `);
    expect(dropping.sites[0]?.verdict).toBe("record_dropping");
    expect(dropping.sites[0]?.evidence.map((e) => e.kind)).toEqual(["swallowing_callee"]);
  });

  it("does not read a catch that re-throws as a guard", () => {
    const result = scanOne(`
      async function listRecent(conn: PgConnection): Promise<readonly Widget[]> {
        const result = await conn.query("SELECT 1");
        const out: Widget[] = [];
        for (const row of result.rows) {
          try {
            out.push(WidgetSchema.parse(row));
          } catch (err) {
            throw new Error("page unreadable");
          }
        }
        return out;
      }
    `);
    expect(result.sites[0]?.verdict).toBe("record_throwing");
  });

  it("recognises the primitive, keeping the conversion's name so a declaration reads overtaken", () => {
    // The key survives the migration on purpose: an obsolete declaration should say "delete this
    // line", not "find out what happened to this site".
    const result = scanOne(`
      function rowToWidget(row: Record<string, unknown>): Widget {
        return WidgetSchema.parse(row);
      }
      async function listRecent(conn: PgConnection, onUnreadable: Reporter): Promise<readonly Widget[]> {
        const result = await conn.query("SELECT 1 LIMIT 5");
        return readRows(result.rows, rowToWidget, (r) => String(r["id"]), onUnreadable);
      }
    `);
    expect(result.sites[0]?.shape).toBe("primitive");
    expect(result.sites[0]?.verdict).toBe("guarded_by_primitive");
    expect(result.sites[0]?.conversion).toBe("rowToWidget");
  });

  it("ignores a rows array that did not come from a query", () => {
    // The measurement behind `REFUSED_ROW_PAGE_ANCHORS`: a domain object with a `rows` field is not a page.
    const result = scanOne(`
      function summarize(run: PreviewRun): PreviewSummary {
        const out: Row[] = [];
        for (const row of run.rows) {
          out.push(rowToPreview(row));
        }
        return { rows: out };
      }
    `);
    expect(result.sites).toEqual([]);
    expect(result.coverage.untracedRowReceivers).toHaveLength(1);
  });

  it("ignores a row-array parameter in a module that issues no query", () => {
    const text = `
      function parseAll(rows: readonly Record<string, unknown>[]): readonly Widget[] {
        const out: Widget[] = [];
        for (const row of rows) out.push(WidgetSchema.parse(row));
        return out;
      }
    `;
    expect(scanOne(text).sites).toEqual([]);
    // And finds it in a module that does, which is how `parseRows(result.rows)` is reached.
    const withQuery = scanOne(`${text}
      async function listRecent(conn: PgConnection): Promise<readonly Widget[]> {
        const result = await conn.query("SELECT 1");
        return parseAll(result.rows);
      }
    `);
    expect(withQuery.sites.map((s) => s.verdict)).toEqual(["record_throwing"]);
  });

  it("does not take the enclosing element type for a map that is not returned", () => {
    // `claimQueued`'s shape: two pages in one method, only one of which is the method's answer.
    const result = scanOne(`
      async function claimQueued(conn: PgConnection): Promise<readonly Claimed[]> {
        const selected = await conn.query("SELECT 1");
        const ids = selected.rows.map((r) => String(r["id"]));
        return selected.rows.map((r) => ({ id: String(r["id"]), n: ids.length }));
      }
    `);
    expect(result.sites.map((s) => s.verdict).sort()).toEqual(["projection", "record_total"]);
    // The two inline conversions **do** share a key, which is the declaration shape's one stated
    // weakness — safe exactly while at most one of them needs a declaration, which is what the
    // verdicts above establish and what the workspace test asserts over every site.
    expect(new Set(result.sites.map((s) => siteKey(s))).size).toBe(1);
    expect(result.sites.filter((s) => VERDICT_NEEDS_DECLARATION[s.verdict])).toHaveLength(1);
  });

  it("reads a schema parse written out at the call site, naming the schema", () => {
    const result = scanOne(`
      async function loadChain(conn: PgConnection): Promise<readonly ChainedLogEntry[]> {
        const rows = (await conn.query("SELECT 1")).rows;
        return rows.map((row) => ChainedLogEntrySchema.parse({ id: row["id"] }));
      }
    `);
    expect(result.sites[0]?.conversion).toBe("ChainedLogEntrySchema.parse");
    expect(result.sites[0]?.recordType).toBe("ChainedLogEntry");
    expect(result.sites[0]?.evidence.map((e) => e.kind)).toEqual(["zod_parse"]);
  });

  it("believes neither a comment nor a string that contains the defect's own spelling", () => {
    // **The hazard this directory has been bitten by.** `read-rows.ts`' doc comment contains
    // `result.rows.map(rowToX)` verbatim, and a scan that believed a raw match would report the
    // primitive's own documentation as a defect (ADR-0337 found exactly that in a sibling rule).
    const result = scanOne(`
      /**
       * \`result.rows.map(rowToWidget)\` is the defect this module replaces.
       */
      const PROSE = "result.rows.map(rowToWidget)";
      async function listRecent(conn: PgConnection, noop: Reporter): Promise<readonly Widget[]> {
        // result.rows.map(rowToWidget)
        const result = await conn.query("SELECT 1");
        return readRows(result.rows, rowToWidget, (r) => String(r["id"]), noop);
      }
    `);
    expect(result.sites.map((s) => s.shape)).toEqual(["primitive"]);
  });

  it("skips a regex containing a quote without swallowing the code after it", () => {
    // `opensRegexLiteral`'s reason, shared with `stripComments`: `"([^"]+)"` carries three quotes,
    // so pairing them as delimiters blanks whatever follows — here, the whole read.
    const result = scanOne(`
      const QUOTED = /"([^"]+)"/g;
      async function listRecent(conn: PgConnection): Promise<readonly Widget[]> {
        const result = await conn.query("SELECT 1");
        return result.rows.map(rowToWidget);
      }
      function rowToWidget(row: Record<string, unknown>): Widget {
        return WidgetSchema.parse(row);
      }
    `);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]?.verdict).toBe("record_throwing");
  });

  it("traces a binding whose generic type argument contains a semicolon", () => {
    // `signal-store.ts`' shape: a naive read to the first `;` stops inside the generic and the page
    // goes untraced, losing the only read in that file.
    const result = scanOne(`
      async function lookup(conn: PgConnection): Promise<readonly Delivery[]> {
        const result = await conn.query<{ signal_id: string; instance_id: string | null }>("SELECT 1");
        return result.rows.map(rowToDelivery);
      }
      function rowToDelivery(row: Record<string, unknown>): Delivery {
        return DeliverySchema.parse(row);
      }
    `);
    expect(result.sites).toHaveLength(1);
  });

  it("traces a destructured pair of query results", () => {
    const bindings = rowPageBindingsIn(
      `const [checks, columns] = await Promise.all([conn.query(A), conn.query(B)]);`,
    );
    expect([...bindings.results].sort()).toEqual(["checks", "columns"]);
    expect(isRowPage("checks.rows", bindings)).toBe(true);
    expect(isRowPage("other.rows", bindings)).toBe(false);
  });

  it("attributes a conversion to the class method it sits in, not to the module", () => {
    // The reason `functionSpans` was refused: a file with four such methods would collapse to one
    // declaration key.
    const result = scanOne(`
      export class PostgresWidgetStore {
        async listOpen(): Promise<readonly Widget[]> {
          const a = await this.conn.query("SELECT 1");
          return a.rows.map(rowToWidget);
        }
        async listRecent(): Promise<readonly Widget[]> {
          const b = await this.conn.query("SELECT 2");
          return b.rows.map(rowToWidget);
        }
      }
      function rowToWidget(row: Record<string, unknown>): Widget {
        return WidgetSchema.parse(row);
      }
    `);
    expect(result.sites.map((s) => s.scope).sort()).toEqual(["listOpen", "listRecent"]);
  });

  it("reports a named conversion with no return annotation rather than guessing", () => {
    const result = scanOne(`
      function rowToWidget(row) {
        return WidgetSchema.parse(row);
      }
      async function listRecent(conn: PgConnection) {
        const result = await conn.query("SELECT 1");
        return result.rows.map(rowToWidget);
      }
    `);
    expect(result.coverage.unannotated).toEqual([
      "packages/widgets-pg/src/widget-store.ts::listRecent::rowToWidget",
    ]);
  });
});

/* ----------------------------------------------------------------- the parts */

describe("the pieces, on inputs the workspace does not hold", () => {
  it("peels a record type out of its wrappers and refuses a primitive", () => {
    expect(recordTypeOf("Promise<readonly Widget[]>")).toBe("Widget");
    expect(recordTypeOf("Widget | null")).toBe("Widget");
    expect(recordTypeOf("ReadonlyArray<Widget>")).toBe("Widget");
    expect(recordTypeOf("string")).toBeNull();
    expect(recordTypeOf("{ id: string }")).toBeNull();
    expect(recordTypeOf(null)).toBeNull();
    // The array requirement, which is what the enclosing-scope fallback turns on.
    expect(recordTypeOf("Promise<Survey>", { requireArray: true })).toBeNull();
    expect(recordTypeOf("Promise<readonly Widget[]>", { requireArray: true })).toBe("Widget");
  });

  it("names a conversion by the call the row is handed to, never by a coercion helper", () => {
    expect(conversionName("rowToWidget")).toBe("rowToWidget");
    expect(conversionName("this.rowToWidget")).toBe("rowToWidget");
    expect(conversionName("(row) => rowToWidget(row)")).toBe("rowToWidget");
    expect(conversionName("(r) => ({ id: str(r.id) })")).toBe("<inline>");
    expect(conversionName("const n = intOf(row.count);", "row")).toBe("<inline>");
    expect(conversionName("(row) => WidgetSchema.parse({ id: row.id })")).toBe("WidgetSchema.parse");
    expect(conversionName("(row) => compile(rowToWidget(row))")).toBe("rowToWidget");
  });

  it("applies a by-reference mapper to a row so its body is reached", () => {
    expect(conversionExpression("rowToWidget")).toBe("rowToWidget(row)");
    expect(conversionExpression("this.rowToWidget")).toBe("rowToWidget(row)");
    expect(conversionExpression("(r) => f(r)")).toBe("(r) => f(r)");
  });

  it("answers the three inline-guard cases", () => {
    expect(inlineGuard("{ const x = f(row); }")).toBe("none");
    expect(inlineGuard("try { f(row); } catch { return null; }")).toBe("drops");
    expect(inlineGuard("try { f(row); } catch {}")).toBe("drops");
    expect(inlineGuard("try { f(row); } catch (e) { report(e); }")).toBe("reports");
    expect(inlineGuard("try { f(row); } catch (e) { throw e; }")).toBe("none");
    expect(swallowsItsOwnRefusal("{ try { return f(row); } catch { return null; } }")).toBe(true);
    expect(swallowsItsOwnRefusal("{ return f(row); }")).toBe(false);
  });

  it("treats safeParse and a zod constructor as total, and a parse as throwing", () => {
    const index = buildFunctionIndex([]);
    expect(TOTAL_CALLS.has("safeParse")).toBe(true);
    expect(throwEvidence("WidgetSchema.safeParse(row)", "a/b.ts", index)).toEqual([]);
    expect(throwEvidence("z.enum(KINDS)", "a/b.ts", index)).toEqual([]);
    expect(throwEvidence("WidgetSchema.parse(row)", "a/b.ts", index).map((e) => e.kind)).toEqual([
      "zod_parse",
    ]);
    expect(throwEvidence("JSON.parse(text)", "a/b.ts", index).map((e) => e.kind)).toEqual([
      "json_parse",
    ]);
    // An unresolved callee is throw evidence, which is the fail-closed direction.
    expect(throwEvidence("mystery(row)", "a/b.ts", index).map((e) => e.kind)).toEqual([
      "unresolved_callee",
    ]);
  });

  it("resolves a name in its own file before its package, and refuses an ambiguous one", () => {
    // ADR-0354's bare-name-map defect, which this rule reproduced once: `safeParse` resolved against
    // a workspace function of that name and two sites read `throwing_callee:safeParse`.
    const index = buildFunctionIndex([
      source("function helper(): string { return ''; }", "packages/a-pg/src/one.ts"),
      source("function helper(): number { return 1; }", "packages/b-pg/src/two.ts"),
      source("function helper(): boolean { return true; }", "packages/b-pg/src/three.ts"),
    ]);
    expect(resolveFunction(index, "packages/a-pg/src/one.ts", "helper")?.returnType).toBe("string");
    // Two in one package and none in this file: unresolved rather than a guess.
    expect(resolveFunction(index, "packages/b-pg/src/other.ts", "helper")).toBeNull();
  });

  it("splits arguments at the top level only", () => {
    expect(splitArguments("rows, rowToWidget, (r) => id(r, 1), report")).toEqual([
      "rows",
      "rowToWidget",
      "(r) => id(r, 1)",
      "report",
    ]);
  });

  it("finds a body's end through a string holding a brace", () => {
    const code = `{ const s = "}"; }`;
    expect(bodyEnd(code, 0)).toBe(code.length);
  });

  it("answers isReturned for a returned map and not for an assigned one", () => {
    const a = `return rows.map(f)`;
    expect(isReturned(a, a.indexOf("rows"))).toBe(true);
    const b = `const x = rows.map(f)`;
    expect(isReturned(b, b.indexOf("rows"))).toBe(false);
  });

  it("names test surfaces and the primitive's own module as out of scope", () => {
    expect(isNonProductionSource("packages/a-pg/src/store.test.ts")).toBe(true);
    expect(isNonProductionSource("packages/a-pg/src/test-fakes.ts")).toBe(true);
    expect(isNonProductionSource("packages/a/src/fixtures.ts")).toBe(true);
    expect(isNonProductionSource("packages/a-pg/src/store.ts")).toBe(false);
    expect(
      productionSources([
        source("", PRIMITIVE_MODULE),
        source("", "packages/a-pg/src/store.ts"),
      ]).map((s) => s.file),
    ).toEqual(["packages/a-pg/src/store.ts"]);
  });

  it("finds a class method's return annotation as well as a function's", () => {
    const scopes = declaredScopes(`
      export class Store {
        async listRecent(limit: number): Promise<readonly Widget[]> {
          if (limit < 1) { return []; }
          return [];
        }
      }
      function helper(a: string): number { return 1; }
      const arrow = (a: string): boolean => { return true; };
    `);
    const byName = new Map(scopes.map((s) => [s.name, s.returnType]));
    expect(byName.get("listRecent")).toBe("Promise<readonly Widget[]>");
    expect(byName.get("helper")).toBe("number");
    expect(byName.get("arrow")).toBe("boolean");
    // And does not mistake a control-flow block for a scope.
    expect(scopes.map((s) => s.name)).not.toContain("if");
  });
});

/* -------------------------------------------------------------- the workspace */

describe("the real workspace", () => {
  const { files, unhandledGlobs } = readWorkspaceSources();
  const scan = scanWorkspacePageReads(files, unhandledGlobs);
  const needing = scan.sites.filter((s) => VERDICT_NEEDS_DECLARATION[s.verdict]);

  it("walked the workspace rather than silently walking nothing", () => {
    // Every assertion below is vacuous if the walk came back empty.
    expect(scan.unhandledGlobs).toEqual([]);
    expect(scan.files).toBeGreaterThanOrEqual(700);
    expect(scan.sites.length).toBeGreaterThanOrEqual(60);
    expect(existsSync(join(REPO_ROOT, PRIMITIVE_MODULE))).toBe(true);
  });

  it("found both the guarded and the unguarded shapes, so neither matcher has stopped matching", () => {
    // **The floors are one-sided and the main one is on the side that would pass on zero.** If the
    // `.map`/loop matcher stopped matching, every site would vanish or read `guarded_by_primitive`
    // and this file would pass having examined nothing — so the *declaration-needing* count carries
    // the floor. The primitive's own floor is the weaker one by construction: if that matcher broke,
    // a migrated site would reappear as a throwing one and demand a declaration, which fails loudly.
    expect(needing.length).toBeGreaterThanOrEqual(40);
    const counts = countSitesByVerdict(scan.sites);
    expect(counts.get("guarded_by_primitive")).toBeGreaterThanOrEqual(3);
    expect(counts.get("record_throwing")).toBeGreaterThanOrEqual(20);
    expect(counts.get("projection")).toBeGreaterThanOrEqual(10);
  });

  it("gives every declaration-needing site a key of its own", () => {
    // The key is `(file, scope, conversion)` and deliberately carries no line number, so two sites
    // in one method must differ in their conversion or one declaration would stand for both.
    const keys = needing.map((s) => siteKey(s));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("no multi-row read loses a page without a declaration saying why", () => {
    // The assertion this rule exists for.
    const findings = auditUnreadableRows({
      sites: scan.sites,
      declarations: UNREADABLE_ROW_SITES,
      files: scan.scanned,
      sources: scan.sources,
      unannotatedConversions: scan.coverage.unannotated,
    });
    expect(formatUnreadableRowFindings(findings)).toBe("");
  });

  it("declares exactly the sites that need one, and every declaration parses", () => {
    expect(UNREADABLE_ROW_SITES.length).toBe(needing.length);
    expect(new Set(UNREADABLE_ROW_SITES.map((d) => siteKey(d))).size).toBe(
      UNREADABLE_ROW_SITES.length,
    );
    for (const d of UNREADABLE_ROW_SITES) {
      expect(() => UnreadableRowDeclarationSchema.parse(d), siteKey(d)).not.toThrow();
    }
    // Every reason is used, so none is a dead branch of the vocabulary.
    const counts = countDeclarationsByReason(UNREADABLE_ROW_SITES);
    for (const reason of UNREADABLE_ROW_REASONS) {
      expect(counts.get(reason), `no declaration uses ${reason}`).toBeGreaterThan(0);
    }
  });

  it("every declared file exists, and every declared refusal is really answered", () => {
    for (const d of UNREADABLE_ROW_SITES) {
      expect(existsSync(join(REPO_ROOT, d.file)), d.file).toBe(true);
      if (d.refusedIn !== undefined) {
        expect(existsSync(join(REPO_ROOT, d.refusedIn)), d.refusedIn).toBe(true);
        expect(scan.sources.get(d.refusedIn) ?? "", d.refusedIn).toContain(d.refusalCode ?? "");
      }
    }
  });

  it("the conventions it leans on still cover what it claims", () => {
    // **Re-asked every run rather than measured once.** A convention measured once goes stale in
    // silence and takes the population with it, which is `pg-binding-names.ts`' rule one rule across.
    expect(scan.coverage.unannotated).toEqual([]);
    expect(scan.coverage.destructured).toEqual([]);
    // The excluded `<x>.rows` receivers are a small, named set — a jump here means the binding
    // tracer stopped tracing and sites are being dropped, which the site floor above would not see
    // if it happened a few files at a time.
    expect(scan.coverage.untracedRowReceivers.length).toBeLessThanOrEqual(6);
  });

  it("would catch the defect it was written for, in both directions", () => {
    // The fence finding nothing is indistinguishable from the fence being broken, so one real
    // declaration is removed and the rule is asked about it.
    //
    // Chosen **structurally** and not by name. It named `tombstone-store::scanAll` until that site
    // was migrated an hour later in the same increment, and the test then failed for the one reason
    // that is not a regression: the work got done. A backlog entry is the least durable thing in
    // this directory to point at, so the control is "whatever `unmigrated` entry still exists" —
    // which also means this test retires itself honestly, by failing with a message about an empty
    // backlog, on the day the last one is closed.
    const target = UNREADABLE_ROW_SITES.find((d) => d.reason === "unmigrated");
    expect(target, "an unmigrated declaration to use as the control").toBeDefined();
    const key = siteKey(target ?? { file: "", scope: "", conversion: "" });
    const findings = auditUnreadableRows({
      sites: scan.sites,
      declarations: UNREADABLE_ROW_SITES.filter((d) => siteKey(d) !== key),
      files: scan.scanned,
      sources: scan.sources,
      unannotatedConversions: [],
    });
    expect(findings.map((f) => `${f.kind}:${f.site}`)).toEqual([`undeclared_throwing_map:${key}`]);

    // And the other direction: a site the primitive already guards cannot be parked as a backlog
    // entry, which is what keeps this list from outliving the work it describes.
    const guarded = scan.sites.find((s) => s.verdict === "guarded_by_primitive");
    expect(guarded, "a site using the primitive").toBeDefined();
    const overtaken = auditUnreadableRows({
      sites: scan.sites,
      declarations: [
        ...UNREADABLE_ROW_SITES,
        UnreadableRowDeclarationSchema.parse({
          file: guarded?.file ?? "",
          scope: guarded?.scope ?? "",
          conversion: guarded?.conversion ?? "",
          reason: "unmigrated",
          consequence: "a false claim, to prove the rule reads the verdict",
          note: "a false claim, to prove the rule reads the verdict rather than this list",
        }),
      ],
      files: scan.scanned,
      sources: scan.sources,
      unannotatedConversions: [],
    });
    expect(overtaken.map((f) => f.kind)).toEqual(["overtaken"]);
  });

  it("holds every unbounded throwing read under a declaration too", () => {
    // Reported rather than asserted to a figure: the set shrinks as slices migrate, and a test that
    // pinned the number would be edited to make the suite pass (`pg-storeless-tables.ts`' lesson
    // about a vacuity floor becoming a number somebody adjusts).
    const unbounded = unboundedThrowingSites(scan.sites);
    expect(unbounded.length).toBeLessThanOrEqual(needing.length);
    for (const s of unbounded) {
      expect(
        UNREADABLE_ROW_SITES.find((d) => siteKey(d) === siteKey(s)),
        siteKey(s),
      ).toBeDefined();
    }
  });

  it("reports a newly written unguarded read through the whole wiring, not only the matcher", () => {
    // **End to end rather than per function.** Every assertion above either exercises the scan on a
    // fixture or the audit on fabricated sites; neither would notice `scanWorkspacePageReads`
    // silently dropping a file, which would make the fence pass having examined less than it says.
    // So one production-shaped module is appended to the real source list and the whole pipeline is
    // asked about it.
    const planted = scanWorkspacePageReads(
      [
        ...files,
        source(
          `
          function rowToGadget(row: Record<string, unknown>): Gadget {
            return GadgetSchema.parse(row);
          }
          export class PostgresGadgetStore {
            async listRecent(): Promise<readonly Gadget[]> {
              const result = await this.conn.query("SELECT * FROM meta.gadgets LIMIT 50");
              return result.rows.map(rowToGadget);
            }
          }
        `,
          "packages/gadgets-pg/src/gadget-store.ts",
        ),
      ],
      unhandledGlobs,
    );
    const findings = auditUnreadableRows({
      sites: planted.sites,
      declarations: UNREADABLE_ROW_SITES,
      files: planted.scanned,
      sources: planted.sources,
      unannotatedConversions: planted.coverage.unannotated,
    });
    expect(findings.map((f) => `${f.kind}:${f.site}`)).toEqual([
      "undeclared_throwing_map:packages/gadgets-pg/src/gadget-store.ts::listRecent::rowToGadget",
    ]);
  });

  it("keeps every refused anchor with the measurement that refused it", () => {
    expect(REFUSED_ROW_PAGE_ANCHORS.length).toBeGreaterThanOrEqual(5);
    for (const refused of REFUSED_ROW_PAGE_ANCHORS) {
      expect(refused.anchor.length, refused.anchor).toBeGreaterThan(20);
      // A count or a named member, so a refusal is a measurement rather than a preference.
      expect(/\d/.test(refused.measurement), refused.anchor).toBe(true);
    }
  });
});
