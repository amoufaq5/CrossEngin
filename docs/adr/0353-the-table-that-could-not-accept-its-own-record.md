# ADR-0353: The table that could not accept its own record

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-09 |
| **Authors** | platform |
| **Reviewers** | platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0300, ADR-0330, ADR-0332, ADR-0333, ADR-0334, ADR-0336, ADR-0337, ADR-0351, ADR-0352 |

## Context

ADR-0352 built the downstream half of "does the live catalog admit what this binary emits" and named
the upstream half as its first open question:

> the **contract → catalog** half is unbuilt and it is the *upstream* one — a value the contract can
> emit that the catalog's CHECK refuses ships in the artifact rather than being a migration state,
> which is what ADR-0300 and ADR-0334 each were.

The two halves are not symmetric and the asymmetry is the whole reason to build the second one.
Downstream, the catalog is right and the database is behind: a value the catalog has added since the
database was migrated is refused `23514` until an operator runs one `ALTER`. That is a property of a
*deployment*, it is recoverable, and ADR-0352's boot survey now reports it. Upstream, a disagreement
means the artifact itself cannot persist its own records. No migration fixes it, because there is
nothing to catch up to.

ADR-0352 also recorded two candidate members of the upstream class, and **both were wrong**. The
census that produced them read only named `export const X = [...] as const` arrays, which is not
where a column's domain always lives:

- **`REPORT_ENGINES` is `['postgres','clickhouse','auto']` and `meta.report_runs.engine`'s CHECK
  refuses `auto`.** True, and not a defect: the authoritative domain for that column is
  `ReportRunRecordSchema.engine`, which is `z.enum(["postgres","clickhouse"])` — an inline literal the
  census could not see. `BaseReportSchema.engine` defaults to `"auto"` because a report *definition*
  may ask the platform to choose an engine, and a run has a resolved one. The two schemas are
  correctly different.
- **`DIGEST_FREQUENCIES` has six members against `meta.notification_digests.frequency`'s four.** Also
  true, also not a defect: `DIGEST_WINDOW_MINUTES` answers `null` for `immediate` and `never`, so
  `buildDigestBatch` throws for both, `delivery-drain` returns before opening a batch, and
  `DigestBatchSchema` refuses them by name in a `superRefine`. The narrowing is enforced three times.

So the first finding of this increment is that the recorded findings were not findings. The second is
that the real ones were in a shape no test in the repo could have seen.

### `META_DEPLOYMENTS` could not accept a `DeploymentRecord`

`DeploymentRecordSchema` is `meta.deployments`' record, field for field — `appKind` → `app_kind`,
`environment`, `region`, `target`, `strategy`, `version`, `commitSha`, `trigger`, `status`. It is the
only thing that could ever be inserted into that table. Four of its seven enum fields emitted values
the table's CHECKs refused:

| column | the CHECK admitted | `DeploymentRecordSchema` emits | relation |
|---|---|---|---|
| `app_kind` | `docs_site`, `cdc_shipper`, `hl7_listener`, `virus_scanner`, `gpu_inference`, … | `docs-site`, `cdc-shipper`, `hl7-listener`, `virus-scanner`, `gpu-inference`, … | 6 of 9 differ, hyphen versus underscore |
| `environment` | `preview`, `staging`, `production`, `sandbox` | `local`, `preview`, `staging`, `production` | one each way |
| `target` | `vercel_edge`, `vercel_node`, `fly_machine`, … (10) | `vercel`, `fly_machines`, `supabase`, … (10) | **entirely disjoint** |
| `strategy` | `rolling`, `blue_green`, `canary`, `recreate` | `atomic`, `rolling`, `blue_green`, `canary` | one each way |

The other three value-set columns on that table — `region`, `trigger`, `status` — matched their
contracts exactly. The table was authored in pieces, at different times, against nothing.

Two things about this are worth more than the defect. First, **none of these is a subset or a
superset**, so every nesting test is structurally blind to them: a rule asking "can the contract emit
a value the CHECK refuses" by looking for strict supersets finds nothing here, and `target` — the
worst of the four — looks like two unrelated sets, which is exactly what it is. Second, the kernel
test standing over `target` read:

