# ADR-0426: An expression default is looked up in a closed table, never written into SQL

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0348 (a property of the manifest alone is a validation error), ADR-0340 (no hatch where the hatch reopens the hole), ADR-0368 (a tenant's own manifest reaches the column store) |

## Context

**H-02**: a field's `default: {kind: "expression", expression}` was concatenated verbatim into
`CREATE TABLE … DEFAULT <expression>` by `emitDefault`, the single producer of a default's SQL, on
`--store pg-columns` and in `applyTenantManifestSchema`. A manifest — including an activated
tenant's own, or an Architect design — is therefore a SQL injection sink executed by a role that
can create tables. The audit's payload did not parse as written (`42601`), but a payload closing its
own parentheses created `public.pwned` live.

Measured over the seven resolved packs: 748 expression defaults, **all `now()` on `datetime`** (the
`auditable` trait); the compliance packs add five more `now()`; the Architect's spec teaches no
defaults. The document store never evaluates an expression default.

## Decision

`EXPRESSION_DEFAULTS` is a `Map` with two entries — `now()` for `datetime`, `uuid_generate_v7()`
for `uuid` — matched exactly (no folding, no trimming; a `Map` so `__proto__` cannot match).
`emitDefault` returns the table's own constant and throws for anything else, naming only the
expression's length. `validateManifest` refuses an unadmitted expression, an admitted one on the
wrong field type, and any expression default on a `phi`/`regulated` field; the message never repeats
the expression. In `applyTenantManifestSchema` the emitter's refusal is a blocking change,
`unadmitted_expression_default`, with no SQL run.

Beside it, the **literal** arm was injectable too: string literals were quote-doubled assuming
`standard_conforming_strings = on`. They are emitted as `E'…'` with backslashes escaped, verified by
1 672 round trips under both settings with no mismatch and no table created.

## Alternatives considered

- **A hatch for other expressions.** Refused: it is the injection. `current_date` is deliberately
  absent — the session timezone picks the day.

## Consequences

A stored tenant manifest carrying another expression now fails serve-time validation and falls back
through the existing invalid-manifest path. None exists in the repo.

## Implementation notes

Verified live: the old rendering created `public.pwned`; after, validation refuses, the boot store
refuses at construction, and the tenant apply returns `applied=false` with no schema. `validateManifest`
throws "expression default is not one of the admitted expressions (now(), uuid_generate_v7())".

## Open questions

1. A custom `datetime` field defaulting to `now()` stores microseconds; only the system timestamps
   are truncated to milliseconds.
2. A literal default on an encrypted field lands as plaintext bytes in a `BYTEA` default; zero
   members.

## References

- `packages/kernel/src/ddl/expression-default.ts`, `column.ts`, `manifest/validate.ts`;
  `packages/operate-runtime-pg/src/column-plan.ts`, `tenant-schema-apply.ts`
