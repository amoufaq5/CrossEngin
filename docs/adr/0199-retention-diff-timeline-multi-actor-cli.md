# ADR-0199: `crossengin retention diff-timeline --actor-id` repeatable for OR-semantic multi-actor filter (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.multi-actor)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0193 (--actor-id single-value across diff-timeline), ADR-0183 (multiFlags infrastructure), ADR-0186 (--actor-id on retention history) |

## Context

ADR-0193 shipped `--actor-id <uuid>` single-value filter across all three `retention diff-timeline` dispatch paths (pair-wise + N-way cross-tenant + cross-table). ADR-0193 Q1 listed `--actor-id` repeated multi-flag as future work:

> Q1: `--actor-id` repeated multi-flag for OR semantics across N actors. Defer until measured demand.

ADR-0183 had already established the `multiFlags` infrastructure for `--add-tenant`, and ADR-0188 extended it to `--add-table`. ADR-0185/0186 documented operator desire for multi-actor workflows ("Alice's OR Bob's mutations"). Time to ship.

M6.7.zz.tenant.opt-out.cli.diff-timeline.multi-actor closes ADR-0193 Q1 by making `--actor-id` repeatable across all three diff-timeline paths, building an OR-semantic IN-clause filter.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--add-tenant <c> ...]
                                   [--actor-id <uuid> ...]    # NOW REPEATABLE
                                   [--kind <event-kind>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>] [--before-id <uuid>]
                                   [--format human|json]
```

(Same surface on all three diff-timeline dispatch paths — pair-wise, N-way via `--add-tenant`, cross-table via `--cross-table`.)

- `--actor-id` is now read via `getMultiFlag` (matches `--add-tenant` / `--add-table` precedent from ADR-0183/0188).
- Single value: `--actor-id <X>` → SQL `h.actor_id IN ($N)`.
- Multi value: `--actor-id <X> --actor-id <Y>` → SQL `h.actor_id IN ($N1, $N2)`.
- Zero values (flag omitted): no actor-filter WHERE clause; full result set.

### Breaking adapter type change

All three diff-timeline input types had `actorId?: string` from ADR-0193. This milestone renames to `actorIds?: ReadonlyArray<string>`:

```ts
// BEFORE (ADR-0193)
export interface DiffHistoryTimelineInput {
  // ...
  readonly actorId?: string;
}

// AFTER (this milestone)
export interface DiffHistoryTimelineInput {
  // ...
  readonly actorIds?: ReadonlyArray<string>;
}
```

Same change on `DiffHistoryTimelineNwayInput` and `DiffHistoryTimelineCrossTableInput`.

Why rename (vs. keeping both `actorId` + `actorIds`):

1. **No production consumers** of the kernel-pg adapter outside the architect-cli (which lives in the same repo).
2. **One-shot clean break** beats a permanent two-field surface.
3. **Same shape as ADR-0183's tenantIds + ADR-0188's tableNames** — consistent across N-way collection inputs.
4. **TypeScript narrowing stays clean** — `ReadonlyArray<string>` is structurally honest.

The rename is contained: 6 adapter call sites + ~15 test assertions in this commit + 1 JSON envelope field rename. All within the session-recent code from ADR-0193 (shipped within the past hour); no external surface affected.

### Retention history's actorId stays single

`retention history` ships `actorId?: string` (single) from ADR-0186. This milestone does **not** widen it to `actorIds`. The two surfaces diverge intentionally:

- `retention history` uses `actorId: string | null` in adapter + JSON envelope.
- `retention diff-timeline` (all three paths) uses `actorIds: string[] | null`.

Operators reading both will see the divergence. Documented as a future Q — a separate milestone could widen retention history's actor filter to multi-actor for consistency, but the demand hasn't materialized yet (operators run `retention history --actor-id alice` then `--actor-id bob` and grep, which is fine at history's typical scale).

### Adapter SQL

Same WHERE-clause pattern as ADR-0193 but with IN-list construction:

```ts
if (input.actorIds !== undefined && input.actorIds.length > 0) {
  const actorPlaceholders = input.actorIds
    .map((actorId) => {
      params.push(actorId);
      return `$${params.length}`;
    })
    .join(", ");
  conditions.push(`h.actor_id IN (${actorPlaceholders})`);
}
```

Single-element array yields `h.actor_id IN ($4)`, equivalent to `h.actor_id = $4` from ADR-0193 — PG handles both shapes identically. The IN-clause syntax is structurally uniform.

Empty array (`actorIds: []`) is treated as "filter not set" — no WHERE clause added. Equivalent to operators not passing `--actor-id` at all.

### CLI dispatcher

```ts
const actorIdFlags = getMultiFlag(command, "actor-id");
const actorIds = actorIdFlags.length > 0 ? actorIdFlags : undefined;
```

Threaded to whichever of the three adapter methods is dispatched.

### JSON envelope

The envelope's `actorId: string | null` field from ADR-0193 is renamed to `actorIds: string[] | null`:

```json
{
  "action": "diff-timeline",
  "actorIds": ["uuid-1", "uuid-2"],
  // ...
}
```

When the flag is not set, `actorIds: null`. Operators jq-filter via `.actorIds | length == 2` or `.actorIds | contains(["uuid-X"])`.

## Use cases unblocked

**1. Two-actor cohort forensics**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --actor-id <alice-uuid> \
  --actor-id <bob-uuid> \
  --with-actor-names --since 2026-01-01
# Every mutation Alice OR Bob made across both tenants on workflow_traces
# during the audit window, with names rendered.
```

