# ADR-0217: `crossengin retention diff-history --kind` repeatable for multi-value OR-semantic tuple expectation check (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.kind.multi)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0198 (--kind single-value expectation), ADR-0214 (--kind-not multi-value precedent), ADR-0200 (diff-timeline multi-kind precedent), ADR-0210 (--actor-id-not multi-value rename precedent), ADR-0183 (multiFlags infrastructure) |

## Context

ADR-0198 shipped `--kind <event-kind>` as a single-value expectation check on `retention diff-history` — operator declares "I expect both events to have this event_kind" and the adapter throws on mismatch. Future Q2 explicitly listed widening to multi-value tuple expectation as deferred future work:

> ADR-0198 Q2: `--kind <a>|<b>|<c>` multi-value expectation (assert "both events must be one of these N kinds"). Defer; pairs with ADR-0200 multi-value filter on diff-timeline.

ADR-0214 just shipped multi-value `--kind-not` on the same surface (negative path). ADR-0214 documented the within-action asymmetry it created:

> ADR-0214 Drawback 4: Within-action asymmetry with single-value `--kind` — positive expectation stays single-value while negative goes multi-value. Acceptable until the natural-symmetric milestone widens `--kind` too. Documented future Q.

This milestone IS that follow-up. It widens global `--kind` to multi-value tuple expectation, restoring within-action symmetry on the kind dimension. The per-side `--kind-a` / `--kind-b` from ADR-0215 stay single-value (deferred to future Q — per-side multi-value tuple expectation).

Real cohort-inclusion use cases on diff-history:

1. **Opt-out lifecycle workflow assertion** — operator pulls two events and asserts "both must be opt_out workflow kinds" (`--kind opt_out_set --kind opt_out_cleared`) to verify the diff is within the opt-out workflow (not a maintenance event).
2. **State-transition pair verification** — assert "both events must be one of {opt_out_set, opt_out_cleared}" to verify both are operator-driven opt-out state changes excluding system maintenance kinds.
3. **Compliance attestation gating** — quarterly audit asserts "both events are policy state-changes (opt_out_set, opt_out_cleared, retention_set) not deletions" via 3-element tuple expectation.
4. **CI gate on workflow consistency** — fail build if either event is outside the expected workflow kind set.

Mirror of:
- **ADR-0214 multi-value `--kind-not`** on the same surface (negative direction; same flag-repetition pattern, same one-shot breaking rename).
- **ADR-0200 multi-value `--kind`** on diff-timeline (positive direction on the LIST-style surface; same per-occurrence validation + same empty-array-as-filter-not-set convention).
- **ADR-0210 / ADR-0211 multi-value `--actor-id-not` / `--actor-id`** on retention history (same one-shot break + same multi-value canonical envelope shape).

## Decision

### CLI surface

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--kind <event-kind> ...]   # NOW REPEATABLE
                                  [other flags from ADR-0203/0205/0208/0212/0214/0215/0216]
                                  [--with-actor-names]
                                  [--format human|json]
```

- `--kind <event-kind>` is now repeatable via the `multiFlags` infrastructure from ADR-0183.
- Single occurrence: `--kind opt_out_set` asserts both events have that one kind (equivalent to ADR-0198 single-value behavior).
- Multi occurrence: `--kind opt_out_set --kind opt_out_cleared` asserts both events have ANY of the listed kinds (OR-semantic tuple expectation).
- Empty (zero occurrences): treated as expectation-not-set (no check) — backward compat.
- Composes with `--kind-not` (negative expectation from ADR-0214) and all other diff-history flags without restriction.
- Invalid value on ANY occurrence exits 2 with the offending value named (matches ADR-0200/0214 per-occurrence validation pattern).

### Adapter changes

`DiffHistoryEntriesInput` field rename — breaking change for direct adapter consumers (matches the established 6-rename precedent from ADR-0199/0207/0210/0211/0214):

```ts
// Before (ADR-0198):
readonly eventKind?: OptOutHistoryEventKind;

