# ADR-0216: `crossengin retention diff-history` per-side `--system-only` / `--no-system` actor-presence expectation check (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.per-side.system-only)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0212 (--system-only/--no-system global expectation), ADR-0215 (per-side asymmetric expectation checks framework), ADR-0209 (--system-only/--no-system filter on retention history) |

## Context

ADR-0215 shipped 8 per-side asymmetric expectation-check flags on `retention diff-history` covering 4 of the 5 per-side future Qs (`--kind-a/-b`, `--kind-not-a/-b`, `--actor-id-a/-b`, `--actor-id-not-a/-b`). The 5th per-side future Q from ADR-0212 Q2 — `--system-only-a` / `--system-only-b` / `--no-system-a` / `--no-system-b` per-side actor-presence — was deliberately deferred:

> ADR-0215 Drawback 5: `--system-only-a` / `--system-only-b` / `--no-system-a` / `--no-system-b` deferred — the boolean-pair × per-side combination has different design considerations (4 flags with intra-side mutual exclusivity). Defer.

This milestone closes ADR-0212 Q2 + ADR-0215 Drawback 5. The 4-flag intra-side mutual-exclusivity design space resolves cleanly by reusing the `ActorPresenceFilter` discriminated string union from ADR-0209/0212 per side — same type at adapter level, CLI handles intra-side mutual exclusivity.

Real use cases for asymmetric system-vs-human assertions on diff-history:

1. **Migration-to-human handoff verification** — operator compares the migration script's initial `retention_set` event (system-authored) against a later operator-driven adjustment (human-authored) and wants to assert `--system-only-a --no-system-b` ("A is the system migration, B is the human adjustment") to verify the workflow ran in the expected order.
2. **Human-to-automation handoff** — incident-response operator manually opted out a tenant (event A) and the automated retention sweep later picked it up (event B). Assert `--no-system-a --system-only-b` to verify the workflow attribution.
3. **System sweep audit pair** — operator pulls two `policy_deleted` events from the same scheduled sweep and asserts both are system-authored using `--system-only-a --system-only-b` (which is equivalent to global `--system-only` but more explicit when composing with other per-side flags).
4. **Operator forensic discipline** — incident responder asserts "this diff is between human-authored events on both sides" via `--no-system-a --no-system-b` (equivalent to global `--no-system` but composable with per-side actor-id flags).

The completing flag-pair restores symmetry with the 4 per-side dimensions ADR-0215 already shipped — every actor-related expectation flag on diff-history now has both global symmetric AND per-side asymmetric variants.

## Decision

### CLI surface

4 new boolean flags added to retention diff-history:

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [existing 13 expectation flags from ADR-0198/0203/0205/0208/0212/0214/0215]
                                  [--system-only-a | --no-system-a]   # NEW
                                  [--system-only-b | --no-system-b]   # NEW
                                  [--with-actor-names]
