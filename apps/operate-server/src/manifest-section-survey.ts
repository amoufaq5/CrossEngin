/**
 * Which sections the served manifest declares that no request path in this binary reads.
 *
 * `MANIFEST_SECTION_REACH` is the kernel's total map of how far each of the seventeen sections
 * reaches a request, and until this module it had no reader outside the kernel: the design-review
 * diff carries its sentence per *change*, and nothing said at boot which *declared* sections this
 * deployment will validate, hash and then serve to nobody. A manifest declaring `reports` or `theme`
 * booted with no word that both are inert here.
 *
 * Derived from the kernel over **every** non-served section rather than three hand-named ones, so a
 * section whose reach changes moves this line with no edit here. "Declared" means the section has
 * at least one member by the kernel's own member keying — `diffManifestSections(null, manifest)`,
 * which compares against an absent manifest — because a resolved manifest carries keys that declare
 * nothing: on every extending pack `integrations`, `files`, `reports`, `dashboards` and
 * `customWidgets` are **own keys holding `undefined`** (measured with `in` over the resolved
 * `erp-retail`; the register recorded them as `{}`, which is the same non-declaration by a different
 * value). Counting key presence would report five unserved declarations on six of the seven shipped
 * packs, all of them false, and an authored `{}` is no more a declaration than an absent key.
 *
 * Reports and never refuses, at info level: an unserved declaration costs nothing at request time,
 * and the remedy (wiring a section into a request path) is an increment, not an operator's act.
 */

import {
  diffManifestSections,
  MANIFEST_SECTION_NAMES,
  MANIFEST_SECTION_REACH,
  MANIFEST_SECTION_REACH_MEANINGS,
  MANIFEST_SECTION_REACHES,
  type Manifest,
  type ManifestSectionName,
  type ManifestSectionReach,
} from "@crossengin/kernel/manifest";

export interface DeclaredUnservedSection {
  readonly section: ManifestSectionName;
  readonly reach: ManifestSectionReach;
  /** Member count by the kernel's keying for this section. Always at least one. */
  readonly members: number;
}

export interface ManifestSectionSurvey {
  /** Every section this binary serves on no request path, from the kernel's map, in its order. */
  readonly unservedSections: readonly ManifestSectionName[];
  /** The subset the manifest declares at least one member in. */
  readonly declared: readonly DeclaredUnservedSection[];
}

/** Pure: a function of the resolved manifest and the kernel's reach map. */
export function surveyManifestSections(manifest: Manifest): ManifestSectionSurvey {
  const unservedSections = MANIFEST_SECTION_NAMES.filter((s) => MANIFEST_SECTION_REACH[s] !== "served");
  const declared = diffManifestSections(null, manifest)
    .filter((c) => c.reach !== "served" && c.countAfter > 0)
    .map((c) => ({ section: c.section, reach: c.reach, members: c.countAfter }));
  return { unservedSections, declared };
}

/** The `[manifest]` boot line, said either way. */
export function formatManifestSectionSurvey(survey: ManifestSectionSurvey): string {
  const census = MANIFEST_SECTION_REACHES.filter((r) => r !== "served")
    .map((reach) => {
      const names = survey.unservedSections.filter((s) => MANIFEST_SECTION_REACH[s] === reach);
      return names.length === 0 ? null : `${reach}: ${names.join(", ")}`;
    })
    .filter((part): part is string => part !== null)
    .join("; ");
  const head =
    `[manifest] ${survey.unservedSections.length} of ${MANIFEST_SECTION_NAMES.length} manifest` +
    ` sections are read by no request path in this binary (${census})`;
  if (survey.declared.length === 0) {
    return `${head} — this manifest declares a member in none of them`;
  }
  const parts = MANIFEST_SECTION_REACHES.filter((r) => r !== "served")
    .map((reach) => {
      const here = survey.declared.filter((d) => d.reach === reach);
      if (here.length === 0) return null;
      const list = here.map((d) => `${d.section} (${d.members} member(s))`).join(", ");
      return `${list}: ${MANIFEST_SECTION_REACH_MEANINGS[reach]}`;
    })
    .filter((part): part is string => part !== null);
  return `${head} — this manifest declares ${survey.declared.length} of them: ${parts.join("; ")}`;
}
