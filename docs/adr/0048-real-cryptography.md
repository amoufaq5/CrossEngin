# ADR-0048: Real cryptography (Phase 2 M2)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0009 (security model), ADR-0026 (marketplace), ADR-0035 (audit + forensics), ADR-0040 (access reviews), ADR-0042 (data lineage), ADR-0046 (Phase 2 plan) |

## Context

The Phase 1 surface declares many cryptographic fields as opaque strings: `sha256` hashes anchor evidence, postmortems, ml datasets, webhook bodies, and tombstones; `hmac-sha256` signs outbound webhooks (`sdk/webhooks.ts`); `ed25519` signs marketplace packs (`marketplace/registry.ts`). Today these fields exist as zod-validated string shapes — nothing actually produces or verifies them. M2 closes that gap.

Three concrete requirements:

1. **Real, verifiable values.** A pack signed with M2 crypto must verify with `verifyPackSignature(publicKey, signature, manifest)`; a webhook signed by us must verify with the same code path the customer's library runs.
2. **No raw key material crosses package boundaries.** Calling code receives a `KeyHandle` (opaque), never the bytes. The handle is presented to the key store, which performs the operation. This is the contract that makes a future KMS / HSM backend a drop-in replacement.
3. **Per-tenant isolation.** Tenant A's keys cannot be used to sign Tenant B's records. The key handle carries `tenantId`; the store enforces that any operation under a handle requires that the caller-asserted tenant matches.

There's also a sequencing constraint: M4 (gateway runtime) needs HMAC verification, M6 (workflow signal bridge) needs webhook signature verification, M7 (first vertical pack) needs pack signing — all must consume the same `@crossengin/crypto` API. This ADR fixes that API before downstream milestones lock it in.

## Decision

`@crossengin/crypto` ships with **seven modules** + meta-schema integration:

1. **`algorithms.ts`.** Single source of truth for supported algorithms:
   - `HashAlgorithm = "sha256" | "blake2b-512"`. SHA-256 covers existing fields; BLAKE2b-512 covers forensics' faster hash-chain use case (already declared in `HASH_ALGORITHMS`). We use blake2b-512 rather than blake2b-256 because Node's BLAKE2 binding does not expose custom output length, and truncating BLAKE2b-512 to 32 bytes is NOT equivalent to native BLAKE2b-256 (the digest length is part of the parameter block).
   - `MacAlgorithm = "hmac-sha256"`. The one MAC we use.
   - `SignatureAlgorithm = "ed25519"`. The one signature algorithm we use.
   - `KeyPurpose = "pack_signing" | "webhook_signing" | "evidence_sealing" | "tombstone_anchoring"`. Limits key reuse — a webhook key cannot sign a pack.
   - `CRYPTO_VERSION = 1`. Bumps when we change the canonicalization or KDF.

2. **`hashing.ts`.** Pure synchronous hashing — all `node:crypto`.
   - `sha256(input: Uint8Array | string): string` (lowercase hex, 64 chars).
   - `blake2b512Hex(input: Uint8Array | string): string` (lowercase hex, 128 chars). Node's `createHash('blake2b512')` is the only BLAKE2b output length OpenSSL exposes; the spec parameterizes output length so truncation is *not* valid blake2b-256, hence the explicit `-512` in the algorithm name.
   - `hashChainStep(previousHashHex: string, payloadHashHex: string, algorithm: HashAlgorithm): string` — convenience for forensics tamper-evident logs (`H(prev || payload)`).
   - `sha256ContentAddress(bytes: Uint8Array): string` — prefix + hash for content-addressed identifiers (e.g. `sha256:<hex>`); used by marketplace pack content references.
   - `constantTimeEqualHex(a, b): boolean` — `crypto.timingSafeEqual` over hex-decoded buffers.

