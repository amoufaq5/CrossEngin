# ADR-0215: `crossengin retention diff-history` per-side asymmetric expectation checks (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.per-side)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0198 (--kind global expectation), ADR-0203 (--actor-id global expectation), ADR-0205 (--actor-id-not global exclusion), ADR-0208 (--kind-not global exclusion), ADR-0214 (--kind-not multi-value), ADR-0212 (--system-only/--no-system global expectation) |

## Context

The retention diff-history surface has accumulated 5 expectation-check flag families that ALL apply to BOTH events symmetrically:

| Flag | Semantic | ADR |
|---|---|---|
| `--kind <event-kind>` | both events have this kind | ADR-0198 |
| `--kind-not <event-kind> ...` | neither event has any of these kinds (multi) | ADR-0214 |
| `--actor-id <uuid>` | both events have this actor | ADR-0203 |
| `--actor-id-not <uuid>` | neither event has this actor | ADR-0205 |
| `--system-only` / `--no-system` | both are system / neither is | ADR-0212 |

But operators have real use cases for ASYMMETRIC expectations — assertions where the two events have different expected properties:

1. **Forensic state-transition verification** — operator pulls a `policy_deleted` event and a `retention_set` event and wants to assert "A is the deletion event, B is the rebuild event" (`--kind-a policy_deleted --kind-b retention_set`) to verify the order is correct.
2. **Per-side actor attribution** — operator compares Alice's earlier mutation against Bob's later mutation and wants to assert "A is Alice's, B is Bob's" (`--actor-id-a alice --actor-id-b bob`) for compliance proof.
3. **Per-side exclusion** — operator asserts "A is not authored by the migration SA, B is not authored by the CI SA" (`--actor-id-not-a $migration_sa --actor-id-not-b $ci_sa`) — different excluded actors per side.
4. **Hybrid global + per-side** — operator wants "both must be opt_out events (global --kind) AND A must NOT be a policy_deleted variant (per-side --kind-not-a policy_deleted)" — redundant safety but loud.

Future Q1 from these ADRs explicitly listed per-side variants as deferred future work:
- ADR-0198 Q1: `--kind-a` + `--kind-b` per-side
- ADR-0203 Q1: `--actor-id-a` + `--actor-id-b` per-side
- ADR-0205 Q2: `--actor-id-not-a` + `--actor-id-not-b` per-side
- ADR-0208 Q2: `--kind-not-a` + `--kind-not-b` per-side
- ADR-0212 Q2: `--system-only-a` / `--system-only-b` / `--no-system-a` / `--no-system-b` per-side

This milestone closes 4 of those 5 future Qs by shipping per-side variants for the 4 cleanest pairs (kind, kind-not, actor-id, actor-id-not). The `--system-only` / `--no-system` per-side family is deferred because the boolean-pair × per-side combination (4 flags with cross-axis mutual exclusivity rules) deserves its own design milestone — `--system-only-a` and `--no-system-a` are mutually exclusive on side A, same for side B, but A's and B's flags don't interact, creating a 2×2 design space that needs careful CLI ergonomics.

## Decision

### CLI surface

8 new flags added to retention diff-history, organized in 4 pairs mirroring the 4 existing global flags:

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--kind <event-kind>]
                                  [--kind-a <event-kind>] [--kind-b <event-kind>]   # NEW
                                  [--kind-not <event-kind> ...]
                                  [--kind-not-a <event-kind> ...]                    # NEW
                                  [--kind-not-b <event-kind> ...]                    # NEW
                                  [--actor-id <uuid>]
                                  [--actor-id-a <uuid>] [--actor-id-b <uuid>]        # NEW
                                  [--actor-id-not <uuid>]
                                  [--actor-id-not-a <uuid>]                          # NEW
                                  [--actor-id-not-b <uuid>]                          # NEW
                                  [--system-only | --no-system]
                                  [--with-actor-names]