```ts
it("META_DEPLOYMENTS check-constrains target to the ten deploy targets", () => {
  expect(target?.check).toContain("'vercel_edge'");
  expect(target?.check).toContain("'fly_machine'");
  expect(target?.check).toContain("'helm_release'");
});
```

Three values no `DeployTarget` has ever had, asserted against the catalog that declared them. A test
comparing the catalog with itself, under a title naming the contract.

### Why the link has to be declared

Nothing in the text joins a contract enum to a catalogued column. The store's SQL names the column
and binds a parameter; which record field supplies that parameter is not visible to a scan. Two
derivations were built and measured against the real workspace, and both are refused on the numbers:

- **"no workspace domain may strictly exceed a CHECK's value set"** — **23 pairs over 15 columns, of
  which 0 are defects.** `meta.plans.billing_interval` is `['month','year']`, a strict subset of
  `@crossengin/reporting`'s `TIMESERIES_BUCKETS`. `meta.api_keys.status` is a strict subset of
  `SSO_SESSION_STATUSES`. `meta.webhook_endpoints.signing_algorithm` is `MAC_ALGORITHMS`, and
  `KEY_ALGORITHMS = [...MAC_ALGORITHMS, ...SIGNATURE_ALGORITHMS]` exceeds it *by spread
  construction*. Declaring 23 coincidences as exemptions is what the fourth meta-schema invariant
  refused for the cross-column type rule — it "would train people to add exemptions".
- **"a schema field whose name matches the column"** — **4,938 pairs over 180 columns**, because
  `status` is a field on 51 schemas and a column on 40 tables.

And exact set equality, which looks like it needs no declaration at all, is **unsound rather than
merely imprecise** — demonstrated on a real column. Before this change `meta.deployments.environment`
exactly equalled `@crossengin/feature-flags`' own environment enum and so read as accounted for,
while the record that table stores emits `@crossengin/deploy`'s `ENVIRONMENTS`. A vacuous pass on a
genuinely drifted column, which is the failure mode this directory exists to prevent.

## Decision

**Every catalogued value-set CHECK declares which contract domain governs it, and a sixth workspace
strategy rule compares the declaration against the workspace in both directions.**

`packages/testing/src/strategy/pg-value-set-domains.ts`. 287 declarations, one per CHECK, with no
optionality: a missing entry is a failure, not a silence. That is ADR-0334's rule — *location was
never what made `needsAuditEmitter` wrong, the absence of a both-ways comparison was* — applied to a
list the repo has to maintain anyway.

**Three link kinds, and `mirrors` asserts equality in both directions.** 281 of the 287 are
`mirrors`, which is what the four `meta.deployments` columns needed: a nesting test was blind to all
four, and an equality is not. `catalog_exceeds_contract` is reported alongside
`contract_exceeds_catalog` for exactly that reason — the first is harmless to a write and is still
the other half of the same divergence. There is deliberately **no fourth kind** for a catalog that
widens on purpose: it would ship with zero members, and a link kind nobody uses is a guess about a
case nobody has met. The finding names the condition if one arrives.

**`narrows` carries a machine-checked obligation.** `except` names the members the column does not
admit, so `domain \ except === check` is an equality and neither side can drift unnoticed, and
`guardedBy` names the symbol whose declaration refuses them — checked by requiring every `except`
member to appear as a quoted literal inside that symbol's own text. That is
`pg-unreachable-stores.ts`' `substitutedBy` shape, and it is what separates a narrowing somebody
enforces from a divergence somebody wrote a sentence about. One member today:
`meta.notification_digests.frequency`, guarded by `DigestBatchSchema`, whose `superRefine` names
`immediate` and `never` outright.

