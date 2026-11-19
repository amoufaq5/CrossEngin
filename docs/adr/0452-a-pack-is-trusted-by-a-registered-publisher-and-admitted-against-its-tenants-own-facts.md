# ADR-0452: A pack is trusted by a registered publisher and admitted against its tenant's own facts

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0338 (refuse only when nothing correct breaks), ADR-0368 (a flag with nothing to serve is refused), ADR-0335 (an actor column must not make its actor undeletable), ADR-0359 (a surface whose drop changes which rows come back is refused or said), ADR-0376 and ADR-0406 (the per-flag question for the shipped compose), ADR-0430 (job handlers), ADR-0436 (`--file-root`), ADR-0440 (`pg-columns` on the confined role), ADR-0449 (the tenant-status gate on by default) |

## Context

The external due-diligence audit, verified against the tree at `f6faf05`, left four items for this
slice.

- **M-21** (true, open, latent behind non-default flags): the marketplace trusted a self-asserted
  signing key, let any author overwrite a published version, and recorded an install that nothing
  executes. Measured before any change, all three hold:
  - each catalog entry and each submission carried its own key, so a pack signed with a key its
    author supplied always verified;
  - `PostgresPackVersionStore.upsert` was an unconditional `DO UPDATE`, so a published version could
    be overwritten;
  - install records a row, and nothing executes the pack or reads its grants.

  Three defects the audit did not name: `author.kind` was self-declared, so a community author could
  claim `crossengin_official` and skip security review; `packId` was not bound to `manifest.id`, so a
  signed version could be filed under another pack; and uninstall was allowed only from `installed`,
  which nothing ever reaches, so every admitted install was stuck in `installing` or
  `permission_pending` and every reinstall was refused `already_installed`.
- **P0.8** (register): the marketplace `TenantContext` was five fabricated facts — `us-east`,
  `professional`, `[]`, `false`, `1.0.0` — one boot-time constant for every tenant. Measured: the
  seven packs declare 6 compliance ids (hipaa, pci, haccp, osha, ferpa, nist-800-53), definitions
  exist for 4 (hipaa, gdpr, uae-moh, 21-cfr-part-11), so 5 of the 6 declared ids have no definition;
  and the marketplace vocabulary spells `uae_moh` where the definition says `uae-moh`. Live before:
  an EU tenant was admitted a pack blocked in the EU, because its region was fabricated as `us-east`.
- **H-25** (partly fixed): the shipped compose still leaves `--rate-limit-policy`,
  `--classified-write-mask`, `--schedule-ms`, `--workflow-workers` and the deletion capabilities
  off, and `scripts/run-dev.ps1` is stale. The audit overstated it: an in-memory 10,000/60 s limiter
  already existed.
- **P2.1** (register): a `?q=` search partially narrowed by an encrypted column still answers without
  saying so.

## Decision

**A publisher is registered by the platform, not by the pack.** `packages/marketplace/src/publishers.ts`
holds `--pack-publisher-key <namespace>:<authorKind>:<publicKeyBase64>` entries and refuses
overlapping namespaces, one namespace under two kinds, and a duplicate key. `verifyPackPublisher`
refuses, in order, `publisher_unregistered`, `pack_outside_publisher_namespace`,
`author_kind_not_registered` and `signature_invalid`, and is called by install, by submission and by
a catalog survey at boot. A catalog entry's legacy `publisherPublicKeyBase64` is accepted only when it
matches the registered signer; the submission body's `publicKeyBase64` is refused (strict schema).
Submission requires `packId === manifest.id`.

**A published version cannot be overwritten.** `insertDraft` is `ON CONFLICT DO NOTHING` and refuses
`version_exists`; `advance(previous, next)` updates only the lifecycle columns, guarded on the
previous status, and refuses `version_changed`. `publish` refuses a failed security review on every
channel (`review_not_cleared`), not only on `stable`. The authoring route maps refusals to status
through a total map — publisher refusals 403, a bad signature or pack-id mismatch 400, the rest 409 —
and propagates anything that is not a refusal; the submit body's `version` uses the record schema's
own field, so `latest` is a 400.

