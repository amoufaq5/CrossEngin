# ADR-0397: The manifest nobody surveyed

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-02 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0314 (a tenant's own manifest, and the JSONB fallback), ADR-0334 (the placement that covers a per-tenant gateway; a remedy that cannot work is worse than none), ADR-0339 (the write-open / read-closed asymmetry), ADR-0340 (the boot refusal this sits beside), ADR-0348 (validation error versus boot refusal), ADR-0357 (the cursor disclosure survey), ADR-0361 (the aperture of a classification reader), ADR-0366 (a proposal is withdrawn with its measurement), ADR-0368 (`meta.extends` on a stored manifest), ADR-0372 (a test that pins the defect as the specification), ADR-0397's sibling ADR-0396 (same batch) |

## Context

Three register items, taken as one increment because they are the same gap seen from three sides:
**the deployment's boot pack is surveyed and a tenant's own activated manifest is not.**

- **P2.2** — nothing surveys an activated per-tenant manifest's classified fields, so ADR-0339's
  asymmetry (39 of 46 fields unreadable by every role, all 46 writable by anybody holding entity
  `update`) was measured for the boot pack and unmeasured for the one input the Architect produces.
- **ADR-0357's open end 1** — the cursor-disclosure survey is boot-time only, so a classified field
  a *tenant* declared sortable travels in a plaintext `nextCursor` with nothing saying so.
- **P2.9's residue (Q4)** — a throw from the manifest **source** resolved `{kind:"none"}` and fell
  back to the deployment's gateway, which on `--store pg` is the same store object.

Every item was re-measured before being designed against (register P3.1), and in each case
something the register said was wrong. Those corrections are recorded here rather than quietly
applied, because two of them would have sent the work somewhere false.

## Decision

**1. `BuildOperateHttpServerOptions.onSurvey` is a non-failure report channel**, and the two
surveys `serve()` already ran for the boot pack run there too: `surveySensitiveFields` and
`decideCursorDisclosure`. Gated on the callback being supplied, so a deployment passing none pays
nothing.

**2. `surveySensitiveFields` takes a `policyForEntity` resolver** instead of a
`SensitiveFieldDeclaration`. This is the enabling change, not plumbing — see below.

**3. `tenant-manifest-survey.ts` turns that report into log lines**, with
`tenantSurveyHasFinding` as the predicate: a clean manifest is **silent**, every line names the
tenant, and the formatters are **borrowed** from the boot path rather than restated.

**4. A throw from the manifest source is a `refused` with kind `unknown`**, returned
**unremembered**, so the tenant gets a 503 with `retry-after` and the next request re-asks.

## Alternatives considered

- **P2.2: put the survey in `applyTenantManifestSchema`,** as the plan proposed.
  - **Pros:** that function already runs per tenant and already reports per-tenant findings
    (`uniqueIndexRefusals`, `unservable_field_type`), so the channel exists.
  - **Cons, decisive:** its only caller is built **solely under `--store pg-columns`**
    (`TenantColumnStoreRegistry`), and the shipped compose is `--store pg`. The check would have
    been dark on the deployment that ships.
  - **Cons, second:** it runs inside the DDL application transaction, where a throw aborts into
    ADR-0314's JSONB fallback — so a *report* placed there is one statement away from being a
    refusal that moves the tenant's data somewhere else.
  - **Why not:** `buildOperateHttpServer` is reached on **every** store, already compiles an
    activated per-tenant manifest, and already holds three of the four inputs — the same placement
    argument ADR-0340 makes for the obligation check and ADR-0334 for the tenant-status gate.

- **P2.2: make the per-tenant survey a refusal, like ADR-0340's obligation check.**
  - **Pros:** symmetry with the check it sits beside; a tenant could not activate a manifest whose
    classified fields nobody can read.
  - **Cons:** activation already **validates** (ADR-0348's split: these are properties of the
    manifest alone, so they are decidable by `crossengin validate` and by the reviewer), and
    refusing here takes a tenant's whole deployment away over a *declaration* — which on
    `--store pg` means serving them from the boot gateway, i.e. their data under someone else's
    rules (P2.9's defect, caused by the fix).
  - **Why not:** report. ADR-0348's rule, and ADR-0360's precedent for a permissive degradation.

- **P2.2 / ADR-0357 Q1 as two increments.**
  - **Pros:** each is small; the register lists them separately.
  - **Cons:** the register's own claim that they *"share an input set, so one blocks the other"* is
    **refuted**: the cursor survey needed **zero** plumbing (both its inputs are already on
    `buildOperateHttpServer`'s literal) while the sensitive-field survey needed the resolver change.
    Neither blocked the other.
  - **Why not:** what they genuinely share is the **missing report channel** —
    `TenantGatewayCache` carried only `onInvalidManifest` and `onBuildRefused`, both failure-only.
    That is `onSurvey`, and it is what makes them one change rather than two.

- **The survey computes its own policy from a declaration, as before.**
  - **Pros:** no signature change; one fewer parameter.
  - **Cons:** `buildSensitiveFieldPolicy(declaration)("")` is spent on **one** line, and a
    `SensitiveFieldDeclaration` exists in exactly one place — `serve()` — so the survey was tied to
    the only caller that could construct one. That tie *is* the defect.
  - **Why not:** taking the resolver is also **strictly more correct**: its type permits per-entity
    variation and a deployment may supply its own `policyForEntity`, where the old single `("")`
    call applied one answer to every entity.

- **P2.9 Q4: a third `GatewayResolution` disposition,** as that open end prescribed.
  - **Pros:** names the state explicitly.
  - **Cons:** **unnecessary** — `GATEWAY_BUILD_REFUSAL_KINDS` already carries `unknown` with
    `permanent: false`, and `remember` already holds the permanence decision, so routing the throw
    there gives exactly what the open end wanted with no fourth arm and no new enum member.
  - **Why not:** four lines instead of a contract change. The prescription was the costly half of a
    correct diagnosis, which is register P3.1's clause about checking a remedy as well as its facts.

- **P2.9 Q4: keep the fallback and log.**
  - **Pros:** a tenant whose manifest cannot be read is still served something.
  - **Cons:** on `--store pg` the fallback store is the **same object**, so what they are served is
    their own rows under the boot manifest's rules — their field grants, classification and
    obligations all absent. ADR-0359 established that this is a wrong answer and not a degradation.
  - **Why not:** `unknown` is not permanent, so the cost of refusing is one request's latency per
    TTL-free retry, against serving the wrong rules indefinitely.

- **A clean per-tenant manifest reports an affirmative line,** as every boot survey does.
  - **Pros:** "we checked and found nothing" cannot be claimed from silence (ADR-0340's rule).
  - **Cons:** scale. A line per tenant per activation grows with the tenant count and is the thing
    an operator filters — taking the real findings with it.
  - **Why not:** silent on a clean manifest, which is the one place this departs from the
    say-it-either-way rule and the reason is stated at the predicate. The boot line still says it
    either way, so the affirmative claim exists once per deployment rather than once per tenant.

## Consequences

- **Positive.** A tenant's own design is surveyed for the same three defects the boot pack is, and
  the measurement proves it is not redundant: on one process the boot `[cursor]` line reports **1**
  classified sortable field and the per-tenant line **2**; the boot `[sensitive]` line **21**
  classified fields and the per-tenant one **23**. The difference is `Patron.email`, which the
  tenant authored and the boot survey structurally could not see. A manifest source failure is a
  named 503 instead of a silent wrong answer. `surveySensitiveFields` is no longer tied to its one
  caller.
- **Negative.** The per-tenant surveys run on every gateway build, so a deployment with many
  tenants activating frequently pays the survey's cost per build (pure, no I/O, over an
  already-resolved manifest). A tenant whose manifest source is unreadable now gets a 503 where it
  got a 200 — correct, and a behaviour change for anyone who was relying on the fallback. The
  resolver change touched `surveySensitiveFields`' signature, which is a two-caller contract.
- **Neutral.** `onSurvey` is optional, so `serve()` is the only supplier and the boot lines are
  unchanged.
- **Reversibility.** Dropping `onSurvey` from the per-tenant literal restores the previous silence,
  and it is the kind of optional field whose omission is invisible to `tsc` (ADR-0386's triple).
  ADR-0396's general forwarding fence catches it — but only **asymmetrically**, and the asymmetry is
  worth stating because it is not an oversight: `onSurvey` is deliberately in the **boot** site's
  `notPassed` map, since `serve()` surveys the boot manifest itself *before* this function is
  reached (the refusal has to fire before anything mounts, and the `[cursor]` line has a declared
  order relative to `checkAbacObligations`), so passing it there would survey one manifest twice and
  report it once. It is **not** excused at the per-tenant site, which is the one that matters — and
  that asymmetry is the whole reason the option exists.

## Implementation notes

**Why the resolver change is the increment.** `surveySensitiveFields` accepted
`declaration: SensitiveFieldDeclaration` and immediately did
`buildSensitiveFieldPolicy(declaration)("")` — one call, one answer, applied to every entity. A
declaration is parsed from `--sensitive-field-role` / `--sensitive-field-class`, which happens in
`cli.ts`, so the survey could only ever be called from `serve()`. Taking
`policyForEntity: (entity: string) => SensitiveFieldPolicy | undefined` — the seam the redaction
registry already takes — both unties it and asks the question per entity.

One measurement an implementer needs: **that resolver has two consumers on the same server.** The
redaction registry already calls it once per entity, so a test counting invocations must assert a
**delta** derived from `manifest.entities.length` rather than a total. The first draft of
`server.test.ts` asserted totals and failed with `expected 12 to be +0` and `expected 54 to be 66`.

**Ordering.** The surveys run **after** ADR-0340's obligation check, for that check's own stated
reason: an obligation on a required classified field's `update` grant makes the field unwritable
and would otherwise trip `--classified-write-mask`'s `would_make_entity_uncreatable`, naming the
classification declaration as the remedy for something no declaration can fix. First refusal wins,
so it has to be the one whose remedy is true.

**The log lines.** `formatTenantManifestSurvey` prefixes **every** line and not the block.
`formatSensitiveFieldSurvey` returns a `\n`-joined block of already-prefixed lines
(`[fields] …`), so tagging the block attributes only line 1 and leaves lines 2..N reaching a
multi-tenant log with no tenant on them — unattributable, and worse than not reporting. The first
draft did exactly that and its own test (`names the tenant on EVERY line, not just the first`)
caught it.

The cursor remedy names the **deployment's** `CURSOR_ENCRYPTION_SECRET` and nothing a tenant can
change, because one secret seals every tenant with the key derived per tenant inside the sealer —
so a per-tenant report implying a per-tenant remedy would send a reader to a setting that does not
exist (ADR-0334).

**The source throw.** `TenantGatewayCache.serverFor`'s `catch` around the manifest read used to
`return { kind: "none" }`. It now builds the `unknown` refusal, reports it through
`onBuildRefused`, and returns it through `remember`, which declines to cache a non-permanent kind.
`onBuildRefused`'s message is **keyed on the kind**: the unconditional *"manifest is valid and its
gateway could not be built"* is false for a source throw — the manifest was never read — and
contradicted its own detail clause (`permission denied for table operate_tenant_manifests`) in one
sentence. For the five kinds that parse the manifest first the clause is true and load-bearing,
because it is what tells an operator not to look there.

**Two existing tests pinned the defect as the specification**, one in its title (*"falls back
rather than refusing when the manifest source itself throws"*). Both are rewritten with the
reasoning recorded rather than deleted — ADR-0372's class, which this file records under that name
in seven places and which is deliberately **not** given an ordinal here: the instances span several
runs, one of them already claims "the sixth time", and an ordinal in prose is the quantity register
P3.1 exists to stop being repeated. Count the occurrences; do not trust a number.

**Live verification**, all as the non-owner `serving` role on PG 16.13 against a real cluster, one
active tenant with a stored and activated `acme/clinic` manifest extending `operate-erp/core`:

| arm | result |
|---|---|
| `GET /v1/patrons` (the tenant's own entity) | **200** — the per-tenant gateway really built |
| no pii grant, no cursor secret, mask off | **4** `[tenant-manifest]` lines |
| pii granted, cursor secret set | **2** lines |
| pii granted, secret set, `--classified-write-mask` | **0** lines (silent) |
| `REVOKE SELECT ON meta.operate_tenant_manifests FROM serving`, two requests | **503** + `retry-after: 60`, twice (two log lines ⇒ uncached) |
| grant restored, **same process** | **200** on the very next request |

The P2.9 arm had to be reached through an **api-key**: a self-minted Bearer does not resolve a
tenant through `resolveRequestTenant`, so the per-tenant dispatch is never consulted for it and the
request goes straight to the default gateway. Worth knowing before measuring that path.

**Two things the arms established that were not in the plan.**

1. **The blind-overwrite shape is no longer authorable.** The first fixture declared
   `tax_ref: {read: ["clinician"], update: ["front_desk"]}` and activation was **refused** by
   ADR-0348's kernel coherence rule. So the explicit-grant form of ADR-0339's headline defect is
   closed at validation, and the survey's live finding is the **classification-default** form — a
   classified field with no field grant, which is ADR-0339's measured state on 39 of 46.
2. **The pii grant clears the unreadable finding and not the asymmetric one, and that is correct.**
   `--sensitive-field-class pii=…` says who may *read* a class; `--classified-write-mask` enforces
   writes (ADR-0339 made it opt-in deliberately). With the grant and the mask off,
   `Patron.email`'s `writableBy` is all 17 resolved roles. The boot survey reports no asymmetric
   finding on `erp-core` because all 21 of its classified fields carry explicit grants (ADR-0348
   authored them) — so the contrast is between a pack whose grants were **authored** and a tenant
   design whose grants were not, which is exactly the population this survey exists for.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| P2.9's Q5 remains and is the **root** of Q4's class rather than its sibling: `ai-design-routes.ts` returns **200** on activation with no build check, so a tenant can activate a manifest this deployment cannot serve and learn of it from a 503. Scoped: an `activationCheck` seam running resolve → validate → obligations costs 0.65 ms for the refusal gate and under 7 ms for a full compile, with no database side effect on `--store pg`, and honestly refuses 8 of the 9 reachable refusals plus both validation failures. It must **not** claim to cover `ColumnEncryptionUnavailable` on `--store pg-columns`, where the key check needs the column plan. | Platform | 2026-12-15 |
| `diffFragment`'s bare catch makes the design reviewer's page say *"This is the first system for this tenant"* for a tenant that has one, hiding a measured `breaking / 40 warnings` behind `impact: none`. Its own increment: the fix is a three-valued diff provenance crossing the kernel view type, the route mirror and the web component. | Platform | 2026-12-31 |
| The per-tenant survey reaches an operator through a **log line only**. Every boot survey in this binary is in the same state (register P1.16's diagnostics half), and a per-tenant finding is the one an operator most needs a route for, since it is about somebody else's design. | Platform | 2027-01-15 |
| A tenant whose per-tenant DDL application was *refused* is served from the JSONB fallback (ADR-0314) and the survey says nothing about it — so the report describes a manifest the tenant is not being served by. Should `onSurvey` carry the store the gateway actually got? | Platform | 2027-01-15 |
| `tenantSurveyHasFinding`'s five clauses are hand-written over two report shapes. Both shapes are closed vocabularies, so the predicate could be derived from a total map per verdict — which would make a sixth sensitive-field finding kind a compile error here rather than a silent omission. | Platform | 2027-01-31 |

## References

- Register items P2.2, P2.9 (Q4) and ADR-0357's open end 1; P3.1 (the re-measurement discipline).
- `apps/operate-server/src/tenant-manifest-survey.ts` and its test.
- `apps/operate-server/src/server.ts` (`onSurvey`, the two gated surveys).
- `apps/operate-server/src/sensitive-field-policy.ts` (`policyForEntity`).
- `apps/operate-server/src/tenant-gateway-cache.ts` (the `unknown` refusal).
- ADR-0340 (the placement argument), ADR-0348 (report versus refuse), ADR-0372 (tests that pin a
  defect).
