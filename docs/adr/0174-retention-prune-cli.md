# ADR-0174: `crossengin retention prune [--dry-run]` CLI action (Phase 2 M6.7.zz.tenant.opt-out.cli.prune)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0143 (META_RETENTION_POLICIES + PostgresTraceRetention.prune), ADR-0153 (previewPrune), ADR-0172 (history-table retention) |

## Context

ADR-0143 / M6.7.zz shipped `PostgresTraceRetention.prune()` and ADR-0153 / M6.7.zz.dry-run shipped `previewPrune()`. Both adapter methods exist and are used by operator-side scheduled jobs (cron, Inngest, Kubernetes CronJob, AWS EventBridge). But operators have no first-class **ad-hoc invocation** path — debugging a stuck prune, running a one-off compliance sweep, or validating a freshly-configured retention policy requires invoking the scheduled job manually or writing a one-off Node script.

ADR-0172 Q2 lined this up:

> Q2: CLI `retention prune` action. Currently `prune()` is invoked via a scheduled job (operator-side). A `crossengin retention prune [--dry-run]` action would let operators run it ad-hoc. Defer.

M6.7.zz.tenant.opt-out.cli.prune closes Q2 with a thin wrapper — pure CLI delivery, no new substrate code. The pruning machinery already exists; this milestone exposes it to operators at the terminal.

## Decision

Single CLI action `crossengin retention prune` with one optional flag `--dry-run`. Wraps the two existing adapter methods one-for-one:

- `crossengin retention prune` → calls `retention.prune()` → returns `RetentionRunResult[]`
- `crossengin retention prune --dry-run` → calls `retention.previewPrune()` → returns `RetentionPreviewResult[]`

No other flags. No new adapter methods. The action is the mechanically simplest milestone in the retention CLI family.

### Output rendering

Both result types share the same conceptual shape (per (table, tenant?) rows with status + retention_days + cutoff + opt-out details). Two distinct formatter functions (`formatPruneRun` / `formatPrunePreview`) keep terminology distinct:

| | Run | Dry-run |
|---|---|---|
| Header | `Retention prune results (N entries):` | `Retention prune dry-run results (N entries):` |
| Count label | `deleted=N` | `would_delete=N` |
| Summary verb | `pruned` | `would prune` |

**Per-row format:**

```
<status>                 <table-name>           <tenant>                   <count>           retention=<N>d  cutoff=<iso>  [extra]
```

Where `<tenant>` is `tenant=<uuid>` or `(platform)`, `<count>` is `deleted=N` / `would_delete=N` / `-` for skipped rows, and `[extra]` captures opt-out detail when status is `skipped_opt_out` / `skipped_opt_out_expired`:

```
  skipped_opt_out          workflow_traces   tenant=<uuid>  -      retention=365d  -  reason=legal_hold:case#42  until=2027-01-01T...
  skipped_opt_out_expired  workflow_traces   tenant=<uuid>  -      retention=365d  -  reason=legal_hold:case#42  until=2025-01-01T... (EXPIRED)
```

**Summary line** at the end aggregates:

```
Summary: 2 pruned (1042 rows), 1 skipped (1 skipped_disabled)
```

Multiple skip categories render alphabetically sorted:

```
Summary: 0 pruned (0 rows), 3 skipped (1 skipped_disabled, 1 skipped_opt_out, 1 skipped_opt_out_expired)
```

### JSON output

```json
{
  "action": "prune",
  "dryRun": false,
  "results": [ RetentionRunResult, ... ]
}
```

`dryRun` boolean discriminator distinguishes the two modes in downstream `jq` consumers. `results` is the full typed array from the underlying adapter method.

### Empty-result handling

When no policies are configured, output is:

- Human (live): `no retention policies configured`
- Human (dry-run): `no retention policies configured (dry-run)`
- JSON: `{action, dryRun, results: []}`

Exit code 0 in all cases — the absence of policies is not an error.

### Why share the formatter scaffolding via `PruneResultLike` interface

The two result types differ in two fields (`deletedCount` vs `wouldDeleteCount`) but share the rest. A private interface `PruneResultLike` enforces the shared shape; the count-rendering helper takes a `countLabel` parameter ("deleted" / "would_delete") and the actual count value, avoiding duplication while keeping the public adapter types separate.

### Why no `--policy <table>` / `--tenant <uuid>` filter flags

Considered. Rejected this milestone:

1. **Scope creep.** The pruning machinery is one round trip per policy — operators wanting partial runs use the per-tenant override mechanism (`retention opt-out` to exclude tenants) rather than a CLI filter.
2. **Filter ambiguity.** A `--policy workflow_traces` would only prune that table. But the platform-default DELETE uses NOT IN subqueries against ALL per-tenant policies — filtering would change the semantics in subtle ways.
3. **Operator pattern.** Today operators rely on scheduled jobs running the full prune across all policies. Ad-hoc CLI invocation mirrors that — full sweep, deterministic outcome.

