import { META_OPERATE_ENTITY_RECORDS } from "@crossengin/kernel/bootstrap";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  ReferencedRecordInUse,
  ReferenceNotFound,
  UniqueViolation,
  type EntityRecord,
} from "@crossengin/operate-runtime";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  DOCUMENT_RUNTIME_INDEX_PREFIX,
  documentUniqueIndexName,
  ensureDocumentUniqueIndexes,
  planDocumentIntegrity,
  type DocumentIntegrityPlan,
} from "./document-integrity.js";
import { PostgresEntityStore } from "./entity-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const TABLE = "meta.operate_entity_records";

/**
 * The shape the integrity cares about, and a little of each delete rule: an `Account` that a
 * `Contact` references with `cascade`, an `Invoice` references with the default `restrict`, and a
 * `Note` references with `set_null`; a `ContactTag` cascading from `Contact` (so a cascade is
 * recursive) and a `Survey` restricting `Contact` (so a restrict *inside* a cascade blocks it).
 */
const MANIFEST = {
  manifestVersion: "1.0",
  meta: { slug: "t/integrity", name: "Integrity", version: "1.0.0" },
  entities: [
    { name: "Account", fields: [{ name: "code", type: { kind: "text" }, unique: true }] },
    {
      name: "Contact",
      fields: [
        { name: "account_id", type: { kind: "reference", target: "Account" } },
        { name: "email", type: { kind: "text" }, unique: { scope: ["account_id"] } },
      ],
    },
    { name: "ContactTag", fields: [{ name: "contact_id", type: { kind: "reference", target: "Contact" } }] },
    { name: "Survey", fields: [{ name: "contact_id", type: { kind: "reference", target: "Contact" } }] },
    { name: "Invoice", fields: [{ name: "account_id", type: { kind: "reference", target: "Account" } }] },
    { name: "Note", fields: [{ name: "account_id", type: { kind: "reference", target: "Account" } }] },
    { name: "Orphan", fields: [{ name: "ghost_id", type: { kind: "reference", target: "Ghost" } }] },
  ],
  relations: [
    { kind: "many_to_one", from: "Contact", field: "account_id", to: "Account", onDelete: "cascade" },
    { kind: "many_to_one", from: "ContactTag", field: "contact_id", to: "Contact", onDelete: "cascade" },
    { kind: "many_to_one", from: "Survey", field: "contact_id", to: "Contact", onDelete: "restrict" },
    { kind: "many_to_one", from: "Note", field: "account_id", to: "Account", onDelete: "set_null" },
  ],
} as unknown as Manifest;

interface Row {
  entity: string;
  record_id: string;
  document: EntityRecord;
}

/**
 * Interprets exactly the statements the document store and its integrity issue, against an
 * in-memory table, with each declared unique index enforced as Postgres would. A statement it does
 * not recognise **throws** rather than answering `{rows: []}`, because an empty answer for a
 * statement whose shape later changed would make every "nothing references it" assertion pass
 * vacuously.
 */
