import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { META_TABLES } from "@crossengin/kernel/bootstrap";

import { rowsResult } from "./node-pg.js";

import {
  PG_CHANNEL_ASSURANCES,
  PG_CHANNEL_ASSURANCE_DESCRIPTIONS,
  PG_SSL_MODES,
  PLATFORM_WRITE_GRANTS,
  isPgSslMode,
  isoCalendarDate,
  isoInstant,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
  pgChannelAssurance,
  requireIsoInstant,
  assertScopeTenantId,
  scopeFilter,
  scopeFilterWithPlatform,
  setPlatformWriteSql,
  sslModeRequiresTls,
  sslModeValidatesCertificate,
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

  it("threads every mode but verify-ca through unchanged", () => {
    for (const mode of PG_SSL_MODES) {
      if (mode === "verify-ca") continue;
      expect(parsePgEnvConfig({ ...baseEnv, PGSSLMODE: mode }).ssl).toBe(mode);
    }
  });

  it("refuses PGSSLMODE=verify-ca by name", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "verify-ca" })).toThrow(
      /PGSSLMODE=verify-ca is refused/,
    );
  });

  it("says verification is not implemented and that no CA material is read", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "verify-ca" })).toThrow(
      /verification is not implemented/,
    );
    expect(() => parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "verify-ca" })).toThrow(/PGSSLROOTCERT/);
  });

  it("names verify-full as the mode that does validate", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "verify-ca" })).toThrow(
      /PGSSLMODE=verify-full/,
    );
  });

  // The two refusals must stay distinguishable: a typo and a mode this binding declines to serve
  // send an operator to different places, so the verify-ca message must not read as "not recognized".
  it("does not report verify-ca as unrecognized", () => {
    expect(() => parsePgEnvConfig({ ...baseEnv, PGSSLMODE: "verify-ca" })).not.toThrow(
      /not recognized/,
    );
  });

  it("defaults to a plaintext-capable mode, and says so", () => {
    expect(pgChannelAssurance(parsePgEnvConfig(baseEnv).ssl)).toBe("plaintext_possible");
  });
});

describe("PG_SSL_MODES", () => {
  it("lists libpq's six modes in ascending order of what they promise", () => {
    expect(PG_SSL_MODES).toEqual([
      "disable",
      "allow",
      "prefer",
      "require",
      "verify-ca",
      "verify-full",
    ]);
  });

  it("keeps verify-ca, which the parse refuses, so the maps can answer for it", () => {
    expect(PG_SSL_MODES).toContain("verify-ca");
    expect(pgChannelAssurance("verify-ca")).toBe("encrypted_unauthenticated");
  });
});

describe("isPgSslMode", () => {
  it("accepts every declared mode", () => {
    for (const mode of PG_SSL_MODES) {
      expect(isPgSslMode(mode)).toBe(true);
    }
  });

  it("rejects an unknown mode", () => {
    expect(isPgSslMode("bogus")).toBe(false);
    expect(isPgSslMode("")).toBe(false);
  });

  it("compares case-sensitively, as libpq does", () => {
    expect(isPgSslMode("Require")).toBe(false);
    expect(isPgSslMode("VERIFY-FULL")).toBe(false);
  });
});

describe("pgChannelAssurance", () => {
  it("calls the three modes that may proceed without TLS plaintext_possible", () => {
    expect(pgChannelAssurance("disable")).toBe("plaintext_possible");
    expect(pgChannelAssurance("allow")).toBe("plaintext_possible");
    expect(pgChannelAssurance("prefer")).toBe("plaintext_possible");
  });

  it("calls require encrypted_unauthenticated", () => {
    expect(pgChannelAssurance("require")).toBe("encrypted_unauthenticated");
  });

  it("calls verify-full authenticated", () => {
    expect(pgChannelAssurance("verify-full")).toBe("authenticated");
  });

  it("answers for every mode with a declared assurance", () => {
    for (const mode of PG_SSL_MODES) {
      expect(PG_CHANNEL_ASSURANCES).toContain(pgChannelAssurance(mode));
    }
  });
});

describe("PG_CHANNEL_ASSURANCE_DESCRIPTIONS", () => {
  it("carries exactly the three assurances", () => {
    expect(Object.keys(PG_CHANNEL_ASSURANCE_DESCRIPTIONS).sort()).toEqual(
      [...PG_CHANNEL_ASSURANCES].sort(),
    );
  });

  // A description that only restates its own key tells an operator nothing they did not already
  // have from the enum member's name.
  it("describes rather than restating its own key", () => {
    for (const assurance of PG_CHANNEL_ASSURANCES) {
      const text = PG_CHANNEL_ASSURANCE_DESCRIPTIONS[assurance];
      expect(text.length).toBeGreaterThan(assurance.length);
      expect(text).not.toContain(assurance);
    }
  });
});

