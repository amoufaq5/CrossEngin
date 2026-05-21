# ADR-0194: `crossengin retention diff-timeline --kind` event-kind filter across all three diff-timeline paths (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.kind-filter)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0189 (diff-timeline pair-wise), ADR-0190 (--with-actor-names), ADR-0191 (--add-tenant N-way), ADR-0192 (--cross-table), ADR-0193 (--actor-id filter), ADR-0170 (history audit log + event_kind tuple) |

## Context

ADR-0170 shipped `META_TENANT_RETENTION_OPT_OUT_HISTORY` with a 4-value `event_kind` CHECK constraint (`opt_out_set | opt_out_cleared | retention_set | policy_deleted`). The `retention history` action ships a `--kind <event-kind>` filter via ADR-0170 since day one. ADR-0193 just shipped `--actor-id <uuid>` across all three diff-timeline paths.

Operators investigating specific event types across a cohort or table set — "show me every `opt_out_set` event across these 5 tenants" or "show me every `policy_deleted` event across this tenant's 4 prunable tables" — couldn't filter on event_kind from `retention diff-timeline`. Post-filtering with jq broke LIMIT correctness (same trap ADR-0193 closed for actor filtering).

M6.7.zz.tenant.opt-out.cli.diff-timeline.kind-filter threads `--kind` uniformly across all three diff-timeline paths, mirroring ADR-0193's actor-filter pattern.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--add-tenant <c> ...]
                                   [--actor-id <uuid>]
                                   [--kind <event-kind>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--format human|json]

crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table
                                   [--add-table <c> ...]
                                   [--actor-id <uuid>]
                                   [--kind <event-kind>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--format human|json]
```

- `--kind <event-kind>` is a single optional flag added to all three dispatch paths uniformly.
- Validated at CLI boundary against the 4-value `OPT_OUT_HISTORY_EVENT_KINDS` tuple from ADR-0170: `opt_out_set | opt_out_cleared | retention_set | policy_deleted`. Invalid values → exit 2 with explicit list of valid values in the error message.
- Composes with `--actor-id` (ADR-0193), `--with-actor-names` (ADR-0190), `--add-tenant` (ADR-0191), `--cross-table`/`--add-table` (ADR-0192) without restriction.

### Adapter changes

All three input types gain optional `eventKind?: OptOutHistoryEventKind` field (where `OptOutHistoryEventKind` is the type already exported from ADR-0170):

```ts
export interface DiffHistoryTimelineInput {
  // ...existing fields
  readonly actorId?: string;
  readonly eventKind?: OptOutHistoryEventKind;  // NEW
}

export interface DiffHistoryTimelineNwayInput {
  // ...existing fields
  readonly actorId?: string;
  readonly eventKind?: OptOutHistoryEventKind;  // NEW
}

export interface DiffHistoryTimelineCrossTableInput {
  // ...existing fields
  readonly actorId?: string;
  readonly eventKind?: OptOutHistoryEventKind;  // NEW
}
```

All three adapter methods add an identical conditional WHERE clause: when `input.eventKind !== undefined`, append `h.event_kind = $N` to the conditions array. Param position: immediately after `actorId` (when set) but before `--since`/`--until`.

Why TypeScript type instead of plain `string` on the adapter input: the kernel-pg type already exists; using `OptOutHistoryEventKind` gives TypeScript narrowing for adapter consumers calling directly. The CLI validates via `isOptOutHistoryEventKind` before passing through, so the narrowing is correct at the call site.

Why substrate-side WHERE not CLI-side jq filter — same three reasons as ADR-0193:
1. **LIMIT correctness.** `--limit 100 --kind opt_out_set` returns 100 opt-out-set entries from PG, not <100 filtered from a 100-row jq input.
2. **Future cursor pagination correctness.** When `--after-id` ships, cursor semantics need the filter to happen before pagination not after.
3. **Index usage.** Future composite index on `(event_kind, occurred_at)` would speed kind-scoped queries.

### CLI dispatcher

`runRetentionDiffTimeline` reads `kindFlag = getStringFlag(command, "kind")` once, validates via `isOptOutHistoryEventKind`, and threads `eventKind: OptOutHistoryEventKind | undefined` to whichever adapter method gets selected. Same `getStringFlag` + validate-once pattern as `runRetentionHistory` for symmetric ergonomics.

JSON envelope echoes `kind: OptOutHistoryEventKind | null` field across all three envelope shapes (pair-wise no-discriminator, nway:true, crossTable:true) — same convention as `actorId` from ADR-0193.

### Single-kind only

Operators wanting multi-kind filter ("show me opt_out_set OR opt_out_cleared events") run two commands + concat, or jq-filter on `.result.entries[] | select(.eventKind == "opt_out_set" or .eventKind == "opt_out_cleared")`. Multi-kind via repeated flag is documented as a future Q; substrate stays minimal — one positive filter per dimension matching ADR-0193 actor-filter convention.

### Composition with `--actor-id`

Operators chaining `--actor-id <uuid> --kind opt_out_set` answer "every opt_out_set event Alice authored" — the canonical per-actor-per-kind forensic query in one command. The two filters combine multiplicatively (AND semantic) at the WHERE-clause level.

## Use cases unblocked

**1. Per-kind cohort audit**

```bash
crossengin retention diff-timeline <ref-tenant> <a> workflow_traces \
  --add-tenant <b> --add-tenant <c> --add-tenant <d> \
  --kind opt_out_set \
  --since 2026-Q1 --with-actor-names
