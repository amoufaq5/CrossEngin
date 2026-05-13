import { ExtendsCycleError, UnknownParentManifestError } from "./errors.js";
import { manifestHash } from "./hash.js";
import type { Manifest, ManifestMeta, ManifestResolutionEntry } from "./types.js";

export interface ManifestRegistry {
  getManifest(parentId: string): Promise<Manifest | null>;
}

export interface ResolveContext {
  readonly registry: ManifestRegistry;
}

export async function resolveManifest(
  manifest: Manifest,
  context: ResolveContext,
): Promise<Manifest> {
  const { manifest: resolved, parents } = await resolveInternal(manifest, context, new Set());
  if (parents.length === 0) {
    return resolved;
  }
  return {
    ...resolved,
    meta: { ...resolved.meta, manifestResolution: { parents } },
  };
}

interface ResolveResult {
  manifest: Manifest;
  parents: ManifestResolutionEntry[];
}

async function resolveInternal(
  manifest: Manifest,
  context: ResolveContext,
  visited: ReadonlySet<string>,
): Promise<ResolveResult> {
  const slug = manifest.meta.slug;
  if (visited.has(slug)) {
    throw new ExtendsCycleError([...visited, slug]);
  }

  const extendsList = manifest.meta.extends ?? [];
  if (extendsList.length === 0) {
    return { manifest: stripExtends(manifest), parents: [] };
  }

  const newVisited = new Set(visited);
  newVisited.add(slug);

  const entries: ManifestResolutionEntry[] = [];
  const resolvedParents: Manifest[] = [];

  for (const parentId of extendsList) {
    const parent = await context.registry.getManifest(parentId);
    if (parent === null) {
      throw new UnknownParentManifestError(parentId, slug);
    }

    entries.push({
      slug: parent.meta.slug,
      version: parent.meta.version,
      hash: manifestHash(parent),
      parentId,
    });

    const parentResult = await resolveInternal(parent, context, newVisited);
    entries.push(...parentResult.parents);
    resolvedParents.push(parentResult.manifest);
  }

  let composed: Manifest = {
    manifestVersion: manifest.manifestVersion,
    meta: stripExtendsFromMeta(manifest.meta),
  };

  for (const parent of resolvedParents) {
    composed = mergeContent(composed, parent);
  }

  composed = mergeContent(composed, manifest);

  return { manifest: composed, parents: entries };
}

function stripExtends(manifest: Manifest): Manifest {
  return { ...manifest, meta: stripExtendsFromMeta(manifest.meta) };
}

function stripExtendsFromMeta(meta: ManifestMeta): ManifestMeta {
  const result = { ...meta };
  delete result.extends;
  return result;
}

function mergeContent(base: Manifest, overlay: Manifest): Manifest {
  return {
    manifestVersion: base.manifestVersion,
    meta: base.meta,
    entities: mergeNamedArray(base.entities, overlay.entities, (e) => e.name),
    traits: mergeNamedArray(base.traits, overlay.traits, (t) => t.name),
    relations: concatOrUndefined(base.relations, overlay.relations),
    roles: mergeRecord(base.roles, overlay.roles),
    permissions: mergeRecord(base.permissions, overlay.permissions),
    workflows: mergeRecord(base.workflows, overlay.workflows),
    integrations: mergeRecord(base.integrations, overlay.integrations),
    jobs: mergeRecord(base.jobs, overlay.jobs),
  };
}

function mergeNamedArray<T>(
  base: readonly T[] | undefined,
  overlay: readonly T[] | undefined,
  keyOf: (item: T) => string,
): T[] | undefined {
  if (base === undefined && overlay === undefined) return undefined;
  const byKey = new Map<string, T>();
  for (const item of base ?? []) byKey.set(keyOf(item), item);
  for (const item of overlay ?? []) byKey.set(keyOf(item), item);
  return Array.from(byKey.values());
}

function concatOrUndefined<T>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
): T[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  return [...(a ?? []), ...(b ?? [])];
}

function mergeRecord<T>(
  base: Readonly<Record<string, T>> | undefined,
  overlay: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  if (base === undefined && overlay === undefined) return undefined;
  return { ...(base ?? {}), ...(overlay ?? {}) };
}
