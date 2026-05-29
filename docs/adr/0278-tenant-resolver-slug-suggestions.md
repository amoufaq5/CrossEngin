# ADR-0278: Auto-suggest similar slugs on `resolveTenantIdentifier` failure

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-29 |
| **Authors** | CrossEngin team |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Related** | ADR-0273 Q6 (closes), ADR-0275 Q3 (closes), ADR-0276 Q8 (closes), ADR-0277 Q6 (closes), ADR-0269/0270/0275/0276/0277 (host slug-resolution callers) |

## Context

ADR-0273 wired slug-to-UUID resolution into the two housekeeping
dashboards; ADR-0275 extended it to the three retention query
actions; ADR-0276 added the cross-dashboard `tenant
housekeeping` view; ADR-0277 added the standalone `tenants
resolve` helper. All five entry points share the same
`resolveTenantIdentifier(conn, value)` helper from
`apps/architect-cli/src/tenant-resolver.ts`, and all five
surface the same error on unknown slugs:

```
retention housekeeping: no tenant with slug 'acme-prdo' (use --tenant <uuid> or a valid slug from meta.tenants)
```

Four parallel ADRs deferred the typo-recovery question:

> "Auto-suggest similar slugs on resolve error — Levenshtein
> distance against `meta.tenants.slug` when resolve fails.
> Error becomes `no tenant with slug 'foo' — did you mean
> 'foo-prod', 'foo-bar'?` across all surfaces using
> resolveTenantIdentifier."

Real operator workflows pile evidence that this is a high-
value ergonomic gap:

1. **Interactive debugging** — operators inheriting a workspace
   try slugs like `acme-prod` and `acme-prdo` interchangeably
   from memory; without suggestions the failed lookup gives no
   hint that the resolver almost matched.
2. **Compliance audits** — auditors transcribing slugs from
   ticket comments + chat copy/paste hit transpositions like
   `foo-prdo` and `foo-prod` — currently they re-look-up
   `meta.tenants` manually.
3. **Onboarding** — new operators learning the slug taxonomy
   benefit from the substrate teaching them via "did you
   mean" responses instead of forcing them to memorize the
   full slug list.

The pattern is canonical — `git`, `npm`, `cargo`, `kubectl`,
and many other CLI tools surface "did you mean" suggestions
on close-match failures with Levenshtein distance ≤ 2 as the
de-facto threshold.

## Decision

When `resolveTenantIdentifier` fails to find a slug, run an
additional `SELECT slug FROM meta.tenants ORDER BY slug`
query, compute Levenshtein distance from the input against
each result, and append "did you mean 'a', 'b', 'c'?" hints
to the error message for slugs within distance 2 (sorted by
distance ascending then alphabetically, capped at 3
suggestions). When no slugs are within threshold the base
error remains unchanged. The new query fires ONLY on the
error path — UUID short-circuits and successful slug matches
are untouched.

### Algorithm

```ts
const MAX_SUGGESTION_DISTANCE = 2;
const MAX_SUGGESTIONS = 3;

export function levenshteinDistance(a: string, b: string): number {
  // Standard two-row DP, O(m × n).
}

export function findSimilarSlugs(
  input: string,
  candidates: ReadonlyArray<string>,
): string[] {
  const scored = candidates
    .map((slug) => ({ slug, distance: levenshteinDistance(input, slug) }))
    .filter((s) => s.distance > 0 && s.distance <= MAX_SUGGESTION_DISTANCE);
  scored.sort((a, b) =>
    a.distance !== b.distance
      ? a.distance - b.distance
      : a.slug.localeCompare(b.slug),
  );
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.slug);
}
```

### Threshold + limit choices

- **Distance ≤ 2** catches single-character insert/delete/
  substitute plus adjacent transpositions (which Levenshtein
  counts as distance 2). The same threshold `git` and `npm`
  use for their "did you mean" surface.
- **Limit 3** keeps the error message readable on narrow
  terminals. At distance 1 + 2 thresholds, 3 suggestions
  almost always include the intended target.
- **Sort by (distance ASC, slug ASC)** for stable output
  across runs — operators comparing CI logs side-by-side get
  byte-identical error strings when the candidate set is
  unchanged.
