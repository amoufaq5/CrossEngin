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

export const META_PLANS: TableDefinition = {
  schema: "meta",
  name: "plans",
  columns: [
    { name: "id", type: "TEXT", notNull: true },
    {
      name: "family",
      type: "TEXT",
      notNull: true,
      check:
        "family IN ('operate', 'govern', 'heal', 'educate', 'serve', 'build', 'partner')",
    },
    {
      name: "tier",
      type: "TEXT",
      notNull: true,
      check: "tier IN ('trial', 'base', 'professional', 'enterprise', 'non_profit')",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "currency", type: "CHAR(3)", notNull: true, check: "currency ~ '^[A-Z]{3}$'" },
    {
      name: "base_price_cents",
      type: "INTEGER",
      notNull: true,
      check: "base_price_cents >= 0",
    },
    {
      name: "billing_interval",
      type: "TEXT",
      notNull: true,
      check: "billing_interval IN ('month', 'year')",
    },
    { name: "stripe_product_id", type: "TEXT", notNull: true },
    { name: "stripe_base_price_id", type: "TEXT", notNull: true },
    { name: "included_quotas", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    { name: "metered_prices", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "available_in_regions", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "min_kernel_version", type: "TEXT", notNull: true },
    {
      name: "trial_days",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "trial_days >= 0",
    },
    { name: "deprecated", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_plans_family", columns: ["family"] },
    { name: "idx_plans_deprecated", columns: ["deprecated"] },
  ],
};

export const META_SUBSCRIPTIONS: TableDefinition = {
  schema: "meta",
  name: "subscriptions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "plan_id", type: "TEXT", notNull: true, references: { schema: "meta", table: "plans", column: "id", onDelete: "RESTRICT" } },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('trialing', 'active', 'past_due', 'paused', 'canceled', 'unpaid', 'incomplete')",
    },
    { name: "stripe_subscription_id", type: "TEXT" },
    { name: "stripe_customer_id", type: "TEXT", notNull: true },
    { name: "current_period_start", type: "TIMESTAMPTZ", notNull: true },
    { name: "current_period_end", type: "TIMESTAMPTZ", notNull: true },
    { name: "trial_end", type: "TIMESTAMPTZ" },
    { name: "cancel_at_period_end", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "canceled_at", type: "TIMESTAMPTZ" },
    { name: "paused_at", type: "TIMESTAMPTZ" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "subscriptions_stripe_id_key", columns: ["stripe_subscription_id"] },
  ],
  indexes: [
    { name: "idx_subscriptions_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_subscriptions_plan_id", columns: ["plan_id"] },
  ],
  rls: {
    enabled: true,
    policies: [{ name: "subscriptions_tenant_isolation", using: TENANT_ISOLATION_USING }],
  },
};

export const META_INVOICES: TableDefinition = {
  schema: "meta",
  name: "invoices",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "subscription_id", type: "UUID", notNull: true },
    { name: "number", type: "TEXT", notNull: true },
    { name: "stripe_invoice_id", type: "TEXT" },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'open', 'paid', 'uncollectible', 'void', 'refunded')",
    },
    { name: "currency", type: "CHAR(3)", notNull: true },
    { name: "subtotal_cents", type: "INTEGER", notNull: true },
    {
      name: "tax_cents",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "tax_cents >= 0",
    },
    {
      name: "discount_cents",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "discount_cents >= 0",
    },
    { name: "total_cents", type: "INTEGER", notNull: true },
    {
      name: "amount_paid_cents",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "amount_paid_cents >= 0",
    },
    {
      name: "amount_remaining_cents",
      type: "INTEGER",
      notNull: true,
      check: "amount_remaining_cents >= 0",
    },
    { name: "issued_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "due_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "paid_at", type: "TIMESTAMPTZ" },
    { name: "voided_at", type: "TIMESTAMPTZ" },
    { name: "period_start", type: "TIMESTAMPTZ", notNull: true },
    { name: "period_end", type: "TIMESTAMPTZ", notNull: true },
    { name: "line_items", type: "JSONB", notNull: true },
    { name: "pdf_url", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "invoices_number_key", columns: ["tenant_id", "number"] },
    { name: "invoices_stripe_id_key", columns: ["stripe_invoice_id"] },
  ],
  indexes: [
    { name: "idx_invoices_tenant_issued", columns: ["tenant_id", "issued_at"] },
    { name: "idx_invoices_status", columns: ["tenant_id", "status"] },
    { name: "idx_invoices_subscription", columns: ["subscription_id"] },
  ],
  rls: {
    enabled: true,
    policies: [{ name: "invoices_tenant_isolation", using: TENANT_ISOLATION_USING }],
  },
};

