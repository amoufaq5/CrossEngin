# ADR-0459: A stored pack release is re-verified against its signer, and a publisher signs with a tool

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0454 (the release envelope; this closes two of its open questions), ADR-0452 (the publisher registry), ADR-0372 (an absence of evidence is not evidence), ADR-0301 (a credential never travels on argv), ADR-0358 and ADR-0406 (one secret, the public half derived), ADR-0373 (a row its contract refuses reads unreadable) |

## Context

ADR-0454 left two open questions that this increment takes.

**A stored row is checked against its own claim, not against its signer.** `PackVersionRecordSchema`'s
refinement compares a `meta.pack_versions` row's `packId`/`version`/`manifestSha256`/`bundleSha256`
with `signature.release`, which catches a single-column `UPDATE` (the row then reads unreadable). It
cannot catch an edit that rewrites the column *and* the claim (`jsonb_set(signature,
'{release,version}', '"9.9.9"')`): the row agrees with itself, so it parses — measured live in
ADR-0454 as `9.9.9` listed by `GET /v1/authoring/packs/com.acme.loyalty/versions`. Nothing on that
read path re-verifies the Ed25519 signature, which is the only fact binding the claim to a key.

**There is no signing tool.** The envelope was reachable only by calling `signPackRelease` from
code, so a publisher had to write a program to submit a pack.

### What the slice framed, measured against the tree

The slice asked for re-verification on the list route **and, decisively, immediately before
install**. Measured, the stored row **never reaches install**: `buildPackInstallHandler` reads
`ctx.catalog` — the `--pack-catalog` file loaded once at boot — and the only readers of
`PostgresPackVersionStore` are the seven authoring routes (`getByPackVersion` and `listByPack` have
no other non-test caller in the workspace). And install's own input is **already** re-verified
against the registry on every admission: `admitInstallation` step 2 calls `verifyPackPublisher` on
the catalog entry. So "before install" is not where a stored row's trust is decided. What moves a
stored row toward tenants is the authoring lifecycle — `submit-for-review`, `review`, `publish` — and
`publish` is the act that puts a release on a distribution channel. That is the lifecycle gate a
stored row passes through the routes, and it was unguarded: a two-column rewrite could be reviewed
and published to `stable` as a release its publisher never made. It is **not** a gate against the
attacker the threat model names — one who can write the table — because the columns that decide
the lifecycle (`status`, `security_review_status`) are outside the signature; see §2a.

## Decision

### 1. `verifyStoredRelease` re-verifies a stored row against the registry

In `@crossengin/marketplace`'s `publishers.ts`, beside `verifyPackPublisher`. It takes the row's
four facts plus its signature (`StoredRelease`, which a `PackVersionRecord` satisfies structurally)
and answers, first failure wins:
`legacy_signature_form` → `publisher_unregistered` → `pack_outside_publisher_namespace` →
`signature_invalid` → `release_pack_mismatch` → `release_manifest_mismatch` →
`release_version_mismatch` → `release_bundle_mismatch`.

`STORED_RELEASE_REFUSALS` is that list, typed `satisfies readonly PublisherRefusal[]`, and it
deliberately omits `author_kind_not_registered`: **the row does not store the manifest**, only its
digest, so the author kind cannot be re-asked. That check ran at submission over the manifest whose
digest the signature binds; what is lost is re-asking it after the registry changes a namespace's
kind, and the test pins the omission so it cannot be added back as a check that silently passes.

The answer is about the registry **now**. A release whose key was removed from
`--pack-publisher-key` reads `publisher_unregistered`, which is ADR-0452's rotation question
(still open) and not a defect of this check. A legacy row (no `release`) reads
`legacy_signature_form` — ADR-0454 already said such a row "can never be re-verified", and now the
platform says so per row.

### 2. The forward lifecycle steps refuse an unverifiable row: `stored_release_unverified`

