# ADR-0277: `crossengin tenants` standalone subcommand (list + resolve)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0273 Q3 (closes), ADR-0275 Q6 (closes), ADR-0276 (sibling `tenant` singular subcommand), ADR-0269/0270/0271 (host slug-resolution pattern) |

## Context

After M4.14.o/m wired slug acceptance into the
housekeeping dashboards + the three retention query
actions (list-policies, history, summary), operators
had three new operational gaps:

1. **Slug discovery** — operators inheriting a
   workspace had no CLI path to enumerate slugs.
   Reading raw SQL from `meta.tenants` worked but
   required PG-shell access.
2. **Pre-resolution for scripted workflows** —
   shell pipelines like `for slug in $(cat
   slugs.txt); do crossengin gateway housekeeping
   --tenant $slug; done` invoked the full slug
   resolver for every iteration. A one-shot
   `slug → UUID` helper would let scripts resolve
   once then use UUIDs.
3. **Compliance audit operator surveys** —
   "show every tenant with a per-tenant policy on
   workflow_traces" required a JOIN against
   `meta.tenant_retention_policies` that operators
   wrote manually.

ADR-0273 Q3 + ADR-0275 Q6 explicitly carved out
this gap:

> "Expose `crossengin tenants list` or `crossengin
> tenants resolve <slug>` standalone commands —
> operators wanting to enumerate or pre-resolve
> slugs without invoking a dashboard."

The `tenants` (plural) namespace is reserved for
**collection-level** tenant operations, distinct
from `tenant` (singular) from M4.14.l which holds
**per-tenant** actions (housekeeping, future
lifecycle/policies).

## Decision

Add a new top-level `crossengin tenants` (plural)
subcommand with two actions in v1:

### `tenants list`

Enumerates tenants from `meta.tenants` with
optional filters:

- `--status <s>` — narrows to one of the 4 values
  matching the schema CHECK (`active` /
  `suspended` / `archived` / `deleted`). Invalid
  value exits 2 with explanatory error listing
  the valid set.
- `--table-filter <name>` — narrows to tenants
  with a per-tenant policy on that specific
  table. Implemented as a parameterized `EXISTS
  (SELECT 1 FROM meta.tenant_retention_policies p
  WHERE p.tenant_id = t.id AND p.table_name = $N)`
  subquery — operators don't need to know the
  JOIN syntax.
- `--has-overrides` — narrows to tenants with at
  least one per-tenant policy on any table.
  Implemented as the same EXISTS subquery without
  the table predicate.

When both `--table-filter` and `--has-overrides`
are set, `--table-filter` wins (it's strictly
narrower). The renderer surfaces this in the
filter suffix as `table=<name>` only.

Output ordering: `ORDER BY t.slug` — operators
reading the table or piping JSON get stable diff-
able output across runs (slug is UNIQUE +
operator-friendly; UUID would sort by random v7
prefix which is less useful for human comparison).

Output:
- **Human** — table with `id | slug | name |
  status | tier` columns + filter suffix in the
  header + per-column width auto-sizing + empty-
  result placeholder `(no tenants match)`.
- **JSON** — envelope `{action: "tenants.list",
  count, tenants: TenantRow[]}` where each row
  contains the 5 columns.

### `tenants resolve <slug|uuid>`

One-shot slug→UUID lookup helper for shell
scripting. Reuses the M4.14.o
`resolveTenantIdentifier` helper:

- UUID-shaped input short-circuits (zero PG cost).
- Slug-shaped input runs the same `SELECT id FROM
  meta.tenants WHERE slug = $1` as the housekeeping
  dispatchers.
- Unknown slug exits 2 with `no tenant with slug
  '<input>'` error.

Output:
- **Human** — JUST the UUID + newline. This is
  the load-bearing design choice: shell pipelines
  like `crossengin tenants resolve acme-prod | xargs
  -I {} crossengin gateway housekeeping --tenant {}`
  work without `jq` or text munging. The brevity
  is intentional.
- **JSON** — envelope `{action:
  "tenants.resolve", input, tenantId}` — the
  `input` echo lets consumers correlate when
  batching.

## Rejected alternatives

1. **`crossengin tenant list / resolve` (singular)**
   — would conflate collection-level operations
   with per-tenant actions in the same subcommand.
   Plural for collection / singular for
   per-tenant follows established REST + CLI
   conventions.

2. **`crossengin tenants get <slug|uuid>`** vs
   `resolve` — `get` implies returning the full
   row; `resolve` is specifically about the
   slug→UUID lookup operation. Future Q for a
   `tenants get` action returning the full
   TenantRow.

3. **Print the full TenantRow in human format for
   resolve** — would break the pipeline-friendly
   "just the UUID" contract. Operators wanting
   the full row use `tenants list` filtered by
   the slug they care about.

4. **Always emit JSON for resolve regardless of
   --format** — operators piping to `xargs`
   shouldn't need `jq` to extract the UUID. The
   human format IS the pipeline format.

5. **`--with-overrides` (verb-style flag) instead
   of `--has-overrides`** — minor naming nit;
   `has-overrides` reads more like an SQL
   predicate which is what it implements.

6. **Server-side `meta.tenant_summary` view that
   joins meta.tenants + meta.tenant_retention_policies**
   — adds a schema object for one CLI consumer.
   The EXISTS subquery in the CLI is simple
   enough; substrate stays narrow.

7. **`--limit N` + `--offset M` pagination** —
   `meta.tenants` is bounded at typical
   deployment scales (10K-100K tenants); a full
   list returns in ms. Operators wanting filtered
   subsets use `--status` / `--table-filter` /
   `--has-overrides`. Defer pagination until
   measured slow.

8. **`--sort-by name|status|tier`** — sorting by
   slug is stable + diff-friendly; alternative
   sorts are operator-side concerns (pipe through
   `jq sort_by`). Defer.

9. **Inline `tenants list` into the existing
   `retention list-policies --tenant` action** —
   different domains (collection vs filter). The
   `tenants` namespace keeps the surface
   discoverable.

10. **Skip `tenants resolve` and tell operators
    to wrap with `jq '.tenants[] | select(.slug
    == "X") | .id'` on the list output** —
    multi-step pipeline + requires `jq`. The
    one-shot helper is the operator-friendly
    surface.