export const META_TENANT_CREDITS: TableDefinition = {
  schema: "meta",
  name: "tenant_credits",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "amount_cents",
      type: "INTEGER",
      notNull: true,
      check: "amount_cents > 0",
    },
    {
      name: "remaining_cents",
      type: "INTEGER",
      notNull: true,
      check: "remaining_cents >= 0 AND remaining_cents <= amount_cents",
    },
    { name: "currency", type: "CHAR(3)", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('sla_credit', 'goodwill', 'promotional', 'migration_assist', 'manual_adjustment')",
    },
    { name: "reason", type: "TEXT", notNull: true },
    { name: "expires_at", type: "TIMESTAMPTZ" },
    { name: "issued_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "issued_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "applied_to_invoice_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_tenant_credits_tenant_remaining", columns: ["tenant_id", "remaining_cents"] },
    { name: "idx_tenant_credits_kind", columns: ["kind"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "tenant_credits_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_TENANT_AI_SETTINGS: TableDefinition = {
  schema: "meta",
  name: "tenant_ai_settings",
  columns: [
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "shared_catalog_opt_in",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "cross_tenant_pattern_learning_opt_in",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "allowed_external_providers",
      type: "JSONB",
      notNull: true,
      default: "'[\"fireworks\"]'::jsonb",
    },
    {
      name: "schema_change_approval_tier",
      type: "TEXT",
      notNull: true,
      default: "'always_human'",
      check:
        "schema_change_approval_tier IN ('tiered', 'always_human', 'agent_can_do_anything')",
    },
    {
      name: "per_session_token_ceiling",
      type: "INTEGER",
      notNull: true,
      default: "50000",
      check: "per_session_token_ceiling > 0",
    },
    {
      name: "per_tenant_monthly_dollar_ceiling",
      type: "INTEGER",
      notNull: true,
      default: "200",
      check: "per_tenant_monthly_dollar_ceiling > 0",
    },
    {
      name: "summarization_frequency_turns",
      type: "INTEGER",
      notNull: true,
      default: "20",
      check: "summarization_frequency_turns BETWEEN 5 AND 100",
    },
    {
      name: "diff_preview_verbose",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "support_transcript_access_granted",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_by", type: "UUID", notNull: true, references: USER_FK },
  ],
  primaryKey: ["tenant_id"],
  rls: {
    enabled: true,
    policies: [
      { name: "tenant_ai_settings_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_BILLING_EVENTS: TableDefinition = {
  schema: "meta",
  name: "billing_events",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('subscription_created', 'subscription_changed', 'subscription_canceled', 'subscription_paused', 'subscription_resumed', 'trial_started', 'trial_converted', 'trial_expired', 'invoice_issued', 'invoice_paid', 'invoice_failed', 'invoice_voided', 'payment_method_added', 'payment_method_removed', 'refund_issued', 'credit_applied', 'credit_issued', 'plan_changed', 'dunning_advanced', 'usage_synced')",
    },
    { name: "actor", type: "JSONB", notNull: true },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "subscription_id", type: "UUID" },
    { name: "invoice_id", type: "UUID" },
    { name: "amount_cents", type: "INTEGER" },
    { name: "currency", type: "CHAR(3)" },
    { name: "payload", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_billing_events_tenant_occurred", columns: ["tenant_id", "occurred_at"] },
    { name: "idx_billing_events_kind", columns: ["tenant_id", "kind"] },
    { name: "idx_billing_events_subscription", columns: ["subscription_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "billing_events_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_FEATURE_FLAGS: TableDefinition = {
  schema: "meta",
  name: "feature_flags",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "key",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "feature_flags_key_key" },
      check: "key ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$'",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check: "kind IN ('boolean', 'string', 'number', 'json')",
    },
    { name: "description", type: "TEXT", notNull: true },
    { name: "default_value", type: "JSONB", notNull: true },
    {
      name: "environments",
      type: "JSONB",
      notNull: true,
      default: "'[]'::jsonb",
    },
    {
      name: "rules",
      type: "JSONB",
      notNull: true,
      default: "'[]'::jsonb",
    },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "archived_at", type: "TIMESTAMPTZ" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_feature_flags_enabled", columns: ["enabled"] },
    { name: "idx_feature_flags_archived_at", columns: ["archived_at"] },
  ],
};

export const META_DEPLOYMENTS: TableDefinition = {
  schema: "meta",
  name: "deployments",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "app_kind",
      type: "TEXT",
      notNull: true,
      check:
        "app_kind IN ('web', 'marketing', 'docs_site', 'ops', 'cdc_shipper', 'hl7_listener', 'virus_scanner', 'gpu_inference', 'mobile_shell')",
    },
    { name: "app_id", type: "TEXT", notNull: true },
    {
      name: "environment",
      type: "TEXT",
      notNull: true,
      check: "environment IN ('preview', 'staging', 'production', 'sandbox')",
    },
    {
      name: "region",
      type: "TEXT",
      notNull: true,
      check:
        "region IN ('eu-central', 'eu-west', 'us-east', 'us-west', 'me-uae', 'gcc-ksa', 'apac-sg', 'ap-south')",
    },
    {
      name: "target",
      type: "TEXT",
      notNull: true,
      check:
        "target IN ('vercel_edge', 'vercel_node', 'fly_machine', 'fly_gpu', 'supabase_functions', 'cloudflare_worker', 'appstore_connect', 'play_console', 'helm_release', 'docs_pages')",
    },
    {
      name: "strategy",
      type: "TEXT",
      notNull: true,
      check:
        "strategy IN ('rolling', 'blue_green', 'canary', 'recreate')",
    },
    {
      name: "version",
      type: "TEXT",
      notNull: true,
      check: "version ~ '^v?[0-9]+\\.[0-9]+\\.[0-9]+'",
    },
    {
      name: "commit_sha",
      type: "CHAR(40)",
      notNull: true,
      check: "commit_sha ~ '^[0-9a-f]{40}$'",
    },
    { name: "artifact_ref", type: "TEXT", notNull: true },
    {
      name: "trigger",
      type: "TEXT",
      notNull: true,
      check:
        "trigger IN ('merge_to_main', 'manual_promotion', 'scheduled_release', 'rollback', 'live_update')",
    },
    { name: "triggered_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "queued_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "duration_seconds",
      type: "INTEGER",
      check: "duration_seconds IS NULL OR duration_seconds >= 0",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('queued', 'in_progress', 'succeeded', 'failed', 'rolled_back', 'cancelled')",
    },
    { name: "previous_version", type: "TEXT" },
    { name: "rolled_back_to_deployment_id", type: "UUID" },
    { name: "health_check_passed", type: "BOOLEAN" },
    { name: "sentry_release_id", type: "TEXT" },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_deployments_app_environment_queued",
      columns: ["app_kind", "environment", "queued_at"],
    },
    { name: "idx_deployments_status", columns: ["status"] },
    { name: "idx_deployments_commit_sha", columns: ["commit_sha"] },
  ],
};

export const META_BACKUP_RECORDS: TableDefinition = {
  schema: "meta",
  name: "backup_records",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "policy_id", type: "TEXT", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('full', 'incremental', 'wal_archive', 'logical_dump', 'object_snapshot')",
    },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "duration_seconds",
      type: "INTEGER",
      check: "duration_seconds IS NULL OR duration_seconds >= 0",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('scheduled', 'running', 'succeeded', 'failed', 'verified', 'expired')",
    },
    { name: "size_bytes", type: "BIGINT", check: "size_bytes IS NULL OR size_bytes >= 0" },
    { name: "sha256", type: "CHAR(64)", check: "sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'" },
    {
      name: "storage_region",
      type: "TEXT",
      notNull: true,
      check:
        "storage_region IN ('eu-central', 'eu-west', 'us-east', 'us-west', 'me-uae', 'gcc-ksa', 'apac-sg', 'ap-south')",
    },
    {
      name: "copied_to_regions",
      type: "JSONB",
      notNull: true,
      default: "'[]'::jsonb",
    },
    { name: "verified_at", type: "TIMESTAMPTZ" },
    { name: "verified_by", type: "TEXT" },
    { name: "expires_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "error_message", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_backup_records_policy_started", columns: ["policy_id", "started_at"] },
    { name: "idx_backup_records_status", columns: ["status"] },
    { name: "idx_backup_records_expires_at", columns: ["expires_at"] },
  ],
};

export const META_FAILOVER_RECORDS: TableDefinition = {
  schema: "meta",
  name: "failover_records",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "tier",
      type: "TEXT",
      notNull: true,
      check:
        "tier IN ('tier_0_mission_critical', 'tier_1_business_critical', 'tier_2_important', 'tier_3_recoverable', 'tier_4_best_effort')",
    },
    {
      name: "trigger",
      type: "TEXT",
      notNull: true,
      check:
        "trigger IN ('planned_drill', 'primary_outage', 'regional_failure', 'maintenance_window', 'manual_promotion')",
    },
    { name: "triggered_by", type: "TEXT", notNull: true },
    { name: "triggered_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "from_region",
      type: "TEXT",
      notNull: true,
      check:
        "from_region IN ('eu-central', 'eu-west', 'us-east', 'us-west', 'me-uae', 'gcc-ksa', 'apac-sg', 'ap-south')",
    },
    {
      name: "to_region",
      type: "TEXT",
      notNull: true,
      check:
        "to_region IN ('eu-central', 'eu-west', 'us-east', 'us-west', 'me-uae', 'gcc-ksa', 'apac-sg', 'ap-south')",
    },
    { name: "affected_apps", type: "JSONB", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('queued', 'in_progress', 'succeeded', 'failed', 'aborted', 'reverted')",
    },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "duration_seconds",
      type: "INTEGER",
      check: "duration_seconds IS NULL OR duration_seconds >= 0",
    },
    {
      name: "actual_rpo_seconds",
      type: "INTEGER",
      check: "actual_rpo_seconds IS NULL OR actual_rpo_seconds >= 0",
    },
    {
      name: "actual_rto_seconds",
      type: "INTEGER",
      check: "actual_rto_seconds IS NULL OR actual_rto_seconds >= 0",
    },
    { name: "reverted_at", type: "TIMESTAMPTZ" },
    { name: "reverted_to_failover_id", type: "UUID" },
    { name: "incident_ticket_id", type: "TEXT" },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_failover_records_triggered_at", columns: ["triggered_at"] },
    { name: "idx_failover_records_status", columns: ["status"] },
    { name: "idx_failover_records_from_to", columns: ["from_region", "to_region"] },
  ],
};

