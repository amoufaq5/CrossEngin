# ADR-0196: `crossengin retention history --before-id` reverse cursor pagination (Phase 2 M6.7.zz.tenant.opt-out.history.before-id)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0175 (--after-id forward pagination), ADR-0195 (--after-id on diff-timeline), ADR-0186 (--actor-id filter), ADR-0170 (history audit log) |

## Context

ADR-0175 shipped compound-cursor `--after-id` forward pagination on `retention history` (DESC ordering — walk-backward in time). ADR-0175 Q1 listed `--before-id` reverse pagination as future work, deferred because "single forward direction covers the common case; bidirectional needs operator-driven demand." ADR-0195 just shipped `--after-id` across all three diff-timeline paths, closing the analogous question on that surface.

Operators now hitting genuine bidirectional pagination needs:

1. **Resume from a known event after refresh.** Operator saw event id X mid-session, refreshed the terminal, wants to see events newer than X (catching up to current state without re-scrolling).
2. **Page reversal.** Operator paged forward via `--after-id` to look at older events, then wants to go back to the previous page. `--before-id` is the natural reverse.
3. **Sliding-window audit.** Operator anchors on a specific event id and wants to see both directions (older via --after-id, newer via --before-id).
4. **Stream-tail mode.** Operator polls `crossengin retention history --before-id <latest-known>` periodically to discover new events without re-scanning the whole table.

M6.7.zz.tenant.opt-out.history.before-id closes ADR-0175 Q1 by adding `--before-id <uuid>` reverse pagination to `retention history`.

## Decision

### CLI surface

```
crossengin retention history [--tenant <uuid>] [--table <name>] [--kind <event-kind>]
                             [--actor-id <uuid>] [--since DATE] [--until DATE]
                             [--limit N]
                             [--after-id <uuid>]   # forward (older)
                             [--before-id <uuid>]  # backward (newer)
                             [--with-actor-names]
                             [--format human|json]
```

- `--after-id` and `--before-id` are **mutually exclusive** — both set → exit 2 with clear error message.
- Both compose with every existing filter (`--tenant`, `--table`, `--kind`, `--actor-id`, `--with-actor-names`, `--since`, `--until`, `--limit`).
- JSON envelope gains `beforeId: string | null` + `nextBeforeId: string | null` fields (alongside existing `afterId` + `nextAfterId`).
- Human-format gains a "previous page" hint when `nextBeforeId !== null`.

### Why `>` operator for `--before-id` (vs `<` for `--after-id`)

`retention history` orders DESC `(occurred_at, id)` — latest entries first. The cursor SQL semantics:

| Flag | SQL | Direction | Returns |
|---|---|---|---|
| `--after-id <X>` | `(h.occurred_at, h.id) < (cursor)` | Walk backward (down the DESC list) | Older entries than X |
| `--before-id <X>` | `(h.occurred_at, h.id) > (cursor)` | Walk forward (up the DESC list) | Newer entries than X |

Same compound-cursor shape as ADR-0175 with the inline-subquery `occurred_at` lookup; only the operator flips. ORDER BY remains unchanged — `h.occurred_at DESC, h.id DESC` — operators still see latest entries first in the returned page regardless of which cursor flag they used.

### Composition: both flags allowed in adapter, mutually exclusive at CLI boundary

The adapter accepts both `afterId` and `beforeId` simultaneously — when both are set, the WHERE clause has both bounds and the query returns rows in a window (older than `afterId` AND newer than `beforeId`). This is semantically a "range cursor" and is well-defined.

The CLI rejects both flags at the boundary because in practice operators specifying both at once almost always meant one of them. The substrate-side flexibility is preserved for programmatic consumers calling the adapter directly. Documented as future work — operator-facing "range cursor" flag (e.g., `--range <after-id>..<before-id>`) deferred.

One adapter test verifies the both-cursors-set behavior produces the expected SQL shape (both clauses present, both params threaded) so the substrate flexibility is preserved.

### `nextBeforeId` computation

Computed at the CLI layer immediately after the adapter call:

```ts
const nextBeforeId =
  entries.length === limit ? (entries[0]?.id ?? null) : null;
```

When `entries.length === limit` (page is full), `nextBeforeId` is the FIRST entry's id (which is the newest in DESC order — the boundary for "what's newer than this page"). When `entries.length < limit`, no more newer entries exist — `nextBeforeId` is null.

### Why FIRST entry, not LAST

For forward pagination via `--after-id`, the cursor is the LAST entry (oldest in DESC order, boundary of "what's older than this page"). For backward pagination via `--before-id`, the cursor is the FIRST entry (newest in DESC order, boundary of "what's newer than this page"). The convention: in any DESC-ordered result, the FIRST entry is the boundary for going-newer, the LAST entry is the boundary for going-older.

### Both cursor fields always populated when page is full

Even on a no-cursor (first-page) query that fills its limit, both `nextAfterId` AND `nextBeforeId` are populated. Operators can navigate either direction from any page. The `nextBeforeId` on a first-page query points at the absolute newest entry — calling `--before-id <that>` next time returns an empty page (no entries newer than the newest), which is the correct end-of-pagination signal in the backward direction. Acceptable trade-off matching GitHub REST's Link-header convention.

