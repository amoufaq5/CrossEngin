# ADR-0185: `crossengin retention history --with-actor-names` actor display name surfacing (Phase 2 M6.7.zz.tenant.opt-out.history.actor-join)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0170 (retention history substrate) |

## Context

ADR-0170 shipped the append-only retention history audit log with `actor_id` (nullable UUID) capturing who performed each mutation. The existing CLI renders `<system>` for null actor + raw UUID otherwise. Operators reading raw UUIDs in the audit table — `actor=00000000-0000-4000-8000-000000000001` on every row — had no way to know who that actually was without a separate `SELECT * FROM meta.users WHERE id = ...` lookup. ADR-0170 listed Q9 explicitly:

> Q9: Actor display join — surface human names from meta.users via LEFT JOIN. Defer.

Real operator workflows getting tedious:
- Audit review: "who set this opt-out?" — operators copy UUID, query meta.users, find name, repeat
- Incident report: "show me Alice's last 10 mutations" — operators need to know Alice's UUID first
- Compliance attestation: "list every actor who modified the legal-hold tenant's retention" — operators export raw UUIDs then join externally

The `meta.users` table has existed in the substrate from M1 (kernel meta-schema) — operators just had no CLI surface bridging it to history queries.

## Decision

### CLI surface

```
crossengin retention history [...other flags...] [--with-actor-names]
```

Boolean flag. Default off — existing behavior preserved (raw UUID or `<system>`). With `--with-actor-names`, the adapter does a `LEFT JOIN meta.users` and returns `actorDisplayName` + `actorEmail` fields alongside `actorId`.

### Adapter

`ListOptOutHistoryInput` gains optional `joinActor?: boolean` field (default false). When set:

1. SQL adds `LEFT JOIN meta.users u ON u.id = h.actor_id`.
2. SELECT adds `u.display_name AS actor_display_name, u.email AS actor_email`.
3. Result entries include `actorDisplayName: string | null` + `actorEmail: string | null` fields.

When `joinActor` is false (default) or omitted:
- SQL omits the JOIN entirely.
- Result entries omit `actorDisplayName` + `actorEmail` (TypeScript optional `string | null | undefined`).

### LEFT JOIN semantic

`LEFT JOIN` (not `INNER JOIN`) deliberately:
- Preserves history rows even when the actor has been deleted from `meta.users` (orphan FK).
- Preserves history rows where actor_id is NULL (system actors).
- Operators never lose audit context due to user-row mutations.

When the user row exists but `display_name` is NULL (rare — meta.users has email NOT NULL but display_name nullable), the adapter returns `actorDisplayName: null` + `actorEmail: <email>`. The CLI's render layer falls back to email then to raw UUID.

### Adapter SQL aliasing

The history table is now aliased as `h` consistently (even when `joinActor` is false), with all WHERE-clause column references prefixed `h.`. This makes the JOIN-vs-no-JOIN paths share the same query shape modulo the LEFT JOIN + SELECT additions — easier to reason about and avoids any column-ambiguity surprise if `meta.users` adds new columns in the future.

The cursor-pagination inline subquery (`SELECT occurred_at FROM ... WHERE id = $N`) stays unqualified because it has its own FROM clause with no alias — `id` and `occurred_at` reference the inline subquery's table directly.

### CLI rendering rules

Human format (single line per entry):

| `actor_id` | `actorDisplayName` | `actorEmail` | Rendered as |
|---|---|---|---|
| NULL | — | — | `<system>` |
| present | present | — | `<display_name> (<uuid>)` |
| present | null | present | `<email> (<uuid>)` |
| present | null | null | `<uuid>` (no name; falls through) |
| present | absent (no --with-actor-names) | absent | `<uuid>` (no lookup) |

The `name (uuid)` format gives operators both the human-readable name AND the UUID for unambiguous identification. Stale audit logs reviewed years later still show the UUID even if the user has since been renamed.

JSON format: history entries include `actorDisplayName` + `actorEmail` only when `--with-actor-names` is set. Otherwise these fields are absent (not null). Operators detect feature use via `entries[0].actorDisplayName !== undefined`.

### Two-table join cost

Adding the LEFT JOIN on `meta.users(id)` against `tenant_retention_opt_out_history(actor_id)`:
- `meta.users.id` is the primary key — index-only lookup.
- LEFT JOIN doesn't add row-count expansion (1:1 by actor_id).
- One additional query plan node; negligible cost on typical history result sets.

For operators with millions of history rows + thousands of users, the LEFT JOIN is still index-only and bounded by the LIMIT clause. No materialization concerns at typical scales.

## Use cases unblocked

**1. Audit-review readability**

```bash
crossengin retention history --tenant <uuid> --with-actor-names --limit 50
# actor=Alice Smith (00000000-...)  ← immediately recognizable
```

**2. Per-actor compliance report**

