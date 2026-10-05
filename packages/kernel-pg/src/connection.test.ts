import { describe, expect, it } from "vitest";
import { META_TABLES } from "@crossengin/kernel/bootstrap";

import { rowsResult } from "./node-pg.js";

import {
  PLATFORM_WRITE_GRANTS,
  isoCalendarDate,
  isoInstant,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
  requireIsoInstant,
  assertScopeTenantId,
  scopeFilter,
  scopeFilterWithPlatform,
  setPlatformWriteSql,
  type PlatformWriteGrant,
} from "./connection.js";

describe("parsePgEnvConfig", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PGHOST: "db.example.com",
    PGUSER: "postgres",
    PGDATABASE: "crossengin_dev",
  };

  it("returns a config with defaults filled in", () => {
    const cfg = parsePgEnvConfig(baseEnv);
    expect(cfg.host).toBe("db.example.com");
    expect(cfg.user).toBe("postgres");
    expect(cfg.database).toBe("crossengin_dev");
    expect(cfg.port).toBe(5432);
    expect(cfg.password).toBe("");
    expect(cfg.ssl).toBe("prefer");
    expect(cfg.applicationName).toBe("crossengin-pg");
  });

  it("threads PGPASSWORD through", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGPASSWORD: "secret" });
    expect(cfg.password).toBe("secret");
  });

  it("parses PGPORT as an integer", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGPORT: "6543" });
    expect(cfg.port).toBe(6543);
  });

  it("threads PGSSLMODE through when valid", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "require" });
    expect(cfg.ssl).toBe("require");
  });

  it("threads PGAPPNAME through", () => {
    const cfg = parsePgEnvConfig({ ...baseEnv, PGAPPNAME: "crossengin-ci" });
    expect(cfg.applicationName).toBe("crossengin-ci");
  });

  it("throws when PGHOST is missing", () => {
    expect(() =>
      parsePgEnvConfig({ ...baseEnv, PGHOST: undefined } as NodeJS.ProcessEnv),
    ).toThrow(/PGHOST/);
  });

  it("throws when PGUSER is missing", () => {
    expect(() =>
      parsePgEnvConfig({ ...baseEnv, PGUSER: undefined } as NodeJS.ProcessEnv),
    ).toThrow(/PGUSER/);
  });

  it("throws when PGDATABASE is missing", () => {
    expect(() =>
      parsePgEnvConfig({ ...baseEnv, PGDATABASE: undefined } as NodeJS.ProcessEnv),
    ).toThrow(/PGDATABASE/);
  });

  it("throws when PGPORT is not a valid TCP port", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "abc" })).toThrow(/PGPORT/);
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "0" })).toThrow(/PGPORT/);
    expect(() => parsePgEnvConfig({ ...baseEnv, PGPORT: "70000" })).toThrow(/PGPORT/);
  });

  it("throws when PGSSLMODE is not recognized", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "bogus" })).toThrow(/PGSSLMODE/);
  });
});

describe("looksLikeProductionDatabase", () => {
  it("flags names containing prod", () => {
    expect(looksLikeProductionDatabase("crossengin_prod")).toBe(true);
    expect(looksLikeProductionDatabase("PROD-cluster")).toBe(true);
  });

  it("flags names containing production", () => {
    expect(looksLikeProductionDatabase("production-db")).toBe(true);
  });

  it("flags names ending _live", () => {
    expect(looksLikeProductionDatabase("crossengin_live")).toBe(true);
  });

  it("flags the bare name live", () => {
    expect(looksLikeProductionDatabase("live")).toBe(true);
  });

  it("does not flag dev/test/staging names", () => {
    expect(looksLikeProductionDatabase("crossengin_dev")).toBe(false);
    expect(looksLikeProductionDatabase("staging_db")).toBe(false);
    expect(looksLikeProductionDatabase("test")).toBe(false);
  });
});

