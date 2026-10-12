import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { PG_SCAN_EXEMPT_PACKAGE_DIRS, stripComments } from "./pg-column-coverage.js";
import { blankStringBodies } from "./pg-record-reads.js";
import { REPO_ROOT, readWorkspaceSources, workspaceRoots } from "./workspace-sql-scan.js";

/**
 * The rule: **no function that holds a manifest `Entity` may read `entity.fields` without saying
 * what the narrower answer loses.**
 *
 * An entity's own `fields` are not the fields its served table has. A trait contributes more, and
 * `resolvedFields(entity, customTraits)` is the one answer to "which fields does this entity resolve
 * to" — its own doc comment says it is "shared by `validateManifest`'s reference checks and by the
 * serving store's column plan, so validation cannot say a field exists that the served table has no
 * column for". So a reader of `entity.fields` is asking a **narrower question than the emitted table
 * answers**. Sometimes that is the correct question. Usually it is a blind spot nobody declared, and
 * the assertion is not "every reader resolves". It is:
 *
 *   **no raw reader exists without a declaration naming its direction.**
 *
 * **The direction is the point.** It is what decides whether a member is a defect or a decision, and
 * the three are not interchangeable:
 *
 *  - `fails_open` — a safety property is lost. A classified trait field served unredacted, a write
 *    mask that does not cover it, a refusal that does not fire. These are defects.
 *  - `fails_closed` — the field is omitted or refused, so nothing unsafe happens. A completeness
 *    loss, and the one direction that can be a deliberate decision.
 *  - `incomplete` — neither: a capability the trait field simply does not get.
 *
 * The class was found by hand after the ranked register named three members, all three in the
 * *authorization* layer: response redaction (`fails_open` — a trait-contributed classified field
 * yielded no spec and was served in the clear), the write mask (`fails_open` — not a candidate, so
 * writable by anybody), and the audit trail's field lookup (`fails_closed`, and documented). The
 * first two are fixed. This rule exists because **the other twelve were invisible**, and because
 * the mechanism that hid them is still in place: a narrow read needs no workaround and a wide one
 * does, so the narrow read is what gets written.
 *
 * **Why every member has zero live members on every shipped pack.** All seven packs declare *zero*
 * custom traits, and none of the eight built-in trait fields carries a classification. So this class
 * is reachable only from an **authored** manifest — the platform's headline Architect feature — which
 * is exactly why it wants a rule rather than a comment: there is no deployment today whose failure
 * would teach anybody that these readers are narrow.
 *
 * **Scope: a typed read on an `Entity`-typed binding.** Two populations exist and only one is here.
 * `apps/operate-server`'s `manifest-view.ts`, `design-review.ts` and `tenant-manifests.ts` project a
 * manifest from `Record<string, unknown>` and read `entity["fields"]` by bracket access — they never
 * hold an `Entity`, have no `Trait[]` in hand, and *cannot* call the resolver, so they are blocked by
 * shape rather than by wiring. That is `pg-unreachable-stores.ts`' distinction between
 * `prerequisite_of_unbuilt_surface` and `contract_cannot_carry_the_surface`, and its argument applies
 * unchanged: calling both "narrow" sends the next person to write a call that cannot be written. They
 * are named in `PROJECTED_MANIFEST_READERS` with their count, and detecting them needs a different
 * predicate (a bracket read on an untyped record), which would have different precision and wants its
 * own rule.
 *
 * **Why the anchor is the type and not the receiver's name.** `.fields` is a property on a dozen
 * unrelated things here — `EntityPermissions`, `ListQuery`, `ListConfig`, `ListSearch`, `EntityView`,
 * `UiEntitySchema`, `EntityClassification`, an index definition, a drift record, a PHI decision — so a
 * bare `\.fields\b` scan is mostly false positives. Measured on the real workspace: **84** reads of
 * that shape, **19** of them on an `Entity`-typed binding, so the naive scan is **23%** precise and
 * this one is 100% on a population verified by hand. (It was 89 and 21 earlier in the same increment,
 * before a sibling change routed `list-query.ts`' three field sets through one resolver. Re-measure
 * the census rather than reading the figure — it is the test that enforces the ratio, not this
 * sentence.) The 25 reads in `apps/operate-web` are the sharpest reason: every one is
 * `UiEntitySchema`-typed, and they are narrow only as a *consequence* of `buildUiSchema` being
 * narrow — downstream of a member, not members.
 */

/* ---------------------------------------------------------------- directions */

export const FIELD_APERTURE_DIRECTIONS = [
  /** A safety property is lost: something is disclosed, writable, or unrefused. A defect. */
  "fails_open",
  /** The field is omitted or refused. Nothing unsafe happens; a completeness loss. */
  "fails_closed",
  /** Neither. A capability the trait-contributed field does not get. */
  "incomplete",
] as const;
export type FieldApertureDirection = (typeof FIELD_APERTURE_DIRECTIONS)[number];

/**
 * The two directions that must state what a trait field loses.
 *
 * `pg-storeless-tables.ts`' `CONSEQUENCE_BEARING_REASONS` for its reason: a field that may ride along
 * on any member is a field that can be forgotten. A gap cannot be parked without saying what a
 * deployment does not get.
 */
export const CONSEQUENCE_BEARING_DIRECTIONS: readonly FieldApertureDirection[] = [
  "fails_open",
  "incomplete",
];

/**
 * The one direction that must state what is dropped, and why dropping it is safe.
 *
 * Deliberately a *different* field from `consequence` rather than the same one reused. A
 * `fails_closed` declaration is making a safety claim — "the field is omitted, and that is fine" —
 * and a claim is what a reviewer must check. Sharing one field with the two gap directions would let
 * a safety argument be written in the slot reserved for a cost.
 */
export const DROPPED_BEARING_DIRECTIONS: readonly FieldApertureDirection[] = ["fails_closed"];

/* -------------------------------------------------------------- declarations */

