# ADR-0266: Housekeeping `--threshold-alert` CI-gate flag

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0263 Q4 (closes), ADR-0264 Q4 (closes), ADR-0265 Q6 (closes — watch+threshold integration), ADR-0181 (exit code conventions: 0/1/2/3) |

## Context

After ADR-0263 / ADR-0264 / ADR-0265 shipped the gateway and
retention housekeeping dashboards with read + watch modes,
both dashboards still required custom jq + bash plumbing to
wire into CI gates:

```bash
COUNT=$(crossengin retention housekeeping --format json | \
  jq '.tables[] | select(.tableName == "llm_call_traces") | .wouldPruneCount')
if [ "$COUNT" -gt 1000000 ]; then
  echo "WARN: llm_call_traces has $COUNT rows pending prune"
  exit 1
fi
```

Three problems with this pattern:

1. **Boilerplate per CI script.** Every gate re-implements the
   jq filter + threshold check + exit-code routing. Operators
   end up with 5-10 lines of bash per check.

2. **Exit code collision.** `exit 1` from the shell script
   collides with the housekeeping action's exit 1 (runtime
   I/O failure). CI logs can't tell "threshold tripped" from
   "PG went away."

3. **No composition with --watch.** Operators wanting "fail
   the build when any tick during a 5-minute run trips the
   threshold" had no way to express this — `watch` ran
   indefinitely with no exit signal.

ADR-0263 Q4 + ADR-0264 Q4 both deferred this:

> "`--threshold-alert` CI gate flag — operators want
> dashboards wired into deploy gates that fail when tables
> grow too big or aren't pruned recently."

ADR-0265 Q6 noted the watch composition concern:

> "Watch mode integration with `--threshold-alert`. When the
> threshold-alert Q lands, `--watch` could exit non-zero on
> first threshold violation (CI-gate loop)."

This ADR closes all three.

## Decision

Add `--threshold-alert <field>:<op><value>` (repeatable) to
both `crossengin gateway housekeeping` and `crossengin
retention housekeeping`. Exit code 3 when any alert trips on
any table (matches ADR-0181's exit-3 convention for
"completed successfully but a configurable gate failed").

### Surface

```
$ crossengin gateway housekeeping \
    --threshold-alert wouldPruneCount:>1000000 \
    --threshold-alert lastPrunedAt:>24h

$ crossengin retention housekeeping \
    --threshold-alert oldestAt:>365d \
    --threshold-alert perTenantPolicyCount:>=10
```

### Spec grammar

```
<spec>  ::= <field> ':' <op> <value>
<field> ::= identifier (must be in the surface's field registry)
<op>    ::= '>' | '>=' | '<' | '<=' | '='
<value> ::= <number> | <duration> | <iso-8601>
<number>   ::= digits ('.' digits)?
<duration> ::= digits ('s' | 'm' | 'h' | 'd' | 'w' | 'y')
<iso-8601> ::= anything Date.parse accepts
```

Duration units:
- `s` = seconds
- `m` = minutes (NOT months — operators use `30d` for months)
- `h` = hours
- `d` = days
- `w` = weeks
- `y` = years (365 days; leap-year precision deferred)

The parser tries number → duration → ISO timestamp in order.
Any unparseable value exits 2 with a clear error.

### Field registries

**Retention housekeeping** (6 alertable fields):

| Field | Type | Notes |
|---|---|---|
| `totalRowCount` | number | Direct from `SELECT COUNT(*)`. |
| `oldestAt` | timestamp_nullable | `MIN(time_col)` — null when table is empty. |
| `wouldPruneCount` | number | Platform-level preview total. |
| `retentionDays` | number_nullable | Null when no platform policy. |
| `lastPrunedAt` | timestamp_nullable | Null when never pruned. |
| `perTenantPolicyCount` | number | Per-table count of tenant overrides. |

