# ADR-0259: Gateway idempotency-record prune CLI

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-26 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0258 (gateway pipeline-execution retention — Q6 explicitly listed this), ADR-0044 (gateway pipeline + idempotency lifecycle), ADR-0050 (gateway runtime), ADR-0153 (preview/run dual-method pattern), ADR-0174 (retention prune CLI shape) |

## Context

ADR-0258 (M4.11) closed retention coverage for
`META_GATEWAY_PIPELINE_EXECUTIONS` — the platform-default gateway
audit table — and explicitly listed `meta.gateway_idempotency_records`
as the next operational hot table that grows under request load:

> "META_IDEMPOTENCY_RECORDS is the next operational table that
> grows under request load — needs the same retention treatment
> but has its own time column (`expires_at` already serves the
> role; pure DELETE WHERE expires_at < now() works without a
> policy table)."

The substrate side has been ready since M4.5:
`PostgresIdempotencyStore.deleteExpired(now)` issues `DELETE FROM
meta.gateway_idempotency_records WHERE expires_at < $1`. The
operator side is the gap — today operators have three workarounds:

1. Raw SQL `DELETE FROM meta.gateway_idempotency_records WHERE
   expires_at < now()` from psql.
2. A Node script importing `PostgresIdempotencyStore` and calling
   `deleteExpired(new Date())`.
3. Skip the prune entirely and let the table grow.

All three are boilerplate or risky. The table grows roughly at
the rate of unique requests with `Idempotency-Key` headers (per
ADR-0044 the gateway writes one row per first-seen key); at 1M
keyed-req/day, ~600 MB/day after indexes. Operators need a
one-command path.

**Distinct from ADR-0258.** `gateway_idempotency_records` has its
own TTL contract (`expires_at` column written at row-creation
time, typically `received_at + 24h`); pruning is "delete EXPIRED
records" not "delete records older than N days regardless of
expiry." That semantic is fundamentally different from the
retention substrate's `time_column < (now - retention_days)`
sweep — adding this table to PRUNABLE_TABLES would either delete
records that haven't expired yet (wrong) or duplicate the
expires_at logic in a separate retention_days field (operator
confusion). The right shape is a dedicated CLI action that
respects the existing column.

## Decision

Add `crossengin gateway prune-idempotency [--dry-run]` as a new
gateway action + add a `previewDeleteExpired(now)` method to
`PostgresIdempotencyStore` so the dry-run path mirrors the
prune/previewPrune dual-method pattern established in ADR-0153.

**Substrate addition.** One new method on the existing
`PostgresIdempotencyStore`:

```ts
async previewDeleteExpired(now: Date): Promise<number> {
  const result = await this.conn.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE}
     WHERE expires_at < $1`,
    [now.toISOString()],
  );
  return Number(result.rows[0]?.count ?? 0);
}
```

Read-only SELECT, identical predicate to `deleteExpired`, BIGINT
::TEXT cast + Number parse for safe integer round-trip (same
pattern used in PostgresTraceRetention.previewPrune and
PostgresCostCeilingResolver per ADR-0135).

**CLI action.** `crossengin gateway prune-idempotency` joins the
existing `gateway start` + `gateway routes ...` actions:

```
$ crossengin gateway prune-idempotency
deleted 17 expired idempotency record(s) (as of 2026-05-26T12:00:00.000Z)

$ crossengin gateway prune-idempotency --dry-run
42 expired idempotency record(s) would be deleted (dry-run; as of 2026-05-26T12:00:00.000Z)