/** A member directory: `packages/<name>` or `apps/<name>`. */
const MEMBER_DIR = /^(?:packages|apps)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * A workspace-relative source path.
 *
 * The `..` guard leads, as in `pg-unreachable-stores.ts`: the segment class has to admit `.` for the
 * extension and `-` for a hyphenated name, which admits `..` as a whole segment — so a declaration
 * could name a file in another member while passing every per-member check below it.
 *
 * `[` and `]` are admitted because `apps/operate-web` is a Next app and `app/e/[slug]/page.tsx` is an
 * ordinary path there. Found by mutation rather than by reading: widening the anchor to the refused
 * structural spelling made the scan **throw** on `ApertureReaderSchema.parse` instead of reporting,
 * because the first read it then admitted was in a dynamic route segment. A fence that crashes when
 * it finds something is worse than one that misses it, since the crash is what gets reverted.
 */
const WORKSPACE_PATH =
  /^(?!.*\.\.)(?:packages|apps)\/[A-Za-z0-9_.[\]-]+(?:\/[A-Za-z0-9_.[\]-]+)*\.tsx?$/;
/**
 * A function name, or `<module>` for a read at module scope.
 *
 * PascalCase is admitted, and for the same reason the path regex admits `[`: a React component is a
 * function, so `SchemaView` and `EntityBlock` in `apps/operate-web` are legitimate symbols. Found by
 * the same mutation, one parse field later — a lowercase-only rule crashed the scan the moment the
 * anchor admitted a read there, so the two together were a fence that could only pass.
 */
const SYMBOL = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|<module>)$/;

export const ApertureDeclarationSchema = z
  .object({
    /** The member directory the file belongs to, asserted against the file path. */
    pkg: z.string().regex(MEMBER_DIR),
    /** Workspace-relative, POSIX-separated. */
    file: z.string().regex(WORKSPACE_PATH),
    /** The enclosing function that performs the read. */
    symbol: z.string().regex(SYMBOL),
    direction: z.enum(FIELD_APERTURE_DIRECTIONS),
    /** What a trait-contributed field loses, in one sentence an operator could act on. */
    consequence: z.string().min(20).optional(),
    /** What is dropped, and why dropping it is safe. `fails_closed` only. */
    dropped: z.string().min(20).optional(),
    /** The evidence: what the function does, whether its own caller exists, what resolving it costs. */
    note: z.string().min(20),
  })
  .superRefine((value, ctx) => {
    const wants = (set: readonly FieldApertureDirection[]): boolean => set.includes(value.direction);
    if (wants(CONSEQUENCE_BEARING_DIRECTIONS) !== (value.consequence !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["consequence"],
        message:
          `only a fails_open or incomplete declaration may state a consequence, and it must state ` +
          `one (${value.direction})`,
      });
    }
    if (wants(DROPPED_BEARING_DIRECTIONS) !== (value.dropped !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dropped"],
        message:
          `only a fails_closed declaration may say what is dropped, and it must say what and why ` +
          `that is safe (${value.direction})`,
      });
    }
    if (!value.file.startsWith(`${value.pkg}/`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file"],
        message: `${value.file} is not inside ${value.pkg}`,
      });
    }
  });
export type ApertureDeclaration = z.infer<typeof ApertureDeclarationSchema>;

/**
 * `packages/operate-runtime/src/defaults.ts::literalDefaultPlans`.
 *
 * Named `readerSubjectOf` and not `subjectOf` because `pg-unreachable-stores.ts` already exports that
 * name for a different subject, and `strategy/index.ts` re-exports both with `export *` — so the
 * short name is a compile error rather than a silent shadow. ADR-0354's bare-name lesson, arriving
 * on an export list.
 */
export function readerSubjectOf(declaration: { readonly file: string; readonly symbol: string }): string {
  return `${declaration.file}::${declaration.symbol}`;
}

/* --------------------------------------------------------------------- facts */

/**
 * How a reader is accounted for.
 *
 * `trait_aware` is not a courtesy. A function whose own signature takes the trait contribution —
 * `checkEntityFieldNames(entity, traitFields)` — is reading `entity.fields` in order to **compare** it
 * against the wide half it was handed, and resolving it would make every entity with a trait collide
 * with itself. The wide answer is visible in the same signature, so the narrow read is a choice made
 * with both in view, which is what a declaration exists to establish. Measured: the exemption has
 * exactly the members it should, and none of the six `operate-runtime` readers takes such a parameter.
 */
export const READER_ACCOUNTINGS = ["raw", "resolver_called", "trait_aware"] as const;
export type ReaderAccounting = (typeof READER_ACCOUNTINGS)[number];

/** How the receiver was shown to hold an `Entity`. Both are type facts, never name heuristics. */
export const APERTURE_BINDINGS = ["annotation", "manifest_rooted"] as const;
export type ApertureBinding = (typeof APERTURE_BINDINGS)[number];

export const ApertureReaderSchema = z.object({
  pkg: z.string().regex(MEMBER_DIR),
  file: z.string().regex(WORKSPACE_PATH),
  symbol: z.string().regex(SYMBOL),
  /** The identifier the read was performed on, e.g. `entity`. */
  receiver: z.string().min(1),
  binding: z.enum(APERTURE_BINDINGS),
  /** How the binding was resolved, for the record: `entity:Entity`, `manifest:Manifest`. */
  detail: z.string().min(1),
  /** Every line in this function that reads it, ascending. */
  lines: z.array(z.number().int().positive()).min(1),
  accounting: z.enum(READER_ACCOUNTINGS),
});
export type ApertureReader = z.infer<typeof ApertureReaderSchema>;

/* ------------------------------------------------------------------ findings */

export const APERTURE_FINDING_KINDS = [
  /** A raw reader with no declaration. **This is the fence.** */
  "undeclared",
  /**
   * Declared, and the reader now resolves. The decision is overtaken; **delete the line.**
   *
   * ADR-0336 and ADR-0337 both found that the fix for an overtaken declaration is deletion rather
   * than weakening the check, and ADR-0337's own increment produced five of them.
   */
  "overtaken",
  /** Declared for a file the scan did not read — moved, renamed, or outside the walk. */
  "unknown_file",
  /** Declared for a symbol that file no longer has a raw reader in. */
  "unknown_symbol",
  /** Declared twice, which would let two contradictory directions both pass. */
  "duplicate",
] as const;
export type ApertureFindingKind = (typeof APERTURE_FINDING_KINDS)[number];

