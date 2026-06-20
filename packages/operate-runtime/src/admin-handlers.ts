import type { RoleName } from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";

import { TenantSettingsSchema, type SettingsStore } from "./settings.js";

export interface AdminContext {
  readonly settingsStore: SettingsStore;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to read/write tenant settings. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<RoleName>;
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
    const updatedBy = principal?.principalId ?? null;
    return json(200, await ctx.settingsStore.put(tenantId, parsed.data, updatedBy));
  };
}
