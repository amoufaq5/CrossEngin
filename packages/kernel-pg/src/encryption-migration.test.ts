import { describe, expect, it, vi } from "vitest";
import type { PgConnection, PgQueryResult } from "./connection.js";
import type { EncryptedColumnRow } from "./encryption.js";
import {
  EncryptionMigrator,
  emitDecryptingViewSql,
  emitEncryptColumnSql,
  planColumnEncryption,
} from "./encryption-migration.js";

const KEY_REF = "current_setting('app.column_encryption_key')";

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

function mockConn(
  rows: EncryptedColumnRow[],
  observed: string[],
): PgConnection {
  const conn: PgConnection = {
    query: vi.fn(async (sql: string) => {
      observed.push(sql);
      if (sql.includes("col_description")) {
        return { rows, rowCount: rows.length } as PgQueryResult;
      }
      return { rows: [], rowCount: 0 } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: vi.fn(async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
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
});
