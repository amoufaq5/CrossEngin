# ADR-0208: `crossengin retention diff-history --kind-not` event-kind exclusion expectation check (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.kind-not)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0198 (--kind expectation check), ADR-0205 (--actor-id-not exclusion check), ADR-0203 (--actor-id expectation check), ADR-0204 (--with-actor-names), ADR-0170 (history audit log) |

## Context

ADR-0198 shipped `--kind <event-kind>` on `retention diff-history` as a positive expectation check — operator declares "I expect both these events to have event_kind X" and the adapter throws when reality differs. ADR-0205 then shipped `--actor-id-not <uuid>` as the mirror-image inverse on the actor dimension. ADR-0205 Q4 explicitly listed `--kind-not` as a deferred future Q to complete the matrix:

| Dimension | Positive (both must be X) | Negative (neither may be X) |
|---|---|---|
| event_kind | `--kind` (ADR-0198) | `--kind-not` (this milestone) |
| actor_id | `--actor-id` (ADR-0203) | `--actor-id-not` (ADR-0205) |

The operational use case is symmetric with `--actor-id-not`:

1. **Anti-deletion verification** — operator asserts "verify NEITHER of these two history events is a `policy_deleted` event before treating them as ordinary state transitions." Catches accidental delete-paired-with-mutation diffs that operators want to surface as different workflow.
2. **Compliance gate excluding system-driven kinds** — for human-policy audits ("verify neither event was a `retention_set` automation; both should be `opt_out_*` human-policy events").
3. **CI gate on tier migration** — "this diff is for opt-out lifecycle audit; assert neither event is `retention_set` (migration noise) or `policy_deleted` (different workflow)."
4. **Forensic disambiguation** — incident responder asserts "this comparison is about opt-out toggles; verify neither side is a `policy_deleted` event before drawing conclusions about toggle state."

`--kind` is "both MUST be X." `--kind-not` is "neither MAY be X." Mirror-image expectation checks; both compose with each other (operator can say "both must be `opt_out_set` AND neither is `policy_deleted`" — redundant but not contradictory) and with `--actor-id` (ADR-0203) + `--actor-id-not` (ADR-0205) + `--with-actor-names` (ADR-0204).

M6.7.zz.tenant.opt-out.cli.diff-history.kind-not closes ADR-0205 Q4 + ADR-0198 Q5 in spirit by adding the inverse exclusion semantic on the event-kind dimension.

## Decision

### CLI surface

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--kind <event-kind>]
                                  [--kind-not <event-kind>]   # NEW
                                  [--actor-id <uuid>]
                                  [--actor-id-not <uuid>]
                                  [--with-actor-names]
                                  [--format human|json]