**Install is honest rather than wired.** A response carries `effect: {executesPack: false,
grantsConsulted: false}`, and a total map `UNINSTALL_PATH` routes `installing` → failed (with a
withdrawn reason) → uninstalled, so an install can be withdrawn and reinstalled.

**The tenant context is resolved per tenant, and an unknown fact refuses only a pack that constrains
it.** `MarketplaceAdminContext.tenantContext` is `(tenantId) => Promise<TenantContext>`, built by
`marketplace-tenant-context.ts`. Region is the tenant's residency primary region, else `--region`
parsed with `RegionSchema`; a failed residency lookup reads as `null` rather than falling back.
Platform version comes from `--marketplace-platform-version`. `planTier`, `compliancePacks` and
`isDedicatedTenant` have no source and are `null`, each with its reason on the boot line; a `null`
fact refuses a pack only when the pack constrains it, with an `undetermined` list. `--pack-admin-role`
(default `erp_admin`) replaces the hard-coded set, which closes the marketplace half of P2.16. Boot
prints `[marketplace]` lines naming the facts, the declared compliance ids outside the vocabulary, the
install effect, and catalog entries that will be refused at install.

**A flag with nothing to serve is refused** (ADR-0368). `--pack-catalog` or `--marketplace-authoring`
without a publisher key exits 2 — under ADR-0338's rule, since no compose passes either flag — and so
do `--pack-admin-role`, `--marketplace-platform-version` and `--pack-publisher-key` with no surface
that reads them. architect-cli `chat` exits 2 when `--file-root` is given with no file tool enabled or
under `--no-tools`; the test that pinned the silent acceptance was rewritten.

**A narrowed search says so on the page.** `buildListSql` returns `searchNarrowedBy`, the column store
sets it on `ListPage`, the decimal and datetime wrappers spread the page so it survives, and the list
handler emits `page.searchNarrowedBy` only when non-empty, so ordinary pages are byte-identical. The
OpenAPI document declares the optional field, and the `q` description no longer claims every
searchable field is matched.

**The compose is unchanged, because none of the five flags passes all six clauses.** Each is fenced
in `deployment-defaults.test.ts` with the clause it fails, and a non-vacuity floor asserts each fenced
flag still exists in `cli.ts`:

| Flag | Clause | Why |
|---|---|---|
| `--rate-limit-policy` | 6 and 5 | any declared policy refuses traffic that works today; nothing deletes `meta.rate_limit_decisions` |
| `--classified-write-mask` | 1 and 6 | changes 0 shipped fields; on a tenant design with an ungranted required classified field, a create that works today would fail |
| `--schedule-ms` | 6 | starts posting depreciation, marking invoices overdue and raising invoices on a working deployment (ADR-0430; not re-measured) |
| `--workflow-workers` | 1 | no producer is mounted, so there is nothing to execute |
| deletion capabilities | 1, plus a product decision | mount nothing alone; the only servable subject scope erases a whole tenant when one subject asks (ADR-0379) |

`scripts/run-dev.ps1` is deleted, and a fence keeps it from returning: `operate-web` reads
`OPERATE_API_KEY` nowhere and `--credential-login` refuses `--store memory`, so every console request
that script produced was a 401, and a working version would be a second copy of the documented
bootstrap.

## Alternatives considered

- **Keep each catalog entry's own key and add a review step.** Refused: the key is the pack author's
  claim about itself, so no step downstream of it can make the signature mean anything.
- **Read `planTier` and `compliancePacks` from `meta.tenants`.** Refused: the register measured that
  table's `tier` and `region` as the wrong vocabularies, and fabricating a fact is the defect, so an
  unknown fact refuses only a pack that constrains it.
- **Fall back to the deployment region when the residency lookup fails.** Refused, and checked by
  review: a fallback would admit a pack the tenant's real region blocks.
- **Wire install to execute the pack.** Not taken: there is no installer to wire; the response says
  so instead.
