# ADR-0206: `crossengin retention history --actor-id-not` actor exclusion filter (Phase 2 M6.7.zz.tenant.opt-out.cli.history.actor-not)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0186 (--actor-id positive filter on retention history), ADR-0205 (--actor-id-not expectation check on diff-history), ADR-0170 (history audit log) |

## Context

ADR-0186 shipped `--actor-id <uuid>` substrate-side WHERE filter on `retention history` for per-actor forensic + compliance workflows. ADR-0186 Q1 listed `--actor-id-not` exclusion filter as future work.

ADR-0205 just shipped `--actor-id-not` as an exclusion EXPECTATION CHECK on `retention diff-history` (the inverse of ADR-0203's positive expectation check). The semantic is different on diff-history (assert neither of 2 fixed events matches) vs retention history (filter OUT events matching the actor from the list query result). Both flags share the name `--actor-id-not` but have surface-appropriate semantics — operators reading either surface get consistent flag naming with surface-appropriate behavior.

The operational use cases for an exclusion FILTER on retention history:

1. **Service-account-free human audit** — `--actor-id-not <ci-sa-uuid>` returns the list of human-driven mutations only (system events with null actor_id still included).
2. **Suspended-user audit** — `--actor-id-not <suspended-actor>` excludes the suspended user's events to focus on remaining actor activity for the period.
3. **Self-exclude review** — operator reviewing their own tenant's activity excludes their own mutations: `--actor-id-not $MY_ACTOR_ID`.
4. **Compliance "non-automation" filter** — for regulatory frameworks requiring "human review" event lists, exclude the migration / sweep service accounts.

M6.7.zz.tenant.opt-out.cli.history.actor-not closes ADR-0186 Q1 + ADR-0205 Q6 by adding the substrate-side WHERE NOT filter to `retention history`.

## Decision

### CLI surface

```
crossengin retention history [--tenant <uuid>] [--table <name>] [--kind <event-kind>]
                             [--actor-id <uuid>]
                             [--actor-id-not <uuid>]   # NEW
                             [--since DATE] [--until DATE] [--limit N]
                             [--after-id <uuid>] [--before-id <uuid>]
                             [--range <after-id>..<before-id>]
                             [--with-actor-names]
                             [--format human|json]
```

- `--actor-id-not <uuid>` added as a single optional flag.
- Composes with all existing filters. NOT mutually exclusive with `--actor-id` — adapter applies both conditions independently (operator passing `--actor-id alice --actor-id-not bob` gets rows where actor_id = alice AND (actor_id IS NULL OR actor_id != bob) — Alice matches both, result includes Alice's events).
- Contradictory `--actor-id X --actor-id-not X` returns empty result (substrate doesn't enforce; the SQL `actor_id = X AND (actor_id IS NULL OR actor_id != X)` is unsatisfiable; empty result is the correct natural outcome).
- No CLI-side UUID validation (matches deferred decision across cursor + actor-filter ADRs).

### Adapter changes

`ListOptOutHistoryInput` gains optional `actorIdNot?: string` field. When set, the SQL WHERE clause gains:

```sql
(h.actor_id IS NULL OR h.actor_id != $N)
```

Two important details on this clause:

1. **Includes system events (null actor_id)** — `actor_id IS NULL` is explicitly OR'd in. PG's `actor_id != $N` returns NULL (not true) for null values, which would silently filter system events out. Operators using `--actor-id-not <alice>` expect "everything not authored by Alice" — including system events. The explicit IS NULL handles this.
2. **Substrate-side, not jq-side filter** — same three reasons as ADR-0186 positive filter: LIMIT correctness (--limit 100 returns 100 non-Alice entries from PG, not <100 after jq filtering), future cursor-pagination correctness, index usage if a future composite index is added on (actor_id, occurred_at).

Filter position is immediately after the positive `actorId` filter in WHERE-clause assembly — keeps actor-related clauses grouped + matches the natural ordering operators expect.

### Why "WHERE NOT" not "IS DISTINCT FROM"

PG offers `h.actor_id IS DISTINCT FROM $N` as a single-operator alternative that treats nulls as distinct from any value (returning true for nulls). Functionally equivalent to `(h.actor_id IS NULL OR h.actor_id != $N)`. We chose the explicit form for two reasons:

1. **Clearer intent** — operators reading the SQL immediately see "include nulls explicitly"; the IS DISTINCT FROM form requires PG knowledge to understand null semantics.
2. **Index usage parity** — both forms perform similarly in PG; explicit form composes cleanly if we add `(actor_id, occurred_at)` composite index later.

### Composition with --actor-id positive

When both `--actor-id` and `--actor-id-not` are set, both WHERE clauses fire independently:

```sql
WHERE h.actor_id = $N1 AND (h.actor_id IS NULL OR h.actor_id != $N2)
```

For most input combinations this is satisfiable:
- `--actor-id alice --actor-id-not bob` → returns Alice's events (Alice != Bob, so the IS DISTINCT clause passes)
- `--actor-id alice --actor-id-not alice` → contradictory → empty result (correct natural outcome; substrate doesn't enforce)

CLI doesn't enforce mutual exclusivity — operators can compose freely, contradictory combinations return empty results naturally (no error, no extra round-trip).

### JSON envelope

Gains `actorIdNot: string | null` field echoing operator's input:

```json
{
  "tenantFilter": null,
  "tableFilter": null,
  "eventKind": null,
  "actorId": null,
  "actorIdNot": "22222222-...",
  "since": null,
  "until": null,
  "afterId": null,
  "beforeId": null,
  "range": null,
  "limit": 100,
  "count": 47,
  "entries": [...]
}
```

Field positioned right after `actorId` in envelope for consistency with WHERE-clause ordering. When `--actor-id-not` not set, field renders `null`.

### No human-format change

The existing human-format table renders entries (one row per event); the exclusion filter affects WHICH rows are returned but not their rendering. No formatter changes needed.

## Use cases unblocked

**1. Service-account-free human audit**

```bash
# Show me all mutations on tenant X excluding CI automation:
crossengin retention history --tenant <tenant-uuid> --actor-id-not <ci-sa-uuid>
# Returns human-authored + system events; SA events excluded.
```

**2. Suspended-user activity audit**

```bash
# What did everyone else do during this period, excluding now-suspended user?
crossengin retention history --since 2026-05-01 \
  --actor-id-not <suspended-uuid> --with-actor-names \
  --format json | jq '.entries[].actorDisplayName' | sort | uniq -c
```

**3. Self-exclude operator review**

```bash
# What did others do to this tenant (exclude my own mutations)?
crossengin retention history --tenant <tenant-uuid> \
  --actor-id-not $MY_ACTOR_ID --with-actor-names
```

**4. Compliance non-automation filter**

```bash
# For Q1 audit: human review events only (exclude migration + sweep SAs):
# (Operators chain via shell when needing multi-exclusion; this flag is single-value.)
crossengin retention history --since 2026-01-01 --until 2026-03-31 \
  --actor-id-not <migration-sa-uuid> --format json \
  | jq '[.entries[] | select(.actorId != "<sweep-sa-uuid>")]'
```

## Drawbacks

1. **Single-value exclusion only** — operators wanting multi-exclusion run multiple commands or compose with jq. Multi-value exclusion via repeated flag using multiFlags from ADR-0183 deferred.
2. **Includes system events** — `--actor-id-not <uuid>` returns null-actor events (by design). Operators wanting "human-only no system events" need a separate flag (defer; operators jq-filter for now).
3. **Contradictory composition with --actor-id returns empty silently** — no error message; operators inspecting empty result need to check their flags. Acceptable since the contradiction is logically obvious (a = X AND a ≠ X is empty); explicit error path adds complexity for unlikely misuse.
4. **No CLI-side UUID validation** — invalid UUIDs hit PG with clearer error; matches established pattern.
5. **No --actor-id-not on diff-timeline** (yet) — this milestone only ships the filter on retention history; diff-timeline equivalent deferred (different surface, similar shape).
6. **No `--system-only` / `--no-system` flag** for explicit null actor_id matching/exclusion — operators jq-filter; defer.

## Alternatives considered

1. **CLI-side jq filter as documented workflow** — breaks LIMIT correctness + future cursor-pagination correctness; matches ADR-0186 rejection.
2. **Use `actor_id != $N` only without IS NULL OR** — silently excludes system events; operators expecting "everything not Alice" lose system events surprisingly. Rejected.
3. **Use `actor_id IS DISTINCT FROM $N`** — functionally equivalent but less clear to operators reading SQL. Adopted explicit form.
4. **Mutually exclusive with --actor-id at CLI boundary** — would block valid composition like "Alice's events but not on this date" (which makes sense as `--actor-id alice --since X --until Y`); contradiction surfaces as empty result naturally. Rejected mutual exclusivity.
5. **Multi-value via repeated flag from day one** — single-value is the common case; defer.
6. **Inverse flag named `--exclude-actor-id`** — verbose; `--actor-id-not` matches ADR-0205 convention. Rejected verbose form.
7. **Substrate-side validation rejecting contradictory --actor-id + --actor-id-not** — adds adapter input validation for an obscure case; SQL returns empty naturally. Rejected.
8. **Filter at result-mapping layer (after PG returns rows)** — same LIMIT correctness problem as jq-filter. Rejected.

## Open questions

1. **`--actor-id-not <a>|<b>|<c>` multi-value exclusion** ("exclude these N actors") via repeated flag using multiFlags infrastructure from ADR-0183. Defer until measured demand.
2. **`--system-only` + `--no-system` flags** for explicit null actor_id matching/exclusion. Defer; operators jq-filter for now.
3. **`--actor-id-not` filter on diff-timeline** across all three dispatch paths. Different surface, same shape. Defer; pairs with ADR-0193's positive filter on diff-timeline.
4. **`--kind-not` filter on retention history** for event-kind exclusion. Symmetric companion. Defer.
5. **Composite index on `(actor_id, occurred_at)`** for large-scale actor-scoped pagination performance. Defer until measured slow.
6. **`--actor-name-not <name>` filter via meta.users.display_name JOIN** for human-readable input. Pairs with ADR-0186 Q3. Defer.
