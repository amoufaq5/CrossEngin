/**
 * Does a record field's name agree with the column it is **read from**?
 *
 * ADR-0355 built `pg-binding-names.ts` over the **write** path: for each catalogued column an
 * `INSERT`/`UPDATE` binds, does the column's name agree with the bound property's under this repo's
 * one transform? Its own first open end is this one, and the live member that prompted it was found
 * by hand while verifying it: `ClaimedJob.jobId` is the **run** id and `jobDefinitionId` is
 * `job_id`. A row → record mapping can name a field as wrongly as a parameter can, and **nothing
 * looked**: a mapper that assigns `row.created_at` to `updatedAt` satisfies every rule in this
 * directory, because no SQL is wrong, no column is missing and no value has the wrong type.
 *
 * The signal is the same one, so the vocabulary is the same: this repo spells a column `snake_case`
 * and its contract field `camelCase`, and `DERIVATION_RULES` is imported from the write-path rule
 * **unchanged** rather than restated, because `admits(column, property, table)` does not care which
 * direction the value is moving. One vocabulary, both directions.
 *
 * What is **not** the same is the anchor, and that asymmetry is most of this module. A write names
 * its table in the statement; a read says `row.campaign_id` and names nothing. Applying
 * `business_key` by column name alone would be unsound exactly where it matters — measured,
 * `campaign_id` is a single-column-UNIQUE business key on one table and a foreign key on **three**,
 * and `instance_id` on one against **four**. So the table is resolved from the **declared row
 * interface** by column-set containment, which is decisive: of **40** interfaces, **26** resolve to
 * exactly one table and **none is ambiguous**, giving a table for **313 of 336** reads.
 *
 * The anchor for a *read* is the **catalog** and never the `SELECT`. The SELECT-as-anchor version
 * was built first and abandoned on two measurements: it is wrong per module, because `records.ts`
 * holds five mappers while the statements sit in the three stores beside it, and
 * `installation-store.ts` issues `SELECT *`, which names no column at all. What makes the catalog
 * safe is itself a measurement rather than an assumption — every non-column `snake_case` property
 * in the workspace (an Anthropic `stop_reason`, an OpenAI `prompt_tokens`, a `pg_catalog`
 * `rls_enabled`) is absent from the catalog, so there is **zero collision** between "a column
 * access" and "any other property access".
 */
import { z } from "zod";

import {
  camelOfColumn,
  columnOfCamel,
  DERIVATION_RULES,
  NAME_DERIVATIONS,
  type NameDerivation,
} from "./pg-binding-names.js";
import { opensRegexLiteral, stripComments, type CatalogTable } from "./pg-column-coverage.js";
import type { WorkspaceSourceFile } from "./workspace-sql-scan.js";

/* ------------------------------------------------------------------ source */

/**
 * Replaces every string and template body with spaces, keeping offsets and line numbers.
 *
 * Needed as well as `stripComments`, and for the opposite reason: the SQL in this workspace lives
 * in template literals, so `meta.tenants`, `app.current_tenant_id` and `EXCLUDED.job_id` all read
 * as `snake_case` property accesses. Measured before it was added, those three alone contributed
 * **418** of 1,728 apparent accesses.
 *
 * It skips a **regex literal** as a unit for `stripComments`' reason and shares its predicate: a
 * pattern may contain a quote, so pairing that quote with a real one blanks the code between them.
 * Here the direction is conservative — a blanked region loses reads rather than inventing them —
 * but 19 of the scanned files put a quote inside a pattern, so it is a silent loss and not a
 * theoretical one.
 */
