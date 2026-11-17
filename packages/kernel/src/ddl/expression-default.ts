import type { Field, FieldType } from "@crossengin/types/meta-schema";
import { requiresEncryptionAtRest } from "@crossengin/types/meta-schema";

/**
 * The closed vocabulary of `{kind: "expression"}` field defaults, and the only SQL any of them
 * renders to.
 *
 * `DefaultValueSchema` types the expression as `z.string().min(1)` and `emitDefault` used to return
 * it verbatim after `DEFAULT`, so a manifest declaring
 * `"'a'); CREATE TABLE public.pwned(x int); --"` put a second statement into the DDL that
 * `ColumnMappedEntityStore.ensureSchema` and `applyTenantManifestSchema` execute — and a manifest
 * is authored by a pack, by a tenant through the Architect, or by hand. So the expression is
 * **looked up, never rendered**: the text is a key into this table, and what reaches `DEFAULT` is
 * the table's own constant. A spelling outside it has no rendering at all, which is the property
 * quote-escaping cannot give, since an expression is SQL by definition and there is nothing in it
 * to escape.
 *
 * The members are the ones the workspace uses, measured: `now()` is every expression default in
 * the seven resolved packs (374 `created_at` + 374 `updated_at`, all from the built-in `auditable`
 * trait; zero declared by a pack itself) and in the compliance packs (four fields across `gdpr`,
 * `hipaa` and `21-cfr-part-11`, all `datetime`; `uae-moh` declares none), and
 * `uuid_generate_v7()` is the function every catalogued `id` column defaults to and the applier's
 * precondition guarantees. A new member is a decision about a function's result type and its
 * dependence on session state, which is why `current_date` (the session `TimeZone` picks the day)
 * is not here: add it with that decision written beside it, not by widening the lookup.
 *
 * `fieldKinds` is the field types whose column takes the result without a cast that depends on
 * session settings. It is checked at validation and not at the emitter, because what the emitter
 * writes is the table's constant either way, so a mismatch cannot inject anything. It is not always
 * loud, though, which is why validation owns it: measured on PG 16, `now()` on an `integer` or
 * `bytea` column is refused at `CREATE TABLE`, while on a `text` column it is accepted and stores a
 * `DateStyle`-dependent rendering, and on a `date` column it is accepted and the session `TimeZone`
 * picks the day — the same two defects ADR-0402 refused `created_at: text` for.
 */
export const EXPRESSION_DEFAULTS: ReadonlyMap<
  string,
  { readonly sql: string; readonly fieldKinds: readonly FieldType["kind"][] }
> = new Map([
  ["now()", { sql: "now()", fieldKinds: ["datetime"] }],
  ["uuid_generate_v7()", { sql: "uuid_generate_v7()", fieldKinds: ["uuid"] }],
]);

/** The admitted spellings, for messages. */
export const ADMITTED_EXPRESSION_DEFAULTS: readonly string[] = [...EXPRESSION_DEFAULTS.keys()];

/**
 * Thrown by `emitDefault` for an expression outside `EXPRESSION_DEFAULTS`.
 *
 * Carries no copy of the expression: it is attacker-controllable text, and this message lands in a
 * boot failure, a log line and a tenant schema refusal. Its length is the one fact about it that is
 * safe to print and useful for telling a typo from a payload.
 */
export class UnadmittedExpressionDefaultError extends Error {
  override readonly name = "UnadmittedExpressionDefaultError";
  readonly expressionLength: number;
  constructor(expression: string) {
    super(
      `expression default (${expression.length} characters) is not one of the admitted ` +
        `expressions (${ADMITTED_EXPRESSION_DEFAULTS.join(", ")}); it is never rendered into SQL`,
    );
    this.expressionLength = expression.length;
  }
}

/** The SQL an admitted expression renders to, or null. Exact match: no case folding, no trimming. */
export function admittedExpressionDefaultSql(expression: string): string | null {
  return EXPRESSION_DEFAULTS.get(expression)?.sql ?? null;
}

/**
 * Why a field's expression default is refused, or null when it is admitted (or is not an
 * expression). The three reasons are ordered so the first true one is the one an author can act on:
 * an unadmitted spelling first, since nothing else about it means anything.
 */
export function expressionDefaultRefusal(field: Field): string | null {
  const dflt = field.default;
  if (dflt === undefined || dflt.kind !== "expression") return null;
  const entry = EXPRESSION_DEFAULTS.get(dflt.expression);
  if (entry === undefined) {
    return (
      `expression default is not one of the admitted expressions ` +
      `(${ADMITTED_EXPRESSION_DEFAULTS.join(", ")}) — an expression default is looked up, never ` +
      `rendered into SQL, so any other text is refused`
    );
  }
  if (!entry.fieldKinds.includes(field.type.kind)) {
    return (
      `expression default '${dflt.expression}' produces a value for a ` +
      `${entry.fieldKinds.join(" or ")} field, not a ${field.type.kind} one`
    );
  }
  if (field.classification !== undefined && requiresEncryptionAtRest(field.classification)) {
    return (
      `expression default '${dflt.expression}' cannot apply to a '${field.classification}' field: ` +
      `its column holds ciphertext, so a database-computed default is refused by the column type`
    );
  }
  return null;
}