`PackSubmissionEngine` gains `verifyStored(record)`, and `submitForReview`, `publish` and a
**passing** `recordReview` call a private `assertStoredRelease` that throws `PackSubmissionError`
`stored_release_unverified` carrying the underlying `storedRefusal`. The check runs **before**
`assertTransition`, because "illegal transition" describes the request while the finding is about the
row (a test pins that a rewritten draft asked to publish answers `stored_release_unverified`, not
`illegal_transition`).

`deprecate`, `withdraw` and a **failed** review are deliberately **not** gated: each retires or
blocks an unverifiable row, and gating them would leave no lifecycle route to take the row out of
the way.

The route maps `stored_release_unverified` to **409** in the total `SUBMISSION_REFUSAL_STATUS` map:
the request is well formed and the caller may make it; the stored state is what cannot advance —
`version_changed`'s reasoning — so neither 400 nor 403. The body carries `releaseRefusal` naming
why. **The remedy is reachable by both roles that meet the 409**: an author meets it at
`submit-for-review`, a reviewer at `review` and `publish`, so `withdraw` is granted to authors **and**
reviewers (a reviewer withdrawing is the platform taking a version out of distribution, which a
publish grant already implies — and for a forged row the author is exactly the party who did not
make it), and a reviewer may record a failed review, which blocks publish on every channel.

### 2a. What the signature does not cover, and the one unsigned edit the platform can still prove

The release signature binds `packId`, `version`, `manifestSha256` and `bundleSha256` and nothing
else. `status`, `channel`, `bundle_size_bytes`, `changelog`, `security_review_status` and
`security_reviewer` are unsigned columns, and an owner-level edit of them is invisible to
`verifyStoredRelease`: `SET status = 'published'` never passes through `publish` at all, and
`SET security_review_status = 'passed'` with a forged reviewer cannot be told from a real review. So
the gate in §2 protects the **lifecycle routes**, not the table.

One such edit *is* provable: `exempt` on a row whose verifying publisher is registered with an
untrusted author kind. `requiresElevatedReview` is unconditionally true for an untrusted author, and
`author_kind_not_registered` at submission tied the manifest's kind to the registered one, so the
engine never writes that pair — `SET security_review_status = 'exempt'` on a community row is the
cheapest way to skip the elevated review the envelope exists to protect. `verifyStored` therefore
answers a ninth refusal after the signature verifies, `review_exemption_unsupported`
(`STORED_VERSION_REFUSALS` in `@crossengin/marketplace-runtime`, `STORED_RELEASE_REFUSALS` plus this
one), and the read marking and the 409 both carry it. `packAuthorKindTrusted(kind)` is the one
spelling of "trusted", with `packAuthorTrusted` now delegating to it, because the row stores the
publisher's registered kind and not the manifest. Like every stored check it asks the registry
**now**: a namespace re-registered from `certified_partner` to `community` makes its `exempt` rows
refuse, which is the honest answer.

### 3. The read routes list the row, marked — they do not hide it

`GET …/versions` and `GET …/versions/{version}` attach `releaseVerification`:
`{ verified: true }` or `{ verified: false, refusal, detail }` to every version they return.

Hiding a failing row was the alternative, and it is refused on ADR-0372's rule: a hidden row reads
exactly like a version nobody submitted — an absence presented as evidence. The person reading this
route is the author, the one party who can recognise a release they never made; and a hidden row
would make a resubmit of that number answer `version_exists` about a row they cannot see. The boot
catalog headline already takes the same shape — it counts entries *installable as catalogued* and
*refused at install* rather than omitting the refused ones.

The field is additive: existing consumers of `data` keep working and see the same record keys.

### 4. One log line per unverified row and status, with no key material

