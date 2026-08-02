import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";

import type { EntitlementResolver } from "./entitlement.js";
import type { EntityStore } from "./store.js";

/** When the plan is unlimited, count each entity up to this ceiling before reporting `overflow`. */
export const DEFAULT_USAGE_DISPLAY_CEILING = 1000;

export interface EntityUsage {
  readonly entity: string;
  /** Records counted, bounded at the plan cap (or the display ceiling when unlimited). */
  readonly used: number;
  /** True when there may be more than `used` — the bounded probe hit its ceiling. */
  readonly overflow: boolean;
  /** True when the plan sets a cap and this entity is at or over it. */
  readonly atLimit: boolean;
}

/** The caller tenant's per-entity record usage against its plan cap, for the billing screen. */
export interface UsageView {
  readonly maxRecordsPerEntity: number | null;
  readonly entities: readonly EntityUsage[];
}

export interface UsageHandlerContext {
  readonly resolver: EntitlementResolver;
  readonly store: EntityStore;
  /** The manifest's entity names to report usage for. */
  readonly entities: readonly string[];
  readonly displayCeiling?: number;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * `GET /v1/meta/usage` — the caller tenant's per-entity record counts against its plan cap,
 * driving the billing screen's "N of M used" meter. Ungated (own tenant only, like the
 * entitlement route) so a lapsed tenant can still see why they're blocked. Counts are
 * **bounded**: each entity is probed for at most `cap+1` (or `displayCeiling+1` when the plan
 * is unlimited) rows via `listPage`, so the endpoint never scans a full table — `overflow`
 * flags an entity whose true count exceeds the probe. A null entitlement reports a null cap
 * with every entity `atLimit:false` (no cap to breach).
 */
export function buildUsageHandler(ctx: UsageHandlerContext): Handler {
  const ceiling = ctx.displayCeiling ?? DEFAULT_USAGE_DISPLAY_CEILING;
  return async ({ principal }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    const entitlement = await ctx.resolver.resolve(tenantId);
    const cap = entitlement?.maxRecordsPerEntity ?? null;
    const probeCeiling = cap ?? ceiling;
    const entities: EntityUsage[] = [];
    for (const entity of ctx.entities) {
      const page = await ctx.store.listPage(tenantId, entity, {
        limit: probeCeiling + 1,
        cursor: null,
        sort: [],
        filters: [],
      });
      const len = page.records.length;
      entities.push({
        entity,
        used: Math.min(len, probeCeiling),
        overflow: len > probeCeiling,
        atLimit: cap !== null && len >= cap,
      });
    }
    const view: UsageView = { maxRecordsPerEntity: cap, entities };
    return json(200, view);
  };
}
