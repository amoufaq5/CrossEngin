# ADR-0170: META_TENANT_RETENTION_OPT_OUT_HISTORY append-only audit log (Phase 2 M6.7.zz.tenant.opt-out.history)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0155 (META_TENANT_RETENTION_POLICIES), ADR-0161 (opt_out_reason), ADR-0162 (opt_out_until), ADR-0166 (opt-out/opt-in mutation CLI), ADR-0167 (list-policies CLI), ADR-0168 (retention set CLI), ADR-0169 (retention delete CLI) |

## Context

ADRs 0160-0169 shipped the per-tenant retention substrate + a complete CRUD CLI (8 actions). But the **audit story** still has gaps:

- "Who set this opt-out and when?" — only `updated_at` on the live row, no actor attribution.
- "What was the state before this change?" — only the current row, no history.
- "When did tenant X transition from opt-out to active retention?" — invisible without checking PG audit logs.

Six prior ADRs lined up the answer:

- ADR-0161 alt-1: separate audit table for opt-out history
- ADR-0162 Q7: history-aware queries via append-only history table
- ADR-0166 Q1, Q2: audit columns (set_by, set_at) + history table
- ADR-0167 Q3: --include-history flag pairing with deferred history table
- ADR-0168 Q6: audit columns pairing with history table
- ADR-0169 audit-log Q + restore Q: pre-deletion state preservation

M6.7.zz.tenant.opt-out.history ships the append-only history table + auto-writes from all four mutation methods + a query method + CLI surface. Six Qs closed in one milestone.

## Decision

### Schema: META_TENANT_RETENTION_OPT_OUT_HISTORY (table 129)

```ts
{
  schema: "meta",
  name: "tenant_retention_opt_out_history",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true, references: TENANT_FK },
    { name: "table_name", type: "TEXT", notNull: true },
    { name: "event_kind", type: "TEXT", notNull: true,
      check: "event_kind IN ('opt_out_set', 'opt_out_cleared', 'retention_set', 'policy_deleted')" },
    { name: "actor_id", type: "UUID" },
    { name: "occurred_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
    { name: "prev_state", type: "JSONB" },
    { name: "next_state", type: "JSONB" },
    { name: "attributes", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "...tenant_idx", columns: ["tenant_id", "occurred_at"] },
    { name: "...table_idx", columns: ["table_name", "occurred_at"] },
    { name: "...kind_idx", columns: ["event_kind", "occurred_at"] },
  ],
  rls: { enabled: true, policies: [...tenant isolation] },
}
```

**Append-only by convention.** No `UPDATE` or `DELETE` SQL surfaces in the adapter. Retention sweeps on the history table itself are a future Q.

**PK on `id` UUID v7** rather than `(tenant_id, table_name, occurred_at)` — same (tenant, table) pair can have multiple events at the same instant (concurrent CLI runs); UUID v7 gives time-ordered rows for natural sort + collision-free identity.

**Three indexes** serving the canonical operator queries: per-tenant timeline, per-table timeline, per-kind analytics. Each index ordered by `occurred_at` for the "latest events first" pagination.

**RLS tenant-isolated** — history rows belong to the tenant whose policy was mutated. Compliance audits with tenant scoping use the standard `app.current_tenant_id` session var.

### Event kinds (4)

- `opt_out_set` — emitted by `setTenantOptOut`
- `opt_out_cleared` — emitted by `clearTenantOptOut`
- `retention_set` — emitted by `setTenantRetention`
- `policy_deleted` — emitted by `deleteTenantPolicy`

Exported as `OPT_OUT_HISTORY_EVENT_KINDS` const tuple + `OptOutHistoryEventKind` type + `isOptOutHistoryEventKind` predicate. Pattern mirrors workflow runtime kinds + router instrumentation kinds.

### Atomic write via CTE

Each mutation method writes the history row in the SAME SQL statement as the policy mutation. CTE chain:

```sql
WITH existing AS (
  SELECT ... FROM meta.tenant_retention_policies
  WHERE tenant_id = $1 AND table_name = $2
),
mutation AS (
  INSERT INTO meta.tenant_retention_policies (...)
  VALUES (...)
  ON CONFLICT (tenant_id, table_name) DO UPDATE SET ...
  RETURNING ...
),
history AS (
  INSERT INTO meta.tenant_retention_opt_out_history
    (tenant_id, table_name, event_kind, actor_id,
     prev_state, next_state, attributes)
  SELECT m.tenant_id, m.table_name, 'opt_out_set', $6,
         (SELECT to_jsonb(e.*) FROM existing e),
         to_jsonb(m.*),
         $7::jsonb
  FROM mutation m
)
SELECT * FROM mutation
```

PG guarantees CTE-in-single-statement atomicity. No race window between policy change and history write. No need for an outer transaction. No history-write-failed-after-mutation-succeeded class of bugs.

### prev_state / next_state semantics

- **INSERT (new row)**: `prev_state = NULL`, `next_state = row`. The `existing` CTE returns empty; the inner SELECT produces NULL.
- **INSERT...ON CONFLICT DO UPDATE**: `prev_state = pre-mutation row`, `next_state = post-mutation row`. The `existing` CTE captures the pre-state snapshot at statement start.
- **DELETE**: `prev_state = deleted row`, `next_state = NULL`. The `DELETE ... RETURNING` provides the pre-state.

Operators reconstructing a tenant's full retention history walk events ordered by `occurred_at`. Each event answers "what did the row look like just before, and what does it look like now?"

### Adapter mutation method signature changes

Four methods (`setTenantOptOut`, `clearTenantOptOut`, `setTenantRetention`, `deleteTenantPolicy`) gain two optional input fields:

```ts
{
  ...
  actorId?: string | null;       // UUID; null when omitted (CLI / system actors)
  attributes?: Record<string, unknown>;  // arbitrary JSONB metadata
}
```

The CLI threads `--actor <uuid>` through to `actorId` on all four mutation actions. `attributes` is operator-extensible — application code can pass `{source: "cli", correlationId: "req_abc", ...}` for richer audit context.

### Query surface: `listOptOutHistory(input)`

```ts
async listOptOutHistory(input: ListOptOutHistoryInput = {}): Promise<OptOutHistoryEntry[]>;

interface ListOptOutHistoryInput {
  readonly tenantId?: string;
  readonly tableName?: string;
  readonly eventKind?: OptOutHistoryEventKind;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;  // default 100
}
```

Five orthogonal filters (all optional) compose via WHERE-clause AND. Default limit 100. Sorted by `occurred_at DESC` (latest first). All filter values validated at the boundary; `limit` validated as integer >= 1.

Strict event_kind validation on returned rows — unknown kinds throw at the adapter boundary (defensive against schema drift between adapter and DB).

### CLI: `crossengin retention history`

```
crossengin retention history [--tenant <uuid>] [--table <name>]
                             [--kind <event-kind>]
                             [--since DATE] [--until DATE]
                             [--limit N]
                             [--format human|json]
```

All flags optional. CLI-side validation:
- `--kind` against the 4-value tuple (exit 2 on invalid)
- `--since` / `--until` parsed via `Date.parse()` and normalised to canonical ISO 8601 (exit 2 on invalid)
- `--limit` integer >= 1 (exit 2 on invalid)

Human output is a single-row-per-event table:
```
Retention history (N entries, limit 100):
  2026-05-21T10:00:00.000Z  opt_out_set      tenant=<uuid>  table=workflow_traces  actor=<uuid>
  2026-05-20T12:00:00.000Z  retention_set    tenant=<uuid>  table=workflow_traces  actor=<system>
```

`<system>` placeholder for null actorId — distinguishes operator-initiated changes from system / unattributed events.