```

Per-side flags use the `-a` / `-b` suffix matching the result type's `actorIdA` / `actorIdB` / `eventKindA` / `eventKindB` field naming convention. Operators reading `--kind-a` vs `--kind-b` immediately understand which side the assertion targets.

Validation rules mirror the global counterparts:
- `--kind-a` / `--kind-b`: single-value flag validated against the 4-value `OPT_OUT_HISTORY_EVENT_KINDS` tuple from ADR-0170. Invalid value exits 2 with the offending value named.
- `--kind-not-a` / `--kind-not-b`: repeatable multi-value following ADR-0214 multi-value pattern; per-occurrence validation; exits 2 on FIRST invalid value with that value named.
- `--actor-id-a` / `--actor-id-b`: single-value string flag, no CLI-side UUID validation (matches ADR-0175 deferred decision).
- `--actor-id-not-a` / `--actor-id-not-b`: single-value string flag (matches ADR-0205 single-value negative).

All 8 flags compose freely with the existing 5 global flags + each other. No CLI-side mutual-exclusivity check between global and per-side variants — operators may legitimately combine them.

### Adapter changes

`DiffHistoryEntriesInput` gains 8 new optional fields preserving the existing 5 global fields:

```ts
export interface DiffHistoryEntriesInput {
  readonly idA: string;
  readonly idB: string;
  // existing global fields (unchanged):
  readonly eventKind?: OptOutHistoryEventKind;
  readonly eventKindsNot?: ReadonlyArray<OptOutHistoryEventKind>;
  readonly actorId?: string;
  readonly actorIdNot?: string;
  readonly actorPresence?: ActorPresenceFilter;
  readonly joinActor?: boolean;
  // NEW per-side fields:
  readonly eventKindA?: OptOutHistoryEventKind;
  readonly eventKindB?: OptOutHistoryEventKind;
  readonly eventKindsNotA?: ReadonlyArray<OptOutHistoryEventKind>;
  readonly eventKindsNotB?: ReadonlyArray<OptOutHistoryEventKind>;
  readonly actorIdA?: string;
  readonly actorIdB?: string;
  readonly actorIdNotA?: string;
  readonly actorIdNotB?: string;
}
```

Note: this is ADDITIVE — no breaking rename. The 8 new fields are purely additional optional inputs. Existing global fields continue to work unchanged. Operators choose between global symmetric expectations and per-side asymmetric expectations independently.

### Check ordering

The adapter's expectation-check sequence now runs in this order (each per-side check after its global counterpart):

1. Existing same-tenant + same-table validations.
2. `eventKind` (global positive — ADR-0198)
3. `eventKindA` (per-side positive — NEW)
4. `eventKindB` (per-side positive — NEW)
5. `eventKindsNot` (global negative — ADR-0214)
6. `eventKindsNotA` (per-side negative — NEW)
7. `eventKindsNotB` (per-side negative — NEW)
8. `actorId` (global positive — ADR-0203)
9. `actorIdA` (per-side positive — NEW)
10. `actorIdB` (per-side positive — NEW)
11. `actorIdNot` (global negative — ADR-0205)
12. `actorIdNotA` (per-side negative — NEW)
13. `actorIdNotB` (per-side negative — NEW)
14. `actorPresence` (global system/no-system — ADR-0212)
15. Result construction.

Ordering rationale:
- **Kind dimension before actor dimension** — operators reading errors get kind mismatches first (more common semantic).
- **Global before per-side** — when operators combine global + per-side, the global check surfaces first (matches ADR-0205 contradictory-actor-id pattern).
- **Positive before negative within each pair** — symmetric with existing ADR-0203/0205 ordering.
- **Per-side A before per-side B** — consistent left-to-right reading.

### Per-side error message format

Each per-side check throws with explicit "event A" / "event B" prefix to distinguish from global "both events":

| Flag | Error format |
|---|---|
| `--kind-a <X>` mismatch | `expected event A to have event_kind 'X' but A is 'Y'` |
| `--kind-b <X>` mismatch | `expected event B to have event_kind 'X' but B is 'Y'` |
| `--kind-not-a [X, Y]` match | `expected event A to have event_kind NOT in ['X', 'Y'] but A is 'X'` |
| `--kind-not-b [X, Y]` match | `expected event B to have event_kind NOT in ['X', 'Y'] but B is 'X'` |
| `--actor-id-a <X>` mismatch | `expected event A to have actor_id 'X' but A is 'Y'` (or `<system>`) |
| `--actor-id-b <X>` mismatch | `expected event B to have actor_id 'X' but B is 'Y'` (or `<system>`) |
| `--actor-id-not-a <X>` match | `expected event A to have actor_id NOT 'X' but A matches` |
| `--actor-id-not-b <X>` match | `expected event B to have actor_id NOT 'X' but B matches` |

Asymmetric rendering preserved across positive/negative + per-side:
- Positive expectation (`--kind-a` / `--actor-id-a`): shows the ACTUAL value the operator didn't expect (`A is 'Y'` or `A is <system>`).
- Negative expectation (`--kind-not-a` / `--actor-id-not-a`): names the side without showing the value (`A matches` / `A is 'Y'`); operator already knows the excluded value.

`<system>` placeholder for null actor_id matches ADR-0185 / ADR-0203 / ADR-0205 / ADR-0212 convention.

### JSON envelope

Gains 8 new fields matching the CLI flag names verbatim:

```json
{
  "action": "diff-history",
  "kind": null,
  "kindA": "opt_out_set",
  "kindB": "policy_deleted",
  "kindsNot": null,
  "kindsNotA": ["retention_set"],
  "kindsNotB": null,
  "actorId": null,
  "actorIdA": "<alice-uuid>",
  "actorIdB": null,
  "actorIdNot": null,
  "actorIdNotA": null,
  "actorIdNotB": "<bob-uuid>",
  "systemOnly": false,
  "noSystem": false,
  "withActorNames": false,
  "result": { ... }
}
```

- `kindA` / `kindB`: string-or-null.
- `kindsNotA` / `kindsNotB`: string-array-or-null (matches ADR-0214 multi-value envelope convention).
- `actorIdA` / `actorIdB` / `actorIdNotA` / `actorIdNotB`: string-or-null.

Operators jq-parse the envelope and read per-side expectations alongside global ones. Note: `result.actorIdA` (the actual diff output value) vs envelope-level `actorIdA` (the operator's CLI flag) are at different JSON nesting levels — operators distinguish via path.

### Composition with global flags

Per-side flags compose freely with global flags. When BOTH a global and the corresponding per-side flag are set, BOTH checks fire (global first). Examples:

1. **`--kind opt_out_set --kind-a opt_out_set`** — global asserts both must be opt_out_set; per-side A asserts A must be opt_out_set; redundant but harmless. Passes when both events are opt_out_set.
2. **`--kind opt_out_set --kind-a retention_set`** — global asserts both are opt_out_set; per-side A asserts A is retention_set. Contradictory at the data layer. Global check fires first; if A is opt_out_set the global passes and per-side fails; if A is retention_set the global fails first with "expected both events to have event_kind 'opt_out_set'".
3. **`--actor-id alice --actor-id-a bob`** — operator wants both alice but A specifically bob. Same logic as case 2; global fires first.
4. **`--kind-not policy_deleted --kind-not-a policy_deleted`** — global asserts neither is policy_deleted; per-side A asserts A is NOT policy_deleted. Redundant.
5. **`--kind-a opt_out_set --kind-b opt_out_cleared`** — canonical asymmetric pattern: A is opt_out_set AND B is opt_out_cleared. Both per-side checks fire independently.

### Why ADDITIVE not breaking rename

This milestone differs from ADR-0199 / ADR-0207 / ADR-0210 / ADR-0211 / ADR-0214 (which all did breaking renames). Per-side flags are semantically DIFFERENT operations from global flags — they assert different things. A breaking rename would lose the global flag's symmetric semantic ("both events"). Operators who want symmetric assertion continue to use global; operators who want asymmetric assertion use per-side.

### CLI parsing

Each new flag gets its own parsing block in `runRetentionDiffHistory`:

- `--kind-a` / `--kind-b`: `getStringFlag` + `isOptOutHistoryEventKind` validation (matches global `--kind` pattern from ADR-0198).
- `--kind-not-a` / `--kind-not-b`: `getMultiFlag` + per-occurrence validation loop (matches global `--kind-not` multi-value pattern from ADR-0214).
- `--actor-id-a` / `--actor-id-b` / `--actor-id-not-a` / `--actor-id-not-b`: `getStringFlag` (matches global `--actor-id` / `--actor-id-not` patterns from ADR-0203 / ADR-0205).

Each flag threads its value to the adapter as the corresponding optional field. JSON envelope echoes each flag's literal value (or null).

## Use cases unblocked

**1. Forensic state-transition verification**

```bash
# Assert A is the deletion event, B is the rebuild event:
crossengin retention diff-history $deletion_id $rebuild_id \
  --kind-a policy_deleted --kind-b retention_set
