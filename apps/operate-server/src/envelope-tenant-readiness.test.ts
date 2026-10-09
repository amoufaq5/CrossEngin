import type { PgConnection } from "@crossengin/kernel-pg";
import { META_TABLES } from "@crossengin/kernel/bootstrap";
import { describe, expect, it } from "vitest";

import {
  DATA_KEY_TENANT_FK,
  ENVELOPE_TENANT_STATES,
  type EnvelopeTenantState,
  envelopeTenantStateOf,
  formatEnvelopeTenantReadiness,
  surveyEnvelopeTenantReadiness,
} from "./envelope-tenant-readiness.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

type Row = Record<string, unknown>;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeOptions {
  readonly exists?: boolean;
  readonly canSelect?: boolean;
  readonly present?: readonly string[];
  /** Which statement should throw: the catalog probe or the id read. */
  readonly throwOn?: "catalog" | "present";
}

/**
 * Answers the two statements the probe issues, by recognising them rather than by position — an
 * absent or unreadable table never reaches the id read, and a positional fake would hand that
 * answer to the wrong question.
 */
function fakeDb(opts: FakeOptions = {}): { conn: PgConnection; captured: Captured[] } {
  const captured: Captured[] = [];
  const exists = opts.exists ?? true;
  const run = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    captured.push({ sql, params: params ?? [] });
    if (sql.includes("has_table_privilege")) {
      if (opts.throwOn === "catalog") throw new Error("connection refused");
      return {
        rows: [{ table_exists: exists, can_select: exists && (opts.canSelect ?? true) }],
        rowCount: 1,
      };
    }
    if (opts.throwOn === "present") throw new Error("permission denied for table tenants");
    const rows = (opts.present ?? []).map((id) => ({ id }));
    return { rows, rowCount: rows.length };
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, captured };
}

describe("ENVELOPE_TENANT_STATES", () => {
  it("names three states in verdict order", () => {
    expect(ENVELOPE_TENANT_STATES).toEqual(["provisioned", "missing", "unknown"]);
  });

  it("separates 'the row is absent' from 'we could not check'", () => {
    // The whole point of the enum: one names work an operator must do, the other names a thing this
    // probe could not see, and collapsing them prints a list of tenants that are fine.
    expect(new Set(ENVELOPE_TENANT_STATES).has("missing")).toBe(true);
    expect(new Set(ENVELOPE_TENANT_STATES).has("unknown")).toBe(true);
  });

  it("is handled exhaustively, so a fourth state is a compile error rather than a silent branch", () => {
    // A total map written here rather than in the module, because nothing in the module dispatches
    // on the state — the verdicts are data. This is the fence that a reader added later must either
    // extend or fail at.
    const described: Readonly<Record<EnvelopeTenantState, string>> = {
      provisioned: "a meta.tenants row holds this id",
      missing: "no row holds it, so the data key insert is refused",
      unknown: "the probe established nothing",
    };
    expect(Object.keys(described).sort()).toEqual([...ENVELOPE_TENANT_STATES].sort());
    for (const state of ENVELOPE_TENANT_STATES) {
      expect(described[state].length).toBeGreaterThan(0);
    }
  });
});

describe("DATA_KEY_TENANT_FK", () => {
  it("names the constraint the catalog's own reference really produces", () => {
    // The emitter writes column-level foreign keys inline and unnamed, so Postgres derives
    // `<table>_<column>_fkey`. Pinned against META_TABLES so a catalog edit that moves the
    // reference fails here rather than leaving the boot line naming a constraint that is gone.
    const table = META_TABLES.find((t) => t.name === "tenant_data_keys");
    expect(table, "meta.tenant_data_keys is no longer in the catalog").toBeDefined();
    const column = table?.columns.find((c) => c.name === "tenant_id");
    expect(column?.references?.schema).toBe("meta");
    expect(column?.references?.table).toBe("tenants");
    expect(column?.references?.column).toBe("id");
    expect(DATA_KEY_TENANT_FK).toBe(
      `${String(table?.name)}_${String(column?.name)}_fkey`,
    );
  });

  it("is a reference whose ON DELETE is the CASCADE that made it deliberate", () => {
    // ADR-0347's argument for the reference is that the row must not outlive the tenant. The
    // defect this module reports is the contrapositive, so if the CASCADE ever goes the reasoning
    // in the module doc is the thing to revisit.
    const column = META_TABLES.find((t) => t.name === "tenant_data_keys")?.columns.find(
      (c) => c.name === "tenant_id",
    );
    expect(column?.references?.onDelete).toBe("CASCADE");
    expect(column?.notNull).toBe(true);
  });
});

