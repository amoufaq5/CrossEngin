import { describe, expect, it, vi } from "vitest";
import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  DEFAULT_COLUMN_KEY_REF,
  OLD_COLUMN_KEY_REF,
  type EncryptedColumnRow,
} from "./encryption.js";
import {
  KEY_ROTATION_REFUSAL_REASONS,
  KeyRotationMigrator,
  TENANT_SCOPE_COLUMN,
  confirmColumnKeySql,
  emitEncryptingViewTriggersSql,
  formatKeyRotationPlan,
  formatKeyRotationSurvey,
  planColumnKeyRotation,
  reencryptColumnSql,
  type KeyRotationPlan,
  type ReencryptScope,
} from "./encryption-writepath.js";

const OLD_KEY = OLD_COLUMN_KEY_REF;
const NEW_KEY = DEFAULT_COLUMN_KEY_REF;

const TENANT = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const EVERY_ROW: ReencryptScope = { kind: "every_row", because: "a KEK rotation, not a data key" };
const TENANT_SCOPE: ReencryptScope = {
  kind: "tenant",
  column: TENANT_SCOPE_COLUMN,
  tenantId: TENANT,
};

const CIPHERTEXT_COLUMN = {
  schema: "t_clinic",
  table: "patient",
  column: "mrn",
  dataType: "bytea",
  dataClass: "phi",
  encryptedStorage: true,
} as const;

