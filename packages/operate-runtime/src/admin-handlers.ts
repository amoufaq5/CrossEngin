import type { RoleName } from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";

import { TenantSettingsSchema, type SettingsStore } from "./settings.js";
import type { EntityStore } from "./store.js";
import { resolveTaxJurisdiction } from "./tax-determination.js";

export interface AdminContext {
  readonly settingsStore: SettingsStore;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to read/write tenant settings. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<RoleName>;
  /**
   * Where `finance.defaultTaxJurisdiction` is checked on save (ADR-0480, ADR-0432 Q5): present only
   * when the manifest declares the jurisdiction entity, since a deployment with none has nothing the
   * code could name and the posting never resolves it either. Absent, the setting is saved as before.
   */
  readonly taxJurisdictions?: {
    readonly store: Pick<EntityStore, "listPage">;
    readonly entity: string;
  };
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function authorize(ctx: AdminContext, principal: ResolvedPrincipal | null): string | null {
  const tenantId = principal?.tenantId ?? null;
  if (tenantId === null) return null;
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  const roles = [primaryRole, ...(secondaryRoles ?? [])];
  return roles.some((r) => ctx.adminRoles.has(r as RoleName)) ? tenantId : "";
}

export function buildAdminSettingsReadHandler(ctx: AdminContext): Handler {
  return async ({ principal }) => {
    const tenantId = authorize(ctx, principal);
    if (tenantId === null) return json(401, { error: "tenant_required" });
    if (tenantId === "") return json(403, { error: "forbidden", detail: "admin role required" });
    return json(200, await ctx.settingsStore.get(tenantId));
  };
}

export function buildAdminSettingsUpdateHandler(ctx: AdminContext): Handler {
  return async ({ principal, parsedBody }) => {
    const tenantId = authorize(ctx, principal);
    if (tenantId === null) return json(401, { error: "tenant_required" });
    if (tenantId === "") return json(403, { error: "forbidden", detail: "admin role required" });
    const parsed = TenantSettingsSchema.safeParse(parsedBody ?? {});
    if (!parsed.success) {
      return json(400, { error: "invalid_settings", detail: parsed.error.issues });
    }
    // The code is resolved by the function the posting resolves it with, so a value saved here is
    // one the first `send` can use. Before this a typo saved with a 200 and surfaced only at the
    // first invoice, as a 409 naming a setting the admin had already left the page for.
    const jurisdiction = parsed.data.finance?.defaultTaxJurisdiction?.trim();
    if (ctx.taxJurisdictions !== undefined && jurisdiction !== undefined && jurisdiction.length > 0) {
      const found = await resolveTaxJurisdiction(ctx.taxJurisdictions.store, tenantId, jurisdiction, ctx.taxJurisdictions.entity);
      if (found === null) {
        return json(422, {
          error: "tax_jurisdiction_unresolved",
          detail:
            `finance.defaultTaxJurisdiction '${jurisdiction}' names no single active ${ctx.taxJurisdictions.entity} ` +
            `in this tenant; create it first, correct the code, or leave the setting unset`,
        });
      }
    }
    const updatedBy = principal?.principalId ?? null;
    return json(200, await ctx.settingsStore.put(tenantId, parsed.data, updatedBy));
  };
}