```

Intra-side mutual exclusivity (matches ADR-0209/0212 within each side):
- `--system-only-a` AND `--no-system-a` both set → exit 2 with `--system-only-a and --no-system-a are mutually exclusive` error.
- `--system-only-b` AND `--no-system-b` both set → exit 2 with `--system-only-b and --no-system-b are mutually exclusive` error.
- A's flags and B's flags do NOT interact — operators can set `--system-only-a` + `--no-system-b` for asymmetric "A is system, B is human" assertion (canonical use case).

Composes with all existing flags (global `--system-only`/`--no-system` + 8 per-side flags from ADR-0215 + 5 global expectation flags) without restriction. Per-side fires after global in check order.

### Adapter changes

`DiffHistoryEntriesInput` gains 2 new optional fields reusing the `ActorPresenceFilter` discriminated string union from ADR-0209:

```ts
export interface DiffHistoryEntriesInput {
  ...existing fields including actorPresence...
  readonly actorPresenceA?: ActorPresenceFilter;
  readonly actorPresenceB?: ActorPresenceFilter;
  ...
}
```

Discriminated string union over 2 booleans per side matches ADR-0209/0212 precedent:
1. **Mutual exclusivity enforced at type level** within each side — impossible to express "both at once" in adapter input.
2. **Adapter consumes clean 3-state choice per side** — `actorPresenceA` is `"system_only" | "no_system" | undefined`.
3. **CLI translates 4 boolean flags + intra-side mutual exclusivity check into 2 union values** (one per side).

### Per-side check logic

Adapter gains 2 new conditional blocks positioned immediately after the existing global `actorPresence` block (at the end of the actor dimension chain, just before result construction):

```ts
if (input.actorPresenceA === "system_only") {
  if (entryA.actor_id !== null) {
    throw new Error(
      `diffHistoryEntries: expected event A to be system-authored (actor_id IS NULL) but A is '${entryA.actor_id}'`,
    );
  }
} else if (input.actorPresenceA === "no_system") {
  if (entryA.actor_id === null) {
    throw new Error(
      `diffHistoryEntries: expected event A to NOT be system-authored (actor_id IS NULL) but A is <system>`,
    );
  }
}
// Same shape for actorPresenceB on entryB
```

Single-side check (not the "both events" loop from global) — per-side fires independently for A or B, throws with explicit "event A" / "event B" prefix.

### Check ordering

The adapter's expectation-check sequence now ends with the per-side actor-presence pair:

1. Existing same-tenant + same-table validations.
2-13. Global + per-side checks from ADR-0198/0203/0205/0208/0212/0214/0215.
14. `actorPresence` (global system/no-system — ADR-0212).
15. `actorPresenceA` (per-side A — NEW).
16. `actorPresenceB` (per-side B — NEW).
17. Result construction.

Global before per-side within the actor-presence dimension, matching the ADR-0215 ordering pattern. Per-side A before per-side B for consistency with existing left-to-right reading.

### Per-side error message format

Matches the ADR-0215 per-side error format conventions:

| Flag | Mismatch error |
|---|---|
| `--system-only-a` | `expected event A to be system-authored (actor_id IS NULL) but A is '<uuid>'` |
| `--no-system-a` | `expected event A to NOT be system-authored (actor_id IS NULL) but A is <system>` |
| `--system-only-b` | `expected event B to be system-authored (actor_id IS NULL) but B is '<uuid>'` |
| `--no-system-b` | `expected event B to NOT be system-authored (actor_id IS NULL) but B is <system>` |

Different rendering per direction:
- **Positive `--system-only-X`** (expects NULL but got UUID): shows the actual UUID since operator needs to see WHO authored the event.
- **Negative `--no-system-X`** (expects non-NULL but got NULL): renders `<system>` placeholder since operator already knows the excluded value.

Asymmetric rendering matches ADR-0203/0205/0212/0215 family conventions across positive/negative + per-side.

### JSON envelope

Gains 4 new boolean fields matching CLI flag names verbatim:

```json
{
  "action": "diff-history",
  ...existing fields...
  "systemOnly": false,
  "noSystem": false,
  "systemOnlyA": true,    // NEW
  "noSystemA": false,     // NEW
  "systemOnlyB": false,   // NEW
  "noSystemB": true,      // NEW
  "withActorNames": false,
  "result": { ... }
}
```

Two-boolean echo per side (not discriminated string) matches the existing global `systemOnly`/`noSystem` echo convention from ADR-0209/0212 — operators read literal flag state; intra-side mutual exclusivity at CLI guarantees both never true simultaneously.

### Composition with global flags

Per-side flags compose freely with global `--system-only`/`--no-system`. When BOTH global and the corresponding per-side flag are set, BOTH checks fire (global first). Examples:

1. **`--system-only --system-only-a`** — global asserts both events system; per-side A asserts A is system. Redundant but harmless. Passes when both events are system.
2. **`--system-only --no-system-a`** — global asserts both system; per-side A asserts A is NOT system. Contradictory at the data layer. Global check fires first; if A is system the global passes and per-side fails; if A is human the global fails first with "expected both events to be system-authored".
3. **`--no-system --no-system-a`** — both check neither/A is non-system. Redundant.
4. **`--system-only-a --no-system-b`** — canonical asymmetric pattern: A is system AND B is human. Both per-side checks fire independently.
5. **`--system-only-a --system-only-b`** — equivalent to global `--system-only` but explicit. Both per-side checks fire.

### Why ADDITIVE not breaking

This milestone follows the ADR-0215 ADDITIVE precedent (not the ADR-0210/0211/0214 breaking-rename precedent). Per-side flags are semantically DIFFERENT operations from global flags — they assert different things. A breaking rename of global `actorPresence` → `actorPresenceX` would lose the global symmetric semantic ("both events"). Operators who want symmetric assertion continue to use global; operators who want asymmetric assertion use per-side.

## Use cases unblocked

**1. Migration-to-human handoff verification**

```bash
# A is the migration script's system event, B is the human adjustment:
crossengin retention diff-history $migration_event $adjustment_event \
  --system-only-a --no-system-b --with-actor-names
