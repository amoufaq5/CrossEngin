# ADR-0212: `crossengin retention diff-history --system-only` / `--no-system` actor-presence expectation check (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.system-only)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0205 (--actor-id-not expectation check), ADR-0203 (--actor-id expectation check), ADR-0198 (--kind expectation check), ADR-0208 (--kind-not expectation check), ADR-0209 (--system-only/--no-system filter on retention history) |

## Context

ADR-0209 shipped `--system-only` / `--no-system` boolean flag pair on `retention history` as a substrate-side WHERE filter — `--system-only` adds `h.actor_id IS NULL`, `--no-system` adds `h.actor_id IS NOT NULL`, mutually exclusive at CLI boundary. ADR-0205 Q3 explicitly listed the diff-history expectation-check companion as deferred future work:

> 3. `--system-only` + `--no-system` flags for explicit null actor_id matching/exclusion. Defer; operators jq-filter.

The semantic differs from ADR-0209's filter (which restricts the query) because diff-history takes exactly two IDs not a list query — flag semantic shifts from filter to expectation check matching the pattern established by ADR-0198 (--kind), ADR-0203 (--actor-id), ADR-0205 (--actor-id-not), ADR-0208 (--kind-not). The recurring shape: when a flag exists as both a list-query filter (on retention history + retention diff-timeline) and a per-event-pair expectation check (on retention diff-history), the diff-history surface shifts from filter to assertion.

Real expectation-check use cases on diff-history:

1. **System-only audit pair verification** — operator pulls two `policy_deleted` events suspected of being from the scheduled retention sweep and wants to assert "both events were system-initiated" before treating the diff as automation-history.
2. **Human-only forensic comparison** — incident responder compares two state transitions and wants to assert "neither event was system-initiated" (both were deliberate human/SA mutations) before drawing conclusions about responsibility.
3. **Compliance attestation gating** — auditor producing "this diff is human-deliberate not automation" exports asserts `--no-system` to ensure neither event is a maintenance row.
4. **Migration verification** — operator running a tier migration script wants to assert both events from the migration window are `--system-only` (initiated by the migration SA running as system) before treating the diff as the canonical migration record.

M6.7.zz.tenant.opt-out.cli.diff-history.system-only closes ADR-0205 Q3 by shipping the `--system-only` / `--no-system` expectation check on retention diff-history. Reuses the `ActorPresenceFilter` discriminated union from ADR-0209 — same type, same CLI mutual-exclusivity, same JSON envelope echo shape.

## Decision

### CLI surface

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--kind <event-kind>]
                                  [--kind-not <event-kind>]
                                  [--actor-id <uuid>]
                                  [--actor-id-not <uuid>]
                                  [--system-only | --no-system]    # NEW
                                  [--with-actor-names]
                                  [--format human|json]
```

- `--system-only` boolean flag — assert BOTH events have `actor_id IS NULL` (both system-authored).
- `--no-system` boolean flag — assert NEITHER event has `actor_id IS NULL` (both have UUID actor — human or service-account authored).
- Mutually exclusive at CLI boundary — both set returns exit 2 with `retention diff-history: --system-only and --no-system are mutually exclusive` error before any PG query (CI logs recognize as misuse, matches ADR-0209 retention history's mutual-exclusivity pattern).
- Composes with `--kind`, `--kind-not`, `--actor-id`, `--actor-id-not`, `--with-actor-names` without restriction.

### Adapter changes

`DiffHistoryEntriesInput` gains optional `actorPresence?: ActorPresenceFilter` field reusing the exported type from ADR-0209:

```ts
// Already exported from ADR-0209:
export type ActorPresenceFilter = "system_only" | "no_system";

