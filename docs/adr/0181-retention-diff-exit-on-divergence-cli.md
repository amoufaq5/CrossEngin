# ADR-0181: `crossengin retention diff --exit-on-divergence` CI gate flag (Phase 2 M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0178 (retention diff cross-tenant), ADR-0179 (retention diff --vs-platform), ADR-0180 (retention diff --cross-table) |

## Context

After ADR-0178/0179/0180 shipped the full diff matrix (cross-tenant + tenant-vs-platform + cross-table-within-tenant), operators started wiring `retention diff` into CI pipelines as drift detectors. Three of those four ADRs explicitly listed a CI-gate exit-code flag as future work:

- ADR-0179 Q6: `--exit-on-divergence` for CI gates that fail when tenant differs from platform.
- ADR-0180 Q3: `--exit-on-divergence` for CI gates.

The existing workaround:

```bash
DIFF=$(crossengin retention diff <a> <b> <table> --format json)
if echo "$DIFF" | jq -e '.result.fieldDiffs | length > 0'; then
  exit 1
fi
```

Three downsides:
1. **Fragile** — `jq -e` exit code (0 = truthy result + non-empty; 1 = falsy/empty; 4-5 = real errors) collides with retention-diff's runtime-error exit code. CI logs that say "exit 1" don't distinguish "drift detected" from "PG connection refused."
2. **Boilerplate** — every CI pipeline reinvents the same pattern.
3. **Three discriminator branches in jq** — cross-tenant + vsPlatform + crossTable envelopes have different shapes; the wrapping script needs `jq -e '.result.fieldDiffs | length > 0'` per variant (the field path happens to be the same, but operators verifying their jq script don't know that without reading 3 ADRs).

A single `--exit-on-divergence` flag on the `diff` action covers all 3 variants uniformly.

## Decision

### Flag semantic

`--exit-on-divergence` is a boolean flag on the `retention diff` action that applies to ALL three variants (cross-tenant default, `--vs-platform`, `--cross-table`). When set:

- `fieldDiffs.length === 0` → exit code **0** (no drift detected; CI gate passes).
- `fieldDiffs.length > 0` → exit code **3** (drift detected; CI gate fails).

When NOT set, the diff action returns exit 0 regardless of `fieldDiffs` (backward compatible — pre-M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence callers see identical behavior).

### Why exit code 3

Existing CLI exit codes across the substrate:
- **0** — success
- **1** — runtime error (adapter throws, PG connection refused, etc.)
- **2** — misuse (missing args, invalid flag value, mutually-exclusive flags)

**Exit 3** for "drift detected; completed successfully but CI-gate fail" stays distinguishable from runtime errors. CI logs reading exit codes get clean signal:
- Exit 1 in pipeline → something is broken (PG/network/permissions); fix and rerun.
- Exit 3 in pipeline → retention drift detected on the configured tenants; cohort-consistency check failed.

Bash gates work the same way regardless (`if ! crossengin retention diff ... --exit-on-divergence; then ...`), but operators differentiating signal from noise get it for free.

GNU `diff(1)` uses exit 1 for "files differ" and 2 for "error" — different convention. We diverge deliberately because exit 1 is already meaningful (runtime error) in the CrossEngin CLI.

### Output unchanged

The result (human or JSON) is STILL emitted on exit 3. Operators reading scripts see what diverged. The flag controls only the exit code.

### Single flag for all 3 variants

`--exit-on-divergence` works identically on:
- `retention diff <a> <b> <table>` (cross-tenant)
- `retention diff <tenant> <table> --vs-platform`
- `retention diff <tenant> <table-a> <table-b> --cross-table`

No per-variant naming (`--exit-on-cross-tenant-drift`, etc.); a single uniform contract.

### Implementation

Pure CLI enhancement, no adapter changes. Each of the 3 runner functions now:

```ts
if (command.format === "json") {
  printJson(ctx.io, { action: "diff", ..., result });
} else {
  ctx.io.stdout.write(formatXDiff(result));
}
return divergenceExitCode(command, result.fieldDiffs.length);
```

Where `divergenceExitCode` is a shared private helper:

```ts
function divergenceExitCode(
  command: ParsedCommand,
  fieldDiffsLength: number,
): number {
  if (getBooleanFlag(command, "exit-on-divergence") && fieldDiffsLength > 0) {
    return 3;
  }
  return 0;
}
```

Runtime errors (adapter throws) take precedence — the existing `return 1` from the catch block fires before `divergenceExitCode` is reached.

## Use cases unblocked

**1. CI cohort consistency gate**

```bash
crossengin retention diff <tenant-a> <tenant-b> workflow_traces --exit-on-divergence
# exit 3 → CI step fails; build red until cohort is reconciled
```

Direct bash idiom replaces the existing `jq -e` wrapping.

**2. Per-tenant drift detection from platform default**

```bash
crossengin retention diff <regulated-tenant> workflow_traces --vs-platform --exit-on-divergence
# exit 0 if tenant inherits default; exit 3 if tenant has its own retention/opt-out
```

For tenants that MUST stay on the platform default (e.g., free-tier with no override capability), this is the canonical CI assertion.

**3. Per-tenant cross-table consistency**

```bash
crossengin retention diff <legal-hold-tenant> workflow_traces llm_call_traces --cross-table --exit-on-divergence
# exit 3 → legal hold is incomplete (applied to one table but not the other)
```

Compliance gate for legal-hold completeness.

**4. Pipeline runners differentiate exit 1 vs exit 3**

```bash
# In a wrapping bash script
crossengin retention diff ... --exit-on-divergence
case $? in
  0) echo "✅ no drift" ;;
  1) echo "❌ runtime error — investigate"; exit 1 ;;
  3) echo "⚠️  drift detected — alert team"; exit 3 ;;
esac
```

CI systems can route exit 1 to on-call, exit 3 to compliance team.

## Drawbacks

1. **New exit code (3) added to the substrate's CLI vocabulary.** Operators reading existing scripts may not realize the new code exists. Mitigated by the flag being opt-in — pre-M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence callers never see exit 3.
2. **No `--exit-on-no-divergence` inverse.** Operators wanting "fail CI when tenants stop diverging" (unusual but conceivable for A/B-test migration gates) write `! crossengin retention diff ... --exit-on-divergence` instead. Deferred — single direction covers the common case.
3. **No `--threshold N` for "exit 3 only if N+ field diffs."** Operators wanting fuzzy thresholds wrap with jq. Deferred.
4. **No per-field allowlist** (e.g., "fail only on retention_days drift, ignore enabled drift"). Operators wrap with jq filter then check length. Deferred.
5. **Exit code 3 is a CrossEngin-specific convention.** Operators porting scripts from `diff(1)` (which uses exit 1 for "files differ") need to translate. Documented in help text.
6. **Output still emitted on exit 3.** CI systems that grep stderr for errors won't see drift output (it's on stdout). Operators redirect appropriately.

