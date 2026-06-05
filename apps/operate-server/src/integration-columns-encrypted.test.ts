import { randomUUID } from "node:crypto";

import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
} from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { ColumnMappedEntityStore } from "@crossengin/operate-runtime-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";

/**
 * Real-Postgres integration test for encrypted-column read fidelity in the
 * `ColumnMappedEntityStore`. Gated on `CROSSENGIN_PG_TEST=1` (skipped offline).
 *
 * The sibling P1.24 (`integration-columns.test.ts`) already proves the happy
 * path — a `phi` `Patient.mrn` is `pgp_sym_encrypt`'d to BYTEA on write and
 * decrypted on read. This suite locks down the encrypted-column edge cases that
 * weren't covered:
 *   - NULL PHI (write null → read null; update from null → real value → read it)
 *   - Empty-string PHI (`""` is distinct from null on the ciphertext side)
 *   - Multibyte / Unicode PHI (Arabic + ASCII — the platform targets MENA)
 *   - Long PHI (>256 chars — pgp_sym_encrypt has no truncation)
 *   - listPage decryption (the SELECT list decrypts the encrypted column under
 *     the `?fields` projection just as `get` does)
 *
 * The integration is intentionally separate from the offline unit tests in
 * `packages/operate-runtime-pg/src/column-store.test.ts`: only a real Postgres
 * exercises pgcrypto + node-postgres' BYTEA <-> text coercion end-to-end.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const KEY_REF = "'k_test_secret'";

interface PatientShape {
  account_id: string;
  given_name: string;
  family_name: string;
  date_of_birth: string;
  sex: string;
  status: string;
  mrn?: string | null;
}

suite("ColumnMappedEntityStore encrypted-PHI read fidelity (real Postgres)", () => {
  let conn: PgConnection;
  let store: ColumnMappedEntityStore;
  let healthcare: Manifest;
  let tenant: string;
  let accountId: string;
  let mrnCounter = 0;

  // mrn is `unique: true` in the healthcare pack; mint a fresh value per row
  const uniqueMrn = (label: string): string => `${label}-${(++mrnCounter).toString()}-${randomUUID().slice(0, 8)}`;

  const basePatient = (mrn: string | null): PatientShape => ({
    account_id: accountId,
    given_name: "Test",
    family_name: "Patient",
    date_of_birth: "1990-01-01",
    sex: "unknown",
    status: "active",
    ...(mrn === null ? { mrn: null } : { mrn }),
  });

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    healthcare = await loadBuiltinPack("erp-healthcare");
    store = new ColumnMappedEntityStore(conn, healthcare, {
      schema: "public",
      encryptionKeyRef: KEY_REF,
    });
    await store.ensureSchema();
    tenant = randomUUID();
    const account = await store.create(tenant, "Account", {
      name: "PHI Fidelity Co",
      status: "prospect",
      billing_email: "fidelity@acme.test",
    });
    accountId = account.id as string;
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  // Patient.mrn is required: true in pack-erp-healthcare, so a true NULL PHI
  // value can't be tested through that manifest. Use a tiny inline manifest
  // (nullable phi text) under its own schema for the NULL + update-to-value
  // round-trip; the BYTEA + pgcrypto plumbing is identical.
  it("create with null PHI stores NULL ciphertext; update to a value encrypts in place", async () => {
    const nullableManifest = {
      entities: [
        {
          name: "PhiBox",
          fields: [
            { name: "label", type: { kind: "text" }, required: true },
            { name: "secret", type: { kind: "text" }, classification: "phi" },
          ],
        },
      ],
    } as unknown as Manifest;
    const nullStore = new ColumnMappedEntityStore(conn, nullableManifest, {
      schema: "lk",
      encryptionKeyRef: KEY_REF,
    });
    await nullStore.ensureSchema();
    const t = randomUUID();
    const created = await nullStore.create(t, "PhiBox", { label: "row-1", secret: null });
    expect(created["secret"]).toBeNull();

    // raw row: the BYTEA column is genuinely NULL (no ciphertext written for null)
    const raw = await conn.query<{ secret: Buffer | null }>(
      `SELECT secret FROM lk.phi_box WHERE tenant_id = $1 AND id = $2`,
      [t, created.id],
    );
    expect(raw.rows[0]?.secret).toBeNull();

    // decrypted read returns null (omitted from the record per rowToRecord)
    const got = await nullStore.get(t, "PhiBox", created.id as string);
    expect(got).not.toBeNull();
    expect(got?.["secret"] ?? null).toBeNull();

    // update from NULL to a real value encrypts on the way in + decrypts on read
    const updated = await nullStore.update(t, "PhiBox", created.id as string, {
      secret: "now-set",
    });
    expect(updated?.["secret"]).toBe("now-set");
    const rawAfter = await conn.query<{ secret: Buffer | null }>(
      `SELECT secret FROM lk.phi_box WHERE tenant_id = $1 AND id = $2`,
      [t, created.id],
    );
    expect(rawAfter.rows[0]?.secret).toBeInstanceOf(Buffer);
    // the ciphertext doesn't contain the plaintext substring (proves it's encrypted, not bypassed)
    expect((rawAfter.rows[0]?.secret as Buffer).toString("utf8")).not.toContain("now-set");

    // and update back to null clears the ciphertext column (NULL again, not the string "null")
    const cleared = await nullStore.update(t, "PhiBox", created.id as string, {
      secret: null,
    });
    expect(cleared?.["secret"] ?? null).toBeNull();
    const rawCleared = await conn.query<{ secret: Buffer | null }>(
      `SELECT secret FROM lk.phi_box WHERE tenant_id = $1 AND id = $2`,
      [t, created.id],
    );
    expect(rawCleared.rows[0]?.secret).toBeNull();
  });

  it("round-trips an empty-string PHI value (distinct from null on the ciphertext side)", async () => {
    const mrn = ""; // intentionally empty — pgp_sym_encrypt accepts zero-length plaintext
    // mrn is required: true + unique. An empty string is a valid required value (length > -1)
    // and the unique index sees it as a distinct ciphertext.
    const patient = await store.create(tenant, "Patient", basePatient(mrn));
    const got = await store.get(tenant, "Patient", patient.id as string);
    expect(got?.["mrn"]).toBe("");
    // the BYTEA column is non-null even for an empty plaintext — pgp_sym_encrypt
    // emits a real envelope (header + zero-length payload) for ""
    const raw = await conn.query<{ mrn: Buffer | null; t: string }>(
      `SELECT mrn, pg_typeof(mrn)::text AS t FROM public.patient WHERE tenant_id = $1 AND id = $2`,
      [tenant, patient.id],
    );
    expect(raw.rows[0]?.t).toBe("bytea");
    expect(raw.rows[0]?.mrn).toBeInstanceOf(Buffer);
    expect((raw.rows[0]?.mrn as Buffer).length).toBeGreaterThan(0);
  });

  it("round-trips multibyte / Unicode PHI (Arabic + ASCII)", async () => {
    const mrn = `محمد-${uniqueMrn("u")}`;
    const patient = await store.create(tenant, "Patient", basePatient(mrn));
    const got = await store.get(tenant, "Patient", patient.id as string);
    expect(got?.["mrn"]).toBe(mrn);
    // the ciphertext doesn't contain the plaintext substring (a sanity check the
    // characters round-tripped through UTF-8 + pgcrypto rather than being mangled)
    const raw = await conn.query<{ mrn: Buffer }>(
      `SELECT mrn FROM public.patient WHERE tenant_id = $1 AND id = $2`,
      [tenant, patient.id],
    );
    expect(raw.rows[0]?.mrn.toString("utf8")).not.toContain("محمد");
  });

  it("round-trips a long PHI value (>256 chars), no truncation", async () => {
    // Patient.mrn is text with maxLength 32 in the manifest, but the SQL column
    // is plain TEXT (column store doesn't emit a length constraint). pgcrypto
    // imposes no size cap. Use a Long entity with no maxLength.
    const longManifest = {
      entities: [
        {
          name: "LongBox",
          fields: [
            { name: "label", type: { kind: "text" }, required: true },
            { name: "blob", type: { kind: "text" }, classification: "phi" },
          ],
        },
      ],
    } as unknown as Manifest;
    const longStore = new ColumnMappedEntityStore(conn, longManifest, {
      schema: "lk",
      encryptionKeyRef: KEY_REF,
    });
    await longStore.ensureSchema();
    const t = randomUUID();
    const big = "A".repeat(257) + "B".repeat(257) + "C".repeat(257); // 771 chars
    const created = await longStore.create(t, "LongBox", { label: "big", blob: big });
    const got = await longStore.get(t, "LongBox", created.id as string);
    expect(typeof got?.["blob"]).toBe("string");
    expect((got?.["blob"] as string).length).toBe(big.length);
    expect(got?.["blob"]).toBe(big);
  });

  it("listPage decrypts an encrypted column in the returned records", async () => {
    const mrnA = uniqueMrn("list-a");
    const mrnB = uniqueMrn("list-b");
    const t = randomUUID();
    const account = await store.create(t, "Account", {
      name: "List Co",
      status: "prospect",
      billing_email: "list@acme.test",
    });
    await store.create(t, "Patient", {
      account_id: account.id,
      mrn: mrnA,
      given_name: "List",
      family_name: "Aaa",
      date_of_birth: "1990-01-01",
      sex: "unknown",
      status: "active",
    });
    await store.create(t, "Patient", {
      account_id: account.id,
      mrn: mrnB,
      given_name: "List",
      family_name: "Bbb",
      date_of_birth: "1990-01-01",
      sex: "unknown",
      status: "active",
    });

    // No filter on the encrypted column (excluded from the filter adapter);
    // a sort on family_name (plaintext) lets us assert order deterministically.
    const page = await store.listPage(t, "Patient", {
      limit: 50,
      cursor: null,
      sort: [{ field: "family_name", direction: "asc" }],
      filters: [],
    });
    const mrns = page.records.map((r) => r["mrn"]);
    expect(mrns).toContain(mrnA);
    expect(mrns).toContain(mrnB);

    // Repeat with a ?fields projection that explicitly includes mrn — the
    // SQL pushdown still wraps the column in pgp_sym_decrypt
    const projected = await store.listPage(t, "Patient", {
      limit: 50,
      cursor: null,
      sort: [{ field: "family_name", direction: "asc" }],
      filters: [],
      fields: ["mrn", "family_name"],
    });
    expect(projected.records.map((r) => r["mrn"])).toEqual(expect.arrayContaining([mrnA, mrnB]));
  });
});
