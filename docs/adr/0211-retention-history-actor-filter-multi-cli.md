# ADR-0211: `crossengin retention history --actor-id` repeatable for multi-value OR-semantic positive filter (Phase 2 M6.7.zz.tenant.opt-out.cli.history.actor-filter.multi)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0186 (--actor-id single-value filter), ADR-0210 (--actor-id-not multi-value precedent on same surface), ADR-0199 (diff-timeline multi-actor positive precedent), ADR-0183 (multiFlags infrastructure) |

## Context

ADR-0186 shipped `--actor-id <uuid>` as a single-value substrate-side WHERE filter on `retention history`. Future Q1 explicitly listed widening to multi-value via repeated flag using the `multiFlags` infrastructure from ADR-0183:

> 1. multi-actor via repeated `--actor-id` using ADR-0183 multiFlags infrastructure (operators with cohort audit needs would benefit; defer until measured demand emerges).

ADR-0210 just shipped multi-value `--actor-id-not` on the same surface, closing ADR-0206 Q1 — but deliberately scoped to the negative-filter dimension only because the user request was scoped there. ADR-0210 documented an explicit within-surface asymmetry:

> The retention history surface now has a documented within-surface asymmetry on the actor filter dimension: positive `--actor-id` stays single-value while negative `--actor-id-not` is multi-value. Widening `--actor-id` to multi-value on retention history closes ADR-0186 future Q + restores within-surface symmetry. Natural follow-up milestone.

This milestone IS that follow-up milestone. M6.7.zz.tenant.opt-out.cli.history.actor-filter.multi closes ADR-0186 Q1 and restores within-surface symmetry on retention history.

Real cohort-inclusion use cases motivate the widening (mirror of the cohort-exclusion uses from ADR-0210):

1. **Multi-actor cohort audit** — operators auditing activity by a specific 3-actor cohort (auditor + reviewer + approver triad on a regulated tenant) want to include ALL their events in one query, with LIMIT correctness + cursor-pagination correctness preserved.
2. **Multi-admin attestation** — "show every mutation made by ANY of these 4 platform admins" in one command for SOC 2 attestation.
3. **Multi-SA observability** — operators monitoring N service accounts simultaneously ("show every retention_set event made by any of our 3 migration SAs during Q2").
4. **Composed positive cohort + exclusion** — "any of these N expected actors EXCEPT these M noise actors" — composes with `--actor-id-not` from ADR-0210 for fine-grained cohort queries.

Closes ADR-0210's documented within-surface asymmetry. Restores parity with diff-timeline (ADR-0199 positive multi + ADR-0207 negative multi) — both filter surfaces now have multi-value on both positive + negative dimensions.

## Decision

### CLI surface

```
crossengin retention history [--actor-id <uuid> ...]       # NEW: repeatable
                             [--actor-id-not <uuid> ...]
                             [--system-only | --no-system]
                             [other flags from ADR-0186/0196/etc.]
                             [--format human|json]
```

- `--actor-id <uuid>` is now repeatable via the `multiFlags` infrastructure from ADR-0183.
- Single occurrence: `--actor-id <a>` filters to one actor's events (equivalent to ADR-0186 single-value behavior; same query plan).
- Multi occurrence: `--actor-id <a> --actor-id <b> --actor-id <c>` builds OR-semantic IN ($1, $2, $3) clause.
- Empty (zero occurrences): treated as filter-not-set (no WHERE clause emitted) — backward compat.
- Composes with `--actor-id-not <uuid> ...` (negative filter from ADR-0210) and `--system-only` / `--no-system` (from ADR-0209) and every other existing filter without restriction.

### Adapter changes

`ListOptOutHistoryInput` field rename — breaking change matching ADR-0210's precedent (session-recent code, no external consumers, contained scope):

```ts
// Before (ADR-0186):
readonly actorId?: string;

// After (this milestone):
readonly actorIds?: ReadonlyArray<string>;
```

One-shot clean break beats permanent two-field surface. Same pattern as ADR-0199 (`actorId → actorIds` on diff-timeline) and ADR-0210 (`actorIdNot → actorIdsNot` on retention history) — the workspace has established the breaking-rename precedent for the actor filter family.

SQL changes from single-value `h.actor_id = $N` to multi-value `h.actor_id IN ($N1, $N2, ...)`:

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

Single-element array yields `IN ($N)` — PG treats this identically to `= $N` (no observable behavior change for single-value callers; same query plan).