// After (this milestone):
readonly eventKinds?: ReadonlyArray<OptOutHistoryEventKind>;
```

One-shot clean break beats permanent two-field surface. Matches the workspace's established breaking-rename pattern across the actor + kind family — 7 consecutive single→multi renames (ADR-0199/0207/0210/0211/0200/0214/0217) make this milestone mechanical.

Expectation check logic rewrites with Set-based membership lookup:

```ts
if (input.eventKinds !== undefined && input.eventKinds.length > 0) {
  const expectedSet = new Set<string>(input.eventKinds);
  const mismatches: string[] = [];
  if (!expectedSet.has(entryA.event_kind)) {
    mismatches.push(`A is '${entryA.event_kind}'`);
  }
  if (!expectedSet.has(entryB.event_kind)) {
    mismatches.push(`B is '${entryB.event_kind}'`);
  }
  if (mismatches.length > 0) {
    const kindList = input.eventKinds
      .map((k) => `'${k}'`)
      .join(", ");
    throw new Error(
      `diffHistoryEntries: expected both events to have event_kind in [${kindList}] but ${mismatches.join(" and ")}`,
    );
  }
}
```

Key shape decisions:

1. **Set-based lookup** — O(1) membership check via `Set<string>` for the expected kinds. Operators with up to 4 kinds (the full enum) get same performance as single-value lookup.
2. **Always-list error format** — `event_kind in ['X']` for single-value, `event_kind in ['X', 'Y']` for multi-value. Single-value error format breaks from ADR-0198's `event_kind 'X'` shape — acceptable because the field rename `eventKind → eventKinds` is itself a breaking API change; operators relying on error string format need to update at the same time as the field rename. Consistent error format across single + multi reads better than separate single-value-special-case vs multi-value-list-case formats. Matches ADR-0214 `--kind-not` precedent.
3. **Empty array = filter-not-set** — matches ADR-0199/0200/0207/0210/0211/0214 convention. Operators may legitimately compute the list at the call site producing an empty array (allowlist empty); operator-friendly.
4. **Duplicates preserved verbatim** — operators passing `--kind opt_out_set --kind opt_out_set` get a Set with one entry (Set dedupes membership). Substrate doesn't dedup the input array itself (matches ADR-0207/0210/0211/0214 stance) — the Set is constructed at check time so duplicates in the input array become single-entry Set lookups; harmless. Error message preserves the operator's literal input including duplicates.

### CLI changes

`runRetentionDiffHistory` reads via `getMultiFlag("kind")` instead of `getStringFlag("kind")`:

```ts
const kindFlags = getMultiFlag(command, "kind");
const validatedKinds: OptOutHistoryEventKind[] = [];
for (const kindFlag of kindFlags) {
  if (!isOptOutHistoryEventKind(kindFlag)) {
    printError(
      ctx.io,
      `retention diff-history: invalid --kind '${kindFlag}' (...)`,
    );
    return 2;
  }
  validatedKinds.push(kindFlag);
}
const eventKinds: ReadonlyArray<OptOutHistoryEventKind> | undefined =
  validatedKinds.length > 0 ? validatedKinds : undefined;
```

Per-occurrence validation matches ADR-0200 / ADR-0214 — exits 2 on the FIRST invalid value with that value named in the error message.

### JSON envelope rename

```json
{
  "action": "diff-history",
  "kinds": ["opt_out_set", "opt_out_cleared"],   // RENAMED: was kind (string | null)
  "kindA": null,
  "kindB": null,
  "kindsNot": null,
  ...
}
```

Breaking JSON envelope rename — `kind: string | null` → `kinds: string[] | null`. Operators parsing the envelope:
- Single-occurrence: `kinds: ["<kind>"]`.
- Multi-occurrence: `kinds: ["<a>", "<b>", ...]`.
- Not set: `kinds: null`.

Same shape as ADR-0207/0210/0211/0214 array-or-null canonical multi-value envelope.

### Per-side flags stay single-value

The per-side `--kind-a` / `--kind-b` flags from ADR-0215 keep their single-value `eventKindA?: OptOutHistoryEventKind` / `eventKindB?: OptOutHistoryEventKind` shape this milestone. Widening per-side to multi-value tuple expectation ("A must be one of N kinds", "B must be one of M kinds") is documented as a future Q. Operators wanting per-side multi-value use the global `--kind` (which now covers both events with the same tuple expectation).

### Composition with --kind-not (negative)

Both `--kind` and `--kind-not` are now multi-value on diff-history. Operators can express complex assertions:

```bash
# Both must be in {opt_out_set, opt_out_cleared} AND neither in {policy_deleted, retention_set}:
--kind opt_out_set --kind opt_out_cleared --kind-not policy_deleted --kind-not retention_set
```

These two assertions are equivalent for the 4-value enum (since the universe minus the negative is the positive). Operators get expressiveness in both directions.

## Use cases unblocked

**1. Opt-out lifecycle workflow assertion**

```bash
# Assert both events are within the opt-out workflow (not maintenance kinds):
crossengin retention diff-history $id_a $id_b \
  --kind opt_out_set --kind opt_out_cleared