describe("sslModeValidatesCertificate", () => {
  it("is true for verify-full alone", () => {
    expect(sslModeValidatesCertificate("verify-full")).toBe(true);
    expect(PG_SSL_MODES.filter((mode) => sslModeValidatesCertificate(mode))).toEqual([
      "verify-full",
    ]);
  });

  // The defect this refusal exists for: the mode whose purpose is to validate the CA validates
  // nothing, so the predicate must not flatter it.
  it("is false for verify-ca", () => {
    expect(sslModeValidatesCertificate("verify-ca")).toBe(false);
  });

  it("is false for the plaintext-capable modes", () => {
    expect(sslModeValidatesCertificate("disable")).toBe(false);
    expect(sslModeValidatesCertificate("allow")).toBe(false);
    expect(sslModeValidatesCertificate("prefer")).toBe(false);
    expect(sslModeValidatesCertificate("require")).toBe(false);
  });

  it("agrees with the assurance it is derived from, for every mode", () => {
    for (const mode of PG_SSL_MODES) {
      expect(sslModeValidatesCertificate(mode)).toBe(pgChannelAssurance(mode) === "authenticated");
    }
  });

  // This is the fence on the measurement the map rests on. `createNodePgConnection` is what decides
  // whether a mode validates anything, and the refusal above exists *because* of what it asks of
  // node's TLS stack — so it must ask it through the predicate rather than restating the judgement.
  //
  // Asserted as a **call plus the absence of the literal**, which is stronger than pinning the
  // literal was: an inline `config.ssl === "verify-full"` beside this map is a second spelling of
  // one judgement, and two spellings can disagree about one mode invisibly, because the predicate
  // gates a refusal while the assurance gates what an operator is told. Read as text rather than by
  // behaviour because `createNodePgConnection` constructs a real `Pool` on the first line, so there
  // is nothing to inspect without a server to connect to.
  it("reads both judgements from this module rather than restating them", () => {
    const source = readFileSync(fileURLToPath(new URL("./node-pg.ts", import.meta.url)), "utf8");
    expect(source).toContain("rejectUnauthorized: sslModeValidatesCertificate(config.ssl)");
    expect(source).toContain("sslModeRequiresTls(config.ssl)");
    // Strip comments before looking for a restatement, so the prose explaining why these
    // comparisons are gone cannot itself fail the assertion. Both are checked: `verify-full` was
    // the validation judgement, and the three-name list was the *must there be TLS* one — which
    // this test found still present after the first was converged, which is why it is here.
    const code = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain('config.ssl === "verify-full"');
    expect(code).not.toContain('config.ssl === "verify-ca"');
    expect(code).not.toContain('config.ssl === "require"');
  });

  it("is the complement of plaintext_possible, which is what lets node-pg stop listing names", () => {
    for (const mode of PG_SSL_MODES) {
      expect(sslModeRequiresTls(mode)).toBe(pgChannelAssurance(mode) !== "plaintext_possible");
    }
    expect(PG_SSL_MODES.filter(sslModeRequiresTls)).toEqual([
      "require",
      "verify-ca",
      "verify-full",
    ]);
  });

  it("answers the question sslModeValidatesCertificate does not, and require is why", () => {
    // `require` is the member that makes the two predicates distinct: TLS is mandatory and the
    // peer is unchecked. If they ever agreed on every mode, one of them would be redundant.
    expect(sslModeRequiresTls("require")).toBe(true);
    expect(sslModeValidatesCertificate("require")).toBe(false);
    expect(PG_SSL_MODES.some((m) => sslModeRequiresTls(m) !== sslModeValidatesCertificate(m))).toBe(
      true,
    );
  });

  // The one mode comparison that stays, and why. `disable`, `allow` and `prefer` share one
  // assurance — the channel may be plaintext — and differ only in *who declines*, which is the
  // distinction the assurance deliberately does not carry: `disable` passes `ssl: false` and the
  // other two pass nothing and let the server decide. So that comparison is not a duplicated
  // judgement, and a future edit that tried to derive it from the assurance would be wrong.
  it("still decides disable by name, which the assurance cannot answer", () => {
    const source = readFileSync(fileURLToPath(new URL("./node-pg.ts", import.meta.url)), "utf8");
    expect(source).toContain('config.ssl === "disable"');
    expect(pgChannelAssurance("disable")).toBe(pgChannelAssurance("prefer"));
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
