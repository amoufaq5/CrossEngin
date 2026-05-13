import { describe, expect, it } from "vitest";
import { emitMetaBootstrapSql } from "./index.js";
import {
  META_AI_CONVERSATIONS,
  META_AI_PROVIDER_CALLS,
  META_AUDIT_LOG,
  META_COMPLIANCE_ATTESTATIONS,
  META_DEAD_LETTER_JOBS,
  META_EVENTS,
  META_FILES,
  META_JOB_COSTS,
  META_JOB_RUNS,
  META_MANIFESTS,
  META_TABLES,
  META_TENANT_STORAGE_USAGE,
  META_TENANTS,
  META_USER_TENANT_MEMBERSHIP,
  META_USERS,
} from "./meta-schema.js";

describe("META_TABLES", () => {
  it("contains 15 tables", () => {
    expect(META_TABLES).toHaveLength(15);
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
      "compliance_attestations",
      "dead_letter_jobs",
      "events",
      "files",
      "integration_calls",
      "job_costs",
      "job_runs",
      "manifests",
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
