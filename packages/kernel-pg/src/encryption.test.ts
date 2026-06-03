import { describe, expect, it, vi } from "vitest";
import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  EncryptionApplier,
  ENCRYPTED_COLUMN_QUERY,
  ensurePgcryptoExtension,
  formatEncryptionCoverage,
  introspectEncryptedColumns,
  parseColumnDirectives,
  pgcryptoInstalled,
  pgpSymDecryptExpr,
  pgpSymEncryptExpr,
  pgpSymEncryptLiteral,
  summarizeEncryptionCoverage,
  type EncryptedColumn,
  type EncryptedColumnRow,
} from "./encryption.js";

function mockConn(handler: (sql: string, params?: readonly unknown[]) => PgQueryResult): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => handler(sql, params)) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

describe("parseColumnDirectives", () => {
  it("parses data_class + encrypt directives", () => {
    expect(parseColumnDirectives("crossengin.data_class=phi; crossengin.encrypt=at_rest")).toEqual({
      dataClass: "phi",
      encryptAtRest: true,
    });
  });

  it("parses a data_class-only comment (no encryption)", () => {
    expect(parseColumnDirectives("crossengin.data_class=pii")).toEqual({
      dataClass: "pii",
      encryptAtRest: false,
    });
  });

  it("is empty for null / empty / non-directive comments", () => {
    expect(parseColumnDirectives(null)).toEqual({ dataClass: null, encryptAtRest: false });
    expect(parseColumnDirectives("")).toEqual({ dataClass: null, encryptAtRest: false });
    expect(parseColumnDirectives("just a human comment")).toEqual({
      dataClass: null,
      encryptAtRest: false,
    });
  });
});

describe("introspectEncryptedColumns", () => {
  const rows: EncryptedColumnRow[] = [
    {
      schema: "t_clinic",
      table_name: "patient",
      column_name: "mrn",
      data_type: "text",
      comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
    },
    {
      schema: "t_clinic",
      table_name: "observation",
      column_name: "value_text",
      data_type: "bytea",
      comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
    },
  ];

  it("queries col_description and maps rows, flagging ciphertext storage", async () => {
    let observed = "";
    const conn = mockConn((sql) => {
      observed = sql;
      return { rows, rowCount: rows.length };
    });
    const cols = await introspectEncryptedColumns(conn, "t_clinic");
    expect(observed).toBe(ENCRYPTED_COLUMN_QUERY);
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({ table: "patient", column: "mrn", encryptedStorage: false });
    expect(cols[1]).toMatchObject({ table: "observation", encryptedStorage: true });
  });
});

describe("pgcrypto provisioning", () => {
  it("detects the installed extension", async () => {
    const conn = mockConn(() => ({ rows: [{ installed: true }], rowCount: 1 }));
    expect(await pgcryptoInstalled(conn)).toBe(true);
  });

  it("reports a missing extension", async () => {
    const conn = mockConn(() => ({ rows: [{ installed: false }], rowCount: 1 }));
    expect(await pgcryptoInstalled(conn)).toBe(false);
  });

  it("issues CREATE EXTENSION IF NOT EXISTS pgcrypto", async () => {
    let observed = "";
    const conn = mockConn((sql) => {
      observed = sql;
      return { rows: [], rowCount: 0 };
    });
    await ensurePgcryptoExtension(conn);
    expect(observed).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  });
});

describe("pgcrypto expression builders", () => {
  it("builds symmetric encrypt/decrypt expressions with a key reference", () => {
    expect(pgpSymEncryptExpr(`"mrn"`, "$1")).toBe(`pgp_sym_encrypt("mrn", $1)`);
    expect(pgpSymDecryptExpr(`"mrn"`, "$1")).toBe(`pgp_sym_decrypt("mrn", $1)`);
  });

  it("escapes a plaintext literal", () => {
    expect(pgpSymEncryptLiteral("O'Hara", "$1")).toBe(`pgp_sym_encrypt('O''Hara', $1)`);
  });
});

describe("summarizeEncryptionCoverage", () => {
  const columns: EncryptedColumn[] = [
    { schema: "t", table: "patient", column: "mrn", dataType: "text", dataClass: "phi", encryptedStorage: false },
    { schema: "t", table: "observation", column: "value_text", dataType: "bytea", dataClass: "phi", encryptedStorage: true },
  ];

  it("flags plaintext-at-rest columns as drift", () => {
    const report = summarizeEncryptionCoverage("t", columns, true);
    expect(report.total).toBe(2);
    expect(report.ciphertextStored).toBe(1);
    expect(report.plaintext).toBe(1);
    expect(report.issues.map((i) => i.kind)).toEqual(["plaintext_at_rest"]);
    expect(report.issues[0]?.column).toBe("mrn");
  });

  it("flags a missing pgcrypto extension when columns need it", () => {
    const report = summarizeEncryptionCoverage("t", columns, false);
    expect(report.issues.map((i) => i.kind)).toContain("pgcrypto_missing");
  });

  it("is clean when all columns are ciphertext + pgcrypto installed", () => {
    const allEncrypted = columns.map((c) => ({ ...c, dataType: "bytea", encryptedStorage: true }));
    const report = summarizeEncryptionCoverage("t", allEncrypted, true);
    expect(report.issues).toEqual([]);
  });

  it("has no pgcrypto_missing issue when there are no encrypted columns", () => {
    const report = summarizeEncryptionCoverage("t", [], false);
    expect(report.issues).toEqual([]);
  });
});

describe("formatEncryptionCoverage", () => {
  const columns: EncryptedColumn[] = [
    { schema: "t", table: "patient", column: "mrn", dataType: "text", dataClass: "phi", encryptedStorage: false },
  ];

  it("renders coverage counts + drift issues", () => {
    const out = formatEncryptionCoverage(summarizeEncryptionCoverage("t", columns, false));
    expect(out).toContain('Encryption coverage for schema "t": 1 column(s)');
    expect(out).toContain("pgcrypto installed: no");
    expect(out).toContain("[plaintext_at_rest]");
    expect(out).toContain("[pgcrypto_missing]");
  });

  it("renders an OK line when fully covered", () => {
    const encrypted = columns.map((c) => ({ ...c, dataType: "bytea", encryptedStorage: true }));
    const out = formatEncryptionCoverage(summarizeEncryptionCoverage("t", encrypted, true));
    expect(out).toContain("OK — every hinted column is encrypted at rest.");
  });

  it("notes when no columns are hinted", () => {
    const out = formatEncryptionCoverage(summarizeEncryptionCoverage("t", [], true));
    expect(out).toContain("no columns hinted for at-rest encryption.");
  });
});

describe("EncryptionApplier", () => {
  it("reports coverage by introspecting + checking the extension", async () => {
    const conn = mockConn((sql) => {
      if (sql.includes("pg_extension")) return { rows: [{ installed: false }], rowCount: 1 };
      if (sql.includes("col_description")) {
        return {
          rows: [
            {
              schema: "t_clinic",
              table_name: "patient",
              column_name: "mrn",
              data_type: "text",
              comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const report = await new EncryptionApplier(conn).coverage("t_clinic");
    expect(report.total).toBe(1);
    expect(report.pgcryptoInstalled).toBe(false);
    expect(report.issues.map((i) => i.kind).sort()).toEqual(["pgcrypto_missing", "plaintext_at_rest"]);
  });
});
