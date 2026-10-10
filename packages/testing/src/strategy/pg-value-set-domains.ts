import { z } from "zod";

import {
  literalBody,
  matchBracket,
  splitTopLevel,
  stripComments,
  type CatalogTable,
} from "./pg-column-coverage.js";
import type { WorkspaceSourceFile } from "./workspace-sql-scan.js";

/**
 * The **upstream** half of ADR-0352's question, and the half that ships in the artifact.
 *
 * `check-admission.ts` asks whether a *live database* admits the values the catalog declares. That is
 * a property of a deployment: a value the catalog has added since the database was migrated is
 * refused `23514` until an operator runs one `ALTER`, which is the state ADR-0334 and ADR-0351 each
 * landed in and each had found by hand. This file asks the question one step earlier —
 * whether the catalog's CHECK admits every value the **contract** can emit — and that is a property
 * of the artifact alone, decidable from text with no database anywhere, so it belongs in a test
 * rather than at boot.
 *
 * The two halves are not symmetric and the asymmetry is the point. Downstream, the catalog is right
 * and the database is behind. Upstream, a disagreement means the artifact itself cannot persist its
 * own records, and no migration fixes it.
 *
 * ## Why the link is declared and not derived
 *
 * Nothing in the text joins a contract enum to a catalogued column. The store's SQL names the column
 * and binds a parameter; which record field supplies that parameter is not visible to a scan. Two
 * derivations were built and measured against the real workspace, and both are refused:
 *
 *  - **"no workspace domain may strictly exceed a CHECK's value set"** — 23 pairs over 15 columns, of
 *    which 0 were defects. `meta.plans.billing_interval` is `['month','year']`, which is a strict
 *    subset of `@crossengin/reporting`'s `TIMESERIES_BUCKETS`; `meta.api_keys.status` is a strict
 *    subset of `SSO_SESSION_STATUSES`; `MAC_ALGORITHMS ⊂ KEY_ALGORITHMS` by spread construction.
 *    Declaring 23 coincidences as exemptions is what the fourth meta-schema invariant refused for
 *    the cross-column type rule — it "would train people to add exemptions".
 *  - **"a schema field whose name matches the column"** — 4,938 pairs over 180 columns, because
 *    `status` is a field on 51 schemas and a column on 40 tables.
 *
 * And exact set equality, which looks like it needs no declaration at all, is **unsound rather than
 * merely imprecise** — demonstrated on a real column. `meta.deployments.environment`'s CHECK was
 * `('preview','staging','production','sandbox')`, which exactly equals `@crossengin/feature-flags`'
 * own environment enum and so read as accounted for, while the only record that table stores —
 * `DeploymentRecordSchema` — emits `@crossengin/deploy`'s `ENVIRONMENTS`, which is
 * `('local','preview','staging','production')`. A vacuous pass on a genuinely drifted column.
 *
 * So the link is a declaration, and what makes a declaration acceptable here is the rule this repo
 * arrived at in ADR-0334: *location was never what made `needsAuditEmitter` wrong — the absence of a
 * both-ways comparison was.* Every catalogued value-set CHECK must be declared, and every
 * declaration must name a column that has one.
 *
 * ## What the declaration buys
 *
 * `mirrors` asserts **equality**, in both directions. That is what the four `meta.deployments`
 * columns needed: their drift was neither a subset nor a superset of the contract in any of the four
 * (`target` was *entirely disjoint* — ten values against ten with no overlap), so every nesting test
 * was structurally blind to it, and the kernel test that stood over `target` asserted three values no
 * `DeployTarget` has ever had, comparing the catalog with itself.
 */

/* ------------------------------------------------------------------ catalog */

/**
 * A catalogued column CHECK that enumerates its domain.
 *
 * `shape` separates the two spellings for the same reason `check-admission.ts` reads both: `col =
 * 'x'` is a value set of one, and the day its contract gains a second member the catalog widens to
 * an `IN` list. Treating it as something else would exempt the single-member case from the rule at
 * exactly the moment it stops being single.
 */
export const VALUE_SET_SHAPES = ["in_list", "equality"] as const;
export type ValueSetShape = (typeof VALUE_SET_SHAPES)[number];

export const CatalogValueSetSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  shape: z.enum(VALUE_SET_SHAPES),
  values: z.array(z.string()).min(1),
  /** The `default` expression, SQL text, so a string literal still carries its quotes. */
  defaultExpression: z.string().nullable(),
});
export type CatalogValueSet = z.infer<typeof CatalogValueSetSchema>;

/**
 * `col IN ('a', 'b')`, optionally prefixed by the `col IS NULL OR` that 29 catalogued checks carry.
 *
 * The prefix is redundant as a constraint — a CHECK passes when its expression is NULL — and is read
 * here rather than rejected because the values after it are the domain either way.
 */
const IN_LIST_RE =
  /^\s*(?:\(?\s*([A-Za-z_][\w]*)\s*\)?(?:::[a-z ]+)?\s+IS\s+NULL\s+OR\s+)?\(?\s*([A-Za-z_][\w]*)\s*\)?(?:::[a-z ]+)?\s+IN\s*\(([^()]*)\)\s*$/i;
const EQUALITY_RE = /^\s*([A-Za-z_][\w]*)\s*=\s*'((?:[^']|'')*)'\s*$/;

/** A SQL string literal's value: the quotes removed and `''` folded back to one apostrophe. */
function sqlLiteral(text: string): string | null {
  const trimmed = text.trim();
  const m = /^'((?:[^']|'')*)'$/.exec(trimmed);
  return m === null ? null : (m[1] ?? "").replace(/''/g, "'");
}

/**
 * Every catalogued column CHECK that enumerates its domain.
 *
 * A check this does not recognise is simply not a value set — a range, a pattern, a cross-column
 * comparison — and is out of scope rather than unresolved: `check-admission.ts`'s
 * `CHECK_SHAPE_COVERAGE` is what accounts for those, and duplicating that taxonomy here would give
 * two answers to one question.
 */