describe("rowsResult", () => {
  it("passes a single result through", () => {
    expect(rowsResult({ rows: [{ a: 1 }], rowCount: 1 })).toEqual({
      rows: [{ a: 1 }],
      rowCount: 1,
    });
  });

  it("takes the last result when node-postgres returns an array", () => {
    // A simple query holding more than one statement — `DROP INDEX …; CREATE INDEX …;`, which is how
    // an object is replaced without a window where it is missing — returns one result per statement.
    // Reading `.rows` off the array yielded undefined and surfaced as a JS TypeError wearing the
    // costume of a database error.
    expect(
      rowsResult([
        { rows: [], rowCount: null },
        { rows: [{ b: 2 }], rowCount: 1 },
      ]),
    ).toEqual({ rows: [{ b: 2 }], rowCount: 1 });
  });

  it("falls back to the row count when rowCount is null", () => {
    expect(rowsResult({ rows: [{ a: 1 }, { a: 2 }], rowCount: null }).rowCount).toBe(2);
  });

  it("is empty for an empty array of results", () => {
    expect(rowsResult([])).toEqual({ rows: [], rowCount: 0 });
  });

  it("is empty for a result with no rows field", () => {
    expect(rowsResult({ rowCount: 0 })).toEqual({ rows: [], rowCount: 0 });
  });

  it("is empty for null or undefined", () => {
    expect(rowsResult(null)).toEqual({ rows: [], rowCount: 0 });
    expect(rowsResult(undefined)).toEqual({ rows: [], rowCount: 0 });
  });
});

describe("isoInstant", () => {
  // The case the offline fakes could never produce: node-postgres hands a TIMESTAMPTZ, a TIMESTAMP
  // and a DATE back as a `Date`, and this is the whole reason this function exists.
  it("renders a Date as its ISO instant, milliseconds kept", () => {
    expect(isoInstant(new Date("2026-05-16T12:30:00.456Z"))).toBe("2026-05-16T12:30:00.456Z");
  });

  it("answers equal for a Date and the ISO string of the same instant", () => {
    expect(isoInstant(new Date("2026-05-16T12:30:00.456Z"))).toBe(
      isoInstant("2026-05-16T12:30:00.456Z"),
    );
  });

  it("does not answer equal for a Date and that Date's own String() form", () => {
    // `String(date)` drops the milliseconds, so substituting it would silently widen equality.
    const d = new Date("2026-05-16T12:30:00.456Z");
    expect(isoInstant(d)).not.toBe(isoInstant(String(d)));
  });

  it("normalises an offset-bearing string to UTC", () => {
    expect(isoInstant("2026-05-16T14:30:00+02:00")).toBe("2026-05-16T12:30:00.000Z");
  });

  it("is null for null and for undefined", () => {
    expect(isoInstant(null)).toBeNull();
    expect(isoInstant(undefined)).toBeNull();
  });

  it("returns an unparseable value as it stands, never as null", () => {
    // Absent and garbage are different facts; collapsing them would make a tampered column compare
    // equal to an empty one.
    expect(isoInstant("not a date")).toBe("not a date");
    expect(isoInstant(new Date("nope"))).toBe("Invalid Date");
    expect(isoInstant(42)).toBe("42");
  });
});

describe("requireIsoInstant", () => {
  it("renders a Date from a NOT NULL column", () => {
    expect(requireIsoInstant(new Date("2026-05-16T12:30:00.000Z"), "occurred_at")).toBe(
      "2026-05-16T12:30:00.000Z",
    );
  });

  it("throws naming the column when a NOT NULL timestamp is absent", () => {
    expect(() => requireIsoInstant(null, "occurred_at")).toThrow(
      /missing required timestamp: occurred_at/,
    );
  });
});

describe("isoCalendarDate", () => {
  // node-postgres parses a DATE into *local* midnight, so the ISO text of the same
  // `'2026-10-05'::date` names the previous day anywhere east of UTC. The local parts do not.
  it("reads the local calendar parts, not the ISO instant", () => {
    const tokyoMidnight = new Date(2026, 9, 5, 0, 0, 0); // local, whatever TZ the runner has
    expect(isoCalendarDate(tokyoMidnight)).toBe("2026-10-05");
  });

  it("does not agree with slicing the ISO text when that would shift the day", () => {
    // 1970-01-01T00:00:00Z is 1970-01-01 local only at or west of UTC; constructing from local
    // parts is what makes the answer independent of the runner's zone.
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(isoCalendarDate(d)).toBe("2026-01-01");
  });

  it("passes a text date through unchanged", () => {
    expect(isoCalendarDate("2026-10-05")).toBe("2026-10-05");
  });

  it("is null for null and undefined, and names an invalid Date", () => {
    expect(isoCalendarDate(null)).toBeNull();
    expect(isoCalendarDate(undefined)).toBeNull();
    expect(isoCalendarDate(new Date("nope"))).toBe("Invalid Date");
  });
});

/** Every policy in the catalog, with the table it sits on. */
function allPolicies(): readonly { readonly table: string; readonly policy: (typeof META_TABLES)[number]["rls"] extends
  | { readonly policies?: readonly (infer P)[] }
  | undefined
  ? P
  : never }[] {
  return META_TABLES.flatMap((t) =>
    (t.rls?.policies ?? []).map((policy) => ({ table: t.name, policy })),
  );
}