// Extended in this milestone:
export interface DiffHistoryEntriesInput {
  ...existing fields...
  readonly actorPresence?: ActorPresenceFilter;
  ...
}
```

Discriminated string union over two booleans matches ADR-0209 precedent — mutual exclusivity enforced at the type level, adapter consumers see a clean 3-state choice, CLI translates the two boolean flags into the single union value after mutual-exclusivity check.

New expectation check block positioned after the existing `actorIdNot` check (immediately after the actor-dimension group):

```ts
if (input.actorPresence === "system_only") {
  const mismatches: string[] = [];
  if (entryA.actor_id !== null) {
    mismatches.push(`A is '${entryA.actor_id}'`);
  }
  if (entryB.actor_id !== null) {
    mismatches.push(`B is '${entryB.actor_id}'`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `diffHistoryEntries: expected both events to be system-authored (actor_id IS NULL) but ${mismatches.join(" and ")}`,
    );
  }
} else if (input.actorPresence === "no_system") {
  const matches: string[] = [];
  if (entryA.actor_id === null) matches.push("A");
  if (entryB.actor_id === null) matches.push("B");
  if (matches.length > 0) {
    const suffix =
      matches.length === 1
        ? `${matches[0]} is <system>`
        : "both A and B are <system>";
    throw new Error(
      `diffHistoryEntries: expected neither event to be system-authored (actor_id IS NULL) but ${suffix}`,
    );
  }
}
```

### Asymmetric error rendering

`system_only` reports the offending side(s) with their actual actor_id value: `A is '<uuid>'` — operators need to see WHO authored the event if it wasn't supposed to have a human actor. Mirrors the ADR-0203 positive `--actor-id` expectation rendering ("but A is '<actual>'").

`no_system` reports the offending side(s) as `<system>` placeholder: `A is <system>` / `both A and B are <system>` — operators already know which side they expected to be human, naming the sentinel is sufficient. Mirrors the ADR-0205 negative `--actor-id-not` rendering ("but A matches") shape — short and clear.

Different rendering reflects different information needs:
- Positive expectation (`system_only`): operator wanted null, but got a UUID — show the UUID so they know who DID author it.
- Negative expectation (`no_system`): operator wanted any non-null, but got system — naming the side `<system>` is enough since system IS the excluded value.

Consistent with the ADR-0203 vs ADR-0205 asymmetric rendering documented across the actor expectation family.

### Check ordering

The four expectation checks on `diffHistoryEntries` now run in this order after the cross-tenant / cross-table / known-event_kind validations:

1. `eventKind` (positive expectation — ADR-0198)
2. `eventKindNot` (negative expectation — ADR-0208)
3. `actorId` (positive specific actor expectation — ADR-0203)
4. `actorIdNot` (negative specific actor expectation — ADR-0205)
5. `actorPresence` (this milestone: system_only or no_system)

Positioned `actorPresence` immediately after `actorIdNot` so actor-dimension checks group together. Kind-dimension checks come first; actor-dimension checks (specific then presence) follow.

### Composition with --actor-id / --actor-id-not

- `--system-only --actor-id <uuid>` is contradictory at the data layer (system events have `actor_id IS NULL`; `--actor-id` requires a specific UUID). Both checks fire; `--actor-id` check fires first surfacing the actor-mismatch error. Operators see a clear error.
- `--system-only --actor-id-not <uuid>` is redundant but valid (system events are NEITHER any specific UUID; both checks pass).
- `--no-system --actor-id <uuid>` is the canonical "both must be human actor X" idiom (both checks pass when both events have actor_id = X; X being a UUID implies non-null which `--no-system` requires).
- `--no-system --actor-id-not <uuid>` is the canonical "both must be human, excluding X" idiom (operators wanting "two human-authored events neither of which is the migration SA").

### Why expectation check not filter

diff-history takes exactly TWO IDs — there's nothing to "filter" (no row set to narrow). The semantic shifts from filter (on retention history + diff-timeline list-style surfaces) to expectation check matching ADR-0198 / ADR-0203 / ADR-0205 / ADR-0208 precedent. PG-side WHERE filter would silently return zero rows on mismatch indistinguishable from "IDs don't exist"; adapter throw with clear message naming the offending side(s) is loud and clear.

### Error path: exit 1 (runtime) not exit 2 (misuse)

Matches ADR-0198 + ADR-0203 + ADR-0205 + ADR-0208 pattern exactly. Adapter expectation violation throws; CLI catches and returns exit 1 (runtime path). Exit 2 reserved for CLI-side input validation (mutual exclusivity of `--system-only` + `--no-system`).

### JSON envelope

Gains two boolean fields matching ADR-0209 retention history precedent:

```json
{
  "action": "diff-history",
  "kind": null,
  "kindNot": null,
  "actorId": null,
  "actorIdNot": null,
  "systemOnly": true,
  "noSystem": false,
  "withActorNames": false,
  "result": { ... }
}
```

- `systemOnly: true` when `--system-only` set, `false` otherwise.
- `noSystem: true` when `--no-system` set, `false` otherwise.
- Mutual exclusivity at CLI guarantees both are never `true` simultaneously.

Two-boolean echo (not single discriminated string) matches existing CLI-flag-echo convention — every CLI flag has a corresponding envelope field with the same boolean-or-null-or-string shape.

## Use cases unblocked

**1. System-only audit pair verification**

```bash
# Assert both events are system-initiated (from scheduled retention sweep):
crossengin retention diff-history <id-a> <id-b> --system-only \
  --kind policy_deleted