# Asserts A is system-authored AND B is human-authored.
```

**2. Human-to-automation handoff**

```bash
# A is incident responder's manual opt-out, B is the system sweep:
crossengin retention diff-history $manual_opt_out $sweep_event \
  --no-system-a --system-only-b --kind-not policy_deleted
```

**3. Compose with kind expectations**

```bash
# A is human-authored opt_out_set, B is system-authored policy_deleted:
crossengin retention diff-history $id_a $id_b \
  --kind-a opt_out_set --no-system-a \
  --kind-b policy_deleted --system-only-b \
  --with-actor-names
```

**4. Compose with actor expectations**

```bash
# A is Alice's human mutation, B is system event (NOT Bob):
crossengin retention diff-history $id_a $id_b \
  --actor-id-a $alice --no-system-a \
  --system-only-b --actor-id-not-b $bob
```

**5. Symmetric assertion via per-side flags (more explicit than global)**

```bash
# Equivalent to --system-only but explicit per-side:
crossengin retention diff-history $sweep_a $sweep_b \
  --system-only-a --system-only-b
# Both per-side checks fire; both must pass.
```

## Drawbacks

1. **4 new flags adds CLI surface** — diff-history now has 17 expectation-check flags (5 global + 8 per-side from ADR-0215 + 4 per-side actor-presence from this milestone) plus `--with-actor-names`. Operators reading helpText face a long list. Mitigated by grouping in helpText: actor-presence pair grouped together, A's flags grouped together, B's flags grouped together.
2. **Intra-side mutual exclusivity at CLI not adapter** — adapter's `actorPresenceA: ActorPresenceFilter | undefined` makes invalid state unrepresentable; CLI validates the 4 boolean flags before constructing the 2 union values. Direct adapter caller bypassing CLI cannot construct invalid state. CLI-bypassing scripts must replicate the intra-side mutual exclusivity check at their layer (same caveat as ADR-0209/0212/0215).
3. **Two-boolean JSON echo per side** — envelope shape diverges from adapter shape (boolean pair per side on JSON, single string union per side on adapter). Matches global `systemOnly`/`noSystem` convention from ADR-0209/0212.
4. **No CLI-side validation of global + per-side contradictions** — operators combining global `--system-only` with per-side `--no-system-a` produce a contradiction at the data layer. Global check fires first; operator sees global error. Same stance as ADR-0205/0215 contradictory-combination ordering.
5. **Composition explosion** — operators combining all 17 expectation flags + 4 new per-side actor-presence flags can construct elaborate assertions. Check ordering documented in ADR; operators see first-failing error.
6. **Per-side actor-presence positioned LAST in check sequence** — operators combining many flags might expect actor-presence per-side errors to surface earlier. Documented; sequence matches global-before-per-side + actor-dimension-after-kind-dimension ordering.

## Alternatives considered

1. **Two separate boolean field pairs on adapter** (`systemOnlyA?: boolean` + `noSystemA?: boolean` + ...) — allows invalid both-true state per side. Discriminated union per side (`actorPresenceA?: ActorPresenceFilter`) makes invalid states unrepresentable. Rejected; matches ADR-0209/0212 stance.
2. **Single combined `actorPresence` field at type level** with 4-value union (`"system_only" | "no_system" | "system_only_a" | "system_only_b" | ...`) — combinatorial explosion (system_only_a + no_system_b would need 4×4=16 string values). Per-side fields cleaner.
3. **`--side-A-presence <only|exclude>` parameterized flag** — unusual flag form; verbose. CLI flag pair per side matches ADR-0212 global pattern + ADR-0215 per-side pattern. Adopted.
4. **CLI-side global + per-side contradiction error** — operators may legitimately script with both flags always set (different from "set both intentionally"); adapter surfaces clear error from whichever check fires first. Same stance as ADR-0205/0215.
5. **Ship per-side multi-value (multiple `actor-presence` values per side)** — actor-presence is intrinsically boolean, not multi-value. N/A.
6. **Implement as positional `<A-presence> <B-presence>` arguments** — unusual flag form; non-composable with other flags. Rejected.
7. **Adapter-side mutual exclusivity check** between global + per-side — operator intent ambiguous; CLI passes both to adapter; adapter runs both checks; error fires from whichever fails first. Cleaner.
8. **Validate per-side actor-presence against actor_id BEFORE the per-side specific actor checks** — would interact awkwardly with `--actor-id-a <uuid>` (assertions on A's actor_id). Current ordering: actor-id checks first, then actor-presence. Operator sees actor-id mismatch before actor-presence assertion. Acceptable.

## Open questions

1. **Per-side `--system-only-X` + per-side `--actor-id-X` contradiction detection** — `--system-only-a --actor-id-a <uuid>` is impossible (system actors have null actor_id). Currently both checks fire; first-failing surfaces error. Could add CLI-side detection. Defer.
2. **JSON envelope unification** — currently boolean pair per side; could unify with discriminated string per side. Operators write conditional jq branches per shape today. Defer (would be breaking).
3. **Apply per-side actor-presence to retention diff-timeline** — diff-timeline is a list-style query not per-event-pair comparison; per-side doesn't apply. N/A.
4. **Apply per-side actor-presence to retention history** — same; list-style query. N/A.
5. **Short-circuit LEFT JOIN when `actorPresenceA === "system_only"`** — system events have no user row; per-side optimization. Pairs with ADR-0212 Q3 + ADR-0213 Q5 family. Defer.
6. **Combined per-side actor-presence + actor-id consistency check** (e.g., assert "A is system AND no actor_id check is meaningful") — operators can express via not setting `--actor-id-a`. Defer.

## Implementation outline

Three additive code changes:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - `DiffHistoryEntriesInput` gains 2 new optional fields `actorPresenceA?` + `actorPresenceB?: ActorPresenceFilter`. ADDITIVE — no breaking rename.
   - 2 new per-side check blocks in `diffHistoryEntries`, each positioned immediately after the existing global `actorPresence` block (at the end of the actor dimension chain). Each throws with explicit "event A" / "event B" error format using established asymmetric rendering (positive shows actual UUID, negative shows `<system>` placeholder).

2. **`apps/architect-cli/src/retention.ts`**:
   - 4 new flag parses in `runRetentionDiffHistory`: `getBooleanFlag` for `--system-only-a`, `--no-system-a`, `--system-only-b`, `--no-system-b`.
   - Intra-side mutual exclusivity checks: both A flags set → exit 2; both B flags set → exit 2. A's and B's flags don't interact.
   - Translate to 2 `actorPresenceA` / `actorPresenceB` union values.
   - Thread to `retention.diffHistoryEntries(...)` adapter call.
   - JSON envelope gains 4 new boolean fields matching CLI flag names verbatim.

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention diff-history` usage line extended with `[--system-only-a | --no-system-a] [--system-only-b | --no-system-b]` notation.
   - Description block extended explaining per-side actor-presence semantic + intra-side mutual exclusivity + A's-and-B's-flags-don't-interact composition.

