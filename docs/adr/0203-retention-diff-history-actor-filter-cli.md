# ADR-0203: `crossengin retention diff-history --actor-id` actor expectation check (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.actor-filter)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0198 (--kind expectation check on diff-history), ADR-0193 (--actor-id filter on diff-timeline), ADR-0186 (--actor-id filter on retention history), ADR-0170 (history audit log + actor_id column) |

## Context

ADR-0198 shipped `--kind` as an expectation check on `retention diff-history` — operator declares "I expect both these events to have event_kind X" and the adapter throws when reality differs. ADR-0198 Q3 explicitly listed `--actor-id` expectation check on diff-history as future work: "Same shape; defer."

ADR-0193 shipped `--actor-id` as a substrate-side WHERE filter on `retention diff-timeline` (across all three dispatch paths). ADR-0186 shipped it on `retention history`. Both are list-style queries where filter semantics apply naturally.

`diff-history` takes exactly two IDs — there's nothing to filter. The meaningful interpretation mirrors ADR-0198 on the actor dimension: `--actor-id` becomes an **expectation check**. Operator declares "I expect both these events to have actor_id X" and the adapter throws when reality differs. Useful for:

1. **Compliance scripts** asserting "diff these two policy_deleted events Alice authored" without accidentally comparing across actors.
2. **Forensic analysis** verifying that two events from an audit pair were indeed authored by the suspect actor before producing the diff.
3. **CI gates** ensuring automated migration scripts ran as the expected service account on both events.

M6.7.zz.tenant.opt-out.cli.diff-history.actor-filter closes ADR-0198 Q3 by threading `--actor-id` through `retention diff-history` as an expectation check — mirror of ADR-0198's `--kind` pattern on the actor dimension.

## Decision

### CLI surface

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--kind <event-kind>]
                                  [--actor-id <uuid>]   # NEW
                                  [--format human|json]
```

- `--actor-id <uuid>` added as a single optional flag.
- Composes with `--kind` from ADR-0198 — both expectations applied independently; either mismatch throws.
- No CLI-side UUID validation (matches deferred decision across cursor + actor-filter ADRs; invalid UUIDs hit PG with a clearer error than CLI substring matching).

### Adapter changes

`DiffHistoryEntriesInput` gains optional `actorId?: string` field. The adapter SELECT now includes the `actor_id` column on the result row type. After the existing same-tenant + same-table + valid-event_kind + eventKind expectation checks, an actorId mismatch validation:

```ts
if (input.actorId !== undefined) {
  const mismatches: string[] = [];
  if (entryA.actor_id !== input.actorId) {
    mismatches.push(
      `A is ${entryA.actor_id === null ? "<system>" : `'${entryA.actor_id}'`}`,
    );
  }
  if (entryB.actor_id !== input.actorId) {
    mismatches.push(
      `B is ${entryB.actor_id === null ? "<system>" : `'${entryB.actor_id}'`}`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      `diffHistoryEntries: expected both events to have actor_id '${input.actorId}' but ${mismatches.join(" and ")}`,
    );
  }
}
```

Error message names whichever sides don't match. Null `actor_id` (system actor) renders as `<system>` — operators looking up the actor never see ambiguous quoting around a literal "null" string. Same `<system>` convention as ADR-0185 retention history rendering.

### Why "expectation check" not "filter"

`retention diff-history`'s input is exactly two IDs — there's nothing to "filter." Same semantic shift as ADR-0198 for `--kind`: expectation check, not filter. Two events fetched; if either doesn't match the expected actor, the query is invalid from the operator's perspective.

### `<system>` rendering for null actor_id

When `actor_id` IS NULL (system-authored events from cron jobs, scheduled retention, etc.), the mismatch message renders `B is <system>` rather than `B is 'null'`. Three reasons:

1. **Unambiguous** — operators can't confuse the literal string "null" (which would be a malformed UUID) with the system-actor sentinel.
2. **Consistency** — matches ADR-0185 `<system>` rendering on retention history human output.
3. **No null sentinel for input** — operators wanting "assert both events are system events" run `--actor-id system` would imply a sentinel value. We don't support that here. Operators wanting to check for system events use `--format json | jq 'select(.result... )'`. Same as ADR-0186 null-actor stance — substrate stays minimal, one filter per dimension.

### Error path: exit 1 (runtime) not exit 2 (misuse)

Matches ADR-0198's pattern exactly. CLI input validation (invalid `--actor-id` syntax — though we don't validate UUID shape) would exit 2. Adapter mismatch throws are caught by the runner and propagate exit 1 (runtime path) matching cross-tenant + cross-table + eventKind mismatch.

### JSON envelope

Gains `actorId: string | null` field echoing the operator's expectation (or null when not set). Matches the ADR-0198 envelope convention:

```json
{
  "action": "diff-history",
  "kind": "opt_out_set",
  "actorId": "11111111-0000-4000-8000-000000000001",
  "result": { ... }
}
```

When both `--kind` and `--actor-id` set, both fields populate. When neither set, both render as `null`.

### No additional human-format change

The existing `formatHistoryDiff` doesn't render actor information in the metadata header (operators wanting actor names use `retention history --with-actor-names` on each event separately — defer combined surface to ADR-0198 Q5 noted as future work). When `--actor-id` is set and both match, the diff renders normally. When actors mismatch, the adapter throws before reaching the formatter.

## Use cases unblocked

**1. Compliance script asserting actor match**

```bash
# Assert both events were authored by Alice before producing the diff:
crossengin retention diff-history <id-a> <id-b> --actor-id <alice-uuid>
# Exit 0 if both match + diff rendered. Exit 1 if either doesn't match.
```

**2. Forensic analysis gated on actor**

```bash
# Comparing two events from suspect-actor audit pair:
crossengin retention diff-history <id-a> <id-b> \
  --actor-id <suspect-uuid> --kind opt_out_set \
  --format json | jq '.result.fieldDiffs[]'
