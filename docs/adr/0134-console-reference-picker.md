# ADR-0134: Console reference picker (tax-code & all reference fields)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0131/0132/0133 (line-level tax codes, per-code GL accounts, withholding), ADR-0127 (console aging screen) |

## Context

The tax engine shipped in #39–#41 is fully line-driven (per-line `tax_code_id`, per-code
GL accounts, withholding) but only drivable via the API: in the console, every reference
field — `tax_code_id`, `account_id`, `vendor_id`, … — rendered as a **raw id text input**
(`"TaxCode id"`), so a user had to copy a UUID to set a line's tax code. This closes that
gap with a picker for *all* reference fields.

## Decision

**`ReferencePicker` component.** Given a reference field's target entity name, it resolves
the target's slug from the UI schema, lazy-loads up to 200 of its records, and renders a
`<select>` of human labels (`recordLabel`) storing the record id. It is defensive:
- an unresolvable target or a failed list falls back to the raw id text input (editing is
  never blocked);
- a selected id absent from the loaded options is preserved as an explicit option (a
  truncated list never silently drops an existing value);
- a `Loading…` placeholder shows the current value until options arrive;
- the empty `—` option appears only for optional fields.

**`FieldInput` routes reference fields to it.** `FieldInput` gains an optional `schema`
prop; when a field is a `reference` with a resolvable target and a schema is supplied, it
renders `ReferencePicker` instead of the text input. Both call sites — the record detail
edit form and the list-page create form — now pass `schema` (already in scope via
`useSchema`). With no schema passed, the prior text input is unchanged.

## Consequences

- Setting an invoice line's `tax_code_id` (or any reference: account, vendor, ledger
  account, …) is now a labelled dropdown — "VAT20", "Acme Corp" — not a pasted UUID. The
  tax engine's line-level codes are finally reachable from the UI.
- Generic: the picker serves every reference field across all entities, not just tax codes.
- Robust by construction: unresolved targets / list failures degrade to the id input, so
  no field becomes uneditable.
- `operate-web` build green; no package/server change, so the workspace test suite is
  unaffected.
- Follow-ups: resolve reference *labels* in read mode (list cells + detail values still
  show the raw id link); a typeahead for entities with >200 records; the TaxCode
  `gl_account_code` / `kind` are already editable via the generic form.
