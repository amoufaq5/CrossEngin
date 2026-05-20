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
    { name: "idx_manifests_applied_by", columns: ["applied_by"] },
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
    { name: "idx_compliance_attestations_attester", columns: ["attester_user_id"] },
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
    { name: "idx_files_uploaded_by", columns: ["uploaded_by"] },
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
    { name: "invoked_by", type: "UUID", references: USER_FK },
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
    { name: "idx_report_runs_invoked_by", columns: ["invoked_by"] },
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
    { name: "idx_tenant_credits_issued_by", columns: ["issued_by"] },
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
  indexes: [
    { name: "idx_tenant_ai_settings_updated_by", columns: ["updated_by"] },
  ],
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
    { name: "idx_deployments_triggered_by", columns: ["triggered_by"] },
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
    { name: "idx_api_keys_created_by", columns: ["created_by"] },
    { name: "idx_api_keys_revoked_by", columns: ["revoked_by"] },
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
    { name: "idx_webhook_endpoints_created_by", columns: ["created_by"] },
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
    {
      name: "response_body_sha256",
      type: "CHAR(64)",
      check:
        "response_body_sha256 IS NULL OR response_body_sha256 ~ '^[0-9a-f]{64}$'",
    },
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
    {
      name: "response_body_sha256",
      type: "CHAR(64)",
      check:
        "response_body_sha256 IS NULL OR response_body_sha256 ~ '^[0-9a-f]{64}$'",
    },
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
    { name: "idx_pack_versions_published_by", columns: ["published_by"] },
    { name: "idx_pack_versions_security_reviewer", columns: ["security_reviewer"] },
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
    { name: "idx_pack_installations_requested_by", columns: ["requested_by"] },
    { name: "idx_pack_installations_installed_by", columns: ["installed_by"] },
    { name: "idx_pack_installations_uninstalled_by", columns: ["uninstalled_by"] },
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
    { name: "idx_pack_reviews_author", columns: ["author_id"] },
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
    { name: "idx_import_sources_created_by", columns: ["created_by"] },
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
    { name: "idx_backfill_jobs_requested_by", columns: ["requested_by"] },
    { name: "idx_backfill_jobs_cancelled_by", columns: ["cancelled_by"] },
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
    { name: "idx_onboarding_runs_started_by", columns: ["started_by"] },
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
    { name: "idx_ml_consent_granted_by", columns: ["granted_by"] },
    { name: "idx_ml_consent_withdrawn_by", columns: ["withdrawn_by"] },
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
    {
      name: "frozen_sha256",
      type: "CHAR(64)",
      check:
        "frozen_sha256 IS NULL OR frozen_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "deprecated_reason", type: "TEXT" },
    { name: "purged_at", type: "TIMESTAMPTZ" },
    { name: "purged_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_ml_datasets_status", columns: ["status"] },
    { name: "idx_ml_datasets_purpose", columns: ["purpose"] },
    { name: "idx_ml_datasets_created_by", columns: ["created_by"] },
    { name: "idx_ml_datasets_frozen_by", columns: ["frozen_by"] },
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
    { name: "idx_ml_evalsets_frozen_by", columns: ["frozen_by"] },
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
    {
      name: "output_model_artifact_sha256",
      type: "CHAR(64)",
      check:
        "output_model_artifact_sha256 IS NULL OR output_model_artifact_sha256 ~ '^[0-9a-f]{64}$'",
    },
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
    { name: "idx_ml_training_runs_requested_by", columns: ["requested_by"] },
    { name: "idx_ml_training_runs_approved_by", columns: ["approved_by"] },
    { name: "idx_ml_training_runs_cancelled_by", columns: ["cancelled_by"] },
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
    { name: "idx_ml_evaluations_triggered_by", columns: ["triggered_by"] },
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
    { name: "idx_ml_models_promoted_by", columns: ["promoted_to_production_by"] },
    { name: "idx_ml_models_created_by", columns: ["created_by"] },
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
    { name: "idx_cost_budgets_created_by", columns: ["created_by"] },
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
    {
      name: "idx_tenant_unit_economics_loss_leader_approved_by",
      columns: ["loss_leader_approved_by"],
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
    { name: "idx_chargeback_generated_by", columns: ["generated_by"] },
    { name: "idx_chargeback_approved_by", columns: ["approved_by"] },
  ],
};