describe("reencryptColumnSql", () => {
  const unscoped = reencryptColumnSql({
    schema: "t_clinic",
    table: "patient",
    column: "mrn",
    oldKeyRef: OLD_KEY,
    newKeyRef: NEW_KEY,
    scope: EVERY_ROW,
  });

  it("decrypts with the old key and re-encrypts with the new key", () => {
    expect(unscoped.sql).toBe(
      `UPDATE "t_clinic"."patient" SET "mrn" = pgp_sym_encrypt(pgp_sym_decrypt("mrn", ${OLD_KEY}), ${NEW_KEY}) WHERE "mrn" IS NOT NULL;`,
    );
  });

  it("skips NULLs via the WHERE guard", () => {
    expect(unscoped.sql).toContain(`WHERE "mrn" IS NOT NULL`);
  });

  it("never inlines either key (only references)", () => {
    expect(unscoped.sql).not.toMatch(/pgp_sym_(en|de)crypt\([^)]*,\s*'/);
  });

  it("binds nothing for an every_row scope", () => {
    expect(unscoped.params).toEqual([]);
  });

  it("adds the tenant predicate and binds the id as $1", () => {
    const scoped = reencryptColumnSql({
      schema: "public",
      table: "patient",
      column: "mrn",
      oldKeyRef: OLD_KEY,
      newKeyRef: NEW_KEY,
      scope: TENANT_SCOPE,
    });
    expect(scoped.sql).toContain(`WHERE "mrn" IS NOT NULL AND "tenant_id" = $1`);
    expect(scoped.params).toEqual([TENANT]);
  });

  it("keeps the tenant id out of the SQL text entirely", () => {
    const scoped = reencryptColumnSql({
      schema: "public",
      table: "patient",
      column: "mrn",
      oldKeyRef: OLD_KEY,
      newKeyRef: NEW_KEY,
      scope: TENANT_SCOPE,
    });
    expect(scoped.sql).not.toContain(TENANT);
  });

  it("honours a scope column other than the default", () => {
    const scoped = reencryptColumnSql({
      schema: "public",
      table: "patient",
      column: "mrn",
      oldKeyRef: OLD_KEY,
      newKeyRef: NEW_KEY,
      scope: { kind: "tenant", column: "owner_tenant", tenantId: TENANT },
    });
    expect(scoped.sql).toContain(`AND "owner_tenant" = $1`);
  });

  it("throws when every_row carries no reason", () => {
    expect(() =>
      reencryptColumnSql({
        schema: "s",
        table: "t",
        column: "c",
        oldKeyRef: OLD_KEY,
        newKeyRef: NEW_KEY,
        scope: { kind: "every_row", because: "" },
      }),
    ).toThrow(/non-empty `because`/);
  });

  it("throws when every_row's reason is only whitespace", () => {
    expect(() =>
      reencryptColumnSql({
        schema: "s",
        table: "t",
        column: "c",
        oldKeyRef: OLD_KEY,
        newKeyRef: NEW_KEY,
        scope: { kind: "every_row", because: "   " },
      }),
    ).toThrow(/non-empty `because`/);
  });

  it("throws on a tenant id that could never be one", () => {
    expect(() =>
      reencryptColumnSql({
        schema: "s",
        table: "t",
        column: "c",
        oldKeyRef: OLD_KEY,
        newKeyRef: NEW_KEY,
        scope: { kind: "tenant", column: TENANT_SCOPE_COLUMN, tenantId: "all" },
      }),
    ).toThrow(/invalid tenantId/);
  });
});

describe("confirmColumnKeySql", () => {
  const confirm = confirmColumnKeySql({
    schema: "public",
    table: "patient",
    column: "mrn",
    keyRef: NEW_KEY,
    scope: TENANT_SCOPE,
  });

  it("counts the rows that decrypt under the given key", () => {
    expect(confirm.sql).toBe(
      `SELECT count(pgp_sym_decrypt("mrn", ${NEW_KEY})) AS readable FROM "public"."patient" WHERE "mrn" IS NOT NULL AND "tenant_id" = $1;`,
    );
  });

  it("carries the same WHERE and the same bound parameter as the rotation", () => {
    const rotation = reencryptColumnSql({
      schema: "public",
      table: "patient",
      column: "mrn",
      oldKeyRef: OLD_KEY,
      newKeyRef: NEW_KEY,
      scope: TENANT_SCOPE,
    });
    const where = (sql: string): string => sql.slice(sql.indexOf("WHERE"));
    expect(where(confirm.sql)).toBe(where(rotation.sql));
    expect(confirm.params).toEqual(rotation.params);
  });

  it("names only the new key, never the old one", () => {
    expect(confirm.sql).toContain(NEW_KEY);
    expect(confirm.sql).not.toContain(OLD_KEY);
  });

  it("throws when every_row carries no reason", () => {
    expect(() =>
      confirmColumnKeySql({
        schema: "s",
        table: "t",
        column: "c",
        keyRef: NEW_KEY,
        scope: { kind: "every_row", because: "" },
      }),
    ).toThrow(/non-empty `because`/);
  });
});

describe("planColumnKeyRotation + formatKeyRotationPlan", () => {
  it("builds a plan from an introspected ciphertext column", () => {
    const plan = planColumnKeyRotation(
      { schema: "s", table: "t", column: "c", dataType: "bytea", dataClass: "phi", encryptedStorage: true },
      OLD_KEY,
      NEW_KEY,
      EVERY_ROW,
    );
    expect(plan).toMatchObject({ schema: "s", table: "t", column: "c", dataClass: "phi" });
    expect(plan.statement.sql).toContain("pgp_sym_encrypt(pgp_sym_decrypt");
    expect(plan.confirm.sql).toContain("AS readable");
  });

  it("answers rowsToRewrite as null, because the pure planner counted nothing", () => {
    const plan = planColumnKeyRotation(CIPHERTEXT_COLUMN, OLD_KEY, NEW_KEY, TENANT_SCOPE);
    // `null` is "not counted", never 0 — 0 is also what a confined session sees.
    expect(plan.rowsToRewrite).toBeNull();
  });

  it("renders a no-op message when there is nothing to rotate", () => {
    expect(formatKeyRotationPlan([])).toContain("No ciphertext (BYTEA) columns");
  });

  it("lists each column header + its statement", () => {
    const plan = planColumnKeyRotation(
      { schema: "t", table: "patient", column: "mrn", dataType: "bytea", dataClass: "phi", encryptedStorage: true },
      OLD_KEY,
      NEW_KEY,
      EVERY_ROW,
    );
    const out = formatKeyRotationPlan([plan]);
    expect(out).toContain("1 column(s) to re-encrypt");
    expect(out).toContain("-- patient.mrn (phi)");
    expect(out).toContain("UPDATE");
  });

  it("prints the row count on the comment line once one has been counted", () => {
    const plan = planColumnKeyRotation(CIPHERTEXT_COLUMN, OLD_KEY, NEW_KEY, TENANT_SCOPE);
    const counted: KeyRotationPlan = { ...plan, rowsToRewrite: 42 };
    expect(formatKeyRotationPlan([counted])).toContain("-- patient.mrn (phi) — 42 row(s)");
  });

  it("prints no count when nobody counted", () => {
    const plan = planColumnKeyRotation(CIPHERTEXT_COLUMN, OLD_KEY, NEW_KEY, TENANT_SCOPE);
    expect(formatKeyRotationPlan([plan])).toContain("-- patient.mrn (phi)\n");
    expect(formatKeyRotationPlan([plan])).not.toContain("row(s)\n");
  });
});

describe("KEY_ROTATION_REFUSAL_REASONS", () => {
  it("names every way a rotation would report itself complete having skipped ciphertext", () => {
    expect(KEY_ROTATION_REFUSAL_REASONS).toEqual([
      "rls_would_confine_this_session",
      "keys_are_the_same",
      "table_missing",
      "tenant_column_missing",
      "partitioned_table_unreachable",
    ]);
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

interface VisibilityRow {
  readonly role: string;
  readonly bypasses_rls: boolean;
  readonly is_owner: boolean;
  readonly rls_enabled: boolean;
  readonly has_scope_column: boolean;
}

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface MockOpts {
  readonly owner?: boolean;
  readonly tableExists?: boolean;
  readonly updatedRows?: number;
  /** Absent means "the table has no tenant_id column", which is `tenant_column_missing`. */
  readonly hasScopeColumn?: boolean;
  /** Partitioned parents the probe finds, as `{table_name, comment}` rows. */
  readonly partitioned?: readonly EncryptedColumnRow[];
  /** What the confirm pass counts back; defaults to `updatedRows` so a clean run agrees. */
  readonly readable?: number;
  readonly rowsToRewrite?: number;
}

/**
 * The owner-bypass default is deliberate and is the opposite of the fake this replaced.
 *
 * That one was a pure recorder answering `{rows: [], rowCount: 0}` to every statement, which is the
 * ADR-0334 class exactly: it answered the catalog probe as "table does not exist" and answered the
 * `UPDATE` as "0 rows rewritten", and the test asserted on neither. `owner: false` is what a real
 * non-owner deployment looks like, and the refusal test uses it.
 *
 * Both counts come back as **strings**, because `count()` is BIGINT and that is what node-postgres
 * hands over (ADR-0331). A fake answering numbers here would make `readCount`'s whole reason for
 * existing untested.
 */
function mockConn(
  rows: EncryptedColumnRow[],
  observed: Recorded[],
  opts: MockOpts = {},
): PgConnection {
  const owner = opts.owner ?? true;
  const tableExists = opts.tableExists ?? true;
  const updatedRows = opts.updatedRows ?? 7;
  const visibility: VisibilityRow[] = tableExists
    ? [
        {
          role: "app_rw",
          bypasses_rls: false,
          is_owner: owner,
          rls_enabled: true,
          has_scope_column: opts.hasScopeColumn ?? true,
        },
      ]
    : [];
  const conn: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      observed.push({ sql, params: params ?? [] });
      if (sql.includes("relrowsecurity")) {
        return { rows: visibility, rowCount: visibility.length } as unknown as PgQueryResult<EncryptedColumnRow>;
      }
      if (sql.includes("relkind = 'p'")) {
        const partitioned = opts.partitioned ?? [];
        return { rows: partitioned, rowCount: partitioned.length } satisfies PgQueryResult<EncryptedColumnRow>;
      }
      if (sql.includes("col_description")) {
        return { rows, rowCount: rows.length } satisfies PgQueryResult<EncryptedColumnRow>;
      }
      if (sql.includes("AS rows_to_rewrite")) {
        return {
          rows: [{ rows_to_rewrite: String(opts.rowsToRewrite ?? updatedRows) }],
          rowCount: 1,
        } as unknown as PgQueryResult<EncryptedColumnRow>;
      }
      if (sql.includes("AS readable")) {
        return {
          rows: [{ readable: String(opts.readable ?? updatedRows) }],
          rowCount: 1,
        } as unknown as PgQueryResult<EncryptedColumnRow>;
      }
      if (sql.startsWith("UPDATE")) {
        return { rows: [], rowCount: updatedRows } satisfies PgQueryResult<EncryptedColumnRow>;
      }
      return { rows: [], rowCount: 0 } satisfies PgQueryResult<EncryptedColumnRow>;
    }) as PgConnection["query"],
    transaction: vi.fn(async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
}

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

function sqlTexts(observed: readonly Recorded[]): string[] {
  return observed.map((r) => r.sql);
}

describe("KeyRotationMigrator", () => {
  it("plans only the ciphertext (bytea) hinted columns", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow, plaintextRow], observed));
    const plans = await migrator.planSchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.column).toBe("mrn");
  });

  it("executes each re-encryption inside a transaction", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow], observed));
    const plans = await migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(plans).toHaveLength(1);
    expect(
      sqlTexts(observed).some(
        (s) => s.startsWith("UPDATE") && s.includes("pgp_sym_encrypt(pgp_sym_decrypt"),
      ),
    ).toBe(true);
  });

  it("reports the rows each column actually rewrote, not the statements issued", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(
      mockConn([ciphertextRow], observed, { updatedRows: 12 }),
    );
    const outcomes = await migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(outcomes[0]?.rowsReencrypted).toBe(12);
  });

  it("refuses when row-level security would confine this session", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow], observed, { owner: false }));
    await expect(migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY)).rejects.toThrow(
      /rls_would_confine_this_session/,
    );
    // The refusal lands before any rewrite: a rotation that half-ran under RLS is worse than one
    // that did not start, because the outcome list would name columns it only partly rewrote.
    expect(sqlTexts(observed).some((s) => s.startsWith("UPDATE"))).toBe(false);
  });

  it("reports a hinted column that is still plaintext at rest without blocking the rotation", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow, plaintextRow], observed));
    const survey = await migrator.surveySchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(survey.plans).toHaveLength(1);
    expect(survey.plaintextAtRest.map((c) => c.column)).toEqual(["body"]);
    expect(survey.refusals).toEqual([]);
    // Reported, not refused: that column was protected by neither key, so it is a finding about
    // the encryption migration rather than a reason this rotation is wrong.
    const outcomes = await migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(outcomes.map((o) => o.column)).toEqual(["mrn"]);
  });

  it("refuses rotating a key to itself", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow], observed));
    const survey = await migrator.surveySchema("t_clinic", NEW_KEY, NEW_KEY);
    expect(survey.refusals.map((r) => r.reason)).toContain("keys_are_the_same");
  });

  it("does not refuse two distinct key refs, which is every rekey", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow], observed));
    const survey = await migrator.surveySchema("t_clinic", OLD_KEY, NEW_KEY);
    // The refusal compares *references*, so two GUC names holding identical bytes pass it. The
    // value-equality check belongs to whoever holds both values.
    expect(survey.refusals.map((r) => r.reason)).not.toContain("keys_are_the_same");
  });

  it("refuses when an introspected table does not exist", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(
      mockConn([ciphertextRow], observed, { tableExists: false }),
    );
    const survey = await migrator.surveySchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(survey.refusals.map((r) => r.reason)).toContain("table_missing");
  });

  it("refuses a schema holding a partitioned encrypted table that introspection cannot see", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(
      mockConn([ciphertextRow], observed, {
        partitioned: [
          {
            schema: "t_clinic",
            table_name: "observation",
            column_name: "value_text",
            data_type: "bytea",
            comment: "crossengin.encrypt=at_rest",
          },
        ],
      }),
    );
    await expect(migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY)).rejects.toThrow(
      /partitioned_table_unreachable/,
    );
    expect(sqlTexts(observed).some((s) => s.startsWith("UPDATE"))).toBe(false);
  });

  it("does not read has_scope_column for a whole-schema rotation", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(
      mockConn([ciphertextRow], observed, { hasScopeColumn: false }),
    );
    const survey = await migrator.surveySchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(survey.refusals).toEqual([]);
  });

  it("claims its key GUCs transaction-locally inside the rotation", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow], observed), {
      sessionSettings: new Map([["app.column_encryption_key_old", "old-secret"]]),
    });
    await migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY);
    const settings = observed.filter((r) => r.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    // `true` is the is_local argument: a session-wide SET would leave the key readable to the next
    // caller of a pooled connection.
    expect(settings[0]?.sql).toContain("set_config($1, $2, true)");
    // And the key value is a bound parameter, never SQL text.
    expect(settings[0]?.params).toEqual(["app.column_encryption_key_old", "old-secret"]);
    expect(settings[0]?.sql).not.toContain("old-secret");
  });

  it("is a no-op when there are no ciphertext columns", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([], observed));
    const plans = await migrator.rotateSchema("t_clinic", OLD_KEY, NEW_KEY);
    expect(plans).toEqual([]);
    expect(sqlTexts(observed).some((s) => s.startsWith("UPDATE"))).toBe(false);
  });

  it("formats the survey with the skipped and refused parts the plan cannot carry", async () => {
    const observed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow, plaintextRow], observed));
    const text = formatKeyRotationSurvey(
      await migrator.surveySchema("t_clinic", OLD_KEY, NEW_KEY),
    );
    expect(text).toContain("SKIPPED note.body");
    expect(text).toContain("hinted encrypt=at_rest but stored as text");
  });

  it("no longer claims an absence it did not check", () => {
    expect(formatKeyRotationPlan([])).not.toContain("No encrypted-at-rest columns found");
    expect(formatKeyRotationPlan([])).toContain("No ciphertext (BYTEA) columns");
  });
});

