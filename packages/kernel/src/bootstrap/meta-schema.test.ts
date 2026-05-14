import { describe, expect, it } from "vitest";
import { emitMetaBootstrapSql } from "./index.js";
import {
  META_AI_CONVERSATIONS,
  META_AI_PROVIDER_CALLS,
  META_AUDIT_LOG,
  META_BILLING_EVENTS,
  META_CDC_CHECKPOINTS,
  META_COMPLIANCE_ATTESTATIONS,
  META_DEAD_LETTER_JOBS,
  META_DEPLOYMENTS,
  META_EVENTS,
  META_FEATURE_FLAGS,
  META_FILES,
  META_INVOICES,
  META_JOB_COSTS,
  META_JOB_RUNS,
  META_MANIFESTS,
  META_PLANS,
  META_REGIONS,
  META_REPORT_RUNS,
  META_SCHEDULED_EXPORTS,
  META_SUBSCRIPTIONS,
  META_TABLES,
  META_TENANT_AI_SETTINGS,
  META_TENANT_CREDITS,
  META_TENANT_STORAGE_USAGE,
  META_TENANTS,
  META_USER_TENANT_MEMBERSHIP,
  META_USERS,
} from "./meta-schema.js";

describe("META_TABLES", () => {
  it("contains 27 tables", () => {
    expect(META_TABLES).toHaveLength(27);
  });

  it("each table is in the meta schema with a unique name", () => {
    const names = new Set<string>();
    for (const t of META_TABLES) {
      expect(t.schema).toBe("meta");
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
    }
  });

  it("includes all expected tables", () => {
    expect(META_TABLES.map((t) => t.name).sort()).toEqual([
      "ai_conversations",
      "ai_provider_calls",
      "audit_log",
      "billing_events",
      "cdc_checkpoints",
      "compliance_attestations",
      "dead_letter_jobs",
      "deployments",
      "events",
      "feature_flags",
      "files",
      "integration_calls",
      "invoices",
      "job_costs",
      "job_runs",
      "manifests",
      "plans",
      "regions",
      "report_runs",
      "scheduled_exports",
      "subscriptions",
      "tenant_ai_settings",
      "tenant_credits",
      "tenant_storage_usage",
      "tenants",
      "user_tenant_membership",
      "users",
    ]);
  });

  it("FK references resolve to a table declared earlier in META_TABLES", () => {
    const seen = new Set<string>();
    for (const table of META_TABLES) {
      for (const col of table.columns) {
        if (col.references && col.references.schema === "meta") {
          expect(seen.has(col.references.table)).toBe(true);
        }
      }
      seen.add(table.name);
    }
  });

  it("tables with tenant_id column have RLS enabled", () => {
    for (const table of META_TABLES) {
      const hasTenantId = table.columns.some((c) => c.name === "tenant_id");
      if (hasTenantId) {
        expect(table.rls?.enabled).toBe(true);
        expect(table.rls?.policies?.length).toBeGreaterThan(0);
      }
    }
  });

  it("each table has a primary key", () => {
    for (const table of META_TABLES) {
      expect(table.primaryKey).toBeDefined();
    }
  });
});

