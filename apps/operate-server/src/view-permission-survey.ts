/**
 * Which of this manifest's views declare their own permission override, and that nothing reads one.
 *
 * A view may say `permissions: {roles: [...]}` instead of `"inherit"`. Those role names **are**
 * checked — `validateManifest` refuses a view granting a role `manifest.roles` does not declare,
 * and has since views were validated at all — so the declaration looks live from every angle an
 * author can see: it parses, it is cross-validated against the role catalog, and it is hashed into
 * `manifestHash`. And then **no code reads it.**
 *
 * Measured against the seven resolved packs rather than reasoned about:
 * `listConfigForEntity` is the only serve-time reader of `manifest.views` in the workspace and it
 * takes `columns`, `sort` and `pageSize` from the first `list` view per entity; every authorization
 * decision — entity grant, per-field grant, ABAC obligation, write mask, response redaction — reads
 * `manifest.permissions[entity]`. `UiSchema` does not carry a view at all, so there is not even a
 * client that could honour the declaration. The reach of a view's `permissions` is zero in both
 * directions.
 *
 * ## What that costs, stated precisely
 *
 * The declaration is **inert**, not partially honoured, and the difference decides everything below.
 * An author writing `permissions: {roles: ["gov_admin"]}` on a view of an entity whose grants also
 * name `case_worker` means *this view is for gov_admin*; what happens is that the view's data is
 * served per the entity's grants, which is strictly **wider** than the declaration wherever the two
 * differ. Nothing a caller may not otherwise see is disclosed by that — the authorization decision
 * never consulted the view, so there is no narrowing that was dropped from a check, only a sentence
 * in the manifest that describes a restriction nobody applies.
 *
 * ## The remedy, and who holds it
 *
 * There is no flag that enforces a view override and no store that reads one. The restriction has
 * to be expressed where something reads it — `manifest.permissions[entity]`, which carries the
 * entity grants, the per-field grants and the ABAC obligations — and the view's own override
 * dropped, so the manifest says what is true. That is actionable by a **manifest author**, which
 * includes the Architect and an activated per-tenant manifest; for a builtin pack it is an edit to
 * this repository, which is the half that decides the verdict map below.
 */

import type { Manifest } from "@crossengin/kernel/manifest";

/**
 * One view declaration, structurally.
 *
 * Indexed out of `Manifest` rather than imported as `ViewDeclaration`, because `@crossengin/views`
 * is not a dependency of this app and the kernel does not re-export it (`abac-obligations.test.ts`
 * records the same constraint). Indexing the manifest's own field type is not a second spelling: it
 * **is** the type `manifest.views` holds, so a change to `ViewDeclaration` reaches here through the
 * kernel exactly as it would through a direct import.
 */
type ViewOf = NonNullable<Manifest["views"]>[string];

/**
 * The sentinel a view uses to say it inherits its entity's permissions.
 *
 * `PERMISSION_INHERIT` in `@crossengin/views` is the authority and cannot be imported here for the
 * reason above, so the literal is restated once, in one place, read by one function. The branch
 * below is written so that the restatement cannot fail *open*: anything that is not this sentinel
 * is reported as an override, so a third member added to `PermissionRefSchema` would be named
 * rather than quietly treated as inheriting.
 */
const PERMISSION_INHERIT_VALUE = "inherit";

/**
 * How many overriding views are named before the line summarises the rest.
 *
 * `WITHHELD_FIELD_LIMIT`'s rule and figure, for its reason: the count stays exact even when the
 * list is truncated, because the number is what an operator compares between two boots.
 */
export const OVERRIDING_VIEW_LIMIT = 8;

export const VIEW_PERMISSION_VERDICTS = [
  /**
   * The manifest declares no view, so there is no override to be ignored.
   *
   * Its own member rather than folded into `all_inherit`, on ADR-0331's distinction: *every view
   * inherits* is a claim about 132 views that use the feature, and *there are no views* is the
   * absence of anything to claim. A line reading "none of 0 views" would be vacuously true and
   * indistinguishable, in a boot log, from the survey not having run — which is the whole failure
   * mode this module exists to end for a different declaration.
   */
  "no_views",
  /** Every view inherits its entity's permissions, which is what the serving path reads. */
  "all_inherit",
  /** At least one view declares an override, and nothing reads it. */
  "overrides_unenforced",
] as const;
export type ViewPermissionVerdict = (typeof VIEW_PERMISSION_VERDICTS)[number];

