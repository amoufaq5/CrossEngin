# ADR-0273: Housekeeping `--tenant <uuid|slug>` via `meta.tenants` lookup

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0269 Q3 (closes), ADR-0270 Q3 (closes), ADR-0271 Q3 (closes), ADR-0263 / 0264 (host housekeeping dashboards), ADR-0272 (composes with shutdown bridge under watch) |

## Context

ADR-0269/0270/0271 shipped `--tenant <uuid>` and
`--all-tenants` on both housekeeping dashboards.
Operators in the field reported that the UUID
requirement is friction during interactive debugging
sessions:

```
$ crossengin retention housekeeping --tenant 7f2c8a1b-3d4e-...
```

vs the workflow they actually want:

```
$ crossengin retention housekeeping --tenant acme-prod
```

The UUID copy-paste from `meta.tenants` to the
terminal is error-prone (one character off → "must be
a UUID" error → re-look-up). Operators using
`crossengin retention list-policies` already see slugs
in their output; consistency across CLI surfaces
matters.

All three ADRs explicitly carved out slug acceptance
as Q3: "accept slug (e.g., 'acme-prod') alongside UUID
on --tenant; CLI resolves to UUID via meta.tenants
SELECT before adapter call."

The discriminator design question: how to tell a slug
from a UUID? Two reasonable shapes:

- **Try UUID regex first; if no match, treat as slug** —
  short-circuit for UUIDs (zero PG cost), one extra
  SELECT for slugs.
- **Always slug; require explicit `--tenant-uuid` for
  UUID** — uniform path but forces every existing
  caller through the resolution.

Chose discriminator-by-shape because UUIDs are
machine-emitted (from `meta.tenants` exports, audit
logs, prior CLI output) and slugs are operator-typed.
The shape difference cleanly distinguishes the two
sources; short-circuiting UUIDs preserves existing
zero-PG-cost behavior for scripted callers.

## Decision

Widen `--tenant <value>` on both housekeeping
dashboards (`gateway housekeeping` + `retention
housekeeping`) to accept either a UUID OR a slug.
Resolution happens via a new shared helper
`resolveTenantIdentifier(conn, value)` in
`apps/architect-cli/src/tenant-resolver.ts`:

```ts
export async function resolveTenantIdentifier(
  conn: PgConnection,
  value: string,
): Promise<{ ok: true; tenantId: string } | { ok: false; error: string }> {
  if (UUID_REGEX.test(value)) {
    return { ok: true, tenantId: value };
  }
  const result = await conn.query<{ id: string }>(
    `SELECT id FROM meta.tenants WHERE slug = $1`,
    [value],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return {
      ok: false,
      error: `no tenant with slug '${value}' (use --tenant <uuid> or a valid slug from meta.tenants)`,
    };
  }
  return { ok: true, tenantId: row.id };
}
```

Resolution timing:

- **UUID-shaped value**: short-circuits without any
  PG round-trip. Existing scripted callers see zero
  performance change.
- **Slug-shaped value**: one extra `SELECT id FROM
  meta.tenants WHERE slug = $1` BEFORE the gather
  closure runs. Under `--watch`, the resolution
  happens ONCE before the loop starts — slug-to-UUID
  mapping is stable for the duration of the watch
  session (`meta.tenants.slug` is UNIQUE; a slug
  collision would be a separate substrate concern).
- **Unknown slug**: `ok: false` with explicit error;
  dispatcher exits 2 with `no tenant with slug '<value>'`
  message.

The discriminator is the UUID regex (case-insensitive
hex + hyphens in the canonical 8-4-4-4-12 shape). Any
input that matches the regex is treated as a UUID; any
input that doesn't is treated as a slug. This means a
malformed UUID (e.g., `00000000-0000-0000-0000-not-hex`)
falls through to slug lookup and surfaces as "no
tenant with slug" — operator-friendly on the typo
edge case.

The dispatchers move the `--tenant` parsing earlier
(only check that the flag is set + mutually exclusive
with `--all-tenants`) but DEFER resolution until after
the PG connection is established:

```ts
const tenantFlag = getStringFlag(command, "tenant");
// ... mutual exclusivity check ...
// ... PG conn setup ...
let tenantId: string | undefined;
if (tenantFlag !== null) {
  const resolved = await resolveTenantIdentifier(conn, tenantFlag);
  if (!resolved.ok) {
    printError(ctx.io, `<dashboard>: ${resolved.error}`);
    return 2;
  }
  tenantId = resolved.tenantId;
}
```

The mutual exclusivity check with `--all-tenants`
fires BEFORE PG resolution (no PG cost when both
flags are misused). The slug resolution itself
requires PG, so its error path runs after the PG
conn check fires.

Help text on both dashboards updated:

```
[--tenant <uuid|slug> | --all-tenants]
  ...
  --tenant accepts a UUID OR a slug from meta.tenants. UUIDs
  short-circuit; slugs resolve via one extra SELECT before the
  dashboard runs. Unknown slug exits 2 cleanly.
```

The JSON envelope continues to echo the RESOLVED UUID
in `tenantId`, NOT the operator's slug input. Operators
piping JSON between commands or comparing audit
exports get the canonical identifier — slug is
operator-facing convenience, UUID is the stable
identity.

## Rejected alternatives

1. **Always slug; explicit `--tenant-uuid` for UUID** —
   forces every existing caller through PG resolution.
   Scripted callers with UUIDs in their config files
   would pay one round-trip per call. Short-circuit
   on UUID shape preserves the existing zero-PG-cost
   path.

2. **CLI-side validation of slug shape before
   lookup** — `meta.tenants.slug` has no `CHECK`
   constraint on shape (just `UNIQUE` + `TEXT NOT
   NULL`). Operators with unusual slugs (e.g.,
   `acme.prod`, `customer_42`) shouldn't be blocked
   by a CLI-side regex that doesn't match the
   substrate's permissiveness. Let PG be authoritative
   on what's a valid slug.

3. **Cache the slug-to-UUID mapping across CLI
   invocations** — every command would need to read +
   refresh the cache; cache invalidation on slug
   changes is a separate substrate concern. Each
   command does one extra SELECT — bounded cost.

4. **Resolve slug to UUID server-side via a function
   call (e.g., `meta.tenant_by_slug(slug)`)** — adds
   a PG function to the substrate for one consumer.
   The direct SELECT is portable; if multiple
   consumers need the same lookup in the future a
   function is a reasonable refactor target.

5. **Surface BOTH the slug AND the resolved UUID in
   the JSON envelope** — operators piping JSON care
   about stable identifiers; surfacing both
   complicates the schema for marginal benefit.
   Operators wanting to know "what slug did the
   operator type?" can read it from their own
   command history.

6. **Lookup by slug OR display_name OR email** —
   `meta.tenants` doesn't have `display_name` or
   `email` (those live on `meta.users` /
   `meta.tenant_memberships`). Slug is the single
   canonical operator-friendly tenant identifier;
   matching by anything else would require multi-
   table JOIN logic that doesn't belong in a CLI
   helper.

7. **Resolve at CLI dispatch BEFORE the PG conn
   check** — the resolver needs PG to do the lookup;
   pre-resolution before PG check would require a
   separate connection just for the resolver. The
   resolver shares the same conn as the gather
   closure; one connection total.

8. **Skip the shared `tenant-resolver.ts` module +
   inline the logic in both dispatchers** — the
   logic is non-trivial (UUID regex + PG query +
   typed result) and identical across both surfaces.
   Sharing is justified by the complexity (vs the
   UUID_REGEX itself which was previously inlined
   in both files because it was a one-liner).

9. **Use `Identifier` as a union type
   (`{kind:"uuid",uuid}|{kind:"slug",slug}`) parsed
   at the CLI boundary, then a resolver that
   discriminates** — adds a type layer for a single
   internal helper. The runtime regex check is the
   simplest form.

10. **Allow `--tenant @<slug>` prefix syntax to
    explicitly request slug semantics** — operators
    would have to remember the prefix; UUIDs and
    slugs don't collide in practice (UUIDs are
    deterministic hex+hyphen). Auto-discrimination
    by shape is the operator-friendly default.

