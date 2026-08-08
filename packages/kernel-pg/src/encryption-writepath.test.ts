import { describe, expect, it, vi } from "vitest";
import type { PgConnection, PgQueryResult } from "./connection.js";
import type { EncryptedColumnRow } from "./encryption.js";
import {
  KeyRotationMigrator,
  emitEncryptingViewTriggersSql,
  formatKeyRotationPlan,
  planColumnKeyRotation,
  reencryptColumnSql,
} from "./encryption-writepath.js";

const OLD_KEY = "current_setting('app.column_encryption_key_old')";
const NEW_KEY = "current_setting('app.column_encryption_key')";

describe("reencryptColumnSql", () => {
  const sql = reencryptColumnSql({
    schema: "t_clinic",
    table: "patient",
    column: "mrn",
    oldKeyRef: OLD_KEY,
    newKeyRef: NEW_KEY,
  });

  it("decrypts with the old key and re-encrypts with the new key", () => {
    expect(sql).toBe(
      `UPDATE "t_clinic"."patient" SET "mrn" = pgp_sym_encrypt(pgp_sym_decrypt("mrn", ${OLD_KEY}), ${NEW_KEY}) WHERE "mrn" IS NOT NULL;`,
    );
  });

  it("skips NULLs via the WHERE guard", () => {
    expect(sql).toContain(`WHERE "mrn" IS NOT NULL`);
  });

  it("never inlines either key (only references)", () => {
    expect(sql).not.toMatch(/pgp_sym_(en|de)crypt\([^)]*,\s*'/);
  });
});

describe("planColumnKeyRotation + formatKeyRotationPlan", () => {
  it("builds a plan from an introspected ciphertext column", () => {
    const plan = planColumnKeyRotation(
      { schema: "s", table: "t", column: "c", dataType: "bytea", dataClass: "phi", encryptedStorage: true },
      OLD_KEY,
      NEW_KEY,
    );
    expect(plan).toMatchObject({ schema: "s", table: "t", column: "c", dataClass: "phi" });
    expect(plan.statement).toContain("pgp_sym_encrypt(pgp_sym_decrypt");
  });

  it("renders a no-op message when there is nothing to rotate", () => {
    expect(formatKeyRotationPlan([])).toContain("nothing to rotate");
  });

  it("lists each column header + its statement", () => {
    const plan = planColumnKeyRotation(
      { schema: "t", table: "patient", column: "mrn", dataType: "bytea", dataClass: "phi", encryptedStorage: true },
      OLD_KEY,
      NEW_KEY,
    );
    const out = formatKeyRotationPlan([plan]);
    expect(out).toContain("1 column(s) to re-encrypt");
    expect(out).toContain("-- patient.mrn (phi)");
    expect(out).toContain("UPDATE");
  });
});

describe("emitEncryptingViewTriggersSql", () => {
  const sql = emitEncryptingViewTriggersSql({
    schema: "t_clinic",
    table: "patient",
    viewName: "patient_decrypted",
    columns: ["tenant_id", "id", "mrn", "status"],
    encryptedColumns: ["mrn"],
    keyColumns: ["tenant_id", "id"],
    keyRef: NEW_KEY,
  });

  it("drops the trigger, (re)creates the function, then creates the trigger", () => {
    expect(sql).toHaveLength(3);
    expect(sql[0]).toBe(
      `DROP TRIGGER IF EXISTS "patient_decrypted_encrypt" ON "t_clinic"."patient_decrypted";`,
    );
    expect(sql[1]).toContain(
      `CREATE OR REPLACE FUNCTION "t_clinic"."patient_decrypted_encrypt_tg"() RETURNS trigger`,
    );
    expect(sql[2]).toBe(
      `CREATE TRIGGER "patient_decrypted_encrypt" INSTEAD OF INSERT OR UPDATE OR DELETE ON "t_clinic"."patient_decrypted" FOR EACH ROW EXECUTE FUNCTION "t_clinic"."patient_decrypted_encrypt_tg"();`,
    );
  });

  it("encrypts the encrypted column on INSERT and passes plaintext columns through", () => {
    const fn = sql[1]!;
    expect(fn).toContain(
      `INSERT INTO "t_clinic"."patient" ("tenant_id", "id", "mrn", "status") VALUES (NEW."tenant_id", NEW."id", CASE WHEN NEW."mrn" IS NULL THEN NULL ELSE pgp_sym_encrypt(NEW."mrn"::text, ${NEW_KEY}) END, NEW."status");`,
    );
  });

  it("encrypts on UPDATE and matches the row by its key columns", () => {
    const fn = sql[1]!;
    expect(fn).toContain(`"mrn" = CASE WHEN NEW."mrn" IS NULL THEN NULL ELSE pgp_sym_encrypt(NEW."mrn"::text, ${NEW_KEY}) END`);
    expect(fn).toContain(`WHERE "tenant_id" = OLD."tenant_id" AND "id" = OLD."id"`);
  });

  it("passes DELETE through to the base table by key columns", () => {
    const fn = sql[1]!;
    expect(fn).toContain(
      `DELETE FROM "t_clinic"."patient" WHERE "tenant_id" = OLD."tenant_id" AND "id" = OLD."id";`,
    );
  });

  it("never inlines the key", () => {
    for (const s of sql) expect(s).not.toMatch(/pgp_sym_encrypt\([^,]*,\s*'/);
  });

  it("throws when keyColumns is empty", () => {
    expect(() =>
      emitEncryptingViewTriggersSql({
        schema: "s",
        table: "t",
        viewName: "v",
        columns: ["id"],
        encryptedColumns: [],
        keyColumns: [],
        keyRef: NEW_KEY,
      }),
    ).toThrow(/keyColumns/);
  });
});

function mockConn(rows: EncryptedColumnRow[], observed: string[]): PgConnection {
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

describe("KeyRotationMigrator", () => {
  const ciphertextRow: EncryptedColumnRow = {
    schema: "t_clinic",
    table_name: "patient",
    column_name: "mrn",
    data_type: "bytea",
    comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
  };
  const plaintextRow: EncryptedColumnRow = {
    schema: "t_clinic",
    table_name: "note",
    column_name: "body",
    data_type: "text",
    comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
  };

  it("plans only the ciphertext (bytea) hinted columns", async () => {
    const observed: string[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow, plaintextRow], observed));
    const plans = await migrator.planSchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.column).toBe("mrn");
  });

  it("executes each re-encryption inside a transaction", async () => {
    const observed: string[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow], observed));
    const plans = await migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(plans).toHaveLength(1);
    expect(observed.some((s) => s.startsWith("UPDATE") && s.includes("pgp_sym_encrypt(pgp_sym_decrypt"))).toBe(true);
  });

  it("is a no-op when there are no ciphertext columns", async () => {
    const observed: string[] = [];
    const migrator = new KeyRotationMigrator(mockConn([plaintextRow], observed));
    const plans = await migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(plans).toEqual([]);
    expect(observed.some((s) => s.startsWith("UPDATE"))).toBe(false);
  });
});
