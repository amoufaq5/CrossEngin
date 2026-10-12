import { describe, expect, it, vi } from "vitest";
import type { PgConnection, PgQueryResult } from "./connection.js";
import type { EncryptedColumnRow } from "./encryption.js";
import { DEFAULT_COLUMN_KEY_REF } from "./encryption.js";
import {
  EncryptionMigrator,
  emitDecryptingViewSql,
  emitEncryptColumnSql,
  formatEncryptionPlan,
  planColumnEncryption,
} from "./encryption-migration.js";

// The canonical ref, imported rather than respelled: this literal used to be written out here, in
// `crossengin-pg.ts` and in `operate-runtime-pg`'s column store, agreeing by coincidence.
const KEY_REF = DEFAULT_COLUMN_KEY_REF;

describe("emitEncryptColumnSql", () => {
  const sql = emitEncryptColumnSql({
    schema: "t_clinic",
    table: "patient",
    column: "mrn",
    keyRef: KEY_REF,
    dataClass: "phi",
  });

  it("emits the five in-place conversion statements in order", () => {
    expect(sql).toHaveLength(5);
    expect(sql[0]).toBe(`ALTER TABLE "t_clinic"."patient" ADD COLUMN "mrn__enc" BYTEA;`);
    expect(sql[2]).toBe(`ALTER TABLE "t_clinic"."patient" DROP COLUMN "mrn";`);
    expect(sql[3]).toBe(`ALTER TABLE "t_clinic"."patient" RENAME COLUMN "mrn__enc" TO "mrn";`);
  });

  it("encrypts existing values via pgp_sym_encrypt, preserving NULLs", () => {
    expect(sql[1]).toBe(
      `UPDATE "t_clinic"."patient" SET "mrn__enc" = CASE WHEN "mrn" IS NULL THEN NULL ELSE pgp_sym_encrypt("mrn"::text, ${KEY_REF}) END;`,
    );
  });

  it("re-applies the classification + encrypt directive comment", () => {
    expect(sql[4]).toBe(
      `COMMENT ON COLUMN "t_clinic"."patient"."mrn" IS 'crossengin.data_class=phi; crossengin.encrypt=at_rest';`,
    );
  });

  it("never inlines the key (only a reference)", () => {
    for (const s of sql) expect(s).not.toMatch(/pgp_sym_encrypt\([^,]*,\s*'/);
  });

  it("honours a custom plaintext cast", () => {
    const s = emitEncryptColumnSql({
      schema: "s",
      table: "t",
      column: "dob",
      keyRef: KEY_REF,
      plaintextCast: "::text",
    });
    expect(s[1]).toContain(`pgp_sym_encrypt("dob"::text, ${KEY_REF})`);
  });
});

describe("emitDecryptingViewSql", () => {
  it("decrypts the encrypted columns and passes the rest through", () => {
    const view = emitDecryptingViewSql({
      schema: "t_clinic",
      table: "patient",
      viewName: "patient_decrypted",
      columns: ["id", "mrn", "status"],
      encryptedColumns: ["mrn"],
      keyRef: KEY_REF,
    });
    expect(view).toBe(
      `CREATE OR REPLACE VIEW "t_clinic"."patient_decrypted" AS SELECT "id", pgp_sym_decrypt("mrn", ${KEY_REF}) AS "mrn", "status" FROM "t_clinic"."patient";`,
    );
  });
});

describe("planColumnEncryption", () => {
  it("builds a plan from an introspected column", () => {
    const plan = planColumnEncryption(
      { schema: "s", table: "t", column: "c", dataType: "text", dataClass: "phi", encryptedStorage: false },
      KEY_REF,
    );
    expect(plan).toMatchObject({ schema: "s", table: "t", column: "c", dataClass: "phi" });
    expect(plan.statements).toHaveLength(5);
  });
});

describe("formatEncryptionPlan", () => {
  it("renders a no-op message when nothing needs migrating", () => {
    expect(formatEncryptionPlan([])).toContain("nothing to migrate");
  });

  it("lists each column header + its statements", () => {
    const plan = planColumnEncryption(
      { schema: "t", table: "patient", column: "mrn", dataType: "text", dataClass: "phi", encryptedStorage: false },
      KEY_REF,
    );
    const out = formatEncryptionPlan([plan]);
    expect(out).toContain("1 column(s) to encrypt in place");
    expect(out).toContain("-- patient.mrn (phi)");
    expect(out).toContain("ALTER TABLE");
  });
});

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
  /** Whether the statement was issued on a `transaction()` handle rather than the bare connection. */
  readonly inTransaction: boolean;
}

function mockConn(
  rows: EncryptedColumnRow[],
  observed: string[],
  recorded: Recorded[] = [],
): PgConnection {
  let depth = 0;
  const conn: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      observed.push(sql);
      recorded.push({ sql, params, inTransaction: depth > 0 });
      if (sql.includes("col_description")) {
        return { rows, rowCount: rows.length } satisfies PgQueryResult<EncryptedColumnRow>;
      }
      return { rows: [], rowCount: 0 } satisfies PgQueryResult<EncryptedColumnRow>;
    }) as PgConnection["query"],
    transaction: vi.fn(async <T,>(fn: (tx: PgConnection) => Promise<T>) => {
      depth += 1;
      try {
        return await fn(conn);
      } finally {
        depth -= 1;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
}

describe("EncryptionMigrator", () => {
  const plaintextRow: EncryptedColumnRow = {
    schema: "t_clinic",
    table_name: "patient",
    column_name: "mrn",
    data_type: "text",
    comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
  };
  const ciphertextRow: EncryptedColumnRow = {
    schema: "t_clinic",
    table_name: "observation",
    column_name: "value_text",
    data_type: "bytea",
    comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
  };

  it("plans only the plaintext (non-bytea) hinted columns", async () => {
    const observed: string[] = [];
    const migrator = new EncryptionMigrator(mockConn([plaintextRow, ciphertextRow], observed));
    const plans = await migrator.planSchema("t_clinic", KEY_REF);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.column).toBe("mrn");
  });

  it("executes each plan's statements inside a transaction", async () => {
    const observed: string[] = [];
    const migrator = new EncryptionMigrator(mockConn([plaintextRow], observed));
    await migrator.migrateSchema("t_clinic", KEY_REF);
    expect(observed.some((s) => s.startsWith("ALTER TABLE"))).toBe(true);
    expect(observed.some((s) => s.startsWith("UPDATE"))).toBe(true);
    expect(observed.some((s) => s.startsWith("COMMENT ON COLUMN"))).toBe(true);
  });

  it("is a no-op when every hinted column is already ciphertext", async () => {
    const observed: string[] = [];
    const migrator = new EncryptionMigrator(mockConn([ciphertextRow], observed));
    const plans = await migrator.migrateSchema("t_clinic", KEY_REF);
    expect(plans).toEqual([]);
    expect(observed.some((s) => s.startsWith("ALTER TABLE"))).toBe(false);
  });

  it("takes no options argument — three call sites use the one-argument form", async () => {
    const observed: string[] = [];
    const migrator = new EncryptionMigrator(mockConn([plaintextRow], observed));
    await expect(migrator.migrateSchema("t_clinic", KEY_REF)).resolves.toHaveLength(1);
    expect(observed.some((s) => s.includes("set_config"))).toBe(false);
  });
});

describe("EncryptionMigrator session settings", () => {
  const plaintextRow: EncryptedColumnRow = {
    schema: "t_clinic",
    table_name: "patient",
    column_name: "mrn",
    data_type: "text",
    comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
  };

  function run(): Promise<{ recorded: Recorded[] }> {
    const observed: string[] = [];
    const recorded: Recorded[] = [];
    const migrator = new EncryptionMigrator(mockConn([plaintextRow], observed, recorded), {
      sessionSettings: new Map([["app.column_encryption_key", "s3cret"]]),
    });
    return migrator.migrateSchema("t_clinic", KEY_REF).then(() => ({ recorded }));
  }

  it("issues set_config with the name and value both bound, never interpolated", async () => {
    const { recorded } = await run();
    const setConfig = recorded.filter((r) => r.sql.includes("set_config"));
    expect(setConfig).toHaveLength(1);
    expect(setConfig[0]?.sql).toBe(`SELECT set_config($1, $2, true)`);
    expect(setConfig[0]?.params).toEqual(["app.column_encryption_key", "s3cret"]);
  });

  it("issues it inside the transaction", async () => {
    // `set_config(…, is_local => true)` is transaction-local, so a setting claimed outside is
    // discarded with the implicit single-statement transaction before the statement it was set for.
    const { recorded } = await run();
    const setConfig = recorded.find((r) => r.sql.includes("set_config"));
    expect(setConfig?.inTransaction).toBe(true);
  });

  it("issues it before the plan's statements", async () => {
    const { recorded } = await run();
    const inTx = recorded.filter((r) => r.inTransaction).map((r) => r.sql);
    expect(inTx[0]).toContain("set_config");
    expect(inTx[1]).toMatch(/^ALTER TABLE/);
    expect(inTx).toHaveLength(6); // one set_config + the five conversion statements
  });

  it("puts the key value in no SQL text", async () => {
    const { recorded } = await run();
    for (const r of recorded) expect(r.sql).not.toContain("s3cret");
  });
});
