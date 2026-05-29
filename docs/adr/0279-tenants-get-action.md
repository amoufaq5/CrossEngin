# ADR-0279: `crossengin tenants get <slug|uuid>` action

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0277 Q1 (closes), ADR-0278 Q6 (extends — applies suggestion pattern to a new caller), ADR-0277 (host `tenants` subcommand) |

## Context

ADR-0277 shipped `crossengin tenants` (plural) as the
collection-level namespace with two actions in v1 — `list`
(enumerate with filters) and `resolve <slug|uuid>` (one-shot
slug→UUID for shell scripting). The "full TenantRow for one
tenant" case was deferred as Q1:

> "`crossengin tenants get <slug|uuid>` — `get` implies
> returning the full row; `resolve` is specifically about
> the slug→UUID lookup operation. Future Q for a `tenants
> get` action returning the full TenantRow."

Three operator workflows accumulated demand:

1. **One-tenant audit** — operators investigating a
   specific tenant want all 11 META_TENANTS columns
   (region, schema_name, residency, search_locale,
   timestamps) without filtering `tenants list` output by
   slug then squinting at table-format alignment.
2. **Programmatic consumers** — compliance dashboards
   feeding tenant audit reports want a structured `{action:
   "tenants.get", tenant: TenantRowFull}` envelope they can
   reliably parse without correlating filter+row outputs.
3. **Resource-fingerprint diff** — operators tracking
   tenant-row drift across environments (staging vs prod)
   want a clean `tenants get --format json` snapshot to
   pipe into `diff`.

`tenants list --status active | jq '.tenants[] |
select(.slug == "acme-prod")'` works but (a) requires
fetching every active tenant just to project one row, (b)
loses the 6 columns `list` doesn't surface, and (c) makes
slug-typo detection impossible since `list` doesn't run
through `resolveTenantIdentifier`.

## Decision

Add `crossengin tenants get <slug|uuid>` as the third
action on the `tenants` namespace. Reuses the M4.14.o
`resolveTenantIdentifier` helper for slug resolution
(which means M4.14.j's "did you mean" slug-typo suggestions
surface automatically on slug miss). After resolution
runs `SELECT id, slug, name, status, tier, region,
schema_name, residency, search_locale, created_at,
updated_at FROM meta.tenants WHERE id = $1` to fetch the
full row.

### Output

- **Human** — multi-line `key: value` block with the 9
  most-essential fields (`id`, `name`, `status`, `tier`,
  `region`, `schema`, `created_at`, `updated_at` — slug
  is in the header line). Column-aligned `padEnd(11)`-
  style padding for visual scanability. Residency +
  search_locale deliberately omitted from human output
  to keep the block compact; operators wanting those
  use `--format json`.
- **JSON** — `{action: "tenants.get", tenant:
  TenantRowFull}` envelope where `TenantRowFull` has
  all 11 META_TENANTS columns. Operators correlate by
  the `action` discriminator.

### Failure modes — distinct error per input shape

- **Slug input, not found** — `resolveTenantIdentifier`
  returns `ok: false` with the M4.14.j-extended error
  including "did you mean 'X', 'Y'?" suggestions when
  available. Exit 2. Same error path as `tenants resolve`.
- **UUID input, not found** — `resolveTenantIdentifier`
  short-circuits with `ok: true` (UUID-shaped → no PG
  lookup); the subsequent `SELECT ... WHERE id = $1`
  returns empty; new error `no tenant with id '<uuid>'`.
  Exit 2. **Deliberately distinct from slug-not-found**
  so operators can tell input-shape from data-presence
  failures apart.

### Why two queries for slug input, one for UUID input

The natural shape — `resolveTenantIdentifier` returns
the UUID, then we `SELECT ... WHERE id = $1` — keeps
the resolver helper reusable across all 7 existing
callers without forking. UUID input hits the SELECT
directly (1 query, ~1ms); slug input does the resolve
SELECT then the get SELECT (2 queries, ~2ms). The
performance delta is irrelevant on an interactive
audit; the consistency win across the 7 resolver
callers is worth keeping.

Alternative single-query shape — `SELECT ... FROM
meta.tenants WHERE id = $1 OR slug = $1` — was
considered but rejected: it forces a CASE WHEN at the
UUID-discriminator boundary (do we trust the input to be
either-or? what about a slug that happens to be UUID-
shaped? what about UUID-shape but non-existent vs
slug-shape but matching that string by accident?). The
two-query approach is unambiguous.

### Why `TenantRowFull extends TenantRow`

The 5-field `TenantRow` from M4.14.k is the compact
shape `list` returns. `tenants get` returns 6 more
columns. Subtyping reflects the natural relationship:
every TenantRowFull IS a TenantRow with extra fields
(the 5 list-columns are a strict subset of the 11
get-columns). Operators consuming both surfaces can
write generic code against `TenantRow` and
discriminate to `TenantRowFull` when they need region/
residency/timestamps.

### Why timestamp `to_char(... AT TIME ZONE 'UTC')`

PG returns TIMESTAMPTZ as a `Date` object in
node-postgres by default, but the serialization to JSON
varies by Node version + locale + ISO 8601 representation
choice (milliseconds-or-not, T-vs-space, Z-vs-+00:00).
Forcing the cast in SQL to `'YYYY-MM-DDTHH24:MI:SS.MSZ'`
gives operators byte-identical output across all
environments. Slight cost: human format renders the
same ISO 8601 string. JSON consumers parsing strings
back to Date round-trip cleanly.

