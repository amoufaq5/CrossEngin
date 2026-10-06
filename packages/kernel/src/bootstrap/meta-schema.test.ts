import { describe, expect, it } from "vitest";
import type { ColumnDefinition, TableDefinition } from "./types.js";
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
  META_AUDIT_INTEGRITY_VERDICTS,
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
  META_DATA_SUBJECTS,
  META_DEAD_LETTER_JOBS,
  META_DEPLOYMENTS,
  META_DR_DRILLS,
  META_EDISCOVERY_REQUESTS,
  META_EVENTS,
  META_EXTENSION_PACKS,
  META_FAILOVER_RECORDS,
  META_FORENSIC_EVIDENCE,
  META_FEATURE_FLAGS,
  META_FEATURE_FLAG_CHANGES,
  META_FEATURE_FLAG_EVALUATIONS,
  META_FEATURE_FLAG_KILL_SWITCHES,
  META_FEATURE_FLAG_TARGETING_RULES,
  META_GATEWAY_IDEMPOTENCY_RECORDS,
  META_GATEWAY_PIPELINE_EXECUTIONS,
  META_GATEWAY_ROUTES,
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
  META_LINEAGE_EDGES,
  META_LINEAGE_NODES,
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
  META_PROVENANCE_RECORDS,
  META_QUOTA_DEFINITIONS,
  META_QUOTA_USAGE,
  META_RATE_LIMIT_DECISIONS,
  META_RATE_LIMIT_EXCEPTIONS,
  META_RATE_LIMIT_POLICIES,
  META_REGIONS,
  META_REPORT_RUNS,
  META_SCHEDULED_EXPORTS,
  META_SCIM_CLIENTS,
  META_SCIM_PROVISIONING,
  META_SDK_CLIENT_INSTALLATIONS,
  META_SDK_CLIENT_RELEASES,
  META_OPERATE_ENTITY_RECORDS,
  META_OPERATE_TENANT_MANIFESTS,
  META_SLO_ENFORCEMENT_ACTIONS,
  META_SLO_EVALUATIONS,
  META_SLO_LATENCY_EVALUATIONS,
  META_SSO_LOGINS,
  META_SSO_PROVIDERS,
  META_SSO_SESSIONS,
  META_SUBJECT_ACCESS_REQUESTS,
  META_SUBJECT_NODE_OCCURRENCES,
  META_SUBSCRIPTIONS,
  META_TABLES,
  META_TENANT_AI_SETTINGS,
  META_TENANT_CREDITS,
  META_TENANT_DATA_EXPORTS,
  META_TENANT_LIFECYCLE_EVENTS,
  META_TENANT_STORAGE_USAGE,
  META_ARCHITECT_ESTIMATE_INFLATION,
  META_NOTIFICATION_READ_STATES,
  META_WORKFLOW_INSTANCES,
  META_TENANT_TOMBSTONES,
  META_TENANT_UNIT_ECONOMICS,
  META_TENANTS,
  META_THROTTLE_EVENTS,
  META_USER_TENANT_MEMBERSHIP,
  META_USERS,
  META_WEBHOOK_DELIVERIES,
  META_WEBHOOK_ENDPOINTS,
  META_WORKFLOW_ACTIVITIES,
  META_WORKFLOW_DEFINITIONS,
  META_WORKFLOW_EVENTS,
  META_WORKFLOW_SIGNALS,
  META_WORKFLOW_TIMERS,
} from "./meta-schema.js";

/**
 * The named unique constraint on a column, or undefined when the column declares bare `unique: true`.
 * `unique` is a union, so reading `.constraintName` straight off it does not typecheck — and a column
 * that lost its constraint name should fail these assertions, not skip them.
 */
function uniqueConstraintName(column: ColumnDefinition | undefined): string | undefined {
  const unique = column?.unique;
  return typeof unique === "object" ? unique.constraintName : undefined;
}


/**
 * The isolation predicate every tenant-scoped policy carries. Spelled here rather than exported
 * from the catalog: it is module-private there for a reason, and a test that imports it could not
 * then catch the catalog changing it. "The two agree" is asserted over the whole catalog instead.
 */
const TENANT_ISOLATION_USING =
  "tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID";

/**
 * A table's platform read arm, which since ADR-0332 is a `SELECT`-scoped policy of its own rather
 * than an `OR` inside the isolation one. Found by its predicate, not by its name, so a renamed
 * policy still satisfies the assertions that use this.
 */
function platformReadOf(t: TableDefinition) {
  return (t.rls?.policies ?? []).find((p) => (p.using ?? "").trim() === "tenant_id IS NULL");
}

/**
 * The four grants an `INSERT`- or `UPDATE`-scoped platform policy may check (ADR-0332).
 *
 * Spelled here rather than imported from `@crossengin/kernel-pg`, which would invert the package
 * dependency. The other direction is asserted in `kernel-pg`'s `connection.test.ts`, which reads
 * the real catalog and refuses a GUC the vocabulary does not spell — both directions are wanted,
 * because a name with two copies is exactly what ADR-0288 is the standing lesson about.
 */
const PLATFORM_WRITE_GRANTS_IN_CATALOG = [
  "app.platform_audit_write",
  "app.platform_record_write",
  "app.platform_config_write",
  "app.platform_key_write",
] as const;

interface PolicyClause {
  readonly table: string;
  readonly name: string;
  readonly command: string;
  readonly clause: string;
}

function policyClauses(): readonly PolicyClause[] {
  return META_TABLES.flatMap((t) =>
    (t.rls?.policies ?? []).flatMap((pol) =>
      [pol.using, pol.check]
        .filter((c): c is string => c !== undefined)
        .map((clause) => ({ table: t.name, name: pol.name, command: pol.command ?? "ALL", clause })),
    ),
  );
}

function grantedClauses(): readonly PolicyClause[] {
  return policyClauses().filter((c) =>
    PLATFORM_WRITE_GRANTS_IN_CATALOG.some((g) => c.clause.includes(g)),
  );
}

describe("the platform write grants", () => {
  it("is checked by every one of the four, so none is declared with nothing behind it", () => {
    const all = policyClauses()
      .map((c) => c.clause)
      .join(" ");
    for (const guc of PLATFORM_WRITE_GRANTS_IN_CATALOG) expect(all).toContain(guc);
  });

  it("is checked only by INSERT- and UPDATE-scoped policies", () => {
    // On an `ALL`-scope policy the `USING` expression also serves as the `WITH CHECK`, which is the
    // defect this increment closes — and it would hand the grant a DELETE besides. Nothing in the
    // catalog deletes a platform row (retirement is a status column in every one of these
    // contracts), so `DELETE` is deliberately reachable by no policy at all.
    for (const c of grantedClauses()) {
      expect(`${c.table}.${c.name}: ${c.command}`).toMatch(/: (INSERT|UPDATE)$/);
    }
  });

  it("is always ANDed with `tenant_id IS NULL` in the clause that checks it", () => {
    // So holding a write elevation buys no access to any *tenant's* rows: the isolation policy is
    // still the only route to one, and it still demands that tenant's context.
    for (const c of grantedClauses()) {
      expect(`${c.table}.${c.name}: ${c.clause}`).toContain("tenant_id IS NULL");
    }
  });

  it("never appears on a SELECT policy", () => {
    // ADR-0313's rule as a catalog-wide assertion: a grant that authorises a write must never also
    // be a route to another tenant's rows. The cross-tenant *read* grant is `app.platform_audit`,
    // which has no `_write` suffix and so is not in this list at all.
    for (const c of policyClauses()) {
      if (c.command !== "SELECT") continue;
      for (const guc of PLATFORM_WRITE_GRANTS_IN_CATALOG) {
        expect(`${c.table}.${c.name}: ${c.clause}`).not.toContain(guc);
      }
    }
  });
});

