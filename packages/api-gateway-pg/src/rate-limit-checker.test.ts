import type { IncomingRequest, RouteDefinition } from "@crossengin/api-gateway";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import type { DecisionSchemaProbe } from "./decision-schema-probe.js";
import {
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./pipeline-execution-store.js";
import {
  PostgresRateLimitChecker,
  type DecisionPersistFailure,
  type UndeclaredPolicyReport,
} from "./rate-limit-checker.js";
import { declareRateLimitPolicies } from "./rate-limit-policy.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";

const POLICIES = declareRateLimitPolicies({
  defaultPolicy: { policyId: "rlp_defaultpolicy", limit: 3, windowSeconds: 60 },
  policies: [{ policyId: "rlp_strictwrites", limit: 1, windowSeconds: 1 }],
});

function fixtureRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    id: "rt_route0001",
    operationId: "tenants.create",
    method: "POST",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "tenants" },
    ],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
    ...overrides,
  };
}

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

const PATCHED_COLUMNS = [
  { column_name: "policy_id", udt_name: "text" },
  { column_name: "principal_id", udt_name: "text" },
];

/**
 * A fake that **models the scope**, per ADR-0334: the previous recorder answered `{rowCount: 1}` to
 * every statement, so a write issued with no tenant context and no platform elevation looked
 * identical to one issued correctly — and a table's owner bypasses RLS, so only a non-owner
 * deployment would ever have found out.
 */
function mockConnection(opts: {
  readonly capture?: Captured[];
  readonly columns?: readonly Record<string, unknown>[];
  readonly failInsert?: Error;
  readonly failProbe?: Error;
  readonly scoped?: { value: boolean };
} = {}): PgConnection {
  const scoped = opts.scoped ?? { value: false };
  const self = (): PgConnection => ({
    query: vi.fn(async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      opts.capture?.push({ sql, params });
      if (sql.includes("information_schema.columns")) {
        if (opts.failProbe !== undefined) throw opts.failProbe;
        return {
          rows: (opts.columns ?? PATCHED_COLUMNS) as readonly Record<string, unknown>[],
          rowCount: (opts.columns ?? PATCHED_COLUMNS).length,
        };
      }
      if (sql.includes("set_config")) {
        scoped.value = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO meta.rate_limit_decisions")) {
        if (!scoped.value) {
          throw new Error(
            "unscoped write to meta.rate_limit_decisions: no tenant context and no platform elevation was claimed",
          );
        }
        if (opts.failInsert !== undefined) throw opts.failInsert;
      }
      return { rows: [], rowCount: 1 };
    }) as PgConnection["query"],
    // `scopedWrite` runs its write inside a transaction, so a fake whose `transaction` returns
    // undefined silently drops the statement under test. The scope flag is shared with the outer
    // connection so the elevation set inside the transaction is visible to the INSERT's check.
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(self())) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  });
  return self();
}

const REQ = {} as IncomingRequest;
const NOW = new Date("2026-05-16T12:00:00.000Z");

function readyProbe(overrides: Partial<DecisionSchemaProbe> = {}): DecisionSchemaProbe {
  return {
    policyColumn: "text",
    principalColumn: "text",
    quotaColumnPresent: false,
    ready: true,
    defects: [],
    remediationSql: [],
    ...overrides,
  };
}

describe("PostgresRateLimitChecker.check — allow vs deny", () => {
  it("allows requests up to the declared limit", async () => {
    const checker = new PostgresRateLimitChecker({ conn: mockConnection(), policies: POLICIES });
    for (let i = 0; i < 3; i++) {
      const d = await checker.check({
        tenantId: TENANT,
        principalId: USER,
        route: fixtureRoute(),
        request: REQ,
        now: NOW,
      });
      expect(d.allowed).toBe(true);
      expect(d.limit).toBe(3);
    }
  });

  it("denies the request after the limit and sets retryAfter", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      policies: declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_onlyoneplease", limit: 1, windowSeconds: 60 },
      }),
    });
    const route = fixtureRoute();
    await checker.check({ tenantId: TENANT, principalId: USER, route, request: REQ, now: NOW });
    const d = await checker.check({ tenantId: TENANT, principalId: USER, route, request: REQ, now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
    expect(d.decisionId).toMatch(/^rld_[0-9a-z]{20}$/);
  });

  it("resets the window when the timestamp moves past the policy's windowSeconds", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      policies: declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_onlyoneplease", limit: 1, windowSeconds: 60 },
      }),
    });
    const route = fixtureRoute();
    const later = new Date("2026-05-16T12:02:00.000Z");
    const a = await checker.check({ tenantId: TENANT, principalId: USER, route, request: REQ, now: NOW });
    const b = await checker.check({ tenantId: TENANT, principalId: USER, route, request: REQ, now: NOW });
    const c = await checker.check({ tenantId: TENANT, principalId: USER, route, request: REQ, now: later });
    expect([a.allowed, b.allowed, c.allowed]).toEqual([true, false, true]);
  });

  it("computes per-scope buckets (different operationIds are independent)", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      policies: declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_onlyoneplease", limit: 1, windowSeconds: 60 },
      }),
    });
    const r1 = fixtureRoute();
    const r2 = fixtureRoute({ id: "rt_route0002", operationId: "tenants.list" });
    const a = await checker.check({ tenantId: TENANT, principalId: USER, route: r1, request: REQ, now: NOW });
    const b = await checker.check({ tenantId: TENANT, principalId: USER, route: r2, request: REQ, now: NOW });
    expect([a.allowed, b.allowed]).toEqual([true, true]);
  });
});