export function catalogValueSets(tables: readonly CatalogTable[]): readonly CatalogValueSet[] {
  const out: CatalogValueSet[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      const expression = column.check;
      if (expression === null) continue;
      const inList = IN_LIST_RE.exec(expression);
      if (
        inList !== null &&
        inList[2] === column.name &&
        (inList[1] === undefined || inList[1] === column.name)
      ) {
        const values = splitTopLevel(inList[3] ?? "").map(sqlLiteral);
        if (values.length > 0 && values.every((v): v is string => v !== null)) {
          out.push({
            table: table.name,
            column: column.name,
            shape: "in_list",
            values,
            defaultExpression: column.defaultExpression,
          });
          continue;
        }
      }
      const equality = EQUALITY_RE.exec(expression);
      if (equality !== null && equality[1] === column.name) {
        out.push({
          table: table.name,
          column: column.name,
          shape: "equality",
          values: [(equality[2] ?? "").replace(/''/g, "'")],
          defaultExpression: column.defaultExpression,
        });
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------- workspace domains */

/**
 * Where a domain is written down.
 *
 * `constant` is `export const X = [...] as const`, the repo's enum idiom. `schema_enum` is an
 * exported `z.enum([…])` bound straight to a name — `DeadLetterReasonSchema` is the repo's one, and
 * it *is* the domain rather than carrying one. `schema_field` is `field: z.enum(…)` inside an
 * exported `*Schema`, which is the authoritative domain wherever the constant is not:
 * `meta.report_runs.engine` is the sharp case, since `REPORT_ENGINES` has three members including
 * `auto` and `ReportRunRecordSchema.engine` has the two the column admits, because `auto` is a
 * *report definition's* engine preference and a run has a resolved engine.
 */
export const DOMAIN_SITE_KINDS = ["constant", "schema_enum", "schema_field"] as const;
export type DomainSiteKind = (typeof DOMAIN_SITE_KINDS)[number];

export const WorkspaceDomainSchema = z.object({
  /** Owning package name, the first half of a ref. */
  package: z.string().min(1),
  /** `NAME` for a constant, `XSchema.field` for a schema field: the second half of a ref. */
  name: z.string().min(1),
  kind: z.enum(DOMAIN_SITE_KINDS),
  file: z.string().min(1),
  line: z.number().int().positive(),
  members: z.array(z.string()).min(1),
  /**
   * The ref of the constant this domain is a *reference* to, where it is one — so
   * `ReportRunRecordSchema.engine` typed `z.enum(REPORT_ENGINES)` carries
   * `@crossengin/reporting:REPORT_ENGINES`, and one typed `z.enum([…])` inline carries `null`
   * because there is nothing else to name.
   *
   * It exists so that the **two legal spellings of one domain compare equal** (ADR-0354): a
   * declaration may ref the constant or the field, and the binding audit derives whichever the
   * writer's own schema happens to use. Resolved through the same four steps as a spread member,
   * and recorded even when the target is *not* exported — a private constant is unnameable as a
   * ref, which is a finding the audit reports rather than a fact to hide here.
   *
   * `null` for a `constant`: a constant is not a reference to anything, it is the thing.
   */
  typedBy: z.string().min(1).nullable().default(null),
});
export type WorkspaceDomain = z.infer<typeof WorkspaceDomainSchema>;

/** A domain whose members this scan could not resolve, reported rather than skipped. */
export const UnresolvedDomainSchema = z.object({
  package: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
  reason: z.string().min(1),
});
export type UnresolvedDomain = z.infer<typeof UnresolvedDomainSchema>;

export interface WorkspaceDomainScan {
  readonly domains: readonly WorkspaceDomain[];
  readonly unresolved: readonly UnresolvedDomain[];
  readonly filesScanned: number;
}

/** 1-based line of `index` in `text`. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/**
 * The text of one statement starting at `from`, ending at the `;` that closes it.
 *
 * Needed because an exported schema's initialiser is a chained expression —
 * `z.object({…}).superRefine(…)` — so its fields cannot be found by bracket-matching one `{`, and
 * reading to the end of the file would attribute the next schema's fields to this one.
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

interface ArrayDeclaration {
  readonly package: string;
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly literals: readonly string[];
  /**
   * Names whose members are spliced in: `[...MAC_ALGORITHMS, ...SIGNATURE_ALGORITHMS]`, and an
   * alias — `export const TENANT_STATUSES = TENANT_LIFECYCLE_STATES` — which is one spread and no
   * literals, so the two need no separate machinery.
   */
  readonly spreads: readonly string[];
  /**
   * Whether the declaration is exported. A module-private constant is a legitimate *resolution*
   * target — `MANIFEST_PROPOSAL_SOURCES` and `operate-runtime`'s `ENTITLEMENT_STATUSES` are both
   * private and both type an exported schema's field — but it is not a nameable **ref**, because a
   * ref names something the package exports. Collecting them for resolution and withholding them
   * from the candidate set is what keeps field resolution total without widening the set of
   * coincidental matches.
   */
  readonly exported: boolean;
  /**
   * Whether this was recorded speculatively from `const X = Y;` rather than from an array literal.
   *
   * The alias branch cannot tell `const TENANT_STATUSES = TENANT_LIFECYCLE_STATES` from
   * `const DATA_KEY_BYTES = AEAD_KEY_BYTES`, because whether `Y` names an array is only known once
   * every file has been read. So an alias whose target does not resolve is **dropped** rather than
   * reported: it was never a domain. A declaration with literals of its own, or more than one
   * spread, is a real array and an unresolvable member there is a genuine gap.
   */
  readonly alias: boolean;
}

/** `import { A, B as C } from "@crossengin/x"` → the package each imported name came from. */
function importSources(code: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(
    /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    const from = m[2] ?? "";
    if (!from.startsWith("@crossengin/")) continue;
    // `@crossengin/kernel/bootstrap` is a subpath export of one package.
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

/**
 * Every domain the workspace declares, with spreads resolved.
 *
 * A name is resolved in four steps — the same file, the same package, the package the file *imports*
 * it from, then a workspace-unique match — and the import step is load-bearing rather than tidy:
 * `DATA_CLASSES` is declared in three packages, so without following the import, every schema field
 * typed `z.enum(DATA_CLASSES)` resolves to nothing and four catalogued columns read as undeclarable.
 * An unresolvable name is reported, never guessed: picking one of three would be a confident wrong
 * answer, which is worse here than no answer.
 */
export function collectWorkspaceDomains(
  sources: readonly WorkspaceSourceFile[],
): WorkspaceDomainScan {
  const stripped = sources.map((s) => ({ ...s, code: stripComments(s.text) }));

  const arrays: ArrayDeclaration[] = [];
  const imports = new Map<string, ReadonlyMap<string, string>>();
  for (const source of stripped) {
    imports.set(source.file, importSources(source.code));
    for (const m of source.code.matchAll(
      /\b(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*/g,
    )) {
      const exported = m[1] !== undefined;
      const rest = source.code.slice(m.index + m[0].length).replace(/^\s*/, "");
      if (!/^(?:Object\.freeze\s*\(\s*)?\[/.test(rest)) {
        // An alias: `const X = Y;` where `Y` turns out to name an array. Recorded as a one-member
        // spread so the resolver handles it with no second code path; a `Y` that is not an array
        // declaration simply fails to resolve, so this costs nothing for every other `const`.
        const alias = /^([A-Za-z_$][\w$]*)\s*(?:as\s+const\s*)?;/.exec(rest);
        if (alias !== null) {
          arrays.push({
            package: source.package,
            file: source.file,
            line: lineOf(source.code, m.index),
            name: m[2] ?? "",
            literals: [],
            spreads: [alias[1] ?? ""],
            exported,
            alias: true,
          });
        }
        continue;
      }
      const open = rest.indexOf("[");
      const end = matchBracket(rest, open);
      if (end < 0) continue;
      // `as const` is what makes an array a *domain* rather than a mutable list, and every enum in
      // the repo carries it. Without the test, `Object.freeze`d lookup tables and default arrays
      // would join the candidate set and make a coincidental match likelier for no gain.
      if (!/^as\s+const/.test(rest.slice(end).replace(/^\s*\)?\s*/, ""))) continue;
      const entries = splitTopLevel(rest.slice(open + 1, end - 1));
      if (entries.length === 0) continue;
      const literals: string[] = [];
      const spreads: string[] = [];
      let readable = true;
      for (const entry of entries) {
        const literal = literalBody(entry);
        if (literal !== null) {
          literals.push(literal);
          continue;
        }
        const spread = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(entry);
        if (spread !== null) {
          spreads.push(spread[1] ?? "");
          continue;
        }
        readable = false;
        break;
      }
      if (!readable) continue;
      arrays.push({
        package: source.package,
        file: source.file,
        line: lineOf(source.code, m.index),
        name: m[2] ?? "",
        literals,
        spreads,
        exported,
        alias: false,
      });
    }
  }

  const byFile = new Map<string, ArrayDeclaration>();
  const byPackage = new Map<string, ArrayDeclaration[]>();
  const byName = new Map<string, ArrayDeclaration[]>();
  /**
   * Names bound twice in one file to different contents — a module-level `const KINDS` and a
   * function-local one, say, which the scan reads without scoping. Keeping whichever came last would
   * be a confident wrong answer, so the name becomes unresolvable and whatever reads it is reported.
   */
  const conflictingInFile = new Set<string>();
  for (const decl of arrays) {
    const key = `${decl.file}::${decl.name}`;
    const prior = byFile.get(key);
    if (
      prior !== undefined &&
      (prior.literals.join("\u0000") !== decl.literals.join("\u0000") ||
        prior.spreads.join("\u0000") !== decl.spreads.join("\u0000"))
    ) {
      conflictingInFile.add(key);
    } else {
      byFile.set(key, decl);
    }
    byPackage.set(`${decl.package}::${decl.name}`, [
      ...(byPackage.get(`${decl.package}::${decl.name}`) ?? []),
      decl,
    ]);
    byName.set(decl.name, [...(byName.get(decl.name) ?? []), decl]);
  }

  const lookup = (name: string, file: string, pkg: string): ArrayDeclaration | undefined => {
    if (conflictingInFile.has(`${file}::${name}`)) return undefined;
    const local = byFile.get(`${file}::${name}`);
    if (local !== undefined) return local;
    const samePackage = byPackage.get(`${pkg}::${name}`) ?? [];
    if (samePackage.length === 1) return samePackage[0];
    const imported = imports.get(file)?.get(name);
    if (imported !== undefined) {
      const fromImport = byPackage.get(`${imported}::${name}`) ?? [];
      if (fromImport.length === 1) return fromImport[0];
    }
    const anywhere = byName.get(name) ?? [];
    return anywhere.length === 1 ? anywhere[0] : undefined;
  };

  const resolve = (decl: ArrayDeclaration, seen: ReadonlySet<string>): string[] | null => {
    const id = `${decl.file}::${decl.name}`;
    if (seen.has(id)) return null;
    if (decl.spreads.length === 0) return [...decl.literals];
    const out: string[] = [];
    for (const spread of decl.spreads) {
      const target = lookup(spread, decl.file, decl.package);
      if (target === undefined) return null;
      const members = resolve(target, new Set([...seen, id]));
      if (members === null) return null;
      out.push(...members);
    }
    out.push(...decl.literals);
    return out;
  };

  const domains: WorkspaceDomain[] = [];
  const unresolved: UnresolvedDomain[] = [];

  for (const decl of arrays) {
    // A module-private declaration is a resolution target only: it is reported through whichever
    // exported schema field names it, so an unresolvable `const x = f()` that the alias branch
    // happened to record is not a finding of its own.
    if (!decl.exported) continue;
    const members = resolve(decl, new Set());
    if ((members === null || members.length === 0) && decl.alias) continue;
    if (members === null || members.length === 0) {
      unresolved.push({
        package: decl.package,
        name: decl.name,
        file: decl.file,
        line: decl.line,
        reason: `spread member(s) ${decl.spreads.join(", ")} could not be resolved`,
      });
      continue;
    }
    // An alias — `export const TENANT_STATUSES = TENANT_LIFECYCLE_STATES` — *is* a reference, so it
    // carries the ref of what it aliases while a constant with members of its own carries `null`.
    // Without that, `operate-server:TENANT_STATUSES` and `tenant-lifecycle:TENANT_LIFECYCLE_STATES`
    // compare unequal and ADR-0334's deliberate re-export reads as a second spelling.
    const aliased =
      decl.alias && decl.spreads.length === 1
        ? lookup(decl.spreads[0] ?? "", decl.file, decl.package)
        : undefined;
    domains.push({
      package: decl.package,
      name: decl.name,
      kind: "constant",
      file: decl.file,
      line: decl.line,
      members,
      typedBy: aliased === undefined ? null : `${aliased.package}:${aliased.name}`,
    });
  }

  /**
   * The members of a `z.enum(…)` whose argument list starts at `after`, and the ref of the constant
   * it names where it names one rather than listing its members inline.
   */
  const enumMembers = (
    after: string,
    file: string,
    pkg: string,
  ): { readonly members: readonly string[] | null; readonly typedBy: string | null } => {
    if (after.startsWith("[")) {
      const end = matchBracket(after, 0);
      if (end <= 0) return { members: null, typedBy: null };
      const values = splitTopLevel(after.slice(1, end - 1)).map((e) => literalBody(e));
      if (values.length === 0 || !values.every((v): v is string => v !== null)) {
        return { members: null, typedBy: null };
      }
      return { members: values, typedBy: null };
    }
    const reference = /^([A-Za-z_$][\w$]*)/.exec(after);
    if (reference === null) return { members: null, typedBy: null };
    const target = lookup(reference[1] ?? "", file, pkg);
    if (target === undefined) return { members: null, typedBy: null };
    return { members: resolve(target, new Set()), typedBy: `${target.package}:${target.name}` };
  };

  for (const source of stripped) {
    // `export const XSchema = z.enum([...])` — the domain bound straight to a name, with no object
    // around it. The field pass below visits the same declaration when the name ends in `Schema`,
    // and finds nothing, because a bare `z.enum(…)` contains no `field: z.enum(` of its own.
    for (const m of source.code.matchAll(
      /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*z\s*\.\s*enum\s*\(\s*/g,
    )) {
      const after = source.code.slice(m.index + m[0].length);
      const { members, typedBy } = enumMembers(after, source.file, source.package);
      const line = lineOf(source.code, m.index);
      if (members === null || members.length === 0) {
        unresolved.push({
          package: source.package,
          name: m[1] ?? "",
          file: source.file,
          line,
          reason: "the enum this name is bound to could not be read",
        });
        continue;
      }
      domains.push({
        package: source.package,
        name: m[1] ?? "",
        kind: "schema_enum",
        file: source.file,
        line,
        members: [...members],
        typedBy,
      });
    }

    for (const m of source.code.matchAll(
      /\bexport\s+const\s+([A-Za-z_$][\w$]*Schema)\s*(?::[^=;]*)?=\s*/g,
    )) {
      const schema = m[1] ?? "";
      const span = statementSpan(source.code, m.index);
      for (const field of span.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*z\s*\.\s*enum\s*\(\s*/g)) {
        const after = span.slice(field.index + field[0].length);
        const line = lineOf(source.code, m.index + field.index);
        const { members, typedBy } = enumMembers(after, source.file, source.package);
        if (members === null || members.length === 0) {
          unresolved.push({
            package: source.package,
            name: `${schema}.${field[1] ?? ""}`,
            file: source.file,
            line,
            reason: "the enum this field is typed with could not be read",
          });
          continue;
        }
        domains.push({
          package: source.package,
          name: `${schema}.${field[1] ?? ""}`,
          kind: "schema_field",
          file: source.file,
          line,
          members: [...members],
          typedBy,
        });
      }
    }
  }

  return { domains, unresolved, filesScanned: sources.length };
}

/* ------------------------------------------------------------- declarations */

/**
 * How a catalogued value set relates to the contract domain that governs it.
 *
 * There are deliberately three and not four. A `widens` kind — the catalog admitting values the
 * contract never emits, on purpose — would ship with **zero** members, and a link kind with no member
 * is a guess about a case nobody has met; the finding `catalog_exceeds_contract` names the condition
 * if one arrives, and whoever meets it decides then.
 */
export const DOMAIN_LINK_KINDS = ["mirrors", "narrows", "catalog_only"] as const;
export type DomainLinkKind = (typeof DOMAIN_LINK_KINDS)[number];

/**
 * What each link claims, read by the shape test and by nothing else — deliberately.
 *
 * Its job is the `Record` being total: a fourth link kind is a compile error here until it says what
 * it means, which the `superRefine`'s `if`/`else` chain below would *not* make it. That is the only
 * reason a map is better than three comments, and it is the same argument `ABAC_DENIAL_EFFECT` is
 * kept for.
 */
export const DOMAIN_LINK_MEANINGS: Readonly<Record<DomainLinkKind, string>> = Object.freeze({
  mirrors:
    "the CHECK enumerates exactly this domain; a difference in either direction is a defect, because a value the contract emits and the column refuses cannot be stored, and a value the column admits and nothing emits is drift",
  narrows:
    "the column admits a subset of the domain, and `except` names the difference; `guardedBy` must name the symbol that makes those members unreachable, because a narrowing that nothing enforces is a divergence with a note attached",
  catalog_only:
    "no contract domain governs this column — the catalog is the only place its values are written down; contradicted the moment one appears",
});

export const ValueSetDomainDeclarationSchema = z
  .object({
    /** Unqualified table name, as `META_TABLES` spells it. */
    table: z.string().min(1),
    column: z.string().min(1),
    link: z.enum(DOMAIN_LINK_KINDS),
    /**
     * `<package>:<NAME>` for a constant or `<package>:<XSchema>.<field>` for a schema field, and
     * `null` for `catalog_only`.
     */
    ref: z.string().min(3).nullable(),
    /**
     * For `narrows`: the domain members this column does not admit. Named rather than implied by the
     * CHECK, so `domain \ except === check` is an equality and neither side can drift unnoticed.
     */
    except: z.array(z.string().min(1)).min(1).optional(),
    /**
     * For `narrows`: `<package>:<Symbol>` whose declaration refuses every `except` member. A
     * referential obligation in `pg-unreachable-stores.ts`'s shape — the one thing that separates a
     * narrowing somebody enforced from a divergence somebody wrote a sentence about.
     */
    guardedBy: z.string().min(3).optional(),
    /** Required for `narrows` and `catalog_only`; prose a `mirrors` link does not need. */
    because: z.string().min(20).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.link === "catalog_only") {
      if (d.ref !== null)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ref"],
          message: "a catalog_only link names no domain",
        });
      if (d.because === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["because"],
          message: "a catalog_only link must say why no contract domain governs the column",
        });
    } else if (d.ref === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ref"],
        message: `a ${d.link} link must name a domain`,
      });
    }
    if (d.link === "narrows") {
      if (d.except === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["except"],
          message: "a narrows link must name the members the column does not admit",
        });
      if (d.guardedBy === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["guardedBy"],
          message: "a narrows link must name the symbol that enforces it",
        });
      if (d.because === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["because"],
          message: "a narrows link must say why the column admits less than the domain",
        });
    } else if (d.except !== undefined || d.guardedBy !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["except"],
        message: `only a narrows link carries except/guardedBy; this one is ${d.link}`,
      });
    }
  });
