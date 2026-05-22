# ADR-0201: `crossengin retention history --range <after-id>..<before-id>` window-cursor flag (Phase 2 M6.7.zz.tenant.opt-out.cli.history.range)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0175 (--after-id), ADR-0196 (--before-id + range-cursor adapter), ADR-0197 (--before-id on diff-timeline) |

## Context

ADR-0196 documented that `ListOptOutHistoryInput` accepts BOTH `afterId` AND `beforeId` simultaneously at the adapter layer — the substrate-level range-cursor semantic is preserved for programmatic consumers — while the CLI rejects both flags at the boundary because operators specifying both at once "almost always meant one of them."

ADR-0196 Q2 listed the operator-facing `--range` flag as future work, leveraging the adapter's existing both-cursors support to provide one-flag window-cursor pagination at the CLI surface.

ADR-0197 Q1 listed the same flag for diff-timeline.

Operators investigating audit windows ("show me the 50 events between these two cursor IDs") currently can't ask substrate-side; they paginate forward via `--after-id` and check each result manually, or write Node scripts calling the adapter directly. M6.7.zz.tenant.opt-out.cli.history.range exposes the range-cursor capability at the CLI for `retention history`.

## Decision

### CLI surface

```
crossengin retention history [--tenant <uuid>] [--table <name>] [--kind <event-kind>]
                             [--actor-id <uuid>] [--since DATE] [--until DATE]
                             [--limit N]
                             [--after-id <uuid>]
                             [--before-id <uuid>]
                             [--range <after-id>..<before-id>]   # NEW
                             [--with-actor-names]
                             [--format human|json]
```

- `--range` accepts a single string with two UUIDs separated by `..` (git-like commit-range syntax).
- Parsed at CLI boundary into `afterId` + `beforeId` and threaded to the adapter (which already supports both-cursors-set per ADR-0196).
- **Mutually exclusive with bare `--after-id` and `--before-id`** — `--range` IS already setting both, so combining with the bare flags is operator confusion → exit 2 with clear error.

### Why `..` separator

Git uses `git log <commit-a>..<commit-b>` for commit-range queries. Operators familiar with git recognize the pattern; UUIDs in canonical form don't contain dots so there's no ambiguity. Single-flag value is shell-quote-friendly.

Rejected alternatives:
- `:` separator (`<a>:<b>`) — git also uses `:` but for namespace separation; less mnemonic for range.
- `,` separator — UUIDs don't contain commas but operators with shell variables containing them could trip.
- `--from <a> --to <b>` two flags — explicit but verbose; the whole point of this flag is one-flag ergonomics.

### Why no adapter changes

ADR-0196 already shipped the adapter's both-cursors-set support. The CLI was rejecting it for "operators almost always meant one of them." `--range` is the explicit operator-side gesture saying "I'm deliberately setting both." Adapter call unchanged: `afterId: <parsed-a>, beforeId: <parsed-b>`. Pure CLI ergonomics improvement.

### Existing mutual-exclusivity rules preserved

Before `--range`:
- `--after-id <a>` alone: walk-forward (older entries) ✓
- `--before-id <b>` alone: walk-backward (newer entries) ✓
- `--after-id <a> --before-id <b>` (bare flags both set): rejected with "mutually exclusive" error

After `--range`:
- All above behaviors unchanged
- `--range <a>..<b>` alone: window cursor ✓
- `--range <a>..<b> --after-id <c>`: rejected ("`--range cannot be combined with --after-id or --before-id`")
- `--range <a>..<b> --before-id <c>`: rejected (same)
- Bare `--after-id <a> --before-id <b>` (without `--range`): still rejected, but error message now points operators at `--range` for window-cursor needs

### Parse validation

The `..` split must produce exactly 2 non-empty halves:
- `--range abc` → no `..` → exit 2
- `--range ..xyz` → empty first half → exit 2
- `--range abc..` → empty second half → exit 2
- `--range abc..xyz..def` → 3 parts → exit 2

No CLI-side UUID validation matching ADR-0175/0186/0193 deferred decision — invalid UUIDs hit PG error at adapter layer.

### JSON envelope

Gains a single new `range: string | null` field echoing the operator's input. When `--range` is set, both `afterId` + `beforeId` ALSO populate (so jq scripts reading either path get correct values):

```json
{
  "tenantFilter": null,
  "eventKind": null,
  "since": null,
  "until": null,
  "afterId": "uuid-after",
  "beforeId": "uuid-before",
  "range": "uuid-after..uuid-before",
  "limit": 100,
  ...
}
```