## Tests

10 new adapter tests in a new "PostgresTraceRetention.diffHistoryEntries per-side actorPresence expectation checks (M6.7.zz.tenant.opt-out.cli.diff-history.per-side.system-only)" describe block:

1. `--system-only-a` accepts when A has null actor_id (regardless of B).
2. `--system-only-a` throws when A has UUID with actual UUID in error.
3. `--no-system-a` accepts when A has UUID actor (regardless of B).
4. `--no-system-a` throws with `<system>` rendering when A is null actor_id.
5. `--system-only-b` throws when B has UUID (B side independent of A).
6. `--no-system-b` throws with `<system>` rendering when B is null actor_id.
7. Canonical asymmetric pattern: `--system-only-a + --no-system-b` accepts when A=null, B=UUID.
8. Composition: global `--system-only` fires BEFORE per-side `--no-system-a` (global error first).
9. Omits per-side actor-presence checks when fields not set (backward compat).
10. Per-side A fires BEFORE per-side B in check order.

13 new CLI tests in a new "runRetention diff-history per-side --system-only / --no-system (M6.7.zz.tenant.opt-out.cli.diff-history.per-side.system-only)" describe block:

1. Exit 2 when `--system-only-a` AND `--no-system-a` both set with explicit error.
2. Exit 2 when `--system-only-b` AND `--no-system-b` both set.
3. `--system-only-a` + `--no-system-b` allowed (different sides, asymmetric assertion).
4. Threads `actorPresenceA: "system_only"` when `--system-only-a` set.
5. Threads `actorPresenceA: "no_system"` when `--no-system-a` set.
6. Threads `actorPresenceB: "system_only"` when `--system-only-b` set.
7. Threads `actorPresenceB: "no_system"` when `--no-system-b` set.
8. Omits per-side actorPresence fields when neither set (backward compat).
9. Composes with global `--system-only` + per-side `--no-system-a` (both threaded; global fires first at adapter).
10. JSON envelope echoes `systemOnlyA + noSystemA + systemOnlyB + noSystemB` booleans.
11. JSON envelope all per-side actor-presence booleans false when none set.
12. Adapter per-side error propagates as exit 1 with per-side error format.
13. Intra-side mutual exclusivity check fires BEFORE PG adapter call (capture length 0).