export type ValueSetDomainDeclaration = z.infer<typeof ValueSetDomainDeclarationSchema>;

/**
 * Which contract domain governs each catalogued value-set CHECK — one entry per CHECK, no
 * exceptions, which is what makes a missing entry a failure rather than a silence.
 *
 * 287 of them: **281** `mirrors`, **5** `catalog_only` and **1** `narrows`. The `mirrors` entries
 * were generated by matching each CHECK's value set against every domain in the workspace and taking
 * the unique exact match, then hand-adjudicating the 19 columns where several domains enumerate the
 * same set — `DATA_CLASSES` is declared in three packages, `RISK_LEVELS` and `LATENCY_PERCENTILES` in
 * three each, `OCR_STATUSES` and `EMBEDDING_STATUSES` are two names for one set, and
 * `audit_integrity_verdicts.verdict` has three spellings inside one app. A ref is a constant where one
 * is unambiguous and a schema field where it is not, because a field is what actually produces the
 * value: `meta.report_runs.engine` refs `ReportRunRecordSchema.engine` rather than `REPORT_ENGINES`,
 * whose third member `auto` is a report *definition's* engine preference and never a run's.
 *
 * Generated once and then owned by hand. The generator is not kept, deliberately: re-running it would
 * recompute the links from whatever the enums say today, which is the very thing the declaration
 * exists to pin. A new catalogued CHECK gets a line written by whoever adds it.
 */
