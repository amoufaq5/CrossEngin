# ADR-0186: `crossengin retention history --actor-id <uuid>` filter (Phase 2 M6.7.zz.tenant.opt-out.cli.history.actor-filter)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0170 (retention history substrate), ADR-0175 (cursor pagination), ADR-0185 (retention history --with-actor-names) |

## Context

ADR-0170 shipped 5 filter dimensions on `retention history` (tenant, table, kind, since, until). ADR-0175 added `--after-id` cursor pagination. ADR-0185 added `--with-actor-names` for human-readable actor display. ADR-0185 listed Q1 explicitly:

> Q1: `--actor-id <uuid>` filter to scope history to one actor's mutations. Pair with `--with-actor-names` for "show all of Alice's mutations with her name shown." Defer.

Real operator workflows getting tedious:
- Incident response: "show me everything actor X did in the last week" — operators fetch full history then jq-filter
- Compliance attestation: "what mutations did each compliance officer perform?" — operators run N queries (one per officer)
- Per-actor audit: "Alice approved 12 opt-outs last month; show them" — current workaround is `--format json | jq '.entries[] | select(.actorId == "...")'`

A single substrate-side filter eliminates the jq dance.

## Decision

### CLI surface

```
crossengin retention history [...other flags...] [--actor-id <uuid>]
```

`--actor-id <uuid>` is a string flag. When set, scopes history to mutations performed by that actor.

### Adapter

`ListOptOutHistoryInput` gains optional `actorId?: string` field. When set:
- SQL WHERE adds `h.actor_id = $N`.
- Index-scan on the existing `actor_id` column.

When omitted (default), no actor filter applied — existing behavior preserved.

### Filter position

`actorId` slots between `eventKind` and `since` in the WHERE-clause assembly order. This places actor-based filters near "who" semantically (tenant + table + kind + actor + time-range). The param-number sequence is `$1: tenantId, $2: tableName, $3: eventKind, $4: actorId, $5: since, $6: until, $7: afterId, $8: limit` when all set.

### Substrate-side, not CLI-side

The filter happens in PG via WHERE clause, not via post-fetch jq. Three benefits:
- LIMIT correctness — operators asking for `--limit 100 --actor-id <x>` get the latest 100 entries by that actor, not the latest 100 entries filtered to that actor (which may return <100).
- Cursor pagination correctness — `--after-id` semantics with `--actor-id` work intuitively (skip-then-filter-by-actor is wrong; filter-then-skip is right). Substrate-side filtering is the only way to get this right.
- Index usage — PG can use an index on (actor_id, occurred_at) if added; jq filtering can't.

### Composes with existing filters

`--actor-id` composes uniformly with every existing filter dimension:
- `--tenant` + `--actor-id` — actor's mutations on one tenant.
- `--table` + `--actor-id` — actor's mutations on one table.
- `--kind` + `--actor-id` — actor's mutations of a specific event kind.
- `--since` / `--until` + `--actor-id` — actor's mutations in a time range.
- `--after-id` + `--actor-id` — paginated actor-scoped history.
- `--with-actor-names` + `--actor-id` — actor-scoped + display-name surfacing (canonical "Alice's audit log" pattern).

### No null-actor filtering

Operators wanting "only system-actor events" (where `actor_id IS NULL`) jq-filter on `.actorId === null`. Three reasons:
- Substrate stays minimal — one filter per dimension, no sentinel values.
- Null is logically the absence of an actor, not a specific actor ID.
- jq idiom is one-liner: `crossengin retention history --format json | jq '.entries[] | select(.actorId == null)'`.

Future Q if measured demand.

### JSON envelope

The envelope gains an `actorId` field (string when `--actor-id` set, null when not). Operators piping through jq can branch on it. Position between `eventKind` and `since` matches the WHERE-clause order.

### Pure CLI delivery (modulo adapter input field)

The adapter gets one new field (`actorId?: string`). The CLI gets one new flag (`--actor-id`). No new types, no new helpers, no result-shape changes. Mechanical.

## Use cases unblocked

**1. Per-actor incident response**

```bash
crossengin retention history --actor-id <suspect-actor-uuid> --with-actor-names --since 2026-05-01
# Lists every mutation by that actor since May 1 with their display name.
```

**2. Compliance attestation per officer**