describe("no table carries the permissive platform arm any more", () => {
  const PERMISSIVE =
    "tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID";

  it("is spelled by no policy in the catalog", () => {
    // It was spelled by 29, and on every one `tenant_id IS NULL` satisfied the `WITH CHECK`
    // unconditionally, so any tenant session could insert, update or delete a platform-wide row.
    // Demonstrated live as a non-owner role before the split: an `INSERT 0 1` of a platform-wide
    // quota definition, an `UPDATE 1` of the platform flag gating JWT audience checking, and a
    // `DELETE 1` of it — three statements, three successes, from a plain tenant session.
    const offenders = META_TABLES.flatMap((t) =>
      (t.rls?.policies ?? [])
        .filter((pol) => pol.using === PERMISSIVE || pol.check === PERMISSIVE)
        .map((pol) => `${t.name}.${pol.name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("gives a platform read arm the SELECT scope and never a wider one", () => {
    // The replacement shape, asserted as a rule rather than as a list of 29: a platform row stays
    // readable by anyone (an integrity pass and a template resolver both need that) and is writable
    // only under an elevation.
    for (const t of META_TABLES) {
      const arm = platformReadOf(t);
      if (arm === undefined) continue;
      expect(`${t.name}.${arm.name}`).toBe(`${t.name}.${arm.name}`);
      expect(arm.command).toBe("SELECT");
    }
  });

  it("pairs every platform read arm with exactly one INSERT arm", () => {
    // A read arm with no write arm would be a table whose platform row nothing can create; a second
    // write arm would be a second route to one. Both are findings rather than configurations.
    for (const t of META_TABLES) {
      if (platformReadOf(t) === undefined) continue;
      const inserts = (t.rls?.policies ?? []).filter((pol) => pol.command === "INSERT");
      expect(`${t.name}: ${inserts.length.toString()} INSERT arm(s)`).toBe(`${t.name}: 1 INSERT arm(s)`);
    }
  });
});

describe("META_TABLES", () => {
  it("contains 145 tables", () => {
    expect(META_TABLES).toHaveLength(145);
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
      "architect_estimate_inflation",
      "architect_messages",
      "architect_proposals",
      "architect_sessions",
      "architect_tenant_cost",
      "architect_tool_invocations",
      "audit_integrity_verdicts",
      "audit_log",
      "autoscaling_events",
      "backfill_jobs",
      "backfill_ledger",
      "backup_records",
      "billing_events",
      "billing_subscriptions",
      "billing_usage_records",
      "budget_breaches",
      "cdc_checkpoints",
      "certification_reports",
      "chain_of_custody",
      "chargeback_statements",
      "compliance_attestations",
      "cost_attribution",
      "cost_budgets",
      "crypto_audit",
      "crypto_keys",
      "data_subjects",
      "dead_letter_jobs",
      "deployments",
      "dr_drill_executions",
      "dr_drills",
      "dr_failover_executions",
      "dr_readiness_snapshots",
      "ediscovery_requests",
      "events",
      "extension_packs",
      "failover_records",
      "feature_flag_changes",
      "feature_flag_evaluations",
      "feature_flag_kill_switches",
      "feature_flag_targeting_rules",
      "feature_flags",
      "files",
      "forensic_chain_checkpoints",
      "forensic_chain_entries",
      "forensic_evidence",
      "gateway_idempotency_records",
      "gateway_pipeline_executions",
      "gateway_routes",
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
      "lineage_edges",
      "lineage_nodes",
      "manifests",
      "ml_consent",
      "ml_datasets",
      "ml_evalsets",
      "ml_evaluations",
      "ml_models",
      "ml_training_runs",
      "notification_deliveries",
      "notification_digest_items",
      "notification_digests",
      "notification_dispatches",
      "notification_fax_observations",
      "notification_preferences",
      "notification_read_states",
      "notification_read_watermarks",
      "notification_suppressions",
      "notification_templates",
      "notification_user_quiet_hours",
      "onboarding_runs",
      "operate_design_jobs",
      "operate_entity_links",
      "operate_entity_records",
      "operate_sequences",
      "operate_tenant_manifests",
      "operate_tenant_settings",
      "pack_installations",
      "pack_reviews",
      "pack_versions",
      "plans",
      "provenance_records",
      "quota_definitions",
      "quota_usage",
      "rate_limit_decisions",
      "rate_limit_exceptions",
      "rate_limit_policies",
      "regions",
      "report_runs",
      "scheduled_exports",
      "scim_clients",
      "scim_provisioning",
      "sdk_client_installations",
      "sdk_client_releases",
      "slo_enforcement_actions",
      "slo_evaluations",
      "slo_latency_evaluations",
      "sso_logins",
      "sso_providers",
      "sso_sessions",
      "subject_access_requests",
      "subject_node_occurrences",
      "subscriptions",
      "tenant_ai_settings",
      "tenant_credits",
      "tenant_data_exports",
      "tenant_lifecycle_events",
      "tenant_residency_profiles",
      "tenant_storage_usage",
      "tenant_tombstones",
      "tenant_unit_economics",
      "tenants",
      "throttle_events",
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

describe("tenant isolation predicates", () => {
  it("never casts the tenant GUC without NULLIF", () => {
    // `current_setting(x, true)` answers NULL only until the setting has been used once on a
    // connection; after a transaction-local `set_config` ends, its reset value is the empty string,
    // and `''::UUID` raises rather than returning no rows. Measured on a real cluster — a fresh psql
    // session does not reproduce it, a pooled connection that has served one tenant does. So the
    // guard is an invariant, not a preference, and a policy that loses it must fail here.
    const offenders = META_TABLES.flatMap((table) =>
      (table.rls?.policies ?? []).flatMap((policy) =>
        [policy.using, policy.check]
          .filter((clause): clause is string => typeof clause === "string")
          .filter((clause) => clause.includes("current_setting") && clause.includes("::UUID"))
          .filter((clause) => !clause.includes("NULLIF("))
          .map((clause) => `${table.name}.${policy.name}: ${clause}`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("guards every tenant-scoped table, so the rule covers the whole catalog", () => {
    // Guards against the invariant above passing because nothing matched it any more.
    const guarded = META_TABLES.filter((table) =>
      (table.rls?.policies ?? []).some((policy) => (policy.using ?? "").includes("NULLIF(")),
    );
    expect(guarded.length).toBeGreaterThan(90);
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

  it("META_TENANTS.status permits exactly the five states a tenant can be in", () => {
    // The other half of ADR-0334's reconciliation. `@crossengin/tenant-lifecycle` declared a
    // seven-state lifecycle that nothing read, while this column's CHECK was what could actually be
    // stored — so three of those states were unreachable and `READ_ONLY_STATES`, which names the
    // policy for a suspended or pending-deletion tenant, could not be consulted for two of them.
    //
    // The five are spelled here rather than imported, because the kernel must not depend on a
    // contracts package that depends on it; `tenant-lifecycle`'s own test asserts the same list
    // from its side, so the pair of them is what keeps one vocabulary from drifting into two again.
    const status = META_TENANTS.columns.find((c) => c.name === "status");
    for (const state of [
      "active",
      "suspended",
      "archived",
      "pending_deletion",
      "deleted",
    ]) {
      expect([state, status?.check?.includes(`'${state}'`)]).toEqual([state, true]);
    }
    // And not the two that were billing facts duplicated onto the tenant: `past_due` is a
    // subscription status with its own transition map, `trial` a plan tier. A tenant in arrears is
    // `active`, and storing the arrears here would let two records disagree about one fact.
    for (const notAState of ["past_due", "trial"]) {
      expect([notAState, status?.check?.includes(`'${notAState}'`)]).toEqual([notAState, false]);
    }
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

  it("META_AUDIT_LOG carries nullable forensic-chain anchor columns", () => {
    // Nullable on purpose: a deployment with no signing key has no chain to anchor into, and
    // verification must be able to report an unanchored row rather than assume it is intact.
    const seq = META_AUDIT_LOG.columns.find((c) => c.name === "chain_sequence_number");
    const hash = META_AUDIT_LOG.columns.find((c) => c.name === "chain_entry_hash");
    expect(seq?.type).toBe("BIGINT");
    expect(seq?.notNull).toBeUndefined();
    expect(hash?.type).toBe("TEXT");
    expect(hash?.notNull).toBeUndefined();
  });

  it("META_AUDIT_LOG indexes the chain anchor for per-row verification lookups", () => {
    const idx = META_AUDIT_LOG.indexes?.find((i) =>
      i.columns.includes("chain_sequence_number"),
    );
    expect(idx?.columns).toEqual(["tenant_id", "chain_sequence_number"]);
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
    expect(uniqueConstraintName(key)).toBe("feature_flags_key_key");
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
    expect(uniqueConstraintName(eid)).toBe("webhook_endpoints_endpoint_id_key");
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

  it("META_TENANT_LIFECYCLE_EVENTS check-constrains from/to_state to the five lifecycle states", () => {
    // Five since ADR-0335. ADR-0334 narrowed `TENANT_LIFECYCLE_STATES` to five and narrowed
    // `meta.tenants.status`' CHECK with it, and **missed this table** — so the column accepted
    // `trial` and `past_due`, two values the contract refuses, which is ADR-0289's class. The states
    // are spelled locally because the kernel cannot depend on `@crossengin/tenant-lifecycle`.
    const table = META_TABLES.find((t) => t.name === "tenant_lifecycle_events");
    for (const column of ["from_state", "to_state"]) {
      const check = table?.columns.find((c) => c.name === column)?.check ?? "";
      for (const state of ["active", "suspended", "archived", "pending_deletion", "deleted"]) {
        expect(check, `${column}/${state}`).toContain(`'${state}'`);
      }
      expect(check, column).not.toContain("'trial'");
      expect(check, column).not.toContain("'past_due'");
    }
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
    expect(uniqueConstraintName(tid)).toBe("tenant_tombstones_tombstone_id_key");
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
    expect(uniqueConstraintName(iid)).toBe("incidents_incident_id_key");
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

  it("META_INCIDENTS declares declared_by as TEXT, not a users foreign key", () => {
    // `IncidentRecord.declaredBy` is any non-empty string, and every incident the platform
    // declares automatically is declared by a scheduler with no `meta.users` row. A UUID FK made
    // the table unable to store the only incidents anything actually produces.
    const by = META_INCIDENTS.columns.find((c) => c.name === "declared_by");
    expect(by?.type).toBe("TEXT");
    expect(by?.notNull).toBe(true);
    expect(by?.references).toBeUndefined();
  });

  it("META_INCIDENTS derives year + sequence_number and constrains them uniquely", () => {
    // What makes two incidents sharing an id impossible in the database rather than in a
    // per-process counter.
    const year = META_INCIDENTS.columns.find((c) => c.name === "year");
    const seq = META_INCIDENTS.columns.find((c) => c.name === "sequence_number");
    expect(year?.type).toBe("INTEGER");
    expect(year?.notNull).toBe(true);
    expect(seq?.notNull).toBe(true);
    expect(
      META_INCIDENTS.uniqueConstraints?.some(
        (u) => u.columns.includes("year") && u.columns.includes("sequence_number"),
      ),
    ).toBe(true);
  });

  it("META_INCIDENTS carries a revision for optimistic concurrency", () => {
    const rev = META_INCIDENTS.columns.find((c) => c.name === "revision");
    expect(rev?.type).toBe("INTEGER");
    expect(rev?.notNull).toBe(true);
    expect(rev?.default).toBe("1");
    expect(rev?.check).toContain("revision >= 1");
  });

  it("META_INCIDENTS indexes open incidents partially and tenants as GIN", () => {
    const open = META_INCIDENTS.indexes?.find((i) => i.name === "idx_incidents_open");
    expect(open?.where).toContain("closed");
    expect(open?.where).toContain("cancelled");
    const tenants = META_INCIDENTS.indexes?.find((i) =>
      i.columns.includes("affected_tenant_ids"),
    );
    expect(tenants?.kind).toBe("gin");
  });

  it("META_INCIDENTS carries the signal an incident was auto-declared for", () => {
    const key = META_INCIDENTS.columns.find((c) => c.name === "auto_declared_for");
    expect(key?.type).toBe("TEXT");
    // Nullable: a human-declared incident has no signal, and requiring one would exclude it.
    expect(key?.notNull).toBeUndefined();
  });

  it("META_INCIDENTS makes two open incidents for one signal impossible", () => {
    // The duplicate hydration prevents, refused by the database rather than left to the declarer.
    const idx = META_INCIDENTS.indexes?.find(
      (i) => i.name === "idx_incidents_auto_declared_open",
    );
    expect(idx?.unique).toBe(true);
    expect(idx?.columns).toEqual(["auto_declared_for"]);
    // Partial, so a closed episode can be declared again and a keyless incident is not covered.
    expect(idx?.where).toContain("auto_declared_for IS NOT NULL");
    expect(idx?.where).toContain("closed");
    expect(idx?.where).toContain("cancelled");
  });

  it("META_INCIDENTS has no RLS, being a platform-wide record", () => {
    // An incident may name many tenants or none, so there is no single tenant_id to confine by.
    expect(META_INCIDENTS.columns.some((c) => c.name === "tenant_id")).toBe(false);
    expect(META_INCIDENTS.rls).toBeUndefined();
  });

  it("META_INCIDENT_RUNBOOK_EXECUTIONS check-constrains status to six values", () => {
    const status = META_INCIDENT_RUNBOOK_EXECUTIONS.columns.find((c) => c.name === "status");
    expect(status?.check).toContain("'queued'");
    expect(status?.check).toContain("'succeeded'");
    expect(status?.check).toContain("'aborted'");
  });

  it("META_SLO_EVALUATIONS enforces sloe_ id pattern + availability target bounds", () => {
    const eid = META_SLO_EVALUATIONS.columns.find((c) => c.name === "evaluation_id");
    expect(uniqueConstraintName(eid)).toBe("slo_evaluations_evaluation_id_key");
    expect(eid?.check).toContain("sloe_");
    const target = META_SLO_EVALUATIONS.columns.find((c) => c.name === "target");
    expect(target?.check).toContain("target > 0");
    expect(target?.check).toContain("target <= 1");
    const sev = META_SLO_EVALUATIONS.columns.find((c) => c.name === "worst_severity");
    expect(sev?.check).toContain("'sev1'");
  });

  it("META_SLO_EVALUATIONS is platform-or-tenant scoped with RLS", () => {
    expect(META_SLO_EVALUATIONS.rls?.enabled).toBe(true);
    // ADR-0332: the platform arm is a SELECT-scoped policy of its own now, not an `OR` inside
    // the isolation one. The old assertion pinned the defect: on an `ALL`-scope policy the
    // `USING` also serves as the `WITH CHECK`, so `tenant_id IS NULL` let any tenant session
    // write a platform-wide row.
    expect(META_SLO_EVALUATIONS.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_SLO_EVALUATIONS)?.command).toBe("SELECT");
  });

  it("META_SLO_ENFORCEMENT_ACTIONS constrains decision + cross-links incident/kill-switch/flag", () => {
    const decision = META_SLO_ENFORCEMENT_ACTIONS.columns.find((c) => c.name === "decision");
    expect(decision?.check).toContain("'breach_opened'");
    expect(decision?.check).toContain("'recovered'");
    const inc = META_SLO_ENFORCEMENT_ACTIONS.columns.find((c) => c.name === "incident_id");
    expect(inc?.check).toContain("INC-");
    const ks = META_SLO_ENFORCEMENT_ACTIONS.columns.find((c) => c.name === "kill_switch_id");
    expect(ks?.check).toContain("fks_");
    const flag = META_SLO_ENFORCEMENT_ACTIONS.columns.find((c) => c.name === "flag_id");
    expect(flag?.check).toContain("ff_");
  });

  it("the three incident child tables carry the contract's own id, not only a surrogate", () => {
    // Without a business key a record could be written but never looked up, updated, or referred to
    // by the id it carries — which is most of what a store is for.
    const exec = META_INCIDENT_RUNBOOK_EXECUTIONS.columns.find((c) => c.name === "execution_id");
    const comms = META_INCIDENT_COMMUNICATIONS.columns.find((c) => c.name === "communication_id");
    const pm = META_INCIDENT_POSTMORTEMS.columns.find((c) => c.name === "postmortem_id");
    for (const col of [exec, comms, pm]) {
      expect(col?.type).toBe("TEXT");
      expect(col?.notNull).toBe(true);
      expect(uniqueConstraintName(col)).toBeDefined();
    }
  });

  it("the three incident child tables type their actors as the contract does, not as user rows", () => {
    // The ADR-0289 `declared_by` defect, in five more columns: the contract types each of these as
    // any non-empty string and an automated actor is a scheduler with no `meta.users` row, so a
    // UUID FK made the tables unable to store the records anything would produce.
    const actors: ReadonlyArray<readonly [TableDefinition, string]> = [
      [META_INCIDENT_RUNBOOK_EXECUTIONS, "invoked_by"],
      [META_INCIDENT_RUNBOOK_EXECUTIONS, "incident_commander_approval_user_id"],
      [META_INCIDENT_POSTMORTEMS, "author_user_id"],
      [META_INCIDENT_COMMUNICATIONS, "published_by"],
      [META_INCIDENT_COMMUNICATIONS, "legal_reviewed_by"],
      [META_INCIDENT_COMMUNICATIONS, "executive_approved_by"],
    ];
    for (const [table, name] of actors) {
      const col = table.columns.find((c) => c.name === name);
      expect(col, `${table.name}.${name}`).toBeDefined();
      expect(col?.type, `${table.name}.${name}`).toBe("TEXT");
      expect(col?.references, `${table.name}.${name}`).toBeUndefined();
    }
  });

  it("incident_communications can name the communication it supersedes", () => {
    // By the superseded record's contract id, which is what `communication_id` holds — a UUID
    // column left the supersede chain unrepresentable.
    const col = META_INCIDENT_COMMUNICATIONS.columns.find((c) => c.name === "supersedes_id");
    expect(col?.type).toBe("TEXT");
  });

  it("the three incident child tables carry a revision for optimistic concurrency", () => {
    for (const table of [
      META_INCIDENT_RUNBOOK_EXECUTIONS,
      META_INCIDENT_POSTMORTEMS,
      META_INCIDENT_COMMUNICATIONS,
    ]) {
      const rev = table.columns.find((c) => c.name === "revision");
      expect(rev?.type, table.name).toBe("INTEGER");
      expect(rev?.notNull, table.name).toBe(true);
      expect(rev?.default, table.name).toBe("1");
      expect(table.columns.some((c) => c.name === "updated_at"), table.name).toBe(true);
    }
  });

  it("META_AUDIT_INTEGRITY_VERDICTS can answer the questions it exists for", () => {
    // Queryability is the whole point (ADR-0287), so each of these must be a column rather than
    // something only recoverable by parsing the JSONB report.
    const names = META_AUDIT_INTEGRITY_VERDICTS.columns.map((c) => c.name);
    for (const n of [
      "verdict",
      "verified_at",
      "anchors_checked",
      "anchors_verified",
      "anchors_tampered",
      "anchors_unanchored",
      "truncated",
    ]) {
      expect(names, n).toContain(n);
    }
  });

  it("META_AUDIT_INTEGRITY_VERDICTS ties a row to the chain entry that attests to it", () => {
    // A row with no matching chain entry proves nothing on its own; the hash names the entry, the
    // sequence lets a reader seek to it, and the digest proves the content is the committed content.
    const hash = META_AUDIT_INTEGRITY_VERDICTS.columns.find((c) => c.name === "chain_entry_hash");
    const seq = META_AUDIT_INTEGRITY_VERDICTS.columns.find(
      (c) => c.name === "chain_sequence_number",
    );
    const digest = META_AUDIT_INTEGRITY_VERDICTS.columns.find((c) => c.name === "payload_sha256");
    expect(hash?.type).toBe("TEXT");
    expect(seq?.type).toBe("INTEGER");
    expect(digest?.check).toContain("[0-9a-f]{64}");
    // All three nullable: a pass configured not to record a verdict writes none of them.
    for (const col of [hash, seq, digest]) expect(col?.notNull).toBeUndefined();
  });

  it("META_AUDIT_INTEGRITY_VERDICTS confines a tenant and gates the platform read separately", () => {
    // Three policies rather than one, which is ADR-0313's split arriving at the table ADR-0313
    // named. The isolation arm must not carry the read grant: on an `ALL`-scope policy the `USING`
    // expression also serves as the `WITH CHECK`, so a session holding only the cross-tenant read
    // could forge a `verified` verdict for any tenant, flip a `compromised` one, or delete it.
    // Twelve such forgeries succeeded live as a non-owner role before the split and none after.
    const policies = META_AUDIT_INTEGRITY_VERDICTS.rls?.policies ?? [];
    expect(META_AUDIT_INTEGRITY_VERDICTS.rls?.enabled).toBe(true);
    expect(policies).toHaveLength(3);

    const isolation = policies[0];
    expect(isolation?.command).toBeUndefined();
    expect(isolation?.using).toBe(TENANT_ISOLATION_USING);
    // Not the `feature_flag_kill_switches` `IS NULL OR …` shape: that would show a platform-chain
    // tamper finding to every tenant session. Plain isolation is false for a NULL tenant, so a
    // platform verdict is invisible without the explicit opt-in.
    expect(isolation?.using).not.toContain("tenant_id IS NULL");
    expect(isolation?.using).not.toContain("app.platform_audit");

    // The read is gated on its own flag — not `app.platform_review`, because reading every
    // tenant's verdicts is not the same privilege as reviewing design proposals — and it is
    // `SELECT`-scoped, so it carries no `WITH CHECK` and cannot authorise a write.
    const read = policies[1];
    expect(read?.command).toBe("SELECT");
    expect(read?.using).toContain("app.platform_audit");
    expect(read?.using).not.toContain("app.platform_review");
    expect(read?.check).toBeUndefined();

    // The write is on the **record** grant, never the audit one: a grant over the record must not
    // reach the thing that validates the record, which is why `meta.crypto_audit` is `record` and
    // not `key`. A verdict is the platform's record of a verification, and the population that may
    // append to the trail must not also be able to certify that trail verified.
    const write = policies[2];
    expect(write?.command).toBe("INSERT");
    expect(write?.check).toContain("app.platform_record_write");
    expect(write?.check).toContain("tenant_id IS NULL");
    expect(write?.check).not.toContain("app.platform_audit_write");
    // Append-only: no `UPDATE` arm and no `DELETE` arm, so a platform verdict is immutable by
    // policy once written. `verdict_id` is `aiv_` + the sha256 of the canonical report, so changing
    // any field yields a different row and there is no stable handle to aim an `UPDATE` at.
    expect(policies.map((p) => p.command ?? "ALL")).toEqual(["ALL", "SELECT", "INSERT"]);
  });

  it("META_TENANT_TOMBSTONES outlives the users and the tenant it names", () => {
    const col = (name: string) => META_TENANT_TOMBSTONES.columns.find((c) => c.name === name);
    // Free text, unreferenced. The reference was to `meta.users`, whose rows a tenant deletion erases
    // — so the tombstone would have pointed at rows it had just destroyed, and ON DELETE RESTRICT
    // would have made those users undeletable *because* a tombstone named them. A scheduled_purge has
    // no human executor at all.
    for (const name of ["executed_by", "approved_by"]) {
      expect(col(name)?.type, name).toBe("TEXT");
      expect(col(name)?.references, name).toBeUndefined();
    }
    expect(col("related_deletion_request_id")?.type).toBe("TEXT");
    // Always right, and worth pinning: the tenant row is retired after its data is erased, so a
    // tombstone that required it to exist could not describe a completed deletion.
    expect(col("tenant_id")?.type).toBe("UUID");
    expect(col("tenant_id")?.references).toBeUndefined();
    // The evidence the scope was composed from, so a stored record can be checked against more than
    // itself (ADR-0317).
    expect(col("attestations")?.type).toBe("JSONB");
    expect(col("attestations")?.notNull).toBe(true);
    // ADR-0329. The version selects which domain tag the digest commits to, so it may not be NULL:
    // a row whose version is unknown has a digest nothing can be checked against. `DEFAULT 'v1'`
    // because every row written before this column existed was genuinely a v1 proof.
    expect(col("proof_version")?.type).toBe("TEXT");
    expect(col("proof_version")?.notNull).toBe(true);
    expect(col("proof_version")?.default).toBe("'v1'");
    expect(col("proof_version")?.check).toBe("proof_version IN ('v1', 'v2', 'v3')");
    // Nullable, and paired with the version by the contract: v2 must carry it, v1 must not.
    expect(col("capability_declaration")?.type).toBe("JSONB");
    expect(col("capability_declaration")?.notNull).toBeUndefined();
    // ADR-0331. Nullable with **no default**: NULL means "these bytes do not cover a retention
    // claim" (every v1 and v2 row), while `[]` is the v3 claim that nothing was kept. A default
    // would make every pre-v3 row read back as a signed empty claim — and the contract pairs the
    // field with the version, so those rows would then fail to parse at all.
    expect(col("retained_obligations")?.type).toBe("JSONB");
    expect(col("retained_obligations")?.notNull).toBeUndefined();
    expect(col("retained_obligations")?.default).toBeUndefined();
  });

  it("META_TENANT_CREDITS names its issuer without making that issuer undeletable", () => {
    const col = META_TENANT_CREDITS.columns.find((c) => c.name === "issued_by");
    // ADR-0331, applying ADR-0318's fix to the table ADR-0330 found carrying the same defect. It
    // referenced `meta.users` with `ON DELETE RESTRICT`, so a credit made its issuer undeletable —
    // latent until ADR-0330 made this table statutorily *retained*, which is exactly when the row
    // starts outliving the deletion that would have taken it.
    expect(col?.type).toBe("TEXT");
    expect(col?.references).toBeUndefined();
    expect(col?.notNull).toBe(true);
    // Structured, not free text: an `sla_credit` from a breach handler has no human in it while a
    // `manual_adjustment` must name one, and free text would let `system:slo` satisfy that. Same
    // vocabulary as `notification_suppressions.applied_by` (ADR-0302) — one spelling for one idea.
    expect(col?.check).toContain("user:");
    expect(col?.check).toContain("system:");
    expect(col?.check).toContain("provider:");
    // NOT NULL here where the suppression column is nullable: nothing has ever written this table,
    // so there are no pre-existing rows an actor requirement would retroactively invalidate — the
    // one reason ADR-0302 left its own column nullable.
    expect(col?.check).not.toContain("IS NULL");
  });

  it("META_ARCHITECT_ESTIMATE_INFLATION cannot hold a factor that deflates an estimate", () => {
    const col = (n: string) =>
      META_ARCHITECT_ESTIMATE_INFLATION.columns.find((c) => c.name === n);
    // The estimate feeds a ceiling, so a factor below 1 would admit a request that should have
    // been delayed. Refused at the column, not only in the resolver (ADR-0330).
    expect(col("inflation")?.check).toBe("inflation >= 1");
    expect(col("worst_observed")?.check).toBe("worst_observed >= 1");
    expect(col("inflation")?.notNull).toBe(true);
    // Keyed on the tenant **alone**, which is the point of the table existing: its sibling
    // `architect_tenant_cost` is keyed `(tenant_id, period_key)`, so a figure stored there would
    // reset every month — ADR-0311's forgetting on a monthly cadence instead of a per-restart one.
    expect(META_ARCHITECT_ESTIMATE_INFLATION.primaryKey).toEqual(["tenant_id"]);
    expect(col("period_key")).toBeUndefined();
    // No indexes: the primary key is the only access path either statement uses.
    expect(META_ARCHITECT_ESTIMATE_INFLATION.indexes).toBeUndefined();
  });

  it("META_WORKFLOW_INSTANCES carries the cancellation fence without letting silence decide", () => {
    const col = (n: string) => META_WORKFLOW_INSTANCES.columns.find((c) => c.name === n);
    // The fence itself: nullable with no default, because a non-NULL value *means* "cancellation
    // requested" and a `DEFAULT now()` would fence every instance at birth (ADR-0329).
    expect(col("cancellation_requested_at")?.type).toBe("TIMESTAMPTZ");
    expect(col("cancellation_requested_at")?.notNull).toBeUndefined();
    expect(col("cancellation_requested_at")?.default).toBeUndefined();
    // TEXT and unreferenced: the value is a user's uuid *or* a system slug, because a scheduled
    // cancellation has no human in it — ADR-0318's lesson in a second table.
    expect(col("cancellation_requested_by")?.type).toBe("TEXT");
    expect(col("cancellation_requested_by")?.references).toBeUndefined();
    // Nullable and with no default, so neither disposition is the reading of silence — the same
    // refusal the contract makes by giving the field no `z.default()`.
    expect(col("cancellation_disposition")?.notNull).toBeUndefined();
    expect(col("cancellation_disposition")?.default).toBeUndefined();
    // NOT NULL, matching its `awaiting_*` siblings: "nothing was signalled" and "we do not know"
    // are different facts and a nullable column collapses them (ADR-0317).
    expect(col("cancellation_signalled_activity_ids")?.notNull).toBe(true);
    expect(col("cancellation_signalled_activity_ids")?.default).toBe("'[]'::jsonb");
  });

  it("META_WORKFLOW_INSTANCES constrains the disposition where the reconciler can see it", () => {
    const disposition = META_WORKFLOW_INSTANCES.columns.find(
      (c) => c.name === "cancellation_disposition",
    );
    // Inline on the column, which ADR-0330 made safe: a column-level expression **is** compared
    // now, so widening it later is planned on an empty table and reported with its SQL on a
    // populated one. ADR-0329 had to lift two constraints to named table-level forms because this
    // was not true; both are back inline and the catalog is uniform again.
    expect(disposition?.check).toBe("cancellation_disposition IN ('compensate', 'abandon')");
    // And the status vocabulary did *not* grow: `status` carries its own CHECK, so a new value
    // there is not an additive change the way a new event kind is.
    const status = META_WORKFLOW_INSTANCES.columns.find((c) => c.name === "status");
    expect(status?.check).not.toContain("cancellation");
  });

  it("META_NOTIFICATION_READ_STATES carries the dispatch id the contract carries", () => {
    const col = (n: string) => META_NOTIFICATION_READ_STATES.columns.find((c) => c.name === n);
    // Declared UUID and never written, this table had drifted behind its own contract exactly as
    // `meta.feature_flags` had (ADR-0300): `NotificationReadState.dispatchId` is
    // `disp_[A-Za-z0-9_-]{8,40}`, which cannot be stored in a UUID column, so the first INSERT
    // would have failed on a schema that read as correct. Nothing noticed because nothing wrote.
    expect(col("dispatch_id")?.type).toBe("TEXT");
    expect(col("dispatch_id")?.check).toBe("dispatch_id ~ '^disp_[A-Za-z0-9_-]{8,40}$'");
    // The dispatch's own identifier, not its surrogate key — unique-constrained there, so a valid
    // foreign key target, and the one the contract names.
    expect(col("dispatch_id")?.references?.table).toBe("notification_dispatches");
    expect(col("dispatch_id")?.references?.column).toBe("dispatch_id");
    // CASCADE: a read state has no meaning without the notice it is about.
    expect(col("dispatch_id")?.references?.onDelete).toBe("CASCADE");
  });

  it("META_TENANT_TOMBSTONES is readable after its tenant is gone, by SELECT only", () => {
    const policies = META_TENANT_TOMBSTONES.rls?.policies ?? [];
    expect(policies).toHaveLength(2);
    const platform = policies.find((p) => p.name === "tenant_tombstones_platform_audit_read");
    const isolation = policies.find((p) => p.name === "tenant_tombstones_isolation");
    // Isolation alone makes the record unreadable by the only people who need it: a tombstone
    // outlives its tenant, so no tenant session is left to satisfy it.
    expect(platform?.command).toBe("SELECT");
    expect(platform?.using).toBe("current_setting('app.platform_audit', true) = 'on'");
    expect(isolation?.command).toBeUndefined();
    expect(isolation?.using).toContain("NULLIF(");
  });

  it("META_TENANT_TOMBSTONES enforces four-eyes at the column, not only in the contract", () => {
    const check = (META_TENANT_TOMBSTONES.constraints ?? []).find(
      (c) => c.name === "tenant_tombstones_four_eyes_check",
    );
    expect(check?.kind === "check" && check.expression).toBe("executed_by <> approved_by");
  });

  it("META_TENANT_TOMBSTONES indexes the question reconciliation asks, partially", () => {
    const idx = (META_TENANT_TOMBSTONES.indexes ?? []).find((i) =>
      i.columns.includes("related_deletion_request_id"),
    );
    // "Does a tombstone name this request?" is ADR-0322's conclusive evidence that a deletion
    // committed, and `findForRequest` runs it for every stranded request on every scheduler tick.
    // It was a sequential scan on a table that only grows (ADR-0327).
    expect(idx?.name).toBe("idx_tenant_tombstones_related_request");
    // Partial, because the column is NULL for every tombstone the synchronous route of ADR-0320
    // writes, and those rows can never match a lookup by request id.
    expect(idx?.where).toBe("related_deletion_request_id IS NOT NULL");
  });

  it("META_GDPR_DELETION_REQUESTS outlives the verifier and names its proof", () => {
    const col = (n: string) => META_GDPR_DELETION_REQUESTS.columns.find((c) => c.name === n);
    // A deletion erases the tenant's users, and ON DELETE RESTRICT would have made the verifier
    // undeletable *because they verified the request to delete them* (ADR-0318's finding again).
    expect(col("verified_by")?.type).toBe("TEXT");
    expect(col("verified_by")?.references).toBeUndefined();
    // The contract's own free-text id, so a tombstone's relatedDeletionRequestId can name it.
    expect(col("request_id")?.type).toBe("TEXT");
    expect(col("request_id")?.check).toContain("dreq_");
    // completion_sha256 commits to the proof; this one can find it.
    expect(col("tombstone_id")?.type).toBe("TEXT");
    expect(col("tombstone_id")?.check).toContain("tomb_");
  });

  it("META_GDPR_DELETION_REQUESTS is readable after its tenant is gone, by SELECT only", () => {
    const policies = META_GDPR_DELETION_REQUESTS.rls?.policies ?? [];
    expect(policies).toHaveLength(2);
    const platform = policies.find((p) => p.name === "gdpr_deletion_requests_platform_audit_read");
    expect(platform?.command).toBe("SELECT");
    expect(platform?.using).toBe("current_setting('app.platform_audit', true) = 'on'");
  });

  it("META_GDPR_DELETION_REQUESTS indexes the scheduler's claim partially", () => {
    const due = META_GDPR_DELETION_REQUESTS.indexes?.find((i) => i.name === "idx_gdpr_deletion_due");
    // Partial, because the predicate is false for almost every row once requests accumulate.
    expect(due?.where).toBe("status = 'verified'");
    expect(due?.columns).toEqual(["status", "deadline_at"]);
  });

  it("META_AUDIT_LOG splits the platform read off as SELECT rather than widening isolation", () => {
    const policies = META_AUDIT_LOG.rls?.policies ?? [];
    expect(policies).toHaveLength(3);
    const isolation = policies.find((p) => p.name === "audit_log_tenant_isolation");
    const platform = policies.find((p) => p.name === "audit_log_platform_audit_read");
    // The isolation half stays at the `ALL` default and never mentions the flag: an elevated
    // session must not be able to satisfy an INSERT's WITH CHECK and forge an entry into another
    // tenant's chain. That is the whole reason this is two policies and not one `OR`.
    expect(isolation?.command).toBeUndefined();
    expect(isolation?.using).not.toContain("app.platform_audit");
    expect(platform?.command).toBe("SELECT");
    expect(platform?.using).toBe("current_setting('app.platform_audit', true) = 'on'");
    // And the isolation predicate is NULLIF-guarded, without which the platform read fails on any
    // pooled connection that previously served a tenant — adding the SELECT policy alone does not
    // help, because the other policy's cast still evaluates.
    expect(isolation?.using).toContain("NULLIF(");
  });

  it("META_AUDIT_LOG opens platform scope by an INSERT policy on its own grant", () => {
    // ADR-0331. `tenant_id` is nullable now, which is what makes a platform-scope row expressible
    // at all — three escalators previously wrote nothing because the row could not exist.
    const tenantId = META_AUDIT_LOG.columns.find((c) => c.name === "tenant_id");
    expect(tenantId?.notNull).toBeUndefined();
    // The foreign key is **gone** as of ADR-0335, and ADR-0331's note here ("the foreign key stays:
    // a NULL satisfies it, and a non-NULL must still name a real tenant") was right about what the
    // reference does and wrong about whether this table wants it. `ON DELETE CASCADE` into
    // `meta.tenants` made the one row that matters most impossible: `tenant-deletion-routes.ts`
    // retires the tenant and *then* records, so inserting `platform.tenant_deleted` raised
    // `violates foreign key constraint "audit_log_tenant_id_fkey"` and `record()` swallowed it into
    // `onRecordError` while the route answered 200. A row recording what happened *to* a tenant is
    // precisely a row whose `tenant_id` names a tenant that no longer exists.
    expect(tenantId?.references).toBeUndefined();

    const policies = META_AUDIT_LOG.rls?.policies ?? [];
    const write = policies.find((p) => p.name === "audit_log_platform_audit_write");
    const platform = policies.find((p) => p.name === "audit_log_platform_audit_read");
    expect(write?.command).toBe("INSERT");
    // Postgres refuses `USING` on a `FOR INSERT` policy — there are no existing rows to filter —
    // so the clause must be absent rather than duplicated from the check.
    expect(write?.using).toBeUndefined();
    // Scoped to platform rows, so the write grant buys no access to any tenant's chain.
    expect(write?.check).toContain("tenant_id IS NULL");
    // Its own grant. Reusing the read flag would let a reader of the trail forge an entry about
    // their own conduct, which is ADR-0313's hole arriving from the other direction.
    expect(write?.check).toContain("app.platform_audit_write");
    expect(write?.check).not.toContain("'app.platform_audit'");
    // And the read policy still carries no `WITH CHECK`, which is what keeps it a read.
    expect(platform?.check).toBeUndefined();
  });

  it("META_INCIDENT_COMMUNICATIONS holds its two cross-column rules in the database", () => {
    // ADR-0296 recorded both as having nowhere to live, enforced only by the re-parse on read.
    const names = (META_INCIDENT_COMMUNICATIONS.constraints ?? []).map((c) => c.name);
    expect(names).toContain("incident_communications_bounces_check");
    expect(names).toContain("incident_communications_breach_window_check");
    const window = (META_INCIDENT_COMMUNICATIONS.constraints ?? []).find(
      (c) => c.name === "incident_communications_breach_window_check",
    );
    // A CHECK that evaluates to NULL is passed by Postgres, so the null guard is what makes the
    // deadline rule mean anything for a non-breach communication.
    expect(window?.kind === "check" && window.expression).toContain("IS NULL OR");
    for (const c of META_INCIDENT_COMMUNICATIONS.constraints ?? []) {
      expect(c.name.length, c.name).toBeLessThanOrEqual(63);
    }
  });

  it("META_FEATURE_FLAGS stores the contract's own flag id", () => {
    // What a `flag_id UUID` reference elsewhere in the catalog had nothing to point at (ADR-0296).
    const col = META_FEATURE_FLAGS.columns.find((c) => c.name === "flag_id");
    expect(col?.type).toBe("TEXT");
    expect(col?.notNull).toBe(true);
    expect(uniqueConstraintName(col)).toBe("feature_flags_flag_id_key");
    expect(col?.check).toContain("^ff_[a-z0-9]{8,32}$");
  });

  it("META_FEATURE_FLAG_KILL_SWITCHES does not require a user row for an automated actor", () => {
    // Measured against a real Postgres: the SLO loop arms its rollback as the configured
    // `systemActorUserId`, a well-formed UUID nothing creates a user row for, and the insert failed
    // with a foreign-key violation. The type stays UUID because the contract demands one; only the
    // reference goes.
    for (const name of [
      "armed_by_user_id",
      "triggered_by_user_id",
      "co_triggered_by_user_id",
      "released_by_user_id",
    ]) {
      const col = META_FEATURE_FLAG_KILL_SWITCHES.columns.find((c) => c.name === name);
      expect(col?.type, name).toBe("UUID");
      expect(col?.references, name).toBeUndefined();
    }
  });

  it("META_FEATURE_FLAG_KILL_SWITCHES stores the contract's flag id, not a surrogate", () => {
    // A UUID FK to meta.feature_flags made the table unable to store the only kill switches
    // anything produces: `KillSwitch.flagId` is an `ff_…` contract id and meta.feature_flags has no
    // column for one. The same shape of defect ADR-0289 found in `incidents.declared_by`.
    const flag = META_FEATURE_FLAG_KILL_SWITCHES.columns.find((c) => c.name === "flag_id");
    expect(flag?.type).toBe("TEXT");
    expect(flag?.notNull).toBe(true);
    expect(flag?.references).toBeUndefined();
    expect(flag?.check).toContain("ff_");
  });

  it("META_FEATURE_FLAG_KILL_SWITCHES names a flag the way the action row that refers to it does", () => {
    const onSwitch = META_FEATURE_FLAG_KILL_SWITCHES.columns.find((c) => c.name === "flag_id");
    const onAction = META_SLO_ENFORCEMENT_ACTIONS.columns.find((c) => c.name === "flag_id");
    expect(onSwitch?.type).toBe(onAction?.type);
    expect(onSwitch?.check).toContain("^ff_[a-z0-9]{8,32}$");
    expect(onAction?.check).toContain("^ff_[a-z0-9]{8,32}$");
  });

  it("META_SLO_ENFORCEMENT_ACTIONS records what became of a recovered incident", () => {
    // Nullable because only a `recovered` row has a close-out; the record schema is what enforces
    // that pairing, since a CHECK constraint cannot see two columns' agreement.
    const closeOut = META_SLO_ENFORCEMENT_ACTIONS.columns.find((c) => c.name === "close_out");
    expect(closeOut?.type).toBe("TEXT");
    expect(closeOut?.notNull).toBeUndefined();
    expect(closeOut?.check).toContain("'cancelled'");
    expect(closeOut?.check).toContain("'human_owned'");
    expect(closeOut?.check).toContain("'unpersisted'");
    expect(closeOut?.check).toContain("'failed'");
  });

  it("META_SLO_ENFORCEMENT_ACTIONS discriminates availability vs latency signal", () => {
    const signal = META_SLO_ENFORCEMENT_ACTIONS.columns.find((c) => c.name === "signal");
    expect(signal?.notNull).toBe(true);
    expect(signal?.default).toBe("'availability'");
    expect(signal?.check).toContain("'availability'");
    expect(signal?.check).toContain("'latency'");
  });

  it("META_SLO_LATENCY_EVALUATIONS enforces slle_ id + percentile/severity enums", () => {
    const eid = META_SLO_LATENCY_EVALUATIONS.columns.find((c) => c.name === "evaluation_id");
    expect(uniqueConstraintName(eid)).toBe("slo_latency_evaluations_evaluation_id_key");
    expect(eid?.check).toContain("slle_");
    const pct = META_SLO_LATENCY_EVALUATIONS.columns.find((c) => c.name === "worst_percentile");
    expect(pct?.check).toContain("'p95'");
    const sev = META_SLO_LATENCY_EVALUATIONS.columns.find((c) => c.name === "worst_severity");
    expect(sev?.check).toContain("'sev2'");
    // ADR-0332: the platform arm is a SELECT-scoped policy of its own now, not an `OR` inside
    // the isolation one. The old assertion pinned the defect: on an `ALL`-scope policy the
    // `USING` also serves as the `WITH CHECK`, so `tenant_id IS NULL` let any tenant session
    // write a platform-wide row.
    expect(META_SLO_LATENCY_EVALUATIONS.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_SLO_LATENCY_EVALUATIONS)?.command).toBe("SELECT");
  });

  it("META_OPERATE_ENTITY_RECORDS keys documents by (tenant, entity, record) with tenant RLS", () => {
    const tenant = META_OPERATE_ENTITY_RECORDS.columns.find((c) => c.name === "tenant_id");
    expect(tenant?.notNull).toBe(true);
    const entity = META_OPERATE_ENTITY_RECORDS.columns.find((c) => c.name === "entity");
    expect(entity?.check).toContain("A-Za-z");
    const doc = META_OPERATE_ENTITY_RECORDS.columns.find((c) => c.name === "document");
    expect(doc?.type).toBe("JSONB");
    expect(META_OPERATE_ENTITY_RECORDS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "entity",
      "record_id",
    ]);
    expect(META_OPERATE_ENTITY_RECORDS.rls?.policies?.[0]?.using).toBe(
      "tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID",
    );
  });

  it("META_OPERATE_TENANT_MANIFESTS keeps the tenant+status lookup index", () => {
    const idx = META_OPERATE_TENANT_MANIFESTS.indexes?.find(
      (i) => i.name === "idx_operate_tenant_manifests_tenant_status",
    );
    expect(idx?.columns).toEqual(["tenant_id", "status"]);
    expect(idx?.unique).toBeUndefined();
    expect(idx?.where).toBeUndefined();
  });

  it("META_OPERATE_TENANT_MANIFESTS enforces at most one active manifest per tenant", () => {
    const idx = META_OPERATE_TENANT_MANIFESTS.indexes?.find(
      (i) => i.name === "uq_operate_tenant_manifests_active",
    );
    expect(idx).toBeDefined();
    expect(idx?.columns).toEqual(["tenant_id"]);
    expect(idx?.unique).toBe(true);
    expect(idx?.where).toBe("status = 'active'");
  });

  it("META_OPERATE_TENANT_MANIFESTS emits the partial unique index in the bootstrap SQL", () => {
    const sql = emitMetaBootstrapSql();
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "uq_operate_tenant_manifests_active" ON "meta"."operate_tenant_manifests" ("tenant_id") WHERE status = 'active';`,
    );
  });

  it("META_OPERATE_TENANT_MANIFESTS carries the platform review columns", () => {
    const byName = (n: string) => META_OPERATE_TENANT_MANIFESTS.columns.find((c) => c.name === n);
    const review = byName("review_status");
    expect(review?.notNull).toBe(true);
    expect(review?.default).toBe("'not_required'");
    for (const s of ["not_required", "pending", "approved", "rejected"]) {
      expect(review?.check).toContain(`'${s}'`);
    }
    expect(byName("reviewed_by")?.notNull).toBe(false);
    expect(byName("reviewed_at")?.notNull).toBe(false);
    expect(byName("review_notes")?.notNull).toBe(false);
  });

  it("META_OPERATE_TENANT_MANIFESTS indexes the pending review queue", () => {
    const idx = META_OPERATE_TENANT_MANIFESTS.indexes?.find(
      (i) => i.name === "idx_operate_tenant_manifests_review_queue",
    );
    expect(idx?.columns).toEqual(["created_at"]);
    expect(idx?.where).toBe("review_status = 'pending'");
    expect(idx?.unique).toBeUndefined();
  });

  it("META_OPERATE_TENANT_MANIFESTS allows an explicit platform-review escape from tenant isolation", () => {
    const policy = META_OPERATE_TENANT_MANIFESTS.rls?.policies?.[0];
    expect(policy?.name).toBe("operate_tenant_manifests_tenant_or_platform_review");
    // Tenant isolation still holds by default; the cross-tenant read requires a
    // transaction-scoped flag the platform review store sets and nothing else does.
    expect(policy?.using).toContain(
      "tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID",
    );
    expect(policy?.using).toContain("current_setting('app.platform_review', true) = 'on'");
    const statements = emitMetaBootstrapSql();
    expect(
      statements.some(
        (s) =>
          s.includes("operate_tenant_manifests_tenant_or_platform_review") &&
          s.includes("current_setting('app.platform_review', true) = 'on'"),
      ),
    ).toBe(true);
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
    // ADR-0332: the platform arm is a SELECT-scoped policy of its own now, not an `OR` inside
    // the isolation one. The old assertion pinned the defect: on an `ALL`-scope policy the
    // `USING` also serves as the `WITH CHECK`, so `tenant_id IS NULL` let any tenant session
    // write a platform-wide row.
    expect(META_SSO_PROVIDERS.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_SSO_PROVIDERS)?.command).toBe("SELECT");
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
    // ADR-0332: a SELECT-scoped platform arm of its own, not an `OR` inside isolation.
    expect(META_NOTIFICATION_TEMPLATES.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_NOTIFICATION_TEMPLATES)?.command).toBe("SELECT");
  });

  it("META_NOTIFICATION_PREFERENCES enforces (tenant, user, category, channel) uniqueness", () => {
    expect(
      META_NOTIFICATION_PREFERENCES.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "user_id", "category", "channel"]);
  });

  it("META_NOTIFICATION_SUPPRESSIONS enforces (tenant, channel, address) uniqueness per permanent row", () => {
    // A predicated unique index, not a unique constraint: as a constraint it was total despite being
    // named `_active`, so a lapsed suppression held its address forever and an address that had
    // soft-bounced could never be hard-bounce-suppressed.
    const idx = META_NOTIFICATION_SUPPRESSIONS.indexes?.find(
      (i) => i.name === "notification_suppressions_tenant_channel_address_active",
    );
    expect(idx?.columns).toEqual(["tenant_id", "channel", "recipient_address"]);
    expect(idx?.unique).toBe(true);
    expect(idx?.where).toBe("expires_at IS NULL");
    // An index predicate must be IMMUTABLE, so it cannot ask whether the row is active *now*.
    expect(idx?.where).not.toContain("now()");
    expect(META_NOTIFICATION_SUPPRESSIONS.uniqueConstraints ?? []).toHaveLength(0);
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
    // ADR-0332: a SELECT-scoped platform arm of its own, not an `OR` inside isolation.
    expect(META_ACCESS_REVIEW_TEMPLATES.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_ACCESS_REVIEW_TEMPLATES)?.command).toBe("SELECT");
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
    // ADR-0332: a SELECT-scoped platform arm of its own, not an `OR` inside isolation.
    expect(META_WORKFLOW_DEFINITIONS.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_WORKFLOW_DEFINITIONS)?.command).toBe("SELECT");
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

  it("META_WORKFLOW_SIGNALS keys idempotency per DELIVERY, not per submit", () => {
    // ADR-0332. One submit correlating to N instances is N signals carrying one idempotency key,
    // because `WorkflowSignal.instanceId` is singular — so the three-column form refused the
    // *second* delivery of every fan-out, measured live. `instance_id` is the fourth column.
    expect(META_WORKFLOW_SIGNALS.uniqueConstraints?.[0]?.columns).toEqual([
      "tenant_id",
      "signal_name",
      "idempotency_key",
      "instance_id",
    ]);
  });

  it("keeps submit-level dedup as the PREFIX of that key, so the index still serves it", () => {
    // The reason the fourth column costs nothing: `PostgresSignalDeduplicator` reads
    // (tenant, name, key), which is a left prefix of the constraint's index.
    const cols = META_WORKFLOW_SIGNALS.uniqueConstraints?.[0]?.columns ?? [];
    expect(cols.slice(0, 3)).toEqual(["tenant_id", "signal_name", "idempotency_key"]);
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

  it("META_LINEAGE_NODES allows NULL tenant_id (platform-wide nodes)", () => {
    const tenantId = META_LINEAGE_NODES.columns.find(
      (c) => c.name === "tenant_id",
    );
    expect(tenantId?.notNull).not.toBe(true);
    // ADR-0332: a SELECT-scoped platform arm of its own, not an `OR` inside isolation.
    expect(META_LINEAGE_NODES.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_LINEAGE_NODES)?.command).toBe("SELECT");
  });

  it("META_LINEAGE_NODES kind enum covers 14 node kinds", () => {
    const kind = META_LINEAGE_NODES.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'source_table'");
    expect(kind?.check).toContain("'ml_model'");
    expect(kind?.check).toContain("'tenant_export'");
    expect(kind?.check).toContain("'aggregation_result'");
  });

  it("META_LINEAGE_NODES classification enum has the 6 data classifications", () => {
    const classification = META_LINEAGE_NODES.columns.find(
      (c) => c.name === "classification",
    );
    expect(classification?.check).toContain("'pii_personal'");
    expect(classification?.check).toContain("'phi_protected'");
    expect(classification?.check).toContain("'regulated_financial'");
  });

  it("META_LINEAGE_EDGES restricts on source/target node deletion (preserve history)", () => {
    const source = META_LINEAGE_EDGES.columns.find(
      (c) => c.name === "source_node_id",
    );
    const target = META_LINEAGE_EDGES.columns.find(
      (c) => c.name === "target_node_id",
    );
    expect(source?.references?.onDelete).toBe("RESTRICT");
    expect(target?.references?.onDelete).toBe("RESTRICT");
  });

  it("META_LINEAGE_EDGES kind enum has 10 edge kinds", () => {
    const kind = META_LINEAGE_EDGES.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'derived_from'");
    expect(kind?.check).toContain("'anonymized_from'");
    expect(kind?.check).toContain("'trained_on'");
  });

  it("META_PROVENANCE_RECORDS operation_kind enum covers 15 operations", () => {
    const op = META_PROVENANCE_RECORDS.columns.find(
      (c) => c.name === "operation_kind",
    );
    expect(op?.check).toContain("'ingest'");
    expect(op?.check).toContain("'anonymize'");
    expect(op?.check).toContain("'ai_inference'");
    expect(op?.check).toContain("'tombstone'");
  });

  it("META_DATA_SUBJECTS enforces (tenant, identifier kind + sha) uniqueness", () => {
    expect(
      META_DATA_SUBJECTS.uniqueConstraints?.[0]?.columns,
    ).toEqual([
      "tenant_id",
      "primary_identifier_kind",
      "primary_identifier_sha256",
    ]);
  });

  it("META_DATA_SUBJECTS primary_identifier_sha256 is CHAR(64) hex", () => {
    const sha = META_DATA_SUBJECTS.columns.find(
      (c) => c.name === "primary_identifier_sha256",
    );
    expect(sha?.type).toBe("CHAR(64)");
    expect(sha?.check).toContain("[0-9a-f]{64}");
  });

  it("META_SUBJECT_NODE_OCCURRENCES cascades on subject + node deletion", () => {
    const subjectFk = META_SUBJECT_NODE_OCCURRENCES.columns.find(
      (c) => c.name === "subject_id",
    );
    const nodeFk = META_SUBJECT_NODE_OCCURRENCES.columns.find(
      (c) => c.name === "node_id",
    );
    expect(subjectFk?.references?.onDelete).toBe("CASCADE");
    expect(nodeFk?.references?.onDelete).toBe("CASCADE");
  });

  it("META_SUBJECT_NODE_OCCURRENCES enforces (subject, node) uniqueness", () => {
    expect(
      META_SUBJECT_NODE_OCCURRENCES.uniqueConstraints?.[0]?.columns,
    ).toEqual(["subject_id", "node_id"]);
  });

  it("META_SUBJECT_ACCESS_REQUESTS legal_basis enum covers GDPR/CCPA/LGPD/PIPEDA/UAE", () => {
    const basis = META_SUBJECT_ACCESS_REQUESTS.columns.find(
      (c) => c.name === "legal_basis",
    );
    expect(basis?.check).toContain("'gdpr_article_15'");
    expect(basis?.check).toContain("'ccpa_right_to_know'");
    expect(basis?.check).toContain("'lgpd_article_18'");
    expect(basis?.check).toContain("'pipeda_principle_9'");
    expect(basis?.check).toContain("'uae_data_protection_law'");
  });

  it("META_SUBJECT_ACCESS_REQUESTS status enum has the 7 lifecycle states", () => {
    const status = META_SUBJECT_ACCESS_REQUESTS.columns.find(
      (c) => c.name === "status",
    );
    expect(status?.check).toContain("'submitted'");
    expect(status?.check).toContain("'verified'");
    expect(status?.check).toContain("'partial_complete'");
    expect(status?.check).toContain("'deferred'");
  });

  it("META_RATE_LIMIT_POLICIES allows NULL tenant_id (platform policies)", () => {
    const tenantId = META_RATE_LIMIT_POLICIES.columns.find(
      (c) => c.name === "tenant_id",
    );
    expect(tenantId?.notNull).not.toBe(true);
    // ADR-0332: a SELECT-scoped platform arm of its own, not an `OR` inside isolation.
    expect(META_RATE_LIMIT_POLICIES.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_RATE_LIMIT_POLICIES)?.command).toBe("SELECT");
  });

  it("META_RATE_LIMIT_POLICIES algorithm enum has 6 algorithms", () => {
    const alg = META_RATE_LIMIT_POLICIES.columns.find(
      (c) => c.name === "algorithm",
    );
    expect(alg?.check).toContain("'token_bucket'");
    expect(alg?.check).toContain("'leaky_bucket'");
    expect(alg?.check).toContain("'sliding_window_log'");
    expect(alg?.check).toContain("'concurrent_request'");
  });

  it("META_RATE_LIMIT_POLICIES response_code restricted to 429 or 503", () => {
    const code = META_RATE_LIMIT_POLICIES.columns.find(
      (c) => c.name === "response_code",
    );
    expect(code?.check).toContain("(429, 503)");
  });

  it("META_QUOTA_DEFINITIONS target enum covers 10 quota targets", () => {
    const target = META_QUOTA_DEFINITIONS.columns.find(
      (c) => c.name === "target",
    );
    expect(target?.check).toContain("'api_requests'");
    expect(target?.check).toContain("'ai_tokens'");
    expect(target?.check).toContain("'ml_training_minutes'");
    expect(target?.check).toContain("'rows_exported'");
  });

  it("META_QUOTA_DEFINITIONS period enum has 7 periods", () => {
    const period = META_QUOTA_DEFINITIONS.columns.find(
      (c) => c.name === "period",
    );
    expect(period?.check).toContain("'minute'");
    expect(period?.check).toContain("'billing_period'");
    expect(period?.check).toContain("'lifetime'");
  });

  it("META_QUOTA_USAGE enforces (tenant, quota_def, period_start) uniqueness", () => {
    expect(
      META_QUOTA_USAGE.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "quota_definition_id", "period_start_at"]);
  });

  it("META_QUOTA_USAGE restricts on quota_definitions deletion", () => {
    const fk = META_QUOTA_USAGE.columns.find(
      (c) => c.name === "quota_definition_id",
    );
    expect(fk?.references?.onDelete).toBe("RESTRICT");
  });

  it("META_RATE_LIMIT_DECISIONS outcome enum covers 10 decision outcomes", () => {
    const outcome = META_RATE_LIMIT_DECISIONS.columns.find(
      (c) => c.name === "outcome",
    );
    expect(outcome?.check).toContain("'allowed'");
    expect(outcome?.check).toContain("'denied_quota_exceeded'");
    expect(outcome?.check).toContain("'bypassed_critical_priority'");
    expect(outcome?.check).toContain("'denied_circuit_open'");
  });

  it("META_RATE_LIMIT_EXCEPTIONS multiplier is NUMERIC(8, 4) bounded 0.1 - 100", () => {
    const m = META_RATE_LIMIT_EXCEPTIONS.columns.find(
      (c) => c.name === "multiplier",
    );
    expect(m?.type).toBe("NUMERIC(8, 4)");
    expect(m?.check).toContain("BETWEEN 0.1 AND 100");
  });

  it("META_RATE_LIMIT_EXCEPTIONS kind enum has 6 exception kinds", () => {
    const kind = META_RATE_LIMIT_EXCEPTIONS.columns.find(
      (c) => c.name === "kind",
    );
    expect(kind?.check).toContain("'principal_overage'");
    expect(kind?.check).toContain("'incident_response_bypass'");
    expect(kind?.check).toContain("'load_test_temporary'");
  });

  it("META_THROTTLE_EVENTS kind enum covers 10 event kinds", () => {
    const kind = META_THROTTLE_EVENTS.columns.find((c) => c.name === "kind");
    expect(kind?.check).toContain("'hard_limit_hit'");
    expect(kind?.check).toContain("'soft_limit_hit'");
    expect(kind?.check).toContain("'circuit_opened'");
    expect(kind?.check).toContain("'exception_approved'");
  });

  it("META_GATEWAY_ROUTES enforces (method, version, operation) uniqueness", () => {
    expect(
      META_GATEWAY_ROUTES.uniqueConstraints?.[0]?.columns,
    ).toEqual(["method", "api_version", "operation_id"]);
  });

  it("META_GATEWAY_ROUTES method enum has 9 HTTP methods", () => {
    const method = META_GATEWAY_ROUTES.columns.find((c) => c.name === "method");
    expect(method?.check).toContain("'GET'");
    expect(method?.check).toContain("'PATCH'");
    expect(method?.check).toContain("'CONNECT'");
  });

  it("META_GATEWAY_IDEMPOTENCY_RECORDS enforces (tenant, op, key) uniqueness", () => {
    expect(
      META_GATEWAY_IDEMPOTENCY_RECORDS.uniqueConstraints?.[0]?.columns,
    ).toEqual(["tenant_id", "operation_id", "idempotency_key"]);
  });

  it("META_GATEWAY_IDEMPOTENCY_RECORDS method restricted to non-idempotent HTTP methods", () => {
    const method = META_GATEWAY_IDEMPOTENCY_RECORDS.columns.find(
      (c) => c.name === "method",
    );
    expect(method?.check).toContain("'POST'");
    expect(method?.check).toContain("'PUT'");
    expect(method?.check).toContain("'PATCH'");
    expect(method?.check).toContain("'DELETE'");
    expect(method?.check).not.toContain("'GET'");
  });

  it("META_GATEWAY_IDEMPOTENCY_RECORDS status enum has 4 lifecycle states", () => {
    const status = META_GATEWAY_IDEMPOTENCY_RECORDS.columns.find(
      (c) => c.name === "status",
    );
    expect(status?.check).toContain("'in_progress'");
    expect(status?.check).toContain("'completed_success'");
    expect(status?.check).toContain("'completed_error'");
    expect(status?.check).toContain("'expired'");
  });

  it("META_GATEWAY_PIPELINE_EXECUTIONS allows NULL tenant_id (anonymous traffic)", () => {
    const tenantId = META_GATEWAY_PIPELINE_EXECUTIONS.columns.find(
      (c) => c.name === "tenant_id",
    );
    expect(tenantId?.notNull).not.toBe(true);
    // ADR-0332: a SELECT-scoped platform arm of its own, not an `OR` inside isolation.
    expect(META_GATEWAY_PIPELINE_EXECUTIONS.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_GATEWAY_PIPELINE_EXECUTIONS)?.command).toBe("SELECT");
  });

  it("META_GATEWAY_PIPELINE_EXECUTIONS final_stage enum covers 17 stages", () => {
    const stage = META_GATEWAY_PIPELINE_EXECUTIONS.columns.find(
      (c) => c.name === "final_stage",
    );
    expect(stage?.check).toContain("'receive'");
    expect(stage?.check).toContain("'authenticate'");
    expect(stage?.check).toContain("'check_rate_limit'");
    expect(stage?.check).toContain("'emit_audit'");
  });

  it("META_GATEWAY_PIPELINE_EXECUTIONS final_outcome enum has 6 outcomes", () => {
    const outcome = META_GATEWAY_PIPELINE_EXECUTIONS.columns.find(
      (c) => c.name === "final_outcome",
    );
    expect(outcome?.check).toContain("'pass'");
    expect(outcome?.check).toContain("'deny'");
    expect(outcome?.check).toContain("'short_circuit_replay'");
    expect(outcome?.check).toContain("'redirect'");
  });

  it("META_FEATURE_FLAG_TARGETING_RULES cascades on flag deletion", () => {
    const fk = META_FEATURE_FLAG_TARGETING_RULES.columns.find(
      (c) => c.name === "flag_id",
    );
    expect(fk?.references?.onDelete).toBe("CASCADE");
  });

  it("META_FEATURE_FLAG_TARGETING_RULES allows NULL tenant_id (platform rules)", () => {
    const tenantId = META_FEATURE_FLAG_TARGETING_RULES.columns.find(
      (c) => c.name === "tenant_id",
    );
    expect(tenantId?.notNull).not.toBe(true);
    // ADR-0332: a SELECT-scoped platform arm of its own, not an `OR` inside isolation.
    expect(META_FEATURE_FLAG_TARGETING_RULES.rls?.policies?.[0]?.using).toBe(TENANT_ISOLATION_USING);
    expect(platformReadOf(META_FEATURE_FLAG_TARGETING_RULES)?.command).toBe("SELECT");
  });

  it("META_FEATURE_FLAG_KILL_SWITCHES still does not restrict on flag deletion, and now only one thing blocks it", () => {
    // This assertion once read `references.onDelete === 'RESTRICT'`, protecting the audit trail by
    // refusing to delete a flag a kill switch still names. ADR-0296 had to drop that FK because it
    // pointed at a UUID surrogate no contract record carries. `meta.feature_flags` now holds the
    // contract's `flag_id`, so the *target* finally exists — but the FK stays off, deliberately:
    // nothing populates that table, and a reference to it would make every kill-switch write depend
    // on a row no deployment creates. That is precisely the defect ADR-0296 removed, and measured
    // live in the same session on `armed_by_user_id`. Restoring it needs the flag registry actually
    // populated, not merely addressable. Asserted so that is a decision someone makes.
    const onSwitch = META_FEATURE_FLAG_KILL_SWITCHES.columns.find((c) => c.name === "flag_id");
    expect(onSwitch?.references).toBeUndefined();
    const target = META_FEATURE_FLAGS.columns.find((c) => c.name === "flag_id");
    expect(uniqueConstraintName(target)).toBe("feature_flags_flag_id_key");
  });

  it("META_FEATURE_FLAG_KILL_SWITCHES status enum has 4 lifecycle states", () => {
    const status = META_FEATURE_FLAG_KILL_SWITCHES.columns.find(
      (c) => c.name === "status",
    );
    expect(status?.check).toContain("'armed'");
    expect(status?.check).toContain("'triggered_active'");
    expect(status?.check).toContain("'released'");
    expect(status?.check).toContain("'expired'");
  });

  it("META_FEATURE_FLAG_KILL_SWITCHES trigger_kind covers 8 trigger kinds", () => {
    const trigger = META_FEATURE_FLAG_KILL_SWITCHES.columns.find(
      (c) => c.name === "trigger_kind",
    );
    expect(trigger?.check).toContain("'manual_admin'");
    expect(trigger?.check).toContain("'incident_response'");
    expect(trigger?.check).toContain("'compliance_directive'");
    expect(trigger?.check).toContain("'automated_metric_breach'");
  });

  it("META_FEATURE_FLAG_EVALUATIONS reason enum covers 17 reasons", () => {
    const reason = META_FEATURE_FLAG_EVALUATIONS.columns.find(
      (c) => c.name === "reason",
    );
    expect(reason?.check).toContain("'default_returned'");
    expect(reason?.check).toContain("'kill_switch_active'");
    expect(reason?.check).toContain("'percentage_bucket_match'");
    expect(reason?.check).toContain("'segment_match'");
    expect(reason?.check).toContain("'exclusion_rule_hit'");
  });

  it("META_FEATURE_FLAG_EVALUATIONS environment enum restricted to 4 envs", () => {
    const env = META_FEATURE_FLAG_EVALUATIONS.columns.find(
      (c) => c.name === "environment",
    );
    expect(env?.check).toContain("'preview'");
    expect(env?.check).toContain("'staging'");
    expect(env?.check).toContain("'production'");
    expect(env?.check).toContain("'sandbox'");
  });

  it("META_FEATURE_FLAG_CHANGES cascades on flag deletion", () => {
    const fk = META_FEATURE_FLAG_CHANGES.columns.find(
      (c) => c.name === "flag_id",
    );
    expect(fk?.references?.onDelete).toBe("CASCADE");
  });

  it("META_FEATURE_FLAG_CHANGES kind enum covers 23 change kinds", () => {
    const kind = META_FEATURE_FLAG_CHANGES.columns.find(
      (c) => c.name === "kind",
    );
    expect(kind?.check).toContain("'flag_created'");
    expect(kind?.check).toContain("'default_value_changed'");
    expect(kind?.check).toContain("'rollout_stage_advanced'");
    expect(kind?.check).toContain("'kill_switch_triggered'");
  });

  it("META_FEATURE_FLAG_CHANGES outcome enum has 4 outcomes", () => {
    const outcome = META_FEATURE_FLAG_CHANGES.columns.find(
      (c) => c.name === "outcome",
    );
    expect(outcome?.check).toContain("'succeeded'");
    expect(outcome?.check).toContain("'blocked_by_four_eyes'");
    expect(outcome?.check).toContain("'blocked_by_policy'");
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

/**
 * Both sides of a cross-column comparison are one type, or the constraint is not a constraint.
 *
 * The fourth catalog invariant, and it exists because the third defect of this class nearly shipped:
 * `workflow_definitions.created_by` became TEXT while `published_by` stayed UUID, so
 * `workflow_definitions_four_eyes_check` rendered `published_by <> created_by` — and Postgres has no
 * `uuid <> text` operator, so the `CREATE TABLE` raised `operator does not exist` and took the
 * **entire 609-statement bootstrap** with it, at statement #0.
 *
 * Every offline test passed, including this file's: the emitted-SQL assertions compare *strings*, and
 * a string containing a comparison between two types Postgres cannot relate is a perfectly
 * well-formed string. So the fence is this, not a more careful reading of the emitted text.
 *
 * `IS NULL` / `IS NOT NULL` are unary and deliberately not comparisons: a naive "two columns of
 * different types appear in one expression" rule reports `status <> 'published' OR (published_at IS
 * NOT NULL AND published_by IS NOT NULL)` as a disagreement, which is wrong and would train people
 * to add exemptions.
 */
function crossColumnComparisons(): readonly {
  readonly table: string;
  readonly constraint: string;
  readonly left: string;
  readonly right: string;
  readonly leftType: string;
  readonly rightType: string;
}[] {
  const COMPARISON = /\b([a-z_][a-z0-9_]*)\s*(=|<>|!=|<=|>=|<|>)\s*([a-z_][a-z0-9_]*)\b/g;
  const found: {
    table: string;
    constraint: string;
    left: string;
    right: string;
    leftType: string;
    rightType: string;
  }[] = [];
  for (const table of META_TABLES) {
    const types = new Map(table.columns.map((c) => [c.name, c.type]));
    for (const constraint of table.constraints ?? []) {
      if (constraint.kind !== "check") continue;
      for (const match of constraint.expression.matchAll(COMPARISON)) {
        const [, left, , right] = match;
        const leftType = left !== undefined ? types.get(left) : undefined;
        const rightType = right !== undefined ? types.get(right) : undefined;
        // Both operands must be columns of this table. One column against a literal is a comparison
        // Postgres resolves by the literal's inferred type, which is not this rule's business.
        if (left === undefined || right === undefined) continue;
        if (leftType === undefined || rightType === undefined) continue;
        found.push({ table: table.name, constraint: constraint.name, left, right, leftType, rightType });
      }
    }
  }
  return found;
}

describe("a cross-column CHECK compares two columns of one type", () => {
  it("finds no disagreement", () => {
    const disagreements = crossColumnComparisons().filter((c) => c.leftType !== c.rightType);
    expect(
      disagreements.map(
        (c) => `${c.table}.${c.constraint}: ${c.left} (${c.leftType}) vs ${c.right} (${c.rightType})`,
      ),
    ).toEqual([]);
  });

  it("is not vacuous: it really does examine the four-eyes checks", () => {
    // The guard that matters. If the extractor stopped matching anything — a renamed operator, a
    // reformatted expression — the rule above would pass having looked at nothing, which is the
    // failure mode of every fence in this repo that turned out to be wrong.
    // Five today: two four-eyes inequalities (`tenant_tombstones`, `workflow_definitions`) and three
    // orderings (a bounce count against a recipient count, a publication against a breach deadline,
    // a read watermark against its own `updated_at`).
    const comparisons = crossColumnComparisons();
    expect(comparisons.length).toBeGreaterThanOrEqual(5);
    const fourEyes = comparisons.filter((c) => c.constraint.includes("four_eyes"));
    expect(fourEyes.map((c) => c.table).sort()).toEqual(["tenant_tombstones", "workflow_definitions"]);
    // Both four-eyes pairs are actor columns, and an actor column is TEXT in this catalog because it
    // records who did a thing and must outlive the actor. A UUID here means somebody re-added a
    // `meta.users` reference to one side of a four-eyes rule.
    for (const c of fourEyes) {
      expect(c.leftType, `${c.table}.${c.constraint} left`).toBe("TEXT");
      expect(c.rightType, `${c.table}.${c.constraint} right`).toBe("TEXT");
    }
  });

  it("does not read a unary IS NOT NULL as a comparison", () => {
    // The false positive this rule was deliberately narrowed to avoid, pinned so the narrowing
    // cannot be undone by somebody widening the regex.
    const published = crossColumnComparisons().filter(
      (c) => c.constraint === "workflow_definitions_published_fields_check",
    );
    expect(published).toEqual([]);
  });
});

describe("the platform's record of a tenant outlives the tenant", () => {
  /**
   * The sixteen tables `PLATFORM_RECORD_TABLES` protects from the Article 17 erasure, spelled here
   * because the kernel cannot depend on `tenant-lifecycle-pg` (that package depends on the kernel).
   * `packages/testing/src/strategy/pg-record-retention.ts` asserts the two lists agree, reading both
   * from disk — which is the forcing function; this one is the catalog-side invariant.
   */
  const PLATFORM_RECORD = [
    "audit_log",
    "audit_integrity_verdicts",
    "compliance_attestations",
    "certification_reports",
    "crypto_keys",
    "forensic_chain_entries",
    "forensic_chain_checkpoints",
    "gdpr_deletion_requests",
    "tenant_lifecycle_events",
    "tenant_tombstones",
    "access_review_templates",
    "access_review_campaigns",
    "access_review_items",
    "access_review_decisions",
    "access_review_exceptions",
    "access_review_evidence",
  ] as const;

  it("names sixteen tables", () => {
    expect(PLATFORM_RECORD).toHaveLength(16);
    expect(new Set(PLATFORM_RECORD).size).toBe(16);
  });

  it("gives none of them a cascading tenant_id, so retiring the tenant cannot erase the record", () => {
    // The defect this pins: 15 of the 16 carried `ON DELETE CASCADE` into `meta.tenants`, so the
    // erasure skipped them by name and then ADR-0316's retirement of the tenant row destroyed them
    // anyway. `forensic_chain_entries` was among them, so the entry a tombstone's anchor names was
    // deleted — making `verifyStoredEvidence`'s `unwitnessed` defect, a paging `sev1` under
    // ADR-0324, true of every Article 17 proof the platform had ever produced.
    const offenders: string[] = [];
    for (const name of PLATFORM_RECORD) {
      const table = META_TABLES.find((t) => t.name === name);
      expect(table, name).toBeDefined();
      const tenantId = table?.columns.find((c) => c.name === "tenant_id");
      if (tenantId?.references?.table === "tenants") offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("still cascades a tenant DATA table, where the cascade is belt-and-braces", () => {
    // The rule is per class, not wholesale: a row of the tenant's own data has no meaning once the
    // tenant is gone, and the cascade backs up `eraseSharedTablesWithin`'s explicit delete.
    const protectedNames = new Set<string>(PLATFORM_RECORD);
    const cascading = META_TABLES.filter((t) => {
      const c = t.columns.find((x) => x.name === "tenant_id");
      return c?.references?.table === "tenants" && c.references.onDelete === "CASCADE";
    });
    expect(cascading.length).toBeGreaterThan(80);
    for (const t of cascading) expect(protectedNames.has(t.name), t.name).toBe(false);
  });
});
