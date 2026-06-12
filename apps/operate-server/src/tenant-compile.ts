import type { Manifest } from "@crossengin/kernel/manifest";
import { manifestRouteSpecs, pathTemplate } from "@crossengin/operate-runtime";

/**
 * Composes a tenant's base served manifest with its installed packs' (resolved)
 * manifests into one manifest (Phase 3 P5.4). Entities dedupe by name (base wins,
 * so shared core entities appear once); relations dedupe by `kind:from.field->to`;
 * roles / permissions / workflows / views / reports / dashboards merge by key
 * (base entries kept on a key collision). The base `meta` (the tenant's served
 * identity) is preserved. Distinct verticals (each over the shared core) compose
 * cleanly — no entity-name or role collisions.
 */
export function composeTenantManifest(base: Manifest, packs: readonly Manifest[]): Manifest {
  const entitiesByName = new Map((base.entities ?? []).map((e) => [e.name, e]));
  const relations = [...(base.relations ?? [])];
  const relKey = (r: { kind: string; from: string; field: string; to: string }): string =>
    `${r.kind}:${r.from}.${r.field}->${r.to}`;
  const relSeen = new Set(relations.map((r) => relKey(r as never)));
  let roles = { ...(base.roles ?? {}) };
  let permissions = { ...(base.permissions ?? {}) };
  let workflows = { ...(base.workflows ?? {}) };
  let views = { ...(base.views ?? {}) };
  let reports = { ...(base.reports ?? {}) };
  let dashboards = { ...(base.dashboards ?? {}) };

  for (const pack of packs) {
    for (const e of pack.entities ?? []) if (!entitiesByName.has(e.name)) entitiesByName.set(e.name, e);
    for (const r of pack.relations ?? []) {
      const k = relKey(r as never);
      if (!relSeen.has(k)) {
        relSeen.add(k);
        relations.push(r);
      }
    }
    // base entries win on a key collision (spread base last would, but distinct
    // verticals don't collide; we keep base authoritative by spreading it first).
    roles = { ...(pack.roles ?? {}), ...roles };
    permissions = { ...(pack.permissions ?? {}), ...permissions };
    workflows = { ...(pack.workflows ?? {}), ...workflows };
    views = { ...(pack.views ?? {}), ...views };
    reports = { ...(pack.reports ?? {}), ...reports };
    dashboards = { ...(pack.dashboards ?? {}), ...dashboards };
  }

  return {
    ...base,
    entities: [...entitiesByName.values()],
    relations,
    roles,
    permissions,
    workflows,
    views,
    reports,
    dashboards,
  };
}

/** A single REST route the composed (per-tenant) manifest would serve. */
export interface TenantRouteSummary {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly entity: string;
  readonly action: string;
}

/**
 * Derives the per-tenant served route specs from the composed manifest using the
 * **same** `manifestRouteSpecs` the gateway compiles — so the routes reported are
 * exactly the ones the tenant's installs would serve (CRUD + lifecycle transitions).
 */
export function tenantRouteSummaries(base: Manifest, packs: readonly Manifest[]): readonly TenantRouteSummary[] {
  const composed = composeTenantManifest(base, packs);
  return manifestRouteSpecs(composed).map((spec) => ({
    operationId: spec.operationId,
    method: spec.method,
    path: pathTemplate(spec.pathSegments),
    entity: spec.entity,
    action: spec.action,
  }));
}
