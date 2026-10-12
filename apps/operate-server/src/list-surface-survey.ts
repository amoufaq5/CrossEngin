import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import { listConfigForEntity } from "@crossengin/operate-runtime";

import type { StoreKind } from "./cli.js";

/**
 * Which list surfaces this deployment declares and cannot serve.
 *
 * It exists because the surfaces used to be dropped silently, and the dropping was reported by
 * nothing anywhere: a filter on a ciphertext column left `tenant_id = $1` as the whole predicate
 * and the page came back holding every row the caller asked to exclude, under a 200. The store
 * refuses that request now — which is the correctness fix — and this is the half that tells an
 * operator *before* a user meets the refusal, because the facts are all knowable at boot: the
 * manifest's view columns, the field classifications and the store kind.
 *
 * `--store pg-columns` is the only kind with a member, and the reason is structural rather than
 * incidental: `pgp_sym_encrypt` is non-deterministic, so there is no comparison to push into SQL
 * against the stored bytes. The document store holds the same values as plaintext inside `document`
 * and can filter, sort and search all of them; the in-memory store compares records in process.
 * So this survey is a fact about a *store choice*, not about a manifest — the same manifest served
 * two ways has members on one and none on the other, which is why it cannot be a kernel validation
 * rule and why `erp-healthcare` is not wrong to declare `mrn` filterable.
 */

export const LIST_SURFACE_VERDICTS = [
  /** The store expresses every declared surface. */
  "all_surfaces_serveable",
  /** A filter or a sort naming an inexpressible field; the request is refused by the store. */
  "surfaces_refused",
  /**
   * Only `?q` is affected, and only partly: some of its fields are inexpressible and at least one
   * is not, so the search still runs over the rest. The *rows* it returns are right and a match on
   * the inexpressible field is missed, so nothing is refused and nothing is wrong — it is narrower
   * than the view declares, and this is the only place that says so.
   */
  "search_narrowed",
] as const;
export type ListSurfaceVerdict = (typeof LIST_SURFACE_VERDICTS)[number];

/**
 * Whether each verdict permits a boot. `CURSOR_DISCLOSURE_MAY_SERVE`'s shape, and **every member
 * is `true`**: this survey reports and never refuses.
 *
 * Argued from the three precedents rather than from taste, and the deciding one is the remedy.
 * ADR-0338 refuses by default on the grounds that *nothing served PHI correctly today*, which is
 * true here — a `pg-columns` healthcare deployment answers `?mrn=MRN-1` with every patient — so a
 * refusal would break nothing that worked. What stops it is the **remedy**: the surface is declared
 * by a *builtin pack's* view, so an operator meeting the refusal cannot clear it without editing
 * this repository, and "a remedy that cannot work is worse than none" (ADR-0334).
 *
 * The honest reason a report suffices here, and the reason this is not ADR-0340's no-hatch case, is
 * that **the wrong answer is already gone**: `ListSurfaceUnserveable` refuses the request before the
 * statement is issued, so by the time an operator reads this line nothing is being served
 * incorrectly. A boot refusal would buy no correctness and cost a deployment its boot. This line's
 * job is to make the 400 a clinician will eventually see predictable rather than a surprise.
 */
export const LIST_SURFACE_MAY_SERVE: Readonly<Record<ListSurfaceVerdict, true>> = {
  all_surfaces_serveable: true,
  surfaces_refused: true,
  search_narrowed: true,
};

/**
 * Which classifications a `pg-columns` deployment stores as ciphertext, and so cannot compare.
 *
 * The same two `encryptAtRest` reaches for. Restated rather than imported because
 * `column-plan.ts` derives the flag from the classification inline and exports no predicate —
 * so the test beside this asserts the pair against the column plan's **own** answer over a
 * manifest declaring one field of each classification, which is what keeps a third encrypted
 * classification from being added in one place only.
 */
const CIPHERTEXT_CLASSIFICATIONS: ReadonlySet<string> = new Set(["phi", "regulated"]);

/** Which surfaces of one entity this store cannot express. */
export interface EntitySurfaceGap {
  readonly entity: string;
  readonly field: string;
  readonly surfaces: readonly ("filter" | "sort" | "search" | "defaultSort")[];
}

export interface ListSurfaceReport {
  readonly verdict: ListSurfaceVerdict;
  readonly storeKind: StoreKind;
  /** Every (entity, field) pair with at least one declared surface this store cannot express. */
  readonly gaps: readonly EntitySurfaceGap[];
  /** Entities whose `?q` still runs over at least one expressible field. */
  readonly narrowedSearchEntities: readonly string[];
  readonly mayServe: boolean;
}

/**
 * Surveys every entity's declared list surfaces against what the chosen store can express.
 *
 * Through `listConfigForEntity` — the same function the handler uses — so this reads the set
 * `parseListQuery` will accept rather than a second derivation of it, and through `resolvedFields`
 * so a classified **trait** field is in scope.
 */
