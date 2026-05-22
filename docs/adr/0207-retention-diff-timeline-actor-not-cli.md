# ADR-0207: `crossengin retention diff-timeline --actor-id-not` actor exclusion filter across all three diff-timeline paths (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.actor-not)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0193 (--actor-id positive filter on diff-timeline), ADR-0199 (--actor-id repeatable multi-actor), ADR-0206 (--actor-id-not filter on retention history), ADR-0186 (--actor-id filter on retention history) |

## Context

ADR-0193 shipped `--actor-id <uuid>` substrate-side WHERE filter on `retention diff-timeline` across all three dispatch paths (pair-wise + N-way + cross-table). ADR-0199 made it repeatable (multi-actor OR-semantic via `actorIds: ReadonlyArray<string>`). ADR-0206 just shipped `--actor-id-not <uuid>` substrate-side WHERE NOT filter on `retention history` (single-value).

ADR-0206 Q3 listed `--actor-id-not` on diff-timeline as future work. The diff-timeline surface uses multi-value `actorIds[]` (from ADR-0199) for the positive filter, so the symmetric negative filter should also be multi-value to maintain surface consistency: `actorIdsNot: ReadonlyArray<string>` rather than the retention-history single-value `actorIdNot: string` from ADR-0206.

M6.7.zz.tenant.opt-out.cli.diff-timeline.actor-not closes ADR-0193 + ADR-0206 Q3 by adding multi-actor exclusion uniformly across all three diff-timeline dispatch paths.

## Decision

### CLI surface

```
crossengin retention diff-timeline <a> <b> <table>
                                   [--add-tenant <c> ...]
                                   [--actor-id <uuid> ...]
                                   [--actor-id-not <uuid> ...]   # NEW
                                   [--kind <event-kind> ...]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>]
                                   [--before-id <uuid>]
                                   [--range <after-id>..<before-id>]
                                   [--format human|json]

crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table
                                   [--add-table <c> ...]
                                   [--actor-id <uuid> ...]
                                   [--actor-id-not <uuid> ...]   # NEW
                                   [--kind <event-kind> ...]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>]
                                   [--before-id <uuid>]
                                   [--range <after-id>..<before-id>]
                                   [--format human|json]
```

- `--actor-id-not <uuid>` repeatable via multiFlags from ADR-0183 — each occurrence appends one actor to the exclusion set.
- Composes with all existing flags. NOT mutually exclusive with `--actor-id` — both clauses fire independently at the SQL layer.
- No CLI-side UUID validation (matches deferred decision).

### Adapter changes

All three input types (`DiffHistoryTimelineInput` + `DiffHistoryTimelineNwayInput` + `DiffHistoryTimelineCrossTableInput`) gain optional `actorIdsNot?: ReadonlyArray<string>` field. When set with non-empty array, the SQL WHERE clause adds:

```sql
(h.actor_id IS NULL OR h.actor_id NOT IN ($N1, $N2, ...))
```

Two important details:

1. **Includes system events (null actor_id)** — explicitly OR'd with `actor_id IS NULL`. Matches ADR-0206's reasoning: PG's `NOT IN ($N1, ...)` returns NULL (not true) for null values, silently filtering system events out. Operators using `--actor-id-not <alice>` expect "everything not authored by Alice" including system events.

2. **Substrate-side, not jq-side** — three reasons matching ADR-0193 + ADR-0206: LIMIT correctness, future cursor-pagination correctness, index usage if composite index added.

Filter position is immediately after the positive `actorIds` filter in WHERE-clause assembly — keeps actor-related clauses grouped.

### Multi-value via `NOT IN` SQL

Single excluded actor produces `NOT IN ($N1)`, multiple produce `NOT IN ($N1, $N2, ...)`. PG handles both forms identically. Operators chaining `--actor-id-not <a> --actor-id-not <b>` exclude both Alice AND Bob's events. Empty array treated as filter-not-set (no WHERE clause added; matches ADR-0199's empty-array convention).

### Why multi-value here but single-value on retention history (ADR-0206)

Diff-timeline already uses multi-value `actorIds: ReadonlyArray<string>` from ADR-0199 — symmetric negative would be multi-value too. Retention history uses single-value `actorId: string` from ADR-0186 — symmetric negative is single-value `actorIdNot: string` from ADR-0206. Within each surface, positive and negative filters share the same value-shape; across surfaces, the divergence reflects the ADR-0199 widening of diff-timeline that didn't extend to retention history (documented future Q from ADR-0199).

### CLI dispatcher

`runRetentionDiffTimeline` reads `--actor-id-not` via `getMultiFlag` returning `string[]`; passes `actorIdsNot` to whichever of three adapter methods is dispatched (pair-wise, N-way, cross-table). Same single-read-multi-thread pattern as `--actor-id` from ADR-0193/0199.

### JSON envelope

All three envelope shapes (pair-wise no-discriminator, `nway:true`, `crossTable:true`) gain `actorIdsNot: string[] | null` field echoing operator input. Positioned right after `actorIds` field for consistency. Renders as `null` when not set.

```json
{
  "action": "diff-timeline",
  "actorIds": null,
  "actorIdsNot": ["22222222-..."],
  "kinds": null,
  ...
}
```

