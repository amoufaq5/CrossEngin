# ADR-0184: `crossengin retention diff --threshold N` fuzzy CI-gate threshold (Phase 2 M6.7.zz.tenant.opt-out.cli.diff.threshold)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0181 (retention diff --exit-on-divergence), ADR-0183 (retention diff --add-tenant) |

## Context

ADR-0181 shipped `--exit-on-divergence` for CI gates that fail on ANY field difference. ADR-0183 extended that to N-way diff via fieldVariations counts. Both listed Q2 / Q5 respectively as:

- ADR-0181 Q2: `--threshold N` parameter (only fail when N+ field diffs).
- ADR-0183 Q5: `--threshold N` combined with `--exit-on-divergence` (only exit 3 when N+ field variations).

Real operator use cases pile up:
- Tier migration: "fail CI when more than 1 field differs from reference" — small drifts during migration are acceptable but a multi-field drift signals a bigger problem.
- Cohort-consistency: "in a 10-tenant cohort, fail CI when the cohort has 3+ distinct fields varying" — minor variations (e.g., reason field text wording) are tolerable, structural drift is not.
- Compliance noise reduction: "fail only when source + retention_days differ; ignore enabled flag noise" — operators wrap with jq for now but want first-class support.

`--threshold N` makes the gate fuzzy. Operators specify N+ field differences as the failure threshold; the gate fails (exit 3) only when the count crosses the threshold.

M6.7.zz.tenant.opt-out.cli.diff.threshold closes both deferred Qs.

## Decision

### CLI surface

```
crossengin retention diff <...args> --exit-on-divergence --threshold <N>
```

`--threshold N` is a string flag taking a positive integer (`N >= 1`). Default when omitted: `N=1` (equivalent to current `--exit-on-divergence` behavior).

### Semantic

| `fieldDiffs.length` or `fieldVariations.length` | Without `--threshold` | `--threshold 1` | `--threshold 2` | `--threshold 5` |
|---|---|---|---|---|
| 0 | exit 0 | exit 0 | exit 0 | exit 0 |
| 1 | exit 3 | exit 3 | exit 0 | exit 0 |
| 2 | exit 3 | exit 3 | exit 3 | exit 0 |
| 5 | exit 3 | exit 3 | exit 3 | exit 3 |
| 10 | exit 3 | exit 3 | exit 3 | exit 3 |

`N=1` is equivalent to current `--exit-on-divergence` behavior. `N>=2` enables the fuzzy semantic. Comparison is `>=` (at-or-above-threshold) — `--threshold 5` fails on EXACTLY 5 diffs, not 6+.

### Validation

| Condition | Exit | Message |
|---|---|---|
| `--threshold` set without `--exit-on-divergence` | 2 | `--threshold requires --exit-on-divergence` |
| `--threshold 0` (or negative) | 2 | `--threshold must be a positive integer` |
| `--threshold 1.5` (non-integer) | 2 | `--threshold must be a positive integer` |
| `--threshold abc` (non-numeric) | 2 | `--threshold must be a positive integer` |
| Valid value | 0/3 per semantic above | — |

Validation fires at the TOP of `runRetentionDiff` (before the dispatcher routes to a variant), so invalid `--threshold` returns exit 2 without any PG queries. CI logs that say "exit 2" are immediately recognizable as CLI misuse, not runtime errors.

### Why require `--exit-on-divergence`

`--threshold` without `--exit-on-divergence` would silently no-op — operators passing `--threshold 5` thinking the gate is configured would get exit 0 regardless of the diff. Strict rejection catches that misuse early.

### Single helper across 4 diff variants

The existing `divergenceExitCode(command, fieldDiffsLength)` helper now reads `--threshold` from `command.flags` directly:

```ts
function divergenceExitCode(
  command: ParsedCommand,
  fieldDiffsLength: number,
): number {
  if (!getBooleanFlag(command, "exit-on-divergence")) return 0;
  const thresholdRaw = getStringFlag(command, "threshold");
  const threshold = thresholdRaw === null ? 1 : Number(thresholdRaw);
  return fieldDiffsLength >= threshold ? 3 : 0;
}
```

Trusts that `validateThresholdFlag` already ran successfully at the parent dispatcher — no error paths inside the exit-code computation. Pure CLI code; no adapter changes.

Applies uniformly to all 4 diff variants:
- Cross-tenant default: `result.fieldDiffs.length`
- `--vs-platform`: `result.fieldDiffs.length`
- `--cross-table`: `result.fieldDiffs.length`
- `--add-tenant` N-way: `result.fieldVariations.length`

For N-way, the count is "number of fields with variation" (not the cross-product of distinct value groups). This matches what operators care about — "how many fields differ across the cohort?" — not "how many distinct value cells exist."

### Pure CLI enhancement

No adapter changes, no result-type changes, no JSON envelope changes. The threshold is consumed at the CLI exit-code layer. JSON output emits the same `fieldDiffs`/`fieldVariations` arrays as before — operators inspecting JSON can apply their own filter logic on top.

