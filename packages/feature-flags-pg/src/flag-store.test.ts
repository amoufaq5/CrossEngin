import { describe, expect, it } from "vitest";
import { FlagDefinitionSchema, type FlagDefinition } from "@crossengin/feature-flags";

import {
  FEATURE_FLAG_COLUMNS,
  FEATURE_FLAG_COLUMN_NAMES,
  FEATURE_FLAG_JSONB_COLUMNS,
  FEATURE_FLAG_PARAM_COUNT,
  FeatureFlagConflictError,
  PostgresFeatureFlagStore,
  flagPlaceholders,
  flagRowValues,
  flagUpdateAssignments,
  rowToFeatureFlag,
} from "./flag-store.js";
import {
  SET_PLATFORM_CONFIG_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./kill-switch-store.js";
import {
  type Captured,
  EMPTY,
  FLAG_ID,
  RELEASER,
  T0,
  T1,
  T2,
  TENANT,
  mockConnection,
  written,
  respondTo,
} from "./test-fakes.js";

const OWNER = "55555555-5555-4555-8555-555555555555";

const MULTIVARIATE_VARIANTS = [
  { key: "control", label: "Control", value: false, weight: 5000 },
  { key: "treatment", label: "Treatment", value: true, weight: 5000 },
];

/** A live, platform-wide boolean flag — the shape almost everything in the catalog is. */
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
    environments: ["staging", "production"],
    riskLevel: "medium",
    ownerUserId: OWNER,
    ownerTeam: "payments",
    tags: ["checkout"],
    relatedDeploymentId: null,
    relatedIncidentId: null,
    targetingRuleIds: [],
    requiresFourEyesToToggle: false,
    requiresIncidentToKill: false,
    expiresAt: null,
    createdAt: T0,
    createdBy: OWNER,
    updatedAt: T1,
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    ...over,
  });
}

function archivedFlag(over: Record<string, unknown> = {}): FlagDefinition {
  return flag({
    status: "archived",
    updatedAt: T2,
    archivedAt: T2,
    archivedBy: RELEASER,
    archivedReason: "superseded by the pricing rewrite",
    ...over,
  });
}

/** The kind the contract puts the most cross-field rules on. */
function killSwitchFlag(over: Record<string, unknown> = {}): FlagDefinition {
  return flag({
    kind: "kill_switch",
    killedValueJson: "false",
    requiresFourEyesToToggle: true,
    riskLevel: "critical",
    ...over,
  });
}

/** The row a stored flag comes back as, built through the same projection the store writes. */
function flagRow(record: FlagDefinition): Record<string, unknown> {
  const values = flagRowValues(record);
  const row: Record<string, unknown> = {};
  FEATURE_FLAG_COLUMN_NAMES.forEach((col, i) => {
    row[col] = values[i];
  });
  return row;
}

const rows = (
  ...records: FlagDefinition[]
): { rows: Record<string, unknown>[]; rowCount: number } => ({
  rows: records.map((r) => flagRow(r)),
  rowCount: records.length,
});

describe("PostgresFeatureFlagStore construction", () => {
  it("defaults to the meta schema", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture, () => EMPTY)).load(FLAG_ID);
    expect(capture[0]?.sql).toContain("meta.feature_flags");
  });

  it("honours an override schema", async () => {
    const capture: Captured[] = [];
    const store = new PostgresFeatureFlagStore(mockConnection(capture, () => EMPTY), {
      schema: "other_meta",
    });
    await store.load(FLAG_ID);
    expect(capture[0]?.sql).toContain("other_meta.feature_flags");
  });

  it("refuses a schema name that is not a bare identifier", () => {
    expect(
      () => new PostgresFeatureFlagStore(mockConnection(), { schema: 'meta"; DROP' }),
    ).toThrow(/invalid schema identifier/);
  });
});