## Implementation notes

The shared resolver module is the first file in
`apps/architect-cli/src/` to be created specifically
for a cross-cutting helper across both housekeeping
dispatchers. The UUID_REGEX used to be duplicated in
each dispatcher; M4.14.o consolidates it into the
resolver since both files now go through it.

The unit tests for `tenant-resolver.ts` cover the
discriminator decision (UUID vs slug), the PG query
shape (verifies `SELECT id FROM meta.tenants WHERE
slug = $1` is issued with the correct param), the
unknown-slug error path, and the malformed-UUID-falls-
through-to-slug-lookup edge case.

The dispatchers' help text changes both the flag
syntax (`--tenant <uuid|slug>`) and add a description
note explaining the UUID vs slug discriminator + the
extra round-trip for slugs + the "unknown slug exits
2" guarantee.

The JSON envelope's `tenantId` field continues to
hold the RESOLVED UUID. This is deliberate — operators
running `crossengin retention housekeeping --tenant
acme-prod --format json | jq '.tenantId'` get the
UUID, which can be passed verbatim to subsequent CLI
calls or stored in audit exports without re-resolving.

The pre-existing M4.14.u/v tests that asserted the
old "must be a UUID" CLI-boundary error were updated
to assert the new slug-lookup-failure error path
(`no tenant with slug '<value>'`). Operators reading
the test code learn the M4.14.o semantic naturally.