### Why parallel implementation across all three paths

Same reasoning as ADR-0193/0194/0199/0200/0202 — the three paths share cursor + JSON envelope code, adding the exclusion clause to each is mechanical and structurally identical. One milestone covers all three because the lift is identical and operator-facing surface stays consistent.

## Use cases unblocked

**1. Cohort drift detection excluding noise actors**

```bash
# Compare 5-tenant cohort timeline excluding migration SA + sweep SA:
crossengin retention diff-timeline <a> <b> workflow_traces \
  --add-tenant <c> --add-tenant <d> --add-tenant <e> \
  --actor-id-not <migration-sa> --actor-id-not <sweep-sa> \
  --with-actor-names --format json
```

**2. Cross-table audit excluding automation**

```bash
# One tenant × all prunable tables, exclude automated mutations:
crossengin retention diff-timeline <tenant> workflow_traces llm_call_traces \
  --cross-table --add-table llm_latency_samples \
  --actor-id-not <automation-sa-uuid>
```

**3. Self-exclude reviewer audit**

```bash
# What did everyone else do during incident window (exclude my own mutations)?
crossengin retention diff-timeline <a> <b> workflow_traces \
  --since <incident-start> --until <incident-end> \
  --actor-id-not $MY_ACTOR_ID --with-actor-names
```

**4. Compose positive + negative for fine-grained filter**

```bash
# Alice OR Bob's events, excluding Carol's events (if Carol overlaps the cohort):
crossengin retention diff-timeline <a> <b> workflow_traces \
  --actor-id <alice> --actor-id <bob> \
  --actor-id-not <carol>
# Returns Alice's events + Bob's events (where neither is Carol — but since Alice
# and Bob aren't Carol, this filter is effectively redundant in this case;
# operators use it when actor sets overlap unpredictably).
```

## Drawbacks

1. **Multi-value asymmetry with retention history** — diff-timeline uses `actorIdsNot: string[]`, retention history uses `actorIdNot: string`. Documented intentional divergence following ADR-0186 vs ADR-0193/0199 asymmetry. Future widening Q in ADR-0206 covers retention history side.
2. **Includes system events** — by design (matches ADR-0206 reasoning); operators wanting "exclude system events too" need separate flag (defer).
3. **Contradictory composition with `--actor-id`** — `--actor-id alice --actor-id-not alice` returns empty silently (SQL natural outcome `actor_id IN (alice) AND (actor_id IS NULL OR actor_id NOT IN (alice))` is unsatisfiable). Acceptable; operators won't set contradictory flags accidentally.
4. **No CLI-side UUID validation** — matches established pattern.
5. **Three-path parallel implementation** — same structural symmetry as ADR-0193/0194/0199/0200/0202; mirrors how every other diff-timeline filter exists three times.
6. **No `--actor-id-not <a>|<b>` pipe-separated single flag** — operators use repeated flag occurrences via multiFlags; consistent with ADR-0199 multi-actor positive pattern.

## Alternatives considered

1. **CLI-side jq filter as documented workflow** — breaks LIMIT + future cursor correctness. Rejected (matches ADR-0193/0206 reasoning).
2. **Single-value `actorIdNot: string` to match ADR-0206 retention history** — would diverge from diff-timeline's existing multi-value `actorIds[]` from ADR-0199; within-surface consistency wins. Rejected.
3. **Use `actor_id NOT IN ($N1, ...)` alone without IS NULL OR** — silently filters system events out, losing operator intent. Rejected.
4. **Use `actor_id IS DISTINCT FROM $N` per-value** — only works for single-value comparison; doesn't compose with IN list. Rejected for multi-value.
5. **Mutually exclusive with `--actor-id` at CLI boundary** — would block valid intentional contradictions and noise-overlap patterns. Adapter natural outcome (empty result) is cleaner. Rejected.
6. **Substrate-side rejection of contradictory `actorIds + actorIdsNot` overlap** — adds validation for an unlikely case; SQL handles correctly. Rejected.
7. **Pipe-separated single flag `--actor-id-not a|b|c`** — operators with shell vars containing pipes hit edge cases; repeated flag via multiFlags is the established pattern.
8. **Three separate flags per dispatch path** — `--pair-wise-actor-id-not` / `--nway-actor-id-not` / `--cross-table-actor-id-not` would be ridiculous; single uniform flag matches established pattern.

## Open questions

1. **`--actor-id-not` on retention diff-history** — closes ADR-0205 future-Q gap (already shipped as expectation check in ADR-0205; filter doesn't apply to diff-history). Already done.
2. **Widen retention history `--actor-id-not` to multi-value** — pairs with ADR-0199's widening of diff-timeline's positive filter; matches ADR-0206 Q1. Defer.
3. **`--system-only` + `--no-system` explicit null-actor matching/exclusion** — defer; operators jq-filter for now.
4. **`--kind-not` exclusion filter on diff-timeline** — symmetric companion to `--kind` multi-value from ADR-0200. Defer.
5. **Composite index on `(actor_id, occurred_at)`** for large-scale actor-scoped pagination. Defer until measured slow.
6. **`--actor-name-not <name>` filter via meta.users JOIN** for human-readable input. Pairs with ADR-0186 Q3. Defer.