Empty array treated as filter-not-set matching ADR-0199/0207/0210 convention.

### No `IS NULL OR` prefix on positive filter

Unlike `--actor-id-not` which prepends `IS NULL OR` (to include system events when excluding specific actors), the positive `--actor-id` filter intentionally does NOT include null actor_id events. Operators wanting "match these actors" do NOT mean "and also include all system events"; PG's `actor_id IN ($1, $2)` returns NULL when actor_id IS NULL → filtered out, which is correct semantic. Operators wanting both human cohort + system events use `--actor-id <uuid> --actor-id <uuid> --system-only` (positive cohort + positive system) — though those clauses would AND together producing no results since an event is either system or has actor_id, never both. Operators wanting "cohort OR system" jq-merge two queries.

### Why duplicates are not deduplicated at adapter

If operator passes `--actor-id <a> --actor-id <a>`, adapter builds `IN ($1, $2)` with both placeholders set to the same value. PG handles duplicates fine in IN lists (semantic identical to single-value). Substrate doesn't dedup — operator's duplicates pass through verbatim, matches ADR-0210 stance.

### CLI changes

`runRetentionHistory` reads via `getMultiFlag("actor-id")` instead of `getStringFlag("actor-id")`:

```ts
const actorIdsFlags = getMultiFlag(command, "actor-id");
const actorIds: ReadonlyArray<string> | undefined =
  actorIdsFlags.length > 0 ? actorIdsFlags : undefined;
```

Threads `actorIds` to adapter. No mutual-exclusivity check needed (multi-value via repeated flag is the natural extension of single-value; one occurrence = single-value behavior preserved).

### JSON envelope rename

```json
{
  "tenantFilter": null,
  "tableFilter": null,
  "eventKind": null,
  "actorIds": ["uuid-a", "uuid-b"],      // RENAMED: was actorId
  "actorIdsNot": null,
  "systemOnly": false,
  "noSystem": false,
  ...
}
```

Breaking JSON envelope rename — `actorId: string | null` → `actorIds: string[] | null`. Operators parsing the envelope:
- Single-occurrence: `actorIds: ["<uuid>"]`.
- Multi-occurrence: `actorIds: ["<a>", "<b>", ...]`.
- Not set: `actorIds: null`.

Same shape as ADR-0210's `actorIdsNot` envelope — array-or-null is the canonical multi-value envelope shape across the family.

### Within-surface symmetry restored

Before this milestone (post-ADR-0210):

| Filter | Shape | ADR |
|---|---|---|
| `--actor-id` | single string | ADR-0186 (single-value) |
| `--actor-id-not` | string array | ADR-0210 (multi-value) |
| `--system-only` / `--no-system` | boolean pair | ADR-0209 |

After this milestone:

| Filter | Shape | ADR |
|---|---|---|
| `--actor-id` | string array | ADR-0211 (this milestone) |
| `--actor-id-not` | string array | ADR-0210 |
| `--system-only` / `--no-system` | boolean pair | ADR-0209 |