describe("PostgresRateLimitChecker — the declared policy", () => {
  it("applies the policy a route names in preference to the default", async () => {
    const checker = new PostgresRateLimitChecker({ conn: mockConnection(), policies: POLICIES });
    const route = fixtureRoute({ rateLimitPolicyId: "rlp_strictwrites" });
    const a = await checker.check({ tenantId: TENANT, principalId: USER, route, request: REQ, now: NOW });
    const b = await checker.check({ tenantId: TENANT, principalId: USER, route, request: REQ, now: NOW });
    expect(a.limit).toBe(1);
    expect(b.allowed).toBe(false);
  });

  it("writes the rlp_ id of the policy it applied — the column that was hardcoded NULL", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
    });
    await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: fixtureRoute({ rateLimitPolicyId: "rlp_strictwrites" }),
      request: REQ,
      now: NOW,
    });
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
    expect(insert?.params?.[2]).toBe("rlp_strictwrites");
  });

  it("writes the default policy's id for a route that names none", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
    });
    await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
    expect(insert?.params?.[2]).toBe("rlp_defaultpolicy");
  });

  it("names no quota_definition_id column at all, since nothing can fill it", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
    });
    await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
    expect(insert?.sql).not.toContain("quota_definition_id");
  });

  it("buckets per policy, so moving a route to another policy does not inherit the old window", async () => {
    const checker = new PostgresRateLimitChecker({ conn: mockConnection(), policies: POLICIES });
    const strict = fixtureRoute({ rateLimitPolicyId: "rlp_strictwrites" });
    const plain = fixtureRoute();
    await checker.check({ tenantId: TENANT, principalId: USER, route: strict, request: REQ, now: NOW });
    const d = await checker.check({ tenantId: TENANT, principalId: USER, route: plain, request: REQ, now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(2);
  });

  it("policyFor answers which policy governs a route without deciding", async () => {
    const checker = new PostgresRateLimitChecker({ conn: mockConnection(), policies: POLICIES });
    expect(checker.policyFor({ route: fixtureRoute() })?.policyId).toBe("rlp_defaultpolicy");
    expect(checker.policyFor({ route: null })?.policyId).toBe("rlp_defaultpolicy");
    expect(checker.policyFor({ route: fixtureRoute({ rateLimitPolicyId: "rlp_nosuchpolicy" }) })).toBeNull();
  });
});

describe("PostgresRateLimitChecker — an undeclared policy", () => {
  it("denies the request rather than falling back to the default", async () => {
    const reports: UndeclaredPolicyReport[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      policies: POLICIES,
      onUndeclaredPolicy: (r) => reports.push(r),
    });
    const d = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: fixtureRoute({ rateLimitPolicyId: "rlp_nosuchpolicy" }),
      request: REQ,
      now: NOW,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("policy_undeclared_rlp_nosuchpolicy");
    expect(reports).toEqual([{ policyId: "rlp_nosuchpolicy", operationId: "tenants.create" }]);
  });

  it("writes no decision row, because every NOT NULL figure would have to be invented", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
      onUndeclaredPolicy: () => undefined,
    });
    await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: fixtureRoute({ rateLimitPolicyId: "rlp_nosuchpolicy" }),
      request: REQ,
      now: NOW,
    });
    expect(capture).toHaveLength(0);
  });

  it("still mints a decision id, so the pipeline execution can name the refusal", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      policies: POLICIES,
      onUndeclaredPolicy: () => undefined,
    });
    const d = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: fixtureRoute({ rateLimitPolicyId: "rlp_nosuchpolicy" }),
      request: REQ,
      now: NOW,
    });
    expect(d.decisionId).toMatch(/^rld_[0-9a-z]{20}$/);
  });
});

