# ADR-0205: `crossengin retention diff-history --actor-id-not` actor exclusion expectation check (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.actor-not)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0203 (--actor-id expectation check), ADR-0198 (--kind expectation check), ADR-0204 (--with-actor-names), ADR-0186 (--actor-id filter on retention history), ADR-0170 (history audit log) |

## Context

ADR-0203 shipped `--actor-id <uuid>` on `retention diff-history` as a positive expectation check — operator declares "I expect both these events to have actor_id X" and the adapter throws when reality differs. ADR-0203 Q1 listed `--actor-id-not` exclusion as future work for asymmetric expectations (per-side flags), but the operational use case for an exclusion EXPECTATION CHECK (vs per-side) is stronger and simpler:

1. **Tier-migration anti-actor sanity check** — operator asserts "verify these two production-tier migration events were NOT authored by the test-account-actor" (catch accidental test-actor leaking into prod migration).
2. **Suspended-user audit verification** — "verify neither event was authored by the now-suspended user before approving the diff for compliance."
3. **CI gate excluding service accounts** — "verify neither event was authored by the automation SA before treating this as a human-operator forensic record."
4. **"This isn't me" forensic discipline** — incident responder asserts "verify neither event was authored by my own actor-id before drawing conclusions about responsibility from the diff."

`--actor-id` is "both MUST be X." `--actor-id-not` is "neither MAY be X." Mirror-image expectation checks; both compose with each other (operator can say "both must be Alice AND neither is Bob" — redundant but not contradictory) and with `--kind` (ADR-0198) + `--with-actor-names` (ADR-0204).

M6.7.zz.tenant.opt-out.cli.diff-history.actor-not closes ADR-0204 Q5 + ADR-0203 Q1 in spirit by adding the inverse exclusion semantic.

## Decision

### CLI surface

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--kind <event-kind>]
                                  [--actor-id <uuid>]
                                  [--actor-id-not <uuid>]   # NEW
                                  [--with-actor-names]
                                  [--format human|json]
```

- `--actor-id-not <uuid>` added as a single optional flag.
- Composes with all existing flags. NOT mutually exclusive with `--actor-id` at the CLI boundary — substrate adapter surfaces contradictions via thrown errors (operator passing `--actor-id alice --actor-id-not alice` gets a clear adapter error since the actorId check fires first and throws).
- No CLI-side UUID validation (matches deferred decision across cursor + actor-filter ADRs).

### Adapter changes

`DiffHistoryEntriesInput` gains optional `actorIdNot?: string` field. After the existing actorId expectation check, an actorIdNot exclusion validation:

```ts
if (input.actorIdNot !== undefined) {
  const matches: string[] = [];
  if (entryA.actor_id === input.actorIdNot) matches.push("A");
  if (entryB.actor_id === input.actorIdNot) matches.push("B");
  if (matches.length > 0) {
    const suffix =
      matches.length === 1
        ? `${matches[0]} matches`
        : "both A and B match";
    throw new Error(
      `diffHistoryEntries: expected neither event to have actor_id '${input.actorIdNot}' but ${suffix}`,
    );
  }
}
```

Error message names the offending side(s) compactly — single match: `"but A matches"`, both match: `"but both A and B match"`. Operators see at a glance which side(s) violated the exclusion.

### Why "matches" not "is '<actor>'"

The actorId check (ADR-0203) renders mismatches as `A is '<actual-actor>'` because operators need to see the unexpected value. For exclusion, the offending value is the one in `--actor-id-not` (operator already knows it); naming the side ("A matches" / "both A and B match") is sufficient and shorter. Different rendering reflects different information need.

### Null actor_id (system) and the exclusion check

When `--actor-id-not <uuid>` is set and an event has `actor_id IS NULL` (system actor), the comparison `null === <uuid>` evaluates false, so the check passes (a system event is NOT that specific UUID actor). This is the correct behavior — operators wanting "neither event is system" would need a different flag (deferred future Q; operators jq-filter for now).

### Composition with --actor-id (positive expectation)

Both can be set; both fire independently. Examples:

- `--actor-id alice --actor-id-not bob`: "both must be alice AND neither is bob" — passes when both are alice (since alice ≠ bob, neither is bob).
- `--actor-id alice --actor-id-not alice`: contradictory — actorId check fires first throwing "expected both events to have actor_id alice but A is '...'" if either event isn't alice; if both ARE alice, actorIdNot fires throwing "expected neither event to have actor_id alice but both A and B match." Operator sees a clear error from whichever check fires.

CLI doesn't enforce mutual exclusivity — substrate stays minimal, operators can compose freely, contradictory inputs produce clear adapter errors.

### Error path: exit 1 (runtime) not exit 2 (misuse)

Matches ADR-0203 + ADR-0198 pattern exactly. Adapter exclusion violation throws; CLI catches and returns exit 1 (runtime path). Exit 2 reserved for CLI-side input validation.

### JSON envelope

Gains `actorIdNot: string | null` field echoing the operator's expectation (or null when not set):

```json
{
  "action": "diff-history",
  "kind": null,
  "actorId": null,
  "actorIdNot": "22222222-...",
  "withActorNames": false,
  "result": { ... }
}
```

When both `--actor-id` and `--actor-id-not` are set, both fields populate. When neither set, both render as `null`. Matches established envelope-echo pattern from ADR-0198/0203/0204.

### No human-format change

The existing `formatHistoryDiff` renders metadata + field diffs; the exclusion check fires at the adapter layer before the formatter is reached on violation, and is silent on pass (operators see normal diff output). No formatter changes needed.

## Use cases unblocked

**1. Tier-migration anti-actor verification**

```bash
# Verify these two production migration events were NOT authored by the test SA:
crossengin retention diff-history <id-a> <id-b> --actor-id-not <test-sa-uuid>
# Exit 0 if neither is test SA + diff rendered. Exit 1 if either is test SA.
```

**2. Suspended-user audit pre-check**

```bash
# Verify neither event was authored by now-suspended user before approving diff:
crossengin retention diff-history <id-a> <id-b> --actor-id-not <suspended-uuid> \
  --with-actor-names --format json | jq '.result'
