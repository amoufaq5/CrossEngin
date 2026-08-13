# ADR-0248: The tamper-evident chain producer (`forensics-pg`) (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0247 (forensic-chain certification source), the `forensics` tamper-evident log + `crypto` KeyStore, ADR-0077 (Phase 4) |

## Context

ADR-0247 added the *read/verify* half of the audit chain — a `meta.forensic_chain_entries` table and a
certification source that verifies it — but left the chain empty because nothing *wrote* to it. This adds
the producer: a durable append store that turns audit events into signed, hash-linked chain entries, so
the audit-integrity control has a real chain to assess.

## Decision

Ship **`@crossengin/forensics-pg`** — the forensics persistence sibling.

- **`PostgresChainLogStore.append(input)`** is the producer. Each append runs in **one transaction** that:
  1. takes a per-scope `pg_advisory_xact_lock` (a **transaction**-level lock — auto-released at commit and
     bound to that transaction's own connection, so concurrent appends for a tenant serialize and the
     `priorEntryHash` chain never races; a session-level `withAdvisoryLock` could straddle a different
     pooled connection than the write transaction, so it is deliberately avoided),
  2. sets the tenant's RLS context (a platform chain, `tenantId = null`, skips it — RLS then exposes only
     `tenant_id IS NULL` rows),
  3. reads the current tail (`ORDER BY sequence_number DESC LIMIT 1`),
  4. builds the next entry from the genesis-anchored `priorEntryHash` via the `forensics` `buildChainEntry`
     (real payload sha256 + `hashChainStep` link + Ed25519 signature), and
  5. inserts it.
  `loadChain` / `verify` / `tail` are the scoped reads (`verify` folds `verifyChainIntegrity`).
- **`ChainSigner` seam** — `{fingerprint, sign(bytes)}`, so the store is signer-agnostic and unit-testable
  with a stub. `keyStoreChainSigner(store, record, tenantId)` adapts a `crypto` `KeyStore` +
  `evidence_sealing` Ed25519 key, enforcing the same algorithm/purpose guard the forensics chain builder
  does (a mis-scoped key fails at wiring time, not first append).
- **`records.ts`** — `ChainAppendInputSchema` (tenant/kind/actor/recordedAt/payload) + `rowToChainEntry`
  (trims `CHAR(64)` padding, re-parses through `ChainedLogEntrySchema`).

## Consequences

- The chain now has a producer: a caller appends an audit event and gets back a durable, signed,
  genesis-anchored entry; the whole chain verifies (`verifyChainIntegrity`) and every entry's signature
  verifies (`verifyChainEntrySignature`) against the sealing key — proven end-to-end in tests over an
  in-memory Postgres fake with a real Ed25519 key. This is the missing piece that lets the ADR-0247
  certification source report the audit-integrity control as *satisfied* instead of *not_assessed*.
- Appends are serialized per scope by a transaction-level advisory lock, so the hash chain stays linear
  and gap-free under concurrency; per-tenant and platform chains are independent, each starting at the
  genesis hash.
- No new META table (the chain table landed in ADR-0247), so no schema-count change.
  `@crossengin/forensics-pg` depends on `forensics` + `crypto` + `kernel-pg` + `zod`. +13 tests (signer
  adapt/guard; append → linked + signed + integrity-valid chain; tail/next-seq; per-tenant + platform
  isolation; verify; malformed-tenant/schema guards; append-input + row parsing). The store's SQL stays
  offline-untestable against real RLS, like the other `-pg` stores; the append logic + signing are unit-
  tested with the fake + a real key.
- Follow-up (open, immediate): wire the producer into `operate-server`'s request stream — an
  `onExecution` observer that appends an `audit_event` per request (from the `PipelineExecution`) under a
  configured sealing key, so the chain fills from live traffic and the certification pass lights up
  end-to-end. Checkpoint-anchored verification for long chains remains the scale follow-up (ADR-0247).