describe("PostgresRateLimitChecker — decision persistence", () => {
  it("inserts a rate_limit_decisions row by default", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
    });
    await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
    expect(insert).toBeDefined();
    expect(insert?.params?.[1]).toBe(TENANT);
    expect(insert?.params?.[4]).toBe(USER);
    expect(insert?.params?.[7]).toBe("allowed");
  });

  it("writes denied_rate_limit_exceeded outcome when denied", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: declareRateLimitPolicies({
        defaultPolicy: { policyId: "rlp_onlyoneplease", limit: 1, windowSeconds: 60 },
      }),
      schema: readyProbe(),
    });
    const route = fixtureRoute();
    await checker.check({ tenantId: TENANT, principalId: USER, route, request: REQ, now: NOW });
    capture.length = 0;
    await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route,
      request: REQ,
      now: new Date("2026-05-16T12:00:01.000Z"),
    });
    const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
    expect(insert?.params?.[7]).toBe("denied_rate_limit_exceeded");
  });

  it("skips persistence when persistDecisions=false", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      persistDecisions: false,
    });
    await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    expect(capture).toHaveLength(0);
  });

  it("keeps ON CONFLICT DO NOTHING, which is correct for an id minted per decision", () => {
    // Pinned so nobody "completes" ADR-0333's DO NOTHING sweep into this statement: the conflict
    // means "write this once", as in PostgresDrReadinessStore, not "advance this row".
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
    });
    return checker
      .check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW })
      .then(() => {
        const insert = capture.find((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
        expect(insert?.sql).toContain("ON CONFLICT (decision_id) DO NOTHING");
      });
  });
});

describe("PostgresRateLimitChecker — a failed write is reported, never thrown", () => {
  it("returns the decision even when the INSERT raises", async () => {
    // `GatewayRuntime.handleRequest` runs its stages in a bare loop with no try/catch, so a
    // rejection here escapes the whole pipeline: the request gets no problem document and no
    // PipelineExecution. This is the live failure mode of the FK into the unwritten meta.users.
    const failures: DecisionPersistFailure[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({
        failInsert: new Error(
          'insert or update on table "rate_limit_decisions" violates foreign key constraint "rate_limit_decisions_principal_id_fkey"',
        ),
      }),
      policies: POLICIES,
      schema: readyProbe(),
      onPersistFailure: (f) => failures.push(f),
    });
    const d = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: fixtureRoute(),
      request: REQ,
      now: NOW,
    });
    expect(d.allowed).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.defect).toBe("statement_failed");
    expect(failures[0]?.detail).toMatch(/principal_id_fkey/);
    expect(failures[0]?.decisionId).toBe(d.decisionId);
  });

  it("reports and continues when the schema probe itself fails", async () => {
    const failures: DecisionPersistFailure[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ failProbe: new Error("terminating connection") }),
      policies: POLICIES,
      onPersistFailure: (f) => failures.push(f),
    });
    const d = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: fixtureRoute(),
      request: REQ,
      now: NOW,
    });
    expect(d.allowed).toBe(true);
    expect(failures[0]?.detail).toMatch(/schema probe failed/);
  });

  it("re-probes after a failed probe rather than memoising an unreachable catalog", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture, failProbe: new Error("down") }),
      policies: POLICIES,
      onPersistFailure: () => undefined,
    });
    await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    expect(capture.filter((c) => c.sql.includes("information_schema.columns"))).toHaveLength(2);
  });
});

describe("PostgresRateLimitChecker — the schema probe", () => {
  it("probes once and reuses the answer, so the request path pays one round trip", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({ conn: mockConnection({ capture }), policies: POLICIES });
    for (let i = 0; i < 3; i++) {
      await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    }
    expect(capture.filter((c) => c.sql.includes("information_schema.columns"))).toHaveLength(1);
  });

  it("does not probe at all when the caller supplies a boot survey's answer", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
    });
    await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    expect(capture.some((c) => c.sql.includes("information_schema.columns"))).toBe(false);
  });

  it("writes nothing against an unpatched catalog and names the SQL to run", async () => {
    const capture: Captured[] = [];
    const failures: DecisionPersistFailure[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({
        capture,
        columns: [
          { column_name: "policy_id", udt_name: "uuid" },
          { column_name: "principal_id", udt_name: "uuid" },
        ],
      }),
      policies: POLICIES,
      onPersistFailure: (f) => failures.push(f),
    });
    const d = await checker.check({
      tenantId: TENANT,
      principalId: USER,
      route: fixtureRoute(),
      request: REQ,
      now: NOW,
    });
    expect(d.allowed).toBe(true);
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"))).toBe(false);
    expect(failures[0]?.defect).toBe("schema_unready");
    expect(failures[0]?.detail).toMatch(/ALTER TABLE meta\.rate_limit_decisions ALTER COLUMN policy_id TYPE TEXT/);
  });

  it("drops the principal and says so once when only principal_id lags", async () => {
    const capture: Captured[] = [];
    const failures: DecisionPersistFailure[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({
        capture,
        columns: [
          { column_name: "policy_id", udt_name: "text" },
          { column_name: "principal_id", udt_name: "uuid" },
        ],
      }),
      policies: POLICIES,
      onPersistFailure: (f) => failures.push(f),
    });
    for (let i = 0; i < 3; i++) {
      await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    }
    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"));
    expect(inserts).toHaveLength(3);
    for (const insert of inserts) expect(insert.params?.[4]).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toMatch(/principal attribution dropped/);
  });

  it("does not report attribution loss when there was no principal to lose", async () => {
    const failures: DecisionPersistFailure[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({
        columns: [
          { column_name: "policy_id", udt_name: "text" },
          { column_name: "principal_id", udt_name: "uuid" },
        ],
      }),
      policies: POLICIES,
      onPersistFailure: (f) => failures.push(f),
    });
    await checker.check({ tenantId: null, principalId: null, route: fixtureRoute(), request: REQ, now: NOW });
    expect(failures).toHaveLength(0);
  });
});