export const META_DR_DRILLS: TableDefinition = {
  schema: "meta",
  name: "dr_drills",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('tabletop', 'restore_test', 'failover_test', 'full_regional', 'chaos_injection')",
    },
    {
      name: "tier",
      type: "TEXT",
      notNull: true,
      check:
        "tier IN ('tier_0_mission_critical', 'tier_1_business_critical', 'tier_2_important', 'tier_3_recoverable', 'tier_4_best_effort')",
    },
    { name: "scheduled_for", type: "TIMESTAMPTZ", notNull: true },
    { name: "executed_at", type: "TIMESTAMPTZ" },
    { name: "executed_by", type: "TEXT" },
    { name: "scope_regions", type: "JSONB", notNull: true },
    { name: "scope_apps", type: "JSONB", notNull: true },
    {
      name: "outcome",
      type: "TEXT",
      notNull: true,
      check:
        "outcome IN ('passed', 'passed_with_findings', 'failed', 'aborted', 'not_executed')",
    },
    {
      name: "measured_rpo_seconds",
      type: "INTEGER",
      check: "measured_rpo_seconds IS NULL OR measured_rpo_seconds >= 0",
    },
    {
      name: "measured_rto_seconds",
      type: "INTEGER",
      check: "measured_rto_seconds IS NULL OR measured_rto_seconds >= 0",
    },
    { name: "findings", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "report_url", type: "TEXT" },
    { name: "next_drill_due_at", type: "TIMESTAMPTZ", notNull: true },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_dr_drills_kind_scheduled", columns: ["kind", "scheduled_for"] },
    { name: "idx_dr_drills_tier", columns: ["tier"] },
    { name: "idx_dr_drills_next_due", columns: ["next_drill_due_at"] },
    { name: "idx_dr_drills_outcome", columns: ["outcome"] },
  ],
};

export const META_AUTOSCALING_EVENTS: TableDefinition = {
  schema: "meta",
  name: "autoscaling_events",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "policy_id", type: "TEXT", notNull: true },
    { name: "app_id", type: "TEXT", notNull: true },
    {
      name: "region",
      type: "TEXT",
      notNull: true,
      check:
        "region IN ('eu-central', 'eu-west', 'us-east', 'us-west', 'me-uae', 'gcc-ksa', 'apac-sg', 'ap-south')",
    },
    {
      name: "signal",
      type: "TEXT",
      notNull: true,
      check:
        "signal IN ('cpu_pct', 'memory_pct', 'rps', 'p99_latency_ms', 'queue_depth', 'error_rate_pct', 'concurrent_connections')",
    },
    { name: "observed_value", type: "NUMERIC(14, 4)", notNull: true },
    {
      name: "decision",
      type: "TEXT",
      notNull: true,
      check:
        "decision IN ('scale_up', 'scale_down', 'hold', 'throttled')",
    },
    {
      name: "reason",
      type: "TEXT",
      notNull: true,
      check:
        "reason IN ('threshold_exceeded', 'threshold_recovered', 'cooldown_active', 'min_replicas_reached', 'max_replicas_reached', 'manual_override')",
    },
    { name: "from_replicas", type: "INTEGER", notNull: true, check: "from_replicas >= 0" },
    { name: "to_replicas", type: "INTEGER", notNull: true, check: "to_replicas >= 0" },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "duration_ms",
      type: "INTEGER",
      check: "duration_ms IS NULL OR duration_ms >= 0",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_autoscaling_app_occurred", columns: ["app_id", "occurred_at"] },
    { name: "idx_autoscaling_policy", columns: ["policy_id"] },
    { name: "idx_autoscaling_decision", columns: ["decision"] },
  ],
};

export const META_BUDGET_BREACHES: TableDefinition = {
  schema: "meta",
  name: "budget_breaches",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "route_id", type: "TEXT", notNull: true },
    {
      name: "percentile",
      type: "TEXT",
      notNull: true,
      check: "percentile IN ('p50', 'p95', 'p99')",
    },
    { name: "budget_ms", type: "NUMERIC(12, 3)", notNull: true, check: "budget_ms > 0" },
    {
      name: "observed_ms",
      type: "NUMERIC(12, 3)",
      notNull: true,
      check: "observed_ms > 0",
    },
    {
      name: "severity",
      type: "TEXT",
      notNull: true,
      check: "severity IN ('info', 'warning', 'critical')",
    },
    { name: "observed_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "window_start", type: "TIMESTAMPTZ", notNull: true },
    { name: "window_end", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "sample_count",
      type: "INTEGER",
      notNull: true,
      check: "sample_count > 0",
    },
    { name: "alert_sent", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "paged_at", type: "TIMESTAMPTZ" },
    { name: "resolved_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_budget_breaches_route_observed", columns: ["route_id", "observed_at"] },
    { name: "idx_budget_breaches_severity", columns: ["severity"] },
    { name: "idx_budget_breaches_unresolved", columns: ["resolved_at"] },
  ],
};

