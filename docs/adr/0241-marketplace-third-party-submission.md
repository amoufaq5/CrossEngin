# ADR-0241: Third-party pack submission + security-review pipeline (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0060-era `marketplace` contracts, `marketplace-runtime` (install engine), ADR-0077 (Phase 4 — marketplace to third-party authors) |

## Context

`marketplace-runtime` executes the *install* side (admit installation, permission grants, uninstall/
update), and the `marketplace` contracts model pack versions, security-review statuses, ed25519 pack
signatures, and author trust — but nothing drove the *publish* side. To open the marketplace to
third-party authors, a submitted pack must move through `draft → in_review → published` with the
signature verified and a security review gating publication. This adds that pipeline.

## Decision

- **`PackSubmissionEngine`** (`marketplace-runtime/src/submission.ts`), a pure state-machine engine over
  the `marketplace` contracts:
  - `submit(input)` — **verifies the ed25519 signature** against the author's public key
    (`verifyPackSignature`; a bad signature throws `PackSubmissionError`), then creates a `draft`
    `PackVersionRecord`. The review requirement is derived from the manifest via `requiresElevatedReview`
    (PHI access, `:admin` scopes, or an untrusted author): an untrusted `community` / `private_tenant`
    author's pack starts `securityReviewStatus: "pending"`, a trusted `crossengin_official` /
    `certified_partner` author's non-PHI pack starts `"exempt"`.
  - `submitForReview` — `draft → in_review` (a pending review moves to `in_progress`; an exempt one
    stays exempt).
  - `recordReview({status: passed|failed, reviewer})` — records the review outcome (only while
    `in_review`).
  - `publish({publishedBy})` — `in_review → published`, **gated**: publishing to the `stable` channel
    requires `securityReviewStatus` `passed` or `exempt` (matching the contract's own invariant).
  - `deprecate` / `withdraw` with a required reason.
  - Every transition is guarded by `canTransitionVersion` and re-validated through
    `PackVersionRecordSchema`, so the contract's publish/deprecate/withdraw field invariants (published
    needs `publishedAt`/`publishedBy`, etc.) always hold — the engine can never emit an invalid record.

## Consequences

- The marketplace is now open to third-party authors end-to-end: a `community` author signs and submits
  a pack, it is automatically flagged for security review (because the author is untrusted, or the pack
  touches PHI / admin scopes), a reviewer records pass/fail, and only a passed (or exempt) review can
  publish to the stable channel. First-party / certified-partner non-PHI packs skip review (exempt) but
  still flow through the same pipeline.
- Trust is policy, not code paths: `requiresElevatedReview` decides the review requirement from the
  manifest, so tightening the policy (e.g. always review PHI) is a contract change, not an engine one.
- The engine is pure + offline-tested (real ed25519 keypairs via `@crossengin/crypto`, signed manifests,
  the full submit → review → publish → retire flow + the signature/gate/transition rejections); a `-pg`
  sibling persisting `PackVersionRecord`s into a registry table, and an HTTP submission edge in
  `operate-server` (like the admin install routes), are the follow-ups.
- +11 tests. Full build + typecheck + workspace tests green. No META tables, no new package (extends
  `marketplace-runtime`), no new dependency.
- Follow-ups (open): `marketplace-runtime-pg` persistence for submitted versions + review history; a
  third-party submission HTTP route; author onboarding / key registration.