# Exit 0 + diff rendered if both events match their respective expected kinds.
# Exit 1 with explicit error if either side doesn't match.
```

**2. Per-side actor attribution**

```bash
# Assert A is Alice's earlier mutation, B is Bob's later mutation:
crossengin retention diff-history $alice_event $bob_event \
  --actor-id-a $alice_uuid --actor-id-b $bob_uuid --with-actor-names
```

**3. Per-side exclusion (different excluded actors per side)**

```bash
# Assert A is not migration SA, B is not CI SA:
crossengin retention diff-history $id_a $id_b \
  --actor-id-not-a $migration_sa --actor-id-not-b $ci_sa
```

**4. Per-side multi-value kind exclusion**

```bash
# Assert A is opt_out workflow (not maintenance), B is allowed any kind:
crossengin retention diff-history $id_a $id_b \
  --kind-not-a policy_deleted --kind-not-a retention_set
# A must be opt_out_set or opt_out_cleared; B unconstrained.
```

**5. Hybrid global + per-side belt-and-suspenders**

```bash
# Belt: both must be opt_out events. Suspenders: A specifically opt_out_set:
crossengin retention diff-history $id_a $id_b \
  --kind-not policy_deleted --kind-not retention_set \
  --kind-a opt_out_set
# Global excludes maintenance kinds (covers B); per-side narrows A further.
```

**6. Maximum-discipline forensic assertion**

```bash
# A is Alice's opt_out_set + B is not Bob's policy_deleted:
crossengin retention diff-history $id_a $id_b \
  --kind-a opt_out_set --actor-id-a $alice \
  --kind-not-b policy_deleted --actor-id-not-b $bob \
  --with-actor-names