cli.ts helpText extended for retention diff-history usage line with `[--system-only-a | --no-system-a] [--system-only-b | --no-system-b]` notation + 4-line description explaining per-side actor-presence + intra-side mutual exclusivity + A's-and-B's-flags-don't-interact + per-side-fires-after-global semantic.

Test count: 9,045 → 9,068 (+23 net: adapter +10, CLI +13).

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green (no new errors from this milestone; pre-existing `labelForIndex` + `chat.ts` errors unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

The retention diff-history surface now has the COMPLETE per-side expectation-check matrix — 5 dimensions × 3 modes (global symmetric + per-side A + per-side B) = 15 expectation-check flag families plus `--with-actor-names`:

| Dimension | Global | Per-side A | Per-side B |
|---|---|---|---|
| event_kind positive | `--kind` (ADR-0198) | `--kind-a` (ADR-0215) | `--kind-b` (ADR-0215) |
| event_kind negative | `--kind-not` multi (ADR-0214) | `--kind-not-a` multi (ADR-0215) | `--kind-not-b` multi (ADR-0215) |
| actor_id positive | `--actor-id` (ADR-0203) | `--actor-id-a` (ADR-0215) | `--actor-id-b` (ADR-0215) |
| actor_id negative | `--actor-id-not` (ADR-0205) | `--actor-id-not-a` (ADR-0215) | `--actor-id-not-b` (ADR-0215) |
| system presence | `--system-only` / `--no-system` (ADR-0212) | `--system-only-a` / `--no-system-a` (ADR-0216) | `--system-only-b` / `--no-system-b` (ADR-0216) |

Plus `--with-actor-names` (ADR-0204) for display.

Operators have unprecedented control over per-event-pair forensic assertions on the cross-event policy diff surface — symmetric (both events) AND asymmetric (per-side) expectations across kind + actor + system-presence dimensions in a single command. The matrix is now fully symmetric: every dimension has both global symmetric and per-side asymmetric variants.

Natural follow-up milestones:
- **ADR-0203 Q2 / ADR-0205 Q1**: multi-value tuple expectations on actor-id positive/negative (assert "A must be one of N actors" / "all events must be one of N actors").
- **ADR-0198 Q2**: multi-value tuple expectation on `--kind` positive (assert "both events must be one of N kinds").
- **Per-side multi-value variants**: combine ADR-0215 per-side pattern with future multi-value tuple expectations.

The retention CLI now has 18 actions with the most comprehensive multi-flag coverage in the codebase. The per-side asymmetric expectation-check matrix on diff-history is COMPLETE for the 5 actor + kind dimensions.