export function blankStringBodies(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (ch === "/" && source[i + 1] !== "/" && source[i + 1] !== "*" && opensRegexLiteral(source, i)) {
      // Copied verbatim and bounded by the line: a pattern is code, and an unterminated one must
      // not swallow the rest of the file the way the quote it contains would.
      out += ch;
      i += 1;
      let inClass = false;
      while (i < source.length) {
        const c = source[i] ?? "";
        if (c === "\n") break;
        out += c;
        i += 1;
        if (c === "\\") {
          out += source[i] ?? "";
          i += 1;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i] ?? "";
        if (c === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (c === quote) {
          out += c;
          i += 1;
          break;
        }
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** `row.some_column` and `row["some_column"]`, the two spellings this repo reads a column by. */
const COLUMN_ACCESS =
  /\b([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*)\b|\[\s*"([^"]+)"\s*\])/g;

/** `some_column`: the marker a read carries when nothing else says it is a column. */
function looksLikeColumn(name: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name);
}

/* --------------------------------------------------------------- row shapes */

/**
 * Where a field of a declared row interface comes from.
 *
 * A total map rather than a boolean, because the three non-column cases are genuinely different
 * and were **settled by reading the SELECTs** rather than guessed: `i.item_id AS item_natural_id`
 * reaches a catalogued column of another table through a join, while
 * `$1::TEXT AS instance_text_id` echoes the caller's own argument back and was never in the
 * database at all.
 */
export const ROW_FIELD_PROVENANCES = [
  /** A column of the table this row interface resolves to. */
  "catalogued_column",
  /** `<other>.<col> AS <alias>` — a catalogued column of another table, reached by a join. */
  "joined_column",
  /** `$n::TYPE AS <alias>` — the caller's own argument, round-tripped through the SELECT. */
  "parameter_echo",
  /** A `pg_catalog` read: there is no catalogued table for this row and never will be. */
  "introspection",
] as const;
export type RowFieldProvenance = (typeof ROW_FIELD_PROVENANCES)[number];

export const RowShapeSchema = z.object({
  file: z.string().min(1),
  /** The interface's name, which is the handle a declaration names it by. */
  name: z.string().min(1),
  /**
   * Every field it declares, in order — **not** only the `snake_case` ones.
   *
   * The distinction is load-bearing: **597 of the catalog's 2,399 columns are single-word**
   * (`status`, `kind`, `reason`, and the pairs most likely to be transposed — `before`/`after`,
   * `input`/`output`, `source`/`target`), so an underscore-only marker is blind to a quarter of
   * the catalog. Where this list is known there is no marker to guess at: the row says which of
   * its properties are columns.
   */
  fields: z.array(z.string().min(1)),
  /** The subset the catalog has a column of somewhere, which is what pins the table. */
  columns: z.array(z.string().min(1)),
  /**
   * The one catalogued table whose columns contain every catalogued field, or `null`.
   *
   * `null` means either a `pg_catalog` row or an unresolvable one, which the audit separates — a
   * row that *should* resolve and does not is a finding, and one that never could is a census line.
   */
  table: z.string().min(1).nullable(),
  /** Fields the catalog has no column of anywhere: an alias or a parameter echo. */
  foreign: z.array(z.string().min(1)),
});
export type RowShape = z.infer<typeof RowShapeSchema>;

/**
 * Every declared row interface, resolved to its table.
 *
 * The match **tolerates a field the catalog has no column of anywhere**, because that is what a
 * SQL alias looks like from here and the remaining fields still pin the table — which is what took
 * the resolution from 18 of 28 to 21, closing `ItemRow`, `DecisionRow` and `event-log.ts`' `Row`.
 * A three-field floor keeps a short `{a_b, c_d, e_f}` shape from matching several tables by
 * accident; the one interface below it in the workspace is an introspection row.
 */
export function resolveRowShapes(
  sources: readonly WorkspaceSourceFile[],
  catalog: readonly CatalogTable[],
): readonly RowShape[] {
  const anyColumn = new Set(catalog.flatMap((t) => t.columns.map((c) => c.name)));
  const out: RowShape[] = [];
  for (const source of sources) {
    const code = stripComments(source.text);
    // The `extends` clause is matched because omitting it is not a smaller scan but a silent one:
    // `StoredInstanceRow extends StoredCancellationColumns` was skipped entirely, so three reads
    // annotated with it resolved to no table and `tableForRead` answered `null` with nobody told.
    for (const match of code.matchAll(
      /\binterface\s+(\w*Row)(?:\s+extends\s+[\w\s,<>]+?)?\s*\{([\s\S]*?)\n\}/g,
    )) {
      const fields = [
        ...(match[2] ?? "").matchAll(/^\s*readonly\s+([A-Za-z_$][\w$]*)\s*\??\s*:/gm),
      ].map((f) => f[1] ?? "");
      if (fields.length < 3) continue;
      // Only a `snake_case` field the catalog has no column of anywhere is an alias. A single-word
      // one it does not have is an ordinary computed projection (`count(*) AS count`), which needs
      // no declaration because there is no column it could have been confused with.
      const foreign = fields.filter((f) => !anyColumn.has(f) && f.includes("_"));
      const known = fields.filter((f) => anyColumn.has(f));
      const candidates =
        known.length < 3
          ? []
          : catalog.filter((t) => {
              const columns = new Set(t.columns.map((c) => c.name));
              return known.every((k) => columns.has(k));
            });
      out.push(
        RowShapeSchema.parse({
          file: source.file,
          name: match[1] ?? "",
          fields,
          columns: known,
          table: candidates.length === 1 ? (candidates[0]?.name ?? null) : null,
          foreign,
        }),
      );
    }
  }
  return out;
}

/* -------------------------------------------------------------------- reads */

export const RecordReadSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  /** The record field the value lands in. */
  field: z.string().min(1),
  /** The column name the expression reads. */
  column: z.string().min(1),
  /** The object the column was read off, for a message a reader can act on. */
  receiver: z.string().min(1),
  /** The row interface the receiver is annotated with, or `null` where none is in scope. */
  rowType: z.string().min(1).nullable(),
  /**
   * The offset of the enclosing `{`.
   *
   * Carried for one finding: a **reversed pair** is two fields of *one* object literal each reading
   * the other's column, and without the grouping the two halves are only two divergences in a file.
   */
  literal: z.number().int().nonnegative(),
});
export type RecordRead = z.infer<typeof RecordReadSchema>;

export interface RecordReadExtraction {
  readonly reads: readonly RecordRead[];
  /** Fields whose expression reads **several** columns: derived, with no single name to compare. */
  readonly derived: readonly (Omit<RecordRead, "column"> & { readonly columns: readonly string[] })[];
}

interface KeyedValue {
  readonly key: string;
  readonly value: string;
  readonly offset: number;
  readonly literal: number;
}

/** Every `key: value` pair at any depth, tagged with the `{` that encloses it. */
function keyedValues(code: string): readonly KeyedValue[] {
  const out: KeyedValue[] = [];
  const open: number[] = [];
  const n = code.length;
  // One left-to-right pass maintaining the brace stack, so a key's enclosing literal is known
  // rather than inferred from proximity — which would group two sibling records as one.
  for (let i = 0; i < n; i += 1) {
    const ch = code[i] ?? "";
    if (ch === "{") {
      open.push(i);
      continue;
    }
    if (ch === "}") {
      open.pop();
      continue;
    }
    if (ch !== ":") continue;
    // The key must sit immediately after a `{` or a `,`, which is what separates an object field
    // from the `:` of a ternary. Allowing any whitespace before the identifier instead reads
    // `x === null ? null : y` as a field named `null` — measured, 6 of 37 findings were that.
    const before = code.slice(Math.max(0, i - 120), i);
    const key = /(?:^|[{,])\s*(?:([A-Za-z_$][\w$]*)|"([^"]+)")\s*$/.exec(before);
    if (key === null) continue;
    let j = i + 1;
    let depth = 0;
    const start = j;
    while (j < n) {
      const c = code[j] ?? "";
      if (c === "{" || c === "[" || c === "(") depth += 1;
      else if (c === "}" || c === "]" || c === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && (c === "," || c === ";")) break;
      j += 1;
    }
    out.push({
      key: key[1] ?? key[2] ?? "",
      value: code.slice(start, j),
      offset: start,
      literal: open[open.length - 1] ?? 0,
    });
  }
  return out;
}

/**
 * Every `field: <expression reading one catalogued column>` in the workspace.
 *
 * A field whose value is **itself an object literal** is skipped: its own fields are found on the
 * same pass, so counting the wrapper too reports every nested record twice — measured, 2,489
 * object-valued fields against 352 real reads.
 *
 * The candidate predicate is the column being **catalogued**, and that is sound rather than
 * convenient: measured over the workspace, *every* `snake_case` property that is not a column —
 * an Anthropic `stop_reason`, an OpenAI `prompt_tokens`, a `pg_catalog` `rls_enabled`, a SQL alias
 * — is absent from `META_TABLES`, so there is no collision to resolve.
 */
export function scanRecordReads(
  sources: readonly WorkspaceSourceFile[],
  catalog: readonly CatalogTable[],
  rowShapes: readonly RowShape[] = [],
): RecordReadExtraction {
  const catalogued = new Set(catalog.flatMap((t) => t.columns.map((c) => c.name)));
  // Keyed by file **and** name, with a bare-name fallback only where the name is unique in the
  // workspace. Four stores name their interface plainly `Row`, so a name-only map holds whichever
  // was scanned last — ADR-0354's own worst measurement artefact, reproduced here on the first
  // widening and caught by the read count going *down*.
  const byFileAndName = new Map<string, RowShape>();
  const uniqueByName = new Map<string, RowShape>();
  const nameCounts = new Map<string, number>();
  for (const shape of rowShapes) nameCounts.set(shape.name, (nameCounts.get(shape.name) ?? 0) + 1);
  for (const shape of rowShapes) {
    byFileAndName.set(`${shape.file}::${shape.name}`, shape);
    if (nameCounts.get(shape.name) === 1) uniqueByName.set(shape.name, shape);
  }
  const reads: RecordRead[] = [];
  const derived: (Omit<RecordRead, "column"> & { columns: readonly string[] })[] = [];

  for (const source of sources) {
    const code = blankStringBodies(stripComments(source.text));
    const newlines: number[] = [];
    for (let i = 0; i < code.length; i += 1) if (code[i] === "\n") newlines.push(i);
    const lineAt = (offset: number): number => {
      let lo = 0;
      let hi = newlines.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((newlines[mid] ?? 0) < offset) lo = mid + 1;
        else hi = mid;
      }
      return lo + 1;
    };
    // `(row: SomeRow)` annotations and `query<SomeRow>` generics, so a read can learn its row type.
    // `\w*Row` and not `\w+Row`: four stores name the interface plainly `Row`, and requiring a
    // prefix left exactly those four unresolvable — which cost the `business_key` derivation 4 of
    // its 9 members while `resolveRowShapes` had resolved their tables perfectly well.
    const annotations = [
      ...code.matchAll(/[(,]\s*([A-Za-z_$][\w$]*)\s*:\s*(\w*Row)\b/g),
    ].map((m) => ({ offset: m.index, receiver: m[1] ?? "", type: m[2] ?? "" }));
    // A generic names no receiver, so attributing it is a guess bounded by **every** `query<…>`
    // and not only the named ones. Measured: `job-cancellation.ts` issues
    // `query<{run_id: unknown; tenant_id: unknown}>` inline, so matching named generics alone
    // carried `StateRow` from 137 lines earlier onto `reapCancelledJobRuns`' own rows — right
    // here by luck, since both resolve to `meta.job_runs`, and a guess either way. An anonymous
    // row type is therefore recorded as one, and a read after it learns `null`: *the last query
    // in scope had a row type I cannot name* is the honest answer, and it costs only a
    // derivation that was never available.
    const generics = [...code.matchAll(/\bquery\s*<\s*(\w*Row\b)?/g)].map((m) => ({
      offset: m.index,
      type: m[1] ?? null,
    }));

    for (const { key, value, offset, literal } of keyedValues(code)) {
      if (value.trim().startsWith("{")) continue;
      // A `snake_case` key is not a record field: it is a row being copied to another row, which
      // the test fakes do (`public_key_base64: incoming.public_key_base64`). The transform would
      // call every one of those a divergence, and none of them is a mapping into a contract.
      if (/_/.test(key)) continue;
      const hits = [...value.matchAll(COLUMN_ACCESS)]
        .map((m) => ({ receiver: m[1] ?? "", column: m[2] ?? m[3] ?? "" }))
        .filter((h) => {
          // Where the receiver's row type is declared, its field list is authoritative and no
          // marker is guessed at. Where it is not, the `snake_case` spelling is the only signal,
          // and it must also be a catalogued column — measured, every non-column `snake_case`
          // property in the workspace (an Anthropic `stop_reason`, a `pg_catalog` `rls_enabled`)
          // is absent from the catalog, so there is no collision to resolve.
          const type = annotations
            .filter((a) => a.offset < offset && a.receiver === h.receiver)
            .pop()?.type;
          const shape =
            type === undefined
              ? undefined
              : (byFileAndName.get(`${source.file}::${type}`) ?? uniqueByName.get(type));
          if (shape !== undefined) {
            // A `pg_catalog` row resolves to no catalogued table, so none of its fields has a
            // column to be compared with — `check_expr`, `policy_name`, `using_expr`. Reading them
            // is not a divergence and declaring them would be a declaration about nothing.
            if (shape.table === null) return false;
            return new Set(shape.fields).has(h.column);
          }
          return looksLikeColumn(h.column) && catalogued.has(h.column);
        });
      if (hits.length === 0) continue;
      const columns = [...new Set(hits.map((h) => h.column))];
      const receiver = hits[0]?.receiver ?? "";
      const annotated = annotations.filter((a) => a.offset < offset && a.receiver === receiver).pop();
      const generic = generics.filter((g) => g.offset < offset).pop();
      const base = {
        file: source.file,
        line: lineAt(offset),
        field: key,
        receiver,
        // The annotation wins because it names the receiver; the generic is the fallback, and it
        // only ever resolves a *table* for a read already admitted on the `snake_case` evidence —
        // so a mis-attribution can mis-resolve a table and cannot invent a read. The filter above
        // deliberately does not consult it for that same reason: a field list applied to the
        // wrong receiver would admit one.
        rowType: annotated?.type ?? generic?.type ?? null,
        literal,
      };
      if (columns.length !== 1) {
        derived.push({ ...base, columns });
        continue;
      }
      reads.push(RecordReadSchema.parse({ ...base, column: columns[0] ?? "" }));
    }
  }
  return { reads, derived };
}

/* -------------------------------------------------------------- the vocabulary */

/**
 * Why a record field's name and the column it reads differ, where no derivation explains it.
 *
 * Settled from the adjudications, as ADR-0355's write-path kinds were: every divergence was read
 * against the mapper, the row interface, the `SELECT` that fills it and the contract field, with
 * the convention named in the reader's own words, and these are what those names collapse onto.
 */
export const READ_DIVERGENCE_KINDS = [
  /**
   * A sub-record's field, the column folding the sub-record's name in as a prefix:
   * `kind <- attestation_kind`. Check: the prefix names the sub-record being filled.
   */
  "nested_record",
  /**
   * The inverse of the above, and a different question: a sub-record **re-labels a top-level
   * column** of the row — `attestation.attestedAt <- decided_at`. Check: the sub-record's concept
   * and the column's are the same act, which is not implied by a shared prefix because there is
   * none.
   */
  "record_vocabulary",
  /** The two names denote one fact and one carries a qualifier: `reason <- cancel_reason`. */
  "qualifier_differs",
  /**
   * The field names a **side of a comparison** rather than the datum:
   * `{stored: stored.current_state, projected: …}` in a drift report. Check: the record is a
   * comparison and not a mapping, so there is no column the field could have been named for.
   */
  "names_the_side",
  /**
   * The **field's** name denotes a different fact than the column, deliberately — the mirror of
   * ADR-0355's `column_overloaded`, where the wart was on the column. `ClaimedJob.jobId` is the
   * **run** id. The one kind that admits a name is wrong rather than merely vaguer, so
   * `requiresFieldComment` makes it cost what the write path's equivalent costs.
   */
  "field_overloaded",
  /**
   * Not a naming decision at all: the names differ by a **rule the scan could not apply**, because
   * the receiver's row type is behind a method return type this scan does not follow (ADR-0337
   * measured and refused the compiler-API answer twice). An entry here should be *deleted* if the
   * resolution ever reaches it, which `divergence_overtaken` will say.
   */
  "derivation_unreachable",
] as const;
export type ReadDivergenceKind = (typeof READ_DIVERGENCE_KINDS)[number];

export interface ReadKindRule {
  /** What a reader must check to believe a declaration of this kind. */
  readonly check: string;
  /**
   * Whether the contract field must carry a source comment naming itself.
   *
   * Required for `field_overloaded` alone, and for exactly ADR-0355's reason one side across: that
   * declaration asserts the **field's** name is wrong, and a declaration living only in this
   * directory leaves the interface — where the next person reads — still saying the wrong thing.
   */
  readonly requiresFieldComment: boolean;
}

/** A total map, so a seventh kind cannot land without saying what believing it requires. */
export const READ_KIND_RULES: Readonly<Record<ReadDivergenceKind, ReadKindRule>> = Object.freeze({
  nested_record: {
    check: "the column's prefix names the sub-record the field is being read into",
    requiresFieldComment: false,
  },
  record_vocabulary: {
    check: "the sub-record's concept and the top-level column's are the same act",
    requiresFieldComment: false,
  },
  qualifier_differs: {
    check: "the qualifier one side omits does not change which fact it is",
    requiresFieldComment: false,
  },
  names_the_side: {
    check: "the record is a comparison, so no column could have named the field",
    requiresFieldComment: false,
  },
  field_overloaded: {
    check:
      "nothing reads the field as its name says, and the interface says so where the next reader looks",
    requiresFieldComment: true,
  },
  derivation_unreachable: {
    check: "a derivation would explain it, and the row type is out of the scan's reach",
    requiresFieldComment: false,
  },
});

/**
 * The `//` or `/** … *\/` prose immediately above `readonly <field>:` in each module, by
 * `<file>::<field>`.
 *
 * Read here rather than in the audit because the audit is a pure function over facts
 * (ADR-0307's split), and read from the **unstripped** source because the prose is the point.
 */
export function collectFieldComments(
  sources: readonly WorkspaceSourceFile[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const s of sources) {
    const lines = s.text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const declares = /^\s*readonly\s+([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(lines[i] ?? "");
      if (declares === null) continue;
      const prose: string[] = [];
      for (let j = i - 1; j >= 0; j -= 1) {
        const line = (lines[j] ?? "").trim();
        if (line === "{" || line === "*/" || line === "/**") continue;
        // All three spellings, because a one-line `/** … */` is the commonest form in this repo
        // and reading only the multi-line one would make the `field_overloaded` comment
        // requirement satisfiable by a *style* rather than by saying the thing.
        const one = /^\/\*\*?(.*?)\*\/$/.exec(line);
        if (one !== null) {
          prose.unshift((one[1] ?? "").trim());
          continue;
        }
        if (!line.startsWith("//") && !line.startsWith("*")) break;
        prose.unshift(line.replace(/^(?:\/\/|\*)\s?/, ""));
      }
      if (prose.length > 0) out.set(`${s.file}::${declares[1] ?? ""}`, prose.join(" "));
    }
  }
  return out;
}

export const RecordReadDivergenceSchema = z.object({
  /** The module the mapper lives in, which is not always the module holding the `SELECT`. */
  file: z.string().min(1),
  field: z.string().min(1),
  column: z.string().min(1),
  kind: z.enum(READ_DIVERGENCE_KINDS),
  /** The evidence: what was read to decide the field reads the right column. */
  note: z.string().min(40),
});
export type RecordReadDivergence = z.infer<typeof RecordReadDivergenceSchema>;

/**
 * What a row field the catalog has no column of actually is.
 *
 * Declaring one is **not an exemption** — it is what puts the read back under the rule. A
 * `joined_column` names the catalogued column it reaches, so `campaignId <- campaign_natural_id`
 * is checked against `access_review_campaigns.campaign_id` and *agrees*; without the declaration
 * the rule simply goes quiet, which is the one place a mis-mapping would be least visible.
 */
export const RowFieldAliasSchema = z.object({
  /** The alias as the row interface and the `SELECT` spell it. */
  alias: z.string().min(1),
  provenance: z.enum(["joined_column", "parameter_echo"]),
  /** `<table>.<column>` for a joined column; `null` for a parameter echo, which is no column. */
  aliases: z.string().min(1).nullable(),
  /** The `SELECT` that introduces it, so the claim is checkable. */
  introducedIn: z.string().min(1),
  note: z.string().min(40),
});
export type RowFieldAlias = z.infer<typeof RowFieldAliasSchema>;

const ACCESS_REVIEWS = "packages/access-reviews-runtime-pg/src/records.ts";
const JOB_CANCEL = "packages/workflow-runtime-pg/src/job-cancellation.ts";

/**
 * Every read-path divergence no derivation explains, with what was read to decide it.
 *
 * Adjudicated the way ADR-0355's write-path list was — each read against the mapper, the row
 * interface, the `SELECT` that fills it (often in a sibling module) and the contract field, with
 * the convention named in the reader's own words. **Nineteen independent convention names came
 * back** and the six kinds above are what they collapse onto.
 */
export const RECORD_READ_DIVERGENCES: readonly RecordReadDivergence[] = Object.freeze([
  /* ------------------------------------------------- nested_record (6) */
  {
    file: ACCESS_REVIEWS,
    field: "reviewerUserId",
    column: "current_reviewer_user_id",
    kind: "nested_record",
    note:
      "`rowToItem` rebuilds `currentReviewer` as a nullable `ReviewerAssignmentState`, so the " +
      "`current_reviewer_` prefix is the flattening of that sub-record onto the row; the column is " +
      "nullable and the read is `row.current_reviewer_user_id ?? null`, matching. ADR-0355 declared " +
      "the write half of the same pair.",
  },
  {
    file: ACCESS_REVIEWS,
    field: "reviewerKind",
    column: "current_reviewer_kind",
    kind: "nested_record",
    note:
      "The column's CHECK is `REVIEWER_KINDS` verbatim and the field is `z.enum(REVIEWER_KINDS)`; " +
      "`records.ts` types the row field as " +
      '`NonNullable<AccessReviewItem["currentReviewer"]>["reviewerKind"] | null`, so the row and ' +
      "the sub-record field are tied by the type and not only by the name.",
  },
  {
    file: ACCESS_REVIEWS,
    field: "assignedAt",
    column: "reviewer_assigned_at",
    kind: "nested_record",
    note:
      "When the *current reviewer* was assigned, read back into `currentReviewer.assignedAt` " +
      "through `requireIso`, and distinct from this row's `created_at` and `opened_for_review_at`. " +
      "The prefix is `reviewer_` where the two kind columns say `current_reviewer_` — an " +
      "inconsistency inside one flattening, which ADR-0355 recorded from the write side.",
  },
  {
    file: ACCESS_REVIEWS,
    field: "kind",
    column: "attestation_kind",
    kind: "nested_record",
    note:
      "The sharpest one, and the only sibling collision on the read path: the same mapper also " +
      "reads the top-level `kind` column into `decision.kind`, so `kind` is filled twice in one " +
      "function from two columns of the same declared type. It is not transposed — `rowToDecision` " +
      "reads `row.kind` into the record's own `kind` and `row.attestation_kind` into " +
      "`attestation.kind`, the two CHECK value sets are **disjoint** (`DECISION_KINDS` against " +
      "`ATTESTATION_KINDS`), so a swap would be refused `23514` by every insert that round-tripped " +
      "it.",
  },
  {
    file: ACCESS_REVIEWS,
    field: "signatureSha256",
    column: "attestation_signature_sha256",
    kind: "nested_record",
    note:
      "`CHAR(64)` with `IS NULL OR ~ '^[0-9a-f]{64}$'` read into " +
      "`attestation.signatureSha256`, whose zod field is the same predicate including the NULL " +
      "arm. Its neighbour `attestation_signing_key_fingerprint` is the identical type and CHECK, so " +
      "a swap is invisible to the database — the evidence is that `rowToDecision` reads each into " +
      "its own field and the writer binds each from its own, checked in both directions.",
  },
  {
    file: ACCESS_REVIEWS,
    field: "signingKeyFingerprint",
    column: "attestation_signing_key_fingerprint",
    kind: "nested_record",
    note:
      "The other half of that pair, with the same `CHAR(64)` CHECK and the same argument: nothing " +
      "but the name separates it from `attestation_signature_sha256`, and the round trip closes " +
      "because ADR-0355's write-path declaration names the same two columns the same way.",
  },

  /* ---------------------------------------------- record_vocabulary (2) */
  {
    file: ACCESS_REVIEWS,
    field: "attestedByUserId",
    column: "decided_by_user_id",
    kind: "record_vocabulary",
    note:
      "The `attestation` sub-record re-labels the row's own top-level column: there is no " +
      "`attestation_decided_by` column, and the decision's decider *is* the attester, which the " +
      "contract fixes by requiring `attestation` exactly when `attestationKind` is set. So the " +
      "sub-record borrows the row's actor column rather than carrying its own — and " +
      "`AccessReviewDecisionSchema.superRefine` *enforces* `decidedByUserId === " +
      "attestation.attestedByUserId`, so this derivation is recoverable from the contract.",
  },
  {
    file: ACCESS_REVIEWS,
    field: "attestedAt",
    column: "decided_at",
    kind: "record_vocabulary",
    note:
      "The same borrowing one field across and the weaker of the two: there is no " +
      "`attestation_attested_at` column — the attestation columns are `attestation_kind`, " +
      "`_signature_sha256`, `_signing_key_fingerprint`, `co_attesting_user_id` and " +
      "`co_attested_at` — so `decided_at` is the only source the row carries, and the writer binds " +
      "neither `att.attestedAt` nor `att.attestationPhrase` (23 columns, 23 params, both absent). " +
      "What makes it weaker than its neighbour is that nothing *enforces* the equality: the " +
      "contract constrains `timeBoundExtendUntil` and `appliedAt` against `decidedAt` and says " +
      "nothing about `attestedAt`, so this rests on producer behaviour — `buildRevokeDecision` " +
      "sets both from one `nowIso`, and every construction site in the workspace does the same. " +
      "The gap is therefore in `decision-store.ts` (an unbound field with no column) and " +
      "`decisions.ts` (a missing refinement) rather than in this read, which is the only read " +
      "available. See *What's actually left*.",
  },

  /* --------------------------------------------- qualifier_differs (5) */
  {
    file: JOB_CANCEL,
    field: "requestedAt",
    column: "cancel_requested_at",
    kind: "qualifier_differs",
    note:
      "The enclosing record *is* the cancellation (`{requestedAt, requestedBy, reason}` on a " +
      "`JobCancellationRecord`), so the field drops the `cancel_` qualifier the column needs to " +
      "distinguish it from `started_at` and `completed_at` on the same row. The column is " +
      "ADR-0315's \"the cancellation is the column\" and the claim predicate excludes on it.",
  },
  {
    file: JOB_CANCEL,
    field: "requestedBy",
    column: "cancel_requested_by",
    kind: "qualifier_differs",
    note:
      "The same flattening one field across, and the column is deliberately TEXT rather than a " +
      "`meta.users` reference because a scheduler cancelling a run is not a user (ADR-0334's rule " +
      "about an actor column recording a past act).",
  },
  {
    file: JOB_CANCEL,
    field: "reason",
    column: "cancel_reason",
    kind: "qualifier_differs",
    note:
      "The third field of the same record, and the one place the qualifier matters most: " +
      "`meta.job_runs` also carries an `error` JSONB, so a bare `reason` column would have been " +
      "ambiguous on the table while it is unambiguous on a record that is only about cancelling.",
  },
  {
    file: "packages/workflow-runtime-pg/src/job-claim.ts",
    field: "jobDefinitionId",
    column: "job_id",
    kind: "qualifier_differs",
    note:
      "`meta.job_runs.job_id` holds the `JobDeclaration.id` — the job *definition's* id, which is " +
      "what the field name spells out — and `job-claim.ts` filters `job_id = ANY($n::text[])` " +
      "against declaration ids. The field is the more explicit one precisely because `ClaimedJob` " +
      "also carries `jobId`, which is the **run** id; see that declaration.",
  },
  {
    file: "packages/workflow-runtime-pg/src/job-engine.ts",
    field: "input",
    column: "input_redacted",
    kind: "qualifier_differs",
    note:
      "The `_redacted` qualifier is a fact about how the column is *stored* — the producer redacts " +
      "before writing — and not a different datum, so the contract field the handler receives is " +
      "the input it is to run on. The sibling `output_redacted` is read into `output` by the same " +
      "rule, and that pair agrees under the transform while this one does not only because the " +
      "field is singular.",
  },

  /* ------------------------------------------------- names_the_side (4) */
  {
    file: "packages/workflow-runtime-pg/src/replayer.ts",
    field: "stored",
    column: "current_state",
    kind: "names_the_side",
    note:
      "A drift finding, not a record: `{field: 'currentState', stored: stored.current_state, " +
      "projected: projection.currentState}`. The field names which **side** of the comparison the " +
      "value is from, and the column it is named for is carried in the sibling `field` entry, so " +
      "there is nothing for the transform to agree with.",
  },
  {
    file: "packages/workflow-runtime-pg/src/replayer.ts",
    field: "stored",
    column: "sequence_cursor",
    kind: "names_the_side",
    note:
      "The same comparison shape over the instance's cursor, and the only numeric column in that " +
      "projection — so even a transposition within the drift report would have to be with a " +
      "differently typed value.",
  },
  {
    file: "packages/workflow-runtime-pg/src/replayer.ts",
    field: "stored",
    column: "status",
    kind: "names_the_side",
    note:
      "The same shape again, and visible to this rule only because the read scan now accepts a " +
      "single-word column off a declared row — 597 of the catalog's 2,399 columns are single-word, " +
      "so an underscore-only marker never saw this family at all.",
  },
  {
    file: "packages/workflow-runtime-pg/src/replayer.ts",
    field: "stored",
    column: "variables",
    kind: "names_the_side",
    note:
      "The same shape over the instance's `variables` JSONB, which ADR-0337 found the workflow " +
      "replayer comparing with `!==` against a parsed value — the drift report's two sides are " +
      "exactly what that defect was about, which is why `stored` names a side here.",
  },

  /* --------------------------------------- derivation_unreachable (2) */
  {
    file: "packages/workflow-runtime-pg/src/replayer.ts",
    field: "id",
    column: "signal_id",
    kind: "derivation_unreachable",
    note:
      "This *is* the `business_key` derivation — `meta.workflow_signals.signal_id` is a " +
      "single-column UNIQUE referencing nothing — and the scan cannot apply it because the " +
      "receiver comes from `storedSignals.map((s) => …)` where `storedSignals` is the awaited " +
      "result of `fetchSignalRows`, so the row type is behind a method return type. Delete this " +
      "entry if the resolution ever follows one.",
  },
  {
    file: "packages/workflow-runtime-pg/src/replayer.ts",
    field: "id",
    column: "timer_id",
    kind: "derivation_unreachable",
    note:
      "The same shape over `meta.workflow_timers.timer_id`, read from " +
      "`storedTimers.map((t) => …)` behind `fetchTimerRows`. Both would derive the moment the row " +
      "type resolved, which is why neither is recorded as a naming decision.",
  },

  /* ------------------------------------------------ field_overloaded (1) */
  {
    file: "packages/workflow-runtime-pg/src/job-claim.ts",
    field: "jobId",
    column: "run_id",
    kind: "field_overloaded",
    note:
      "The member that prompted this rule, and the only one where the **field's** name is the " +
      "wart. `RETURNING j.run_id, j.tenant_id, j.job_id, …` carries no `AS`, so every `ClaimRow` " +
      "property is its column name and `jobId: str(r.run_id)` is unambiguous. It is **not** the " +
      "transposition signature by this rule's own criterion — `run_id` is UUID and `job_id` is " +
      "TEXT, so the declared types separate them and a swap would be refused `22P02` — and " +
      "`job_id` is read into `jobDefinitionId` on the next line. What makes it a divergence rather " +
      "than a defect is that the round trip closes on the **value** and not on the name: every " +
      "consumer uses it as a run id (`executeJobRun` and `renewJobClaim`/`releaseJobClaim` filter " +
      "`WHERE run_id = $1`, `observeJobCancellation` takes `{runId: jobId}`), the engine never " +
      "trusts the handle for the definition id (`executeJobRun` re-reads `job_id` from the row " +
      "it just locked), and `ClaimedJob.jobDefinitionId` has **no consumer at all** — so the " +
      "field that could have been swapped is dead and no site reads both. The asymmetry is " +
      "across the two paths: `EnqueuedJobRun.jobId` binds `job_id` while this reads `run_id`, one " +
      "property name meaning two columns in one package, and `ClaimedJob` is the sole holdout " +
      "against its own package's settled vocabulary (`reapCancelledJobRuns` reads the same column " +
      "from a near-identical CTE as `runId`; `executeJobRun(runId)`, `ExecuteJobRunResult.runId` " +
      "and the handler context all agree). Both interfaces declaring it now say so.",
  },
]);

/**
 * Every row field the catalog has no column of, with what it actually is.
 *
 * Declaring one **puts the read under the rule** rather than taking it out: with
 * `campaign_natural_id` declared as `access_review_campaigns.campaign_id`, the read
 * `campaignId <- campaign_natural_id` is compared against `campaignId` and agrees.
 */
export const ROW_FIELD_ALIASES: readonly RowFieldAlias[] = Object.freeze([
  {
    alias: "campaign_natural_id",
    provenance: "joined_column",
    aliases: "access_review_campaigns.campaign_id",
    introducedIn: "packages/access-reviews-runtime-pg/src/item-store.ts",
    note:
      "`c.campaign_id AS campaign_natural_id` in both `item-store.ts` and `decision-store.ts`: " +
      "the row's own `campaign_id` column is the parent's UUID *surrogate*, so the join reaches " +
      "the parent's business key and the alias exists to keep the two apart in one row. Once " +
      "declared, the read agrees under the transform.",
  },
  {
    alias: "item_natural_id",
    provenance: "joined_column",
    aliases: "access_review_items.item_id",
    introducedIn: "packages/access-reviews-runtime-pg/src/decision-store.ts",
    note:
      "`i.item_id AS item_natural_id` in `SELECT_JOINED`, for the same reason: " +
      "`access_review_decisions.item_id` is the UUID surrogate and the contract's `itemId` is the " +
      "`ari_…` business key, so the alias is what lets one row carry both.",
  },
  {
    alias: "instance_text_id",
    provenance: "parameter_echo",
    aliases: null,
    introducedIn: "packages/workflow-runtime-pg/src/event-log.ts",
    note:
      "`$1::TEXT AS instance_text_id` — the caller's own `instanceId` argument handed back through " +
      "the SELECT, and never a column. `meta.workflow_events.instance_id` stores the instance's " +
      "UUID surrogate, so the text id the contract wants is not on the row at all; echoing the " +
      "parameter is how the mapper fills a field the row cannot supply. There is no column to " +
      "compare the name against, which is why this provenance exists separately from a join alias.",
  },
]);

/* ------------------------------------------------------------------ findings */

/**
 * What the audit can find.
 *
 * `reversed_pair` and `field_reads_sibling_column` are first for ADR-0355's reason — they are the
 * transposition signature, read on the other side — and `alias_undeclared` is third because an
 * undeclared alias is the rule *failing to ask*, which is worse than a divergence it asks about
 * and is told the answer to.
 */
export const RECORD_READ_FINDING_KINDS = [
  "reversed_pair",
  "field_reads_sibling_column",
  "alias_undeclared",
  "field_overload_uncommented",
  "row_type_unknown",
  "row_table_ambiguous",
  "derivation_ambiguous",
  "undeclared_read_divergence",
  "divergence_overtaken",
  "divergence_duplicate",
  "alias_overtaken",
] as const;
export type RecordReadFindingKind = (typeof RECORD_READ_FINDING_KINDS)[number];

export const RecordReadFindingSchema = z.object({
  kind: z.enum(RECORD_READ_FINDING_KINDS),
  file: z.string().min(1),
  field: z.string().min(1),
  detail: z.string().min(1),
});
export type RecordReadFinding = z.infer<typeof RecordReadFindingSchema>;

export interface RecordReadAuditInput {
  readonly catalog: readonly CatalogTable[];
  readonly reads: readonly RecordRead[];
  readonly rowShapes: readonly RowShape[];
  readonly divergences?: readonly RecordReadDivergence[];
  readonly aliases?: readonly RowFieldAlias[];
  /** `collectFieldComments`' output, for the one kind that requires one. */
  readonly fieldComments?: ReadonlyMap<string, string>;
}

export interface RecordReadSummary {
  /** Reads whose field name and column name agree under the one transform. */
  readonly agreeing: number;
  /** Reads a derivation explains, by derivation. */
  readonly derived: Readonly<Record<NameDerivation, number>>;
  /** Reads a declaration explains. */
  readonly declared: number;
  /** Reads of a `parameter_echo`, which has no column to be compared with. */
  readonly aliased: number;
  /** Reads whose receiver resolved to a catalogued table, so a derivation was available. */
  readonly tableResolved: number;
  readonly total: number;
}

function divergenceKey(d: { field: string; column: string }): string {
  return `${d.field}<-${d.column}`;
}

/**
 * The catalogued column a read is really of, following a declared alias.
 *
 * `null` means the read has no column to be compared with: a `parameter_echo` was never in the
 * database. Declaring an alias is therefore **not an exemption** — `campaignId <-
 * campaign_natural_id` resolves to `access_review_campaigns.campaign_id`, whose camel form *is*
 * `campaignId`, so the declaration moves the read into the checked set and it agrees.
 */
export function effectiveColumn(
  column: string,
  aliases: readonly RowFieldAlias[],
): string | null {
  const alias = aliases.find((a) => a.alias === column);
  if (alias === undefined) return column;
  if (alias.provenance === "parameter_echo") return null;
  return alias.aliases?.split(".").pop() ?? null;
}

/** The table a read's receiver resolves to, or `null`. */
export function tableForRead(
  read: RecordRead,
  rowShapes: readonly RowShape[],
  catalog: readonly CatalogTable[],
): CatalogTable | null {
  if (read.rowType === null) return null;
  // Same file first, then a bare name **only if it is unique**: four stores call their interface
  // `Row`, so an unconditional name fallback would hand a read another table's columns and the
  // derivations would then be answered against the wrong row.
  const sameFile = rowShapes.find((s) => s.name === read.rowType && s.file === read.file);
  const byName = rowShapes.filter((s) => s.name === read.rowType);
  const shape = sameFile ?? (byName.length === 1 ? byName[0] : undefined);
  if (shape?.table == null) return null;
  return catalog.find((t) => t.name === shape.table) ?? null;
}

export function auditRecordReads(input: RecordReadAuditInput): readonly RecordReadFinding[] {
  const findings: RecordReadFinding[] = [];
  const declared = input.divergences ?? [];
  const aliases = input.aliases ?? [];
  const byKey = new Map<string, RecordReadDivergence>();

  for (const d of declared) {
    const key = divergenceKey(d);
    if (byKey.has(key)) {
      findings.push(
        RecordReadFindingSchema.parse({
          kind: "divergence_duplicate",
          file: d.file,
          field: d.field,
          detail: `RECORD_READ_DIVERGENCES declares \`${key}\` twice`,
        }),
      );
      continue;
    }
    byKey.set(key, d);
    if (!READ_KIND_RULES[d.kind].requiresFieldComment) continue;
    const comment = input.fieldComments?.get(`${d.file}::${d.field}`) ?? "";
    if (comment.includes(d.field)) continue;
    findings.push(
      RecordReadFindingSchema.parse({
        kind: "field_overload_uncommented",
        file: d.file,
        field: d.field,
        detail:
          `RECORD_READ_DIVERGENCES declares \`${d.field}\` as \`${d.kind}\` — that the field's ` +
          `name denotes a different fact than the column — and the interface declaring it carries ` +
          `no comment naming it. ${READ_KIND_RULES[d.kind].check}.`,
      }),
    );
  }

  /* An alias the catalog has no column of, with nothing saying what it is. */
  const aliasByName = new Map(aliases.map((a) => [a.alias, a]));
  const seenAlias = new Set<string>();
  for (const shape of input.rowShapes) {
    // An introspection row's fields are `pg_catalog`'s own and there is no catalogued column to
    // name, so the whole row is the census line rather than each of its fields.
    if (shape.table === null) continue;
    for (const field of shape.foreign) {
      seenAlias.add(field);
      if (aliasByName.has(field)) continue;
      findings.push(
        RecordReadFindingSchema.parse({
          kind: "alias_undeclared",
          file: shape.file,
          field,
          detail:
            `${shape.file} declares \`${shape.name}.${field}\` and the catalog has no column of ` +
            `that name, so this read is checked against nothing. Declare it in ROW_FIELD_ALIASES ` +
            `with the \`<table>.<column>\` it reaches, or as a \`parameter_echo\` if the SELECT ` +
            `hands back one of its own arguments.`,
        }),
      );
    }
  }
  for (const a of aliases) {
    if (seenAlias.has(a.alias)) continue;
    findings.push(
      RecordReadFindingSchema.parse({
        kind: "alias_overtaken",
        file: a.introducedIn,
        field: a.alias,
        detail: `ROW_FIELD_ALIASES declares \`${a.alias}\` and no row interface carries it any more; delete the declaration`,
      }),
    );
  }

  /* A read annotated with a row type no shape was found for: the resolution answered `null` and
     no derivation was available, which must be said rather than inherited as a declaration. */
  const shapeNames = new Set(input.rowShapes.map((s) => s.name));
  const unknownTypes = new Set<string>();
  for (const read of input.reads) {
    if (read.rowType === null || shapeNames.has(read.rowType)) continue;
    // Only where it costs something. A row whose every read agrees needed no table, and firing
    // there reports two rows with two `snake_case` fields each — under the containment floor, and
    // correctly so, since a one-field row matches dozens of tables.
    if (read.field === camelOfColumn(read.column)) continue;
    if (unknownTypes.has(read.rowType)) continue;
    unknownTypes.add(read.rowType);
    findings.push(
      RecordReadFindingSchema.parse({
        kind: "row_type_unknown",
        file: read.file,
        field: read.rowType,
        detail:
          `${read.file} annotates a read with \`${read.rowType}\`, which \`resolveRowShapes\` ` +
          `found no declaration for — so every read off it resolves to no table and silently ` +
          `loses the derivations. The interface scan is not seeing it.`,
      }),
    );
  }

  /* A row interface that should resolve and does not. */
  const anyColumn = new Set(input.catalog.flatMap((t) => t.columns.map((c) => c.name)));
  for (const shape of input.rowShapes) {
    if (shape.table !== null) continue;
    if (shape.fields.filter((f) => anyColumn.has(f)).length < 3) continue;
    findings.push(
      RecordReadFindingSchema.parse({
        kind: "row_table_ambiguous",
        file: shape.file,
        field: shape.name,
        detail:
          `\`${shape.name}\` carries ${shape.fields.length.toString()} columns and no single ` +
          `catalogued table contains all of them, so no read off it can reach a derivation. ` +
          `Either a column is missing from the catalog or a field is an undeclared alias.`,
      }),
    );
  }

  /* The reversed pair: two fields of ONE object literal each reading the other's column. */
  const byLiteral = new Map<string, RecordRead[]>();
  for (const read of input.reads) {
    const key = `${read.file}:${read.literal.toString()}`;
    byLiteral.set(key, [...(byLiteral.get(key) ?? []), read]);
  }
  const reported = new Set<string>();
  for (const [, group] of byLiteral) {
    for (const a of group) {
      for (const b of group) {
        if (a === b) continue;
        if (camelOfColumn(a.column) !== b.field || camelOfColumn(b.column) !== a.field) continue;
        const key = [a.field, b.field].sort().join("<->");
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push(
          RecordReadFindingSchema.parse({
            kind: "reversed_pair",
            file: a.file,
            field: a.field,
            detail:
              `${a.file}:${a.line.toString()} reads \`${a.column}\` into \`${a.field}\` and ` +
              `\`${b.column}\` into \`${b.field}\` in one record — each field is filled from the ` +
              `other's column. No declaration can excuse it.`,
          }),
        );
      }
    }
  }

  const matched = new Set<string>();
  for (const read of input.reads) {
    const effective = effectiveColumn(read.column, aliases);
    if (effective === null) continue;
    if (read.field === camelOfColumn(effective)) continue;
    const table = tableForRead(read, input.rowShapes, input.catalog);
    const column = table?.columns.find((c) => c.name === read.column);

    if (table !== null && column !== undefined) {
      const derivation = NAME_DERIVATIONS.find((n) =>
        DERIVATION_RULES[n].admits(column, read.field, table),
      );
      if (derivation !== undefined) {
        const targets = table.columns.filter((c) =>
          DERIVATION_RULES[derivation].admits(c, read.field, table),
        );
        if (targets.length > 1) {
          findings.push(
            RecordReadFindingSchema.parse({
              kind: "derivation_ambiguous",
              file: read.file,
              field: read.field,
              detail:
                `the \`${derivation}\` derivation admits \`${read.field}\` from ` +
                `${targets.length.toString()} columns of meta.${table.name} ` +
                `(${targets.map((c) => c.name).join(", ")}), so it no longer says which; its ` +
                `tightness claim is: ${DERIVATION_RULES[derivation].tightness}`,
            }),
          );
        }
        continue;
      }
    }

    const key = divergenceKey(read);
    matched.add(key);
    const sibling =
      table?.columns.find((c) => c.name === columnOfCamel(read.field) && c.name !== read.column) ??
      undefined;
    if (sibling !== undefined && column !== undefined && sibling.type === column.type) {
      const declaration = byKey.get(key);
      if (declaration === undefined) {
        findings.push(
          RecordReadFindingSchema.parse({
            kind: "field_reads_sibling_column",
            file: read.file,
            field: read.field,
            detail:
              `${read.file}:${read.line.toString()} reads \`${read.column}\` into \`${read.field}\`, ` +
              `and meta.${table?.name ?? "?"} declares a column \`${sibling.name}\` of the same ` +
              `type (${column.type ?? "?"}) — the transposition signature, read from the other ` +
              `side. Declare it with its evidence if the two really are different facts.`,
          }),
        );
      } else if (!declaration.note.includes(sibling.name)) {
        findings.push(
          RecordReadFindingSchema.parse({
            kind: "field_reads_sibling_column",
            file: read.file,
            field: read.field,
            detail:
              `the declaration for \`${key}\` never names \`${sibling.name}\` — the column of the ` +
              `same type the value could have come from. Say why it did not.`,
          }),
        );
      }
      continue;
    }

    if (byKey.has(key)) continue;
    findings.push(
      RecordReadFindingSchema.parse({
        kind: "undeclared_read_divergence",
        file: read.file,
        field: read.field,
        detail:
          `${read.file}:${read.line.toString()} reads \`${read.receiver}.${read.column}\` into ` +
          `\`${read.field}\`, whose name reads \`${camelOfColumn(read.column)}\`` +
          `${read.rowType === null ? " (no row interface in scope, so no derivation was available)" : ""}; ` +
          `declare it in RECORD_READ_DIVERGENCES with what you read to decide it reads the right column`,
      }),
    );
  }

  for (const d of declared) {
    if (matched.has(divergenceKey(d))) continue;
    findings.push(
      RecordReadFindingSchema.parse({
        kind: "divergence_overtaken",
        file: d.file,
        field: d.field,
        detail: `RECORD_READ_DIVERGENCES declares \`${divergenceKey(d)}\` and no read diverges that way any more; delete the declaration`,
      }),
    );
  }

  const order = new Map(RECORD_READ_FINDING_KINDS.map((k, i) => [k, i]));
  return [...findings].sort(
    (a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) || a.file.localeCompare(b.file),
  );
}

export function summarizeRecordReads(input: RecordReadAuditInput): RecordReadSummary {
  const derived: Record<NameDerivation, number> = { business_key: 0, resolved_surrogate: 0 };
  const keys = new Set((input.divergences ?? []).map((d) => divergenceKey(d)));
  let agreeing = 0;
  let declaredCount = 0;
  let tableResolved = 0;
  let aliased = 0;

  const aliases = input.aliases ?? [];
  for (const read of input.reads) {
    const table = tableForRead(read, input.rowShapes, input.catalog);
    if (table !== null) tableResolved += 1;
    const effective = effectiveColumn(read.column, aliases);
    if (effective === null) {
      aliased += 1;
      continue;
    }
    if (read.field === camelOfColumn(effective)) {
      agreeing += 1;
      continue;
    }
    const column = table?.columns.find((c) => c.name === read.column);
    const derivation =
      table !== null && column !== undefined
        ? NAME_DERIVATIONS.find((n) => DERIVATION_RULES[n].admits(column, read.field, table))
        : undefined;
    if (derivation !== undefined) {
      derived[derivation] += 1;
      continue;
    }
    if (keys.has(divergenceKey(read))) declaredCount += 1;
  }

  return {
    agreeing,
    derived,
    declared: declaredCount,
    aliased,
    tableResolved,
    total: input.reads.length,
  };
}

export function formatRecordReadFindings(findings: readonly RecordReadFinding[]): string {
  return findings.map((f) => `${f.kind}: ${f.file} ${f.field} — ${f.detail}`).join("\n");
}