# Exit 0 + diff rendered if both are system policy_deleted events.
# Exit 1 if either has a UUID actor (with the offending UUID shown).
```

**2. Human-only forensic comparison**

```bash
# Assert neither event is system-initiated before drawing conclusions:
crossengin retention diff-history <id-a> <id-b> --no-system \
  --with-actor-names --format json | jq '.result'
```

**3. Compliance attestation gating**

```bash
# Quarterly compliance: this diff must be human-deliberate not automation:
crossengin retention diff-history <baseline> <current> --no-system \
  --kind opt_out_set --format json
# Composes: assert both opt_out_set + neither is system.
```

**4. Migration verification**

```bash
# Verify these two events are from migration script (system-initiated):
crossengin retention diff-history <pre-migration> <post-migration> \
  --system-only --kind retention_set
# Asserts both events are system retention_set (migration signature).
```

**5. Compose across all four expectation flags**

```bash
# Maximum-discipline assertion: both must be opt_out_set, neither policy_deleted,
# both authored by Alice, neither by Bob, both are human (no_system):
crossengin retention diff-history <id-a> <id-b> \
  --kind opt_out_set --kind-not policy_deleted \
  --actor-id <alice-uuid> --actor-id-not <bob-uuid> \
  --no-system
```

## Drawbacks

1. **Five expectation flags on diff-history now** — `--kind`, `--kind-not`, `--actor-id`, `--actor-id-not`, `--system-only`/`--no-system` (plus `--with-actor-names` for display) — operators have to mentally manage a larger flag matrix. Mitigated by helpText structure: kind dimension grouped together, actor dimension grouped together, `--system-only`/`--no-system` placed in the actor section as the actor-presence sub-dimension.
2. **Mutual exclusivity enforced at CLI not adapter** — adapter's discriminated string union type prevents both-at-once expression in the input; CLI validates the two flags before translating. A direct adapter caller bypassing the CLI cannot construct an invalid state (type system enforces). But an adapter caller mapping operator flags themselves must replicate the mutual-exclusivity check at their layer (same caveat as ADR-0209).
3. **Two-boolean JSON echo when adapter uses discriminated string** — CLI envelope shape diverges from adapter shape (boolean-pair on JSON, string union on adapter). The two-boolean form matches the literal flag state operators typed and pairs with the existing `withActorNames` + ADR-0209 `systemOnly`/`noSystem` boolean echo convention.
4. **Composition with `--actor-id <uuid> --system-only` is contradictory** — `--actor-id` check fires first surfacing the actor-mismatch error; operator sees that error not the system-only error. Acceptable because both checks would fail; first-fail ordering is consistent. Documented.
5. **Asymmetric error rendering (positive shows UUID, negative says `<system>`)** — different rendering reflects different information needs (documented above). Matches the ADR-0203 vs ADR-0205 precedent.
6. **No partial expectation (e.g., "A must be system, B may be either")** — this is per-side asymmetric expectation, deferred as future Q (pairs with ADR-0203 Q1 + ADR-0205 Q2 + ADR-0208 Q2 per-side family).
7. **No `--system-only` / `--no-system` on retention diff-timeline yet** — pairs with deferred ADR-0207 Q3 + ADR-0193 future Q. Defer to follow-up milestone.

## Alternatives considered

1. **Two separate boolean fields on adapter** (`systemOnly?: boolean` + `noSystem?: boolean`) — allows invalid both-true state at the type level. Discriminated union (`actorPresence?: "system_only" | "no_system"`) makes invalid states unrepresentable. Rejected two-field; matches ADR-0209 stance.
2. **`--actor-presence <only|exclude>` single flag with enum value** — operators have to remember the enum vocabulary instead of natural boolean flags. `--system-only` and `--no-system` are more memorable + more discoverable in helpText. Rejected.
3. **`--system` and `--human` as flag names** — "human" is misleading (service accounts are also non-system but not human). Rejected.
4. **`--actor-id null` sentinel value** — overloads the `--actor-id` flag's string-UUID semantic. Operators parsing the help would expect a UUID, not the literal string "null." Rejected.
5. **CLI-side `--actor-id <uuid> --system-only` contradiction error** — would block valid edge cases (operator may script with both flags always set; substrate returns clear error for the impossible combination — natural first-check-fires outcome).
6. **Substrate-side `--system-only` + `--no-system` mutual-exclusivity error in the adapter** — adapter's discriminated string union type makes the invalid state unrepresentable; CLI handles the mutual exclusivity at flag parsing. Cleaner.
7. **Per-side `--system-only-a` / `--system-only-b`** — overkill for v1; both-must-be-system / neither-must-be-system are the common cases. Defer.
8. **Render mismatch as fieldDiff** — actor presence isn't a "field" in next_state JSONB; throwing is loud and clear. Rejected (matches ADR-0198/0203/0205/0208 stance).
9. **PG WHERE clause validation** — diff-history takes 2 fixed IDs not a list query; WHERE filter would silently return zero rows on mismatch indistinguishable from "IDs don't exist"; throw with clear message is correct.
10. **Default `--no-system` behavior (require non-null actor)** — silent behavior change for existing callers. Backward-incompatible. Rejected.

## Open questions

1. **`--system-only` / `--no-system` on `retention diff-timeline`** — substrate-side filter across all 3 dispatch paths (pair-wise + N-way + cross-table). Defer; closes ADR-0207 Q3 + ADR-0193 future Q.
2. **Per-side asymmetric expectation** — `--system-only-a` / `--system-only-b` allowing one side to be system and the other not. Defer; pairs with ADR-0203 Q1 + ADR-0205 Q2 per-side family.
3. **Short-circuit LEFT JOIN when `actorPresence === "system_only"`** — system events have no user row; the JOIN is wasted when `--system-only` is set with `--with-actor-names`. Defer optimization.
4. **JSON envelope unification across expectation-check flags** — currently `systemOnly`/`noSystem` are booleans while `kind`/`kindNot`/`actorId`/`actorIdNot` are nullable strings; operators write conditional jq branches per shape. Tagged-union envelope would simplify but break backward compat. Defer.
5. **Apply same expectation-check semantic to retention prune** — `crossengin retention prune --system-only` to dry-run prune only system-authored history rows. Different surface, different semantic. Defer.
6. **`--mixed-actors` flag** for asserting "exactly one event is system, the other is human" — uncommon use case, operators chain commands. Defer.

## Implementation outline

Three additive code changes:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - `DiffHistoryEntriesInput` gains optional `actorPresence?: ActorPresenceFilter` field reusing the type from ADR-0209.
   - New `if (input.actorPresence === "system_only") ... else if (input.actorPresence === "no_system") ...` block in `diffHistoryEntries` immediately after the existing `actorIdNot` check, before the result construction. Throws with asymmetric error messages.

2. **`apps/architect-cli/src/retention.ts`**:
   - `runRetentionDiffHistory` reads `systemOnlyFlag` + `noSystemFlag` via `getBooleanFlag`.
   - Mutual exclusivity check: both true → exit 2 with explicit error matching ADR-0209's history pattern.
   - Translate to `actorPresence: "system_only" | "no_system" | undefined`.
   - Thread `actorPresence` to `retention.diffHistoryEntries(...)` adapter call.
   - JSON envelope gains `systemOnly: systemOnlyFlag` + `noSystem: noSystemFlag` boolean fields.

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention diff-history` usage line extended with `[--system-only | --no-system]` notation indicating mutual exclusivity.
   - 4-line description added explaining "assert both events are system / neither is system" + mutual exclusivity.