export const META_API_KEYS: TableDefinition = {
  schema: "meta",
  name: "api_keys",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "key_prefix",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "api_keys_prefix_key" },
      check: "key_prefix ~ '^ce_(live|test)_[A-Za-z0-9]{8}$'",
    },
    {
      name: "secret_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "secret_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "scopes", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "tags", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      default: "'active'",
      check: "status IN ('active', 'revoked', 'expired')",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "expires_at", type: "TIMESTAMPTZ" },
    { name: "last_used_at", type: "TIMESTAMPTZ" },
    { name: "revoked_at", type: "TIMESTAMPTZ" },
    { name: "revoked_by", type: "UUID", references: USER_FK },
    { name: "revoked_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_api_keys_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_api_keys_last_used", columns: ["tenant_id", "last_used_at"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "api_keys_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_WEBHOOK_ENDPOINTS: TableDefinition = {
  schema: "meta",
  name: "webhook_endpoints",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "endpoint_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "webhook_endpoints_endpoint_id_key" },
      check: "endpoint_id ~ '^whk_[A-Za-z0-9]{8,32}$'",
    },
    {
      name: "url",
      type: "TEXT",
      notNull: true,
      check: "url ~ '^https://'",
    },
    { name: "events", type: "JSONB", notNull: true },
    {
      name: "signing_secret_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "signing_secret_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "signing_algorithm",
      type: "TEXT",
      notNull: true,
      default: "'hmac-sha256'",
      check: "signing_algorithm = 'hmac-sha256'",
    },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "description", type: "TEXT" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "last_delivered_at", type: "TIMESTAMPTZ" },
    { name: "last_failure_at", type: "TIMESTAMPTZ" },
    {
      name: "consecutive_failures",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "consecutive_failures >= 0",
    },
    { name: "disabled_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_webhook_endpoints_tenant_enabled", columns: ["tenant_id", "enabled"] },
    { name: "idx_webhook_endpoints_consecutive_failures", columns: ["consecutive_failures"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "webhook_endpoints_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_WEBHOOK_DELIVERIES: TableDefinition = {
  schema: "meta",
  name: "webhook_deliveries",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "endpoint_id",
      type: "TEXT",
      notNull: true,
      check: "endpoint_id ~ '^whk_[A-Za-z0-9]{8,32}$'",
    },
    { name: "event", type: "TEXT", notNull: true },
    {
      name: "payload_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "payload_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "signature", type: "TEXT", notNull: true },
    { name: "signed_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('pending', 'delivering', 'delivered', 'retrying', 'failed', 'dropped')",
    },
    {
      name: "attempt",
      type: "INTEGER",
      notNull: true,
      default: "1",
      check: "attempt >= 1",
    },
    {
      name: "max_attempts",
      type: "INTEGER",
      notNull: true,
      default: "8",
      check: "max_attempts >= 1",
    },
    { name: "response_status", type: "INTEGER" },
    { name: "response_body_sha256", type: "CHAR(64)" },
    { name: "delivered_at", type: "TIMESTAMPTZ" },
    { name: "failed_at", type: "TIMESTAMPTZ" },
    { name: "failure_reason", type: "TEXT" },
    { name: "next_retry_at", type: "TIMESTAMPTZ" },
    { name: "dropped_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_webhook_deliveries_endpoint_signed",
      columns: ["endpoint_id", "signed_at"],
    },
    {
      name: "idx_webhook_deliveries_tenant_status",
      columns: ["tenant_id", "status"],
    },
    {
      name: "idx_webhook_deliveries_next_retry",
      columns: ["next_retry_at"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "webhook_deliveries_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_IDEMPOTENCY_RECORDS: TableDefinition = {
  schema: "meta",
  name: "idempotency_records",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "key",
      type: "TEXT",
      notNull: true,
      check: "key ~ '^[A-Za-z0-9_-]{8,64}$'",
    },
    { name: "method", type: "TEXT", notNull: true },
    { name: "path", type: "TEXT", notNull: true },
    {
      name: "request_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "request_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "response_status", type: "INTEGER" },
    { name: "response_body_sha256", type: "CHAR(64)" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "expires_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "in_progress", type: "BOOLEAN", notNull: true, default: "true" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "idempotency_records_tenant_key", columns: ["tenant_id", "key"] },
  ],
  indexes: [
    { name: "idx_idempotency_expires", columns: ["expires_at"] },
    {
      name: "idx_idempotency_tenant_created",
      columns: ["tenant_id", "created_at"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "idempotency_records_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_EXTENSION_PACKS: TableDefinition = {
  schema: "meta",
  name: "extension_packs",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "pack_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "extension_packs_pack_id_key" },
      check: "pack_id ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*){1,3}$'",
    },
    { name: "name", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('vertical_template', 'integration_bundle', 'ai_tool', 'ui_extension', 'workflow_pack', 'compliance_addon', 'data_connector', 'theme')",
    },
    {
      name: "author_kind",
      type: "TEXT",
      notNull: true,
      check:
        "author_kind IN ('crossengin_official', 'certified_partner', 'community', 'private_tenant')",
    },
    { name: "author_name", type: "TEXT", notNull: true },
    { name: "author_email", type: "TEXT" },
    { name: "license", type: "TEXT", notNull: true },
    { name: "homepage_url", type: "TEXT" },
    { name: "repository_url", type: "TEXT" },
    { name: "keywords", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "min_platform_version", type: "TEXT", notNull: true },
    { name: "max_platform_version", type: "TEXT" },
    {
      name: "requires_phi_access",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "handles_user_data",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "private_tenant_id",
      type: "UUID",
      references: TENANT_FK,
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_extension_packs_kind", columns: ["kind"] },
    { name: "idx_extension_packs_author_kind", columns: ["author_kind"] },
    { name: "idx_extension_packs_private_tenant", columns: ["private_tenant_id"] },
  ],
};

export const META_PACK_VERSIONS: TableDefinition = {
  schema: "meta",
  name: "pack_versions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "pack_id",
      type: "TEXT",
      notNull: true,
      check: "pack_id ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*){1,3}$'",
    },
    { name: "version", type: "TEXT", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('draft', 'in_review', 'published', 'deprecated', 'withdrawn')",
    },
    {
      name: "channel",
      type: "TEXT",
      notNull: true,
      check: "channel IN ('stable', 'beta', 'canary', 'internal')",
    },
    {
      name: "bundle_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "bundle_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "bundle_size_bytes",
      type: "BIGINT",
      notNull: true,
      check: "bundle_size_bytes > 0",
    },
    {
      name: "manifest_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "manifest_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "signature", type: "JSONB", notNull: true },
    { name: "changelog", type: "TEXT", notNull: true },
    { name: "published_at", type: "TIMESTAMPTZ" },
    { name: "published_by", type: "UUID", references: USER_FK },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "deprecated_reason", type: "TEXT" },
    { name: "withdrawn_at", type: "TIMESTAMPTZ" },
    { name: "withdrawn_reason", type: "TEXT" },
    { name: "superseded_by", type: "TEXT" },
    {
      name: "security_review_status",
      type: "TEXT",
      notNull: true,
      default: "'pending'",
      check:
        "security_review_status IN ('pending', 'in_progress', 'passed', 'failed', 'exempt')",
    },
    { name: "security_reviewed_at", type: "TIMESTAMPTZ" },
    { name: "security_reviewer", type: "UUID", references: USER_FK },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "pack_versions_pack_version_key", columns: ["pack_id", "version"] },
  ],
  indexes: [
    { name: "idx_pack_versions_pack_status", columns: ["pack_id", "status"] },
    { name: "idx_pack_versions_channel", columns: ["channel"] },
    { name: "idx_pack_versions_security_review", columns: ["security_review_status"] },
  ],
};