describe("surveyEnvelopeTenantReadiness", () => {
  it("refuses an invalid schema identifier", async () => {
    const { conn } = fakeDb();
    await expect(surveyEnvelopeTenantReadiness(conn, [], { schema: "me ta" })).rejects.toThrow(
      /invalid schema/,
    );
  });

  it("asks the catalog for existence and privilege in one statement with no branch that can raise", async () => {
    const { conn, captured } = fakeDb({ present: [A] });
    await surveyEnvelopeTenantReadiness(conn, [A]);
    const probe = captured[0];
    expect(probe?.sql).toMatch(/to_regclass\(\$1\) IS NOT NULL AS table_exists/);
    // The oid overload, not the name one: the name form raises on an absent table, which would
    // make an absent table indistinguishable from an unreachable database.
    expect(probe?.sql).toMatch(/has_table_privilege\(current_user, to_regclass\(\$1\), 'SELECT'\)/);
    expect(probe?.params).toEqual(["meta.tenants"]);
  });

  it("reports every named tenant provisioned when each has a row", async () => {
    const { conn } = fakeDb({ present: [A, B] });
    const report = await surveyEnvelopeTenantReadiness(conn, [A, B]);
    expect(report.tenants).toEqual([
      { tenantId: A, state: "provisioned" },
      { tenantId: B, state: "provisioned" },
    ]);
    expect(report.missing).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.unreadableReason).toBeNull();
  });

  it("names the tenants with no row as missing", async () => {
    const { conn } = fakeDb({ present: [A] });
    const report = await surveyEnvelopeTenantReadiness(conn, [A, B]);
    expect(report.missing).toEqual([B]);
    expect(report.unknown).toEqual([]);
    expect(report.unreadableReason).toBeNull();
    expect(envelopeTenantStateOf(report, A)).toBe("provisioned");
    expect(envelopeTenantStateOf(report, B)).toBe("missing");
  });

  it("answers `unknown` and never `missing` when the role may not read the table", async () => {
    const { conn } = fakeDb({ canSelect: false });
    const report = await surveyEnvelopeTenantReadiness(conn, [A, B]);
    // The defect this arm exists for: a zero-row answer would print a list of tenants that are
    // perfectly fine and talk an operator out of envelope mode.
    expect(report.unknown).toEqual([A, B]);
    expect(report.missing).toEqual([]);
    expect(report.tenants.every((t) => t.state === "unknown")).toBe(true);
    expect(report.unreadableReason).toMatch(/indistinguishable/);
  });

  it("does not read the ids when it may not read them", async () => {
    const { conn, captured } = fakeDb({ canSelect: false });
    await surveyEnvelopeTenantReadiness(conn, [A]);
    expect(captured.some((c) => c.sql.includes("WHERE id = ANY"))).toBe(false);
  });

  it("answers `unknown` when the table does not exist, naming the constraint nothing can satisfy", async () => {
    const { conn } = fakeDb({ exists: false });
    const report = await surveyEnvelopeTenantReadiness(conn, [A]);
    expect(report.unknown).toEqual([A]);
    expect(report.missing).toEqual([]);
    expect(report.unreadableReason).toMatch(/does not exist/);
    expect(report.unreadableReason).toContain(DATA_KEY_TENANT_FK);
  });

  it("does not read the ids when the table does not exist", async () => {
    const { conn, captured } = fakeDb({ exists: false });
    await surveyEnvelopeTenantReadiness(conn, [A]);
    expect(captured.some((c) => c.sql.includes("WHERE id = ANY"))).toBe(false);
  });

  it("answers `unknown` when the catalog probe itself fails", async () => {
    const { conn } = fakeDb({ throwOn: "catalog" });
    const report = await surveyEnvelopeTenantReadiness(conn, [A]);
    expect(report.unknown).toEqual([A]);
    expect(report.missing).toEqual([]);
    expect(report.unreadableReason).toMatch(/connection refused/);
  });

  it("answers `unknown` when the id read fails after a readable catalog", async () => {
    const { conn } = fakeDb({ throwOn: "present" });
    const report = await surveyEnvelopeTenantReadiness(conn, [A, B]);
    expect(report.unknown).toEqual([A, B]);
    expect(report.missing).toEqual([]);
    expect(report.unreadableReason).toMatch(/permission denied/);
  });

  it("binds the tenant ids as parameters and puts none of them in the SQL text", async () => {
    const { conn, captured } = fakeDb({ present: [] });
    await surveyEnvelopeTenantReadiness(conn, [B, A]);
    const read = captured.find((c) => c.sql.includes("WHERE id = ANY"));
    expect(read?.sql).toContain("ANY($1::uuid[])");
    expect(read?.params).toEqual([[A, B]]);
    for (const c of captured) {
      expect(c.sql).not.toContain(A);
      expect(c.sql).not.toContain(B);
    }
  });

  it("deduplicates, sorts and drops empty ids", async () => {
    const { conn, captured } = fakeDb({ present: [] });
    const report = await surveyEnvelopeTenantReadiness(conn, [B, A, A, ""]);
    expect(report.tenants.map((t) => t.tenantId)).toEqual([A, B]);
    expect(captured.find((c) => c.sql.includes("WHERE id = ANY"))?.params).toEqual([[A, B]]);
  });

  it("matches a stored id case-insensitively, since a UUID is not case-sensitive", async () => {
    const { conn } = fakeDb({ present: [A.toUpperCase()] });
    const report = await surveyEnvelopeTenantReadiness(conn, [A]);
    expect(report.missing).toEqual([]);
    expect(envelopeTenantStateOf(report, A)).toBe("provisioned");
  });

  it("keeps a non-uuid id out of the bind and still reports it missing", async () => {
    const { conn, captured } = fakeDb({ present: [A] });
    const report = await surveyEnvelopeTenantReadiness(conn, [A, "acme"]);
    // `parseApiKeySpec` does not validate the tenant field, so 'acme' is reachable from argv. One
    // malformed element would make `$1::uuid[]` raise 22P02 and turn every other verdict into
    // `unknown`, which is the answer this probe exists to avoid.
    expect(captured.find((c) => c.sql.includes("WHERE id = ANY"))?.params).toEqual([[A]]);
    expect(report.missing).toEqual(["acme"]);
    expect(envelopeTenantStateOf(report, A)).toBe("provisioned");
  });

  it("reports a non-uuid id as `unknown` when nothing could be established", async () => {
    const { conn } = fakeDb({ canSelect: false });
    const report = await surveyEnvelopeTenantReadiness(conn, ["acme"]);
    // Deliberate: the column's type makes 'acme' unsatisfiable without any read, but a report
    // mixing one established verdict into a set of unestablished ones reads as "we checked".
    expect(report.unknown).toEqual(["acme"]);
    expect(report.missing).toEqual([]);
  });

  it("is silent with no tenants to check and issues no read", async () => {
    const { conn, captured } = fakeDb();
    const report = await surveyEnvelopeTenantReadiness(conn, []);
    expect(report.tenants).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.unreadableReason).toBeNull();
    expect(captured.some((c) => c.sql.includes("WHERE id = ANY"))).toBe(false);
  });

  it("honours a non-default schema in both statements", async () => {
    const { conn, captured } = fakeDb({ present: [A] });
    await surveyEnvelopeTenantReadiness(conn, [A], { schema: "shadow" });
    expect(captured[0]?.params).toEqual(["shadow.tenants"]);
    expect(captured.find((c) => c.sql.includes("WHERE id = ANY"))?.sql).toMatch(/shadow\.tenants/);
  });
});

