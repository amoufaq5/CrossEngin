import { describe, expect, it } from "vitest";

import {
  CHAIN_SCOPE_COVERAGES,
  CHAIN_SCOPE_TENANT_STATUSES,
  COVERAGE_REACHES_A_TENANT,
  chainScopeStatuses,
  formatChainScopes,
  surveyChainScopes,
  type ChainScopeCoverage,
} from "./chain-scope-survey.js";
import { CheckpointConfigSchema, configScopes } from "./checkpoint-scheduler.js";
import { IntegrityProofConfigSchema, integrityConfigScopes } from "./integrity-proof.js";
import { TENANT_STATUSES } from "./platform-tenants.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

const input = (over: Partial<Parameters<typeof surveyChainScopes>[0]> = {}) =>
  surveyChainScopes({
    allTenants: false,
    staticScopes: [],
    includePlatform: false,
    intervalMs: 3_600_000,
    tenantStatuses: CHAIN_SCOPE_TENANT_STATUSES,
    ...over,
  });

describe("CHAIN_SCOPE_TENANT_STATUSES", () => {
  it("is every tenant status and is derived rather than listed", () => {
    // Derived, so a sixth status is covered by arriving — ADR-0334's reason `TenantCounts` is
    // derived, which is how that census came to omit `pending_deletion` while counting it.
    expect([...CHAIN_SCOPE_TENANT_STATUSES].sort()).toEqual([...TENANT_STATUSES].sort());
    expect(CHAIN_SCOPE_TENANT_STATUSES.length).toBeGreaterThanOrEqual(5);
  });

  it("includes the four statuses the chain tables are retained FOR", () => {
    // The finding: `PostgresTenantSource` defaults to `['active']`, so with that default the two
    // passes never cover a suspended, archived, `pending_deletion` or `deleted` tenant — while all
    // four chain tables are `PLATFORM_RECORD_TABLES` members, kept precisely so an auditor can read
    // them after the tenant is gone. `pending_deletion` is the status whose data is about to be
    // destroyed and `deleted` is the status the retention set exists for.
    for (const status of ["suspended", "archived", "pending_deletion", "deleted"]) {
      expect(CHAIN_SCOPE_TENANT_STATUSES).toContain(status);
    }
  });
});

describe("chainScopeStatuses", () => {
  it("silence buys the wide set, which is the fix and not a preference", () => {
    expect(chainScopeStatuses(undefined)).toEqual(CHAIN_SCOPE_TENANT_STATUSES);
  });

  it("honours an explicit narrow set", () => {
    expect(chainScopeStatuses(["active"])).toEqual(["active"]);
  });

  it("is the ONE spelling: both schemas leave the field optional so this decides", () => {
    // If either schema grew a `z.default()`, `undefined` would stop reaching here and this helper
    // would silently stop being the decision — so the absence is asserted rather than assumed.
    expect(CheckpointConfigSchema.parse({}).tenantStatuses).toBeUndefined();
    expect(IntegrityProofConfigSchema.parse({}).tenantStatuses).toBeUndefined();
    expect(chainScopeStatuses(CheckpointConfigSchema.parse({}).tenantStatuses)).toEqual(
      CHAIN_SCOPE_TENANT_STATUSES,
    );
  });
});

describe("surveyChainScopes", () => {
  it("an EMPTY config covers the platform chain only — the finding", () => {
    // Driven through the real `configScopes`, which is the regression test: an empty config resolves
    // to `[null]`, so a pass mounted over `{}` reads the platform chain and not one tenant's.
    const config = CheckpointConfigSchema.parse({});
    const survey = surveyChainScopes({
      allTenants: config.allTenants,
      staticScopes: configScopes(config),
      includePlatform: config.includePlatform,
      intervalMs: config.intervalMs,
      tenantStatuses: chainScopeStatuses(config.tenantStatuses),
    });
    expect(configScopes(config)).toEqual([null]);
    expect(survey.coverage).toBe("platform_only");
    expect(survey.namedTenants).toBe(0);
    expect(survey.includesPlatform).toBe(true);
    expect(COVERAGE_REACHES_A_TENANT[survey.coverage]).toBe(false);
  });

  it("the integrity proof's own resolver answers the same for an empty config", () => {
    const config = IntegrityProofConfigSchema.parse({});
    expect(integrityConfigScopes(config)).toEqual([null]);
    const survey = surveyChainScopes({
      allTenants: config.allTenants,
      staticScopes: integrityConfigScopes(config),
      includePlatform: config.includePlatform,
      intervalMs: config.intervalMs,
      tenantStatuses: chainScopeStatuses(config.tenantStatuses),
    });
    expect(survey.coverage).toBe("platform_only");
  });

  it("allTenants reaches every tenant, and the platform rides along iff includePlatform", () => {
    expect(input({ allTenants: true, includePlatform: true }).coverage).toBe("every_active_tenant");
    expect(input({ allTenants: true, includePlatform: true }).includesPlatform).toBe(true);
    expect(input({ allTenants: true, includePlatform: false }).includesPlatform).toBe(false);
    // Under `allTenants` the static list is not read, so a stale `tenants` entry contributes no
    // named count — which is what `tenantSourceScopes` does.
    expect(input({ allTenants: true, staticScopes: [TENANT_A] }).namedTenants).toBe(0);
  });

  it("a static tenant list is named_tenants, counting tenants and not the platform entry", () => {
    const survey = input({ staticScopes: [TENANT_A, TENANT_B, null] });
    expect(survey.coverage).toBe("named_tenants");
    expect(survey.namedTenants).toBe(2);
    expect(survey.includesPlatform).toBe(true);
  });

  it("an empty scope list is `nothing`", () => {
    expect(input({ staticScopes: [] }).coverage).toBe("nothing");
  });

  it("a real config naming tenants resolves through the real resolver", () => {
    const config = CheckpointConfigSchema.parse({ tenants: [TENANT_A], includePlatform: false });
    const survey = surveyChainScopes({
      allTenants: config.allTenants,
      staticScopes: configScopes(config),
      includePlatform: config.includePlatform,
      intervalMs: config.intervalMs,
      tenantStatuses: chainScopeStatuses(config.tenantStatuses),
    });
    expect(survey.coverage).toBe("named_tenants");
    expect(survey.namedTenants).toBe(1);
    expect(survey.includesPlatform).toBe(false);
  });
});

