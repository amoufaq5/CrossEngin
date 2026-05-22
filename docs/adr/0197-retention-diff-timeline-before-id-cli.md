# ADR-0197: `crossengin retention diff-timeline --before-id` reverse cursor pagination across all three diff-timeline paths (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.before-id)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0195 (--after-id on diff-timeline), ADR-0196 (--before-id on retention history), ADR-0175 (--after-id on retention history), ADR-0189 (diff-timeline base) |

## Context

ADR-0195 shipped `--after-id` forward cursor pagination across all three `retention diff-timeline` paths (pair-wise + N-way + cross-table). ADR-0196 just shipped `--before-id` reverse cursor on `retention history`, completing bidirectional pagination on that audit-log surface. ADR-0195 Q1 + ADR-0196 Q1 both listed `--before-id` on diff-timeline as future work.

After ADR-0196, the substrate has bidirectional pagination on retention history but only forward on diff-timeline — asymmetric. Operators now want the same bidirectional ergonomics on the chronological-merge surface.

M6.7.zz.tenant.opt-out.cli.diff-timeline.before-id closes ADR-0195 Q1 + ADR-0196 Q1 by adding `--before-id <uuid>` reverse cursor to all three diff-timeline paths.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--add-tenant <c> ...]
                                   [--actor-id <uuid>] [--kind <event-kind>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>] [--before-id <uuid>]
                                   [--format human|json]

crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table
                                   [--add-table <c> ...]
                                   [--actor-id <uuid>] [--kind <event-kind>]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>] [--before-id <uuid>]
                                   [--format human|json]
```

- `--before-id` added to all three diff-timeline dispatch paths uniformly.
- `--after-id` and `--before-id` are **mutually exclusive** at CLI boundary (both set → exit 2). Matches ADR-0196 pattern.
- All other flags compose without restriction.

### Why `<` operator on diff-timeline `--before-id` (opposite of history's `>`)

The cursor SQL semantic flips based on ORDER BY direction:

| Surface | ORDER BY | `--after-id` operator | `--after-id` returns | `--before-id` operator | `--before-id` returns |
|---|---|---|---|---|---|
| retention history | DESC (latest first) | `<` | Older entries (walk DOWN the list) | `>` | Newer entries (walk UP the list) |
| diff-timeline | ASC (oldest first) | `>` | Newer entries (walk DOWN the list) | `<` | Older entries (walk UP the list) |

In both cases:
- `--after-id` means "give me the page that comes AFTER this cursor in the result ordering"
- `--before-id` means "give me the page that comes BEFORE this cursor in the result ordering"

For DESC: "after" in result-ordering = chronologically-older; "before" = chronologically-newer.
For ASC: "after" in result-ordering = chronologically-newer; "before" = chronologically-older.

The flip is structural — the operator mirrors the ORDER BY direction.

### Adapter changes

All three diff-timeline input types gain optional `beforeId?: string` field:

```ts
export interface DiffHistoryTimelineInput {
  // ...existing fields
  readonly afterId?: string;
  readonly beforeId?: string;  // NEW
}

export interface DiffHistoryTimelineNwayInput {
  // ...existing fields
  readonly afterId?: string;
  readonly beforeId?: string;  // NEW
}

export interface DiffHistoryTimelineCrossTableInput {
  // ...existing fields
  readonly afterId?: string;
  readonly beforeId?: string;  // NEW
}
```

All three adapter methods add identical conditional WHERE clause:

```sql
(h.occurred_at, h.id) < (
  (SELECT occurred_at FROM meta.tenant_retention_opt_out_history WHERE id = $N),
  $N
)
```

Same compound-cursor shape, same `$N` reuse, just flipped operator from ADR-0195's `>`. Positioned in the conditions array right after the `afterId` block.

Adapter accepts both `afterId` and `beforeId` simultaneously (substrate-level range-cursor semantic preserved — same as ADR-0196 on retention history). CLI rejects both. One adapter test verifies range-cursor SQL shape.

### `nextBeforeId` computation

```ts
const nextBeforeId =
  entries.length === limit ? (entries[0]?.id ?? null) : null;
