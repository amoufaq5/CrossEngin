/**
 * Which workspace symbol does a store actually write into a catalogued column?
 *
 * ADR-0353 declared, for each of the 287 catalogued value-set CHECKs, the contract domain that
 * governs it, and `mirrors` asserts the two enumerate the same members. That is the right assertion
 * and it cannot see the question this module asks. A declaration says *which* domain governs a
 * column, and a member comparison is blind to which: two constants spelling one domain are
 * interchangeable to it, so a declaration adjudicated by reading — which is how all 287 were
 * written, and 19 of them required reading which record each table stores — can name the wrong
 * symbol and pass. That was ADR-0353's own first open end.
 *
 * So this module derives the answer instead of accepting it: for each value-set column it resolves
 * what the workspace's SQL binds into it, and compares the **symbol** against the declared ref.
 * Every step of that derivation is reported when it fails rather than skipped, because a chain that
 * goes quiet where it cannot see would report "all declarations agree" having checked a handful.
 *
 * It is a static scan, like its siblings, and reads the real workspace from disk. The honest limit
 * is `UNRESOLVED_BINDING_GAPS` plus the floor on how many columns are checked: a column with no
 * reachable writer cannot be checked at all, and 164 of the 287 sit on tables
 * `pg-storeless-tables.ts` already declares writerless.
 */
import { z } from "zod";

import {
  clauseOf,
  collectImportedNames,
  collectModuleBindings,
  emptyBindings,
  matchBracket,
  normalizeSource,
  resolveBindings,
  splitTopLevel,
  stripComments,
  substituteBindings,
  untilTemplateEnd,
  type ModuleBindings,
} from "./pg-column-coverage.js";
import type { WorkspaceDomain } from "./pg-value-set-domains.js";
import type { WorkspaceSourceFile } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------- extraction */

/** The statement shapes that put a value into a column. */
export const BINDING_STATEMENT_KINDS = ["insert", "conflict_update", "update"] as const;
export type BindingStatementKind = (typeof BINDING_STATEMENT_KINDS)[number];

/**
 * How the value reaches the column.
 *
 * `parameter` is `receiver.property` out of the statement's own parameter array and `local` is a
 * bare identifier there, which resolve differently: the first asks what type *declares that field*
 * and the second asks what the identifier's own type is. `literal` is a SQL literal written into
 * the statement, which is checkable against the CHECK with no declaration at all.
 */
export const COLUMN_BINDING_KINDS = ["parameter", "local", "literal"] as const;
export type ColumnBindingKind = (typeof COLUMN_BINDING_KINDS)[number];

export const ColumnBindingSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    statement: z.enum(BINDING_STATEMENT_KINDS),
    schema: z.string().min(1),
    table: z.string().min(1),
    column: z.string().min(1),
    kind: z.enum(COLUMN_BINDING_KINDS),
    /** `event` of `event.action`, for a `parameter`; `null` for a `local`. */
    receiver: z.string().min(1).nullable(),
    /** `action` of `event.action`, or the identifier itself for a `local`. */
    property: z.string().min(1).nullable(),
    /**
     * The declared type of the receiver, or of the local itself. `null` where the module annotates
     * neither, which is reported rather than guessed.
     */
    receiverType: z.string().min(1).nullable(),
    /** The literal's value, for a `literal`. */
    literal: z.string().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "parameter" && (v.receiver === null || v.property === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["property"],
        message: "a parameter binding must name the receiver and the property",
      });
    }
    if (v.kind === "local" && (v.receiver !== null || v.property === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["property"],
        message: "a local binding names an identifier and no receiver",
      });
    }
    if (v.kind === "literal" && v.literal === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["literal"],
        message: "a literal binding must carry its value",
      });
    }
  });
export type ColumnBinding = z.infer<typeof ColumnBindingSchema>;

/**
 * Why one column's value could not be traced back to a symbol.
 *
 * Reported, never skipped. `params_after_spread` is the one that had to be learned: without it
 * `access_review_evidence.status` resolved to `evidence.acceptedAt`, because
 * `...EVIDENCE_RATE_FIELDS.map(…)` sits at position 9 of that store's parameter array and shifts
 * every later position by an amount a scan cannot know. A spread shifts everything *after* it and
 * nothing before, so the split is exact: positions before the first spread stand, positions at or
 * after it are refused.
 */
export const UNRESOLVED_BINDING_KINDS = [
  "column_list_unresolved",
  "columns_not_bare",
  "values_clause_absent",
  "values_clause_unresolved",
  "values_arity_mismatch",
  "set_clause_unresolved",
  "params_not_located",
  "params_not_an_array",
  "params_after_spread",
  "params_too_short",
  "value_not_a_parameter",
  "parameter_not_a_property",
  "excluded_column_not_inserted",
] as const;
export type UnresolvedBindingKind = (typeof UNRESOLVED_BINDING_KINDS)[number];

export const UnresolvedBindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  kind: z.enum(UNRESOLVED_BINDING_KINDS),
  schema: z.string().min(1).nullable(),
  table: z.string().min(1),
  /** `null` where the failure is the whole statement rather than one column. */
  column: z.string().min(1).nullable(),
  detail: z.string().min(1),
});
export type UnresolvedBinding = z.infer<typeof UnresolvedBindingSchema>;

export interface ColumnBindingExtraction {
  readonly bindings: readonly ColumnBinding[];
  readonly unresolved: readonly UnresolvedBinding[];
}

const BARE_COLUMN = /^[a-z_][a-z0-9_]*$/;

function columnName(text: string): string | null {
  const bare = text.trim().replace(/^"(.*)"$/, "$1").toLowerCase();
  return BARE_COLUMN.test(bare) ? bare : null;
}

function lineAt(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) if (code[i] === "\n") line += 1;
  return line;
}

interface ParameterArray {
  /** Offset of the `(` opening the `query(…)` call. */
  readonly at: number;
  readonly end: number;
  /** The call's first argument, which says whether it carries this statement's SQL. */
  readonly first: string;
  /** `null` when the second argument is not an array literal this scan can split. */
  readonly items: readonly string[] | null;
  readonly detail: string;
  /** Whether the array could not be *located* rather than not be *read*. */
  readonly unlocated: boolean;
}

/** `const sql = ` … `` — the template span an identifier names. */
interface SqlConstant {
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

function parameterArrays(code: string): readonly ParameterArray[] {
  const out: ParameterArray[] = [];
  for (const m of code.matchAll(/\.\s*query\b/g)) {
    const from = m.index + m[0].length;
    const paren = code.indexOf("(", from);
    if (paren < 0) continue;
    // `conn.query<{ id: string }>(` is how roughly half of these stores are written, so the type
    // argument has to be stepped over; anything else between `query` and `(` is not this call.
    if (!/^\s*(<[^()]*>)?\s*$/.test(code.slice(from, paren))) continue;
    const end = matchBracket(code, paren);
    if (end < 0) continue;
    const args = splitTopLevel(code.slice(paren + 1, end - 1));
    const first = (args[0] ?? "").trim();
    const second = (args[1] ?? "").trim();
    const base = { at: paren, end, first, unlocated: false };
    if (args.length < 2) {
      out.push({ ...base, items: null, detail: "the query call passes no parameter array" });
      continue;
    }
    if (!second.startsWith("[")) {
      out.push({
        ...base,
        items: null,
        detail: `the parameter argument is \`${second.replace(/\s+/g, " ").slice(0, 60)}\`, not an array literal`,
      });
      continue;
    }
    const close = matchBracket(second, 0);
    if (close < 0) {
      out.push({ ...base, items: null, detail: "the parameter array has no closing bracket" });
      continue;
    }
    out.push({
      ...base,
      items: splitTopLevel(second.slice(1, close - 1))
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      detail: "",
    });
  }
  return out;
}

/**
 * The span of every `const <name> = …` whose initialiser contains a template literal.
 *
 * Taken to the end of the statement rather than to the closing backtick, because the initialiser is
 * not always one literal: `timer-store.ts` writes `const sql = cond ? \`INSERT …\` : \`INSERT …\``,
 * and reading only the first form left six of that store's bindings unlocated. Widening is safe
 * because the *following* query call still has to pass this identifier for the span to be used.
 */
function sqlConstants(code: string): readonly SqlConstant[] {
  const out: SqlConstant[] = [];
  for (const m of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*/g)) {
    const from = m.index + m[0].length;
    const span = statementSpan(code, from);
    if (!span.includes("`")) continue;
    out.push({ name: m[1] ?? "", from, to: from + span.length });
  }
  return out;
}