**`catalog_only` is contradicted by exact enumeration and not by overlap.** Five members, every one a
table `pg-storeless-tables.ts` already declares writerless for an independent reason — asserted as a
cross-rule join rather than left as prose, so writing a store for one of them fails the test and the
domain gets decided then —
`meta.api_keys` (`out_of_band`: credentials arrive through argv and are never persisted),
`meta.manifests` and `meta.ai_conversations` (`superseded`), `meta.scim_clients` and
`meta.sdk_client_installations` (`unbuilt_subsystem`). The contradiction is a domain that enumerates
*exactly* the CHECK, never one that merely contains it, because containment is the coincidence that
made the superset rule unusable.

**A ref is `<package>:<NAME>` or `<package>:<XSchema>.<field>`,** resolved from text at test time.
A constant where one is unambiguous and a schema field where it is not, because a field is what
actually produces the value — `meta.report_runs.engine` refs `ReportRunRecordSchema.engine`, not
`REPORT_ENGINES`. **29 of the 287** ref a schema field; the rest ref a constant. The resolver reads
three sites (`constant`, `schema_enum`, `schema_field`), follows spreads and aliases, and resolves a
name through the **import** that brought it in — load-bearing rather than tidy, because
`DATA_CLASSES` is declared in three packages and a workspace-unique lookup therefore gives up, so
without it `FileReferenceSchema.dataClass` resolves to nothing and `meta.files.data_class` has no
nameable domain at all. Module-private constants are read as resolution targets and withheld from the
candidate set, since a ref names something the package exports.

**The four `META_DEPLOYMENTS` CHECKs now spell what `@crossengin/deploy` declares.** Not a union of
the two: a CHECK that refuses every value its only possible writer can produce is not a constraint,
and the catalog's finer `vercel_edge`/`vercel_node` distinction lives in a CHECK that nothing reads
and no type expresses. The table is writerless in every deployment, so there is no data to preserve
and the reconciler plans the replacement under its emptiness guard.

**And one question in this class needs no declaration at all:** `auditColumnDefaults` asks whether
each column's own `default` satisfies its own `check`, because both halves are in the same
declaration. It passes for all 287 today, which is the cheapest moment a check like this will ever
have — `pg-storeless-tables.ts`' own argument, one question across.

## Alternatives considered

- **Option A: derive the CHECK from the contract enum, so the two cannot diverge.** `check:
  columnCheckIn("status", TENANT_LIFECYCLE_STATES)` in `meta-schema.ts`.
  - **Pros:** eliminates the duplication rather than fencing it, which is this repo's recurring rule
    — the honest fix sits one level up from where the pain was felt. The compiler becomes the fence:
    adding `"v4"` to an enum emits the widened CHECK in the same commit, and the upstream state
    becomes unreachable. Measured favourably on the two counts that looked fatal: **every
    exactly-matched column but one** agrees with its domain in *order* as well as membership, so the
    rendered SQL would be byte-identical except for `meta.workflow_events.kind` (two adjacent members
    swapped — **280 of 281**); and **261** of the domains live in packages `@crossengin/kernel` can
    import without a cycle, which corrects an earlier assumption that the dependency graph refused this
    outright — kernel already depends on `auth`, `files`, `i18n`, `integrations`, `jobs`, `reporting`,
    `search`, `types` and `views`, and no contracts package depends on kernel.
  - **Cons:** **it cannot be total.** The other **20** are in four packages that depend on kernel —
    `operate-server` (12), `ai-architect` (3), `observability-runtime-pg` (3), `crypto-pg` (2) — and
    twelve of them are in an *app*, which the kernel can never import. So the fence is needed for the
    remainder anyway, and a partial elimination plus a fence is strictly more machinery than a fence.
    It would also add **30** dependencies to the substrate — 35 packages hold a referenced domain and
    the kernel already depends on 5 of them — and 287 edits to the most sensitive file in the repo.
  - **Why not:** the advantage was totality and it is unavailable. A narrowing is also not expressible
    without a second mechanism, and six columns need one.