export interface ApertureFinding {
  readonly kind: ApertureFindingKind;
  readonly subject: string;
  readonly detail: string;
}

export interface ApertureAuditInput {
  readonly readers: readonly ApertureReader[];
  readonly declarations: readonly ApertureDeclaration[];
  /** Every file the scan read, so `unknown_file` is a fact rather than an inference. */
  readonly scannedFiles: readonly string[];
  /** The functions each file declares, so `unknown_symbol` is a fact too. */
  readonly symbolsByFile: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Both directions of the rule. An empty array is the invariant holding.
 *
 * `undeclared` is phrased from the workspace's side and `overtaken` / `unknown_*` from the
 * declaration's, so the list is pinned both ways — the property ADR-0288's `needsAuditEmitter` lacked
 * and the reason ADR-0334 concluded that *location* was never what made that list wrong.
 */
export function auditEntityFieldAperture(
  input: ApertureAuditInput,
): readonly ApertureFinding[] {
  const { readers, declarations, scannedFiles, symbolsByFile } = input;
  const raw = new Map<string, ApertureReader>();
  for (const reader of readers) {
    if (reader.accounting === "raw") raw.set(readerSubjectOf(reader), reader);
  }
  const scanned = new Set(scannedFiles);
  const findings: ApertureFinding[] = [];
  const seen = new Set<string>();

  for (const declaration of declarations) {
    const subject = readerSubjectOf(declaration);
    if (seen.has(subject)) {
      findings.push({
        kind: "duplicate",
        subject,
        detail: `${subject} is declared more than once, so two directions would both pass`,
      });
      continue;
    }
    seen.add(subject);

    if (!scanned.has(declaration.file)) {
      findings.push({
        kind: "unknown_file",
        subject,
        detail:
          `${declaration.file} is declared and the scan did not read it — the file moved, was ` +
          `renamed, or its member left the walk`,
      });
      continue;
    }
    if (raw.has(subject)) continue;
    const symbols = symbolsByFile.get(declaration.file) ?? new Set<string>();
    findings.push(
      symbols.has(declaration.symbol) || declaration.symbol === "<module>"
        ? {
            kind: "overtaken",
            subject,
            detail:
              `${subject} is declared ${declaration.direction} and no longer reads an Entity's own ` +
              `fields raw — the decision is overtaken; delete the declaration`,
          }
        : {
            kind: "unknown_symbol",
            subject,
            detail:
              `${declaration.file} declares no function named ${declaration.symbol} — it was renamed ` +
              `or removed, so the declaration describes nothing`,
          },
    );
  }

  for (const [subject, reader] of [...raw].sort(([a], [b]) => a.localeCompare(b))) {
    if (seen.has(subject)) continue;
    findings.push({
      kind: "undeclared",
      subject,
      detail:
        `${subject} holds an Entity (${reader.detail}) and reads its own .fields at line${
          reader.lines.length === 1 ? "" : "s"
        } ${reader.lines.join(", ")} without resolving its traits, and no declaration says what that ` +
        `loses. Call resolvedFields/resolvedClassifiedFields, or add an ENTITY_FIELD_APERTURE line ` +
        `with a direction.`,
    });
  }

  return findings;
}

export function formatApertureFindings(findings: readonly ApertureFinding[]): string {
  return findings.map((f) => `[${f.kind}] ${f.detail}`).join("\n");
}

export function countByDirection(
  declarations: readonly ApertureDeclaration[],
): ReadonlyMap<FieldApertureDirection, number> {
  const counts = new Map<FieldApertureDirection, number>();
  for (const direction of FIELD_APERTURE_DIRECTIONS) counts.set(direction, 0);
  for (const declaration of declarations) {
    counts.set(declaration.direction, (counts.get(declaration.direction) ?? 0) + 1);
  }
  return counts;
}

/** The declared `fails_open` members — the subset that are defects rather than decisions. */
export function openFailures(
  declarations: readonly ApertureDeclaration[],
): readonly ApertureDeclaration[] {
  return declarations
    .filter((d) => d.direction === "fails_open")
    .slice()
    .sort((a, b) => readerSubjectOf(a).localeCompare(readerSubjectOf(b)));
}

/* ------------------------------------------------------------------ the scan */

/**
 * The resolution calls that make a read wide.
 *
 * `resolvedFieldNames` and `expandTraits` are here beside the two the brief names because all four
 * put the trait contribution in the function's hands.
 */
export const RESOLUTION_CALLS: readonly string[] = Object.freeze([
  "resolvedFields",
  "resolvedClassifiedFields",
  "resolvedFieldNames",
  "expandTraits",
]);

/**
 * The trait map itself, which `resolvedFields` reads and which a reader consulting directly has
 * plainly not forgotten traits exist.
 *
 * Separate from `RESOLUTION_CALLS` rather than appended to it, because it is matched as a bare
 * identifier and they are matched as calls — one joined alternation would have had to patch the
 * difference back out of its own output, and `kernel/src/ddl/resolution.ts` reaches it as
 * `BUILT_IN_TRAIT_FIELDS.get(traitName)`, which no `\\s*\\(` arm matches.
 */
export const RESOLUTION_CONSTANTS: readonly string[] = Object.freeze(["BUILT_IN_TRAIT_FIELDS"]);

const RESOLVER_RE = new RegExp(
  [
    ...RESOLUTION_CALLS.map((call) => `\\b${call}\\s*\\(`),
    ...RESOLUTION_CONSTANTS.map((name) => `\\b${name}\\b`),
  ].join("|"),
);

/** A signature parameter carrying the trait contribution. */
const TRAIT_PARAMETER = /\b(?:traitFields|customTraits|traits)\s*\??\s*:/;

/**
 * The generalisations measured and refused, kept beside their counts so nobody attempts them again.
 *
 * `pg-binding-names.ts`' `REFUSED_DERIVATIONS` shape. Each of these produced a confident wrong answer
 * first, which is the only reason they are worth writing down.
 */
export const REFUSED_ANCHORS: readonly {
  readonly anchor: string;
  readonly refutation: string;
}[] = Object.freeze([
  {
    anchor: "any `<receiver>.fields` read",
    refutation:
      "84 reads of that shape in the workspace and 19 on an Entity: 23% precise, with 65 rejected by " +
      "the type anchor. `.fields` is a property on EntityPermissions, UiEntitySchema, EntityView, " +
      "ListQuery, ListConfig, ListSearch, EntityClassification, CrudOpts, EntityPermissionSet, an " +
      "index definition, a drift record and a PHI decision.",
  },
  {
    anchor: "a receiver named `entity` / `ent` / `e`",
    refutation:
      "`apps/operate-web` reads `entity.fields` 11 times on a `UiEntitySchema`, and " +
      "`apps/operate-server/src/manifest-diff.ts` names a `ManifestEntity` `entity` in one function " +
      "and reads a permissions record in another. The name is the same on both sides of the question.",
  },
  {
    anchor: "the first `<name>: <Type>` annotation anywhere in the file",
    refutation:
      "ADR-0354's bare-name defect, reproduced here before it was fixed: `manifest-diff.ts` annotates " +
      "`entity: ManifestEntity` in three functions and `entity` is a plain string elsewhere, so a " +
      "file-wide lookup attributed a read to whichever annotation was scanned first. The lookup is " +
      "scoped to the enclosing function.",
  },
  {
    anchor: "any `for (const x of <...>.entities)` iteration",
    refutation:
      "Type-blind, and wrong in the direction that invents members: 2 of the workspace's iterations are " +
      "over a `UiSchema`'s `schema.entities` and a dashboard's `group.entities`, and admitting them " +
      "would have reported 2 members that do not exist while vouching for the other 23 " +
      "`operate-web` reads beside them. The collection's **root identifier** must itself be " +
      "annotated `Manifest`/`ResolvedManifest`, or inline as `{ entities?: readonly Entity[] }`.",
  },
  {
    anchor: "a structural `interface X { readonly name: string; fields?: ... }` spelling",
    refutation:
      "Meant to catch `EntityLike`, the structural `{name, fields?}` re-spelling of an entity that " +
      "`validation.ts` declares (and `list-query.ts` did, until a sibling change in this same " +
      "increment deleted it). It admitted `EntityView` and `UiEntitySchema` — 2 false positives for " +
      "0 true positives, because the EntityLike reader is already reached as `manifest_rooted` " +
      "through `manifest.entities`.",
  },
]);

/**
 * The second population, named rather than detected.
 *
 * These project a manifest from `Record<string, unknown>` and read `entity["fields"]` by bracket
 * access. They hold no `Entity` and no `Trait[]`, so they cannot call the resolver: blocked by shape,
 * not by wiring. Listed with the count so the boundary is a measurement, and asserted to still read
 * that way — if one of them starts holding a typed `Entity` it becomes a member of this rule and the
 * test says so.
 */
export const PROJECTED_MANIFEST_READERS: readonly string[] = Object.freeze([
  "apps/operate-server/src/design-review.ts",
  "apps/operate-server/src/manifest-view.ts",
  "apps/operate-server/src/tenant-manifests.ts",
]);

interface FunctionSpan {
  readonly name: string;
  readonly start: number;
  readonly signatureEnd: number;
  readonly end: number;
}

function skipString(code: string, from: number): number {
  const quote = code[from];
  let i = from + 1;
  while (i < code.length) {
    const ch = code[i];
    i += 1;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) break;
  }
  return i;
}