```

## Drawbacks

1. **CLI flag surface explodes** — diff-history now has 13 expectation-check flags (5 global + 8 per-side) plus `--with-actor-names`. Operators reading helpText face a long list. Mitigated by helpText structure: global flags grouped together, per-side variants documented as `-a`/`-b` companions to their globals.
2. **JSON envelope has 12 expectation-related fields** — operators jq-parsing the envelope branch on more fields. Mitigated by `null` defaults — operators check only the fields they set.
3. **Check ordering matters but is not visible at CLI** — operators combining global + per-side need to know that global fires first. Documented in ADR; surfaces clearly in error messages (operator sees which check fired).
4. **No CLI-side validation against contradictions** — `--kind opt_out_set --kind-a retention_set` is logically impossible but CLI accepts it. Adapter surfaces global check error first; operator sees clear error from whichever check fires. Same stance as ADR-0205 contradictory-actor-id.
5. **`--system-only-a` / `--system-only-b` / `--no-system-a` / `--no-system-b` deferred** — the boolean-pair × per-side combination has different design considerations (4 flags with intra-side mutual exclusivity). Defer.
6. **Per-side field rename collision risk on adapter** — `actorIdA` / `actorIdB` as Input field names match `actorIdA` / `actorIdB` Result field names. Different interfaces, no type clash, but operators reading code see the same name in different contexts. Mitigated by separate type declarations (`DiffHistoryEntriesInput` vs `DiffHistoryEntriesResult`).
7. **No multi-value `--actor-id-a` / `--actor-id-b`** — single-value matches ADR-0203/0205 single-value pattern on the global side. Multi-value tuple expectation on per-side would be a separate future Q.
8. **Verbose CLI for asymmetric assertions** — operators wanting "A is opt_out_set AND B is opt_out_cleared" type 4 flags + 2 values. Acceptable; alternative would be positional tuples which are even more verbose.

## Alternatives considered

1. **Combine into existing global flags via comma-separated A/B values** (e.g., `--kind opt_out_set,opt_out_cleared` interpreted as "A=opt_out_set, B=opt_out_cleared") — overloads existing flag semantic; current `--kind` is single-value-meaning-both-events. Breaking change. Rejected.
2. **Per-side flags with positional semantics** (e.g., `--kind <A-kind> <B-kind>`) — unusual flag form. Rejected.
3. **Substrate-side dedup of contradictory global + per-side combinations** — operators may script with both flags always set; CLI doesn't pre-empt; adapter error surfacing is loud enough. Same stance as ADR-0205.
4. **Ship `--system-only-a` / `--no-system-a` in this milestone too** — boolean-pair × per-side adds 4 flags with intra-side mutual exclusivity rules. Deserves its own design milestone. Defer.
5. **Per-side `actor-id-a-not` / `actor-id-not-a` naming** — confusing word order. `--actor-id-not-a` (suffix after the `-not`) is consistent with ADR-0205's `actor-id-not` global. Adopted.
6. **Single combined `--side` modifier flag** (e.g., `--kind opt_out_set --side a`) — verbose + non-composable + invalid when multiple per-side assertions needed. Rejected.
7. **`--a-kind` / `--b-kind` prefix form** — non-canonical CLI flag style. `-a` / `-b` suffix matches the result field naming. Adopted.
8. **Per-side multi-value `--actor-id-a` repeatable** — multi-value positive actor expectation on per-side is a separate design (would assert "A must be one of these N actors"). Defer; pairs with potential future global multi-value `--actor-id` tuple expectation.
9. **Adapter-side mutual-exclusivity check global + per-side** — adapter would need to know operator intent which is ambiguous; CLI passes both to adapter, adapter runs both checks, error fires from whichever fails first. Cleaner.
10. **Use Map-based adapter input** (e.g., `actorIdExpect: { a?: string, b?: string }`) — verbose construction; flat fields match CLI flag names. Rejected.

## Open questions

1. **`--system-only-a` / `--system-only-b` / `--no-system-a` / `--no-system-b` per-side** — boolean-pair × per-side combination. Defer; closes ADR-0212 Q2.
2. **Per-side multi-value `--actor-id-a` repeatable** — multi-value positive actor expectation per side. Defer; pairs with future global multi-value tuple expectation.
3. **Apply per-side pattern to retention diff-timeline** — diff-timeline is a list-style query not a per-event-pair comparison; per-side doesn't apply. N/A.
4. **JSON envelope field name distinction** between operator-input expectations (`actorIdA`) and result diff values (`result.actorIdA`) — current naming overlaps but at different nesting levels. Defer rename (would be breaking).
5. **`--kind-a` accepts multi-value** for tuple expectation ("A must be one of N kinds") — pairs with deferred global `--kind` multi-value tuple. Defer.
6. **Combined per-side + system actor presence** — `--system-only-a --no-system-b` ("A is system, B is human"). Defer.

## Implementation outline

Three additive code changes:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - `DiffHistoryEntriesInput` gains 8 new optional fields (`eventKindA`, `eventKindB`, `eventKindsNotA`, `eventKindsNotB`, `actorIdA`, `actorIdB`, `actorIdNotA`, `actorIdNotB`). ADDITIVE — no breaking rename.
   - 4 new per-side check blocks in `diffHistoryEntries`, each positioned immediately after its global counterpart in the check sequence. Each throws with explicit "event A" / "event B" error format.

2. **`apps/architect-cli/src/retention.ts`**:
   - 8 new flag parses in `runRetentionDiffHistory`: 2 `getStringFlag` + validation pairs for `--kind-a`/`--kind-b`, 2 `getMultiFlag` + per-occurrence validation loops for `--kind-not-a`/`--kind-not-b`, 4 `getStringFlag` for actor-id variants.
   - Threading: all 8 new fields passed to `retention.diffHistoryEntries(...)` adapter call.
   - JSON envelope: 8 new fields echoed (string-or-null or array-or-null).

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention diff-history` usage line extended with all 8 new flags grouped by family (kind/kind-not/actor-id/actor-id-not).
   - Description block extended explaining per-side semantic + independence from global counterpart + error format.