## Tests

10 new adapter tests in a new "PostgresTraceRetention.diffHistoryEntries actorPresence expectation check (M6.7.zz.tenant.opt-out.cli.diff-history.system-only)" describe block:

1. `system_only`: accepts when both events are system-authored (null actor_id).
2. `system_only`: throws when A has actor_id with explicit error naming side A + actual UUID.
3. `system_only`: throws when B has actor_id with explicit error naming side B + actual UUID.
4. `system_only`: throws naming both sides when neither is system-authored.
5. `no_system`: accepts when both events have non-null actor_id.
6. `no_system`: throws when A is system-authored with explicit `<system>` error.
7. `no_system`: throws when B is system-authored.
8. `no_system`: throws naming both when both events are system-authored.
9. Omits the check when actorPresence not set (backward compat).
10. Composes with `--kind` expectation check (both pass when actor + kind expectations met).

9 new CLI tests in a new "runRetention diff-history --system-only / --no-system" describe block:

1. Returns exit 2 when `--system-only` AND `--no-system` both set with explicit error.
2. Threads `actorPresence: "system_only"` to adapter when `--system-only` set.
3. Threads `actorPresence: "no_system"` when `--no-system` set.
4. Omits `actorPresence` when neither flag set (backward compat).
5. Composes with `--actor-id-not` + `--no-system` (both threaded independently).
6. Adapter expectation error propagates as exit 1 with explicit error.
7. JSON envelope echoes `systemOnly: true` + `noSystem: false` when `--system-only` set.
8. JSON envelope echoes `noSystem: true` + `systemOnly: false` when `--no-system` set.
9. JSON envelope both `false` when neither flag set.