function fakePg(plan: DocumentIntegrityPlan, seed: Row[] = []): { conn: PgConnection; rows: Row[]; sql: string[] } {
  const rows: Row[] = seed.map((r) => ({ ...r, document: { ...r.document } }));
  const sql: string[] = [];
  const violates = (candidate: Row, ignore: Row | null): string | null => {
    for (const idx of plan.uniqueIndexes) {
      if (idx.entity !== candidate.entity) continue;
      const key = (d: EntityRecord): unknown[] => [...idx.scope, idx.field].map((f) => d[f]);
      const mine = key(candidate.document);
      if (mine.some((v) => v === null || v === undefined)) continue;
      const clash = rows.some(
        (r) =>
          r !== ignore &&
          r.entity === candidate.entity &&
          JSON.stringify(key(r.document)) === JSON.stringify(mine),
      );
      if (clash) return idx.name;
    }
    return null;
  };
  const uniqueError = (name: string): Error =>
    Object.assign(new Error("duplicate key value"), { code: "23505", constraint: name });
  const find = (entity: unknown, id: unknown): Row | undefined =>
    rows.find((r) => r.entity === entity && r.record_id === id);
  const query = async (text: string, params: readonly unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    assertBindArity(text, params);
    const s = text.replace(/\s+/g, " ").trim();
    sql.push(s);
    const p = params;
    if (s.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
    if (s.startsWith("SELECT document FROM") && s.endsWith("FOR UPDATE")) {
      const r = find(p[1], p[2]);
      return { rows: r === undefined ? [] : [{ document: r.document }], rowCount: r === undefined ? 0 : 1 };
    }
    if (/^SELECT 1 FROM \S+ WHERE tenant_id = \$1 AND entity = \$2 AND record_id = \$3 FOR (KEY SHARE|UPDATE)$/.test(s)) {
      const r = find(p[1], p[2]);
      return { rows: r === undefined ? [] : [{ "?column?": 1 }], rowCount: r === undefined ? 0 : 1 };
    }
    const byField = /document ->> '([A-Za-z_][A-Za-z0-9_]*)' = \$3/.exec(s);
    if (s.startsWith("SELECT record_id FROM") && byField !== null) {
      const hits = rows
        .filter((r) => r.entity === p[1] && r.document[byField[1]!] === p[2])
        .sort((a, b) => a.record_id.localeCompare(b.record_id));
      return { rows: hits.map((r) => ({ record_id: r.record_id })), rowCount: hits.length };
    }
    if (s.startsWith("SELECT 1 FROM") && byField !== null && s.includes("NOT (record_id = ANY($4::text[]))")) {
      const exclude = new Set(p[3] as string[]);
      const hit = rows.find((r) => r.entity === p[1] && r.document[byField[1]!] === p[2] && !exclude.has(r.record_id));
      return { rows: hit === undefined ? [] : [{}], rowCount: hit === undefined ? 0 : 1 };
    }
    if (s.startsWith("INSERT INTO")) {
      const row: Row = { entity: String(p[1]), record_id: String(p[2]), document: JSON.parse(String(p[3])) as EntityRecord };
      const clash = violates(row, null);
      if (clash !== null) throw uniqueError(clash);
      rows.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE") && s.includes("jsonb_set")) {
      const r = find(p[1], p[2]);
      if (r !== undefined) r.document = { ...r.document, [String(p[3])]: null };
      return { rows: [], rowCount: r === undefined ? 0 : 1 };
    }
    if (s.startsWith("UPDATE") && s.includes("SET document = $4::jsonb")) {
      const r = find(p[1], p[2]);
      if (r === undefined) return { rows: [], rowCount: 0 };
      const next: Row = { ...r, document: JSON.parse(String(p[3])) as EntityRecord };
      const clash = violates(next, r);
      if (clash !== null) throw uniqueError(clash);
      r.document = next.document;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("DELETE FROM")) {
      const i = rows.findIndex((r) => r.entity === p[1] && r.record_id === p[2]);
      if (i >= 0) rows.splice(i, 1);
      return { rows: [], rowCount: i >= 0 ? 1 : 0 };
    }
    throw new Error(`fake cannot serve: ${s}`);
  };
  const conn: PgConnection = {
    query: query as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    close: async () => undefined,
  } as PgConnection;
  return { conn, rows, sql };
}

function harness(seed: Row[] = [], opts: { enforceReferences?: boolean } = {}) {
  const plan = planDocumentIntegrity(MANIFEST, TABLE, opts);
  const fake = fakePg(plan, seed);
  const store = new PostgresEntityStore(fake.conn, { manifest: MANIFEST, ...opts });
  return { ...fake, store, plan };
}

const row = (entity: string, record_id: string, document: EntityRecord = {}): Row => ({
  entity,
  record_id,
  document: { id: record_id, ...document },
});

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("planDocumentIntegrity", () => {
  const plan = planDocumentIntegrity(MANIFEST, TABLE);

  it("declares the namespace the catalog declares, one spelling in two packages", () => {
    // The reconciler skips a live index on this table only if its name carries the catalog's
    // `runtimeIndexPrefix`; were the two to drift, every index this store builds would read as an
    // undeclared index on every drift check and every `apply`.
    expect(META_OPERATE_ENTITY_RECORDS.runtimeIndexPrefix).toBe(DOCUMENT_RUNTIME_INDEX_PREFIX);
  });

  it("plans one partial unique expression index per declared field, scope first", () => {
    expect(plan.uniqueIndexes.map((i) => `${i.entity}.${i.field}`)).toEqual(["Account.code", "Contact.email"]);
    const contact = plan.uniqueIndexes[1]!;
    expect(contact.scope).toEqual(["account_id"]);
    expect(contact.sql).toBe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${contact.name}" ON ${TABLE}` +
        ` (tenant_id, (document ->> 'account_id'), (document ->> 'email')) WHERE entity = 'Contact'`,
    );
  });

  it("names an index deterministically, inside the namespace and the identifier limit", () => {
    const a = documentUniqueIndexName("E".repeat(63), "f".repeat(63), ["s".repeat(63)]);
    expect(a).toBe(documentUniqueIndexName("E".repeat(63), "f".repeat(63), ["s".repeat(63)]));
    expect(a.startsWith(DOCUMENT_RUNTIME_INDEX_PREFIX)).toBe(true);
    expect(a.length).toBeLessThanOrEqual(63);
    // The scope is part of the identity: a declaration that gains a scope is a different index.
    expect(documentUniqueIndexName("A", "f", [])).not.toBe(documentUniqueIndexName("A", "f", ["g"]));
  });

  it("takes each reference's onDelete from its many_to_one relation, restrict by default", () => {
    const rule = (e: string): string | undefined =>
      [...plan.referencesFrom.values()].flat().find((x) => `${x.entity}.${x.field}` === e)?.onDelete;
    expect(rule("Contact.account_id")).toBe("cascade");
    expect(rule("Note.account_id")).toBe("set_null");
    expect(rule("Invoice.account_id")).toBe("restrict");
    expect(rule("Survey.contact_id")).toBe("restrict");
  });

  it("skips a reference to an entity the manifest does not declare, as the column store does", () => {
    expect(plan.referencesFrom.has("Orphan")).toBe(false);
  });

  it("refuses a name it cannot interpolate rather than withholding the guarantee in silence", () => {
    const bad = {
      entities: [{ name: "Item", fields: [{ name: "sku'; drop", type: { kind: "text" }, unique: true }] }],
    } as unknown as Manifest;
    expect(() => planDocumentIntegrity(bad, TABLE)).toThrow(/cannot be indexed/);
  });
});