describe("the column projection", () => {
  it("puts the contract's own id first, as the key an UPDATE matches on", () => {
    expect(FEATURE_FLAG_COLUMN_NAMES[0]).toBe("flag_id");
    expect(FEATURE_FLAG_COLUMN_NAMES).not.toContain("id");
  });

  it("casts exactly the JSONB columns, leaving both value columns as the validated text", () => {
    const parts = flagPlaceholders().split(", ");
    expect(parts).toHaveLength(FEATURE_FLAG_COLUMN_NAMES.length);
    FEATURE_FLAG_COLUMN_NAMES.forEach((col, i) => {
      expect(parts[i]?.endsWith("::jsonb")).toBe(FEATURE_FLAG_JSONB_COLUMNS.has(col));
    });
    expect(FEATURE_FLAG_JSONB_COLUMNS.has("default_value_json")).toBe(false);
    // And the column list names what the catalog declares. ADR-0308 renamed this column and the
    // list kept the old name, so every statement here named a column no applied database has: the
    // store could not round-trip one flag, and only a live cluster said so.
    expect(FEATURE_FLAG_COLUMN_NAMES).toContain("default_value_json");
    expect(FEATURE_FLAG_COLUMN_NAMES).not.toContain("default_value");
    expect(FEATURE_FLAG_JSONB_COLUMNS.has("killed_value_json")).toBe(false);
  });

  it("assigns every column but the key, starting at $2, one parameter each", () => {
    const assignments = flagUpdateAssignments().split(", ");
    expect(assignments).toHaveLength(FEATURE_FLAG_COLUMN_NAMES.length - 1);
    expect(assignments[0]).toBe("tenant_id = $2");
    expect(assignments.join(", ")).not.toContain("flag_id =");
    expect(FEATURE_FLAG_PARAM_COUNT).toBe(FEATURE_FLAG_COLUMN_NAMES.length);
    expect(flagRowValues(flag())).toHaveLength(FEATURE_FLAG_PARAM_COUNT);
  });

  it("round-trips a flag through the row it writes, Date timestamps included", () => {
    const record = flag();
    expect(rowToFeatureFlag(flagRow(record))).toEqual(record);
    const driverRow = { ...flagRow(record), created_at: new Date(T0) };
    expect(rowToFeatureFlag(driverRow).createdAt).toBe(T0);
  });
});

describe("insert", () => {
  it("inserts the full column list with matching placeholders", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture)).insert(flag());
    expect(capture[1]?.sql).toContain(`INSERT INTO meta.feature_flags (${FEATURE_FLAG_COLUMNS})`);
    expect(capture[1]?.sql).toContain(`$${FEATURE_FLAG_COLUMN_NAMES.length})`);
    expect(capture[1]?.params).toHaveLength(FEATURE_FLAG_PARAM_COUNT);
    expect(capture[1]?.params?.[0]).toBe(FLAG_ID);
    const environments = FEATURE_FLAG_COLUMN_NAMES.indexOf("environments");
    expect(capture[1]?.params?.[environments]).toBe('["staging","production"]');
  });

  it("claims the platform config-write elevation, and sets no tenant context, for a platform-wide flag", async () => {
    // It used to set nothing at all, which read as "RLS exposes the null-tenant rows". That was
    // true of the read — and the same `tenant_id IS NULL` arm satisfied the one `ALL`-scope
    // policy's `WITH CHECK`, so any tenant session could insert, update or delete a platform-wide
    // flag. The write arm is its own `INSERT`-scoped policy on this setting now.
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture)).insert(flag());
    expect(capture).toHaveLength(2);
    expect(capture[0]?.sql).toBe(SET_PLATFORM_CONFIG_WRITE_SQL);
    expect(capture[1]?.sql).toContain("INSERT INTO");
  });

  it("claims the elevation on a platform-wide update and transition too", async () => {
    // `meta.feature_flags` is the mutable half of the split: a platform-wide flag is paused and
    // archived in normal operation, so an `INSERT`-only platform arm would have made every
    // platform row immutable-by-RLS — fail-closed and silent.
    for (const write of [
      (s: PostgresFeatureFlagStore) => s.update(flag({ updatedAt: T2 }), T1),
      (s: PostgresFeatureFlagStore) => s.transition(flag({ status: "paused", updatedAt: T2 }), T1),
    ]) {
      const capture: Captured[] = [];
      await write(new PostgresFeatureFlagStore(mockConnection(capture)));
      expect(capture[0]?.sql).toBe(SET_PLATFORM_CONFIG_WRITE_SQL);
      expect(capture[1]?.sql).toContain("UPDATE meta.feature_flags");
    }
  });

  it("claims nothing at all on a platform-wide read", async () => {
    // The platform read policy is `SELECT`-scoped on `tenant_id IS NULL` and demands no grant, so a
    // read needs no elevation — and claiming one it does not need would leave the privilege set for
    // every later statement in the same transaction.
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture)).load(FLAG_ID);
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).not.toContain("set_config");
  });

  it("sets the tenant context before inserting a tenant-scoped flag", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture)).insert(
      flag({ tenantId: TENANT }),
    );
    expect(capture).toHaveLength(2);
    expect(capture[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(capture[0]?.params).toEqual([TENANT]);
    expect(capture[1]?.sql).toContain("INSERT INTO");
  });

  it("refuses a record the contract rejects before any SQL runs", async () => {
    const capture: Captured[] = [];
    const store = new PostgresFeatureFlagStore(mockConnection(capture));
    const bad = { ...killSwitchFlag(), killedValueJson: null };
    await expect(store.insert(bad)).rejects.toThrow();
    expect(capture).toHaveLength(0);
  });
});

