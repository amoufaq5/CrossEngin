# ADR-0221: `retention history --kind` multi-value substrate-side IN filter

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.history.kind.multi
- **Closes**: ADR-0206 Q1 (multi-value `--kind` on retention history)
- **Related**: ADR-0183 (`multiFlags` infra), ADR-0199/0200/0207/0210/0211/
  0214/0217/0218/0219/0220 (10 prior single→multi widenings), ADR-0206
  (retention history `--kind` original single-value), ADR-0210 (history
  `--actor-id` multi-value), ADR-0211 (history `--actor-id-not` multi-value)

## Context

ADR-0206 introduced the global `--kind <event-kind>` substrate-side WHERE
filter on `retention history` as a single-value flag: operator filters the
audit log to entries with `event_kind = $N`. The future-Qs section listed
multi-value tuple filter — `--kind` repeatable for "any of these N
event_kinds" — as Q1.

This ADR closes that Q1, extending the multi-value family to the third
retention surface (retention history substrate-side filter). 11 consecutive
single→multi widenings via one-shot breaking rename:

- ADR-0199: diff-timeline `--actor-id` → multi
- ADR-0200: diff-timeline `--kind` → multi
- ADR-0207: diff-timeline `--actor-id-not` → multi
- ADR-0210: history `--actor-id` → multi
- ADR-0211: history `--actor-id-not` → multi
- ADR-0214: diff-history `--kind-not` → multi
- ADR-0217: diff-history `--kind` → multi
- ADR-0218: diff-history `--actor-id` → multi
- ADR-0219: diff-history `--actor-id-not` → multi
- ADR-0220: diff-history per-side multi (bulk)
- **This ADR (0221): retention history `--kind` → multi**

This milestone differs from ADR-0217 (diff-history `--kind`) in semantic:
diff-history is per-event-pair **expectation check** (assert BOTH events
match tuple); retention history is list-style **substrate-side WHERE filter**
(return events with event_kind IN tuple). The implementation pattern is
mechanical — same one-shot break, same array-based field, same parameterized
IN clause matching ADR-0210/0211 history actor multi-value precedent.

### Real cohort-positive-filter use cases on history surface

1. **Workflow audit query** — list all events with event_kind IN
   (opt_out_set, opt_out_cleared) across a tenant — focus the audit on
   opt-out workflow without retention/policy noise.
2. **Mutation cohort report** — list all events with event_kind IN
   (opt_out_set, retention_set) — focus on policy mutations excluding
   deletions and clearings.
3. **CI gate aggregation** — count events by kind tuple over a window
   (e.g., did we have any opt_out_cleared OR policy_deleted events in the
   last hour).
4. **Forensic timeline filter** — compose with `--actor-id` (already multi
   from ADR-0210) for "events by Alice OR Bob with kind opt_out_set OR
   policy_deleted" cohort analysis.
5. **Operator dashboard backing query** — UI lists "deletion-class events"
   = (policy_deleted, retention_set); UI lists "workflow events" =
   (opt_out_set, opt_out_cleared).

## Decision

Widen `--kind <event-kind>` on `retention history` from single-value to
**repeated flag** for multi-value OR-semantic substrate-side WHERE filter.
Operator filters audit log to entries with `event_kind IN {set of N
event_kinds}`.

### Breaking adapter rename

`ListOptOutHistoryInput.eventKind?: OptOutHistoryEventKind` →
`ListOptOutHistoryInput.eventKinds?: ReadonlyArray<OptOutHistoryEventKind>`.

Session-recent code from ADR-0206 with no external consumers contained scope —
matches ADR-0199/0207/0210/0211/0214/0217/0218/0219/0220 one-shot break
precedent. 10 prior precedents make the pattern mechanical.

### Adapter WHERE clause rewrite

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

Parameterized IN clause with multi-value placeholders. Matches ADR-0210/0211
history actor multi-value pattern exactly — same `param.push` loop, same
`IN (...)` clause shape, same empty-array-as-filter-not-set convention.

### CLI parsing

`runRetentionHistory` reads via `getMultiFlag("kind")` instead of
`getStringFlag`. Per-occurrence validation via `isOptOutHistoryEventKind`
loop matching ADR-0200/0214/0217/0220 pattern — exits 2 on FIRST invalid
value with that value named.

### JSON envelope shape

Field renamed `eventKind: string | null` → `eventKinds: string[] | null`.
Matches ADR-0207/0210/0211/0214/0217/0218/0219/0220 array-or-null canonical
multi-value envelope shape across the family.

### Help text

`--kind <event-kind>` → `--kind <event-kind> ...` indicating repeatable.
Global flag description note added: "Repeatable for multi-value OR-semantic
IN filter."

### Semantic distinction from diff-history

- **diff-history `--kind`** (ADR-0217): per-event-pair expectation check —
  throws if EITHER event's event_kind is not in the tuple.