/** The index just past the `}` that closes the body opening at `openBrace`. */
function bodyEnd(code: string, openBrace: number): number {
  let depth = 0;
  let i = openBrace;
  while (i < code.length) {
    const ch = code[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return code.length;
}

const DECLARATION =
  /(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]|(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?(?:function\s*\*?\s*[(<]|[(<])/g;

/**
 * Every named function in a module, with its signature and body spans.
 *
 * Hand-written rather than reaching for the compiler API, which ADR-0337 measured and refused twice:
 * 26 s and 1.2 GB for one program, and cross-package symbols resolving into `dist`, so the rule would
 * be green only after a build and green against a stale one. A nested arrow callback is deliberately
 * *not* its own span — a `.fields` read inside `entity.fields.map((f) => …)` belongs to the function
 * that holds the entity, which is the unit a declaration is written against.
 */
export function functionSpans(code: string): readonly FunctionSpan[] {
  const out: FunctionSpan[] = [];
  for (const match of code.matchAll(DECLARATION)) {
    const name = match[1] ?? match[2] ?? "";
    if (name === "") continue;
    let i = match.index + match[0].length - 1;
    let depth = 0;
    let open = -1;
    while (i < code.length) {
      const ch = code[i] ?? "";
      if (ch === '"' || ch === "'" || ch === "`") {
        i = skipString(code, i);
        continue;
      }
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      else if (ch === "{" && depth <= 0) {
        open = i;
        break;
      } else if (ch === ";" && depth <= 0) break;
      i += 1;
    }
    if (open < 0) continue;
    out.push({ name, start: match.index, signatureEnd: open, end: bodyEnd(code, open) });
  }
  return out;
}

const QUOTE_META = /[.*+?^${}()|[\]\\]/g;
const alternation = (names: Iterable<string>): string =>
  [...names].map((n) => n.replace(QUOTE_META, "\\$&")).join("|");

/**
 * Every spelling of the manifest entity type in one module.
 *
 * The nominal `Entity` plus any file-local alias of the indexed-access form —
 * `type ManifestEntity = NonNullable<Manifest["entities"]>[number]`, which `manifest-diff.ts` and
 * `refusal.ts` both declare. A scan anchored on the token `Entity` alone misses three readers, and
 * the brief's own candidate list named two of them.
 */
export function entitySpellings(code: string): ReadonlySet<string> {
  const names = new Set<string>();
  if (/\bEntity\b/.test(code)) names.add("Entity");
  const indexed =
    /type\s+([A-Za-z_$][\w$]*)\s*=\s*(?:NonNullable<\s*)?[A-Za-z_$][\w$]*\[["']entities["']\]\s*>?\s*\[\s*number\s*\]/g;
  for (const match of code.matchAll(indexed)) names.add(match[1] ?? "");
  names.delete("");
  return names;
}

/** Every spelling of the manifest type, so a collection's root can be checked against it. */
export function manifestSpellings(code: string): ReadonlySet<string> {
  const names = new Set<string>(["Manifest", "ResolvedManifest"]);
  for (const match of code.matchAll(/type\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Resolved)?Manifest\b/g)) {
    names.add(match[1] ?? "");
  }
  names.delete("");
  return names;
}

/**
 * A `.fields` or `?.fields` read.
 *
 * The optional-chaining arm is not decoration: `manifest-diff.ts` reads `entity?.fields ?? []` twice,
 * and a matcher without it missed both — two members the brief had named by line number.
 */
const FIELD_READ = /\b([A-Za-z_$][\w$]*)\s*\??\.\s*fields\b/g;

/** Why the type anchor declined a read of the `.fields` shape. */
export const APERTURE_REJECTIONS = [
  /** The receiver is annotated with some other type: `EntityPermissions`, `UiEntitySchema`, … */
  "foreign_type",
  /** No annotation and no manifest-rooted binding in scope — a `v` in a `superRefine`, say. */
  "unresolved_binding",
  /** Bound from an `.entities` collection whose root is not a manifest: a `UiSchema`, a dashboard. */
  "root_not_a_manifest",
] as const;
export type ApertureRejection = (typeof APERTURE_REJECTIONS)[number];

export interface RejectedRead {
  readonly file: string;
  readonly line: number;
  readonly receiver: string;
  readonly reason: ApertureRejection;
  readonly detail: string;
}

export interface ApertureScan {
  readonly files: number;
  readonly readers: readonly ApertureReader[];
  readonly scannedFiles: readonly string[];
  /**
   * The named functions each scanned file declares.
   *
   * Carried so `unknown_symbol` is a fact rather than an inference. Without it the audit had to guess
   * from "does this file still hold any Entity-typed reader", which answers `unknown_symbol` for a
   * file that was *fixed* — and that happened within this increment, when a sibling change made
   * `list-query.ts` resolve its traits: the correct finding is `overtaken`, whose remedy is deleting
   * the declaration, and the message it got instead said the function had been removed.
   */
  readonly symbolsByFile: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Reads of the `.fields` shape the type anchor rejected, with why.
   *
   * Returned rather than discarded, for `workspace-sql-scan.ts`' stated reason: a scan with a silent
   * "not interested" bucket is the next member of this defect's class, and here the bucket is **three
   * times the size of the population**, so it is where a widening or a narrowing of the anchor would
   * show up first.
   */
  readonly rejected: readonly RejectedRead[];
  readonly unhandledGlobs: readonly string[];
}

function sourceFilesUnder(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) sourceFilesUnder(absolute, out);
    else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(absolute);
    }
  }
}

/**
 * The members `readWorkspaceSources()` cannot reach, read here rather than by widening the shared
 * walk.
 *
 * That walk requires a `src/`, and `apps/operate-web` has none — so the nine rules that use it are
 * all blind to a 41-file Next app, which ADR-0337 named as a hole and answered with its own walk. The
 * same answer here, and for a reason specific to this rule: `operate-web` holds **25** `.fields`
 * reads, every one on a `UiEntitySchema`, so it is the single largest population the type anchor has
 * to reject. Reading it is what makes that rejection a measurement instead of an accident of the
 * walk. `packages/config` is the other such member and is JSON only.
 */
interface ScannedSource {
  readonly pkg: string;
  readonly file: string;
  readonly text: string;
}

function srclessMemberSources(): readonly ScannedSource[] {
  const out: ScannedSource[] = [];
  for (const root of workspaceRoots().roots) {
    const rootDir = join(REPO_ROOT, root);
    if (!existsSync(rootDir)) continue;
    for (const entry of readdirSync(rootDir)) {
      const dir = `${root}/${entry}`;
      if (existsSync(join(REPO_ROOT, dir, "src"))) continue;
      if (!statSync(join(REPO_ROOT, dir)).isDirectory()) continue;
      const absolute: string[] = [];
      sourceFilesUnder(join(REPO_ROOT, dir), absolute);
      for (const file of absolute) {
        out.push({
          pkg: dir,
          file: file.slice(REPO_ROOT.length + 1),
          text: readFileSync(file, "utf8"),
        });
      }
    }
  }
  return out;
}

/**
 * Reads the real workspace and resolves every `.fields` read to a reader or a rejection.
 *
 * Impure by itself, following `typecheck-config.ts`' split: the rule above is a pure function over
 * these facts, and the disk is read in one place. **Comments are stripped before anything is
 * believed** — ADR-0337's own widened scan read a doc comment containing a literal construction site
 * as a real one, and five of the 88 raw matches here are prose, including the sentence in
 * `manifest-redaction.ts` that explains why `entity.fields` is the wrong read.
 */
export function scanEntityFieldApertures(): ApertureScan {
  const { files: packaged, unhandledGlobs } = readWorkspaceSources();
  const all: readonly ScannedSource[] = [
    // `readWorkspaceSources` names the owning package `package`; this rule's declarations name the
    // member *directory*, which is what a path can be checked against, so it is derived from the file.
    ...packaged.map((f) => ({
      pkg: f.file.split("/").slice(0, 2).join("/"),
      file: f.file,
      text: f.text,
    })),
    ...srclessMemberSources(),
  ];
  const readers: ApertureReader[] = [];
  const scannedFiles: string[] = [];
  const rejected: RejectedRead[] = [];
  const symbolsByFile = new Map<string, ReadonlySet<string>>();
  /**
   * `packages/testing`, as the SQL rules exempt it.
   *
   * `readWorkspaceSources` deliberately does not apply this list, because a package with no Postgres
   * store can still export the enum a catalogued CHECK is about. Here it is applied, and the reason is
   * narrower than convention: this member holds the rule, so every declaration's prose names the very
   * shape the scan looks for. String blanking already stops the prose matching; the exemption is what
   * stops *this file's own fixtures and regexes* being a population nobody declared.
   */
  const exempt = new Set(PG_SCAN_EXEMPT_PACKAGE_DIRS);

  for (const source of all) {
    if (exempt.has(source.pkg)) continue;
    scannedFiles.push(source.file);
    const analysed = analyzeModuleApertures(source);
    readers.push(...analysed.readers);
    rejected.push(...analysed.rejected);
    symbolsByFile.set(source.file, analysed.symbols);
  }

  return { files: all.length, readers, scannedFiles, symbolsByFile, rejected, unhandledGlobs };
}

/**
 * One module's readers and rejections. Pure, so the rule can be exercised on a source string.
 *
 * Separated from the walk for `typecheck-config.ts`' reason — the shape is decided in a function that
 * reads nothing and the disk is touched in one place — and because the negative control needs it: a
 * rule whose liveness can only be demonstrated against the workspace it is asserting on has no way to
 * show that it would *report* a defect, only that it currently finds none.
 */
export function analyzeModuleApertures(source: ScannedSource): {
  readonly readers: readonly ApertureReader[];
  readonly rejected: readonly RejectedRead[];
  readonly symbols: ReadonlySet<string>;
} {
  const readers: ApertureReader[] = [];
  const rejected: RejectedRead[] = [];
  const symbols = new Set<string>();
  if (source.text.includes(".fields")) {
    // Two views of one file, at identical offsets, and the split is load-bearing in both directions.
    //
    // `declared` is comment-stripped only. A *type* legitimately contains a string literal —
    // `type ManifestEntity = NonNullable<Manifest["entities"]>[number]` is how `manifest-diff.ts` and
    // `refusal.ts` both spell the entity — so blanking strings before extracting spellings loses it,
    // and with it two real members. Measured: it did, and they left the census as `foreign_type`.
    //
    // `code` is additionally string-blanked, and everything matched as *code* is matched on it: the
    // reads, the spans, the annotations and the resolver test. Found by running this rule against the
    // workspace that contains it — `stripComments` copies a string's body verbatim by design, so the
    // sentence "reads `entity.fields`" in a declaration's own `note` matched as a read and the rule
    // reported itself. `blankStringBodies` preserves offsets and newlines, so one `lineOf` serves both.
    const declared = stripComments(source.text);
    const code = blankStringBodies(declared);

    const entities = alternation(entitySpellings(declared));
    const manifests = alternation(manifestSpellings(declared));
    const spans = functionSpans(code);
    for (const span of spans) symbols.add(span.name);
    const lineOf = (index: number): number => code.slice(0, index).split("\n").length;

    // (file, symbol) -> reader, so several reads in one function are one declaration.
    const grouped = new Map<string, ApertureReader & { lines: number[] }>();

    for (const match of code.matchAll(FIELD_READ)) {
      const receiver = match[1] ?? "";
      const at = match.index;
      const enclosing = spans
        .filter((span) => at >= span.start && at < span.end)
        .sort((a, b) => b.end - b.start - (a.end - a.start))
        .pop();
      const scopeStart = enclosing?.start ?? 0;
      const scopeEnd = enclosing?.end ?? code.length;
      const scope = code.slice(scopeStart, scopeEnd);
      const line = lineOf(at);

      const annotated =
        entities === ""
          ? null
          : new RegExp(
              `\\b${receiver.replace(QUOTE_META, "\\$&")}\\s*\\??\\s*:\\s*(?:readonly\\s+)?(${entities})\\b(?!\\[)`,
            ).exec(scope);

      const collection = "(?:[A-Za-z_$][\\w$]*)\\.entities\\b";
      const quoted = receiver.replace(QUOTE_META, "\\$&");
      const bound =
        new RegExp(`for\\s*\\(\\s*const\\s+${quoted}\\s+of\\s+([^)]*?${collection}[^)]*)\\)`).exec(scope) ??
        new RegExp(`const\\s+${quoted}\\s*=\\s*([^;\\n]*${collection}[^;\\n]*)`).exec(scope) ??
        new RegExp(
          `(${collection}[^;\\n]{0,80}?)\\.(?:map|find|filter|flatMap|forEach|some|every)\\s*\\(\\s*\\(?\\s*${quoted}\\b`,
        ).exec(scope);

      let binding: ApertureBinding | null = null;
      let detail = "";
      if (annotated !== null) {
        binding = "annotation";
        detail = `${receiver}:${annotated[1] ?? ""}`;
      } else if (bound !== null) {
        const root = /([A-Za-z_$][\w$]*)\.entities\b/.exec(bound[1] ?? "")?.[1] ?? "";
        const rootQuoted = root.replace(QUOTE_META, "\\$&");
        const nominal =
          manifests === ""
            ? null
            : new RegExp(
                `\\b${rootQuoted}\\s*\\??\\s*:\\s*(?:readonly\\s+)?(${manifests})\\b`,
              ).exec(scope);
        // An inline structural annotation is a *stronger* anchor than a nominal Manifest, because it
        // names the element type: `manifest: { readonly entities?: readonly Entity[] }`, which is how
        // `entityFieldLookupFrom` is written and why a nominal-only check rejected a real member.
        const inline =
          entities === ""
            ? null
            : new RegExp(
                `\\b${rootQuoted}\\s*\\??\\s*:\\s*\\{[^}]*\\bentities\\??\\s*:\\s*readonly\\s+(${entities})\\[\\]`,
              ).exec(scope);
        if (nominal !== null) {
          binding = "manifest_rooted";
          detail = `${root}:${nominal[1] ?? ""}`;
        } else if (inline !== null) {
          binding = "manifest_rooted";
          detail = `${root}:{entities?:readonly ${inline[1] ?? ""}[]}`;
        } else {
          rejected.push({
            file: source.file,
            line,
            receiver,
            reason: "root_not_a_manifest",
            detail: `${root} is not annotated with a manifest type`,
          });
          continue;
        }
      } else {
        const foreign = new RegExp(
          `\\b${quoted}\\s*\\??\\s*:\\s*(?:readonly\\s+)?([A-Z][\\w$]*)`,
        ).exec(scope);
        rejected.push({
          file: source.file,
          line,
          receiver,
          reason: foreign !== null ? "foreign_type" : "unresolved_binding",
          detail: foreign !== null ? `${receiver}:${foreign[1] ?? ""}` : receiver,
        });
        continue;
      }

      const signature = code.slice(scopeStart, enclosing?.signatureEnd ?? scopeStart);
      const accounting: ReaderAccounting = RESOLVER_RE.test(scope)
        ? "resolver_called"
        : TRAIT_PARAMETER.test(signature)
          ? "trait_aware"
          : "raw";

      const symbol = enclosing?.name ?? "<module>";
      const key = `${source.file}::${symbol}`;
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, {
          pkg: source.pkg,
          file: source.file,
          symbol,
          receiver,
          binding,
          detail,
          lines: [line],
          accounting,
        });
        continue;
      }
      existing.lines.push(line);
      // A function that resolves anywhere in its body is accounted for; `raw` is the claim that
      // nothing in it does, so it must not survive one read that proves otherwise.
      if (existing.accounting === "raw" && accounting !== "raw") {
        grouped.set(key, { ...existing, accounting });
      }
    }

    for (const reader of grouped.values()) {
      readers.push(
        ApertureReaderSchema.parse({
          ...reader,
          lines: [...new Set(reader.lines)].sort((a, b) => a - b),
        }),
      );
    }
  }

  return { readers, rejected, symbols };
}

/* ----------------------------------------------------------- the declaration */

/**
 * Every function that holds a manifest `Entity` and reads its own `fields`, with what that loses.
 *
 * Ordered by direction and then by subject, because the direction is what a reader is here for: the
 * `fails_open` members are defects with an argument for not fixing them *in this increment*, the
 * `fails_closed` one is a decision that should stay true, and the rest are the backlog with its cost
 * written down.
 *
 * Two of the three `fails_open` members are **latent**, and each says so: their own callers do not
 * exist. That is this directory's other question (`pg-unreachable-stores.ts`) arriving inside this
 * one, and it does not change the direction — a refusal gate that misses its subject fails open the
 * moment it is wired, and recording it as `incomplete` because nothing calls it today would be a
 * claim about the wiring rather than about the read.
 */
export const ENTITY_FIELD_APERTURE: readonly ApertureDeclaration[] = Object.freeze([
  /* ------------------------------------------------------------- fails_open */
  {
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/validation.ts",
    symbol: "buildValidationPlans",
    direction: "fails_open",
    consequence:
      "A trait-contributed field is validated nowhere: the plan has no rule for it, so no 422 is " +
      "raised, and its declared bounds reach no CHECK either — `integer` maps to a bare INTEGER, so " +
      "`version: 0` against the built-in `versioned` trait's `min: 1` is accepted and stored.",
    note:
      "**The reader is live and the defect has no member on any shipped pack**, and the distinction " +
      "matters: `compile.ts` calls it on every compile, so every deployment serves these plans — but " +
      "the `version: 0` hole above needs an entity carrying `versioned`, and measured across all " +
      "seven packs the only trait declared anywhere is `auditable` (68 entities, 0 `versioned`, 0 " +
      "`gxp_signed`, 0 custom). `auditable`'s four fields are `datetime` and `uuid` and are all " +
      "server-stamped, so nothing a client sends reaches an unvalidated trait field today. Reads " +
      "`(e.fields ?? [])` through a module-local " +
      "`EntityLike` that re-spells an entity with " +
      "`fields` optional, and now the only such spelling: `list-query.ts` declared the other and a " +
      "sibling change in this increment deleted it, routing all three of its field sets through one " +
      "`resolvedFieldsOf`. It holds a " +
      "`Manifest`, so `manifest.traits` is already in hand and resolving needs no signature change; " +
      "what stops it is that `auditable.created_at` is `required: true` with a `now()` default, so " +
      "pulling trait fields into the plans would make a create demand a field the server fills. That " +
      "is a subsystem decision about required-but-defaulted fields, not a reader fix.",
  },
  {
    pkg: "apps/operate-server",
    file: "apps/operate-server/src/manifest-diff.ts",
    symbol: "classificationLayer",
    direction: "fails_open",
    consequence:
      "A classification change on a trait-contributed field is absent from the diff the approving " +
      "reviewer reads, so weakening one from `phi` to `internal` is approved unseen — the review " +
      "surface for the Architect's own output.",
    note:
      "Iterates `next.entities ?? []` where `next: Manifest` and reads `entity.fields`. Live: " +
      "`design-review-routes.ts` shows `ManifestDiffView` to the reviewer, and the ranked register " +
      "already records that the view covers 5 of 16 manifest sections. `ManifestEntity` is the " +
      "indexed-access alias, so the nominal `Entity` token appears nowhere in the file.",
  },
  {
    pkg: "apps/architect-cli",
    file: "apps/architect-cli/src/refusal.ts",
    symbol: "detectEncryptionWeakening",
    direction: "fails_open",
    consequence:
      "The `weaken_encryption_below_pack_minimum` hard refusal does not fire for a trait-contributed " +
      "`phi`/`regulated` field, so the one edit the Architect is forbidden to make is permitted on " +
      "exactly the fields a compliance trait contributes.",
    note:
      "Latent, and the reason is worth knowing before anyone fixes it: `classifyManifestEditRefusal` " +
      "has no caller outside its own test, so no manifest edit is refused by this module at all " +
      "today. Wiring the gate without widening the read would ship the hole. Reads `before.fields` " +
      "over `current.entities ?? []` where `current: Manifest`, and `now.fields` through a " +
      "`Map<string, ManifestEntity>`.",
  },
  /* ----------------------------------------------------------- fails_closed */
  {
    pkg: "apps/operate-server",
    file: "apps/operate-server/src/audit-read-routes.ts",
    symbol: "entityFieldLookupFrom",
    direction: "fails_closed",
    dropped:
      "A trait-contributed key in an audit payload is dropped from the rendered row as undescribed. " +
      "Safe because the narrow set only ever *withholds*: a key absent from the lookup cannot be " +
      "shown, so the trail can omit `created_at` and can never disclose a classified trait field it " +
      "failed to classify.",
    note:
      "The one deliberate member, and the only one whose own doc comment already states the rule: it " +
      "names `resolvedFields` as what a deployment wanting those keys readable should build the " +
      "lookup from 'rather than this convenience'. Its parameter is an inline structural type, " +
      "`{ readonly entities?: readonly Entity[] }`, which is a stronger anchor than a nominal " +
      "`Manifest` and which a nominal-only root check rejected.",
  },
  /* ------------------------------------------------------------- incomplete */
  {
    pkg: "packages/kernel",
    file: "packages/kernel/src/manifest/validate.ts",
    symbol: "manifestClassifiedFields",
    direction: "incomplete",
    consequence:
      "A trait-contributed classified field is absent from the manifest's classified-field census, " +
      "so any survey built on it under-reports — the same under-count that made the response " +
      "redaction and write-mask members fail open.",
    note:
      "Latent for a different reason from `refusal.ts`: this function has no consumer anywhere in the " +
      "workspace outside its own declaration and a stale `kernel/dist`, so nothing is under-reported " +
      "today. It is the kernel's own narrow spelling of the question `resolvedClassifiedFields` now " +
      "answers, sitting one directory from it; wiring it as written would reintroduce the class.",
  },
  {
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/defaults.ts",
    symbol: "literalDefaultPlans",
    direction: "incomplete",
    consequence:
      "A trait field's literal default is not applied by the server on create. The two built-in " +
      "trait fields that have one are `versioned.version` (1) and `gxp_signed.e_signature_required` " +
      "(true), both `required: true` — so on the column store the row is saved by the column's own " +
      "DEFAULT and on the JSONB store the key is simply absent from the document. **No member on " +
      "any shipped pack**: measured, the only trait any of the seven declares is `auditable`, whose " +
      "two defaulted fields carry `now()` expressions rather than literals.",
    note:
      "Takes `entity: Entity` alone, so resolving needs a `traits` parameter and a change at every " +
      "call site — unlike the two readers that already hold a `Manifest`. Not a 500 on either store: " +
      "`columnPlanForEntity` goes through `resolvedFields`, so the emitted column carries both the " +
      "DEFAULT and the NOT NULL.",
  },
  {
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/sequences.ts",
    symbol: "sequenceFieldPlans",
    direction: "incomplete",
    consequence:
      "A trait-contributed field with a `sequence` default gets no allocator, so nothing assigns it a " +
      "number and the column is left to its own DDL default — and ADR-0360's 409-vs-500 split turns " +
      "on exactly whether a unique value was caller-supplied or allocator-chosen.",
    note:
      "No live member: none of the eight built-in trait fields carries a `sequence` default, so only " +
      "a custom trait reaches it. Takes `entity: Entity` alone, so resolving needs a new parameter.",
  },
  {
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/settings-defaults.ts",
    symbol: "settingsDefaultPlan",
    direction: "incomplete",
    consequence:
      "A trait-contributed `currency` field, or one of `currency_amount` kind, is invisible to the " +
      "tenant-settings default plan, so the tenant's configured currency is not applied to it on " +
      "create.",
    note:
      "No live member: no built-in trait field is a currency. Reads `entity.fields` twice — once for " +
      "a name set and once to filter — and takes `entity: Entity` alone.",
  },
  {
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/ui-schema.ts",
    symbol: "buildUiSchema",
    direction: "incomplete",
    consequence:
      "No trait-contributed field reaches the web client at all: `UiEntitySchema.fields` is built from " +
      "`entity.fields`, so `created_at`, `updated_at` and `version` are absent from every list, record " +
      "and form view the generic UI renders, on every deployment.",
    note:
      "The widest-reaching member and the root of the largest downstream population: all 25 `.fields` " +
      "reads in `apps/operate-web` are on the `UiEntitySchema` this function produces, so they are " +
      "narrow as a consequence rather than as members. It holds a `Manifest`, so `manifest.traits` is " +
      "in hand and resolving needs no signature change — what it needs is a decision about whether a " +
      "server-written field should render, which is `uiField`'s `readOnly`/`defaulted` question.",
  },
  {
    pkg: "packages/operate-runtime",
    file: "packages/operate-runtime/src/ui-schema.ts",
    symbol: "pickListColumns",
    direction: "incomplete",
    consequence:
      "A trait-contributed field is never auto-picked as a list column, so a view with no explicit " +
      "`columns` cannot show `created_at` even once `buildUiSchema` carries it.",
    note:
      "Declared separately from `buildUiSchema` in the same file because it is reached with " +
      "`pickListColumns(entity, [])` and would still be narrow after that one is widened — the " +
      "heuristic matches on name patterns (`_date$`, `status`, `_id$`) over `entity.fields.map`.",
  },
  {
    pkg: "apps/operate-server",
    file: "apps/operate-server/src/manifest-diff.ts",
    symbol: "fieldIndex",
    direction: "incomplete",
    consequence:
      "A trait-contributed field is absent from the per-entity field index the diff compares against, " +
      "so a change to one is reported as neither added nor modified.",
    note:
      "Reads `entity?.fields ?? []` through optional chaining on `ManifestEntity | undefined` — a " +
      "shape a `\\.fields` matcher without the `?\\.` arm misses entirely, which is how both readers " +
      "in this file stayed off the first census.",
  },
  {
    pkg: "apps/operate-server",
    file: "apps/operate-server/src/manifest-diff.ts",
    symbol: "fieldNameByColumn",
    direction: "incomplete",
    consequence:
      "The kernel reports a removed field by *column* name, and this maps it back; a trait-contributed " +
      "column is not in the map, so the reviewer is shown the raw column name instead of the field " +
      "name for exactly those fields.",
    note:
      "The sibling of `fieldIndex` and the same optional-chained read. Declared separately because the " +
      "two are different maps with different consumers, and widening one does not widen the other.",
  },
]);
