import type { ColumnReference, TableDefinition } from "./types.js";

const TENANT_FK: ColumnReference = {
  schema: "meta",
  table: "tenants",
  column: "id",
  onDelete: "CASCADE",
};

const USER_FK: ColumnReference = {
  schema: "meta",
  table: "users",
  column: "id",
  onDelete: "RESTRICT",
};

const TENANT_ISOLATION_USING =
  "tenant_id = current_setting('app.current_tenant_id', true)::UUID";

export const META_TENANTS: TableDefinition = {
  schema: "meta",
  name: "tenants",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "slug",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "tenants_slug_key" },
    },
    { name: "name", type: "TEXT", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      default: "'active'",
      check: "status IN ('active', 'suspended', 'archived', 'deleted')",
    },
    {
      name: "tier",
      type: "TEXT",
      notNull: true,
      default: "'small'",
      check: "tier IN ('small', 'enterprise', 'regulated', 'on-prem')",
    },
    {
      name: "region",
      type: "TEXT",
      notNull: true,
      default: "'eu'",
      check: "region IN ('eu', 'us', 'me', 'ap', 'sa')",
    },
    {
      name: "schema_name",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "tenants_schema_name_key" },
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_tenants_status", columns: ["status"] },
    { name: "idx_tenants_region", columns: ["region"] },
  ],
};

export const META_USERS: TableDefinition = {
  schema: "meta",
  name: "users",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "email",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "users_email_key" },
    },
    { name: "display_name", type: "TEXT" },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      default: "'active'",
      check: "status IN ('active', 'suspended', 'deleted')",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "last_login_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [{ name: "idx_users_status", columns: ["status"] }],
};