/**
 * Every place the module says what type a local or a parameter holds.
 *
 * Two idioms, and both are needed: a signature annotation (`async insert(event: LifecycleEvent)`)
 * and a parse (`const valid = ChainCheckpointSchema.parse(record)`), which is how the stores that
 * validate before writing name their record. A generic other than `Readonly<T>` is **rejected**
 * rather than read as `T`: `candidate: Record<string, unknown>` would otherwise be read as a type
 * named `Record`, and the resolver would then go looking for `RecordSchema`.
 */
interface TypeAnnotation {
  readonly at: number;
  readonly name: string;
  readonly type: string;
}

function typeAnnotations(code: string): readonly TypeAnnotation[] {
  const out: TypeAnnotation[] = [];
  for (const m of code.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*:\s*(Readonly<)?([A-Z][\w$]*)\s*(<|\[|\()?/g,
  )) {
    // A generic other than `Readonly<T>`, an array, and a call are all rejected rather than read as
    // `T`: `candidate: Record<string, unknown>` would otherwise be a type named `Record`, and
    // `reviewStatus: String(row["x"])` a type named `String`.
    if (m[4] !== undefined) continue;
    out.push({ at: m.index, name: m[1] ?? "", type: m[3] ?? "" });
  }
  // An annotation whose type is an inline union of string literals. Capturing it is not optional:
  // `finalizeFailure(…, disposition: "failed" | "dead-lettered", …)` is written that way, and
  // without it the nearest-preceding rule reaches past it to `JobRunDisposition`, six members wide,
  // four of which `job_runs.status` does not admit — a confident wrong answer about what is bound.
  for (const m of code.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*((?:"[^"]*"|'[^']*')(?:\s*\|\s*(?:"[^"]*"|'[^']*'))*)/g,
  )) {
    out.push({ at: m.index, name: m[1] ?? "", type: (m[2] ?? "").replace(/\s+/g, " ") });
  }
  for (const m of code.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*Schema)\s*\.\s*(?:parse|safeParse)\s*\(/g,
  )) {
    out.push({ at: m.index, name: m[1] ?? "", type: m[2] ?? "" });
  }
  return out;
}

/**
 * Pulls out, per catalogued column one of this module's statements writes, the symbol it binds.
 *
 * The mapping is **positional over the `VALUES` list**, never a zip of the column list against the
 * parameter array. `apps/operate-server/src/platform-users.ts` is why: it writes
 * `VALUES ($4::uuid, $1, $2, $3, 'active')`, so column order is not parameter order, and `status`
 * arrives from a SQL literal rather than from any parameter at all. A zip would have reported
 * `id ← params[0]` with no sign that it was wrong.
 */