describe("table column shapes", () => {
  it("META_TENANTS has slug, status, tier, region, schema_name", () => {
    const cols = META_TENANTS.columns.map((c) => c.name);
    expect(cols).toContain("slug");
    expect(cols).toContain("status");
    expect(cols).toContain("tier");
    expect(cols).toContain("region");
    expect(cols).toContain("schema_name");
  });

  it("META_USERS has email + status", () => {
    const cols = META_USERS.columns.map((c) => c.name);
    expect(cols).toContain("email");
    expect(cols).toContain("status");
  });

  it("META_USER_TENANT_MEMBERSHIP enforces (user_id, tenant_id) uniqueness", () => {
    expect(META_USER_TENANT_MEMBERSHIP.uniqueConstraints).toEqual([
      {
        name: "user_tenant_membership_user_tenant_key",
        columns: ["user_id", "tenant_id"],
      },
    ]);
  });

  it("META_MANIFESTS enforces (tenant_id, hash) uniqueness", () => {
    expect(
      META_MANIFESTS.uniqueConstraints?.some((u) =>
        u.columns.includes("tenant_id") && u.columns.includes("hash"),
      ),
    ).toBe(true);
  });

  it("META_AUDIT_LOG has the ADR-0008 fields", () => {
    const cols = META_AUDIT_LOG.columns.map((c) => c.name);
    for (const f of [
      "actor",
      "operation",
      "entity",
      "entity_id",
      "before",
      "after",
      "diff",
      "reason",
      "e_signature",
      "rego_decision_trace",
    ]) {
      expect(cols).toContain(f);
    }
  });

  it("META_AUDIT_LOG indexes actor as GIN", () => {
    const actorIdx = META_AUDIT_LOG.indexes?.find((i) => i.columns.includes("actor"));
    expect(actorIdx?.kind).toBe("gin");
  });

  it("META_AI_CONVERSATIONS tracks total cost as NUMERIC(12, 6)", () => {
    const col = META_AI_CONVERSATIONS.columns.find((c) => c.name === "total_cost_usd");
    expect(col?.type).toBe("NUMERIC(12, 6)");
  });

  it("META_AI_PROVIDER_CALLS includes cost_usd, latency_ms, ok", () => {
    const cols = META_AI_PROVIDER_CALLS.columns.map((c) => c.name);
    expect(cols).toContain("cost_usd");
    expect(cols).toContain("latency_ms");
    expect(cols).toContain("ok");
  });

  it("META_COMPLIANCE_ATTESTATIONS uses (tenant_id, pack_id, pack_version, attestation_id) uniqueness", () => {
    expect(
      META_COMPLIANCE_ATTESTATIONS.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "pack_id", "pack_version", "attestation_id"]);
  });

  it("META_EVENTS indexes (tenant_id, occurred_at) and event_name separately", () => {
    const idxNames = META_EVENTS.indexes?.map((i) => i.name) ?? [];
    expect(idxNames).toContain("idx_events_tenant_occurred_at");
    expect(idxNames).toContain("idx_events_event_name");
  });

  it("META_JOB_RUNS enforces (tenant_id, run_id) uniqueness and tenant-scoped indexes", () => {
    expect(META_JOB_RUNS.uniqueConstraints?.[0]?.columns).toEqual(["tenant_id", "run_id"]);
    const idxNames = META_JOB_RUNS.indexes?.map((i) => i.name) ?? [];
    expect(idxNames).toContain("idx_job_runs_tenant_started_at");
    expect(idxNames).toContain("idx_job_runs_status");
  });

  it("META_JOB_RUNS check-constrains status to the enum", () => {
    const status = META_JOB_RUNS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("dead-lettered");
  });

  it("META_DEAD_LETTER_JOBS enforces reason in the four allowed values", () => {
    const reason = META_DEAD_LETTER_JOBS.columns.find((c) => c.name === "reason");
    expect(reason?.check).toContain("max-retries-exceeded");
    expect(reason?.check).toContain("permanent-error");
  });

  it("META_JOB_COSTS uses NUMERIC(12, 6) for estimated_cost_usd", () => {
    const cost = META_JOB_COSTS.columns.find((c) => c.name === "estimated_cost_usd");
    expect(cost?.type).toBe("NUMERIC(12, 6)");
  });

  it("META_FILES enforces the six FileStatus values + (tenant_id, storage_key) uniqueness", () => {
    const status = META_FILES.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("uploading");
    expect(status?.check).toContain("quarantined");
    expect(META_FILES.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "storage_key",
    ]);
  });

  it("META_FILES check-constrains data_class to the DATA_CLASSES enum", () => {
    const dc = META_FILES.columns.find((c) => c.name === "data_class");
    expect(dc?.check).toContain("phi");
    expect(dc?.check).toContain("regulated");
  });

  it("META_TENANT_STORAGE_USAGE tracks hot/archive/cold bytes separately", () => {
    const cols = META_TENANT_STORAGE_USAGE.columns.map((c) => c.name);
    expect(cols).toContain("hot_bytes");
    expect(cols).toContain("archive_bytes");
    expect(cols).toContain("cold_bytes");
    expect(cols).toContain("file_count");
  });

  it("META_TENANTS has a residency JSONB column", () => {
    const residency = META_TENANTS.columns.find((c) => c.name === "residency");
    expect(residency?.type).toBe("JSONB");
  });

  it("META_TENANTS has a search_locale column constrained to seven dictionaries", () => {
    const col = META_TENANTS.columns.find((c) => c.name === "search_locale");
    expect(col?.notNull).toBe(true);
    expect(col?.check).toContain("'simple'");
    expect(col?.check).toContain("'arabic'");
  });

  it("META_REGIONS check-constrains region to the canonical eight", () => {
    const region = META_REGIONS.columns.find((c) => c.name === "region");
    expect(region?.check).toContain("eu-central");
    expect(region?.check).toContain("me-uae");
    expect(region?.check).toContain("gcc-ksa");
  });

  it("META_REGIONS check-constrains status to the four lifecycle states", () => {
    const status = META_REGIONS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("active");
    expect(status?.check).toContain("dr_replica");
    expect(status?.check).toContain("deprecated");
  });

  it("META_REPORT_RUNS enforces (tenant_id, run_id) uniqueness + status + engine enums", () => {
    expect(META_REPORT_RUNS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "run_id",
    ]);
    const status = META_REPORT_RUNS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("throttled");
    const engine = META_REPORT_RUNS.columns.find((c) => c.name === "engine");
    expect(engine?.check).toContain("clickhouse");
  });

  it("META_SCHEDULED_EXPORTS enforces one schedule per (tenant_id, report_id)", () => {
    expect(META_SCHEDULED_EXPORTS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "report_id",
    ]);
  });

  it("META_CDC_CHECKPOINTS is keyed on (region, replication_slot)", () => {
    expect(META_CDC_CHECKPOINTS.primaryKey).toEqual(["region", "replication_slot"]);
  });

  it("META_PLANS check-constrains family + tier + billing_interval", () => {
    const family = META_PLANS.columns.find((c) => c.name === "family");
    expect(family?.check).toContain("'operate'");
    const tier = META_PLANS.columns.find((c) => c.name === "tier");
    expect(tier?.check).toContain("'enterprise'");
    const interval = META_PLANS.columns.find((c) => c.name === "billing_interval");
    expect(interval?.check).toContain("'month'");
    expect(interval?.check).toContain("'year'");
  });

  it("META_SUBSCRIPTIONS FK-references META_PLANS.id with RESTRICT", () => {
    const planFk = META_SUBSCRIPTIONS.columns.find((c) => c.name === "plan_id");
    expect(planFk?.references?.table).toBe("plans");
    expect(planFk?.references?.onDelete).toBe("RESTRICT");
  });

  it("META_INVOICES enforces (tenant_id, number) uniqueness + status enum", () => {
    expect(
      META_INVOICES.uniqueConstraints?.some((u) =>
        u.columns.includes("tenant_id") && u.columns.includes("number"),
      ),
    ).toBe(true);
    const status = META_INVOICES.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'paid'");
    expect(status?.check).toContain("'refunded'");
  });

  it("META_TENANT_CREDITS enforces remaining_cents <= amount_cents at the row level", () => {
    const remaining = META_TENANT_CREDITS.columns.find((c) => c.name === "remaining_cents");
    expect(remaining?.check).toContain("amount_cents");
  });

  it("META_BILLING_EVENTS check-constrains kind to the 20 documented events", () => {
    const kind = META_BILLING_EVENTS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'invoice_paid'");
    expect(kind?.check).toContain("'refund_issued'");
    expect(kind?.check).toContain("'dunning_advanced'");
    expect(kind?.check).toContain("'usage_synced'");
  });

  it("META_TENANT_AI_SETTINGS is keyed on tenant_id + defaults to fireworks-only providers", () => {
    expect(META_TENANT_AI_SETTINGS.primaryKey).toEqual(["tenant_id"]);
    const providers = META_TENANT_AI_SETTINGS.columns.find(
      (c) => c.name === "allowed_external_providers",
    );
    expect(providers?.default).toContain("fireworks");
  });

  it("META_TENANT_AI_SETTINGS check-constrains schema_change_approval_tier", () => {
    const tier = META_TENANT_AI_SETTINGS.columns.find(
      (c) => c.name === "schema_change_approval_tier",
    );
    expect(tier?.check).toContain("'always_human'");
    expect(tier?.check).toContain("'agent_can_do_anything'");
  });

  it("META_FEATURE_FLAGS check-constrains kind to the four flag types", () => {
    const kind = META_FEATURE_FLAGS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'boolean'");
    expect(kind?.check).toContain("'string'");
    expect(kind?.check).toContain("'number'");
    expect(kind?.check).toContain("'json'");
  });

  it("META_FEATURE_FLAGS enforces unique flag keys with snake-case dotted check", () => {
    const key = META_FEATURE_FLAGS.columns.find((c) => c.name === "key");
    expect(key?.unique?.constraintName).toBe("feature_flags_key_key");
    expect(key?.check).toContain("[a-z]");
  });

  it("META_DEPLOYMENTS check-constrains status to the six lifecycle states", () => {
    const status = META_DEPLOYMENTS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'queued'");
    expect(status?.check).toContain("'in_progress'");
    expect(status?.check).toContain("'rolled_back'");
    expect(status?.check).toContain("'cancelled'");
  });

  it("META_DEPLOYMENTS check-constrains region to the canonical eight", () => {
    const region = META_DEPLOYMENTS.columns.find((c) => c.name === "region");
    expect(region?.check).toContain("eu-central");
    expect(region?.check).toContain("me-uae");
    expect(region?.check).toContain("ap-south");
  });

  it("META_DEPLOYMENTS check-constrains target to the ten deploy targets", () => {
    const target = META_DEPLOYMENTS.columns.find((c) => c.name === "target");
    expect(target?.check).toContain("'vercel_edge'");
    expect(target?.check).toContain("'fly_machine'");
    expect(target?.check).toContain("'helm_release'");
  });

  it("META_DEPLOYMENTS triggered_by FK-references META_USERS with RESTRICT", () => {
    const triggeredBy = META_DEPLOYMENTS.columns.find(
      (c) => c.name === "triggered_by",
    );
    expect(triggeredBy?.references?.table).toBe("users");
    expect(triggeredBy?.references?.onDelete).toBe("RESTRICT");
  });
});