```

- `--kind-not <event-kind>` added as a single optional flag.
- Validated at CLI boundary against the 4-value `OPT_OUT_HISTORY_EVENT_KINDS` tuple from ADR-0170 (`opt_out_set | opt_out_cleared | retention_set | policy_deleted`). Invalid value exits 2 with the full valid-values list in the error message — exact same validation pattern as `--kind` from ADR-0198.
- Composes with all existing flags. NOT mutually exclusive with `--kind` at the CLI boundary — substrate adapter surfaces contradictions via thrown errors (operator passing `--kind X --kind-not X` gets a clear adapter error since the kind check fires first and throws).
- No new CLI infrastructure — single new `getStringFlag(command, "kind-not")` call + `isOptOutHistoryEventKind` check, parallels `--kind` parsing 4 lines below it in `runRetentionDiffHistory`.

### Adapter changes

`DiffHistoryEntriesInput` gains optional `eventKindNot?: OptOutHistoryEventKind` field. After the existing eventKind expectation check, an eventKindNot exclusion validation:

```ts
if (input.eventKindNot !== undefined) {
  const matches: string[] = [];
  if (entryA.event_kind === input.eventKindNot) matches.push("A");
  if (entryB.event_kind === input.eventKindNot) matches.push("B");
  if (matches.length > 0) {
    const suffix =
      matches.length === 1
        ? `${matches[0]} matches`
        : "both A and B match";
    throw new Error(
      `diffHistoryEntries: expected neither event to have event_kind '${input.eventKindNot}' but ${suffix}`,
    );
  }
}
```

Error message names the offending side(s) compactly — single match: `"but A matches"`, both match: `"but both A and B match"`. Identical compact-error-message shape as ADR-0205 `--actor-id-not` for consistency across the family.

### Why "matches" not "is '<actual>'"

The eventKind check (ADR-0198) renders mismatches as `A is '<actual-kind>'` because operators need to see the unexpected value. For exclusion, the offending value is the one in `--kind-not` (operator already knows it); naming the side ("A matches" / "both A and B match") is sufficient and shorter. Different rendering reflects different information need — same rationale as ADR-0205 `--actor-id-not` vs ADR-0203 `--actor-id`.

### Check ordering

The four expectation checks on `diffHistoryEntries` now run in this order after the cross-tenant / cross-table / known-event_kind validations:

1. `eventKind` (positive expectation — ADR-0198)
2. `eventKindNot` (negative expectation — this milestone)
3. `actorId` (positive expectation — ADR-0203)
4. `actorIdNot` (negative expectation — ADR-0205)

Positioned `eventKindNot` immediately after `eventKind` so kind-dimension checks group together; actor-dimension checks follow. Contradictory inputs (`--kind X --kind-not X`) surface the eventKind error first since order matters; operator sees a clear message from whichever check fires.

### Composition with --kind (positive expectation)

Both can be set; both fire independently. Examples:

- `--kind opt_out_set --kind-not policy_deleted`: "both must be opt_out_set AND neither is policy_deleted" — passes when both are opt_out_set (since opt_out_set ≠ policy_deleted, neither is policy_deleted).
- `--kind opt_out_set --kind-not opt_out_set`: contradictory — eventKind check fires first throwing "expected both events to have event_kind 'opt_out_set' but A is '...'" if either event isn't opt_out_set; if both ARE opt_out_set, eventKindNot fires throwing "expected neither event to have event_kind 'opt_out_set' but both A and B match." Operator sees a clear error from whichever check fires.

CLI doesn't enforce mutual exclusivity — substrate stays minimal, operators can compose freely, contradictory inputs produce clear adapter errors. Matches ADR-0205 stance.

### Error path: exit 1 (runtime) not exit 2 (misuse)

Matches ADR-0198 + ADR-0203 + ADR-0205 pattern exactly. Adapter exclusion violation throws; CLI catches and returns exit 1 (runtime path). Exit 2 reserved for CLI-side input validation (invalid `--kind-not` value not in 4-value tuple).

### JSON envelope

Gains `kindNot: OptOutHistoryEventKind | null` field echoing the operator's expectation (or null when not set):

```json
{
  "action": "diff-history",
  "kind": null,
  "kindNot": "policy_deleted",
  "actorId": null,
  "actorIdNot": null,
  "withActorNames": false,
  "result": { ... }
}
```

When both `--kind` and `--kind-not` are set, both fields populate. When neither set, both render as `null`. Matches established envelope-echo pattern from ADR-0198/0203/0204/0205.

### No human-format change

The existing `formatHistoryDiff` renders metadata + field diffs; the exclusion check fires at the adapter layer before the formatter is reached on violation, and is silent on pass (operators see normal diff output). No formatter changes needed.

## Use cases unblocked

**1. Anti-deletion verification**

```bash
# Verify these two history events are NOT policy_deleted events:
crossengin retention diff-history <id-a> <id-b> --kind-not policy_deleted
# Exit 0 if neither is policy_deleted + diff rendered. Exit 1 if either is policy_deleted.
```

**2. Human-policy audit excluding automation kinds**

```bash
# Verify neither event was a retention_set automation (e.g., from migration script):
crossengin retention diff-history <id-a> <id-b> --kind-not retention_set --with-actor-names
```

**3. CI gate on opt-out lifecycle**

```bash
# Forensic gate: this diff is about opt-out lifecycle, not policy deletions:
crossengin retention diff-history <baseline> <current> \
  --kind-not policy_deleted --kind-not retention_set 2>&1 | head -1
# (Operators chain multiple commands when needing multi-kind exclusion;
# --kind-not is single-value matching ADR-0205 --actor-id-not single-value.)
```

**4. Composed positive + negative expectation**

```bash
# Both must be opt_out_set AND neither must be policy_deleted (redundant but safe):
crossengin retention diff-history <id-a> <id-b> \
  --kind opt_out_set --kind-not policy_deleted
# Both checks fire independently; clear error if either fails.
```

**5. Compose across kind + actor dimensions**

```bash
# Both must be opt_out_set + neither may be authored by test SA:
crossengin retention diff-history <id-a> <id-b> \
  --kind opt_out_set --actor-id-not <test-sa-uuid>
