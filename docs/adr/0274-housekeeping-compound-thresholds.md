# ADR-0274: Housekeeping `--threshold-alert` compound AND/OR expressions

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0266 Q1 (closes), ADR-0263 / 0264 (host housekeeping dashboards), ADR-0181 (exit-3 convention), ADR-0269/0270/0271 (composes with --tenant + --all-tenants), ADR-0272 (composes with shutdown bridge) |

## Context

ADR-0266 (M4.14.t) shipped `--threshold-alert
<field>:<op><value>` as a repeatable flag with
implicit OR semantic: any single alert tripping
causes exit 3. ADR-0266 Q1 explicitly carved out the
inverse — AND composition — as future work:

> "Extend `--threshold-alert` grammar to allow
> boolean composition — e.g., 'wouldPruneCount:>1M
> AND lastPrunedAt:>24h'. Today operators run
> multiple `--threshold-alert` flags with implicit
> OR semantic via any-trip-trips logic; AND is the
> gap."

Real CI gate use cases that need AND:

- **"Alert when there's drift AND the pruner is
  stuck"** — `wouldPruneCount:>1000000 AND
  lastPrunedAt:>24h` only trips when there's a real
  pruning backlog (lots of rows would be deleted +
  the pruner hasn't run recently). Without AND
  operators get false positives from "lots of
  rows would be deleted" alone (could be a new
  tenant with high natural volume on fresh
  policies).
- **"Alert when retention is configured loosely AND
  the table is large"** — `retentionDays:>365 AND
  totalRowCount:>10000000` finds tables that combine
  long retention with high volume (compliance
  capacity-planning use case).
- **"Alert when staleness AND volume are both
  excessive"** — paired conditions that operators
  intuitively want as AND.

The implicit-OR-across-multiple-flags semantic
preserves backward compat; the gap is intra-flag AND.

## Decision

Extend `--threshold-alert` to accept compound
expressions of the form `<clause>[ AND <clause>...]`
or `<clause>[ OR <clause>...]` within a single flag.
Grammar rules:

- **Single-clause** (existing): `wouldPruneCount:>1000`
  parses as a SINGLE alert (combinator = `"SINGLE"`,
  `clauses.length === 1`).
- **AND-combinator**: `A AND B AND C` (case-sensitive
  uppercase keyword with surrounding spaces). Trips
  when EVERY clause matches.
- **OR-combinator**: `A OR B OR C`. Trips when ANY
  clause matches. Semantically equivalent to running
  each clause as a separate `--threshold-alert` flag;
  OR within a flag is a syntactic convenience.
- **Cross-flag**: still implicit OR (an alert tripping
  in flag N causes exit 3 regardless of other flags).

The case-sensitive uppercase keyword + required
surrounding spaces avoids collisions with values that
might contain "and"/"or" substrings. ISO 8601
timestamps with embedded `T` separators don't trigger
compound parsing (no space-AND-space).

**Mixed AND + OR within a single flag is rejected.**
Operators wanting mixed semantics use multiple flags
(cross-flag OR + within-flag AND). Example:

```
--threshold-alert "A:>1 AND B:>2" --threshold-alert "C:>3"
```

evaluates as `(A AND B) OR C`. Mixing within one flag
introduces precedence ambiguity that's not worth the
parser complexity for marginal expressiveness gain.

Result types extended:

```ts
export interface ThresholdAlertClause {
  readonly raw: string;
  readonly field: string;
  readonly op: ThresholdOp;
  readonly value: ThresholdValue;
}

export type ThresholdCombinator = "SINGLE" | "AND" | "OR";

export interface ThresholdAlertSpec {
  readonly raw: string;
  readonly combinator: ThresholdCombinator;
  readonly clauses: ReadonlyArray<ThresholdAlertClause>;
  // Backward-compat convenience accessors (mirror clauses[0]).
  readonly field: string;
  readonly op: ThresholdOp;
  readonly value: ThresholdValue;
}

export interface TrippedClause { ... }