export const VALUE_SET_DOMAINS: readonly ValueSetDomainDeclaration[] = [
  { table: "aa_conflicts", column: "chosen_strategy", link: "mirrors", ref: "@crossengin/active-active:RESOLUTION_STRATEGIES" },
  { table: "aa_conflicts", column: "kind", link: "mirrors", ref: "@crossengin/active-active:CONFLICT_KINDS" },
  { table: "aa_conflicts", column: "status", link: "mirrors", ref: "@crossengin/active-active:CONFLICT_STATUSES" },
  { table: "aa_split_brain_events", column: "healing_strategy", link: "mirrors", ref: "@crossengin/active-active:HEALING_STRATEGIES" },
  { table: "aa_split_brain_events", column: "kind", link: "mirrors", ref: "@crossengin/active-active:SPLIT_BRAIN_KINDS" },
  { table: "aa_split_brain_events", column: "status", link: "mirrors", ref: "@crossengin/active-active:SPLIT_BRAIN_STATUSES" },
  { table: "aa_topology", column: "kind", link: "mirrors", ref: "@crossengin/active-active:TOPOLOGY_KINDS" },
  { table: "aa_topology", column: "partition_strategy", link: "mirrors", ref: "@crossengin/active-active:PARTITION_STRATEGIES" },
  { table: "access_review_campaigns", column: "auto_revoke_policy", link: "mirrors", ref: "@crossengin/access-reviews:AUTO_REVOKE_POLICIES" },
  { table: "access_review_campaigns", column: "framework", link: "mirrors", ref: "@crossengin/access-reviews:COMPLIANCE_FRAMEWORKS" },
  { table: "access_review_campaigns", column: "frequency", link: "mirrors", ref: "@crossengin/access-reviews:CAMPAIGN_FREQUENCIES" },
  { table: "access_review_campaigns", column: "status", link: "mirrors", ref: "@crossengin/access-reviews:CAMPAIGN_STATUSES" },
  { table: "access_review_decisions", column: "attestation_kind", link: "mirrors", ref: "@crossengin/access-reviews:ATTESTATION_KINDS" },
  { table: "access_review_decisions", column: "kind", link: "mirrors", ref: "@crossengin/access-reviews:DECISION_KINDS" },
  { table: "access_review_decisions", column: "reason", link: "mirrors", ref: "@crossengin/access-reviews:DECISION_REASONS" },
  { table: "access_review_evidence", column: "framework", link: "mirrors", ref: "@crossengin/access-reviews:COMPLIANCE_FRAMEWORKS" },
  { table: "access_review_evidence", column: "status", link: "mirrors", ref: "@crossengin/access-reviews:EVIDENCE_STATUSES" },
  { table: "access_review_exceptions", column: "reason", link: "mirrors", ref: "@crossengin/access-reviews:EXCEPTION_REASONS" },
  { table: "access_review_exceptions", column: "status", link: "mirrors", ref: "@crossengin/access-reviews:EXCEPTION_STATUSES" },
  { table: "access_review_items", column: "current_reviewer_kind", link: "mirrors", ref: "@crossengin/access-reviews:REVIEWER_KINDS" },
  { table: "access_review_items", column: "grant_kind", link: "mirrors", ref: "@crossengin/access-reviews:GRANT_KINDS" },
  { table: "access_review_items", column: "principal_type", link: "mirrors", ref: "@crossengin/access-reviews:PRINCIPAL_TYPES" },
  { table: "access_review_items", column: "risk_level", link: "mirrors", ref: "@crossengin/access-reviews:AccessReviewItemSchema.riskLevel" },
  { table: "access_review_items", column: "status", link: "mirrors", ref: "@crossengin/access-reviews:REVIEW_ITEM_STATUSES" },
  { table: "access_review_templates", column: "default_auto_revoke_policy", link: "mirrors", ref: "@crossengin/access-reviews:AUTO_REVOKE_POLICIES" },
  { table: "access_review_templates", column: "default_frequency", link: "mirrors", ref: "@crossengin/access-reviews:CAMPAIGN_FREQUENCIES" },
  { table: "access_review_templates", column: "framework", link: "mirrors", ref: "@crossengin/access-reviews:COMPLIANCE_FRAMEWORKS" },
  { table: "access_review_templates", column: "status", link: "mirrors", ref: "@crossengin/access-reviews:TEMPLATE_LIFECYCLE_STATUSES" },
  {
    table: "ai_conversations",
    column: "status",
    link: "catalog_only",
    ref: null,
    because:
      "Superseded by meta.architect_sessions plus meta.architect_messages, which is what PostgresTranscript writes; no Architect contract declares an active/finished/aborted conversation lifecycle, so this CHECK is the only place those three values appear.",
  },
  {
    table: "api_keys",
    column: "status",
    link: "catalog_only",
    ref: null,
    because:
      "Credentials arrive through argv as `--api-key key:role:tenant[:principal]` and are never persisted (ADR-0331), so nothing in the workspace types an api-key status at all. SSO_SESSION_STATUSES is a strict superset of these three and is about a federated session, which is the coincidence that made an unconstrained superset rule unusable.",
  },
  { table: "architect_messages", column: "role", link: "mirrors", ref: "@crossengin/ai-architect:ArchitectMessageRecordSchema.role" },
  { table: "architect_proposals", column: "decision", link: "mirrors", ref: "@crossengin/ai-architect:ARCHITECT_PROPOSAL_DECISIONS" },
  { table: "audit_integrity_verdicts", column: "verdict", link: "mirrors", ref: "@crossengin/operate-server:STORED_INTEGRITY_VERDICTS" },
  { table: "autoscaling_events", column: "decision", link: "mirrors", ref: "@crossengin/edge:SCALING_DECISIONS" },
  { table: "autoscaling_events", column: "reason", link: "mirrors", ref: "@crossengin/edge:SCALING_REASONS" },
  { table: "autoscaling_events", column: "region", link: "mirrors", ref: "@crossengin/residency:REGIONS" },
  { table: "autoscaling_events", column: "signal", link: "mirrors", ref: "@crossengin/edge:SCALING_SIGNALS" },
  { table: "backfill_jobs", column: "conflict_resolution", link: "mirrors", ref: "@crossengin/migration:CONFLICT_RESOLUTIONS" },
  { table: "backfill_jobs", column: "status", link: "mirrors", ref: "@crossengin/migration:BACKFILL_STATUSES" },
  { table: "backfill_ledger", column: "outcome", link: "mirrors", ref: "@crossengin/migration:LEDGER_OUTCOMES" },
  { table: "backup_records", column: "kind", link: "mirrors", ref: "@crossengin/dr:BACKUP_KINDS" },
  { table: "backup_records", column: "status", link: "mirrors", ref: "@crossengin/dr:BACKUP_STATUSES" },
  { table: "backup_records", column: "storage_region", link: "mirrors", ref: "@crossengin/residency:REGIONS" },
  { table: "billing_events", column: "kind", link: "mirrors", ref: "@crossengin/billing:BILLING_EVENT_KINDS" },
  { table: "billing_usage_records", column: "meter", link: "mirrors", ref: "@crossengin/billing:METER_IDS" },
  { table: "billing_usage_records", column: "source", link: "mirrors", ref: "@crossengin/billing:USAGE_SOURCES" },
  { table: "budget_breaches", column: "percentile", link: "mirrors", ref: "@crossengin/edge:BudgetBreachRecordSchema.percentile" },
  { table: "budget_breaches", column: "severity", link: "mirrors", ref: "@crossengin/edge:BUDGET_SEVERITIES" },
  { table: "cdc_checkpoints", column: "status", link: "mirrors", ref: "@crossengin/reporting:CDC_PIPELINE_STATUSES" },
  { table: "certification_reports", column: "framework", link: "mirrors", ref: "@crossengin/access-reviews:COMPLIANCE_FRAMEWORKS" },
  { table: "chain_of_custody", column: "action", link: "mirrors", ref: "@crossengin/forensics:CUSTODY_ACTIONS" },
  { table: "chain_of_custody", column: "purpose", link: "mirrors", ref: "@crossengin/forensics:CUSTODY_PURPOSES" },
  { table: "chargeback_statements", column: "status", link: "mirrors", ref: "@crossengin/finops:ChargebackStatementSchema.status" },
  { table: "cost_attribution", column: "allocation_method", link: "mirrors", ref: "@crossengin/finops:ALLOCATION_METHODS" },
  { table: "cost_attribution", column: "category", link: "mirrors", ref: "@crossengin/finops:COST_CATEGORIES" },
  { table: "cost_attribution", column: "environment", link: "mirrors", ref: "@crossengin/finops:CostAttributionRecordSchema.environment" },
  { table: "cost_attribution", column: "region", link: "mirrors", ref: "@crossengin/residency:REGIONS" },
  { table: "cost_attribution", column: "source_data_class", link: "mirrors", ref: "@crossengin/finops:CostAttributionRecordSchema.sourceDataClass" },
  { table: "cost_budgets", column: "period", link: "mirrors", ref: "@crossengin/finops:BUDGET_PERIODS" },
  { table: "crypto_audit", column: "algorithm", link: "mirrors", ref: "@crossengin/crypto:KEY_ALGORITHMS" },
  { table: "crypto_audit", column: "operation", link: "mirrors", ref: "@crossengin/crypto:CRYPTO_OPERATIONS" },
  { table: "crypto_audit", column: "purpose", link: "mirrors", ref: "@crossengin/crypto:KEY_PURPOSES" },
  { table: "crypto_keys", column: "algorithm", link: "mirrors", ref: "@crossengin/crypto:KEY_ALGORITHMS" },
  { table: "crypto_keys", column: "purpose", link: "mirrors", ref: "@crossengin/crypto:KEY_PURPOSES" },
  { table: "crypto_keys", column: "status", link: "mirrors", ref: "@crossengin/crypto-pg:KEY_STATUSES" },
  { table: "data_subjects", column: "primary_identifier_kind", link: "mirrors", ref: "@crossengin/data-lineage:SUBJECT_IDENTIFIER_KINDS" },
  { table: "data_subjects", column: "verification_method", link: "mirrors", ref: "@crossengin/tenant-lifecycle:VERIFICATION_METHODS" },
  { table: "dead_letter_jobs", column: "reason", link: "mirrors", ref: "@crossengin/jobs:DeadLetterReasonSchema" },
  { table: "deployments", column: "app_kind", link: "mirrors", ref: "@crossengin/deploy:APP_KINDS" },
  { table: "deployments", column: "environment", link: "mirrors", ref: "@crossengin/deploy:ENVIRONMENTS" },
  { table: "deployments", column: "region", link: "mirrors", ref: "@crossengin/residency:REGIONS" },
  { table: "deployments", column: "status", link: "mirrors", ref: "@crossengin/deploy:DEPLOYMENT_STATUSES" },
  { table: "deployments", column: "strategy", link: "mirrors", ref: "@crossengin/deploy:DEPLOY_STRATEGIES" },
  { table: "deployments", column: "target", link: "mirrors", ref: "@crossengin/deploy:DEPLOY_TARGETS" },
  { table: "deployments", column: "trigger", link: "mirrors", ref: "@crossengin/deploy:DEPLOYMENT_TRIGGERS" },
  { table: "dr_drills", column: "kind", link: "mirrors", ref: "@crossengin/dr:DRILL_KINDS" },
  { table: "dr_drills", column: "outcome", link: "mirrors", ref: "@crossengin/dr:DRILL_OUTCOMES" },
  { table: "dr_drills", column: "tier", link: "mirrors", ref: "@crossengin/dr:DR_TIERS" },
  { table: "ediscovery_requests", column: "production_format", link: "mirrors", ref: "@crossengin/forensics:PRODUCTION_FORMATS" },
  { table: "ediscovery_requests", column: "status", link: "mirrors", ref: "@crossengin/forensics:EDISCOVERY_STATUSES" },
  { table: "extension_packs", column: "author_kind", link: "mirrors", ref: "@crossengin/marketplace:PACK_AUTHOR_KINDS" },
  { table: "extension_packs", column: "kind", link: "mirrors", ref: "@crossengin/marketplace:PACK_KINDS" },
  { table: "failover_records", column: "from_region", link: "mirrors", ref: "@crossengin/residency:REGIONS" },
  { table: "failover_records", column: "status", link: "mirrors", ref: "@crossengin/dr:FAILOVER_STATUSES" },
  { table: "failover_records", column: "tier", link: "mirrors", ref: "@crossengin/dr:DR_TIERS" },
  { table: "failover_records", column: "to_region", link: "mirrors", ref: "@crossengin/residency:REGIONS" },
  { table: "failover_records", column: "trigger", link: "mirrors", ref: "@crossengin/dr:FAILOVER_TRIGGERS" },
  { table: "feature_flag_changes", column: "kind", link: "mirrors", ref: "@crossengin/feature-flags:CHANGE_KINDS" },
  { table: "feature_flag_changes", column: "outcome", link: "mirrors", ref: "@crossengin/feature-flags:FLAG_CHANGE_OUTCOMES" },
  { table: "feature_flag_evaluations", column: "environment", link: "mirrors", ref: "@crossengin/feature-flags:FlagEvaluationSchema.environment" },
  { table: "feature_flag_evaluations", column: "reason", link: "mirrors", ref: "@crossengin/feature-flags:EVALUATION_REASONS" },
  { table: "feature_flag_kill_switches", column: "status", link: "mirrors", ref: "@crossengin/feature-flags:KILL_SWITCH_STATUSES" },
  { table: "feature_flag_kill_switches", column: "trigger_kind", link: "mirrors", ref: "@crossengin/feature-flags:KILL_SWITCH_TRIGGER_KINDS" },
  { table: "feature_flags", column: "kind", link: "mirrors", ref: "@crossengin/feature-flags:FLAG_KINDS" },
  { table: "feature_flags", column: "risk_level", link: "mirrors", ref: "@crossengin/feature-flags:FlagDefinitionSchema.riskLevel" },
  { table: "feature_flags", column: "status", link: "mirrors", ref: "@crossengin/feature-flags:FLAG_STATUSES" },
  { table: "files", column: "data_class", link: "mirrors", ref: "@crossengin/files:FileReferenceSchema.dataClass" },
  { table: "files", column: "embedding_status", link: "mirrors", ref: "@crossengin/files:FileReferenceSchema.embeddingStatus" },
  { table: "files", column: "ocr_status", link: "mirrors", ref: "@crossengin/files:FileReferenceSchema.ocrStatus" },
  { table: "files", column: "status", link: "mirrors", ref: "@crossengin/files:FILE_STATUSES" },
  { table: "forensic_chain_checkpoints", column: "algorithm", link: "mirrors", ref: "@crossengin/forensics:HASH_ALGORITHMS" },
  { table: "forensic_chain_entries", column: "kind", link: "mirrors", ref: "@crossengin/forensics:LOG_KINDS" },
  { table: "forensic_evidence", column: "kind", link: "mirrors", ref: "@crossengin/forensics:EVIDENCE_KINDS" },
  { table: "forensic_evidence", column: "provenance", link: "mirrors", ref: "@crossengin/forensics:EVIDENCE_PROVENANCE" },
  { table: "forensic_evidence", column: "sensitivity", link: "mirrors", ref: "@crossengin/forensics:EVIDENCE_SENSITIVITY" },
  { table: "gateway_idempotency_records", column: "method", link: "mirrors", ref: "@crossengin/api-gateway:IdempotencyRecordSchema.method" },
  { table: "gateway_idempotency_records", column: "status", link: "mirrors", ref: "@crossengin/api-gateway:IDEMPOTENCY_RECORD_STATUSES" },
  { table: "gateway_pipeline_executions", column: "auth_outcome", link: "mirrors", ref: "@crossengin/api-gateway:AUTH_OUTCOMES" },
  { table: "gateway_pipeline_executions", column: "final_outcome", link: "mirrors", ref: "@crossengin/api-gateway:STAGE_OUTCOMES" },
  { table: "gateway_pipeline_executions", column: "final_stage", link: "mirrors", ref: "@crossengin/api-gateway:PIPELINE_STAGES" },
  { table: "gateway_pipeline_executions", column: "idempotency_outcome", link: "mirrors", ref: "@crossengin/api-gateway:IDEMPOTENCY_OUTCOMES" },
  { table: "gateway_pipeline_executions", column: "route_match_outcome", link: "mirrors", ref: "@crossengin/api-gateway:ROUTE_MATCH_OUTCOMES" },
  { table: "gateway_routes", column: "method", link: "mirrors", ref: "@crossengin/api-gateway:HTTP_METHODS" },
  { table: "gdpr_deletion_requests", column: "legal_basis", link: "mirrors", ref: "@crossengin/tenant-lifecycle:GDPR_LEGAL_BASES" },
  { table: "gdpr_deletion_requests", column: "status", link: "mirrors", ref: "@crossengin/tenant-lifecycle:DELETION_REQUEST_STATUSES" },
  { table: "gdpr_deletion_requests", column: "verification_method", link: "mirrors", ref: "@crossengin/tenant-lifecycle:VERIFICATION_METHODS" },
  { table: "import_sources", column: "kind", link: "mirrors", ref: "@crossengin/migration:SOURCE_KINDS" },
  { table: "import_sources", column: "last_fetch_status", link: "mirrors", ref: "@crossengin/migration:ImportSourceSpecSchema.lastFetchStatus" },
  { table: "import_sources", column: "schedule", link: "mirrors", ref: "@crossengin/migration:SOURCE_SCHEDULES" },
  { table: "incident_communications", column: "audience", link: "mirrors", ref: "@crossengin/incident-response:COMM_AUDIENCES" },
  { table: "incident_communications", column: "kind", link: "mirrors", ref: "@crossengin/incident-response:COMM_KINDS" },
  { table: "incident_communications", column: "status_page_level", link: "mirrors", ref: "@crossengin/incident-response:STATUS_PAGE_LEVELS" },
  { table: "incident_postmortems", column: "confidentiality_class", link: "mirrors", ref: "@crossengin/incident-response:PostmortemSchema.confidentialityClass" },
  { table: "incident_postmortems", column: "severity", link: "mirrors", ref: "@crossengin/incident-response:SEVERITIES" },
  { table: "incident_postmortems", column: "status", link: "mirrors", ref: "@crossengin/incident-response:POSTMORTEM_STATUSES" },
  { table: "incident_runbook_executions", column: "status", link: "mirrors", ref: "@crossengin/incident-response:EXECUTION_STATUSES" },
  { table: "incidents", column: "category", link: "mirrors", ref: "@crossengin/incident-response:INCIDENT_CATEGORIES" },
  { table: "incidents", column: "severity", link: "mirrors", ref: "@crossengin/incident-response:SEVERITIES" },
  { table: "incidents", column: "status", link: "mirrors", ref: "@crossengin/incident-response:INCIDENT_STATUSES" },
  { table: "integration_calls", column: "data_class", link: "mirrors", ref: "@crossengin/types:DATA_CLASSIFICATIONS" },
  { table: "integration_calls", column: "direction", link: "mirrors", ref: "@crossengin/integrations:IntegrationCallRecordSchema.direction" },
  { table: "invoices", column: "status", link: "mirrors", ref: "@crossengin/billing:INVOICE_STATUSES" },
  { table: "job_costs", column: "cost_basis", link: "mirrors", ref: "@crossengin/jobs:JobCostRecordSchema.costBasis" },
  { table: "job_runs", column: "cancelled_at_checkpoint", link: "mirrors", ref: "@crossengin/jobs:JOB_CANCELLATION_CHECKPOINTS" },
  { table: "job_runs", column: "input_data_class", link: "mirrors", ref: "@crossengin/jobs:JobRunRecordSchema.inputDataClass" },
  { table: "job_runs", column: "job_kind", link: "mirrors", ref: "@crossengin/jobs:JOB_KINDS" },
  { table: "job_runs", column: "output_data_class", link: "mirrors", ref: "@crossengin/jobs:JobRunRecordSchema.outputDataClass" },
  { table: "job_runs", column: "status", link: "mirrors", ref: "@crossengin/jobs:JOB_RUN_STATUSES" },
  { table: "legal_holds", column: "kind", link: "mirrors", ref: "@crossengin/forensics:HOLD_KINDS" },
  { table: "legal_holds", column: "status", link: "mirrors", ref: "@crossengin/forensics:HOLD_STATUSES" },
  { table: "lineage_edges", column: "kind", link: "mirrors", ref: "@crossengin/data-lineage:EDGE_KINDS" },
  { table: "lineage_edges", column: "source_classification", link: "mirrors", ref: "@crossengin/data-lineage:DATA_CLASSIFICATIONS" },
  { table: "lineage_edges", column: "target_classification", link: "mirrors", ref: "@crossengin/data-lineage:DATA_CLASSIFICATIONS" },
  { table: "lineage_nodes", column: "classification", link: "mirrors", ref: "@crossengin/data-lineage:DATA_CLASSIFICATIONS" },
  { table: "lineage_nodes", column: "kind", link: "mirrors", ref: "@crossengin/data-lineage:LINEAGE_NODE_KINDS" },
  { table: "lineage_nodes", column: "status", link: "mirrors", ref: "@crossengin/data-lineage:NODE_LIFECYCLE_STATUSES" },
  {
    table: "manifests",
    column: "status",
    link: "catalog_only",
    ref: null,
    because:
      "Phase 1's platform manifest table, superseded by meta.operate_tenant_manifests (ADR-0314) and declared writerless with that reason; its five-state lifecycle is written down nowhere else, and the store that replaced it carries a three-state one of its own.",
  },
  { table: "ml_consent", column: "legal_basis", link: "mirrors", ref: "@crossengin/ml-training:TrainingConsentSchema.legalBasis" },
  { table: "ml_consent", column: "purpose", link: "mirrors", ref: "@crossengin/ml-training:TRAINING_PURPOSES" },
  { table: "ml_consent", column: "status", link: "mirrors", ref: "@crossengin/ml-training:CONSENT_STATUSES" },
  { table: "ml_datasets", column: "purpose", link: "mirrors", ref: "@crossengin/ml-training:TRAINING_PURPOSES" },
  { table: "ml_datasets", column: "redaction_strategy", link: "mirrors", ref: "@crossengin/ml-training:REDACTION_STRATEGIES" },
  { table: "ml_datasets", column: "status", link: "mirrors", ref: "@crossengin/ml-training:DATASET_STATUSES" },
  { table: "ml_evalsets", column: "task_kind", link: "mirrors", ref: "@crossengin/ml-training:EVAL_TASK_KINDS" },
  { table: "ml_evaluations", column: "trigger", link: "mirrors", ref: "@crossengin/ml-training:EvaluationRunSchema.trigger" },
  { table: "ml_evaluations", column: "verdict", link: "mirrors", ref: "@crossengin/ml-training:EVAL_VERDICTS" },
  { table: "ml_models", column: "family", link: "mirrors", ref: "@crossengin/ml-training:MODEL_FAMILIES" },
  { table: "ml_models", column: "status", link: "mirrors", ref: "@crossengin/ml-training:MODEL_LIFECYCLE_STATUSES" },
  { table: "ml_training_runs", column: "kind", link: "mirrors", ref: "@crossengin/ml-training:TRAINING_KINDS" },
  { table: "ml_training_runs", column: "status", link: "mirrors", ref: "@crossengin/ml-training:TRAINING_STATUSES" },
  { table: "notification_deliveries", column: "attempt_kind", link: "mirrors", ref: "@crossengin/notifications:ATTEMPT_KINDS" },
  { table: "notification_deliveries", column: "channel", link: "mirrors", ref: "@crossengin/notifications:NOTIFICATION_CHANNELS" },
  { table: "notification_deliveries", column: "outcome", link: "mirrors", ref: "@crossengin/notifications:DELIVERY_OUTCOMES" },
  { table: "notification_digests", column: "channel", link: "mirrors", ref: "@crossengin/notifications:NOTIFICATION_CHANNELS" },
  {
    table: "notification_digests",
    column: "frequency",
    link: "narrows",
    ref: "@crossengin/notifications:DIGEST_FREQUENCIES",
    except: ["immediate", "never"],
    guardedBy: "@crossengin/notifications:DigestBatchSchema",
    because:
      "A digest row describes a batching *window*, and two of the six frequencies have none: DIGEST_WINDOW_MINUTES answers null for both, so buildDigestBatch throws and delivery-drain returns before opening one. DigestBatchSchema refuses them by name, which is what makes the exclusion a rule rather than a convention — and the inferred type is still the full union, so the refinement is the only thing standing between a hand-built DigestBatch and 23514.",
  },
  { table: "notification_digests", column: "status", link: "mirrors", ref: "@crossengin/notifications:DIGEST_STATUSES" },
  { table: "notification_dispatches", column: "category", link: "mirrors", ref: "@crossengin/notifications:CONTENT_CATEGORIES" },
  { table: "notification_dispatches", column: "channel", link: "mirrors", ref: "@crossengin/notifications:NOTIFICATION_CHANNELS" },
  { table: "notification_dispatches", column: "priority", link: "mirrors", ref: "@crossengin/notifications:PRIORITY_LEVELS" },
  { table: "notification_dispatches", column: "status", link: "mirrors", ref: "@crossengin/notifications:DISPATCH_STATUSES" },
  { table: "notification_fax_observations", column: "last_disposition", link: "mirrors", ref: "@crossengin/notification-providers:FAX_OBSERVATION_DISPOSITIONS" },
  { table: "notification_preferences", column: "category", link: "mirrors", ref: "@crossengin/notifications:CONTENT_CATEGORIES" },
  { table: "notification_preferences", column: "channel", link: "mirrors", ref: "@crossengin/notifications:NOTIFICATION_CHANNELS" },
  { table: "notification_preferences", column: "source", link: "mirrors", ref: "@crossengin/operate-server:PREFERENCE_SOURCES" },
  { table: "notification_read_states", column: "source", link: "mirrors", ref: "@crossengin/notifications:READ_STATE_SOURCES" },
  { table: "notification_read_watermarks", column: "source", link: "mirrors", ref: "@crossengin/notifications:READ_STATE_SOURCES" },
  { table: "notification_suppressions", column: "channel", link: "mirrors", ref: "@crossengin/notifications:NOTIFICATION_CHANNELS" },
  { table: "notification_suppressions", column: "reason", link: "mirrors", ref: "@crossengin/notifications:SUPPRESSION_REASONS" },
  { table: "notification_templates", column: "category", link: "mirrors", ref: "@crossengin/notifications:CONTENT_CATEGORIES" },
  { table: "notification_templates", column: "channel", link: "mirrors", ref: "@crossengin/notifications:NOTIFICATION_CHANNELS" },
  { table: "notification_templates", column: "status", link: "mirrors", ref: "@crossengin/notifications:TEMPLATE_STATUSES" },
  { table: "notification_user_quiet_hours", column: "behavior", link: "mirrors", ref: "@crossengin/notifications:QUIET_HOURS_BEHAVIORS" },
  { table: "notification_user_quiet_hours", column: "source", link: "mirrors", ref: "@crossengin/notifications:USER_QUIET_HOURS_SOURCES" },
  { table: "onboarding_runs", column: "current_stage", link: "mirrors", ref: "@crossengin/migration:ONBOARDING_STAGES" },
  { table: "onboarding_runs", column: "path", link: "mirrors", ref: "@crossengin/migration:ONBOARDING_PATHS" },
  { table: "operate_design_jobs", column: "phase", link: "mirrors", ref: "@crossengin/operate-server:DESIGN_JOB_PHASES" },
  { table: "operate_design_jobs", column: "status", link: "mirrors", ref: "@crossengin/operate-server:DESIGN_JOB_STATUSES" },
  { table: "operate_tenant_manifests", column: "review_status", link: "mirrors", ref: "@crossengin/operate-server:REVIEW_STATUSES" },
  { table: "operate_tenant_manifests", column: "source", link: "mirrors", ref: "@crossengin/operate-server:MANIFEST_PROPOSAL_SOURCES" },
  { table: "operate_tenant_manifests", column: "status", link: "mirrors", ref: "@crossengin/operate-server:TenantManifestRecordSchema.status" },
  { table: "pack_installations", column: "status", link: "mirrors", ref: "@crossengin/marketplace:INSTALLATION_STATUSES" },
  { table: "pack_installations", column: "update_policy", link: "mirrors", ref: "@crossengin/marketplace:UPDATE_POLICIES" },
  { table: "pack_reviews", column: "moderation_status", link: "mirrors", ref: "@crossengin/marketplace:PackReviewSchema.moderationStatus" },
  { table: "pack_versions", column: "channel", link: "mirrors", ref: "@crossengin/marketplace:DISTRIBUTION_CHANNELS" },
  { table: "pack_versions", column: "security_review_status", link: "mirrors", ref: "@crossengin/marketplace:SECURITY_REVIEW_STATUSES" },
  { table: "pack_versions", column: "status", link: "mirrors", ref: "@crossengin/marketplace:PACK_VERSION_STATUSES" },
  { table: "plans", column: "billing_interval", link: "mirrors", ref: "@crossengin/billing:BILLING_INTERVALS" },
  { table: "plans", column: "family", link: "mirrors", ref: "@crossengin/billing:PLAN_FAMILIES" },
  { table: "plans", column: "tier", link: "mirrors", ref: "@crossengin/billing:PlanSchema.tier" },
  { table: "provenance_records", column: "edge_kind", link: "mirrors", ref: "@crossengin/data-lineage:EDGE_KINDS" },
  { table: "provenance_records", column: "operation_kind", link: "mirrors", ref: "@crossengin/data-lineage:PROVENANCE_OPERATION_KINDS" },
  { table: "provenance_records", column: "outcome", link: "mirrors", ref: "@crossengin/data-lineage:PROVENANCE_OUTCOMES" },
  { table: "quota_definitions", column: "period", link: "mirrors", ref: "@crossengin/rate-limiting:QUOTA_PERIODS" },
  { table: "quota_definitions", column: "quota_class", link: "mirrors", ref: "@crossengin/rate-limiting:QUOTA_CLASSES" },
  { table: "quota_definitions", column: "target", link: "mirrors", ref: "@crossengin/rate-limiting:QUOTA_TARGETS" },
  { table: "quota_usage", column: "period", link: "mirrors", ref: "@crossengin/rate-limiting:QUOTA_PERIODS" },
  { table: "quota_usage", column: "target", link: "mirrors", ref: "@crossengin/rate-limiting:QUOTA_TARGETS" },
  { table: "rate_limit_decisions", column: "outcome", link: "mirrors", ref: "@crossengin/rate-limiting:DECISION_OUTCOMES" },
  { table: "rate_limit_exceptions", column: "kind", link: "mirrors", ref: "@crossengin/rate-limiting:EXCEPTION_KINDS" },
  { table: "rate_limit_exceptions", column: "status", link: "mirrors", ref: "@crossengin/rate-limiting:EXCEPTION_STATUSES" },
  { table: "rate_limit_policies", column: "algorithm", link: "mirrors", ref: "@crossengin/rate-limiting:RATE_LIMIT_ALGORITHMS" },
  { table: "rate_limit_policies", column: "overage_handling", link: "mirrors", ref: "@crossengin/rate-limiting:OVERAGE_HANDLING" },
  { table: "rate_limit_policies", column: "priority_override", link: "mirrors", ref: "@crossengin/rate-limiting:PRIORITY_OVERRIDES" },
  { table: "rate_limit_policies", column: "status", link: "mirrors", ref: "@crossengin/rate-limiting:POLICY_STATUSES" },
  { table: "regions", column: "region", link: "mirrors", ref: "@crossengin/residency:REGIONS" },
  { table: "regions", column: "status", link: "mirrors", ref: "@crossengin/residency:REGION_STATUSES" },
  { table: "report_runs", column: "engine", link: "mirrors", ref: "@crossengin/reporting:ReportRunRecordSchema.engine" },
  { table: "report_runs", column: "status", link: "mirrors", ref: "@crossengin/reporting:REPORT_RUN_STATUSES" },
  { table: "report_runs", column: "trigger", link: "mirrors", ref: "@crossengin/reporting:REPORT_RUN_TRIGGERS" },
  { table: "scheduled_exports", column: "last_status", link: "mirrors", ref: "@crossengin/reporting:SCHEDULED_EXPORT_STATUSES" },
  {
    table: "scim_clients",
    column: "status",
    link: "catalog_only",
    ref: null,
    because:
      "SCIM 2.0 provisioning has no client registry (declared unbuilt_subsystem), so @crossengin/sso types provider and session statuses but never a client's; active/disabled/revoked is this CHECK's own vocabulary.",
  },
  { table: "scim_provisioning", column: "operation", link: "mirrors", ref: "@crossengin/sso:SCIM_OPERATIONS" },
  { table: "scim_provisioning", column: "outcome", link: "mirrors", ref: "@crossengin/sso:SCIM_OUTCOMES" },
  { table: "scim_provisioning", column: "resource_type", link: "mirrors", ref: "@crossengin/sso:SCIM_RESOURCE_TYPES" },
  { table: "sdk_client_installations", column: "language", link: "mirrors", ref: "@crossengin/sdk-clients:TARGET_LANGUAGES" },
  {
    table: "sdk_client_installations",
    column: "upgrade_nag_status",
    link: "catalog_only",
    ref: null,
    because:
      "@crossengin/sdk-clients is contracts-only and models the compatibility matrix and advisories without a nag ladder; these four values appear in this CHECK and nowhere else in the workspace.",
  },
  { table: "sdk_client_releases", column: "channel", link: "mirrors", ref: "@crossengin/sdk-clients:RELEASE_CHANNELS" },
  { table: "sdk_client_releases", column: "language", link: "mirrors", ref: "@crossengin/sdk-clients:TARGET_LANGUAGES" },
  { table: "sdk_client_releases", column: "status", link: "mirrors", ref: "@crossengin/sdk-clients:RELEASE_STATUSES" },
  { table: "slo_enforcement_actions", column: "close_out", link: "mirrors", ref: "@crossengin/incident-response-runtime:INCIDENT_CLOSE_OUTS" },
  { table: "slo_enforcement_actions", column: "decision", link: "mirrors", ref: "@crossengin/observability-runtime-pg:SLO_ENFORCEMENT_DECISIONS" },
  { table: "slo_enforcement_actions", column: "severity", link: "mirrors", ref: "@crossengin/incident-response:SEVERITIES" },
  { table: "slo_enforcement_actions", column: "signal", link: "mirrors", ref: "@crossengin/observability-runtime-pg:SLO_SIGNALS" },
  { table: "slo_evaluations", column: "worst_severity", link: "mirrors", ref: "@crossengin/incident-response:SEVERITIES" },
  { table: "slo_latency_evaluations", column: "worst_percentile", link: "mirrors", ref: "@crossengin/observability-runtime-pg:SloLatencyEvaluationRecordSchema.worstPercentile" },
  { table: "slo_latency_evaluations", column: "worst_severity", link: "mirrors", ref: "@crossengin/incident-response:SEVERITIES" },
  { table: "sso_logins", column: "failure_category", link: "mirrors", ref: "@crossengin/sso:FAILURE_CATEGORIES" },
  { table: "sso_logins", column: "initiation", link: "mirrors", ref: "@crossengin/sso:LOGIN_INITIATIONS" },
  { table: "sso_logins", column: "mfa_factor", link: "mirrors", ref: "@crossengin/sso:MFA_FACTORS" },
  { table: "sso_logins", column: "outcome", link: "mirrors", ref: "@crossengin/sso:LOGIN_OUTCOMES" },
  { table: "sso_providers", column: "last_test_outcome", link: "mirrors", ref: "@crossengin/sso:TEST_OUTCOMES" },
  { table: "sso_providers", column: "protocol", link: "mirrors", ref: "@crossengin/sso:PROTOCOLS" },
  { table: "sso_providers", column: "status", link: "mirrors", ref: "@crossengin/sso:PROVIDER_STATUSES" },
  { table: "sso_providers", column: "vendor", link: "mirrors", ref: "@crossengin/sso:IDP_VENDORS" },
  { table: "sso_sessions", column: "binding", link: "mirrors", ref: "@crossengin/sso:SESSION_BINDINGS" },
  { table: "sso_sessions", column: "status", link: "mirrors", ref: "@crossengin/sso:SSO_SESSION_STATUSES" },
  { table: "sso_sessions", column: "termination_kind", link: "mirrors", ref: "@crossengin/sso:SLO_KINDS" },
  { table: "subject_access_requests", column: "legal_basis", link: "mirrors", ref: "@crossengin/data-lineage:SUBJECT_ACCESS_LEGAL_BASES" },
  { table: "subject_access_requests", column: "requested_format", link: "mirrors", ref: "@crossengin/data-lineage:DELIVERY_FORMATS" },
  { table: "subject_access_requests", column: "status", link: "mirrors", ref: "@crossengin/data-lineage:SUBJECT_ACCESS_STATUSES" },
  { table: "subscriptions", column: "status", link: "mirrors", ref: "@crossengin/billing:SUBSCRIPTION_STATUSES" },
  { table: "tenant_ai_settings", column: "schema_change_approval_tier", link: "mirrors", ref: "@crossengin/ai-architect:SCHEMA_CHANGE_APPROVAL_TIERS" },
  { table: "tenant_credits", column: "kind", link: "mirrors", ref: "@crossengin/billing:CREDIT_KINDS" },
  { table: "tenant_data_exports", column: "format", link: "mirrors", ref: "@crossengin/tenant-lifecycle:EXPORT_FORMATS" },
  { table: "tenant_data_exports", column: "status", link: "mirrors", ref: "@crossengin/tenant-lifecycle:EXPORT_STATUSES" },
  { table: "tenant_data_exports", column: "trigger", link: "mirrors", ref: "@crossengin/tenant-lifecycle:EXPORT_TRIGGERS" },
  { table: "tenant_data_keys", column: "provenance", link: "mirrors", ref: "@crossengin/crypto-pg:DATA_KEY_PROVENANCES" },
  { table: "tenant_lifecycle_events", column: "action", link: "mirrors", ref: "@crossengin/tenant-lifecycle:LIFECYCLE_ACTIONS" },
  { table: "tenant_lifecycle_events", column: "from_state", link: "mirrors", ref: "@crossengin/tenant-lifecycle:TENANT_LIFECYCLE_STATES" },
  { table: "tenant_lifecycle_events", column: "notification_channel", link: "mirrors", ref: "@crossengin/tenant-lifecycle:LifecycleEventSchema.notificationChannel" },
  { table: "tenant_lifecycle_events", column: "to_state", link: "mirrors", ref: "@crossengin/tenant-lifecycle:TENANT_LIFECYCLE_STATES" },
  { table: "tenant_lifecycle_events", column: "trigger", link: "mirrors", ref: "@crossengin/tenant-lifecycle:ACTION_TRIGGERS" },
  { table: "tenant_tombstones", column: "kind", link: "mirrors", ref: "@crossengin/tenant-lifecycle:TOMBSTONE_KINDS" },
  { table: "tenant_tombstones", column: "proof_version", link: "mirrors", ref: "@crossengin/tenant-lifecycle:TOMBSTONE_PROOF_VERSIONS" },
  { table: "tenant_unit_economics", column: "health", link: "mirrors", ref: "@crossengin/finops:MARGIN_HEALTH" },
  { table: "tenants", column: "region", link: "mirrors", ref: "@crossengin/operate-server:TenantRecordSchema.region" },
  { table: "tenants", column: "search_locale", link: "mirrors", ref: "@crossengin/operate-server:TenantRecordSchema.searchLocale" },
  { table: "tenants", column: "status", link: "mirrors", ref: "@crossengin/tenant-lifecycle:TENANT_LIFECYCLE_STATES" },
  { table: "tenants", column: "tier", link: "mirrors", ref: "@crossengin/operate-server:TENANT_TIERS" },
  { table: "throttle_events", column: "kind", link: "mirrors", ref: "@crossengin/rate-limiting:THROTTLE_EVENT_KINDS" },
  { table: "throttle_events", column: "related_decision_outcome", link: "mirrors", ref: "@crossengin/rate-limiting:DECISION_OUTCOMES" },
  { table: "user_tenant_membership", column: "status", link: "mirrors", ref: "@crossengin/operate-server:MEMBERSHIP_STATUSES" },
  { table: "users", column: "status", link: "mirrors", ref: "@crossengin/operate-server:USER_STATUSES" },
  { table: "webhook_deliveries", column: "status", link: "mirrors", ref: "@crossengin/sdk:WEBHOOK_DELIVERY_STATUSES" },
  { table: "webhook_endpoints", column: "signing_algorithm", link: "mirrors", ref: "@crossengin/crypto:MAC_ALGORITHMS" },
  { table: "workflow_activities", column: "kind", link: "mirrors", ref: "@crossengin/workflow-engine:ACTIVITY_KINDS" },
  { table: "workflow_activities", column: "status", link: "mirrors", ref: "@crossengin/workflow-engine:ACTIVITY_STATUSES" },
  { table: "workflow_definitions", column: "compensation_strategy", link: "mirrors", ref: "@crossengin/workflow-engine:COMPENSATION_STRATEGIES" },
  { table: "workflow_definitions", column: "status", link: "mirrors", ref: "@crossengin/workflow-engine:DEFINITION_STATUSES" },
  { table: "workflow_events", column: "kind", link: "mirrors", ref: "@crossengin/workflow-engine:EVENT_KINDS" },
  { table: "workflow_instances", column: "cancellation_disposition", link: "mirrors", ref: "@crossengin/workflow-engine:InstanceCancellationRequestSchema.disposition" },
  { table: "workflow_instances", column: "status", link: "mirrors", ref: "@crossengin/workflow-engine:INSTANCE_STATUSES" },
  { table: "workflow_signals", column: "delivery_guarantee", link: "mirrors", ref: "@crossengin/workflow-engine:SIGNAL_DELIVERY_GUARANTEES" },
  { table: "workflow_signals", column: "rejected_reason", link: "mirrors", ref: "@crossengin/workflow-engine:SIGNAL_REJECTION_REASONS" },
  { table: "workflow_signals", column: "status", link: "mirrors", ref: "@crossengin/workflow-engine:SIGNAL_STATUSES" },
  { table: "workflow_timers", column: "kind", link: "mirrors", ref: "@crossengin/workflow-engine:TIMER_KINDS" },
  { table: "workflow_timers", column: "status", link: "mirrors", ref: "@crossengin/workflow-engine:TIMER_STATUSES" },
];

