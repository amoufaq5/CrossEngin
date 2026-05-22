# ADR-0202: `crossengin retention diff-timeline --range <after-id>..<before-id>` window-cursor flag across all three diff-timeline paths (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.range)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0201 (--range on retention history), ADR-0195 (--after-id on diff-timeline), ADR-0197 (--before-id on diff-timeline) |

## Context

ADR-0201 shipped `--range <after-id>..<before-id>` window-cursor flag on `retention history` leveraging the adapter's both-cursors-set support that ADR-0196 documented. ADR-0197 (which shipped `--before-id` across all three diff-timeline paths) listed Q1:

> Q1: `--range <after-id>..<before-id>` range-cursor flag at CLI boundary leveraging the adapter's both-cursors-set support. Defer.

ADR-0201 Q1 explicitly listed `--range` on diff-timeline as future work.

Operators paginating diff-timeline windows want the same single-flag ergonomics they just got on retention history — anchor on an event, look at the 50 events surrounding it bounded by a known cursor.

M6.7.zz.tenant.opt-out.cli.diff-timeline.range closes ADR-0197 Q1 + ADR-0201 Q1 by adding `--range` uniformly across all three diff-timeline paths.

## Decision

Mirror of ADR-0201 on all three diff-timeline dispatch paths (pair-wise + N-way + cross-table).

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--add-tenant <c> ...]
                                   [--actor-id <uuid> ...]
                                   [--kind <event-kind> ...]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>]
                                   [--before-id <uuid>]
                                   [--range <after-id>..<before-id>]   # NEW
                                   [--format human|json]

crossengin retention diff-timeline <tenant> <table-a> <table-b> --cross-table
                                   [--add-table <c> ...]
                                   [--actor-id <uuid> ...]
                                   [--kind <event-kind> ...]
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>]
                                   [--before-id <uuid>]
                                   [--range <after-id>..<before-id>]   # NEW
                                   [--format human|json]
```

(Both surface lines on the dispatcher; `--range` works uniformly across pair-wise, N-way via `--add-tenant`, and cross-table via `--cross-table`.)

### Adapter changes

**None.** All three diff-timeline adapter inputs already accept both `afterId` and `beforeId` simultaneously (substrate-level range-cursor preserved across ADR-0195 + ADR-0197). The CLI was rejecting both at boundary as operator confusion. `--range` is the explicit operator gesture to opt into the range semantic.

### CLI dispatcher

Same parse + validation pattern as ADR-0201:

```ts
const rangeFlag = getStringFlag(command, "range");
let afterId = afterIdFlag !== null ? afterIdFlag : undefined;
let beforeId = beforeIdFlag !== null ? beforeIdFlag : undefined;

if (rangeFlag !== null) {
  if (afterIdFlag !== null || beforeIdFlag !== null) {
    return exit-2("--range cannot be combined with --after-id or --before-id");
  }
  const parts = rangeFlag.split("..");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return exit-2(`invalid --range '${rangeFlag}' (expected <after-id>..<before-id>)`);
  }
  afterId = parts[0];
  beforeId = parts[1];
} else if (afterIdFlag !== null && beforeIdFlag !== null) {
  return exit-2("--after-id and --before-id are mutually exclusive (use --range ... for window cursor)");
}
```

Threaded uniformly to whichever of the three adapter methods gets dispatched. Same `..` separator, same mutual-exclusivity rules, same error messages adapted for the diff-timeline surface.

### JSON envelope

All three envelope shapes (pair-wise, nway:true, crossTable:true) gain a `range: string | null` field echoing operator input. `afterId` + `beforeId` fields also populate when `--range` is set so jq scripts reading either path get correct values. `range: null` when `--range` not set.

```json
{
  "action": "diff-timeline",
  "afterId": "uuid-after",
  "beforeId": "uuid-before",
  "range": "uuid-after..uuid-before",
  "nextAfterId": null,
  "nextBeforeId": null,
  // ...
}
```

### Why parallel implementation across all three paths

The three paths (pair-wise / N-way / cross-table) already use shared cursor + JSON envelope code. Adding `range` to each is mechanical and structurally identical — same `rangeFlag` variable threaded through each branch's `if (command.format === "json")` block + each `if (crossTable) { ... }` / `if (hasAddTenant) { ... }` / fallthrough branch. One milestone covers all three because the lift is identical and the operator-facing surface stays consistent.

## Use cases unblocked

**1. Anchor-based bidirectional cohort audit**

```bash
# Anchor on incident-trigger event id X across 5-tenant cohort:
crossengin retention diff-timeline <a> <b> workflow_traces \
  --add-tenant <c> --add-tenant <d> --add-tenant <e> \
  --range <pre-incident-cursor>..<post-incident-cursor> \
  --with-actor-names --format json