# Exit 0 if both are opt_out_set or opt_out_cleared events.
# Exit 1 with explicit error naming the offending side(s) if either falls outside.
```

**2. State-transition pair verification with --with-actor-names**

```bash
crossengin retention diff-history $event_a $event_b \
  --kind opt_out_set --kind opt_out_cleared --with-actor-names
```

**3. Compliance attestation: any policy state-change kind**

```bash
# Both events must be policy state-changes (not deletions):
crossengin retention diff-history $id_a $id_b \
  --kind opt_out_set --kind opt_out_cleared --kind retention_set
# 3-element tuple expectation; only policy_deleted is excluded.
```

**4. Compose positive + negative for redundant safety**

```bash
# Belt-and-suspenders: both must be opt_out events AND neither is maintenance:
crossengin retention diff-history $id_a $id_b \
  --kind opt_out_set --kind opt_out_cleared \
  --kind-not policy_deleted --kind-not retention_set
# Redundant for the 4-value enum but loud + clear in CI logs.
```

**5. Compose with actor expectations**

```bash
# Both human actors AND both are opt_out events:
crossengin retention diff-history $id_a $id_b \
  --kind opt_out_set --kind opt_out_cleared \
  --no-system --with-actor-names
```

## Drawbacks

1. **Breaking adapter field rename `eventKind → eventKinds`** — direct adapter consumers need to update. Contained scope, no external production consumers. Same one-shot break justification as ADR-0199/0207/0210/0211/0214.
2. **Breaking JSON envelope rename `kind → kinds`** — operator jq scripts parsing the envelope need to update.
3. **Breaking error message format** — `event_kind 'X' but A is 'Y'` → `event_kind in ['X'] but A is 'Y'` (always-list format). Same justification as ADR-0214 — the field rename is itself a breaking change.
4. **Per-side `--kind-a` / `--kind-b` stay single-value** — within-side asymmetry remains: global is multi-value tuple but per-side is single-value scalar. Documented as future Q. Operators wanting per-side multi-value use global.
5. **Cross-references in other test blocks needed updating** — tests in `--actor-id`, `--with-actor-names`, `--kind-not`, `--actor-id-not`, `--actor-id-not`, `--system-only`, `--per-side`, and `--per-side.system-only` describe blocks that composed with global `--kind` all needed `eventKind: "X"` → `eventKinds: ["X"]` updates. Mechanical but extensive.
6. **No CLI-side dedup** — operators passing `--kind X --kind X` get duplicate placeholders. Set-based lookup at adapter dedupes membership but input array preserves duplicates.
7. **First-invalid-fail-fast on validation** — operators with multiple `--kind` flags and one typo see only the first invalid value.

## Alternatives considered

1. **Two-field adapter surface (`eventKind` + `eventKinds`)** — permanent two-field surface invites operator confusion. One-shot rename cleaner, matches the established 7-rename precedent.
2. **`--kind <a>|<b>|<c>` pipe-separated single flag** — fragile shell-quoting; repeated flag is established.
3. **`--kind <a>,<b>,<c>` comma-separated single flag** — fragile if enum values ever contain commas (currently don't); operators with shell `$VAR` substitution hit edge cases.
4. **Keep single-value `--kind`, document jq-workaround for multi-value** — fails the exit-code-semantic argument (jq-side post-filter loses CI gate exit 1 semantic). Rejected.
5. **Widen per-side `--kind-a` / `--kind-b` to multi-value in the same milestone** — would close ADR-0215's deferred per-side multi-value future Q in addition to ADR-0198 Q2, but exceeds the user's requested scope ("multi-value --kind global on retention diff-history"). Documented as future Q.
6. **Keep single-value error message format for single-element arrays** — `event_kind 'X'` for length 1, `event_kind in ['X', 'Y']` for length 2+. Inconsistent rendering. Always-list is more predictable.
7. **PG-side WHERE filter (IN)** — diff-history takes exactly 2 fixed IDs, not a list query. WHERE filter would silently return zero rows on mismatch indistinguishable from "IDs don't exist." Adapter throw with clear message is the correct semantic.
8. **Substrate-side dedup of duplicate values** — PG/Set duplicates harmless via Set; CLI doesn't need to filter operator input. Matches ADR-0207/0210/0211/0214.
9. **Auto-validate at adapter (not CLI)** — adapter receives `OptOutHistoryEventKind[]` which TypeScript narrows; trusting the type. CLI handles validation at the boundary before construction.
10. **Implement as separate `--kind-any` flag while preserving single-value `--kind`** — adds CLI surface with two near-identical flag names. Rename + multi-value cleaner.

## Open questions

1. **Widen per-side `--kind-a` / `--kind-b` to multi-value tuple expectation** — closes ADR-0215's deferred per-side multi-value future Q + restores within-side symmetry. Natural follow-up milestone. Defer.
2. **`--kind @file.txt` for very large exclusion lists** — operators with the 4-value enum don't need this (max 4 values total). Defer indefinitely unless enum expands.
3. **Widen `--actor-id` / `--actor-id-not` global on diff-history to multi-value** — closes ADR-0203 Q2 + ADR-0205 Q1 (same multi-value tuple expectation pattern applied to actor dimension). Pairs naturally with this milestone. Defer to follow-up.
4. **CLI-side dedup of duplicate values** — defer; Set handles fine.
5. **Semantic-shape expectation grouping** (`--policy-state-changes` shorthand for `--kind opt_out_set --kind opt_out_cleared --kind retention_set`) — operator-policy concern; substrate stays generic. Defer.
6. **Apply same multi-value pattern to retention history `--kind` filter** — pairs with ADR-0211 Q8. Defer.

## Implementation outline

Three additive code changes:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - `DiffHistoryEntriesInput.eventKind?: OptOutHistoryEventKind` → `eventKinds?: ReadonlyArray<OptOutHistoryEventKind>` (breaking rename).
   - Adapter check logic rewritten with Set-based membership lookup + always-list error format + empty-array-as-filter-not-set + error message naming offending side(s).

2. **`apps/architect-cli/src/retention.ts`**:
   - `runRetentionDiffHistory` reads via `getMultiFlag(command, "kind")` instead of `getStringFlag`.
   - Per-occurrence validation via `isOptOutHistoryEventKind` loop; exits 2 on FIRST invalid value.
   - Threads `eventKinds: ReadonlyArray<OptOutHistoryEventKind> | undefined` to adapter.
   - JSON envelope renamed `kind: string | null` → `kinds: string[] | null`.

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention diff-history` usage line updated from `[--kind <event-kind>]` to `[--kind <event-kind> ...]` indicating repeatable.
   - Description block updated explaining "repeatable" + "both events have any of the listed event_kinds" + "OR-semantic tuple expectation" semantic.

