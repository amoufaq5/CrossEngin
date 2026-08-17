# ADR-0251: Postgres key registry (`crypto-pg`) (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0048 (`crypto` — KeyStore + KeyRecord), ADR-0248 (forensics-pg chain producer), ADR-0077 (Phase 4) |

## Context

`@crossengin/crypto` defines a `KeyStore` (with an in-memory implementation holding signing material) and
a `KeyRecord` shape, and the meta-schema already has a `meta.crypto_keys` table — but nothing persisted
the key lifecycle to it. Evidence-sealing / webhook / pack-signing keys had no durable, queryable
registry: no way to look up "which key produced this fingerprint", list active keys, or track rotation /
revocation across restarts.

## Decision

Ship **`@crossengin/crypto-pg`** — the Postgres persistence sibling for the crypto **key registry**.

- **Registry, not a signing store.** `meta.crypto_keys` stores only `public_key_base64` +
  `fingerprint_sha256` + lifecycle metadata — **no private key material** — so `crypto-pg` is a
  queryable registry of the public/lifecycle view, complementing `crypto`'s in-memory `KeyStore` (which
  holds the signing secret). It persists what can safely live in the database: public key, fingerprint,
  algorithm, purpose, version, status.
- **`PostgresKeyRegistry`** over `meta.crypto_keys`: `register` (INSERT … `ON CONFLICT (key_id) DO
  UPDATE` — upserts public key / fingerprint / version / status, leaving immutable identity columns
  untouched), `getByKeyId`, `getByFingerprint`, `listActive`, `listKeys(filter)`, `markStatus` /
  `revoke` / `markRotating`. The schema identifier is validated; the tenant id is bound (never
  interpolated) via a `scoped()` helper honoring the table's platform-or-tenant RLS policy.
- **`records.ts`** — `KeyRegistryRecordSchema` + `keyRegistryRecordFrom(record: KeyRecord)` (the pure
  projection from a crypto `KeyRecord`) + `rowToKeyRegistryRecord` (coerces Dates, trims `CHAR(64)`
  padding, maps nullable public material).

## Consequences

- The platform now has a durable key registry: resolve a signing fingerprint to its public key (e.g. to
  verify a forensic-chain entry's signature), enumerate active evidence-sealing keys, and track a key
  through `active → rotating → revoked` — all as SQL against `meta.crypto_keys`, surviving restarts and
  spanning nodes.
- Honest scope: `crypto-pg` persists the *public* view only. Signing still happens where the private key
  lives (the in-memory store, or the serving edge's configured keypair). A private-key-bearing store
  (KMS / envelope-encrypted material) is a separate, larger design and explicitly out of scope.
- Reuses the existing `meta.crypto_keys` table — **no new META table, no schema-count change**. Depends
  on `crypto` + `kernel-pg` + `zod`; `crypto` stays free of any Postgres dependency.
- Known unmapped columns (documented invariants, not populated by the projector): `rotated_from_key_id`
  (the `KeyRecord.rotatedFromKeyId` is a `KeyId` string, not the surrogate UUID FK the column expects, so
  lineage is intentionally dropped rather than mis-joined), `id` (server-generated surrogate — the
  registry keys on `key_id`), `created_by_user_id` / `rotated_at` / `revoked_at` (no source on
  `KeyRecord`). All other columns map 1:1 and round-trip.
- +24 tests (projector for ed25519-with-fingerprint / hmac-with-nulls / rotation version bump; schema
  reject paths; row parsing; register + getByKeyId round-trip; upsert idempotency + status/version
  upsert; getByFingerprint; markStatus / revoke + invalid-status guard; listActive filters; tenant RLS
  scoping; malformed schema/tenant guards). Full build + typecheck + workspace tests green.
- Follow-up (open): wire the audit-chain (and other signers) to register their sealing key's public half
  into the registry at boot, so a chain entry's `signingKeyFingerprint` resolves to a registered public
  key for verification + rotation tracking through the platform's own key management.
