# ADR-0249: Audit-chain request-stream wiring in operate-server (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0248 (forensics-pg chain producer), ADR-0247 (forensic-chain certification source), ADR-0246 (certification serve lifecycle), ADR-0077 (Phase 4) |

## Context

The chain producer (`forensics-pg`, ADR-0248) can append signed, hash-linked audit entries, but nothing
in the serving path fed it — so the chain stayed empty and certification's forensic-chain source
(ADR-0247) reported the audit-integrity control `not_assessed`. This wires the producer into
`operate-server`'s request stream, so every request lands an audit entry and the chain fills from live
traffic — closing the certification loop end-to-end.

## Decision

- **`audit-chain.ts`** — an `AuditChainObserver` that appends one `audit_event` per completed request.
  It rides the existing per-request `onExecution` sink seam (alongside the SLO + metering observers):
  `asExecutionSink()` projects each `PipelineExecution` into a `ChainAppendInput`
  (`auditAppendInputFrom` — tenant from the execution, actor = principal (or the configured fallback for
  anonymous requests), `recordedAt` = `completedAt`, payload = a canonical JSON summary of
  requestId / operationId / outcome / status / principal / correlation).
- **Serialized appends.** The observer pushes appends through an internal promise queue so they run
  strictly one-at-a-time — the hash chain must be linear, and serializing here keeps ordering
  deterministic and avoids piling concurrent transactions onto the producer's per-tenant advisory lock.
  The queue never rejects (both outcomes handled), so one failed append never stalls the next; a
  `drain()` lets shutdown flush the queue before the socket closes.
- **`ed25519ChainSigner`** — builds the producer's `ChainSigner` directly from a configured Ed25519
  keypair (no key store needed at the serving edge), signing with `crypto.signEd25519` and fingerprinting
  the public key.
- **`--audit-chain-config` flag** (needs `--store pg`): `{schema?, actorReference?, privateKeyBase64,
  publicKeyBase64}`. `serve()` builds the observer over `conn`, adds its sink to the composed
  `onExecution`, and drains it on close. `@crossengin/crypto` moves from a dev- to a runtime dependency
  (the signer needs it); `@crossengin/forensics-pg` is added.

## Consequences

- The certification loop is now closed end-to-end: a running `operate-server` with `--audit-chain-config`
  writes a signed, genesis-anchored audit entry per request, and a certification pass (ADR-0246) with the
  forensic-chain source (ADR-0247) reads that live chain, verifies it, and reports the
  `audit.tamper_evident_log` control as **satisfied** instead of `not_assessed`. Declare → assert →
  persist → serve → produce → **verify-from-live** is whole.
- Appends are ordered and best-effort: the serialized queue keeps the chain linear without blocking the
  request path (the sink returns immediately; the append settles on the queue), and an append failure is
  logged, never surfaced to the client. Shutdown drains the queue so no in-flight entry is dropped.
- The sealing key is supplied by config at the edge (a keypair, like the JWKS keys) rather than a key
  store; rotating it changes the entries' `signingKeyFingerprint` going forward, which the chain records
  per entry (verification is per-entry against the fingerprint's key).
- +10 tests (config parse/load; signer fingerprint; execution → append projection incl. anonymous-actor
  fallback; observer appends one signed + linked + integrity-valid entry per request in order; failure
  routed to onError without stalling; `buildAuditChain` sink round-trip). No META tables, no schema-count
  change. Full build + typecheck + workspace tests green. `serve()` stays offline-untestable, like the
  other serve wirings.
- Follow-ups (open): per-tenant append parallelism (one queue per tenant rather than a single global
  queue) if audit volume warrants; sampling / kind-filtering which requests are chained; checkpoint
  anchoring for long chains (ADR-0247); sourcing the sealing key from the `crypto` `KeyStore` /
  `crypto_keys` instead of edge config.
