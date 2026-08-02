# ADR-0172: Inline per-field validation errors in the forms

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0170 (client-side pre-validation), ADR-0169 (server field validation), ADR-0077 (Phase 3 P3 renderer) |

## Context

Validation (ADR-0169/0170) rejected bad input, but the console surfaced the errors as one combined
banner ("Please fix: unit_price, unit_cost") — the user had to map the message back to the fields
themselves. Standard form UX highlights the offending field inline.

## Decision

- **`FieldInput` gains an `invalid` prop.** When set, the input/select/textarea renders a red
  border (`border-red-400`) instead of the default; the base class was refactored so the border
  color is chosen once, not layered (Tailwind order-independent).
- **Forms track a `fieldErrors` map** (`field → message`). Both the create form and the detail
  editor populate it from:
  - the **client-side** required pre-check (each missing field → "`<label>` is required"), and
  - a **server** 422 (`parseValidationErrors` → `fieldErrorMap`, first error per field wins).
  Each field renders its own message in red beneath the input, and the input highlights. Editing a
  field **clears its error** immediately (optimistic — the value probably fixed it). The banner is
  now just a one-line "Please fix the highlighted fields."

## Consequences

- The user sees exactly which fields are wrong and why, next to each field — no more decoding a
  combined message. This applies uniformly to create (list page) and edit (detail page).
- Purely presentational over the existing validation contract — no API/handler change; the
  server-side validator (ADR-0169) is still the authority, and the client pre-check (ADR-0170)
  still saves the round-trip for the obvious case.
- The `fieldErrorMap` helper is shared, so create and edit stay consistent.
- Pure frontend, three files — Typecheck-verified + Next build green (operate-web has no vitest
  suite, like prior console PRs); workspace stays at 6,795 tests, build + typecheck green.
- Follow-ups: focus/scroll to the first invalid field on submit; surface `code`-specific hints
  (e.g. show the allowed enum values inline); aria-invalid + aria-describedby for a11y.