JSON output emits envelope `{tenantFilter, tableFilter, eventKind, since, until, limit, count, entries}` — every filter value echoed for downstream `jq` correlation.

### Why a separate table vs columns on the live policy row

Considered: `opt_out_set_by` + `opt_out_set_at` + `prev_*` columns on `meta.tenant_retention_policies`.

Rejected:
1. **Only captures the most recent event.** Operators querying "every time this tenant's policy changed" need history.
2. **Columns proliferate.** Four mutation kinds × set_by/set_at/prev_state would be 12 columns of dead weight on rows that rarely change.
3. **No event-kind distinction.** A `set_by` column can't represent "the previous state was set by X via opt-out, then changed by Y via retention-set."

A separate append-only table is the canonical audit-log pattern. ADR-0167 Q3 + ADR-0168 Q6 explicitly anticipated this milestone.

### Why CTE atomic write vs `transaction()`

Considered: wrapping each mutation in `this.conn.transaction(async tx => { ... })`.

Rejected because:
1. **Two round-trips** vs one CTE statement.
2. **More mock-test boilerplate** — every test would need to invoke the callback with the mock conn.
3. **CTE provides equivalent guarantees** for our use case — both INSERTs land or neither does.

The CTE pattern is equally atomic for single-statement mutations. Transactions would be needed if we wanted multi-step ordering (e.g., "first check existence, then INSERT, then audit"), but our mutations are single-statement.

### Why default attributes to `{}` JSONB vs NULL

NOT NULL JSONB with default `'{}'::jsonb` matches the convention in `META_WORKFLOW_TRACES.attributes` + `META_LLM_CALL_TRACES.attributes` (ADR-0120 + ADR-0141). Operators querying always see a JSON object, never NULL — simpler downstream `jq '.attributes.source'` access pattern.

## Use cases unblocked

**1. Forensic audit "who set this opt-out?"**

```bash
crossengin retention history --tenant <uuid> --table workflow_traces --limit 10
```

Latest 10 events for the tenant's workflow_traces policy. Operator sees the opt_out_set event with actorId.

**2. Compliance report "all opt-outs in Q3 2026"**

```bash
crossengin retention history \
  --kind opt_out_set \
  --since 2026-07-01 --until 2026-09-30 \
  --limit 10000 \
  --format json > q3-2026-opt-outs.json
```

Auditor gets every opt-out creation with actor + reason + timestamp in one JSON file.

**3. Tier-migration audit trail**

```bash
crossengin retention history --kind retention_set --since 2026-05-01
```

Show every per-tenant retention override set this month. Cross-reference with the tier-migration playbook.

**4. Operator attribution via --actor**

```bash
crossengin retention opt-out <tenant> workflow_traces \
  --until 2027-01-01 \
  --reason "legal_hold:case#42" \
  --actor "$(whoami | uuidv5)"
```

Operator's UUID flows into the history row's `actor_id`. Compliance queries surface "who flipped what."

**5. Reconstruct policy state at a point in time**

```bash
crossengin retention history --tenant <uuid> --table workflow_traces \
  --until "2026-08-15T12:00:00Z" --limit 1 --format json
```

The first entry's `next_state` is the policy as of that moment.

**6. Drift detection between mutations**

Compare `prev_state` and `next_state` of an event to see exactly what fields changed.

## Drawbacks