### Help text

Added to `apps/architect-cli/src/cli.ts` helpText
between `tenants resolve` and `workflow validate`:

```
  tenants get <slug|uuid>
                          Fetch one tenant's full record (all 11
                          META_TENANTS columns: id, slug, name,
                          status, tier, region, schema, residency,
                          search_locale, created_at, updated_at).
                          Resolves slug→UUID via the same path as
                          `tenants resolve` (inherits 'did you mean'
                          suggestions on slug typos). Unknown UUID
                          exits 2 with a distinct 'no tenant with id'
                          error. (requires PG env)
```

## Rejected alternatives

1. **Single SQL query with `WHERE id = $1 OR slug =
   $1`** — forces CASE WHEN on the UUID discriminator at
   the SQL layer; two queries with the resolver helper
   are unambiguous and reuse the same path as the 6
   other callers.

2. **`tenants get` returns only the 5 list columns** —
   would force operators to write JOIN against
   `meta.tenants` directly for region/residency/
   timestamps. The whole point of `get` is full-row
   audit; the action would be redundant with `list +
   jq` at 5 fields.

3. **Render residency + search_locale in human format
   inline** — residency is JSONB so it would either
   pretty-print across many lines (wrecking the
   compact block) or render as a one-liner JSON (which
   is hard to read at 100+ chars). Operators wanting
   structured residency use `--format json`. Documented.

4. **`tenants show` instead of `tenants get`** —
   "show" is occasionally used in CLIs (`kubectl show`,
   `docker show`) but "get" is the canonical noun-
   returning verb (REST `GET`, `kubectl get`, `gh repo
   get`). Sticking with the convention reduces
   operator surprise.

5. **Always emit JSON regardless of `--format` flag**
   — would break the cross-CLI convention where
   `--format human` is the default + the canonical
   output of every action. Human output for one row is
   not problematic on terminals.

6. **Exit code 1 for "no tenant with id"** — exit 1
   conventionally means "runtime/I/O failure" (PG
   connection refused, etc.); exit 2 means "operator
   misuse + invalid identifier." Unknown UUID is the
   latter — the input was syntactically valid but
   referred to no resource. Matches `tenants resolve`
   semantics for slug-not-found.

7. **CSV/TSV output for `tenants get`** — `get`
   returns one row by design; CSV would be a 2-row
   file (header + data) which adds zero value over
   human format. Operators wanting tabular use
   `tenants list`.

8. **No distinct UUID-not-found error** — the
   resolver could SELECT-by-id at resolve time and
   fold both errors into one. Rejected because (a) it
   forks the resolver shape for one caller, (b)
   operators value the distinction ("did I typo the
   UUID or is the tenant gone?").

9. **Render Date objects via JSON.stringify default**
   — environment-dependent serialization. The
   `to_char` SQL cast pins the format.

## Drawbacks

- **Two queries for slug input** — minor; ~1ms extra
  PG round-trip on an interactive audit path.
- **Help text grows by 7 lines** — acceptable; `tenants`
  now has three actions and operators benefit from
  per-action descriptions.
- **`TenantRowFull` shape exposed publicly** — the
  full schema becomes a CLI contract; future
  META_TENANTS column changes ripple to the envelope.
  Documented as a stability commitment.
- **`residency` typed as `unknown`** — JSONB shape is
  operator-defined per tenant (could be `{primary,
  failover}` or `{regions: [...]}` or
  `{regulatory_zone}`); the substrate doesn't
  prescribe. Operators consuming JSON envelope must
  narrow on their own schema.
- **Distinct UUID-not-found error means two error
  strings for the same conceptual failure** — but
  operators can tell typo-slug from typo-uuid apart,
  which is what we want.
- **No `--include <field-list>` filter** — operators
  always get all 11 fields. Future Q if operators
  want column projection (`tenants get acme-prod
  --include id,slug,region`).

## Future Qs

1. **`tenants get --include <field-list>`** — column
   projection for narrow audits. Defer until operator
   demand emerges.

2. **`tenants get --output yaml`** — YAML rendering
   of TenantRowFull with residency JSONB inline as
   YAML block. Defer.

3. **`tenants get --watch <slug|uuid>`** — live
   refresh during incident monitoring (operator sees
   timestamps update on each tick). Defer; the M4.14.w
   watch infrastructure could be reused.

4. **`tenants get --previous-revision <history-id>`**
   — surfaces a tenant's state at a past instant via
   an append-only `tenants_history` table that
   doesn't exist yet. Pairs with a future
   `meta.tenants_history` substrate.

5. **`tenants get <slug|uuid> <other-slug|uuid>`** —
   batch fetch returning multiple rows. Defer; shell
   loops over `tenants get` cover the common case.

6. **Surface `tenants get` errors as RFC 9457 problem
   details in JSON envelope** — would pair with
   API-gateway problem-detail format. Defer.

7. **`tenants describe` as a verbose alias** —
   `kubectl describe` is precedent. `tenants get` is
   the canonical name; consider an alias if operators
   confuse it with `kubectl`-style describes that
   include related-object summary.

8. **Apply the resolver pattern to other slug-or-UUID
   subjects** — pack slugs, workflow definition keys.
   The shared helper makes this nearly mechanical.
   Pairs with ADR-0278 Q6.