describe("KeyRotationMigrator.surveyTenant", () => {
  it("scopes every statement to the tenant and binds the id", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed);
    const survey = await new KeyRotationMigrator(conn).surveyTenant(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    expect(survey.plans).toHaveLength(1);
    expect(survey.plans[0]?.statement.sql).toContain(`AND "tenant_id" = $1`);
    expect(survey.plans[0]?.statement.params).toEqual([TENANT]);
    expect(survey.plans[0]?.confirm.params).toEqual([TENANT]);
  });

  it("counts the rows each column would rewrite", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed, { rowsToRewrite: 31 });
    const survey = await new KeyRotationMigrator(conn).surveyTenant(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    // Filled by the survey where the pure planner answers null, and read back from a BIGINT that
    // arrives as a string.
    expect(survey.plans[0]?.rowsToRewrite).toBe(31);
    const count = observed.find((r) => r.sql.includes("AS rows_to_rewrite"));
    expect(count?.params).toEqual([TENANT]);
    expect(count?.sql).not.toContain(TENANT);
  });

  it("refuses a table with no tenant_id column rather than rotating it unscoped", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed, { hasScopeColumn: false });
    const survey = await new KeyRotationMigrator(conn).surveyTenant(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    expect(survey.refusals.map((r) => r.reason)).toContain("tenant_column_missing");
    // And it does not then count: the count query would itself raise 42703 on that table.
    expect(observed.some((r) => r.sql.includes("AS rows_to_rewrite"))).toBe(false);
    expect(survey.plans[0]?.rowsToRewrite).toBeNull();
  });

  it("keeps rls_would_confine_this_session for a scoped rotation", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed, { owner: false });
    const survey = await new KeyRotationMigrator(conn).surveyTenant(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    // The tenant predicate is the only confinement here, not a second belt beside RLS: a confined
    // session counts 0, which is byte-identical to "this tenant holds no ciphertext".
    expect(survey.refusals.map((r) => r.reason)).toContain("rls_would_confine_this_session");
    expect(observed.some((r) => r.sql.includes("AS rows_to_rewrite"))).toBe(false);
  });

  it("refuses a partitioned encrypted table it cannot plan", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed, {
      partitioned: [
        {
          schema: "public",
          table_name: "observation",
          column_name: "value_text",
          data_type: "bytea",
          comment: "crossengin.encrypt=at_rest",
        },
      ],
    });
    const survey = await new KeyRotationMigrator(conn).surveyTenant(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    const partitioned = survey.refusals.find((r) => r.reason === "partitioned_table_unreachable");
    expect(partitioned?.detail).toContain("public.observation");
  });

  it("surveys through the connection it was handed, not the one it was constructed with", async () => {
    const constructed: Recorded[] = [];
    const handed: Recorded[] = [];
    const migrator = new KeyRotationMigrator(mockConn([ciphertextRow], constructed));
    await migrator.surveyTenant(
      mockConn([ciphertextRow], handed),
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    expect(handed.length).toBeGreaterThan(0);
    expect(constructed).toEqual([]);
  });
});

