# ADR-0222: `retention history --kind-not` multi-value substrate-side NOT IN exclusion

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.history.kind-not.multi
- **Closes**: ADR-0206 Q4 (`--kind-not` filter on retention history)
- **Related**: ADR-0183 (`multiFlags` infra), ADR-0206 (retention history
  original surface), ADR-0210 (history `--actor-id` multi-value),
  ADR-0211 (history `--actor-id-not` multi-value), ADR-0214 (diff-history
  `--kind-not` multi-value), ADR-0221 (history `--kind` multi-value just-
  shipped)

## Context

ADR-0206 introduced the global `--kind <event-kind>` substrate-side WHERE
filter on `retention history` with future Q4 deferring the negative
symmetric `--kind-not` exclusion filter. ADR-0221 just widened `--kind` to
multi-value tuple expression on history; this ADR closes Q4 by adding the
**new** multi-value `--kind-not` exclusion field — completing within-surface
symmetry on the kind dimension on retention history.

This milestone differs from prior single→multi widenings — `--kind-not`
doesn't exist on retention history yet, so this is an **ADDITIVE new field**
(multi-value from inception), not a breaking rename. Pattern matches
ADR-0211 (history `--actor-id-not` multi-value from inception when added).

12 consecutive multi-value family milestones (10 breaking renames + 2
ADDITIVE):

- ADR-0199/0200/0207/0210/0211/0214/0217/0218/0219/0220: breaking renames
- ADR-0220 per-side (bulk additive expansion): breaking renames on per-
  side fields, multi-value from inception on new dimensions
- **This ADR (0222): ADDITIVE new field, multi-value from inception**

### Real cohort-negative-exclusion use cases on history surface

1. **Workflow audit excluding maintenance kinds** — list all history events
   EXCLUDING (policy_deleted, retention_set), focusing audit on opt-out
   workflow without maintenance noise.
2. **Anti-deletion forensic** — list events EXCLUDING policy_deleted to
   surface only non-destructive mutations during incident window.
3. **Cohort-aware audit with positive + negative** — assert IN
   (opt_out_set, opt_out_cleared) AND NOT IN (policy_deleted), redundant
   but allows operators to express intent explicitly.
4. **CI gate with kind-list exclusion** — fail build if any history event
   in the last hour matches any of these N excluded kinds.
5. **Compose with --actor-id-not** (already multi from ADR-0211) — "events
   NOT by automation actors AND NOT of maintenance kinds" cohort exclusion.

## Decision

Add NEW `--kind-not <event-kind>` repeatable flag on `retention history`
for multi-value OR-semantic substrate-side NOT IN exclusion filter.
Operator excludes audit log entries with `event_kind IN {N excluded
event_kinds}`.

### ADDITIVE adapter field

`ListOptOutHistoryInput.eventKindsNot?: ReadonlyArray<OptOutHistoryEventKind>`
— new optional field, multi-value from inception. No breaking rename;
existing consumers unaffected.

### Adapter WHERE clause

```ts
if (input.eventKindsNot !== undefined && input.eventKindsNot.length > 0) {
  const kindNotPlaceholders = input.eventKindsNot
    .map((kind) => {
      params.push(kind);
      return `$${params.length}`;
    })
    .join(", ");
  conditions.push(`h.event_kind NOT IN (${kindNotPlaceholders})`);
}
```

Parameterized NOT IN clause with multi-value placeholders. Matches
ADR-0211 history actor-id-not pattern (substituting `event_kind` for
`actor_id`). Empty-array-as-filter-not-set convention preserved.

Note: `event_kind` is NEVER NULL (NOT NULL constraint on
META_TENANT_RETENTION_OPT_OUT_HISTORY); no IS NULL handling needed unlike
ADR-0211 actor-id-not's `IS NULL OR NOT IN (...)` pattern.

### CLI parsing

`runRetentionHistory` reads via `getMultiFlag("kind-not")` + per-occurrence
validation via `isOptOutHistoryEventKind` loop matching ADR-0200/0214/0217/
0220/0221 pattern — exits 2 on FIRST invalid value with that value named.

### JSON envelope shape

New field `eventKindsNot: string[] | null`. Matches established array-or-
null canonical multi-value envelope shape across the family.

### Help text

New flag `--kind-not <event-kind> ...` added to retention history usage
line. Description added: "--kind-not is repeatable and EXCLUDES entries
with any of the listed event_kinds (OR-semantic NOT IN; mirror of --kind)."

### Composition with --kind

`--kind X --kind Y --kind-not Z` produces SQL `h.event_kind IN ($X, $Y) AND
h.event_kind NOT IN ($Z)`. Both clauses fire independently at the PG layer;
operators can express positive cohort + explicit exclusion. Redundant
combinations (`--kind X --kind-not X`) produce empty result — PG handles
naturally; CLI doesn't surface contradiction error (consistent with
ADR-0211 actor-id-not + actor-id behavior).