3. **`hmac.ts`.** Synchronous HMAC + verification.
   - `hmacSha256Hex(keyBytes: Uint8Array, message: Uint8Array | string): string` — raw HMAC; rare direct use.
   - `signWebhookPayload(keyHandle, body, timestampSeconds): WebhookSignature` — produces the `t=...,v1=...` shape that `sdk/webhooks.ts` already declares.
   - `verifyWebhookSignature(publicMaterial, body, signatureHeader, opts: { toleranceSeconds }): VerifyResult` — constant-time compare via `crypto.timingSafeEqual`; rejects on replay (timestamp outside tolerance) or mismatch.
   - `constantTimeEqualHex(a: string, b: string): boolean` — shared primitive used wherever we compare hex values.

4. **`signing.ts`.** Synchronous Ed25519 over `node:crypto`. We import/export raw 32-byte keys through Node's JWK format (`{ kty: "OKP", crv: "Ed25519", x, d }`) — that's the cleanest path to raw bytes without going through DER/PEM gymnastics.
   - `generateEd25519Keypair(): { publicKeyBase64, privateKeyBase64 }` — public is 32 raw bytes, private is the 32-byte seed.
   - `signEd25519(privateKeyBase64, publicKeyBase64, messageBytes): string` — base64 signature. We thread the public key alongside the seed because Node's JWK ingestion needs both `x` and `d` to reconstruct the private key.
   - `verifyEd25519(publicKeyBase64, signatureBase64, messageBytes): boolean` — pure verify, no key handle needed. Catches malformed inputs and returns `false` rather than throwing.
   - `ed25519PublicKeyFingerprint(publicKeyBase64): string` — sha256 hex of the 32-byte public key bytes; matches the `publicKeyFingerprint` field in `marketplace/registry.ts`.