describe("PostgresEntityStore with a manifest — uniqueness", () => {
  it("turns a duplicate into a UniqueViolation naming the field", async () => {
    const h = harness([row("Account", "a1", { code: "C1" })]);
    const err = await failure(h.store.create(TENANT, "Account", { id: "a2", code: "C1" }));
    expect(err).toBeInstanceOf(UniqueViolation);
    expect(err).toMatchObject({ entity: "Account", field: "code" });
    expect(h.rows).toHaveLength(1);
  });

  it("admits the same value under a different scope, and refuses it under the same one", async () => {
    const h = harness([row("Account", "a1"), row("Account", "a2"), row("Contact", "c1", { account_id: "a1", email: "x" })]);
    await h.store.create(TENANT, "Contact", { id: "c2", account_id: "a2", email: "x" });
    const err = await failure(h.store.create(TENANT, "Contact", { id: "c3", account_id: "a1", email: "x" }));
    expect(err).toMatchObject({ field: "email" });
  });

  it("refuses an update that re-types a taken value", async () => {
    const h = harness([row("Account", "a1", { code: "C1" }), row("Account", "a2", { code: "C2" })]);
    const err = await failure(h.store.update(TENANT, "Account", "a2", { code: "C1" }));
    expect(err).toBeInstanceOf(UniqueViolation);
  });

  it("leaves a store without a manifest exactly as it was: duplicates and dangling ids stored", async () => {
    const plan = planDocumentIntegrity(MANIFEST, TABLE);
    const fake = fakePg({ ...plan, uniqueIndexes: [] }, [row("Account", "a1", { code: "C1" })]);
    const bare = new PostgresEntityStore(fake.conn);
    await bare.create(TENANT, "Account", { id: "a2", code: "C1" });
    await bare.create(TENANT, "Invoice", { id: "i1", account_id: "nope" });
    expect(fake.rows).toHaveLength(3);
    expect(bare.integrityPlan()).toBeNull();
  });
});