## Tests

17 new adapter tests in a new "PostgresTraceRetention.diffHistoryEntries per-side expectation checks (M6.7.zz.tenant.opt-out.cli.diff-history.per-side)" describe block covering:

1. `--kind-a` accepts when A has expected kind (regardless of B).
2. `--kind-a` throws when A has wrong kind with explicit error naming side A + actual kind.
3. `--kind-b` throws when B has wrong kind (B side independent of A).
4. `--kind-a + --kind-b` accepts when both sides match respective per-side expectations.
5. `--kind-not-a` accepts when A doesn't have any excluded kind (multi-value).
6. `--kind-not-a` throws with multi-value list format when A matches one of excluded kinds.
7. `--kind-not-b` throws when B matches one of excluded kinds (B side independent of A).
8. `--actor-id-a` accepts when A has expected actor (regardless of B).
9. `--actor-id-a` throws when A has wrong actor with explicit error naming side A + actual actor.
10. `--actor-id-a` throws with `<system>` rendering when A is system-authored.
11. `--actor-id-b` throws when B has wrong actor (B side independent of A).
12. `--actor-id-not-a` accepts when A is not the excluded actor.
13. `--actor-id-not-a` throws when A matches the excluded actor.
14. `--actor-id-not-b` throws when B matches the excluded actor.
15. Composition: `--actor-id-a + --actor-id-b + --kind-a + --kind-b` all check independently.
16. Composition: global `--kind` fires BEFORE per-side `--kind-a` (global check surfaces first error).
17. Omits per-side checks when none of the per-side fields are set (backward compat).

