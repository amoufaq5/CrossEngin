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
    { name: "residency", type: "JSONB" },
    {
      name: "search_locale",
      type: "TEXT",
      notNull: true,
      default: "'simple'",
      check:
        "search_locale IN ('simple', 'english', 'french', 'spanish', 'arabic', 'german', 'portuguese')",
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

export const META_FILES: TableDefinition = {
  schema: "meta",
  name: "files",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "storage_key", type: "TEXT", notNull: true },
    { name: "filename", type: "TEXT", notNull: true },
    { name: "mime_type", type: "TEXT", notNull: true },
    { name: "size_bytes", type: "BIGINT", notNull: true, check: "size_bytes >= 0" },
    {
      name: "checksum_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "checksum_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('uploading', 'scanning', 'available', 'quarantined', 'archived', 'deleting')",
    },
    { name: "uploaded_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "uploaded_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "scanned_at", type: "TIMESTAMPTZ" },
    {
      name: "ocr_status",
      type: "TEXT",
      check: "ocr_status IS NULL OR ocr_status IN ('pending', 'done', 'skipped', 'failed')",
    },
    { name: "ocr_text_key", type: "TEXT" },
    {
      name: "embedding_status",
      type: "TEXT",
      check:
        "embedding_status IS NULL OR embedding_status IN ('pending', 'done', 'skipped', 'failed')",
    },
    { name: "retention_class", type: "TEXT", notNull: true },
    { name: "archive_after", type: "TIMESTAMPTZ" },
    { name: "delete_after", type: "TIMESTAMPTZ" },
    {
      name: "data_class",
      type: "TEXT",
      notNull: true,
      check:
        "data_class IN ('public', 'internal', 'commercial_sensitive', 'pii', 'phi', 'regulated')",
    },
    { name: "file_type_id", type: "TEXT", notNull: true },
    { name: "region", type: "TEXT", notNull: true },
    { name: "metadata", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "files_storage_key", columns: ["tenant_id", "storage_key"] },
  ],
  indexes: [
    { name: "idx_files_tenant_uploaded_at", columns: ["tenant_id", "uploaded_at"] },
    { name: "idx_files_status", columns: ["tenant_id", "status"] },
    { name: "idx_files_file_type", columns: ["tenant_id", "file_type_id"] },
  ],
  rls: {
    enabled: true,
    policies: [{ name: "files_tenant_isolation", using: TENANT_ISOLATION_USING }],
  },
};

export const META_REGIONS: TableDefinition = {
  schema: "meta",
  name: "regions",
  columns: [
    {
      name: "region",
      type: "TEXT",
      notNull: true,
      check:
        "region IN ('eu-central', 'eu-west', 'us-east', 'us-west', 'me-uae', 'gcc-ksa', 'apac-sg', 'ap-south')",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "cloud_provider", type: "TEXT", notNull: true },
    { name: "cloud_provider_region", type: "TEXT", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('planned', 'dr_replica', 'active', 'deprecated')",
    },
    {
      name: "year_available",
      type: "INTEGER",
      notNull: true,
      check: "year_available >= 2024 AND year_available <= 2100",
    },
    { name: "dr_replica_of", type: "TEXT" },
    { name: "dr_replica_in", type: "TEXT" },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["region"],
  indexes: [{ name: "idx_regions_status", columns: ["status"] }],
};

export const META_TENANT_STORAGE_USAGE: TableDefinition = {
  schema: "meta",
  name: "tenant_storage_usage",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "measured_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "total_bytes", type: "BIGINT", notNull: true, check: "total_bytes >= 0" },
    {
      name: "hot_bytes",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "hot_bytes >= 0",
    },
    {
      name: "archive_bytes",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "archive_bytes >= 0",
    },
    {
      name: "cold_bytes",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "cold_bytes >= 0",
    },
    { name: "file_count", type: "BIGINT", notNull: true, check: "file_count >= 0" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_tenant_storage_usage_tenant_measured",
      columns: ["tenant_id", "measured_at"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "tenant_storage_usage_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_REPORT_RUNS: TableDefinition = {
  schema: "meta",
  name: "report_runs",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "report_id", type: "TEXT", notNull: true },
    { name: "run_id", type: "UUID", notNull: true },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "duration_ms", type: "INTEGER", check: "duration_ms IS NULL OR duration_ms >= 0" },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('running', 'completed', 'failed', 'throttled', 'cancelled')",
    },
    {
      name: "trigger",
      type: "TEXT",
      notNull: true,
      check:
        "trigger IN ('user_invoked', 'scheduled', 'dashboard_refresh', 'ai_architect', 'api')",
    },
    { name: "invoked_by", type: "UUID" },
    {
      name: "engine",
      type: "TEXT",
      notNull: true,
      check: "engine IN ('postgres', 'clickhouse')",
    },
    { name: "parameters_redacted", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    { name: "row_count", type: "INTEGER", check: "row_count IS NULL OR row_count >= 0" },
    { name: "cache_hit", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "error", type: "JSONB" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "report_runs_run_id_key", columns: ["tenant_id", "run_id"] },
  ],
  indexes: [
    { name: "idx_report_runs_tenant_started", columns: ["tenant_id", "started_at"] },
    { name: "idx_report_runs_report_id", columns: ["tenant_id", "report_id"] },
    { name: "idx_report_runs_status", columns: ["tenant_id", "status"] },
  ],
  rls: {
    enabled: true,
    policies: [{ name: "report_runs_tenant_isolation", using: TENANT_ISOLATION_USING }],
  },
};

export const META_SCHEDULED_EXPORTS: TableDefinition = {
  schema: "meta",
  name: "scheduled_exports",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "report_id", type: "TEXT", notNull: true },
    { name: "cron", type: "TEXT", notNull: true },
    { name: "timezone", type: "TEXT", notNull: true, default: "'UTC'" },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "last_run_at", type: "TIMESTAMPTZ" },
    { name: "next_run_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "last_status",
      type: "TEXT",
      check:
        "last_status IS NULL OR last_status IN ('pending', 'running', 'succeeded', 'failed', 'skipped_empty')",
    },
    {
      name: "consecutive_failures",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "consecutive_failures >= 0",
    },
    { name: "last_delivery_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "scheduled_exports_report_key", columns: ["tenant_id", "report_id"] },
  ],
  indexes: [
    { name: "idx_scheduled_exports_next_run", columns: ["next_run_at"] },
    { name: "idx_scheduled_exports_tenant", columns: ["tenant_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "scheduled_exports_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_CDC_CHECKPOINTS: TableDefinition = {
  schema: "meta",
  name: "cdc_checkpoints",
  columns: [
    { name: "region", type: "TEXT", notNull: true },
    { name: "replication_slot", type: "TEXT", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('running', 'paused', 'lagging', 'broken', 'snapshot')",
    },
    { name: "last_committed_lsn", type: "TEXT", notNull: true },
    { name: "last_shipped_lsn", type: "TEXT", notNull: true },
    {
      name: "lag_bytes",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "lag_bytes >= 0",
    },
    {
      name: "lag_seconds",
      type: "NUMERIC(10, 3)",
      notNull: true,
      default: "0",
      check: "lag_seconds >= 0",
    },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "last_error_message", type: "TEXT" },
  ],
  primaryKey: ["region", "replication_slot"],
  indexes: [{ name: "idx_cdc_checkpoints_status", columns: ["status"] }],
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
  META_FILES,
  META_TENANT_STORAGE_USAGE,
  META_REGIONS,
  META_REPORT_RUNS,
  META_SCHEDULED_EXPORTS,
  META_CDC_CHECKPOINTS,
];
