import type { Manifest } from "@crossengin/kernel/manifest";
import type { PackInstallation } from "@crossengin/marketplace";

import { loadBuiltinPack } from "./manifest-source.js";

/**
 * Resolves a marketplace pack id (+ optional version) to its full, lineage-resolved
 * `Manifest`, or `null` when the pack id is unknown to this deployment. The actual
 * pack-manifest registry is deployment-specific (third-party packs, a signed
 * registry, …); this is the seam.
 */
export interface PackManifestResolver {
  resolve(packId: string, version: string | null): Promise<Manifest | null>;
}

/**
 * The built-in vertical packs exposed under marketplace pack ids. A tenant that
 * installs e.g. `crossengin.erp.education` resolves to the fully-merged education
 * manifest (its entities + the core lineage).
 */
export const BUILTIN_PACK_MARKETPLACE_IDS: Readonly<Record<string, string>> = {
  "crossengin.erp.core": "erp-core",
  "crossengin.erp.retail": "erp-retail",
  "crossengin.erp.healthcare": "erp-healthcare",
  "crossengin.erp.grocery": "erp-grocery",
  "crossengin.erp.construction": "erp-construction",
  "crossengin.erp.education": "erp-education",
};

/**
 * A resolver over the built-in vertical packs (mapping marketplace pack ids to the
 * `loadBuiltinPack` aliases). `version` is ignored — the built-ins aren't versioned.
 */
export function buildBuiltinPackResolver(): PackManifestResolver {
  return {
    async resolve(packId: string): Promise<Manifest | null> {
      const alias = BUILTIN_PACK_MARKETPLACE_IDS[packId];
      if (alias === undefined) return null;
      return loadBuiltinPack(alias);
    },
  };
}

/** One installed pack resolved into the entities/views it contributes to a tenant. */
export interface ResolvedSurfacePack {
  readonly packId: string;
  readonly version: string | null;
  /** False when the pack id couldn't be resolved to a manifest (unknown to this deployment). */
  readonly resolved: boolean;
  readonly entities: readonly string[];
  readonly views: readonly string[];
}

/** A tenant's effective marketplace surface — the union of its installed packs. */
export interface TenantSurface {
  readonly packs: readonly ResolvedSurfacePack[];
  readonly entities: readonly string[];
  readonly views: readonly string[];
}

/** One installed pack's resolved manifest (or `null` when the pack id is unknown). */
export interface ResolvedInstalledPack {
  readonly packId: string;
  readonly version: string | null;
  readonly manifest: Manifest | null;
}

/**
 * Resolves a tenant's **installed** pack installations to their manifests via the
 * seam (a non-`installed` pack isn't live yet, so it's skipped). One resolve per
 * installed pack — the caller can compute both the surface and the route set from
 * the result without resolving twice.
 */
export async function resolveInstalledManifests(
  installations: readonly PackInstallation[],
  resolver: PackManifestResolver,
): Promise<readonly ResolvedInstalledPack[]> {
  const out: ResolvedInstalledPack[] = [];
  for (const inst of installations) {
    if (inst.status !== "installed") continue;
    out.push({ packId: inst.packId, version: inst.installedVersion, manifest: await resolver.resolve(inst.packId, inst.installedVersion) });
  }
  return out;
}

/** Composes resolved installed packs into the entity/view surface union. */
export function surfaceFromResolved(resolved: readonly ResolvedInstalledPack[]): TenantSurface {
  const packs: ResolvedSurfacePack[] = [];
  const entities = new Set<string>();
  const views = new Set<string>();
  for (const r of resolved) {
    if (r.manifest === null) {
      packs.push({ packId: r.packId, version: r.version, resolved: false, entities: [], views: [] });
      continue;
    }
    const packEntities = (r.manifest.entities ?? []).map((e) => e.name);
    const packViews = Object.keys(r.manifest.views ?? {});
    for (const e of packEntities) entities.add(e);
    for (const v of packViews) views.add(v);
    packs.push({ packId: r.packId, version: r.version, resolved: true, entities: packEntities, views: packViews });
  }
  return { packs, entities: [...entities].sort(), views: [...views].sort() };
}

/**
 * Composes a tenant's **installed** pack installations into a surface descriptor:
 * each pack's manifest is resolved (via the seam) and the union of entity + view
 * names is reported, plus the per-pack contribution. Pure given the installations +
 * resolver. Only `installed` packs contribute (a `requested`/`installing`/… pack
 * isn't live yet).
 */
export async function resolveTenantSurface(
  installations: readonly PackInstallation[],
  resolver: PackManifestResolver,
): Promise<TenantSurface> {
  return surfaceFromResolved(await resolveInstalledManifests(installations, resolver));
}
