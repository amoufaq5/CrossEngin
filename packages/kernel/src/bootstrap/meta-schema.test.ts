import { describe, expect, it } from "vitest";
import { emitMetaBootstrapSql } from "./index.js";
import {
  META_AA_CONFLICTS,
  META_ACCESS_REVIEW_CAMPAIGNS,
  META_ACCESS_REVIEW_DECISIONS,
  META_ACCESS_REVIEW_EVIDENCE,
  META_ACCESS_REVIEW_EXCEPTIONS,
  META_ACCESS_REVIEW_ITEMS,
  META_ACCESS_REVIEW_TEMPLATES,
  META_AA_SPLIT_BRAIN_EVENTS,
  META_AA_TOPOLOGY,
  META_AI_CONVERSATIONS,
  META_AI_PROVIDER_CALLS,
  META_API_KEYS,
  META_AUDIT_LOG,
  META_AUTOSCALING_EVENTS,
  META_BACKFILL_JOBS,
  META_BACKFILL_LEDGER,
  META_BACKUP_RECORDS,
  META_BILLING_EVENTS,
  META_BUDGET_BREACHES,
  META_CDC_CHECKPOINTS,
  META_CHAIN_OF_CUSTODY,
  META_CHARGEBACK_STATEMENTS,
  META_COMPLIANCE_ATTESTATIONS,
  META_COST_ATTRIBUTION,
  META_COST_BUDGETS,
  META_DEAD_LETTER_JOBS,
  META_DEPLOYMENTS,
  META_DR_DRILLS,
  META_EDISCOVERY_REQUESTS,
  META_EVENTS,
  META_EXTENSION_PACKS,
  META_FAILOVER_RECORDS,
  META_FORENSIC_EVIDENCE,
  META_FEATURE_FLAGS,
  META_FILES,
  META_GDPR_DELETION_REQUESTS,
  META_IDEMPOTENCY_RECORDS,
  META_IMPORT_SOURCES,
  META_INCIDENTS,
  META_INCIDENT_COMMUNICATIONS,
  META_INCIDENT_POSTMORTEMS,
  META_INCIDENT_RUNBOOK_EXECUTIONS,
  META_INVOICES,
  META_JOB_COSTS,
  META_JOB_RUNS,
  META_LEGAL_HOLDS,
  META_MANIFESTS,
  META_ML_CONSENT,
  META_ML_DATASETS,
  META_ML_EVALSETS,
  META_ML_EVALUATIONS,
  META_ML_MODELS,
  META_ML_TRAINING_RUNS,
  META_NOTIFICATION_DELIVERIES,
  META_NOTIFICATION_DIGESTS,
  META_NOTIFICATION_DISPATCHES,
  META_NOTIFICATION_PREFERENCES,
  META_NOTIFICATION_SUPPRESSIONS,
  META_NOTIFICATION_TEMPLATES,
  META_ONBOARDING_RUNS,
  META_PACK_INSTALLATIONS,
  META_PACK_REVIEWS,
  META_PACK_VERSIONS,
  META_PLANS,
  META_REGIONS,
  META_REPORT_RUNS,
  META_SCHEDULED_EXPORTS,
  META_SCIM_CLIENTS,
  META_SCIM_PROVISIONING,
  META_SDK_CLIENT_INSTALLATIONS,
  META_SDK_CLIENT_RELEASES,
  META_SSO_LOGINS,
  META_SSO_PROVIDERS,
  META_SSO_SESSIONS,
  META_SUBSCRIPTIONS,
  META_TABLES,
  META_TENANT_AI_SETTINGS,
  META_TENANT_CREDITS,
  META_TENANT_DATA_EXPORTS,
  META_TENANT_LIFECYCLE_EVENTS,
  META_TENANT_STORAGE_USAGE,
  META_TENANT_TOMBSTONES,
  META_TENANT_UNIT_ECONOMICS,
  META_TENANTS,
  META_USER_TENANT_MEMBERSHIP,
  META_USERS,
  META_WEBHOOK_DELIVERIES,
  META_WEBHOOK_ENDPOINTS,
  META_WORKFLOW_ACTIVITIES,
  META_WORKFLOW_DEFINITIONS,
  META_WORKFLOW_EVENTS,
  META_WORKFLOW_INSTANCES,
  META_WORKFLOW_SIGNALS,
  META_WORKFLOW_TIMERS,
} from "./meta-schema.js";

