# ADR-0454: A pack signature covers the release, not the manifest

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0452 (a pack is trusted by a registered publisher; this closes its replay row), ADR-0346 and ADR-0393 (canonical JSON, never a delimiter join; the wire version derived from the domain tag), ADR-0338 (refuse when nothing correct breaks), ADR-0373 (a stored row that disagrees with its contract reads as unreadable) |

## Context

ADR-0452 measured live that a publisher's signature replays onto any release: the same signature
re-sent as `9.9.9` with a new `bundleSha256` and an arbitrary `manifestSha256` returned 201. That
increment closed the digest half — `manifestSha256` must equal `packManifestDigest(manifest)` or the
submission is refused `manifest_digest_mismatch` — and left the rest open, because the signature
covered `crossengin.pack.v1\n` + canonical JSON of the manifest and nothing else. A captured
signature could therefore still be filed under any `version` with any bundle, and for a
`crossengin_official` publisher a replayed non-PHI version is review-exempt
(`requiresElevatedReview` answers false), so it would publish to `stable` with no human in the loop.

The same gap reached install: `admitInstallation` verified the catalog entry's signature over the
manifest alone, so a catalog line could name any version of a pack whose manifest a publisher had
once signed.

## Decision

**A publisher signs a release envelope, and every verifier checks the envelope.**

