# ADR-0214: `crossengin retention diff-history --kind-not` repeatable for multi-value OR-semantic exclusion expectation check (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.kind-not.multi)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0208 (--kind-not single-value expectation check), ADR-0198 (--kind single-value expectation check), ADR-0200 (--kind multi-value filter on diff-timeline precedent), ADR-0210 (--actor-id-not multi-value precedent), ADR-0183 (multiFlags infrastructure) |

## Context

ADR-0208 shipped `--kind-not <event-kind>` as a single-value expectation check on `retention diff-history` — operator declares "I expect neither event to have event_kind X" and the adapter throws on match. Future Q1 explicitly listed widening to multi-value via repeated flag using the `multiFlags` infrastructure from ADR-0183:

> 1. `--kind-not <a>|<b>|<c>` multi-value exclusion ("neither event must be one of these N kinds"). Defer; multi-value shape different from --kind multi-value (ADR-0200 ships --kind multi-value via repeated flag on diff-timeline; diff-history could mirror once a measured demand emerges for excluding multiple kinds).

The operational use case has stabilized — operators reviewing forensic diffs frequently want to assert "this is a state-transition pair, NOT (deletion OR scheduled retention rebuild)" excluding 2 of the 4 event_kinds in one expression. Currently they:

1. Run two separate `retention diff-history --kind-not X` commands, asserting separately, and fail-fast on the first throw — verbose + loses the "neither of N kinds" expression semantic.
2. Chain `jq` on JSON output to check the rendered `eventKindA` / `eventKindB` fields against an exclusion list post-fetch — works but bypasses the substrate's expectation-check exit-code semantic (CI gates lose exit 1 on mismatch).

Multi-value `--kind-not` closes both gaps. Mirror of:
- **ADR-0210 multi-value `--actor-id-not`** on retention history (same flag-repetition pattern, same one-shot breaking rename, same empty-array-as-filter-not-set convention).
- **ADR-0200 multi-value `--kind`** on diff-timeline (same per-occurrence validation against the 4-value enum, same exit-2-on-any-invalid stance).

This milestone closes ADR-0208 Q1 by widening to multi-value.

Real cohort-exclusion use cases on diff-history:

1. **Workflow audit excluding maintenance kinds** — "this diff is an opt-out workflow comparison; assert NEITHER event is `policy_deleted` OR `retention_set`" in one command (operators currently chain 2 commands).
2. **Anti-automation pair verification** — "assert NEITHER event is a system-automation event_kind (`retention_set` for scheduled sweeps + `policy_deleted` for compliance prunes)" before treating the diff as deliberate human-policy work.
3. **CI gate with kind-list exclusion** — "fail build if either event matches any of these 3 kinds we don't want in this diff context."
4. **Cohort-aware forensic comparison** — "during this incident window, assert neither event was authored by the retention-sweep automation kinds" — composes with `--system-only` from ADR-0212 for layered assertion.

## Decision

### CLI surface

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--kind <event-kind>]
                                  [--kind-not <event-kind> ...]   # NOW REPEATABLE
                                  [--actor-id <uuid>]
                                  [--actor-id-not <uuid>]
                                  [--system-only | --no-system]
                                  [--with-actor-names]
                                  [--format human|json]
```

- `--kind-not <event-kind>` is now repeatable via the `multiFlags` infrastructure from ADR-0183.
- Single occurrence: `--kind-not policy_deleted` asserts neither event has that one kind (equivalent to ADR-0208 single-value behavior).
- Multi occurrence: `--kind-not policy_deleted --kind-not retention_set` asserts neither event has ANY of the listed kinds (OR-semantic exclusion).
- Empty (zero occurrences): treated as expectation-not-set (no check) — backward compat.
- Composes with `--kind` (positive expectation, stays single-value this milestone) and all other diff-history flags without restriction.
- Invalid value on ANY occurrence exits 2 with the offending value named (matches ADR-0200 multi-kind validation pattern on diff-timeline).

### Adapter changes

`DiffHistoryEntriesInput` field rename — breaking change for direct adapter consumers (session-recent code from ADR-0208, no external consumers, contained scope):

```ts
// Before (ADR-0208):
readonly eventKindNot?: OptOutHistoryEventKind;