describe("update", () => {
  it("updates every non-key column, matching the id and the updated_at it read", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture)).update(
      flag({ updatedAt: T2 }),
      T1,
    );
    expect(written(capture).sql).toContain(`SET ${flagUpdateAssignments()}`);
    expect(written(capture).sql).toContain(
      `WHERE flag_id = $1 AND updated_at = $${FEATURE_FLAG_PARAM_COUNT + 1}`,
    );
    expect(written(capture).params).toHaveLength(FEATURE_FLAG_PARAM_COUNT + 1);
    expect(written(capture).params?.[FEATURE_FLAG_PARAM_COUNT]).toBe(T1);
  });

  it("refuses a write whose updatedAt does not advance past the guard", async () => {
    const capture: Captured[] = [];
    const store = new PostgresFeatureFlagStore(mockConnection(capture));
    await expect(store.update(flag({ updatedAt: T1 }), T1)).rejects.toThrow(
      /updatedAt must advance/,
    );
    expect(capture).toHaveLength(0);
  });

  it("treats a zero-row update as a conflict naming the flag and the stale timestamp", async () => {
    const store = new PostgresFeatureFlagStore(mockConnection(undefined, () => EMPTY));
    await expect(store.update(flag({ updatedAt: T2 }), T1)).rejects.toBeInstanceOf(
      FeatureFlagConflictError,
    );
    await expect(store.update(flag({ updatedAt: T2 }), T1)).rejects.toThrow(
      new RegExp(`${FLAG_ID}.*${T1}`),
    );
  });

  it("resolves when one row was written", async () => {
    const store = new PostgresFeatureFlagStore(mockConnection());
    await expect(store.update(flag({ updatedAt: T2 }), T1)).resolves.toBeUndefined();
  });

  it("scopes the update to the tenant that owns the flag", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture)).update(
      flag({ tenantId: TENANT, updatedAt: T2 }),
      T1,
    );
    expect(capture[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(capture[1]?.sql).toContain("UPDATE meta.feature_flags");
  });
});

describe("transition", () => {
  it("guards on the statuses the transition map lets reach active, as well as on updated_at", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture)).transition(
      flag({ status: "active", updatedAt: T2 }),
      T1,
    );
    expect(written(capture).sql).toContain(
      `updated_at = $${FEATURE_FLAG_PARAM_COUNT + 1} AND status IN ('draft', 'paused')`,
    );
  });

  it("lets every non-terminal status reach archived", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture)).transition(archivedFlag(), T1);
    expect(written(capture).sql).toContain("AND status IN ('draft', 'active', 'paused')");
  });

  it("refuses a target no status can transition to", async () => {
    const capture: Captured[] = [];
    const store = new PostgresFeatureFlagStore(mockConnection(capture));
    await expect(
      store.transition(flag({ status: "draft", updatedAt: T2 }), T1),
    ).rejects.toThrow(/no status can transition to 'draft'/);
    expect(capture).toHaveLength(0);
  });

  it("reports a row that moved on as a conflict", async () => {
    const store = new PostgresFeatureFlagStore(mockConnection(undefined, () => EMPTY));
    await expect(store.transition(archivedFlag(), T1)).rejects.toBeInstanceOf(
      FeatureFlagConflictError,
    );
  });
});

describe("load", () => {
  it("selects the stored columns by the contract id, and returns null for an unknown one", async () => {
    const capture: Captured[] = [];
    const store = new PostgresFeatureFlagStore(mockConnection(capture, () => EMPTY));
    await expect(store.load(FLAG_ID)).resolves.toBeNull();
    expect(capture[0]?.sql).toContain(`SELECT ${FEATURE_FLAG_COLUMNS}`);
    expect(capture[0]?.sql).toContain("WHERE flag_id = $1");
    expect(capture[0]?.params).toEqual([FLAG_ID]);
  });

  it("parses the row back into the record, variants and all", async () => {
    const record = flag({ kind: "multivariate", variants: MULTIVARIATE_VARIANTS });
    const store = new PostgresFeatureFlagStore(
      mockConnection(undefined, respondTo([["WHERE flag_id", rows(record)]])),
    );
    await expect(store.load(FLAG_ID)).resolves.toEqual(record);
  });
});

