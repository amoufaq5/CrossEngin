import { ENCRYPTED_COLUMN_QUERY, type PgConnection } from "@crossengin/kernel-pg";
import { tenantSchemaName } from "@crossengin/operate-runtime-pg";
import { describe, expect, it } from "vitest";

import {
  CIPHERTEXT_ABSENT_SQLSTATES,
  buildTenantCiphertextProbe,
} from "./tenant-ciphertext-probe.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OWN_SCHEMA = tenantSchemaName(TENANT);

/** A SQLSTATE-carrying failure, the shape node-postgres raises. */
function pgError(code: string, message = `pg error ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

interface ColumnFixture {
  readonly table: string;
  readonly column: string;
  /** `bytea` is ciphertext at rest; `text` is a hinted column the storage has not caught up with. */
  readonly dataType: string;
}

interface SchemaFixture {
  readonly columns?: readonly ColumnFixture[];
  /** Thrown instead of answering the catalog query for this schema. */
  readonly introspectError?: unknown;
  /** Tables that hold a row for the probed tenant. */
  readonly rowsIn?: readonly string[];
  /** Thrown instead of answering the row query for that table. */
  readonly rowErrors?: Readonly<Record<string, unknown>>;
}

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Which transaction this statement ran in, or `null` for one issued outside any. */
  readonly tx: number | null;
}

interface Fake {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  readonly introspected: () => readonly string[];
  readonly rowQueries: () => readonly Captured[];
}

const ROW_TARGET = /FROM "([^"]+)"\."([^"]+)"/;

/**
 * Answers the catalog and the row queries from a per-schema fixture, and records every statement
 * with the transaction it ran in.
 *
 * The transaction id is the load-bearing part. A fake answers any statement, so the thing it
 * structurally cannot see is whether a row query was *scoped* — and the two arms this module needs
 * are the tenant context (a `set_config` in the same transaction) and the `tenant_id` predicate.
 * Recording the nesting is what lets a test assert both, which is ADR-0333's rule for a fake:
 * a statement it could not really have served must not pass.
 */
function fakeDb(schemas: Readonly<Record<string, SchemaFixture>>): Fake {
  const captured: Captured[] = [];
  let txSeq = 0;
  let currentTx: number | null = null;

  const run = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const bound = params ?? [];
    captured.push({ sql, params: bound, tx: currentTx });
    if (sql.includes("crossengin.encrypt=at_rest")) {
      const schema = String(bound[0]);
      const fixture = schemas[schema];
      if (fixture?.introspectError !== undefined) throw fixture.introspectError;
      const rows = (fixture?.columns ?? []).map((c) => ({
        schema,
        table_name: c.table,
        column_name: c.column,
        data_type: c.dataType,
        comment: "crossengin.data_class=phi; crossengin.encrypt=at_rest",
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
    const target = ROW_TARGET.exec(sql);
    if (target === null) throw new Error(`unexpected statement: ${sql}`);
    const schema = target[1] ?? "";
    const table = target[2] ?? "";
    const fixture = schemas[schema];
    const thrown = fixture?.rowErrors?.[table];
    if (thrown !== undefined) throw thrown;
    const holds = (fixture?.rowsIn ?? []).includes(table);
    return holds ? { rows: [{ one: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  };

  const conn = {
    query: run,
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
      txSeq += 1;
      const outer = currentTx;
      currentTx = txSeq;
      try {
        return await fn(conn as unknown as PgConnection);
      } finally {
        currentTx = outer;
      }
    },
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<undefined> => undefined,
  };

  return {
    conn: conn as unknown as PgConnection,
    captured,
    introspected: () =>
      captured
        .filter((c) => c.sql.includes("crossengin.encrypt=at_rest"))
        .map((c) => String(c.params[0])),
    rowQueries: () => captured.filter((c) => ROW_TARGET.test(c.sql)),
  };
}

function bytea(table: string, column = "mrn"): ColumnFixture {
  return { table, column, dataType: "bytea" };
}

function plaintext(table: string, column = "mrn"): ColumnFixture {
  return { table, column, dataType: "text" };
}

function probeOver(
  schemas: Readonly<Record<string, SchemaFixture>>,
  options: { readonly bootSchema?: string; readonly tenantSchemaPrefix?: string } = {},
): { readonly fake: Fake; readonly probe: (tenantId: string) => Promise<boolean> } {
  const fake = fakeDb(schemas);
  const probe = buildTenantCiphertextProbe({
    conn: fake.conn,
    bootSchema: options.bootSchema ?? "public",
    ...(options.tenantSchemaPrefix !== undefined
      ? { tenantSchemaPrefix: options.tenantSchemaPrefix }
      : {}),
  });
  return { fake, probe };
}

describe("CIPHERTEXT_ABSENT_SQLSTATES", () => {
  it("is exactly the two codes that are an answer rather than an uncertainty", () => {
    expect(CIPHERTEXT_ABSENT_SQLSTATES).toEqual(["42P01", "3F000"]);
  });

  it("names neither a privilege refusal nor a missing column, which say the probe could not see", () => {
    expect(CIPHERTEXT_ABSENT_SQLSTATES).not.toContain("42501");
    expect(CIPHERTEXT_ABSENT_SQLSTATES).not.toContain("42703");
  });
});

describe("buildTenantCiphertextProbe", () => {
  it("answers true for a table that holds a row for this tenant", async () => {
    const { probe } = probeOver({
      public: { columns: [bytea("patient")], rowsIn: ["patient"] },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
  });

  it("answers false when no schema declares an at-rest column, without asking for a row", async () => {
    const { fake, probe } = probeOver({ public: { columns: [] } });
    await expect(probe(TENANT)).resolves.toBe(false);
    expect(fake.rowQueries()).toHaveLength(0);
  });

  it("answers false when the encrypted tables exist and hold nothing for this tenant", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [bytea("patient"), bytea("observation")], rowsIn: [] },
    });
    await expect(probe(TENANT)).resolves.toBe(false);
    expect(fake.rowQueries().map((c) => c.sql)).toHaveLength(2);
  });

  it("asks every table until one answers", async () => {
    const { fake, probe } = probeOver({
      public: {
        columns: [bytea("patient"), bytea("observation"), bytea("chart")],
        rowsIn: ["chart"],
      },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
    expect(fake.rowQueries()).toHaveLength(3);
  });

  it("deduplicates two encrypted columns on one table into one row query", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [bytea("patient", "mrn"), bytea("patient", "ssn")] },
    });
    await expect(probe(TENANT)).resolves.toBe(false);
    expect(fake.rowQueries()).toHaveLength(1);
  });
});

describe("the row query is scoped both ways", () => {
  it("runs inside a transaction that set app.current_tenant_id to this tenant", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [bytea("patient")], rowsIn: ["patient"] },
    });
    await probe(TENANT);
    const row = fake.rowQueries()[0];
    expect(row?.tx).not.toBeNull();
    const context = fake.captured.find(
      (c) => c.sql.includes("set_config") && c.tx === row?.tx,
    );
    // The context is what a **non-owner** needs: without it the entity table's RLS predicate is
    // NULL and the statement comes back empty with no error, which the probe would read as `false`.
    expect(context?.sql).toContain("app.current_tenant_id");
    expect(context?.params).toEqual([TENANT]);
  });

  it("keeps the tenant_id predicate, which is what an owner needs", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [bytea("patient")], rowsIn: ["patient"] },
    });
    await probe(TENANT);
    const row = fake.rowQueries()[0];
    // The owner bypasses RLS, so the context is inert and the predicate is the only confinement.
    expect(row?.sql).toContain(`WHERE "tenant_id" = $1`);
    expect(row?.params).toEqual([TENANT]);
  });

  it("binds the tenant id and never interpolates it into the statement", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [bytea("patient")] },
    });
    await probe(TENANT);
    for (const statement of fake.captured) {
      expect(statement.sql).not.toContain(TENANT);
    }
  });

  it("gives each table its own transaction, so one absent relation does not poison the rest", async () => {
    const { fake, probe } = probeOver({
      public: {
        columns: [bytea("patient"), bytea("observation")],
        rowErrors: { patient: pgError("42P01") },
      },
    });
    // `patient` is gone, `observation` is empty, so the honest answer is `false` — which is only
    // reachable because the second query is not running inside the first one's failed transaction.
    await expect(probe(TENANT)).resolves.toBe(false);
    const transactions = fake.rowQueries().map((c) => c.tx);
    expect(transactions).toHaveLength(2);
    expect(new Set(transactions).size).toBe(2);
  });

  it("sets the context for the tenant's own schema too", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [] },
      [OWN_SCHEMA]: { columns: [bytea("patient")], rowsIn: ["patient"] },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
    const row = fake.rowQueries()[0];
    expect(row?.sql).toContain(`"${OWN_SCHEMA}"."patient"`);
    const context = fake.captured.find(
      (c) => c.sql.includes("set_config") && c.tx === row?.tx,
    );
    expect(context?.params).toEqual([TENANT]);
  });
});

describe("the tables come from the catalog, not from a manifest", () => {
  it("asks the kernel's own encrypted-column query, with the schema bound", async () => {
    const { fake, probe } = probeOver({ public: { columns: [bytea("patient")] } });
    await probe(TENANT);
    const catalog = fake.captured.find((c) => c.sql.includes("crossengin.encrypt=at_rest"));
    expect(catalog?.sql).toBe(ENCRYPTED_COLUMN_QUERY);
    expect(catalog?.params).toEqual(["public"]);
  });

  it("probes a table the boot manifest need not declare", async () => {
    // The point of asking the catalog: `chart_v2` is in no manifest this process loaded, and it
    // holds this tenant's ciphertext.
    const { probe } = probeOver({
      public: { columns: [bytea("chart_v2")], rowsIn: ["chart_v2"] },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
  });

  it("does not treat a hinted TEXT column as evidence of ciphertext", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [plaintext("patient")], rowsIn: ["patient"] },
    });
    // The directive is declared and the storage is plaintext, so the rows are readable under any
    // key and randomising this tenant loses nothing.
    await expect(probe(TENANT)).resolves.toBe(false);
    expect(fake.rowQueries()).toHaveLength(0);
  });

  it("probes only the bytea tables when a schema holds both kinds", async () => {
    const { fake, probe } = probeOver({
      public: {
        columns: [plaintext("patient"), bytea("observation")],
        rowsIn: ["patient", "observation"],
      },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
    expect(fake.rowQueries()).toHaveLength(1);
    expect(fake.rowQueries()[0]?.sql).toContain(`"observation"`);
  });

  it("re-reads the catalog per tenant rather than remembering it", async () => {
    // A table created after boot — a newly activated manifest's `ensureSchema`, or an operator —
    // holds exactly the ciphertext a cached `false` would randomise away.
    const { fake, probe } = probeOver({ public: { columns: [bytea("patient")] } });
    await probe(TENANT);
    await probe(OTHER);
    expect(fake.introspected().filter((s) => s === "public")).toEqual(["public", "public"]);
  });
});

describe("the tenant's own schema", () => {
  it("is asked after the boot schema", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [bytea("patient")] },
      [OWN_SCHEMA]: { columns: [bytea("patient")] },
    });
    await expect(probe(TENANT)).resolves.toBe(false);
    expect(fake.introspected()).toEqual(["public", OWN_SCHEMA]);
  });

  it("answers true for a row that exists only there", async () => {
    // The defect this closes: a tenant serving their own activated manifest holds their encrypted
    // columns in `t_<uuid>`, which the previous probe never queried — so it answered `false` and
    // randomised a key over live ciphertext.
    const { probe } = probeOver({
      public: { columns: [bytea("patient")], rowsIn: [] },
      [OWN_SCHEMA]: { columns: [bytea("patient")], rowsIn: ["patient"] },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
  });

  it("is not reached when the boot schema already answered", async () => {
    const { fake, probe } = probeOver({
      public: { columns: [bytea("patient")], rowsIn: ["patient"] },
      [OWN_SCHEMA]: { columns: [bytea("patient")] },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
    expect(fake.introspected()).toEqual(["public"]);
  });

  it("honours a prefix override", async () => {
    const own = tenantSchemaName(TENANT, "tnt_");
    const { fake, probe } = probeOver(
      { public: { columns: [] }, [own]: { columns: [bytea("patient")], rowsIn: ["patient"] } },
      { tenantSchemaPrefix: "tnt_" },
    );
    await expect(probe(TENANT)).resolves.toBe(true);
    expect(fake.introspected()).toEqual(["public", own]);
  });

  it("is asked once when the boot schema is itself that tenant's schema", async () => {
    const { fake, probe } = probeOver(
      { [OWN_SCHEMA]: { columns: [bytea("patient")] } },
      { bootSchema: OWN_SCHEMA },
    );
    await expect(probe(TENANT)).resolves.toBe(false);
    expect(fake.introspected()).toEqual([OWN_SCHEMA]);
  });

  it("answers true when only its catalog read fails", async () => {
    const { probe } = probeOver({
      public: { columns: [bytea("patient")], rowsIn: [] },
      [OWN_SCHEMA]: { introspectError: pgError("42501", "permission denied for schema") },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
  });
});

describe("every uncertainty resolves to true", () => {
  it("answers false for 42P01, which says the relation is not there", async () => {
    const { probe } = probeOver({
      public: { columns: [bytea("patient")], rowErrors: { patient: pgError("42P01") } },
    });
    await expect(probe(TENANT)).resolves.toBe(false);
  });

  it("answers false for 3F000, which says the schema is not there", async () => {
    const { probe } = probeOver({
      public: { columns: [bytea("patient")], rowErrors: { patient: pgError("3F000") } },
    });
    await expect(probe(TENANT)).resolves.toBe(false);
  });

  it("answers true for a privilege refusal", async () => {
    const { probe } = probeOver({
      public: { columns: [bytea("patient")], rowErrors: { patient: pgError("42501") } },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
  });

  it("answers true for a table with no tenant_id column", async () => {
    // 42703, which `KeyRotationMigrator` refuses as `tenant_column_missing` rather than widening
    // the rotation to every row. Here the same fact is an uncertainty, so it answers `true`.
    const { probe } = probeOver({
      public: { columns: [bytea("patient")], rowErrors: { patient: pgError("42703") } },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
  });

  it("answers true for a failure carrying no SQLSTATE at all", async () => {
    const { probe } = probeOver({
      public: {
        columns: [bytea("patient")],
        rowErrors: { patient: new Error("connection terminated") },
      },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
  });

  it("answers true for a thrown non-object", async () => {
    const { probe } = probeOver({
      public: { columns: [bytea("patient")], rowErrors: { patient: "nope" } },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
  });

  it("answers true when the catalog itself cannot be read", async () => {
    const { fake, probe } = probeOver({
      public: { introspectError: new Error("database is starting up") },
    });
    await expect(probe(TENANT)).resolves.toBe(true);
    expect(fake.rowQueries()).toHaveLength(0);
  });

  it("answers true for a malformed tenant id rather than randomising it", async () => {
    // No per-tenant schema can exist for it — `tenantSchemaName` refuses the same input a
    // provisioning would have — but the boot schema's row test still runs, and
    // `withTenantContext`'s shape check refuses to bind it. That is an uncertainty, not an answer.
    const { probe } = probeOver({ public: { columns: [bytea("patient")] } });
    await expect(probe("tenant-one")).resolves.toBe(true);
  });

  it("gives the one false a malformed tenant id can have: nothing is encrypted anywhere", async () => {
    const { fake, probe } = probeOver({ public: { columns: [] } });
    await expect(probe("tenant-one")).resolves.toBe(false);
    expect(fake.introspected()).toEqual(["public"]);
  });
});