// After (this milestone):
readonly eventKindsNot?: ReadonlyArray<OptOutHistoryEventKind>;
```

One-shot clean break beats permanent two-field surface. Same pattern as:
- ADR-0199 `actorId → actorIds` on diff-timeline
- ADR-0207 `actorIdNot → actorIdsNot` on diff-timeline
- ADR-0210 `actorIdNot → actorIdsNot` on retention history
- ADR-0211 `actorId → actorIds` on retention history
- ADR-0200 `eventKind → eventKinds` on diff-timeline

Six consecutive single→multi renames establish the precedent that this milestone follows mechanically.

Expectation check logic rewrites:

```ts
if (
  input.eventKindsNot !== undefined &&
  input.eventKindsNot.length > 0
) {
  const excludedSet = new Set<string>(input.eventKindsNot);
  const matches: string[] = [];
  if (excludedSet.has(entryA.event_kind)) matches.push("A");
  if (excludedSet.has(entryB.event_kind)) matches.push("B");
  if (matches.length > 0) {
    const suffix =
      matches.length === 1
        ? `${matches[0]} matches`
        : "both A and B match";
    const kindList = input.eventKindsNot
      .map((k) => `'${k}'`)
      .join(", ");
    throw new Error(
      `diffHistoryEntries: expected neither event to have event_kind in [${kindList}] but ${suffix}`,
    );
  }
}
```

Key shape decisions:

1. **Set-based lookup** — O(1) membership check via `Set<string>` for the excluded kinds. Operators with up to 4 kinds (the full enum) get same performance as single-value lookup.
2. **Always-list error format** — `event_kind in ['X']` for single-value, `event_kind in ['X', 'Y']` for multi-value. Single-value error format breaks from ADR-0208's `event_kind 'X'` shape — acceptable because the field rename `eventKindNot → eventKindsNot` is itself a breaking API change; operators relying on error string format need to update at the same time as the field rename. Consistent error format across single + multi reads better than separate single-value-special-case vs multi-value-list-case formats.
3. **Empty array = filter-not-set** — matches ADR-0199/0200/0207/0210/0211 convention. Operators may legitimately compute the list at the call site producing an empty array (allowlist empty); operator-friendly.
4. **Duplicates preserved verbatim** — operators passing `--kind-not policy_deleted --kind-not policy_deleted` get a Set with one entry (Set dedupes membership). Substrate doesn't dedup the input array itself (matches ADR-0207/0210/0211 stance) — the Set is constructed at check time so duplicates in the input array become single-entry Set lookups; harmless. Error message preserves the operator's literal input including duplicates.

### CLI changes

`runRetentionDiffHistory` reads via `getMultiFlag("kind-not")` instead of `getStringFlag("kind-not")`:

```ts
const kindNotFlags = getMultiFlag(command, "kind-not");
const validatedKindsNot: OptOutHistoryEventKind[] = [];
for (const kindNotFlag of kindNotFlags) {
  if (!isOptOutHistoryEventKind(kindNotFlag)) {
    printError(
      ctx.io,
      `retention diff-history: invalid --kind-not '${kindNotFlag}' (...)`,
    );
    return 2;
  }
  validatedKindsNot.push(kindNotFlag);
}
const eventKindsNot: ReadonlyArray<OptOutHistoryEventKind> | undefined =
  validatedKindsNot.length > 0 ? validatedKindsNot : undefined;
