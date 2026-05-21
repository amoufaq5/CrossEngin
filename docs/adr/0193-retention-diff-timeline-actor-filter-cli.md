# ADR-0193: `crossengin retention diff-timeline --actor-id` actor filter across all three diff-timeline paths (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.actor-filter)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0189 (diff-timeline pair-wise), ADR-0190 (--with-actor-names), ADR-0191 (--add-tenant N-way), ADR-0192 (--cross-table), ADR-0186 (--actor-id on retention history) |

## Context

ADR-0186 shipped `retention history --actor-id <uuid>` substrate-side WHERE filter on the audit-log surface. ADR-0189/0190/0191/0192 shipped `retention diff-timeline` with three dispatch paths (pair-wise cross-tenant + N-way cross-tenant + cross-table) and `--with-actor-names` display surfacing. ADR-0189 Q4 listed `--actor-id` filter on diff-timeline as future work.

Operators investigating per-actor forensics across cohorts or table sets — "show all of Alice's mutations across these 5 tenants" or "show all of Alice's mutations across this tenant's 4 prunable tables" — couldn't answer with the existing diff-timeline. They ran the no-filter command and post-processed with `jq '.entries[] | select(.actorId == "...")'` which broke LIMIT correctness (asking for `--limit 100` returned <100 entries after jq filter) and would break future cursor-pagination correctness.

M6.7.zz.tenant.opt-out.cli.diff-timeline.actor-filter closes ADR-0189 Q4 by threading `--actor-id <uuid>` through all three diff-timeline paths. Substrate-side WHERE filter ensures correctness.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--add-tenant <c> ...]
                                   [--actor-id <uuid>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--format human|json]

crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table
                                   [--add-table <c> ...]
                                   [--actor-id <uuid>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--format human|json]
```

- `--actor-id <uuid>` is a single optional flag added to all three dispatch paths uniformly.
- Composes with `--with-actor-names` for the canonical "Alice's audit log across cohort" pattern.
- Composes with `--add-tenant` (N-way cross-tenant) and `--cross-table` (with optional `--add-table` N-way) without restriction.

### Adapter changes

All three input types gain an optional `actorId?: string` field:

```ts
export interface DiffHistoryTimelineInput {
  // ... existing fields
  readonly joinActor?: boolean;
  readonly actorId?: string;  // NEW
}

export interface DiffHistoryTimelineNwayInput {
  // ... existing fields
  readonly joinActor?: boolean;
  readonly actorId?: string;  // NEW
}

export interface DiffHistoryTimelineCrossTableInput {
  // ... existing fields
  readonly joinActor?: boolean;
  readonly actorId?: string;  // NEW
}
```

All three adapter methods add the same conditional WHERE clause: when `input.actorId !== undefined`, append `h.actor_id = $N` to the conditions array with `$N` positioned after the tenant/table parameters but before `--since`/`--until` parameters.

Why substrate-side WHERE not CLI-side jq filter:
1. **LIMIT correctness.** `--limit 100` returns 100 actor-filtered entries from PG, not <100 filtered from a 100-row jq input.
2. **Future cursor pagination correctness.** When `--after-id` ships (ADR-0189 Q5), cursor semantics need the filter to happen before pagination not after.
3. **Index usage.** Future composite index on `(actor_id, occurred_at)` would speed actor-scoped queries.

### CLI dispatcher

`runRetentionDiffTimeline` reads `actorIdFlag = getStringFlag(command, "actor-id")` once, normalizes to `actorId: string | undefined`, and threads to whichever adapter method gets selected. No restriction on which path can use the flag — it composes uniformly.

JSON envelope echoes `actorId: string | null` field across all three envelope shapes (pair-wise, nway:true, crossTable:true) so downstream consumers detect the filter on the existing envelope shapes without needing yet another discriminator.

### No null-actor sentinel

Operators wanting "only system-actor events" (where `actor_id IS NULL`) jq-filter on `.result.entries[] | select(.actorId == null)`. Same convention as ADR-0186 on `retention history`. Substrate stays minimal — one positive filter per dimension, no sentinel string values.

### No UUID validation at CLI boundary

Same convention as ADR-0186: PG enforces UUID format at query time with a clearer error than CLI substring matching could provide. Invalid UUIDs surface as PG-side error → exit 1.

## Use cases unblocked

**1. Per-actor cohort audit**

```bash
crossengin retention diff-timeline <ref-tenant> <a> workflow_traces \
  --add-tenant <b> --add-tenant <c> --add-tenant <d> \
  --actor-id <suspect-actor> \
  --with-actor-names --since 2026-Q1
