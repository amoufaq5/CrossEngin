# ADR-0209: `crossengin retention history --system-only` / `--no-system` actor-presence filter (Phase 2 M6.7.zz.tenant.opt-out.cli.history.system-only)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0186 (--actor-id filter), ADR-0206 (--actor-id-not filter), ADR-0170 (history audit log), ADR-0185 (--with-actor-names) |

## Context

The retention history audit log distinguishes two actor kinds: rows where `actor_id` carries a UUID (human or service-account authored mutations) and rows where `actor_id IS NULL` (system-initiated mutations from the substrate's own background jobs — prune sweeps, scheduled retention runs, automated expiry lifts). Operators reading audit logs have legitimate "show only X" and "exclude all X" workflows for both kinds:

1. **System-only audit** — "show me every mutation made by the substrate itself" (operators verifying prune-run health, debugging scheduled-job behavior, reconciling expected automation activity against the audit log).
2. **Human-only audit (no-system)** — "show me every mutation made by a human operator or service account" (compliance reviewers who need to inventory operator activity excluding noise from automated maintenance; HIPAA/SOC 2 auditors asking "who CHOSE to opt-out tenant X" — system rows are policy state, human rows are the deliberate choice).
3. **Forensic discipline during incidents** — "this was supposed to be a human-authored change; show me everything that touched this tenant where the actor was NOT system" (incident responder confirming a state change was operator-driven not automated drift).
4. **Compliance attestation excluding automation** — "every mutation under regulatory review must be human-authored; export with --no-system + jq to produce the attestation pack."

Until this milestone, operators jq-filtered for these cases (`--format json | jq '.entries[] | select(.actorId == null)'` for system-only, `select(.actorId != null)` for no-system) — same LIMIT correctness + pagination correctness + index-usage problems that ADR-0186 (--actor-id filter) and ADR-0206 (--actor-id-not filter) closed for value-based actor filtering: substrate-side WHERE is the only way to get all three right.

The `--system-only` and `--no-system` flag pair has been listed as a deferred future Q across FOUR retention ADRs:

| ADR | Future Q text |
|---|---|
| ADR-0186 (--actor-id filter) | "`--system-only` flag for actor_id IS NULL" |
| ADR-0193 (diff-timeline --actor-id) | "`--system-only` flag for actor_id IS NULL" |
| ADR-0205 (diff-history --actor-id-not) | "`--system-only` + `--no-system` flags for explicit null actor_id matching" |
| ADR-0206 (history --actor-id-not) | "`--system-only` + `--no-system` explicit null actor_id matching" |
| ADR-0207 (diff-timeline --actor-id-not) | "`--system-only` + `--no-system` explicit null actor matching" |

M6.7.zz.tenant.opt-out.cli.history.system-only ships the flag pair on the `retention history` surface — single-surface delivery matching the per-surface milestone pattern established by ADR-0205/0206/0207. Diff-history and diff-timeline variants follow as separate milestones with the same flag names + adapter contract + mutual-exclusivity rule.

## Decision

### CLI surface

```
crossengin retention history [--tenant <uuid>] [--table <name>]
                             [--kind <event-kind>]
                             [--actor-id <uuid>] [--actor-id-not <uuid>]
                             [--system-only | --no-system]   # NEW
                             [--since DATE] [--until DATE] [--limit N]
                             [--after-id <uuid>] [--before-id <uuid>]
                             [--range <after-id>..<before-id>]
                             [--with-actor-names]
                             [--format human|json]
```

- `--system-only` boolean flag — filters to events where `actor_id IS NULL` (substrate-authored).
- `--no-system` boolean flag — filters to events where `actor_id IS NOT NULL` (human / service-account authored).
- Mutually exclusive at the CLI boundary — both set returns exit 2 with `--system-only and --no-system are mutually exclusive` error before any PG query (CI logs say "exit 2" immediately recognizable as misuse).
- Either flag composes with every existing filter (`--tenant`, `--table`, `--kind`, `--actor-id`, `--actor-id-not`, `--since`, `--until`, `--limit`, `--after-id`, `--before-id`, `--range`, `--with-actor-names`).

### Composition with --actor-id / --actor-id-not

- `--system-only --actor-id <uuid>` is contradictory at the data layer (system events have `actor_id IS NULL`; `--actor-id` requires a specific UUID) — substrate returns empty silently (SQL natural outcome, both clauses fire independently). CLI doesn't pre-empt because operator-supplied combinations may evolve and an explicit error here would block valid edge cases.
- `--system-only --actor-id-not <uuid>` is redundant but valid (system events are NEITHER any specific UUID by definition; both clauses pass).
- `--no-system --actor-id <uuid>` is the canonical "human X's mutations" idiom (both clauses fire; `actor_id = $N` implies `IS NOT NULL` so `--no-system` is redundant but harmless).
- `--no-system --actor-id-not <uuid>` is the canonical "human mutations excluding X" idiom — distinguished from `--actor-id-not <uuid>` alone (which includes system events alongside non-X human events).

The CLI keeps the surface minimal — no contradictory-combination preempting — substrate returns empty for impossible combinations and clear results for valid ones.

### Adapter changes

New exported `ActorPresenceFilter` discriminated string union:

```ts
export type ActorPresenceFilter = "system_only" | "no_system";
```

`ListOptOutHistoryInput` gains optional `actorPresence?: ActorPresenceFilter` field. Discriminated string union over two booleans because:

1. **Mutual exclusivity is enforced at the type level** — impossible to express "both at once" in the adapter input.
2. **Adapter consumers see a clean 3-state choice** — `actorPresence` is `"system_only" | "no_system" | undefined`.
3. **CLI translates the two boolean flags into the single union value** after the mutual-exclusivity check.

Adapter SQL adds one of two conditional WHERE clauses (no parameters needed — `IS NULL` / `IS NOT NULL` are SQL constructs not value comparisons):

```ts
if (input.actorPresence === "system_only") {
  conditions.push(`h.actor_id IS NULL`);
} else if (input.actorPresence === "no_system") {
  conditions.push(`h.actor_id IS NOT NULL`);
}
```

Position: immediately after the `actorIdNot` filter clause, before `--since` / `--until` time-range clauses — matches existing actor-dimension grouping in the WHERE-clause assembly.

### Why substrate-side not jq-side

Three reasons identical to ADR-0186 + ADR-0206 actor-filter milestones:

1. **LIMIT correctness** — `--limit 100 --system-only` returns 100 system-authored entries from PG; jq-side post-filter returns fewer than 100 (filter bites into the page).
2. **Cursor-pagination correctness** — `--after-id <id> --system-only` walks forward through system-only events; jq-side filter would interact wrongly with the page boundary.
3. **Index usage** — PG can use the existing `actor_id` index (partial index on `IS NULL` is a future Q if measured slow); jq filtering can't.

### JSON envelope

Gains two boolean fields matching the existing `withActorNames` boolean-echo pattern from ADR-0185:

```json
{
  "tenantFilter": null,
  "tableFilter": null,
  "eventKind": null,
  "actorId": null,
  "actorIdNot": null,
  "systemOnly": true,
  "noSystem": false,
  "since": null,
  ...
}
```

- `systemOnly: true` when `--system-only` set, `false` otherwise.
- `noSystem: true` when `--no-system` set, `false` otherwise.
- Mutual exclusivity at CLI guarantees both are never `true` simultaneously.
- Operators jq-branch on `if .systemOnly then ... elif .noSystem then ... else ... end`.

Two-boolean echo (not a single discriminated string) matches existing CLI-flag-echo convention: every CLI flag has a corresponding envelope field with the same boolean-or-null-or-string shape. Operators reading the envelope see the literal flag state.

### Help text

Retention history usage line extended with `[--system-only | --no-system]` notation indicating mutual exclusivity. Description block adds 3 lines explaining the semantic:

```
--system-only returns ONLY system-authored events
(actor_id IS NULL); --no-system EXCLUDES system events
(actor_id IS NOT NULL). --system-only and --no-system are
mutually exclusive.
```

## Use cases unblocked

**1. System-authored maintenance audit**

```bash
# Show every system-authored mutation in the last 24 hours:
crossengin retention history --system-only --since 24h-ago --limit 200
```

**2. Human-only compliance attestation**

```bash
# Quarterly audit: all human-authored mutations on the regulated tenant:
crossengin retention history --tenant <regulated-uuid> --no-system \
  --since 2026-04-01 --until 2026-06-30 --with-actor-names \
  --format json > q2-2026-human-audit.json
```

**3. Forensic incident scoping**

```bash
# Was this state change human-driven? Show non-system mutations during the window:
crossengin retention history --tenant <suspect-uuid> --no-system \
  --since incident-start --until incident-end --with-actor-names
```

**4. Substrate-job health monitoring**

```bash
# Count system-authored events by kind for the dashboard:
crossengin retention history --system-only --since 7d-ago \
  --format json | jq '.entries | group_by(.eventKind) | map({kind: .[0].eventKind, count: length})'
```

**5. Compose with actor exclusion**

```bash
# Human mutations excluding the migration SA:
crossengin retention history --no-system --actor-id-not <migration-sa-uuid> \
  --since migration-start --with-actor-names
```

## Drawbacks

1. **Single-surface delivery** — only `retention history` this milestone. Diff-history (`--system-only` as expectation check "both events must be system" / `--no-system` "neither is system") + diff-timeline (multi-value or single-value filter across all 3 dispatch paths) are deferred to future milestones following the established per-surface ADR-0205/0206/0207 precedent.
2. **No partial index on `actor_id` IS NULL** — PG does an index scan + sort on the existing `actor_id` index for system-only queries. Acceptable at typical scales (system rows are a small fraction of audit log volume). Future Q if measured slow.
3. **Mutual exclusivity enforced at CLI not adapter** — adapter's discriminated string union type prevents both-at-once expression; CLI validates the two flags before translating. A direct adapter caller bypassing the CLI cannot construct an invalid state (type system enforces). But an adapter caller mapping operator flags themselves must replicate the mutual-exclusivity check at their layer.
4. **Two-boolean JSON echo when adapter uses discriminated string** — CLI envelope shape diverges from adapter shape. The two-boolean form matches the literal flag state operators typed and pairs with the existing `withActorNames` boolean echo. Adapter callers reading the envelope translate back via `if systemOnly then "system_only" elif noSystem then "no_system" else undefined`. Documented as the CLI-layer convention.
5. **No `--system-only` with `--actor-id <uuid>` validation** — contradictory combination returns empty silently (system events have `actor_id IS NULL` which never equals a UUID). Operators see empty result and notice. Substrate stays minimal; explicit pre-emption rejected for blocking edge cases.
6. **System events appear unconditionally in `--actor-id-not <uuid>` results from ADR-0206** — that's by design (ADR-0206 explicitly includes system events via `IS NULL OR != $N`). The new `--no-system` flag is the opt-out path for operators wanting human-only — pair `--actor-id-not X --no-system` for "exclude X, exclude system."
7. **No CLI-side validation of `--system-only` without `--system-only` companion arg** — boolean flag, no value to validate. Operators pass `--system-only` (no value) or omit; consistent with `--with-actor-names`.

## Alternatives considered

1. **Two separate boolean fields on adapter** (`systemOnly?: boolean` + `noSystem?: boolean`) — allows invalid both-true state at the type level. Adapter would need defensive both-true check. Discriminated string union (`actorPresence?: "system_only" | "no_system"`) makes invalid states unrepresentable. Rejected two-field.
2. **`--actor-presence <only|exclude>` single flag with enum value** — operators have to remember the enum vocabulary instead of natural boolean flags. `--system-only` and `--no-system` are more memorable + more discoverable in helpText.
3. **`--system` and `--human` as flag names** — "human" is misleading (service accounts are also non-system but not human). `--no-system` makes the negation explicit and accurate.
4. **`--actor-id null` sentinel value** — overloads the `--actor-id` flag's string-UUID semantic. Operators parsing the help would expect a UUID, not the literal string "null." `--system-only` is unambiguous.
5. **CLI-side `--actor-id X --system-only` contradiction error** — would block valid edge cases (operator may script with both flags always set; substrate returns empty for the impossible combination — natural outcome).
6. **Substrate-side `--system-only` + `--no-system` mutual-exclusivity error in the adapter** — adapter's discriminated string union type makes the invalid state unrepresentable; CLI handles the mutual exclusivity at flag parsing. Cleaner.
7. **Two-value enum `--actor-presence required|excluded`** — operator vocabulary unusual; `--system-only` / `--no-system` are more natural.
8. **PG partial index on `actor_id` IS NULL in this milestone** — premature optimization without measurement. Schema migration concern. Defer.
9. **`--system-only` flag without a `--no-system` companion** — operators wanting "exclude system" would jq-filter post-fetch with the same LIMIT/pagination correctness problems. Ship both for symmetry; both fit one milestone (single adapter field, mutual-exclusive flag pair).
10. **Default `--no-system=true` so human-only is the implicit default** — silent behavior change for existing callers. Backward-incompatible. Rejected.

## Open questions

1. **`--system-only` / `--no-system` on `retention diff-history`** — expectation check semantic: `--system-only` asserts BOTH events are system-authored (both `actor_id IS NULL`); `--no-system` asserts NEITHER is system. Mirror of the `--actor-id` / `--actor-id-not` expectation check pattern. Defer; closes ADR-0205 future Q.
2. **`--system-only` / `--no-system` on `retention diff-timeline`** — substrate-side filter across all 3 dispatch paths (pair-wise + N-way + cross-table). Single-value or multi-value (multi doesn't make sense for boolean predicates; defer the multi shape). Defer; closes ADR-0207 future Q + ADR-0193 future Q.
3. **Partial index on `meta.tenant_retention_opt_out_history (actor_id) WHERE actor_id IS NULL`** — defer until measured slow at scale. Most operators run `--system-only` with `--limit 100` so index scan + sort is bounded.
4. **`--system-only` + `--with-actor-names`** — semantically meaningless (system events have no user row); adapter still LEFT JOINs and returns null `actorDisplayName` + `actorEmail`; harmless but wastes a JOIN. Future Q: short-circuit the JOIN at adapter when `actorPresence === "system_only"`. Defer.
5. **Boolean field on `actorId` filter parsing the literal value `"null"` or `"system"`** — overloads the `--actor-id` semantic. Rejected (see Alternatives 4). Documented as a recurring footgun operators might propose.
6. **Asymmetric `--system-only-a` / `--system-only-b` on diff-history** — per-side actor-presence assertion. Defer; pairs with deferred per-side `--actor-id-a` / `--actor-id-b` from ADR-0203 Q1.

## Implementation outline

Three additive code changes:

1. **`packages/kernel-pg/src/trace-retention.ts`**:
   - Export `ActorPresenceFilter = "system_only" | "no_system"` type.
   - `ListOptOutHistoryInput` gains optional `actorPresence?: ActorPresenceFilter` field.
   - New `if (input.actorPresence === "system_only")` block in `listOptOutHistory` immediately after the existing `actorIdNot` filter, before the `since` clause. Two branches: `system_only` adds `h.actor_id IS NULL` clause; `no_system` adds `h.actor_id IS NOT NULL`. No params added.

2. **`apps/architect-cli/src/retention.ts`**:
   - `runRetentionHistory` reads `systemOnlyFlag` + `noSystemFlag` via `getBooleanFlag`.
   - Mutual exclusivity check: both true → exit 2 with `--system-only and --no-system are mutually exclusive`.
   - Translate to `actorPresence: "system_only" | "no_system" | undefined`.
   - Thread `actorPresence` to `retention.listOptOutHistory(...)` adapter call.
   - JSON envelope gains `systemOnly: systemOnlyFlag` + `noSystem: noSystemFlag` boolean fields.

3. **`apps/architect-cli/src/cli.ts`**:
   - `retention history` usage line extended with `[--system-only | --no-system]` notation.
   - 3-line description added explaining null-actor filter semantic + mutual exclusivity.

## Tests

8 new adapter tests in a new "PostgresTraceRetention.listOptOutHistory actorPresence filter (M6.7.zz.tenant.opt-out.cli.history.system-only)" describe block:

1. Adds `h.actor_id IS NULL` WHERE clause when `actorPresence === "system_only"`.
2. Adds `h.actor_id IS NOT NULL` WHERE clause when `actorPresence === "no_system"`.
3. Omits actor-presence WHERE clause when `actorPresence` not set.
4. Adds no params for `IS NULL` / `IS NOT NULL` clauses (no placeholder pollution; LIMIT param position correctly assigned).
5. Composes with `tenantId` + `tableName` filters (system_only).
6. Composes with `actorIdNot` + `no_system` (both clauses present; redundant but valid).
7. Composes with `joinActor` + `actorPresence` (LEFT JOIN + `IS NULL` both present).
8. Returns rows with null `actor_id` when `system_only` filter matches.

9 new CLI tests in a new "runRetention history --system-only / --no-system" describe block:

1. Returns exit 2 when `--system-only` AND `--no-system` both set with `--system-only and --no-system are mutually exclusive` error.
2. Threads `actorPresence: "system_only"` to adapter when `--system-only` set.
3. Threads `actorPresence: "no_system"` to adapter when `--no-system` set.
4. Omits `actorPresence` when neither flag set (backward compat).
5. Composes with `--tenant` + `--system-only`.
6. Composes with `--actor-id-not` + `--no-system` (both threaded independently).
7. JSON envelope echoes `systemOnly: true` + `noSystem: false` when `--system-only` set.
8. JSON envelope echoes `systemOnly: false` + `noSystem: true` when `--no-system` set.
9. JSON envelope echoes both `false` when neither flag set.

cli.ts helpText extended for retention history usage line with `[--system-only | --no-system]` flag notation + 3-line description explaining IS NULL / IS NOT NULL semantic + mutual exclusivity.

## Acceptance

- `pnpm --filter @crossengin/kernel-pg test` green.
- `pnpm --filter @crossengin/architect-cli test` green.
- `pnpm -r typecheck` green across the workspace (no new errors from this milestone; pre-existing `chat.ts` readonly errors + `retention.ts` labelForIndex import conflict unchanged).
- `pnpm -r test` green across the workspace.

## Forward-looking

The retention history surface now has FIVE actor-related filter dimensions:

| Dimension | Filter | Semantic |
|---|---|---|
| Specific actor (positive) | `--actor-id <uuid>` (ADR-0186) | `WHERE h.actor_id = $N` |
| Specific actor (negative) | `--actor-id-not <uuid>` (ADR-0206) | `WHERE (h.actor_id IS NULL OR h.actor_id != $N)` |
| System presence (positive) | `--system-only` (this milestone) | `WHERE h.actor_id IS NULL` |
| System presence (negative) | `--no-system` (this milestone) | `WHERE h.actor_id IS NOT NULL` |
| Actor display | `--with-actor-names` (ADR-0185) | LEFT JOIN meta.users |

Plus the orthogonal filters (`--tenant`, `--table`, `--kind`, `--since`, `--until`, `--limit`, `--after-id`, `--before-id`, `--range`). Operators compose any subset for fine-grained forensic + compliance + maintenance workflows on the canonical audit-log surface.

The `--system-only` / `--no-system` family is now 1-of-3 surfaces:

- `retention history` — substrate-side filter (this milestone).
- `retention diff-history` — expectation check (ADR-0205 Q3 deferred).
- `retention diff-timeline` — substrate-side filter across all 3 dispatch paths (ADR-0207 Q3 + ADR-0193 Q deferred).

Subsequent milestones close the remaining two surfaces mechanically following the established per-surface precedent from `--actor-id-not` (ADR-0205 expectation check + ADR-0206 history filter + ADR-0207 diff-timeline multi-value filter).

The retention CLI now has 18 actions with `--system-only` / `--no-system` support shipped on the retention history surface — operators get first-class system-vs-human audit-log workflows without the LIMIT + pagination + index-usage correctness problems of jq-filter workarounds.