/**
 * Whether each verdict permits a boot. `UNIQUE_ENFORCEMENT_MAY_SERVE`'s shape, and **every member
 * is `true`**: this survey reports and never refuses.
 *
 * ## The argument, measured rather than asserted
 *
 * ADR-0338's premise is satisfied and in the strongest form it has ever been: the measured count of
 * overriding views across the seven resolved packs is **zero** — 132 views, every one `"inherit"`,
 * all of kind `list` — so a refusal would break nothing that works today, and no operator is in a
 * position to meet it. Three things take the refusal away again.
 *
 * **The remedy for the thing being reported does not exist.** A refusal's job is to stop a boot
 * until somebody fixes something; there is no flag, store or configuration that makes a view's
 * override enforced, so the only exit from the refusal would be editing the manifest to delete a
 * declaration — and for a builtin pack that is an edit to this repository. "A remedy that cannot
 * work is worse than none" (ADR-0334), which is `list-surface-survey.ts`' deciding reason too.
 *
 * **And the degradation is a declaration nothing acts on, not a wrong answer.** Every request is
 * authorized by `manifest.permissions[entity]` — completely, with its field grants and its
 * obligations — so no row and no field reaches a caller who was not entitled to it. ADR-0359 drew
 * the line this sits on: *a surface whose drop changes WHICH rows come back is refused; one whose
 * drop changes only their ORDER is reported*. An ignored view override changes neither; it changes
 * what the manifest **claims**, and ADR-0360 reported an absent unique index on the same reading.
 *
 * **It is not ADR-0340's case, and the distinction is the sharp one.** There, an `abac`-qualified
 * grant in `manifest.permissions` *was served* with its qualifier silently discarded — a
 * partially-honoured grant, which is the opposite of what the manifest declares, so it is refused at
 * boot with no escape hatch. Here the declaration is not served at all. Nothing is partially
 * honoured: the entity's grants are applied in full and the view's sentence is dead text. A
 * partially-honoured grant is a security defect; an inert declaration is a documentation defect, and
 * the two do not earn the same answer.
 *
 * So: reported, and `viewPermissionsAreSuspect` earns a `warn` wherever an override exists.
 */
export const VIEW_PERMISSION_MAY_SERVE: Readonly<Record<ViewPermissionVerdict, true>> = {
  no_views: true,
  all_inherit: true,
  overrides_unenforced: true,
};

/** One view whose declared permission override this deployment will not enforce. */
export interface ViewPermissionOverride {
  /** The view's key in `manifest.views`, which is how an author finds it. */
  readonly view: string;
  /** The entity whose grants are applied instead. */
  readonly entity: string;
  /**
   * The roles the override names — **role names only**, which are manifest schema and not data.
   *
   * There is no `abac` field to report beside them, and that is why this survey reports rather than
   * refuses: `PermissionRefSchema`'s object arm carries `roles` and nothing else, so a view cannot
   * declare an obligation. An inert *obligation* would be ADR-0340's case — refused at boot by name,
   * no hatch — and this is not that.
   *
   * It does **not** follow that `surveyAbacObligations` walking `manifest.permissions` is complete
   * over the manifest. Measured over the real `ManifestSchema`, an `abac` key is reachable at two
   * further positions: `reports{}.permissions` and `dashboards{}.permissions` are both
   * `RbacGrantSchema`, which carries one. Neither is in that walk, so an obligation declared there
   * is undischargeable and invisible to the boot refusal. Vacuous today — zero reports and zero
   * dashboards across the seven resolved packs — and not this module's to close; said here because
   * this is the file a reader arrives at asking which declarations carry an obligation.
   */
  readonly roles: readonly string[];
}

export interface ViewPermissionSurvey {
  readonly verdict: ViewPermissionVerdict;
  /** Every view in the manifest, whether it overrides or inherits. */
  readonly viewCount: number;
  /** How many inherit. `viewCount - overrides.length`. */
  readonly inheritCount: number;
  readonly overrides: readonly ViewPermissionOverride[];
  readonly mayServe: boolean;
}

/**
 * The roles a view's own override names, or `null` when it inherits.
 *
 * `undefined` reads as inheriting for `viewReferencedRoles`' reason: `validateManifest` runs over
 * hand-built manifests too, where the schema's `"inherit"` default has never been applied, and an
 * absent `permissions` is an author who said nothing rather than one who declared something.
 * `roles` is read through `?? []` on the same grounds — a hand-built override can omit it.
 */
function overrideRoles(permissions: ViewOf["permissions"] | undefined): readonly string[] | null {
  if (permissions === undefined || permissions === PERMISSION_INHERIT_VALUE) return null;
  return [...(permissions.roles ?? [])];
}

