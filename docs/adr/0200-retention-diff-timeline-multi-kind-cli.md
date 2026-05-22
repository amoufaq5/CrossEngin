# ADR-0200: `crossengin retention diff-timeline --kind` repeatable for OR-semantic multi-kind filter (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.multi-kind)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0194 (--kind single-value across diff-timeline), ADR-0199 (--actor-id repeatable across diff-timeline), ADR-0183 (multiFlags infrastructure) |

## Context

ADR-0194 shipped `--kind <event-kind>` single-value filter across all three `retention diff-timeline` dispatch paths. ADR-0194 Q1 listed `--kind` repeated multi-flag as future work:

> Q1: `--kind` repeated multi-flag for OR semantics across N kinds. Defer until measured demand.

ADR-0199 just shipped the matching pattern for `--actor-id` (single → repeated via `multiFlags`). This milestone applies the same rename to `--kind` for consistency.

Operators investigating opt-out lifecycle want "every opt_out_set OR opt_out_cleared event across this cohort" in one command instead of running two separate filters + manually merging.

M6.7.zz.tenant.opt-out.cli.diff-timeline.multi-kind closes ADR-0194 Q1.

## Decision

Mirror of ADR-0199 on the `kind` filter dimension:

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--add-tenant <c> ...]
                                   [--actor-id <uuid> ...]
                                   [--kind <event-kind> ...]    # NOW REPEATABLE
                                   [--since DATE] [--until DATE] [--limit N]
                                   [--with-actor-names]
                                   [--after-id <uuid>] [--before-id <uuid>]
                                   [--format human|json]
```

- `--kind` is now read via `getMultiFlag`.
- Each occurrence validated against the 4-value `OPT_OUT_HISTORY_EVENT_KINDS` tuple. Any invalid value → exit 2 with the offending value named.
- Single: `--kind opt_out_set` → SQL `h.event_kind IN ($N)`.
- Multi: `--kind opt_out_set --kind opt_out_cleared` → SQL `h.event_kind IN ($N1, $N2)`.
- Zero: no filter.

### Breaking adapter type rename

All three diff-timeline input types:

```ts
// BEFORE (ADR-0194)
eventKind?: OptOutHistoryEventKind;

// AFTER (this milestone)
eventKinds?: ReadonlyArray<OptOutHistoryEventKind>;
```

Same one-shot rename rationale as ADR-0199:
1. No production consumers (session-recent code).
2. Matches `actorIds`/`tenantIds`/`tableNames` N-way collection naming.
3. TypeScript narrowing stays clean.

`retention history` and `retention diff-history` keep their `eventKind` single-value field intentionally (different semantics: history is list-style with a single-kind filter is common; diff-history is an expectation check that only makes sense per-event-pair).

### Adapter SQL

```ts
if (input.eventKinds !== undefined && input.eventKinds.length > 0) {
  const kindPlaceholders = input.eventKinds
    .map((kind) => {
      params.push(kind);
      return `$${params.length}`;
    })
    .join(", ");
  conditions.push(`h.event_kind IN (${kindPlaceholders})`);
}
```

Same pattern as ADR-0199's actor-ID IN-clause. Empty array → no WHERE clause.

### CLI dispatcher

```ts
const kindFlags = getMultiFlag(command, "kind");
const validatedKinds: OptOutHistoryEventKind[] = [];
for (const kindFlag of kindFlags) {
  if (!isOptOutHistoryEventKind(kindFlag)) {
    printError(ctx.io, `... invalid --kind '${kindFlag}' ...`);
    return 2;
  }
  validatedKinds.push(kindFlag);
}
const eventKinds = validatedKinds.length > 0 ? validatedKinds : undefined;
```

Each value validated individually so operators see the exact offending value in the error.

### JSON envelope rename

`kind: OptOutHistoryEventKind | null` → `kinds: OptOutHistoryEventKind[] | null` across all three diff-timeline envelope shapes (pair-wise, nway:true, crossTable:true). Operators jq-filter via `.kinds | contains(["opt_out_set"])`.

## Use cases unblocked

**1. Opt-out lifecycle audit**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --kind opt_out_set --kind opt_out_cleared \
  --with-actor-names --since 2026-01-01
# Every opt-out-related mutation (set OR cleared) across both tenants
# during the audit window.
```

**2. Per-actor per-kinds forensics**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --actor-id <alice> --actor-id <bob> \
  --kind opt_out_set --kind opt_out_cleared \
  --with-actor-names
# (Alice OR Bob) × (opt_out_set OR opt_out_cleared) = every opt-out lifecycle
# mutation by either operator across both tenants.
```

**3. Exclude noise-kinds via positive-only filter**

```bash
# Show everything except retention_set (which fires on every tier migration):
crossengin retention diff-timeline <a> <b> workflow_traces \
  --kind opt_out_set --kind opt_out_cleared --kind policy_deleted
# Captures the 3 non-noise kinds in one filter.
```

**4. Compliance attestation across cohort × kinds**

```bash
crossengin retention diff-timeline <reg-a> <reg-b> workflow_traces \
  --add-tenant <reg-c> --add-tenant <reg-d> \
  --kind opt_out_set --kind policy_deleted \
  --since 2026-Q1 --with-actor-names --format json
# Quarterly attestation: all legal-hold mutations + all policy deletions
# across the regulated cohort.
```

## Drawbacks

1. **Breaking adapter type rename + JSON envelope rename** — contained scope, session-recent code, no external consumers. Same one-shot break as ADR-0199.
2. **Retention history's `eventKind` stays single** — divergence with diff-timeline's `eventKinds`. Same documented divergence as ADR-0199 for actorId. Future Q if demand emerges.
3. **Retention diff-history's `eventKind` stays single** — different semantic (expectation check, not filter). Multi-kind expectation would mean "both events must be one of these" — defer; ADR-0198 Q2 already lists this.
4. **OR-semantic only** — operators wanting "neither opt_out_set NOR opt_out_cleared" need a NOT filter. Defer.
5. **No duplicate dedup** — `--kind opt_out_set --kind opt_out_set` builds `IN ($N1, $N2)` with duplicate values; PG handles fine. Not worth substrate dedup.

## Alternatives considered

1. **Keep `eventKind` + add `eventKinds` alongside** — two-field surface. Rejected (matches ADR-0199 decision).
2. **`--kind a|b|c` pipe-separated syntax** — operators with shell pipes could trip. Rejected.
3. **`--kinds <a>,<b>` plural alias** — adds CLI surface. Rejected.
4. **Validate batch (all values at once)** — current per-value validation gives crisper error. Adopted current.
5. **Reject duplicates at CLI** — PG handles duplicate IN values fine. Rejected.
6. **Use enum-array PG SQL `= ANY($N::text[])`** — inconsistent with substrate's positional-placeholder pattern. Rejected.

## Open questions

1. **Widen retention history's `eventKind` to `eventKinds`** for consistency. Defer until measured demand.
2. **`--kind-not <event-kind>`** for exclusion semantic (e.g., "all events except retention_set"). Defer.
3. **Multi-kind expectation on retention diff-history** — "both events must be one of these kinds." Pairs with ADR-0198 Q2. Defer.
4. **Composite index on `(event_kind, occurred_at)`** for high-cardinality multi-kind queries. Defer until measured.
5. **`--kind @file.txt`** reading event kinds from a file. Defer; only 4 valid values so file-based input is overkill.