**Gateway housekeeping** (5 alertable fields — same as retention
minus `perTenantPolicyCount`):

| Field | Type | Notes |
|---|---|---|
| `totalRowCount` | number | Direct from `SELECT COUNT(*)`. |
| `oldestAt` | timestamp_nullable | Null when empty. |
| `wouldPruneCount` | number | For idempotency: `previewDeleteExpired` result. |
| `retentionDays` | number_nullable | Null for `expires_at` semantic. |
| `lastPrunedAt` | timestamp_nullable | Null for `expires_at` semantic. |

Non-alertable fields: `tableName` (static identifier, not a
gate signal), `pruneSemantic` (string, not numeric), `enabled`
(boolean doesn't compose with `>`/`<` semantics).

### Type matching

- Numeric fields require numeric values (e.g.,
  `wouldPruneCount:>1000`). Passing a duration like
  `wouldPruneCount:>24h` exits 2 with "must be a number".
- Timestamp fields require either a duration value (relative
  to the report's `asOf`) OR an ISO 8601 timestamp. Passing
  a bare number like `lastPrunedAt:>500` exits 2 with "must
  be a duration or ISO 8601 timestamp".

### Duration semantic for timestamps

For `lastPrunedAt:>24h`, the check is:

```
(asOf - lastPrunedAt) > 24h
```

Equivalently: "lastPrunedAt is older than 24h ago."

Operators read it as "alert when this hasn't been pruned in
the last 24 hours."

### Null handling

- **Numeric nullable fields** (`retentionDays`): null skips
  evaluation. No alert triggers on a null numeric field.
  Operators wanting "alert if no policy" use other mechanisms
  (e.g., `retention list-policies` output check).

- **Timestamp nullable fields** (`lastPrunedAt`, `oldestAt`):
  null is treated as **infinitely old** for `>` and `>=`
  duration checks. So `lastPrunedAt:>24h` trips on a null
  lastPrunedAt (matches operator intent — "never pruned" is
  worse than "not pruned in 24 hours").
  For `<`, `<=`, `=`, `EQ` with duration, null does NOT match.

### Exit codes

| Condition | Exit |
|---|---|
| Run succeeded, no alert tripped | 0 |
| PG / adapter I/O failure | 1 |
| Invalid `--threshold-alert` syntax / unknown field / type mismatch | 2 |
| Run succeeded, at least one alert tripped | **3** (this milestone) |

Exit 3 reuses ADR-0181's "completed successfully but a
configurable gate failed" convention (same as
`retention diff --exit-on-divergence` exit 3 + `workflow
validate` exit 3 on validation errors). CI scripts route by
status code:

```bash
case $? in
  0) echo "ok" ;;
  1) on_call_alert "PG / adapter error" ;;
  2) echo "BUG: CI script passed invalid threshold alert" ;;
  3) deploy_pipeline_alert "housekeeping threshold tripped" ;;
esac
```

### Composition with --watch

Under `--watch`, the loop evaluates alerts every tick. The
**first tick that trips any alert** exits the loop with exit
code 3. Operators wanting "fail the build when monitoring
for 5 minutes" run:

```bash
timeout 300 crossengin retention housekeeping --watch \
  --threshold-alert wouldPruneCount:>1000000
```

The watch loop's existing `WatchLoopInput.render` callback
was extended to return `"halt" | void`. When a render returns
`"halt"`, the loop exits cleanly returning `{ halted: true }`.
The caller maps `halted=true` to exit 3.

### Output

**Human format** (after the table report):

```
retention housekeeping (as of 2026-05-29T12:00:00.000Z):

  workflow_traces
    total rows:      1,234,567
    ...

THRESHOLD ALERTS (3 tripped):
  ! workflow_traces wouldPruneCount=1,500,000 trips threshold "wouldPruneCount:>1000000"
  ! llm_call_traces lastPrunedAt=2026-04-01T00:00:00.000Z trips threshold "lastPrunedAt:>24h" (age 58.5d)
  ! rate_limit_decisions lastPrunedAt=null (never set) trips threshold "lastPrunedAt:>24h"
```

**JSON envelope** (alerts always emitted, empty when none
tripped):

```json
{
  "action": "retention.housekeeping",
  "asOf": "...",
  "tables": [...],
  "alerts": [
    {
      "spec": "wouldPruneCount:>1000000",
      "tableName": "workflow_traces",
      "fieldName": "wouldPruneCount",
      "op": "GT",
      "thresholdRaw": "1000000",
      "actual": 1500000
    },
    {
      "spec": "lastPrunedAt:>24h",
      "tableName": "llm_call_traces",
      "fieldName": "lastPrunedAt",
      "op": "GT",
      "thresholdRaw": "24h",
      "actual": "2026-04-01T00:00:00.000Z",
      "ageMs": 5054400000
    }
  ]
}
```

`alerts: []` is always present (stable consumer parsing,
operators don't need to defensively check for the key).

### Implementation

New module `apps/architect-cli/src/threshold-alert.ts`:

- `parseThresholdAlert(raw)` — pure parser returning
  `{ok, alert?, error?}`.
- `validateAlertAgainstField(alert, field)` — type-checks the
  alert's value kind against the field's type.
- `evaluateAlertOnRow(alert, tableName, fieldValue, fieldType,
  asOfMs)` — per-row evaluator returning a `TrippedAlert` or
  null.
- `parseThresholdAlertFlags(raws, fields, io, label)` — CLI-
  side flag-array parser that prints errors and returns exit
  code 2 on validation failure, or the parsed alerts array.
- `renderTrippedAlert(alert)` — human-readable line with
  locale-formatted numbers and auto-unit duration suffixes
  (h/d/m as appropriate for the actual age).
- `opSymbol(op)` — operator-name → display-symbol mapping.

Both housekeeping action files (`retention-housekeeping.ts`
and `gateway-housekeeping.ts`) now:

1. Parse `--threshold-alert` via `getMultiFlag` + the shared
   `parseThresholdAlertFlags` against a per-surface field
   registry.
2. Build a `renderTick(report)` closure that renders the
   report normally, then evaluates alerts against the report
   rows. If any tripped, render the THRESHOLD ALERTS section
   and return `"halt"`.
3. Single-shot path: render once, evaluate alerts, return 3
   if tripped or 0 if not.
4. Watch path: pass `renderTick` as the loop's render
   callback. The loop exits with `halted:true` on first
   tripped tick; the caller returns exit 3.

`runHousekeepingWatchLoop` signature now returns
`WatchLoopResult { halted: boolean }`, and `render` callback
now returns `"halt" | void`. Pre-M4.14.t callers (none —
this milestone is the only consumer) continue to work because
the void return type is a subtype of `"halt" | void`.

## Rejected alternatives

1. **Use `--exit-on-divergence` style flag instead of
   `--threshold-alert`.** ADR-0181's `--exit-on-divergence`
   is a single boolean toggle; it doesn't take values. Adding
   per-field per-op per-value semantics would overload it.
   `--threshold-alert` is the right new flag — explicit values
   + composable + repeatable.

2. **Custom DSL like `--alert "wouldPruneCount > 1000000"`.**
   Bash-quoting nightmare (operators escape `<` `>` for shell).
   The `:`-separated compact form sidesteps shell entirely.

3. **`--alert` short flag without "threshold" prefix.**
   Considered. "alert" alone is too generic — could mean
   alert notification, alert delivery. `threshold-alert`
   names the specific gate semantic.

4. **Exit code 1 on tripped (matches diff(1) convention).**
   Collides with the existing exit 1 = "PG / adapter error".
   Exit 3 keeps signal distinct (per ADR-0181).

5. **Exit code 4 to introduce a new "alert" tier.** Not
   needed — ADR-0181's exit 3 already covers "completed
   successfully but a gate failed." Reusing it keeps the
   exit-code vocabulary tight.

6. **Alert spec syntax `--threshold-alert wouldPruneCount=
   gt:1000000` (URL-encoded style).** Verbose; `:>` is
   shorter and reads naturally.

7. **`--threshold-alert <field>=<value>` for equality, with
   separate flags for range checks.** Combinatorial blowup
   — operators would need `--threshold-min`, `--threshold-
   max`, `--threshold-equal`. Single flag with embedded
   operator is concise.

8. **Watch mode keep-going on alert trip (just log them).**
   Operators using `--threshold-alert` in CI want fail-fast
   semantics. Resilient mode is a separate concern (ADR-0265
   Q2 `--watch-keep-going`).

9. **JSON envelope omits `alerts` key when no alerts
   configured.** Defensive operators have to check for the
   key's presence. Always-emit (`[]` when empty) is simpler.

10. **Render the THRESHOLD ALERTS section BEFORE the main
    table report (header position).** Considered for visual
    prominence, but operators reading top-to-bottom expect
    the data first, then the verdict.

11. **Support negation operators (`!=`).** Defer — operators
    can express via `:=` checks for specific values + jq for
    complex predicates. Real-world CI gates use ordered
    comparisons, not equality-not.

12. **Support compound expressions like `wouldPruneCount:
    >1000 AND oldestAt:>30d`.** Defer — operators wanting
    boolean composition can do `--threshold-alert A
    --threshold-alert B` (OR semantics across alerts, as
    we have today). For AND, they wrap with shell `set -e`.

## Drawbacks

1. **OR semantics across alerts (any tripped trips the gate).**
   Operators wanting AND ("alert only if BOTH conditions met")
   can't express this directly. They split into separate
   pipeline stages or use jq on the JSON envelope. Future Q
   for compound expressions.

2. **No `seconds-since-epoch` value type.** Operators using
   external monitoring systems that pass thresholds as Unix
   timestamps have to convert to ISO 8601 first. Acceptable
   for v1.

3. **Year duration is approximate (365 days, not 365.25).**
   Operators caring about leap-year precision use days
   directly. The 0.25-day error is irrelevant at CI-gate
   thresholds.

4. **First-tick exit under --watch may miss alerts that come
   and go.** If a table has 999K rows on tick 1 (alert
   doesn't trip) and 1.5M rows on tick 2 (alert trips), the
   watch exits at tick 2. That's correct behavior — but
   operators wanting "alert if ANY tick during the watch
   tripped" already get that because trip = exit. The
   inverse case ("alert if ALL ticks trip") isn't expressible
   under current semantics. Future Q.

5. **No threshold on aggregated values.** Operators wanting
   "alert if ANY table has > 1M rows" express it the same
   way as "alert if a specific table has > 1M rows" — the
   alert fires on the first matching row. But "alert if SUM
   of all wouldPruneCount > 10M" isn't expressible. Use jq
   on JSON envelope for aggregations.

6. **Per-table evaluation = one tripped alert per (table,
   alert) pair.** If a single alert trips on 3 tables, the
   THRESHOLD ALERTS section shows 3 lines. Operators wanting
   a single roll-up line per alert can use jq grouping on
   JSON output. Current shape matches operator intent of
   "show me each table that's failing."

## Future Qs

1. **Compound expressions (AND / OR / NOT).** Allow
   `--threshold-alert "(wouldPruneCount:>1000 AND
   lastPrunedAt:>24h) OR oldestAt:>365d"`. Significant scope
   — needs a tiny expression parser. Defer until measured
   demand.

2. **Negation operator (`!=`).** Allow
   `--threshold-alert enabled:!=true` for booleans.
   Currently booleans aren't in the registry. Pairs with
   boolean field support.

3. **Aggregated thresholds across tables.** Allow
   `--threshold-alert SUM(wouldPruneCount):>10000000` or
   `--threshold-alert MAX(oldestAt):>30d`. Requires an
   aggregation pre-pass before alert evaluation.

4. **Per-table targeted alerts.** Allow
   `--threshold-alert workflow_traces.wouldPruneCount:
   >1000` to scope to one table. Useful when operators have
   different SLAs per table. Current model evaluates per
   alert × per table (every alert checks every table).

5. **Threshold-alert spec from a file.**
   `--threshold-alert-file alerts.txt` reading specs from
   a newline-delimited file. Operators with many alerts hit
   shell-argument-length limits. Defer.

6. **Boolean fields (`enabled`) with `=true` / `=false`
   support.** Currently `enabled` is excluded from the
   registry because numeric ops don't apply. Adding `=`
   support for booleans would let operators check "alert if
   any platform policy is disabled."

7. **Composable with `--watch-keep-going` (ADR-0265 Q2).**
   When the keep-going flag lands, threshold-alert semantics
   change: render alerts each tick but only exit at watch
   loop end (or never if true infinite). Operator-policy
   decision; defer.

8. **Threshold-alert summary aggregation in JSON envelope.**
   Add a `summary: { trippedCount, byField: {...},
   byTable: {...} }` field for at-a-glance dashboards.

## Operator workflow examples

### Daily CI gate on retention drift

```bash
crossengin retention housekeeping \
  --threshold-alert wouldPruneCount:>1000000 \
  --threshold-alert lastPrunedAt:>24h
```

Exits 3 if any of the 6 tables either has more than 1M rows
pending prune OR hasn't been pruned in the last 24h. Pipeline
reads exit code and routes.

### Time-bounded watch loop with alert gate

```bash
timeout 600 crossengin gateway housekeeping --watch \
  --watch-interval 30 \
  --threshold-alert oldestAt:>30d
```

Watches for 10 minutes; exits 3 on the first tick that finds
any gateway table with an oldest row older than 30 days.
Otherwise exits 124 (timeout's exit code) for "10-minute
window passed without tripping."

### Migration safety check

```bash
# Before kicking off a tier migration:
crossengin retention housekeeping \
  --threshold-alert perTenantPolicyCount:>=50
# Exit 3 → migration cohort is too dense; pause.
# Exit 0 → safe to proceed.
```

### Multi-pipeline severity tiers

```bash
# Tier 1: critical (fail deploy)
crossengin gateway housekeeping \
  --threshold-alert wouldPruneCount:>10000000 \
  || deploy_block

# Tier 2: warn (slack notify)
crossengin gateway housekeeping \
  --threshold-alert wouldPruneCount:>5000000 \
  || slack_warn

# Tier 3: info (log only)
crossengin gateway housekeeping \
  --threshold-alert wouldPruneCount:>1000000 \
  --format json | log_to_otel
```

## Testing

48 new tests across three files:

- **threshold-alert.test.ts** (32 unit tests): parser
  validation (numeric/duration/timestamp), every operator
  (GT/GTE/LT/LTE/EQ), null handling per field type, evaluator
  trip / not-trip cases for each kind, flag-array parsing
  with unknown field + type mismatch errors, renderer output
  with auto-unit duration suffixes.

- **retention-housekeeping.test.ts** (8 CLI tests): exit 0
  when no trip, exit 3 on numeric trip, exit 3 on duration
  trip, multiple alerts, invalid syntax exit 2, unknown field
  exit 2, JSON envelope always emits `alerts: []`, JSON
  envelope embeds tripped details, composes with `--watch`
  (first-tick halt).

- **gateway.test.ts** (8 CLI tests): same shape as retention
  tests, adapted to gateway's field registry (no
  `perTenantPolicyCount`).

Workspace test count 9,543 → 9,591 (+48). Coverage on
`threshold-alert.ts` at 93.65%/84.31%/100%/93.65% — above all
thresholds.