# Composes with --kind from ADR-0198 — both expectations enforced.
```

**3. CI gate verifying service-account migration**

```bash
# Before and after states of an automated migration must both be from the migration SA:
crossengin retention diff-history <baseline-id> <post-migration-id> \
  --actor-id <migration-sa-uuid> --kind retention_set
# Exits 1 if either event was authored by a different actor (someone overrode the migration).
```

**4. Detect inadvertent cross-actor comparison**

```bash
# Catch operator mistakes correlating events from different operators:
crossengin retention diff-history <event-a> <event-b> --actor-id <expected-actor>
# Forensic discipline — fails loudly if the operator picked the wrong ID for either side.
```

## Drawbacks

1. **Semantic shift from "filter" to "expectation check"** — operators familiar with `--actor-id` as a substrate-side WHERE filter on `retention history` / `retention diff-timeline` may expect filter semantics here. Adapter error message ("expected both events to have actor_id X but A is Y") is explicit. Documented in helpText. Same caveat as ADR-0198 for `--kind`.
2. **No null-actor sentinel for input** — operators wanting "assert both events are system events" can't via `--actor-id`. Operators wrap with jq on JSON output for system-event-only audits. Matches ADR-0186 null-actor stance.
3. **No CLI-side UUID validation** — invalid UUIDs hit PG (where actor_id is typed UUID) with a clearer error than CLI substring matching. Matches ADR-0175/0186/0193 deferred decision.
4. **Single-actor only** — operators wanting "either event must be one of <alice, bob, carol>" run multiple calls. Multi-actor tuple expectation deferred (different shape than multi-actor OR-filter from ADR-0199 since expectation check has different semantic — "all must be one of N" vs "any one of N matches").
5. **No per-event expectation** (e.g., `--actor-id-a alice --actor-id-b bob`) — operators wanting different expectations per side jq-filter JSON. Defer; same as ADR-0198 Q1.
6. **Two new adapter errors with similar shape** — same-tenant + same-table + eventKind mismatch already throw with explicit error; actorId mismatch joins this family. Acceptable structural consistency.

## Alternatives considered

1. **`--actor-id` as a filter limiting which fieldDiffs appear** — doesn't match the per-event semantic of `actor_id` (which is row-level, not field-level). Rejected.
2. **Make `--actor-id` mismatch warn (not throw)** — silent gates lose the safety property. Rejected (matches ADR-0198).
3. **Two flags `--actor-id-a` + `--actor-id-b` for per-side expectations** — overkill for v1; both-same is the common case. Defer.
4. **PG side validation only via WHERE clause** — would silently return zero rows on actor mismatch, indistinguishable from "history IDs don't exist." Adapter-side check throws with clear message naming the offending side. Rejected.
5. **Type adapter input as `string | null` to allow filtering for null** — couples input shape to null-actor filtering use case. Operators wanting null-actor checks wrap with jq. Rejected (matches ADR-0186 single-positive-value pattern).
6. **JSON envelope field named `expectedActorId`** — verbose; `actorId` matches ADR-0193 envelope convention. Adopted.
7. **Render mismatch as fieldDiff rather than throwing** — operators reading "fieldDiffs" wouldn't expect to see actor_id mismatch there; actor_id isn't a "field" in next_state JSONB; throwing is loud and clear. Rejected.
8. **Use `actorId IN (...)` filter semantic when value provided** — would silently return zero rows, indistinguishable from "no events match this ID pair." Expectation-check throw is clearer. Rejected.

## Open questions

1. **Per-side `--actor-id-a` + `--actor-id-b`** for asymmetric expectations ("event A by alice, event B by bob"). Defer.
2. **`--actor-id <a>|<b>|<c>`** multi-value expectation ("both must be one of these N actors"). Defer; different semantic from multi-actor OR-filter on diff-timeline.
3. **`--with-actor-names` on diff-history** — LEFT JOIN meta.users for both events' actors to surface 'Alice Smith (uuid)' in the metadata header. Pairs with ADR-0198 Q5 + ADR-0185 retention history `--with-actor-names`. Defer.
4. **`--actor-name-equals <name>` filter via meta.users lookup** — requires actor → UUID resolution; operators look up UUIDs first. Pairs with ADR-0186 Q3. Defer.
5. **CLI-side UUID validation** matching some future tightening. Defer until measured value (PG enforces and produces clearer error).
6. **`--system-only` flag** for asserting both events are system-authored (actor_id IS NULL on both). Defer; operators jq-filter for now.