describe("PLATFORM_WRITE_GRANTS", () => {
  it("spells four grants, all under the app.platform_ prefix", () => {
    expect(Object.keys(PLATFORM_WRITE_GRANTS).sort()).toEqual([
      "audit",
      "config",
      "key",
      "record",
    ]);
    for (const guc of Object.values(PLATFORM_WRITE_GRANTS)) {
      expect(guc.startsWith("app.platform_")).toBe(true);
      expect(guc.endsWith("_write")).toBe(true);
    }
  });

  it("gives each grant a distinct setting, so one cannot stand in for another", () => {
    const names = Object.values(PLATFORM_WRITE_GRANTS);
    expect(new Set(names).size).toBe(names.length);
  });

  it("holds every `app.platform_*_write` setting the real catalog checks", () => {
    // Two copies of a GUC name — one in a policy predicate, one in the writer that sets it — is
    // exactly the arrangement ADR-0288's hand-maintained flag list failed at, and a mismatch has no
    // symptom beyond a write that silently matches no policy. So the catalog is read rather than
    // trusted: a predicate naming a write grant this vocabulary does not spell fails here.
    //
    // The converse — that every grant spelled here is checked by some policy — belongs with the
    // catalog and is asserted in `meta-schema.test.ts`, because a grant can legitimately be
    // declared one increment before the tables that check it.
    const known: readonly string[] = Object.values(PLATFORM_WRITE_GRANTS);
    const referenced = new Set<string>();
    for (const { policy } of allPolicies()) {
      for (const clause of [policy.using ?? "", policy.check ?? ""]) {
        for (const m of clause.matchAll(/app\.platform_[a-z_]*_write/g)) referenced.add(m[0]);
      }
    }
    expect([...referenced].sort().filter((guc) => !known.includes(guc))).toEqual([]);
    // And it is not vacuous: ADR-0331's grant is in the catalog today.
    expect(referenced.has(PLATFORM_WRITE_GRANTS.audit)).toBe(true);
  });

  it("is checked by no SELECT policy anywhere", () => {
    // ADR-0313's rule, as an assertion over the whole catalog: a grant that authorises a write must
    // never also be a route to another tenant's rows. The read elevation is `app.platform_audit`,
    // which has no `_write` suffix and so is not in this vocabulary at all.
    const grants = Object.values(PLATFORM_WRITE_GRANTS);
    for (const { table, policy } of allPolicies()) {
      if (policy.command !== "SELECT") continue;
      for (const guc of grants) {
        expect(`${table}: ${policy.using ?? ""}`).not.toContain(guc);
      }
    }
  });

  it("is checked only by INSERT- and UPDATE-scoped policies, never by an ALL-scope one", () => {
    // An `ALL`-scope policy's `USING` also serves as its `WITH CHECK`, which is the whole defect:
    // it would let the grant reach a DELETE as well, and nothing in the catalog deletes a platform
    // row. `DELETE` is reachable by no policy at all.
    const grants: readonly string[] = Object.values(PLATFORM_WRITE_GRANTS);
    for (const { table, policy } of allPolicies()) {
      const text = `${policy.using ?? ""} ${policy.check ?? ""}`;
      if (!grants.some((guc) => text.includes(guc))) continue;
      expect([`${table}`, policy.command]).toEqual([`${table}`, expect.stringMatching(/^(INSERT|UPDATE)$/)]);
    }
  });

  it("is always paired with `tenant_id IS NULL` in the clause that checks it", () => {
    // So holding a write elevation buys no access to any *tenant's* rows: the isolation policy
    // stays the only route to one and it still demands that tenant's context.
    const grants: readonly string[] = Object.values(PLATFORM_WRITE_GRANTS);
    for (const { table, policy } of allPolicies()) {
      for (const clause of [policy.using, policy.check]) {
        if (clause === undefined) continue;
        if (!grants.some((guc) => clause.includes(guc))) continue;
        expect(`${table}: ${clause}`).toContain("tenant_id IS NULL");
      }
    }
  });
});