## Tests

13 new tests:

- 6 unit tests in `tenant-resolver.test.ts`:
  - UUID-shaped value short-circuits (no PG query)
  - case-insensitive UUID acceptance
  - slug triggers `SELECT id FROM meta.tenants WHERE
    slug = $1`
  - unknown slug returns `ok: false` with explanatory
    error
  - unusual slug characters (dots, underscores)
    preserved
  - malformed UUID falls through to slug lookup
- 4 retention housekeeping integration tests
  (M4.14.o describe block):
  - slug resolves via meta.tenants and renders with
    resolved UUID
  - unknown slug exits 2 with explanatory error
  - UUID-shaped value bypasses slug lookup (verified
    via captured queries — no SELECT meta.tenants)
  - slug + `--all-tenants` still exits 2 (mutual
    exclusivity preserved across slug input)
- 3 gateway housekeeping integration tests (M4.14.o
  describe block):
  - slug resolves and renders with resolved UUID
  - unknown slug exits 2
  - UUID-shaped bypass

Plus 2 modified pre-existing tests on M4.14.u/v
describe blocks (assertion updated from "must be a
UUID" to "no tenant with slug").

Workspace test count goes 9,635 → 9,648.

## Consequences

- Operators using interactive debugging sessions can
  type `--tenant acme-prod` instead of looking up the
  UUID.
- Scripted callers with UUIDs in config files pay
  zero PG cost — the UUID short-circuit preserves
  existing behavior.
- JSON envelope continues to emit the resolved UUID
  in `tenantId` — operators chaining commands get
  the stable canonical identifier.
- The shared `tenant-resolver.ts` module is a
  foundation for any future tenant-identifier
  consumer (e.g., `crossengin retention summary
  --tenant <uuid|slug>` if that surface adopts the
  same pattern).
- Pre-existing behavior preserved end-to-end for all
  UUID-based callers; only new behavior is the slug
  fallback.
- The unknown-slug error path is loud and
  operator-friendly (vs the old "must be a UUID"
  error which was unhelpful to operators who typed
  a real slug they expected to work).

## Future Qs

1. **Resolve via `meta.tenants` AND `meta.users` /
   `meta.tenant_memberships`** — operators wanting
   "look up by email" or "by display_name" need
   multi-table JOIN logic. Out of scope for the
   housekeeping CLI; could be a separate
   `crossengin tenants resolve <input>` helper.
2. **Cache resolved slugs across `--watch` ticks** —
   already done implicitly (resolution is one-shot
   before the loop starts; the UUID is captured in
   the closure). If a slug-to-UUID mapping changes
   mid-watch (unlikely), the loop continues with the
   stale resolution. Future Q if that becomes a
   problem.
3. **Expose `crossengin tenants list` or `crossengin
   tenants resolve <slug>` standalone commands** —
   operators wanting to enumerate or pre-resolve
   slugs without invoking a dashboard. Defer until
   measured needed.
4. **`--tenant-set <file.csv>` cohort drill-down
   with mixed UUID + slug entries** — pairs with
   ADR-0269 Q5 + ADR-0270 Q4. The resolver handles
   per-entry already; the bulk variant would just
   iterate.
5. **Apply `--tenant <uuid|slug>` to other CLI
   surfaces** — `retention history`, `retention
   list-policies`, `retention summary`, etc. all
   currently require UUID. Mechanical extension via
   the shared resolver.
6. **Auto-suggest similar slugs on "no tenant with
   slug" error** (e.g., did-you-mean) — Levenshtein
   distance against `meta.tenants.slug`. Operator-UX
   polish; defer.
7. **`--tenant @file.txt` syntax** for reading the
   tenant identifier from a file. Operators wanting
   secret-like tenant IDs (audit pipelines that
   shouldn't leak into shell history). Defer.
8. **Soft-deprecate the UUID-only path with a
   warning** if measured that most operators prefer
   slugs. The discriminator allows both indefinitely;
   no need for deprecation today.