## Tests

Adapter test block rewritten + expanded from 5 → 9 tests under renamed "diffHistoryEntries --kind expectation check (M6.7.zz.tenant.opt-out.cli.diff-history.kind-filter + .multi)" describe block:

1. Single-value: accepts when both events have the expected event_kind.
2. Single-value: throws when event A's kind doesn't match with new `event_kind in ['X']` format.
3. Single-value: throws when event B's kind doesn't match.
4. Single-value: throws naming both sides when neither matches expected.
5. Multi-value: accepts when both events have ANY of the expected event_kinds (OR-semantic) (NEW).
6. Multi-value: throws when A is not in tuple with multi-value error format (NEW).
7. Multi-value: throws naming both when neither is in tuple (NEW).
8. Omits the check when eventKinds not set (backward compat).
9. Treats empty eventKinds array as filter-not-set (NEW).

Plus updates to 5 cross-reference tests in other describe blocks (`eventKind: "X"` → `eventKinds: ["X"]`):
- `--actor-id` expectation check block (composes-with-kind test).
- `--actor-id-not` exclusion check block (composes test).
- `--actor-id-not` exclusion check block (contradictory test, also updates error string).
- `--system-only` actorPresence block (composes test).
- `--per-side` block (global + per-side composition test, also updates error string).