describe("META_TABLES", () => {
  it("contains 94 tables", () => {
    expect(META_TABLES).toHaveLength(94);
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
      "aa_conflicts",
      "aa_split_brain_events",
      "aa_topology",
      "access_review_campaigns",
      "access_review_decisions",
      "access_review_evidence",
      "access_review_exceptions",
      "access_review_items",
      "access_review_templates",
      "ai_conversations",
      "ai_provider_calls",
      "api_keys",
      "audit_log",
      "autoscaling_events",
      "backfill_jobs",
      "backfill_ledger",
      "backup_records",
      "billing_events",
      "budget_breaches",
      "cdc_checkpoints",
      "chain_of_custody",
      "chargeback_statements",
      "compliance_attestations",
      "cost_attribution",
      "cost_budgets",
      "dead_letter_jobs",
      "deployments",
      "dr_drills",
      "ediscovery_requests",
      "events",
      "extension_packs",
      "failover_records",
      "feature_flags",
      "files",
      "forensic_evidence",
      "gdpr_deletion_requests",
      "idempotency_records",
      "import_sources",
      "incident_communications",
      "incident_postmortems",
      "incident_runbook_executions",
      "incidents",
      "integration_calls",
      "invoices",
      "job_costs",
      "job_runs",
      "legal_holds",
      "manifests",
      "ml_consent",
      "ml_datasets",
      "ml_evalsets",
      "ml_evaluations",
      "ml_models",
      "ml_training_runs",
      "notification_deliveries",
      "notification_digests",
      "notification_dispatches",
      "notification_preferences",
      "notification_suppressions",
      "notification_templates",
      "onboarding_runs",
      "pack_installations",
      "pack_reviews",
      "pack_versions",
      "plans",
      "regions",
      "report_runs",
      "scheduled_exports",
      "scim_clients",
      "scim_provisioning",
      "sdk_client_installations",
      "sdk_client_releases",
      "sso_logins",
      "sso_providers",
      "sso_sessions",
      "subscriptions",
      "tenant_ai_settings",
      "tenant_credits",
      "tenant_data_exports",
      "tenant_lifecycle_events",
      "tenant_storage_usage",
      "tenant_tombstones",
      "tenant_unit_economics",
      "tenants",
      "user_tenant_membership",
      "users",
      "webhook_deliveries",
      "webhook_endpoints",
      "workflow_activities",
      "workflow_definitions",
      "workflow_events",
      "workflow_instances",
      "workflow_signals",
      "workflow_timers",
    ]);
  });

  it("FK references resolve to a table declared earlier in META_TABLES (or self)", () => {
    const seen = new Set<string>();
    for (const table of META_TABLES) {
      for (const col of table.columns) {
        if (col.references && col.references.schema === "meta") {
          const isSelfReference = col.references.table === table.name;
          expect(
            isSelfReference || seen.has(col.references.table),
          ).toBe(true);
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

  it("META_BACKUP_RECORDS check-constrains kind to the five backup kinds", () => {
    const kind = META_BACKUP_RECORDS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'full'");
    expect(kind?.check).toContain("'wal_archive'");
    expect(kind?.check).toContain("'object_snapshot'");
  });

  it("META_BACKUP_RECORDS check-constrains status to the six lifecycle states", () => {
    const status = META_BACKUP_RECORDS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'scheduled'");
    expect(status?.check).toContain("'verified'");
    expect(status?.check).toContain("'expired'");
  });

  it("META_FAILOVER_RECORDS check-constrains tier to the five DR tiers", () => {
    const tier = META_FAILOVER_RECORDS.columns.find((c) => c.name === "tier");
    expect(tier?.check).toContain("'tier_0_mission_critical'");
    expect(tier?.check).toContain("'tier_4_best_effort'");
  });

  it("META_FAILOVER_RECORDS check-constrains trigger to the five trigger kinds", () => {
    const trigger = META_FAILOVER_RECORDS.columns.find((c) => c.name === "trigger");
    expect(trigger?.check).toContain("'planned_drill'");
    expect(trigger?.check).toContain("'primary_outage'");
    expect(trigger?.check).toContain("'regional_failure'");
  });

  it("META_DR_DRILLS check-constrains outcome to the five outcomes", () => {
    const outcome = META_DR_DRILLS.columns.find((c) => c.name === "outcome");
    expect(outcome?.check).toContain("'passed'");
    expect(outcome?.check).toContain("'passed_with_findings'");
    expect(outcome?.check).toContain("'not_executed'");
  });

  it("META_DR_DRILLS check-constrains kind to the five drill kinds", () => {
    const kind = META_DR_DRILLS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'tabletop'");
    expect(kind?.check).toContain("'failover_test'");
    expect(kind?.check).toContain("'chaos_injection'");
  });

  it("META_AUTOSCALING_EVENTS check-constrains signal to the seven scaling signals", () => {
    const signal = META_AUTOSCALING_EVENTS.columns.find((c) => c.name === "signal");
    expect(signal?.check).toContain("'cpu_pct'");
    expect(signal?.check).toContain("'p99_latency_ms'");
    expect(signal?.check).toContain("'queue_depth'");
  });

  it("META_AUTOSCALING_EVENTS check-constrains decision to the four decisions", () => {
    const decision = META_AUTOSCALING_EVENTS.columns.find((c) => c.name === "decision");
    expect(decision?.check).toContain("'scale_up'");
    expect(decision?.check).toContain("'scale_down'");
    expect(decision?.check).toContain("'throttled'");
  });

  it("META_BUDGET_BREACHES check-constrains percentile to p50/p95/p99", () => {
    const percentile = META_BUDGET_BREACHES.columns.find((c) => c.name === "percentile");
    expect(percentile?.check).toContain("'p50'");
    expect(percentile?.check).toContain("'p95'");
    expect(percentile?.check).toContain("'p99'");
  });

  it("META_BUDGET_BREACHES check-constrains severity to info/warning/critical", () => {
    const severity = META_BUDGET_BREACHES.columns.find((c) => c.name === "severity");
    expect(severity?.check).toContain("'info'");
    expect(severity?.check).toContain("'warning'");
    expect(severity?.check).toContain("'critical'");
  });

  it("META_API_KEYS enforces ce_live_/ce_test_ prefix and status enum", () => {
    const prefix = META_API_KEYS.columns.find((c) => c.name === "key_prefix");
    expect(prefix?.check).toContain("ce_(live|test)_");
    const status = META_API_KEYS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'active'");
    expect(status?.check).toContain("'revoked'");
  });

  it("META_WEBHOOK_ENDPOINTS enforces https:// URL prefix and unique endpoint_id", () => {
    const url = META_WEBHOOK_ENDPOINTS.columns.find((c) => c.name === "url");
    expect(url?.check).toContain("https://");
    const eid = META_WEBHOOK_ENDPOINTS.columns.find((c) => c.name === "endpoint_id");
    expect(eid?.unique?.constraintName).toBe("webhook_endpoints_endpoint_id_key");
  });

  it("META_WEBHOOK_DELIVERIES check-constrains status to the six delivery states", () => {
    const status = META_WEBHOOK_DELIVERIES.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'pending'");
    expect(status?.check).toContain("'delivered'");
    expect(status?.check).toContain("'retrying'");
    expect(status?.check).toContain("'dropped'");
  });

  it("META_IDEMPOTENCY_RECORDS enforces (tenant_id, key) uniqueness", () => {
    expect(META_IDEMPOTENCY_RECORDS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "key",
    ]);
  });

  it("META_IDEMPOTENCY_RECORDS check-constrains key pattern (8..64 chars)", () => {
    const key = META_IDEMPOTENCY_RECORDS.columns.find((c) => c.name === "key");
    expect(key?.check).toContain("[A-Za-z0-9_-]{8,64}");
  });

  it("META_EXTENSION_PACKS check-constrains kind to the eight pack kinds", () => {
    const kind = META_EXTENSION_PACKS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'vertical_template'");
    expect(kind?.check).toContain("'ai_tool'");
    expect(kind?.check).toContain("'data_connector'");
  });

  it("META_EXTENSION_PACKS check-constrains author_kind to four types", () => {
    const ak = META_EXTENSION_PACKS.columns.find((c) => c.name === "author_kind");
    expect(ak?.check).toContain("'crossengin_official'");
    expect(ak?.check).toContain("'certified_partner'");
    expect(ak?.check).toContain("'private_tenant'");
  });

  it("META_PACK_VERSIONS enforces (pack_id, version) uniqueness + status enum", () => {
    expect(META_PACK_VERSIONS.uniqueConstraints?.[0]?.columns).toEqual([
      "pack_id",
      "version",
    ]);
    const status = META_PACK_VERSIONS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'published'");
    expect(status?.check).toContain("'withdrawn'");
  });

  it("META_PACK_VERSIONS check-constrains security_review_status to the five states", () => {
    const review = META_PACK_VERSIONS.columns.find((c) => c.name === "security_review_status");
    expect(review?.check).toContain("'pending'");
    expect(review?.check).toContain("'passed'");
    expect(review?.check).toContain("'exempt'");
  });

  it("META_PACK_INSTALLATIONS check-constrains status to eight lifecycle states", () => {
    const status = META_PACK_INSTALLATIONS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'requested'");
    expect(status?.check).toContain("'permission_pending'");
    expect(status?.check).toContain("'installed'");
    expect(status?.check).toContain("'uninstalled'");
  });

  it("META_PACK_INSTALLATIONS check-constrains update_policy to the four policies", () => {
    const policy = META_PACK_INSTALLATIONS.columns.find((c) => c.name === "update_policy");
    expect(policy?.check).toContain("'manual'");
    expect(policy?.check).toContain("'patch_auto'");
    expect(policy?.check).toContain("'track_latest'");
  });

  it("META_PACK_REVIEWS enforces (pack_id, tenant_id, author_id) uniqueness", () => {
    expect(META_PACK_REVIEWS.uniqueConstraints?.[0]?.columns).toEqual([
      "pack_id",
      "tenant_id",
      "author_id",
    ]);
  });

  it("META_PACK_REVIEWS check-constrains rating to 1..5", () => {
    const rating = META_PACK_REVIEWS.columns.find((c) => c.name === "rating");
    expect(rating?.check).toContain("BETWEEN 1 AND 5");
  });

  it("META_IMPORT_SOURCES check-constrains kind to the 12 source kinds", () => {
    const kind = META_IMPORT_SOURCES.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'csv'");
    expect(kind?.check).toContain("'salesforce'");
    expect(kind?.check).toContain("'fhir_r4'");
  });

  it("META_IMPORT_SOURCES enforces (tenant_id, source_id) uniqueness", () => {
    expect(META_IMPORT_SOURCES.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "source_id",
    ]);
  });

  it("META_BACKFILL_JOBS check-constrains status to the seven lifecycle states", () => {
    const status = META_BACKFILL_JOBS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'queued'");
    expect(status?.check).toContain("'completed_with_errors'");
    expect(status?.check).toContain("'paused'");
  });

  it("META_BACKFILL_JOBS check-constrains conflict_resolution to four strategies", () => {
    const cr = META_BACKFILL_JOBS.columns.find((c) => c.name === "conflict_resolution");
    expect(cr?.check).toContain("'skip_duplicate'");
    expect(cr?.check).toContain("'merge_fields'");
  });

  it("META_BACKFILL_LEDGER enforces (backfill_job_id, idempotency_key) uniqueness", () => {
    expect(META_BACKFILL_LEDGER.uniqueConstraints?.[0]?.columns).toEqual([
      "backfill_job_id",
      "idempotency_key",
    ]);
  });

  it("META_BACKFILL_LEDGER check-constrains outcome to the five outcomes", () => {
    const outcome = META_BACKFILL_LEDGER.columns.find((c) => c.name === "outcome");
    expect(outcome?.check).toContain("'inserted'");
    expect(outcome?.check).toContain("'merged'");
  });

  it("META_ONBOARDING_RUNS enforces one active run per tenant", () => {
    expect(META_ONBOARDING_RUNS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
    ]);
  });

  it("META_ONBOARDING_RUNS check-constrains current_stage to the seven stages", () => {
    const stage = META_ONBOARDING_RUNS.columns.find((c) => c.name === "current_stage");
    expect(stage?.check).toContain("'workspace_setup'");
    expect(stage?.check).toContain("'go_live'");
  });

  it("META_ONBOARDING_RUNS check-constrains path to the three onboarding paths", () => {
    const path = META_ONBOARDING_RUNS.columns.find((c) => c.name === "path");
    expect(path?.check).toContain("'bring_my_data'");
    expect(path?.check).toContain("'vertical_template'");
    expect(path?.check).toContain("'blank_workspace'");
  });

  it("META_ML_CONSENT check-constrains purpose to the five training purposes", () => {
    const purpose = META_ML_CONSENT.columns.find((c) => c.name === "purpose");
    expect(purpose?.check).toContain("'global_model_improvement'");
    expect(purpose?.check).toContain("'tenant_specific_finetune'");
    expect(purpose?.check).toContain("'redteam_evaluation'");
  });

  it("META_ML_CONSENT check-constrains legal_basis to three options", () => {
    const lb = META_ML_CONSENT.columns.find((c) => c.name === "legal_basis");
    expect(lb?.check).toContain("'consent'");
    expect(lb?.check).toContain("'contract'");
    expect(lb?.check).toContain("'legitimate_interest'");
  });

  it("META_ML_DATASETS check-constrains status to the four lifecycle states", () => {
    const status = META_ML_DATASETS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'drafting'");
    expect(status?.check).toContain("'frozen'");
    expect(status?.check).toContain("'purged'");
  });

  it("META_ML_EVALSETS check-constrains task_kind to the eight task kinds", () => {
    const tk = META_ML_EVALSETS.columns.find((c) => c.name === "task_kind");
    expect(tk?.check).toContain("'manifest_proposal'");
    expect(tk?.check).toContain("'safety_refusal'");
    expect(tk?.check).toContain("'regression_replay'");
  });

  it("META_ML_TRAINING_RUNS check-constrains status to the six lifecycle states", () => {
    const status = META_ML_TRAINING_RUNS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'queued'");
    expect(status?.check).toContain("'preparing'");
    expect(status?.check).toContain("'succeeded'");
  });

  it("META_ML_TRAINING_RUNS check-constrains kind to the six training kinds", () => {
    const kind = META_ML_TRAINING_RUNS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'supervised_finetune'");
    expect(kind?.check).toContain("'lora_adapter'");
    expect(kind?.check).toContain("'full_pretrain_continue'");
  });

  it("META_ML_EVALUATIONS check-constrains verdict to four values", () => {
    const v = META_ML_EVALUATIONS.columns.find((c) => c.name === "verdict");
    expect(v?.check).toContain("'passed'");
    expect(v?.check).toContain("'regressed'");
    expect(v?.check).toContain("'improved'");
  });

  it("META_ML_MODELS enforces (family, version) uniqueness", () => {
    expect(META_ML_MODELS.uniqueConstraints?.[0]?.columns).toEqual([
      "family",
      "version",
    ]);
  });

  it("META_ML_MODELS check-constrains status to the eight lifecycle states", () => {
    const status = META_ML_MODELS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'draft'");
    expect(status?.check).toContain("'canary'");
    expect(status?.check).toContain("'production'");
    expect(status?.check).toContain("'retired'");
  });

  it("META_COST_ATTRIBUTION check-constrains category to the 17 cost categories", () => {
    const cat = META_COST_ATTRIBUTION.columns.find((c) => c.name === "category");
    expect(cat?.check).toContain("'compute_serverless'");
    expect(cat?.check).toContain("'ai_inference'");
    expect(cat?.check).toContain("'license_fees'");
  });

  it("META_COST_ATTRIBUTION check-constrains allocation_method to five methods", () => {
    const am = META_COST_ATTRIBUTION.columns.find((c) => c.name === "allocation_method");
    expect(am?.check).toContain("'direct'");
    expect(am?.check).toContain("'proportional_usage'");
    expect(am?.check).toContain("'estimated'");
  });

  it("META_COST_BUDGETS enforces (tenant_id, budget_id) uniqueness", () => {
    expect(META_COST_BUDGETS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "budget_id",
    ]);
  });

  it("META_COST_BUDGETS check-constrains period to five values", () => {
    const period = META_COST_BUDGETS.columns.find((c) => c.name === "period");
    expect(period?.check).toContain("'daily'");
    expect(period?.check).toContain("'monthly'");
    expect(period?.check).toContain("'annual'");
  });

  it("META_TENANT_UNIT_ECONOMICS check-constrains health to five states", () => {
    const health = META_TENANT_UNIT_ECONOMICS.columns.find((c) => c.name === "health");
    expect(health?.check).toContain("'healthy'");
    expect(health?.check).toContain("'negative'");
    expect(health?.check).toContain("'loss_leader_approved'");
  });

  it("META_TENANT_UNIT_ECONOMICS enforces (tenant_id, period_start, period_end) uniqueness", () => {
    expect(META_TENANT_UNIT_ECONOMICS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "period_start",
      "period_end",
    ]);
  });

  it("META_CHARGEBACK_STATEMENTS check-constrains status to five states", () => {
    const status = META_CHARGEBACK_STATEMENTS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'draft'");
    expect(status?.check).toContain("'posted'");
    expect(status?.check).toContain("'voided'");
  });

  it("META_TENANT_LIFECYCLE_EVENTS check-constrains action to seven lifecycle actions", () => {
    const action = META_TENANT_LIFECYCLE_EVENTS.columns.find((c) => c.name === "action");
    expect(action?.check).toContain("'activate'");
    expect(action?.check).toContain("'execute_deletion'");
    expect(action?.check).toContain("'cancel_deletion'");
  });

  it("META_TENANT_LIFECYCLE_EVENTS check-constrains from/to_state to seven lifecycle states", () => {
    const fromState = META_TENANT_LIFECYCLE_EVENTS.columns.find((c) => c.name === "from_state");
    expect(fromState?.check).toContain("'trial'");
    expect(fromState?.check).toContain("'pending_deletion'");
    expect(fromState?.check).toContain("'deleted'");
  });

  it("META_GDPR_DELETION_REQUESTS check-constrains legal_basis to six bases", () => {
    const lb = META_GDPR_DELETION_REQUESTS.columns.find((c) => c.name === "legal_basis");
    expect(lb?.check).toContain("'article_17_right_to_erasure'");
    expect(lb?.check).toContain("'consent_withdrawn'");
    expect(lb?.check).toContain("'no_lawful_basis_remaining'");
  });

  it("META_GDPR_DELETION_REQUESTS check-constrains status to six states", () => {
    const status = META_GDPR_DELETION_REQUESTS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'submitted'");
    expect(status?.check).toContain("'verified'");
    expect(status?.check).toContain("'deferred'");
  });

  it("META_TENANT_DATA_EXPORTS check-constrains trigger to five sources", () => {
    const trigger = META_TENANT_DATA_EXPORTS.columns.find((c) => c.name === "trigger");
    expect(trigger?.check).toContain("'customer_request'");
    expect(trigger?.check).toContain("'pre_deletion_archive'");
    expect(trigger?.check).toContain("'regulatory_subpoena'");
  });

  it("META_TENANT_DATA_EXPORTS check-constrains format to five formats", () => {
    const fmt = META_TENANT_DATA_EXPORTS.columns.find((c) => c.name === "format");
    expect(fmt?.check).toContain("'json'");
    expect(fmt?.check).toContain("'parquet'");
    expect(fmt?.check).toContain("'sql_dump'");
  });

  it("META_TENANT_TOMBSTONES enforces unique tombstone_id with 'tomb_' prefix", () => {
    const tid = META_TENANT_TOMBSTONES.columns.find((c) => c.name === "tombstone_id");
    expect(tid?.unique?.constraintName).toBe("tenant_tombstones_tombstone_id_key");
    expect(tid?.check).toContain("tomb_");
  });

  it("META_TENANT_TOMBSTONES check-constrains kind to five tombstone kinds", () => {
    const kind = META_TENANT_TOMBSTONES.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'tenant_deletion'");
    expect(kind?.check).toContain("'data_subject_erasure'");
    expect(kind?.check).toContain("'abandoned_export_purge'");
  });

  it("META_INCIDENTS enforces unique incident_id with INC-YYYY-NNNN pattern", () => {
    const iid = META_INCIDENTS.columns.find((c) => c.name === "incident_id");
    expect(iid?.unique?.constraintName).toBe("incidents_incident_id_key");
    expect(iid?.check).toContain("INC-");
  });

  it("META_INCIDENTS check-constrains severity to sev1..sev5", () => {
    const sev = META_INCIDENTS.columns.find((c) => c.name === "severity");
    expect(sev?.check).toContain("'sev1'");
    expect(sev?.check).toContain("'sev5'");
  });

  it("META_INCIDENTS check-constrains status to the eight lifecycle states", () => {
    const status = META_INCIDENTS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'declared'");
    expect(status?.check).toContain("'mitigated'");
    expect(status?.check).toContain("'postmortem_pending'");
  });

  it("META_INCIDENT_RUNBOOK_EXECUTIONS check-constrains status to six values", () => {
    const status = META_INCIDENT_RUNBOOK_EXECUTIONS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'queued'");
    expect(status?.check).toContain("'succeeded'");
    expect(status?.check).toContain("'aborted'");
  });

  it("META_INCIDENT_POSTMORTEMS enforces PM-YYYY-NNNN pattern + four-status enum", () => {
    const pid = META_INCIDENT_POSTMORTEMS.columns.find((c) => c.name === "postmortem_id");
    expect(pid?.check).toContain("PM-");
    const status = META_INCIDENT_POSTMORTEMS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'drafting'");
    expect(status?.check).toContain("'amended'");
  });

  it("META_INCIDENT_COMMUNICATIONS check-constrains audience to seven values", () => {
    const audience = META_INCIDENT_COMMUNICATIONS.columns.find((c) => c.name === "audience");
    expect(audience?.check).toContain("'status_page_public'");
    expect(audience?.check).toContain("'regulators'");
    expect(audience?.check).toContain("'law_enforcement'");
  });

  it("META_INCIDENT_COMMUNICATIONS check-constrains kind to seven values incl breach_notification", () => {
    const kind = META_INCIDENT_COMMUNICATIONS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'breach_notification'");
    expect(kind?.check).toContain("'postmortem_published'");
  });

  it("META_FORENSIC_EVIDENCE check-constrains kind to ten evidence kinds", () => {
    const kind = META_FORENSIC_EVIDENCE.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'log_export'");
    expect(kind?.check).toContain("'memory_dump'");
    expect(kind?.check).toContain("'expert_report'");
  });

  it("META_FORENSIC_EVIDENCE check-constrains sensitivity to six levels incl attorney_client_privileged", () => {
    const sens = META_FORENSIC_EVIDENCE.columns.find((c) => c.name === "sensitivity");
    expect(sens?.check).toContain("'attorney_client_privileged'");
    expect(sens?.check).toContain("'national_security'");
  });

  it("META_CHAIN_OF_CUSTODY check-constrains action to nine custody actions", () => {
    const action = META_CHAIN_OF_CUSTODY.columns.find((c) => c.name === "action");
    expect(action?.check).toContain("'collected'");
    expect(action?.check).toContain("'transferred'");
    expect(action?.check).toContain("'destroyed'");
  });

  it("META_LEGAL_HOLDS check-constrains status to five states", () => {
    const status = META_LEGAL_HOLDS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'draft'");
    expect(status?.check).toContain("'active'");
    expect(status?.check).toContain("'released'");
  });

  it("META_LEGAL_HOLDS check-constrains kind to seven hold kinds", () => {
    const kind = META_LEGAL_HOLDS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'litigation'");
    expect(kind?.check).toContain("'subpoena'");
    expect(kind?.check).toContain("'preservation_letter'");
  });

  it("META_EDISCOVERY_REQUESTS check-constrains status to eight lifecycle states", () => {
    const status = META_EDISCOVERY_REQUESTS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'scoped'");
    expect(status?.check).toContain("'producing'");
    expect(status?.check).toContain("'objected'");
  });

  it("META_EDISCOVERY_REQUESTS check-constrains production_format to five formats", () => {
    const fmt = META_EDISCOVERY_REQUESTS.columns.find((c) => c.name === "production_format");
    expect(fmt?.check).toContain("'native'");
    expect(fmt?.check).toContain("'pdf_with_load_file'");
    expect(fmt?.check).toContain("'tiff_with_load_file'");
  });

  it("META_AA_TOPOLOGY check-constrains kind to four topology kinds", () => {
    const kind = META_AA_TOPOLOGY.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'single_primary'");
    expect(kind?.check).toContain("'active_active'");
    expect(kind?.check).toContain("'multi_master_partitioned'");
  });

  it("META_AA_TOPOLOGY check-constrains partition_strategy to five strategies", () => {
    const ps = META_AA_TOPOLOGY.columns.find((c) => c.name === "partition_strategy");
    expect(ps?.check).toContain("'tenant_hash'");
    expect(ps?.check).toContain("'tenant_residency'");
    expect(ps?.check).toContain("'geographic'");
  });

  it("META_AA_CONFLICTS check-constrains kind to six conflict kinds", () => {
    const kind = META_AA_CONFLICTS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'concurrent_write'");
    expect(kind?.check).toContain("'delete_update_race'");
    expect(kind?.check).toContain("'tenant_residency_violation'");
  });

  it("META_AA_CONFLICTS check-constrains chosen_strategy to seven strategies", () => {
    const cs = META_AA_CONFLICTS.columns.find((c) => c.name === "chosen_strategy");
    expect(cs?.check).toContain("'last_writer_wins'");
    expect(cs?.check).toContain("'vector_clock_merge'");
    expect(cs?.check).toContain("'manual_review'");
  });

  it("META_AA_SPLIT_BRAIN_EVENTS check-constrains kind to five partition kinds", () => {
    const kind = META_AA_SPLIT_BRAIN_EVENTS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'network_partition'");
    expect(kind?.check).toContain("'asymmetric_partition'");
    expect(kind?.check).toContain("'clock_skew'");
  });

  it("META_AA_SPLIT_BRAIN_EVENTS check-constrains status to five lifecycle states", () => {
    const status = META_AA_SPLIT_BRAIN_EVENTS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'detected'");
    expect(status?.check).toContain("'healing'");
    expect(status?.check).toContain("'permanent_partition'");
  });

  it("META_SDK_CLIENT_RELEASES check-constrains language to ten targets", () => {
    const lang = META_SDK_CLIENT_RELEASES.columns.find((c) => c.name === "language");
    expect(lang?.check).toContain("'typescript'");
    expect(lang?.check).toContain("'python'");
    expect(lang?.check).toContain("'kotlin'");
  });

  it("META_SDK_CLIENT_RELEASES check-constrains channel to four channels", () => {
    const channel = META_SDK_CLIENT_RELEASES.columns.find((c) => c.name === "channel");
    expect(channel?.check).toContain("'stable'");
    expect(channel?.check).toContain("'beta'");
    expect(channel?.check).toContain("'nightly'");
  });

  it("META_SDK_CLIENT_RELEASES check-constrains status to five lifecycle states", () => {
    const status = META_SDK_CLIENT_RELEASES.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'published'");
    expect(status?.check).toContain("'deprecated'");
    expect(status?.check).toContain("'yanked'");
  });

  it("META_SDK_CLIENT_RELEASES enforces (language, version) uniqueness", () => {
    expect(META_SDK_CLIENT_RELEASES.uniqueConstraints?.[0]?.columns).toEqual([
      "language",
      "version",
    ]);
  });

  it("META_SDK_CLIENT_INSTALLATIONS enforces (tenant_id, language, client_version) uniqueness", () => {
    expect(META_SDK_CLIENT_INSTALLATIONS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "language",
      "client_version",
    ]);
  });

  it("META_SDK_CLIENT_INSTALLATIONS check-constrains upgrade_nag_status to four values", () => {
    const nag = META_SDK_CLIENT_INSTALLATIONS.columns.find(
      (c) => c.name === "upgrade_nag_status",
    );
    expect(nag?.check).toContain("'none'");
    expect(nag?.check).toContain("'soft_warning'");
    expect(nag?.check).toContain("'forced_upgrade_required'");
  });

  it("META_SSO_PROVIDERS protocol enum has saml and oidc", () => {
    const protocol = META_SSO_PROVIDERS.columns.find((c) => c.name === "protocol");
    expect(protocol?.check).toContain("'saml'");
    expect(protocol?.check).toContain("'oidc'");
  });

  it("META_SSO_PROVIDERS allows NULL tenant_id (platform-wide providers)", () => {
    const tenantId = META_SSO_PROVIDERS.columns.find((c) => c.name === "tenant_id");
    expect(tenantId?.notNull).not.toBe(true);
    expect(META_SSO_PROVIDERS.rls?.policies?.[0]?.using).toContain("IS NULL OR");
  });

  it("META_SSO_LOGINS check-constrains outcome to the 8 SSO outcomes", () => {
    const outcome = META_SSO_LOGINS.columns.find((c) => c.name === "outcome");
    expect(outcome?.check).toContain("'success'");
    expect(outcome?.check).toContain("'mfa_required'");
    expect(outcome?.check).toContain("'denied_by_policy'");
  });

  it("META_SSO_SESSIONS check-constrains status to four values", () => {
    const status = META_SSO_SESSIONS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'active'");
    expect(status?.check).toContain("'expired'");
    expect(status?.check).toContain("'revoked'");
    expect(status?.check).toContain("'logged_out'");
  });

  it("META_SCIM_CLIENTS bearer_token_sha256 is CHAR(64) with hex check", () => {
    const tok = META_SCIM_CLIENTS.columns.find(
      (c) => c.name === "bearer_token_sha256",
    );
    expect(tok?.type).toBe("CHAR(64)");
    expect(tok?.check).toContain("[0-9a-f]{64}");
  });

  it("META_SCIM_PROVISIONING resource_type enum has the 5 SCIM resource types", () => {
    const rt = META_SCIM_PROVISIONING.columns.find(
      (c) => c.name === "resource_type",
    );
    expect(rt?.check).toContain("'User'");
    expect(rt?.check).toContain("'Group'");
    expect(rt?.check).toContain("'EnterpriseUser'");
    expect(rt?.check).toContain("'Role'");
    expect(rt?.check).toContain("'Entitlement'");
  });

  it("META_NOTIFICATION_TEMPLATES enforces (tenant, template, channel, locale, version) uniqueness", () => {
    expect(
      META_NOTIFICATION_TEMPLATES.uniqueConstraints?.[0]?.columns,
    ).toEqual([
      "tenant_id",
      "template_id",
      "channel",
      "locale",
      "version",
    ]);
  });

  it("META_NOTIFICATION_TEMPLATES allows NULL tenant_id (platform templates)", () => {
    const tenantId = META_NOTIFICATION_TEMPLATES.columns.find(
      (c) => c.name === "tenant_id",
    );
    expect(tenantId?.notNull).not.toBe(true);
    expect(
      META_NOTIFICATION_TEMPLATES.rls?.policies?.[0]?.using,
    ).toContain("IS NULL OR");
  });

  it("META_NOTIFICATION_PREFERENCES enforces (tenant, user, category, channel) uniqueness", () => {
    expect(
      META_NOTIFICATION_PREFERENCES.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "user_id", "category", "channel"]);
  });

  it("META_NOTIFICATION_SUPPRESSIONS enforces (tenant, channel, address) uniqueness", () => {
    expect(
      META_NOTIFICATION_SUPPRESSIONS.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "channel", "recipient_address"]);
  });

  it("META_NOTIFICATION_SUPPRESSIONS check-constrains reason to the 7 suppression reasons", () => {
    const reason = META_NOTIFICATION_SUPPRESSIONS.columns.find(
      (c) => c.name === "reason",
    );
    expect(reason?.check).toContain("'hard_bounce'");
    expect(reason?.check).toContain("'spam_complaint'");
    expect(reason?.check).toContain("'unsubscribe'");
    expect(reason?.check).toContain("'regulatory_block'");
  });

  it("META_NOTIFICATION_DISPATCHES enforces (tenant, idempotency_key) uniqueness", () => {
    expect(
      META_NOTIFICATION_DISPATCHES.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "idempotency_key"]);
  });

  it("META_NOTIFICATION_DISPATCHES check-constrains priority to 5 levels", () => {
    const priority = META_NOTIFICATION_DISPATCHES.columns.find(
      (c) => c.name === "priority",
    );
    expect(priority?.check).toContain("'critical'");
    expect(priority?.check).toContain("'background'");
  });

  it("META_NOTIFICATION_DELIVERIES cascades on dispatch deletion", () => {
    const fk = META_NOTIFICATION_DELIVERIES.columns.find(
      (c) => c.name === "dispatch_id",
    );
    expect(fk?.references?.onDelete).toBe("CASCADE");
  });

  it("META_NOTIFICATION_DIGESTS frequency excludes immediate and never (batches only)", () => {
    const freq = META_NOTIFICATION_DIGESTS.columns.find(
      (c) => c.name === "frequency",
    );
    expect(freq?.check).not.toContain("'immediate'");
    expect(freq?.check).not.toContain("'never'");
    expect(freq?.check).toContain("'hourly'");
    expect(freq?.check).toContain("'daily'");
  });

  it("META_ACCESS_REVIEW_TEMPLATES allows NULL tenant_id (platform templates)", () => {
    const tenantId = META_ACCESS_REVIEW_TEMPLATES.columns.find(
      (c) => c.name === "tenant_id",
    );
    expect(tenantId?.notNull).not.toBe(true);
    expect(
      META_ACCESS_REVIEW_TEMPLATES.rls?.policies?.[0]?.using,
    ).toContain("IS NULL OR");
  });

  it("META_ACCESS_REVIEW_TEMPLATES framework enum covers SOC 2, ISO 27001, HIPAA, PCI, GDPR, CFR 21", () => {
    const framework = META_ACCESS_REVIEW_TEMPLATES.columns.find(
      (c) => c.name === "framework",
    );
    expect(framework?.check).toContain("'soc2_type2'");
    expect(framework?.check).toContain("'iso27001'");
    expect(framework?.check).toContain("'hipaa_security_rule'");
    expect(framework?.check).toContain("'pci_dss_v4'");
    expect(framework?.check).toContain("'cfr_21_part_11'");
  });

  it("META_ACCESS_REVIEW_CAMPAIGNS status enum has the 7 lifecycle states", () => {
    const status = META_ACCESS_REVIEW_CAMPAIGNS.columns.find(
      (c) => c.name === "status",
    );
    expect(status?.check).toContain("'draft'");
    expect(status?.check).toContain("'scheduled'");
    expect(status?.check).toContain("'in_progress'");
    expect(status?.check).toContain("'in_remediation'");
    expect(status?.check).toContain("'completed'");
    expect(status?.check).toContain("'archived'");
    expect(status?.check).toContain("'cancelled'");
  });

  it("META_ACCESS_REVIEW_ITEMS cascades on campaign deletion", () => {
    const fk = META_ACCESS_REVIEW_ITEMS.columns.find(
      (c) => c.name === "campaign_id",
    );
    expect(fk?.references?.onDelete).toBe("CASCADE");
  });

  it("META_ACCESS_REVIEW_ITEMS risk_level enum has 4 levels", () => {
    const risk = META_ACCESS_REVIEW_ITEMS.columns.find(
      (c) => c.name === "risk_level",
    );
    expect(risk?.check).toContain("'low'");
    expect(risk?.check).toContain("'critical'");
  });

  it("META_ACCESS_REVIEW_DECISIONS attestation enum has the 5 attestation kinds", () => {
    const att = META_ACCESS_REVIEW_DECISIONS.columns.find(
      (c) => c.name === "attestation_kind",
    );
    expect(att?.check).toContain("'click_through_acknowledgement'");
    expect(att?.check).toContain("'qualified_e_signature'");
    expect(att?.check).toContain("'two_person_attestation'");
  });

  it("META_ACCESS_REVIEW_DECISIONS cascades on item deletion + restricts on campaign", () => {
    const itemFk = META_ACCESS_REVIEW_DECISIONS.columns.find(
      (c) => c.name === "item_id",
    );
    const campaignFk = META_ACCESS_REVIEW_DECISIONS.columns.find(
      (c) => c.name === "campaign_id",
    );
    expect(itemFk?.references?.onDelete).toBe("CASCADE");
    expect(campaignFk?.references?.onDelete).toBe("RESTRICT");
  });

  it("META_ACCESS_REVIEW_EXCEPTIONS reason enum covers emergency + regulatory categories", () => {
    const reason = META_ACCESS_REVIEW_EXCEPTIONS.columns.find(
      (c) => c.name === "reason",
    );
    expect(reason?.check).toContain("'emergency_break_glass'");
    expect(reason?.check).toContain("'regulatory_exemption'");
    expect(reason?.check).toContain("'dual_role_business_need'");
  });

  it("META_ACCESS_REVIEW_EVIDENCE rates are NUMERIC(5, 4) bounded 0-1", () => {
    const completion = META_ACCESS_REVIEW_EVIDENCE.columns.find(
      (c) => c.name === "completion_rate",
    );
    expect(completion?.type).toBe("NUMERIC(5, 4)");
    expect(completion?.check).toContain("BETWEEN 0 AND 1");
  });

  it("META_ACCESS_REVIEW_EVIDENCE sealed_sha256 is CHAR(64) hex", () => {
    const sha = META_ACCESS_REVIEW_EVIDENCE.columns.find(
      (c) => c.name === "sealed_sha256",
    );
    expect(sha?.type).toBe("CHAR(64)");
    expect(sha?.check).toContain("[0-9a-f]{64}");
  });

  it("META_WORKFLOW_DEFINITIONS allows NULL tenant_id (platform definitions)", () => {
    const tenantId = META_WORKFLOW_DEFINITIONS.columns.find(
      (c) => c.name === "tenant_id",
    );
    expect(tenantId?.notNull).not.toBe(true);
    expect(
      META_WORKFLOW_DEFINITIONS.rls?.policies?.[0]?.using,
    ).toContain("IS NULL OR");
  });

  it("META_WORKFLOW_DEFINITIONS enforces (tenant, key, version) uniqueness", () => {
    expect(
      META_WORKFLOW_DEFINITIONS.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "definition_key", "version"]);
  });

  it("META_WORKFLOW_DEFINITIONS compensation_strategy enum has 4 strategies", () => {
    const strat = META_WORKFLOW_DEFINITIONS.columns.find(
      (c) => c.name === "compensation_strategy",
    );
    expect(strat?.check).toContain("'immediate_reverse_order'");
    expect(strat?.check).toContain("'manual_review'");
    expect(strat?.check).toContain("'no_compensation'");
  });

  it("META_WORKFLOW_INSTANCES status enum covers 12 lifecycle states", () => {
    const status = META_WORKFLOW_INSTANCES.columns.find(
      (c) => c.name === "status",
    );
    expect(status?.check).toContain("'running'");
    expect(status?.check).toContain("'waiting_for_signal'");
    expect(status?.check).toContain("'compensating'");
    expect(status?.check).toContain("'compensated'");
  });

  it("META_WORKFLOW_INSTANCES has parent FK pointing back to instances (child workflows)", () => {
    const parent = META_WORKFLOW_INSTANCES.columns.find(
      (c) => c.name === "parent_instance_id",
    );
    expect(parent?.references?.table).toBe("workflow_instances");
  });

  it("META_WORKFLOW_ACTIVITIES cascades on instance deletion", () => {
    const fk = META_WORKFLOW_ACTIVITIES.columns.find(
      (c) => c.name === "instance_id",
    );
    expect(fk?.references?.onDelete).toBe("CASCADE");
  });

  it("META_WORKFLOW_ACTIVITIES kind enum covers 10 activity kinds", () => {
    const kind = META_WORKFLOW_ACTIVITIES.columns.find(
      (c) => c.name === "kind",
    );
    expect(kind?.check).toContain("'http_call'");
    expect(kind?.check).toContain("'manual_task'");
    expect(kind?.check).toContain("'child_workflow'");
    expect(kind?.check).toContain("'compensation'");
  });

  it("META_WORKFLOW_SIGNALS delivery_guarantee enum has 3 levels", () => {
    const delivery = META_WORKFLOW_SIGNALS.columns.find(
      (c) => c.name === "delivery_guarantee",
    );
    expect(delivery?.check).toContain("'at_most_once'");
    expect(delivery?.check).toContain("'at_least_once'");
    expect(delivery?.check).toContain("'exactly_once_idempotent'");
  });

  it("META_WORKFLOW_SIGNALS enforces (tenant, name, idempotency_key) uniqueness", () => {
    expect(
      META_WORKFLOW_SIGNALS.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "signal_name", "idempotency_key"]);
  });

  it("META_WORKFLOW_TIMERS kind enum has 4 kinds", () => {
    const kind = META_WORKFLOW_TIMERS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'absolute_at'");
    expect(kind?.check).toContain("'relative_after'");
    expect(kind?.check).toContain("'cron_schedule'");
    expect(kind?.check).toContain("'business_hours'");
  });

  it("META_WORKFLOW_EVENTS enforces append-only per-instance ordering via unique (instance, sequence)", () => {
    expect(
      META_WORKFLOW_EVENTS.uniqueConstraints?.[0]?.columns,
    ).toEqual(["instance_id", "sequence_number"]);
  });

  it("META_WORKFLOW_EVENTS cascades on instance deletion", () => {
    const fk = META_WORKFLOW_EVENTS.columns.find(
      (c) => c.name === "instance_id",
    );
    expect(fk?.references?.onDelete).toBe("CASCADE");
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