export function surveyListSurfaces(manifest: Manifest, storeKind: StoreKind): ListSurfaceReport {
  const gaps: EntitySurfaceGap[] = [];
  const narrowed: string[] = [];

  // Only the typed-column store holds a value it cannot compare. Stated as a predicate rather than
  // a branch over the kinds, because what matters is whether the store keeps ciphertext at rest and
  // `pg-columns` is the one that does.
  if (storeKind === "pg-columns") {
    const traits = manifest.traits ?? [];
    for (const entity of manifest.entities ?? []) {
      // `resolvedFields` and not `entityClassifiedFields`: that helper reads the entity's **own**
      // fields only, so a classified field contributed by a trait would be invisible to it while
      // being a real encrypted column on the served table.
      const classified = new Set(
        resolvedFields(entity, traits)
          .filter((f) => f.classification !== undefined && CIPHERTEXT_CLASSIFICATIONS.has(f.classification))
          .map((f) => f.name),
      );
      if (classified.size === 0) continue;
      const config = listConfigForEntity(manifest, entity.name);
      const searchable = new Set(config.searchableFields);
      for (const field of classified) {
        const surfaces: ("filter" | "sort" | "search" | "defaultSort")[] = [];
        if (config.filterableFields.includes(field)) surfaces.push("filter");
        if (config.sortableFields.includes(field)) surfaces.push("sort");
        if (searchable.has(field)) surfaces.push("search");
        if (config.defaultSort.some((s) => s.field === field)) surfaces.push("defaultSort");
        if (surfaces.length > 0) gaps.push({ entity: entity.name, field, surfaces });
      }
      // A search is only *narrowed* when something is left to search. With every searchable field
      // inexpressible the group collapses, `?q` would have matched every row, and the store refuses
      // — which belongs under `surfaces_refused` and not here.
      const inexpressibleSearch = config.searchableFields.filter((f) => classified.has(f));
      if (inexpressibleSearch.length > 0 && inexpressibleSearch.length < config.searchableFields.length) {
        narrowed.push(entity.name);
      }
    }
  }

  const verdict = decideVerdict(gaps, narrowed);
  return {
    verdict,
    storeKind,
    gaps,
    narrowedSearchEntities: narrowed,
    mayServe: LIST_SURFACE_MAY_SERVE[verdict],
  };
}

/**
 * The verdict is the **worst** fact in hand, which puts `surfaces_refused` ahead of
 * `search_narrowed`: a narrowed search returns correct rows and a refused filter returns a 400, so
 * reporting the milder of the two when both hold would understate what an operator will meet.
 */
function decideVerdict(
  gaps: readonly EntitySurfaceGap[],
  narrowed: readonly string[],
): ListSurfaceVerdict {
  const refused = gaps.some((g) =>
    g.surfaces.some((s) => s === "filter" || s === "sort" || s === "defaultSort"),
  );
  if (refused) return "surfaces_refused";
  if (narrowed.length > 0) return "search_narrowed";
  // A gap consisting only of `search` on an entity that is NOT narrowed means every searchable
  // field collapsed, which the store refuses — so it is a refusal rather than nothing.
  return gaps.length > 0 ? "surfaces_refused" : "all_surfaces_serveable";
}

/**
 * The boot line, affirmative in both directions.
 *
 * It says the clean case out loud for `checkAbacObligations`' reason: *"we checked and found
 * nothing"* cannot be claimed from the absence of a log line, and an operator reading a boot log
 * for a reported surface gap must be able to tell a deployment with none from a survey that did not
 * run.
 */
export function formatListSurfaceReport(report: ListSurfaceReport): string {
  if (report.verdict === "all_surfaces_serveable") {
    return `[list] declared surfaces: all serveable on --store ${report.storeKind}`;
  }
  const lines = [`[list] declared surfaces: ${report.verdict} on --store ${report.storeKind}`];
  for (const gap of report.gaps) {
    lines.push(
      `  ${gap.entity}.${gap.field}: declared ${gap.surfaces.join(", ")}; stored as ciphertext, so` +
        ` no comparison can be pushed into SQL`,
    );
  }
  const refusing = report.gaps.filter((g) =>
    g.surfaces.some((s) => s === "filter" || s === "sort" || s === "defaultSort"),
  );
  if (refusing.length > 0) {
    lines.push(
      `  a request naming one of those is refused 400 rather than answered with every row;` +
        ` remedy: drop the column's filterable/sortable flag on the view, declassify the field, or` +
        ` serve this pack on --store pg`,
    );
  }
  if (report.narrowedSearchEntities.length > 0) {
    lines.push(
      `  ?q is narrower than declared on ${report.narrowedSearchEntities.join(", ")}: it runs over` +
        ` the remaining fields, so a match on an encrypted one is missed rather than refused`,
    );
  }
  return lines.join("\n");
}