# Two-dimension expectation gate in one command.
```

## Drawbacks

1. **Single-value exclusion only** — operators wanting "neither event may be one of `<a, b, c>`" run multiple commands or compose with jq. Multi-value exclusion deferred (substrate single-value matches ADR-0205 single-value pattern; the 4-value event_kind tuple makes multi-exclusion less compelling than multi-actor exclusion since operators can just use `--kind <complement>` for half the cases). Documented future Q.
2. **Composition with `--kind` can be contradictory** — `--kind X --kind-not X` is logically impossible; adapter throws but order of error message depends on which check fires first (eventKind fires first). Acceptable — clear error in either ordering; operators won't set contradictory flags accidentally.
3. **CLI-side validation requires exact match** — operators with typos like `--kind-not opt-out-set` vs `opt_out_set` get exit 2 (documented in error message lists all 4 valid values, same as `--kind`).
4. **Asymmetric error rendering vs `--kind`** — positive expectation says "A is '<actual>'" (showing operator the value they didn't expect); exclusion says "A matches" (operator already knows the excluded value). Different rendering reflects different information needs; documented; matches ADR-0205 asymmetric rendering pattern.
5. **No per-side `--kind-not-a` + `--kind-not-b`** — asymmetric exclusion ("A must not be opt_out_set; B must not be policy_deleted") not supported. Operators chain commands. Defer; pairs with similar ADR-0203 Q1 + ADR-0205 Q2.
6. **No semantic-shape exclusion** — operators wanting "neither event may be a write-mutation event" (would group `opt_out_set` + `retention_set` semantically) can't express that without enumerating each kind. Operators jq-filter or chain commands. Defer; semantically different from event_kind which is mutation-method name not resulting-state shape.
7. **One more flag to remember on diff-history** — the action now has 5 optional flags (--kind, --kind-not, --actor-id, --actor-id-not, --with-actor-names) — operators reading helpText need to understand the kind/actor × positive/negative matrix. Helpful structure: documented via 4 separate description paragraphs in helpText.

## Alternatives considered

1. **`--kind-not` as a filter (skip events with that kind)** — doesn't fit diff-history which takes 2 fixed IDs; exclusion expectation matches the semantic, mirroring ADR-0198's "filter shifts to expectation check" reasoning.
2. **Make exclusion match a warning not throw** — silent gates lose safety property. Rejected (matches ADR-0198/0203/0205 stance — substrate throws loudly on expectation violation; CLI surfaces exit 1).
3. **Two flags `--kind-not-a` + `--kind-not-b` for per-side exclusion** — overkill for v1; both-not-X is the common case. Defer.
4. **CLI-enforced mutual exclusivity with `--kind`** — operators wanting "both must be opt_out_set AND neither is policy_deleted" (perfectly valid) would be blocked. Adapter-level error surfaces contradictions naturally. Rejected mutual exclusivity.
5. **Render mismatch as fieldDiff** — event_kind isn't a "field" in next_state JSONB (it's the row-level kind discriminator); throwing is loud and clear. Rejected (matches ADR-0198 stance).
6. **PG WHERE clause filter** — would silently return zero rows on exclusion match indistinguishable from "IDs don't exist"; throw-with-clear-message is the right behavior. Rejected.
7. **Use `IN`/`NOT IN` SQL for multi-value exclusion** — overkill for v1; substrate single-value matches ADR-0205 single-value pattern. Defer multi-value.
8. **Inverse flag named `--exclude-kind`** — verbose; `--kind-not` matches naming convention from `--actor-id-not` (ADR-0205) + future Qs across the family.

## Open questions

1. **`--kind-not <a>|<b>|<c>` multi-value exclusion** ("neither event must be one of these N kinds"). Defer; multi-value shape different from --kind multi-value (ADR-0200 ships --kind multi-value via repeated flag on diff-timeline; diff-history could mirror once a measured demand emerges for excluding multiple kinds).
2. **`--kind-not-a` + `--kind-not-b` per-side exclusion** for asymmetric exclusion checks. Defer; same as ADR-0203 Q1 + ADR-0205 Q2.
3. **`--kind-not` filter on retention history** (substrate-side WHERE NOT event_kind = $N filter; different semantic from expectation check). Defer; pairs with ADR-0206 Q4 (which explicitly listed `--kind-not` companion as a future Q).
4. **`--kind-not` filter on diff-timeline** (substrate-side WHERE NOT event_kind IN (...) filter across all three dispatch paths; multi-value matching ADR-0207 pattern). Defer; pairs with ADR-0207 Q4 (which explicitly listed `--kind-not` companion as a future Q).
5. **Semantic-shape exclusion** — `--exclude-write-mutations` flag grouping `opt_out_set` + `retention_set` + `policy_deleted`. Operator-policy concern; substrate stays minimal with individual kinds. Defer.
6. **`--kind-not` on diff-history allowing N values via comma-separated** (`--kind-not policy_deleted,retention_set`) instead of repeated flag — pipe-separated single flag form. Defer; multiFlags pattern from ADR-0183 would be the canonical multi-value approach if demand emerges.

## Implementation outline

Three additive code changes:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - `DiffHistoryEntriesInput` gains optional `eventKindNot?: OptOutHistoryEventKind` field.
   - New `if (input.eventKindNot !== undefined)` block in `diffHistoryEntries` immediately after the existing `eventKind` check, before the `actorId` check.

2. **`apps/architect-cli/src/retention.ts`**:
   - `runRetentionDiffHistory` reads `kindNotFlag` via `getStringFlag(command, "kind-not")` immediately after the existing `kind` flag parsing.
   - Validates via `isOptOutHistoryEventKind` (exit 2 with valid-values list on invalid — same shape as `--kind` validation).
   - Threads `eventKindNot` to `retention.diffHistoryEntries(...)` adapter call.
   - JSON envelope gains `kindNot: eventKindNot ?? null` field.

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention diff-history` usage line gains `[--kind-not <event-kind>]`.
   - 2-line description explaining anti-kind verification semantic.

