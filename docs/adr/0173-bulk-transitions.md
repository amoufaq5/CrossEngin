# ADR-0173: Bulk lifecycle transitions on the list

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0171 (bulk actions — select/delete/export), ADR-0088 (entity handlers + transitions), ADR-0077 (Phase 3 P3 renderer) |

## Context

Bulk actions (ADR-0171) gave the list row-selection with delete + CSV export, but the third thing
an operator does to a filtered set is *advance* it — mark N invoices paid, fulfil N orders. Firing
a lifecycle transition one record at a time is the tedious gap.

## Decision

- **Bulk-transition buttons** appear in the toolbar when rows are selected and the entity has a
  lifecycle. The offered set is the transitions the **viewer's role may fire** (distinct by name;
  the same role gate as the inbox), so a user only sees actions they can take.
- **State-aware, skip-safe application.** Firing a transition applies it only to the selected
  records whose **current state is a valid `from`** for it; records in a non-matching state are
  skipped, and the result reports "Applied `<label>` to N (skipped K not in a valid state)". A
  mixed-state selection is therefore always safe — no per-record pre-filtering by the user.
- Each transition runs through the existing `runTransition` op, so the gateway's RBAC + the
  lifecycle guards apply per record exactly as for a single transition; the selection clears and
  the list reloads on completion.

## Consequences

- The list is now fully operational: select a filtered set and delete it, export it, **or advance
  it through its lifecycle** — the three bulk verbs an ERP user reaches for.
- Safe by construction: eligibility is checked against each row's current state before firing, and
  the per-record op keeps RBAC + guards authoritative (the client just orchestrates). A mid-batch
  failure surfaces the error and stops, leaving the rest for a retry.
- Only role-permitted transitions are shown, matching the single-record detail view's Actions.
- Pure frontend, one file — no API or contract change (reuses the transition op). Typecheck-verified
  + Next build green (operate-web has no vitest suite, like prior console PRs); workspace stays at
  6,795 tests, build + typecheck green.
- Follow-ups: a server-side batch-transition endpoint (atomic, one round-trip) for very large
  selections; a confirm for destructive transitions; progress feedback per record.
