# ADR-0198: `crossengin retention diff-history --kind` event-kind expectation check (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.kind-filter)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0173 (diff-history base), ADR-0194 (--kind on diff-timeline), ADR-0170 (history audit log + event_kind tuple) |

## Context

ADR-0173 shipped `retention diff-history <id-a> <id-b>` for cross-event policy state comparison. Input is two history IDs; output is the next_state diff between them. Same-(tenant, table) constraint validated at adapter — events on different tenants or tables throw with explicit error.

ADR-0194 shipped `--kind` filter on the broader `retention diff-timeline` family (list-style query). ADR-0194 Q6 listed `--kind` on `retention diff-history` as future work for "symmetric filtering across the retention diff family."

`diff-history` is structurally different from `diff-timeline` — it takes exactly two IDs, not a list query — so "filter" semantics don't translate directly. The meaningful interpretation: `--kind` becomes an **expectation check**. Operator declares "I expect both these events to have event_kind X" and the adapter throws when reality differs. Useful for:

1. **Compliance scripts** asserting "diff these two policy_deleted events" without accidentally comparing across kinds.
2. **Forensic analysis** where mixing kinds (e.g., a `retention_set` and a `policy_deleted`) would produce a confusing diff and the operator wants the comparison gated.
3. **CI gates** verifying that two events from automated migration scripts are both the expected kind.

M6.7.zz.tenant.opt-out.cli.diff-history.kind-filter closes ADR-0194 Q6 by threading `--kind` through `retention diff-history` as an expectation check.

## Decision

### CLI surface

```
crossengin retention diff-history <history-id-a> <history-id-b> [--kind <event-kind>]
                                  [--format human|json]
```

- `--kind <event-kind>` added as a single optional flag.
- Validated at CLI boundary against the 4-value `OPT_OUT_HISTORY_EVENT_KINDS` tuple from ADR-0170: `opt_out_set | opt_out_cleared | retention_set | policy_deleted`. Invalid values → exit 2 with explicit valid-values list (matches ADR-0194 pattern on diff-timeline).

### Adapter changes

`DiffHistoryEntriesInput` gains optional `eventKind?: OptOutHistoryEventKind` field. The adapter loads both events as before, then after the existing same-tenant + same-table + valid-event_kind checks adds a mismatch validation:

```ts
if (input.eventKind !== undefined) {
  const mismatches: string[] = [];
  if (entryA.event_kind !== input.eventKind) {
    mismatches.push(`A is '${entryA.event_kind}'`);
  }
  if (entryB.event_kind !== input.eventKind) {
    mismatches.push(`B is '${entryB.event_kind}'`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `diffHistoryEntries: expected both events to have event_kind '${input.eventKind}' but ${mismatches.join(" and ")}`,
    );
  }
}
```

Error message names whichever sides don't match. If both A and B are wrong, the message names both — operator sees the full picture in one shot.

### Why "expectation check" not "filter"

`retention diff-history`'s input is exactly two IDs — there's nothing to "filter." The flag's semantic shifts from filter to expectation check. Two events fetched; if either doesn't match the expected kind, the query is invalid from the operator's perspective.

This matches the pattern of substrate validation throwing on cross-tenant or cross-table inputs — operator's expectation didn't match data, surface the mismatch loudly.

### Error path: exit 1 (runtime) not exit 2 (misuse)

When the adapter throws due to event_kind mismatch, the CLI catches and returns exit 1 (runtime error path). This matches how other adapter errors propagate (cross-tenant + cross-table mismatch errors also exit 1). Exit 2 is reserved for CLI-side input validation (invalid --kind value before any PG query).

This means: `--kind not_a_kind` → exit 2 (CLI misuse, no PG call). `--kind opt_out_set` but events are different kinds → exit 1 (runtime; events queried; mismatch surfaced).

### JSON envelope

Gains `kind: OptOutHistoryEventKind | null` field echoing the operator's expectation (or null when not set). Matches the ADR-0194 envelope convention on diff-timeline.