export const META_PACK_INSTALLATIONS: TableDefinition = {
  schema: "meta",
  name: "pack_installations",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "pack_id",
      type: "TEXT",
      notNull: true,
      check: "pack_id ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*){1,3}$'",
    },
    { name: "installed_version", type: "TEXT" },
    { name: "pinned_version", type: "TEXT" },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('requested', 'permission_pending', 'installing', 'installed', 'updating', 'failed', 'uninstalling', 'uninstalled')",
    },
    {
      name: "update_policy",
      type: "TEXT",
      notNull: true,
      default: "'manual'",
      check:
        "update_policy IN ('manual', 'patch_auto', 'minor_auto', 'track_latest')",
    },
    { name: "config", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    { name: "permission_grants", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "requested_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "requested_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "installed_at", type: "TIMESTAMPTZ" },
    { name: "installed_by", type: "UUID", references: USER_FK },
    { name: "last_updated_at", type: "TIMESTAMPTZ" },
    { name: "uninstalled_at", type: "TIMESTAMPTZ" },
    { name: "uninstalled_by", type: "UUID", references: USER_FK },
    { name: "failure_reason", type: "TEXT" },
    { name: "isolation_sandbox", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_pack_installations_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_pack_installations_pack", columns: ["pack_id"] },
    {
      name: "idx_pack_installations_tenant_pack_active",
      columns: ["tenant_id", "pack_id", "status"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "pack_installations_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_PACK_REVIEWS: TableDefinition = {
  schema: "meta",
  name: "pack_reviews",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "pack_id",
      type: "TEXT",
      notNull: true,
      check: "pack_id ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*){1,3}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "author_id", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "rating",
      type: "INTEGER",
      notNull: true,
      check: "rating BETWEEN 1 AND 5",
    },
    { name: "title", type: "TEXT", notNull: true },
    { name: "body", type: "TEXT", notNull: true },
    { name: "verified_install", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "submitted_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "edited_at", type: "TIMESTAMPTZ" },
    {
      name: "moderation_status",
      type: "TEXT",
      notNull: true,
      default: "'published'",
      check: "moderation_status IN ('published', 'pending', 'hidden')",
    },
    { name: "hidden_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "pack_reviews_one_per_author",
      columns: ["pack_id", "tenant_id", "author_id"],
    },
  ],
  indexes: [
    { name: "idx_pack_reviews_pack_submitted", columns: ["pack_id", "submitted_at"] },
    { name: "idx_pack_reviews_moderation", columns: ["moderation_status"] },
    { name: "idx_pack_reviews_tenant", columns: ["tenant_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "pack_reviews_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_IMPORT_SOURCES: TableDefinition = {
  schema: "meta",
  name: "import_sources",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "source_id",
      type: "TEXT",
      notNull: true,
      check: "source_id ~ '^[a-z][a-z0-9-]*$'",
    },
    { name: "label", type: "TEXT", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('csv', 'jsonl', 'json', 'excel_xlsx', 'parquet', 'salesforce', 'servicenow', 'sql_dump_postgres', 'sql_dump_mysql', 'http_api', 'hl7_v2', 'fhir_r4')",
    },
    { name: "location", type: "TEXT", notNull: true },
    { name: "auth", type: "JSONB", notNull: true },
    {
      name: "schedule",
      type: "TEXT",
      notNull: true,
      default: "'one_shot'",
      check:
        "schedule IN ('one_shot', 'interval', 'cron', 'webhook_driven')",
    },
    { name: "interval_seconds", type: "INTEGER" },
    { name: "cron", type: "TEXT" },
    {
      name: "sample_size",
      type: "INTEGER",
      notNull: true,
      default: "100",
      check: "sample_size BETWEEN 1 AND 10000",
    },
    { name: "primary_entity", type: "TEXT" },
    { name: "source_schema_url", type: "TEXT" },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "last_fetched_at", type: "TIMESTAMPTZ" },
    {
      name: "last_fetch_status",
      type: "TEXT",
      check: "last_fetch_status IS NULL OR last_fetch_status IN ('ok', 'error', 'rate_limited')",
    },
    { name: "last_fetch_error", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "import_sources_tenant_source_id_key", columns: ["tenant_id", "source_id"] },
  ],
  indexes: [
    { name: "idx_import_sources_tenant_enabled", columns: ["tenant_id", "enabled"] },
    { name: "idx_import_sources_kind", columns: ["kind"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "import_sources_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_BACKFILL_JOBS: TableDefinition = {
  schema: "meta",
  name: "backfill_jobs",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "source_id",
      type: "TEXT",
      notNull: true,
      check: "source_id ~ '^[a-z][a-z0-9-]*$'",
    },
    {
      name: "mapping_id",
      type: "TEXT",
      notNull: true,
      check: "mapping_id ~ '^[a-z][a-z0-9-]*$'",
    },
    { name: "preview_run_id", type: "UUID" },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('queued', 'running', 'paused', 'completed', 'completed_with_errors', 'failed', 'cancelled')",
    },
    {
      name: "conflict_resolution",
      type: "TEXT",
      notNull: true,
      default: "'skip_duplicate'",
      check:
        "conflict_resolution IN ('skip_duplicate', 'overwrite_existing', 'fail_on_conflict', 'merge_fields')",
    },
    {
      name: "batch_size",
      type: "INTEGER",
      notNull: true,
      default: "500",
      check: "batch_size BETWEEN 1 AND 10000",
    },
    {
      name: "parallelism",
      type: "INTEGER",
      notNull: true,
      default: "4",
      check: "parallelism BETWEEN 1 AND 64",
    },
    { name: "rate_limit_rows_per_second", type: "INTEGER" },
    { name: "queued_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "duration_seconds",
      type: "INTEGER",
      check: "duration_seconds IS NULL OR duration_seconds >= 0",
    },
    {
      name: "total_rows_estimate",
      type: "BIGINT",
      check: "total_rows_estimate IS NULL OR total_rows_estimate >= 0",
    },
    {
      name: "rows_processed",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "rows_processed >= 0",
    },
    {
      name: "rows_inserted",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "rows_inserted >= 0",
    },
    {
      name: "rows_updated",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "rows_updated >= 0",
    },
    {
      name: "rows_skipped",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "rows_skipped >= 0",
    },
    {
      name: "rows_failed",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "rows_failed >= 0",
    },
    { name: "last_error", type: "TEXT" },
    { name: "requested_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "cancelled_by", type: "UUID", references: USER_FK },
    { name: "cancelled_reason", type: "TEXT" },
    { name: "checkpoint_token", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_backfill_jobs_tenant_queued", columns: ["tenant_id", "queued_at"] },
    { name: "idx_backfill_jobs_status", columns: ["status"] },
    { name: "idx_backfill_jobs_source", columns: ["source_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "backfill_jobs_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_BACKFILL_LEDGER: TableDefinition = {
  schema: "meta",
  name: "backfill_ledger",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "backfill_job_id", type: "UUID", notNull: true },
    {
      name: "source_row_index",
      type: "BIGINT",
      notNull: true,
      check: "source_row_index >= 0",
    },
    { name: "idempotency_key", type: "TEXT", notNull: true },
    {
      name: "source_row_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "source_row_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "target_entity", type: "TEXT", notNull: true },
    { name: "target_row_id", type: "TEXT" },
    {
      name: "outcome",
      type: "TEXT",
      notNull: true,
      check:
        "outcome IN ('inserted', 'updated', 'skipped', 'failed', 'merged')",
    },
    { name: "outcome_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "error_message", type: "TEXT" },
    {
      name: "retry_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "retry_count >= 0",
    },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "backfill_ledger_job_idempotency_key",
      columns: ["backfill_job_id", "idempotency_key"],
    },
  ],
  indexes: [
    { name: "idx_backfill_ledger_tenant_outcome", columns: ["tenant_id", "outcome"] },
    { name: "idx_backfill_ledger_job_outcome_at", columns: ["backfill_job_id", "outcome_at"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "backfill_ledger_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_ONBOARDING_RUNS: TableDefinition = {
  schema: "meta",
  name: "onboarding_runs",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "path",
      type: "TEXT",
      notNull: true,
      check: "path IN ('bring_my_data', 'vertical_template', 'blank_workspace')",
    },
    {
      name: "current_stage",
      type: "TEXT",
      notNull: true,
      check:
        "current_stage IN ('workspace_setup', 'plan_selection', 'schema_design', 'user_invites', 'first_import', 'validate', 'go_live')",
    },
    { name: "stages", type: "JSONB", notNull: true },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "started_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "abandoned_at", type: "TIMESTAMPTZ" },
    { name: "abandoned_reason", type: "TEXT" },
    { name: "source_pack_id", type: "TEXT" },
    { name: "source_import_id", type: "UUID" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "onboarding_runs_one_active_per_tenant", columns: ["tenant_id"] },
  ],
  indexes: [
    { name: "idx_onboarding_runs_current_stage", columns: ["current_stage"] },
    { name: "idx_onboarding_runs_started", columns: ["started_at"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "onboarding_runs_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_ML_CONSENT: TableDefinition = {
  schema: "meta",
  name: "ml_consent",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "purpose",
      type: "TEXT",
      notNull: true,
      check:
        "purpose IN ('global_model_improvement', 'tenant_specific_finetune', 'shared_catalog_patterns', 'redteam_evaluation', 'benchmarking_only')",
    },
    { name: "allowed_data_classes", type: "JSONB", notNull: true },
    { name: "redact_pii", type: "BOOLEAN", notNull: true, default: "true" },
    {
      name: "minimum_k_anonymity",
      type: "INTEGER",
      notNull: true,
      default: "5",
      check: "minimum_k_anonymity BETWEEN 1 AND 1000",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('active', 'withdrawn', 'expired', 'superseded')",
    },
    { name: "granted_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "granted_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "granted_by_role", type: "TEXT", notNull: true },
    { name: "expires_at", type: "TIMESTAMPTZ" },
    { name: "withdrawn_at", type: "TIMESTAMPTZ" },
    { name: "withdrawn_by", type: "UUID", references: USER_FK },
    { name: "withdrawn_reason", type: "TEXT" },
    { name: "superseding_consent_id", type: "UUID" },
    { name: "terms_version", type: "TEXT", notNull: true },
    {
      name: "legal_basis",
      type: "TEXT",
      notNull: true,
      check: "legal_basis IN ('consent', 'contract', 'legitimate_interest')",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_ml_consent_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_ml_consent_purpose", columns: ["purpose"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "ml_consent_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_ML_DATASETS: TableDefinition = {
  schema: "meta",
  name: "ml_datasets",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "dataset_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "ml_datasets_dataset_id_key" },
      check: "dataset_id ~ '^ds_[a-z0-9-]{4,40}$'",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    {
      name: "purpose",
      type: "TEXT",
      notNull: true,
      check:
        "purpose IN ('global_model_improvement', 'tenant_specific_finetune', 'shared_catalog_patterns', 'redteam_evaluation', 'benchmarking_only')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('drafting', 'frozen', 'deprecated', 'purged')",
    },
    { name: "source_consent_ids", type: "JSONB", notNull: true },
    { name: "data_classes", type: "JSONB", notNull: true },
    {
      name: "redaction_strategy",
      type: "TEXT",
      notNull: true,
      check:
        "redaction_strategy IN ('drop_row', 'mask_token', 'fake_replacement', 'differential_privacy')",
    },
    {
      name: "minimum_k_anonymity",
      type: "INTEGER",
      notNull: true,
      default: "5",
      check: "minimum_k_anonymity BETWEEN 1 AND 1000",
    },
    { name: "splits", type: "JSONB", notNull: true },
    {
      name: "total_sample_count",
      type: "BIGINT",
      notNull: true,
      check: "total_sample_count >= 1",
    },
    {
      name: "total_size_bytes",
      type: "BIGINT",
      notNull: true,
      check: "total_size_bytes >= 1",
    },
    { name: "storage_uri", type: "TEXT", notNull: true },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "frozen_at", type: "TIMESTAMPTZ" },
    { name: "frozen_by", type: "UUID", references: USER_FK },
    { name: "frozen_sha256", type: "CHAR(64)" },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "deprecated_reason", type: "TEXT" },
    { name: "purged_at", type: "TIMESTAMPTZ" },
    { name: "purged_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_ml_datasets_status", columns: ["status"] },
    { name: "idx_ml_datasets_purpose", columns: ["purpose"] },
  ],
};

export const META_ML_EVALSETS: TableDefinition = {
  schema: "meta",
  name: "ml_evalsets",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "evalset_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "ml_evalsets_evalset_id_key" },
      check: "evalset_id ~ '^eval_[a-z0-9-]{4,40}$'",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    {
      name: "task_kind",
      type: "TEXT",
      notNull: true,
      check:
        "task_kind IN ('manifest_proposal', 'sql_generation', 'permission_decision', 'redaction_decision', 'summarization', 'intent_classification', 'safety_refusal', 'regression_replay')",
    },
    { name: "examples", type: "JSONB", notNull: true },
    { name: "frozen_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "frozen_by", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "frozen_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "frozen_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "required_pass_rate",
      type: "NUMERIC(4, 3)",
      notNull: true,
      check: "required_pass_rate BETWEEN 0 AND 1",
    },
    {
      name: "blocks_production_promotion",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "version", type: "TEXT", notNull: true },
    { name: "superseded_by", type: "TEXT" },
    { name: "retired_at", type: "TIMESTAMPTZ" },
    { name: "retired_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_ml_evalsets_task_kind", columns: ["task_kind"] },
    { name: "idx_ml_evalsets_blocking", columns: ["blocks_production_promotion"] },
  ],
};

export const META_ML_TRAINING_RUNS: TableDefinition = {
  schema: "meta",
  name: "ml_training_runs",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "run_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "ml_training_runs_run_id_key" },
      check: "run_id ~ '^train_[a-z0-9]{8,32}$'",
    },
    { name: "label", type: "TEXT", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('supervised_finetune', 'preference_finetune', 'embedding_train', 'lora_adapter', 'qlora_adapter', 'full_pretrain_continue')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('queued', 'preparing', 'running', 'succeeded', 'failed', 'cancelled')",
    },
    { name: "base_model_id", type: "TEXT", notNull: true },
    {
      name: "dataset_id",
      type: "TEXT",
      notNull: true,
      check: "dataset_id ~ '^ds_[a-z0-9-]{4,40}$'",
    },
    {
      name: "dataset_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "dataset_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "hyperparameters", type: "JSONB", notNull: true },
    {
      name: "estimated_cost_usd",
      type: "NUMERIC(12, 6)",
      notNull: true,
      check: "estimated_cost_usd >= 0",
    },
    {
      name: "actual_cost_usd",
      type: "NUMERIC(12, 6)",
      check: "actual_cost_usd IS NULL OR actual_cost_usd >= 0",
    },
    {
      name: "estimated_duration_minutes",
      type: "INTEGER",
      notNull: true,
      check: "estimated_duration_minutes > 0",
    },
    {
      name: "actual_duration_minutes",
      type: "INTEGER",
      check: "actual_duration_minutes IS NULL OR actual_duration_minutes >= 0",
    },
    { name: "queued_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "requested_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "approved_by", type: "UUID", references: USER_FK },
    { name: "cancelled_by", type: "UUID", references: USER_FK },
    { name: "cancelled_reason", type: "TEXT" },
    { name: "failure_reason", type: "TEXT" },
    { name: "output_model_artifact_sha256", type: "CHAR(64)" },
    { name: "output_model_storage_uri", type: "TEXT" },
    { name: "train_loss_final", type: "NUMERIC(12, 6)" },
    { name: "validation_loss_final", type: "NUMERIC(12, 6)" },
    {
      name: "tokens_consumed",
      type: "BIGINT",
      check: "tokens_consumed IS NULL OR tokens_consumed >= 0",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_ml_training_runs_status", columns: ["status"] },
    { name: "idx_ml_training_runs_kind", columns: ["kind"] },
    { name: "idx_ml_training_runs_queued", columns: ["queued_at"] },
  ],
};

export const META_ML_EVALUATIONS: TableDefinition = {
  schema: "meta",
  name: "ml_evaluations",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "eval_run_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "ml_evaluations_eval_run_id_key" },
      check: "eval_run_id ~ '^evalrun_[a-z0-9]{8,32}$'",
    },
    {
      name: "evalset_id",
      type: "TEXT",
      notNull: true,
      check: "evalset_id ~ '^eval_[a-z0-9-]{4,40}$'",
    },
    {
      name: "evalset_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "evalset_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "model_id", type: "TEXT", notNull: true },
    { name: "model_version", type: "TEXT", notNull: true },
    { name: "baseline_run_id", type: "TEXT" },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "duration_seconds",
      type: "INTEGER",
      check: "duration_seconds IS NULL OR duration_seconds >= 0",
    },
    {
      name: "examples_evaluated",
      type: "INTEGER",
      notNull: true,
      check: "examples_evaluated >= 0",
    },
    {
      name: "examples_passed",
      type: "INTEGER",
      notNull: true,
      check: "examples_passed >= 0",
    },
    {
      name: "examples_failed",
      type: "INTEGER",
      notNull: true,
      check: "examples_failed >= 0",
    },
    {
      name: "examples_errored",
      type: "INTEGER",
      notNull: true,
      check: "examples_errored >= 0",
    },
    {
      name: "examples_skipped",
      type: "INTEGER",
      notNull: true,
      check: "examples_skipped >= 0",
    },
    {
      name: "pass_rate",
      type: "NUMERIC(4, 3)",
      notNull: true,
      check: "pass_rate BETWEEN 0 AND 1",
    },
    {
      name: "required_pass_rate",
      type: "NUMERIC(4, 3)",
      notNull: true,
      check: "required_pass_rate BETWEEN 0 AND 1",
    },
    {
      name: "verdict",
      type: "TEXT",
      notNull: true,
      check: "verdict IN ('passed', 'failed', 'regressed', 'improved')",
    },
    {
      name: "total_cost_usd",
      type: "NUMERIC(12, 6)",
      notNull: true,
      check: "total_cost_usd >= 0",
    },
    {
      name: "p50_latency_ms",
      type: "INTEGER",
      notNull: true,
      check: "p50_latency_ms >= 0",
    },
    {
      name: "p99_latency_ms",
      type: "INTEGER",
      notNull: true,
      check: "p99_latency_ms >= 0",
    },
    { name: "results", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "blocks_promotion", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "triggered_by", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "trigger",
      type: "TEXT",
      notNull: true,
      check:
        "trigger IN ('manual', 'ci_pipeline', 'training_completed', 'scheduled_regression')",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_ml_evaluations_model", columns: ["model_id", "model_version"] },
    { name: "idx_ml_evaluations_evalset", columns: ["evalset_id"] },
    { name: "idx_ml_evaluations_verdict", columns: ["verdict"] },
  ],
};

export const META_ML_MODELS: TableDefinition = {
  schema: "meta",
  name: "ml_models",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "model_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "ml_models_model_id_key" },
      check: "model_id ~ '^mdl_[a-z0-9-]{4,40}$'",
    },
    {
      name: "family",
      type: "TEXT",
      notNull: true,
      check:
        "family IN ('manifest_proposer', 'sql_codegen', 'permission_classifier', 'redaction_classifier', 'summarizer', 'embeddings', 'safety_filter', 'intent_classifier')",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "version", type: "TEXT", notNull: true },
    { name: "base_model_id", type: "TEXT", notNull: true },
    { name: "training_run_id", type: "TEXT" },
    {
      name: "artifact_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "artifact_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "artifact_storage_uri", type: "TEXT", notNull: true },
    {
      name: "size_bytes",
      type: "BIGINT",
      notNull: true,
      check: "size_bytes >= 1",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'evaluating', 'approved', 'shadow', 'canary', 'production', 'deprecated', 'retired')",
    },
    { name: "card", type: "JSONB", notNull: true },
    { name: "blocking_eval_run_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    {
      name: "canary_traffic_percent",
      type: "INTEGER",
      check: "canary_traffic_percent IS NULL OR canary_traffic_percent BETWEEN 0 AND 100",
    },
    { name: "promoted_to_production_at", type: "TIMESTAMPTZ" },
    { name: "promoted_to_production_by", type: "UUID", references: USER_FK },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "deprecated_reason", type: "TEXT" },
    { name: "superseded_by", type: "TEXT" },
    { name: "retired_at", type: "TIMESTAMPTZ" },
    { name: "retired_reason", type: "TEXT" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    { name: "ml_models_family_version_key", columns: ["family", "version"] },
  ],
  indexes: [
    { name: "idx_ml_models_family_status", columns: ["family", "status"] },
    { name: "idx_ml_models_status", columns: ["status"] },
  ],
};

export const META_COST_ATTRIBUTION: TableDefinition = {
  schema: "meta",
  name: "cost_attribution",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "period_start", type: "TIMESTAMPTZ", notNull: true },
    { name: "period_end", type: "TIMESTAMPTZ", notNull: true },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    { name: "app_id", type: "TEXT" },
    {
      name: "region",
      type: "TEXT",
      check:
        "region IS NULL OR region IN ('eu-central', 'eu-west', 'us-east', 'us-west', 'me-uae', 'gcc-ksa', 'apac-sg', 'ap-south')",
    },
    {
      name: "environment",
      type: "TEXT",
      check:
        "environment IS NULL OR environment IN ('local', 'preview', 'staging', 'production', 'sandbox')",
    },
    {
      name: "category",
      type: "TEXT",
      notNull: true,
      check:
        "category IN ('compute_serverless', 'compute_long_running', 'compute_gpu', 'storage_hot', 'storage_archive', 'storage_cold', 'egress_bandwidth', 'ingress_bandwidth', 'database_compute', 'database_storage', 'ai_inference', 'ai_training', 'third_party_api', 'search_index', 'observability', 'support_hours', 'license_fees')",
    },
    {
      name: "allocation_method",
      type: "TEXT",
      notNull: true,
      check:
        "allocation_method IN ('direct', 'proportional_usage', 'even_split', 'flat_rate', 'estimated')",
    },
    {
      name: "currency",
      type: "CHAR(3)",
      notNull: true,
      check: "currency ~ '^[A-Z]{3}$'",
    },
    {
      name: "cost_cents",
      type: "BIGINT",
      notNull: true,
      check: "cost_cents >= 0",
    },
    {
      name: "usage_quantity",
      type: "NUMERIC(20, 6)",
      notNull: true,
      check: "usage_quantity >= 0",
    },
    { name: "usage_unit", type: "TEXT", notNull: true },
    {
      name: "provider_cost_cents",
      type: "BIGINT",
      notNull: true,
      check: "provider_cost_cents >= 0",
    },
    { name: "provider_name", type: "TEXT", notNull: true },
    { name: "source_ledger_ref", type: "TEXT", notNull: true },
    { name: "is_estimated", type: "BOOLEAN", notNull: true, default: "false" },
    {
      name: "estimated_confidence",
      type: "NUMERIC(4, 3)",
      check: "estimated_confidence IS NULL OR estimated_confidence BETWEEN 0 AND 1",
    },
    {
      name: "source_data_class",
      type: "TEXT",
      check:
        "source_data_class IS NULL OR source_data_class IN ('public', 'internal', 'commercial_sensitive', 'pii', 'phi', 'regulated')",
    },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_cost_attribution_tenant_period",
      columns: ["tenant_id", "period_start"],
    },
    { name: "idx_cost_attribution_category", columns: ["category"] },
    { name: "idx_cost_attribution_period", columns: ["period_start", "period_end"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "cost_attribution_tenant_isolation",
        using: "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_COST_BUDGETS: TableDefinition = {
  schema: "meta",
  name: "cost_budgets",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "budget_id",
      type: "TEXT",
      notNull: true,
      check: "budget_id ~ '^[a-z][a-z0-9-]*$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    { name: "label", type: "TEXT", notNull: true },
    {
      name: "period",
      type: "TEXT",
      notNull: true,
      check: "period IN ('daily', 'weekly', 'monthly', 'quarterly', 'annual')",
    },
    {
      name: "amount_cents",
      type: "BIGINT",
      notNull: true,
      check: "amount_cents > 0",
    },
    {
      name: "currency",
      type: "CHAR(3)",
      notNull: true,
      check: "currency ~ '^[A-Z]{3}$'",
    },
    { name: "applies_to_categories", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "thresholds", type: "JSONB", notNull: true },
    {
      name: "auto_reset_at_period_end",
      type: "BOOLEAN",
      notNull: true,
      default: "true",
    },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "cost_budgets_tenant_budget_id_key",
      columns: ["tenant_id", "budget_id"],
    },
  ],
  indexes: [
    { name: "idx_cost_budgets_tenant_enabled", columns: ["tenant_id", "enabled"] },
    { name: "idx_cost_budgets_period", columns: ["period"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "cost_budgets_tenant_isolation",
        using: "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_TENANT_UNIT_ECONOMICS: TableDefinition = {
  schema: "meta",
  name: "tenant_unit_economics",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "period_start", type: "TIMESTAMPTZ", notNull: true },
    { name: "period_end", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "currency",
      type: "CHAR(3)",
      notNull: true,
      check: "currency ~ '^[A-Z]{3}$'",
    },
    {
      name: "gross_revenue_cents",
      type: "BIGINT",
      notNull: true,
      check: "gross_revenue_cents >= 0",
    },
    {
      name: "refunds_cents",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "refunds_cents >= 0",
    },
    {
      name: "credits_applied_cents",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "credits_applied_cents >= 0",
    },
    {
      name: "net_revenue_cents",
      type: "BIGINT",
      notNull: true,
      check: "net_revenue_cents >= 0",
    },
    {
      name: "fixed_costs_cents",
      type: "BIGINT",
      notNull: true,
      check: "fixed_costs_cents >= 0",
    },
    {
      name: "variable_costs_cents",
      type: "BIGINT",
      notNull: true,
      check: "variable_costs_cents >= 0",
    },
    {
      name: "total_costs_cents",
      type: "BIGINT",
      notNull: true,
      check: "total_costs_cents >= 0",
    },
    { name: "gross_margin_cents", type: "BIGINT", notNull: true },
    {
      name: "gross_margin_percent",
      type: "NUMERIC(6, 2)",
      notNull: true,
      check: "gross_margin_percent BETWEEN -1000 AND 100",
    },
    { name: "contribution_margin_cents", type: "BIGINT", notNull: true },
    {
      name: "health",
      type: "TEXT",
      notNull: true,
      check:
        "health IN ('healthy', 'watch', 'thin', 'negative', 'loss_leader_approved')",
    },
    { name: "loss_leader_approved_by", type: "UUID", references: USER_FK },
    { name: "loss_leader_approved_reason", type: "TEXT" },
    {
      name: "ltv_estimate_cents",
      type: "BIGINT",
      check: "ltv_estimate_cents IS NULL OR ltv_estimate_cents >= 0",
    },
    {
      name: "cac_estimate_cents",
      type: "BIGINT",
      check: "cac_estimate_cents IS NULL OR cac_estimate_cents >= 0",
    },
    { name: "computed_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "tenant_unit_economics_period_key",
      columns: ["tenant_id", "period_start", "period_end"],
    },
  ],
  indexes: [
    { name: "idx_tenant_unit_economics_health", columns: ["health"] },
    {
      name: "idx_tenant_unit_economics_tenant_period",
      columns: ["tenant_id", "period_start"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "tenant_unit_economics_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_CHARGEBACK_STATEMENTS: TableDefinition = {
  schema: "meta",
  name: "chargeback_statements",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "period_start", type: "TIMESTAMPTZ", notNull: true },
    { name: "period_end", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "currency",
      type: "CHAR(3)",
      notNull: true,
      check: "currency ~ '^[A-Z]{3}$'",
    },
    {
      name: "total_amount_cents",
      type: "BIGINT",
      notNull: true,
      check: "total_amount_cents >= 0",
    },
    { name: "lines", type: "JSONB", notNull: true },
    { name: "generated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "generated_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "approved_at", type: "TIMESTAMPTZ" },
    { name: "approved_by", type: "UUID", references: USER_FK },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'pending_approval', 'approved', 'posted', 'voided')",
    },
    { name: "voided_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_chargeback_period", columns: ["period_start", "period_end"] },
    { name: "idx_chargeback_status", columns: ["status"] },
  ],
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
  META_PLANS,
  META_SUBSCRIPTIONS,
  META_INVOICES,
  META_TENANT_CREDITS,
  META_BILLING_EVENTS,
  META_TENANT_AI_SETTINGS,
  META_FEATURE_FLAGS,
  META_DEPLOYMENTS,
  META_BACKUP_RECORDS,
  META_FAILOVER_RECORDS,
  META_DR_DRILLS,
  META_AUTOSCALING_EVENTS,
  META_BUDGET_BREACHES,
  META_API_KEYS,
  META_WEBHOOK_ENDPOINTS,
  META_WEBHOOK_DELIVERIES,
  META_IDEMPOTENCY_RECORDS,
  META_EXTENSION_PACKS,
  META_PACK_VERSIONS,
  META_PACK_INSTALLATIONS,
  META_PACK_REVIEWS,
  META_IMPORT_SOURCES,
  META_BACKFILL_JOBS,
  META_BACKFILL_LEDGER,
  META_ONBOARDING_RUNS,
  META_ML_CONSENT,
  META_ML_DATASETS,
  META_ML_EVALSETS,
  META_ML_TRAINING_RUNS,
  META_ML_EVALUATIONS,
  META_ML_MODELS,
  META_COST_ATTRIBUTION,
  META_COST_BUDGETS,
  META_TENANT_UNIT_ECONOMICS,
  META_CHARGEBACK_STATEMENTS,
];
