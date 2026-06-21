# ADR-0118: Post-then-reverse for issued invoices + filed tax returns

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0114 (posted entries immutable), ADR-0112 (write guards) |

## Context

ADR-0114 made posted journal entries immutable (edit/delete blocked, correct by
reversal). The same legal-record principle applies to other documents: an issued
invoice and a filed tax return are external commitments that must not be silently
edited or deleted — they're corrected by a void/credit note or an amendment. The
journal guard was hard-wired to journals; this generalizes it and applies it.

## Decision

Generalize the immutability guard into a reusable `lockedDocumentGuard`, and wire
it for invoices and tax returns.

**`lockedDocumentGuard(config)` (`write-guards.ts`).** Once a record's `state`
enters a configured locked set:
- a plain `update` (field edit) → `422 <lockedError>`;
- a `delete` → `422 <lockedError>`;
- declared lifecycle `transition` ops are **allowed** (they carry their own RBAC +
  from-state guard), so the document still advances — this is the correction path;
- an optional `allowedUpdateTransitions` map permits a pure state change via
  `update` for documents without a transition op (a journal reversal);
- an optional child line entity locks with its parent (`<childLockedError>`).

`postedEntryImmutabilityGuard` is now a thin wrapper over it (journal config:
locked `posted`, update-allowed `posted→reversed`, child `JournalLine`), preserving
its exact error codes.

**Wiring (`compile.ts` `defaultWriteGuards`).** Auto-added from the manifest shape:
- **Invoice** present → locked states `sent`/`overdue`/`paid`/`void`, child
  `InvoiceLine`, errors `invoice_locked` / `invoice_locked_lines` ("void it
  instead");
- **TaxReturn** present → locked states `filed`/`paid`, error `tax_return_locked`
  ("amend it instead").

Both opt out via `writeGuards: []`. Because state moves go through the lifecycle
transition ops, the documents still advance normally; only out-of-band field edits
and deletes are blocked.

## Consequences

- Issued invoices and filed tax returns are now tamper-evident legal records:
  verified through the real gateway — editing a draft invoice succeeds, editing or
  deleting a `sent` invoice is `422 invoice_locked`, voiding it (transition)
  succeeds; editing/deleting a `filed` tax return is `422 tax_return_locked`,
  amending it (transition) succeeds.
- Invoice lines lock with the issued invoice, matching the posted-journal-line
  rule.
- The corrections still flow through the declared lifecycle (void / amend), so
  RBAC and the workflow's from-state rules continue to govern who can correct what.
- One reusable guard now expresses the legal-record pattern for journals, invoices,
  and tax returns; the next such document is a one-line config.
- 6,5xx tests pass (+9 invoice/tax-return cases), zero type errors, `operate-web`
  build green.
- Follow-up: a credit-note auto-effect on invoice void (mirroring the journal
  auto-reversal), and locking issued sales orders / purchase orders the same way.