- **Exclude distance 0** since the caller already ran the
  exact-match query — adding an "exact match" suggestion to
  a failure would be wrong (the lookup HAD seen the row
  before and rejected it for some other reason, or the slug
  exists but the typo got past JS string equality somehow).
  Defensive filter.

### Query choice — bounded fetch over SQL-side fuzzy match

PG offers two relevant extensions:

- `fuzzystrmatch.levenshtein(a, b)` — could do the work
  server-side with a `WHERE levenshtein(slug, $1) <= 2 ORDER
  BY levenshtein(slug, $1) LIMIT 3`.
- `pg_trgm.similarity(a, b)` — trigram similarity with an
  index for very fast lookup at large tenant counts.

Both require extensions installed on the operator's PG
instance. Substrate doesn't currently require any non-stock
extensions (kernel-pg only needs `uuid-ossp` for v7 UUIDs
which is universal). Adding a dependency on `fuzzystrmatch`
just for typo suggestions on the error path is poor
proportionality. The chosen approach — fetch all slugs and
compute in JS — is:

- **Portable** — works on every PG instance from v14 onward.
- **Bounded** — meta.tenants at typical deployment scale is
  ≤ 100K rows; fetching 100K × 20-byte average slugs is
  ~2 MB transfer + ~100ms of Levenshtein computation in JS.
  Both are fine on an error path.
- **Documented** — operators with very-large-scale deployments
  (>100K tenants where the 2 MB transfer is undesirable on
  every failed slug attempt) can opt-in to `fuzzystrmatch`
  via a future Q.

### Defensive filtering

`findSimilarSlugs` is called via `(r) => r.slug`. Test
connections and degraded DB states may return rows without
a string `slug` field. The implementation filters with
`(s): s is string => typeof s === "string" && s.length > 0`
to skip those silently. The worst case is no suggestion,
which still gives operators the base error.

### Cross-surface effect

Because all 7 call sites consume `result.error` verbatim
(some with action-label prefix, none mutating the content),
the new "did you mean" hint surfaces uniformly across:

- `crossengin retention housekeeping --tenant <bad>`
- `crossengin gateway housekeeping --tenant <bad>`
- `crossengin tenant housekeeping --tenant <bad>`
- `crossengin retention list-policies --tenant <bad>`
- `crossengin retention history --tenant <bad>`
- `crossengin retention summary --tenant <bad>`
- `crossengin tenants resolve <bad>`

Zero new code at each call site. The unit tests in
`tenant-resolver.test.ts` are sufficient — adding integration
tests across the 5 entry points would be test bloat for a
purely propagating change.

## Rejected alternatives

1. **`fuzzystrmatch.levenshtein()` SQL-side** — requires the
   extension. Defer to a future Q if operators with
   100K+-tenant deployments report the transfer cost as
   problematic.

2. **`pg_trgm` trigram index** — same extension-dependency
   concern. Also fundamentally different algorithm (trigram
   similarity vs edit distance) so the suggestions would
   look different from the canonical `git`/`npm` style.

3. **Distance ≤ 1 threshold** — too narrow; misses adjacent
   transpositions like `foo-prdo` ↔ `foo-prod` (distance 2)
   which is exactly the common typo class operators hit.

4. **Distance ≤ 3 threshold** — too broad; would surface
   unrelated slugs that just happen to share a prefix.
   `git` settled on distance ≤ 2 after experimentation;
   following that convention.

5. **Damerau-Levenshtein** (transposition as distance 1) —
   marginally better fit for transpositions but adds a
   third row to the DP and more code complexity for an
   edge case. Pure Levenshtein at threshold 2 catches the
   same cases.

6. **Show all suggestions, no cap** — at very-close-prefix
   matches the error would have 10+ slugs which hurts
   readability. 3 is the canonical cap.

