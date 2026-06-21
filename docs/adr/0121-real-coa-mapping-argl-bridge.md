# ADR-0121: Real chart-of-accounts mapping for the AR↔GL bridge

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0120 (AR↔GL bridge), ADR-0111 (settings behavior), ADR-0107 (GL) |

## Context

ADR-0120's AR↔GL bridge posted its credit-note journal entry to **placeholder**
account references (`accounts_receivable` / `revenue` strings), explicitly leaving
real chart-of-accounts determination as a follow-up. This wires the posting to the
tenant's actual `LedgerAccount` rows.

## Decision

**Account mapping in tenant settings (`operate-runtime/settings.ts`).**
`FinanceSettings` gains `arAccountCode` and `revenueAccountCode` — each a
`LedgerAccount.account_code`. They join the existing admin settings document
(fail-closed, admin-only) and are surfaced in the web settings' Finance & tax
section.

**Code → id resolution in the effect (`write-effects.ts`).**
`creditNoteGlPostingEffect` gains a `resolveAccountCodes(tenantId)` seam (wired in
`compile.ts` to read `finance.arAccountCode`/`revenueAccountCode` from the
`SettingsStore`) and a `LedgerAccount` lookup: each configured code is resolved to
its account's id via `store.listPage(tenant, "LedgerAccount", {filter
account_code = code})`, and that id becomes the posting line's `ledger_account_id`.
When a code is unset or resolves to no account, the prior placeholder ref is used —
so the bridge still posts (degraded but functional) for an unconfigured tenant.
The lookup runs on the transaction-bound store, inside the void transaction, so it
sees uncommitted state and stays atomic.

The bridge now wires only when the manifest models `JournalEntry` + `JournalLine`
+ `LedgerAccount`.

## Consequences

- The credit-note GL entry posts to the tenant's real AR and revenue accounts:
  verified end-to-end — configure `arAccountCode: "1100"` / `revenueAccountCode:
  "4000"`, create those `LedgerAccount`s, void an invoice, and the `…-CN-GL`
  entry's two balanced lines carry the resolved account ids (revenue debit / AR
  credit).
- Unconfigured tenants degrade gracefully to placeholder refs rather than failing
  the void.
- Account determination is now a per-tenant setting an admin owns in the console,
  not a hardcoded constant.
- 6,5xx tests pass (+4 effect/settings cases), zero type errors, `operate-web`
  build green.
- Follow-ups: map the AP side (vendor bills → GL) and per-document-type account
  overrides; resolve by account *role/tag* rather than a single code when a tenant
  has multiple AR/revenue accounts.