/* ------------------------------------------------------------------ the audit */

export const VALUE_SET_FINDING_KINDS = [
  /** A catalogued value-set CHECK with no declaration. The forcing function. */
  "undeclared",
  /** A declaration naming a table/column pair the catalog does not have. */
  "unknown_column",
  /** A declaration naming a column whose CHECK is not a value set, or which declares none. */
  "not_a_value_set",
  /** Two declarations for one column. */
  "duplicate_declaration",
  /** The ref names no workspace domain. */
  "ref_unresolved",
  /** The ref names more than one domain in that package: the declaration decides nothing. */
  "ref_ambiguous",
  /**
   * The contract can emit a value the CHECK refuses. The defect: a store writing that record gets
   * `23514`, and no migration fixes it because the artifact itself disagrees.
   */
  "contract_exceeds_catalog",
  /** The CHECK admits a value nothing emits. Harmless to a write and still a divergence. */
  "catalog_exceeds_contract",
  /** A `narrows` whose `except` names members the domain does not have. */
  "narrowing_stale",
  /** `guardedBy` names a symbol that does not exist, or whose declaration omits an except member. */
  "guard_unproven",
  /** A `catalog_only` while some workspace domain enumerates exactly this CHECK. */
  "catalog_only_contradicted",
] as const;
export type ValueSetFindingKind = (typeof VALUE_SET_FINDING_KINDS)[number];

