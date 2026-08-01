# ADR-0147: Account-code picker in settings

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0142 (settings jurisdiction map editor), ADR-0121 (real CoA mapping) |

## Context

The settings page's finance account-code fields (and the jurisdiction-map code inputs) were
free text, so a typo'd code that doesn't exist in the chart of accounts wasn't caught.
Delivered in the four-agent polish batch.

## Decision

- **`AccountCodePicker` component.** Props `{label, value, onChange}`. Fetches the chart of
  accounts once via a module-level cached promise (`listRecords("ledger-accounts",
  "?limit=500")`, shared across all instances), builds `{code, name}` sorted by code, and
  renders an `<input>` + `<datalist>` (autocomplete of `code — name`), so the user gets
  suggestions but can still type. A `useId()` datalist id keeps instances from colliding.
  A subtle amber "unknown code" hint shows when a non-empty value matches no known code
  (after load). On fetch failure it degrades to a plain text input (non-blocking).
- **Wiring.** All 11 finance account-code inputs (AR / revenue / AP / expense / cash / tax
  payable / input tax / FX / unrealized FX / WHT receivable / tax recoverable) and the
  jurisdiction-map `code` input now use `AccountCodePicker`. `buildFinance` /
  `jurisdictionRowsToMap` / save-load are unchanged — the picker stores the same plain code.

## Consequences

- Account codes are picked from the live chart of accounts with typo feedback, not typed
  blind — a typo'd code is now visible before save.
- `operate-web` builds green; persistence is byte-identical (same code strings).
- Follow-up: hard-validate (block save) on unknown codes if desired; today it's advisory.
