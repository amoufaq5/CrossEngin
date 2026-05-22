# ADR-0213: `crossengin retention diff-timeline --system-only` / `--no-system` actor-presence filter across all 3 dispatch paths (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.system-only)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0209 (--system-only/--no-system filter on retention history), ADR-0212 (--system-only/--no-system expectation check on retention diff-history), ADR-0207 (--actor-id-not multi across 3 paths precedent), ADR-0193 (--actor-id positive across 3 paths precedent) |

## Context

ADR-0209 shipped `--system-only` / `--no-system` as substrate-side WHERE filter on `retention history`. ADR-0212 shipped the diff-history expectation-check companion. ADR-0207 Q3 + ADR-0193's deferred future Q both listed the diff-timeline filter companion across all 3 dispatch paths (pair-wise + N-way via `--add-tenant` + cross-table via `--cross-table`) as future work:

> ADR-0207 Q3: `--system-only` + `--no-system` flags for explicit null actor matching/exclusion. Defer; same shape as ADR-0209 history filter, multi-path application.

This milestone closes those Qs and completes the `--system-only` / `--no-system` family on all 3 retention surfaces (retention history substrate-side filter from ADR-0209, retention diff-history expectation check from ADR-0212, retention diff-timeline substrate-side filter across all 3 paths from this milestone).

Use cases mirror ADR-0209's retention history filter motivations but on the cohort-comparison surface:

1. **Cross-tenant cohort cohort-vs-system audit** — "across these 5 tenants on `workflow_traces`, show ONLY the system-driven retention sweeps" (`--add-tenant` × 4 + `--system-only`).
2. **Cross-table human-only forensic timeline** — "across all 4 prunable tables for tenant X, show NO system events" (`--cross-table` + `--add-table` × 3 + `--no-system`) — operators investigating human responsibility during an incident window.
3. **Pair-wise migration verification** — "across the two tenants we migrated, show ONLY system events" (`--system-only`) — verify the migration script ran as system actor on both.
4. **Compliance attestation excluding automation** — "the regulated tenants' audit timeline excluding all automation cohorts" (`--no-system` composed with `--actor-id-not` for layered exclusion).

## Decision

### CLI surface

Added uniformly to all 3 diff-timeline dispatch paths:

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                    [--add-tenant <c> ...]
                                    [--system-only | --no-system]    # NEW
                                    [other flags...]

crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table
                                    [--add-table <c> ...]
                                    [--system-only | --no-system]    # NEW
                                    [other flags...]
```

- `--system-only` boolean flag — filters to events where `h.actor_id IS NULL`.
- `--no-system` boolean flag — filters to events where `h.actor_id IS NOT NULL`.
- Mutually exclusive at CLI boundary — both set returns exit 2 with `retention diff-timeline: --system-only and --no-system are mutually exclusive` error before any PG query.
- Single flag parse at the top of `runRetentionDiffTimeline` — threaded uniformly to whichever of the 3 adapter methods is dispatched (matches ADR-0193/0194/0207 pattern of parse-once-thread-three across diff-timeline).
- Composes with every existing diff-timeline filter (`--actor-id`, `--actor-id-not`, `--kind`, `--since`, `--until`, `--limit`, `--after-id`, `--before-id`, `--range`, `--with-actor-names`, `--add-tenant`, `--cross-table`, `--add-table`) without restriction.

### Adapter changes

All 3 diff-timeline input types gain optional `actorPresence?: ActorPresenceFilter` field reusing the exported type from ADR-0209:

```ts
// Already exported from ADR-0209:
export type ActorPresenceFilter = "system_only" | "no_system";