export const ValueSetFindingSchema = z.object({
  kind: z.enum(VALUE_SET_FINDING_KINDS),
  table: z.string().min(1),
  column: z.string().min(1),
  detail: z.string().min(1),
});
export type ValueSetFinding = z.infer<typeof ValueSetFindingSchema>;

/** The text of a `<package>:<Symbol>` declaration, for `guardedBy` to be checked against. */
export interface SymbolDeclaration {
  readonly package: string;
  readonly name: string;
  readonly file: string;
  readonly text: string;
}

/**
 * Every exported symbol's declaration text, so a `guardedBy` can be verified rather than read.
 *
 * `const`, `function` and `class` are the three forms the repo's guards take. The span runs to the
 * closing `;` for a const and to the matching brace for a function or class — found after the
 * parameter list closes, not at the first `{`, because `function f(a: { b: string })` would otherwise
 * end the span inside its own signature. That truncation would only ever lose text, so it fails a
 * `guardedBy` that is in fact sound, which is the safe direction and still a false failure.
 */
export function collectSymbolDeclarations(
  sources: readonly WorkspaceSourceFile[],
): readonly SymbolDeclaration[] {
  const out: SymbolDeclaration[] = [];
  for (const source of sources) {
    const code = stripComments(source.text);
    for (const m of code.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*/g)) {
      out.push({
        package: source.package,
        name: m[1] ?? "",
        file: source.file,
        text: statementSpan(code, m.index),
      });
    }
    for (const m of code.matchAll(
      /\bexport\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      const firstBrace = code.indexOf("{", m.index);
      const firstParen = code.indexOf("(", m.index);
      // A `(` before the first `{` is a parameter list, so the body starts after it closes. A class
      // has no parameter list of its own, and its first `(` is a method's — well past its body's
      // brace — so the comparison is what tells the two forms apart.
      const signature =
        firstParen >= 0 && (firstBrace < 0 || firstParen < firstBrace)
          ? matchBracket(code, firstParen)
          : -1;
      const open = code.indexOf("{", signature > 0 ? signature : m.index);
      const end = open < 0 ? -1 : matchBracket(code, open);
      out.push({
        package: source.package,
        name: m[1] ?? "",
        file: source.file,
        text: end > 0 ? code.slice(m.index, end) : code.slice(m.index),
      });
    }
  }
  return out;
}

