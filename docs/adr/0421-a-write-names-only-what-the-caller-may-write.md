# ADR-0421: A write names only what the caller may write, and the server says who wrote it

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0419 (a document's lock and its state are one rule — the state field this extends), ADR-0360 (`callerKeys` and the 409 on a caller-supplied unique value), ADR-0359 (a surface the server discards must be refused, not ignored), ADR-0335 (`meta.users` and the actor-column rule), ADR-0396 (`principalUserId`), ADR-0339 (the write mask) |

## Context

The external due-diligence audit ranked two findings high that are one surface read from two
sides. **H-08**: a create or update accepted any body key. `validateBody` iterates the entity's
*rules* and never the body's keys, so an undeclared key was neither refused nor stripped — the
document store kept it (`{"totally_undeclared": …}` read back on every later `GET`), the column
store dropped it, and register P2.19 had recorded the divergence without closing it. Worse, keys the
server owns were client-writable: the record `id`, the implicit columns, the `auditable` trait's
`created_by` / `updated_by`, the effect-stamped `Invoice.withholding_total`, `booking_rate` and
`paid_at`, and every sequence-allocated number. **H-32**: nothing stopped the person who created a
document from approving, posting or paying it — `created_by` was declared on 51 of 51 `erp-core`
entities through `auditable` and **written by nothing anywhere**, so the fact a maker-checker rule
needs did not exist.

Two measurements decided the shape. `auditable` is the only trait any pack uses (51/51 in core,
53/54 in education), so the actor stamps were one declaration with no producer. And the
booking-rate effect skipped a value already present, so a client-supplied `booking_rate` *replaced*
the rate the effect would have stamped — a write that looks like data entry and is a currency
override.

## Decision

**One classification of server-owned keys, as a total map**, in `write-surface.ts`: record id,
implicit columns, actor stamps, effect stamps and allocated sequence numbers, each answering whether
it is admitted on create and on update. The effect stamps are collected inside the function that
builds the effects, so the stamp list and the effects cannot disagree.

- An undeclared key is **422 `field_not_declared`** and a server-owned one **422
  `field_server_owned`**, decided before any store sees the body — so both stores answer
  identically, which closes P2.19 by refusal rather than by choosing one store's behaviour.
- A caller-supplied `id` is shape-checked; an existing one is **409 `id_conflict`**.
- `created_by` / `updated_by` are **stamped from `principalUserId`**, and only where the `auditable`
  trait supplies them: an entity declaring its own client-writable `created_by` must not be able to
  forge the creator.
- Effects that copy a record (credit note, its lines, a journal reversal's lines) attribute the
  copy to **the person who fired the transition** (`attributedToTrigger`, reading the `updated_by`
  the transition just stamped), never to the original's creator.
- Sequence numbers are allocated **after validation and before the transaction**. Inside it, the
  allocator borrowed a second pooled connection while the transaction held one, so ten concurrent
  numbered creates on a ten-connection pool deadlocked — found by review, fenced by a test that the
  allocation runs while no transaction is held. Numbering is gap-reduced, not gapless, and the
  comment says so.
- `--segregation-of-duties` refuses an **approve-class** transition (`approve`, `post`,
  `mark_paid`, `reimburse`, and `Payment.complete`) when the actor is the record's `created_by`:
  **422 `maker_cannot_approve`**. A record with no recorded creator is **refused**
  (`maker_checker_unverifiable`) rather than waved through, and the `[sod]` boot line says so.
  Off by default (ADR-0338's rule read the other way: every existing record has no creator, so on
  would block every pending draft on upgrade).
- `ui-schema.ts` marks `booking_rate`, `withholding_total` and `paid_at` read-only, so the console
  does not send what the server now refuses; the OpenAPI create/update schemas carry the same
  classification, with `expectedUpdatedAt` admitted on update through one shared constant.

## Alternatives considered

- **Strip undeclared keys silently.** Refused: ADR-0359's rule — a caller who sent a key and got a
  201 believes it was stored.
- **Refuse when the approver equals `updated_by` too.** Refused for now: in a two-person tenant it
  makes Expense reimbursement impossible (creator and approver both blocked). The bypass it would
  close is real and stays open — see below.
- **Gapless numbering.** Needs the allocation inside the write's own transaction on the write's own
  connection, which is a store contract change.

## Consequences

- A client sending an undeclared or server-owned key now gets a 422 where it got a 201. That is the
  point, and the console was changed in the same increment so it does not.
- Credit notes and reversals stop naming the original invoice's creator.
- **Last-editor bypass, open**: with the switch on, Bob creates a bill for 1, Alice PATCHes the
  total to 100 000, Alice approves — 200. Closing it needs a "last field editor" record that
  transitions do not overwrite.
- `FiscalPeriod` has no lifecycle in any pack, so ADR-0419's state guard does not reach it and a
  plain PATCH can still reopen a period.

## Implementation notes

Verified live on PG 16 as the confined `crossengin_app` role: an undeclared key 422
`field_not_declared`, `created_by` 422 `field_server_owned`, and a create stamping `created_by` as
the caller's user id. Thirty parallel creates of a numbered entity returned 201 with thirty distinct
numbers and no pool stall.

## Open questions

1. The last-editor bypass above.
2. Payment-driven paid marks leave `updated_by` unchanged.
3. Other traits' fields (`version`, `deleted_at`, `e_signature_required`) stay client-writable; no
   pack uses those traits.
4. The `[sod]` boot line names only the boot pack's approve-class transitions, not a tenant's own.

## References

- `packages/operate-runtime/src/write-surface.ts`, `maker-checker.ts`, `handlers.ts`,
  `write-effects.ts` (`attributedToTrigger`), `openapi-schema.ts`, `ui-schema.ts`
