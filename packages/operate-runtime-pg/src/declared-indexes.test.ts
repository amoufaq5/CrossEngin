import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import { columnPlansForManifest } from "./column-plan.js";
import {
  DOCUMENT_LOOKUP_INDEX_PREFIX,
  documentLookupIndexName,
  ensureDeclaredIndexes,
  formatDeclaredIndexPlan,
  formatDeclaredIndexResults,
  planColumnStoreIndexes,
  planDocumentStoreIndexes,
} from "./declared-indexes.js";
import { DOCUMENT_RUNTIME_INDEX_PREFIX, documentUniqueIndexName } from "./document-integrity.js";

const MANIFEST = {
  manifestVersion: "1.0",
  meta: { slug: "t/idx", version: "1.0.0", displayName: "idx" },
  entities: [
    {
      name: "Account",
      fields: [{ name: "name", type: { kind: "text" } }],
    },
    {
      name: "Invoice",
      fields: [
        { name: "number", type: { kind: "text" }, unique: true, indexed: true },
        { name: "status", type: { kind: "text" }, indexed: true },
        { name: "customer", type: { kind: "reference", target: "Account" } },
        { name: "issued", type: { kind: "date" }, indexed: true },
        { name: "total", type: { kind: "decimal", precision: 12, scale: 2 }, indexed: true },
        { name: "memo", type: { kind: "text" }, indexed: { kind: "gin" } },
        { name: "ssn", type: { kind: "text" }, classification: "phi", indexed: true },
      ],
      indexes: [
        { fields: ["status", "issued"] },
        { fields: ["customer", "status"] },
        { fields: ["number", "status"], unique: true },
        { fields: ["ghost"] },
      ],
    },
  ],
} as unknown as Manifest;

describe("planColumnStoreIndexes", () => {
  const plan = planColumnStoreIndexes(MANIFEST, columnPlansForManifest(MANIFEST, { schema: "public" }));
  const keysOf = plan.indexes.map((i) => i.sql.replace(/^.* ON "public"\."invoice" \(|\);$/g, ""));

  it("leads every index with tenant_id and names a real column", () => {
    expect(plan.indexes.every((i) => i.sql.includes('("tenant_id", '))).toBe(true);
    expect(keysOf).toContain('"tenant_id", "customer_id", "status"');
  });

  it("drops a declaration a longer one already starts with", () => {
    expect(keysOf).not.toContain('"tenant_id", "status"');
    expect(keysOf).not.toContain('"tenant_id", "customer_id"');
    expect(keysOf).toContain('"tenant_id", "status", "issued"');
  });

  it("drops a declaration the unique index already serves", () => {
    expect(keysOf).not.toContain('"tenant_id", "number"');
  });

  it("indexes a declared decimal on the column store, where it is a real typed column", () => {
    expect(keysOf).toContain('"tenant_id", "total"');
  });

  it("emits no index over the shared Account table's primary key prefix", () => {
    expect(plan.indexes.filter((i) => i.entity === "Account")).toEqual([]);
  });

  it("reports, by reason, every declaration it does not emit", () => {
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { entity: "Invoice", fields: ["memo"], reason: "kind_not_btree" },
        { entity: "Invoice", fields: ["ssn"], reason: "encrypted_at_rest" },
        { entity: "Invoice", fields: ["number", "status"], reason: "unique_entity_index" },
        { entity: "Invoice", fields: ["ghost"], reason: "unknown_field" },
      ]),
    );
  });

  it("keeps a name under 63 bytes and deterministic", () => {
    for (const i of plan.indexes) expect(i.name.length).toBeLessThanOrEqual(63);
    const again = planColumnStoreIndexes(MANIFEST, columnPlansForManifest(MANIFEST, { schema: "public" }));
    expect(again.indexes.map((i) => i.name)).toEqual(plan.indexes.map((i) => i.name));
  });
});