## Implementation notes

The conn lifecycle is owned by the action via
`resolveConn(ctx, actionLabel)` — same
pattern as the other PG-using actions in this
codebase. Tests inject via
`ctx.pgConnectionOverride`.

`runTenantsResolve` reuses `resolveTenantIdentifier`
from `tenant-resolver.ts` verbatim (no
duplication). The output rendering is the only
action-specific behavior (UUID + newline for
human; JSON envelope for json).

`tenants` becomes the 12th top-level subcommand
(SUBCOMMANDS grows 14 → 15 with help/version
included). The cli.test.ts SUBCOMMANDS assertion
was updated to include "tenants" between
"tenant" and "workflow".

The `buildListQuery` SQL builder uses positional
parameterization for all user-supplied values
(`$1`, `$2`) — no string interpolation. Table
identifier `meta.tenant_retention_policies` is
hardcoded (not user-supplied) so it's safe to
inline.

## Tests

15 new tests in `apps/architect-cli/src/tenants.test.ts`:

- 2 dispatcher tests: missing action exit 2,
  unknown action exit 2
- 7 list tests: no-filter all-rows sorted by slug
  via JSON envelope assertion, --status threads
  as `t.status = $1`, invalid --status exits 2
  listing valid values, --table-filter threads
  as EXISTS subquery, --has-overrides threads as
  EXISTS without table predicate, --table-filter
  takes precedence over --has-overrides (single
  EXISTS in SQL), human-format renders sorted
  table with filter suffix + per-row fields,
  empty-result placeholder "(no tenants match)"
- 6 resolve tests: missing positional exits 2,
  UUID short-circuits (no PG round-trip verified
  via captured-queries-length-0), slug resolves
  + prints UUID + newline (captured query
  contains `SELECT id FROM meta.tenants WHERE
  slug`), unknown slug exits 2, JSON envelope
  includes action + input + tenantId

Plus 1 modified test in `cli.test.ts` (SUBCOMMANDS
expected-list now includes "tenants").

Workspace test count goes 9,685 → 9,700.

## Consequences

- Operators can discover slugs via `crossengin
  tenants list` without raw SQL.
- Shell pipelines pre-resolve slugs via
  `crossengin tenants resolve` for
  performance/auditability (slug→UUID lookup
  happens once per script invocation).
- Compliance audit queries like "every tenant
  with a per-tenant override on workflow_traces"
  are one command (`tenants list --table-filter
  workflow_traces`).
- The `tenants` namespace is reserved for future
  collection-level operations (`tenants
  delete-batch`, `tenants export`, etc.) without
  conflicting with the per-tenant `tenant`
  namespace from M4.14.l.
- Pure additive — no existing surface affected.

## Future Qs

1. **`crossengin tenants get <slug|uuid>`** —
   returns the full TenantRow as JSON envelope.
   Operators wanting more than just the UUID
   would use this. Defer until requested.
2. **`crossengin tenants policies <slug|uuid>`**
   — full per-tenant policy summary across all
   retention tables + cost ceilings + rate-limit
   overrides + etc. Sibling to `tenant policies`
   (singular) from ADR-0276 future Q3 — defer
   ownership of the action to whichever namespace
   ships it first.
3. **`crossengin tenants create / delete /
   archive`** — mutation actions. Significant
   substrate work + permission model. Defer.
4. **`--format csv` for tenants list** —
   operators piping to spreadsheets. Defer until
   demand.
5. **`--limit N` + cursor pagination** for very
   large tenant counts. Defer until measured
   slow.
6. **Auto-suggest similar slugs** on resolve
   error — pairs with ADR-0273 Q6 + ADR-0275 Q3
   + ADR-0276 Q8.
7. **`--name-pattern <regex>` filter on list**
   — operators wanting fuzzy name search. Defer.
8. **`tenants resolve <slug>` accepting comma-
   separated input for batch resolution**
   (`resolve acme-prod,beta-corp,gamma-inc`).
   Defer; current operator pattern is `xargs -n
   1` invocation.