- **Option B: no declaration — report every workspace domain that strictly exceeds a CHECK.**
  - **Pros:** zero maintained list; the forcing function is automatic.
  - **Cons:** measured at 23 pairs over 15 columns with **0** defects among them, and 19 of the 23
    are coincidences a reader would have to be told to ignore. And it is blind to the defect that
    motivated the increment: `meta.deployments.target` is disjoint, not a superset, so the rule finds
    nothing there.
  - **Why not:** 0% precision on the one case that matters, and an exemption list of pure noise.
- **Option C: link by field name, with the column name snake-cased.**
  - **Pros:** semantic, cheap, no declaration.
  - **Cons:** 4,938 pairs over 180 columns.
  - **Why not:** `status`.
- **Option D: derive the link from exact set equality and declare only the exceptions.**
  - **Pros:** would have needed ~9 declarations rather than 287.
  - **Cons:** unsound, demonstrated on `meta.deployments.environment`, whose CHECK exactly equalled an
    *unrelated* package's enum while the record it stores emitted something else. Also masks: a column
    whose CHECK equals one domain and is exceeded by another reads as accounted for — which is where
    `meta.report_runs.engine` sat, correct for a reason the derivation could not know.
  - **Why not:** a derivation that can silently answer about the wrong domain is worse than a list,
    because its failure is a pass.
- **Option E: put the declaration on `ColumnDefinition` in the kernel, beside the `check` it is
  about.**
  - **Pros:** co-located, with no second place to forget; `renamedFrom` is precedent for declared
    metadata on a column.
  - **Cons:** a kernel contract change rippling into the differ, the reconciler, `check-admission.ts`
    and the column store, for a field the kernel emits nothing from — `renamedFrom` is read by the
    reconciler and *does work*, where this would be read only by a test. And the ref would still be a
    string, because the kernel cannot import all of the packages it names.
  - **Why not:** the co-location buys nothing the both-ways comparison does not already buy, at the
    cost of 287 edits to `meta-schema.ts` and a contract change.
- **Option F: declare the four `META_DEPLOYMENTS` columns as diverged-pending-ownership rather than
  fixing them,** the way ADR-0336 declined to resolve `packages/deploy`'s duplicate flag subsystem.
  - **Pros:** consistent with refusing to make a product decision on behalf of an unowned package.
  - **Cons:** there is no product decision here. The record schema is the only possible writer, so a
    CHECK refusing what it emits is wrong on the catalog's side by construction.
  - **Why not:** ADR-0336's case was two complete, incompatible *models*; this is one model and a
    constraint authored without reading it.

## Consequences

- **Positive:** the upstream state is now a test failure in the artifact. Of the three the repo found
  by hand, **ADR-0300's was this kind** — `FLAG_KINDS` had seven members and
  `meta.feature_flags.kind`'s CHECK had four, shipped that way, and nothing said so until a store was
  written for the table. ADR-0334's `pending_deletion` and ADR-0351's `'v4'` were the downstream
  kind, because the author edited the enum and the catalog in one commit; what this rule adds for
  those is that **forgetting the catalog half is now a failure at test time** rather than a defect
  found later, naming the column, the values and the remedy.
- **Positive:** `meta.deployments` can accept a `DeploymentRecord`. It could not before, on four of
  seven value-set columns, and nothing in the repo could have said so.
- **Positive:** two recorded findings are retired as non-findings, with the reason stated:
  `REPORT_ENGINES`/`auto` and `DIGEST_FREQUENCIES`/`immediate` are both correct, and both read as
  defects to a scan that cannot see an inline `z.enum` or a `superRefine`.
- **Positive:** the domain scan is total — 1,363 domains over 915 files with **zero** unresolved,
  which took import-following, alias resolution and module-private constants to reach. A rule with a
  silent could-not-read bucket is the next silence rather than the end of this one.
- **Negative:** 287 hand-owned declarations. A new catalogued value-set CHECK needs a line, and the
  rule says so by name. The generator that produced the first 287 is deliberately not kept:
  re-running it would recompute the links from whatever the enums say today, which is the thing the
  declaration exists to pin.
- **Negative:** the ref is a string, so a typo is caught by the test rather than by the compiler.
  `ref_unresolved` and `ref_ambiguous` are what make that acceptable.