5. **`key-handles.ts`.** Opaque handles passed around the workspace.
   - `KeyId = "key_<algorithm>_<26-char-base32>"` — tenant-scoped or platform-scoped. Stable identifier; never reused after `destroyKey`.
   - `KeyHandle = { id: KeyId, tenantId: UUID | null, algorithm, purpose, version: positive int }`. Version monotonically increases on rotate.
   - `serializeKeyHandle / parseKeyHandle` — base64-encoded JSON for transmission over the wire (e.g. between services); content is non-secret (it's just metadata pointing to key store).
   - `assertHandleTenant(handle, tenantId): void` — throws on mismatch; the canonical guard at every operation boundary.

6. **`key-store.ts`.** The substrate.
   - `KeyStore` interface: `createKey(input): KeyHandle`, `getPublicMaterial(handle): string`, `signWith(handle, message): Promise<string>`, `hmacWith(handle, message): Promise<string>`, `rotateKey(handle): Promise<KeyHandle>`, `destroyKey(handle): Promise<void>`, `listKeys(filter): readonly KeyHandle[]`.
   - `InMemoryKeyStore` — production-shape implementation backed by a `Map`; intended for tests and local dev. Per-tenant key isolation enforced by `tenantId` matching.
   - `FileBackedKeyStore` — JSON-on-disk; deliberately *not* recommended for production (writes raw key material to disk) but useful for the CLI / single-node dev. Marked with `WARNING_NOT_PRODUCTION_SAFE` constant in its export.
   - Real KMS adapter (AWS KMS, Vault, GCP KMS) is **out of scope** for M2 — `KeyStore` is the interface they'll implement when added in Phase 3.

7. **`audit.ts`.** Operations are auditable.
   - `CRYPTO_OPERATIONS = ["sign", "verify", "hmac", "verify_hmac", "hash", "create_key", "rotate_key", "destroy_key", "get_public"] as const`.
   - `CryptoAuditRecord` zod schema — `id`, `tenantId`, `keyId`, `operation`, `principalId`, `succeeded`, `errorMessage`, `durationMs`, `performedAt`.
   - `recordCryptoOperation(store, record): void` — optional sink; consumers wire it to their audit pipeline.
   - **Audit is opt-in.** Most hot-path operations (hash, verify_webhook) do *not* audit by default; only sensitive ones (create_key, rotate_key, destroy_key) auto-record.

Two meta-schema tables land:

- **`crypto_keys`** — registered keys, *public material only*. Tenant-scoped (`tenant_id` nullable for platform keys), `algorithm`, `purpose`, `public_key_base64`, `key_version`, `status` (active / rotating / revoked), `created_at`, `rotated_from_key_id` (self-ref for the rotation chain), `created_by_user_id`.
- **`crypto_audit`** — append-only audit. `id`, `tenant_id`, `key_id`, `operation`, `principal_id`, `succeeded`, `error_message`, `duration_ms`, `performed_at`.

The actual private material lives in the `KeyStore` backend (in-memory map / file / future KMS).

## Cross-cutting invariants enforced

- **No raw key material in returned types.** `KeyHandle` is opaque metadata. Callers cannot extract the private key from a handle. `getPublicMaterial` returns *only* the public side.
- **Constant-time comparison everywhere.** All HMAC / signature verification uses `crypto.timingSafeEqual`. Hex-string comparison routes through `constantTimeEqualHex`. We never use `===` for security-relevant comparisons.
- **Per-tenant isolation by construction.** Every operation that takes a `KeyHandle` accepts a `tenantId` parameter and the store rejects mismatch. Platform-wide keys have `tenantId = null`; cross-tenant signing requires explicit platform principal.
- **Algorithm allow-list.** No "pluggable algorithm" support — the `algorithms.ts` enums are the *only* algorithms we accept. Adding a new algorithm is an ADR-level change.
- **Versioned signatures.** Every signed envelope carries `algorithm` + `keyVersion` + `cryptoVersion`. Verifier rejects signatures from unsupported versions rather than silently passing.

## Alternatives considered

- **Adopt `libsodium-wrappers` for Ed25519 and BLAKE2.**
  - **Pros.** Widely audited (Signal, ProtonMail), works in Node + browser + Cloudflare Worker via WebAssembly, raw 32/64-byte key buffers are easier to work with than Node's KeyObjects.
  - **Cons.** The 0.7.16 ESM build is broken — it imports a `./libsodium.mjs` sibling that isn't shipped in the published tarball, so vitest's ESM resolver crashes on the first import. Workarounds exist (CJS via `createRequire`, or pin to an older version) but each adds friction.
  - **Why not.** Node 18+ exposes Ed25519 in `node:crypto` directly. Round-tripping through JWK (`{kty:"OKP", crv:"Ed25519", x, d}`) gives us raw 32-byte keys without DER/PEM. `createHash('blake2b512')` covers the alt-hash story. Zero new runtime deps, zero WASM init cost, no broken ESM resolver to work around. The dep was reconsidered and dropped during M2 implementation.

- **Use a high-level wrapper like `paseto` or `tink`.**
  - **Pros.** Avoid mistakes like nonce reuse, IND-CCA misuse.
  - **Cons.** PASETO is a token format, not a primitive library — it doesn't solve pack-signing or evidence-sealing. Tink is mostly a Java/Go library with a less-maintained JS port.
  - **Why not.** Our primitives (sign, verify, hash, HMAC) are simple enough that wrapping `node:crypto` directly is clearer.

- **Use Web Crypto API instead of node:crypto.**
  - **Pros.** Cross-runtime (Node, Deno, Bun, browser, Cloudflare Worker).
  - **Cons.** Web Crypto is async-only, even for sha256. The async overhead matters in hot paths (e.g., per-row hash chaining). Phase 2 runtime is Node-first.
  - **Why not.** Phase 3 adapter packages can map this interface onto Web Crypto if we need edge-runtime support.

- **Per-tenant keys vs platform-wide keys for webhook signing.**
  - **Considered.** Each tenant gets their own webhook signing key (different `whsec_*`) vs one platform key that signs everything.
  - **Decision.** Per-tenant. Aligns with Stripe / GitHub / Slack convention. Customer can rotate their secret without affecting other tenants. The blast radius of a key leak is one tenant's webhook traffic.

- **Store private keys in the meta-schema (encrypted column).**
  - **Pros.** One source of truth, transactional with related rows.
  - **Cons.** Now the Postgres operator can decrypt every tenant's signing key. The whole point of the `KeyStore` abstraction is that we can plug in a real KMS where Postgres has no access.
  - **Why not.** We store *public material* + metadata in `crypto_keys`. Private material stays in the key store backend.

- **Auto-rotate keys on a schedule.**
  - **Considered.** Daily / monthly / quarterly automatic rotation.
  - **Decision.** Manual for M2 — `rotateKey(handle)` is exposed but no scheduler. ADR-0049 (TBD, Phase 2.5) covers the schedule + grace period for old key versions.

- **Bundle a constant-time JSON canonicalizer.**
  - **Considered.** RFC 8785 (JSON Canonicalization Scheme) for hashing JSON payloads consistently across implementations.
  - **Decision.** Out of scope for M2. Crypto only operates on `Uint8Array`. Canonicalization belongs in the consumer (e.g., `marketplace` canonicalizes pack manifests before signing).

## Consequences

- **Second impure package.** `@crossengin/crypto` joins `@crossengin/kernel-pg` as runtime — but it ships with *zero* third-party runtime dependencies (only `node:crypto` + `zod`). Browser / edge-runtime support is deferred to a future `@crossengin/crypto-edge` adapter that maps onto Web Crypto.
- **No async startup cost.** All primitives are synchronous (except `KeyStore` methods, which are async for IO-bound backend swappability). `ensureCryptoReady()` is exported as a no-op for forward compatibility — when we add an async backend (WASM-based PQC, browser Web Crypto), it'll become meaningful.
- **Two new META_* tables.** `crypto_keys` (public material) and `crypto_audit` (operations log). Both tenant-scoped with RLS.
- **Downstream packages start populating real values.** `marketplace/registry.ts` `publicKeyFingerprint` becomes the actual `ed25519PublicKeyFingerprint` output. `sdk/webhooks.ts` signature production calls into `signWebhookPayload`. `forensics/tamper-evident-logs.ts` hash chain steps call into `hashChainStep`. These wirings happen in M2.5 (a "wiring" follow-up) rather than M2 proper, so M2 lands the substrate; downstream packages adopt it incrementally.
- **Webhook signature compatibility.** The `t=<unix_seconds>,v1=<sha256_hex>` format declared in `sdk/webhooks.ts` is preserved verbatim. Existing customer integrations against the format keep working.
- **Reversibility.** The interface is the contract; backends are swappable. Moving from `InMemoryKeyStore` to AWS KMS is a config change, not a code rewrite.

## Open questions

- **Q1:** Should `verifyEd25519` accept the public key as bytes or as a `KeyHandle`?
  - _Current direction:_ Bytes (base64). Verification is often performed by external systems (customers verifying our pack signatures) that don't have a `KeyStore`. Internal-only operations can wrap it with `verifyWithHandle(handle, ...)`.
- **Q2:** Should `KeyStore` operations be sync or async?
  - _Current direction:_ Async. Even `InMemoryKeyStore` returns Promises — keeps the interface stable when we plug in a real KMS that's IO-bound.
- **Q3:** What's the canonical "envelope" format for signed records?
  - _Current direction:_ JSON `{ payload, signature, algorithm, keyVersion, cryptoVersion }`. Documented in ADR-0048 appendix when we draft the marketplace integration (M2.5).
- **Q4:** Do we need post-quantum-ready algorithms (e.g., Dilithium)?
  - _Current direction:_ No, not for M2. The `algorithms.ts` enums are explicit allow-lists; adding a PQC algorithm is a future ADR. Ed25519 is the current best practical choice.
- **Q5:** Should `recordCryptoOperation` be async (writes audit row to Postgres) or sync (in-memory buffer flushed later)?
  - _Current direction:_ Buffered. The interface is sync; the consumer's audit sink decides batching. Hot-path crypto cannot block on Postgres writes.

## References

- **RFC 8032** — Edwards-Curve Digital Signature Algorithm (Ed25519)
- **RFC 2104** — HMAC: Keyed-Hashing for Message Authentication
- **RFC 6234** — SHA-2 (SHA-256)
- **RFC 7693** — BLAKE2 cryptographic hash and MAC
- **node:crypto** — Node's built-in cryptography module (Ed25519 via JWK, SHA-256, HMAC-SHA256, BLAKE2b-512, timingSafeEqual)
- **RFC 7517 / 7518** — JSON Web Key, used for raw Ed25519 key roundtrip
- ADR-0009, ADR-0026, ADR-0035, ADR-0040, ADR-0042, ADR-0046