1. **The envelope.** `PackReleaseClaimSchema` (in `@crossengin/marketplace`'s `registry.ts`) is
   `{form, packId, version, manifestSha256, bundleSha256}`, `.strict()`, with `form` the literal
   `PACK_RELEASE_FORM = "crossengin.pack.release.v1"`. `PackSignature` gains an optional `release`
   carrying it. The signed bytes are `canonicalReleaseBytes(release, signer)`:
   `<release.form>\n` followed by canonical JSON (sorted keys) of **one object** holding the claim
   plus the signature's `publicKeyFingerprint` and `signedAt`. The domain tag is derived from the
   claim's own `form`, so the tag and the field cannot disagree about which message a signature is
   over (ADR-0393's wire-version lesson); an object rather than a delimiter join for ADR-0346's
   reason. The fingerprint is inside so a signature cannot be relabelled as another key's, and
   `signedAt` so the stated signing time is the signer's.

2. **The claim is derived, not typed.** `packReleaseClaimFor({manifest, version, bundleSha256})`
   takes the pack id from `manifest.id` and the manifest digest from `packManifestDigest(manifest)`,
   so a signer cannot sign a digest of something other than the manifest it was handed.
   `signPackRelease` and `signPackReleaseWithStore` replace `signPackManifest` and
   `signPackManifestWithStore`; `verifyPackReleaseSignature` replaces `verifyPackSignature`. The old
   names are deleted rather than kept beside the new ones, because a manifest-only signer left in the
   package is the one function that could produce the form every verifier now refuses.

3. **`canonicalManifestBytes` keeps its tag and is no longer a signed message.** It is the
   preimage of `packManifestDigest`, which the envelope signs. A legacy signature over
   `crossengin.pack.v1\n{manifest}` cannot verify as a release signature even with a release claim
   grafted beside it, and the separation has two independent legs: the tags differ, and the bodies
   differ in shape (`PackManifestSchema` refuses an envelope body). The grafting test signs the
   legacy bytes with the real key and asserts the refusal, but it does **not** isolate the tag — it
   would pass with equal tags, because the bodies alone differ. The tag's distinctness is fenced by
   the prefix test on `canonicalReleaseBytes` (mutation-checked: setting `PACK_RELEASE_FORM` to
   `crossengin.pack.v1` fails it), and the body-shape leg by its own test.

4. **The order of `verifyPackPublisher`.** It now takes `submitted: {version, bundleSha256}` and
   answers, first failure wins:
   `legacy_signature_form` → `publisher_unregistered` → `pack_outside_publisher_namespace` →
   `author_kind_not_registered` → `signature_invalid` → `release_pack_mismatch` →
   `release_manifest_mismatch` → `release_version_mismatch` → `release_bundle_mismatch`.
   The claim comparison sits **after** the signature check on purpose: before it, the claim is
   whatever the caller typed, so "you signed 1.0.0 and submitted 1.0.1" would be a statement about a
   value nobody signed. After it, each mismatch is a true statement about what the publisher
   released, and is exactly the replay ADR-0452 measured. A digest is never echoed in a refusal; the
   version is, because it is the caller's own semver.

5. **A manifest-only signature is refused outright, by name, with no transition period.**
   `PackSignatureSchema.release` is optional precisely so such a signature parses and reaches a
   verifier that answers `legacy_signature_form`, rather than a `ZodError` naming a missing key. It
   is checked first because no key could verify it. No transition period, because **nothing working
   breaks**: `--pack-catalog`, `--marketplace-authoring` and `--pack-publisher-key` appear **0** times
   in `deploy/docker-compose.yml`, `docker-compose.ai.yml`, `docker-compose.ai-gpu.yml`,
   `ci-smoke.sh`, `.env.example`, `README.md` and `VERCEL-SUPABASE.md`, and once in `ORACLE.md`, as
   prose listing `--pack-catalog` among the file-taking flags the shipped set does not pass (measured
   with `grep -c` at this ADR). No pack catalog file exists in the repository. So no shipped
   deployment holds a legacy signature to refuse — ADR-0338's premise.

6. **Submission.** `PackSubmissionEngine.submit` passes `{version, bundleSha256}` from the body.
   The caller's `manifestSha256` is still compared to the derived digest **before** the publisher
   check, so ADR-0452's live shape (new version, new bundle, arbitrary digest) is still named
   `manifest_digest_mismatch`; with the digest corrected it is `release_version_mismatch`. The five
   new reasons join `PACK_SUBMISSION_REFUSALS` and the route's total `SUBMISSION_REFUSAL_STATUS` map:
   all five are **400** — `legacy_signature_form` because the remedy is the caller's (re-sign), and
   the four mismatches because the body contradicts its own signature, which is
   `manifest_digest_mismatch`'s reasoning — never 403, which would say the signer is not allowed
   rather than that the request disagrees with itself.

7. **Install.** `InstallRequest` gains a required `bundleSha256`, `PackCatalogEntry` and the catalog
   file schema gain a required `bundleSha256` (sha256 hex), and `admitInstallation` and
   `surveyPackCatalog` pass `{version, bundleSha256}` from the catalog entry. So a catalog line
   naming a version or bundle the publisher did not sign is refused at install (409, as every install
   rejection is) and named at boot by the existing `[marketplace] catalog … will be refused at
   install` line. The five reasons join `INSTALL_REJECTION_REASONS`. The headline above those lines
   was relabelled: it read `N signed by a registered publisher` and counted `total − findings`, which
   is false for a release-mismatch entry — its signature *does* verify against a registered key, the
   mismatch is checked only afterwards. `formatPackCatalogSurvey` prints
   `N installable as catalogued, M refused at install`, which is what the subtraction measures.

8. **A stored row must agree with the release its signature names.** `PackVersionRecordSchema`'s
   refinement adds: when `signature.release` is present, `packId`, `version`, `manifestSha256` and
   `bundleSha256` must equal the claim's. The engine refuses a disagreement before it builds a
   record, so this catches a **single-column** edit afterwards — an
   `UPDATE pack_versions SET version = '9.9.9'` that leaves the signed claim behind — which then
   reads as an unreadable row (ADR-0373). It does **not** bind the row to its signer: an edit that
   also rewrites `signature.release` (`jsonb_set(signature, '{release,version}', '"9.9.9"')`) passes
   the refinement and reads as a release the publisher never made, because nothing on the read path
   re-verifies the Ed25519 signature against the publisher registry. That is recorded as an open
   question rather than claimed closed. A legacy row with
   no release still parses, so a stored record of a pre-ADR-0454 submission stays readable and
   simply can never be re-verified.

## Alternatives considered

| Option | Why not |
|---|---|
| Reconstruct the envelope from the submitted facts and only verify | Every mismatch would read `signature_invalid`, indistinguishable from a forgery. Carrying the claim beside the signature costs nothing (it is not secret) and lets each mismatch be named, after the signature has proved the claim is the signer's. |
| A separate `form` field on `PackSignature` beside `release` | Two fields that must agree; the form inside the claim is in the signed bytes and is the domain tag, so it cannot drift from the message. |
| Accept legacy signatures during a transition window | The flags are on no shipped deployment and no catalog file exists, so a window would protect nothing and keep the replay open for its duration. |
| Make `release` required in the schema | A legacy signature would be a schema 400 listing `release: Required` instead of a named refusal, and every stored pre-ADR-0454 row would become unreadable. |
| Make the catalog's `bundleSha256` optional and take it from the signature | Then the install check would compare the claim against itself. The catalog states what it offers and the signature must agree with it. |
| Bind `channel`, `bundleSizeBytes` or `changelog` too | `channel` is a distribution decision the platform may change; the size is implied by the bundle digest; the changelog is prose. The four bound facts are what a version row asserts about the artifact. Recorded as an open question. |

## Consequences

- A captured signature cannot be filed under a different version, a different bundle, a different
  manifest (even with that manifest's own digest beside it) or a different pack id, at submission or
  at install. Tests prove each arm in `@crossengin/marketplace` (publishers, signing, registry),
  `@crossengin/marketplace-runtime` (submission, install), `@crossengin/marketplace-runtime-pg`
  (a row whose column was edited without its signed claim reads unreadable; one whose claim was
  rewritten too is not caught on read) and `apps/operate-server` (the 400s and the 409, with nothing
  stored).
- Every signer must change: the wire form is new and the old one is refused. There is no in-repo
  signing CLI; a publisher calls `signPackRelease` (or the `KeyStore` form).
- Tests: `@crossengin/marketplace` 193, `@crossengin/marketplace-runtime` 53,
  `@crossengin/marketplace-runtime-pg` 31, `apps/operate-server` marketplace admin + authoring 37,
  all green; the three packages and `apps/operate-server` typecheck clean.
- Verified live on both stores as the confined `crossengin_app` role; see **Verified live** below.

## Open questions

| Question | Owner | Due |
|---|---|---|
| `channel` is not in the envelope, so a release signed for `beta` can be submitted to `stable`. Whether the publisher or the platform owns the channel is a product decision. | CrossEngin platform | _unscheduled_ |
| No key rotation story beyond ADR-0452's: a release signed by a key later removed from `--pack-publisher-key` is refused at install, with no way to say "valid when signed". | CrossEngin platform | _unscheduled_ |
| There is no signing tool for publishers; the envelope is reachable only from code. | CrossEngin platform | _unscheduled_ |
| A stored `meta.pack_versions` row is checked against its own signed claim on read, not against its signer: an `UPDATE` rewriting both the column and `signature.release` reads as a valid release. Closing it means re-verifying the signature against the publisher registry on read (or before install), which needs the registry on the read path. | CrossEngin platform | _unscheduled_ |
| The boot headline counts entries installable as catalogued; it does not separately count entries whose signature verifies but whose release disagrees with the catalog entry (those are named per entry by the `will be refused at install` lines). | CrossEngin platform | _unscheduled_ |
| `PACK_RELEASE_FORM` is a single literal; a second form needs an enum and a per-form byte builder, and must not be a field added to the existing claim. | CrossEngin platform | _unscheduled_ |

## Verified live

Throwaway PG 16 on port 55441, compose order (extensions → `crossengin apply --confirm` as the owner,
990 executed / 0 failed → `app-role.sql` → `document-indexes`), API as `crossengin_app`
(`rolsuper=f, rolbypassrls=f`; boot line `confined on all 115 policied table(s)` on `--store pg`,
`166` on `--store pg-columns` after `column-schema --grant-to crossengin_app`). Flags:
`--marketplace-authoring --pack-publisher-key com.acme:community:<pub> --pack-catalog <file>
--pack-admin-role erp_admin --marketplace-platform-version 1.0.0`. A re-plan after the run printed
`nothing to do — the live schema matches the catalog`. Every arm below gave the same result on both
stores; "rows" is `meta.pack_versions` read as the owner and through
`GET /v1/authoring/packs/com.acme.loyalty/versions`.

| Arm | Result | Rows |
|---|---|---|
| Signature for 1.0.0, submitted as 9.9.9 | 400 `release_version_mismatch` | none |
| Same, `bundleSha256` changed | 400 `release_bundle_mismatch` | none |
| Same, a different manifest with its own correct digest | 400 `release_manifest_mismatch` | none |
| ADR-0452's shape (9.9.9 + new bundle + arbitrary digest), 201 before ADR-0452 | 400 `manifest_digest_mismatch` | none |
| 9.9.9 with `signature.release.version` rewritten to match | 400 `signature_invalid` | none |
| Signature with `release` removed (manifest-only form) | 400 `legacy_signature_form` (named, not a schema error) | none |
| Signed by an unregistered key | 403 `publisher_unregistered` | none |
| Control: correctly signed 1.0.0 | 201 draft; stored `signature.release.form = crossengin.pack.release.v1`, `release.version = 1.0.0` | 1.0.0 |
| Control: separately signed 1.0.1 with bundle `b…` | 201 | 1.0.0, 1.0.1 |
| Resubmit 1.0.0 unchanged | 409 `version_exists` | unchanged |
| Owner `UPDATE … SET version='9.9.9'` (column only) | the row is missing from the list, logged `unreadable pack version … id=com.acme.loyalty@9.9.9: version: custom`; 1.0.1 still listed | — |
| Owner rewrites the column **and** `signature.release.version` with `jsonb_set` | listed as `9.9.9`, which is the open question above, measured | — |
| Boot with a 3-entry catalog (1.0.0 signed; 2.0.0 reusing 1.0.0's signature; 3.0.0 legacy) | `3 version(s), 1 installable as catalogued, 2 refused at install`, plus one line each naming `release_version_mismatch` and `legacy_signature_form` | — |
| Install 2.0.0 / 3.0.0 as `erp_admin` | 409 `release_version_mismatch` / 409 `legacy_signature_form`; 0 `meta.pack_installations` rows | — |
| Install 1.0.0 (control) | 201 admitted; 1 row, `requested_by` = the provisioned user | — |
| Catalog entry with no `bundleSha256` | boot exits 1, zod `invalid_type` at `packs[0].bundleSha256` | — |

The confined role inserted `meta.pack_versions` and `meta.pack_installations` with no `42501`.

## Addendum — ADR-0459

Two of the open questions above are closed by ADR-0459:

- **A stored row checked against its own claim, not its signer.** `verifyStoredRelease` re-verifies a
  `meta.pack_versions` row's signature against the publisher registry; `submit-for-review`, `review`
  and `publish` refuse a row that fails it as **409 `stored_release_unverified`**, and the authoring
  read routes list it marked `releaseVerification: { verified: false, … }` with one log line, rather
  than hiding it. This ADR's question said "on read (or before install)"; measured, the stored row is
  never an install source — install reads the `--pack-catalog` file and already re-verifies that entry
  at every admission — so the gate for a stored row is the lifecycle (`publish` above all), and install
  is fenced by a test against the same two-column edit instead. That gate covers the routes and not
  the table: `status` and the review columns are outside the signature (ADR-0459 §2a).
- **No signing tool.** `crossengin pack keygen` and `crossengin pack sign <manifest.json> --version
  <semver> (--bundle <file> | --bundle-sha256 <hex>)` sign the release envelope with
  `signPackRelease`, the seed from `PACK_SIGNING_KEY` only.

`channel` outside the envelope and key rotation remain open, as product decisions.