```

When the page is full, the first entry (in ASC order = oldest) is the boundary for going even-older. Operators paginate backward by passing `nextBeforeId` as the next `--before-id`. When `entries.length < limit`, no more older entries → null.

Mirrors ADR-0196's `nextBeforeId = entries[0].id` for retention history. In both surfaces, the FIRST entry in the result is the "going-backward" cursor; the LAST entry is the "going-forward" cursor. The boundaries are at the visual top/bottom of the result page regardless of ORDER BY direction.

### Both cursor fields always populated when page is full

Even on a no-cursor (first-page) query that fills its limit, both `nextAfterId` AND `nextBeforeId` are populated. Operators navigate either direction from any page. The `nextBeforeId` on a first-page query points at the absolute oldest entry in the current page; calling `--before-id <that>` next time returns entries older than that. If no events are older, the result is empty (correct end-of-pagination signal). Acceptable trade-off matching ADR-0196.

### Human-format hints

When `nextAfterId !== null`:
```
Page full — next page: crossengin retention diff-timeline --after-id <id> ...
```

When `nextBeforeId !== null`:
```
Page full — previous page: crossengin retention diff-timeline --before-id <id> ...
```

Both can appear in the same output when both are populated. Same labeling convention as ADR-0196.

## Use cases unblocked

**1. Page reversal on the timeline surface**

```bash
# Operator paged forward via --after-id:
crossengin retention diff-timeline <a> <b> workflow_traces --after-id <id>
# Now go back to the previous page:
crossengin retention diff-timeline <a> <b> workflow_traces --before-id <first-id-from-current-page>
```

**2. Anchor-based bidirectional audit on cohort timeline**

```bash
# Anchor on incident-trigger event id X across 5-tenant cohort:
crossengin retention diff-timeline <a> <b> workflow_traces \
  --add-tenant <c> --add-tenant <d> --add-tenant <e> \
  --after-id <X> --limit 50    # 50 events AFTER X chronologically (newer)
crossengin retention diff-timeline <a> <b> workflow_traces \
  --add-tenant <c> --add-tenant <d> --add-tenant <e> \
  --before-id <X> --limit 50   # 50 events BEFORE X chronologically (older)
```

**3. Cross-table backward audit**

```bash
crossengin retention diff-timeline <tenant> workflow_traces llm_call_traces \
  --cross-table --add-table llm_latency_samples \
  --before-id <recent-cursor>
# Walk backward through the multi-table timeline to find when policies
# were originally established.
```

**4. Resume from saved cursor in either direction**

```bash
# Forward (newer):
crossengin retention diff-timeline <a> <b> workflow_traces \
  --after-id <saved-cursor> --until <window-end>
# Backward (older):
crossengin retention diff-timeline <a> <b> workflow_traces \
  --before-id <saved-cursor> --since <window-start>
```

## Drawbacks

1. **Three adapter methods each gain identical cursor logic for the second time** (after ADR-0195's --after-id) — structural symmetry mirrors the established pattern. Acceptable maintenance cost.
2. **Adapter accepts both `afterId` and `beforeId` simultaneously** but CLI rejects — substrate-level flexibility preserved while CLI surface stays simple. Future `--range` flag could expose the range semantic. Documented.
3. **Both `nextAfterId` and `nextBeforeId` populated on every full page** — matches ADR-0196 convention. First-page nextBeforeId returns empty on follow-up call (correct end-of-pagination signal).
4. **No CLI-side UUID validation** — matches deferred decision across the cursor work.
5. **Cursor operators flipped vs retention history** (`<` here vs `>` on history, and vice versa) — operators reading both surfaces may find the inversion mildly confusing. Mitigated by the labeling: `--after-id` always means "next chronologically-forward page" and `--before-id` always means "previous chronologically-backward page" regardless of underlying SQL operator.

## Alternatives considered

1. **Reverse ORDER BY on `--before-id`** — would return entries DESC (newest first) when paginating backward. Confusing — single consistent ASC ordering matches ADR-0189/0195. Rejected.
2. **Reject both `--after-id` and `--before-id` at adapter boundary** — overzealous; substrate-level range-cursor is sound. Rejected (matches ADR-0196).
3. **Single `--cursor <id>` + `--direction forward|backward`** — verbose; explicit named flags clearer (matches ADR-0196 / 0195 / 0175 precedent). Rejected.
4. **Use LAST entry id for `nextBeforeId`** — would point at the chronologically-newest entry in current page, useless for backward (toward-older) pagination. Rejected — FIRST entry is the correct boundary in ASC ordering.
5. **Compute `nextBeforeId` only when `--before-id` explicitly set** — operators wouldn't see the bidirectional cursors on first-page queries. Rejected — both cursors on every full page matches ADR-0196.
6. **Auto-paginate via streaming generator** — operators want explicit page control. Defer.
7. **`--before-id` cursor field named `prevBeforeId` in envelope** — inconsistent with `nextAfterId`. Adopted `nextBeforeId` matching ADR-0196.
8. **Two separate adapter methods per direction** — three adapter methods × 2 directions = 6; structural explosion. Rejected — single adapter with optional cursor fields per direction is cleaner.

## Open questions

1. **`--range <after-id>..<before-id>` range-cursor flag at CLI boundary** leveraging the adapter's both-cursors-set support. Defer (matches ADR-0196 Q2).
2. **`--before-id` on `retention diff-history`** (cross-event diff) for paginating backward. Defer (matches ADR-0196 Q3).
3. **Cross-process cursor stability via point-in-time snapshot**. Defer.
4. **`--watch` flag** auto-polling with `--after-id` for stream-tail mode on the timeline surface. Defer.
5. **`--include-cursor-row`** for `>=`/`<=` semantic instead of strict `>`/`<`. Defer.
6. **Composite indexes** for paginated query performance at scale. Defer.
7. **Unified pagination flag set across retention history + diff-timeline** so operators don't need to remember which surface uses which operator. Same flag names already unify the surface; the underlying SQL operator difference is an implementation detail. No action needed.