### Human-format hints

When `nextAfterId !== null`:
```
Page full — next page: crossengin retention history --after-id <id> ...
```

When `nextBeforeId !== null`:
```
Page full — previous page: crossengin retention history --before-id <id> ...
```

Both can appear in the same output when both are populated. Operators see bidirectional pagination cursors clearly labeled.

## Use cases unblocked

**1. Page reversal after walking back too far**

```bash
# Operator paged forward by --after-id, realized they overshot:
crossengin retention history --after-id <id-A>  # gets page of older entries
# Now go back to the previous page:
crossengin retention history --before-id <first-id-from-current-page>
```

**2. Stream-tail mode**

```bash
LATEST=""
while true; do
  RESULT=$(crossengin retention history \
    ${LATEST:+--before-id $LATEST} --limit 100 --format json)
  echo "$RESULT" | jq '.entries[]'
  LATEST=$(echo "$RESULT" | jq -r '.entries[0]?.id // empty')
  [ -z "$LATEST" ] && break
  sleep 30
done
# Polls for new events every 30s, discovers events newer than the last
# seen id without re-scanning the whole audit log.
```

**3. Sliding-window audit anchored on a specific event**

```bash
# Anchor on incident-trigger event id X. Look at events surrounding it:
crossengin retention history --after-id <X> --limit 50    # 50 older
crossengin retention history --before-id <X> --limit 50   # 50 newer
```

**4. Resume from saved cursor in either direction**

```bash
# Resume forward (older entries):
crossengin retention history --after-id <saved-cursor> --since <window-start>
# Resume backward (newer entries):
crossengin retention history --before-id <saved-cursor> --until <window-end>
```

## Drawbacks

1. **Adapter accepts both `afterId` and `beforeId` simultaneously** — substrate-side flexibility for programmatic consumers but CLI rejects both at boundary. Future `--range` flag could expose the range semantic. Documented.
2. **Both `nextAfterId` and `nextBeforeId` populated on every full page** — first-page queries get a `nextBeforeId` that points at the absolute newest entry; `--before-id <that>` returns empty next time. Operators see bidirectional cursors clearly labeled; null-result signals end of pagination correctly.
3. **No `--before-id` on `retention diff-timeline`** — separate milestone (deferred to next session). Symmetry with the diff-timeline cursor work from ADR-0195 would be natural but the same considerations apply.
4. **No CLI-side UUID validation** — matches ADR-0175/0186/0193/0195 deferred decision.
5. **`nextBeforeId` is best-effort** — concurrent inserts may add events between query and follow-up; walked correctly on next backward page via compound cursor.
6. **DESC ordering remains constant regardless of cursor direction** — operators paginating backward via `--before-id` still see latest entries first in each page. Mirrors GitHub REST and most other DESC-ordered paginated APIs.

## Alternatives considered

1. **Flip ORDER BY direction on `--before-id`** — would return entries ASC, confusing operators who expect DESC. Rejected — single consistent ORDER BY across both directions matches convention.
2. **Reject both `--after-id` and `--before-id` at adapter boundary too** — overzealous; substrate-level range-cursor semantics are sound. Rejected.
3. **Single `--cursor <id>` flag with `--direction forward|backward`** — verbose; explicit named flags clearer (matches `--after-id` precedent). Rejected.
4. **`--before-id` cursor field named `prevBeforeId`** in envelope — abbreviates inconsistently with `nextAfterId`. Adopted `nextBeforeId` for consistent "next page in this direction" naming.
5. **Use LAST entry id for `nextBeforeId`** (mirroring `nextAfterId`'s last-entry convention) — would point at the oldest entry in current page, useless for backward pagination. Rejected — FIRST entry is the correct cursor for going-newer in DESC ordering.
6. **Compute `nextBeforeId` only when `beforeId` was explicitly set** (omit on first-page queries) — would require operators to know whether they can go backward without trying first; bidirectional cursors on every full page is friendlier. Rejected.
7. **Reverse-direction reverse-mode** (`--before-id <X>` with ASC ordering returning newest-last) — semantic stretch; everyone expects DESC. Rejected.
8. **Server-side opaque cursor encoding** (base64 `{id, direction}` tuple) — UUID cursor is simple, opaque adds complexity. Defer.

## Open questions

1. **`--before-id` on `retention diff-timeline`** (all three paths). Defer; same shape as the ADR-0195 cursor work + this milestone.
2. **`--range <after-id>..<before-id>`** range-cursor flag at CLI boundary, leveraging the adapter's both-cursors-set support. Defer.
3. **`--before-id` on `retention diff-history`** (cross-event diff) for paginating backward. Defer.
4. **Cross-process cursor stability via point-in-time snapshot** so polling tails don't get affected by concurrent prune mutations. Defer.
5. **`--watch` flag** auto-polling with `--before-id` for stream-tail mode. Operator-policy; defer.
6. **`--include-cursor-row`** for `>=`/`<=` semantic instead of strict `>`/`<`. Defer matches ADR-0195 Q6.
7. **Composite index on `(tenant_id, occurred_at, id)`** for paginated query performance at scale. Defer.
