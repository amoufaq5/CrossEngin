# ADR-0026: Marketplace and extensions

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0004, ADR-0008, ADR-0009, ADR-0012, ADR-0024, ADR-0027 |

## Context

Tenants want to install pre-packaged extensions: vertical templates (a pharmacy starter pack), integration bundles (Salesforce + ServiceNow + Stripe pre-wired), custom AI tools the AI Architect can invoke, UI extensions, workflow packs, themes. The platform needs a distribution channel for these.

Three constituencies compete for design weight:

1. **First-party.** CrossEngin ships official vertical templates and integration bundles. These set the quality bar.
2. **Certified partners.** Consulting partners, system integrators, and ISVs distribute commercial packs for revenue share. These require a publishing workflow with security review.
3. **Community.** Developers can publish free, community-maintained packs. These are lower trust and need stricter guardrails (no PHI access, lighter review).

The marketplace is a regulated surface — packs run inside tenant contexts and can request OAuth-style scopes. A malicious or poorly-written pack could exfiltrate PHI, exhaust quotas, or impersonate users. The publishing flow, signing scheme, install lifecycle, and permission grants need to be auditable end-to-end.

Two further constraints:

- **Tenant-internal packs.** Some tenants will build private packs that only their own users see. These shouldn't go through public review but still need a publishing pipeline.
- **Compliance interaction.** A pack that handles PHI must require a HIPAA-active tenant. Compatibility checks at install time prevent silent compliance breaches.

## Decision

The marketplace contract has **six core types**, all in `@crossengin/marketplace`:

1. **`PackManifest`.** Declarative metadata: id (reverse-DNS dotted), kind (8 kinds: vertical_template, integration_bundle, ai_tool, ui_extension, workflow_pack, compliance_addon, data_connector, theme), author with `PackAuthorKind` (4 kinds — crossengin_official, certified_partner, community, private_tenant), required + optional scopes, dependencies on other packs, min/max platform versions, license.

2. **`PackVersionRecord`.** A specific released version with a 5-state lifecycle (draft → in_review → published → deprecated → withdrawn), distribution channel (stable / beta / canary / internal), ed25519 signature (with publicKey fingerprint sha256), bundle sha256, security review status. Stable-channel publications require a passed or exempt security review.

3. **`PackCompatibility`.** Per-pack requirements: min/max platform version, allowed/blocked regions, required plan tier, required compliance packs, requires-dedicated-tenant. `checkCompatibility` returns all reasons a pack cannot be installed in a given `TenantContext` — multi-fault diagnostics rather than short-circuit.

4. **`PermissionGrantSet`.** Per-(tenant, pack) scope grants with 4-status lifecycle (pending / granted / denied / revoked). `resolvePermissions` splits a pack's request against the granted set into satisfied / missing-required / granted-optional / pending.

5. **`PackInstallation`.** Per-tenant install record with 8-state lifecycle (requested → permission_pending → installing → installed → updating / uninstalling → uninstalled), 4 update policies (manual, patch_auto, minor_auto, track_latest), pinned-version support. At most one active installation per (tenant, pack); uninstalled installations are eligible for reinstall.

6. **`MarketplaceListing`.** Public-facing entry: title, tagline, screenshots, 5-state lifecycle (draft → submitted → approved → live → delisted), pricing model (6 models: free / one_time / per_seat_monthly / per_tenant_monthly / metered / request_quote), aggregated rating from `PackReview` records.

Four meta-schema tables persist these: `META_EXTENSION_PACKS`, `META_PACK_VERSIONS`, `META_PACK_INSTALLATIONS` (RLS-scoped), `META_PACK_REVIEWS` (RLS-scoped).

## Alternatives considered

- **Option A:** Generic plugin manifest from an existing standard (VSCode-style, JSON-RPC plugins).
  - **Pros:** Lower-cost; existing tooling.
  - **Cons:** Doesn't model security review, regulatory compatibility, tenant-internal distribution, or pricing.
  - **Why not:** Marketplace governance is the hard problem here; we'd recreate everything except the file format.

- **Option B:** OAuth 2.0 dynamic client registration as the install model.
  - **Pros:** Standard.
  - **Cons:** OAuth models authorization, not lifecycle / compatibility / pricing / version pinning. We'd still need everything else.
  - **Why not:** OAuth is one piece (we use SDK scopes for it); marketplace is the bigger surface.

- **Option C:** Flat permissions — every pack can read everything within the tenant.
  - **Pros:** Simple.
  - **Cons:** Catastrophic blast radius for a malicious community pack.
  - **Why not:** Defense in depth requires scope-level grants.

- **Option D:** Mandatory review for every pack version regardless of author.
  - **Pros:** Strongest security.
  - **Cons:** Friction kills marketplace velocity; not enough reviewer capacity.
  - **Why not:** Channel + author tier already differentiates trust. Beta channel + official author bypass review legitimately.

## Consequences

- **Positive.** Trust-tiered publishing scales. Tenants get a curated catalog. Partners get revenue share. Compliance compatibility prevents accidental policy breaches. Audit trail spans publish → install → permission grant → use.
- **Negative.** Significant surface to operate: review queue, signing-key rotation, compatibility matrix, revenue accounting. Permission grant UX is non-trivial.
- **Neutral.** Bundle format (.crossengin-pack.zip) is implementation; the manifest schema constrains content but not transport.
- **Reversibility.** Schema changes for `PackManifest` are easy in Phase 1 (no live packs). Once packs are published, manifest changes require version-2 schemas — moderately costly.

## Implementation notes

- **Signing.** Ed25519 chosen for keypair signing of pack bundles (smaller signatures than RSA, well-supported in Node + browser). Public key fingerprints are sha256 of the raw key.
- **Trusted authors.** `packAuthorTrusted()` returns true only for `crossengin_official` and `certified_partner`. `requiresElevatedReview()` flags PHI access, admin scopes, or untrusted authors.
- **Update policies.** `shouldAutoUpdate()` encodes semver compatibility: `patch_auto` stays in same minor, `minor_auto` stays in same major, `track_latest` accepts anything newer, `manual` never auto-updates. Pinned versions force `manual`.
- **Listings.** Top-of-mind for marketplace UX: screenshot limit (8), tagline limit (160 chars), description limit (10k chars), rating must be null when ratingCount=0 (and present when >0).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Pack revocation across already-installed tenants — auto-uninstall vs notification | _pending_ | Phase 2 |
| Revenue share percentage and Stripe Connect wiring | _pending_ | Phase 3 |
| Cross-tenant pack-internal pattern (one pack, multiple tenants share data?) — defer or build | _pending_ | Phase 3 |

## References

- ADR-0027 (SDK contract) for the scopes pack manifests reference.
- ADR-0012 (compliance packs) — distinct from marketplace packs (regulatory bundles, not installable extensions).
- `packages/marketplace/src/` for the zod schemas and helpers.