7. **Sort by alphabetical only** — would surface 3 unrelated-
   alphabetically-close slugs over 3 close-distance ones.
   Distance-first ranking matches operator intent ("show
   me the closest matches").

8. **Cache slugs across resolver calls** — premature
   optimization; suggestions fire on error path only and
   the cache invalidation question (when do new tenants
   land?) adds complexity. Future Q if measured slow.

9. **`fuzzystrmatch` opt-in via env var** — split-code-path
   complexity for marginal benefit. Defer until a single
   approach is justified.

10. **Render suggestions as a bulleted list on stderr** —
    the existing error format is a single string consumed
    by 7 call sites that prepend action labels and print
    via `printError`. Inline `— did you mean 'X', 'Y'?`
    fits cleanly into that format. Multi-line rendering
    would force per-call-site formatting changes.

11. **Surface `meta.tenants` count in error when no
    suggestions** — verbose; operators wanting that info
    already have `crossengin tenants list`.

12. **Skip suggestions entirely on the resolver path —
    require operators to run `tenants list` first** —
    inverts the canonical CLI ergonomic. The suggestion
    surface is exactly the value-add operators want
    inline.

## Drawbacks

- **One extra PG query on the error path** — bounded by
  meta.tenants size; documented future Q for very-large
  deployments wanting `fuzzystrmatch` integration.
- **2 MB worst-case transfer** at 100K tenants × 20-byte
  slugs — fine on error path, would be unacceptable on
  hot path. Documented.
- **JS-side Levenshtein O(m × n)** runs ~100K times at
  100K tenants — ~100ms total, fine on error path.
- **Threshold = 2 is a fixed magic number** — operators
  who want a tighter/wider threshold for their workflow
  can't override. Future Q for `--suggest-distance N`
  flag if requested.
- **Suggestions only appear when at least one slug is
  within distance 2** — operators with very long or
  unusual slugs may hit failure cases where no suggestion
  surfaces. The base error remains; the suggestion
  surface is opt-in by closeness.
- **No-suggestion fallback is silent** — operators don't
  see "no similar slugs found" because the existing error
  already conveys "no tenant with slug 'X'". Adding the
  silent path explicitly would be noise.
- **Cross-surface assertion strategy is unit-test-only** —
  the existing tests for 7 call sites still assert
  `error.toContain("no tenant with slug 'X'")` which my
  prefix-preserving change leaves intact. Confidence in
  per-call-site rendering rides on the contract that
  callers concatenate `error` verbatim.
- **Defensive filter for undefined slugs** — handles fake-
  connection cases at the cost of one extra `filter`
  pass. The branch is unreachable in production where
  PG always returns string rows for non-null TEXT
  columns; the filter is a test-harness convenience.

## Future Qs

1. **`fuzzystrmatch.levenshtein()` SQL-side for very-large
   deployments** — `WHERE levenshtein(slug, $1) <= 2 ORDER
   BY levenshtein(slug, $1) LIMIT 3` would avoid the
   2 MB transfer cost; gate on extension availability via
   `pg_extension` lookup at resolver bootstrap.

2. **`--suggest-distance <n>` CLI flag** — operators
   wanting tighter or wider suggestions could override
   the default threshold. Defer until operator demand
   emerges.

3. **`--no-suggest` / `--suggest=false` CLI flag** —
   operators piping errors into automation that parses
   specific error strings might want to disable the hint.
   Defer.

4. **Cache the candidate slug list across calls** — when
   resolver is called more than once in a single command
   (rare today; happens in `tenant housekeeping` which
   runs both gateway and retention dashboards via one
   slug). Defer until measured slow.

5. **Surface suggestion confidence in JSON** — `tenants
   resolve --format json` could emit `{action,
   error: "...", suggestions: [{slug, distance}]}` for
   programmatic consumers. Defer until measured demand.

6. **Apply to other slug-or-uuid resolver paths** — when
   future substrates accept slug-or-UUID input (e.g.,
   pack slugs, workflow definition keys), the
   `findSimilarSlugs` helper is reusable. Pattern set
   for future resolvers.

7. **Damerau-Levenshtein for transposition fidelity** —
   marginal correctness improvement. Defer until
   operators report transpositions as confusing.

8. **Localized "did you mean" wording via i18n** — the
   current string is English. The CLI surface is
   English-only today; revisit when i18n lands more
   broadly.