export const META_USER_TENANT_MEMBERSHIP: TableDefinition = {
  schema: "meta",
  name: "user_tenant_membership",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "user_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "primary_role", type: "TEXT", notNull: true },
    {
      name: "secondary_roles",
      type: "TEXT[]",
      notNull: true,
      default: "ARRAY[]::TEXT[]",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      default: "'active'",
      check: "status IN ('active', 'invited', 'revoked')",
    },
    { name: "abac_attributes", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "user_tenant_membership_user_tenant_key",
      columns: ["user_id", "tenant_id"],
    },
  ],
  indexes: [
    { name: "idx_membership_tenant_id", columns: ["tenant_id"] },
    { name: "idx_membership_user_id", columns: ["user_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "membership_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_MANIFESTS: TableDefinition = {
  schema: "meta",
  name: "manifests",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "slug", type: "TEXT", notNull: true },
    { name: "version", type: "TEXT", notNull: true },
    { name: "hash", type: "TEXT", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('draft', 'proposed', 'active', 'superseded', 'retired')",
    },
    { name: "content", type: "JSONB", notNull: true },
    { name: "compliance_pack_versions", type: "JSONB" },
    { name: "applied_at", type: "TIMESTAMPTZ" },
    { name: "applied_by", type: "UUID", references: USER_FK },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "manifests_tenant_hash_key",
      columns: ["tenant_id", "hash"],
    },
  ],
  indexes: [
    { name: "idx_manifests_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_manifests_tenant_applied_at", columns: ["tenant_id", "applied_at"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "manifests_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_AI_CONVERSATIONS: TableDefinition = {
  schema: "meta",
  name: "ai_conversations",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "user_id", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "session_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "ai_conversations_session_key" },
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      default: "'active'",
      check: "status IN ('active', 'finished', 'aborted')",
    },
    { name: "working_manifest", type: "JSONB" },
    { name: "summary", type: "TEXT" },
    {
      name: "total_input_tokens",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "total_input_tokens >= 0",
    },
    {
      name: "total_output_tokens",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "total_output_tokens >= 0",
    },
    {
      name: "total_cost_usd",
      type: "NUMERIC(12, 6)",
      notNull: true,
      default: "0",
      check: "total_cost_usd >= 0",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "last_message_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_ai_conversations_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_ai_conversations_user", columns: ["user_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "ai_conversations_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_EVENTS: TableDefinition = {
  schema: "meta",
  name: "events",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "event_name", type: "TEXT", notNull: true },
    { name: "payload", type: "JSONB" },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_events_tenant_occurred_at", columns: ["tenant_id", "occurred_at"] },
    { name: "idx_events_event_name", columns: ["event_name"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "events_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_AUDIT_LOG: TableDefinition = {
  schema: "meta",
  name: "audit_log",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "actor", type: "JSONB", notNull: true },
    { name: "operation", type: "TEXT", notNull: true },
    { name: "entity", type: "TEXT", notNull: true },
    { name: "entity_id", type: "TEXT" },
    { name: "before", type: "JSONB" },
    { name: "after", type: "JSONB" },
    { name: "diff", type: "JSONB" },
    { name: "reason", type: "TEXT" },
    { name: "e_signature", type: "JSONB" },
    { name: "rego_decision_trace", type: "TEXT" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_audit_tenant_occurred_at", columns: ["tenant_id", "occurred_at"] },
    {
      name: "idx_audit_tenant_entity_occurred_at",
      columns: ["tenant_id", "entity", "occurred_at"],
    },
    { name: "idx_audit_actor", columns: ["actor"], kind: "gin" },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "audit_log_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_COMPLIANCE_ATTESTATIONS: TableDefinition = {
  schema: "meta",
  name: "compliance_attestations",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "pack_id", type: "TEXT", notNull: true },
    { name: "pack_version", type: "TEXT", notNull: true },
    { name: "attestation_id", type: "TEXT", notNull: true },
    { name: "attester_user_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "attested_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "statement_hash", type: "TEXT", notNull: true },
    { name: "ip", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "compliance_attestations_unique_key",
      columns: ["tenant_id", "pack_id", "pack_version", "attestation_id"],
    },
  ],
  indexes: [
    { name: "idx_compliance_attestations_tenant", columns: ["tenant_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "compliance_attestations_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_INTEGRATION_CALLS: TableDefinition = {
  schema: "meta",
  name: "integration_calls",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "integration_id", type: "TEXT", notNull: true },
    { name: "operation", type: "TEXT", notNull: true },
    {
      name: "direction",
      type: "TEXT",
      notNull: true,
      check: "direction IN ('inbound', 'outbound')",
    },
    { name: "idempotency_key", type: "TEXT" },
    { name: "request", type: "JSONB" },
    { name: "response", type: "JSONB" },
    {
      name: "latency_ms",
      type: "INTEGER",
      notNull: true,
      check: "latency_ms >= 0",
    },
    {
      name: "retries",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "retries >= 0",
    },
    { name: "ok", type: "BOOLEAN", notNull: true },
    { name: "error_message", type: "TEXT" },
    {
      name: "data_class",
      type: "TEXT",
      check:
        "data_class IN ('public', 'internal', 'commercial_sensitive', 'pii', 'phi', 'regulated')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "integration_calls_idempotency_key",
      columns: ["tenant_id", "integration_id", "operation", "idempotency_key"],
    },
  ],
  indexes: [
    {
      name: "idx_integration_calls_tenant_occurred_at",
      columns: ["tenant_id", "occurred_at"],
    },
    {
      name: "idx_integration_calls_integration",
      columns: ["tenant_id", "integration_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "integration_calls_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_AI_PROVIDER_CALLS: TableDefinition = {
  schema: "meta",
  name: "ai_provider_calls",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "session_id", type: "TEXT" },
    { name: "task_kind", type: "TEXT", notNull: true },
    { name: "provider_id", type: "TEXT", notNull: true },
    { name: "model_id", type: "TEXT", notNull: true },
    {
      name: "input_tokens",
      type: "INTEGER",
      notNull: true,
      check: "input_tokens >= 0",
    },
    {
      name: "output_tokens",
      type: "INTEGER",
      notNull: true,
      check: "output_tokens >= 0",
    },
    { name: "cached_input_tokens", type: "INTEGER", check: "cached_input_tokens >= 0" },
    {
      name: "cost_usd",
      type: "NUMERIC(12, 6)",
      notNull: true,
      check: "cost_usd >= 0",
    },
    {
      name: "latency_ms",
      type: "INTEGER",
      notNull: true,
      check: "latency_ms >= 0",
    },
    { name: "ok", type: "BOOLEAN", notNull: true },
    { name: "error_message", type: "TEXT" },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_ai_provider_calls_tenant_occurred_at",
      columns: ["tenant_id", "occurred_at"],
    },
    {
      name: "idx_ai_provider_calls_provider_occurred_at",
      columns: ["provider_id", "occurred_at"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "ai_provider_calls_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_SCHEMA_NAME = "meta";

export const META_JOB_RUNS: TableDefinition = {
  schema: "meta",
  name: "job_runs",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "job_id", type: "TEXT", notNull: true },
    {
      name: "job_kind",
      type: "TEXT",
      notNull: true,
      check:
        "job_kind IN ('event', 'scheduled', 'delayed', 'userInvoked', 'workflow', 'cdc')",
    },
    { name: "run_id", type: "UUID", notNull: true },
    { name: "trigger", type: "JSONB", notNull: true },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "duration_ms", type: "INTEGER", check: "duration_ms IS NULL OR duration_ms >= 0" },
    {
      name: "attempts",
      type: "INTEGER",
      notNull: true,
      default: "1",
      check: "attempts >= 1",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('pending', 'running', 'completed', 'failed', 'dead-lettered', 'cancelled')",
    },
    { name: "input_redacted", type: "JSONB" },
    { name: "output_redacted", type: "JSONB" },
    {
      name: "input_data_class",
      type: "TEXT",
      notNull: true,
      check:
        "input_data_class IN ('public', 'internal', 'commercial_sensitive', 'pii', 'phi', 'regulated')",
    },
    {
      name: "output_data_class",
      type: "TEXT",
      notNull: true,
      check:
        "output_data_class IN ('public', 'internal', 'commercial_sensitive', 'pii', 'phi', 'regulated')",
    },
    { name: "error", type: "JSONB" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "job_runs_run_id_key", columns: ["tenant_id", "run_id"] },
  ],
  indexes: [
    { name: "idx_job_runs_tenant_started_at", columns: ["tenant_id", "started_at"] },
    { name: "idx_job_runs_job_id", columns: ["tenant_id", "job_id"] },
    { name: "idx_job_runs_status", columns: ["tenant_id", "status"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "job_runs_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_DEAD_LETTER_JOBS: TableDefinition = {
  schema: "meta",
  name: "dead_letter_jobs",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "job_id", type: "TEXT", notNull: true },
    { name: "run_id", type: "UUID", notNull: true },
    { name: "dead_lettered_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    {
      name: "reason",
      type: "TEXT",
      notNull: true,
      check:
        "reason IN ('max-retries-exceeded', 'permanent-error', 'cancelled', 'timeout')",
    },
    {
      name: "attempt_count",
      type: "INTEGER",
      notNull: true,
      check: "attempt_count >= 1",
    },
    { name: "final_error", type: "JSONB", notNull: true },
    { name: "input_redacted", type: "JSONB" },
    {
      name: "reprocessable",
      type: "BOOLEAN",
      notNull: true,
      default: "true",
    },
    { name: "reprocessed_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "dead_letter_jobs_run_id_key", columns: ["tenant_id", "run_id"] },
  ],
  indexes: [
    {
      name: "idx_dead_letter_jobs_tenant_dead_lettered_at",
      columns: ["tenant_id", "dead_lettered_at"],
    },
    { name: "idx_dead_letter_jobs_job_id", columns: ["tenant_id", "job_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "dead_letter_jobs_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_JOB_COSTS: TableDefinition = {
  schema: "meta",
  name: "job_costs",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "job_id", type: "TEXT", notNull: true },
    { name: "run_id", type: "UUID", notNull: true },
    {
      name: "estimated_cost_usd",
      type: "NUMERIC(12, 6)",
      notNull: true,
      check: "estimated_cost_usd >= 0",
    },
    {
      name: "cost_basis",
      type: "TEXT",
      notNull: true,
      check:
        "cost_basis IN ('inngest-execution', 'inngest-step', 'external-api', 'compute-seconds', 'storage')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_job_costs_tenant_occurred_at", columns: ["tenant_id", "occurred_at"] },
    { name: "idx_job_costs_job_id", columns: ["tenant_id", "job_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "job_costs_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_TABLES: readonly TableDefinition[] = [
  META_TENANTS,
  META_USERS,
  META_USER_TENANT_MEMBERSHIP,
  META_MANIFESTS,
  META_AI_CONVERSATIONS,
  META_EVENTS,
  META_AUDIT_LOG,
  META_COMPLIANCE_ATTESTATIONS,
  META_AI_PROVIDER_CALLS,
  META_INTEGRATION_CALLS,
  META_JOB_RUNS,
  META_DEAD_LETTER_JOBS,
  META_JOB_COSTS,
];