- **Default any of the five compose flags on.** Refused per flag in the table above. H-25's implied
  premise, that some are ready, does not hold for any.
- **Repair `scripts/run-dev.ps1`.** Refused: a working copy would be a second spelling of the
  documented bootstrap.
- **Bind the version and bundle hash into the signature in this slice.** Deferred, not refused: it is
  a signing-format change across three packages (see open questions).

## Consequences

- **Positive:** a pack verifies only under a key the platform registered for its namespace and author
  kind; a version cannot be overwritten; a tenant's install is checked against its own region; an
  install can be withdrawn; the boot says which compatibility facts are unknown and which catalog
  entries will be refused; a narrowed search is visible to the client.
- **Negative:** the five marketplace flags that used to be accepted with nothing to serve now exit 2;
  a pack constraining plan tier, compliance packs or dedicated tenancy is refused for every tenant
  until a source exists; a publisher key is revoked only by restarting without the flag.
- **Neutral:** `deploy/docker-compose.yml` is unchanged; the compliance boot report compares against
  the marketplace vocabulary, because operate-server cannot import `@crossengin/compliance` without a
  `pnpm install`.
- **Reversibility:** the registry, the refusals and the page field are additive. Undoing the version
  guard would restore silent overwrites.

## Implementation notes

- Changed: `packages/marketplace/src/` (`publishers.ts` new, `compatibility.ts`, `index.ts`);
  `packages/marketplace-runtime/src/` (`decisions.ts`, `install.ts`, `submission.ts`);
  `packages/marketplace-runtime-pg/src/` (`version-store.ts`, `persistent-engine.ts`,
  `persistent-submission-engine.ts`, `test-fakes.ts`); `apps/operate-server/src/`
  (`marketplace-admin.ts`, `marketplace-authoring.ts`, `marketplace-tenant-context.ts` new, `cli.ts`,
  `node.ts`, `platform-authority.ts` one line, `list-surface-survey.ts`, `deployment-defaults.test.ts`);
  `packages/operate-runtime/src/` (`store.ts`, `handlers.ts`, `decimal-store.ts`, `datetime-store.ts`,
  `openapi.ts`, `openapi-list-params.ts`); `packages/operate-runtime-pg/src/` (`list-sql.ts`,
  `column-store.ts`); `apps/architect-cli/src/commands.ts`; `scripts/run-dev.ps1` deleted.
- **In process (review's figures, which supersede the implementer's where they differ):** marketplace
  171/171, marketplace-runtime 42/42, marketplace-runtime-pg 30/30, architect-cli 275/275,
  operate-runtime-pg 815/815, testing 906/906, all typecheck-clean; operate-runtime 1477 of 1478 and
  operate-server 6007 of 6008, each failure from the other lane's in-progress files
  (`compile.test.ts` option forwarding; `manifest-view.test.ts` `grantCount` after the other lane's
  `ai-design.ts` change).
- **Mutation-checked**, each reversed: the implementer ran 21 (registry lookup, namespace and
  author-kind checks, unknown-fact refusal, `DO NOTHING`, the `advance` guard, `UNINSTALL_PATH`,
  list-sql narrowing, the handler emit, decimal pass-through, the OpenAPI field, the `--file-root`,
  inert-flag and no-key refusals, the authoring 403 mapping, the catalog key mismatch, residency
  precedence and throw, and three fences). `UNINSTALL_PATH.installing` first survived, because the pg
  package's tests read marketplace-runtime through `dist`; a test in the owning package now catches
  it. Review re-checked four of them and its own two fixes.
- **Measured by the implementer and not re-derived by review:** with the mask off versus on, 0 of the
  173 resolved sensitive fields across the seven packs change writers; the 5-of-6 compliance figure.