describe("PostgresRateLimitChecker — the platform write arm", () => {
  it("claims app.platform_record_write before persisting an anonymous (platform-scope) decision", async () => {
    // `RateLimitCheckInput.tenantId` is nullable and an unauthenticated request has none, so a
    // platform-scope decision row is the ordinary case on this path rather than an edge one — and
    // under the old single `ALL`-scope policy any tenant session could forge one.
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
    });
    await checker.check({ tenantId: null, principalId: null, route: fixtureRoute(), request: REQ, now: NOW });
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.rate_limit_decisions"))).toBe(true);
  });

  it("claims the tenant context instead for a tenant-scope decision, never both", async () => {
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      schema: readyProbe(),
    });
    await checker.check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW });
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);
  });

  it("claims nothing when persistence is off", async () => {
    // No write, so no elevation: the setting rides with the statement that needs it rather than
    // with the call.
    const capture: Captured[] = [];
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection({ capture }),
      policies: POLICIES,
      persistDecisions: false,
    });
    await checker.check({ tenantId: null, principalId: null, route: fixtureRoute(), request: REQ, now: NOW });
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });
});

describe("PostgresRateLimitChecker — decisionId format", () => {
  const one = (checker: PostgresRateLimitChecker): Promise<string> =>
    checker
      .check({ tenantId: TENANT, principalId: USER, route: fixtureRoute(), request: REQ, now: NOW })
      .then((d) => d.decisionId);

  it("starts the counter from idSeed", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      policies: POLICIES,
      idSeed: 41,
    });
    expect(await one(checker)).toMatch(/^rld_[0-9a-z]{20}$/);
  });

  it("is 20 characters wide, so the catalog CHECK and anything reading by length are unaffected", async () => {
    const checker = new PostgresRateLimitChecker({ conn: mockConnection(), policies: POLICIES });
    const id = await one(checker);
    expect(id).toMatch(/^rld_[a-z0-9]{8,40}$/); // the catalog's own check
    expect(id).toHaveLength(24);
  });

  it("two instances do not mint the same id — the collision that silently dropped a replica's rows", async () => {
    // Reproduced live before this fix: three rows from the first process, zero from the second,
    // no error either time, because `ON CONFLICT (decision_id) DO NOTHING` swallowed every one.
    const a = new PostgresRateLimitChecker({ conn: mockConnection(), policies: POLICIES });
    const b = new PostgresRateLimitChecker({ conn: mockConnection(), policies: POLICIES });
    expect(await one(a)).not.toBe(await one(b));
  });

  it("across many instances the first id is always distinct", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(
        await one(new PostgresRateLimitChecker({ conn: mockConnection(), policies: POLICIES })),
      );
    }
    expect(ids.size).toBe(50);
  });

  it("is monotonic within one instance and shares its prefix", async () => {
    const checker = new PostgresRateLimitChecker({
      conn: mockConnection(),
      policies: POLICIES,
      instanceId: "abcdefgh0123",
    });
    const first = await one(checker);
    const second = await one(checker);
    expect(first).toBe("rld_abcdefgh012300000001");
    expect(second).toBe("rld_abcdefgh012300000002");
    expect(second > first).toBe(true);
  });

  it("refuses an instanceId of the wrong width or alphabet", () => {
    for (const bad of ["short", "ABCDEFGH0123", "abcdefgh01234", "abcdefg-0123"]) {
      expect(
        () =>
          new PostgresRateLimitChecker({
            conn: mockConnection(),
            policies: POLICIES,
            instanceId: bad,
          }),
      ).toThrow(/instanceId/);
    }
  });
});