export function extractColumnBindings(
  file: string,
  source: string,
  fallback: ModuleBindings = emptyBindings(),
): ColumnBindingExtraction {
  const code = normalizeSource(source);
  const bindings = resolveBindings(
    collectModuleBindings(code),
    collectImportedNames(code),
    fallback,
  );
  const params = parameterArrays(code);
  const constants = sqlConstants(code);
  const annotations = typeAnnotations(code);

  const out: ColumnBinding[] = [];
  const unresolved: UnresolvedBinding[] = [];

  /**
   * The parameter array belonging to the statement at `at`: the `query(…)` call whose argument span
   * *encloses* it, else the next call whose first argument is the identifier bound to the template
   * the statement sits in.
   *
   * "The next query call" alone is wrong and was measured wrong — for the common
   * `tx.query(\`INSERT …\`, […])` the call *opens before* the statement, so the next one belongs to
   * another method and 56 positions resolved against the wrong array. Requiring the following call
   * to pass the identifier the SQL was assigned to is what makes the second route honest.
   */
  const parametersFor = (at: number): ParameterArray => {
    for (const p of params) if (p.at < at && at < p.end) return p;
    const named = constants.find((c) => c.from < at && at < c.to);
    if (named === undefined) {
      return {
        at,
        end: at,
        first: "",
        items: null,
        unlocated: true,
        detail: "the statement is not enclosed by a query call and is not assigned to a const",
      };
    }
    for (const p of params) {
      if (p.at < at) continue;
      if (p.first === named.name) return p;
      return {
        at,
        end: at,
        first: p.first,
        items: null,
        unlocated: true,
        detail: `the next query call passes \`${p.first.replace(/\s+/g, " ").slice(0, 40)}\`, not \`${named.name}\``,
      };
    }
    return {
      at,
      end: at,
      first: "",
      items: null,
      unlocated: true,
      detail: `no query call follows the template assigned to \`${named.name}\``,
    };
  };

  const typeOf = (name: string, before: number): string | null => {
    let found: string | null = null;
    for (const a of annotations) if (a.at < before && a.name === name) found = a.type;
    return found;
  };

  type Resolution =
    | { readonly ok: true; readonly binding: Omit<ColumnBinding, "file" | "line" | "statement" | "schema" | "table" | "column"> }
    | { readonly ok: false; readonly kind: UnresolvedBindingKind; readonly detail: string };

  const resolveValue = (expression: string, array: ParameterArray): Resolution => {
    const text = expression.trim();
    const literal = /^'((?:[^']|'')*)'(?:::[\w ()]+)?$/.exec(text);
    if (literal !== null) {
      return {
        ok: true,
        binding: {
          kind: "literal",
          receiver: null,
          property: null,
          receiverType: null,
          literal: (literal[1] ?? "").replace(/''/g, "'"),
        },
      };
    }
    const placeholder = /^\$(\d+)(?:::[\w ()[\]]+)?$/.exec(text);
    if (placeholder === null) {
      return {
        ok: false,
        kind: "value_not_a_parameter",
        detail: `the value is \`${text.replace(/\s+/g, " ").slice(0, 60)}\``,
      };
    }
    if (array.items === null) {
      return {
        ok: false,
        kind: array.unlocated ? "params_not_located" : "params_not_an_array",
        detail: array.detail,
      };
    }
    const position = Number(placeholder[1]);
    const spread = array.items.findIndex((item) => item.startsWith("..."));
    if (spread >= 0 && position > spread) {
      return {
        ok: false,
        kind: "params_after_spread",
        detail: `$${position.toString()} sits at or past the spread \`${(array.items[spread] ?? "").replace(/\s+/g, " ").slice(0, 40)}\` at position ${(spread + 1).toString()}`,
      };
    }
    const item = array.items[position - 1];
    if (item === undefined) {
      return {
        ok: false,
        kind: "params_too_short",
        detail: `$${position.toString()} of ${array.items.length.toString()} parameters`,
      };
    }
    const stripped = item
      .replace(/\s*\?\?\s*(null|undefined)\s*$/, "")
      .replace(/\s+as\s+[\w<>[\]|. ]+$/, "")
      .trim();
    const member = /^([A-Za-z_$][\w$]*)(?:\?)?\.([A-Za-z_$][\w$]*)$/.exec(stripped);
    if (member === null) {
      const local = /^([A-Za-z_$][\w$]*)$/.exec(stripped);
      if (local !== null) {
        const identifier = local[1] ?? "";
        return {
          ok: true,
          binding: {
            kind: "local",
            receiver: null,
            property: identifier,
            receiverType: typeOf(identifier, array.at),
            literal: null,
          },
        };
      }
      return {
        ok: false,
        kind: "parameter_not_a_property",
        detail: `$${position.toString()} is \`${stripped.replace(/\s+/g, " ").slice(0, 60)}\``,
      };
    }
    const receiver = member[1] ?? "";
    return {
      ok: true,
      binding: {
        kind: "parameter",
        receiver,
        property: member[2] ?? "",
        receiverType: typeOf(receiver, array.at),
        literal: null,
      },
    };
  };

  const push = (
    where: { schema: string; table: string; column: string; line: number; kind: BindingStatementKind },
    resolution: Resolution,
  ): void => {
    if (resolution.ok) {
      out.push(
        ColumnBindingSchema.parse({
          file,
          line: where.line,
          statement: where.kind,
          schema: where.schema,
          table: where.table,
          column: where.column,
          ...resolution.binding,
        }),
      );
      return;
    }
    unresolved.push(
      UnresolvedBindingSchema.parse({
        file,
        line: where.line,
        kind: resolution.kind,
        schema: where.schema,
        table: where.table,
        column: where.column,
        detail: resolution.detail,
      }),
    );
  };

  const target = (raw: string): { schema: string; table: string } | null => {
    const substituted = substituteBindings(raw, bindings);
    if (substituted === null) return null;
    const parsed = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/.exec(substituted.trim().toLowerCase());
    return parsed === null ? null : { schema: parsed[1] ?? "", table: parsed[2] ?? "" };
  };

  /** `col = <value>` assignments out of a `SET` clause, with `EXCLUDED.col` left to the caller. */
  const assignments = (clause: string): readonly { column: string; value: string }[] => {
    const pairs: { column: string; value: string }[] = [];
    for (const segment of splitTopLevel(clause)) {
      const equals = /^\s*("?[A-Za-z_][\w]*"?)\s*=\s*([\s\S]+)$/.exec(segment);
      if (equals === null) continue;
      const column = columnName(equals[1] ?? "");
      if (column === null) continue;
      pairs.push({ column, value: (equals[2] ?? "").trim() });
    }
    return pairs;
  };

  for (const match of code.matchAll(/INSERT\s+INTO\s+([^\s(]+)\s*\(/g)) {
    const resolvedTarget = target(match[1] ?? "");
    if (resolvedTarget === null) continue;
    const { schema, table } = resolvedTarget;
    const line = lineAt(code, match.index);
    const open = match.index + match[0].length - 1;
    const close = matchBracket(code, open);
    if (close < 0) continue;
    const gap = (kind: UnresolvedBindingKind, detail: string): void => {
      unresolved.push(
        UnresolvedBindingSchema.parse({ file, line, kind, schema, table, column: null, detail }),
      );
    };

    const columnList = substituteBindings(code.slice(open + 1, close - 1), bindings);
    if (columnList === null) {
      gap("column_list_unresolved", "the INSERT's column list holds an unresolved interpolation");
      continue;
    }
    const columns = splitTopLevel(columnList).map(columnName);
    if (!columns.every((c): c is string => c !== null)) {
      gap("columns_not_bare", "the INSERT's column list is not bare column names");
      continue;
    }

    const tail = untilTemplateEnd(code.slice(close));
    const values = /VALUES\s*\(/i.exec(tail);
    if (values === null) {
      gap("values_clause_absent", "the INSERT has no VALUES list in its own template literal");
      continue;
    }
    const valuesOpen = close + values.index + values[0].length - 1;
    const valuesClose = matchBracket(code, valuesOpen);
    if (valuesClose < 0) {
      gap("values_clause_unresolved", "the VALUES list has no closing parenthesis");
      continue;
    }
    const valuesList = substituteBindings(code.slice(valuesOpen + 1, valuesClose - 1), bindings);
    if (valuesList === null) {
      gap("values_clause_unresolved", "the VALUES list holds an unresolved interpolation");
      continue;
    }
    const expressions = splitTopLevel(valuesList).map((e) => e.trim());
    if (expressions.length !== columns.length) {
      gap(
        "values_arity_mismatch",
        `${columns.length.toString()} columns against ${expressions.length.toString()} values`,
      );
      continue;
    }

    const array = parametersFor(match.index);
    const inserted = new Map<string, Resolution>();
    columns.forEach((column, i) => {
      const resolution = resolveValue(expressions[i] ?? "", array);
      inserted.set(column, resolution);
      push({ schema, table, column, line, kind: "insert" }, resolution);
    });

    const conflict = /ON\s+CONFLICT\b[\s\S]*?DO\s+UPDATE\s+SET\b/i.exec(tail);
    if (conflict === null) continue;
    const setStart = close + conflict.index + conflict[0].length;
    const setLine = lineAt(code, setStart);
    const clause = substituteBindings(clauseOf(code.slice(setStart)), bindings);
    if (clause === null) {
      unresolved.push(
        UnresolvedBindingSchema.parse({
          file,
          line: setLine,
          kind: "set_clause_unresolved",
          schema,
          table,
          column: null,
          detail: "the DO UPDATE SET clause holds an unresolved interpolation",
        }),
      );
      continue;
    }
    for (const { column, value } of assignments(clause)) {
      const excluded = /^EXCLUDED\s*\.\s*("?[A-Za-z_][\w]*"?)$/i.exec(value);
      if (excluded === null) {
        push(
          { schema, table, column, line: setLine, kind: "conflict_update" },
          resolveValue(value, array),
        );
        continue;
      }
      // `col = EXCLUDED.col` re-writes whatever the INSERT bound, so it inherits that binding
      // rather than being a second source.
      const from = columnName(excluded[1] ?? "");
      const inheritedFrom = from === null ? undefined : inserted.get(from);
      push(
        { schema, table, column, line: setLine, kind: "conflict_update" },
        inheritedFrom ?? {
          ok: false,
          kind: "excluded_column_not_inserted",
          detail: `\`${value}\` names a column this INSERT does not list`,
        },
      );
    }
  }

  for (const match of code.matchAll(/\bUPDATE\s+([^\s(]+)\s+(?:[A-Za-z_][\w]*\s+)?SET\s/g)) {
    // `DO UPDATE SET` is read above; matching it again would attribute the assignments twice.
    if (/DO\s+$/i.test(code.slice(Math.max(0, match.index - 4), match.index))) continue;
    const resolvedTarget = target(match[1] ?? "");
    if (resolvedTarget === null) continue;
    const { schema, table } = resolvedTarget;
    const line = lineAt(code, match.index);
    const setStart = match.index + match[0].length;
    const clause = substituteBindings(clauseOf(code.slice(setStart)), bindings);
    if (clause === null) {
      unresolved.push(
        UnresolvedBindingSchema.parse({
          file,
          line,
          kind: "set_clause_unresolved",
          schema,
          table,
          column: null,
          detail: "the SET clause holds an unresolved interpolation",
        }),
      );
      continue;
    }
    const array = parametersFor(match.index);
    for (const { column, value } of assignments(clause)) {
      push({ schema, table, column, line, kind: "update" }, resolveValue(value, array));
    }
  }

  return { bindings: out, unresolved };
}

/** Runs `extractColumnBindings` over every source, with each file's own module bindings. */
export function scanColumnBindings(
  sources: readonly WorkspaceSourceFile[],
): ColumnBindingExtraction {
  const bindings: ColumnBinding[] = [];
  const unresolved: UnresolvedBinding[] = [];
  for (const source of sources) {
    const extraction = extractColumnBindings(source.file, source.text);
    bindings.push(...extraction.bindings);
    unresolved.push(...extraction.unresolved);
  }
  return { bindings, unresolved };
}

/* ------------------------------------------------------- the type index */

/**
 * The three idioms `collectWorkspaceDomains` does not read, each keyed by name and resolved against
 * the file that references it.
 *
 * It deliberately does **not** re-read `field: z.enum(…)` inside an exported schema:
 * `collectWorkspaceDomains` already records that as a `schema_field` domain carrying `typedBy`, and
 * a second parser for one declaration is the shape this repo keeps finding wrong. What is left is
 * `field: SomeEnumSchema` (a named enum rather than an inline one — `DeploymentRecord.environment`
 * and `ChainedLogEntry.kind` are both written that way), an `interface`/object-type field, and the
 * `(typeof CONST)[number]` alias that types one.
 */
export interface SymbolSite {
  readonly package: string;
  readonly file: string;
}

export interface EnumSchemaSite extends SymbolSite {
  /** The constant the `z.enum(…)` names, or `null` when it lists its members inline. */
  readonly reference: string | null;
  readonly members: readonly string[] | null;
}

export interface NamedFieldSite extends SymbolSite {
  /** The field's initialiser, for a schema; its type expression, for an object type. */
  readonly text: string;
}

export interface EnumAliasSite extends SymbolSite {
  readonly constant: string;
}

export interface StoreTypeIndex {
  readonly enumSchemas: ReadonlyMap<string, readonly EnumSchemaSite[]>;
  /** `XSchema.field` for an exported schema, so `field: SomeEnumSchema` can be followed. */
  readonly schemaFields: ReadonlyMap<string, readonly NamedFieldSite[]>;
  /** `X.field` for an `interface X` or a `type X = { … }`. */
  readonly objectFields: ReadonlyMap<string, readonly NamedFieldSite[]>;
  /** `type X = (typeof CONST)[number]`. */
  readonly enumAliases: ReadonlyMap<string, readonly EnumAliasSite[]>;
  /** `type X = z.infer<typeof S>`, which is a hop and not a domain. */
  readonly inferAliases: ReadonlyMap<string, readonly NamedFieldSite[]>;
  readonly schemaNames: ReadonlySet<string>;
  readonly importsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

function add<T>(into: Map<string, T[]>, key: string, value: T): void {
  into.set(key, [...(into.get(key) ?? []), value]);
}

/**
 * One statement's text, ending at the `;` that closes it.
 *
 * Needed because an exported schema's initialiser is a chained expression —
 * `z.object({…}).strict()` — so its fields cannot be found by bracket-matching one `{`, and reading
 * to the end of the file would attribute the next schema's fields to this one.
 */
function statementSpan(code: string, from: number): string {
  let depth = 0;
  let i = from;
  while (i < code.length) {
    const ch = code[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < code.length) {
        const c = code[i] ?? "";
        i += 1;
        if (c === "\\") {
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === ";" && depth === 0) return code.slice(from, i);
    i += 1;
  }
  return code.slice(from);
}

/**
 * The top-level `key: value` pairs of an object literal's body.
 *
 * Hand-written rather than `splitTopLevel`, because the value of interest here is the whole
 * initialiser — `z.enum(HASH_ALGORITHMS).default("sha256")` — and the depth counter has to step
 * over a string without losing the bracket that follows it. Getting that wrong truncated the field
 * list at the first initialiser containing a string literal, which silently hid `algorithm` on
 * `ChainCheckpointSchema` and `region` on `CreateTenantInputSchema`.
 */
export function objectLiteralFields(body: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let keyStart = 0;
  let valueStart = 0;
  let key = "";
  let inValue = false;
  let i = 0;
  while (i <= body.length) {
    const ch = body[i] ?? ",";
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < body.length) {
        const c = body[i] ?? "";
        i += 1;
        if (c === "\\") {
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth !== 0) {
      i += 1;
      continue;
    }
    if (ch === ":" && !inValue) {
      key = body.slice(keyStart, i).trim();
      inValue = true;
      valueStart = i + 1;
      i += 1;
      continue;
    }
    if (ch === "," || i === body.length) {
      if (inValue && /^[A-Za-z_$][\w$]*$/.test(key) && !out.has(key)) {
        out.set(key, body.slice(valueStart, i).trim());
      }
      inValue = false;
      keyStart = i + 1;
    }
    i += 1;
  }
  return out;
}

/** `import { A, B as C } from "@crossengin/x"` → the package each imported name came from. */
function importSources(code: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const from = m[2] ?? "";
    if (!from.startsWith("@crossengin/")) continue;
    const pkg = from.split("/").slice(0, 2).join("/");
    for (const clause of (m[1] ?? "").split(",")) {
      const named = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
        clause,
      );
      if (named === null) continue;
      out.set(named[2] ?? named[1] ?? "", pkg);
    }
  }
  return out;
}

export function collectStoreTypes(sources: readonly WorkspaceSourceFile[]): StoreTypeIndex {
  const enumSchemas = new Map<string, EnumSchemaSite[]>();
  const schemaFields = new Map<string, NamedFieldSite[]>();
  const objectFields = new Map<string, NamedFieldSite[]>();
  const enumAliases = new Map<string, EnumAliasSite[]>();
  const inferAliases = new Map<string, NamedFieldSite[]>();
  const schemaNames = new Set<string>();
  const importsByFile = new Map<string, ReadonlyMap<string, string>>();

  for (const source of sources) {
    const code = stripComments(source.text);
    const site = { package: source.package, file: source.file };
    importsByFile.set(source.file, importSources(code));

    for (const m of code.matchAll(
      /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*z\s*\.\s*enum\s*\(\s*/g,
    )) {
      const after = code.slice(m.index + m[0].length);
      if (after.startsWith("[")) {
        const end = matchBracket(after, 0);
        const members =
          end <= 0
            ? null
            : splitTopLevel(after.slice(1, end - 1)).map((e) =>
                e.trim().replace(/^["'](.*)["']$/, "$1"),
              );
        add(enumSchemas, m[1] ?? "", { ...site, reference: null, members });
        continue;
      }
      const reference = /^([A-Za-z_$][\w$]*)/.exec(after);
      add(enumSchemas, m[1] ?? "", {
        ...site,
        reference: reference === null ? null : (reference[1] ?? null),
        members: null,
      });
    }

    for (const m of code.matchAll(
      /\bexport\s+const\s+([A-Za-z_$][\w$]*Schema)\s*(?::[^=;]*)?=\s*/g,
    )) {
      const name = m[1] ?? "";
      schemaNames.add(name);
      const span = statementSpan(code, m.index);
      const object = /z\s*\.\s*object\s*\(\s*\{/.exec(span);
      if (object === null) continue;
      const open = object.index + object[0].length - 1;
      const close = matchBracket(span, open);
      if (close < 0) continue;
      for (const [field, text] of objectLiteralFields(span.slice(open + 1, close - 1))) {
        add(schemaFields, `${name}.${field}`, { ...site, text });
      }
    }

    for (const m of code.matchAll(
      /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*typeof\s+([A-Za-z_$][\w$]*)\s*\)\s*\[\s*number\s*\]/g,
    )) {
      add(enumAliases, m[1] ?? "", { ...site, constant: m[2] ?? "" });
    }
    for (const m of code.matchAll(
      /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*z\s*\.\s*infer\s*<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>/g,
    )) {
      add(inferAliases, m[1] ?? "", { ...site, text: m[2] ?? "" });
    }

    const takeFields = (name: string, body: string): void => {
      for (const field of body.matchAll(
        /(?:^|[;\n])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^;\n]+)/g,
      )) {
        add(objectFields, `${name}.${field[1] ?? ""}`, {
          ...site,
          text: (field[2] ?? "").trim().replace(/,$/, ""),
        });
      }
    };
    for (const m of code.matchAll(/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)[^{]*\{/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(code, open);
      if (close > 0) takeFields(m[1] ?? "", code.slice(open + 1, close - 1));
    }
    for (const m of code.matchAll(/\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(code, open);
      if (close > 0) takeFields(m[1] ?? "", code.slice(open + 1, close - 1));
    }
  }

  return {
    enumSchemas,
    schemaFields,
    objectFields,
    enumAliases,
    inferAliases,
    schemaNames,
    importsByFile,
  };
}

/* ------------------------------------------------------- resolving a domain */

/**
 * One of several same-named declarations, chosen by the four steps `collectWorkspaceDomains` uses
 * for a spread member: the same file, the same package, the package the referencing file *imports*
 * it from, then a workspace-unique match.
 *
 * Using the same four steps on both sides of the comparison is load-bearing rather than tidy.
 * Three of the four contradictions the first measurement of this rule produced were its own
 * resolver attributing an imported constant to the importing package, and a fourth was a bare-name
 * map holding whichever `SeveritySchema` had been scanned last — `incident-response`'s sev1..sev5
 * against `observability`'s P0..P3. A declared ref resolved one way and a bound ref resolved
 * another is not a comparison.
 */
export function pickByOrigin<T extends SymbolSite>(
  candidates: readonly T[] | undefined,
  importNames: readonly string[],
  file: string,
  pkg: string,
  imports: ReadonlyMap<string, ReadonlyMap<string, string>>,
): T | null {
  if (candidates === undefined || candidates.length === 0) return null;
  const local = candidates.filter((c) => c.file === file);
  if (local.length === 1) return local[0] ?? null;
  const samePackage = candidates.filter((c) => c.package === pkg);
  if (samePackage.length === 1) return samePackage[0] ?? null;
  const fileImports = imports.get(file);
  for (const name of importNames) {
    const from = fileImports?.get(name);
    if (from === undefined) continue;
    const imported = candidates.filter((c) => c.package === from);
    if (imported.length === 1) return imported[0] ?? null;
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** What a bound field's type says about the column's domain. */
export const BOUND_DOMAIN_OUTCOMES = [
  "named",
  "inline_union",
  "unconstrained",
  "unresolved",
] as const;
export type BoundDomainOutcome = (typeof BOUND_DOMAIN_OUTCOMES)[number];

export interface BoundDomain {
  readonly outcome: BoundDomainOutcome;
  /** The ref of the domain the field is typed by, for `named`. */
  readonly ref: string | null;
  /** The members, where they are readable — for `named` and for `inline_union`. */
  readonly members: readonly string[] | null;
  /**
   * Whether `ref` names something a declaration could name. A module-private constant types a
   * schema's field perfectly well and cannot be referenced, which is a finding with its own
   * remedy rather than a contradiction.
   */
  readonly nameable: boolean;
  readonly reason: string | null;
}

const UNCONSTRAINED_TYPE = /^(string|string\s*\|\s*null|string\s*\|\s*undefined)$/;
const LITERAL_UNION = /^(["'][^"']*["']\s*\|\s*)*["'][^"']*["']$/;

interface DomainLookup {
  readonly domains: readonly WorkspaceDomain[];
  readonly byRef: ReadonlyMap<string, WorkspaceDomain>;
  readonly byName: ReadonlyMap<string, readonly WorkspaceDomain[]>;
  readonly index: StoreTypeIndex;
}

export function buildDomainLookup(
  domains: readonly WorkspaceDomain[],
  index: StoreTypeIndex,
): DomainLookup {
  const byRef = new Map<string, WorkspaceDomain>();
  const byName = new Map<string, WorkspaceDomain[]>();
  for (const domain of domains) {
    byRef.set(`${domain.package}:${domain.name}`, domain);
    add(byName, domain.name, domain);
  }
  return { domains, byRef, byName, index };
}

/**
 * Follows a ref to the symbol a declaration and a binding can both be compared at.
 *
 * `XSchema.field` typed `z.enum(CONST)` is the same domain as `CONST`, and ADR-0353's 29
 * schema-field refs exist precisely because a constant is sometimes ambiguous or absent — so a
 * declaration may legitimately spell either, and canonicalising both sides is what gives it that
 * latitude without weakening the comparison to a member test.
 */
export function canonicalDomainRef(ref: string, lookup: DomainLookup): string {
  const seen = new Set<string>();
  let current = ref;
  // Iterative because the two kinds of reference compose: a re-export alias of a constant, and a
  // schema field typed by one. A cycle is impossible in valid TypeScript and guarded anyway.
  while (!seen.has(current)) {
    seen.add(current);
    const next = lookup.byRef.get(current)?.typedBy;
    if (next === undefined || next === null) return current;
    current = next;
  }
  return current;
}

const MAX_TYPE_HOPS = 4;

/**
 * `(typeName, property)` → the domain that field is typed by, over the four idioms this repo uses.
 *
 * The `field: z.enum(…)` form is answered from `collectWorkspaceDomains`' own output rather than
 * re-parsed here, so there is one reader of that declaration and the two rules cannot disagree
 * about what it says.
 */
export function resolveBoundDomain(
  typeName: string,
  property: string,
  lookup: DomainLookup,
  file: string,
  pkg: string,
): BoundDomain {
  const { index } = lookup;
  const unresolved = (reason: string): BoundDomain => ({
    outcome: "unresolved",
    ref: null,
    members: null,
    nameable: false,
    reason,
  });
  const seen = new Set<string>();
  let name = typeName;
  for (let hop = 0; hop < MAX_TYPE_HOPS; hop += 1) {
    if (seen.has(name)) return unresolved(`type \`${name}\` resolves cyclically`);
    seen.add(name);
    const schema = name.endsWith("Schema") ? name : `${name}Schema`;

    // 1. `field: z.enum(CONST)` / `z.enum([…])` inside an exported schema.
    const domain = pickByOrigin(
      lookup.byName.get(`${schema}.${property}`),
      [schema, name],
      file,
      pkg,
      index.importsByFile,
    );
    if (domain !== null) {
      const ref = domain.typedBy ?? `${domain.package}:${domain.name}`;
      return {
        outcome: "named",
        ref,
        members: domain.members,
        nameable: lookup.byRef.has(ref),
        reason: null,
      };
    }

    // 2. `field: SomeEnumSchema` — a named enum rather than an inline one.
    const field = pickByOrigin(
      index.schemaFields.get(`${schema}.${property}`),
      [schema, name],
      file,
      pkg,
      index.importsByFile,
    );
    if (field !== null) {
      const resolved = domainOfSchemaInitialiser(field, schema, property, lookup);
      if (resolved !== null) return resolved;
    }

    // 3. An `interface`/object-type field.
    const object = pickByOrigin(
      index.objectFields.get(`${name}.${property}`),
      [name],
      file,
      pkg,
      index.importsByFile,
    );
    if (object !== null) return domainOfTypeExpression(object, lookup);

    // 4. `type X = z.infer<typeof S>` is a hop, not an answer.
    const inferred = pickByOrigin(
      index.inferAliases.get(name),
      [name],
      file,
      pkg,
      index.importsByFile,
    );
    if (inferred !== null && !seen.has(inferred.text)) {
      name = inferred.text;
      continue;
    }
    if (index.schemaNames.has(schema)) {
      return unresolved(`\`${schema}\` declares no field \`${property}\``);
    }
    return unresolved(`nothing named \`${name}\` declares a field \`${property}\``);
  }
  return unresolved(`type \`${typeName}\` did not resolve in ${MAX_TYPE_HOPS.toString()} hops`);
}

/**
 * The domain a *local*'s own type names — `setStatus(id: string, status: TenantStatus)`.
 *
 * A separate entry point from `resolveBoundDomain` because the question is different: a
 * `receiver.property` binding asks which type declares that field, while a bare identifier asks
 * what the identifier itself is. Collapsing the two would mean looking for a field named after a
 * variable.
 */
export function resolveLocalDomain(
  typeName: string,
  lookup: DomainLookup,
  file: string,
  pkg: string,
): BoundDomain {
  return domainOfTypeExpression({ package: pkg, file, text: typeName }, lookup);
}

function refOfConstant(
  constant: string,
  site: SymbolSite,
  lookup: DomainLookup,
): { ref: string; members: readonly string[] | null; nameable: boolean } | null {
  const domain = pickByOrigin(
    lookup.byName.get(constant),
    [constant],
    site.file,
    site.package,
    lookup.index.importsByFile,
  );
  if (domain !== null) {
    return {
      ref: `${domain.package}:${domain.name}`,
      members: domain.members,
      nameable: true,
    };
  }
  return null;
}

function domainOfSchemaInitialiser(
  field: NamedFieldSite,
  schema: string,
  property: string,
  lookup: DomainLookup,
): BoundDomain | null {
  const named = /^([A-Za-z_$][\w$]*)/.exec(field.text);
  if (named === null) return null;
  const enumSchema = pickByOrigin(
    lookup.index.enumSchemas.get(named[1] ?? ""),
    [named[1] ?? ""],
    field.file,
    field.package,
    lookup.index.importsByFile,
  );
  if (enumSchema === null) {
    if (/^z\s*\.\s*string\b/.test(field.text)) {
      return {
        outcome: "unconstrained",
        ref: null,
        members: null,
        nameable: false,
        reason: `\`${schema}.${property}\` is \`z.string()\`, so only the CHECK refuses a wrong value`,
      };
    }
    return null;
  }
  if (enumSchema.reference === null) {
    // `export const XSchema = z.enum([…])`: the schema *is* the domain.
    const ref = `${enumSchema.package}:${named[1] ?? ""}`;
    return {
      outcome: "named",
      ref,
      members: enumSchema.members,
      nameable: lookup.byRef.has(ref),
      reason: null,
    };
  }
  const constant = refOfConstant(enumSchema.reference, enumSchema, lookup);
  if (constant === null) {
    return {
      outcome: "unresolved",
      ref: null,
      members: null,
      nameable: false,
      reason: `\`${named[1] ?? ""}\` names \`${enumSchema.reference}\`, which did not resolve to one domain`,
    };
  }
  return { outcome: "named", ...constant, reason: null };
}

function domainOfTypeExpression(field: NamedFieldSite, lookup: DomainLookup): BoundDomain {
  const text = field.text.trim();
  if (UNCONSTRAINED_TYPE.test(text)) {
    return {
      outcome: "unconstrained",
      ref: null,
      members: null,
      nameable: false,
      reason: `the field is typed \`${text}\`, so only the CHECK refuses a wrong value`,
    };
  }
  const stripped = text
    .replace(/\s*\|\s*(null|undefined)\s*$/g, "")
    .replace(/^Readonly<(.*)>$/, "$1")
    .trim();
  if (LITERAL_UNION.test(stripped)) {
    return {
      outcome: "inline_union",
      ref: null,
      members: stripped.split("|").map((m) => m.trim().replace(/^["'](.*)["']$/, "$1")),
      nameable: false,
      reason: null,
    };
  }
  const named = /^([A-Za-z_$][\w$]*)$/.exec(stripped);
  if (named === null) {
    return {
      outcome: "unresolved",
      ref: null,
      members: null,
      nameable: false,
      reason: `field type \`${stripped.replace(/\s+/g, " ").slice(0, 60)}\` is not a nameable enum type`,
    };
  }
  const alias = pickByOrigin(
    lookup.index.enumAliases.get(named[1] ?? ""),
    [named[1] ?? ""],
    field.file,
    field.package,
    lookup.index.importsByFile,
  );
  if (alias === null) {
    return {
      outcome: "unresolved",
      ref: null,
      members: null,
      nameable: false,
      reason: `field type \`${stripped}\` is not \`(typeof CONST)[number]\``,
    };
  }
  const constant = refOfConstant(alias.constant, alias, lookup);
  if (constant === null) {
    return {
      outcome: "unresolved",
      ref: null,
      members: null,
      nameable: false,
      reason: `\`${stripped}\` aliases \`${alias.constant}\`, which did not resolve to one domain`,
    };
  }
  return { outcome: "named", ...constant, reason: null };
}

/* --------------------------------------------------------- declarations */

/**
 * A binding into a value-set column whose field is typed `string`, so nothing but the CHECK refuses
 * a wrong value.
 *
 * Reported rather than refused, and declared rather than counted — `check-admission.ts`' choice for
 * the same reason: the decoupling can be deliberate (`notification-store.ts`'s own comment says so
 * in as many words, "any producer that satisfies this shape can be recorded"), and refusing would
 * refuse code that works. What a declaration buys is that a fifth one is visible in a diff, with
 * the consequence written down: the value is validated nowhere in this process, so a producer bug
 * surfaces as a `23514` from the database after the handler has already done its work.
 */
export const UnconstrainedBindingSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  /** The type whose field is `string`. */
  type: z.string().min(1),
  field: z.string().min(1),
  note: z.string().min(40),
});
export type UnconstrainedBinding = z.infer<typeof UnconstrainedBindingSchema>;

export const UNCONSTRAINED_BINDINGS: readonly UnconstrainedBinding[] = [
  {
    table: "notification_dispatches",
    column: "channel",
    type: "DispatchInput",
    field: "channel",
    note:
      "`DispatchInput` is `apps/operate-server`'s own persistence shape and its four enum fields " +
      "are `string` on purpose — its comment says the store must not depend on whichever module " +
      "built the dispatch. The cost is that `notification_dispatches`' CHECK is the only thing " +
      "that refuses a wrong channel, and it refuses it after the dispatch has been planned.",
  },
  {
    table: "notification_dispatches",
    column: "category",
    type: "DispatchInput",
    field: "category",
    note:
      "The same decoupling as `channel`. A category is also what `computeDispatchEligibility` " +
      "reads for consent, so a value the CHECK refuses would have already been treated as a " +
      "suppressible or non-suppressible category by the planner.",
  },
  {
    table: "notification_dispatches",
    column: "priority",
    type: "DispatchInput",
    field: "priority",
    note:
      "The same decoupling as `channel`. Priority drives throttling and quiet-hours deferral, so " +
      "the planner has already acted on the value by the time the CHECK would refuse it.",
  },
  {
    table: "notification_dispatches",
    column: "status",
    type: "DispatchInput",
    field: "status",
    note:
      "The same decoupling as `channel`, and the one where the CHECK is load-bearing: a dispatch " +
      "row is advanced by `DispatchAdvanceUpdate`, whose `status` is also `string`, so neither " +
      "the insert nor the advance is checked against `DISPATCH_STATUSES` in this process.",
  },
];

/**
 * A binding this scan could not trace back to a symbol, declared per `(file, table, kind)`.
 *
 * `PG_SCAN_GAPS`' grain and its argument: a rule whose unreadable cases are a silent bucket
 * reports "every declaration agrees" having checked a handful, so the honest shape is a list that
 * a both-ways comparison keeps current. Most of these are a `VALUES` or `SET` clause built by a
 * helper, which is the same limit `pg-column-coverage.ts` stops at — resolving them means
 * evaluating arbitrary functions.
 */
export const BindingGapSchema = z.object({
  file: z.string().min(1),
  table: z.string().min(1),
  kind: z.enum(UNRESOLVED_BINDING_KINDS),
  note: z.string().min(30),
});
export type BindingGap = z.infer<typeof BindingGapSchema>;

export const BINDING_GAPS: readonly BindingGap[] = [
  {
    file: "apps/operate-server/src/delivery-store.ts",
    table: "notification_deliveries",
    kind: "values_clause_absent",
    note: "the INSERT's VALUES list is in a separate template literal from its column list.",
  },
  {
    file: "apps/operate-server/src/digest-store.ts",
    table: "notification_digests",
    kind: "value_not_a_parameter",
    note:
      "`status` is a `CASE WHEN item_count + 1 >= max_items THEN …` expression, so the value is " +
      "decided by the database from the row rather than bound from the process.",
  },
  {
    file: "apps/operate-server/src/integrity-verdict-store.ts",
    table: "audit_integrity_verdicts",
    kind: "params_not_an_array",
    note: "the parameters are accumulated into a `params` local and passed by name.",
  },
  {
    file: "apps/operate-server/src/notification-template-store.ts",
    table: "notification_templates",
    kind: "set_clause_unresolved",
    note: "the SET clause is assembled from a helper, so its assignments are not literal text.",
  },
  {
    file: "apps/operate-server/src/platform-users.ts",
    table: "user_tenant_membership",
    kind: "params_after_spread",
    note:
      "`...scope.params` sits at position 1, so every later position is shifted by an amount a " +
      "scan cannot know.",
  },
  {
    file: "apps/operate-server/src/suppression-store.ts",
    table: "notification_suppressions",
    kind: "values_clause_absent",
    note: "the INSERT's VALUES list is in a separate template literal from its column list.",
  },
  {
    file: "apps/operate-server/src/tenant-manifests.ts",
    table: "operate_tenant_manifests",
    kind: "set_clause_unresolved",
    note: "the UPDATE's SET clause is built from the fields the caller supplied.",
  },
  {
    file: "packages/access-reviews-runtime-pg/src/evidence-store.ts",
    table: "access_review_evidence",
    kind: "params_after_spread",
    note:
      "`...EVIDENCE_RATE_FIELDS.map(…)` sits at position 9 and expands to six, so `status` at " +
      "$16 cannot be located. This is the gap that taught the spread rule: before it, `status` " +
      "resolved to `evidence.acceptedAt`.",
  },
  {
    file: "packages/feature-flags-pg/src/flag-store.ts",
    table: "feature_flags",
    kind: "values_clause_unresolved",
    note: "the VALUES list is rendered by `flagRowValues`, a helper over the whole record.",
  },
  {
    file: "packages/feature-flags-pg/src/flag-store.ts",
    table: "feature_flags",
    kind: "set_clause_unresolved",
    note: "the DO UPDATE SET clause is rendered from the same column list as the insert.",
  },
  {
    file: "packages/feature-flags-pg/src/kill-switch-store.ts",
    table: "feature_flag_kill_switches",
    kind: "column_list_unresolved",
    note: "the column list is a module const joined into the statement by a helper.",
  },
  {
    file: "packages/feature-flags-pg/src/kill-switch-store.ts",
    table: "feature_flag_kill_switches",
    kind: "set_clause_unresolved",
    note: "the DO UPDATE SET clause is rendered from that same column list.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/comms-store.ts",
    table: "incident_communications",
    kind: "values_clause_unresolved",
    note: "the VALUES list is rendered from a column list rather than written out.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/comms-store.ts",
    table: "incident_communications",
    kind: "set_clause_unresolved",
    note: "the DO UPDATE SET clause is rendered from that same column list.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/incident-store.ts",
    table: "incidents",
    kind: "column_list_unresolved",
    note: "the column list is assembled from a shared const and a per-call tail.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/incident-store.ts",
    table: "incidents",
    kind: "set_clause_unresolved",
    note: "the revision-guarded UPDATE renders its assignments from the same list.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/postmortem-store.ts",
    table: "incident_postmortems",
    kind: "values_clause_unresolved",
    note: "the VALUES list is rendered from a column list rather than written out.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/postmortem-store.ts",
    table: "incident_postmortems",
    kind: "set_clause_unresolved",
    note: "the DO UPDATE SET clause is rendered from that same column list.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/runbook-store.ts",
    table: "incident_runbook_executions",
    kind: "values_clause_unresolved",
    note: "the VALUES list is rendered from a column list rather than written out.",
  },
  {
    file: "packages/incident-response-runtime-pg/src/runbook-store.ts",
    table: "incident_runbook_executions",
    kind: "set_clause_unresolved",
    note: "the DO UPDATE SET clause is rendered from that same column list.",
  },
  {
    file: "packages/marketplace-runtime-pg/src/installation-store.ts",
    table: "pack_installations",
    kind: "values_clause_unresolved",
    note: "the VALUES list is rendered from a column list rather than written out.",
  },
  {
    file: "packages/observability-runtime-pg/src/enforcement-action-store.ts",
    table: "slo_enforcement_actions",
    kind: "values_clause_unresolved",
    note: "the VALUES list is rendered from a column list rather than written out.",
  },
  {
    file: "packages/tenant-lifecycle-pg/src/deletion-request-store.ts",
    table: "gdpr_deletion_requests",
    kind: "params_not_an_array",
    note:
      "`transition` accumulates its parameters into a `params` local because the guard predicate " +
      "is built per call.",
  },
  {
    file: "packages/tenant-lifecycle-pg/src/lifecycle-event-store.ts",
    table: "tenant_lifecycle_events",
    kind: "values_clause_unresolved",
    note:
      "`placeholders` is `LIFECYCLE_EVENT_COLUMNS.map(…)` with a per-column cast, so the VALUES " +
      "list is produced by an arrow with a conditional in it.",
  },
  {
    file: "packages/tenant-lifecycle-pg/src/tombstone-store.ts",
    table: "tenant_tombstones",
    kind: "values_clause_unresolved",
    note: "the VALUES list is rendered with a per-column cast map, as the lifecycle store's is.",
  },
  {
    file: "packages/workflow-runtime-pg/src/definition-store.ts",
    table: "workflow_definitions",
    kind: "values_clause_unresolved",
    note: "the VALUES list is rendered from a column list rather than written out.",
  },
  {
    file: "packages/workflow-runtime-pg/src/definition-store.ts",
    table: "workflow_definitions",
    kind: "set_clause_unresolved",
    note: "the status-guarded UPDATE renders its assignments from the same list.",
  },
  {
    file: "packages/workflow-runtime-pg/src/job-engine.ts",
    table: "dead_letter_jobs",
    kind: "parameter_not_a_property",
    note:
      "`reason` is `JOB_DEAD_LETTER_REASONS[input.disposition]`, a total map whose *values* are " +
      "the domain, so the symbol is one indirection past what this scan reads.",
  },
];

/* --------------------------------------------------------------- the audit */

/**
 * What the audit can find.
 *
 * `binding_domain_unexported` is deliberately **not** folded into `ref_contradicts_binding`, and
 * fires instead of it, on ADR-0334's rule that naming a remedy which would not work is worse than
 * naming none: when the bound constant is module-private no declaration can name it, so "the ref
 * contradicts the binding" sends the reader to re-adjudicate a declaration that has no right
 * answer. The remedy is to export the constant or converge the two spellings, and that is a
 * different sentence.
 */
export const COLUMN_BINDING_FINDING_KINDS = [
  "ref_contradicts_binding",
  "binding_domain_unexported",
  "literal_refused_by_check",
  "inline_union_exceeds_check",
  "unconstrained_undeclared",
  "unconstrained_overtaken",
  "gap_undeclared",
  "gap_overtaken",
  "gap_duplicate",
  "column_undeclared",
] as const;
export type ColumnBindingFindingKind = (typeof COLUMN_BINDING_FINDING_KINDS)[number];

export const ColumnBindingFindingSchema = z.object({
  kind: z.enum(COLUMN_BINDING_FINDING_KINDS),
  table: z.string().min(1),
  column: z.string().min(1).nullable(),
  detail: z.string().min(1),
});
export type ColumnBindingFinding = z.infer<typeof ColumnBindingFindingSchema>;

/** The shape of a `VALUE_SET_DOMAINS` entry this audit reads, which is all it reads of one. */
export interface DeclaredColumnDomain {
  readonly table: string;
  readonly column: string;
  readonly ref: string;
}

/** A catalogued value set, as `catalogValueSets` returns it. */
export interface CatalogColumnValueSet {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
}

export interface ColumnBindingAuditInput {
  readonly valueSets: readonly CatalogColumnValueSet[];
  readonly declarations: readonly DeclaredColumnDomain[];
  readonly bindings: readonly ColumnBinding[];
  readonly unresolved: readonly UnresolvedBinding[];
  readonly lookup: DomainLookup;
  /** Which package each scanned file belongs to, for resolving a name the way its file would. */
  readonly packageOfFile: ReadonlyMap<string, string>;
  readonly gaps?: readonly BindingGap[];
  readonly unconstrained?: readonly UnconstrainedBinding[];
}

/** How each value-set column with a binding was answered. */
export interface ColumnBindingSummary {
  readonly valueSets: number;
  /** Columns whose declared ref was compared against a resolved bound symbol and agreed. */
  readonly agreeing: number;
  /** Columns checked by any means: a resolved symbol, a literal, or an inline union. */
  readonly checked: number;
  readonly literals: number;
  readonly inlineUnions: number;
  readonly unconstrained: number;
  /** Bindings whose receiver the module annotates nowhere. */
  readonly untypedReceivers: number;
  /** Bindings whose type resolved to no domain. */
  readonly unresolvedTypes: number;
  readonly unresolvedBindings: number;
}

function resolveBinding(
  binding: ColumnBinding,
  input: ColumnBindingAuditInput,
): BoundDomain | null {
  if (binding.receiverType === null || binding.property === null) return null;
  const pkg = input.packageOfFile.get(binding.file) ?? "";
  return binding.kind === "local"
    ? resolveLocalDomain(binding.receiverType, input.lookup, binding.file, pkg)
    : resolveBoundDomain(binding.receiverType, binding.property, input.lookup, binding.file, pkg);
}

function bindingsByColumn(
  input: ColumnBindingAuditInput,
): ReadonlyMap<string, readonly ColumnBinding[]> {
  const valueSetColumns = new Set(input.valueSets.map((v) => `${v.table}.${v.column}`));
  const out = new Map<string, ColumnBinding[]>();
  for (const binding of input.bindings) {
    const key = `${binding.table}.${binding.column}`;
    if (!valueSetColumns.has(key)) continue;
    add(out, key, binding);
  }
  return out;
}

export function auditColumnBindings(
  input: ColumnBindingAuditInput,
): readonly ColumnBindingFinding[] {
  const findings: ColumnBindingFinding[] = [];
  const declared = new Map(input.declarations.map((d) => [`${d.table}.${d.column}`, d]));
  const valueSet = new Map(input.valueSets.map((v) => [`${v.table}.${v.column}`, v]));

  for (const [key, bindings] of bindingsByColumn(input)) {
    const declaration = declared.get(key);
    const column = valueSet.get(key);
    if (column === undefined) continue;
    if (declaration === undefined) {
      findings.push(
        ColumnBindingFindingSchema.parse({
          kind: "column_undeclared",
          table: column.table,
          column: column.column,
          detail: `the workspace binds a symbol into this value-set column and \`VALUE_SET_DOMAINS\` declares no domain for it`,
        }),
      );
      continue;
    }
    const declaredRef = canonicalDomainRef(declaration.ref, input.lookup);

    for (const binding of bindings) {
      const at = `${binding.file}:${binding.line.toString()}`;
      if (binding.kind === "literal") {
        if (binding.literal !== null && !column.values.includes(binding.literal)) {
          findings.push(
            ColumnBindingFindingSchema.parse({
              kind: "literal_refused_by_check",
              table: column.table,
              column: column.column,
              detail: `${at} writes the literal '${binding.literal}', which the catalogued CHECK does not admit: ${column.values.join(", ")}`,
            }),
          );
        }
        continue;
      }
      const domain = resolveBinding(binding, input);
      if (domain === null || domain.outcome === "unresolved") continue;
      if (domain.outcome === "unconstrained") continue;
      if (domain.outcome === "inline_union") {
        const refused = (domain.members ?? []).filter((m) => !column.values.includes(m));
        if (refused.length > 0) {
          findings.push(
            ColumnBindingFindingSchema.parse({
              kind: "inline_union_exceeds_check",
              table: column.table,
              column: column.column,
              detail: `${at} binds a field typed as a literal union whose member(s) ${refused.join(", ")} the catalogued CHECK does not admit`,
            }),
          );
        }
        continue;
      }
      const boundRef = domain.ref ?? "";
      if (!domain.nameable) {
        findings.push(
          ColumnBindingFindingSchema.parse({
            kind: "binding_domain_unexported",
            table: column.table,
            column: column.column,
            detail:
              `${at} binds a field typed by \`${boundRef}\`, which its package does not export, so no ref can name it; ` +
              `the declaration names \`${declaration.ref}\` instead. Export the bound constant, or converge the two spellings.`,
          }),
        );
        continue;
      }
      const canonical = canonicalDomainRef(boundRef, input.lookup);
      if (canonical !== declaredRef) {
        findings.push(
          ColumnBindingFindingSchema.parse({
            kind: "ref_contradicts_binding",
            table: column.table,
            column: column.column,
            detail:
              `${at} binds a field typed by \`${canonical}\` while the declaration refs \`${declaration.ref}\`` +
              (canonical === boundRef ? "" : ` (via \`${boundRef}\`)`) +
              `; the two enumerate the same members only by coincidence unless they are the same symbol.`,
          }),
        );
      }
    }
  }

  /* The unconstrained declarations, both directions. */
  const unconstrainedDeclared = new Map(
    (input.unconstrained ?? []).map((u) => [`${u.table}.${u.column}`, u]),
  );
  const unconstrainedFound = new Set<string>();
  for (const [key, bindings] of bindingsByColumn(input)) {
    for (const binding of bindings) {
      const domain = resolveBinding(binding, input);
      if (domain?.outcome !== "unconstrained") continue;
      unconstrainedFound.add(key);
      if (unconstrainedDeclared.has(key)) continue;
      const column = valueSet.get(key);
      if (column === undefined) continue;
      findings.push(
        ColumnBindingFindingSchema.parse({
          kind: "unconstrained_undeclared",
          table: column.table,
          column: column.column,
          detail: `${binding.file}:${binding.line.toString()} — ${domain.reason ?? "the bound field constrains nothing"}; declare it in UNCONSTRAINED_BINDINGS with its consequence, or type the field`,
        }),
      );
    }
  }
  for (const [key, entry] of unconstrainedDeclared) {
    if (unconstrainedFound.has(key)) continue;
    findings.push(
      ColumnBindingFindingSchema.parse({
        kind: "unconstrained_overtaken",
        table: entry.table,
        column: entry.column,
        detail: `UNCONSTRAINED_BINDINGS declares \`${entry.type}.${entry.field}\` unconstrained and the scan no longer finds it; delete the declaration`,
      }),
    );
  }

  /* The gap declarations, both directions. */
  const gaps = input.gaps ?? [];
  const gapKey = (g: { file: string; table: string; kind: string }): string =>
    `${g.file}|${g.table}|${g.kind}`;
  const seenGap = new Set<string>();
  for (const gap of gaps) {
    const key = gapKey(gap);
    if (seenGap.has(key)) {
      findings.push(
        ColumnBindingFindingSchema.parse({
          kind: "gap_duplicate",
          table: gap.table,
          column: null,
          detail: `BINDING_GAPS declares \`${key}\` twice`,
        }),
      );
    }
    seenGap.add(key);
  }
  const valueSetTables = new Set(input.valueSets.map((v) => v.table));
  const valueSetColumns = new Set(input.valueSets.map((v) => `${v.table}.${v.column}`));
  const relevant = input.unresolved.filter((u) =>
    u.column === null ? valueSetTables.has(u.table) : valueSetColumns.has(`${u.table}.${u.column}`),
  );
  const foundGap = new Set(relevant.map(gapKey));
  for (const unresolved of relevant) {
    if (seenGap.has(gapKey(unresolved))) continue;
    findings.push(
      ColumnBindingFindingSchema.parse({
        kind: "gap_undeclared",
        table: unresolved.table,
        column: unresolved.column,
        detail: `${unresolved.file}:${unresolved.line.toString()} ${unresolved.kind} — ${unresolved.detail}; declare it in BINDING_GAPS or make the statement readable`,
      }),
    );
  }
  for (const gap of gaps) {
    if (foundGap.has(gapKey(gap))) continue;
    findings.push(
      ColumnBindingFindingSchema.parse({
        kind: "gap_overtaken",
        table: gap.table,
        column: null,
        detail: `BINDING_GAPS declares \`${gapKey(gap)}\` and the scan now resolves it; delete the declaration`,
      }),
    );
  }

  const order = new Map(COLUMN_BINDING_FINDING_KINDS.map((k, i) => [k, i]));
  return [...findings].sort(
    (a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) || a.table.localeCompare(b.table),
  );
}

export function summarizeColumnBindings(input: ColumnBindingAuditInput): ColumnBindingSummary {
  let agreeing = 0;
  let literals = 0;
  let inlineUnions = 0;
  let unconstrained = 0;
  let untypedReceivers = 0;
  let unresolvedTypes = 0;
  const checked = new Set<string>();
  const declared = new Map(input.declarations.map((d) => [`${d.table}.${d.column}`, d]));

  for (const [key, bindings] of bindingsByColumn(input)) {
    for (const binding of bindings) {
      if (binding.kind === "literal") {
        literals += 1;
        checked.add(key);
        continue;
      }
      if (binding.receiverType === null) {
        untypedReceivers += 1;
        continue;
      }
      const domain = resolveBinding(binding, input);
      if (domain === null || domain.outcome === "unresolved") {
        unresolvedTypes += 1;
        continue;
      }
      if (domain.outcome === "unconstrained") {
        unconstrained += 1;
        continue;
      }
      if (domain.outcome === "inline_union") {
        inlineUnions += 1;
        checked.add(key);
        continue;
      }
      checked.add(key);
      const declaration = declared.get(key);
      if (
        declaration !== undefined &&
        domain.nameable &&
        canonicalDomainRef(domain.ref ?? "", input.lookup) ===
          canonicalDomainRef(declaration.ref, input.lookup)
      ) {
        agreeing += 1;
      }
    }
  }
  return {
    valueSets: input.valueSets.length,
    agreeing,
    checked: checked.size,
    literals,
    inlineUnions,
    unconstrained,
    untypedReceivers,
    unresolvedTypes,
    unresolvedBindings: input.unresolved.length,
  };
}

export function formatColumnBindingFindings(
  findings: readonly ColumnBindingFinding[],
): string {
  return findings
    .map((f) => `${f.kind}: ${f.table}${f.column === null ? "" : `.${f.column}`} — ${f.detail}`)
    .join("\n");
}