17 new CLI tests in a new "runRetention diff-history per-side expectations (M6.7.zz.tenant.opt-out.cli.diff-history.per-side)" describe block covering:

1. `--kind-a` invalid value exits 2 with valid-values list.
2. `--kind-b` invalid value exits 2.
3. `--kind-not-a` invalid value exits 2 on FIRST invalid occurrence.
4. `--kind-not-b` invalid value exits 2.
5. Threads eventKindA when `--kind-a` set.
6. Threads eventKindB when `--kind-b` set.
7. Threads multi-element eventKindsNotA when `--kind-not-a` repeated.
8. Threads eventKindsNotB when `--kind-not-b` set.
9. Threads actorIdA + actorIdB independently.
10. Threads actorIdNotA + actorIdNotB independently.
11. Omits all per-side fields when no per-side flag set (backward compat).
12. Composes with global `--kind` + per-side `--kind-a` (both threaded).
13. JSON envelope echoes per-side kindA + kindB fields when set.
14. JSON envelope echoes per-side kindsNotA + kindsNotB arrays when set.
15. JSON envelope echoes per-side actorIdA + actorIdB + actorIdNotA + actorIdNotB.
16. JSON envelope all per-side fields null when none set.
17. Adapter per-side error propagates as exit 1 with per-side error format.

cli.ts helpText extended for retention diff-history usage line — all 8 new flags grouped by family with concise descriptions of per-side semantic + independence + error format.

Test count: 9,011 → 9,045 (+34 net: adapter +17, CLI +17).

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green (no new errors from this milestone; pre-existing `labelForIndex` + `chat.ts` errors unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

The retention diff-history surface now has 13 expectation-check flag families forming a 4×3 matrix (4 dimensions: kind, kind-not, actor-id, actor-id-not × 3 modes: global symmetric, per-side A, per-side B) plus the actor-presence pair:

| Dimension | Global | Per-side A | Per-side B |
|---|---|---|---|
| event_kind positive | `--kind` (ADR-0198) | `--kind-a` (ADR-0215) | `--kind-b` (ADR-0215) |
| event_kind negative | `--kind-not` (ADR-0214 multi) | `--kind-not-a` (ADR-0215 multi) | `--kind-not-b` (ADR-0215 multi) |
| actor_id positive | `--actor-id` (ADR-0203) | `--actor-id-a` (ADR-0215) | `--actor-id-b` (ADR-0215) |
| actor_id negative | `--actor-id-not` (ADR-0205) | `--actor-id-not-a` (ADR-0215) | `--actor-id-not-b` (ADR-0215) |
| system presence | `--system-only` / `--no-system` (ADR-0212) | _deferred_ | _deferred_ |

Plus `--with-actor-names` (ADR-0204) for display.

Operators have unprecedented control over per-event-pair forensic assertions on the cross-event policy diff surface — symmetric (both events) and asymmetric (per-side) expectations across kind + actor + system-presence dimensions.

The natural follow-up milestones:
- ADR-0212 Q2: `--system-only-a` / `--system-only-b` / `--no-system-a` / `--no-system-b` per-side system actor presence (the deferred boolean-pair × per-side combination).
- ADR-0198 Q2 / ADR-0203 Q2: multi-value tuple expectations on per-side variants (`--actor-id-a alice --actor-id-a bob` to assert "A must be one of {alice, bob}").

The retention CLI now has 18 actions with the most comprehensive multi-flag coverage in the codebase — operators can express virtually any state-transition assertion in a single command.