function parseRef(ref: string): { readonly package: string; readonly name: string } | null {
  const at = ref.indexOf(":");
  if (at <= 0 || at === ref.length - 1) return null;
  return { package: ref.slice(0, at), name: ref.slice(at + 1) };
}

export interface ValueSetAuditInput {
  readonly valueSets: readonly CatalogValueSet[];
  readonly domains: readonly WorkspaceDomain[];
  readonly declarations: readonly ValueSetDomainDeclaration[];
  readonly symbols: readonly SymbolDeclaration[];
  /** Every column CHECK the catalog declares, so a declaration can be told from a bad column. */
  readonly checkedColumns: ReadonlySet<string>;
}

/**
 * Compare the catalog's value sets with the contract domains declared to govern them, both ways.
 *
 * Pure over facts another module reads, following `typecheck-config.ts`'s split.
 */
export function auditValueSetDomains(input: ValueSetAuditInput): readonly ValueSetFinding[] {
  const findings: ValueSetFinding[] = [];
  const keyOf = (table: string, column: string): string => `${table}.${column}`;

  const valueSets = new Map(input.valueSets.map((v) => [keyOf(v.table, v.column), v]));
  const byPackage = new Map<string, WorkspaceDomain[]>();
  for (const domain of input.domains) {
    const key = `${domain.package}:${domain.name}`;
    byPackage.set(key, [...(byPackage.get(key) ?? []), domain]);
  }
  const exactly = new Map<string, WorkspaceDomain[]>();
  for (const domain of input.domains) {
    const key = [...new Set(domain.members)].sort().join("\u0001");
    exactly.set(key, [...(exactly.get(key) ?? []), domain]);
  }
  const symbols = new Map<string, SymbolDeclaration[]>();
  for (const symbol of input.symbols) {
    const key = `${symbol.package}:${symbol.name}`;
    symbols.set(key, [...(symbols.get(key) ?? []), symbol]);
  }

  const seen = new Set<string>();
  for (const declaration of input.declarations) {
    const key = keyOf(declaration.table, declaration.column);
    if (seen.has(key)) {
      findings.push({
        kind: "duplicate_declaration",
        table: declaration.table,
        column: declaration.column,
        detail: "declared twice; which link governs the column would depend on array order",
      });
      continue;
    }
    seen.add(key);

    const valueSet = valueSets.get(key);
    if (valueSet === undefined) {
      findings.push({
        kind: input.checkedColumns.has(key) ? "not_a_value_set" : "unknown_column",
        table: declaration.table,
        column: declaration.column,
        detail: input.checkedColumns.has(key)
          ? "the column's CHECK does not enumerate its domain, so there is nothing to compare"
          : "no such column in META_TABLES, or it declares no CHECK",
      });
      continue;
    }

    const catalogued = new Set(valueSet.values);

    if (declaration.link === "catalog_only") {
      const contradicting = exactly.get([...catalogued].sort().join("\u0001")) ?? [];
      if (contradicting.length > 0) {
        findings.push({
          kind: "catalog_only_contradicted",
          table: declaration.table,
          column: declaration.column,
          detail: `declared as having no contract domain, but ${contradicting
            .map((d) => `${d.package}:${d.name}`)
            .join(", ")} enumerates exactly this CHECK`,
        });
      }
      continue;
    }

    const ref = declaration.ref === null ? null : parseRef(declaration.ref);
    if (ref === null) {
      findings.push({
        kind: "ref_unresolved",
        table: declaration.table,
        column: declaration.column,
        detail: `ref ${JSON.stringify(declaration.ref)} is not <package>:<name>`,
      });
      continue;
    }
    const candidates = byPackage.get(`${ref.package}:${ref.name}`) ?? [];
    if (candidates.length === 0) {
      findings.push({
        kind: "ref_unresolved",
        table: declaration.table,
        column: declaration.column,
        detail: `${ref.package} declares no domain named ${ref.name}`,
      });
      continue;
    }
    if (candidates.length > 1) {
      findings.push({
        kind: "ref_ambiguous",
        table: declaration.table,
        column: declaration.column,
        detail: `${ref.package}:${ref.name} is declared in ${candidates
          .map((c) => `${c.file}:${c.line}`)
          .join(", ")}`,
      });
      continue;
    }
    const domain = candidates[0];
    if (domain === undefined) continue;

    const except = new Set(declaration.except ?? []);
    const members = new Set(domain.members);
    const stale = [...except].filter((v) => !members.has(v));
    if (stale.length > 0) {
      findings.push({
        kind: "narrowing_stale",
        table: declaration.table,
        column: declaration.column,
        detail: `except names ${stale.join(", ")}, which ${ref.package}:${ref.name} does not declare`,
      });
    }

    const emitted = [...members].filter((v) => !except.has(v));
    const excess = emitted.filter((v) => !catalogued.has(v));
    if (excess.length > 0) {
      findings.push({
        kind: "contract_exceeds_catalog",
        table: declaration.table,
        column: declaration.column,
        detail: `${ref.package}:${ref.name} can emit ${excess
          .map((v) => JSON.stringify(v))
          .join(", ")}, which the CHECK refuses; widen the CHECK, or declare a narrows link naming what enforces the exclusion`,
      });
    }
    const unemitted = [...catalogued].filter((v) => !emitted.includes(v));
    if (unemitted.length > 0) {
      findings.push({
        kind: "catalog_exceeds_contract",
        table: declaration.table,
        column: declaration.column,
        detail: `the CHECK admits ${unemitted
          .map((v) => JSON.stringify(v))
          .join(", ")}, which ${ref.package}:${ref.name} does not emit`,
      });
    }

    if (declaration.guardedBy !== undefined) {
      const guard = parseRef(declaration.guardedBy);
      const declarations = guard === null ? [] : (symbols.get(`${guard.package}:${guard.name}`) ?? []);
      if (declarations.length === 0) {
        findings.push({
          kind: "guard_unproven",
          table: declaration.table,
          column: declaration.column,
          detail: `guardedBy ${JSON.stringify(declaration.guardedBy)} names no exported symbol`,
        });
      } else {
        const text = declarations.map((d) => d.text).join("\n");
        const unmentioned = [...except].filter(
          (v) => !text.includes(`"${v}"`) && !text.includes(`'${v}'`),
        );
        if (unmentioned.length > 0) {
          findings.push({
            kind: "guard_unproven",
            table: declaration.table,
            column: declaration.column,
            detail: `${declaration.guardedBy} does not name ${unmentioned.join(", ")}, so nothing shown here refuses ${unmentioned.length === 1 ? "it" : "them"}`,
          });
        }
      }
    }
  }

  for (const valueSet of input.valueSets) {
    const key = keyOf(valueSet.table, valueSet.column);
    if (seen.has(key)) continue;
    findings.push({
      kind: "undeclared",
      table: valueSet.table,
      column: valueSet.column,
      detail: `CHECK enumerates ${valueSet.values.length} value(s) and nothing says which contract domain governs them`,
    });
  }

  return findings;
}