```

**3. CI gate excluding automation**

```bash
# Forensic gate: this diff must be human-authored on both sides:
crossengin retention diff-history <baseline> <current> \
  --actor-id-not <ci-automation-sa> --actor-id-not <migration-sa> 2>&1 | head -1
# Exits 1 if either event was authored by automation. (Operators chain multiple
# commands when needing multi-exclusion; --actor-id-not is single-value.)
```

**4. Composed positive + negative expectation**

```bash
# Both must be Alice AND neither must be Bob:
crossengin retention diff-history <id-a> <id-b> \
  --actor-id <alice-uuid> --actor-id-not <bob-uuid>
# Both checks fire independently; clear error if either fails.
```

## Drawbacks

1. **Single-value exclusion only** — operators wanting "neither event must be one of <a, b, c>" run multiple commands or compose with jq. Multi-value exclusion deferred (different shape than multi-actor OR-filter on diff-timeline). Documented future Q.
2. **No null-actor exclusion** — `--actor-id-not <uuid>` doesn't help operators wanting "neither event may be system-authored." Operators jq-filter for that case. Defer; same as ADR-0186 null-actor stance.
3. **Composition with --actor-id can be contradictory** — `--actor-id X --actor-id-not X` is logically impossible; adapter throws but order of error message depends on which check fires first (actorId fires first). Acceptable — clear error in either ordering; operators won't set contradictory flags accidentally.
4. **No CLI-side UUID validation** — invalid UUIDs hit PG; matches ADR-0175/0186/0193/0203 deferred decision.
5. **Asymmetric error rendering vs --actor-id** — positive expectation says "A is '<actual>'" (showing operator the value they didn't expect); exclusion says "A matches" (operator already knows the excluded value). Different rendering reflects different information needs; documented.
6. **No per-side --actor-id-not-a + --actor-id-not-b** — asymmetric exclusion ("A must not be Alice; B must not be Bob") not supported. Operators chain commands. Defer; pairs with similar ADR-0203 Q1.

## Alternatives considered

1. **`--actor-id-not` as a filter (skip events with that actor)** — doesn't fit diff-history which takes 2 fixed IDs; exclusion expectation matches the semantic.
2. **Make exclusion match a warning not throw** — silent gates lose safety property. Rejected (matches ADR-0203 stance).
3. **Two flags `--actor-id-not-a` + `--actor-id-not-b` for per-side exclusion** — overkill for v1; both-not-X is the common case. Defer.
4. **CLI-enforced mutual exclusivity with --actor-id** — operators wanting "both must be Alice AND neither is Bob" (perfectly valid) would be blocked. Adapter-level error surfaces contradictions naturally. Rejected mutual exclusivity.
5. **Render mismatch as fieldDiff** — actor_id isn't a "field" in next_state JSONB; throwing is loud and clear. Rejected (matches ADR-0203).
6. **PG WHERE clause filter** — would silently return zero rows on exclusion match indistinguishable from "IDs don't exist"; throw-with-clear-message is the right behavior. Rejected.
7. **Use `IN`/`NOT IN` SQL for multi-value exclusion** — overkill for v1; substrate single-value matches ADR-0203 positive expectation pattern. Defer multi-value.
8. **Inverse flag named `--exclude-actor-id`** — verbose; `--actor-id-not` matches naming conventions seen in similar inverse flags (defer is already documented in ADR-0186 Q + ADR-0193 future Q with `--actor-id-not` naming).

## Open questions

1. **`--actor-id-not <a>|<b>|<c>` multi-value exclusion** ("neither event must be one of these N actors"). Defer; multi-value shape different from multi-actor OR-filter.
2. **`--actor-id-not-a` + `--actor-id-not-b` per-side exclusion** for asymmetric exclusion checks. Defer; same as ADR-0203 Q1.
3. **`--system-only` + `--no-system` flags** for explicit null actor_id matching/exclusion. Defer; operators jq-filter.
4. **`--kind-not <event-kind>` exclusion check** as a companion symmetric flag on diff-history. Pairs with this milestone's pattern on the kind dimension. Defer.
5. **`--actor-id-not <uuid>` filter on diff-timeline** (substrate-side WHERE NOT actor_id = $N filter; different semantic from expectation check). Defer; matches ADR-0186 Q1 pattern.
6. **`--actor-id-not <uuid>` filter on retention history** (substrate-side WHERE NOT). Defer; pairs with retention history's existing `--actor-id` filter from ADR-0186.