```

**2. Cross-table window scoped to migration period**

```bash
crossengin retention diff-timeline <tenant> workflow_traces llm_call_traces \
  --cross-table --add-table llm_latency_samples \
  --range <migration-start-cursor>..<migration-end-cursor>
```

**3. Per-actor per-window forensic narrowing**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --actor-id <alice> --actor-id <bob> \
  --kind opt_out_set --kind opt_out_cleared \
  --range <window-start>..<window-end>
# Multi-actor × multi-kind × window cursor in one command.
```

**4. CI gate: "no mutations in protected window"**

```bash
if [ "$(crossengin retention diff-timeline <a> <b> workflow_traces \
    --range <a>..<b> --format json | jq '.result.entries | length')" -gt 0 ]; then
  echo "Mutations detected in protected window" >&2
  exit 1
fi
```

## Drawbacks

1. **Parallel implementation across three paths** — same code structure copied into pair-wise/N-way/cross-table dispatch branches. Acceptable structural symmetry; mirrors how every other diff-timeline filter (--actor-id, --kind, --after-id, --before-id, etc.) already exists three times.
2. **No adapter changes** — substrate side already supports the range semantic from ADR-0195/0197. Pure CLI ergonomics improvement.
3. **`..` separator strictly enforced as 2 dots** — same as ADR-0201; 3-dot `...` git syntax errors out with clear message.
4. **No CLI-side UUID validation** — matches deferred decision across cursor work.
5. **`range` JSON envelope field echoes raw operator input** — same convention as ADR-0201. Parsed object form deferred.
6. **Window semantics depend on ASC ordering** — diff-timeline orders ASC (chronological), so `--range <a>..<b>` returns entries where `(occurred_at, id) > <a>` AND `(occurred_at, id) < <b>` — events newer than `a` AND older than `b`. Operators reversing the cursor order get empty results (correctly). This is the inverse direction from retention history's DESC range semantic; documented in helpText.

## Alternatives considered

1. **Single-path delivery (just pair-wise)** — would force operators using N-way or cross-table to use bare flags only. Rejected; symmetric coverage matches the established pattern.
2. **Different separator on diff-timeline** vs retention history — confuses operators learning both surfaces. Same `..` separator is consistent.
3. **Reverse range semantic on diff-timeline** (treat first half as upper bound to match DESC mental model) — would diverge from ADR-0201's convention where first half is always the `--after-id` cursor. Rejected; one consistent meaning across surfaces.
4. **Two flags `--from <a> --to <b>`** — verbose; loses single-flag ergonomic. Rejected (matches ADR-0201).
5. **Adapter-side accept `range` parameter directly** — would push parsing into substrate where it doesn't belong. Rejected; CLI-side parsing is the right boundary.
6. **No mutual-exclusivity check** (silently override bare flags with --range values) — could mask operator confusion. Rejected; explicit error helps.

## Open questions

1. **`--range` on `retention diff-history`** — diff-history takes two history IDs as positional args already, so a range cursor doesn't really fit the cross-event diff semantic. Defer; likely not needed.
2. **Strict-inclusive `>=`/`<=` cursor semantic** for `--range` — operators wanting cursor-row included. Defer (same as ADR-0195 Q6, ADR-0201 Q2).
3. **Visualization of range bounds in human output** — currently the page-full hints render bidirectional cursor IDs; could enhance to show the range. Defer.
4. **`--range @file.txt`** for batch range processing. Defer.
5. **`range` envelope field as parsed object** `{after, before}` instead of raw `<a>..<b>` string. Defer.
6. **Composite index on `(tenant_id, table_name, occurred_at, id)`** for high-cardinality range queries at scale. Defer until measured.
