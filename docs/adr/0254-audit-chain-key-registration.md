# ADR-0254: Registering the audit-chain sealing key in the key registry (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0251 (crypto-pg key registry), ADR-0249 (audit-chain wiring), ADR-0248 (chain producer), ADR-0077 (Phase 4) |

## Context

The audit chain signs each entry with an Ed25519 key configured at the serving edge (`--audit-chain-config`),
recording the signer's fingerprint on every entry. But that key existed only in the config file — it was
not in the platform key registry (`meta.crypto_keys`), so a chain entry's `signingKeyFingerprint` could not
be resolved back to a public key for verification, and the key had no lifecycle record. This connects the
edge sealing key to the registry (`crypto-pg`, ADR-0251).

## Decision

- **`audit-chain-key-registration.ts`** in `operate-server`:
  - `deriveAuditChainKeyId(fingerprintHex)` — a **deterministic**, stable `key_ed25519_<26 Crockford-
    uppercase chars>` derived from the leading 130 bits of the key's sha256 fingerprint. Crockford's
    uppercase alphabet is exactly the `crypto_keys.key_id` check-constraint char class
    (`[0-9A-HJKMNP-TV-Z]`), so the derived id always satisfies the DB constraint, and the same key always
    maps to the same id — making registration idempotent across restarts.
  - `auditChainKeyRegistryRecord(config, opts?)` — builds a schema-valid `KeyRegistryRecord` (algorithm
    `ed25519`, purpose `evidence_sealing`, `active`, version 1, **public key + fingerprint only**, never
    the private key), keyed by the derived (or overridden) id, tenant defaulting to platform.
  - `registerAuditChainKey(registry, config, opts?)` — builds + `registry.register(record)` (upserts on
    `key_id`).
- **`serve()` wiring** — when `--audit-chain-config` is active over a pg store, after building the audit
  chain, `serve()` registers the sealing key into `meta.crypto_keys` via `PostgresKeyRegistry`,
  **best-effort**: a registry failure is logged and never stops serving (the chain still writes and
  verifies without the registry entry).

## Consequences

- A chain entry's `signingKeyFingerprint` now resolves to a registered public key: a verifier can
  `getByFingerprint` to fetch the key material and check `verifyChainEntrySignature`, and the key's
  presence / status (`active → rotating → revoked`) is tracked in the registry alongside webhook / pack /
  tombstone keys.
- The registration is public-only and idempotent; rotating the edge keypair registers a new derived id
  (the old one stays for verifying historical entries signed under it — each entry carries its own
  fingerprint). Private key material never touches the database.
- App-only, no META tables, no schema-count change. `@crossengin/crypto-pg` added as an operate-server
  dependency. +12 tests (deterministic derivation + key_id regex conformance over random keys + Crockford-
  only symbols + stability; record shape / fingerprint / tenant / override; register → resolvable by
  fingerprint + id, idempotent). `serve()` registration stays offline-untestable, like the other serve
  wirings. Full build + typecheck + workspace tests green.
- Follow-up (open): a verification path that reads the registry to check historical chain signatures; a
  rotation command that marks the prior key `rotating`/`revoked` when a new sealing key is deployed.