```bash
for officer in $(cat compliance-officers.txt); do
  crossengin retention history --actor-id "$officer" --tenant "$regulated-tenant" --format json
done | jq -s '[.[] | .entries[]] | sort_by(.occurredAt)'
```

Single command per officer, aggregated by jq.

**3. "What did Alice do in the last 7 days?"**

```bash
crossengin retention history \
  --actor-id "$alice_uuid" \
  --with-actor-names \
  --since "$(date -u -d '7 days ago' --iso-8601=seconds)"
```

Reads like English; output is a clean per-actor changelog.

**4. CI gate on unauthorized-actor mutations**

```bash
crossengin retention history --actor-id "$service_account_id" --since "$build_start" --format json | \
  jq '.entries | length'
# If > 0, an automated mutation occurred during the build window; investigate.
```

## Drawbacks

1. **No null-actor sentinel.** Operators wanting `actor_id IS NULL` filtering jq-filter. Documented.
2. **No `--actor-id-not <uuid>` exclusion.** Operators excluding one actor (e.g., "everything Alice didn't do") jq-filter. Defer.
3. **No multi-actor filter** (`--actor-id alice --actor-id bob`). Operators wanting "Alice OR Bob" run two commands and concatenate. Could use `multiFlags` infrastructure from ADR-0183 — defer.
4. **No `--actor-name-equals <name>`** for human-readable input. Requires actor → UUID resolution; operators look up UUIDs first. Future Q (paired with ADR-0185 Q2).
5. **Substrate-side index requirement** — `actor_id` filtering without a composite index `(actor_id, occurred_at)` does a sequence scan + sort. Defer until measured slow; meta-schema currently has no actor_id index on `tenant_retention_opt_out_history`.
6. **No validation of UUID shape** at CLI boundary — operators passing invalid UUIDs hit PG's error message rather than a CLI exit-2. Matches existing pattern from `--after-id` (ADR-0175) which deferred validation to PG.

## Alternatives considered

1. **CLI-side jq filtering as documented workflow** — keeps substrate minimal. Rejected — substrate-side filtering ensures LIMIT + pagination correctness; jq-side returns < N entries when filtering bites.
2. **`--actor-id-equals <uuid>` / `--actor-id-not <uuid>` pair** — overkill for v1; positive-only is the common case. Rejected — defer the not-equals variant.
3. **Multi-actor `--actor-id` repeated via `multiFlags`** — operators wanting OR-semantic across N actors. Pair-wise sufficient for now (run twice + concat); multi-actor defer.
4. **`--actor system` sentinel for null filtering** — overloads string semantic; null is a valid filter but doesn't need a sentinel. Operators jq-filter. Rejected.
5. **Add `actor_id` index in this milestone** — schema migration concern; defer until measured slow.
6. **`--actor-id-pattern <regex>`** for pattern matching — operators with structured ID schemes (uncommon). Defer.
7. **Implicit actor scoping via `--my`/`$CROSSENGIN_ACTOR_ID` env var** — operator-state-dependent magic; explicit `--actor-id` is clearer.
8. **Surface in JSON envelope as `actorFilter` (not `actorId`)** for naming consistency with `tenantFilter` / `tableFilter` — chose `actorId` because the per-entry `actorId` field already uses that name; envelope-level matches entry-level. Rejected the verbose form.

## Open questions

1. **`--actor-name-equals <name>` filter** that resolves through `meta.users.display_name` (requires JOIN — pairs with ADR-0185 `--with-actor-names` infrastructure). Future Q.
2. **Multi-actor via repeated `--actor-id`** using ADR-0183's `multiFlags` infrastructure. Operators with cohort audit needs would benefit; defer until measured demand.
3. **`--actor-id-not <uuid>`** for exclusion. Defer.
4. **Composite index on `(actor_id, occurred_at)`** for large-scale actor-scoped pagination. Defer until measured slow.
5. **CLI-side UUID validation** matching ADR-0175 deferred decision; PG gives clearer error.
6. **`--system-only` boolean flag** for `actor_id IS NULL` filtering. Defer — operators jq-filter; substrate doesn't need a sentinel.
7. **Surface `--actor-id` filter in audit-log diff actions** (e.g., `retention diff-history --actor-id <uuid>` filtering events by actor before diffing). Different surface; future ADR if requested.