describe("setPlatformWriteSql", () => {
  it("names the grant and sets it to 'on'", () => {
    for (const grant of Object.keys(PLATFORM_WRITE_GRANTS) as PlatformWriteGrant[]) {
      const sql = setPlatformWriteSql(grant);
      expect(sql).toContain(PLATFORM_WRITE_GRANTS[grant]);
      expect(sql).toContain("'on'");
    }
  });

  it("is transaction-local, never a session-wide SET", () => {
    // `set_config(..., true)` — the third argument is `is_local`. A session-wide `SET` would leave
    // the elevation on a pooled connection for whoever is handed it next.
    for (const grant of Object.keys(PLATFORM_WRITE_GRANTS) as PlatformWriteGrant[]) {
      expect(setPlatformWriteSql(grant)).toBe(
        `SELECT set_config('${PLATFORM_WRITE_GRANTS[grant]}', 'on', true)`,
      );
      expect(setPlatformWriteSql(grant).startsWith("SET ")).toBe(false);
    }
  });

  it("binds no parameters, so a caller cannot pass a grant name through it", () => {
    expect(setPlatformWriteSql("record")).not.toContain("$1");
  });
});

const TENANT = "11111111-1111-4111-8111-111111111111";

/**
 * The predicate eight packages held a verbatim copy of. What is asserted here is the *shape* and
 * the *branch*; which spelling a given table wants is asserted in that table's own package, because
 * it is a fact about the table.
 */
describe("scopeFilter", () => {
  it("asks for a tenant's rows by equality, binding the id", () => {
    expect(scopeFilter(TENANT)).toEqual({ sql: "tenant_id = $1", params: [TENANT] });
  });

  it("asks for the platform scope as IS NULL, binding nothing", () => {
    // `tenant_id = NULL` is never true, so the platform scope cannot ride along as a parameter.
    expect(scopeFilter(null)).toEqual({ sql: "tenant_id IS NULL", params: [] });
  });

  it("places its parameter where the caller says, so it composes with a bound list", () => {
    expect(scopeFilter(TENANT, 4).sql).toBe("tenant_id = $4");
    expect(scopeFilter(null, 4).params).toEqual([]);
  });

  /**
   * The measurement that makes the branch load-bearing: `IS NOT DISTINCT FROM` is the one operator
   * matching NULL to NULL, and with a **bound parameter** — which is how a store issues it — it is a
   * sequential scan. 10.67 ms against 0.73 ms on 45k rows, and 24.7 ms against 1.7 ms. With a
   * *literal* NULL it is index-scanned, because Postgres constant-folds it, so the penalty is
   * invisible in a psql session and real in production.
   */
  it("never uses IS NOT DISTINCT FROM, in either arm", () => {
    expect(scopeFilter(TENANT).sql).not.toContain("IS NOT DISTINCT FROM");
    expect(scopeFilter(null).sql).not.toContain("IS NOT DISTINCT FROM");
    expect(scopeFilterWithPlatform(TENANT).sql).not.toContain("IS NOT DISTINCT FROM");
  });

  it("refuses a tenantId that could not be one, in both functions", () => {
    expect(() => scopeFilter("'; DROP TABLE meta.audit_log; --")).toThrow(/invalid tenantId/);
    expect(() => scopeFilterWithPlatform("'; DROP TABLE meta.audit_log; --")).toThrow(
      /invalid tenantId/,
    );
  });

  it("keeps the message every package's tests already match on", () => {
    // Seven of the eight copies spelled this exact string; moving it must not break their asserts.
    expect(() => assertScopeTenantId("not a tenant")).toThrow(
      /invalid tenantId for RLS context/,
    );
    expect(() => assertScopeTenantId(TENANT)).not.toThrow();
  });
});

describe("scopeFilterWithPlatform", () => {
  it("keeps the platform's rows in a tenant's answer, as an OR of two indexable arms", () => {
    expect(scopeFilterWithPlatform(TENANT)).toEqual({
      sql: "(tenant_id = $1 OR tenant_id IS NULL)",
      params: [TENANT],
    });
  });

  /**
   * For the platform scope the two functions agree, and that is the arm the defect was always in: a
   * platform read is the one that was being handed a tenant's row.
   */
  it("agrees with the strict form on the platform scope", () => {
    expect(scopeFilterWithPlatform(null)).toEqual(scopeFilter(null));
  });

  it("contains the strict form as a substring, which a SQL-matching fake must read OR-first", () => {
    // `(tenant_id = $1 OR tenant_id IS NULL)` contains `tenant_id = $1`, so a fake that tests for
    // the strict spelling first silently drops the platform rows the OR exists to keep.
    expect(scopeFilterWithPlatform(TENANT, 1).sql).toContain(scopeFilter(TENANT, 1).sql);
  });

  it("places its parameter where the caller says", () => {
    expect(scopeFilterWithPlatform(TENANT, 3).sql).toBe(
      "(tenant_id = $3 OR tenant_id IS NULL)",
    );
  });
});
