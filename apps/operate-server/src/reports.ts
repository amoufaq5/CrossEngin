import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  listConfigForEntity,
  parseListQuery,
  type EntityStore,
  type ReportRunArgs,
  type ReportRunner,
} from "@crossengin/operate-runtime";
import {
  EntityFieldResolver,
  entityFields,
  executeReport,
  type CompileOptions,
  type ReportData,
  type ReportSpec,
} from "@crossengin/operate-web";

/**
 * Executes a report for a caller: aggregates over its entity's data and applies
 * the field-readability gate. A full-dataset SQL-pushdown executor (the
 * `@crossengin/operate-runtime-pg` `PostgresReportExecutor` /
 * `PostgresColumnReportExecutor`) satisfies this, as does the bounded in-memory
 * fallback below. Returns `null` for an unsupported kind or an unreadable field
 * (fail-closed).
 */
export type ReportExecutor = (
  report: ReportSpec,
  tenantId: string,
  canRead: (field: string) => boolean,
) => Promise<ReportData | null>;

export interface ManifestReportRunnerOptions {
  readonly manifest: Manifest;
  readonly store: EntityStore;
  /** Bridges the gateway principal to its effective roles (the auth wiring). */
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Optional full-dataset SQL-pushdown executor; absent → bounded in-memory. */
  readonly executor?: ReportExecutor;
  readonly compileOptions?: CompileOptions;
}

/** The in-memory fallback's row ceiling (full-dataset aggregation needs an executor). */
const MAX_IN_MEMORY_ROWS = 500;

/**
 * Builds the `ReportRunner` the gateway's `GET /v1/reports/:report` route
 * dispatches to. It mirrors `apps/operate-web`'s report serving: resolve the
 * named report from `manifest.reports`, derive the caller's field-readability
 * gate from the report-entity classification (the same `EntityFieldResolver` the
 * UI uses, so redaction is identical across both apps), then aggregate — via the
 * injected SQL-pushdown executor when set, else a bounded in-memory `listPage` +
 * the pure `executeReport`. Unknown report / unknown entity / unreadable field
 * → `null` (the handler maps that to a fail-closed 404).
 */
export function buildManifestReportRunner(opts: ManifestReportRunnerOptions): ReportRunner {
  const reports = (opts.manifest as unknown as { reports?: Record<string, ReportSpec> }).reports ?? {};
  const entitiesByName = new Map((opts.manifest.entities ?? []).map((e) => [e.name, e]));

  function rolesOf(principal: ResolvedPrincipal | null): readonly string[] {
    const { primaryRole, secondaryRoles } = opts.principalRoles(principal);
    return [primaryRole, ...(secondaryRoles ?? [])].filter(
      (r): r is string => typeof r === "string" && r.length > 0,
    );
  }

  function canReadFor(report: ReportSpec, roles: readonly string[]): (field: string) => boolean {
    const ent = entitiesByName.get(report.entity);
    if (ent === undefined) return () => false;
    const access = new EntityFieldResolver(
      opts.manifest,
      report.entity,
      { roles },
      opts.compileOptions ?? {},
    ).resolve(entityFields(ent));
    return (field: string): boolean => access.get(field)?.read !== false;
  }

  return {
    async run(name: string, args: ReportRunArgs): Promise<unknown | null> {
      const report = reports[name];
      if (report === undefined || !entitiesByName.has(report.entity)) return null;
      const canRead = canReadFor(report, rolesOf(args.principal));
      if (opts.executor !== undefined) return opts.executor(report, args.tenantId, canRead);
      const config = listConfigForEntity(opts.manifest, report.entity);
      const page = await opts.store.listPage(
        args.tenantId,
        report.entity,
        parseListQuery({ limit: String(MAX_IN_MEMORY_ROWS) }, config),
      );
      return executeReport(report, page.records, canRead);
    },
  };
}
