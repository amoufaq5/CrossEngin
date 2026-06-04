import { randomUUID } from "node:crypto";

import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
} from "@crossengin/kernel-pg";
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

  beforeAll(() => {
    conn = createNodePgConnection(parsePgEnvConfig());
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
});
