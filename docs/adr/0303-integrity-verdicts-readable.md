# ADR-0303: Audit-integrity verdicts readable over HTTP (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0287 (audit-integrity proof), ADR-0288 (integrity incident escalation), ADR-0289 (re-parse on read), ADR-0299 (table constraints) |

## Context

ADR-0287 made the audit-integrity proof run on a schedule — row↔anchor verification, chain link and
signature verification, and a checkpoint-witnessed truncation check — and record its verdict *in the
chain*. ADR-0288 then made a `compromised` finding leave a readable `audit.integrity_compromised` row.

That left the ordinary case unreadable. The chain stores a commitment, not a payload, so a *verified*
verdict existed only as a hash: "show me last month's verifications" — the question an auditor actually
asks, and the one a SOC 2 or HIPAA evidence request is made of — had no answer. ADR-0287 named the
remedy as "a route or an anchored report table".

## Decision

Both, in that order: a new platform table `meta.audit_integrity_verdicts` as the readable index of
proof passes, and four read-only routes over it.

```
GET /v1/audit-integrity/verdicts            list, windowed and filterable
GET /v1/audit-integrity/verdicts/stats      counts by verdict over a window
GET /v1/audit-integrity/verdicts/latest     the most recent pass per tenant
GET /v1/audit-integrity/verdicts/{verdictId}
```

Three choices carry the weight.

**The routes are not under `/v1/platform`.** The same listing serves a tenant reading its own verdicts
and a platform operator reading every tenant's; the **grant** decides which, not the path. A separate
platform path would have meant two handlers answering one question, and the tenant-scoped one is the
same query with a narrower filter.

**The table is tenant-scoped with RLS, and the platform read is granted explicitly.** The policy is
`tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID OR
current_setting('app.platform_audit', true) = 'on'`. The `NULLIF` is not decoration: a
transaction-local `set_config` leaves a custom GUC defined as `''` rather than NULL once the transaction
ends, so `current_setting(x, true)::UUID` raises on a reused pooled connection — and Postgres does not
guarantee short-circuit `OR`, so the cast must be made safe rather than avoided. The cross-tenant read
is granted the way `app.platform_review` is, never assumed from role, because a table's owner bypasses
RLS and so role is not a safe proxy.

**The row is not the proof — it is the index of it.** `payload_sha256` ties each row to the chain entry
that commits to the verdict, and `chain_sequence_number` says where. The chain remains the evidence; the
table makes it findable. A row says `anchors_unanchored` too, because "we checked and found nothing
unanchored" and "we could not check" are different answers and reading the second as the first is how a
verification becomes theatre.

## Alternatives considered

- **Option A: a route over the chain itself, deriving verdicts by replay.**
  - **Pros:** no new table; the chain is already the source of truth.
  - **Cons:** the chain stores commitments, not payloads, so the verdict is not recoverable from it at
    all — only confirmable once you already hold the payload.
  - **Why not:** impossible, not merely slow.

- **Option B: a platform-only route under `/v1/platform/audit-integrity`.**
  - **Pros:** matches how other platform-wide administration is exposed.
  - **Cons:** a tenant cannot answer its own auditor's question without the platform operator
    exporting it, which is the thing a self-serve compliance surface exists to avoid.
  - **Why not:** one listing with a grant-driven scope is the same code and serves both.

- **Option C: no RLS, platform-only in practice.**
  - **Pros:** simplest policy; the table is compliance metadata.
  - **Cons:** the meta-schema suite enforces that every `tenant_id`-bearing table has RLS, and it was
    right to: a row names which tenant's audit chain was checked and when, which is not a fact one
    tenant should read about another.
  - **Why not:** the invariant caught this during review of an earlier draft that argued for it.

## Consequences

- **Positive:** routine verdicts are readable, windowed and countable, so an evidence request is a
  query rather than an export. `certification-runtime`'s forensic-chain-integrity adapter now has a
  persisted signal to read instead of re-running a proof.
- **Negative:** one more table to keep in step, and a verdict is now written twice — once to the chain,
  once to the index. The `payload_sha256` link is what makes the duplication checkable rather than a
  second source of truth.
- **Neutral:** read-only by construction. There is no write path in the routes; a verdict is produced
  only by a proof pass, so the routes cannot manufacture evidence.
- **Reversibility:** the routes are behind `--audit-verdict-routes` and can be turned off. The table
  would be reported as undeclared on an existing database if removed, as ADR-0296 measured.

## Implementation notes

- `packages/kernel/src/bootstrap/meta-schema.ts` — `META_AUDIT_INTEGRITY_VERDICTS` (16 columns), taking
  the table count to 140.
- `apps/operate-server/src/integrity-verdict-store.ts` — the store, re-parsing every row on read
  (ADR-0289), with `withTenantContext` for the tenant scope and the explicit platform grant for the
  cross-tenant read.
- `apps/operate-server/src/integrity-verdict-routes.ts` — the four routes, injected through the
  gateway's `extraRoutes` hook; `--audit-verdict-routes`, `--audit-verdict-platform-role`,
  `--audit-verdict-tenant-role`.
- Verified live against the real server and a throwaway Postgres.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Truncation detection still depends on checkpoint cadence (ADR-0287): entries written *and* deleted between two checkpoints leave no trace, and a verdict row cannot report what no witness saw. | amoufaq5 | _unscheduled_ |
| Should `certification-runtime` read the verdict table rather than re-running a proof for its evidence adapter? | amoufaq5 | _unscheduled_ |

## References

- ADR-0287, ADR-0288, ADR-0289, ADR-0296, ADR-0299.
