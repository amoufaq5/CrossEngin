import { describe, expect, it } from "vitest";
import {
  FlagDefinitionSchema,
  TargetingRuleSchema,
  chooseTargetingRule,
  type FlagDefinition,
  type TargetingContext,
  type TargetingRule,
} from "@crossengin/feature-flags";

import { PostgresFeatureFlagStore, flagRowValues, FEATURE_FLAG_COLUMN_NAMES } from "./flag-store.js";
import {
  SET_PLATFORM_CONFIG_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./kill-switch-store.js";
import {
  BLOCKING_TARGETING_RULE_SET_DEFECTS,
  MAX_TARGETING_RULES_PER_FLAG,
  PostgresTargetingRuleStore,
  TARGETING_RULE_COLUMNS,
  TARGETING_RULE_COLUMN_NAMES,
  TARGETING_RULE_JSONB_COLUMNS,
  TARGETING_RULE_PARAM_COUNT,
  TARGETING_RULE_SET_DEFECTS,
  TargetingRuleSetTooLargeError,
  TargetingRulesUnresolvedError,
  loadFlagWithTargeting,
  rowToTargetingRule,
  targetingRulePlaceholders,
  targetingRuleRowValues,
} from "./targeting-rule-store.js";
import {
  type Captured,
  EMPTY,
  FLAG_ID,
  T0,
  T1,
  TENANT,
  mockConnection,
  respondTo,
  written,
} from "./test-fakes.js";

const AUTHOR = "55555555-5555-4555-8555-555555555555";
const RULE_ID = "ftr_rollout1";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";

function rule(over: Record<string, unknown> = {}): TargetingRule {
  return TargetingRuleSchema.parse({
    id: RULE_ID,
    tenantId: null,
    flagId: FLAG_ID,
    priority: 10,
    label: "First ten percent",
    condition: {
      kind: "percentage_bucket",
      bucketingKey: "tenant_id",
      salt: "checkout-v2",
      minBucketInclusive: 0,
      maxBucketExclusive: 1000,
    },
    servedVariantKey: null,
    servedValueJson: "true",
    isExclusion: false,
    createdAt: T0,
    createdBy: AUTHOR,
    ...over,
  });
}

function flag(over: Record<string, unknown> = {}): FlagDefinition {
  return FlagDefinitionSchema.parse({
    id: FLAG_ID,
    tenantId: null,
    key: "checkout.new_pricing",
    kind: "boolean",
    label: "New checkout pricing",
    description: "Serves the rebuilt pricing engine on the checkout path.",
    status: "active",
    defaultValueJson: "false",
    killedValueJson: null,
    variants: [],
    environments: ["production"],
    riskLevel: "medium",
    ownerUserId: AUTHOR,
    ownerTeam: "payments",
    tags: [],
    relatedDeploymentId: null,
    relatedIncidentId: null,
    targetingRuleIds: [RULE_ID],
    requiresFourEyesToToggle: false,
    requiresIncidentToKill: false,
    expiresAt: null,
    createdAt: T0,
    createdBy: AUTHOR,
    updatedAt: T1,
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    ...over,
  });
}

/** The row a stored rule comes back as, built through the same projection the store writes. */
function ruleRow(record: TargetingRule): Record<string, unknown> {
  const values = targetingRuleRowValues(record);
  const row: Record<string, unknown> = {};
  TARGETING_RULE_COLUMN_NAMES.forEach((col, i) => {
    row[col] = values[i];
  });
  // What a real connection hands back: a `Date` for TIMESTAMPTZ and a parsed object for JSONB.
  row["created_at"] = new Date(record.createdAt);
  row["condition"] = record.condition;
  return row;
}

const ruleRows = (...records: TargetingRule[]) => ({
  rows: records.map((r) => ruleRow(r)),
  rowCount: records.length,
});

function flagRow(record: FlagDefinition): Record<string, unknown> {
  const values = flagRowValues(record);
  const row: Record<string, unknown> = {};
  FEATURE_FLAG_COLUMN_NAMES.forEach((col, i) => {
    row[col] = values[i];
  });
  return row;
}

const context = (over: Partial<TargetingContext> = {}): TargetingContext => ({
  tenantId: TENANT,
  principalId: AUTHOR,
  sessionId: "sess-1",
  tenantAttributes: {},
  principalAttributes: {},
  geoCountry: null,
  device: null,
  ...over,
});

describe("TARGETING_RULE_COLUMN_NAMES", () => {
  it("leads with rule_id, the id a flag's targetingRuleIds names", () => {
    expect(TARGETING_RULE_COLUMN_NAMES[0]).toBe("rule_id");
  });

  it("omits the surrogate id, which carries a uuid_generate_v7() default", () => {
    expect(TARGETING_RULE_COLUMN_NAMES).not.toContain("id");
  });

  it("names every column the catalog requires", () => {
    // notNull with no default in META_FEATURE_FLAG_TARGETING_RULES. Asserted here as the local
    // floor; pg-column-coverage.ts checks it against META_TABLES for the whole workspace.
    for (const required of ["rule_id", "flag_id", "priority", "label", "condition", "created_by"]) {
      expect(TARGETING_RULE_COLUMN_NAMES).toContain(required);
    }
  });

  it("names tenant_id, so a write cannot be unscoped", () => {
    expect(TARGETING_RULE_COLUMN_NAMES).toContain("tenant_id");
  });

  it("treats only condition as JSONB", () => {
    expect([...TARGETING_RULE_JSONB_COLUMNS]).toEqual(["condition"]);
  });

  it("does not store served_value_json as JSONB, which would re-serialise validated text", () => {
    expect(TARGETING_RULE_JSONB_COLUMNS.has("served_value_json")).toBe(false);
  });

  it("renders placeholders positionally with a jsonb cast only on condition", () => {
    const parts = targetingRulePlaceholders().split(", ");
    expect(parts).toHaveLength(TARGETING_RULE_COLUMN_NAMES.length);
    TARGETING_RULE_COLUMN_NAMES.forEach((col, i) => {
      expect(parts[i]).toBe(
        `$${String(i + 1)}${TARGETING_RULE_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
      );
    });
  });

  it("binds one parameter per column", () => {
    expect(TARGETING_RULE_PARAM_COUNT).toBe(TARGETING_RULE_COLUMN_NAMES.length);
    expect(targetingRuleRowValues(rule())).toHaveLength(TARGETING_RULE_PARAM_COUNT);
  });
});

describe("targetingRuleRowValues", () => {
  it("validates through the contract before binding anything", () => {
    expect(() =>
      targetingRuleRowValues({ ...rule(), priority: 5000 } as TargetingRule),
    ).toThrow();
  });

  it("serialises the condition to JSON text for the ::jsonb cast", () => {
    const values = targetingRuleRowValues(rule());
    const i = TARGETING_RULE_COLUMN_NAMES.indexOf("condition");
    expect(typeof values[i]).toBe("string");
    expect(JSON.parse(String(values[i]))).toMatchObject({ kind: "percentage_bucket" });
  });

  it("writes an absent description as NULL", () => {
    const values = targetingRuleRowValues(rule());
    expect(values[TARGETING_RULE_COLUMN_NAMES.indexOf("description")]).toBeNull();
  });
});

describe("rowToTargetingRule", () => {
  it("round-trips a rule through the row projection", () => {
    expect(rowToTargetingRule(ruleRow(rule()))).toEqual(rule());
  });

  it("reads a TIMESTAMPTZ Date into the contract's ISO text", () => {
    const row = ruleRow(rule());
    expect(row["created_at"]).toBeInstanceOf(Date);
    expect(rowToTargetingRule(row).createdAt).toBe(T0);
  });

  it("brings an absent description back as an omitted key, not null", () => {
    expect("description" in rowToTargetingRule(ruleRow(rule()))).toBe(false);
  });

  it("keeps a description that was set", () => {
    const row = ruleRow(rule({ description: "canary cohort" }));
    expect(rowToTargetingRule(row).description).toBe("canary cohort");
  });

  it("re-parses, so a row the contract forbids raises rather than being served", () => {
    const row = ruleRow(rule());
    // Both served columns set: expressible as a CHECK and not declared, so this is the only guard.
    row["served_variant_key"] = "treatment";
    expect(() => rowToTargetingRule(row)).toThrow();
  });

  it("refuses a condition whose percentage bucket range is inverted", () => {
    const row = ruleRow(rule());
    row["condition"] = {
      kind: "percentage_bucket",
      bucketingKey: "tenant_id",
      salt: "checkout-v2",
      minBucketInclusive: 900,
      maxBucketExclusive: 100,
    };
    expect(() => rowToTargetingRule(row)).toThrow();
  });

  it("refuses a row whose created_at is missing entirely", () => {
    const row = ruleRow(rule());
    row["created_at"] = null;
    expect(() => rowToTargetingRule(row)).toThrow(/missing required timestamp/);
  });
});

describe("PostgresTargetingRuleStore construction", () => {
  it("defaults to the meta schema", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).load(RULE_ID);
    expect(capture[0]?.sql).toContain("meta.feature_flag_targeting_rules");
  });

  it("honours an override schema", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY), {
      schema: "other_meta",
    }).load(RULE_ID);
    expect(capture[0]?.sql).toContain("other_meta.feature_flag_targeting_rules");
  });

  it("refuses a schema name that is not a bare identifier", () => {
    expect(
      () => new PostgresTargetingRuleStore(mockConnection(), { schema: 'meta"; DROP' }),
    ).toThrow(/invalid schema identifier/);
  });
});

describe("insert", () => {
  it("names every column and binds every value", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture)).insert(rule());
    const stmt = written(capture);
    expect(stmt.sql).toContain(`INSERT INTO meta.feature_flag_targeting_rules (${TARGETING_RULE_COLUMNS})`);
    expect(stmt.params).toEqual(targetingRuleRowValues(rule()));
  });

  it("carries no ON CONFLICT clause at all", async () => {
    // Pinned so nobody "completes" this with a DO NOTHING, which would report success for an
    // insert of different content under an id already taken (ADR-0333), or with a DO UPDATE, which
    // the table's missing platform UPDATE arm refuses — and a refused DO UPDATE returns INSERT 0 0,
    // byte-identical to DO NOTHING.
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture)).insert(rule());
    expect(written(capture).sql).not.toMatch(/ON\s+CONFLICT/i);
  });

  it("claims the platform config-write elevation for a platform-wide rule", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture)).insert(rule());
    expect(capture[0]?.sql).toBe(SET_PLATFORM_CONFIG_WRITE_SQL);
  });

  it("sets a tenant context, and not the elevation, for a tenant-scoped rule", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture)).insert(
      rule({ tenantId: TENANT }),
    );
    expect(capture[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(capture[0]?.params).toEqual([TENANT]);
    expect(capture.map((c) => c.sql)).not.toContain(SET_PLATFORM_CONFIG_WRITE_SQL);
  });

  it("refuses a tenantId that is not a scope identifier", async () => {
    await expect(
      new PostgresTargetingRuleStore(mockConnection()).insert({
        ...rule(),
        tenantId: "'; DROP TABLE",
      } as TargetingRule),
    ).rejects.toThrow();
  });
});

describe("load", () => {
  it("carries the inclusive scope predicate for a tenant", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).load(
      RULE_ID,
      TENANT,
    );
    const stmt = written(capture);
    expect(stmt.sql).toContain("(tenant_id = $2 OR tenant_id IS NULL)");
    expect(stmt.params).toEqual([RULE_ID, TENANT]);
  });

  it("asks for tenant_id IS NULL in the platform scope", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).load(RULE_ID);
    expect(written(capture).sql).toContain("tenant_id IS NULL");
    expect(written(capture).params).toEqual([RULE_ID]);
  });

  it("answers null for a rule no row carries", async () => {
    const store = new PostgresTargetingRuleStore(mockConnection(undefined, () => EMPTY));
    await expect(store.load(RULE_ID)).resolves.toBeNull();
  });

  it("re-parses the row it found", async () => {
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(rule())),
    );
    await expect(store.load(RULE_ID)).resolves.toEqual(rule());
  });
});

describe("rulesFor", () => {
  it("orders by priority then rule_id, so a tie is not decided by the plan", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).rulesFor(FLAG_ID);
    expect(written(capture).sql).toContain("ORDER BY priority, rule_id");
  });

  it("asks both directions in one statement", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).rulesFor(FLAG_ID);
    expect(written(capture).sql).toContain("(flag_id = $1 OR rule_id = ANY($2::text[]))");
  });

  it("fetches one more row than the ceiling, so truncation cannot be silent", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).rulesFor(
      FLAG_ID,
      null,
      5,
    );
    expect(written(capture).params?.at(-1)).toBe(6);
  });

  it("refuses a rule set past the ceiling rather than returning a prefix of it", async () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      rule({ id: `ftr_rollout${String(i)}`, priority: i }),
    );
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(...many)),
    );
    await expect(store.rulesFor(FLAG_ID, null, 3)).rejects.toBeInstanceOf(
      TargetingRuleSetTooLargeError,
    );
  });

  it("refuses a non-positive limit", async () => {
    await expect(
      new PostgresTargetingRuleStore(mockConnection()).rulesFor(FLAG_ID, null, 0),
    ).rejects.toThrow(/limit must be positive/);
  });

  it("defaults its ceiling to MAX_TARGETING_RULES_PER_FLAG", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).rulesFor(FLAG_ID);
    expect(written(capture).params?.at(-1)).toBe(MAX_TARGETING_RULES_PER_FLAG + 1);
  });
});

describe("TARGETING_RULE_SET_DEFECTS", () => {
  it("has the three ways a flag and its rows can disagree", () => {
    expect([...TARGETING_RULE_SET_DEFECTS]).toEqual([
      "rule_missing",
      "rule_wrong_flag",
      "rule_unreferenced",
    ]);
  });

  it("blocks on the two that make a flag unevaluable and not on the third", () => {
    expect([...BLOCKING_TARGETING_RULE_SET_DEFECTS].sort()).toEqual([
      "rule_missing",
      "rule_wrong_flag",
    ]);
    expect(BLOCKING_TARGETING_RULE_SET_DEFECTS.has("rule_unreferenced")).toBe(false);
  });
});

describe("surveyFor", () => {
  it("resolves a clean flag with no findings", async () => {
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(rule())),
    );
    const survey = await store.surveyFor(flag());
    expect(survey.rules.map((r) => r.id)).toEqual([RULE_ID]);
    expect(survey.findings).toEqual([]);
  });

  it("reports a declared rule no row carries", async () => {
    const store = new PostgresTargetingRuleStore(mockConnection(undefined, () => EMPTY));
    const survey = await store.surveyFor(flag());
    expect(survey.findings).toEqual([
      { defect: "rule_missing", ruleId: RULE_ID, storedFlagId: null },
    ]);
    expect(survey.rules).toEqual([]);
  });

  it("reports a declared rule whose row belongs to another flag", async () => {
    const stray = rule({ flagId: "ff_otherflag" });
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(stray)),
    );
    const survey = await store.surveyFor(flag());
    expect(survey.findings).toEqual([
      { defect: "rule_wrong_flag", ruleId: RULE_ID, storedFlagId: "ff_otherflag" },
    ]);
    expect(survey.rules).toEqual([]);
  });

  it("reports a stored rule the flag's list does not name", async () => {
    const extra = rule({ id: "ftr_orphan01", priority: 20 });
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(rule(), extra)),
    );
    const survey = await store.surveyFor(flag());
    expect(survey.rules.map((r) => r.id)).toEqual([RULE_ID]);
    expect(survey.findings).toEqual([
      { defect: "rule_unreferenced", ruleId: "ftr_orphan01", storedFlagId: FLAG_ID },
    ]);
  });

  it("asks for the declared ids as a text array", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).surveyFor(flag());
    expect(written(capture).params?.[1]).toEqual([RULE_ID]);
  });

  it("degrades to the flag_id arm when the flag declares no rules", async () => {
    const capture: Captured[] = [];
    await new PostgresTargetingRuleStore(mockConnection(capture, () => EMPTY)).surveyFor(
      flag({ targetingRuleIds: [] }),
    );
    expect(written(capture).params?.[1]).toEqual([]);
  });

  it("returns the resolved rules in priority order, not in the declared list's order", async () => {
    const lo = rule({ id: "ftr_zlowpri0", priority: 5 });
    const hi = rule({ id: "ftr_ahighpri", priority: 50 });
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(lo, hi)),
    );
    const survey = await store.surveyFor(
      flag({ targetingRuleIds: ["ftr_ahighpri", "ftr_zlowpri0"] }),
    );
    expect(survey.rules.map((r) => r.id)).toEqual(["ftr_zlowpri0", "ftr_ahighpri"]);
  });

  it("breaks a priority tie by rule_id", async () => {
    const b = rule({ id: "ftr_bbbbbbb1", priority: 10 });
    const a = rule({ id: "ftr_aaaaaaa1", priority: 10 });
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(b, a)),
    );
    const survey = await store.surveyFor(
      flag({ targetingRuleIds: ["ftr_bbbbbbb1", "ftr_aaaaaaa1"] }),
    );
    expect(survey.rules.map((r) => r.id)).toEqual(["ftr_aaaaaaa1", "ftr_bbbbbbb1"]);
  });
});

describe("loadFor", () => {
  it("returns the set with an empty unreferenced list when clean", async () => {
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(rule())),
    );
    const set = await store.loadFor(flag());
    expect(set.flagId).toBe(FLAG_ID);
    expect(set.rules.map((r) => r.id)).toEqual([RULE_ID]);
    expect(set.unreferenced).toEqual([]);
  });

  it("refuses a flag naming a missing rule rather than evaluating without it", async () => {
    const store = new PostgresTargetingRuleStore(mockConnection(undefined, () => EMPTY));
    await expect(store.loadFor(flag())).rejects.toBeInstanceOf(TargetingRulesUnresolvedError);
  });

  it("names the flag and the defect in the refusal", async () => {
    const store = new PostgresTargetingRuleStore(mockConnection(undefined, () => EMPTY));
    await expect(store.loadFor(flag())).rejects.toThrow(
      /feature flag 'ff_checkout1' cannot be evaluated: ftr_rollout1 \(rule_missing\)/,
    );
  });

  it("refuses a declared rule that belongs to another flag", async () => {
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(rule({ flagId: "ff_otherflag" }))),
    );
    await expect(store.loadFor(flag())).rejects.toThrow(/belongs to flag ff_otherflag/);
  });

  it("does not refuse an unreferenced rule, and carries it in the set", async () => {
    const extra = rule({ id: "ftr_orphan01", priority: 20 });
    const store = new PostgresTargetingRuleStore(
      mockConnection(undefined, () => ruleRows(rule(), extra)),
    );
    const set = await store.loadFor(flag());
    expect(set.rules.map((r) => r.id)).toEqual([RULE_ID]);
    expect(set.unreferenced.map((f) => f.ruleId)).toEqual(["ftr_orphan01"]);
  });

  it("carries the scope the refusal was made in", async () => {
    const store = new PostgresTargetingRuleStore(mockConnection(undefined, () => EMPTY));
    await store.loadFor(flag(), TENANT).catch((err: unknown) => {
      expect(err).toBeInstanceOf(TargetingRulesUnresolvedError);
      expect((err as TargetingRulesUnresolvedError).scopeTenantId).toBe(TENANT);
    });
    expect.hasAssertions();
  });
});

describe("loadFlagWithTargeting", () => {
  const respond = respondTo([
    ["meta.feature_flags", { rows: [flagRow(flag())], rowCount: 1 }],
    ["meta.feature_flag_targeting_rules", ruleRows(rule())],
  ]);

  it("loads the flag and its rules so the evaluator can run", async () => {
    const conn = mockConnection(undefined, respond);
    const loaded = await loadFlagWithTargeting(
      new PostgresFeatureFlagStore(conn),
      new PostgresTargetingRuleStore(conn),
      FLAG_ID,
    );
    expect(loaded?.flag.id).toBe(FLAG_ID);
    expect(loaded?.targeting.rules.map((r) => r.id)).toEqual([RULE_ID]);
  });

  it("answers null for a flag that does not exist, without asking for rules", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, () => EMPTY);
    const loaded = await loadFlagWithTargeting(
      new PostgresFeatureFlagStore(conn),
      new PostgresTargetingRuleStore(conn),
      FLAG_ID,
    );
    expect(loaded).toBeNull();
    expect(capture.some((c) => c.sql.includes("feature_flag_targeting_rules"))).toBe(false);
  });

  it("feeds chooseTargetingRule, which serves the rule the bucket falls in", async () => {
    const conn = mockConnection(undefined, respond);
    const loaded = await loadFlagWithTargeting(
      new PostgresFeatureFlagStore(conn),
      new PostgresTargetingRuleStore(conn),
      FLAG_ID,
    );
    const decision = chooseTargetingRule(loaded?.targeting.rules ?? [], context());
    // The stored rule is a 0..1000-of-10000 bucket; whichever side this tenant falls on, the
    // decision has to be one of exactly two answers and never an exception.
    expect(decision.matched === null || decision.matched.id === RULE_ID).toBe(true);
    expect(decision.excluded).toBe(false);
  });

  it("refuses to compose a flag whose declared rule is absent", async () => {
    const conn = mockConnection(
      undefined,
      respondTo([
        ["meta.feature_flags", { rows: [flagRow(flag())], rowCount: 1 }],
        ["meta.feature_flag_targeting_rules", EMPTY],
      ]),
    );
    await expect(
      loadFlagWithTargeting(
        new PostgresFeatureFlagStore(conn),
        new PostgresTargetingRuleStore(conn),
        FLAG_ID,
      ),
    ).rejects.toBeInstanceOf(TargetingRulesUnresolvedError);
  });

  it("passes the scope through to both reads", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respond);
    await loadFlagWithTargeting(
      new PostgresFeatureFlagStore(conn),
      new PostgresTargetingRuleStore(conn),
      FLAG_ID,
      OTHER_TENANT,
    );
    // `SET_TENANT_CONTEXT_SQL` is itself a `SELECT set_config(…)`, so the two table reads are
    // picked out by their target rather than by the keyword.
    const reads = capture.filter((c) => c.sql.includes("FROM meta."));
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.sql).toContain("OR tenant_id IS NULL");
      expect(read.params).toContain(OTHER_TENANT);
    }
  });
});