describe("PostgresEntityStore with a manifest — references on write", () => {
  it("refuses a reference naming no record, and writes nothing", async () => {
    const h = harness();
    const err = await failure(h.store.create(TENANT, "Invoice", { id: "i1", account_id: "nope" }));
    expect(err).toBeInstanceOf(ReferenceNotFound);
    expect(err).toMatchObject({ entity: "Invoice", field: "account_id", target: "Account" });
    expect(h.rows).toHaveLength(0);
  });

  it("admits a reference to a record that exists, and a null one", async () => {
    const h = harness([row("Account", "a1")]);
    await h.store.create(TENANT, "Invoice", { id: "i1", account_id: "a1" });
    await h.store.create(TENANT, "Invoice", { id: "i2", account_id: null });
    expect(h.rows.map((r) => r.record_id)).toEqual(["a1", "i1", "i2"]);
  });

  it("refuses a value no record id can equal", async () => {
    const h = harness([row("Account", "a1")]);
    const err = await failure(h.store.create(TENANT, "Invoice", { id: "i1", account_id: { id: "a1" } }));
    expect(err).toBeInstanceOf(ReferenceNotFound);
  });

  it("checks a reference an update changes, and not one it leaves as it was", async () => {
    // A row holding a dangling id from before the check existed can still be edited; that is when
    // Postgres re-checks a foreign key too.
    const h = harness([row("Account", "a1"), row("Invoice", "i1", { account_id: "gone", memo: "x" })]);
    await h.store.update(TENANT, "Invoice", "i1", { memo: "y" });
    expect(await failure(h.store.update(TENANT, "Invoice", "i1", { account_id: "nope" }))).toBeInstanceOf(
      ReferenceNotFound,
    );
    await h.store.update(TENANT, "Invoice", "i1", { account_id: "a1" });
    expect(h.rows.find((r) => r.record_id === "i1")!.document.account_id).toBe("a1");
  });

  it("locks the referenced row so a concurrent delete cannot slip between the check and the commit", async () => {
    const h = harness([row("Account", "a1")]);
    await h.store.create(TENANT, "Invoice", { id: "i1", account_id: "a1" });
    expect(h.sql.some((s) => s.includes("record_id = $3 FOR KEY SHARE"))).toBe(true);
  });

  it("stores a dangling reference under --allow-dangling-references", async () => {
    const h = harness([], { enforceReferences: false });
    await h.store.create(TENANT, "Invoice", { id: "i1", account_id: "nope" });
    expect(h.rows).toHaveLength(1);
  });
});