/**
 * Surveys every view's `permissions` against what the serving path reads, which is nothing.
 *
 * A **pure function of the manifest alone**, and deliberately not of the store or the store kind —
 * which is where it parts company with its two siblings. `surveyListSurfaces` and
 * `surveyUniqueEnforcement` both take a `StoreKind` because the same manifest has members on one
 * store and none on another: one store holds ciphertext it cannot compare, another has no DDL seam.
 * Here there is no store that reads a view's permissions and no store that could, so the fact is a
 * property of the artifact. Taking a `StoreKind` would invite a reader to believe the answer depends
 * on one.
 *
 * Ordering is not a severity judgement here, which is the other difference from those two: their
 * verdicts overlap, so each tests the worst fact first and says so. These three partition the input
 * — zero views, views with no override, views with one — so every order gives the same answer and
 * `no_views` is first only because it reads that way.
 */
export function surveyViewPermissionOverrides(manifest: Manifest): ViewPermissionSurvey {
  const views = Object.entries(manifest.views ?? {});
  const overrides: ViewPermissionOverride[] = [];
  for (const [view, declaration] of views) {
    const roles = overrideRoles(declaration.permissions);
    if (roles === null) continue;
    overrides.push({ view, entity: declaration.entity, roles });
  }
  const verdict = decideVerdict(views.length, overrides.length);
  return {
    verdict,
    viewCount: views.length,
    inheritCount: views.length - overrides.length,
    overrides,
    mayServe: VIEW_PERMISSION_MAY_SERVE[verdict],
  };
}

function decideVerdict(viewCount: number, overrideCount: number): ViewPermissionVerdict {
  if (viewCount === 0) return "no_views";
  return overrideCount > 0 ? "overrides_unenforced" : "all_inherit";
}

/**
 * True when this survey deserves a `warn` rather than an `info`: a view declares an override.
 *
 * Reads the same list the verdict is computed from, so the level an operator sees and the verdict
 * they read cannot disagree about one manifest — `uniqueEnforcementIsSuspect`' stated reason for
 * sharing its predicate with the arm above it.
 *
 * `no_views` and `all_inherit` are both `info`, and for two different reasons that the line spells
 * out: the first has nothing to declare and the second declares nothing that is ignored.
 */
export function viewPermissionsAreSuspect(survey: ViewPermissionSurvey): boolean {
  return survey.overrides.length > 0;
}

/** `key on Entity grants a, b`, bounded, with the count always exact. */
function nameOverrides(overrides: readonly ViewPermissionOverride[]): readonly string[] {
  const shown = overrides
    .slice(0, OVERRIDING_VIEW_LIMIT)
    .map((o) => `  ${o.view} on ${o.entity} grants ${o.roles.join(", ")}`);
  const hidden = overrides.length - shown.length;
  return hidden > 0 ? [...shown, `  (+${hidden.toString()} more)`] : shown;
}

/**
 * The boot line, affirmative in both directions and said **even when the count is zero**.
 *
 * `boot-erasure-report.ts`' rule, and the half that would have surfaced this years ago: "we checked
 * and found none" cannot be claimed from the absence of a log line, and a line that appeared only
 * when something was overriding would print nothing on all seven shipped packs — indistinguishable,
 * in a boot log, from a survey nobody wired. ADR-0350 named the same shape from the other side: a
 * passing check and a missing guarantee can be one sentence.
 */
export function formatViewPermissionSurvey(survey: ViewPermissionSurvey): string {
  const prefix = "[views] view permission overrides:";
  if (survey.verdict === "no_views") {
    return (
      `${prefix} none, because this manifest declares no view — so there is no override to be` +
      ` ignored`
    );
  }
  // Pluralised because a one-view manifest is an ordinary authored one — a tenant's first activated
  // manifest is likely to have exactly one — and "none of 1 views" on a boot line that argues for
  // care about declarations reads as carelessness about them.
  const of = `of ${survey.viewCount.toString()} view${survey.viewCount === 1 ? "" : "s"}`;
  if (survey.verdict === "all_inherit") {
    return (
      `${prefix} none ${of} — every one inherits its entity's permissions, which is what the` +
      ` serving path reads`
    );
  }
  return [
    `${prefix} ${survey.overrides.length.toString()} ${of} declare one, and nothing reads it`,
    ...nameOverrides(survey.overrides),
    `  listConfigForEntity is the only serve-time reader of manifest.views and takes columns, sort` +
      ` and pageSize; UiSchema carries no view at all. So each view above is served per its` +
      ` entity's own grants in manifest.permissions, which is strictly wider than it declares` +
      ` wherever the two differ`,
    `  remedy: express the restriction in manifest.permissions, where it is read, and drop the` +
      ` view's override so the manifest says what is true; no flag enforces one`,
  ].join("\n");
}
