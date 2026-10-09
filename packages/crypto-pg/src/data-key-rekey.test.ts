import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import {
  COLUMN_ENCRYPTION_KEY_GUC,
  COLUMN_ENCRYPTION_KEY_OLD_GUC,
  DEFAULT_COLUMN_KEY_REF,
  KeyRotationRefused,
  OLD_COLUMN_KEY_REF,
} from "@crossengin/kernel-pg";
import { DATA_KEY_BYTES, dataKeyToColumnKey, generateDataKey } from "@crossengin/crypto";

import {
  REKEY_REFUSAL_REASONS,
  TenantRekeyRefused,
  rekeyTenant,
  surveyTenantRekey,
} from "./data-key-rekey.js";
import { DATA_KEY_LOCK_SQL, PostgresDataKeyStore } from "./data-key-store.js";
import { fakeDataKeysPg, storedDataKeyRow, type FakeDataKeysPg } from "./test-fakes.js";
import { SET_TENANT_CONTEXT_SQL, TENANT_CONTEXT_GUC } from "./tenant-context.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const KEK = new Uint8Array(DATA_KEY_BYTES).fill(7);
const kekFor = (): Uint8Array => KEK;

const DATA_SCHEMA = "public";
const TENANT_SCHEMA = "t_11111111_1111_4111_8111_111111111111";

interface FakeColumn {
  readonly table: string;
  readonly column: string;
  /** `bytea` is ciphertext at rest; anything else is a hinted column that was never encrypted. */
  readonly dataType?: string;
  readonly dataClass?: string;
}

interface RotationOptions {
  readonly columns?: readonly FakeColumn[];
  readonly otherSchemas?: Readonly<Record<string, readonly FakeColumn[]>>;
  readonly partitioned?: readonly string[];
  readonly rlsEnabled?: boolean;
  readonly isOwner?: boolean;
  readonly bypassesRls?: boolean;
  /**
   * `relforcerowsecurity`, which confines the **owner** too. A real catalog always answers a
   * boolean here, so the fake does: leaving the key off would answer `undefined` for a column the
   * probe selects, which is the "a fake that answers a statement it could not really serve" class.
   */
  readonly rlsForced?: boolean;
  readonly hasScopeColumn?: boolean;
  readonly rowsPerColumn?: number;
  readonly updatedPerColumn?: number;
  readonly confirmedPerColumn?: number;
}

const PHI_COLUMNS: readonly FakeColumn[] = [
  { table: "patient", column: "mrn" },
  { table: "patient", column: "date_of_birth" },
];

/**
 * The *data* schema's half of the fake: the catalog reads, the visibility probe, the row count, the
 * `UPDATE` and the confirm pass.
 *
 * Deliberately separate from `fakeDataKeysPg`'s own rules rather than folded into them. These
 * statements are about the tenant's entity tables, not about `meta.tenant_data_keys`, and that
 * fake's tripwires would refuse a catalog query for carrying no `tenant_id` predicate — a fake
 * asserting a rule about a table the statement does not touch.
 *
 * The two counts come back as **strings**, because `count()` is BIGINT and node-postgres hands a
 * BIGINT back as text (ADR-0331's measured class). A fake answering numbers would be modelling a
 * row shape no deployment produces.
 */
