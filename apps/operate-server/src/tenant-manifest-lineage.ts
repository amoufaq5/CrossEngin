import type { Manifest, ManifestRegistry } from "@crossengin/kernel/manifest";

/**
 * Which manifests a tenant's own manifest is permitted to `meta.extends`.
 *
 * A tenant may extend only the manifest this deployment itself serves. The boot manifest is the
 * one this deployment has already surveyed, provisioned and declared — its unique-index
 * enforcement, PHI storage decision, list-surface survey and ABAC obligation check were all
 * computed over it — so a tenant extending anything else would inherit entities the deployment
 * never checked. Narrower is safer and the policy is extensible later.
 *
 * A const rather than prose in two files, so the decision has one spelling: the registry below
 * enforces it and `permittedParentSentence` reports it, and neither restates it.
 */
export const TENANT_PARENT_POLICY = "deployment_boot_manifest_only";

/**
 * The one manifest a tenant may extend, named by the id a child writes in `meta.extends`.
 *
 * `slug` is the lookup key and is ordinarily `manifest.meta.slug`; the two are separate fields
 * because `ManifestResolutionEntry` records both a parent's own `slug` and the `parentId` it was
 * reached by, so a deployment registering the boot manifest under an alias stays expressible.
 */
export interface TenantManifestParent {
  readonly slug: string;
  readonly manifest: Manifest;
}

/**
 * Everything the resolution step needs, as one object.
 *
 * Grouped rather than passed as two options because they must agree: a registry whose permitted
 * slug says something else would refuse a parent it holds, or name a parent it does not — and
 * `buildTenantManifestLineage` derives both from one source so that cannot be formed.
 *
 * `permittedParentSlug` is required and nullable: `null` is the claim *this deployment serves no
 * manifest a tenant may extend*, not an argument somebody forgot.
 */
export interface TenantManifestLineage {
  readonly registry: ManifestRegistry;
  readonly permittedParentSlug: string | null;
}

/**
 * A `ManifestRegistry` answering for exactly one parent and `null` for every other id.
 *
 * One entry is sufficient, and re-resolution cannot loop, because a *resolved* manifest carries no
 * `meta.extends` — `resolveManifest` strips it from the composed meta on both arms, so handing the
 * boot manifest back resolves it to itself with no further lookups. Verified: re-resolving the
 * boot manifest performs zero `getManifest` calls and hashes identically.
 *
 * The match is exact, with no alias or prefix fallback, because `null` here is what raises
 * `UnknownParentManifestError` — the refusal a tenant's manifest is entitled to. A near-match
 * answered generously would compose a manifest the child did not ask for.
 */
export function buildTenantManifestRegistry(parent: TenantManifestParent | null): ManifestRegistry {
  return {
    async getManifest(parentId: string): Promise<Manifest | null> {
      if (parent === null || parentId !== parent.slug) return null;
      return parent.manifest;
    },
  };
}

/** The parent a lineage refusal may name, or `null` where there is none. */
export function permittedParentSlug(parent: TenantManifestParent | null): string | null {
  return parent === null ? null : parent.slug;
}

/** The registry and the slug it permits, derived from one source so they cannot disagree. */
export function buildTenantManifestLineage(
  parent: TenantManifestParent | null,
): TenantManifestLineage {
  return {
    registry: buildTenantManifestRegistry(parent),
    permittedParentSlug: permittedParentSlug(parent),
  };
}

/**
 * The clause a lineage refusal adds to the thrown message.
 *
 * The kernel's `UnknownParentManifestError` names the parent that was *asked for* and cannot name
 * the one that was allowed — it has never been told. A refusal an operator cannot act on is worse
 * than none, and "unknown parent 'x'" with no permitted parent beside it is exactly that.
 */
export function permittedParentSentence(permitted: string | null): string {
  return permitted === null
    ? "this deployment serves no manifest a tenant may extend, so any 'meta.extends' is unsatisfiable"
    : `this deployment permits extending only '${permitted}'`;
}