Symmetric. Both positive + negative actor filters on retention history are now multi-value (mirror of diff-timeline's ADR-0199 + ADR-0207 symmetry).

## Use cases unblocked

**1. Multi-actor cohort audit**

```bash
# Audit activity by 3-actor cohort (auditor + reviewer + approver triad):
crossengin retention history --tenant <regulated> \
  --actor-id <auditor> --actor-id <reviewer> --actor-id <approver> \
  --since 2026-04-01 --with-actor-names --format json > triad-q2-audit.json
```

**2. Multi-admin attestation**

```bash
# Show every mutation made by ANY of the 4 platform admins:
crossengin retention history \
  --actor-id <admin-1> --actor-id <admin-2> \
  --actor-id <admin-3> --actor-id <admin-4> \
  --since 2026-04-01 --until 2026-06-30 --with-actor-names
```

**3. Multi-SA observability**

```bash
# Monitor retention_set events from 3 migration SAs during Q2:
crossengin retention history --kind retention_set \
  --actor-id <migration-sa-1> --actor-id <migration-sa-2> --actor-id <migration-sa-3> \
  --since 2026-04-01 --until 2026-06-30 --format json
```

**4. Composed positive cohort + exclusion**

```bash
# Any of these 3 expected actors EXCEPT these 2 noise actors:
crossengin retention history \
  --actor-id <a> --actor-id <b> --actor-id <c> \
  --actor-id-not <noise-1> --actor-id-not <noise-2> \
  --with-actor-names
```

**5. Compose with --no-system + multi-actor**

```bash
# Human cohort (no system events) filtered to specific actors:
crossengin retention history --no-system \
  --actor-id <human-1> --actor-id <human-2> \
  --with-actor-names
```

## Drawbacks

1. **Breaking adapter field rename `actorId → actorIds`** — direct adapter consumers (Node scripts calling the adapter without the CLI layer) need to update. Contained scope, session-recent code (ADR-0186 shipped originally as session-recent, has been actorId for some time but no external production consumers). Same one-shot break justification as ADR-0199/0207/0210.
2. **Breaking JSON envelope rename `actorId → actorIds`** — operator jq scripts parsing the envelope need to update. Same justification as adapter rename. Operators reading either path can detect the rename via the array-vs-string shape.
3. **No CLI-side dedup** — operators passing `--actor-id <a> --actor-id <a>` get a duplicate placeholder in SQL; PG handles fine but operator confusion possible. Defer; same stance as ADR-0207/0210.
4. **No mixed cohort + system events in one query** — positive multi-actor filter excludes null actor_id events (system events). Operators wanting "Alice + Bob + system" need jq-merge two queries or use the `retention diff-timeline` surface which has the same shape. Defer; documented.
5. **PG IN-list at very large scale** — operators passing 100+ `--actor-id` flags hit PG parser limits; substrate doesn't chunk. Defer until measured slow. Realistic operator cohorts have <20 actors.
6. **No CLI-side UUID validation per flag occurrence** — invalid UUIDs surface as PG errors with clearer messages. Matches ADR-0175/0186/0193/0206/0210 deferred decision.
7. **Two breaking renames in two consecutive milestones (ADR-0210 + ADR-0211)** — operators wrapping the retention history CLI with their own scripts have to update both `actorId` and `actorIdNot` references in one development window. Acceptable since both renames are session-recent code with no external production consumers; the alternative (two milestones in two different weeks) would extend the asymmetry window.

## Alternatives considered

1. **Ship in same milestone as ADR-0210 (combined `--actor-id` + `--actor-id-not` multi-value)** — would close both ADR-0186 Q1 + ADR-0206 Q1 in one shot, BUT exceeded the user's scope for the prior milestone ("multi-value --actor-id-not on retention history"). Shipping as a follow-up milestone respects the per-request scope discipline.
2. **Two-field adapter surface (`actorId: string` + `actorIds: ReadonlyArray<string>`)** — permanent two-field surface invites operator confusion. One-shot rename cleaner, matches ADR-0199/0210 precedent.
3. **`--actor-id <a,b,c>` comma-separated single flag** — fragile with shell-quoted UUIDs; multi-flag via repeated flag is the established `multiFlags` pattern.
4. **Keep single-value `--actor-id`, document within-surface asymmetry as permanent** — documented as future Q in ADR-0210 already; ignoring would entrench the asymmetry. Restoring symmetry is operator-friendly.
5. **Include null actor_id in IN-list match** — operators wanting "match these actors OR system" don't use IN since the semantic is unclear ("match these actors and also include system events that are NEITHER of these actors" doesn't compose). Keep IN clause pure; operators compose with `--system-only` / `--no-system` from ADR-0209 explicitly.
6. **`@file.txt` substitution for very large lists** — operators jq-build from JSON or use shell `$(cat ...)` substitution for now. Defer.
7. **CLI-side dedup of duplicate values** — PG handles fine; substrate stays minimal. Matches ADR-0210 stance.
8. **`--actor-name` filter via meta.users.display_name JOIN** — pairs with ADR-0185 Q2; defer.

## Open questions

1. **`--actor-id @file.txt` for very large cohorts** — operators jq-build from JSON or use shell substitution for now. Defer.
2. **CLI-side UUID validation per flag occurrence** — defer matching ADR-0175/0186/0193/0206/0210 pattern.
3. **Substrate-side deduplication of duplicate values in `actorIds`** — defer; PG handles fine, no measured perf issue.
4. **Composite index on `(actor_id, occurred_at)`** for large-scale actor-scoped pagination — defer until measured slow.
5. **`--actor-name <name>` filter via meta.users.display_name JOIN** — pairs with ADR-0185 Q2. Defer.
6. **PG IN-list chunking at substrate level** for 1K+ actors — defer until measured.
7. **Mixed cohort + system mode** — `--actor-id <a> --actor-id <b> --include-system` would require `(actor_id IN ($1, $2) OR actor_id IS NULL)` SQL. Defer; not measured demand.
8. **Apply same multi-value widening to retention history's positive `--kind` filter** — `--kind <event-kind>` on retention history stays single-value (ADR-0170); the 4-value enum makes multi-value less compelling than for the unbounded UUID actor dimension. Defer; pairs with ADR-0200 Q5 (which widened `--kind` to multi on diff-timeline).