When `--range` is not set, `range: null` and `afterId`/`beforeId` reflect the bare-flag values (or null if neither set).

## Use cases unblocked

**1. Investigation window between two known events**

```bash
crossengin retention history --range <incident-trigger-id>..<resolution-id> \
  --with-actor-names
# Show all history events that occurred between the incident trigger and
# its resolution, scoped to the audit window between those two cursors.
```

**2. Tier-migration audit window**

```bash
crossengin retention history --range <pre-migration-cursor>..<post-migration-cursor> \
  --kind retention_set --format json | jq '.entries | length'
# Count of retention_set events that occurred during the migration window.
```

**3. Two-pass forensic narrowing**

```bash
# Pass 1: paginate forward, find suspect window:
crossengin retention history --after-id <starting-point> --limit 1000 --format json
# Identify cursor IDs at start + end of suspect window.

# Pass 2: zoom in on just that window:
crossengin retention history --range <suspect-start>..<suspect-end> --with-actor-names
```

**4. CI gate for audit-log emptiness in a window**

```bash
if [ "$(crossengin retention history --range <a>..<b> --format json | jq '.entries | length')" -gt 0 ]; then
  echo "Mutations detected in protected window" >&2
  exit 1
fi
```

## Drawbacks

1. **Single-surface delivery** — only `retention history` ships `--range` this milestone; `retention diff-timeline` (which has the same underlying adapter range-cursor support) still uses bare flags. ADR-0197 Q1 documents this; separate milestone if/when operator demand emerges for the timeline surface.
2. **`..` separator not strictly enforced as 2 dots** — operators typing `--range a...b` (3 dots, git's other syntax) get exit 2 with the "expected `<after-id>..<before-id>`" error. Clear feedback; no special-case handling.
3. **No CLI-side UUID validation** per part — matches ADR-0175/0186/0193 deferred decision.
4. **`range` JSON envelope field echoes the raw operator input** — operators using `--after-id` + `--before-id` (somehow allowed in a future change) would not get `range` populated. Currently impossible (mutually exclusive); documented if future changes allow.
5. **No `--range` that supports just one half** — operators wanting "after X, indefinitely forward" use `--after-id <X>`; "before Y, indefinitely backward" use `--before-id <Y>`. `--range` requires both halves; partial range is each bare flag's job. Documented.
6. **Window semantics depend on DESC ordering** — `--range <a>..<b>` returns entries where `(occurred_at, id) < <a>` AND `(occurred_at, id) > <b>` — i.e., events older than `a` AND newer than `b`. Operators need to understand DESC ordering to pick the right cursor order; reversing produces empty results (correctly).

## Alternatives considered

1. **Two flags `--from <a> --to <b>`** — explicit but verbose; loses single-flag ergonomic value. Rejected.
2. **`--range <after-id> <before-id>` (positional pair)** — unusual flag syntax for two values; `..` separator is more idiomatic. Rejected.
3. **`:` separator** — git uses it for namespace; less mnemonic. Rejected.
4. **Auto-relax bare `--after-id` + `--before-id` mutual exclusivity** (treat both-set as range automatically) — would silently change ADR-0196 behavior. Rejected; explicit `--range` is the gesture.
5. **Add to retention diff-timeline in same milestone** — scope creep; deferred matches ADR-0197 Q1 documentation.
6. **Validate parts as UUIDs at CLI** — matches deferred-validation decision across cursor work. Rejected.
7. **`--range` partial form** (e.g., `<a>..` for forward-from-a) — partial range is already what bare `--after-id` / `--before-id` do; redundant surface. Rejected.

## Open questions

1. **`--range` on `retention diff-timeline`** (all three paths) — same shape, adapter already supports. Defer (matches ADR-0197 Q1).
2. **`--range` with strict-inclusive semantic** (`>=` / `<=` instead of `>` / `<`) — operators wanting cursor-row included. Defer (same as ADR-0195 Q6).
3. **Visualization of range bounds in human output** — currently the page-full hints render bidirectional cursor IDs; could enhance to show the range. Defer.
4. **`--range @file.txt`** for batch range processing. Defer.
5. **`range` envelope field as parsed object** `{after: <a>, before: <b>}` instead of raw `<a>..<b>` string. Defer; raw string preserves operator's literal input.
6. **`--range <a>..` and `--range ..<b>` partial-range support** — collapse semantic with bare `--after-id` and `--before-id`. Defer (each bare flag is already the partial-range form).