describe("planDocumentStoreIndexes", () => {
  const plan = planDocumentStoreIndexes(MANIFEST, "meta");

  it("builds one partial expression index per entity and field list, in the store's namespace", () => {
    const sts = plan.indexes.find((i) => i.fields.join() === "status,issued")!;
    expect(sts.name.startsWith(DOCUMENT_RUNTIME_INDEX_PREFIX)).toBe(true);
    expect(sts.sql).toBe(
      `CREATE INDEX IF NOT EXISTS "${documentLookupIndexName("Invoice", ["status", "issued"])}" ON "meta"."operate_entity_records" (tenant_id, (document ->> 'status'), (document ->> 'issued')) WHERE entity = 'Invoice';`,
    );
  });

  it("refuses a field whose list predicate is a guarded cast, which an index on the text cannot serve", () => {
    expect(plan.skipped).toContainEqual({ entity: "Invoice", fields: ["total"], reason: "cast_predicate" });
    expect(plan.indexes.some((i) => i.fields.includes("total"))).toBe(false);
  });

  it("does not report a declaration it cannot read as emitted", () => {
    expect(plan.skipped).toContainEqual({ entity: "Invoice", fields: ["ghost"], reason: "unknown_field" });
  });

  it("names a lookup index under a prefix no unique index name carries, so a stale one can be told apart", () => {
    for (const i of plan.indexes) expect(i.name.startsWith(DOCUMENT_LOOKUP_INDEX_PREFIX)).toBe(true);
    expect(documentUniqueIndexName("Invoice", "number", []).startsWith(DOCUMENT_LOOKUP_INDEX_PREFIX)).toBe(false);
  });
});

describe("the two plans over resolved erp-core", () => {
  const core = buildErpCorePack();

  it("emits every declared lookup on the column store but what an earlier index already serves", () => {
    const plan = planColumnStoreIndexes(core, columnPlansForManifest(core, { schema: "public" }));
    expect(plan.indexes.length).toBeGreaterThan(100);
    expect(plan.skipped.filter((s) => s.reason === "encrypted_at_rest")).toEqual([]);
    expect(formatDeclaredIndexPlan("pg-columns", plan)).toMatch(/^declared indexes on --store pg-columns: \d+ \(/);
  });

  it("skips only cast-compared fields on the document store", () => {
    const plan = planDocumentStoreIndexes(core, "meta");
    expect(plan.indexes.length).toBeGreaterThan(50);
    expect(new Set(plan.skipped.map((s) => s.reason))).toEqual(new Set(["cast_predicate"]));
  });
});

describe("formatDeclaredIndexPlan", () => {
  it("says every declaration was emitted when nothing was skipped", () => {
    expect(formatDeclaredIndexPlan("pg", { indexes: [], skipped: [] })).toBe(
      "declared indexes on --store pg: 0 (0 field, 0 reference, 0 entity_index); every declaration emitted",
    );
  });
});

function fakeConn(answer: (sql: string) => { rows: Record<string, unknown>[] } | Error): {
  conn: PgConnection;
  sqls: string[];
} {
  const sqls: string[] = [];
  const conn = {
    query: async (sql: string, params?: readonly unknown[]) => {
      assertBindArity(sql, params ?? []);
      sqls.push(sql);
      const out = answer(sql);
      if (out instanceof Error) throw out;
      return { rows: out.rows, rowCount: out.rows.length };
    },
    transaction: async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
  } as unknown as PgConnection;
  return { conn, sqls };
}

describe("ensureDeclaredIndexes", () => {
  const indexes = planDocumentStoreIndexes(MANIFEST, "meta").indexes.slice(0, 1);

  it("only looks when asked only to look, issuing no DDL", async () => {
    const { conn, sqls } = fakeConn(() => ({ rows: [] }));
    const out = await ensureDeclaredIndexes(conn, indexes, { build: false });
    expect(out.map((r) => r.outcome)).toEqual(["absent"]);
    expect(sqls.every((s) => s.startsWith("SELECT"))).toBe(true);
  });

  it("reports a role that does not own the table as not_owner, and never throws", async () => {
    const denied = Object.assign(new Error("must be owner of table operate_entity_records"), { code: "42501" });
    const { conn } = fakeConn((sql) => (sql.startsWith("CREATE") ? denied : { rows: [] }));
    const out = await ensureDeclaredIndexes(conn, indexes, { build: true });
    expect(out[0]).toMatchObject({ outcome: "not_owner", detail: "must be owner of table operate_entity_records" });
    expect(formatDeclaredIndexResults(out, "run the owner step")).toBe(
      "declared index pass: 1 not_owner — run the owner step",
    );
  });

  it("reports a build, and a present index without the remedy", async () => {
    const built = await ensureDeclaredIndexes(fakeConn(() => ({ rows: [] })).conn, indexes, { build: true });
    expect(built[0]!.outcome).toBe("built");
    const present = await ensureDeclaredIndexes(
      fakeConn(() => ({ rows: [{ valid: true }] })).conn,
      indexes,
      { build: true },
    );
    expect(formatDeclaredIndexResults(present, "never shown")).toBe("declared index pass: 1 present");
  });

  it("calls any other failure failed", async () => {
    const { conn } = fakeConn((sql) => (sql.startsWith("CREATE") ? new Error("disk full") : { rows: [] }));
    const out = await ensureDeclaredIndexes(conn, indexes, { build: true });
    expect(out[0]!.outcome).toBe("failed");
  });
});