# Every opt-out-set event across the 5-tenant cohort during Q1 2026.
```

**2. Per-kind cross-table audit**

```bash
crossengin retention diff-timeline <tenant> workflow_traces llm_call_traces \
  --cross-table \
  --add-table llm_latency_samples \
  --add-table tenant_retention_opt_out_history \
  --kind policy_deleted \
  --with-actor-names
# Every policy_deleted event across this tenant's 4 prunable tables.
```

**3. Per-actor-per-kind forensics**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --actor-id <alice> \
  --kind opt_out_cleared \
  --since <incident-window-start>
# Every opt-out-cleared event Alice authored during the incident window.
```

**4. Compliance report on retention adjustments only**

```bash
crossengin retention diff-timeline <regulated-a> <regulated-b> workflow_traces \
  --add-tenant <regulated-c> \
  --kind retention_set \
  --format json | \
  jq '.result.entries | group_by(.tenantLabel) | map({tenant: .[0].tenantLabel, retention_changes: length})'
# Counts retention_set events per tenant.
```

## Drawbacks

1. **Single-kind only** — operators wanting multi-kind OR filter run multiple commands or jq-filter. Defer multi-kind via repeated flag.
2. **One flag added uniformly to all three paths** — three adapter methods + three JSON envelopes all gain the same eventKind field. Acceptable since structurally identical (mirrors ADR-0193 pattern).
3. **No `--kind-not` exclusion** — operators excluding one kind jq-filter. Defer; matches ADR-0186/0193 pattern.
4. **No `--kind` for filter-by-state-shape** (e.g., "show me events where `nextState.opt_out = true`") — operators jq-filter on JSON output. Defer; semantically different from event_kind which is the mutation method name not the resulting state.
5. **PG composite index `(event_kind, occurred_at)` not added** — kind-filtered queries do index scan + sort. Defer until measured slow. (`event_kind` already has an index from ADR-0170 for analytics queries, but it's not composite with occurred_at.)
6. **`--kind` validation at CLI boundary requires exact match** — operators with typos like `--kind opt-out-set` (hyphen vs underscore) get exit 2; documented in error message which lists all 4 valid values.

## Alternatives considered

1. **CLI-side jq filter as documented workflow** — breaks LIMIT correctness + future cursor pagination. Rejected (same as ADR-0193).
2. **`--kind` as repeated multi-flag from day one** — overkill for v1; single-kind is the common case. Defer multi-kind.
3. **PG side validation only (no CLI-side check)** — PG would error on invalid event_kind via the CHECK constraint, but the error message references the table column not the CLI flag. CLI-side check gives clearer "expected one of: ..." error. Adopted.
4. **Type the adapter input as `string` not `OptOutHistoryEventKind`** — loses TypeScript narrowing for direct adapter consumers. Rejected.
5. **Add `--exclude-kind <event-kind>`** for inversion — defer; jq-filter covers + matches ADR-0193 pattern (single positive filter).
6. **Validate `--kind` via zod schema** — overkill for a 4-value tuple; `isOptOutHistoryEventKind` predicate is sufficient. Rejected.
7. **Auto-deduce kind from positional or other args** — magical; explicit flag clearer.
8. **Surface filter in JSON envelope as `kindFilter`** — verbose; `kind` matches per-entry `eventKind` field (though field name is slightly inconsistent — envelope uses `kind` shorthand, per-entry uses `eventKind`). Adopted for envelope brevity; the `eventKind` per-entry field name from ADR-0170 stays. Operators wanting the canonical name on the envelope would prefer `eventKind` everywhere but this minor inconsistency matches `retention history`'s JSON envelope which also uses `kind` shorthand.

## Open questions

1. **`--kind` repeated multi-flag** for OR semantics across N kinds. Defer until measured demand.
2. **`--exclude-kind <event-kind>`** inversion. Defer; jq-filter covers.
3. **Filter by state-shape predicate** (e.g., `--with-opt-out-true` for events where `nextState.opt_out = true`). Semantically different from event_kind; defer until measured.
4. **Composite index on `(event_kind, occurred_at)`** for large-scale kind-scoped pagination. Defer until measured slow.
5. **Combined cohort filters** — operators wanting `--kind opt_out_set --add-tenant <c>` already work, but a `--summary-by-kind` mode that bucket-counts per kind across the cohort is operator-policy at the jq layer for now. Defer.
6. **`--kind` filter on retention diff-history** (ADR-0173 cross-event diff) for symmetric filtering. Defer.
7. **`--kind <kind1> AND <kind2> AND ...` combined event-kind matrix** for multi-kind comparison ergonomics. Defer.
