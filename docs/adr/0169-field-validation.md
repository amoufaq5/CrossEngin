# ADR-0169: Manifest-driven field validation on create / update

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0167 (optimistic concurrency), ADR-0088 (entity handlers), ADR-0066 (field schemas) |

## Context

The serving handlers accepted any write body and stored it — a Product with no `unit_price`, an
invalid `status` enum, or a non-numeric quantity all persisted silently. The manifest already
declares each field's `required` / type / `enum values` / `maxLength`, so the rules exist; they
just weren't enforced. (This is the server-side backbone under the "form validation" ask — the
console surfaces the result.)

## Decision

- **`validation.ts` (`operate-runtime`, pure).** `buildValidationPlans(manifest)` distills a
  per-entity `FieldRule[]` (name / required / kind / enumValues / maxLength / serverManaged) from
  the field schemas. `validateBody(plan, body, mode)` returns `FieldError[]`:
  - **create** — a required field must be present and non-empty; every present value is
    type/enum/length checked.
  - **update** — a partial patch: absent fields are untouched; a required field only errors if
    explicitly emptied; present values are still checked.
  - **server-managed** fields (a `sequence` default) are never demanded from the client.
- **Wired into the handlers.** Create validates **after** defaults are applied (so a required
  field filled by a literal/sequence/settings default passes) and **before** the write; update
  validates the stripped patch. A violation returns **422 `validation_failed`** with the
  `fields` array — before anything is persisted.
- **Console.** `parseValidationErrors` reads the 422 body; the create form and detail editor show
  the per-field messages (the editor stays in edit mode so the user fixes them) instead of a raw
  error blob.

## Consequences

- Data integrity at the edge: an incomplete or malformed record is rejected 422, not stored. The
  rules are the manifest's — declaring a field `required` now enforces it end-to-end (catalog →
  DDL → validation), no hand-written check.
- Existing test fixtures that created intentionally-incomplete records (a Product without
  `unit_price`/`unit_cost`, an invalid `category` enum) were corrected to valid bodies — they were
  relying on the absence of validation.
- Type coercion is lenient where safe (a numeric string passes a number field); enum/boolean/email
  are strict.
- 6,794 tests pass (+16: the validator's create/update/partial/enum/type/maxLength/server-managed
  paths, `buildValidationPlans`, and handler 422s for missing-required / bad-enum / emptied-required;
  plus fixture corrections across operate-runtime + operate-server for records that were previously
  created incomplete). Full build + typecheck green; console typecheck-verified.
- Follow-ups: expose a `defaulted` hint on the UI schema for client-side required pre-validation
  (avoids a round-trip without false-positiving defaulted fields); `min`/`max`/pattern rules;
  cross-field validation.