describe("envelopeTenantStateOf", () => {
  it("answers `unknown` for a tenant the survey never asked about", async () => {
    const { conn } = fakeDb({ present: [A] });
    const report = await surveyEnvelopeTenantReadiness(conn, [A, B]);
    // Not `missing`: an id outside the surveyed set was not found absent, it was not looked for.
    expect(envelopeTenantStateOf(report, C)).toBe("unknown");
  });
});

describe("formatEnvelopeTenantReadiness", () => {
  it("answers null when every named tenant is provisioned", async () => {
    const { conn } = fakeDb({ present: [A, B] });
    const report = await surveyEnvelopeTenantReadiness(conn, [A, B]);
    expect(formatEnvelopeTenantReadiness(report)).toBeNull();
  });

  it("answers null with nothing to survey", async () => {
    const { conn } = fakeDb();
    expect(formatEnvelopeTenantReadiness(await surveyEnvelopeTenantReadiness(conn, []))).toBeNull();
  });

  it("names the constraint, the consequence and both remedies", async () => {
    const { conn } = fakeDb({ present: [] });
    const line = formatEnvelopeTenantReadiness(await surveyEnvelopeTenantReadiness(conn, [A])) ?? "";
    expect(line).toContain(DATA_KEY_TENANT_FK);
    // The consequence, in the three parts an operator cannot guess: reads as well as writes, the
    // status they will actually see, and why retrying is futile.
    expect(line).toMatch(/every PHI read and write/);
    expect(line).toMatch(/504/);
    expect(line).toMatch(/retrying can never succeed/);
    // Both remedies, each nameable: provision the tenant, or stop needing a row at all.
    expect(line).toMatch(/POST \/v1\/platform\/tenants/);
    expect(line).toMatch(/--column-key-mode derived/);
    expect(line).toMatch(/no foreign key to satisfy/);
  });

  it("names each unprovisioned tenant", async () => {
    const { conn } = fakeDb({ present: [A] });
    const line = formatEnvelopeTenantReadiness(
      await surveyEnvelopeTenantReadiness(conn, [A, B]),
    ) ?? "";
    expect(line).toContain(`unprovisioned tenant: ${B}`);
    expect(line).not.toContain(`unprovisioned tenant: ${A}`);
    expect(line).toMatch(/1 of 2 named tenants/);
  });

  it("gives a malformed id its own remedy, since correcting a spec is not provisioning a tenant", async () => {
    const { conn } = fakeDb({ present: [] });
    const line = formatEnvelopeTenantReadiness(
      await surveyEnvelopeTenantReadiness(conn, ["acme"]),
    ) ?? "";
    expect(line).toMatch(/malformed tenant id/);
    expect(line).toMatch(/meta\.tenants\.id is UUID/);
    expect(line).not.toContain("unprovisioned tenant: acme");
  });

  it("reports an unreadable probe without claiming any tenant is missing", async () => {
    const { conn } = fakeDb({ canSelect: false });
    const line = formatEnvelopeTenantReadiness(
      await surveyEnvelopeTenantReadiness(conn, [A, B]),
    ) ?? "";
    expect(line).toMatch(/^envelope tenant readiness: unknown —/);
    expect(line).toContain(`undetermined tenant: ${A}`);
    // Per-id and not merely per-phrase: the `unknown` arm's own prose explains that a zero-row
    // answer would be indistinguishable from "an unprovisioned tenant", so the property is that no
    // *labelled* line names one.
    expect(line).not.toMatch(/unprovisioned tenant: /);
    expect(line).not.toMatch(/malformed tenant id/);
    // The clause that keeps an operator from acting on a list this probe did not produce.
    expect(line).toMatch(/no tenant was found missing/);
  });

  it("says nothing about an undetermined tenant when the verdicts mean something", async () => {
    const { conn } = fakeDb({ present: [A] });
    const line = formatEnvelopeTenantReadiness(
      await surveyEnvelopeTenantReadiness(conn, [A, B]),
    ) ?? "";
    expect(line).not.toMatch(/undetermined tenant/);
    expect(line).not.toMatch(/no tenant was found missing/);
  });

  it("always declares the population it could not survey", async () => {
    // Both arms: the api-key specs are a lower bound, because a JWT deployment presents whatever
    // tenant the request names and meets the same foreign key unsurveyed.
    const missing = fakeDb({ present: [] });
    const unreadable = fakeDb({ canSelect: false });
    for (const { conn } of [missing, unreadable]) {
      const line = formatEnvelopeTenantReadiness(
        await surveyEnvelopeTenantReadiness(conn, [A]),
      ) ?? "";
      expect(line).toMatch(/not surveyed: tenants arriving over JWT/);
      expect(line).toMatch(/lower bound/);
    }
  });
});