export const META_TENANT_LIFECYCLE_EVENTS: TableDefinition = {
  schema: "meta",
  name: "tenant_lifecycle_events",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "action",
      type: "TEXT",
      notNull: true,
      check:
        "action IN ('activate', 'suspend', 'restore', 'archive', 'schedule_deletion', 'cancel_deletion', 'execute_deletion')",
    },
    {
      name: "from_state",
      type: "TEXT",
      notNull: true,
      check:
        "from_state IN ('trial', 'active', 'past_due', 'suspended', 'archived', 'pending_deletion', 'deleted')",
    },
    {
      name: "to_state",
      type: "TEXT",
      notNull: true,
      check:
        "to_state IN ('trial', 'active', 'past_due', 'suspended', 'archived', 'pending_deletion', 'deleted')",
    },
    {
      name: "trigger",
      type: "TEXT",
      notNull: true,
      check:
        "trigger IN ('customer_request', 'billing_failure', 'compliance_directive', 'abuse_report', 'security_incident', 'scheduled_policy', 'platform_admin', 'support_escalation')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "actor_user_id", type: "UUID", references: USER_FK },
    { name: "actor_system_id", type: "TEXT" },
    { name: "reason", type: "TEXT", notNull: true },
    { name: "customer_notified_at", type: "TIMESTAMPTZ" },
    {
      name: "notification_channel",
      type: "TEXT",
      notNull: true,
      default: "'email'",
      check: "notification_channel IN ('email', 'in_app', 'phone', 'none')",
    },
    {
      name: "requires_four_eyes_approval",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "approved_by_user_id", type: "UUID", references: USER_FK },
    { name: "approved_at", type: "TIMESTAMPTZ" },
    { name: "related_incident_id", type: "TEXT" },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_tenant_lifecycle_events_tenant_occurred",
      columns: ["tenant_id", "occurred_at"],
    },
    { name: "idx_tenant_lifecycle_events_action", columns: ["action"] },
    { name: "idx_tenant_lifecycle_events_trigger", columns: ["trigger"] },
    { name: "idx_tenant_lifecycle_events_actor", columns: ["actor_user_id"] },
    { name: "idx_tenant_lifecycle_events_approved_by", columns: ["approved_by_user_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "tenant_lifecycle_events_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_GDPR_DELETION_REQUESTS: TableDefinition = {
  schema: "meta",
  name: "gdpr_deletion_requests",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "subject_identifier", type: "TEXT", notNull: true },
    {
      name: "legal_basis",
      type: "TEXT",
      notNull: true,
      check:
        "legal_basis IN ('article_17_right_to_erasure', 'article_21_objection_to_processing', 'data_subject_request', 'consent_withdrawn', 'contract_terminated', 'no_lawful_basis_remaining')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('submitted', 'verified', 'in_progress', 'completed', 'rejected', 'deferred')",
    },
    { name: "submitted_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "submitted_by", type: "TEXT", notNull: true },
    { name: "deadline_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "verification_method",
      type: "TEXT",
      check:
        "verification_method IS NULL OR verification_method IN ('email_link', 'phone_otp', 'in_app_re_authentication', 'government_id_check', 'in_person')",
    },
    { name: "verified_at", type: "TIMESTAMPTZ" },
    { name: "verified_by", type: "UUID", references: USER_FK },
    { name: "in_progress_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "completion_sha256",
      type: "CHAR(64)",
      check: "completion_sha256 IS NULL OR completion_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "rejected_at", type: "TIMESTAMPTZ" },
    { name: "rejected_reason", type: "TEXT" },
    { name: "deferred_until", type: "TIMESTAMPTZ" },
    { name: "deferral_reason", type: "TEXT" },
    {
      name: "retention_obligations",
      type: "JSONB",
      notNull: true,
      default: "'[\"none\"]'::jsonb",
    },
    {
      name: "retained_data_categories",
      type: "JSONB",
      notNull: true,
      default: "'[]'::jsonb",
    },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_gdpr_deletion_tenant_status",
      columns: ["tenant_id", "status"],
    },
    { name: "idx_gdpr_deletion_deadline", columns: ["deadline_at"] },
    { name: "idx_gdpr_deletion_legal_basis", columns: ["legal_basis"] },
    { name: "idx_gdpr_deletion_verified_by", columns: ["verified_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "gdpr_deletion_requests_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_TENANT_DATA_EXPORTS: TableDefinition = {
  schema: "meta",
  name: "tenant_data_exports",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "trigger",
      type: "TEXT",
      notNull: true,
      check:
        "trigger IN ('customer_request', 'pre_deletion_archive', 'scheduled_backup_certified', 'regulatory_subpoena', 'tenant_migration')",
    },
    { name: "requested_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "requested_by", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "format",
      type: "TEXT",
      notNull: true,
      check: "format IN ('json', 'ndjson', 'csv', 'parquet', 'sql_dump')",
    },
    {
      name: "includes_pii_categories",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "includes_phi_categories",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "encryption_key_fingerprint",
      type: "CHAR(64)",
      notNull: true,
      check: "encryption_key_fingerprint ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('queued', 'running', 'ready_for_download', 'delivered', 'failed', 'expired')",
    },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "ready_at", type: "TIMESTAMPTZ" },
    { name: "delivered_at", type: "TIMESTAMPTZ" },
    { name: "failed_at", type: "TIMESTAMPTZ" },
    { name: "failure_reason", type: "TEXT" },
    {
      name: "size_bytes",
      type: "BIGINT",
      check: "size_bytes IS NULL OR size_bytes >= 0",
    },
    {
      name: "row_count",
      type: "BIGINT",
      check: "row_count IS NULL OR row_count >= 0",
    },
    {
      name: "sha256",
      type: "CHAR(64)",
      check: "sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "storage_uri", type: "TEXT" },
    { name: "download_url_expires_at", type: "TIMESTAMPTZ" },
    {
      name: "download_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "download_count >= 0",
    },
    {
      name: "max_downloads",
      type: "INTEGER",
      notNull: true,
      default: "3",
      check: "max_downloads BETWEEN 1 AND 10",
    },
    { name: "purged_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_tenant_data_exports_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_tenant_data_exports_expires", columns: ["download_url_expires_at"] },
    { name: "idx_tenant_data_exports_requested_by", columns: ["requested_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "tenant_data_exports_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_TENANT_TOMBSTONES: TableDefinition = {
  schema: "meta",
  name: "tenant_tombstones",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "tombstone_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "tenant_tombstones_tombstone_id_key" },
      check: "tombstone_id ~ '^tomb_[A-Za-z0-9_-]{12,40}$'",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('tenant_deletion', 'user_deletion', 'data_subject_erasure', 'scheduled_purge', 'abandoned_export_purge')",
    },
    { name: "tenant_id", type: "UUID", notNull: true },
    { name: "subject_identifier", type: "TEXT" },
    { name: "related_deletion_request_id", type: "UUID" },
    { name: "deleted_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "executed_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "approved_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "scope", type: "JSONB", notNull: true },
    {
      name: "content_manifest_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "content_manifest_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "proof_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "proof_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "anchors", type: "JSONB", notNull: true },
    { name: "retained_reason", type: "TEXT" },
    { name: "retained_data_reference", type: "TEXT" },
    { name: "invalidation_of_prior_tombstone_id", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_tenant_tombstones_tenant", columns: ["tenant_id"] },
    { name: "idx_tenant_tombstones_kind", columns: ["kind"] },
    { name: "idx_tenant_tombstones_deleted_at", columns: ["deleted_at"] },
    { name: "idx_tenant_tombstones_executed_by", columns: ["executed_by"] },
    { name: "idx_tenant_tombstones_approved_by", columns: ["approved_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "tenant_tombstones_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_INCIDENTS: TableDefinition = {
  schema: "meta",
  name: "incidents",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "incident_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "incidents_incident_id_key" },
      check: "incident_id ~ '^INC-[0-9]{4}-[0-9]{4,8}$'",
    },
    { name: "title", type: "TEXT", notNull: true },
    {
      name: "severity",
      type: "TEXT",
      notNull: true,
      check: "severity IN ('sev1', 'sev2', 'sev3', 'sev4', 'sev5')",
    },
    {
      name: "category",
      type: "TEXT",
      notNull: true,
      check:
        "category IN ('availability', 'performance', 'data_integrity', 'security', 'compliance', 'billing', 'dependency_failure', 'human_error', 'scheduled_change_impact')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('declared', 'triaged', 'mitigating', 'mitigated', 'resolved', 'postmortem_pending', 'closed', 'cancelled')",
    },
    { name: "affected_tenant_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "affected_regions", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "publicly_visible", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "declared_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "declared_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "acked_at", type: "TIMESTAMPTZ" },
    { name: "mitigated_at", type: "TIMESTAMPTZ" },
    { name: "resolved_at", type: "TIMESTAMPTZ" },
    { name: "closed_at", type: "TIMESTAMPTZ" },
    { name: "cancelled_at", type: "TIMESTAMPTZ" },
    { name: "cancelled_reason", type: "TEXT" },
    { name: "root_cause", type: "TEXT" },
    { name: "customer_impact_summary", type: "TEXT" },
    { name: "role_assignments", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "timeline", type: "JSONB", notNull: true },
    { name: "runbook_execution_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "related_deployment_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "security_incident", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "breach_data_classes", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "postmortem_id", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_incidents_severity", columns: ["severity"] },
    { name: "idx_incidents_status", columns: ["status"] },
    { name: "idx_incidents_declared_at", columns: ["declared_at"] },
    { name: "idx_incidents_security", columns: ["security_incident"] },
    { name: "idx_incidents_declared_by", columns: ["declared_by"] },
  ],
};

export const META_INCIDENT_RUNBOOK_EXECUTIONS: TableDefinition = {
  schema: "meta",
  name: "incident_runbook_executions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "incident_id",
      type: "TEXT",
      notNull: true,
      check: "incident_id ~ '^INC-[0-9]{4}-[0-9]{4,8}$'",
    },
    {
      name: "runbook_id",
      type: "TEXT",
      notNull: true,
      check: "runbook_id ~ '^RB-[0-9]{4}$'",
    },
    { name: "runbook_version", type: "TEXT", notNull: true },
    { name: "invoked_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "invoked_by", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'aborted')",
    },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "duration_seconds",
      type: "INTEGER",
      check: "duration_seconds IS NULL OR duration_seconds >= 0",
    },
    { name: "steps", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "aborted_at", type: "TIMESTAMPTZ" },
    { name: "aborted_reason", type: "TEXT" },
    {
      name: "page_oncall_triggered",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "incident_commander_approval_user_id", type: "UUID", references: USER_FK },
    { name: "artifact_storage_uri", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_incident_runbook_executions_incident",
      columns: ["incident_id", "invoked_at"],
    },
    { name: "idx_incident_runbook_executions_runbook", columns: ["runbook_id"] },
    { name: "idx_incident_runbook_executions_status", columns: ["status"] },
    { name: "idx_incident_runbook_executions_invoked_by", columns: ["invoked_by"] },
    {
      name: "idx_incident_runbook_executions_commander_approval",
      columns: ["incident_commander_approval_user_id"],
    },
  ],
};

export const META_INCIDENT_POSTMORTEMS: TableDefinition = {
  schema: "meta",
  name: "incident_postmortems",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "postmortem_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "incident_postmortems_postmortem_id_key" },
      check: "postmortem_id ~ '^PM-[0-9]{4}-[0-9]{4,8}$'",
    },
    {
      name: "incident_id",
      type: "TEXT",
      notNull: true,
      check: "incident_id ~ '^INC-[0-9]{4}-[0-9]{4,8}$'",
    },
    { name: "title", type: "TEXT", notNull: true },
    {
      name: "severity",
      type: "TEXT",
      notNull: true,
      check: "severity IN ('sev1', 'sev2', 'sev3', 'sev4', 'sev5')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('drafting', 'review', 'published', 'amended')",
    },
    { name: "summary", type: "TEXT", notNull: true },
    { name: "root_cause", type: "TEXT", notNull: true },
    { name: "contributing_factors", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "detection", type: "TEXT", notNull: true },
    { name: "response", type: "TEXT", notNull: true },
    { name: "impact", type: "TEXT", notNull: true },
    { name: "what_went_well", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "what_went_wrong", type: "JSONB", notNull: true },
    { name: "lessons_learned", type: "JSONB", notNull: true },
    { name: "action_items", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "timeline_summary", type: "TEXT", notNull: true },
    { name: "author_user_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "reviewers", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "published_at", type: "TIMESTAMPTZ" },
    { name: "amended_at", type: "TIMESTAMPTZ" },
    { name: "blameless_attested", type: "BOOLEAN", notNull: true, default: "true" },
    {
      name: "confidentiality_class",
      type: "TEXT",
      notNull: true,
      check:
        "confidentiality_class IN ('public', 'customer_facing', 'internal_only', 'security_restricted')",
    },
    { name: "storage_uri", type: "TEXT" },
    {
      name: "storage_sha256",
      type: "CHAR(64)",
      check:
        "storage_sha256 IS NULL OR storage_sha256 ~ '^[0-9a-f]{64}$'",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_incident_postmortems_status", columns: ["status"] },
    { name: "idx_incident_postmortems_incident", columns: ["incident_id"] },
    { name: "idx_incident_postmortems_severity", columns: ["severity"] },
    { name: "idx_incident_postmortems_author", columns: ["author_user_id"] },
  ],
};

export const META_INCIDENT_COMMUNICATIONS: TableDefinition = {
  schema: "meta",
  name: "incident_communications",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "incident_id",
      type: "TEXT",
      notNull: true,
      check: "incident_id ~ '^INC-[0-9]{4}-[0-9]{4,8}$'",
    },
    {
      name: "audience",
      type: "TEXT",
      notNull: true,
      check:
        "audience IN ('status_page_public', 'affected_tenants', 'all_customers', 'internal_eng', 'internal_exec', 'regulators', 'law_enforcement')",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('investigating', 'identified', 'monitoring', 'resolved', 'postmortem_published', 'scheduled_maintenance', 'breach_notification')",
    },
    {
      name: "status_page_level",
      type: "TEXT",
      check:
        "status_page_level IS NULL OR status_page_level IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'under_maintenance')",
    },
    { name: "title", type: "TEXT", notNull: true },
    { name: "body", type: "TEXT", notNull: true },
    { name: "published_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "published_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "languages", type: "JSONB", notNull: true, default: "'[\"en\"]'::jsonb" },
    {
      name: "requires_legal_review",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "legal_reviewed_by", type: "UUID", references: USER_FK },
    { name: "legal_reviewed_at", type: "TIMESTAMPTZ" },
    {
      name: "requires_executive_approval",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "executive_approved_by", type: "UUID", references: USER_FK },
    { name: "executive_approved_at", type: "TIMESTAMPTZ" },
    { name: "delivery_channels", type: "JSONB", notNull: true },
    {
      name: "recipient_count",
      type: "INTEGER",
      notNull: true,
      check: "recipient_count >= 0",
    },
    {
      name: "bounces_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "bounces_count >= 0",
    },
    { name: "supersedes_id", type: "UUID" },
    { name: "retracted_at", type: "TIMESTAMPTZ" },
    { name: "retracted_reason", type: "TEXT" },
    { name: "breach_notification_deadline_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_incident_communications_incident_published",
      columns: ["incident_id", "published_at"],
    },
    { name: "idx_incident_communications_audience", columns: ["audience"] },
    { name: "idx_incident_communications_kind", columns: ["kind"] },
    { name: "idx_incident_communications_published_by", columns: ["published_by"] },
    { name: "idx_incident_communications_legal_reviewed_by", columns: ["legal_reviewed_by"] },
    { name: "idx_incident_communications_exec_approved_by", columns: ["executive_approved_by"] },
  ],
};

export const META_FORENSIC_EVIDENCE: TableDefinition = {
  schema: "meta",
  name: "forensic_evidence",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "evidence_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "forensic_evidence_evidence_id_key" },
      check: "evidence_id ~ '^EV-[0-9]{4}-[0-9]{4,8}$'",
    },
    { name: "case_id", type: "TEXT", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('log_export', 'database_snapshot', 'file_artifact', 'network_capture', 'memory_dump', 'configuration_snapshot', 'screenshot', 'video_recording', 'witness_statement', 'expert_report')",
    },
    {
      name: "sensitivity",
      type: "TEXT",
      notNull: true,
      check:
        "sensitivity IN ('public', 'internal', 'confidential', 'phi_protected', 'attorney_client_privileged', 'national_security')",
    },
    {
      name: "provenance",
      type: "TEXT",
      notNull: true,
      check:
        "provenance IN ('automated_collection', 'human_collection', 'forensic_imaging', 'subpoena_response', 'third_party_provided')",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    { name: "source_system", type: "TEXT", notNull: true },
    { name: "collected_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "collected_by", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "size_bytes",
      type: "BIGINT",
      notNull: true,
      check: "size_bytes >= 0",
    },
    {
      name: "sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "storage_uri", type: "TEXT", notNull: true },
    {
      name: "encryption_key_fingerprint",
      type: "CHAR(64)",
      notNull: true,
      check: "encryption_key_fingerprint ~ '^[0-9a-f]{64}$'",
    },
    { name: "sealed_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "sealed_by", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "content_redacted_sha256",
      type: "CHAR(64)",
      check:
        "content_redacted_sha256 IS NULL OR content_redacted_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "related_incident_id", type: "TEXT" },
    { name: "related_tenant_id", type: "UUID" },
    { name: "retention_until", type: "TIMESTAMPTZ", notNull: true },
    { name: "legal_hold_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "destroyed_at", type: "TIMESTAMPTZ" },
    { name: "destroyed_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_forensic_evidence_case", columns: ["case_id"] },
    { name: "idx_forensic_evidence_kind", columns: ["kind"] },
    { name: "idx_forensic_evidence_retention", columns: ["retention_until"] },
    { name: "idx_forensic_evidence_related_incident", columns: ["related_incident_id"] },
    { name: "idx_forensic_evidence_collected_by", columns: ["collected_by"] },
    { name: "idx_forensic_evidence_sealed_by", columns: ["sealed_by"] },
  ],
};

export const META_CHAIN_OF_CUSTODY: TableDefinition = {
  schema: "meta",
  name: "chain_of_custody",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "custody_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "chain_of_custody_custody_id_key" },
      check: "custody_id ~ '^COC-[0-9]{4}-[0-9]{4,8}$'",
    },
    {
      name: "evidence_id",
      type: "TEXT",
      notNull: true,
      check: "evidence_id ~ '^EV-[0-9]{4}-[0-9]{4,8}$'",
    },
    {
      name: "action",
      type: "TEXT",
      notNull: true,
      check:
        "action IN ('collected', 'transferred', 'accessed', 'analyzed', 'duplicated', 'redacted', 'exported_for_review', 'returned', 'destroyed')",
    },
    {
      name: "purpose",
      type: "TEXT",
      notNull: true,
      check:
        "purpose IN ('incident_investigation', 'regulatory_inquiry', 'litigation_preservation', 'internal_audit', 'security_research', 'law_enforcement_request')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "from_custodian_id", type: "UUID", references: USER_FK },
    { name: "to_custodian_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "witness_id", type: "UUID", references: USER_FK },
    {
      name: "expected_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "expected_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "verified_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "verified_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "seal_number", type: "TEXT" },
    { name: "location", type: "TEXT", notNull: true },
    { name: "notes", type: "TEXT" },
    { name: "signature", type: "TEXT", notNull: true },
    {
      name: "signing_key_fingerprint",
      type: "CHAR(64)",
      notNull: true,
      check: "signing_key_fingerprint ~ '^[0-9a-f]{64}$'",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_chain_of_custody_evidence_occurred",
      columns: ["evidence_id", "occurred_at"],
    },
    { name: "idx_chain_of_custody_action", columns: ["action"] },
    { name: "idx_chain_of_custody_from_custodian", columns: ["from_custodian_id"] },
    { name: "idx_chain_of_custody_to_custodian", columns: ["to_custodian_id"] },
    { name: "idx_chain_of_custody_witness", columns: ["witness_id"] },
  ],
};

export const META_LEGAL_HOLDS: TableDefinition = {
  schema: "meta",
  name: "legal_holds",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "hold_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "legal_holds_hold_id_key" },
      check: "hold_id ~ '^LH-[0-9]{4}-[0-9]{4,8}$'",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('litigation', 'regulatory_inquiry', 'internal_investigation', 'tax_audit', 'merger_acquisition_diligence', 'subpoena', 'preservation_letter')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'active', 'suspended', 'released', 'expired')",
    },
    { name: "title", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    { name: "matter_reference", type: "TEXT", notNull: true },
    { name: "legal_counsel_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "scope", type: "JSONB", notNull: true },
    { name: "issued_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "issued_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "activated_at", type: "TIMESTAMPTZ" },
    { name: "suspended_at", type: "TIMESTAMPTZ" },
    { name: "suspended_reason", type: "TEXT" },
    { name: "released_at", type: "TIMESTAMPTZ" },
    { name: "released_by", type: "UUID", references: USER_FK },
    { name: "released_reason", type: "TEXT" },
    { name: "expires_at", type: "TIMESTAMPTZ" },
    {
      name: "blocks_automatic_deletion",
      type: "BOOLEAN",
      notNull: true,
      default: "true",
    },
    {
      name: "affected_custodian_count",
      type: "INTEGER",
      notNull: true,
      check: "affected_custodian_count >= 0",
    },
    {
      name: "custodian_notifications_sent",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "custodian_acknowledgement_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "custodian_acknowledgement_count >= 0",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_legal_holds_status", columns: ["status"] },
    { name: "idx_legal_holds_kind", columns: ["kind"] },
    { name: "idx_legal_holds_expires_at", columns: ["expires_at"] },
    { name: "idx_legal_holds_counsel", columns: ["legal_counsel_id"] },
    { name: "idx_legal_holds_issued_by", columns: ["issued_by"] },
    { name: "idx_legal_holds_released_by", columns: ["released_by"] },
  ],
};

export const META_EDISCOVERY_REQUESTS: TableDefinition = {
  schema: "meta",
  name: "ediscovery_requests",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "ediscovery_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "ediscovery_requests_ediscovery_id_key" },
      check: "ediscovery_id ~ '^ED-[0-9]{4}-[0-9]{4,8}$'",
    },
    { name: "matter_reference", type: "TEXT", notNull: true },
    { name: "requesting_party", type: "TEXT", notNull: true },
    { name: "legal_counsel_id", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('requested', 'scoped', 'running', 'producing', 'delivered', 'objected', 'complete', 'withdrawn')",
    },
    { name: "related_legal_hold_ids", type: "JSONB", notNull: true },
    { name: "scope", type: "JSONB", notNull: true },
    {
      name: "production_format",
      type: "TEXT",
      notNull: true,
      check:
        "production_format IN ('native', 'pdf_with_load_file', 'tiff_with_load_file', 'csv', 'json')",
    },
    { name: "requested_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "requested_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "scoped_at", type: "TIMESTAMPTZ" },
    { name: "scoped_by", type: "UUID", references: USER_FK },
    { name: "run_started_at", type: "TIMESTAMPTZ" },
    { name: "delivered_at", type: "TIMESTAMPTZ" },
    { name: "complete_at", type: "TIMESTAMPTZ" },
    { name: "objection_reason", type: "TEXT" },
    { name: "withdrawn_reason", type: "TEXT" },
    {
      name: "estimated_document_count",
      type: "BIGINT",
      check: "estimated_document_count IS NULL OR estimated_document_count >= 0",
    },
    {
      name: "produced_document_count",
      type: "BIGINT",
      check: "produced_document_count IS NULL OR produced_document_count >= 0",
    },
    {
      name: "produced_size_bytes",
      type: "BIGINT",
      check: "produced_size_bytes IS NULL OR produced_size_bytes >= 0",
    },
    {
      name: "production_sha256",
      type: "CHAR(64)",
      check: "production_sha256 IS NULL OR production_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "production_storage_uri", type: "TEXT" },
    {
      name: "privileged_exclusion_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "privileged_exclusion_count >= 0",
    },
    { name: "deadline_at", type: "TIMESTAMPTZ", notNull: true },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_ediscovery_status", columns: ["status"] },
    { name: "idx_ediscovery_deadline", columns: ["deadline_at"] },
    { name: "idx_ediscovery_matter", columns: ["matter_reference"] },
    { name: "idx_ediscovery_counsel", columns: ["legal_counsel_id"] },
    { name: "idx_ediscovery_requested_by", columns: ["requested_by"] },
    { name: "idx_ediscovery_scoped_by", columns: ["scoped_by"] },
  ],
};

export const META_AA_TOPOLOGY: TableDefinition = {
  schema: "meta",
  name: "aa_topology",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "topology_id", type: "TEXT", notNull: true, unique: { constraintName: "aa_topology_topology_id_key" } },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('single_primary', 'active_passive', 'active_active', 'multi_master_partitioned')",
    },
    {
      name: "partition_strategy",
      type: "TEXT",
      notNull: true,
      check:
        "partition_strategy IN ('tenant_hash', 'tenant_residency', 'entity_class', 'row_hash', 'geographic')",
    },
    { name: "participations", type: "JSONB", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    { name: "activated_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "activated_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "superseded_at", type: "TIMESTAMPTZ" },
    { name: "superseded_by", type: "UUID", references: USER_FK },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_aa_topology_kind", columns: ["kind"] },
    { name: "idx_aa_topology_activated_at", columns: ["activated_at"] },
    { name: "idx_aa_topology_activated_by", columns: ["activated_by"] },
    { name: "idx_aa_topology_superseded_by", columns: ["superseded_by"] },
  ],
};

export const META_AA_CONFLICTS: TableDefinition = {
  schema: "meta",
  name: "aa_conflicts",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "conflict_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "aa_conflicts_conflict_id_key" },
      check: "conflict_id ~ '^CFL-[0-9]{4}-[0-9]{4,8}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "entity_class", type: "TEXT", notNull: true },
    { name: "entity_id", type: "TEXT", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('concurrent_write', 'delete_update_race', 'constraint_violation_after_merge', 'ordering_ambiguity', 'schema_drift', 'tenant_residency_violation')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('detected', 'auto_resolving', 'awaiting_review', 'resolved', 'escalated')",
    },
    { name: "detected_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "conflicting_writes", type: "JSONB", notNull: true },
    {
      name: "chosen_strategy",
      type: "TEXT",
      check:
        "chosen_strategy IS NULL OR chosen_strategy IN ('last_writer_wins', 'first_writer_wins', 'vector_clock_merge', 'crdt_merge', 'application_merge', 'manual_review', 'rollback')",
    },
    { name: "chosen_strategy_at", type: "TIMESTAMPTZ" },
    { name: "chosen_strategy_by", type: "UUID", references: USER_FK },
    { name: "resolved_at", type: "TIMESTAMPTZ" },
    { name: "resolved_by", type: "UUID", references: USER_FK },
    {
      name: "resolution_payload_sha256",
      type: "CHAR(64)",
      check: "resolution_payload_sha256 IS NULL OR resolution_payload_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "resolution_notes", type: "TEXT" },
    { name: "requires_audit", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "audit_recorded_at", type: "TIMESTAMPTZ" },
    { name: "escalated_to", type: "TEXT" },
    { name: "escalation_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_aa_conflicts_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_aa_conflicts_entity", columns: ["entity_class", "entity_id"] },
    { name: "idx_aa_conflicts_detected_at", columns: ["detected_at"] },
    { name: "idx_aa_conflicts_kind", columns: ["kind"] },
    { name: "idx_aa_conflicts_chosen_strategy_by", columns: ["chosen_strategy_by"] },
    { name: "idx_aa_conflicts_resolved_by", columns: ["resolved_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "aa_conflicts_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_AA_SPLIT_BRAIN_EVENTS: TableDefinition = {
  schema: "meta",
  name: "aa_split_brain_events",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "event_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "aa_split_brain_events_event_id_key" },
      check: "event_id ~ '^SB-[0-9]{4}-[0-9]{4,8}$'",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('network_partition', 'asymmetric_partition', 'membership_disagreement', 'clock_skew', 'replication_lag_critical')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('detected', 'isolating', 'healing', 'healed', 'permanent_partition')",
    },
    { name: "detected_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "detected_by", type: "TEXT", notNull: true },
    { name: "detector_evidence", type: "TEXT", notNull: true },
    { name: "partition_groups", type: "JSONB", notNull: true },
    { name: "isolated_at", type: "TIMESTAMPTZ" },
    { name: "healing_started_at", type: "TIMESTAMPTZ" },
    { name: "healed_at", type: "TIMESTAMPTZ" },
    {
      name: "healing_strategy",
      type: "TEXT",
      check:
        "healing_strategy IS NULL OR healing_strategy IN ('auto_merge_concurrent', 'manual_evidence_review', 'rollback_minority', 'freeze_and_audit', 'prefer_quorum_side')",
    },
    { name: "conflict_record_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "permanent_partition_at", type: "TIMESTAMPTZ" },
    { name: "permanent_partition_reason", type: "TEXT" },
    {
      name: "requires_incident_response",
      type: "BOOLEAN",
      notNull: true,
      default: "true",
    },
    { name: "incident_record_id", type: "TEXT" },
    {
      name: "duration_seconds",
      type: "INTEGER",
      check: "duration_seconds IS NULL OR duration_seconds >= 0",
    },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_aa_split_brain_status", columns: ["status"] },
    { name: "idx_aa_split_brain_detected_at", columns: ["detected_at"] },
    { name: "idx_aa_split_brain_kind", columns: ["kind"] },
  ],
};

export const META_SDK_CLIENT_RELEASES: TableDefinition = {
  schema: "meta",
  name: "sdk_client_releases",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "release_id", type: "TEXT", notNull: true, unique: { constraintName: "sdk_client_releases_release_id_key" } },
    {
      name: "language",
      type: "TEXT",
      notNull: true,
      check:
        "language IN ('typescript', 'python', 'go', 'java', 'csharp', 'ruby', 'rust', 'php', 'swift', 'kotlin')",
    },
    { name: "version", type: "TEXT", notNull: true },
    { name: "api_version", type: "TEXT", notNull: true },
    {
      name: "channel",
      type: "TEXT",
      notNull: true,
      check: "channel IN ('stable', 'beta', 'rc', 'nightly')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('draft', 'in_review', 'published', 'deprecated', 'yanked')",
    },
    {
      name: "artifact_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "artifact_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "artifact_size_bytes",
      type: "BIGINT",
      notNull: true,
      check: "artifact_size_bytes > 0",
    },
    { name: "registry_package_uri", type: "TEXT", notNull: true },
    { name: "generation_run_id", type: "TEXT", notNull: true },
    { name: "published_at", type: "TIMESTAMPTZ" },
    { name: "published_by", type: "UUID", references: USER_FK },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "deprecated_reason", type: "TEXT" },
    { name: "deprecated_replaced_by", type: "TEXT" },
    { name: "yanked_at", type: "TIMESTAMPTZ" },
    { name: "yanked_reason", type: "TEXT" },
    { name: "security_advisories", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "changelog_url", type: "TEXT", notNull: true },
    {
      name: "download_count",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "download_count >= 0",
    },
    {
      name: "breaking_changes",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "min_language_runtime_version", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "sdk_client_releases_lang_version_key",
      columns: ["language", "version"],
    },
  ],
  indexes: [
    { name: "idx_sdk_client_releases_language", columns: ["language"] },
    { name: "idx_sdk_client_releases_status", columns: ["status"] },
    { name: "idx_sdk_client_releases_api_version", columns: ["api_version"] },
    { name: "idx_sdk_client_releases_channel", columns: ["channel"] },
    { name: "idx_sdk_client_releases_published_by", columns: ["published_by"] },
  ],
};

export const META_SDK_CLIENT_INSTALLATIONS: TableDefinition = {
  schema: "meta",
  name: "sdk_client_installations",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "language",
      type: "TEXT",
      notNull: true,
      check:
        "language IN ('typescript', 'python', 'go', 'java', 'csharp', 'ruby', 'rust', 'php', 'swift', 'kotlin')",
    },
    { name: "client_version", type: "TEXT", notNull: true },
    { name: "first_observed_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "last_observed_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    {
      name: "request_count_30d",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "request_count_30d >= 0",
    },
    { name: "user_agent_sample", type: "TEXT" },
    {
      name: "upgrade_nag_status",
      type: "TEXT",
      notNull: true,
      default: "'none'",
      check:
        "upgrade_nag_status IN ('none', 'soft_warning', 'hard_warning', 'forced_upgrade_required')",
    },
    { name: "last_nag_sent_at", type: "TIMESTAMPTZ" },
    { name: "acknowledged_at", type: "TIMESTAMPTZ" },
    { name: "acknowledged_by", type: "UUID", references: USER_FK },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "sdk_client_installations_tenant_lang_version_key",
      columns: ["tenant_id", "language", "client_version"],
    },
  ],
  indexes: [
    {
      name: "idx_sdk_client_installations_tenant",
      columns: ["tenant_id"],
    },
    {
      name: "idx_sdk_client_installations_language_version",
      columns: ["language", "client_version"],
    },
    {
      name: "idx_sdk_client_installations_nag",
      columns: ["upgrade_nag_status"],
    },
    {
      name: "idx_sdk_client_installations_acknowledged_by",
      columns: ["acknowledged_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "sdk_client_installations_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_SSO_PROVIDERS: TableDefinition = {
  schema: "meta",
  name: "sso_providers",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "provider_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "sso_providers_provider_id_key" },
      check: "provider_id ~ '^sso_[a-z0-9]{8,32}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "vendor",
      type: "TEXT",
      notNull: true,
      check:
        "vendor IN ('okta', 'auth0', 'azure_ad', 'google_workspace', 'jumpcloud', 'onelogin', 'ping_federate', 'adfs', 'keycloak', 'custom')",
    },
    {
      name: "protocol",
      type: "TEXT",
      notNull: true,
      check: "protocol IN ('saml', 'oidc')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('draft', 'testing', 'active', 'suspended', 'archived')",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT" },
    { name: "config", type: "JSONB", notNull: true },
    { name: "claim_mappings", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "group_sync_rules", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "jit_policy", type: "JSONB", notNull: true },
    {
      name: "signing_certificate_sha256",
      type: "CHAR(64)",
      check:
        "signing_certificate_sha256 IS NULL OR signing_certificate_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "client_secret_sha256",
      type: "CHAR(64)",
      check:
        "client_secret_sha256 IS NULL OR client_secret_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "allow_weak_signatures",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "last_tested_at", type: "TIMESTAMPTZ" },
    {
      name: "last_test_outcome",
      type: "TEXT",
      notNull: true,
      default: "'untested'",
      check:
        "last_test_outcome IN ('untested', 'metadata_ok', 'metadata_failed', 'round_trip_ok', 'round_trip_failed')",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_sso_providers_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_sso_providers_protocol", columns: ["protocol"] },
    { name: "idx_sso_providers_vendor", columns: ["vendor"] },
    { name: "idx_sso_providers_created_by", columns: ["created_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "sso_providers_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_SSO_LOGINS: TableDefinition = {
  schema: "meta",
  name: "sso_logins",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "provider_id", type: "UUID", notNull: true, references: { schema: "meta", table: "sso_providers", column: "id", onDelete: "RESTRICT" } },
    { name: "request_id", type: "TEXT", notNull: true },
    { name: "initiated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "latency_ms",
      type: "INTEGER",
      check: "latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000",
    },
    {
      name: "outcome",
      type: "TEXT",
      notNull: true,
      check:
        "outcome IN ('success', 'mfa_required', 'mfa_failed', 'password_expired', 'account_locked', 'idp_unreachable', 'attribute_invalid', 'denied_by_policy')",
    },
    {
      name: "initiation",
      type: "TEXT",
      notNull: true,
      check: "initiation IN ('sp_initiated', 'idp_initiated', 'scim_invoked')",
    },
    { name: "federated_subject_id", type: "TEXT" },
    { name: "requested_name_id_format", type: "TEXT" },
    { name: "principal_id", type: "UUID", references: USER_FK },
    {
      name: "mfa_factor",
      type: "TEXT",
      check:
        "mfa_factor IS NULL OR mfa_factor IN ('totp', 'webauthn', 'push_notification', 'sms', 'security_question')",
    },
    { name: "mfa_completed_at", type: "TIMESTAMPTZ" },
    {
      name: "failure_category",
      type: "TEXT",
      check:
        "failure_category IS NULL OR failure_category IN ('network', 'credential', 'mfa', 'policy', 'attribute', 'account')",
    },
    { name: "failure_reason", type: "TEXT" },
    { name: "ip_address", type: "INET", notNull: true },
    { name: "user_agent", type: "TEXT", notNull: true },
    {
      name: "as_number",
      type: "BIGINT",
      check: "as_number IS NULL OR as_number BETWEEN 0 AND 4294967295",
    },
    {
      name: "geo_country",
      type: "CHAR(2)",
      check: "geo_country IS NULL OR geo_country ~ '^[A-Z]{2}$'",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_sso_logins_tenant_initiated", columns: ["tenant_id", "initiated_at"] },
    { name: "idx_sso_logins_outcome", columns: ["tenant_id", "outcome"] },
    { name: "idx_sso_logins_provider", columns: ["provider_id"] },
    { name: "idx_sso_logins_subject", columns: ["federated_subject_id"] },
    { name: "idx_sso_logins_principal", columns: ["principal_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "sso_logins_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_SSO_SESSIONS: TableDefinition = {
  schema: "meta",
  name: "sso_sessions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "session_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "sso_sessions_session_id_key" },
      check: "session_id ~ '^sess_[A-Za-z0-9_-]{12,64}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "user_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "provider_id", type: "UUID", notNull: true, references: { schema: "meta", table: "sso_providers", column: "id", onDelete: "RESTRICT" } },
    { name: "federated_subject_id", type: "TEXT", notNull: true },
    {
      name: "binding",
      type: "TEXT",
      notNull: true,
      check:
        "binding IN ('cookie', 'jwt_bearer', 'opaque_token', 'ldap_kerberos')",
    },
    { name: "idp_session_index", type: "TEXT" },
    {
      name: "idp_refresh_token_sha256",
      type: "CHAR(64)",
      check:
        "idp_refresh_token_sha256 IS NULL OR idp_refresh_token_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "last_activity_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "expires_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "absolute_expires_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check: "status IN ('active', 'expired', 'revoked', 'logged_out')",
    },
    { name: "terminated_at", type: "TIMESTAMPTZ" },
    {
      name: "termination_kind",
      type: "TEXT",
      check:
        "termination_kind IS NULL OR termination_kind IN ('sp_initiated', 'idp_initiated', 'idle_timeout', 'absolute_timeout', 'admin_revoke', 'policy_violation', 'mfa_step_up_failed')",
    },
    { name: "termination_reason", type: "TEXT" },
    { name: "mfa_satisfied_at", type: "TIMESTAMPTZ" },
    { name: "ip_address", type: "INET", notNull: true },
    { name: "user_agent", type: "TEXT", notNull: true },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_sso_sessions_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_sso_sessions_user", columns: ["user_id"] },
    { name: "idx_sso_sessions_provider", columns: ["provider_id"] },
    { name: "idx_sso_sessions_expires", columns: ["expires_at"] },
    { name: "idx_sso_sessions_subject", columns: ["federated_subject_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "sso_sessions_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_SCIM_CLIENTS: TableDefinition = {
  schema: "meta",
  name: "scim_clients",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "provider_id", type: "UUID", notNull: true, references: { schema: "meta", table: "sso_providers", column: "id", onDelete: "RESTRICT" } },
    {
      name: "client_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "scim_clients_client_id_key" },
      check: "client_id ~ '^scim_[A-Za-z0-9_-]{8,40}$'",
    },
    {
      name: "bearer_token_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "bearer_token_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "label", type: "TEXT", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      default: "'active'",
      check: "status IN ('active', 'disabled', 'revoked')",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "last_used_at", type: "TIMESTAMPTZ" },
    { name: "revoked_at", type: "TIMESTAMPTZ" },
    { name: "revoked_by", type: "UUID", references: USER_FK },
    { name: "revoked_reason", type: "TEXT" },
    { name: "allowed_ip_ranges", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_scim_clients_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_scim_clients_provider", columns: ["provider_id"] },
    { name: "idx_scim_clients_created_by", columns: ["created_by"] },
    { name: "idx_scim_clients_revoked_by", columns: ["revoked_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "scim_clients_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_SCIM_PROVISIONING: TableDefinition = {
  schema: "meta",
  name: "scim_provisioning",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "scim_client_id", type: "UUID", notNull: true, references: { schema: "meta", table: "scim_clients", column: "id", onDelete: "RESTRICT" } },
    { name: "provider_id", type: "UUID", notNull: true, references: { schema: "meta", table: "sso_providers", column: "id", onDelete: "RESTRICT" } },
    { name: "request_id", type: "TEXT", notNull: true },
    {
      name: "resource_type",
      type: "TEXT",
      notNull: true,
      check:
        "resource_type IN ('User', 'Group', 'EnterpriseUser', 'Role', 'Entitlement')",
    },
    {
      name: "operation",
      type: "TEXT",
      notNull: true,
      check:
        "operation IN ('create', 'replace', 'patch', 'delete', 'get', 'list', 'search')",
    },
    { name: "target_resource_id", type: "TEXT" },
    { name: "requested_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "completed_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "latency_ms",
      type: "INTEGER",
      notNull: true,
      check: "latency_ms BETWEEN 0 AND 600000",
    },
    {
      name: "outcome",
      type: "TEXT",
      notNull: true,
      check:
        "outcome IN ('success', 'created', 'conflict', 'invalid_filter', 'invalid_path', 'invalid_value', 'not_found', 'forbidden', 'rate_limited', 'schema_violation')",
    },
    {
      name: "bytes_request",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "bytes_request >= 0",
    },
    {
      name: "bytes_response",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "bytes_response >= 0",
    },
    { name: "error_message", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_scim_provisioning_tenant_requested",
      columns: ["tenant_id", "requested_at"],
    },
    { name: "idx_scim_provisioning_outcome", columns: ["outcome"] },
    { name: "idx_scim_provisioning_resource_type", columns: ["resource_type"] },
    { name: "idx_scim_provisioning_client", columns: ["scim_client_id"] },
    { name: "idx_scim_provisioning_provider", columns: ["provider_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "scim_provisioning_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_NOTIFICATION_TEMPLATES: TableDefinition = {
  schema: "meta",
  name: "notification_templates",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "ntpl_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "notification_templates_ntpl_id_key" },
      check: "ntpl_id ~ '^ntpl_[a-z0-9]{8,32}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "template_id",
      type: "TEXT",
      notNull: true,
      check: "template_id ~ '^[a-z][a-z0-9_.-]*$'",
    },
    {
      name: "version",
      type: "TEXT",
      notNull: true,
      check: "version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
    },
    {
      name: "locale",
      type: "TEXT",
      notNull: true,
      check: "locale ~ '^[a-z]{2}(-[A-Z]{2})?$'",
    },
    {
      name: "channel",
      type: "TEXT",
      notNull: true,
      check:
        "channel IN ('email', 'sms', 'push_mobile', 'in_app', 'webhook', 'voice_call')",
    },
    {
      name: "category",
      type: "TEXT",
      notNull: true,
      check:
        "category IN ('transactional', 'security_alert', 'system_notice', 'operational_digest', 'marketing')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'in_review', 'approved', 'deprecated', 'retired')",
    },
    { name: "content", type: "JSONB", notNull: true },
    { name: "variables", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    {
      name: "body_size_bytes",
      type: "INTEGER",
      notNull: true,
      check: "body_size_bytes >= 1",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "approved_at", type: "TIMESTAMPTZ" },
    { name: "approved_by", type: "UUID", references: USER_FK },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "superseded_by_template_id", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "notification_templates_tenant_template_locale_version_key",
      columns: ["tenant_id", "template_id", "channel", "locale", "version"],
    },
  ],
  indexes: [
    {
      name: "idx_notification_templates_tenant_template",
      columns: ["tenant_id", "template_id"],
    },
    { name: "idx_notification_templates_status", columns: ["status"] },
    { name: "idx_notification_templates_channel", columns: ["channel"] },
    { name: "idx_notification_templates_created_by", columns: ["created_by"] },
    { name: "idx_notification_templates_approved_by", columns: ["approved_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "notification_templates_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_NOTIFICATION_PREFERENCES: TableDefinition = {
  schema: "meta",
  name: "notification_preferences",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "user_id", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "category",
      type: "TEXT",
      notNull: true,
      check:
        "category IN ('transactional', 'security_alert', 'system_notice', 'operational_digest', 'marketing')",
    },
    {
      name: "channel",
      type: "TEXT",
      notNull: true,
      check:
        "channel IN ('email', 'sms', 'push_mobile', 'in_app', 'webhook', 'voice_call')",
    },
    { name: "opted_in", type: "BOOLEAN", notNull: true },
    {
      name: "source",
      type: "TEXT",
      notNull: true,
      check:
        "source IN ('default_policy', 'user_set', 'admin_set', 'regulatory_requirement', 'import')",
    },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_by", type: "UUID", references: USER_FK },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "notification_preferences_user_category_channel_key",
      columns: ["tenant_id", "user_id", "category", "channel"],
    },
  ],
  indexes: [
    {
      name: "idx_notification_preferences_user",
      columns: ["tenant_id", "user_id"],
    },
    {
      name: "idx_notification_preferences_user_only",
      columns: ["user_id"],
    },
    {
      name: "idx_notification_preferences_updated_by",
      columns: ["updated_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "notification_preferences_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_NOTIFICATION_SUPPRESSIONS: TableDefinition = {
  schema: "meta",
  name: "notification_suppressions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "suppression_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "notification_suppressions_suppression_id_key",
      },
      check: "suppression_id ~ '^supp_[A-Za-z0-9_-]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "channel",
      type: "TEXT",
      notNull: true,
      check:
        "channel IN ('email', 'sms', 'push_mobile', 'in_app', 'webhook', 'voice_call')",
    },
    { name: "recipient_address", type: "TEXT", notNull: true },
    {
      name: "reason",
      type: "TEXT",
      notNull: true,
      check:
        "reason IN ('hard_bounce', 'soft_bounce_exceeded', 'spam_complaint', 'manual_block', 'unsubscribe', 'do_not_contact_register', 'regulatory_block')",
    },
    { name: "applied_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "applied_by", type: "UUID", references: USER_FK },
    { name: "expires_at", type: "TIMESTAMPTZ" },
    { name: "source_delivery_id", type: "UUID" },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "notification_suppressions_tenant_channel_address_active",
      columns: ["tenant_id", "channel", "recipient_address"],
    },
  ],
  indexes: [
    {
      name: "idx_notification_suppressions_expires",
      columns: ["expires_at"],
    },
    {
      name: "idx_notification_suppressions_reason",
      columns: ["reason"],
    },
    {
      name: "idx_notification_suppressions_applied_by",
      columns: ["applied_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "notification_suppressions_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_NOTIFICATION_DISPATCHES: TableDefinition = {
  schema: "meta",
  name: "notification_dispatches",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "dispatch_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "notification_dispatches_dispatch_id_key",
      },
      check: "dispatch_id ~ '^disp_[A-Za-z0-9_-]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "template_id", type: "TEXT", notNull: true },
    {
      name: "template_version",
      type: "TEXT",
      notNull: true,
      check: "template_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
    },
    {
      name: "locale",
      type: "TEXT",
      notNull: true,
      check: "locale ~ '^[a-z]{2}(-[A-Z]{2})?$'",
    },
    {
      name: "channel",
      type: "TEXT",
      notNull: true,
      check:
        "channel IN ('email', 'sms', 'push_mobile', 'in_app', 'webhook', 'voice_call')",
    },
    {
      name: "category",
      type: "TEXT",
      notNull: true,
      check:
        "category IN ('transactional', 'security_alert', 'system_notice', 'operational_digest', 'marketing')",
    },
    {
      name: "priority",
      type: "TEXT",
      notNull: true,
      check:
        "priority IN ('critical', 'high', 'normal', 'low', 'background')",
    },
    { name: "audience", type: "JSONB", notNull: true },
    {
      name: "variables_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "variables_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "correlation_id", type: "TEXT" },
    {
      name: "idempotency_key",
      type: "TEXT",
      notNull: true,
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('queued', 'rendering', 'rendered', 'sending', 'completed', 'failed', 'cancelled')",
    },
    { name: "queued_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "recipient_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "recipient_count >= 0",
    },
    {
      name: "delivered_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "delivered_count >= 0",
    },
    {
      name: "failed_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "failed_count >= 0",
    },
    {
      name: "suppressed_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "suppressed_count >= 0",
    },
    { name: "cancelled_reason", type: "TEXT" },
    { name: "requested_by", type: "UUID", references: USER_FK },
    { name: "requesting_system", type: "TEXT", notNull: true },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "notification_dispatches_tenant_idempotency_key",
      columns: ["tenant_id", "idempotency_key"],
    },
  ],
  indexes: [
    {
      name: "idx_notification_dispatches_tenant_queued",
      columns: ["tenant_id", "queued_at"],
    },
    { name: "idx_notification_dispatches_status", columns: ["status"] },
    {
      name: "idx_notification_dispatches_template",
      columns: ["template_id", "template_version"],
    },
    {
      name: "idx_notification_dispatches_correlation",
      columns: ["correlation_id"],
    },
    {
      name: "idx_notification_dispatches_requested_by",
      columns: ["requested_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "notification_dispatches_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_NOTIFICATION_DELIVERIES: TableDefinition = {
  schema: "meta",
  name: "notification_deliveries",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "delivery_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "notification_deliveries_delivery_id_key",
      },
      check: "delivery_id ~ '^dlv_[A-Za-z0-9_-]{8,40}$'",
    },
    {
      name: "dispatch_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "notification_dispatches",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "channel",
      type: "TEXT",
      notNull: true,
      check:
        "channel IN ('email', 'sms', 'push_mobile', 'in_app', 'webhook', 'voice_call')",
    },
    { name: "provider", type: "TEXT", notNull: true },
    {
      name: "recipient_address_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "recipient_address_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "attempt_kind",
      type: "TEXT",
      notNull: true,
      check: "attempt_kind IN ('initial', 'retry', 'escalation')",
    },
    {
      name: "attempt_number",
      type: "INTEGER",
      notNull: true,
      check: "attempt_number BETWEEN 1 AND 20",
    },
    { name: "queued_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "sent_at", type: "TIMESTAMPTZ" },
    { name: "finalized_at", type: "TIMESTAMPTZ" },
    {
      name: "latency_ms",
      type: "INTEGER",
      check: "latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000",
    },
    {
      name: "outcome",
      type: "TEXT",
      notNull: true,
      check:
        "outcome IN ('queued', 'delivered', 'deferred', 'bounced_hard', 'bounced_soft', 'complained', 'dropped', 'failed', 'suppressed', 'rate_limited')",
    },
    { name: "provider_message_id", type: "TEXT" },
    {
      name: "http_status",
      type: "INTEGER",
      check: "http_status IS NULL OR http_status BETWEEN 100 AND 599",
    },
    {
      name: "bytes_sent",
      type: "INTEGER",
      check: "bytes_sent IS NULL OR bytes_sent >= 0",
    },
    {
      name: "sms_segments",
      type: "INTEGER",
      check: "sms_segments IS NULL OR sms_segments BETWEEN 0 AND 20",
    },
    { name: "error_code", type: "TEXT" },
    { name: "error_message", type: "TEXT" },
    { name: "next_retry_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_notification_deliveries_dispatch_attempt",
      columns: ["dispatch_id", "attempt_number"],
    },
    {
      name: "idx_notification_deliveries_tenant_queued",
      columns: ["tenant_id", "queued_at"],
    },
    {
      name: "idx_notification_deliveries_outcome",
      columns: ["outcome"],
    },
    {
      name: "idx_notification_deliveries_next_retry",
      columns: ["next_retry_at"],
    },
    {
      name: "idx_notification_deliveries_recipient_sha",
      columns: ["channel", "recipient_address_sha256"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "notification_deliveries_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_NOTIFICATION_DIGESTS: TableDefinition = {
  schema: "meta",
  name: "notification_digests",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "digest_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "notification_digests_digest_id_key" },
      check: "digest_id ~ '^dgst_[A-Za-z0-9_-]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "user_id", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "channel",
      type: "TEXT",
      notNull: true,
      check:
        "channel IN ('email', 'sms', 'push_mobile', 'in_app', 'webhook', 'voice_call')",
    },
    {
      name: "frequency",
      type: "TEXT",
      notNull: true,
      check:
        "frequency IN ('every_15_minutes', 'hourly', 'daily', 'weekly')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('open', 'queued_for_assembly', 'assembled', 'dispatched', 'expired')",
    },
    { name: "opened_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "scheduled_dispatch_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "assembled_at", type: "TIMESTAMPTZ" },
    { name: "dispatched_at", type: "TIMESTAMPTZ" },
    {
      name: "item_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "item_count >= 0",
    },
    {
      name: "max_items",
      type: "INTEGER",
      notNull: true,
      default: "100",
      check: "max_items BETWEEN 1 AND 1000",
    },
    {
      name: "dedup_sha256",
      type: "CHAR(64)",
      check: "dedup_sha256 IS NULL OR dedup_sha256 ~ '^[0-9a-f]{64}$'",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_notification_digests_user_channel_status",
      columns: ["tenant_id", "user_id", "channel", "status"],
    },
    {
      name: "idx_notification_digests_user_only",
      columns: ["user_id"],
    },
    {
      name: "idx_notification_digests_scheduled",
      columns: ["scheduled_dispatch_at"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "notification_digests_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_ACCESS_REVIEW_TEMPLATES: TableDefinition = {
  schema: "meta",
  name: "access_review_templates",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "template_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "access_review_templates_template_id_key" },
      check: "template_id ~ '^art_[a-z0-9]{8,32}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "template_key",
      type: "TEXT",
      notNull: true,
      check: "template_key ~ '^[a-z][a-z0-9_.-]*$'",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    {
      name: "version",
      type: "TEXT",
      notNull: true,
      check: "version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'published', 'deprecated', 'retired')",
    },
    {
      name: "framework",
      type: "TEXT",
      notNull: true,
      check:
        "framework IN ('soc2_type2', 'iso27001', 'hipaa_security_rule', 'pci_dss_v4', 'gdpr_article_32', 'cfr_21_part_11', 'custom')",
    },
    {
      name: "default_frequency",
      type: "TEXT",
      notNull: true,
      check:
        "default_frequency IN ('one_time', 'monthly', 'quarterly', 'semi_annual', 'annual', 'sox_quarterly', 'post_incident', 'ad_hoc')",
    },
    { name: "default_scope", type: "JSONB", notNull: true },
    { name: "default_reviewer_assignment", type: "JSONB", notNull: true },
    {
      name: "default_auto_revoke_policy",
      type: "TEXT",
      notNull: true,
      check:
        "default_auto_revoke_policy IN ('auto_revoke_on_deadline', 'escalate_to_manager', 'default_keep', 'default_revoke')",
    },
    {
      name: "default_deadline_days_from_start",
      type: "INTEGER",
      notNull: true,
      check: "default_deadline_days_from_start BETWEEN 1 AND 180",
    },
    {
      name: "default_grace_period_hours",
      type: "INTEGER",
      notNull: true,
      check: "default_grace_period_hours BETWEEN 0 AND 720",
    },
    {
      name: "default_remediation_days_from_completion",
      type: "INTEGER",
      check:
        "default_remediation_days_from_completion IS NULL OR default_remediation_days_from_completion BETWEEN 0 AND 180",
    },
    { name: "documentation_url", type: "TEXT" },
    { name: "published_at", type: "TIMESTAMPTZ" },
    { name: "published_by", type: "UUID", references: USER_FK },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "superseded_by_template_key", type: "TEXT" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "access_review_templates_tenant_key_version_key",
      columns: ["tenant_id", "template_key", "version"],
    },
  ],
  indexes: [
    {
      name: "idx_access_review_templates_framework_status",
      columns: ["framework", "status"],
    },
    {
      name: "idx_access_review_templates_created_by",
      columns: ["created_by"],
    },
    {
      name: "idx_access_review_templates_published_by",
      columns: ["published_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "access_review_templates_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_ACCESS_REVIEW_CAMPAIGNS: TableDefinition = {
  schema: "meta",
  name: "access_review_campaigns",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "campaign_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "access_review_campaigns_campaign_id_key" },
      check: "campaign_id ~ '^arc_[a-z0-9]{8,32}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    {
      name: "frequency",
      type: "TEXT",
      notNull: true,
      check:
        "frequency IN ('one_time', 'monthly', 'quarterly', 'semi_annual', 'annual', 'sox_quarterly', 'post_incident', 'ad_hoc')",
    },
    {
      name: "framework",
      type: "TEXT",
      notNull: true,
      check:
        "framework IN ('soc2_type2', 'iso27001', 'hipaa_security_rule', 'pci_dss_v4', 'gdpr_article_32', 'cfr_21_part_11', 'custom')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'scheduled', 'in_progress', 'in_remediation', 'completed', 'archived', 'cancelled')",
    },
    { name: "scope", type: "JSONB", notNull: true },
    { name: "reviewer_assignment", type: "JSONB", notNull: true },
    {
      name: "auto_revoke_policy",
      type: "TEXT",
      notNull: true,
      check:
        "auto_revoke_policy IN ('auto_revoke_on_deadline', 'escalate_to_manager', 'default_keep', 'default_revoke')",
    },
    { name: "related_incident_id", type: "TEXT" },
    { name: "scheduled_start_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "deadline_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "grace_period_hours",
      type: "INTEGER",
      notNull: true,
      default: "24",
      check: "grace_period_hours BETWEEN 0 AND 720",
    },
    { name: "remediation_deadline_at", type: "TIMESTAMPTZ" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "archived_at", type: "TIMESTAMPTZ" },
    { name: "cancelled_at", type: "TIMESTAMPTZ" },
    { name: "cancelled_reason", type: "TEXT" },
    {
      name: "template_id",
      type: "UUID",
      references: {
        schema: "meta",
        table: "access_review_templates",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "total_items",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "total_items >= 0",
    },
    {
      name: "decided_items",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "decided_items >= 0",
    },
    {
      name: "auto_revoked_items",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "auto_revoked_items >= 0",
    },
    {
      name: "exception_items",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "exception_items >= 0",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_access_review_campaigns_tenant_status",
      columns: ["tenant_id", "status"],
    },
    {
      name: "idx_access_review_campaigns_framework",
      columns: ["framework"],
    },
    {
      name: "idx_access_review_campaigns_deadline",
      columns: ["deadline_at"],
    },
    {
      name: "idx_access_review_campaigns_created_by",
      columns: ["created_by"],
    },
    {
      name: "idx_access_review_campaigns_template",
      columns: ["template_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "access_review_campaigns_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_ACCESS_REVIEW_ITEMS: TableDefinition = {
  schema: "meta",
  name: "access_review_items",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "item_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "access_review_items_item_id_key" },
      check: "item_id ~ '^ari_[a-z0-9]{8,32}$'",
    },
    {
      name: "campaign_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "access_review_campaigns",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "principal_id", type: "UUID", notNull: true },
    {
      name: "principal_type",
      type: "TEXT",
      notNull: true,
      check:
        "principal_type IN ('user', 'service_account', 'ai_architect', 'system', 'external_partner')",
    },
    { name: "principal_label", type: "TEXT", notNull: true },
    {
      name: "grant_kind",
      type: "TEXT",
      notNull: true,
      check:
        "grant_kind IN ('role', 'permission', 'resource_access', 'tenant_membership', 'field_permission', 'api_key_scope', 'marketplace_pack_grant')",
    },
    { name: "grant_id", type: "TEXT", notNull: true },
    { name: "grant_label", type: "TEXT", notNull: true },
    { name: "grant_attributes", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    { name: "granted_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "granted_by", type: "UUID", references: USER_FK },
    { name: "last_used_at", type: "TIMESTAMPTZ" },
    {
      name: "risk_level",
      type: "TEXT",
      notNull: true,
      check: "risk_level IN ('low', 'medium', 'high', 'critical')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('pending', 'in_review', 'decided', 'escalated', 'auto_revoked', 'exception_pending', 'deferred_to_next_campaign', 'withdrawn')",
    },
    { name: "current_reviewer_user_id", type: "UUID", references: USER_FK },
    {
      name: "current_reviewer_kind",
      type: "TEXT",
      check:
        "current_reviewer_kind IS NULL OR current_reviewer_kind IN ('human_user', 'ai_suggested_pending_human', 'system_automated')",
    },
    { name: "reviewer_assigned_at", type: "TIMESTAMPTZ" },
    {
      name: "reminder_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "reminder_count BETWEEN 0 AND 20",
    },
    { name: "last_reminder_at", type: "TIMESTAMPTZ" },
    {
      name: "escalation_level",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "escalation_level BETWEEN 0 AND 10",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "opened_for_review_at", type: "TIMESTAMPTZ" },
    { name: "decided_at", type: "TIMESTAMPTZ" },
    { name: "decision_id", type: "TEXT" },
    { name: "auto_revoked_at", type: "TIMESTAMPTZ" },
    { name: "auto_revoke_reason", type: "TEXT" },
    { name: "due_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_access_review_items_campaign_status",
      columns: ["campaign_id", "status"],
    },
    {
      name: "idx_access_review_items_principal",
      columns: ["principal_id"],
    },
    {
      name: "idx_access_review_items_reviewer",
      columns: ["current_reviewer_user_id"],
    },
    {
      name: "idx_access_review_items_due",
      columns: ["due_at"],
    },
    {
      name: "idx_access_review_items_risk",
      columns: ["tenant_id", "risk_level"],
    },
    {
      name: "idx_access_review_items_granted_by",
      columns: ["granted_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "access_review_items_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_ACCESS_REVIEW_DECISIONS: TableDefinition = {
  schema: "meta",
  name: "access_review_decisions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "decision_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "access_review_decisions_decision_id_key" },
      check: "decision_id ~ '^ard_[a-z0-9]{8,32}$'",
    },
    {
      name: "item_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "access_review_items",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    {
      name: "campaign_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "access_review_campaigns",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "decided_by_user_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "decided_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('keep', 'revoke', 'time_bound_extend', 'modify_grant', 'defer_to_next_campaign')",
    },
    {
      name: "reason",
      type: "TEXT",
      notNull: true,
      check:
        "reason IN ('role_appropriate', 'last_login_recent', 'business_justification_attested', 'compliance_attestation', 'manager_attestation', 'regulatory_requirement', 'no_response_auto_default', 'security_concern_revoked', 'role_changed_modified', 'promotion_modified', 'departure_revoked', 'duplicate_access_revoked', 'unused_access_revoked', 'principal_no_longer_in_scope')",
    },
    { name: "comment", type: "TEXT" },
    { name: "time_bound_extend_until", type: "TIMESTAMPTZ" },
    { name: "modified_grant_attributes", type: "JSONB" },
    {
      name: "attestation_kind",
      type: "TEXT",
      notNull: true,
      check:
        "attestation_kind IN ('click_through_acknowledgement', 'typed_attestation_phrase', 'e_signature_digital', 'qualified_e_signature', 'two_person_attestation')",
    },
    {
      name: "attestation_signature_sha256",
      type: "CHAR(64)",
      check:
        "attestation_signature_sha256 IS NULL OR attestation_signature_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "attestation_signing_key_fingerprint",
      type: "CHAR(64)",
      check:
        "attestation_signing_key_fingerprint IS NULL OR attestation_signing_key_fingerprint ~ '^[0-9a-f]{64}$'",
    },
    { name: "co_attesting_user_id", type: "UUID", references: USER_FK },
    { name: "co_attested_at", type: "TIMESTAMPTZ" },
    { name: "ip_address", type: "INET", notNull: true },
    { name: "user_agent", type: "TEXT", notNull: true },
    { name: "supersedes_decision_id", type: "TEXT" },
    { name: "related_exception_id", type: "TEXT" },
    { name: "applied_at", type: "TIMESTAMPTZ" },
    { name: "application_failed_at", type: "TIMESTAMPTZ" },
    { name: "application_failure_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_access_review_decisions_tenant",
      columns: ["tenant_id"],
    },
    {
      name: "idx_access_review_decisions_item",
      columns: ["item_id", "decided_at"],
    },
    {
      name: "idx_access_review_decisions_campaign",
      columns: ["campaign_id"],
    },
    {
      name: "idx_access_review_decisions_decided_by",
      columns: ["decided_by_user_id"],
    },
    {
      name: "idx_access_review_decisions_co_attestor",
      columns: ["co_attesting_user_id"],
    },
    {
      name: "idx_access_review_decisions_kind_reason",
      columns: ["kind", "reason"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "access_review_decisions_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_ACCESS_REVIEW_EXCEPTIONS: TableDefinition = {
  schema: "meta",
  name: "access_review_exceptions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "exception_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "access_review_exceptions_exception_id_key" },
      check: "exception_id ~ '^are_[a-z0-9]{8,32}$'",
    },
    {
      name: "item_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "access_review_items",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    {
      name: "campaign_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "access_review_campaigns",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('requested', 'approved', 'rejected', 'expired', 'revoked_early', 'superseded')",
    },
    {
      name: "reason",
      type: "TEXT",
      notNull: true,
      check:
        "reason IN ('emergency_break_glass', 'regulatory_exemption', 'system_account_required', 'contractor_renewal_pending', 'dual_role_business_need', 'audit_trail_required', 'migration_in_progress', 'vendor_support_requirement')",
    },
    { name: "justification", type: "TEXT", notNull: true },
    { name: "requested_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "requested_by_user_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "requested_expires_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "approved_at", type: "TIMESTAMPTZ" },
    { name: "approved_by_user_id", type: "UUID", references: USER_FK },
    { name: "approved_justification", type: "TEXT" },
    { name: "granted_expires_at", type: "TIMESTAMPTZ" },
    { name: "rejected_at", type: "TIMESTAMPTZ" },
    { name: "rejected_by_user_id", type: "UUID", references: USER_FK },
    { name: "rejected_reason", type: "TEXT" },
    { name: "expired_at", type: "TIMESTAMPTZ" },
    { name: "revoked_early_at", type: "TIMESTAMPTZ" },
    { name: "revoked_early_by_user_id", type: "UUID", references: USER_FK },
    { name: "revoked_early_reason", type: "TEXT" },
    { name: "superseded_by_exception_id", type: "TEXT" },
    {
      name: "notification_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "notification_count BETWEEN 0 AND 50",
    },
    { name: "last_notification_at", type: "TIMESTAMPTZ" },
    {
      name: "requires_quarterly_reattestation",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "last_reattested_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_access_review_exceptions_item",
      columns: ["item_id"],
    },
    {
      name: "idx_access_review_exceptions_campaign",
      columns: ["campaign_id"],
    },
    {
      name: "idx_access_review_exceptions_tenant_status",
      columns: ["tenant_id", "status"],
    },
    {
      name: "idx_access_review_exceptions_granted_expires",
      columns: ["granted_expires_at"],
    },
    {
      name: "idx_access_review_exceptions_requested_by",
      columns: ["requested_by_user_id"],
    },
    {
      name: "idx_access_review_exceptions_approved_by",
      columns: ["approved_by_user_id"],
    },
    {
      name: "idx_access_review_exceptions_rejected_by",
      columns: ["rejected_by_user_id"],
    },
    {
      name: "idx_access_review_exceptions_revoked_early_by",
      columns: ["revoked_early_by_user_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "access_review_exceptions_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_ACCESS_REVIEW_EVIDENCE: TableDefinition = {
  schema: "meta",
  name: "access_review_evidence",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "evidence_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "access_review_evidence_evidence_id_key" },
      check: "evidence_id ~ '^arv_[a-z0-9]{8,32}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "framework",
      type: "TEXT",
      notNull: true,
      check:
        "framework IN ('soc2_type2', 'iso27001', 'hipaa_security_rule', 'pci_dss_v4', 'gdpr_article_32', 'cfr_21_part_11', 'custom')",
    },
    { name: "period_start_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "period_end_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "campaign_ids", type: "JSONB", notNull: true },
    { name: "control_mappings", type: "JSONB", notNull: true },
    {
      name: "total_items_across_campaigns",
      type: "INTEGER",
      notNull: true,
      check: "total_items_across_campaigns >= 0",
    },
    {
      name: "completion_rate",
      type: "NUMERIC(5, 4)",
      notNull: true,
      check: "completion_rate BETWEEN 0 AND 1",
    },
    {
      name: "keep_rate",
      type: "NUMERIC(5, 4)",
      notNull: true,
      check: "keep_rate BETWEEN 0 AND 1",
    },
    {
      name: "revoke_rate",
      type: "NUMERIC(5, 4)",
      notNull: true,
      check: "revoke_rate BETWEEN 0 AND 1",
    },
    {
      name: "auto_revoke_rate",
      type: "NUMERIC(5, 4)",
      notNull: true,
      check: "auto_revoke_rate BETWEEN 0 AND 1",
    },
    {
      name: "exception_rate",
      type: "NUMERIC(5, 4)",
      notNull: true,
      check: "exception_rate BETWEEN 0 AND 1",
    },
    {
      name: "strong_attestation_rate",
      type: "NUMERIC(5, 4)",
      notNull: true,
      check: "strong_attestation_rate BETWEEN 0 AND 1",
    },
    {
      name: "overdue_rate",
      type: "NUMERIC(5, 4)",
      notNull: true,
      check: "overdue_rate BETWEEN 0 AND 1",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'compiled', 'sealed', 'submitted_to_auditor', 'accepted_by_auditor', 'rejected_by_auditor')",
    },
    { name: "compiled_at", type: "TIMESTAMPTZ" },
    { name: "sealed_at", type: "TIMESTAMPTZ" },
    {
      name: "sealed_sha256",
      type: "CHAR(64)",
      check: "sealed_sha256 IS NULL OR sealed_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "submitted_at", type: "TIMESTAMPTZ" },
    { name: "submitted_to_auditor_id", type: "TEXT" },
    { name: "accepted_at", type: "TIMESTAMPTZ" },
    { name: "rejected_at", type: "TIMESTAMPTZ" },
    { name: "rejected_reason", type: "TEXT" },
    { name: "storage_uri", type: "TEXT" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_access_review_evidence_tenant_period",
      columns: ["tenant_id", "period_end_at"],
    },
    {
      name: "idx_access_review_evidence_framework_status",
      columns: ["framework", "status"],
    },
    {
      name: "idx_access_review_evidence_created_by",
      columns: ["created_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "access_review_evidence_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_WORKFLOW_DEFINITIONS: TableDefinition = {
  schema: "meta",
  name: "workflow_definitions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "definition_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "workflow_definitions_definition_id_key" },
      check: "definition_id ~ '^wfd_[a-z0-9]{8,32}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "definition_key",
      type: "TEXT",
      notNull: true,
      check: "definition_key ~ '^[a-z][a-z0-9_.-]*$'",
    },
    {
      name: "version",
      type: "TEXT",
      notNull: true,
      check: "version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'in_review', 'published', 'deprecated', 'retired')",
    },
    { name: "states", type: "JSONB", notNull: true },
    { name: "transitions", type: "JSONB", notNull: true },
    { name: "variables", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "timers", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "signals", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    {
      name: "initial_state",
      type: "TEXT",
      notNull: true,
      check: "initial_state ~ '^[a-z][a-z0-9_]*$'",
    },
    {
      name: "compensation_strategy",
      type: "TEXT",
      notNull: true,
      check:
        "compensation_strategy IN ('immediate_reverse_order', 'parallel', 'manual_review', 'no_compensation')",
    },
    {
      name: "timeout_seconds",
      type: "INTEGER",
      notNull: true,
      check: "timeout_seconds BETWEEN 60 AND 31536000",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "published_at", type: "TIMESTAMPTZ" },
    { name: "published_by", type: "UUID", references: USER_FK },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "superseded_by_definition_id", type: "TEXT" },
    {
      name: "source_manifest_sha256",
      type: "CHAR(64)",
      check:
        "source_manifest_sha256 IS NULL OR source_manifest_sha256 ~ '^[0-9a-f]{64}$'",
    },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "workflow_definitions_tenant_key_version_key",
      columns: ["tenant_id", "definition_key", "version"],
    },
  ],
  indexes: [
    {
      name: "idx_workflow_definitions_tenant_key",
      columns: ["tenant_id", "definition_key"],
    },
    { name: "idx_workflow_definitions_status", columns: ["status"] },
    { name: "idx_workflow_definitions_created_by", columns: ["created_by"] },
    { name: "idx_workflow_definitions_published_by", columns: ["published_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "workflow_definitions_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_WORKFLOW_INSTANCES: TableDefinition = {
  schema: "meta",
  name: "workflow_instances",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "instance_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "workflow_instances_instance_id_key" },
      check: "instance_id ~ '^wfi_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "definition_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "workflow_definitions",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "definition_key",
      type: "TEXT",
      notNull: true,
      check: "definition_key ~ '^[a-z][a-z0-9_.-]*$'",
    },
    {
      name: "definition_version",
      type: "TEXT",
      notNull: true,
      check: "definition_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('created', 'running', 'waiting_for_signal', 'waiting_for_timer', 'waiting_for_activity', 'waiting_for_manual', 'suspended', 'completed', 'failed', 'cancelled', 'compensating', 'compensated')",
    },
    {
      name: "current_state",
      type: "TEXT",
      notNull: true,
      check: "current_state ~ '^[a-z][a-z0-9_]*$'",
    },
    { name: "variables", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    { name: "related_entity", type: "JSONB" },
    { name: "correlation_key", type: "TEXT" },
    {
      name: "parent_instance_id",
      type: "UUID",
      references: {
        schema: "meta",
        table: "workflow_instances",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "started_by_user_id", type: "UUID", references: USER_FK },
    { name: "started_by_system", type: "TEXT" },
    { name: "last_transition_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "cancelled_at", type: "TIMESTAMPTZ" },
    { name: "cancelled_by_user_id", type: "UUID", references: USER_FK },
    { name: "cancelled_reason", type: "TEXT" },
    { name: "failed_at", type: "TIMESTAMPTZ" },
    { name: "failure_code", type: "TEXT" },
    { name: "failure_message", type: "TEXT" },
    { name: "suspended_at", type: "TIMESTAMPTZ" },
    { name: "suspended_reason", type: "TEXT" },
    { name: "compensation_started_at", type: "TIMESTAMPTZ" },
    { name: "compensation_completed_at", type: "TIMESTAMPTZ" },
    { name: "timeout_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "sequence_cursor",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "sequence_cursor >= 0",
    },
    { name: "awaiting_activity_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "awaiting_signal_names", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "awaiting_timer_names", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_workflow_instances_tenant_status",
      columns: ["tenant_id", "status"],
    },
    {
      name: "idx_workflow_instances_definition",
      columns: ["definition_id"],
    },
    {
      name: "idx_workflow_instances_correlation",
      columns: ["tenant_id", "correlation_key"],
    },
    {
      name: "idx_workflow_instances_timeout",
      columns: ["timeout_at"],
    },
    {
      name: "idx_workflow_instances_parent",
      columns: ["parent_instance_id"],
    },
    {
      name: "idx_workflow_instances_started_by",
      columns: ["started_by_user_id"],
    },
    {
      name: "idx_workflow_instances_cancelled_by",
      columns: ["cancelled_by_user_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "workflow_instances_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_WORKFLOW_ACTIVITIES: TableDefinition = {
  schema: "meta",
  name: "workflow_activities",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "activity_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "workflow_activities_activity_id_key" },
      check: "activity_id ~ '^wfa_[a-z0-9]{8,40}$'",
    },
    {
      name: "instance_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "workflow_instances",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "definition_activity_key",
      type: "TEXT",
      notNull: true,
      check: "definition_activity_key ~ '^[a-z][a-z0-9_]*$'",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('http_call', 'db_read', 'db_write', 'ai_call', 'manual_task', 'child_workflow', 'compensation', 'send_notification', 'audit_emit', 'transformation')",
    },
    { name: "label", type: "TEXT", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('pending', 'scheduled', 'running', 'succeeded', 'failed', 'cancelled', 'compensated', 'timed_out')",
    },
    {
      name: "attempt_number",
      type: "INTEGER",
      notNull: true,
      check: "attempt_number BETWEEN 1 AND 50",
    },
    {
      name: "max_attempts",
      type: "INTEGER",
      notNull: true,
      check: "max_attempts BETWEEN 1 AND 50",
    },
    { name: "retry_policy", type: "JSONB", notNull: true },
    { name: "scheduled_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "started_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    {
      name: "timeout_seconds",
      type: "INTEGER",
      notNull: true,
      check: "timeout_seconds BETWEEN 1 AND 86400",
    },
    { name: "timeout_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "input_sha256",
      type: "CHAR(64)",
      check: "input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "output_sha256",
      type: "CHAR(64)",
      check: "output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "error_code", type: "TEXT" },
    { name: "error_message", type: "TEXT" },
    { name: "next_retry_at", type: "TIMESTAMPTZ" },
    {
      name: "compensation_activity_key",
      type: "TEXT",
      check:
        "compensation_activity_key IS NULL OR compensation_activity_key ~ '^[a-z][a-z0-9_]*$'",
    },
    { name: "compensates_activity_id", type: "TEXT" },
    { name: "child_workflow_instance_id", type: "TEXT" },
    { name: "assigned_to_user_id", type: "UUID", references: USER_FK },
    { name: "completed_by_user_id", type: "UUID", references: USER_FK },
    {
      name: "sequence_cursor",
      type: "INTEGER",
      notNull: true,
      check: "sequence_cursor >= 0",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_workflow_activities_instance_seq",
      columns: ["instance_id", "sequence_cursor"],
    },
    {
      name: "idx_workflow_activities_status",
      columns: ["tenant_id", "status"],
    },
    {
      name: "idx_workflow_activities_next_retry",
      columns: ["next_retry_at"],
    },
    {
      name: "idx_workflow_activities_timeout",
      columns: ["timeout_at"],
    },
    {
      name: "idx_workflow_activities_assigned_to",
      columns: ["assigned_to_user_id"],
    },
    {
      name: "idx_workflow_activities_completed_by",
      columns: ["completed_by_user_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "workflow_activities_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_WORKFLOW_SIGNALS: TableDefinition = {
  schema: "meta",
  name: "workflow_signals",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "signal_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "workflow_signals_signal_id_key" },
      check: "signal_id ~ '^wfs_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "instance_id",
      type: "UUID",
      references: {
        schema: "meta",
        table: "workflow_instances",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "signal_name",
      type: "TEXT",
      notNull: true,
      check: "signal_name ~ '^[a-z][a-z0-9_.-]*$'",
    },
    { name: "correlation_key", type: "TEXT", notNull: true },
    {
      name: "delivery_guarantee",
      type: "TEXT",
      notNull: true,
      check:
        "delivery_guarantee IN ('at_most_once', 'at_least_once', 'exactly_once_idempotent')",
    },
    { name: "idempotency_key", type: "TEXT" },
    {
      name: "payload_sha256",
      type: "CHAR(64)",
      check:
        "payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "payload_storage_uri", type: "TEXT" },
    {
      name: "payload_size_bytes",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "payload_size_bytes BETWEEN 0 AND 10000000",
    },
    { name: "source_system", type: "TEXT", notNull: true },
    { name: "source_principal_id", type: "UUID", references: USER_FK },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('received', 'matched_to_instance', 'consumed', 'expired', 'rejected')",
    },
    { name: "received_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "matched_at", type: "TIMESTAMPTZ" },
    { name: "consumed_at", type: "TIMESTAMPTZ" },
    { name: "consumed_by_activity_id", type: "TEXT" },
    { name: "expires_at", type: "TIMESTAMPTZ" },
    { name: "expired_at", type: "TIMESTAMPTZ" },
    { name: "rejected_at", type: "TIMESTAMPTZ" },
    {
      name: "rejected_reason",
      type: "TEXT",
      check:
        "rejected_reason IS NULL OR rejected_reason IN ('no_matching_instance', 'instance_terminal', 'signal_not_declared', 'duplicate_idempotency_key', 'payload_schema_mismatch', 'expired_before_match', 'tenant_mismatch')",
    },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "workflow_signals_tenant_name_idempotency_key",
      columns: ["tenant_id", "signal_name", "idempotency_key"],
    },
  ],
  indexes: [
    {
      name: "idx_workflow_signals_correlation",
      columns: ["tenant_id", "correlation_key"],
    },
    {
      name: "idx_workflow_signals_instance",
      columns: ["instance_id"],
    },
    {
      name: "idx_workflow_signals_status",
      columns: ["status"],
    },
    {
      name: "idx_workflow_signals_source_principal",
      columns: ["source_principal_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "workflow_signals_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_WORKFLOW_TIMERS: TableDefinition = {
  schema: "meta",
  name: "workflow_timers",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "timer_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "workflow_timers_timer_id_key" },
      check: "timer_id ~ '^wft_[a-z0-9]{8,40}$'",
    },
    {
      name: "instance_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "workflow_instances",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "timer_name",
      type: "TEXT",
      notNull: true,
      check: "timer_name ~ '^[a-z][a-z0-9_]*$'",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('absolute_at', 'relative_after', 'cron_schedule', 'business_hours')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('scheduled', 'fired', 'cancelled', 'expired_before_fire')",
    },
    { name: "scheduled_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "fire_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "timezone", type: "TEXT", notNull: true, default: "'UTC'" },
    { name: "cron_expression", type: "TEXT" },
    {
      name: "relative_seconds",
      type: "INTEGER",
      check:
        "relative_seconds IS NULL OR relative_seconds BETWEEN 1 AND 31536000",
    },
    { name: "fired_at", type: "TIMESTAMPTZ" },
    { name: "cancelled_at", type: "TIMESTAMPTZ" },
    { name: "cancelled_reason", type: "TEXT" },
    { name: "expired_at", type: "TIMESTAMPTZ" },
    { name: "transition_to_trigger", type: "TEXT" },
    {
      name: "fire_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "fire_count BETWEEN 0 AND 1000000",
    },
    { name: "next_fire_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_workflow_timers_instance",
      columns: ["instance_id"],
    },
    {
      name: "idx_workflow_timers_fire_at",
      columns: ["fire_at"],
    },
    {
      name: "idx_workflow_timers_status",
      columns: ["tenant_id", "status"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "workflow_timers_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_WORKFLOW_EVENTS: TableDefinition = {
  schema: "meta",
  name: "workflow_events",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "event_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "workflow_events_event_id_key" },
      check: "event_id ~ '^wfe_[a-z0-9]{8,40}$'",
    },
    {
      name: "instance_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "workflow_instances",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "sequence_number",
      type: "INTEGER",
      notNull: true,
      check: "sequence_number BETWEEN 0 AND 1000000000",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('instance_started', 'instance_completed', 'instance_failed', 'instance_cancelled', 'instance_suspended', 'instance_resumed', 'state_transitioned', 'activity_scheduled', 'activity_started', 'activity_completed', 'activity_failed', 'activity_timed_out', 'activity_compensated', 'signal_received', 'signal_consumed', 'timer_scheduled', 'timer_fired', 'timer_cancelled', 'variable_updated', 'compensation_started', 'compensation_step_completed', 'compensation_completed', 'manual_action_taken', 'child_workflow_spawned', 'child_workflow_completed')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "actor_principal_id", type: "UUID", references: USER_FK },
    { name: "actor_system_id", type: "TEXT" },
    { name: "previous_state", type: "TEXT" },
    { name: "new_state", type: "TEXT" },
    { name: "activity_id", type: "TEXT" },
    { name: "signal_id", type: "TEXT" },
    { name: "timer_id", type: "TEXT" },
    { name: "child_instance_id", type: "TEXT" },
    {
      name: "variable_name",
      type: "TEXT",
      check:
        "variable_name IS NULL OR variable_name ~ '^[a-z][a-z0-9_]*$'",
    },
    { name: "payload", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    { name: "correlation_id", type: "TEXT" },
    { name: "causation_event_id", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "workflow_events_instance_sequence_key",
      columns: ["instance_id", "sequence_number"],
    },
  ],
  indexes: [
    {
      name: "idx_workflow_events_instance_occurred",
      columns: ["instance_id", "occurred_at"],
    },
    {
      name: "idx_workflow_events_kind",
      columns: ["tenant_id", "kind"],
    },
    {
      name: "idx_workflow_events_actor",
      columns: ["actor_principal_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "workflow_events_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_WORKFLOW_TRACES: TableDefinition = {
  schema: "meta",
  name: "workflow_traces",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "instance_id",
      type: "UUID",
      references: {
        schema: "meta",
        table: "workflow_instances",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    {
      name: "definition_id",
      type: "UUID",
      references: {
        schema: "meta",
        table: "workflow_definitions",
        column: "id",
        onDelete: "SET NULL",
      },
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('instance_started', 'instance_completed', 'instance_failed', 'instance_cancelled', 'state_transitioned', 'signal_received', 'signal_consumed', 'timer_fired', 'activity_scheduled', 'activity_started', 'activity_completed', 'activity_failed', 'action_applied', 'engine_error')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "duration_ms",
      type: "INTEGER",
      check: "duration_ms IS NULL OR duration_ms >= 0",
    },
    { name: "correlation_id", type: "TEXT" },
    { name: "attributes", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    {
      name: "created_at",
      type: "TIMESTAMPTZ",
      notNull: true,
      default: "now()",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_workflow_traces_instance_occurred",
      columns: ["instance_id", "occurred_at"],
    },
    {
      name: "idx_workflow_traces_tenant_kind_occurred",
      columns: ["tenant_id", "kind", "occurred_at"],
    },
    {
      name: "idx_workflow_traces_correlation",
      columns: ["tenant_id", "correlation_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "workflow_traces_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_LINEAGE_NODES: TableDefinition = {
  schema: "meta",
  name: "lineage_nodes",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "node_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "lineage_nodes_node_id_key" },
      check: "node_id ~ '^lng_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('source_table', 'derived_table', 'dataset', 'ml_model', 'ml_evaluation', 'report', 'dashboard', 'tenant_export', 'ai_call_output', 'search_index_document', 'materialized_view', 'file_artifact', 'aggregation_result', 'redacted_view')",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT" },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('active', 'frozen', 'archived', 'purged', 'tombstoned')",
    },
    {
      name: "classification",
      type: "TEXT",
      notNull: true,
      check:
        "classification IN ('public', 'internal', 'confidential', 'pii_personal', 'phi_protected', 'regulated_financial')",
    },
    {
      name: "row_count",
      type: "BIGINT",
      check: "row_count IS NULL OR row_count >= 0",
    },
    {
      name: "column_count",
      type: "INTEGER",
      check: "column_count IS NULL OR column_count BETWEEN 0 AND 10000",
    },
    {
      name: "size_bytes",
      type: "BIGINT",
      check: "size_bytes IS NULL OR size_bytes >= 0",
    },
    {
      name: "content_sha256",
      type: "CHAR(64)",
      check:
        "content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "storage_uri", type: "TEXT" },
    { name: "external_ref", type: "JSONB" },
    {
      name: "source_package",
      type: "TEXT",
      check:
        "source_package IS NULL OR source_package ~ '^@crossengin/[a-z][a-z0-9-]*$'",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by_user_id", type: "UUID", references: USER_FK },
    { name: "created_by_system", type: "TEXT" },
    { name: "frozen_at", type: "TIMESTAMPTZ" },
    {
      name: "frozen_sha256",
      type: "CHAR(64)",
      check:
        "frozen_sha256 IS NULL OR frozen_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "purged_at", type: "TIMESTAMPTZ" },
    { name: "tombstoned_at", type: "TIMESTAMPTZ" },
    { name: "retention_until", type: "TIMESTAMPTZ" },
    {
      name: "minimum_k_anonymity",
      type: "INTEGER",
      check:
        "minimum_k_anonymity IS NULL OR minimum_k_anonymity BETWEEN 1 AND 10000",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_lineage_nodes_tenant_kind", columns: ["tenant_id", "kind"] },
    { name: "idx_lineage_nodes_classification", columns: ["classification"] },
    { name: "idx_lineage_nodes_status", columns: ["status"] },
    { name: "idx_lineage_nodes_retention", columns: ["retention_until"] },
    { name: "idx_lineage_nodes_created_by", columns: ["created_by_user_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "lineage_nodes_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_LINEAGE_EDGES: TableDefinition = {
  schema: "meta",
  name: "lineage_edges",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "edge_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "lineage_edges_edge_id_key" },
      check: "edge_id ~ '^lne_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('derived_from', 'joined_with', 'aggregated_from', 'transformed_by', 'redacted_from', 'anonymized_from', 'referenced_by', 'copied_to', 'predicted_by', 'trained_on')",
    },
    {
      name: "source_node_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "lineage_nodes",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "target_node_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "lineage_nodes",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "source_classification",
      type: "TEXT",
      notNull: true,
      check:
        "source_classification IN ('public', 'internal', 'confidential', 'pii_personal', 'phi_protected', 'regulated_financial')",
    },
    {
      name: "target_classification",
      type: "TEXT",
      notNull: true,
      check:
        "target_classification IN ('public', 'internal', 'confidential', 'pii_personal', 'phi_protected', 'regulated_financial')",
    },
    { name: "columns_contributing", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "columns_consumed", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    {
      name: "transform_expression_sha256",
      type: "CHAR(64)",
      check:
        "transform_expression_sha256 IS NULL OR transform_expression_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "row_count_consumed",
      type: "BIGINT",
      check: "row_count_consumed IS NULL OR row_count_consumed >= 0",
    },
    {
      name: "row_count_produced",
      type: "BIGINT",
      check: "row_count_produced IS NULL OR row_count_produced >= 0",
    },
    {
      name: "k_anonymity_achieved",
      type: "INTEGER",
      check: "k_anonymity_achieved IS NULL OR k_anonymity_achieved >= 1",
    },
    { name: "redaction_rules", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "provenance_record_id", type: "TEXT" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by_user_id", type: "UUID", references: USER_FK },
    { name: "created_by_system", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_lineage_edges_tenant",
      columns: ["tenant_id"],
    },
    {
      name: "idx_lineage_edges_source",
      columns: ["source_node_id"],
    },
    {
      name: "idx_lineage_edges_target",
      columns: ["target_node_id"],
    },
    {
      name: "idx_lineage_edges_kind",
      columns: ["kind"],
    },
    {
      name: "idx_lineage_edges_created_by",
      columns: ["created_by_user_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "lineage_edges_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_PROVENANCE_RECORDS: TableDefinition = {
  schema: "meta",
  name: "provenance_records",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "provenance_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "provenance_records_provenance_id_key" },
      check: "provenance_id ~ '^prv_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "operation_kind",
      type: "TEXT",
      notNull: true,
      check:
        "operation_kind IN ('ingest', 'transform', 'join', 'aggregate', 'redact', 'anonymize', 'train', 'evaluate', 'predict', 'export', 'query', 'index', 'ai_inference', 'copy_to_region', 'tombstone')",
    },
    {
      name: "edge_kind",
      type: "TEXT",
      check:
        "edge_kind IS NULL OR edge_kind IN ('derived_from', 'joined_with', 'aggregated_from', 'transformed_by', 'redacted_from', 'anonymized_from', 'referenced_by', 'copied_to', 'predicted_by', 'trained_on')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "actor_principal_id", type: "UUID", references: USER_FK },
    { name: "actor_system_id", type: "TEXT" },
    {
      name: "actor_package",
      type: "TEXT",
      check:
        "actor_package IS NULL OR actor_package ~ '^@crossengin/[a-z][a-z0-9-]*$'",
    },
    { name: "input_node_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "output_node_ids", type: "JSONB", notNull: true },
    {
      name: "operation_parameters_sha256",
      type: "CHAR(64)",
      check:
        "operation_parameters_sha256 IS NULL OR operation_parameters_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "operation_code_sha256",
      type: "CHAR(64)",
      check:
        "operation_code_sha256 IS NULL OR operation_code_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "related_workflow_instance_id", type: "TEXT" },
    { name: "related_activity_id", type: "TEXT" },
    { name: "related_job_run_id", type: "TEXT" },
    {
      name: "outcome",
      type: "TEXT",
      notNull: true,
      check:
        "outcome IN ('succeeded', 'partial_succeeded', 'failed', 'rolled_back')",
    },
    {
      name: "duration_ms",
      type: "INTEGER",
      check: "duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000",
    },
    {
      name: "rows_read",
      type: "BIGINT",
      check: "rows_read IS NULL OR rows_read >= 0",
    },
    {
      name: "rows_written",
      type: "BIGINT",
      check: "rows_written IS NULL OR rows_written >= 0",
    },
    { name: "error_code", type: "TEXT" },
    { name: "error_message", type: "TEXT" },
    { name: "rolled_back_at", type: "TIMESTAMPTZ" },
    { name: "rolled_back_reason", type: "TEXT" },
    { name: "caused_by_provenance_id", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_provenance_records_tenant_occurred",
      columns: ["tenant_id", "occurred_at"],
    },
    {
      name: "idx_provenance_records_operation",
      columns: ["operation_kind"],
    },
    {
      name: "idx_provenance_records_outcome",
      columns: ["outcome"],
    },
    {
      name: "idx_provenance_records_actor",
      columns: ["actor_principal_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "provenance_records_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_DATA_SUBJECTS: TableDefinition = {
  schema: "meta",
  name: "data_subjects",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "subject_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "data_subjects_subject_id_key" },
      check: "subject_id ~ '^ds_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "primary_identifier_kind",
      type: "TEXT",
      notNull: true,
      check:
        "primary_identifier_kind IN ('email_address', 'user_id', 'external_user_id', 'patient_mrn', 'national_id', 'tax_id', 'phone_e164', 'device_fingerprint', 'ip_address', 'pseudonymous_id')",
    },
    {
      name: "primary_identifier_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "primary_identifier_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "alternate_identifiers", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "is_verified", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "verified_at", type: "TIMESTAMPTZ" },
    {
      name: "verification_method",
      type: "TEXT",
      check:
        "verification_method IS NULL OR verification_method IN ('email_link', 'phone_otp', 'in_app_re_authentication', 'government_id_check', 'in_person')",
    },
    { name: "first_seen_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "last_seen_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "node_occurrence_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "node_occurrence_count >= 0",
    },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "data_subjects_tenant_primary_identifier_key",
      columns: ["tenant_id", "primary_identifier_kind", "primary_identifier_sha256"],
    },
  ],
  indexes: [
    {
      name: "idx_data_subjects_tenant_kind",
      columns: ["tenant_id", "primary_identifier_kind"],
    },
    {
      name: "idx_data_subjects_last_seen",
      columns: ["last_seen_at"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "data_subjects_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_SUBJECT_NODE_OCCURRENCES: TableDefinition = {
  schema: "meta",
  name: "subject_node_occurrences",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "occurrence_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "subject_node_occurrences_occurrence_id_key",
      },
      check: "occurrence_id ~ '^sno_[a-z0-9]{8,40}$'",
    },
    {
      name: "subject_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "data_subjects",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    {
      name: "node_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "lineage_nodes",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "first_observed_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "last_observed_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "occurrence_count",
      type: "INTEGER",
      notNull: true,
      default: "1",
      check: "occurrence_count >= 1",
    },
    { name: "columns_containing", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    {
      name: "derived_through_edge_ids",
      type: "JSONB",
      notNull: true,
      default: "'[]'::jsonb",
    },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "subject_node_occurrences_subject_node_key",
      columns: ["subject_id", "node_id"],
    },
  ],
  indexes: [
    {
      name: "idx_subject_node_occurrences_subject",
      columns: ["subject_id"],
    },
    {
      name: "idx_subject_node_occurrences_node",
      columns: ["node_id"],
    },
    {
      name: "idx_subject_node_occurrences_tenant",
      columns: ["tenant_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "subject_node_occurrences_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_SUBJECT_ACCESS_REQUESTS: TableDefinition = {
  schema: "meta",
  name: "subject_access_requests",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "request_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "subject_access_requests_request_id_key" },
      check: "request_id ~ '^sar_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "subject_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "data_subjects",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "legal_basis",
      type: "TEXT",
      notNull: true,
      check:
        "legal_basis IN ('gdpr_article_15', 'ccpa_right_to_know', 'lgpd_article_18', 'pipeda_principle_9', 'uae_data_protection_law', 'custom_contract_obligation')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('submitted', 'verified', 'in_progress', 'partial_complete', 'complete', 'rejected', 'deferred')",
    },
    { name: "submitted_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "submitted_by_contact", type: "TEXT", notNull: true },
    { name: "deadline_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "verified_at", type: "TIMESTAMPTZ" },
    { name: "in_progress_at", type: "TIMESTAMPTZ" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "rejected_at", type: "TIMESTAMPTZ" },
    { name: "rejected_reason", type: "TEXT" },
    { name: "deferred_until", type: "TIMESTAMPTZ" },
    { name: "deferral_reason", type: "TEXT" },
    {
      name: "requested_format",
      type: "TEXT",
      notNull: true,
      check:
        "requested_format IN ('json', 'ndjson', 'csv', 'pdf_report', 'machine_readable_archive')",
    },
    { name: "include_derived_data", type: "BOOLEAN", notNull: true, default: "true" },
    {
      name: "node_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "node_count >= 0",
    },
    {
      name: "edge_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "edge_count >= 0",
    },
    {
      name: "bytes_produced",
      type: "BIGINT",
      check: "bytes_produced IS NULL OR bytes_produced >= 0",
    },
    {
      name: "bundle_sha256",
      type: "CHAR(64)",
      check:
        "bundle_sha256 IS NULL OR bundle_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "bundle_storage_uri", type: "TEXT" },
    {
      name: "bundle_encryption_key_fingerprint",
      type: "CHAR(64)",
      check:
        "bundle_encryption_key_fingerprint IS NULL OR bundle_encryption_key_fingerprint ~ '^[0-9a-f]{64}$'",
    },
    { name: "delivered_at", type: "TIMESTAMPTZ" },
    {
      name: "download_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "download_count >= 0",
    },
    {
      name: "max_downloads",
      type: "INTEGER",
      notNull: true,
      default: "3",
      check: "max_downloads BETWEEN 1 AND 10",
    },
    { name: "notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_subject_access_requests_tenant_status",
      columns: ["tenant_id", "status"],
    },
    {
      name: "idx_subject_access_requests_deadline",
      columns: ["deadline_at"],
    },
    {
      name: "idx_subject_access_requests_subject",
      columns: ["subject_id"],
    },
    {
      name: "idx_subject_access_requests_legal_basis",
      columns: ["legal_basis"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "subject_access_requests_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_RATE_LIMIT_POLICIES: TableDefinition = {
  schema: "meta",
  name: "rate_limit_policies",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "policy_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "rate_limit_policies_policy_id_key" },
      check: "policy_id ~ '^rlp_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    { name: "label", type: "TEXT", notNull: true },
    { name: "description", type: "TEXT", notNull: true },
    {
      name: "version",
      type: "TEXT",
      notNull: true,
      check: "version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('draft', 'active', 'paused', 'deprecated', 'retired')",
    },
    {
      name: "algorithm",
      type: "TEXT",
      notNull: true,
      check:
        "algorithm IN ('token_bucket', 'leaky_bucket', 'fixed_window', 'sliding_window', 'sliding_window_log', 'concurrent_request')",
    },
    { name: "algorithm_params", type: "JSONB", notNull: true },
    { name: "scope", type: "JSONB", notNull: true },
    {
      name: "overage_handling",
      type: "TEXT",
      notNull: true,
      check:
        "overage_handling IN ('hard_block', 'soft_throttle_delay', 'queue_and_serve', 'allow_with_overage_billing', 'allow_with_warning')",
    },
    {
      name: "priority_override",
      type: "TEXT",
      notNull: true,
      default: "'none'",
      check:
        "priority_override IN ('none', 'critical_only', 'high_and_above', 'elevated_principals')",
    },
    {
      name: "soft_throttle_delay_ms_per_overage",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "soft_throttle_delay_ms_per_overage BETWEEN 0 AND 60000",
    },
    {
      name: "queue_max_wait_ms",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "queue_max_wait_ms BETWEEN 0 AND 300000",
    },
    {
      name: "response_code",
      type: "INTEGER",
      notNull: true,
      check: "response_code IN (429, 503)",
    },
    {
      name: "include_retry_after_header",
      type: "BOOLEAN",
      notNull: true,
      default: "true",
    },
    {
      name: "include_rate_limit_headers",
      type: "BOOLEAN",
      notNull: true,
      default: "true",
    },
    { name: "problem_type_uri", type: "TEXT" },
    { name: "enabled_routes", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "excluded_routes", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "exempt_principal_ids", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "exempt_api_key_prefixes", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "activated_at", type: "TIMESTAMPTZ" },
    { name: "activated_by", type: "UUID", references: USER_FK },
    { name: "deprecated_at", type: "TIMESTAMPTZ" },
    { name: "superseded_by_policy_id", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_rate_limit_policies_tenant_status", columns: ["tenant_id", "status"] },
    { name: "idx_rate_limit_policies_algorithm", columns: ["algorithm"] },
    { name: "idx_rate_limit_policies_created_by", columns: ["created_by"] },
    { name: "idx_rate_limit_policies_activated_by", columns: ["activated_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "rate_limit_policies_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_QUOTA_DEFINITIONS: TableDefinition = {
  schema: "meta",
  name: "quota_definitions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "quota_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "quota_definitions_quota_id_key" },
      check: "quota_id ~ '^rlq_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    { name: "label", type: "TEXT", notNull: true },
    {
      name: "target",
      type: "TEXT",
      notNull: true,
      check:
        "target IN ('api_requests', 'ai_tokens', 'storage_bytes', 'compute_seconds', 'notification_dispatches', 'search_queries', 'report_runs', 'ml_training_minutes', 'webhook_deliveries', 'rows_exported')",
    },
    {
      name: "quota_class",
      type: "TEXT",
      notNull: true,
      check:
        "quota_class IN ('free_tier', 'starter', 'pro', 'enterprise', 'internal', 'custom')",
    },
    {
      name: "period",
      type: "TEXT",
      notNull: true,
      check:
        "period IN ('minute', 'hour', 'day', 'week', 'month', 'billing_period', 'lifetime')",
    },
    { name: "hard_limit", type: "BIGINT", notNull: true, check: "hard_limit >= 0" },
    {
      name: "soft_limit",
      type: "BIGINT",
      check: "soft_limit IS NULL OR soft_limit >= 0",
    },
    { name: "overage_allowed", type: "BOOLEAN", notNull: true, default: "false" },
    {
      name: "overage_unit_price_cents",
      type: "BIGINT",
      check:
        "overage_unit_price_cents IS NULL OR overage_unit_price_cents >= 0",
    },
    {
      name: "applies_after_plan_switch_seconds",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "applies_after_plan_switch_seconds BETWEEN 0 AND 86400",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_quota_definitions_tenant_class", columns: ["tenant_id", "quota_class"] },
    { name: "idx_quota_definitions_target", columns: ["target"] },
    { name: "idx_quota_definitions_created_by", columns: ["created_by"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "quota_definitions_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_QUOTA_USAGE: TableDefinition = {
  schema: "meta",
  name: "quota_usage",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "usage_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "quota_usage_usage_id_key" },
      check: "usage_id ~ '^rlu_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "quota_definition_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "quota_definitions",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "target",
      type: "TEXT",
      notNull: true,
      check:
        "target IN ('api_requests', 'ai_tokens', 'storage_bytes', 'compute_seconds', 'notification_dispatches', 'search_queries', 'report_runs', 'ml_training_minutes', 'webhook_deliveries', 'rows_exported')",
    },
    {
      name: "period",
      type: "TEXT",
      notNull: true,
      check:
        "period IN ('minute', 'hour', 'day', 'week', 'month', 'billing_period', 'lifetime')",
    },
    { name: "period_start_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "period_end_at", type: "TIMESTAMPTZ" },
    {
      name: "consumed_units",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "consumed_units >= 0",
    },
    { name: "soft_limit_breached_at", type: "TIMESTAMPTZ" },
    { name: "hard_limit_breached_at", type: "TIMESTAMPTZ" },
    {
      name: "overage_units_consumed",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "overage_units_consumed >= 0",
    },
    { name: "overage_billed_at", type: "TIMESTAMPTZ" },
    { name: "last_updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "quota_usage_tenant_quota_period_key",
      columns: ["tenant_id", "quota_definition_id", "period_start_at"],
    },
  ],
  indexes: [
    {
      name: "idx_quota_usage_tenant_target_period",
      columns: ["tenant_id", "target", "period_start_at"],
    },
    {
      name: "idx_quota_usage_quota_definition",
      columns: ["quota_definition_id"],
    },
    {
      name: "idx_quota_usage_hard_breach",
      columns: ["hard_limit_breached_at"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "quota_usage_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_RATE_LIMIT_DECISIONS: TableDefinition = {
  schema: "meta",
  name: "rate_limit_decisions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "decision_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "rate_limit_decisions_decision_id_key" },
      check: "decision_id ~ '^rld_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "policy_id",
      type: "UUID",
      references: {
        schema: "meta",
        table: "rate_limit_policies",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "quota_definition_id",
      type: "UUID",
      references: {
        schema: "meta",
        table: "quota_definitions",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    { name: "scope_key", type: "TEXT", notNull: true },
    { name: "principal_id", type: "UUID", references: USER_FK },
    {
      name: "api_key_prefix",
      type: "TEXT",
      check:
        "api_key_prefix IS NULL OR api_key_prefix ~ '^ce_(live|test)_[A-Za-z0-9]{8}$'",
    },
    { name: "route", type: "TEXT" },
    { name: "decided_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    {
      name: "outcome",
      type: "TEXT",
      notNull: true,
      check:
        "outcome IN ('allowed', 'allowed_with_warning', 'throttled_soft_delayed', 'denied_rate_limit_exceeded', 'denied_quota_exceeded', 'denied_concurrent_limit', 'denied_global_limit', 'denied_circuit_open', 'bypassed_critical_priority', 'bypassed_exempt_principal')",
    },
    {
      name: "cost_units",
      type: "INTEGER",
      notNull: true,
      default: "1",
      check: "cost_units >= 1",
    },
    { name: "limit_total", type: "BIGINT", notNull: true, check: "limit_total >= 0" },
    {
      name: "remaining_after",
      type: "BIGINT",
      notNull: true,
      check: "remaining_after >= 0",
    },
    { name: "reset_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "retry_after_seconds",
      type: "INTEGER",
      check: "retry_after_seconds IS NULL OR retry_after_seconds >= 0",
    },
    {
      name: "soft_throttle_delay_ms",
      type: "INTEGER",
      check: "soft_throttle_delay_ms IS NULL OR soft_throttle_delay_ms >= 0",
    },
    { name: "applied_headers", type: "JSONB" },
    { name: "problem_details", type: "JSONB" },
    { name: "bypass_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_rate_limit_decisions_tenant_decided",
      columns: ["tenant_id", "decided_at"],
    },
    {
      name: "idx_rate_limit_decisions_policy",
      columns: ["policy_id"],
    },
    {
      name: "idx_rate_limit_decisions_quota_definition",
      columns: ["quota_definition_id"],
    },
    {
      name: "idx_rate_limit_decisions_outcome",
      columns: ["outcome"],
    },
    {
      name: "idx_rate_limit_decisions_scope_key",
      columns: ["scope_key"],
    },
    {
      name: "idx_rate_limit_decisions_principal",
      columns: ["principal_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "rate_limit_decisions_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_RATE_LIMIT_EXCEPTIONS: TableDefinition = {
  schema: "meta",
  name: "rate_limit_exceptions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "exception_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "rate_limit_exceptions_exception_id_key" },
      check: "exception_id ~ '^rle_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "policy_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "rate_limit_policies",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    { name: "scope_key", type: "TEXT", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('principal_overage', 'tenant_burst_allowance', 'scheduled_event_uplift', 'compliance_override', 'incident_response_bypass', 'load_test_temporary')",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('requested', 'approved', 'active', 'expired', 'rejected', 'revoked_early')",
    },
    {
      name: "multiplier",
      type: "NUMERIC(8, 4)",
      notNull: true,
      check: "multiplier BETWEEN 0.1 AND 100",
    },
    {
      name: "additive_burst",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "additive_burst BETWEEN 0 AND 1000000",
    },
    { name: "justification", type: "TEXT", notNull: true },
    { name: "requested_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "requested_by", type: "UUID", notNull: true, references: USER_FK },
    { name: "approved_at", type: "TIMESTAMPTZ" },
    { name: "approved_by", type: "UUID", references: USER_FK },
    { name: "rejected_at", type: "TIMESTAMPTZ" },
    { name: "rejected_by", type: "UUID", references: USER_FK },
    { name: "rejected_reason", type: "TEXT" },
    { name: "activated_at", type: "TIMESTAMPTZ" },
    { name: "expires_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "revoked_early_at", type: "TIMESTAMPTZ" },
    { name: "revoked_early_by", type: "UUID", references: USER_FK },
    { name: "revoked_early_reason", type: "TEXT" },
    { name: "related_incident_id", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_rate_limit_exceptions_tenant_status",
      columns: ["tenant_id", "status"],
    },
    {
      name: "idx_rate_limit_exceptions_policy_scope",
      columns: ["policy_id", "scope_key"],
    },
    {
      name: "idx_rate_limit_exceptions_expires",
      columns: ["expires_at"],
    },
    {
      name: "idx_rate_limit_exceptions_requested_by",
      columns: ["requested_by"],
    },
    {
      name: "idx_rate_limit_exceptions_approved_by",
      columns: ["approved_by"],
    },
    {
      name: "idx_rate_limit_exceptions_rejected_by",
      columns: ["rejected_by"],
    },
    {
      name: "idx_rate_limit_exceptions_revoked_early_by",
      columns: ["revoked_early_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "rate_limit_exceptions_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_THROTTLE_EVENTS: TableDefinition = {
  schema: "meta",
  name: "throttle_events",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "event_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "throttle_events_event_id_key" },
      check: "event_id ~ '^rlt_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('hard_limit_hit', 'soft_limit_hit', 'burst_consumed', 'quota_period_reset', 'policy_activated', 'policy_deactivated', 'exception_approved', 'exception_expired', 'circuit_opened', 'circuit_closed')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "policy_id", type: "TEXT" },
    { name: "quota_definition_id", type: "TEXT" },
    { name: "exception_id", type: "TEXT" },
    { name: "scope_key", type: "TEXT" },
    {
      name: "related_decision_outcome",
      type: "TEXT",
      check:
        "related_decision_outcome IS NULL OR related_decision_outcome IN ('allowed', 'allowed_with_warning', 'throttled_soft_delayed', 'denied_rate_limit_exceeded', 'denied_quota_exceeded', 'denied_concurrent_limit', 'denied_global_limit', 'denied_circuit_open', 'bypassed_critical_priority', 'bypassed_exempt_principal')",
    },
    { name: "actor_principal_id", type: "UUID", references: USER_FK },
    { name: "actor_system_id", type: "TEXT" },
    { name: "payload", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    {
      name: "notification_dispatched",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "incident_declared",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "related_incident_id", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_throttle_events_tenant_occurred",
      columns: ["tenant_id", "occurred_at"],
    },
    {
      name: "idx_throttle_events_kind",
      columns: ["kind"],
    },
    {
      name: "idx_throttle_events_actor",
      columns: ["actor_principal_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "throttle_events_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_GATEWAY_ROUTES: TableDefinition = {
  schema: "meta",
  name: "gateway_routes",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "route_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "gateway_routes_route_id_key" },
      check: "route_id ~ '^rt_[a-z0-9]{8,40}$'",
    },
    {
      name: "operation_id",
      type: "TEXT",
      notNull: true,
      check: "operation_id ~ '^[a-z][a-zA-Z0-9._]*$'",
    },
    {
      name: "method",
      type: "TEXT",
      notNull: true,
      check:
        "method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT')",
    },
    { name: "path_segments", type: "JSONB", notNull: true },
    {
      name: "api_version",
      type: "TEXT",
      notNull: true,
      check: "api_version ~ '^v[0-9]+$'",
    },
    { name: "is_deprecated", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "deprecated_since", type: "TIMESTAMPTZ" },
    { name: "sunset_at", type: "TIMESTAMPTZ" },
    { name: "successor_operation_id", type: "TEXT" },
    {
      name: "required_scopes",
      type: "JSONB",
      notNull: true,
      default: "'[]'::jsonb",
    },
    {
      name: "rate_limit_policy_id",
      type: "TEXT",
      check:
        "rate_limit_policy_id IS NULL OR rate_limit_policy_id ~ '^rlp_[a-z0-9]{8,40}$'",
    },
    {
      name: "idempotency_required",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "request_schema_sha256",
      type: "CHAR(64)",
      check:
        "request_schema_sha256 IS NULL OR request_schema_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "response_schema_sha256",
      type: "CHAR(64)",
      check:
        "response_schema_sha256 IS NULL OR response_schema_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
    {
      name: "source_pack",
      type: "TEXT",
      check:
        "source_pack IS NULL OR source_pack ~ '^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*$'",
    },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "gateway_routes_method_version_operation_key",
      columns: ["method", "api_version", "operation_id"],
    },
  ],
  indexes: [
    {
      name: "idx_gateway_routes_version_method",
      columns: ["api_version", "method"],
    },
    {
      name: "idx_gateway_routes_sunset",
      columns: ["sunset_at"],
    },
    {
      name: "idx_gateway_routes_created_by",
      columns: ["created_by"],
    },
    {
      name: "idx_gateway_routes_source_pack",
      columns: ["source_pack"],
    },
  ],
};

export const META_GATEWAY_IDEMPOTENCY_RECORDS: TableDefinition = {
  schema: "meta",
  name: "gateway_idempotency_records",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "record_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "gateway_idempotency_records_record_id_key",
      },
      check: "record_id ~ '^idem_[A-Za-z0-9_-]{8,64}$'",
    },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "operation_id", type: "TEXT", notNull: true },
    {
      name: "method",
      type: "TEXT",
      notNull: true,
      check: "method IN ('POST', 'PUT', 'PATCH', 'DELETE')",
    },
    {
      name: "idempotency_key",
      type: "TEXT",
      notNull: true,
      check: "idempotency_key ~ '^[A-Za-z0-9_.:-]{8,255}$'",
    },
    {
      name: "request_hash_sha256",
      type: "CHAR(64)",
      notNull: true,
      check: "request_hash_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "principal_id", type: "UUID", references: USER_FK },
    { name: "received_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "expires_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('in_progress', 'completed_success', 'completed_error', 'expired')",
    },
    {
      name: "response_status",
      type: "INTEGER",
      check:
        "response_status IS NULL OR response_status BETWEEN 100 AND 599",
    },
    {
      name: "response_sha256",
      type: "CHAR(64)",
      check:
        "response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "response_storage_uri", type: "TEXT" },
    { name: "completed_at", type: "TIMESTAMPTZ" },
    { name: "error_code", type: "TEXT" },
    { name: "error_message", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "gateway_idempotency_records_tenant_op_key",
      columns: ["tenant_id", "operation_id", "idempotency_key"],
    },
  ],
  indexes: [
    {
      name: "idx_gateway_idempotency_expires",
      columns: ["expires_at"],
    },
    {
      name: "idx_gateway_idempotency_principal",
      columns: ["principal_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "gateway_idempotency_records_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_GATEWAY_PIPELINE_EXECUTIONS: TableDefinition = {
  schema: "meta",
  name: "gateway_pipeline_executions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "request_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "gateway_pipeline_executions_request_id_key",
      },
      check: "request_id ~ '^req_[A-Za-z0-9_-]{8,64}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "completed_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "total_duration_ms",
      type: "INTEGER",
      notNull: true,
      check: "total_duration_ms BETWEEN 0 AND 300000",
    },
    {
      name: "final_stage",
      type: "TEXT",
      notNull: true,
      check:
        "final_stage IN ('receive', 'parse_request', 'validate_tls', 'parse_auth_credential', 'authenticate', 'resolve_principal', 'match_route', 'negotiate_version', 'negotiate_content', 'check_idempotency', 'check_rate_limit', 'validate_request_signature', 'validate_request_schema', 'dispatch_handler', 'transform_response', 'apply_security_headers', 'emit_audit')",
    },
    {
      name: "final_outcome",
      type: "TEXT",
      notNull: true,
      check:
        "final_outcome IN ('pass', 'deny', 'short_circuit_replay', 'redirect', 'fallthrough', 'error')",
    },
    {
      name: "final_response_status",
      type: "INTEGER",
      notNull: true,
      check: "final_response_status BETWEEN 100 AND 599",
    },
    { name: "stages", type: "JSONB", notNull: true },
    {
      name: "auth_outcome",
      type: "TEXT",
      notNull: true,
      check:
        "auth_outcome IN ('anonymous', 'authenticated', 'credential_malformed', 'credential_not_found', 'invalid_signature', 'expired_token', 'not_yet_valid_token', 'audience_mismatch', 'issuer_mismatch', 'principal_not_found', 'principal_disabled', 'principal_locked', 'scope_insufficient', 'mfa_required', 'weak_tls_rejected')",
    },
    {
      name: "route_match_outcome",
      type: "TEXT",
      check:
        "route_match_outcome IS NULL OR route_match_outcome IN ('matched', 'no_route', 'method_not_allowed', 'version_not_supported', 'deprecated_version', 'sunset_version')",
    },
    {
      name: "idempotency_outcome",
      type: "TEXT",
      check:
        "idempotency_outcome IS NULL OR idempotency_outcome IN ('no_key_required', 'no_key_provided', 'first_seen', 'replay_hit_match', 'replay_hit_mismatch', 'replay_in_progress', 'replay_expired', 'replay_not_allowed_for_method')",
    },
    { name: "principal_id", type: "UUID", references: USER_FK },
    { name: "route_operation_id", type: "TEXT" },
    {
      name: "resolved_api_version",
      type: "TEXT",
      check:
        "resolved_api_version IS NULL OR resolved_api_version ~ '^v[0-9]+$'",
    },
    { name: "correlation_id", type: "TEXT" },
    { name: "rate_limit_decision_id", type: "TEXT" },
    {
      name: "bytes_in",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "bytes_in >= 0",
    },
    {
      name: "bytes_out",
      type: "BIGINT",
      notNull: true,
      default: "0",
      check: "bytes_out >= 0",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_gateway_pipeline_tenant_started",
      columns: ["tenant_id", "started_at"],
    },
    {
      name: "idx_gateway_pipeline_final_outcome",
      columns: ["final_outcome"],
    },
    {
      name: "idx_gateway_pipeline_auth_outcome",
      columns: ["auth_outcome"],
    },
    {
      name: "idx_gateway_pipeline_principal",
      columns: ["principal_id"],
    },
    {
      name: "idx_gateway_pipeline_operation",
      columns: ["route_operation_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "gateway_pipeline_executions_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_FEATURE_FLAG_TARGETING_RULES: TableDefinition = {
  schema: "meta",
  name: "feature_flag_targeting_rules",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "rule_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "feature_flag_targeting_rules_rule_id_key",
      },
      check: "rule_id ~ '^ftr_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "flag_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "feature_flags",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    {
      name: "priority",
      type: "INTEGER",
      notNull: true,
      check: "priority BETWEEN 0 AND 1000",
    },
    { name: "label", type: "TEXT", notNull: true },
    { name: "condition", type: "JSONB", notNull: true },
    {
      name: "served_variant_key",
      type: "TEXT",
      check:
        "served_variant_key IS NULL OR served_variant_key ~ '^[a-z][a-z0-9_]*$'",
    },
    { name: "served_value_json", type: "TEXT" },
    { name: "is_exclusion", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "description", type: "TEXT" },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "created_by", type: "UUID", notNull: true, references: USER_FK },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_feature_flag_targeting_rules_flag_priority",
      columns: ["flag_id", "priority"],
    },
    {
      name: "idx_feature_flag_targeting_rules_tenant",
      columns: ["tenant_id"],
    },
    {
      name: "idx_feature_flag_targeting_rules_created_by",
      columns: ["created_by"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "feature_flag_targeting_rules_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_FEATURE_FLAG_KILL_SWITCHES: TableDefinition = {
  schema: "meta",
  name: "feature_flag_kill_switches",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "kill_switch_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "feature_flag_kill_switches_kill_switch_id_key",
      },
      check: "kill_switch_id ~ '^fks_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "flag_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "feature_flags",
        column: "id",
        onDelete: "RESTRICT",
      },
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      check:
        "status IN ('armed', 'triggered_active', 'released', 'expired')",
    },
    {
      name: "trigger_kind",
      type: "TEXT",
      notNull: true,
      check:
        "trigger_kind IN ('manual_admin', 'incident_response', 'security_event', 'data_quality_alert', 'performance_degradation', 'vendor_outage', 'compliance_directive', 'automated_metric_breach')",
    },
    { name: "justification", type: "TEXT", notNull: true },
    { name: "armed_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "armed_by_user_id", type: "UUID", notNull: true, references: USER_FK },
    { name: "triggered_at", type: "TIMESTAMPTZ" },
    { name: "triggered_by_user_id", type: "UUID", references: USER_FK },
    { name: "co_triggered_by_user_id", type: "UUID", references: USER_FK },
    { name: "co_triggered_at", type: "TIMESTAMPTZ" },
    { name: "expires_at", type: "TIMESTAMPTZ" },
    { name: "released_at", type: "TIMESTAMPTZ" },
    { name: "released_by_user_id", type: "UUID", references: USER_FK },
    { name: "released_reason", type: "TEXT" },
    { name: "expired_at", type: "TIMESTAMPTZ" },
    { name: "related_incident_id", type: "TEXT" },
    { name: "overridden_value_json", type: "TEXT", notNull: true },
    { name: "impact_scope_notes", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_feature_flag_kill_switches_flag_status",
      columns: ["flag_id", "status"],
    },
    {
      name: "idx_feature_flag_kill_switches_tenant",
      columns: ["tenant_id"],
    },
    {
      name: "idx_feature_flag_kill_switches_armed_by",
      columns: ["armed_by_user_id"],
    },
    {
      name: "idx_feature_flag_kill_switches_triggered_by",
      columns: ["triggered_by_user_id"],
    },
    {
      name: "idx_feature_flag_kill_switches_co_triggered_by",
      columns: ["co_triggered_by_user_id"],
    },
    {
      name: "idx_feature_flag_kill_switches_released_by",
      columns: ["released_by_user_id"],
    },
    {
      name: "idx_feature_flag_kill_switches_expires",
      columns: ["expires_at"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "feature_flag_kill_switches_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_FEATURE_FLAG_EVALUATIONS: TableDefinition = {
  schema: "meta",
  name: "feature_flag_evaluations",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "evaluation_id",
      type: "TEXT",
      notNull: true,
      unique: {
        constraintName: "feature_flag_evaluations_evaluation_id_key",
      },
      check: "evaluation_id ~ '^fev_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "flag_key",
      type: "TEXT",
      notNull: true,
      check: "flag_key ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$'",
    },
    { name: "flag_id", type: "TEXT" },
    {
      name: "flag_version",
      type: "TEXT",
      check:
        "flag_version IS NULL OR flag_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
    },
    {
      name: "environment",
      type: "TEXT",
      notNull: true,
      check:
        "environment IN ('preview', 'staging', 'production', 'sandbox')",
    },
    { name: "principal_id", type: "UUID", references: USER_FK },
    { name: "session_id", type: "TEXT" },
    { name: "evaluated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    {
      name: "evaluation_latency_us",
      type: "INTEGER",
      notNull: true,
      check: "evaluation_latency_us BETWEEN 0 AND 10000000",
    },
    {
      name: "reason",
      type: "TEXT",
      notNull: true,
      check:
        "reason IN ('default_returned', 'kill_switch_active', 'flag_not_found', 'flag_archived', 'flag_paused', 'flag_disabled_for_environment', 'specific_principal_match', 'specific_tenant_match', 'tenant_attribute_match', 'principal_attribute_match', 'percentage_bucket_match', 'segment_match', 'custom_predicate_match', 'exclusion_rule_hit', 'fallthrough_to_default', 'error_returned_default', 'expired_returned_default')",
    },
    { name: "matched_rule_id", type: "TEXT" },
    { name: "matched_segment_id", type: "TEXT" },
    { name: "served_variant_key", type: "TEXT" },
    { name: "served_value_json", type: "TEXT", notNull: true },
    { name: "kill_switch_id", type: "TEXT" },
    {
      name: "bucketing_value_sha256",
      type: "CHAR(64)",
      check:
        "bucketing_value_sha256 IS NULL OR bucketing_value_sha256 ~ '^[0-9a-f]{64}$'",
    },
    { name: "request_id", type: "TEXT" },
    { name: "correlation_id", type: "TEXT" },
    { name: "is_sampled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "error_code", type: "TEXT" },
    { name: "error_message", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_feature_flag_evaluations_tenant_evaluated",
      columns: ["tenant_id", "evaluated_at"],
    },
    {
      name: "idx_feature_flag_evaluations_flag_key",
      columns: ["flag_key"],
    },
    {
      name: "idx_feature_flag_evaluations_reason",
      columns: ["reason"],
    },
    {
      name: "idx_feature_flag_evaluations_principal",
      columns: ["principal_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "feature_flag_evaluations_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_FEATURE_FLAG_CHANGES: TableDefinition = {
  schema: "meta",
  name: "feature_flag_changes",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "change_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "feature_flag_changes_change_id_key" },
      check: "change_id ~ '^fch_[a-z0-9]{8,40}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "flag_id",
      type: "UUID",
      notNull: true,
      references: {
        schema: "meta",
        table: "feature_flags",
        column: "id",
        onDelete: "CASCADE",
      },
    },
    {
      name: "flag_key",
      type: "TEXT",
      notNull: true,
      check: "flag_key ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$'",
    },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('flag_created', 'flag_updated_metadata', 'flag_activated', 'flag_paused', 'flag_archived', 'default_value_changed', 'killed_value_changed', 'variant_added', 'variant_removed', 'variant_weight_changed', 'targeting_rule_added', 'targeting_rule_removed', 'targeting_rule_updated', 'rollout_stage_advanced', 'rollout_stage_paused', 'rollout_rolled_back', 'kill_switch_armed', 'kill_switch_triggered', 'kill_switch_released', 'segment_added', 'segment_updated', 'owner_transferred', 'expires_at_extended')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true },
    { name: "actor_user_id", type: "UUID", references: USER_FK },
    { name: "actor_system_id", type: "TEXT" },
    { name: "co_actor_user_id", type: "UUID", references: USER_FK },
    { name: "co_actor_attested_at", type: "TIMESTAMPTZ" },
    { name: "before_value_json", type: "TEXT" },
    { name: "after_value_json", type: "TEXT" },
    { name: "change_reason", type: "TEXT", notNull: true },
    { name: "related_deployment_id", type: "TEXT" },
    { name: "related_incident_id", type: "TEXT" },
    { name: "related_targeting_rule_id", type: "TEXT" },
    { name: "related_kill_switch_id", type: "TEXT" },
    {
      name: "outcome",
      type: "TEXT",
      notNull: true,
      check:
        "outcome IN ('succeeded', 'rolled_back', 'blocked_by_policy', 'blocked_by_four_eyes')",
    },
    {
      name: "required_four_eyes",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    {
      name: "four_eyes_attested",
      type: "BOOLEAN",
      notNull: true,
      default: "false",
    },
    { name: "blocked_reason", type: "TEXT" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_feature_flag_changes_flag_occurred",
      columns: ["flag_id", "occurred_at"],
    },
    {
      name: "idx_feature_flag_changes_tenant",
      columns: ["tenant_id"],
    },
    {
      name: "idx_feature_flag_changes_kind",
      columns: ["kind"],
    },
    {
      name: "idx_feature_flag_changes_actor",
      columns: ["actor_user_id"],
    },
    {
      name: "idx_feature_flag_changes_co_actor",
      columns: ["co_actor_user_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "feature_flag_changes_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_CRYPTO_KEYS: TableDefinition = {
  schema: "meta",
  name: "crypto_keys",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    {
      name: "key_id",
      type: "TEXT",
      notNull: true,
      unique: { constraintName: "crypto_keys_key_id_key" },
      check:
        "key_id ~ '^key_(hmac-sha256|ed25519)_[0-9A-HJKMNP-TV-Z]{26}$'",
    },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "algorithm",
      type: "TEXT",
      notNull: true,
      check: "algorithm IN ('hmac-sha256', 'ed25519')",
    },
    {
      name: "purpose",
      type: "TEXT",
      notNull: true,
      check:
        "purpose IN ('pack_signing', 'webhook_signing', 'evidence_sealing', 'tombstone_anchoring')",
    },
    { name: "public_key_base64", type: "TEXT" },
    {
      name: "fingerprint_sha256",
      type: "CHAR(64)",
      check: "fingerprint_sha256 IS NULL OR fingerprint_sha256 ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "key_version",
      type: "INTEGER",
      notNull: true,
      default: "1",
      check: "key_version >= 1",
    },
    {
      name: "status",
      type: "TEXT",
      notNull: true,
      default: "'active'",
      check: "status IN ('active', 'rotating', 'revoked')",
    },
    {
      name: "rotated_from_key_id",
      type: "UUID",
      references: {
        schema: "meta",
        table: "crypto_keys",
        column: "id",
        onDelete: "SET NULL",
      },
    },
    { name: "created_by_user_id", type: "UUID", references: USER_FK },
    {
      name: "created_at",
      type: "TIMESTAMPTZ",
      notNull: true,
      default: "now()",
    },
    { name: "rotated_at", type: "TIMESTAMPTZ" },
    { name: "revoked_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_crypto_keys_tenant", columns: ["tenant_id"] },
    { name: "idx_crypto_keys_purpose", columns: ["purpose"] },
    { name: "idx_crypto_keys_status", columns: ["status"] },
    { name: "idx_crypto_keys_rotated_from", columns: ["rotated_from_key_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "crypto_keys_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_CRYPTO_AUDIT: TableDefinition = {
  schema: "meta",
  name: "crypto_audit",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", references: TENANT_FK },
    {
      name: "key_id",
      type: "TEXT",
      check:
        "key_id IS NULL OR key_id ~ '^key_(hmac-sha256|ed25519)_[0-9A-HJKMNP-TV-Z]{26}$'",
    },
    {
      name: "algorithm",
      type: "TEXT",
      check: "algorithm IS NULL OR algorithm IN ('hmac-sha256', 'ed25519')",
    },
    {
      name: "purpose",
      type: "TEXT",
      check:
        "purpose IS NULL OR purpose IN ('pack_signing', 'webhook_signing', 'evidence_sealing', 'tombstone_anchoring')",
    },
    {
      name: "operation",
      type: "TEXT",
      notNull: true,
      check:
        "operation IN ('sign', 'verify', 'hmac', 'verify_hmac', 'hash', 'create_key', 'rotate_key', 'destroy_key', 'get_public')",
    },
    { name: "principal_user_id", type: "UUID", references: USER_FK },
    { name: "succeeded", type: "BOOLEAN", notNull: true },
    { name: "error_message", type: "TEXT" },
    {
      name: "duration_ms",
      type: "INTEGER",
      notNull: true,
      check: "duration_ms >= 0",
    },
    {
      name: "performed_at",
      type: "TIMESTAMPTZ",
      notNull: true,
      default: "now()",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_crypto_audit_tenant", columns: ["tenant_id"] },
    { name: "idx_crypto_audit_key", columns: ["key_id"] },
    { name: "idx_crypto_audit_operation", columns: ["operation"] },
    { name: "idx_crypto_audit_performed_at", columns: ["performed_at"] },
    { name: "idx_crypto_audit_principal", columns: ["principal_user_id"] },
  ],
  rls: {
    enabled: true,
    policies: [
      {
        name: "crypto_audit_tenant_or_platform",
        using:
          "tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID",
      },
    ],
  },
};

export const META_ARCHITECT_SESSIONS: TableDefinition = {
  schema: "meta",
  name: "architect_sessions",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "session_id", type: "TEXT", notNull: true },
    { name: "model", type: "TEXT", notNull: true },
    { name: "system_prompt_sha256", type: "CHAR(64)" },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "ended_at", type: "TIMESTAMPTZ" },
    {
      name: "turn_count",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "turn_count >= 0",
    },
    {
      name: "input_tokens",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "input_tokens >= 0",
    },
    {
      name: "output_tokens",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "output_tokens >= 0",
    },
    {
      name: "cached_input_tokens",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "cached_input_tokens >= 0",
    },
    {
      name: "cost_usd",
      type: "NUMERIC(12, 6)",
      notNull: true,
      default: "0",
      check: "cost_usd >= 0",
    },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [
    {
      name: "architect_sessions_tenant_session_key",
      columns: ["tenant_id", "session_id"],
    },
  ],
  indexes: [
    { name: "idx_architect_sessions_tenant_started", columns: ["tenant_id", "started_at"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "architect_sessions_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_ARCHITECT_MESSAGES: TableDefinition = {
  schema: "meta",
  name: "architect_messages",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "session_id",
      type: "UUID",
      notNull: true,
      references: { schema: "meta", table: "architect_sessions", column: "id" },
    },
    {
      name: "turn_index",
      type: "INTEGER",
      notNull: true,
      check: "turn_index >= 0",
    },
    {
      name: "message_index",
      type: "INTEGER",
      notNull: true,
      check: "message_index >= 0",
    },
    {
      name: "role",
      type: "TEXT",
      notNull: true,
      check: "role IN ('system', 'user', 'assistant', 'tool')",
    },
    { name: "content", type: "TEXT", notNull: true },
    { name: "tool_call_id", type: "TEXT" },
    { name: "tool_uses", type: "JSONB" },
    {
      name: "input_tokens",
      type: "INTEGER",
      check: "input_tokens IS NULL OR input_tokens >= 0",
    },
    {
      name: "output_tokens",
      type: "INTEGER",
      check: "output_tokens IS NULL OR output_tokens >= 0",
    },
    {
      name: "cached_input_tokens",
      type: "INTEGER",
      check: "cached_input_tokens IS NULL OR cached_input_tokens >= 0",
    },
    {
      name: "cost_usd",
      type: "NUMERIC(12, 6)",
      check: "cost_usd IS NULL OR cost_usd >= 0",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_architect_messages_session", columns: ["session_id", "turn_index", "message_index"] },
    { name: "idx_architect_messages_tenant_created", columns: ["tenant_id", "created_at"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "architect_messages_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_ARCHITECT_TOOL_INVOCATIONS: TableDefinition = {
  schema: "meta",
  name: "architect_tool_invocations",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "session_id",
      type: "UUID",
      notNull: true,
      references: { schema: "meta", table: "architect_sessions", column: "id" },
    },
    {
      name: "message_id",
      type: "UUID",
      references: { schema: "meta", table: "architect_messages", column: "id" },
    },
    { name: "tool_call_id", type: "TEXT", notNull: true },
    { name: "tool_name", type: "TEXT", notNull: true },
    { name: "input", type: "JSONB", notNull: true },
    { name: "output", type: "TEXT", notNull: true },
    { name: "is_error", type: "BOOLEAN", notNull: true, default: "false" },
    {
      name: "duration_ms",
      type: "INTEGER",
      check: "duration_ms IS NULL OR duration_ms >= 0",
    },
    { name: "started_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_architect_tool_invocations_session", columns: ["session_id", "started_at"] },
    { name: "idx_architect_tool_invocations_tool_name", columns: ["tool_name"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "architect_tool_invocations_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_ARCHITECT_PROPOSALS: TableDefinition = {
  schema: "meta",
  name: "architect_proposals",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "session_id",
      type: "UUID",
      notNull: true,
      references: { schema: "meta", table: "architect_sessions", column: "id" },
    },
    {
      name: "tool_invocation_id",
      type: "UUID",
      references: { schema: "meta", table: "architect_tool_invocations", column: "id" },
    },
    { name: "target_path", type: "TEXT", notNull: true },
    { name: "is_new", type: "BOOLEAN", notNull: true },
    { name: "old_hash", type: "CHAR(64)" },
    { name: "new_hash", type: "CHAR(64)", notNull: true },
    {
      name: "entities_added",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "entities_added >= 0",
    },
    {
      name: "entities_removed",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "entities_removed >= 0",
    },
    {
      name: "entities_modified",
      type: "INTEGER",
      notNull: true,
      default: "0",
      check: "entities_modified >= 0",
    },
    {
      name: "decision",
      type: "TEXT",
      notNull: true,
      check:
        "decision IN ('auto_approved', 'interactive_approved', 'interactive_denied', 'no_changes', 'invalid_manifest')",
    },
    { name: "applied", type: "BOOLEAN", notNull: true, default: "false" },
    { name: "denial_reason", type: "TEXT" },
    { name: "proposed_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "decided_at", type: "TIMESTAMPTZ" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_architect_proposals_session", columns: ["session_id", "proposed_at"] },
    { name: "idx_architect_proposals_target_path", columns: ["target_path"] },
    { name: "idx_architect_proposals_decision", columns: ["decision"] },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "architect_proposals_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_LLM_COST_WINDOWS: TableDefinition = {
  schema: "meta",
  name: "llm_cost_windows",
  columns: [
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "window_start_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "window_cost_usd",
      type: "NUMERIC(18,8)",
      notNull: true,
      check: "window_cost_usd >= 0",
    },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tenant_id"],
  rls: {
    enabled: true,
    policies: [
      { name: "llm_cost_windows_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_LLM_COST_TIERS: TableDefinition = {
  schema: "meta",
  name: "llm_cost_tiers",
  columns: [
    {
      name: "tier_id",
      type: "TEXT",
      notNull: true,
      check: "tier_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'",
    },
    { name: "display_name", type: "TEXT", notNull: true },
    {
      name: "max_usd_per_request",
      type: "NUMERIC(18,8)",
      check: "max_usd_per_request IS NULL OR max_usd_per_request > 0",
    },
    {
      name: "max_usd_per_window",
      type: "NUMERIC(18,8)",
      check: "max_usd_per_window IS NULL OR max_usd_per_window > 0",
    },
    {
      name: "window_seconds",
      type: "INTEGER",
      check: "window_seconds IS NULL OR window_seconds > 0",
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tier_id"],
};

export const META_LLM_TENANT_TIER_MEMBERSHIPS: TableDefinition = {
  schema: "meta",
  name: "llm_tenant_tier_memberships",
  columns: [
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "tier_id",
      type: "TEXT",
      notNull: true,
      references: {
        schema: "meta",
        table: "llm_cost_tiers",
        column: "tier_id",
        onDelete: "RESTRICT",
      },
    },
    { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tenant_id"],
  rls: {
    enabled: true,
    policies: [
      {
        name: "llm_tenant_tier_memberships_isolation",
        using: TENANT_ISOLATION_USING,
      },
    ],
  },
};

export const META_RETENTION_POLICIES: TableDefinition = {
  schema: "meta",
  name: "retention_policies",
  columns: [
    {
      name: "table_name",
      type: "TEXT",
      notNull: true,
      check:
        "table_name IN ('workflow_traces', 'llm_latency_samples', 'llm_call_traces')",
    },
    {
      name: "retention_days",
      type: "INTEGER",
      notNull: true,
      check: "retention_days >= 1",
    },
    { name: "enabled", type: "BOOLEAN", notNull: true, default: "true" },
    { name: "last_pruned_at", type: "TIMESTAMPTZ" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["table_name"],
};

export const META_LLM_CALL_TRACES: TableDefinition = {
  schema: "meta",
  name: "llm_call_traces",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "provider_id", type: "TEXT", notNull: true },
    { name: "model_id", type: "TEXT", notNull: true },
    { name: "task", type: "TEXT", notNull: true },
    { name: "session_id", type: "TEXT", notNull: true },
    {
      name: "kind",
      type: "TEXT",
      notNull: true,
      check:
        "kind IN ('llm_call_started', 'llm_call_completed', 'llm_call_failed')",
    },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true },
    {
      name: "duration_ms",
      type: "INTEGER",
      check: "duration_ms IS NULL OR duration_ms >= 0",
    },
    { name: "attributes", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
    {
      name: "created_at",
      type: "TIMESTAMPTZ",
      notNull: true,
      default: "now()",
    },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_llm_call_traces_tenant_occurred",
      columns: ["tenant_id", "occurred_at"],
    },
    {
      name: "idx_llm_call_traces_provider_kind_occurred",
      columns: ["provider_id", "kind", "occurred_at"],
    },
    {
      name: "idx_llm_call_traces_session",
      columns: ["tenant_id", "session_id"],
    },
  ],
  rls: {
    enabled: true,
    policies: [
      { name: "llm_call_traces_tenant_isolation", using: TENANT_ISOLATION_USING },
    ],
  },
};

export const META_LLM_LATENCY_SAMPLES: TableDefinition = {
  schema: "meta",
  name: "llm_latency_samples",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "provider_id", type: "TEXT", notNull: true },
    {
      name: "latency_ms",
      type: "INTEGER",
      notNull: true,
      check: "latency_ms >= 0",
    },
    { name: "success", type: "BOOLEAN", notNull: true },
    { name: "recorded_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    {
      name: "idx_llm_latency_samples_provider_recorded",
      columns: ["provider_id", "recorded_at"],
    },
  ],
};

export const META_LLM_COST_CEILINGS: TableDefinition = {
  schema: "meta",
  name: "llm_cost_ceilings",
  columns: [
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    {
      name: "max_usd_per_request",
      type: "NUMERIC(18,8)",
      check: "max_usd_per_request IS NULL OR max_usd_per_request > 0",
    },
    {
      name: "max_usd_per_window",
      type: "NUMERIC(18,8)",
      check: "max_usd_per_window IS NULL OR max_usd_per_window > 0",
    },
    {
      name: "window_seconds",
      type: "INTEGER",
      check: "window_seconds IS NULL OR window_seconds > 0",
    },
    { name: "effective_from", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "updated_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
  ],
  primaryKey: ["tenant_id"],
  rls: {
    enabled: true,
    policies: [
      {
        name: "llm_cost_ceilings_tenant_isolation",
        using: TENANT_ISOLATION_USING,
      },
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
  META_TENANT_LIFECYCLE_EVENTS,
  META_GDPR_DELETION_REQUESTS,
  META_TENANT_DATA_EXPORTS,
  META_TENANT_TOMBSTONES,
  META_INCIDENTS,
  META_INCIDENT_RUNBOOK_EXECUTIONS,
  META_INCIDENT_POSTMORTEMS,
  META_INCIDENT_COMMUNICATIONS,
  META_FORENSIC_EVIDENCE,
  META_CHAIN_OF_CUSTODY,
  META_LEGAL_HOLDS,
  META_EDISCOVERY_REQUESTS,
  META_AA_TOPOLOGY,
  META_AA_CONFLICTS,
  META_AA_SPLIT_BRAIN_EVENTS,
  META_SDK_CLIENT_RELEASES,
  META_SDK_CLIENT_INSTALLATIONS,
  META_SSO_PROVIDERS,
  META_SSO_LOGINS,
  META_SSO_SESSIONS,
  META_SCIM_CLIENTS,
  META_SCIM_PROVISIONING,
  META_NOTIFICATION_TEMPLATES,
  META_NOTIFICATION_PREFERENCES,
  META_NOTIFICATION_SUPPRESSIONS,
  META_NOTIFICATION_DISPATCHES,
  META_NOTIFICATION_DELIVERIES,
  META_NOTIFICATION_DIGESTS,
  META_ACCESS_REVIEW_TEMPLATES,
  META_ACCESS_REVIEW_CAMPAIGNS,
  META_ACCESS_REVIEW_ITEMS,
  META_ACCESS_REVIEW_DECISIONS,
  META_ACCESS_REVIEW_EXCEPTIONS,
  META_ACCESS_REVIEW_EVIDENCE,
  META_WORKFLOW_DEFINITIONS,
  META_WORKFLOW_INSTANCES,
  META_WORKFLOW_ACTIVITIES,
  META_WORKFLOW_SIGNALS,
  META_WORKFLOW_TIMERS,
  META_WORKFLOW_EVENTS,
  META_WORKFLOW_TRACES,
  META_LINEAGE_NODES,
  META_LINEAGE_EDGES,
  META_PROVENANCE_RECORDS,
  META_DATA_SUBJECTS,
  META_SUBJECT_NODE_OCCURRENCES,
  META_SUBJECT_ACCESS_REQUESTS,
  META_RATE_LIMIT_POLICIES,
  META_QUOTA_DEFINITIONS,
  META_QUOTA_USAGE,
  META_RATE_LIMIT_DECISIONS,
  META_RATE_LIMIT_EXCEPTIONS,
  META_THROTTLE_EVENTS,
  META_GATEWAY_ROUTES,
  META_GATEWAY_IDEMPOTENCY_RECORDS,
  META_GATEWAY_PIPELINE_EXECUTIONS,
  META_FEATURE_FLAG_TARGETING_RULES,
  META_FEATURE_FLAG_KILL_SWITCHES,
  META_FEATURE_FLAG_EVALUATIONS,
  META_FEATURE_FLAG_CHANGES,
  META_CRYPTO_KEYS,
  META_CRYPTO_AUDIT,
  META_ARCHITECT_SESSIONS,
  META_ARCHITECT_MESSAGES,
  META_ARCHITECT_TOOL_INVOCATIONS,
  META_ARCHITECT_PROPOSALS,
  META_LLM_COST_WINDOWS,
  META_LLM_COST_CEILINGS,
  META_LLM_COST_TIERS,
  META_LLM_TENANT_TIER_MEMBERSHIPS,
  META_LLM_LATENCY_SAMPLES,
  META_LLM_CALL_TRACES,
  META_RETENTION_POLICIES,
];