$ crossengin gateway prune-idempotency --format json
{
  "action": "gateway.prune-idempotency",
  "dryRun": false,
  "asOf": "2026-05-26T12:00:00.000Z",
  "deletedCount": 17
}
```

**Pipeline.** parse PG env (or test override) → instantiate
`PostgresIdempotencyStore` → call `deleteExpired(now)` or
`previewDeleteExpired(now)` based on `--dry-run` → render.
`now` is `new Date()` by default, injectable via
`ctx.clockOverride` for deterministic tests.

**Exit codes** follow the established convention from ADRs
0181/0257:

| Exit | Cause |
|------|-------|
| 0    | Success (records deleted OR dry-run count emitted) |
| 1    | I/O failure (PG env missing, connection refused, adapter throws) |
| 2    | (reserved — no current path needs misuse exit here) |

There's no validation gate (no flag values to misparse), so exit
2 is unused in this action — matches the simplicity of the
underlying operation.

**JSON envelope discriminator.** `dryRun: boolean` is the
top-level key, mirroring the prune envelope from ADR-0174.
`deletedCount` field on live mode; `wouldDeleteCount` on dry-run.
The asymmetry is deliberate (clear semantic at the JSON layer for
operators piping through jq).

**No new META schema change.** The schema (`META_GATEWAY_IDEMPOTENCY_RECORDS`
with its `expires_at` column + index `idx_gateway_idempotency_expires`)
is unchanged. No CHECK widening. No new table.

**Test injection.** `GatewayContext` gains two optional fields:
- `idempotencyStoreOverride?: PostgresIdempotencyStore` — tests
  inject a store wrapping a mock PgConnection.
- `clockOverride?: () => Date` — deterministic `now` for the
  asOf field assertion.

Both mirror existing override patterns (`runtimeOverride`,
`pgConnectionOverride`, `serverFactory`).

## Alternatives considered

- **Add `gateway_idempotency_records` to PRUNABLE_TABLES (extend
  ADR-0258's substrate).**
  - **Why not:** semantic mismatch. The retention substrate sweeps
    `WHERE time_column < (now - retention_days)`; idempotency
    records sweep `WHERE expires_at < now()`. The two would
    produce different deletes for the same row (a record with
    expires_at=now+5min and retention_days=1 would be retained by
    expires_at but deleted by retention) — operator confusion.
    Keeping them as separate concepts surfaces the right
    operator-facing CLI.

- **Single `crossengin retention prune-idempotency` action under
  the retention subcommand.**
  - **Why not:** `retention` is the META_RETENTION_POLICIES-based
    surface; the idempotency action doesn't read or write that
    table. Action namespace should reflect ownership — gateway
    owns idempotency, so `gateway prune-idempotency` belongs
    under `gateway`.

- **Schedule the prune internally on a timer inside the gateway
  runtime.**
  - **Why not:** operators want the prune cadence under their
    control (cron, Inngest, K8s CronJob). Internal scheduling
    couples the gateway runtime to a scheduler choice. CLI keeps
    the substrate scheduler-agnostic.

- **Skip the `previewDeleteExpired` method + hard-code the COUNT
  query inside the CLI.**
  - **Why not:** breaks the substrate's pattern — `PostgresTraceRetention`
    has `prune`/`previewPrune` as a pair on the adapter; the same
    pattern here keeps adapters cohesive and reusable. The COUNT
    query is part of the adapter contract, not CLI rendering.

- **Add `--older-than <duration>` to delete records by age rather
  than expiry.**
  - **Why not:** the table has its own expires_at TTL — operators
    setting `--older-than 1h` could delete records that haven't
    expired yet, breaking the idempotency contract for in-flight
    keys. The expires_at column is authoritative.

- **Emit a structured `IDEMPOTENCY_PRUNED` event to the
  pipeline-execution trace.**
  - **Why not:** the prune is operator-initiated maintenance, not
    request-pipeline activity. Mixing maintenance events into
    the pipeline trace dilutes the audit signal. The CLI's stdout
    + exit-code is the canonical record.

- **Wrap into a single `crossengin gateway housekeeping` umbrella
  action with multiple sub-actions (idempotency, rate-limit
  decisions, expired routes).**
  - **Why not:** premature abstraction. Each housekeeping target
    has different semantics (idempotency: TTL-based, rate-limit
    decisions: append-only audit, routes: operator-curated).
    Per-target actions are clearer.

## Consequences

- **Positive:** operators have a one-command path for the second
  hot-write gateway table. The full gateway audit + idempotency
  pruning story is now CLI-native.
- **Positive:** `previewDeleteExpired` follows the established
  preview/run pattern (ADR-0153) — operators can `--dry-run` to
  see the would-delete count before committing.
- **Positive:** no schema change, no CHECK widening, no policy
  table — the substrate's existing `expires_at` is authoritative.
  Pure additive: 1 adapter method + 1 CLI action.
- **Neutral:** `gateway` subcommand actions grow from 2 to 3
  (`start`, `routes`, `prune-idempotency`).
- **Neutral:** `GatewayContext` gains 2 optional fields
  (`idempotencyStoreOverride`, `clockOverride`); existing
  consumers unaffected (optional, undefined-default).
- **Reversibility:** trivial — revert the action branch, the
  context fields, the help-text entry, and the substrate method.
  Pure additive.

## Implementation notes

- The CLI action accepts no positional args. Future extensions
  (`--operation-id <id>` to scope, `--limit <n>` to cap, ...) are
  deferred future Qs.
- `now` is `new Date()` evaluated at call time; tests inject
  via `ctx.clockOverride`. Sub-millisecond precision matches
  PG's `TIMESTAMPTZ` round-trip.
- The adapter is built before the CLI tests run (turbo `^build`),
  so the new `previewDeleteExpired` method is available to
  architect-cli through the workspace's built `dist/`. A fresh
  build was required after the substrate edit (cached pre-edit
  dist would surface as a test failure with
  `store.previewDeleteExpired is not a function`).
- 4 new adapter tests: SELECT COUNT(*) shape + cutoff param
  match; returns 0 on empty match; parses large BIGINT string
  via ::TEXT cast; defensive 0 on empty result row.
- 6 new CLI tests: default mode deletes + prints count + asOf;
  --dry-run path SELECTs not DELETEs; JSON envelope shape on
  both modes (dryRun discriminator); adapter throw propagates
  exit 1; PG env missing exits 1 with clear message.
- workspace test count 9,481 → **9,491**. api-gateway-pg tests
  73 → 77 (+4); architect-cli tests 1,227 → 1,233 (+6).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Scope flags — `--operation-id <id>` / `--method <verb>` to prune only specific operation scopes (e.g. retire idempotency for a deprecated endpoint) | platform | _deferred_ |
| `--limit <n>` cap on delete count (batch-delete pattern for very large prunes that risk lock contention) | platform | _deferred_ |
| `--older-than <duration>` for force-prune records that haven't reached `expires_at` yet (would need warning + --confirm; risky for in-flight idempotency) | platform | _deferred_ |
| Integration with the retention prune scheduled-job framework (ADR-0143/0174 retention prune today is operator-scheduled; idempotency prune likewise — but a unified scheduled-housekeeping surface might combine them) | platform | _deferred_ |
| Time-based partitioning on `gateway_idempotency_records.expires_at` for O(partition drop) prune at very high write rates (same Q as ADR-0258 Q5) | platform | _deferred_ |
| Default `expires_at` TTL on `META_IDEMPOTENCY_RECORDS` (the kernel-side idempotency table, distinct from `gateway_idempotency_records`) — currently writers set per-row; a META-level default would simplify ops | platform | _deferred_ |

## References

- ADR-0258 — gateway pipeline-execution retention (this milestone's
  sibling; explicitly listed `meta.gateway_idempotency_records`
  as the next gap in Q6).
- ADR-0044 — gateway pipeline + idempotency contract.
- ADR-0050 — gateway runtime (writer of the table).
- ADR-0153 — preview/run dual-method substrate pattern (this
  milestone follows it).
- ADR-0174 — retention prune CLI shape (this milestone's exit-
  code + envelope conventions match).
- `packages/api-gateway-pg/src/idempotency-store.ts`
  (`deleteExpired` already shipped; `previewDeleteExpired` added).
- `apps/architect-cli/src/gateway.ts`
  (`runGatewayPruneIdempotency`),
  `apps/architect-cli/src/cli.ts` (help text).