describe("emitMetaBootstrapSql", () => {
  it("produces deterministic SQL across calls", () => {
    const a = emitMetaBootstrapSql();
    const b = emitMetaBootstrapSql();
    expect(a).toEqual(b);
  });

  it("starts with CREATE SCHEMA", () => {
    const sql = emitMetaBootstrapSql();
    expect(sql[0]).toBe(`CREATE SCHEMA IF NOT EXISTS "meta";`);
  });

  it("includes a CREATE TABLE for each meta table", () => {
    const sql = emitMetaBootstrapSql();
    const createTables = sql.filter((s) => s.startsWith("CREATE TABLE"));
    expect(createTables).toHaveLength(META_TABLES.length);
  });

  it("emits CREATE TABLE statements in dependency order (FK targets declared first)", () => {
    const sql = emitMetaBootstrapSql();
    const createIdx = (name: string) =>
      sql.findIndex((s) => s.startsWith(`CREATE TABLE "meta"."${name}"`));
    expect(createIdx("tenants")).toBeLessThan(createIdx("user_tenant_membership"));
    expect(createIdx("users")).toBeLessThan(createIdx("user_tenant_membership"));
    expect(createIdx("tenants")).toBeLessThan(createIdx("manifests"));
    expect(createIdx("users")).toBeLessThan(createIdx("manifests"));
    expect(createIdx("tenants")).toBeLessThan(createIdx("ai_conversations"));
    expect(createIdx("users")).toBeLessThan(createIdx("ai_conversations"));
  });

  it("includes RLS ENABLE + policy for each tenant-scoped table", () => {
    const sql = emitMetaBootstrapSql();
    const rlsEnableCount = sql.filter((s) =>
      s.includes("ENABLE ROW LEVEL SECURITY"),
    ).length;
    const tenantScoped = META_TABLES.filter((t) => t.rls?.enabled === true);
    expect(rlsEnableCount).toBe(tenantScoped.length);
  });
});
