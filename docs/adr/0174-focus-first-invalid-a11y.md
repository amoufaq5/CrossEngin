# ADR-0174: Focus-first-invalid + aria on form validation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0172 (inline field errors), ADR-0170 (client pre-validation), ADR-0077 (Phase 3 P3 renderer) |

## Context

Inline field errors (ADR-0172) highlighted invalid fields, but on a long form the user still had to
hunt for the first one, and screen readers weren't told which input was invalid or where its error
lived. Standard accessible-form behavior is to move focus to the first invalid field and wire the
error to the input via ARIA.

## Decision

- **`FieldInput` emits ARIA.** When `invalid`, the input/select/textarea gets `aria-invalid="true"`
  and `aria-describedby="<error id>"` (a new `describedById` prop); the inline error `<span>` now
  carries that matching `id`. A screen reader announces "invalid" and reads the message.
- **Focus the first invalid field on submit.** A shared `focusFirstInvalid(container)` queries the
  form for the first `[aria-invalid="true"]` element (next animation frame, after React paints the
  new state), focuses it, and scrolls it to center. Wired into both the create form and the detail
  editor, on the client required pre-check **and** a server 422.

## Consequences

- After a failed submit the caret lands on the first field that needs fixing — no scrolling to
  find it — and assistive tech announces the specific error, closing the accessibility gap the
  inline highlight left open.
- Ids are namespaced (`create-<slug>-err-<field>` / `edit-<slug>-err-<field>`) so the describedby
  target is unique per form.
- Purely presentational over the existing validation contract — no API/handler change; the
  server validator remains the authority.
- Pure frontend, three files — Typecheck-verified + Next build green (operate-web has no vitest
  suite, like prior console PRs); workspace stays at 6,795 tests, build + typecheck green.
- Follow-ups: an `aria-live` region for the summary banner; `role="alert"` on the per-field
  messages; keyboard shortcut to jump between invalid fields.