describe("PostgresEntityStore with a manifest — references on delete", () => {
  it("refuses a delete a restrict reference blocks, and deletes nothing", async () => {
    const h = harness([row("Account", "a1"), row("Invoice", "i1", { account_id: "a1" })]);
    const err = await failure(h.store.remove(TENANT, "Account", "a1"));
    expect(err).toBeInstanceOf(ReferencedRecordInUse);
    expect(err).toMatchObject({ entity: "Account", referencedBy: "Invoice", field: "account_id" });
    expect(h.rows).toHaveLength(2);
  });

  it("cascades recursively and nulls a set_null reference", async () => {
    const h = harness([
      row("Account", "a1"),
      row("Account", "a2"),
      row("Contact", "c1", { account_id: "a1" }),
      row("ContactTag", "t1", { contact_id: "c1" }),
      row("Note", "n1", { account_id: "a1" }),
      row("Contact", "c2", { account_id: "a2" }),
    ]);
    expect(await h.store.remove(TENANT, "Account", "a1")).toBe(true);
    expect(h.rows.map((r) => r.record_id).sort()).toEqual(["a2", "c2", "n1"]);
    expect(h.rows.find((r) => r.record_id === "n1")!.document).toMatchObject({ account_id: null });
  });

  it("lets a restrict reference held inside the cascade not block it, and one outside it block", async () => {
    const h = harness([
      row("Account", "a1"),
      row("Contact", "c1", { account_id: "a1" }),
      row("Survey", "s1", { contact_id: "c1" }),
    ]);
    // Survey restricts Contact, and c1 is reached only through the Account's cascade — the
    // Survey row is outside the closure, so it blocks the whole delete, as RESTRICT does.
    const err = await failure(h.store.remove(TENANT, "Account", "a1"));
    expect(err).toMatchObject({ entity: "Contact", referencedBy: "Survey", field: "contact_id" });
    expect(h.rows).toHaveLength(3);
  });

  it("does not let a restrict reference held by a row the same delete removes block it", async () => {
    // Two contacts cascaded from one account, one restricting the other: both go in the same
    // statement on the column store and Postgres deletes them (measured on PG 16), so a closure
    // check that forgot to exclude its own rows would refuse a delete both stores agree on.
    const peers = {
      ...MANIFEST,
      entities: [
        { name: "Account", fields: [] },
        {
          name: "Contact",
          fields: [
            { name: "account_id", type: { kind: "reference", target: "Account" } },
            { name: "peer_id", type: { kind: "reference", target: "Contact" } },
          ],
        },
      ],
      relations: [
        { kind: "many_to_one", from: "Contact", field: "account_id", to: "Account", onDelete: "cascade" },
        { kind: "many_to_one", from: "Contact", field: "peer_id", to: "Contact", onDelete: "restrict" },
      ],
    } as unknown as Manifest;
    const plan = planDocumentIntegrity(peers, TABLE);
    const fake = fakePg(plan, [
      row("Account", "a1"),
      row("Contact", "c1", { account_id: "a1" }),
      row("Contact", "c2", { account_id: "a1", peer_id: "c1" }),
    ]);
    const s = new PostgresEntityStore(fake.conn, { manifest: peers });
    expect(await s.remove(TENANT, "Account", "a1")).toBe(true);
    expect(fake.rows).toHaveLength(0);
  });

  it("answers false for a record that does not exist, writing nothing", async () => {
    const h = harness([row("Invoice", "i1", { account_id: "a1" })]);
    expect(await h.store.remove(TENANT, "Account", "a1")).toBe(false);
    expect(h.rows).toHaveLength(1);
  });

  it("deletes a referenced record under --allow-dangling-references", async () => {
    const h = harness([row("Account", "a1"), row("Invoice", "i1", { account_id: "a1" })], { enforceReferences: false });
    expect(await h.store.remove(TENANT, "Account", "a1")).toBe(true);
    expect(h.rows.map((r) => r.record_id)).toEqual(["i1"]);
  });

  it("refuses a set_null on a required reference, as the column store's NOT NULL would", async () => {
    const required = {
      ...MANIFEST,
      entities: [
        { name: "Account", fields: [] },
        { name: "Note", fields: [{ name: "account_id", type: { kind: "reference", target: "Account" }, required: true }] },
      ],
      relations: [{ kind: "many_to_one", from: "Note", field: "account_id", to: "Account", onDelete: "set_null" }],
    } as unknown as Manifest;
    const plan = planDocumentIntegrity(required, TABLE);
    const fake = fakePg(plan, [row("Account", "a1"), row("Note", "n1", { account_id: "a1" })]);
    const s = new PostgresEntityStore(fake.conn, { manifest: required });
    expect(await failure(s.remove(TENANT, "Account", "a1"))).toBeInstanceOf(ReferencedRecordInUse);
    expect(fake.rows).toHaveLength(2);
  });
});