```

Per-occurrence validation matches ADR-0200 multi-kind on diff-timeline — exits 2 on the FIRST invalid value with that value named in the error message. Operators reading the error know exactly which `--kind-not` occurrence failed.

### JSON envelope rename

```json
{
  "action": "diff-history",
  "kind": null,
  "kindsNot": ["policy_deleted", "retention_set"],   // RENAMED: was kindNot (string | null)
  "actorId": null,
  "actorIdNot": null,
  "systemOnly": false,
  "noSystem": false,
  "withActorNames": false,
  "result": { ... }
}
```

Breaking JSON envelope rename — `kindNot: string | null` → `kindsNot: string[] | null`. Operators parsing the envelope:
- Single-occurrence: `kindsNot: ["<kind>"]`.
- Multi-occurrence: `kindsNot: ["<a>", "<b>", ...]`.
- Not set: `kindsNot: null`.

Same shape as ADR-0207 / ADR-0210 / ADR-0211 array-or-null canonical multi-value envelope.

### Composition with --kind positive expectation

The positive `--kind` filter from ADR-0198 stays SINGLE-VALUE this milestone. This creates a within-action asymmetry on diff-history (matching the historical asymmetry that existed on retention history between ADR-0210 and ADR-0211 before ADR-0211 widened the positive side):

| Flag | Shape | ADR |
|---|---|---|
| `--kind` | single string | ADR-0198 |
| `--kind-not` | string array | ADR-0214 (this milestone) |

The asymmetry is documented as future Q. Widening `--kind` to multi-value tuple expectation ("all must be one of these N kinds") would close ADR-0198 Q2 and restore within-action symmetry. Deferred to keep this milestone's scope focused on closing ADR-0208 Q1 specifically.

Asymmetry is acceptable here because:
1. **Positive + negative are semantically distinct dimensions** — the negative path benefits more from multi-value since "exclude these N noise kinds" is more common than "include exactly one of these N specific kinds" (operators with positive multi-value would typically just use no filter and post-filter on the result).
2. **Diff-timeline has BOTH multi-value** (ADR-0194 positive + ADR-0200 multi-positive — wait actually ADR-0200 is the multi-positive milestone; diff-timeline doesn't have a `--kind-not` flag yet). Updated note: diff-timeline has `--kind` multi-value from ADR-0194/0200 but lacks `--kind-not` entirely (deferred future Q).
3. **The 4-value event_kind enum makes multi-value positive less compelling than multi-value negative** — operators wanting "any of these 3 kinds" can equivalently use "neither of the remaining 1 kind" via `--kind-not`. The negative path is a strict superset of the positive path's expressiveness.

## Use cases unblocked

**1. Workflow audit excluding maintenance kinds**

```bash
# Assert neither event is a maintenance event_kind:
crossengin retention diff-history $id_a $id_b \
  --kind-not policy_deleted --kind-not retention_set
# Exit 0 if both are opt_out_set / opt_out_cleared events.
# Exit 1 if either is policy_deleted or retention_set.
```

**2. Anti-automation pair verification**

```bash
# Verify both events are deliberate human-policy work (no automation kinds):
crossengin retention diff-history $id_a $id_b \
  --kind-not retention_set --kind-not policy_deleted \
  --no-system --with-actor-names
# Composes negative kind exclusion with negative actor-presence exclusion.
```

**3. CI gate with kind-list exclusion**

```bash
# Fail build if either event matches any of these 3 kinds:
crossengin retention diff-history $baseline $current \
  --kind-not retention_set --kind-not policy_deleted --kind-not opt_out_cleared
# Exit 1 unless both events are opt_out_set.
```

**4. Compose with --kind positive expectation**

```bash
# Both must be opt_out_set AND neither may be the noise kinds:
crossengin retention diff-history $id_a $id_b \
  --kind opt_out_set \
  --kind-not policy_deleted --kind-not retention_set
# Redundant but loud + clear; documents intent in CI scripts.
```

**5. Compose with --actor-id-not + --no-system + multi --kind-not**

```bash
# Full forensic discipline: both opt_out events, neither system, neither
# authored by the migration SA, neither is a maintenance kind:
crossengin retention diff-history $baseline $current \
  --kind opt_out_set \
  --kind-not policy_deleted --kind-not retention_set \
  --actor-id-not $migration_sa \
  --no-system --with-actor-names