# Shows all of one actor's mutations across the 4-tenant cohort,
# rendered with display_name (uuid) per event.
```

**2. Per-actor cross-table audit**

```bash
crossengin retention diff-timeline <tenant> workflow_traces llm_call_traces \
  --cross-table \
  --add-table llm_latency_samples \
  --add-table tenant_retention_opt_out_history \
  --actor-id <alice-uuid> \
  --with-actor-names
# Single command: every retention mutation Alice made across all 4
# prunable tables of one tenant.
```

**3. Incident timeline focused on a specific operator**

```bash
crossengin retention diff-timeline <tenant-a> <tenant-b> workflow_traces \
  --actor-id <suspect> \
  --with-actor-names --since <incident-window-start> --until <window-end>
# Forensic timeline focused on what one actor did across two tenants
# during the incident window.
```

**4. Service-account vs human-actor split**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --actor-id <service-account-uuid> \
  --format json | \
  jq '.result.entries[] | {when: .occurredAt, what: .eventKind, side: .tenantSide}'
# All service-account mutations isolated for separate review;
# human-actor mutations queried with a separate --actor-id.
```

## Drawbacks

1. **One flag added uniformly to all three paths** — three adapter methods + three JSON envelope shapes all gain the same actorId field. Acceptable since the addition is structurally identical across all three.
2. **No null-actor sentinel** — operators wanting `actor_id IS NULL` events jq-filter (documented; matches ADR-0186 pattern).
3. **No `--actor-id-not` exclusion** — operators excluding one actor jq-filter (defer; same as ADR-0186).
4. **No multi-actor OR filter** — operators wanting "show Alice's OR Bob's mutations" run twice + concat. Defer (could ship via multiFlags from ADR-0183 if measured demand emerges).
5. **No `--actor-name-equals` for human-readable input** — operators look up UUIDs first. Defer; pairs with ADR-0185 Q2 + ADR-0186 Q1.
6. **PG composite index `(actor_id, occurred_at)` not added** — actor-filtered queries do index scan + sort. Defer until measured slow; meta-schema currently has no actor_id index on `tenant_retention_opt_out_history`.
7. **No CLI-side UUID validation** — invalid UUIDs hit PG error message rather than crisp CLI exit 2. Matches ADR-0175/0186 deferred decision.

## Alternatives considered

1. **CLI-side jq filter as documented workflow** — breaks LIMIT correctness + future cursor pagination. Rejected.
2. **`--actor-id` as a repeated multi-flag from day one** — overkill for v1; positive-only filter is the common case. Defer multi-actor.
3. **`--actor` sentinel for null filtering** — overloads the string semantic. Operators jq-filter for system-actor events. Rejected.
4. **Separate adapter input type for actor-filtered queries** — same shape with one optional field; separate type would balloon the surface. Rejected.
5. **CLI-side UUID validation matching some regex** — substrate doesn't validate; PG errors are clearer. Matches ADR-0175/0186. Rejected.
6. **Add composite index on `(actor_id, occurred_at)`** — premature optimization; substrate stays unindexed until measured slow. Defer.
7. **Surface filter in JSON envelope as `actorFilter` rather than `actorId`** — matches per-entry `actorId` field name from ADR-0190 entries. Rejected verbose name.
8. **Reject `--actor-id` when adapter response would be empty (no rows for that actor)** — over-eager; empty result is a valid signal. Rejected.

## Open questions

1. **`--actor-id` repeated multi-flag** for OR semantics across N actors. Defer until measured demand.
2. **`--actor-id-not <uuid>`** exclusion. Defer.
3. **`--actor-name-equals <name>` filter** via `meta.users.display_name` JOIN. Pairs with ADR-0185 Q2 + ADR-0186 Q1. Defer.
4. **Composite index on `(actor_id, occurred_at)`** for large-scale actor-scoped pagination performance. Defer until measured.
5. **CLI-side UUID validation matching ADR-0175 deferred decision**. Defer.
6. **`--system-only` flag** for `actor_id IS NULL` events. Defer; jq-filter covers.
7. **Multi-dimension actor filter** combining `--actor-id` + `--add-tenant` + `--cross-table` in a single matrix query mode (operator-policy concern; current N-way axis singleton is sufficient).