```json
{
  "action": "diff-history",
  "kind": "opt_out_set",
  "result": { ... }
}
```

### No additional human-format change

The existing `formatHistoryDiff` already renders both events' `eventKindA` and `eventKindB` in the metadata header. When `--kind` is set and both match, the diff renders normally — operators visually verify the expectation was met. When kinds mismatch, the adapter throws before reaching the formatter.

## Use cases unblocked

**1. Compliance script asserting kind match**

```bash
# Assert both events are opt_out_set before producing the diff:
crossengin retention diff-history <id-a> <id-b> --kind opt_out_set
# Exit 0 if both match + diff rendered. Exit 1 if either doesn't match.
```

**2. Forensic analysis gated on kind**

```bash
# Comparing two policy_deleted events as part of incident investigation:
crossengin retention diff-history <id-a> <id-b> --kind policy_deleted \
  --format json | jq '.result.fieldDiffs[]'
```

**3. CI gate verifying migration script behavior**

```bash
# Before and after states of a migration retention_set:
crossengin retention diff-history <baseline-id> <post-migration-id> \
  --kind retention_set
# Exits 1 if the migration accidentally fired a different mutation kind.
```

## Drawbacks

1. **Semantic shift from "filter" to "expectation check"** — operators familiar with `--kind` as a filter on `retention history` / `retention diff-timeline` may expect filter semantics here. Adapter error message ("expected both events to have event_kind X but A is Y") is explicit about the expectation-check semantic. Documented in helpText.
2. **No "filter the field diffs" semantic** — `--kind` doesn't filter which fields appear in the diff; it filters which events are allowed to be diffed at all. Operators wanting per-field control jq-filter the JSON.
3. **Two adapter errors with similar shape** — same-tenant mismatch and same-table mismatch throw with explicit error; --kind mismatch joins this family. Acceptable structural consistency.
4. **Single-kind only** — operators wanting "either event must be one of <a, b, c>" run multiple calls. Defer multi-kind tuple expectation.
5. **No per-event expectation** (e.g., `--kind-a opt_out_set --kind-b retention_set`) — operators wanting different expectations per side jq-filter JSON. Defer.

## Alternatives considered

1. **`--kind` as a filter limiting which fieldDiffs appear** — doesn't match the per-event semantic of `event_kind` (which is row-level, not field-level). Rejected.
2. **Make `--kind` mismatch warn (not throw)** — silent gates lose the safety property. Rejected.
3. **Two flags `--kind-a` + `--kind-b` for per-side expectations** — overkill for v1; both-same is the common case. Defer.
4. **Validate event_kind matches **the** same value but operator doesn't specify which** — operator may want "either both opt_out_set or both retention_set" — substrate doesn't know which. Operator picks via `--kind <X>`. Rejected the auto-pick.
5. **PG side validation only** — PG can't know operator's expectation. Adapter-side check is the right boundary.
6. **Type adapter input as `string` not `OptOutHistoryEventKind`** — loses TypeScript narrowing. Rejected (matches ADR-0194).
7. **JSON envelope field named `expectedKind`** — verbose; `kind` matches ADR-0194 convention. Adopted.
8. **Render mismatch as fieldDiff rather than throwing** — operators reading "fieldDiffs" wouldn't expect to see event_kind mismatch there; throwing is loud and clear. Rejected.

## Open questions

1. **Per-side `--kind-a` + `--kind-b`** for asymmetric expectations. Defer.
2. **`--kind <a>|<b>|<c>`** multi-value expectation ("both must be one of these"). Defer.
3. **`--actor-id` expectation check** on diff-history (e.g., "assert both events were authored by Alice"). Same shape; defer.
4. **`--actor-id` + `--kind` composition** for fine-grained expectation checks. Defer.
5. **`--with-actor-names`** on diff-history (LEFT JOIN meta.users for the two events' actors). Defer.
6. **Inline diff annotation** showing when events are different kinds (without throwing) for operators who want diff anyway. Defer; opt-in via separate flag if needed.