```

## Drawbacks

1. **Breaking adapter field rename `eventKindNot → eventKindsNot`** — direct adapter consumers (Node scripts calling the adapter without the CLI layer) need to update. Contained scope, session-recent code from ADR-0208, no external consumers. Same one-shot break justification as ADR-0199/0207/0210/0211.
2. **Breaking JSON envelope rename `kindNot → kindsNot`** — operator jq scripts parsing the envelope need to update. Same justification as adapter rename. Operators reading either path can detect the rename via the array-vs-string shape.
3. **Breaking error message format** — `event_kind 'X' but A matches` → `event_kind in ['X'] but A matches` (always-list format). Operators relying on exact error string format in their test/CI assertions need to update. Justified because the field rename is itself a breaking change at the same boundary.
4. **Within-action asymmetry with single-value `--kind`** — positive expectation stays single-value while negative goes multi-value (documented above). Acceptable until the natural-symmetric milestone widens `--kind` too. Documented future Q.
5. **No CLI-side dedup** — operators passing `--kind-not X --kind-not X` get duplicate placeholders in the array; Set-based lookup at adapter dedupes membership but the input array preserves duplicates (and error message reflects duplicates verbatim). Same stance as ADR-0207/0210/0211.
6. **First-invalid-fail-fast on validation** — operators with multiple `--kind-not` flags and one typo see only the first invalid value in the error. Acceptable; operators fix one at a time.
7. **No comma-separated `--kind-not <a>,<b>,<c>` short-hand** — fragile with shell-quoted enum values containing special chars (though current enum values don't). Repeated flag is the canonical multiFlags pattern from ADR-0183. Defer.

## Alternatives considered

1. **Two-field adapter surface (`eventKindNot: OptOutHistoryEventKind` + `eventKindsNot: ReadonlyArray<...>`)** — permanent two-field surface invites operator confusion ("which one wins when both set?"). One-shot rename cleaner, matches the established 6-rename precedent.
2. **`--kind-not <a>|<b>|<c>` pipe-separated single flag** — fragile shell-quoting; repeated flag via `multiFlags` is the established pattern.
3. **`--kind-not <a>,<b>,<c>` comma-separated single flag** — fragile if enum values ever contain commas (currently don't); operators with shell `$VAR` substitution containing commas hit edge cases. Defer.
4. **Keep single-value, document jq-workaround for multi-value** — fails the exit-code-semantic argument (jq-side post-filter loses CI gate exit 1 semantic). Rejected.
5. **Ship in same milestone as `--kind` multi-value tuple expectation** — would close ADR-0198 Q2 + ADR-0208 Q1 in one shot, BUT exceeds the user's requested scope ("multi-value `--kind-not` on retention diff-history"). Documented as future Q.
6. **Keep single-value error message format for single-element arrays** — `event_kind 'X'` for length 1, `event_kind in ['X', 'Y']` for length 2+. Inconsistent rendering across single/multi-value; operators reading error strings need to handle both formats. Always-list is more predictable.
7. **PG-side WHERE filter (NOT IN)** — diff-history takes exactly 2 fixed IDs, not a list query. WHERE filter would silently return zero rows on mismatch indistinguishable from "IDs don't exist." Adapter throw with clear message is the correct semantic.
8. **Substrate-side dedup of duplicate values** — PG-style IN duplicates harmless via Set; CLI doesn't need to filter operator input. Matches ADR-0207/0210/0211.
9. **Auto-validate at adapter (not CLI)** — adapter receives `OptOutHistoryEventKind[]` which TypeScript narrows; trusting the type. CLI handles validation at the boundary before construction.
10. **Implement as separate `--kind-not-any` flag while preserving single-value `--kind-not`** — adds CLI surface with two near-identical flag names. Rename + multi-value cleaner.

## Open questions

1. **Widen `--kind` to multi-value tuple expectation** on diff-history — closes ADR-0198 Q2 + restores within-action symmetry. Natural follow-up milestone. Defer.
2. **`--kind-not @file.txt` for very large exclusion lists** — operators with the 4-value enum don't need this (max 4 values total). Defer indefinitely unless enum expands.
3. **`--kind-not` filter on retention history** — substrate-side filter pairs with ADR-0206 Q4 (multi-value negative kind filter on history). Defer.
4. **`--kind-not` filter on retention diff-timeline** across all 3 paths — multi-value substrate-side filter pairs with ADR-0207 Q4 + ADR-0200 future Q. Defer.
5. **CLI-side dedup of duplicate values** — defer; PG/Set handles fine, operators see literal input in error.
6. **Semantic-shape exclusion grouping write-mutations** — `--exclude-write-mutations` shorthand grouping `opt_out_set` + `retention_set` + `policy_deleted`. Operator-policy concern. Defer.

## Implementation outline

Three additive code changes:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - `DiffHistoryEntriesInput.eventKindNot?: OptOutHistoryEventKind` → `eventKindsNot?: ReadonlyArray<OptOutHistoryEventKind>` (breaking rename).
   - Adapter check logic rewritten with Set-based membership lookup + always-list error format + empty-array-as-filter-not-set + error message naming offending side(s) compactly via existing `matches.length === 1 ? "X matches" : "both A and B match"` pattern.

2. **`apps/architect-cli/src/retention.ts`**:
   - `runRetentionDiffHistory` reads via `getMultiFlag(command, "kind-not")` instead of `getStringFlag`.
   - Per-occurrence validation via `isOptOutHistoryEventKind` loop (matches ADR-0200 pattern); exits 2 on FIRST invalid value.
   - Threads `eventKindsNot: ReadonlyArray<OptOutHistoryEventKind> | undefined` to adapter.
   - JSON envelope renamed `kindNot: string | null` → `kindsNot: string[] | null`.

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention diff-history` usage line updated from `[--kind-not <event-kind>]` to `[--kind-not <event-kind> ...]` indicating repeatable.
   - Description block updated explaining "repeatable" + "NEITHER event has any of the listed event_kinds" + "match by either side on any listed kind exits 1".