function rotationAnswers(
  options: RotationOptions,
): (sql: string, params: readonly unknown[]) => PgQueryResult | null {
  const columnsFor = (schema: string): readonly FakeColumn[] => {
    if (schema === DATA_SCHEMA) return options.columns ?? PHI_COLUMNS;
    return options.otherSchemas?.[schema] ?? [];
  };
  return (sql, params) => {
    if (sql.includes("col_description")) {
      const schema = String(params[0]);
      const rows = columnsFor(schema).map((c) => ({
        schema,
        table_name: c.table,
        column_name: c.column,
        data_type: c.dataType ?? "bytea",
        comment: `crossengin.data_class=${c.dataClass ?? "phi"}; crossengin.encrypt=at_rest`,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("relkind = 'p'")) {
      const names = String(params[0]) === DATA_SCHEMA ? (options.partitioned ?? []) : [];
      const rows = names.map((table_name) => ({
        table_name,
        comment: "crossengin.encrypt=at_rest",
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("relrowsecurity")) {
      return {
        rows: [
          {
            role: "crossengin_app",
            bypasses_rls: options.bypassesRls ?? false,
            is_owner: options.isOwner ?? true,
            rls_enabled: options.rlsEnabled ?? true,
            rls_forced: options.rlsForced ?? false,
            has_scope_column: options.hasScopeColumn ?? true,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("AS rows_to_rewrite")) {
      return {
        rows: [{ rows_to_rewrite: String(options.rowsPerColumn ?? 3) }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE ")) {
      return { rows: [], rowCount: options.updatedPerColumn ?? options.rowsPerColumn ?? 3 };
    }
    if (sql.includes("AS readable")) {
      return {
        rows: [
          {
            readable: String(
              options.confirmedPerColumn ?? options.updatedPerColumn ?? options.rowsPerColumn ?? 3,
            ),
          },
        ],
        rowCount: 1,
      };
    }
    return null;
  };
}

interface Fixture {
  readonly fake: FakeDataKeysPg;
  readonly store: PostgresDataKeyStore;
  readonly storedDek: Uint8Array;
}

function fixture(
  options: RotationOptions & {
    readonly rows?: readonly Record<string, unknown>[];
    readonly noKeyRow?: boolean;
    readonly storedProvenance?: string;
    readonly storedGeneration?: number;
  } = {},
): Fixture {
  const storedDek = generateDataKey();
  const seedRows =
    options.rows ??
    (options.noKeyRow === true
      ? []
      : [
          storedDataKeyRow(KEK, TENANT_A, storedDek, {
            generation: options.storedGeneration ?? 1,
            provenance: options.storedProvenance ?? "seeded_from_derived",
          }),
        ]);
  const fake = fakeDataKeysPg({ seedRows, answer: rotationAnswers(options) });
  return { fake, store: new PostgresDataKeyStore(fake.conn, kekFor), storedDek };
}

function inputOf(f: Fixture, over: { readonly alternativeSchemas?: readonly string[] } = {}) {
  return {
    conn: f.fake.conn,
    store: f.store,
    tenantId: TENANT_A,
    dataSchema: DATA_SCHEMA,
    ...over,
  };
}

function sqlOf(f: Fixture): string[] {
  return f.fake.captured.map((c) => c.sql);
}

function settingsOf(f: Fixture): [string, string][] {
  return f.fake.captured
    .filter((c) => c.sql.includes("set_config") && !c.sql.includes(TENANT_CONTEXT_GUC))
    .map((c) => [String(c.params?.[0]), String(c.params?.[1])] as [string, string]);
}

/**
 * Everything through, except that a `DELETE` reports zero rows without raising.
 *
 * What RLS answers a session it confines, and the one failure inside this transaction that leaves
 * both halves of the rekey looking successful: the ciphertext is rewritten, the new key row is
 * written, and the generation the rekey exists to retire survives.
 */
function silencesDelete(conn: PgConnection): PgConnection {
  const wrap = (inner: PgConnection): PgConnection => ({
    query: (async (sql: string, params?: readonly unknown[]) => {
      const result = await inner.query(sql, params);
      return sql.includes("DELETE FROM") ? { rows: [], rowCount: 0 } : result;
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      inner.transaction((tx) => fn(wrap(tx)))) as PgConnection["transaction"],
    withAdvisoryLock: inner.withAdvisoryLock.bind(inner),
    close: inner.close.bind(inner),
  });
  return wrap(conn);
}

describe("constants", () => {
  it("names the four ways a rekey is wrong as a rekey", () => {
    expect(REKEY_REFUSAL_REASONS).toEqual([
      "no_data_key_row",
      "no_encrypted_columns",
      "new_key_equals_old",
      "nothing_to_reencrypt",
    ]);
  });

  it("has a test for every member, so a fifth cannot land unexercised", () => {
    // The forcing function, derived from the enum rather than restated: each reason below names the
    // test that reaches it, and a member added with no entry here fails on the key set rather than
    // passing quietly as a safety check nothing exercises.
    const covered: Readonly<Record<(typeof REKEY_REFUSAL_REASONS)[number], string>> = {
      no_data_key_row: "refuses no_data_key_row before any rewrite",
      no_encrypted_columns: "refuses no_encrypted_columns and names a schema that does hold ciphertext",
      new_key_equals_old: "refuses when the generated key is byte-identical to the stored one",
      nothing_to_reencrypt: "refuses a rotation that rewrote nothing, before destroying the key",
    };
    expect(Object.keys(covered).sort()).toEqual([...REKEY_REFUSAL_REASONS].sort());
  });

  it("rotates from the old-key GUC to the one the serving stack reads", () => {
    // Not interchangeable: the new key has to land in the GUC `buildEnvelopeKeySource`'s consumers
    // read, or the rekey would leave the deployment one step out of phase with its own key source.
    expect(OLD_COLUMN_KEY_REF).toContain(COLUMN_ENCRYPTION_KEY_OLD_GUC);
    expect(DEFAULT_COLUMN_KEY_REF).toContain(COLUMN_ENCRYPTION_KEY_GUC);
    expect(OLD_COLUMN_KEY_REF).not.toBe(DEFAULT_COLUMN_KEY_REF);
  });
});

describe("surveyTenantRekey", () => {
  it("reports the current generation, provenance and per-column row counts", async () => {
    const f = fixture({ rowsPerColumn: 4 });
    const survey = await surveyTenantRekey(inputOf(f));

    expect(survey.tenantId).toBe(TENANT_A);
    expect(survey.dataSchema).toBe(DATA_SCHEMA);
    expect(survey.current).toEqual({
      generation: 1,
      provenance: "seeded_from_derived",
      kekGeneration: 1,
    });
    expect(survey.plans.map((p) => `${p.table}.${p.column}`)).toEqual([
      "patient.mrn",
      "patient.date_of_birth",
    ]);
    expect(survey.plans.map((p) => p.rowsToRewrite)).toEqual([4, 4]);
    expect(survey.rowsToRewrite).toBe(8);
    expect(survey.refusals).toEqual([]);
  });

  it("writes nothing and mints nothing", async () => {
    const f = fixture();
    await surveyTenantRekey(inputOf(f));

    const statements = sqlOf(f);
    expect(statements.some((s) => s.includes("INSERT INTO"))).toBe(false);
    expect(statements.some((s) => s.includes("DELETE FROM"))).toBe(false);
    expect(statements.some((s) => s.startsWith("UPDATE "))).toBe(false);
    expect(f.fake.rows).toHaveLength(1);
  });

  it("sets no key GUC, because nothing it issues decrypts", async () => {
    const f = fixture();
    await surveyTenantRekey(inputOf(f));
    // A survey has to be runnable on a deployment whose keys an operator has not arranged yet,
    // which is the deployment most likely to be asking.
    expect(settingsOf(f)).toEqual([]);
  });

  it("plans the key references and never a key value", async () => {
    const f = fixture();
    const survey = await surveyTenantRekey(inputOf(f));
    const first = survey.plans[0];
    expect(first?.statement.sql).toContain(OLD_COLUMN_KEY_REF);
    expect(first?.statement.sql).toContain(DEFAULT_COLUMN_KEY_REF);
    expect(first?.confirm.sql).toContain(DEFAULT_COLUMN_KEY_REF);
  });

  it("binds the tenant and names it in no statement text", async () => {
    const f = fixture();
    const survey = await surveyTenantRekey(inputOf(f));
    for (const plan of survey.plans) {
      expect(plan.statement.sql).toContain('"tenant_id" = $1');
      expect(plan.statement.sql).not.toContain(TENANT_A);
      expect(plan.statement.params).toEqual([TENANT_A]);
      expect(plan.confirm.sql).toContain('"tenant_id" = $1');
    }
  });

  it("refuses no_data_key_row first, and still reports the plans", async () => {
    const f = fixture({ noKeyRow: true });
    const survey = await surveyTenantRekey(inputOf(f));

    expect(survey.current).toBeNull();
    expect(survey.refusals[0]?.reason).toBe("no_data_key_row");
    expect(survey.refusals[0]?.detail).toContain("derived");
    // The plans are what tell an operator whether this tenant has ciphertext at all, which is the
    // next question after "no key row".
    expect(survey.plans).toHaveLength(2);
  });

  it("refuses no_encrypted_columns and names a schema that does hold ciphertext", async () => {
    const f = fixture({
      columns: [],
      otherSchemas: { [TENANT_SCHEMA]: PHI_COLUMNS },
    });
    const survey = await surveyTenantRekey(
      inputOf(f, { alternativeSchemas: [DATA_SCHEMA, TENANT_SCHEMA] }),
    );

    expect(survey.refusals.map((r) => r.reason)).toContain("no_encrypted_columns");
    expect(survey.alternativesWithCiphertext).toEqual([TENANT_SCHEMA]);
    expect(
      survey.refusals.find((r) => r.reason === "no_encrypted_columns")?.detail,
    ).toContain(TENANT_SCHEMA);
  });

  it("names no alternative that holds no ciphertext", async () => {
    const f = fixture({ columns: [], otherSchemas: { t_empty: [] } });
    const survey = await surveyTenantRekey(inputOf(f, { alternativeSchemas: ["t_empty"] }));
    expect(survey.alternativesWithCiphertext).toEqual([]);
    expect(survey.refusals.map((r) => r.reason)).toContain("no_encrypted_columns");
  });

  it("asks about alternatives only when the primary schema is empty", async () => {
    const f = fixture({ otherSchemas: { [TENANT_SCHEMA]: PHI_COLUMNS } });
    const survey = await surveyTenantRekey(inputOf(f, { alternativeSchemas: [TENANT_SCHEMA] }));

    expect(survey.alternativesWithCiphertext).toEqual([]);
    const catalogSchemas = f.fake.captured
      .filter((c) => c.sql.includes("col_description"))
      .map((c) => String(c.params?.[0]));
    expect(catalogSchemas).toEqual([DATA_SCHEMA]);
  });

  it("merges the rotation survey's refusals after its own", async () => {
    const f = fixture({ noKeyRow: true, hasScopeColumn: false });
    const survey = await surveyTenantRekey(inputOf(f));
    // One refusal and not two, because the probe is per *table*: both PHI columns are on
    // `patient`, so the table is asked about once.
    expect(survey.refusals.map((r) => r.reason)).toEqual([
      "no_data_key_row",
      "tenant_column_missing",
    ]);
  });

  it("reports a confined session rather than a row count", async () => {
    const f = fixture({ isOwner: false, rlsEnabled: true, bypassesRls: false });
    const survey = await surveyTenantRekey(inputOf(f));

    expect(survey.refusals.map((r) => r.reason)).toContain("rls_would_confine_this_session");
    // Not counted, because a confined session counts 0 and 0 is byte-identical to "this tenant
    // holds no ciphertext" — which is the one wrong answer a rekey cannot come back from.
    expect(survey.plans.every((p) => p.rowsToRewrite === null)).toBe(true);
    expect(survey.rowsToRewrite).toBe(0);
  });

  it("reports a hinted column that was never encrypted and does not plan it", async () => {
    const f = fixture({
      columns: [
        { table: "patient", column: "mrn" },
        { table: "patient", column: "notes", dataType: "text" },
      ],
    });
    const survey = await surveyTenantRekey(inputOf(f));
    expect(survey.plans.map((p) => p.column)).toEqual(["mrn"]);
    expect(survey.plaintextAtRest.map((c) => c.column)).toEqual(["notes"]);
  });

  it("refuses a malformed tenant id before any statement", async () => {
    const f = fixture();
    await expect(
      surveyTenantRekey({ ...inputOf(f), tenantId: "not a uuid;" }),
    ).rejects.toThrow(/invalid tenantId/);
    expect(f.fake.captured).toHaveLength(0);
  });
});

describe("rekeyTenant", () => {
  it("issues the whole sequence inside one transaction, in order", async () => {
    const f = fixture();
    await rekeyTenant(inputOf(f));

    const order = sqlOf(f);
    const at = (predicate: (s: string) => boolean): number => order.findIndex(predicate);
    const context = at((s) => s === SET_TENANT_CONTEXT_SQL);
    const lock = at((s) => s === DATA_KEY_LOCK_SQL);
    const read = at((s) => s.startsWith("SELECT ") && s.includes("FROM meta.tenant_data_keys"));
    const setting = at((s) => s.includes("set_config") && !s.includes(TENANT_CONTEXT_GUC));
    const catalog = at((s) => s.includes("col_description"));
    const probe = at((s) => s.includes("relrowsecurity"));
    const count = at((s) => s.includes("AS rows_to_rewrite"));
    const update = at((s) => s.startsWith("UPDATE "));
    const confirm = at((s) => s.includes("AS readable"));
    const insert = at((s) => s.includes("INSERT INTO"));
    const del = at((s) => s.includes("DELETE FROM"));

    for (const [name, index] of Object.entries({
      context,
      lock,
      read,
      setting,
      catalog,
      probe,
      count,
      update,
      confirm,
      insert,
      del,
    })) {
      expect(index, name).toBeGreaterThanOrEqual(0);
    }
    expect(context).toBeLessThan(lock);
    expect(lock).toBeLessThan(read);
    expect(read).toBeLessThan(setting);
    expect(setting).toBeLessThan(catalog);
    expect(catalog).toBeLessThan(probe);
    expect(probe).toBeLessThan(count);
    expect(count).toBeLessThan(update);
    expect(update).toBeLessThan(confirm);
    expect(confirm).toBeLessThan(insert);
    expect(insert).toBeLessThan(del);
    expect(f.fake.captured.every((c) => c.inTx)).toBe(true);
  });

  it("every UPDATE lands before the first confirm", async () => {
    const f = fixture();
    await rekeyTenant(inputOf(f));
    const order = sqlOf(f);
    const lastUpdate = order.reduce((n, s, i) => (s.startsWith("UPDATE ") ? i : n), -1);
    const firstConfirm = order.findIndex((s) => s.includes("AS readable"));
    expect(lastUpdate).toBeGreaterThanOrEqual(0);
    expect(lastUpdate).toBeLessThan(firstConfirm);
  });

  it("maps the old key to the old GUC and the new key to the serving GUC", async () => {
    const f = fixture();
    const result = await rekeyTenant(inputOf(f));

    const settings = settingsOf(f);
    expect(settings.map(([name]) => name)).toEqual([
      COLUMN_ENCRYPTION_KEY_OLD_GUC,
      COLUMN_ENCRYPTION_KEY_GUC,
    ]);
    expect(settings[0]?.[1]).toBe(dataKeyToColumnKey(f.storedDek));
    const written = f.fake.rows.find((r) => r["generation"] === result.toGeneration);
    expect(written).toBeDefined();
    // The new GUC holds the key the new row now wraps, which is the pairing the whole operation is.
    expect(settings[1]?.[1]).not.toBe(settings[0]?.[1]);
  });

  it("puts the two key values in params and in no SQL text anywhere", async () => {
    const f = fixture();
    await rekeyTenant(inputOf(f));

    const settings = settingsOf(f);
    expect(settings).toHaveLength(2);
    for (const [, value] of settings) {
      expect(value.length).toBeGreaterThan(0);
      for (const captured of f.fake.captured) {
        expect(captured.sql).not.toContain(value);
      }
    }
    // And the KEK never travels at all, in either direction.
    for (const captured of f.fake.captured) {
      expect(captured.sql).not.toContain(Buffer.from(KEK).toString("base64"));
    }
  });

  it("writes a random key at the next generation and destroys the earlier ones", async () => {
    const f = fixture({ storedGeneration: 2, rowsPerColumn: 5 });
    const result = await rekeyTenant(inputOf(f));

    expect(result).toMatchObject({
      tenantId: TENANT_A,
      fromGeneration: 2,
      fromProvenance: "seeded_from_derived",
      toGeneration: 3,
      rowsReencrypted: 10,
      rowsConfirmed: 10,
      priorGenerationsDestroyed: 1,
    });
    expect(result.columns.map((c) => `${c.table}.${c.column}`)).toEqual([
      "patient.mrn",
      "patient.date_of_birth",
    ]);
    expect(f.fake.rows).toHaveLength(1);
    expect(f.fake.rows[0]?.["provenance"]).toBe("random");
    expect(f.fake.rows[0]?.["generation"]).toBe(3);
  });

  it("reads through the *Within seam, so it never nests a transaction", async () => {
    const f = fixture();
    await rekeyTenant(inputOf(f));
    // Exactly one tenant-context `set_config` in the whole trace. `load` and `ensure` each open
    // their own transaction and set it again, so a second one here would be the nested transaction
    // the real `node-pg` binding refuses and both of this package's fakes permit — green offline,
    // dead live, which is the only reason the seams exist.
    expect(
      sqlOf(f).filter((s) => s.includes("set_config") && s.includes(TENANT_CONTEXT_GUC)),
    ).toHaveLength(1);
    expect(sqlOf(f).filter((s) => s === DATA_KEY_LOCK_SQL)).toHaveLength(1);
  });

  it("binds the new generation into the row's AAD", async () => {
    const f = fixture();
    const result = await rekeyTenant(inputOf(f));
    const written = f.fake.rows.find((r) => r["generation"] === result.toGeneration);
    expect(written).toBeDefined();
    // Refiled at another generation the same bytes do not open, so a row cannot be replayed as a
    // generation it was not wrapped for — which is what keeps the destroyed generations destroyed.
    f.fake.rows.splice(0, f.fake.rows.length, { ...(written ?? {}), generation: 9 });
    await expect(f.store.load(TENANT_A)).rejects.toThrow(/did not unwrap/);
  });

  it("leaves the tenant readable under the new key, not the old one", async () => {
    const f = fixture();
    await rekeyTenant(inputOf(f));
    const reread = await f.store.load(TENANT_A);
    expect(reread?.provenance).toBe("random");
    expect(
      Buffer.from(reread?.dek ?? new Uint8Array()).equals(Buffer.from(f.storedDek)),
    ).toBe(false);
  });

  it("scopes every rewrite to this tenant, so no other tenant's ciphertext moves", async () => {
    const f = fixture();
    await rekeyTenant(inputOf(f));
    const updates = f.fake.captured.filter((c) => c.sql.startsWith("UPDATE "));
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      // Finding 1: without this predicate a rekey for one tenant rewrites every tenant's rows under
      // this tenant's key pair, and in envelope mode `pgp_sym_decrypt` raises on the first foreign
      // row — so the scope is not a refinement, it is the difference between a rekey and a disaster.
      expect(update.sql).toContain('"tenant_id" = $1');
      expect(update.params).toEqual([TENANT_A]);
      expect(update.sql).not.toContain(TENANT_A);
    }
  });

  it("rolls back and writes no key row when a confirm count disagrees", async () => {
    const f = fixture({ updatedPerColumn: 3, confirmedPerColumn: 2 });

    await expect(rekeyTenant(inputOf(f))).rejects.toThrow(/confirm failed/);

    // The throw escapes `conn.transaction`, which is what makes the real binding roll back; what an
    // offline fake can show is the half that matters — the key row was never written, so no
    // deployment is left naming a key its ciphertext is not under.
    expect(sqlOf(f).some((s) => s.includes("INSERT INTO"))).toBe(false);
    expect(f.fake.rows).toHaveLength(1);
    expect(f.fake.rows[0]?.["provenance"]).toBe("seeded_from_derived");
  });

  it("will not commit when the delete retired no generation", async () => {
    // The read found a row at generation 1 under this transaction's lock, so a `DELETE` bounded by
    // `generation <= 1` had at least that row to reach. Zero is therefore not "nothing to retire" —
    // it is RLS confining a session or a scope that does not match the read, and the consequence is
    // the previous generation surviving the rekey and going on claiming a recomputable key while
    // the deployment believes the tenant is shreddable.
    const f = fixture();
    // The message names the generation it read rather than a count of earlier ones: `current
    // .generation` is a generation *number*, so "none of the 1 earlier generation(s)" read a label
    // as a quantity and was wrong for every tenant past generation 1.
    await expect(
      rekeyTenant({ ...inputOf(f), conn: silencesDelete(f.fake.conn) }),
    ).rejects.toThrow(/retired no earlier generation, though generation 1 was read/);
    // Rolled back: the row the rekey read is the row that is still there.
    expect(f.fake.rows).toHaveLength(1);
    expect(f.fake.rows[0]?.["provenance"]).toBe("seeded_from_derived");
  });

  it("refuses no_data_key_row before any rewrite", async () => {
    const f = fixture({ noKeyRow: true });

    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantRekeyRefused);
    expect((error as TenantRekeyRefused).tenantId).toBe(TENANT_A);
    expect((error as TenantRekeyRefused).refusals.map((r) => r.reason)).toEqual([
      "no_data_key_row",
    ]);
    expect(sqlOf(f).some((s) => s.startsWith("UPDATE "))).toBe(false);
    expect(sqlOf(f).some((s) => s.includes("INSERT INTO"))).toBe(false);
  });

  it("lets the rotation's own refusal out unchanged, before any rewrite", async () => {
    const f = fixture({ hasScopeColumn: false });

    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    // Not re-wrapped as a TenantRekeyRefused: that would need the only `catch` in a function whose
    // guarantee is that it has none, and it would erase which vocabulary the refusal came from.
    expect(error).toBeInstanceOf(KeyRotationRefused);
    expect((error as KeyRotationRefused).refusals.map((r) => r.reason)).toEqual([
      "tenant_column_missing",
    ]);
    expect(sqlOf(f).some((s) => s.startsWith("UPDATE "))).toBe(false);
    expect(f.fake.rows).toHaveLength(1);
  });

  it("refuses a partitioned table rather than reporting a rotation that skipped it", async () => {
    const f = fixture({ partitioned: ["observation"] });
    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyRotationRefused);
    expect((error as KeyRotationRefused).refusals[0]?.reason).toBe(
      "partitioned_table_unreachable",
    );
    expect(sqlOf(f).some((s) => s.startsWith("UPDATE "))).toBe(false);
  });

  it("refuses a confined session before any rewrite", async () => {
    const f = fixture({ isOwner: false, rlsEnabled: true, bypassesRls: false });
    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyRotationRefused);
    expect((error as KeyRotationRefused).refusals[0]?.reason).toBe(
      "rls_would_confine_this_session",
    );
    expect(sqlOf(f).some((s) => s.startsWith("UPDATE "))).toBe(false);
  });

  it("refuses an owner that FORCE ROW LEVEL SECURITY confines", async () => {
    // The owner arm is the one `relforcerowsecurity` overrides, and this is the operation it
    // matters to: a confined session rewrites 0 rows and the next statement destroys the key those
    // rows are under. Asserted through the rekey and not only through the probe, so the fix is
    // known to reach the destructive path.
    const f = fixture({ isOwner: true, rlsEnabled: true, bypassesRls: false, rlsForced: true });
    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyRotationRefused);
    expect((error as KeyRotationRefused).refusals[0]?.reason).toBe(
      "rls_would_confine_this_session",
    );
    expect((error as KeyRotationRefused).refusals[0]?.detail).toContain(
      "FORCE ROW LEVEL SECURITY",
    );
    const statements = sqlOf(f);
    expect(statements.some((s) => s.startsWith("UPDATE "))).toBe(false);
    expect(statements.some((s) => s.includes("DELETE FROM"))).toBe(false);
    expect(f.fake.rows).toHaveLength(1);
  });

  it("does not refuse an unforced owner, which is every deployment today", async () => {
    const f = fixture({ isOwner: true, rlsEnabled: true, bypassesRls: false, rlsForced: false });
    await expect(rekeyTenant(inputOf(f))).resolves.toMatchObject({ toGeneration: 2 });
  });

  it("refuses a malformed tenant id before any statement", async () => {
    const f = fixture();
    await expect(rekeyTenant({ ...inputOf(f), tenantId: "not a uuid;" })).rejects.toThrow(
      /invalid tenantId/,
    );
    expect(f.fake.captured).toHaveLength(0);
  });

  it("does not read or write another tenant's key row", async () => {
    const f = fixture({
      rows: [storedDataKeyRow(KEK, TENANT_B, generateDataKey(), { generation: 1 })],
    });
    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantRekeyRefused);
    expect(f.fake.rows).toHaveLength(1);
    expect(f.fake.rows[0]?.["tenant_id"]).toBe(TENANT_B);
  });
});

/**
 * The refusal that covers the one count at which the confirm pass proves nothing.
 *
 * `rotateTenantWithin` compares the rows it rewrote against the rows that read back under the new
 * key, which is the right check for every count but zero: `0 === 0` passes having established
 * nothing at all, and the very next statement destroys the only copy of the key this tenant's
 * ciphertext is under. The reachable cause is a wrong `--data-schema` — the schema holds the
 * encrypted *columns*, so `no_encrypted_columns` does not fire, and holds none of **this tenant's**
 * rows, so the rotation rewrites nothing and the tenant's real ciphertext (in their own `t_<uuid>`
 * schema) becomes permanently unreadable.
 *
 * So the assertions that matter here are over the **recorded statements** rather than over the
 * thrown error: a refusal whose message is right while the DELETE still ran is the defect.
 */
describe("nothing_to_reencrypt", () => {
  /** Encrypted columns present, and no row for this tenant: the wrong-`--data-schema` shape. */
  const noRowsForThisTenant = (): Fixture => fixture({ rowsPerColumn: 0 });

  it("refuses a rotation that rewrote nothing, before destroying the key", async () => {
    const f = noRowsForThisTenant();
    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TenantRekeyRefused);
    expect((error as TenantRekeyRefused).tenantId).toBe(TENANT_A);
    expect((error as TenantRekeyRefused).refusals.map((r) => r.reason)).toEqual([
      "nothing_to_reencrypt",
    ]);
  });

  it("writes no key row and deletes no generation", async () => {
    const f = noRowsForThisTenant();
    await rekeyTenant(inputOf(f)).catch(() => undefined);

    // The whole point of the refusal, asserted where it can be seen: nothing was destroyed. A
    // `DELETE` bounded by `generation <= 1` would have taken the only copy of the key the tenant's
    // ciphertext is under, and `INSERT` would have named a random one in its place.
    const statements = sqlOf(f);
    expect(statements.some((s) => s.includes("INSERT INTO"))).toBe(false);
    expect(statements.some((s) => s.includes("DELETE FROM"))).toBe(false);
    // And the row the rekey read is the row that is still there, at its original generation.
    expect(f.fake.rows).toHaveLength(1);
    expect(f.fake.rows[0]?.["provenance"]).toBe("seeded_from_derived");
    expect(f.fake.rows[0]?.["generation"]).toBe(1);
  });

  it("fires after the vacuous confirm pass, which is why the confirm cannot cover it", async () => {
    const f = noRowsForThisTenant();
    await rekeyTenant(inputOf(f)).catch(() => undefined);

    const order = sqlOf(f);
    // The rotation really ran — UPDATE and confirm both issued, and the confirm *agreed* (0 against
    // 0) rather than throwing. So this refusal is not a second spelling of the confirm check; it is
    // the case the confirm check is structurally unable to answer.
    const update = order.findIndex((s) => s.startsWith("UPDATE "));
    const confirm = order.findIndex((s) => s.includes("AS readable"));
    expect(update).toBeGreaterThanOrEqual(0);
    expect(confirm).toBeGreaterThan(update);
    const readable = f.fake.captured.filter((c) => c.sql.includes("AS readable"));
    expect(readable).toHaveLength(2);
  });

  it("names --data-schema and the tenant's own schema, because that is the remedy", async () => {
    const f = noRowsForThisTenant();
    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    const detail = (error as TenantRekeyRefused).refusals[0]?.detail ?? "";

    expect(detail).toContain("--data-schema");
    expect(detail).toContain("another schema");
    // The tenant's own schema named as the likely place, which is what turns a puzzling refusal
    // into an action: a tenant serving its own activated manifest holds its encrypted tables there
    // and nowhere `--data-schema public` can see.
    expect(detail).toContain("activated manifest holds it in its own");
    expect(detail).toContain(DATA_SCHEMA);
    // And it says what the next statement would have done, since "nothing was re-encrypted" alone
    // reads as harmless.
    expect(detail).toContain("destroy the only copy of the key");
    // Both halves of the ambiguity, because they are indistinguishable from inside the transaction
    // and only one of them is harmless.
    expect(detail).toContain("holds no ciphertext");
  });

  it("transports no key material in the refusal", async () => {
    const f = noRowsForThisTenant();
    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).not.toContain(dataKeyToColumnKey(f.storedDek));
    expect(message).not.toContain(Buffer.from(KEK).toString("base64"));
    // 32 raw bytes base64 is 44 characters; the refusal carries catalog names and counts only.
    expect(message).not.toMatch(/[A-Za-z0-9+/]{43}=/);
  });

  it("still commits a rotation that rewrote a single row", async () => {
    // One row is the smallest non-refusing count, so this is the fence rather than a repeat of the
    // happy path: a refusal written as `<= 0` would be indistinguishable here and a `< 1` typo as
    // `<= 1` would not.
    const f = fixture({ rowsPerColumn: 1 });
    const result = await rekeyTenant(inputOf(f));

    expect(result.rowsReencrypted).toBe(2);
    expect(result.rowsConfirmed).toBe(2);
    expect(result.toGeneration).toBe(2);
    expect(result.priorGenerationsDestroyed).toBe(1);
    const statements = sqlOf(f);
    expect(statements.some((s) => s.includes("INSERT INTO"))).toBe(true);
    expect(statements.some((s) => s.includes("DELETE FROM"))).toBe(true);
    expect(f.fake.rows).toHaveLength(1);
    expect(f.fake.rows[0]?.["provenance"]).toBe("random");
    expect(f.fake.rows[0]?.["generation"]).toBe(2);
  });

  it("is a rule about the total, so one column rewriting nothing is not a refusal", async () => {
    // Per column, zero is ordinary: the rotation's `WHERE col IS NOT NULL` skips a nullable PHI
    // column nobody filled in, so a per-column refusal would refuse most real tenants. The
    // aggregate is therefore the right unit — and the residual follows from it, which is why this
    // is pinned rather than left implicit: a `--data-schema` holding *some* of this tenant's
    // ciphertext sums above zero and is not refused, while the key it destroys also covered the
    // rows in whatever schema this invocation never looked at.
    const perColumn = [5, 0] as const;
    let updates = 0;
    let confirms = 0;
    const base = rotationAnswers({});
    const fake = fakeDataKeysPg({
      seedRows: [
        storedDataKeyRow(KEK, TENANT_A, generateDataKey(), {
          generation: 1,
          provenance: "seeded_from_derived",
        }),
      ],
      answer: (sql, params) => {
        // `rotateTenantWithin` issues every UPDATE and then every confirm, in one column order, so
        // the two counters walk the same list.
        if (sql.startsWith("UPDATE ")) {
          const n = perColumn[updates] ?? 0;
          updates += 1;
          return { rows: [], rowCount: n };
        }
        if (sql.includes("AS readable")) {
          const n = perColumn[confirms] ?? 0;
          confirms += 1;
          return { rows: [{ readable: String(n) }], rowCount: 1 };
        }
        return base(sql, params);
      },
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    const result = await rekeyTenant({
      conn: fake.conn,
      store,
      tenantId: TENANT_A,
      dataSchema: DATA_SCHEMA,
    });
    expect(result.columns.map((c) => c.rowsReencrypted)).toEqual([5, 0]);
    expect(result.rowsReencrypted).toBe(5);
    expect(result.priorGenerationsDestroyed).toBe(1);
  });

  it("refuses a tenant whose only encrypted column has no rows, even with columns planned", async () => {
    // The survey's own `no_encrypted_columns` arm cannot reach this: the columns are there, so the
    // plan is non-empty and the alternative-schema hint never fires. Asserted here so the two
    // refusals are not confused for one another.
    const f = noRowsForThisTenant();
    const survey = await surveyTenantRekey(inputOf(f, { alternativeSchemas: [TENANT_SCHEMA] }));
    expect(survey.refusals).toEqual([]);
    expect(survey.plans).toHaveLength(2);
    expect(survey.rowsToRewrite).toBe(0);
    expect(survey.alternativesWithCiphertext).toEqual([]);

    const error = await rekeyTenant(inputOf(f)).catch((e: unknown) => e);
    expect((error as TenantRekeyRefused).refusals.map((r) => r.reason)).toEqual([
      "nothing_to_reencrypt",
    ]);
  });
});

describe("new_key_equals_old", () => {
  afterEach(() => {
    vi.doUnmock("@crossengin/crypto");
    vi.resetModules();
  });

  it("refuses when the generated key is byte-identical to the stored one", async () => {
    // The only branch in this module that cannot be reached by arranging the database, because the
    // key it compares against is random by construction. Left untested it would be a safety check
    // nothing ever exercised, which is the class this increment's ADR lineage exists to end.
    const fixed = new Uint8Array(DATA_KEY_BYTES).fill(9);
    vi.doMock("@crossengin/crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@crossengin/crypto")>();
      return { ...actual, generateDataKey: (): Uint8Array => fixed };
    });
    // Before the dynamic import and after the mock: the statically imported copy at the top of this
    // file is already in the registry, and without the reset the re-import hands it back unmocked —
    // which reads as the refusal not firing rather than as the mock not applying.
    vi.resetModules();
    const mod = await import("./data-key-rekey.js");

    const fake = fakeDataKeysPg({
      seedRows: [storedDataKeyRow(KEK, TENANT_A, fixed, { generation: 1 })],
      answer: rotationAnswers({}),
    });
    const store = new PostgresDataKeyStore(fake.conn, kekFor);

    const error = await mod
      .rekeyTenant({ conn: fake.conn, store, tenantId: TENANT_A, dataSchema: DATA_SCHEMA })
      .catch((e: unknown) => e);

    expect((error as TenantRekeyRefused).refusals.map((r) => r.reason)).toEqual([
      "new_key_equals_old",
    ]);
    const statements = fake.captured.map((c) => c.sql);
    // Before the migrator is even constructed, so no key GUC is claimed and nothing is rewritten.
    expect(statements.some((s) => s.startsWith("UPDATE "))).toBe(false);
    expect(
      statements.some((s) => s.includes("set_config") && !s.includes(TENANT_CONTEXT_GUC)),
    ).toBe(false);
    expect(fake.rows).toHaveLength(1);
  });
});