describe("KeyRotationMigrator.rotateTenantWithin", () => {
  const settings = new Map([
    ["app.column_encryption_key_old", "old-secret"],
    ["app.column_encryption_key", "new-secret"],
  ]);

  it("applies both key settings before anything reads them", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed);
    await new KeyRotationMigrator(conn, { sessionSettings: settings }).rotateTenantWithin(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    const texts = sqlTexts(observed);
    expect(texts[0]).toContain("set_config($1, $2, true)");
    expect(texts[1]).toContain("set_config($1, $2, true)");
    // Before the survey, so the survey's own statements run with both keys claimed.
    expect(texts.findIndex((s) => s.includes("col_description"))).toBe(2);
  });

  it("keeps both key values out of every recorded SQL text", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed);
    await new KeyRotationMigrator(conn, { sessionSettings: settings }).rotateTenantWithin(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    for (const record of observed) {
      expect(record.sql).not.toContain("old-secret");
      expect(record.sql).not.toContain("new-secret");
    }
    expect(observed.flatMap((r) => [...r.params])).toContain("new-secret");
  });

  it("rotates, confirms and returns the totals", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed, { updatedRows: 9 });
    const outcome = await new KeyRotationMigrator(conn).rotateTenantWithin(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    expect(outcome.rowsReencrypted).toBe(9);
    expect(outcome.rowsConfirmed).toBe(9);
    expect(outcome.columns.map((c) => c.column)).toEqual(["mrn"]);
    const texts = sqlTexts(observed);
    expect(texts.findIndex((s) => s.startsWith("UPDATE"))).toBeLessThan(
      texts.findIndex((s) => s.includes("AS readable")),
    );
  });

  it("throws when the confirm count disagrees with what was rewritten", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed, { updatedRows: 7, readable: 6 });
    await expect(
      new KeyRotationMigrator(conn).rotateTenantWithin(
        conn,
        "public",
        TENANT,
        OLD_KEY,
        NEW_KEY,
      ),
    ).rejects.toThrow(/7 row\(s\) were re-encrypted but 6 read back under the new key/);
  });

  it("refuses before issuing any UPDATE", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed, { owner: false });
    await expect(
      new KeyRotationMigrator(conn).rotateTenantWithin(
        conn,
        "public",
        TENANT,
        OLD_KEY,
        NEW_KEY,
      ),
    ).rejects.toThrow(/rls_would_confine_this_session/);
    expect(sqlTexts(observed).some((s) => s.startsWith("UPDATE"))).toBe(false);
  });

  it("refuses a tenant_column_missing table before issuing any UPDATE", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed, { hasScopeColumn: false });
    await expect(
      new KeyRotationMigrator(conn).rotateTenantWithin(
        conn,
        "public",
        TENANT,
        OLD_KEY,
        NEW_KEY,
      ),
    ).rejects.toThrow(/tenant_column_missing/);
    expect(sqlTexts(observed).some((s) => s.startsWith("UPDATE"))).toBe(false);
  });

  it("never opens a transaction of its own", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([ciphertextRow], observed);
    await new KeyRotationMigrator(conn).rotateTenantWithin(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    // The caller owns the transaction: the real node-pg binding throws on a nested one, so a seam
    // that opened its own would be green offline and dead live.
    expect(conn.transaction).not.toHaveBeenCalled();
  });

  it("is a no-op that confirms nothing when the tenant has no ciphertext columns", async () => {
    const observed: Recorded[] = [];
    const conn = mockConn([], observed);
    const outcome = await new KeyRotationMigrator(conn).rotateTenantWithin(
      conn,
      "public",
      TENANT,
      OLD_KEY,
      NEW_KEY,
    );
    expect(outcome).toEqual({ columns: [], rowsReencrypted: 0, rowsConfirmed: 0 });
  });
});