- **history `--kind`** (this ADR): list-style WHERE filter — returns ONLY
  events whose event_kind is in the tuple.
- **diff-timeline `--kind`** (ADR-0200): list-style WHERE filter (across 3
  dispatch paths) — same semantic as history but on diff-timeline surface.

All three surfaces now have multi-value `--kind` with their respective
surface-appropriate semantics.

## Rejected alternatives

1. **Keep single-value `eventKind` + add `eventKinds` field (additive)** —
   defeats simplicity; inconsistent with established one-shot break
   precedent across 10 prior single→multi renames.
2. **Comma-separated string `--kind opt_out_set,opt_out_cleared`** — breaks
   shell quoting; inconsistent with multiFlags pattern.
3. **`--kind-list` canonical flag name** — inconsistent with established
   `--kind` repeatable pattern on diff-timeline (ADR-0200) and diff-history
   (ADR-0217); breaks naming symmetry across surfaces.
4. **`event_kind = ANY($N::text[])`** array-element-of-array PG syntax
   instead of IN clause — equivalent semantically; IN clause is more
   readable in EXPLAIN output and matches ADR-0210/0211 history actor
   pattern exactly.
5. **Repeated flag with implicit AND semantic** — semantically equivalent
   to "always false" for N > 1 (event has exactly one kind); AND on multi-
   value substrate filter would degenerate.
6. **Array literal JSON `--kind '["a", "b"]'`** — worse UX than flag
   repetition; requires shell-escape; doesn't compose with tab-completion.
7. **Retain single-value `event_kind = $N` SQL for backward-compat EXPLAIN
   parsing** — EXPLAIN output was never API-grade contract; `IN ($N)` for
   single + `IN ($N, $M)` for multi reads consistently.
8. **Defer to retention history `--kind-not` first** — `--kind-not` on
   history doesn't exist yet (would require new ADR); deferring this Q would
   miss the natural one-shot break opportunity while session-recent code
   is contained.
9. **Add jq-style post-query filter** — wrong layer; substrate-side filter
   is canonical for performance + LIMIT correctness + cursor pagination
   correctness (matches ADR-0193/0194/0207 reasoning).
10. **Normalize expression DSL for kind tuples** — scope creep;
    inconsistent with multiFlags pattern across the family.

## Future questions

1. **`--kind-not` filter on retention history** — would close ADR-0206 Q4;
   pairs with this ADR as the negative symmetric on history surface; same
   one-shot break pattern but on a NEW field (additive not rename). Defer —
   separate future Q; natural follow-up.
2. **`--kind @file.txt`** — file-source of kind names; defer since 4-value
   enum is bounded; operators can write all 4 in shell easily.
3. **CLI-side dedup of duplicates** — operator passing `--kind X --kind X`
   produces `["X", "X"]` → PG IN clause `IN ($1, $2)` with X twice. Defer —
   PG handles duplicates fine; CLI-side dedup would hide operator intent
   in JSON envelope echo.
4. **Semantic-shape grouping shorthand (e.g., `--kind=opt-out-workflow`
   mapping to (opt_out_set, opt_out_cleared))** — operator-policy concern;
   defer to tenant config layer.
5. **Compose with multi-value `--kind-not` on history** — once `--kind-not`
   on history exists (future Q 1 above), contradictory combinations like
   `--kind X --kind-not X` would surface; document then.
6. **Per-tenant `--kind` filter (when no `--tenant` set)** — current `--kind`
   filters across ALL tenants when `--tenant` not set; per-tenant
   aggregation could be useful for multi-tenant cohort reports. Defer —
   operator-policy concern; can be expressed via repeated --tenant
   flag combined with --kind.

## Consequences

- **11th milestone in actor + kind multi-value family** — extends multi-
  value to retention history surface; with this milestone the global `--kind`
  filter is multi-value on all 3 retention surfaces (history, diff-timeline,
  diff-history).
- **Test count: 9,106 → 9,113** (+7 net: adapter +3, CLI +4).
- **JSON envelope shape change** — `eventKind: string | null` →
  `eventKinds: string[] | null`; consumers of the JSON envelope on
  retention history must update field path.
- **SQL clause shift** — `h.event_kind = $N` → `h.event_kind IN ($N)`;
  consumers parsing EXPLAIN output or logs must update; PG plan is
  equivalent (single-value IN clause flattens to = at planner level).
- **All 3 retention surfaces have multi-value `--kind`** — history (this
  ADR, list-style filter), diff-timeline (ADR-0200, list-style filter
  across 3 dispatch paths), diff-history (ADR-0217, per-event-pair
  expectation check). Surface-appropriate semantics preserved.
- **`--kind-not` on retention history** is the natural follow-up Q to
  complete within-surface symmetry on the kind dimension; ADR-0206 Q4
  remains open.