describe("loadByKey", () => {
  it("selects on the unique key column", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture, () => EMPTY)).loadByKey(
      "checkout.new_pricing",
    );
    expect(capture[0]?.sql).toContain("WHERE key = $1");
    expect(capture[0]?.params).toEqual(["checkout.new_pricing"]);
  });

  it("returns the flag a key names", async () => {
    const record = flag();
    const store = new PostgresFeatureFlagStore(
      mockConnection(undefined, respondTo([["WHERE key", rows(record)]])),
    );
    await expect(store.loadByKey("checkout.new_pricing")).resolves.toEqual(record);
  });
});

describe("listForEnvironment", () => {
  it("asks for containment over the JSONB array, newest first, limit 100 by default", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(
      mockConnection(capture, () => EMPTY),
    ).listForEnvironment("production");
    expect(capture[0]?.sql).toContain("WHERE environments @> $1::jsonb");
    expect(capture[0]?.sql).toContain("ORDER BY created_at DESC");
    expect(capture[0]?.sql).not.toContain("status = 'active'");
    expect(capture[0]?.params).toEqual(['["production"]', 100]);
  });

  it("binds a caller's limit", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(
      mockConnection(capture, () => EMPTY),
    ).listForEnvironment("sandbox", 5);
    expect(capture[0]?.params).toEqual(['["sandbox"]', 5]);
  });

  it("refuses a non-positive limit instead of emitting LIMIT 0", async () => {
    const capture: Captured[] = [];
    const store = new PostgresFeatureFlagStore(mockConnection(capture));
    await expect(store.listForEnvironment("production", 0)).rejects.toThrow(
      /limit must be positive/,
    );
    expect(capture).toHaveLength(0);
  });

  it("parses every row, and returns an empty list rather than null", async () => {
    const a = flag();
    const b = flag({ id: "ff_checkout2", key: "checkout.express" });
    const store = new PostgresFeatureFlagStore(
      mockConnection(undefined, respondTo([["environments @>", rows(a, b)]])),
    );
    await expect(store.listForEnvironment("production")).resolves.toEqual([a, b]);
    const empty = new PostgresFeatureFlagStore(mockConnection(undefined, () => EMPTY));
    await expect(empty.listForEnvironment("production")).resolves.toEqual([]);
  });
});

describe("listActiveForEnvironment", () => {
  it("adds the active predicate, expiring against the database clock", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(
      mockConnection(capture, () => EMPTY),
    ).listActiveForEnvironment("production");
    expect(capture[0]?.sql).toContain("environments @> $1::jsonb");
    expect(capture[0]?.sql).toContain("status = 'active'");
    expect(capture[0]?.sql).toContain("expires_at IS NULL OR expires_at > now()");
  });

  it("scopes to a tenant when one is given", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(
      mockConnection(capture, () => EMPTY),
    ).listActiveForEnvironment("production", 10, TENANT);
    expect(capture[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    // The tenant context *and* the predicate beside it: the context is what confines a non-owner,
    // the predicate is what confines the owner, and the limit now rides on $3.
    expect(capture[1]?.sql).toContain("(tenant_id = $2 OR tenant_id IS NULL)");
    expect(capture[1]?.sql).toContain("LIMIT $3");
    expect(capture[1]?.params).toEqual(['["production"]', TENANT, 10]);
  });
});

/**
 * The reason the read re-parses. Every row below satisfies every CHECK the reconciled table
 * declares — the enum values are legal, the NOT NULLs are filled — and every one is a flag the
 * contract forbids.
 */
describe("refusing a hand-edited row on the way out", () => {
  it("refuses an archived row whose archival reason was cleared", async () => {
    const row = { ...flagRow(archivedFlag()), archived_reason: null };
    const store = new PostgresFeatureFlagStore(
      mockConnection(undefined, respondTo([["WHERE flag_id", { rows: [row], rowCount: 1 }]])),
    );
    await expect(store.load(FLAG_ID)).rejects.toThrow(
      /archived flag requires archivedAt \+ archivedBy \+ archivedReason/,
    );
  });

  it("refuses a kill-switch flag whose four-eyes requirement was turned off", () => {
    const row = { ...flagRow(killSwitchFlag()), requires_four_eyes_to_toggle: false };
    expect(() => rowToFeatureFlag(row)).toThrow(/must require four-eyes/);
  });

  it("refuses a default value that is not JSON", () => {
    const row = { ...flagRow(flag()), default_value_json: "{oops" };
    expect(() => rowToFeatureFlag(row)).toThrow(/defaultValueJson must be valid JSON/);
  });

  it("refuses variant weights that no longer sum to 10000 basis points", () => {
    const row = flagRow(flag({ kind: "multivariate", variants: MULTIVARIATE_VARIANTS }));
    row["variants"] = JSON.stringify([
      MULTIVARIATE_VARIANTS[0],
      { ...MULTIVARIATE_VARIANTS[1], weight: 4000 },
    ]);
    expect(() => rowToFeatureFlag(row)).toThrow(/variant weights must sum to 10000/);
  });

  it("refuses an expiry that precedes creation", () => {
    const row = { ...flagRow(flag()), expires_at: "2020-01-01T00:00:00.000Z" };
    expect(() => rowToFeatureFlag(row)).toThrow(/expiresAt must be after createdAt/);
  });
});