**2. Service-account allowlist audit**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --add-tenant <c> --add-tenant <d> \
  --actor-id <sa-prod-1> \
  --actor-id <sa-prod-2> \
  --actor-id <sa-staging> \
  --kind retention_set
# All retention_set events authored by any of three service accounts
# across the 4-tenant cohort.
```

**3. Per-team mutation audit on shared table**

```bash
crossengin retention diff-timeline <tenant> workflow_traces llm_call_traces \
  --cross-table --add-table llm_latency_samples \
  --actor-id <team-lead-alice> \
  --actor-id <team-lead-bob> \
  --actor-id <team-lead-carol>
# Every retention mutation any of three team leads made across all 4
# prunable tables for one tenant.
```

**4. Compliance reviewer audit set**

```bash
# Auditor team has 5 members; show everything they did on the regulated cohort:
crossengin retention diff-timeline <reg-a> <reg-b> workflow_traces \
  --add-tenant <reg-c> --add-tenant <reg-d> --add-tenant <reg-e> \
  --actor-id <auditor-1> --actor-id <auditor-2> --actor-id <auditor-3> \
  --actor-id <auditor-4> --actor-id <auditor-5> \
  --since 2026-Q1 --with-actor-names --format json > audit-q1-2026.json
```

## Drawbacks

1. **Breaking field rename across three adapter input types + JSON envelope.** Contained scope (session-recent code, no external consumers). Documented one-shot break.
2. **Retention history `actorId` stays single** — divergence with diff-timeline's `actorIds`. Documented; could be widened in a separate milestone if measured demand emerges.
3. **OR semantic only** — operators wanting AND ("show events authored by Alice AND co-signed by Bob") need a different data model. Out of scope; substrate has one actor per row.
4. **No actor deduplication** — operators passing `--actor-id <alice> --actor-id <alice>` get `h.actor_id IN ($N1, $N2)` with both values being alice; PG handles this fine (duplicate IN values are no-ops). Documented; not worth substrate dedup.
5. **No null-actor sentinel** — operators wanting "Alice OR system-actor events" jq-filter for `actorId == null` on the result. Same as ADR-0193 deferred decision.
6. **No CLI-side UUID validation per flag occurrence** — invalid UUIDs hit PG error. Matches ADR-0193 deferred decision.

## Alternatives considered

1. **Keep `actorId?: string` and add `actorIds?: ReadonlyArray<string>` alongside** — two-field surface; adapter logic complicated by needing to merge or reject combinations. Rejected — one-shot rename is cleaner.
2. **Keep `actorId` as `string | ReadonlyArray<string>`** — union type forces every consumer to discriminate. Rejected.
3. **CLI builds OR semantic via jq post-filter** — breaks LIMIT correctness + future cursor pagination correctness (same trap ADR-0193 closed for single-actor). Rejected.
4. **Use PG's `= ANY($N::uuid[])`** instead of `IN ($N1, $N2, ...)` — single placeholder for array vs multi-placeholders. Cleaner SQL but the existing substrate uses positional placeholders throughout. Rejected for consistency.
5. **Widen retention history's actorId in the same milestone** — scope creep. Defer to a separate milestone if demand emerges.
6. **`--actor-id` accepts comma-separated values** (`--actor-id alice,bob`) — UUIDs don't contain commas but operators with shell variables could trip up. Rejected — repeated-flag matches the established multiFlags pattern.
7. **`--actors <a>,<b>` plural alias** — adds CLI surface for one concept. Rejected — repeated `--actor-id` is consistent with `--add-tenant`/`--add-table`.
8. **Reject duplicate values at CLI boundary** — substrate doesn't need to deduplicate; PG handles duplicate IN values fine. Rejected.

## Open questions

1. **Widen retention history's actorId to actorIds** for consistency with diff-timeline. Defer until measured demand.
2. **`--actor-id-not <uuid>`** for exclusion semantic (e.g., "all events except Alice's"). Defer.
3. **`--actor-name-equals <name>` repeated** for human-readable input via meta.users LEFT JOIN. Pairs with ADR-0185 Q2. Defer.
4. **Multi-actor `--system-only` mode** — `actor_id IS NULL` filter alongside multi-actor. Operators jq-filter for now. Defer.
5. **Composite index on `(actor_id, occurred_at)`** for high-cardinality multi-actor queries. Defer until measured.
6. **`--actor-id @file.txt`** reading actor IDs from a file for very large cohorts. Defer.
7. **Range cursor + multi-actor composition** — operators paginating with --after-id + multi-actor see correct behavior since IN-clause is part of WHERE; documented. No action needed.