cli.ts helpText extended for retention diff-history usage line with `[--system-only | --no-system]` notation + 4-line description explaining the expectation-check semantic + mutual exclusivity.

Test count: 8,966 → 8,985 (+19 net: adapter +10, CLI +9).

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green (no new errors from this milestone; pre-existing `labelForIndex` + `chat.ts` errors unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

The retention diff-history surface now has FIVE expectation-check flag families forming a 3×2 + 1 matrix:

| Dimension | Positive | Negative |
|---|---|---|
| event_kind | `--kind` (ADR-0198) | `--kind-not` (ADR-0208) |
| specific actor_id | `--actor-id` (ADR-0203) | `--actor-id-not` (ADR-0205) |
| system actor presence | `--system-only` (this milestone) | `--no-system` (this milestone) |

Plus `--with-actor-names` (ADR-0204) for actor display name surfacing. Operators get full positive + negative expectation gates across the kind + specific-actor + system-presence dimensions with consistent error-message shape (positive: "but A is 'Y'", negative: "but A matches" / "but A is <system>") and uniform exit-code semantics (CLI misuse exit 2 on mutual exclusivity violation, runtime exit 1 on adapter-level expectation violation).

The `--system-only` / `--no-system` family is now 2-of-3 surfaces shipped:

- `retention history` — substrate-side filter (ADR-0209).
- `retention diff-history` — expectation check (this milestone).
- `retention diff-timeline` — substrate-side filter across all 3 dispatch paths (ADR-0207 Q3 + ADR-0193 future Q deferred).

The retention CLI now has 18 actions with `--system-only` / `--no-system` support shipped on both retention history (list-style filter) and retention diff-history (cross-event expectation check) — operators get system-vs-human ergonomics on the two complementary audit-log surfaces with surface-appropriate semantics.