## Alternatives considered

1. **Exit 1 (matching `diff(1)`)** — collides with existing runtime-error exit 1. Rejected — distinguishability is the point.
2. **Exit 2 (matching `git diff --exit-code`)** — collides with existing misuse exit 2. Rejected.
3. **`--ci` flag instead of `--exit-on-divergence`** — too vague; doesn't name the semantic. Rejected.
4. **Three per-variant flags (`--cross-tenant-exit-on-divergence`, etc.)** — verbose; one flag works on all 3. Rejected.
5. **Implicit exit-on-divergence when stdout is not a TTY** — magical; operators want explicit. Rejected.
6. **Print "drift detected" warning on stderr in addition to exit code** — noisy when piped through pipelines; output already shows the diff. Rejected.
7. **`--threshold N` parameter (only fail when N+ field diffs)** — overkill for v1; operators chain with jq for now. Deferred to future Q.
8. **Adapter-side method returning the exit signal instead of CLI-side computation** — exit codes are a CLI concern; the adapter stays uncoupled from process exit. Rejected.

## Open questions

1. **`--exit-on-no-divergence` inverse flag.** Defer — wrap with bash `!`.
2. **`--threshold N` for N+ field-diff exit.** Defer — jq covers.
3. **`--field <name>` allowlist for which fields trigger exit 3.** Defer — jq covers.
4. **`--quiet` flag to suppress diff output when exit 3 is the only signal needed.** Defer — operators redirect `> /dev/null`.
5. **Distinguished exit codes per variant (e.g., 3 for cross-tenant, 4 for vs-platform, 5 for cross-table).** Rejected — single code keeps the contract simple; the JSON envelope discriminator covers per-variant context.
6. **`--exit-on-divergence` on `retention diff-history` action.** Mirror case — operators verifying state stability across two history events. Defer — different workflow.
7. **Apply same flag to `retention list-policies` (e.g., exit 3 if any tenant has overrides)** — different semantic (drift vs configuration); separate ADR if requested.