export interface TrippedAlert {
  readonly spec: string;
  readonly tableName: string;
  readonly combinator: ThresholdCombinator;
  readonly trippedClauses: ReadonlyArray<TrippedClause>;
  // Backward-compat convenience (mirror first tripped clause).
  readonly fieldName: string;
  readonly op: ThresholdOp;
  readonly thresholdRaw: string;
  readonly actual: number | string | null;
  readonly ageMs?: number;
}
```

The backward-compat convenience accessors (`field`,
`op`, `value` on spec; `fieldName`, `op`,
`thresholdRaw`, `actual`, `ageMs` on tripped) mirror
the FIRST clause/tripped-clause. Existing consumers
that don't know about compound expressions see no
shape change.

New evaluator entry point:

```ts
export function evaluateAlertCompound(
  alert: ThresholdAlertSpec,
  tableName: string,
  readField: (field: string) => number | string | null,
  fieldTypeOf: (field: string) => AlertableFieldType | undefined,
  asOfMs: number,
): TrippedAlert | null;
```

The dispatcher calls this once per (table, alert)
pair; the evaluator owns the per-clause iteration +
combinator logic. The pre-M4.14.n `evaluateAlertOnRow`
is preserved (treats spec as a single clause via the
convenience accessors) for backward compat with
existing unit tests + external callers.

Human renderer differentiates compound output:

```
! workflow_traces trips compound threshold "wouldPruneCount:>1000 AND lastPrunedAt:>24h"
      - wouldPruneCount=5,000 [wouldPruneCount:>1000]
      - lastPrunedAt=2026-05-27T12:00:00.000Z (age 48.0h) [lastPrunedAt:>24h]