## Implementation outline

Two-file additive code change + one breaking adapter rename:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - `ListOptOutHistoryInput.actorId?: string` → `actorIds?: ReadonlyArray<string>` (breaking rename).
   - Adapter SQL change from `params.push(input.actorId)` + `h.actor_id = $N` to multi-placeholder IN construction matching ADR-0207's diff-timeline pattern.

2. **`apps/architect-cli/src/retention.ts`**:
   - `runRetentionHistory` reads via `getMultiFlag(command, "actor-id")` instead of `getStringFlag`.
   - Threads `actorIds: ReadonlyArray<string> | undefined` to adapter.
   - JSON envelope renamed `actorId: string | null` → `actorIds: string[] | null`.

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention history` usage line updated from `[--actor-id <uuid>]` to `[--actor-id <uuid> ...]` indicating repeatable.
   - Description block extended explaining "repeatable" + OR-semantic IN.

## Tests

Adapter test block rewritten + expanded from 7 → 11 tests under renamed "actorIds filter" describe block:

1. Single-element IN ($1) verified via SQL substring + params.
2. Multi-element IN ($1, $2) verified via two placeholders (NEW).
3. Omits clause when not set.
4. Empty array treated as filter-not-set (NEW).
5. Composes with tenantId (multi-actor + tenant filter).
6. Composes with joinActor (LEFT JOIN + IN both present).
7. Composes with actorIdsNot (positive + negative both threaded — NEW).
8. Composes with all filter dimensions (full param array verified).
9. Returns rows matching the actors.
10. Returns empty array when no rows match.
11. Duplicate actorIds values produce duplicate placeholders (NEW; PG dedupes via IN semantic).

Plus updates to two cross-reference tests in the before-id and range describe blocks (`actorId: ACTOR_A` → `actorIds: [ACTOR_A]` in composition tests) and one cross-reference in the actor-not block (positive+negative composition test) — no count change for those.

CLI test block rewritten + expanded from 7 → 9 tests under renamed "runRetention history --actor-id" describe block:

1. Threads `actorIds: [ACTOR_A]` as single-element array when set once.
2. Threads multi-element array when `--actor-id` repeated (NEW).
3. Omits when NOT set backward compat.
4. Composes with other filters (multi --actor-id + --tenant + --kind).
5. Composes with --with-actor-names (multi actor + LEFT JOIN).
6. JSON envelope echoes single-element array.
7. JSON envelope echoes multi-element array (NEW).
8. JSON envelope `actorIds=null` when not set.
9. Human-format empty-result message preserved when `--actor-id` has no matches.

cli.ts helpText extended for retention history usage line — `[--actor-id <uuid> ...]` notation + description updated to "repeatable" + OR-semantic IN.

Test count: 8,960 → 8,966 (+6 net: adapter +4, CLI +2). The block rewrites kept existing single-value coverage while adding multi-value coverage.

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green (no new errors from this milestone; pre-existing `labelForIndex` + `chat.ts` errors unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

Retention history's actor filter family now matches diff-timeline's symmetric multi-value design:

| Surface | Positive | Negative |
|---|---|---|
| `retention history` | `--actor-id ...` multi (ADR-0211) | `--actor-id-not ...` multi (ADR-0210) |
| `retention diff-timeline` | `--actor-id ...` multi (ADR-0199) | `--actor-id-not ...` multi (ADR-0207) |
| `retention diff-history` | `--actor-id <uuid>` single (ADR-0203 — expectation check) | `--actor-id-not <uuid>` single (ADR-0205 — expectation check) |

The diff-history surface stays single-value because the semantic is per-event-pair expectation check, not list-style filter — multi-value tuple expectation is a different shape deferred to ADR-0205 Q1 / ADR-0203 Q2.

The retention CLI now has 18 actions with multi-value `--actor-id` + `--actor-id-not` support on the two list-style audit-log filter surfaces (retention history + retention diff-timeline). Operators get cohort-inclusion + cohort-exclusion ergonomics with surface-appropriate semantics under one consistent flag-name family.