```bash
crossengin retention history --tenant <regulated-tenant> --with-actor-names --format json | \
  jq '.entries[] | "\(.occurredAt) \(.eventKind) by \(.actorDisplayName // .actorEmail // "system")"'
```

Produces a human-readable changelog without lookup boilerplate.

**3. Orphan-actor detection**

```bash
crossengin retention history --with-actor-names --format json | \
  jq '.entries[] | select(.actorId != null and .actorDisplayName == null and .actorEmail == null) | .actorId' | sort -u
# Lists actor UUIDs that don't resolve in meta.users (FK orphans).
```

**4. Backward-compat for raw-UUID consumers**

Pipelines parsing existing JSON output without `actorDisplayName` continue to work — fields are absent unless `--with-actor-names` is set, no schema-shift surprise.

## Drawbacks

1. **Cross-schema dependency.** Adapter SQL now references `meta.users` directly. If operators deploy `tenant_retention_opt_out_history` without `meta.users` (very unusual but possible in custom test fixtures), `--with-actor-names` would fail at query time. Documented; not a regression because the substrate ships both tables together.
2. **No multi-tenant filtering on users.** `meta.users` is platform-wide (one user can be a member of multiple tenants via `user_tenant_membership`). The join doesn't scope users by tenant — a cross-tenant actor (e.g., a platform admin) appears with the same display_name in all tenants' history. This matches operator intent ("who did this action?") but means the substrate doesn't enforce tenant-scoped actor visibility. RLS on `meta.users` (if enabled) would still apply.
3. **No email fallback in JSON envelope shape — caller composes preference order.** The adapter returns both `actorDisplayName` and `actorEmail`; the CLI rendering picks one. Programmatic consumers via JSON make their own choice. Documented as a contract.
4. **Always uses `h.` SQL aliasing.** Existing test assertions checking for bare-column SQL substrings broke and were updated. Minor migration cost for callers verifying the SQL shape directly (none outside our tests).
5. **No `--actor-name <name>` filter** for "show only Alice's mutations." Operators filter at the jq layer for now.
6. **One JOIN per query.** Operators iterating with pagination + `--with-actor-names` get the JOIN cost N times across N pages. Bounded — meta.users lookup is index-only — but operators with very large cohorts might prefer to fetch all rows first then look up actors in one batch. Future Q if measured.

## Alternatives considered

1. **CLI-side `--users-file <path>` JSON map** instead of SQL JOIN — operators maintain a separate file; substrate stays uncoupled from `meta.users`. Rejected — meta.users exists in the substrate; using it is the canonical path.
2. **INNER JOIN instead of LEFT JOIN** — would silently drop history rows with orphan FK or NULL actor_id. Rejected — preserves audit completeness.
3. **Substrate change with always-on JOIN** (no `--with-actor-names` flag, JOIN always present) — adds query cost to every history call. Rejected — opt-in keeps the default cheap.
4. **Add `actorDisplayName` to the existing JSON envelope unconditionally** (null when no lookup) — changes JSON shape for backward-compat callers. Rejected — conditional emission preserves the existing shape.
5. **New `retention history-with-actors` action** — adds CLI surface. Rejected — flag-on-existing matches the `--vs-platform` / `--cross-table` / `--add-tenant` precedent.
6. **Return only `actorDisplayName` (omit `actorEmail`)** — operators wanting email fallback can't get it. Rejected — both fields cheap to emit.
7. **`display_name <email>` format** (email in angle brackets) — mixes with `<system>` placeholder syntax. Rejected — `display_name (uuid)` parens disambiguates.
8. **Display only `display_name` without UUID** — strips audit-trail context for compliance reviews. Rejected — UUID disambiguation matters for forensic accuracy.
9. **Cache user lookups across paginated calls** — operator-side concern; substrate stays stateless. Rejected.

## Open questions

1. **`--actor-id <uuid>` filter** to scope history to one actor's mutations. Pair with `--with-actor-names` for "show all of Alice's mutations with her name shown." Defer.
2. **`--actor-name-equals <name>` filter** (substring or exact match against display_name). Operators currently jq-filter the JSON output; defer.
3. **Show user status alongside name** (`active` / `suspended` / `deleted`) — useful for compliance to see "this action was done by a now-suspended user." Defer.
4. **Display user's tenant_membership role** (e.g., `Alice (erp_admin)`) — would need additional JOIN to `meta.user_tenant_membership`. Different scope; defer.
5. **Surface actor names in other audit surfaces** (`retention restore` history rows, future audit logs). Pattern set; replicate in future milestones.
6. **`--actor-name-pattern <regex>`** for pattern-based filtering. Defer — operators use jq.
7. **Pretty-printed actor format option** (e.g., just `<display_name>` without UUID for narrow terminals). Defer — `--with-actor-names` is opt-in; operators wanting it can also wrap output with `cut`/`awk`.
