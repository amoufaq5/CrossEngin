import type { Manifest } from "@crossengin/kernel/manifest";
import type { PathSegment } from "@crossengin/api-gateway";

import { REPORT_RUN_OPERATION_ID } from "./report-routes.js";
import type { RouteAction, RouteSpec } from "./operations.js";

/**
 * A serializable description of the serving API: one entry per gateway operation
 * (the entity CRUD + lifecycle routes, plus the report route) and the catalog of
 * available manifest reports. It is the structural source the OpenAPI document is
 * projected from, and is itself useful to a client that just wants the operation
 * list. Pure data — no handler/runtime references.
 */
export interface ApiOperation {
  readonly operationId: string;
  readonly method: string;
  /** Path template with `{param}` placeholders, e.g. `/v1/products/{id}`. */
  readonly path: string;
  readonly kind: RouteAction | "report";
  readonly entity?: string;
  readonly transition?: string;
}

export interface ReportDescriptor {
  readonly name: string;
  readonly kind: string;
  readonly entity: string;
  readonly label?: string;
}

export interface ApiDescriptor {
  readonly apiVersion: string;
  readonly operations: readonly ApiOperation[];
  readonly reports: readonly ReportDescriptor[];
}

/** Renders a route's path segments as a `{param}` template, e.g. `/v1/products/{id}`. */
export function pathTemplate(segments: readonly PathSegment[]): string {
  const parts = segments.map((s) => {
    if (s.kind === "literal") return s.value;
    if (s.kind === "parameter") return `{${s.name}}`;
    return "*";
  });
  return `/${parts.join("/")}`;
}

/** Projects the entity route specs to API operations (CRUD + lifecycle transitions). */
export function operationsFromRouteSpecs(routeSpecs: readonly RouteSpec[]): readonly ApiOperation[] {
  return routeSpecs.map((spec) => ({
    operationId: spec.operationId,
    method: spec.method,
    path: pathTemplate(spec.pathSegments),
    kind: spec.action,
    entity: spec.entity,
    ...(spec.transition !== undefined ? { transition: spec.transition.name } : {}),
  }));
}

interface RawReport {
  readonly kind?: unknown;
  readonly entity?: unknown;
  readonly label?: { readonly en?: unknown } | undefined;
}

/**
 * Extracts the report catalog from a manifest's `reports` map (read structurally,
 * since the report shape lives in `@crossengin/operate-web` which `operate-runtime`
 * doesn't depend on). Each entry carries its name, kind, entity, and English label
 * if present. Reports missing a string `kind`/`entity` are skipped (malformed).
 */
export function reportDescriptorsFromManifest(manifest: Manifest): readonly ReportDescriptor[] {
  const reports = (manifest as unknown as { reports?: Record<string, RawReport> }).reports ?? {};
  const out: ReportDescriptor[] = [];
  for (const [name, raw] of Object.entries(reports)) {
    if (typeof raw?.kind !== "string" || typeof raw?.entity !== "string") continue;
    const label = typeof raw.label?.en === "string" ? raw.label.en : undefined;
    out.push({ name, kind: raw.kind, entity: raw.entity, ...(label !== undefined ? { label } : {}) });
  }
  return out;
}

/** The path template for the report route (matches `reportRouteDefinition`). */
export const REPORT_ROUTE_PATH = "/v1/reports/{report}";

export interface BuildApiDescriptorOptions {
  /** Include the `GET /v1/reports/:report` operation (only when a report runner is wired). */
  readonly includeReportRoute: boolean;
  readonly apiVersion?: string;
}

/**
 * Builds the full `ApiDescriptor` from the compiled entity route specs + the
 * manifest's report catalog. The report *route* operation is included only when
 * `includeReportRoute` is set (i.e. a report runner was wired), while the report
 * *catalog* always reflects the manifest's declared reports.
 */
export function buildApiDescriptor(
  manifest: Manifest,
  routeSpecs: readonly RouteSpec[],
  options: BuildApiDescriptorOptions,
): ApiDescriptor {
  const operations = [...operationsFromRouteSpecs(routeSpecs)];
  if (options.includeReportRoute) {
    operations.push({
      operationId: REPORT_RUN_OPERATION_ID,
      method: "GET",
      path: REPORT_ROUTE_PATH,
      kind: "report",
    });
  }
  return {
    apiVersion: options.apiVersion ?? "v1",
    operations,
    reports: reportDescriptorsFromManifest(manifest),
  };
}