export function formatValueSetFindings(findings: readonly ValueSetFinding[]): string {
  return findings.map((f) => `[${f.kind}] ${f.table}.${f.column}: ${f.detail}`).join("\n");
}

/* ------------------------------------------------- the zero-declaration half */

export const ColumnDefaultFindingSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  defaultExpression: z.string().min(1),
  detail: z.string().min(1),
});
export type ColumnDefaultFinding = z.infer<typeof ColumnDefaultFindingSchema>;

/**
 * Whether each column's own `default` satisfies its own `check` — the one question in this class
 * that needs no declaration, because both halves are in the same declaration.
 *
 * A default the column's CHECK refuses makes every `INSERT` that omits the column raise `23514`,
 * which for a NOT NULL column means the table cannot be written at all. It passes today for all 287
 * value sets, and that is the cheapest moment a check like this will ever have
 * (`pg-storeless-tables.ts`'s argument, one question across).
 *
 * A non-literal default — `now()`, `uuid_generate_v7()`, a cast — is out of scope rather than a
 * finding: evaluating it means evaluating SQL, which is `check-admission.ts`'s job against a live
 * database and cannot be done from text.
 */
export function auditColumnDefaults(
  valueSets: readonly CatalogValueSet[],
): readonly ColumnDefaultFinding[] {
  const findings: ColumnDefaultFinding[] = [];
  for (const valueSet of valueSets) {
    const expression = valueSet.defaultExpression;
    if (expression === null) continue;
    const literal = sqlLiteral(expression);
    if (literal === null) continue;
    if (valueSet.values.includes(literal)) continue;
    findings.push({
      table: valueSet.table,
      column: valueSet.column,
      defaultExpression: expression,
      detail: `default ${expression} is not one of ${valueSet.values.map((v) => `'${v}'`).join(", ")}, so an INSERT omitting the column raises 23514`,
    });
  }
  return findings;
}

export function formatColumnDefaultFindings(
  findings: readonly ColumnDefaultFinding[],
): string {
  return findings
    .map((f) => `${f.table}.${f.column} default ${f.defaultExpression}: ${f.detail}`)
    .join("\n");
}