- **Negative:** `catalog_exceeds_contract` makes `mirrors` stricter than safety requires. A catalog
  deliberately admitting more than the contract emits must either narrow or gain a link kind; today
  nothing is in that position.
- **Neutral, and it looked like a cost:** the four replaced CHECKs are drift on every already-applied
  deployment, which ADR-0352's boot survey reports as `refuses` — the two halves meeting, and the
  clearest demonstration either of them has. It needs **no manual SQL**, because a CHECK that refuses
  everything its only writer emits cannot have let a row in, so ADR-0330's emptiness guard always
  holds and the reconciler plans all four as `replace_column_check [guarded]`.

## Implementation notes

`parseCatalogSource` gained `check` and `defaultExpression` on `CatalogColumn` rather than growing a
second parser beside it, for `check-admission.ts`'s reason: one parser means the two rules cannot
disagree about what the catalog says. `isRequiredColumn` narrowed to `Pick<CatalogColumn, "notNull" |
"hasDefault">`, which is what it reads.

`readWorkspaceSources()` is new in `workspace-sql-scan.ts` and returns text with its owning package,
which is a different product from `scanWorkspaceSql`'s pre-extracted statements. It deliberately does
**not** apply `PG_SCAN_EXEMPT_PACKAGE_DIRS`: that list exempts packages from the *SQL* rules, and a
package with no Postgres store can still export the enum a catalogued CHECK is about.

The resolver took three passes to become total, and each gap was a real idiom:

1. `export const TENANT_STATUSES = TENANT_LIFECYCLE_STATES` — an alias, recorded as a one-member
   spread so the resolver needs no second code path. An alias whose target turns out not to name an
   array is **dropped** rather than reported, because whether it does is only knowable once every
   file is read: `export const DATA_KEY_BYTES = AEAD_KEY_BYTES` is a number and
   `nodePgConnectionFactory = createNodePgConnection` is a function, and reporting those produced nine
   false gaps.
2. Module-private `const SOURCES = [...] as const` typing an exported schema's field — read for
   resolution, withheld as a ref.
3. `import { DATA_CLASSES } from "@crossengin/jobs"` — followed, because the name is declared in three
   packages and a workspace-unique lookup gives up.

Reading unexported `const`s brought one hazard with it, and it is handled the way `bindArray`
handles its own: the scan has no scoping, so a module-level `KINDS` and a function-local one are two
bindings of one name in one file, and keeping whichever came last would be a confident wrong answer
about which domain types the field. The name becomes unresolvable instead and whatever reads it is
reported. Vacuous today — no such collision exists — and it is the direction that fails loudly.

**Measured, live, on PG 16.13.** A fresh cluster bootstraps the fixed catalog in **965/965**
statements under `ON_ERROR_STOP=1`, giving 146 `meta` base tables, and a `DeploymentRecord`-shaped
`INSERT` — `('docs-site', 'local', 'vercel', 'atomic', …)` — succeeds.

Against a second database still holding the old CHECKs, the same `INSERT` is refused `23514` four
times over, one constraint at a time, and only lands once all four are dropped. Then the upstream fix
arrives at the downstream survey, **as a non-owner role** (`app_serving`, `rolsuper = f`,
`rolbypassrls = f`): `surveyCheckAdmission` reports

```
catalog admission: refuses — 536 admitted, 4 refusing, 0 unconstrained, 237 not probeable, 0 absent, 0 unreadable
  meta.deployments.target: … refuses "vercel", "fly_machines", "supabase", "cloudflare", "typesense_cloud",
  "inngest_cloud", "clickhouse_cloud", "ghcr", "app_store", "play_store", which the catalog declares;
  a write carrying one of those values is refused 23514
```

in 351 ms over all 777 catalogued checks, naming every refused value on all four columns and nothing
else. `admissionBlocks` finds all four and `admissionRemedy` prints the eight `ALTER` statements;
applying them takes the survey to `admits — 540 admitted, 0 refusing` and the record inserts.