## Tests

Adapter test block rewritten + expanded from 8 → 12 tests under renamed "diffHistoryEntries --kind-not exclusion check (M6.7.zz.tenant.opt-out.cli.diff-history.kind-not + .multi)" describe block:

1. Single-value: accepts when neither event has the excluded event_kind.
2. Single-value: throws when event A matches with new `event_kind in ['X'] but A matches` format.
3. Single-value: throws when event B matches.
4. Single-value: throws naming both sides when neither matches.
5. Multi-value: accepts when neither event has any of the excluded kinds (NEW).
6. Multi-value: throws when A matches one of N excluded kinds with multi-value error format (NEW).
7. Multi-value: throws naming both when both events match different kinds in the exclusion list (NEW).
8. Omits the check when eventKindsNot not set (backward compat).
9. Treats empty eventKindsNot array as filter-not-set (NEW).
10. Composes with --kind expectation check (both pass when distinct kinds).
11. Contradictory --kind + --kind-not surfaces kind check first.
12. Composes with --actor-id-not (both checks fire independently).

CLI test block rewritten + expanded from 7 → 10 tests under renamed "runRetention diff-history --kind-not (M6.7.zz.tenant.opt-out.cli.diff-history.kind-not + .multi)" describe block:

1. Returns exit 2 when --kind-not is invalid value.
2. Returns exit 2 on FIRST invalid --kind-not occurrence when multiple flags supplied (NEW).
3. Threads eventKindsNot as single-element array when --kind-not set once.
4. Threads multi-element eventKindsNot when --kind-not repeated (NEW).
5. Omits eventKindsNot when --kind-not NOT set (backward compat).
6. Composes with --kind (both threaded independently, multi-value kind-not).
7. Adapter exclusion error propagates as exit 1 with multi-value error format.
8. JSON envelope echoes kindsNot single-element array when --kind-not set once.
9. JSON envelope echoes multi-element kindsNot when --kind-not repeated (NEW).
10. JSON envelope kindsNot=null when --kind-not NOT set.

cli.ts helpText extended for retention diff-history usage line — `[--kind-not <event-kind> ...]` notation + description updated to "repeatable" + "NEITHER event has any of the listed kinds" + match-by-either-side semantic.

Test count: 9,004 → 9,011 (+7 net: adapter +4, CLI +3). The block rewrites kept existing single-value coverage while adding multi-value coverage.

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green (no new errors from this milestone; pre-existing `labelForIndex` + `chat.ts` errors unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

The retention diff-history surface now has an asymmetric within-action kind filter dimension:

| Flag | Shape | ADR |
|---|---|---|
| `--kind` (positive expectation) | single string | ADR-0198 |
| `--kind-not` (negative expectation) | string array | ADR-0214 (this milestone) |

Widening `--kind` to multi-value tuple expectation closes ADR-0198 Q2 + restores within-action symmetry. Natural follow-up milestone.

The retention CLI's multi-value flag coverage continues to expand:

| Surface × Flag | Status |
|---|---|
| retention history `--actor-id` | multi (ADR-0211) |
| retention history `--actor-id-not` | multi (ADR-0210) |
| retention history `--kind` | single (ADR-0170; ADR-0211 Q8 deferred) |
| retention diff-history `--actor-id` | single expectation (ADR-0203) |
| retention diff-history `--actor-id-not` | single expectation (ADR-0205) |
| retention diff-history `--kind` | single expectation (ADR-0198) |
| retention diff-history `--kind-not` | multi expectation (ADR-0214 — this milestone) |
| retention diff-timeline `--actor-id` | multi filter (ADR-0199) |
| retention diff-timeline `--actor-id-not` | multi filter (ADR-0207) |
| retention diff-timeline `--kind` | multi filter (ADR-0194/0200) |

The retention diff-history surface uniquely keeps single-value semantics on most flags because expectation-check has different operator ergonomics than list-query filter (operators making per-event assertions usually have specific values in mind, not cohorts). The negative kind-not filter is the first multi-value expectation check on diff-history; the symmetric positive `--kind` multi-value is the natural follow-up.

The retention CLI now has 18 actions with comprehensive multi-flag coverage spanning the actor + kind dimensions across all 3 surfaces with surface-appropriate semantics.