`unverifiedReleaseLine` builds
`[marketplace] stored release unverified pack=<id> version=<v> status=<s> reason=<refusal> — …` and
its remedy clause is a total map over the row's **status** (`UNVERIFIED_RELEASE_REMEDY`): a draft
cannot be submitted, an `in_review` row cannot be passed or published, a `published` or
`deprecated` row is **in distribution** and should be withdrawn, and a `withdrawn` row needs nothing
and is silent. A read route reports a given (pack, version, status, reason) **once per process**
(`createUnverifiedReleaseReporter`), because a list is read on every page view and after a key
rotation every row that key signed would otherwise log on every request and bury the finding; a
refused lifecycle step is an act somebody attempted and is reported every time. It names the reason
and **not** the refusal's `detail`: `publisher_unregistered`'s detail carries a 12-character fingerprint prefix, which
is public but is not needed to act, and a line written per row should carry nothing about a key. A
test asserts neither the public key nor the fingerprint prefix appears.

### 5. Install keeps its existing check, now fenced against the two-column shape

No install code changed, for the reason measured above. A new test applies ADR-0454's live edit to a
catalog line (version and `signature.release.version` both `9.9.9`): the boot survey names it
`signature_invalid` (`1 installable as catalogued, 1 refused at install`), the install route answers
**409 `signature_invalid`** with nothing recorded, and the untouched `1.0.0` beside it installs
(201) — the control that makes the zero a refusal and not a broken read.

### 6. `crossengin pack sign`, with the seed from the environment only

The tool is a subcommand of `apps/architect-cli` (`crossengin`), not of `operate-server`, because a
publisher is not an operator of a deployment: `crossengin` is the authoring CLI (`validate`, `hash`,
`diff`) and already hosts the one other offline signer in the repo (`license mint`), while
`operate-server` is the serving binary every subcommand of which acts on a deployment's own database.
A publisher should not need the serving binary, its configuration or a Postgres to sign a pack.

```
crossengin pack keygen [--format json]
crossengin pack sign <manifest.json> --version <semver> (--bundle <file> | --bundle-sha256 <hex>)
                     [--signed-at <iso>] [--format json]
```

- The seed is `PACK_SIGNING_KEY` (32 bytes, standard base64) and nothing else (ADR-0301). The public
  half is **derived** (`ed25519PublicKeyFromSeed`), not read from a second variable, because node
  silently discards an inconsistent `x` (ADR-0358). Three refusals, each exit 2, none echoing the
  value: `signing_key_absent`, `signing_key_placeholder` (the documented `REPLACE_WITH_` prefix) and
  `signing_key_malformed`. The key is resolved after every argument check, so a malformed command
  never needs the secret.
- Each action takes an **allow-list** of flags (`PACK_ACTION_FLAGS`: `sign` takes `--version`,
  `--bundle`, `--bundle-sha256`, `--signed-at`, `--format`; `keygen` takes `--format`) and refuses any
  other, never echoing its value. A flag whose name reads as key material (`key`, `seed`, `secret`,
  `private`, …) gets the argv-exposure refusal naming `PACK_SIGNING_KEY`. An ignored key flag would
  sign with whatever the environment holds, or refuse for an absent variable while the operator
  believes they supplied the key, and the CLI's `parseArgs` otherwise keeps any flag silently — so a
  deny-list of four spellings missed the most natural one, `--pack-signing-key`.
- It signs with `signPackRelease` — the same function every verifier is the inverse of — so there is
  no second spelling of the canonical bytes. `packId` and `manifestSha256` come out of the manifest
  through `packReleaseClaimFor`; the bundle digest is computed from `--bundle` (with its size) or
  taken from `--bundle-sha256`, exactly one of which is required.
- It prints `{ submission, publisher }` to stdout. `submission` holds exactly the fields of a
  `POST /v1/authoring/packs` body that the signature binds (`packId`, `version`, `manifestSha256`,
  `bundleSha256`, `bundleSizeBytes` when a file was given, `signature`) and nothing else, because that
  body is `.strict()`; the author adds `manifest`, `channel` and `changelog`. A catalog entry takes
  `version`, `bundleSha256` and `signature` from it. `publisher` carries the public key and its
  fingerprint, which the operator registers with `--pack-publisher-key`. In human format a line on
  stderr names the fingerprint and the spec shape; stdout stays pure JSON so it can be piped. The
  seed is printed only by `pack keygen`, which is `license keygen`'s precedent.