**And there is no manual SQL, for a reason worth stating.** ADR-0330 cannot tell a widening CHECK
from a narrowing one, so a replacement is planned only under the emptiness guard — and these four
*are* always empty, because the old CHECKs refuse every value the only possible writer can produce,
so no artifact could ever have populated them. `crossengin-pg apply --plan` against the pre-fix
database reports exactly:

```
  4 statement(s) to apply:
      replace_column_check deployments.app_kind [guarded]
      replace_column_check deployments.environment [guarded]
      replace_column_check deployments.target [guarded]
      replace_column_check deployments.strategy [guarded]
```

`apply` executes 4 of 4 with 0 failures in 27 ms, the re-plan comes back *"nothing to do — the live
schema matches the catalog"* (ADR-0331's convergence claim), and the record then inserts.

## Open questions

1. **`auditColumnDefaults` only reads a literal default.** `now()`, `uuid_generate_v7()` and a cast
   are out of scope here because evaluating them means evaluating SQL, which is `check-admission.ts`'s
   job. No value-set column carries a non-literal default today, so the gap is latent.
2. **The rule compares a domain's members and not a record's reachable states.** A `mirrors` link is
   satisfied by a CHECK equal to the whole enum even where the record schema's own refinements make
   some members unreachable for *that* column — the inverse of `narrows`, and harmless, since the
   column admitting more than a record can hold refuses nothing.
3. **Nothing checks that a ref names the domain the store actually binds.** The 19 adjudicated
   columns were decided by reading which record the table stores; a wrong adjudication that happens
   to enumerate the same set passes. Closing it needs the parameter-to-field link that is not visible
   to a scan — the same wall `pg-column-coverage.ts` stops at.
4. **Five spellings of one six-member data classification** — `DATA_CLASSES` in `dr`, `jobs` and
   `ml-training`, `DATA_CLASSIFICATIONS` in `types` and `data-lineage` — and three of one four-member
   environment (`deploy`, `feature-flags`, `finops`, the last with five). ADR-0340 found seven
   spellings of the ABAC concept and left them; this is the same shape, now measured, and four
   catalogued columns ref one of the five by declaration.
5. **`packages/deploy` still has zero importers** (ADR-0336), so `meta.deployments` remains
   writerless and this fix is latent. The package also carries the workspace's only `evaluateFlag()`
   and a second, incompatible flag vocabulary under six colliding names; which model is real is the
   product decision that ADR declined to make, and it is still open.
6. **A table-level `constraints` CHECK is not read.** `catalogValueSets` reads column-level checks
   only, which is where all 287 are; a value set written as a table constraint would be undeclared
   and invisible rather than undeclared and reported.
7. **The scan is text, not a tokenizer, so a regex literal containing an unbalanced quote can
   desync it** — `stripComments` reads `"` inside `/["']/` as a string opener and swallows to the
   next one. It is the shared helper's long-standing property rather than something this rule adds
   (ADR-0333 has trusted it since), and here the both-ways comparison makes it loud rather than
   silent: any domain the scan loses makes its declaration's ref `ref_unresolved`, which fails. A
   domain it has never been asked about could still be lost quietly.
8. **The rule says nothing about a value a store writes as a SQL literal.** A statement spelling
   `status = 'open'` inline is governed by no contract domain, so a `catalog_only` column with a
   writer is not a finding — reporting it would report a condition that is not a defect, which is
   what Option B was refused for.

## References

- ADR-0352 — the downstream half, and the open question this closes.
- ADR-0300 — a contract seven members wide against a four-member CHECK, shipped and found by hand;
  ADR-0334 and ADR-0351 — the downstream half of the same class, where the catalog moved and the
  already-applied databases did not.
- ADR-0330 — a widening CHECK cannot be told from a narrowing one, which is why the four replaced
  CHECKs are handed over as SQL on a populated table.
- ADR-0334 — a both-ways comparison is what makes a declared list trustworthy.
- ADR-0336 — `pg-unreachable-stores.ts`' reason fields, and the referential obligation `guardedBy`
  copies.
- ADR-0337 — a scan over source must strip comments and strings before it believes a match.
