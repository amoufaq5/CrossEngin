import { describe, expect, it, vi } from "vitest";
import type { PgConnection } from "./connection.js";
import {
  COLUMN_ENCRYPTION_KEY_ENV,
  COLUMN_ENCRYPTION_KEY_GUC,
  COLUMN_KEY_REFUSAL_REASONS,
  DEFAULT_COLUMN_KEY_REF,
  EncryptionApplier,
  ENCRYPTED_COLUMN_QUERY,
  columnKeyRefFor,
  ensurePgcryptoExtension,
  formatEncryptionCoverage,
  introspectEncryptedColumns,
  isRaisingKeyRef,
  parseColumnDirectives,
  pgcryptoInstalled,
  pgpSymDecryptExpr,
  pgpSymEncryptExpr,
  pgpSymEncryptLiteral,
  resolveColumnEncryptionKey,
  summarizeEncryptionCoverage,
  type EncryptedColumn,
  type EncryptedColumnRow,
} from "./encryption.js";

function mockConn(
  handler: (sql: string, params?: readonly unknown[]) => { rows: readonly unknown[]; rowCount: number },
): PgConnection {
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

describe("column key ref vocabulary", () => {
  it("pins the GUC name the whole stack agrees on", () => {
    expect(COLUMN_ENCRYPTION_KEY_GUC).toBe("app.column_encryption_key");
    expect(COLUMN_ENCRYPTION_KEY_ENV).toBe("COLUMN_ENCRYPTION_KEY");
  });

  it("derives the default ref from the GUC rather than restating it", () => {
    expect(DEFAULT_COLUMN_KEY_REF).toBe(`current_setting('app.column_encryption_key')`);
    expect(DEFAULT_COLUMN_KEY_REF).toBe(columnKeyRefFor(COLUMN_ENCRYPTION_KEY_GUC));
  });

  it("builds a ref for any valid GUC name", () => {
    expect(columnKeyRefFor("app.other_key")).toBe(`current_setting('app.other_key')`);
    expect(columnKeyRefFor("_x._y0")).toBe(`current_setting('_x._y0')`);
  });

  it("emits only the one-argument (raising) form", () => {
    // The two-argument form is what the house GUC idiom uses for tenant isolation and is exactly
    // wrong here; see `isRaisingKeyRef`'s measurements.
    expect(columnKeyRefFor("app.k")).not.toContain(",");
  });

  it("throws on anything that is not a GUC name — the value is interpolated raw", () => {
    expect(() => columnKeyRefFor("'; DROP TABLE patient; --")).toThrow(/not a GUC name/);
    expect(() => columnKeyRefFor("barename")).toThrow(/not a GUC name/);
    expect(() => columnKeyRefFor("")).toThrow(/not a GUC name/);
    expect(() => columnKeyRefFor("App.Key")).toThrow(/not a GUC name/);
    expect(() => columnKeyRefFor("app.key.extra")).toThrow(/not a GUC name/);
    expect(() => columnKeyRefFor("app. key")).toThrow(/not a GUC name/);
    expect(() => columnKeyRefFor("9app.key")).toThrow(/not a GUC name/);
  });
});

describe("isRaisingKeyRef", () => {
  it("is true for the single-argument current_setting form", () => {
    expect(isRaisingKeyRef(DEFAULT_COLUMN_KEY_REF)).toBe(true);
    expect(isRaisingKeyRef(`current_setting( 'app.k' )`)).toBe(true);
    expect(isRaisingKeyRef(`  current_setting('app.k')  `)).toBe(true);
  });

  it("is false for the two-argument form", () => {
    // Measured on PG 16: current_setting('app.foo', true) unset returns NULL (and '' once used and
    // reset on that connection), and pgp_sym_encrypt(x, NULL) returns NULL *silently* — so the
    // two-argument form turns a missing key into a PHI column storing NULL, reported as success.
    // The one-argument form raises `unrecognized configuration parameter` instead, and
    // pgp_sym_encrypt(x, '') raises `Illegal argument to function`.
    expect(isRaisingKeyRef(`current_setting('app.column_encryption_key', true)`)).toBe(false);
    expect(isRaisingKeyRef(`current_setting('app.k',true)`)).toBe(false);
    expect(isRaisingKeyRef(`current_setting('app.k', false)`)).toBe(false);
    expect(isRaisingKeyRef(`NULLIF(current_setting('app.k', true), '')`)).toBe(false);
  });

  it("is false for anything else, including a bind parameter", () => {
    // Not a judgement that `$1` is malformed — it answers "cannot be shown to raise", and `$1`
    // bound to null is the silent-NULL path one layer out.
    expect(isRaisingKeyRef("$1")).toBe(false);
    expect(isRaisingKeyRef("'literal-key'")).toBe(false);
    expect(isRaisingKeyRef("")).toBe(false);
  });
});

describe("resolveColumnEncryptionKey", () => {
  it("claims the GUC from the environment with the default ref", () => {
    const resolved = resolveColumnEncryptionKey(DEFAULT_COLUMN_KEY_REF, {
      COLUMN_ENCRYPTION_KEY: "s3cret",
    });
    expect(resolved.refusal).toBeNull();
    expect([...resolved.sessionSettings]).toEqual([["app.column_encryption_key", "s3cret"]]);
  });

  it("refuses the default ref when the environment variable is absent", () => {
    const resolved = resolveColumnEncryptionKey(DEFAULT_COLUMN_KEY_REF, {});
    expect(resolved.refusal?.reason).toBe("key_value_absent");
    expect(resolved.refusal?.message).toContain("COLUMN_ENCRYPTION_KEY is not set");
    expect(resolved.refusal?.message).toContain("unrecognized configuration parameter");
    expect(resolved.sessionSettings.size).toBe(0);
  });

  it("refuses an empty variable too — pgp_sym_encrypt(x, '') raises", () => {
    const resolved = resolveColumnEncryptionKey(DEFAULT_COLUMN_KEY_REF, {
      COLUMN_ENCRYPTION_KEY: "",
    });
    expect(resolved.refusal?.reason).toBe("key_value_absent");
  });

  it("requires nothing when the deployment names its own raising ref", () => {
    const resolved = resolveColumnEncryptionKey(`current_setting('app.other_key')`, {});
    expect(resolved.refusal).toBeNull();
    expect(resolved.sessionSettings.size).toBe(0);
  });

  it("refuses a caller-supplied ref that can yield NULL", () => {
    const resolved = resolveColumnEncryptionKey(`current_setting('app.other_key', true)`, {
      COLUMN_ENCRYPTION_KEY: "s3cret",
    });
    expect(resolved.refusal?.reason).toBe("key_ref_can_yield_null");
    expect(resolved.refusal?.message).toContain("store NULL");
  });

  it("never puts the key value in the refusal message", () => {
    const resolved = resolveColumnEncryptionKey(`current_setting('app.k', true)`, {
      COLUMN_ENCRYPTION_KEY: "s3cret",
    });
    expect(resolved.refusal?.message).not.toContain("s3cret");
  });

  it("has a refusal reason enum with no duplicates", () => {
    expect(new Set(COLUMN_KEY_REFUSAL_REASONS).size).toBe(COLUMN_KEY_REFUSAL_REASONS.length);
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
