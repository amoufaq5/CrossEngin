import type { RefusedServing, TenantSchemaApplication } from "@crossengin/operate-runtime-pg";

/**
 * The `[tenant-schema] … REFUSED` line, saying what the tenant is served while the refusal stands —
 * from the registry's own answer, the one `ensureServing` gives the gateway, so the line and the
 * response cannot name different arms. It named the JSONB fallback for a restart over a schema that
 * already held the tenant's tables, beside the 503 `tenant_schema_stranded` every request got.
 */
export function formatTenantSchemaRefusal(
  application: TenantSchemaApplication,
  refusal: RefusedServing | null,
): string {
  const blocking = application.changes.filter((c) => c.blocking);
  const served =
    refusal === null
      ? ""
      : refusal.kind === "retained"
        ? `still serving the last applied manifest ${refusal.retained.manifestHash.slice(0, 12)} from ` +
          `${refusal.retained.schema} — the re-activation does not take effect until this is resolved. `
        : refusal.kind === "stranded"
          ? `NOT serving it: ${refusal.schema} already holds this tenant's tables and this process` +
            ` does not know which manifest built them, so every request answers 503` +
            ` tenant_schema_stranded until the activated manifest applies. `
          : `serving from the JSONB fallback. `;
  return (
    `[tenant-schema] ${application.tenantId} REFUSED; ` +
    served +
    blocking.map((c) => `${c.table}.${c.column ?? "-"}: ${c.detail}`).join("; ")
  );
}