describe("ensureDocumentUniqueIndexes", () => {
  const plan = planDocumentIntegrity(MANIFEST, TABLE);
  const [account, contact] = plan.uniqueIndexes as [(typeof plan.uniqueIndexes)[0], (typeof plan.uniqueIndexes)[0]];

  function ddlConn(opts: {
    fail?: (sql: string) => Error | null;
    live: readonly { name: string; valid: boolean }[];
  }): { conn: PgConnection; sql: string[] } {
    const sql: string[] = [];
    const conn = {
      query: async (text: string, params: readonly unknown[] = []) => {
        assertBindArity(text, params);
        sql.push(text);
        if (text.startsWith("CREATE UNIQUE INDEX")) {
          const e = opts.fail?.(text) ?? null;
          if (e !== null) throw e;
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("FROM pg_index")) {
          expect(params).toEqual(["meta", DOCUMENT_RUNTIME_INDEX_PREFIX]);
          return { rows: opts.live, rowCount: opts.live.length };
        }
        throw new Error(`unexpected: ${text}`);
      },
      transaction: async () => {
        throw new Error("the index DDL must run outside a transaction");
      },
    } as unknown as PgConnection;
    return { conn, sql };
  }
  const pgError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

  it("reports every index enforced when each was built and reads back valid", async () => {
    const { conn } = ddlConn({ live: [account, contact].map((i) => ({ name: i.name, valid: true })) });
    const r = await ensureDocumentUniqueIndexes(conn, plan, "meta");
    expect(r.results.map((x) => x.outcome)).toEqual(["enforced", "enforced"]);
    expect(r.stale).toEqual([]);
  });

  it("names each refusal, attempts every index, and never throws", async () => {
    const { conn, sql } = ddlConn({
      fail: (s) => (s.includes(account.name) ? pgError("23505") : pgError("42501")),
      live: [],
    });
    const r = await ensureDocumentUniqueIndexes(conn, plan, "meta");
    expect(r.results.map((x) => x.outcome)).toEqual(["existing_duplicates", "not_owner"]);
    expect(sql.filter((s) => s.startsWith("CREATE UNIQUE INDEX"))).toHaveLength(2);
  });

  it("counts an owner-built index as enforced when this role is refused only for not owning the table", async () => {
    // The shipped case since ADR-0424: the API is a confined role, the owner built the index first,
    // and Postgres refuses `IF NOT EXISTS` with 42501 anyway (measured: the ownership check precedes
    // the existence check). Present and valid is enforcement; absent, or invalid, is still a gap.
    const { conn } = ddlConn({
      fail: () => pgError("42501"),
      live: [
        { name: account.name, valid: true },
        { name: contact.name, valid: false },
      ],
    });
    const r = await ensureDocumentUniqueIndexes(conn, plan, "meta");
    expect(r.results.map((x) => x.outcome)).toEqual(["enforced", "not_owner"]);
  });

  it("does not count a statement that succeeded over an index Postgres reports invalid, or missing", async () => {
    const { conn } = ddlConn({ live: [{ name: account.name, valid: false }] });
    const r = await ensureDocumentUniqueIndexes(conn, plan, "meta");
    expect(r.results.map((x) => x.outcome)).toEqual(["invalid_index", "failed"]);
  });

  it("reports a runtime index the manifest no longer produces, with its DROP, and drops nothing", async () => {
    const stale = `${DOCUMENT_RUNTIME_INDEX_PREFIX}uq_0000000000000000`;
    const { conn, sql } = ddlConn({
      live: [...[account, contact].map((i) => ({ name: i.name, valid: true })), { name: stale, valid: true }],
    });
    const r = await ensureDocumentUniqueIndexes(conn, plan, "meta");
    expect(r.stale).toEqual([{ name: stale, dropSql: `DROP INDEX "meta"."${stale}";` }]);
    expect(sql.some((s) => s.startsWith("DROP"))).toBe(false);
  });
});