```

Single-clause + single-tripped-clause render is
backward-compat verbatim (`! <table> <field>=<actual>
trips threshold "<spec>"`).

JSON envelope per-tripped-alert includes
`combinator` + `trippedClauses` array (consumers
parsing JSON learn the compound shape). Backward-
compat fields remain on the top-level for consumers
reading single-clause shapes.

## Rejected alternatives

1. **Allow mixed AND + OR within one flag with
   precedence rules** — implies a small expression
   grammar (parentheses or operator-precedence
   ordering). Operators wanting mixed semantics
   compose via multiple flags (cross-flag OR + intra-
   flag AND). The simple two-shape grammar covers
   95%+ of operator use cases.

2. **Lowercase `and` / `or` keywords** — would
   collide with values that contain those substrings
   (e.g., a hypothetical `lastPrunedAt:>orphan` or
   slug `andover`). Uppercase + space-required is
   unambiguous.

3. **Use `&&` / `||` operators borrowed from C-style
   syntax** — operators reading the help text would
   wonder about shell escaping. `AND` / `OR` reads
   like English in help text.

4. **Require parentheses around clauses** — verbose
   for the 99% case (single clause); the space-
   surrounded keyword IS the unambiguous separator.

5. **Per-clause `--threshold-alert-and`/`--threshold-
   alert-or` flag variants** — operators would have
   to remember which flag combines how. Single flag
   with grammar-driven combinator is cleaner.

6. **Implicit AND when same field appears in
   multiple clauses across flags** — magic; breaks
   the existing cross-flag-OR semantic operators
   already learned.

7. **Compound tripped alerts emit one entry per
   tripped clause** (vs one per compound alert
   regardless of clause count) — operators reading
   the THRESHOLD ALERTS section would lose the
   "this compound rule tripped" framing. One entry
   per compound alert with `trippedClauses` array
   keeps the rule-grouped view.

8. **Drop the backward-compat convenience accessors
   from TrippedAlert** — would force every existing
   consumer (renderer, JSON serializer, downstream
   tests) to access `trippedClauses[0]` instead of
   `fieldName`. Backward-compat is preserved
   verbatim by mirroring the first clause's data on
   the top level.

9. **Validate compound expressions at parse time
   only (skip per-clause field-existence check)** —
   would surface "unknown field" only at evaluation
   time. Per-clause validation at parse time gives
   operators the typo error before any dashboard
   runs.

10. **Treat `SINGLE` as a separate type alias `=
    ThresholdAlertClause`** vs ThresholdAlertSpec
    with one-element clauses array — would force the
    dispatcher to discriminate on type instead of
    iterating clauses uniformly. Uniform shape
    (always clauses[]) is cleaner.

## Implementation notes

The parser detects `" AND "` and `" OR "` substrings
in the raw input. If both are present → exit 2
("mixed AND/OR"). If one is present → split on it,
parse each clause via the extracted `parseSingleClause`
helper, set combinator accordingly. If neither →
single-clause path (legacy behavior preserved
verbatim).

`parseSingleClause` was extracted from the pre-M4.14.n
`parseThresholdAlert` body — the same value-kind
detection (number → duration → ISO timestamp) runs on
each clause. Returns `ParseClauseResult` with `clause`
instead of `alert` (the compound caller wraps clauses
into the alert envelope).

The dispatcher refactor was minimal — both
housekeeping `evaluateAlertsForReport` helpers swapped
the per-clause `evaluateAlertOnRow` for the per-alert
`evaluateAlertCompound`, plus added a `fieldTypeOf`
closure that the evaluator uses internally to look up
each clause's field type.

The renderer's compound branch fires only when
`combinator !== "SINGLE" && trippedClauses.length > 1`
— a SINGLE alert (or an OR alert where only one
clause tripped) renders in the single-clause
backward-compat shape.

## Tests

20 new tests:

- 8 unit tests in `parseThresholdAlert compound
  expressions (M4.14.n)`:
  - single-clause has SINGLE combinator + clauses
    array
  - AND parses every clause + first-clause convenience
  - OR parses every clause + first-clause convenience
  - 3-clause AND chain
  - mixed AND+OR rejected with explanatory error
  - empty clause around keyword rejected
  - bad clause in compound fails the whole parse
  - substring 'AND' inside value doesn't trigger
    compound parsing (requires spaces)
- 5 unit tests in `evaluateAlertCompound (M4.14.n)`:
  - AND trips only when EVERY clause trips (both
    trip / only first / only second)
  - OR trips when ANY clause trips (only first /
    both / neither); trippedClauses contains only
    tripping ones
  - AND with mixed numeric + timestamp clauses
    (wouldPruneCount + lastPrunedAt staleness)
  - SINGLE combinator with single-clause compound
  - renderTrippedAlert emits per-clause detail for
    compound AND tripping
- 3 unit tests in `parseThresholdAlertFlags compound
  validation (M4.14.n)`:
  - validates every clause's field + first failure
    exits 2 with clause-specific error
  - validates every clause's value-kind against its
    field type
  - accepts valid compound AND expression with mixed
    types
- 4 gateway CLI integration tests:
  - compound AND trips when BOTH clauses match
  - compound AND does NOT trip when only one matches
  - compound OR within a single flag works
  - mixed AND + OR in one flag exits 2

Workspace test count goes 9,648 → 9,668.

## Consequences

- Operators expressing "alert when X AND Y are both
  bad" get a single-flag, single-message CI gate.
- The implicit-OR-across-flags semantic preserved
  verbatim — existing operators see no change.
- Compound rule tripping renders as one entry
  (rule-grouped) with per-clause detail, matching
  operator mental model.
- ThresholdAlertSpec + TrippedAlert shapes
  backward-compat via convenience accessors —
  existing consumers (renderer, JSON serializer)
  see no breakage.
- The shared evaluator entry point
  (`evaluateAlertCompound`) is reusable for any
  future threshold-alert surface (e.g., if other
  CLI actions adopt the same flag).
- Pure additive grammar extension; pre-M4.14.n
  invocations parse identically.

## Future Qs

1. **Parenthesized expressions** to allow mixed
   AND/OR with explicit precedence — `(A AND B) OR
   (C AND D)`. Operators wanting this can compose
   via multiple flags today; defer until measured
   needed.
2. **NOT operator** for negation — `NOT
   wouldPruneCount:>1000` (no rows would be pruned).
   Different semantic from inverting the op (>= ↔ <)
   when null fields involved. Defer.
3. **Cross-table AND** — operators wanting "alert
   when table A's count > X AND table B's count > Y"
   need a different mechanism (cross-table compound
   isn't expressible in the current per-table
   evaluation model). Future Q if measured needed.
4. **Compound expressions with timestamp arithmetic**
   — `lastPrunedAt > oldestAt + 7d` (relative
   between two timestamps). Significant grammar
   complexity. Defer.
5. **JSON envelope `trippedClauses` schema
   documentation** in operator guides — operators
   writing jq filters on compound alerts need the
   field reference. Pairs with future operator-guide
   work.
6. **Compound expressions in `retention summary
   --where` if that surface ever adopts thresholds**
   — same grammar would map naturally. Defer until
   that surface lands.
7. **Configurable separator** (e.g., environment
   variable `CROSSENGIN_THRESHOLD_AND=`&&`) — adds
   operator-policy complexity for a marginal use
   case. Defer.
8. **Allow lower-case `and`/`or` with explicit
   escape syntax** for ambiguous-value edge cases —
   no operator pain reports yet; defer until needed.