Operators wanting partial pruning use the existing `retention opt-out` action to exclude tenants and the platform-policy `enabled = false` toggle to disable specific tables.

### Why no `--confirm` flag

Pruning is destructive. The existing `apply --confirm` flag pattern would suggest gating with prompt. Rejected this milestone:

1. **`--dry-run` is the canonical preview.** Operators preview first, then run live. Two-command pattern is the documented safety.
2. **Scheduled jobs invoke this method without confirmation** — adding a CLI prompt would create operational asymmetry (CLI prompts but cron doesn't).
3. **Result is reversible-ish.** Pruned events are gone, but per-tenant restore action can recreate the policy (just not the pruned trace data).

Future Q if operators report accidental aggressive prunes.

## Use cases unblocked

**1. Ad-hoc dry-run after configuring a new policy**

```bash
crossengin retention set <tenant> workflow_traces --days 7
crossengin retention prune --dry-run --format json | \
  jq '.results[] | select(.tenantId == "<uuid>")'
```

Operator confirms what the next scheduled prune would delete before it actually runs.

**2. Compliance sweep on demand**

```bash
crossengin retention prune
```

Compliance team triggers a sweep after a policy change without waiting for the next scheduled run.

**3. CI / migration validation**

```bash
crossengin retention prune --dry-run --format json | \
  jq '[.results[] | select(.status == "pruned")] | length'
```

Migration script asserts "exactly N policies should be active." Returns count of would-prune entries.

**4. Debugging stuck pruning**

When operators report "the retention isn't pruning," they run `crossengin retention prune --dry-run` and inspect the result list to see which policies the substrate sees and which would actually delete.

**5. Forensic "what happened last sweep"**

```bash
crossengin retention prune --format json > prune-snapshot-$(date +%s).json
```

Operator captures a full prune-run snapshot for post-incident analysis.

## Drawbacks

1. **No actor attribution.** Unlike the mutation actions which thread `--actor`, prune is a maintenance operation that runs across all policies. The substrate doesn't record "who triggered this prune." Future audit-table milestone could capture (closes ADR-0172 Q3 indirectly).
2. **No filter flags.** Operators wanting partial runs use the policy table directly (opt-out specific tenants, disable specific tables). CLI stays simple.
3. **No `--confirm` flag.** Mirrors scheduled-job pattern. Operators preview with `--dry-run` before running live.
4. **Destructive without per-tenant feedback in JSON.** The result envelope is one array; operators wanting per-tenant breakdown use `jq` groupBy.
5. **One round-trip per policy** at the adapter level. Performance acceptable for the bounded policy count (typically <100 across all tenants).

## Alternatives considered

1. **Two separate actions `retention prune` + `retention preview`.** Rejected — `--dry-run` is the more idiomatic CLI pattern (matches `apply --dry-run` from the existing CLI).
2. **`--policy <table>` / `--tenant <uuid>` filter flags.** Rejected — partial pruning has subtle semantic gotchas; operators control scope via policy-table state.
3. **`--confirm` flag with prompt.** Rejected — operators preview with `--dry-run`; scheduled jobs would still bypass anyway.
4. **Render summary at the TOP of human output** (before per-row details). Rejected — operators reading from the top down typically want context first, summary last.
5. **Aggregate by table_name in human output** (grouping rows visually). Rejected — adds complexity for marginal gain; operators bucket via `jq` on JSON output.
6. **Implicit `--limit N` on result rendering.** Rejected — policy table is bounded; full output is always reasonable.
7. **Auto-emit a notification when N rows pruned exceeds threshold.** Rejected — notification delivery is operator concern, substrate stays passive.
8. **CSV output format.** Rejected — JSON + `jq` covers all CSV use cases; substrate stays consistent.

## Open questions

1. **`--actor <uuid>` flag for prune attribution.** Pair with a future `meta.retention_pruning_runs` audit table (ADR-0172 Q3). Defer.
2. **`--filter-table <name>` / `--filter-tenant <uuid>`.** Defer.
3. **`--confirm` flag matching `apply --confirm` pattern.** Defer until operators report accidents.
4. **Progress reporting for long-running prunes.** Currently silent until completion. Defer; add if measured slow.
5. **Concurrent invocation safety.** Two operators running prune simultaneously could double-delete. Currently relies on PG advisory locks NOT being held by the prune machinery (no `withAdvisoryLock` wrapper). Future Q to consider gating.
6. **`--summary-only` flag** to skip per-row details. Defer; `jq` covers it.
7. **Exit code by result.** Currently always exit 0 on successful prune. A future `--exit-on-pruned` could exit 1 when any row was pruned (useful for CI gates). Defer.
8. **CLI integration with scheduled-job framework.** Operators currently wire prune into Inngest / cron / K8s CronJob manually. A future `crossengin schedule retention-prune --interval daily` would standardise. Defer — different concern (scheduling vs invocation).