- **Live on PG 16, `--store pg`, as `crossengin_app`** (independent run, with a four-entry signed
  catalog, one registered publisher, `--region us-east` and a residency profile putting tenant acme in
  `eu-central`):
  - acme installs a pack blocked in `eu-central`: 409 *"region 'eu-central' is blocked"* (before:
    admitted). Tenant beta, with no profile, installs the same pack: 201.
  - a pack requiring a plan tier: 409, because the plan tier is unknown. A basic pack: 201. A pack
    signed by an unregistered key: 409 `publisher_unregistered` at install, 403 at submission.
  - uninstall from `installing`: 200 `uninstalled`, then reinstall 201; another tenant's uninstall:
    404 `installation_not_found`.
  - re-submit 1.0.0 with new bytes: 409 `version_exists`, stored bundle unchanged; a pack outside the
    namespace 403; `version: "latest"` 400 (before: 500).
  - the five inert flags: exit 2 each, naming the missing flag. `deploy/docker-compose.yml`:
    `git diff --stat` empty.
- The implementer's own live run (PG 16 as the non-owner `serving` role, store and engine level)
  reproduced the submission and install arms above. **P2.1 was verified in process only**; no live arm
  exercised a narrowed search.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| **A publisher's signature replays onto any version with any bundle** (confirmed live: the same signature re-sent as `9.9.9` with a new `bundleSha256` and an arbitrary `manifestSha256` returned 201). *The digest half is closed in the commit that landed this ADR*: `manifestSha256` must equal `packManifestDigest(manifest)`, the sha256 of the bytes the signature covers, or the submission is refused `manifest_digest_mismatch` (400). Still open: the signature covers only the manifest, so a captured signature can still be submitted with a different `version` and `bundleSha256`, and for a `crossengin_official` publisher a replayed non-PHI version is review-exempt. Closing it needs a signed release envelope over manifest, version and bundle hash, a wire change for every signer. | CrossEngin platform | _unscheduled_ |
| **Uninstall fails 23503 when the actor has no `meta.users` row** (an api-key's shared placeholder, reproduced by implementer and review), because `pack_installations.installed_by` and `uninstalled_by` carry `USER_FK`; the two-transaction `installing` path then leaves the row `failed`. ADR-0335's rule; the fix is in the kernel meta-schema. | CrossEngin platform | _unscheduled_ |
| `pack_author` and `marketplace_reviewer` are still fixed strings, not platform-authority flags: any author can withdraw or deprecate any publisher's version, one person can author and review, and a review can be re-recorded while `in_review`. Latent: no compose passes `--marketplace-authoring`. | CrossEngin platform | _unscheduled_ |
| Two concurrent installs can both pass the already-installed check. | CrossEngin platform | _unscheduled_ |
| `UNINSTALL_PATH` is `null` for `requested`, `updating` and `uninstalled`, although `updating → failed → uninstalled` is a legal route; nothing reaches `updating` today. | CrossEngin platform | _unscheduled_ |
| No source exists for `planTier`, `compliancePacks` or `isDedicatedTenant`; supplying one is a product decision. | CrossEngin platform | _unscheduled_ |
| A publisher key is revoked only by restarting with the flag removed. | CrossEngin platform | _unscheduled_ |
| The compliance boot report compares against the marketplace vocabulary rather than the compliance definitions, and covers the boot manifest only. | CrossEngin platform | _unscheduled_ |
| A search narrowed by a manifest view, rather than by the store, carries no page signal; and the OpenAPI text says a narrowed field is ciphertext while `searchNarrowedBy` records any unavailable column (in practice only encrypted ones). | CrossEngin platform | _unscheduled_ |

## References

- `packages/marketplace/src/publishers.ts`, `compatibility.ts`
- `packages/marketplace-runtime/src/install.ts`, `submission.ts`, `decisions.ts`
- `packages/marketplace-runtime-pg/src/version-store.ts`
- `apps/operate-server/src/marketplace-tenant-context.ts`, `marketplace-admin.ts`,
  `marketplace-authoring.ts`, `deployment-defaults.test.ts`
- `packages/operate-runtime-pg/src/list-sql.ts`, `packages/operate-runtime/src/handlers.ts`
- ADR-0335, ADR-0338, ADR-0368, ADR-0376, ADR-0406, ADR-0430, ADR-0440, ADR-0449