## Tests

7 new adapter tests in a new "PostgresTraceRetention.diffHistoryEntries --kind-not exclusion check" describe block:

1. Accepts when neither event has the excluded event_kind.
2. Throws when event A matches the excluded kind (error names side A).
3. Throws when event B matches the excluded kind (error names side B).
4. Throws naming both when both events match the excluded kind ("both A and B match").
5. Omits the check when eventKindNot not set (backward compat).
6. Composes with `--kind` expectation check (both pass when distinct).
7. Contradictory `--kind` + `--kind-not` surfaces kind check first.
8. Composes with `--actor-id-not` (both checks fire independently — null actors + UUID exclusion + kind exclusion).

7 new CLI tests in a new "runRetention diff-history --kind-not" describe block:

1. Returns exit 2 when `--kind-not` is invalid value (e.g., `not_a_kind`) with explicit valid-values list.
2. Threads `eventKindNot` to adapter when `--kind-not` set.
3. Omits `eventKindNot` when `--kind-not` NOT set (backward compat).
4. Composes with `--kind` (both threaded independently).
5. Adapter exclusion error propagates as exit 1 with explicit error.
6. JSON envelope echoes `kindNot` field when `--kind-not` set.
7. JSON envelope `kindNot=null` when `--kind-not` NOT set.

cli.ts helpText extended for retention diff-history usage line with `[--kind-not <event-kind>]` flag note + 2-line description explaining anti-kind verification semantic + mirror-of-`--kind` framing.

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green across the workspace.
- `pnpm -r test` green across the workspace.

## Forward-looking

The retention diff-history surface now has FOUR expectation-check flags across two dimensions:

| Dimension | Positive | Negative |
|---|---|---|
| event_kind | `--kind` (ADR-0198) | `--kind-not` (ADR-0208) |
| actor_id | `--actor-id` (ADR-0203) | `--actor-id-not` (ADR-0205) |

Plus `--with-actor-names` (ADR-0204) for actor display name surfacing. Operators get full positive + negative expectation gates across both row-level dimensions of every history event, with consistent error-message shape (`expected both events to have <field> 'X' but A is 'Y'` for positive checks, `expected neither event to have <field> 'X' but A matches` for negative checks) and uniform exit-code semantics (CLI misuse exit 2 on invalid kind value, runtime exit 1 on adapter-level expectation violation).

The `--kind-not` family is now half-shipped on the retention CLI:

- `retention diff-history --kind-not` — expectation check (this milestone).
- `retention history --kind-not` — substrate-side WHERE NOT filter (ADR-0206 Q4 deferred).
- `retention diff-timeline --kind-not` — substrate-side WHERE NOT IN filter across all 3 paths matching multi-value pattern from ADR-0207 (ADR-0207 Q4 deferred).

Subsequent milestones can close the two filter-side ADRs mechanically following the established `--actor-id-not` precedent from ADR-0205 (expectation check) + ADR-0206 (history filter) + ADR-0207 (diff-timeline multi-value filter).

The retention CLI now has 18 actions with `--kind-not` support on the diff-history surface — operators get full positive + negative expectation gates with named-actor audit readability uniformly on the cross-event policy diff surface.
