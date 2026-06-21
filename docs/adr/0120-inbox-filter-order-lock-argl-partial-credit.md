# ADR-0120: Inbox server-side filtering, order locking, AR↔GL bridge, partial credit

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0113 (inbox), ADR-0118 (document locking), ADR-0119 (credit note), ADR-0112/0116 (guards/effects) |

## Context

Four follow-ups noted across ADR-0113/0118/0119, delivered together: push the
inbox's state filter into SQL for every lifecycle entity; extend the legal-record
locking to sales/purchase orders; bridge AR to the GL when a credit note is
issued; and support partial credit notes.

(Process note: an attempt to parallelize these via isolated worktree agents was
abandoned — the agents' worktrees were created from a base 23 commits stale, so
their output couldn't integrate; the work was reimplemented directly on the live
branch.)

## Decision

**1. Inbox server-side filtering (`operate-runtime/list-query.ts`).**
`listConfigForEntity` now always marks an entity's lifecycle `stateField` as
filterable — even with no declared `ListView` — so the work-queue inbox's
`?state[in]=…` filter is pushed into SQL for every lifecycle entity (TaxReturn,
SalesOrder, …), not just those with a view. (`updated_at` sortability stays
deferred: it's a runtime-stamped field with no mapped column in the typed store.)

**2. Committed-order locking (`compile.ts` `defaultWriteGuards`).** Two more
`lockedDocumentGuard` (ADR-0118) instances: `SalesOrder` locked once
`confirmed/fulfilled/invoiced/closed` (plus retail's `placed/returned`), lines via
`sales_order_id`; `PurchaseOrder` locked once `submitted/approved/received/closed`,
lines via `purchase_order_id`. Out-of-band edits/deletes are blocked
(`sales_order_locked` / `purchase_order_locked`); lifecycle transitions (incl.
cancel) still flow.

**3. AR↔GL bridge (`write-effects.ts` `creditNoteGlPostingEffect`).** On the
issued→void edge (the same edge that issues the credit note), auto-posts a balanced
GL entry — a posted `JournalEntry` numbered `<invoice>-CN-GL` with two lines
reversing the sale (debit revenue, credit AR) for the credited amount. Account
references are configurable **placeholders** (`revenue` / `accounts_receivable`) —
real per-tenant chart-of-accounts determination is out of scope and noted in code.
Wired only when the manifest models a GL (`JournalEntry` + `JournalLine`). Runs in
the void transaction, so AR (credit note) and GL (entry) commit atomically.

**4. Partial credit (`write-effects.ts` + `pack-erp-core`).** `Invoice` gains an
optional `credit_amount` decimal. When it's set below `total` at void, the credit
note (and the GL posting) are for that amount — a single "Partial credit" line and
`total = credit_amount`; absent or ≥ total → full credit (unchanged). 

## Consequences

- Verified end-to-end through the real gateway: lifecycle entities report `state`
  filterable; editing a submitted PO → `422 purchase_order_locked`; voiding an
  invoice yields both `INV-…-CN` (credit note) and a posted `INV-…-CN-GL` GL entry;
  `credit_amount: 40` yields a `total = 40` "Partial credit note".
- The legal-record + auto-correction pattern now spans journals, invoices, tax
  returns, sales orders, and purchase orders, with AR and GL kept in lockstep.
- 6,5xx tests pass (+19 cases across guards/effects/list-query/ui-schema), zero
  type errors, `operate-web` build green.
- Follow-ups: real chart-of-accounts mapping for the GL bridge (replace placeholder
  account refs); credit-note GL posting on partial-credit via a dedicated action
  rather than only on void.