describe("COVERAGE_REACHES_A_TENANT", () => {
  it("is a total map and partitions the coverages", () => {
    expect(Object.keys(COVERAGE_REACHES_A_TENANT).sort()).toEqual([...CHAIN_SCOPE_COVERAGES].sort());
    const reaching = CHAIN_SCOPE_COVERAGES.filter((c) => COVERAGE_REACHES_A_TENANT[c]);
    const not = CHAIN_SCOPE_COVERAGES.filter((c) => !COVERAGE_REACHES_A_TENANT[c]);
    expect(reaching.length + not.length).toBe(CHAIN_SCOPE_COVERAGES.length);
    expect([...not].sort()).toEqual(["nothing", "platform_only"]);
  });
});

describe("formatChainScopes", () => {
  it("every coverage gets its own sentence, and none is an echo of its key", () => {
    // "none restates its own key" was the first form of this and it is the wrong assertion: the
    // `nothing` arm's sentence legitimately contains the English word *nothing* ("the pass will
    // fire and read nothing"), so the crude form failed on a correct line. What is worth fencing is
    // that a sentence is not a bare echo — so: no line carries an enum key's `snake_case` spelling,
    // and the four lines are pairwise distinct, which a default-arm fall-through would break.
    const lines = new Set<string>();
    for (const coverage of CHAIN_SCOPE_COVERAGES) {
      const line = formatChainScopes("scope", {
        coverage,
        namedTenants: coverage === "named_tenants" ? 2 : 0,
        includesPlatform: true,
        intervalMs: 3_600_000,
        tenantStatuses: CHAIN_SCOPE_TENANT_STATUSES,
      });
      expect(line.startsWith("scope: ")).toBe(true);
      expect(line).toContain("3600s");
      for (const key of CHAIN_SCOPE_COVERAGES.filter((k) => k.includes("_"))) {
        expect(line).not.toContain(key);
      }
      lines.add(line);
    }
    expect(lines.size).toBe(CHAIN_SCOPE_COVERAGES.length);
  });

  it("names a remedy on the arms where one exists, and only there", () => {
    const remedied: ChainScopeCoverage[] = ["named_tenants", "platform_only", "nothing"];
    for (const coverage of CHAIN_SCOPE_COVERAGES) {
      const line = formatChainScopes("scope", {
        coverage,
        namedTenants: 1,
        includesPlatform: false,
        intervalMs: 1000,
        tenantStatuses: ["active"],
      });
      expect(line.includes("allTenants")).toBe(remedied.includes(coverage));
    }
  });

  it("names the status set on the allTenants arm, where the population is a runtime answer", () => {
    const line = formatChainScopes("scope", {
      coverage: "every_active_tenant",
      namedTenants: 0,
      includesPlatform: true,
      intervalMs: 3_600_000,
      tenantStatuses: ["active", "deleted"],
    });
    expect(line).toContain("active/deleted");
    // And the narrow set is visible as such, which is the whole point of naming it: an operator
    // reading `status active` can see that a retired tenant's trail is not covered.
    const narrow = formatChainScopes("scope", {
      coverage: "every_active_tenant",
      namedTenants: 0,
      includesPlatform: false,
      intervalMs: 1000,
      tenantStatuses: ["active"],
    });
    expect(narrow).toContain("status active,");
  });

  it("says nothing about statuses on an arm that applies no status filter", () => {
    // A status set beside a static tenant list would describe a filter that arm does not apply.
    for (const coverage of ["named_tenants", "platform_only", "nothing"] as const) {
      const line = formatChainScopes("scope", {
        coverage,
        namedTenants: 1,
        includesPlatform: true,
        intervalMs: 1000,
        tenantStatuses: ["active", "deleted"],
      });
      expect(line).not.toContain("active/deleted");
    }
  });

  it("the platform clause tracks includesPlatform", () => {
    expect(
      formatChainScopes("scope", {
        coverage: "every_active_tenant",
        namedTenants: 0,
        includesPlatform: false,
        intervalMs: 1000,
        tenantStatuses: ["active"],
      }),
    ).not.toContain("platform");
    expect(
      formatChainScopes("scope", {
        coverage: "every_active_tenant",
        namedTenants: 0,
        includesPlatform: true,
        intervalMs: 1000,
        tenantStatuses: ["active"],
      }),
    ).toContain("the platform chain");
  });
});
