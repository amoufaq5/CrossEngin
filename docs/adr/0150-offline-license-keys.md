# ADR-0150: Offline Ed25519 license keys (on-prem entitlement)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0149 (subscription entitlement gate), ADR-0048 (crypto — Ed25519), `marketplace` (ed25519 pack signing) |

## Context

The entitlement gate (ADR-0149) resolves a tenant's subscription via an injected
`EntitlementResolver`. Cloud reads it from a billing store, but a **local / on-prem**
deployment can't call a cloud billing API — its entitlement must be provable offline from a
signed license. Delivered by an agent alongside the subscription UI.

## Decision

**`license.ts` (`operate-runtime`).** A license is a signed set of entitlement claims.
- **Token:** `"<b64url(canonicalJson(claims))>.<base64(signature)>"`. `canonicalJson`
  recursively sorts object keys so identical claims canonicalize identically; the Ed25519
  signature (via `@crossengin/crypto` `signEd25519`) is over the payload string.
- **Claims (`LicenseClaimsSchema`):** `tenantId`, `status` (an `EntitlementStatus`), optional
  `planId` / `features` / `maxRecordsPerEntity`, and ISO `issuedAt` / `expiresAt`.
- **`verifyLicense(token, publicKeyB64, now?)`** returns `{valid, claims?, reason?}`, checked
  in order: `malformed_token` → `bad_signature` (`verifyEd25519`) → `malformed_claims`
  (schema) → `expired` (`now ≥ expiresAt`) → valid. No throws.
- **`LicenseEntitlementResolver`** implements `EntitlementResolver`: re-verifies on each
  `resolve(tenantId)`, returns `null` when invalid or the tenant doesn't match the license (so
  the gate denies), else the `Entitlement` from claims.
- **`signLicense`** mints a token (tooling / tests).

Adds `@crossengin/crypto` as an `operate-runtime` dependency (the module needs Ed25519).

## Consequences

- An on-prem `operate-server` can enforce a subscription with **no network dependency**:
  ship a customer an Ed25519-signed license bound to their tenant + expiry; the boot wires a
  `LicenseEntitlementResolver` into the gate. Expiry or tamper → the gate denies.
- Reuses the same Ed25519 primitives as marketplace pack signing; the public key is the only
  thing the deployment embeds.
- 18 new tests (canonicalization determinism, b64url round-trip, sign→verify, tamper/wrong-
  key → `bad_signature`, expiry, resolver tenant-match/omit-optionals). Full build green.
- Follow-ups: an `operate-server --license <file>` flag to load it at boot; a licensor CLI to
  mint/rotate licenses; a short grace period after `expiresAt`.