## Rejected alternatives

1. **Single-value `--kind-not <event-kind>`** — would require breaking
   rename later when extending to multi-value (matches ADR-0211 lesson:
   add multi-value from inception when adding new fields); 12 prior multi-
   value milestones make the pattern routine.
2. **Comma-separated string `--kind-not policy_deleted,retention_set`** —
   breaks shell quoting; inconsistent with multiFlags pattern.
3. **`--exclude-kind` canonical flag name** — inconsistent with established
   `--kind-not` repeatable pattern on diff-history (ADR-0214) and diff-
   timeline (future Q); breaks naming symmetry across surfaces.
4. **`event_kind != ANY($N::text[])`** array-element-of-array PG syntax
   instead of NOT IN clause — equivalent semantically; NOT IN clause is
   more readable in EXPLAIN output and matches ADR-0211 history actor-id-
   not pattern exactly.
5. **AND semantic on multi-value exclusion** — semantically equivalent to
   OR for negative filter ("exclude X AND exclude Y" = "exclude X OR Y");
   OR rendering reads more naturally.
6. **Array literal JSON `--kind-not '["a", "b"]'`** — worse UX than flag
   repetition; requires shell-escape.
7. **`event_kind IS NULL OR NOT IN (...)`** matching ADR-0211 actor-id-not
   pattern — would include system events; event_kind is NOT NULL by
   constraint, so OR clause would never trigger; cleaner to omit.
8. **CLI-side eager error on `--kind X --kind-not X` contradiction** —
   adapter handles naturally (PG returns empty result); operators may
   intentionally include redundant `--kind-not` for self-documentation;
   defer.
9. **`--kind-not @file.txt`** file-source — bounded 4-value enum; defer.
10. **Normalize expression DSL for kind exclusion tuples** — scope creep;
    inconsistent with multiFlags pattern across the family.

## Future questions

1. **`--kind-not` on retention diff-timeline (across 3 dispatch paths)** —
   would pair with ADR-0200 (diff-timeline `--kind` multi) as negative
   symmetric on the diff-timeline surface; ADDITIVE field across all 3
   dispatch paths (pair-wise + N-way + cross-table). Defer — separate
   future Q; natural follow-up for completing the kind dimension symmetry
   across all 3 surfaces.
2. **`--kind-not @file.txt`** — file-source of kind names; defer since 4-
   value enum is bounded.
3. **CLI-side dedup of duplicates** — operator passing `--kind-not X
   --kind-not X` produces `["X", "X"]` → PG NOT IN clause `NOT IN ($1,
   $2)` with X twice. Defer — PG handles duplicates fine.
4. **Semantic-shape exclusion grouping shorthand (e.g.,
   `--exclude-maintenance-kinds` = (policy_deleted, retention_set))** —
   operator-policy concern; defer to tenant config layer.
5. **Cross-flag contradiction detection** — once both --kind and --kind-
   not exist on history, contradictory combinations (`--kind X --kind-
   not X`) could surface CLI-side error; defer — current PG-returns-
   empty behavior is observably correct.
6. **Compose with multi-value --actor-id-not** (already multi from
   ADR-0211) — operator audit query "events NOT by automation actors
   AND NOT of maintenance kinds" — should compose naturally; verify in
   tests but no separate Q needed.

## Consequences

- **12th milestone in multi-value family** — ADDITIVE new field, multi-
  value from inception (not a breaking rename); pattern matches ADR-0211
  precedent.
- **Within-surface kind-dimension symmetry on history restored** —
  positive `--kind` (ADR-0221) + negative `--kind-not` (this ADR) now
  symmetric on retention history. Matches diff-history (ADR-0217 + 0214)
  and diff-timeline positive (ADR-0200, negative still future Q).
- **Test count: 9,113 → 9,123** (+10 net: adapter +4, CLI +6).
- **No JSON envelope or error format changes** — ADDITIVE field doesn't
  break existing envelope shape; new field added; existing fields
  preserved.
- **No SQL plan regression** — NOT IN clause is parameterized and PG plans
  it identically to IN clause (both via hash-join or seq-scan with filter
  depending on cardinality).
- **Per-tenant exclusion forensic now expressible in single command** —
  `--tenant X --kind-not policy_deleted` returns all non-deletion events
  for tenant X without post-query filtering.
- **Natural follow-up — `--kind-not` on retention diff-timeline** pairs
  with ADR-0200 (diff-timeline `--kind` multi) as negative symmetric;
  would complete kind dimension symmetry on the 3rd retention surface.
