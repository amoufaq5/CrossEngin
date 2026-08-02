# ADR-0170: `defaulted` UI-schema hint + client-side required pre-validation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0169 (server field validation), ADR-0088 (entity handlers), ADR-0077 (Phase 3 P3 renderer) |

## Context

ADR-0169 added server-side field validation (422 on a missing required field). The console could
pre-check required fields before submitting to save a round-trip — but naively requiring every
`required` field would false-positive on fields the server auto-fills (a `status` with a literal
default, a sequence `invoice_number`, a settings-driven `currency`). The client needs to know
*which* required fields it must actually collect.

## Decision

- **`defaulted` on the UI schema.** `UiFieldSchema` gains an optional `defaulted: boolean`, set by
  `isServerDefaulted(field)` — true when the field carries a manifest `default` (literal or
  sequence) or is a settings-driven currency default. This is exactly the set the create handler
  fills when the client omits the field, so a `required && defaulted` field needs no client input.
- **Client-side required pre-check.** The create form blocks submit and lists the missing fields
  when a `required`, **non-`defaulted`**, non-boolean field is empty (a boolean `false` is a valid
  value, not "empty"). Instant feedback for the obvious case; the server-side validator (ADR-0169)
  remains the authoritative backstop for everything else (types, enums, emptied-on-update).

## Consequences

- The common mistake — submitting a create form with a blank required field — is caught instantly,
  in the browser, with a plain "Please fill in: …" message, no server round-trip.
- No false positives: a required field the server defaults (lifecycle `status`, sequence number,
  currency) is not demanded, because the schema now tells the client the server will fill it.
- The hint is additive and backward compatible — any consumer ignoring `defaulted` is unaffected;
  the server validation is unchanged and still enforces the truth.
- 6,795 tests pass (+1: the ui-schema `defaulted` assertion — literal/sequence-defaulted fields
  flagged, a plain required field not). Full build + typecheck green; console typecheck-verified.
- Follow-ups: inline per-field error highlighting (vs. a combined message); `min`/`max`/pattern
  hints mirrored client-side; required-field markers driven by `defaulted` in the form layout.
