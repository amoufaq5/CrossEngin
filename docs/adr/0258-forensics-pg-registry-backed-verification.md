# ADR-0258: Registry-backed historical chain signature verification (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0254 (audit-chain key registration), ADR-0251 (crypto-pg key registry), ADR-0248 (chain producer), ADR-0077 (Phase 4) |

## Context

Each audit-chain entry records the `signingKeyFingerprint` of the key that signed it (ADR-0248), and the
sealing key's public half is now registered in `meta.crypto_keys` (ADR-0254). What was missing: a way to
*verify* historical chain signatures by resolving each entry's fingerprint to its registered public key
— so an auditor can confirm every entry was signed by a known, registered key, even after key rotation.

## Decision

- **`chain-signature-verify.ts` in `@crossengin/forensics-pg`** — a structural `PublicKeyResolver`
  (`resolveByFingerprint(fp) => Promise<string | null>`) plus `verifyChainSignatures(entries, resolver)`
  and `verifyStoredChainSignatures(store, tenantId, resolver)`. For each entry it resolves the fingerprint
  (caching one resolver call per distinct fingerprint), then `verifyChainEntrySignature` against the
  resolved public key; an unresolved fingerprint is a failure (`unresolved_key`), a mismatch is
  `bad_signature`. An empty chain is vacuously valid. forensics-pg stays **decoupled** from crypto-pg —
  the resolver is structural.
- **`chain-verify.ts` in `apps/operate-server`** — `keyRegistryResolver(registry)` adapts a crypto-pg
  `PostgresKeyRegistry` into that `PublicKeyResolver` (`getByFingerprint(fp)?.publicKeyBase64 ?? null`),
  and `verifyChainAgainstRegistry(store, registry, tenantId)` is the end-to-end registry-backed check.

## Consequences

- Historical audit-chain signatures can be verified against the platform key registry rather than a
  locally-held key: load a scope's chain, resolve each entry's signing fingerprint to its registered
  public key, verify. Rotation is handled naturally — each entry carries its own fingerprint, and the
  registry retains prior keys, so entries signed under an old key still verify.
- The structural `PublicKeyResolver` keeps forensics-pg free of a crypto-pg dependency; the crypto-pg
  binding lives in operate-server (which already depends on both). Verification is a library capability
  (no serve wiring needed) — a caller invokes it on demand.
- +11 forensics-pg tests (all-verify; unknown fingerprint → unresolved; dedup; tampered signature and
  wrong-registered-key → bad_signature; empty vacuous; mixed; resolver-called-once-per-distinct;
  `verifyStoredChainSignatures` round-trip) + 4 operate-server adapter tests (resolve known / unknown /
  no-public-material, delegates to getByFingerprint). No META tables, no schema-count change. Full build +
  typecheck + workspace tests green.
- Follow-up (open): a serve-level `verify-chain` CLI command / endpoint (needs a signer-free chain reader,
  since `PostgresChainLogStore`'s constructor currently requires a signer even for read-only verification).