The tests prove the round trip with the server's own code: the printed signature passes
`verifyPackReleaseSignature`; the printed fields plus the author's three parse through
`PackSubmissionBodySchema` — the `.strict()` body the route parses, moved from the route into
`@crossengin/marketplace-runtime` so there is one spelling — with the tool's keys asserted equal to
the schema's minus the author's three, and make a draft through `PackSubmissionEngine.submit` against
a registry built from the printed public key; that draft
re-verifies with `verifyStored`; and the same output filed as `9.9.9` is refused
`release_version_mismatch`.

## Alternatives considered

| Option | Why not |
|---|---|
| Hide an unverifiable row from the list | An absence read as evidence (ADR-0372): a hidden row is indistinguishable from a version never submitted, the author loses the one place to see it, and a resubmit answers `version_exists` about an invisible row. |
| Verify in `PostgresPackVersionStore` (`rowToRecord`) and treat a failing row as unreadable | The store would need the publisher registry, which is deployment configuration, and a row that fails would vanish from the list (the same hiding), and could not be withdrawn because `getByPackVersion` would refuse it. The store answers "what is stored"; whether to trust it is the engine's question. |
| Gate install on the stored row | Install does not read the stored row (measured: the catalog file is its only source), so the gate would guard nothing; install's own input is already re-verified at admission and is now fenced against the two-column shape. Making `meta.pack_versions` the install source is a separate product decision (who builds the catalog from published versions). |
| Gate deprecate, withdraw and a failed review too | Each retires or blocks an unverifiable row; refusing them would leave the row in distribution with no lifecycle exit. |
| Keep withdraw an author-only route | The reviewer meets the 409 at review and publish and would then hold no action; for a forged row the author is the party who did not make it. |
| Sign `status` and the review columns too | They change after submission by design (review, publish), so a publisher's signature cannot cover them; binding them would need a platform signature per transition, which is a different trust model. |
| Log every unverified row on every read | After a key rotation every row that key signed logs per request, which buries the finding; a withdrawn row has nothing left to do. |
| A deny-list of key-flag spellings for `pack sign` | Missed `--pack-signing-key`, the spelling that mirrors the variable; an allow-list closes every spelling. |
| Put the signer in `operate-server` | A publisher is not a deployment operator; the serving binary's subcommands act on a deployment's database. `crossengin` is the authoring CLI and already hosts an offline signer. |
| Accept the seed as a flag, or a public key beside it | ADR-0301 (argv is readable via `ps`) and ADR-0358 (a pair stated twice can be stated inconsistently, with the only symptom `signature_invalid` at the platform). |
| Print the whole submission body | The tool does not know the channel or the changelog, and inventing either would be the tool deciding a fact the publisher states. `channel` is also deliberately outside the envelope (ADR-0454's open question). |

## Consequences

- **Positive:** a stored row whose release was rewritten in both places, or whose review was edited
  to an `exempt` its publisher's kind cannot have, can no longer be passed or published through the
  lifecycle routes; it is listed marked unverified and reported once. An owner-level edit of an
  unsigned column (`status`, a forged `passed` review) is still undetected — §2a. A publisher can sign a release without
  writing code, with the seed kept off argv.
- **Negative:** a key removed from `--pack-publisher-key` now makes every stored row it signed read
  unverified and unpublishable — the honest consequence of asking the registry now, and the reason
  key rotation stays an open question.
- **Neutral:** the authoring read responses gain one additive field per version. `apps/architect-cli`
  gains a dependency on `@crossengin/marketplace` (and a dev dependency on
  `@crossengin/marketplace-runtime` for the round-trip test); `pnpm-lock.yaml` carries both links.
- **Reversibility:** cheap; no schema or stored data changed.
- **Tests:** `@crossengin/marketplace` 203 (9 for `verifyStoredRelease`, mutation-checked: making
  the signature check vacuous fails the two two-column cases; 1 for `packAuthorKindTrusted`),
  `@crossengin/marketplace-runtime` 66 (the exemption check, a failed review on an unverifiable row,
  the strict body), `@crossengin/marketplace-runtime-pg` 32, `apps/operate-server` marketplace admin +
  authoring 48 (a reviewer withdrawing, a reviewer failing, the `exempt` edit refused at publish, the
  once-per-process report, the status-keyed remedy), `apps/architect-cli` 304 (the allow-list, the
  round trip through `PackSubmissionBodySchema`); all five typecheck clean.
- Verified live on both stores as the confined `crossengin_app` role; see **Verified live** below.

## Implementation notes

- `packages/marketplace/src/publishers.ts`: `StoredRelease`, `STORED_RELEASE_REFUSALS`,
  `StoredReleaseVerification`, `verifyStoredRelease`.
- `packages/marketplace/src/packs.ts`: `packAuthorKindTrusted`.
- `packages/marketplace-runtime/src/submission.ts`: `stored_release_unverified`,
  `STORED_VERSION_REFUSALS` (with `review_exemption_unsupported`), `PackSubmissionError.storedRefusal`,
  `verifyStored`, `assertStoredRelease`, `PackSubmissionBodySchema`.
- `apps/operate-server/src/marketplace-authoring.ts`: the 409, `ReleaseVerificationView`,
  `unverifiedReleaseLine`, `createUnverifiedReleaseReporter`, `withVerification`, withdraw granted to
  authors and reviewers. No `node.ts` change: the routes reach the registry
  through the engine they already hold (`ctx.engine.engine`).
- `apps/architect-cli/src/pack.ts` and the `pack` subcommand in `cli.ts` / `bin/crossengin.ts`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `channel` is not in the envelope (ADR-0454), so a release signed for `beta` can be published to `stable`. Whether the publisher or the platform owns the channel is a product decision. | CrossEngin platform | _unscheduled_ |
| Key rotation: a row signed by a key later removed from `--pack-publisher-key` now reads `publisher_unregistered` and cannot be published; there is no "valid when signed" record. | CrossEngin platform | _unscheduled_ |
| `meta.pack_versions` is not an install source; the catalog is a hand-written file whose `securityReviewStatus` is typed by hand. Whether published versions should become the catalog (and then be re-verified at admission from the row) is a product decision. | CrossEngin platform | _unscheduled_ |
| The author kind cannot be re-asked of a stored row, because the manifest is not stored. Storing it (or a re-asked kind) would change the table. | CrossEngin platform | _unscheduled_ |
| The unsigned lifecycle columns (`status`, `security_review_status`, `security_reviewer`) are undetectable when edited by an owner. Detecting them needs a platform-signed transition record, or confining the serving role so it cannot write them (ADR-0424 makes that the default). | CrossEngin platform | _unscheduled_ |
| `crossengin pack sign` has no `verify` counterpart for a publisher to check a signature offline against a public key. | CrossEngin platform | _unscheduled_ |
| A reviewer credential that names no provisioned user cannot review: `meta.pack_versions.security_reviewer` (and `published_by`) reference `meta.users` with `ON DELETE RESTRICT`, so a bare `key:marketplace_reviewer:<tenant>` api-key — which resolves to the shared placeholder principal — gets an unclassified **500** (`pack_versions_security_reviewer_fkey`) on `POST …/review`. Measured live below; it predates this ADR and is ADR-0335's actor-column class. | CrossEngin platform | _unscheduled_ |

## Verified live

Throwaway PG 16 on port 55461, compose order: extensions → `crossengin apply --confirm` as the owner
(990 executed / 0 failed) → `app-role.sql` → `eraser-role.sql` (`DELETION_PGUSER` unset: no-op) →
`document-indexes` (32 of 32 enforced), and for the second store `column-schema --grant-to
crossengin_app` (52 grants). API as `crossengin_app` (`rolsuper=f, rolbypassrls=f`; boot line
`confined on all 115 policied table(s)` on `--store pg`, `166` on `--store pg-columns`), flags
`--marketplace-authoring --pack-publisher-key com.acme:community:<pub> --pack-catalog <file>
--pack-admin-role erp_admin --marketplace-platform-version 1.0.0`, `<pub>`, every signature and the
catalog's 1.0.0 entry produced by `crossengin pack keygen` / `pack sign`. A re-plan afterwards printed
`nothing to do`. Every server arm gave the same result on both stores.

| Arm | Result |
|---|---|
| `pack sign` with `PACK_SIGNING_KEY` unset / `REPLACE_WITH_X` / `AAAA` | exit 2, stdout empty, `is not set` / `documented placeholder` / `must be 32 bytes`; the value is not echoed |
| `--private-key <seed>`; `--pack-signing-key <seed>` | exit 2, `--<flag> is refused — … set PACK_SIGNING_KEY instead` |
| Valid seed, human and `--format json` | exit 0, stdout pure JSON `{submission, publisher}`; `publisher.publicKeyBase64` equals keygen's; the seed occurs 0 times in stdout and stderr |
| Boot with catalog 1.0.0 (tool output) + 9.9.9 (version and `signature.release.version` rewritten) | `2 version(s), 1 installable as catalogued, 1 refused at install`, plus `com.acme.loyalty@9.9.9 … signature_invalid` |
| Tool submission + manifest/channel/changelog posted to `/v1/authoring/packs` (1.0.0, 1.0.1, 1.0.2) | 201 draft each |
| The 1.0.0 output filed as 9.9.9 | 400 `release_version_mismatch`, no row |
| List control | every version `releaseVerification: {verified: true}`; no `stored release unverified` line |
| Owner rewrites 1.0.0's column and `signature.release.version` to 9.9.9 | listed, `{verified: false, refusal: "signature_invalid"}` on the list and on `GET …/versions/9.9.9`; after two lists and one GET exactly one line, `stored release unverified pack=com.acme.loyalty version=9.9.9 status=draft reason=signature_invalid — …`; the public key and its 12-character fingerprint prefix occur 0 times in the log |
| `submit-for-review` on that row | 409 `stored_release_unverified`, `releaseRefusal: signature_invalid`; still `draft` |
| 1.0.1 to `in_review`, then the same edit (→ 9.9.8); `review passed`, `publish` | 409 `stored_release_unverified` each; `in_review`, `published_at` NULL |
| `review failed` on that row, reviewer key bound to a provisioned user | 200, review `failed`; `publish` afterwards 409. With a principal-less reviewer key: 500 (the open question above) |
| Control: honest 1.0.3 through submit → review passed → publish | 201 / 200 / 200 / 200, `published` |
| `withdraw` the rewritten draft as author, the rewritten `in_review` row as reviewer | 200 `withdrawn` each; both still listed, marked unverified |
| Column-only edit (version alone) | row absent from the list, `unreadable pack version … version: custom` (unchanged) |
| Install 9.9.9 / 1.0.0 as `erp_admin` | 409 `signature_invalid`, 0 `meta.pack_installations` rows / 201 admitted, 1 row |
| Restart with `--pack-publisher-key` naming a different key | `0 installable as catalogued, 2 refused at install` (`publisher_unregistered`); every stored row — published, draft, in_review, withdrawn — lists `{verified: false, refusal: "publisher_unregistered"}`; `submit-for-review` on a previously verified draft 409 `stored_release_unverified` / `publisher_unregistered`; neither public key in the log |

The confined role wrote `meta.pack_versions` and `meta.pack_installations` with no `42501`; the only
5xx in any run was the principal-less-reviewer 500.

## References

- ADR-0454 (the release envelope), ADR-0452 (the publisher registry), ADR-0372, ADR-0301, ADR-0358.