CLI test block rewritten + expanded from 6 → 10 tests under renamed "runRetention diff-history --kind (M6.7.zz.tenant.opt-out.cli.diff-history.kind-filter + .multi)" describe block:

1. Returns exit 2 when --kind is invalid value.
2. Returns exit 2 on FIRST invalid --kind occurrence when multiple flags supplied (NEW).
3. Threads eventKinds as single-element array when --kind set once.
4. Threads multi-element eventKinds when --kind repeated (NEW).
5. Omits eventKinds when --kind NOT set (backward compat).
6. Adapter mismatch error propagates as exit 1 with new always-list format.
7. Multi-value adapter error propagates with multi-value list format (NEW).
8. JSON envelope echoes kinds single-element array when --kind set once.
9. JSON envelope echoes multi-element kinds when --kind repeated (NEW).
10. JSON envelope kinds=null when --kind NOT set.

Plus updates to 3 cross-reference tests in other CLI describe blocks (`eventKind: "X"` → `eventKinds: ["X"]`):
- `--actor-id` block (composes-with-kind test).
- `--with-actor-names` block (composes-with-kind test).
- `--kind-not` block (composes-with-kind test).
- `--per-side` block (global + per-side --kind-a composition test).

cli.ts helpText extended for retention diff-history usage line — `[--kind <event-kind> ...]` notation + description updated to "repeatable" + "both events have any of the listed event_kinds" + OR-semantic tuple expectation semantic.

Test count: 9,068 → 9,076 (+8 net: adapter +4, CLI +4). The block rewrites kept existing single-value coverage while adding multi-value coverage.

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green (no new errors from this milestone; pre-existing `labelForIndex` + `chat.ts` errors unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

The retention diff-history surface now has symmetric multi-value support on the kind dimension:

| Flag | Shape | ADR |
|---|---|---|
| `--kind` (positive expectation) | string array | ADR-0217 (this milestone) |
| `--kind-not` (negative expectation) | string array | ADR-0214 |

The within-action asymmetry that ADR-0214 explicitly created is now resolved on the kind dimension. Per-side `--kind-a` / `--kind-b` from ADR-0215 stay single-value (deferred future Q).

The actor dimension on diff-history (global) still has single-value `--actor-id` / `--actor-id-not` (ADR-0203/0205). Closing ADR-0203 Q2 + ADR-0205 Q1 by widening those to multi-value tuple expectation would restore within-action symmetry on the actor dimension. Natural follow-up milestone.

The retention CLI's multi-value flag coverage continues to expand:

| Surface × Flag | Status |
|---|---|
| retention history `--actor-id` | multi (ADR-0211) |
| retention history `--actor-id-not` | multi (ADR-0210) |
| retention history `--kind` | single (ADR-0170; ADR-0211 Q8 deferred) |
| retention diff-history `--actor-id` | single expectation (ADR-0203; Q2 multi-value deferred) |
| retention diff-history `--actor-id-not` | single expectation (ADR-0205; Q1 multi-value deferred) |
| retention diff-history `--kind` | multi expectation (ADR-0217 — this milestone) |
| retention diff-history `--kind-not` | multi expectation (ADR-0214) |
| retention diff-history `--kind-a` / `--kind-b` | single per-side (ADR-0215; multi-value per-side deferred) |
| retention diff-timeline `--actor-id` | multi filter (ADR-0199) |
| retention diff-timeline `--actor-id-not` | multi filter (ADR-0207) |
| retention diff-timeline `--kind` | multi filter (ADR-0194/0200) |

The retention CLI now has 18 actions with comprehensive multi-flag coverage. The kind dimension on diff-history is now multi-value on both positive AND negative directions, matching the multi-value coverage on diff-timeline and retention history surfaces.