// Extended in this milestone:
export interface DiffHistoryTimelineInput {
  ...existing fields including actorIds + actorIdsNot...
  readonly actorPresence?: ActorPresenceFilter;
  ...
}
// Same field added to DiffHistoryTimelineNwayInput + DiffHistoryTimelineCrossTableInput.
```

Discriminated string union over two booleans matches ADR-0209 + ADR-0212 precedent — mutual exclusivity enforced at the type level, adapter consumers see a clean 3-state choice, CLI translates the two boolean flags into the single union value after mutual-exclusivity check.

Each of the 3 adapter methods (`diffHistoryTimeline`, `diffHistoryTimelineNway`, `diffHistoryTimelineCrossTable`) gains the same conditional WHERE clause positioned immediately after the existing `actorIdsNot` block, before the `eventKinds` block:

```ts
if (input.actorPresence === "system_only") {
  conditions.push(`h.actor_id IS NULL`);
} else if (input.actorPresence === "no_system") {
  conditions.push(`h.actor_id IS NOT NULL`);
}
```

No params needed — `IS NULL` / `IS NOT NULL` are SQL constructs not value comparisons. Same shape as ADR-0209's retention history WHERE clause construction. Mechanical 3-path symmetry.

### Why parallel implementation across 3 paths

Matches the established ADR-0193/0194/0199/0200/0202/0207 pattern — every diff-timeline filter exists in 3 identical conditional WHERE clauses (one per adapter method). Parallel implementation has these benefits:

1. **Same SQL clause structure** — 3 adapter methods share identical SQL shape for the actor-presence filter; operators reading any path see the same `h.actor_id IS NULL` / `IS NOT NULL` clause.
2. **One CLI flag parse, three adapter calls** — the CLI dispatcher parses `--system-only` / `--no-system` once at the top, threads `actorPresence` to whichever of the 3 adapter methods is selected.
3. **JSON envelope echo across 3 envelope shapes** — `systemOnly: boolean` + `noSystem: boolean` fields appear in all 3 envelope shapes (pair-wise no-discriminator, `nway:true`, `crossTable:true`) at the same position.

### Composition with --actor-id / --actor-id-not (from ADR-0193 + ADR-0207)

- `--system-only --actor-id <a> --actor-id <b>` is contradictory at the data layer (system events have `actor_id IS NULL`; `--actor-id` requires UUIDs in the IN list). Both clauses fire at SQL layer — system_only adds `h.actor_id IS NULL`, actor-IN adds `h.actor_id IN ($1, $2)`. PG natural outcome: empty result (an actor_id cannot be both NULL and equal to a non-null value). Operators see empty result and notice — substrate stays minimal.
- `--system-only --actor-id-not <a>` is redundant but valid (system events have `actor_id IS NULL` which satisfies the `IS NULL OR != $N` clause from ADR-0207's negative filter).
- `--no-system --actor-id <a>` is the canonical "filter to human actor X" idiom (actor_id = a implies non-null which `--no-system` also requires; both clauses fire; redundant but harmless).
- `--no-system --actor-id-not <a>` is the canonical "human cohort excluding X" idiom (distinguishes from `--actor-id-not <a>` alone which includes system events).

### Why substrate-side not jq-side

Same three reasons as ADR-0193/0194/0207 (substrate-side actor + kind + actor-not filters on diff-timeline):

1. **LIMIT correctness** — `--limit 100 --system-only` returns 100 system-authored entries from PG; jq-side post-filter returns fewer than 100.
2. **Cursor-pagination correctness** — `--after-id <id> --system-only` walks forward through system-only events; jq-side filter would interact wrongly with the page boundary.
3. **Index usage** — PG can use the existing `actor_id` index (partial index on `IS NULL` is a future Q if measured slow); jq filtering can't.

### JSON envelope

Gains two boolean fields on all 3 envelope shapes (pair-wise, N-way `nway:true`, cross-table `crossTable:true`):

```json
{
  "action": "diff-timeline",
  "nway": true,
  ...
  "actorIds": null,
  "actorIdsNot": null,
  "systemOnly": false,
  "noSystem": true,
  "kinds": null,
  ...
}
```

- `systemOnly: true` when `--system-only` set, `false` otherwise.
- `noSystem: true` when `--no-system` set, `false` otherwise.
- Mutual exclusivity at CLI guarantees both are never `true` simultaneously.

Position after `actorIdsNot` (matching the actor-dimension grouping in the JSON shape). Matches ADR-0209 history boolean-echo convention.

### Help text

Both diff-timeline usage lines extended with `[--system-only | --no-system]` notation. Description block updated to document the IS NULL / IS NOT NULL filter semantic + mutual exclusivity.

## Use cases unblocked

**1. Cross-tenant cohort vs system audit**

```bash
# Show ONLY system-driven retention sweeps across 5-tenant cohort:
crossengin retention diff-timeline $tenant_a $tenant_b workflow_traces \
  --add-tenant $tenant_c --add-tenant $tenant_d --add-tenant $tenant_e \
  --system-only --since 2026-04-01 --format json > q2-system-sweeps.json
