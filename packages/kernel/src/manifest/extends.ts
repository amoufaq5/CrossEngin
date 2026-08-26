import type { Entity, Relation } from "@crossengin/types/meta-schema";
import {
  ExtendsCycleError,
  UndeclaredEntityOverrideError,
  UnknownParentManifestError,
} from "./errors.js";
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

  // Parents merge last-wins among themselves: a collision between two independently-authored
  // parents is the child's ambiguity to resolve by choosing them, and neither parent could
  // sensibly declare it is overriding the other. Only the local manifest must declare intent.
  for (const parent of resolvedParents) {
    composed = mergeContent(composed, parent, { requireOverrideMarker: false });
  }

  composed = mergeContent(composed, manifest, { requireOverrideMarker: true });

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

interface MergeOptions {
  readonly requireOverrideMarker: boolean;
}

function mergeContent(base: Manifest, overlay: Manifest, opts: MergeOptions): Manifest {
  return {
    manifestVersion: base.manifestVersion,
    meta: base.meta,
    entities: mergeEntities(base.entities, overlay.entities, opts),
    traits: mergeNamedArray(base.traits, overlay.traits, (t) => t.name),
    relations: pruneOverriddenRelations(
      concatOrUndefined(base.relations, overlay.relations),
      mergeEntities(base.entities, overlay.entities, opts),
      overriddenNames(base.entities, overlay.entities),
    ),
    roles: mergeRecord(base.roles, overlay.roles),
    permissions: mergeRecord(base.permissions, overlay.permissions),
    workflows: mergeRecord(base.workflows, overlay.workflows),
    integrations: mergeRecord(base.integrations, overlay.integrations),
    jobs: mergeRecord(base.jobs, overlay.jobs),
    files: mergeRecord(base.files, overlay.files),
    reports: mergeRecord(base.reports, overlay.reports),
    dashboards: mergeRecord(base.dashboards, overlay.dashboards),
    views: mergeRecord(base.views, overlay.views),
    customWidgets: mergeRecord(base.customWidgets, overlay.customWidgets),
    ...(overlay.theme !== undefined || base.theme !== undefined
      ? { theme: { ...(base.theme ?? {}), ...(overlay.theme ?? {}) } }
      : {}),
    ...(overlay.i18n !== undefined || base.i18n !== undefined
      ? {
          i18n: mergeI18nBundles(base.i18n, overlay.i18n),
        }
      : {}),
    ...(overlay.search !== undefined || base.search !== undefined
      ? { search: mergeSearch(base.search, overlay.search) }
      : {}),
  };
}

function mergeSearch(
  base: Manifest["search"],
  overlay: Manifest["search"],
): Manifest["search"] {
  if (base === undefined && overlay === undefined) return undefined;
  const baseEntities = base?.entities ?? {};
  const overlayEntities = overlay?.entities ?? {};
  const baseFiles = base?.files;
  const overlayFiles = overlay?.files;
  const mergedFiles =
    overlayFiles !== undefined || baseFiles !== undefined
      ? {
          globalIndex: overlayFiles?.globalIndex ?? baseFiles?.globalIndex ?? false,
          ocr: overlayFiles?.ocr ?? baseFiles?.ocr ?? false,
          embedding: overlayFiles?.embedding ?? baseFiles?.embedding ?? false,
          embeddingScope:
            overlayFiles?.embeddingScope ?? baseFiles?.embeddingScope ?? "tenant",
        }
      : undefined;
  return {
    entities: { ...baseEntities, ...overlayEntities },
    defaultDictionary:
      overlay?.defaultDictionary ?? base?.defaultDictionary ?? "simple",
    ...(mergedFiles !== undefined ? { files: mergedFiles } : {}),
  };
}

function mergeI18nBundles(
  base: Manifest["i18n"],
  overlay: Manifest["i18n"],
): Manifest["i18n"] {
  if (base === undefined) return overlay;
  if (overlay === undefined) return base;
  const translations: Record<string, Record<string, string>> = {};
  for (const [locale, keys] of Object.entries(base.translations)) {
    translations[locale] = { ...keys };
  }
  for (const [locale, keys] of Object.entries(overlay.translations)) {
    translations[locale] = { ...(translations[locale] ?? {}), ...keys };
  }
  const mergedSupported = Array.from(
    new Set([...base.supportedLocales, ...overlay.supportedLocales]),
  );
  return {
    defaultLocale: overlay.defaultLocale ?? base.defaultLocale,
    supportedLocales: mergedSupported,
    rtlLocales: overlay.rtlLocales ?? base.rtlLocales,
    currency: overlay.currency ?? base.currency,
    alternativeCurrencies: Array.from(
      new Set([...base.alternativeCurrencies, ...overlay.alternativeCurrencies]),
    ),
    timezone: overlay.timezone ?? base.timezone,
    firstDayOfWeek: overlay.firstDayOfWeek ?? base.firstDayOfWeek,
    weekendDays: overlay.weekendDays ?? base.weekendDays,
    numberingSystem: overlay.numberingSystem ?? base.numberingSystem,
    calendar: overlay.calendar ?? base.calendar,
    translations,
  };
}

/**
 * Entity names an overlay replaces rather than adds. A replacement must say so via
 * `overrides: true`; an undeclared collision is refused in `mergeEntities`.
 */
function overriddenNames(
  base: readonly Entity[] | undefined,
  overlay: readonly Entity[] | undefined,
): ReadonlySet<string> {
  const baseNames = new Set((base ?? []).map((e) => e.name));
  const out = new Set<string>();
  for (const e of overlay ?? []) if (baseNames.has(e.name)) out.add(e.name);
  return out;
}

/**
 * Last-write-wins by name, as before — but a silent win is the bug this guards. A pack that
 * reuses an inherited entity name destroys the parent's version and leaves everything the
 * parent hung off its fields dangling, so the replacement must declare `overrides: true` and
 * thereby take responsibility for the difference.
 */
function mergeEntities(
  base: readonly Entity[] | undefined,
  overlay: readonly Entity[] | undefined,
  opts: MergeOptions,
): Entity[] | undefined {
  if (base === undefined && overlay === undefined) return undefined;
  const byName = new Map<string, Entity>();
  for (const e of base ?? []) byName.set(e.name, e);
  for (const e of overlay ?? []) {
    if (opts.requireOverrideMarker && byName.has(e.name) && e.overrides !== true) {
      throw new UndeclaredEntityOverrideError(e.name);
    }
    byName.set(e.name, e);
  }
  return Array.from(byName.values());
}

/**
 * A replacement need not carry every field the original had, so relations the parent declared
 * on fields the replacement dropped can no longer be emitted. Only `many_to_one` binds a column
 * on its `from` entity; a `one_to_many`'s field names an inverse collection and survives.
 */
function pruneOverriddenRelations(
  relations: readonly Relation[] | undefined,
  entities: readonly Entity[] | undefined,
  overridden: ReadonlySet<string>,
): Relation[] | undefined {
  if (relations === undefined) return undefined;
  if (overridden.size === 0) return [...relations];
  const fieldsByEntity = new Map(
    (entities ?? []).map((e) => [e.name, new Set(e.fields.map((f) => f.name))] as const),
  );
  return relations.filter((rel) => {
    if (rel.kind !== "many_to_one") return true;
    if (!overridden.has(rel.from)) return true;
    return fieldsByEntity.get(rel.from)?.has(rel.field) ?? false;
  });
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