## Use cases unblocked

**1. Cohort drift gate tolerating minor variations**

```bash
crossengin retention diff "$ref" "$b" workflow_traces \
  --add-tenant "$c" --add-tenant "$d" --add-tenant "$e" \
  --exit-on-divergence --threshold 3
# exit 3 only when 3+ fields vary across the 5-tenant cohort
# minor 1-2 field variations (e.g., reason text differences) tolerated
```

**2. Tier migration tolerance**

```bash
crossengin retention diff "$migrated" "$ref" workflow_traces \
  --exit-on-divergence --threshold 2
# exit 3 when migration left 2+ fields divergent from reference
# expected single-field difference (e.g., updated_at timestamp) ignored
```

**3. Compliance-only-source gate**

```bash
# Operators wanting "ONLY source must match" use jq for now; --threshold
# combined with --exit-on-divergence covers the simpler "tolerate up to N
# differences" case without per-field configuration.
crossengin retention diff "$tenant" workflow_traces --vs-platform \
  --exit-on-divergence --threshold 5
# Tolerates up to 4 fields of drift; fails on 5+
```

**4. Graduated CI gates**

```bash
# Pipeline stage 1: strict (any drift fails)
crossengin retention diff ... --exit-on-divergence --threshold 1
# Pipeline stage 2: lenient (5+ drifts fail)
crossengin retention diff ... --exit-on-divergence --threshold 5
```

Operators wire multiple gates with different sensitivities into staged pipelines.

## Drawbacks

1. **`--threshold` requires `--exit-on-divergence`.** Operators passing `--threshold 3` without `--exit-on-divergence` get exit 2. Documented but could surprise — strict-rejection chosen over silent no-op.
2. **No per-field threshold or per-field allowlist.** Operators wanting "ignore the `enabled` field, count everything else" wrap with `jq` on JSON output then check length. Threshold is uniform across all field types.
3. **`>=` semantic (at-or-above).** Operators wanting strict-above (`>`) need `--threshold N+1`. Documented; matches "fail when at least N" intuition.
4. **No fractional threshold.** Operators wanting "fail when 50%+ of fields differ" compute the expected count themselves. Out of scope.
5. **N-way uses field-variation count not value-cell count.** For a 10-tenant cohort with 3 fields each having 2 distinct values, `fieldVariations.length` is 3, not 6 (3 fields × 2 distinct values each). Documented; matches operator intent ("how many fields differ").
6. **Validation happens at the parent dispatcher** — variant-specific helpers (`runRetentionDiffVsPlatform` etc.) trust the threshold is valid. If new variants are added in the future, they must call `divergenceExitCode` at the end; if they bypass it, they bypass threshold checking too.

## Alternatives considered

1. **`--max-diffs N` instead of `--threshold N`** — same semantic, different name; `--threshold` is more idiomatic for "fail when N+". Rejected name.
2. **Strict `>` semantic (`--threshold N` fails when N+1+ diffs)** — operators counting "I want to fail when 2+ fields differ" set `--threshold 2`, not `--threshold 1`. Rejected — counterintuitive.
3. **Silent no-op when `--threshold` is set without `--exit-on-divergence`** — masks misuse. Rejected.
4. **`--threshold` accepts `0` to mean "fail on any"** — equivalent to default, redundant; reject to keep semantic clean.
5. **`--ignore-fields <list>`** for per-field allowlist — broader feature; defer. Operators use jq for now.
6. **`--threshold-percentage X%`** for fractional threshold — operators compute expected count themselves. Defer.
7. **Apply threshold per-field (e.g., "fail when retention_days alone differs")** — different mental model; user wants whole-record threshold. Defer.
8. **Make threshold default `N=2` instead of `N=1`** — breaks backward compat with ADR-0181 callers. Rejected — default of 1 preserves prior semantics.
9. **N-way threshold against value-cell count (sum of distinct values across all varying fields)** — over-counts and confuses operators thinking about "how many fields differ." Rejected.

## Open questions

1. **`--ignore-field <name>`** repeated flag for per-field allowlist (using `multiFlags` infrastructure from ADR-0183). Defer.
2. **`--threshold-percentage X%`** for fractional thresholds in N-way comparisons across many fields. Defer.
3. **Per-field severity weighting** (e.g., `source` change = 10 points, `enabled` change = 1 point; fail when score >= threshold). Overcomplicated; defer.
4. **`--threshold` on `retention diff-history`** for cross-event analysis. Different workflow; defer.
5. **`--threshold` semantic for `retention prune`** (e.g., fail CI when N+ rows would be deleted). Different context (prune is destructive, not diff); separate ADR if requested.
6. **Output annotation** showing "threshold met: X >= Y" or "threshold not met: X < Y" in human format. Defer — operators read fieldDiffs count directly.
7. **Default threshold via environment variable** (e.g., `CROSSENGIN_DIFF_THRESHOLD=2`) for pipeline-wide configuration. Defer — operators set it per-call for clarity.