describe("the scope predicate every read carries beside RLS", () => {
  /** The read under test, found by what it is rather than by where it sits. */
  function read(capture: readonly Captured[]): Captured {
    const found = capture.find((c) => c.sql.includes("FROM meta.feature_flags"));
    if (found === undefined) throw new Error("no read was issued");
    return found;
  }

  /** The predicate, separated from the projection — `tenant_id` is a selected column too. */
  function where(captured: Captured): string {
    const at = captured.sql.indexOf("WHERE");
    if (at < 0) throw new Error(`read carried no WHERE clause: ${captured.sql}`);
    return captured.sql.slice(at);
  }

  it("asks for the platform scope by name on load, which answered with a tenant's flag as the owner", async () => {
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture, () => EMPTY)).load(FLAG_ID);
    expect(where(read(capture))).toContain("tenant_id IS NULL");
    expect(where(read(capture))).not.toContain("tenant_id = $");
  });

  it("keeps the platform's flags in a tenant's answer, because that is what a non-owner was shown", async () => {
    // `meta.feature_flags`' own catalog comment: a platform-wide flag is *meant* to be evaluated by
    // every tenant's gateway. So the tenant arm reproduces the isolation policy OR'd with the
    // `SELECT`-scoped platform read arm, rather than narrowing it.
    const capture: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(capture, () => EMPTY)).load(FLAG_ID, TENANT);
    expect(where(read(capture))).toContain("(tenant_id = $2 OR tenant_id IS NULL)");
    expect(read(capture).params).toEqual([FLAG_ID, TENANT]);
  });

  it("scopes loadByKey, whose table-wide unique key is exactly what hid the defect", async () => {
    const platform: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(platform, () => EMPTY)).loadByKey(
      "gateway.strict_jwt_aud",
    );
    expect(where(read(platform))).toContain("tenant_id IS NULL");

    const tenant: Captured[] = [];
    await new PostgresFeatureFlagStore(mockConnection(tenant, () => EMPTY)).loadByKey(
      "gateway.strict_jwt_aud",
      TENANT,
    );
    expect(where(read(tenant))).toContain("(tenant_id = $2 OR tenant_id IS NULL)");
  });

  it("scopes the environment list before its LIMIT, so another scope cannot displace the page", async () => {
    const platform: Captured[] = [];
    await new PostgresFeatureFlagStore(
      mockConnection(platform, () => EMPTY),
    ).listForEnvironment("production", 5);
    expect(where(read(platform))).toContain("tenant_id IS NULL");
    expect(read(platform).sql).toContain("LIMIT $2");
    expect(read(platform).params).toEqual(['["production"]', 5]);

    const tenant: Captured[] = [];
    await new PostgresFeatureFlagStore(
      mockConnection(tenant, () => EMPTY),
    ).listForEnvironment("production", 5, TENANT);
    expect(where(read(tenant))).toContain("(tenant_id = $2 OR tenant_id IS NULL)");
    expect(read(tenant).sql).toContain("LIMIT $3");
    expect(read(tenant).params).toEqual(['["production"]', TENANT, 5]);
  });

  it("never spells a scope as IS NOT DISTINCT FROM, which is unindexable", async () => {
    const capture: Captured[] = [];
    const store = new PostgresFeatureFlagStore(mockConnection(capture, () => EMPTY));
    await store.load(FLAG_ID, TENANT);
    await store.loadByKey("a.b", TENANT);
    await store.listForEnvironment("production", 5, TENANT);
    await store.listActiveForEnvironment("production", 5, TENANT);
    const reads = capture.filter((c) => c.sql.includes("FROM meta.feature_flags"));
    expect(reads).toHaveLength(4);
    for (const r of reads) {
      expect(r.sql).not.toContain("IS NOT DISTINCT FROM");
      expect(where(r)).toContain("tenant_id");
    }
  });
});