```

**2. Cross-table human-only forensic timeline**

```bash
# Across all 4 prunable tables for tenant X, show NO system events:
crossengin retention diff-timeline $tenant_x workflow_traces llm_call_traces \
  --cross-table --add-table tenant_retention_opt_out_history \
  --add-table llm_latency_samples \
  --no-system --since $incident_start --with-actor-names
```

**3. Pair-wise migration verification**

```bash
# Verify the migration ran as system actor on both tenants:
crossengin retention diff-timeline $tenant_a $tenant_b workflow_traces \
  --system-only --kind retention_set --since $migration_start
```

**4. Compose with --actor-id-not for layered exclusion**

```bash
# Human cohort excluding migration SA cohort, on regulated table:
crossengin retention diff-timeline $tenant_a $tenant_b tenant_retention_opt_out_history \
  --no-system --actor-id-not $migration_sa_1 --actor-id-not $migration_sa_2 \
  --since $audit_period_start --with-actor-names --format json
```

**5. Compose with --actor-id positive cohort (redundant but valid)**

```bash
# Filter to specific human actors (--no-system redundant but harmless):
crossengin retention diff-timeline $tenant_a $tenant_b workflow_traces \
  --actor-id $alice --actor-id $bob --no-system --add-tenant $tenant_c
```

## Drawbacks

1. **Parallel implementation across 3 adapter methods** — same conditional WHERE block lives in 3 places (matches ADR-0193/0194/0199/0200/0202/0207 pattern). Acceptable structural symmetry; mechanical and reviewable.
2. **No partial index on `actor_id` IS NULL** — PG does index scan + sort on existing `actor_id` index for system-only queries. Acceptable at typical scales (system rows are a small fraction of audit log volume). Future Q if measured slow.
3. **Mutual exclusivity enforced at CLI not adapter** — adapter's discriminated string union type prevents both-at-once expression; CLI validates the two flags before translating. Direct adapter caller bypassing CLI cannot construct an invalid state. CLI-bypassing scripts must replicate the mutual-exclusivity check (same caveat as ADR-0209 + ADR-0212).
4. **Two-boolean JSON echo when adapter uses discriminated string** — CLI envelope shape diverges from adapter shape. Matches ADR-0209 + ADR-0212 convention for CLI-flag literal echo.
5. **Composition contradictions return empty silently** — `--system-only --actor-id <uuid>` is impossible (an actor_id can't be both NULL and equal to a UUID); substrate returns empty result. CLI doesn't pre-empt; operators see empty result and notice. Same stance as ADR-0207 (`--actor-id-not X` returning empty when `--actor-id X` also set).
6. **PG IN-list scaling concern unchanged** — operators with very large `--add-tenant` or `--add-table` lists + `--system-only` filter still hit PG IN-list limits (substrate doesn't chunk). Defer.
7. **No CLI-side validation of `--system-only` without `--system-only` companion arg** — boolean flag, no value to validate.

## Alternatives considered

1. **Two separate boolean fields on adapter** — allows invalid both-true state. Discriminated union matches ADR-0209/0212 precedent. Rejected.
2. **Single-path delivery (only pair-wise)** — would force N-way + cross-table operators to jq-filter for `actorId == null` post-fetch breaking LIMIT correctness. Symmetric coverage matches ADR-0193/0194/0199/0200/0202/0207 pattern. Rejected single-path.
3. **`--actor-presence <only|exclude>` single flag with enum value** — operators have to remember enum vocabulary instead of natural boolean flags. Matches ADR-0209 rejection.
4. **`--system` and `--human` as flag names** — "human" misleading (service accounts also non-system). Matches ADR-0209 rejection.
5. **`--actor-id null` sentinel value** — overloads `--actor-id` UUID semantic. Matches ADR-0209 rejection.
6. **CLI-side contradictory-combination preempting** (e.g., `--system-only --actor-id <uuid>` exit 2) — operators may script with both flags always set; substrate returns empty for impossible combinations as natural outcome. Same stance as ADR-0207. Rejected.
7. **Partial PG index on `actor_id IS NULL` in this milestone** — premature optimization without measurement. Schema migration concern. Defer.
8. **Substrate-side mutual-exclusivity check in adapter** — discriminated string union makes invalid unrepresentable. CLI handles mutual exclusivity at flag parsing. Cleaner.
9. **Apply `actorPresence` to retention diff (cross-tenant point-in-time diff) too** — different surface, different semantic (diff is per-tenant state comparison not history filter). Defer.
10. **Combine `--system-only` + `--no-system` into a single tri-state flag `--actor-presence <only|exclude|both>`** — `both` would be operator-confusing (default is `both`; setting it explicitly is redundant). Two boolean flags + mutual exclusivity matches established CLI convention.

## Open questions

1. **Partial PG index on `meta.tenant_retention_opt_out_history (actor_id) WHERE actor_id IS NULL`** — defer until measured slow at scale.
2. **`--actor-presence` flag on retention diff cross-tenant point-in-time** — different surface, different semantic. Defer.
3. **Per-side `--system-only-a` / `--system-only-b` on pair-wise diff-timeline** — operators wanting "tenant A's events must be system, tenant B's must be human" asymmetric filtering. Defer pairs with similar per-side family from ADR-0203 Q1 + ADR-0205 Q2 + ADR-0212 Q2.
4. **`actorPresence` filter on retention diff (current-state comparison)** — diff doesn't have history-row actor_id (it operates on policy state); semantically different. Defer.
5. **Short-circuit LEFT JOIN when `actorPresence === "system_only"`** — system events have no user row; the JOIN is wasted with `--with-actor-names`. Defer optimization.
6. **JSON envelope unification across `--system-only` family surfaces** — currently boolean pair across all 3 surfaces; could unify with single string discriminator. Operators write conditional jq branches per shape today. Defer.

## Implementation outline

Three additive code changes:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - All 3 diff-timeline input types (`DiffHistoryTimelineInput`, `DiffHistoryTimelineNwayInput`, `DiffHistoryTimelineCrossTableInput`) gain optional `actorPresence?: ActorPresenceFilter` field reusing the type from ADR-0209.
   - All 3 adapter methods (`diffHistoryTimeline`, `diffHistoryTimelineNway`, `diffHistoryTimelineCrossTable`) gain the same conditional WHERE block immediately after the existing `actorIdsNot` block (before `eventKinds`).

2. **`apps/architect-cli/src/retention.ts`**:
   - `runRetentionDiffTimeline` reads `systemOnlyFlag` + `noSystemFlag` via `getBooleanFlag` once at the top of the function (before path dispatch).
   - Mutual exclusivity check: both true → exit 2 with explicit error.
   - Translate to `actorPresence: "system_only" | "no_system" | undefined`.
   - Thread `actorPresence` to all 3 adapter method calls (pair-wise + N-way + cross-table).
   - JSON envelope on all 3 envelope shapes gains `systemOnly: systemOnlyFlag` + `noSystem: noSystemFlag` boolean fields.

3. **`apps/architect-cli/src/cli.ts`**:
   - Both diff-timeline usage lines (pair-wise + cross-table) extended with `[--system-only | --no-system]` notation.
   - Description blocks updated to document IS NULL / IS NOT NULL filter semantic + mutual exclusivity.

## Tests

9 new adapter tests in a new "PostgresTraceRetention diff-timeline actorPresence filter" describe block:

1. Pair-wise: adds `h.actor_id IS NULL` WHERE clause when `actorPresence='system_only'`.
2. Pair-wise: adds `h.actor_id IS NOT NULL` WHERE clause when `actorPresence='no_system'`.
3. Pair-wise: omits actor-presence WHERE clause when `actorPresence` not set.
4. N-way: adds `h.actor_id IS NULL` positioned after tenant IN list.
5. N-way: adds `h.actor_id IS NOT NULL` when `actorPresence='no_system'`.
6. Cross-table: adds `h.actor_id IS NULL` positioned after table IN list.
7. Cross-table: adds `h.actor_id IS NOT NULL` when `actorPresence='no_system'`.
8. Pair-wise: composes with all filter dimensions (actorIds + actorIdsNot + actorPresence + eventKinds + joinActor).
9. Pair-wise: adds no params for IS NULL / IS NOT NULL clauses (LIMIT param position correct).

10 new CLI tests in a new "runRetention diff-timeline --system-only / --no-system" describe block:

1. Returns exit 2 when `--system-only` AND `--no-system` both set with explicit error.
2. Pair-wise: threads `actorPresence: "system_only"` to adapter when `--system-only` set.
3. Pair-wise: threads `actorPresence: "no_system"` when `--no-system` set.
4. Pair-wise: omits `actorPresence` when neither flag set (backward compat).
5. N-way: threads `actorPresence` alongside `--add-tenant`.
6. Cross-table: threads `actorPresence` alongside `--cross-table`.
7. Pair-wise: composes with `--actor-id-not` + `--no-system` (both threaded independently).
8. Pair-wise: JSON envelope echoes `systemOnly + noSystem` when `--system-only` set.
9. N-way: JSON envelope echoes both booleans when `--no-system` set.
10. Cross-table: JSON envelope echoes both booleans when `--system-only` set.

cli.ts helpText extended on both diff-timeline usage lines with `[--system-only | --no-system]` notation + descriptions updated explaining IS NULL / IS NOT NULL filter semantic + mutual exclusivity.

Test count: 8,985 → 9,004 (+19 net: adapter +9, CLI +10).

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green (no new errors from this milestone; pre-existing `labelForIndex` + `chat.ts` errors unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

The `--system-only` / `--no-system` family is now COMPLETE across all 3 retention surfaces:

| Surface | Semantic | ADR |
|---|---|---|
| `retention history` | substrate-side filter (single path) | ADR-0209 |
| `retention diff-history` | expectation check (2 fixed IDs) | ADR-0212 |
| `retention diff-timeline` | substrate-side filter (3 dispatch paths) | ADR-0213 (this milestone) |

Operators get system-vs-human ergonomics on every retention CLI surface with surface-appropriate semantics (filter on list-style queries, expectation check on cross-event diff).

The retention CLI now has 18 actions with comprehensive multi-flag coverage:
- 4 actor-related filter families (`--actor-id`, `--actor-id-not`, `--system-only`, `--no-system`) on list-style surfaces (retention history + retention diff-timeline) — all multi-value or boolean as appropriate.
- 5 expectation-check families on retention diff-history (`--kind`, `--kind-not`, `--actor-id`, `--actor-id-not`, `--system-only`/`--no-system`) plus `--with-actor-names`.

Subsequent milestones can extend per-side asymmetric expectations on diff-history (closes ADR-0203 Q1 + ADR-0205 Q2 + ADR-0208 Q2 + ADR-0212 Q3 family), multi-value tuple expectations on diff-history (closes ADR-0203 Q2 + ADR-0205 Q1 + ADR-0208 Q1 family), or apply the multi-value pattern to retention history's `--kind` filter (ADR-0211 Q8).