1. **CTE complexity in SQL.** The four mutation methods now have multi-statement CTE SQL instead of single INSERT/UPDATE/DELETE. Harder to read; more parameters per query.
2. **No backfill for pre-existing rows.** Tenants with policies created before this milestone have no history rows. Operators can backfill manually if compliance requires it.
3. **JSONB storage cost.** Each event stores prev_state + next_state as JSONB. At ~200 bytes per state, ~400 bytes per event. At 100K events: 40MB. Not a concern at expected operator scales.
4. **Append-only by convention, not enforcement.** Nothing prevents a DBA from `DELETE FROM meta.tenant_retention_opt_out_history`. A future REVOKE on the audit-write role would enforce; defer.
5. **No retention on the history table itself.** Operator query patterns will eventually want "purge events older than 2 years." Future Q.
6. **Actor identity opaque.** `actor_id` is a UUID with no FK constraint (no `meta.users` reference). Operators correlating actorId → human user join externally. A future FK would couple this milestone to the not-yet-shipped users substrate; defer.
7. **No event-source distinction in JSONB.** The `attributes` column allows operator-defined source tagging but doesn't enforce a schema. Convention: `attributes.source = "cli" | "api" | "scheduler" | ...`. Operators define their own taxonomies.
8. **CTE doesn't fire INSERT trigger.** If operators ever add INSERT triggers to META_TENANT_RETENTION_POLICIES, the CTE pattern still triggers them — but operators expecting BEFORE INSERT triggers to see "prev_state" can't access it within the trigger. Defer; document if/when triggers are added.

## Alternatives considered

1. **Audit columns on the live policy row** (set_by, set_at, prev_state JSONB). Rejected — only captures most recent event; column proliferation.
2. **Transactions instead of CTE.** Rejected — two round-trips, more test boilerplate, same atomicity outcome.
3. **PG trigger on META_TENANT_RETENTION_POLICIES that writes history.** Rejected — hidden behavior; debugging harder; doesn't pass actorId / attributes (which live in the SQL statement parameters, not row data).
4. **Separate `meta.tenant_retention_opt_out_history` schema (own schema, not `meta`).** Rejected — breaks the established meta-schema topology; all platform tables live in `meta`.
5. **Mandatory `actorId` on all mutations.** Rejected — system actors (cron jobs, schedulers) often have no human actor; null is the canonical "system" signal.
6. **Per-field diff in the history row instead of prev/next state.** Rejected — JSONB diff is easy to compute application-side; storing both states gives maximum reconstructability.
7. **WAL-based audit via `pg_audit` extension.** Rejected — extension dependency, harder to query for tenant-scoped events, no application-layer actorId/attributes.
8. **Materialized view aggregating history into "current state" snapshots.** Rejected — the live policy table IS the current state; the materialized view would duplicate.
9. **Strict CHECK on `actor_id` (UUID format only).** Rejected — actor_id is already TYPED as UUID, PG enforces shape on INSERT.
10. **`policy_state` enum on the history row (active / opted_out / disabled / deleted).** Rejected — can be derived from next_state; storing redundant fields invites drift.

## Open questions

1. **History table retention.** Add to `meta.retention_policies` allowlist + adapter pruning logic. Defer until measured table-growth concern.
2. **Actor identity FK to `meta.users(id)`.** Couples to the not-yet-shipped users substrate. Defer.
3. **Trigger-based or REVOKE-enforced append-only constraint.** Defer until operators report tampering concerns.
4. **`retention restore <history-id>` action.** Use a history event's `prev_state` to roll back to a prior policy. Closes ADR-0169 Q7. Defer.
5. **`retention diff-history <history-id-a> <history-id-b>`.** Compare two history events. Defer.
6. **Backfill tool for pre-existing policies.** A `crossengin retention backfill-history` action that synthesizes events from current rows. Defer.
7. **Hooks for application-level audit ingestion.** Stream history events to SIEM / Splunk / Datadog. Pair with a future notification fanout milestone.
8. **History query pagination via cursor.** Currently uses LIMIT only. Add `--after-id <uuid>` for >100K-event tenants. Defer.
9. **Actor display in CLI.** Current `<system>` placeholder for null actorId; future enhancement might join to `meta.users` for human-readable names. Defer.
10. **`--attributes` flag on mutation CLI actions.** Currently the adapter accepts arbitrary `attributes` JSONB but the CLI doesn't expose it. Future Q if operators want structured audit context from the CLI directly.
