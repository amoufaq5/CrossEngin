import { randomUUID } from "node:crypto";

import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
  type PgConfig,
} from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { ColumnMappedEntityStore } from "@crossengin/operate-runtime-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";

/**
 * Real-Postgres integration test for the typed `ColumnMappedEntityStore` (the
 * sibling of the JSONB store). Gated on `CROSSENGIN_PG_TEST=1`. It proves the
 * features only the column store has — `ensureSchema` provisioning real typed
 * per-entity tables, column-native filter + keyset sort, and **transparent
 * at-rest encryption** of a phi column via pgcrypto — against a real database.
 *
 * Tables are created in `public` (the store's default schema). The connecting
 * role owns them, so RLS is bypassed; tenant scoping is exercised via the store's
 * `WHERE tenant_id = $1`.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

suite("ColumnMappedEntityStore integration (real Postgres)", () => {
  let conn: PgConnection;

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    await conn.query("CREATE SCHEMA IF NOT EXISTS lk");
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("ensureSchema provisions typed tables; CRUD + column-native filter + keyset sort", async () => {
    const manifest = await loadBuiltinPack("erp-retail");
    const store = new ColumnMappedEntityStore(conn, manifest, { schema: "public" });
    await store.ensureSchema();

    // the product table is real + typed (unit_price is NUMERIC, not JSONB text)
    const colType = await conn.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'product' AND column_name = 'unit_price'`,
    );
    expect(colType.rows[0]?.data_type).toMatch(/numeric/i);

    const tenant = randomUUID();
    const mk = (sku: string, price: number, status: string) =>
      store.create(tenant, "Product", { sku, name: sku, category: "grocery", unit_price: price, unit_cost: price / 2, status });
    const created = await mk("CS-1", 3, "active");
    await mk("CS-2", 1, "inactive");
    await mk("CS-3", 2, "active");

    // read back the typed record (NUMERIC round-trips as a pg string)
    const got = await store.get(tenant, "Product", created.id as string);
    expect(got).toMatchObject({ sku: "CS-1", status: "active" });
    expect(Number(got?.["unit_price"])).toBe(3);

    // column-native equality filter
    const active = await store.listPage(tenant, "Product", {
      limit: 50, cursor: null, sort: [{ field: "sku", direction: "asc" }],
      filters: [{ field: "status", op: "eq", value: "active" }],
    });
    expect(active.records.length).toBe(2);
    expect(active.records.every((r) => r["status"] === "active")).toBe(true);

    // keyset sort on the native NUMERIC column, paginated
    const firstPage = await store.listPage(tenant, "Product", {
      limit: 2, cursor: null, sort: [{ field: "unit_price", direction: "asc" }], filters: [],
    });
    expect(firstPage.records.map((r) => Number(r["unit_price"]))).toEqual([1, 2]);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await store.listPage(tenant, "Product", {
      limit: 2, cursor: firstPage.nextCursor, sort: [{ field: "unit_price", direction: "asc" }], filters: [],
    });
    expect(secondPage.records.map((r) => Number(r["unit_price"]))).toEqual([3]);
  });

  it("encrypts a phi column at rest (BYTEA ciphertext) and decrypts it on read", async () => {
    const manifest = await loadBuiltinPack("erp-healthcare");
    // a literal key reference for the test (production uses current_setting(...))
    const store = new ColumnMappedEntityStore(conn, manifest, { schema: "public", encryptionKeyRef: "'k_test_secret'" });
    await store.ensureSchema();

    const tenant = randomUUID();
    const account = await store.create(tenant, "Account", { name: "Acme Health", status: "prospect", billing_email: "ap@acme.test" });
    const patient = await store.create(tenant, "Patient", {
      account_id: account.id, mrn: "MRN-998877", given_name: "Jamie", family_name: "Rivera",
      date_of_birth: "1990-01-01", sex: "unknown", status: "active",
    });

    // the authorized read decrypts the phi column back to plaintext
    const got = await store.get(tenant, "Patient", patient.id as string);
    expect(got?.["mrn"]).toBe("MRN-998877");
    expect(got?.["given_name"]).toBe("Jamie");

    // the column is stored as BYTEA ciphertext, not plaintext
    const raw = await conn.query<{ t: string; mrn: Buffer }>(
      `SELECT pg_typeof(mrn)::text AS t, mrn FROM public.patient WHERE tenant_id = $1 AND id = $2`,
      [tenant, patient.id],
    );
    expect(raw.rows[0]?.t).toBe("bytea");
    expect(raw.rows[0]?.mrn.toString("utf8")).not.toContain("MRN-998877");
  });

  it("manages many_to_many association links over a real join table (link/unlink/listLinks + FK cascade)", async () => {
    const manifest = {
      entities: [
        { name: "Course", fields: [{ name: "title", type: { kind: "text" } }] },
        { name: "Student", fields: [{ name: "name", type: { kind: "text" } }] },
      ],
      relations: [{ kind: "many_to_many", left: "Course", right: "Student" }],
    } as unknown as Manifest;
    const store = new ColumnMappedEntityStore(conn, manifest, { schema: "lk" });
    await store.ensureSchema();

    const tenant = randomUUID();
    const course = await store.create(tenant, "Course", { title: "Algebra" });
    const s1 = await store.create(tenant, "Student", { name: "Ada" });
    const s2 = await store.create(tenant, "Student", { name: "Bo" });

    await store.link(tenant, "Course", "Student", course.id as string, s1.id as string);
    await store.link(tenant, "Course", "Student", course.id as string, s2.id as string);
    await store.link(tenant, "Course", "Student", course.id as string, s1.id as string); // idempotent

    expect(await store.isLinked(tenant, "Course", "Student", course.id as string, s1.id as string)).toBe(true);
    const links = await store.listLinks(tenant, "Course", "Student", { leftId: course.id as string });
    expect(links).toHaveLength(2);

    expect(await store.unlink(tenant, "Course", "Student", course.id as string, s1.id as string)).toBe(true);
    expect(await store.isLinked(tenant, "Course", "Student", course.id as string, s1.id as string)).toBe(false);
    expect(await store.listLinks(tenant, "Course", "Student", { leftId: course.id as string })).toHaveLength(1);

    // the join FK is ON DELETE CASCADE: removing the course clears its remaining links
    await store.remove(tenant, "Course", course.id as string);
    expect(await store.listLinks(tenant, "Course", "Student", { leftId: course.id as string })).toHaveLength(0);
  });

  it("enforces a many_to_one ON DELETE RESTRICT foreign key", async () => {
    const manifest = {
      entities: [
        { name: "Account", fields: [{ name: "name", type: { kind: "text" } }] },
        { name: "Order", fields: [{ name: "account", type: { kind: "reference", target: "Account" } }] },
      ],
      relations: [{ kind: "many_to_one", from: "Order", field: "account", to: "Account", onDelete: "restrict" }],
    } as unknown as Manifest;
    const store = new ColumnMappedEntityStore(conn, manifest, { schema: "lk" });
    await store.ensureSchema();

    const tenant = randomUUID();
    const account = await store.create(tenant, "Account", { name: "Acme" });
    await store.create(tenant, "Order", { account: account.id });

    // RESTRICT: the referenced account can't be deleted while an order references it
    await expect(store.remove(tenant, "Account", account.id as string)).rejects.toThrow();
  });

  it("nulls a many_to_one reference on ON DELETE SET NULL (keeping tenant_id)", async () => {
    const manifest = {
      entities: [
        { name: "Vendor", fields: [{ name: "name", type: { kind: "text" } }] },
        // the reference is nullable (not required), so SET NULL is valid
        { name: "Bill", fields: [{ name: "vendor", type: { kind: "reference", target: "Vendor" } }] },
      ],
      relations: [{ kind: "many_to_one", from: "Bill", field: "vendor", to: "Vendor", onDelete: "set_null" }],
    } as unknown as Manifest;
    const store = new ColumnMappedEntityStore(conn, manifest, { schema: "lk" });
    await store.ensureSchema();

    const tenant = randomUUID();
    const vendor = await store.create(tenant, "Vendor", { name: "Globex" });
    const bill = await store.create(tenant, "Bill", { vendor: vendor.id });

    // SET NULL: removing the vendor succeeds and nulls the bill's ref (bill survives)
    expect(await store.remove(tenant, "Vendor", vendor.id as string)).toBe(true);
    const got = await store.get(tenant, "Bill", bill.id as string);
    expect(got).not.toBeNull();
    expect(got?.["vendor"] ?? null).toBeNull();
    // the row + its tenant_id are intact (SET NULL only nulled vendor_id)
    const raw = await conn.query<{ tenant_id: string; vendor_id: string | null }>(
      `SELECT tenant_id::text, vendor_id FROM lk.bill WHERE id = $1`, [bill.id],
    );
    expect(raw.rows[0]?.tenant_id).toBe(tenant);
    expect(raw.rows[0]?.vendor_id).toBeNull();
  });

  it("enforces the RLS policy itself for a non-bypassing role (not just WHERE tenant_id)", async () => {
    // a fresh single-entity table, rows seeded for two tenants by the owner (RLS-bypassed)
    const manifest = { entities: [{ name: "Doc", fields: [{ name: "title", type: { kind: "text" } }] }] } as unknown as Manifest;
    const owner = new ColumnMappedEntityStore(conn, manifest, { schema: "lk" });
    await owner.ensureSchema();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await owner.create(tenantA, "Doc", { title: "A-only" });
    await owner.create(tenantB, "Doc", { title: "B-only" });

    // a non-owner, NOBYPASSRLS role to which the RLS policy actually applies
    const exists = await conn.query(`SELECT 1 FROM pg_roles WHERE rolname = 'crossengin_rls'`);
    if (exists.rows.length === 0) {
      await conn.query("CREATE ROLE crossengin_rls LOGIN PASSWORD 'rls' NOSUPERUSER NOBYPASSRLS");
    }
    await conn.query("GRANT USAGE ON SCHEMA lk TO crossengin_rls");
    await conn.query("GRANT SELECT ON lk.doc TO crossengin_rls");

    const base = parsePgEnvConfig();
    const rlsConfig: PgConfig = { ...base, user: "crossengin_rls", password: "rls" };
    const rls = createNodePgConnection(rlsConfig);
    try {
      // with the policy enforced, a raw SELECT (no WHERE tenant_id) sees only the
      // tenant set by app.current_tenant_id — proving the RLS policy, not the store
      const countFor = (tenant: string) =>
        rls.transaction(async (tx) => {
          await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
          const r = await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM lk.doc");
          return Number(r.rows[0]!.n);
        });
      // only this run's two tenants are asserted (the table may hold other runs' rows)
      const seenA = await rls.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
        const r = await tx.query<{ title: string }>("SELECT title FROM lk.doc");
        return r.rows.map((x) => x.title);
      });
      expect(seenA).toContain("A-only");
      expect(seenA).not.toContain("B-only");
      // tenant A sees exactly one row of this run's pair (its own)
      expect(await countFor(tenantA)).toBe(1);
      expect(await countFor(tenantB)).toBe(1);
    } finally {
      await rls.close();
    }
  });
});
