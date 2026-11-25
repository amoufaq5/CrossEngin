import type { Manifest } from "@crossengin/kernel/manifest";
import { approveClassTransitions, formatSegregationOfDuties, type ReportSurface } from "@crossengin/operate-runtime";
import { planDocumentIntegrity, type TenantServing } from "@crossengin/operate-runtime-pg";

import type { StoreKind } from "./cli.js";
import { decidePhiStorage, surveyPhiFields, type PhiStorageDecision, type PhiStorageVerdict } from "./column-encryption.js";
import {
  formatCursorDisclosure,
  type CursorDisclosureDecision,
  type CursorDisclosureVerdict,
} from "./cursor-encryption.js";
import { formatListSurfaceReport, surveyListSurfaces, type ListSurfaceReport, type ListSurfaceVerdict } from "./list-surface-survey.js";
import { formatManifestSectionSurvey, surveyManifestSections, type ManifestSectionSurvey } from "./manifest-section-survey.js";
import { formatReportSurfaceSurvey, surveyReportSurfaces, type ReportSurfaceSurvey } from "./report-surface-survey.js";
import {
  formatSensitiveFieldSurvey,
  type SensitiveFieldSurvey,
} from "./sensitive-field-policy.js";
import {
  formatUniqueEnforcementReport,
  surveyUniqueEnforcement,
  type UniqueEnforcementReport,
  type UniqueEnforcementVerdict,
} from "./unique-enforcement.js";
import {
  formatViewPermissionSurvey,
  surveyViewPermissionOverrides,
  type ViewPermissionSurvey,
  type ViewPermissionVerdict,
} from "./view-permission-survey.js";

/**
 * How a **tenant's own activated manifest** reports the surveys that used to run only at boot.
 *
 * `serve()` surveys the boot pack and prints `[fields]`, `[cursor]`, `[list]`, `[unique]`,
 * `[manifest]`, `[views]`, `[reports]`, `[sod]`, `[jobs]` and `[phi]` lines; a tenant serving its own
 * manifest (ADR-0314) is compiled inside `buildOperateHttpServer` and was surveyed for two of those
 * ten (ADR-0397), so eight boot findings were unmeasured for exactly the input the AI Architect
 * produces (register P1.12a, ADR-0416 Q5, ADR-0421 Q4, ADR-0413 Q4, ADR-0445 Q9, ADR-0472). This
 * renders the per-tenant answer for all of them, plus the one fact only a tenant has — where it is
 * served from.
 *
 * Four decisions:
 *
 *   - **The sentences have one producer each.** Every boot formatter is called rather than restated,
 *     so the boot line and the per-tenant line cannot come to describe one finding differently. The
 *     three findings with no boot counterpart — the document-store index gap, the tenant's own jobs,
 *     and where the tenant is served from — are written here because no boot line exists to borrow.
 *   - **Every line is prefixed, not the block.** Several formatters return a `\n`-joined block of
 *     already-prefixed lines, so tagging the block would leave lines 2..N unattributable in a
 *     multi-tenant log.
 *   - **Silent when clean** (ADR-0397's scale rule): a line per tenant per activation that says
 *     nothing is the line an operator filters, taking the findings with it.
 *   - **Whether a survey is a finding is a total map over its verdict**, never a comparison against
 *     a hand-picked verdict name (ADR-0397 Q5). A comparison `verdict === "plaintext_disclosing"` is a
 *     maintained list of one: a fifth cursor verdict would inherit "not a finding" in silence. A
 *     `Record<Verdict, boolean>` makes it a compile error until somebody says which it is.
 */

/**
 * Where a tenant's gateway reads and writes its records, after `ensureServing`.
 *
 *   - `own_schema` — the tenant's activated manifest applied to its own schema (ADR-0314).
 *   - `own_schema_retained` — a re-activation was refused, so the tenant is served the **last
 *     applied** manifest over its own schema, not the one it activated.
 *   - `fallback` — the application was refused and nothing was applied before, so the tenant is
 *     served from the deployment's JSONB document store (ADR-0314's degraded answer).
 *   - `shared` — the deployment runs no per-tenant schemas (`--store pg` or `memory`), so every
 *     tenant is served from the one store; this is the design, not a degradation.
 *
 * `stranded` is not a member: that arm throws before a gateway is compiled, so no survey runs.
 */
export const TENANT_SERVED_FROM = ["own_schema", "own_schema_retained", "fallback", "shared"] as const;
export type TenantServedFrom = (typeof TENANT_SERVED_FROM)[number];

/** `ensureServing`'s answer as a served-from fact. Total over the non-throwing arms. */
const SERVED_FROM_BY_SERVING: Readonly<Record<Exclude<TenantServing["kind"], "stranded">, TenantServedFrom>> = {
  applied: "own_schema",
  retained: "own_schema_retained",
  refused: "fallback",
};

/** `null` is a deployment with no per-tenant schema registry, which serves every tenant from one store. */
export function servedFromOf(kind: Exclude<TenantServing["kind"], "stranded"> | null): TenantServedFrom {
  return kind === null ? "shared" : SERVED_FROM_BY_SERVING[kind];
}

const SERVED_FROM_IS_FINDING: Readonly<Record<TenantServedFrom, boolean>> = {
  own_schema: false,
  own_schema_retained: true,
  fallback: true,
  shared: false,
};

/**
 * The store the tenant's records actually go through, for the surveys that answer per store.
 * Its own schema is the column store; the fallback is the JSONB document store whatever `--store`
 * says; `shared` is whatever `--store` says.
 */
function effectiveStore(servedFrom: TenantServedFrom, storeKind: StoreKind): StoreKind {
  switch (servedFrom) {
    case "own_schema":
    case "own_schema_retained":
      return "pg-columns";
    case "fallback":
      return "pg";
    case "shared":
      return storeKind;
  }
}

/* --------------------------------------------- whether each verdict is a finding (total maps) */

const CURSOR_DISCLOSURE_IS_FINDING: Readonly<Record<CursorDisclosureVerdict, boolean>> = {
  no_sortable_classified_field: false,
  sealed: false,
  // Acknowledged deployment-wide by --allow-cursor-disclosure, which is the operator's answer.
  plaintext_accepted: false,
  plaintext_disclosing: true,
};

const LIST_SURFACE_IS_FINDING: Readonly<Record<ListSurfaceVerdict, boolean>> = {
  all_surfaces_serveable: false,
  surfaces_refused: true,
  search_narrowed: true,
};

const UNIQUE_IS_FINDING: Readonly<Record<UniqueEnforcementVerdict, boolean>> = {
  no_declarations: false,
  all_enforced: false,
  partly_enforced: true,
  none_enforced: true,
};

const VIEW_PERMISSION_IS_FINDING: Readonly<Record<ViewPermissionVerdict, boolean>> = {
  no_views: false,
  all_inherit: false,
  overrides_unenforced: true,
};

const AT_REST_IS_FINDING: Readonly<Record<PhiStorageVerdict, boolean>> = {
  no_phi: false,
  encrypted: false,
  // Acknowledged deployment-wide by --allow-plaintext-phi.
  plaintext_accepted: false,
  refused_no_secret: true,
  refused_plaintext_store: true,
};

/* ------------------------------------------------------------------------------ the report */

/** What `buildOperateHttpServer` computed while compiling the tenant's manifest. */
export interface TenantSurveyBase {
  readonly sensitive: SensitiveFieldSurvey;
  readonly cursorDisclosure: CursorDisclosureDecision;
  /** The compiled gateway's report surfaces, so the report survey reads what was mounted. */
  readonly reportSurfaces: readonly ReportSurface[];
}

/** The deployment facts a tenant's survey is read against. */
export interface TenantSurveyContext {
  /** The manifest `serve()` booted, whose jobs every producer reads and whose plan the indexes follow. */
  readonly deploymentManifest: Manifest;
  readonly storeKind: StoreKind;
  readonly servedFrom: TenantServedFrom;
  readonly segregationOfDuties: { readonly enabled: boolean; readonly removalsRead: boolean };
  /** Whether a column key source is configured, and whether plaintext PHI was acknowledged. */
  readonly phi: { readonly keyConfigured: boolean; readonly allowPlaintextPhi: boolean };
  /**
   * `--allow-dangling-references`: the deployment's JSONB store was built with
   * `enforceReferences: false`, so it checks no reference of any manifest. Required, because the
   * document-store gap's reference half is a claim about what that store checks, and a default would
   * assert it checks the deployment's references when the operator turned that off.
   */
  readonly allowDanglingReferences: boolean;
}

/**
 * What the shared JSONB store does **not** enforce of the tenant's manifest.
 *
 * Its unique indexes are built by the owner's `document-indexes` step from the deployment's
 * manifest, and its reference checks follow the plan of the manifest the store was constructed
 * with — the deployment's. So a unique field or a reference field the tenant authored and the
 * deployment's manifest does not declare is enforced by nothing on this store: no index, no lookup.
 * Compared by the index's derived name and by `(entity, field, target)`, which are the keys the
 * store itself uses.
 */
export interface DocumentStoreGap {
  readonly unindexedUnique: readonly string[];
  readonly uncheckedReferences: readonly string[];
  /**
   * Which references the JSONB store this tenant is served from actually checks, which decides both
   * the list above and the sentence explaining it:
   *
   *   - `deployment_plan` — `--store pg`'s boot store, constructed with the deployment's manifest, so
   *     it checks exactly that manifest's references.
   *   - `nothing` — the per-tenant **fallback** on a `--store pg-columns` deployment, which `node.ts`
   *     constructs as `new PostgresEntityStore(conn, schemaOpt)` with **no manifest**, so it checks no
   *     reference at all — inherited ones included. Comparing against the deployment's plan there
   *     would call a reference "checked" that nothing checks.
   *   - `off_by_flag` — `--allow-dangling-references` turned the check off deployment-wide; the boot
   *     line already said so, so no per-tenant reference finding is raised (the operator's answer,
   *     as `plaintext_accepted` is for PHI).
   */
  readonly referencesCheckedBy: "deployment_plan" | "nothing" | "off_by_flag";
}

/** The tenant's jobs no producer of this deployment reads. */
export interface TenantJobGap {
  /** Declared by the tenant and absent from the deployment's manifest: never enqueued, never run. */
  readonly unserved: readonly string[];
  /** Declared by both, differently: the deployment's declaration is the one that runs. */
  readonly divergent: readonly string[];
}

export interface TenantManifestSurveyReport extends TenantSurveyBase {
  readonly servedFrom: TenantServedFrom;
  readonly listSurfaces: ListSurfaceReport;
  readonly uniqueEnforcement: UniqueEnforcementReport | null;
  readonly documentStoreGap: DocumentStoreGap | null;
  readonly sections: ManifestSectionSurvey;
  readonly viewPermissions: ViewPermissionSurvey;
  readonly reports: ReportSurfaceSurvey;
  /** The tenant's approve-class transitions, and whether they differ from the deployment's. */
  readonly sod: { readonly differs: boolean; readonly line: string };
  readonly jobs: TenantJobGap;
  readonly atRest: PhiStorageDecision;
  readonly segregationEnabled: boolean;
  /**
   * What the same surveys find over the **deployment's** manifest on the same store, as signatures.
   * A tenant extending the deployment inherits every boot finding, and the boot line already said
   * those; repeating them per tenant per activation is the noise ADR-0397's scale rule exists to
   * avoid. So for these five kinds a finding holds only when the tenant's manifest **contributes** a
   * signature the deployment's does not carry — and the line, when it prints, still says the whole
   * truth.
   */
  readonly inherited: Readonly<Record<InheritedKind, ReadonlySet<string>>>;
}

/** The kinds whose finding is judged against the deployment's own answer. */
type InheritedKind = "list_surfaces" | "unique_enforcement" | "unserved_sections" | "view_permissions" | "report_surfaces";

interface SignedSurveys {
  readonly listSurfaces: ListSurfaceReport;
  readonly uniqueEnforcement: UniqueEnforcementReport | null;
  readonly sections: ManifestSectionSurvey;
  readonly viewPermissions: ViewPermissionSurvey;
  readonly reports: ReportSurfaceSurvey;
}

/** One string per finding member, so two answers compare as sets. Total over the inherited kinds. */
const SIGNATURES: Readonly<Record<InheritedKind, (s: SignedSurveys) => readonly string[]>> = {
  list_surfaces: (s) =>
    LIST_SURFACE_IS_FINDING[s.listSurfaces.verdict]
      ? [
          ...s.listSurfaces.gaps.map((g) => `${g.entity}.${g.field}:${[...g.surfaces].sort().join(",")}`),
          ...s.listSurfaces.narrowedSearchEntities.map((e) => `q:${e}`),
        ]
      : [],
  unique_enforcement: (s) =>
    s.uniqueEnforcement !== null && UNIQUE_IS_FINDING[s.uniqueEnforcement.verdict]
      ? s.uniqueEnforcement.withheld.map((w) => `${w.entity}.${w.field}:${w.reason}`)
      : [],
  unserved_sections: (s) => s.sections.declared.map((d) => `${d.section}:${d.members.toString()}`),
  view_permissions: (s) =>
    VIEW_PERMISSION_IS_FINDING[s.viewPermissions.verdict]
      ? s.viewPermissions.overrides.map((o) => `${o.view}:${[...o.roles].sort().join(",")}`)
      : [],
  report_surfaces: (s) =>
    s.reports.reports.flatMap((r) => [
      ...r.listGaps.map((g) => `${r.operationId}:gap:${g.role}->${g.entity}`),
      ...r.undeclaredRoles.map((role) => `${r.operationId}:undeclared:${role}`),
      ...r.unanswered.map((g) => `${r.operationId}:unanswered:${g.role}->${g.entity}`),
    ]),
};

function contributes(r: TenantManifestSurveyReport, kind: InheritedKind): boolean {
  const theirs = r.inherited[kind];
  return SIGNATURES[kind](r).some((sig) => !theirs.has(sig));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function documentStoreGap(
  tenant: Manifest,
  deployment: Manifest,
  referencesCheckedBy: DocumentStoreGap["referencesCheckedBy"],
): DocumentStoreGap {
  // The table name is irrelevant to the comparison — the index name derives from (entity, field,
  // scope) alone — so any qualified name will do. The unique half is the same for every
  // `referencesCheckedBy`: the indexes are built in the database by the owner's `document-indexes`
  // step from the deployment's manifest, whichever store object later writes through them.
  const mine = planDocumentIntegrity(tenant, "meta.operate_entity_records");
  const theirs = planDocumentIntegrity(deployment, "meta.operate_entity_records");
  const built = new Set(theirs.uniqueIndexes.map((i) => i.name));
  const checked = new Set(
    referencesCheckedBy === "deployment_plan"
      ? [...theirs.referencesFrom.values()].flat().map((e) => `${e.entity}.${e.field}->${e.target}`)
      : [],
  );
  return {
    unindexedUnique: mine.uniqueIndexes.filter((i) => !built.has(i.name)).map((i) => `${i.entity}.${i.field}`),
    uncheckedReferences:
      referencesCheckedBy === "off_by_flag"
        ? []
        : [...mine.referencesFrom.values()]
            .flat()
            .filter((e) => !checked.has(`${e.entity}.${e.field}->${e.target}`))
            .map((e) => `${e.entity}.${e.field}`),
    referencesCheckedBy,
  };
}

function tenantJobGap(tenant: Manifest, deployment: Manifest): TenantJobGap {
  const deployed = new Map(Object.values(deployment.jobs ?? {}).map((j) => [j.id, canonical(j)] as const));
  const unserved: string[] = [];
  const divergent: string[] = [];
  for (const job of Object.values(tenant.jobs ?? {})) {
    const theirs = deployed.get(job.id);
    if (theirs === undefined) unserved.push(job.id);
    else if (theirs !== canonical(job)) divergent.push(job.id);
  }
  return { unserved: unserved.sort(), divergent: divergent.sort() };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((x) => left.has(x));
}

/**
 * Runs every boot survey over the tenant's compiled manifest. Pure: a function of the manifest, the
 * compiled report surfaces and the deployment facts, with no connection and no clock.
 */
export function surveyTenantManifest(
  manifest: Manifest,
  base: TenantSurveyBase,
  ctx: TenantSurveyContext,
): TenantManifestSurveyReport {
  const store = effectiveStore(ctx.servedFrom, ctx.storeKind);
  const onDocumentStore = store === "pg";
  const tenantGated = approveClassTransitions(manifest);
  // On the document store the pure unique survey answers "enforced" for every declaration, because
  // that store builds its indexes — but from the deployment's manifest, so the tenant's own
  // declarations are compared against that plan instead (`documentStoreGap`).
  const signed = (m: Manifest): SignedSurveys => ({
    listSurfaces: surveyListSurfaces(m, store),
    uniqueEnforcement: onDocumentStore ? null : surveyUniqueEnforcement(m, store, []),
    sections: surveyManifestSections(m),
    viewPermissions: surveyViewPermissionOverrides(m),
    reports: surveyReportSurfaces(base.reportSurfaces, m),
  });
  const mine = signed(manifest);
  const theirs = signed(ctx.deploymentManifest);
  const inheritedOf = (kind: InheritedKind): ReadonlySet<string> => new Set(SIGNATURES[kind](theirs));
  return {
    ...base,
    servedFrom: ctx.servedFrom,
    ...mine,
    documentStoreGap: onDocumentStore
      ? documentStoreGap(
          manifest,
          ctx.deploymentManifest,
          ctx.servedFrom === "fallback" ? "nothing" : ctx.allowDanglingReferences ? "off_by_flag" : "deployment_plan",
        )
      : null,
    inherited: {
      list_surfaces: inheritedOf("list_surfaces"),
      unique_enforcement: inheritedOf("unique_enforcement"),
      unserved_sections: inheritedOf("unserved_sections"),
      view_permissions: inheritedOf("view_permissions"),
      report_surfaces: inheritedOf("report_surfaces"),
    },
    sod: {
      differs: !sameSet(tenantGated, approveClassTransitions(ctx.deploymentManifest)),
      line: formatSegregationOfDuties(manifest, ctx.segregationOfDuties.enabled, ctx.segregationOfDuties.removalsRead),
    },
    jobs: tenantJobGap(manifest, ctx.deploymentManifest),
    atRest: decidePhiStorage({
      store,
      phiFields: surveyPhiFields(manifest),
      secretPresent: ctx.phi.keyConfigured,
      allowPlaintextPhi: ctx.phi.allowPlaintextPhi,
    }),
    segregationEnabled: ctx.segregationOfDuties.enabled,
  };
}

/** Every kind of per-tenant finding. A total map below makes a twelfth kind a compile error. */
export const TENANT_SURVEY_FINDING_KINDS = [
  "sensitive_fields",
  "cursor_disclosure",
  "served_from",
  "list_surfaces",
  "unique_enforcement",
  "document_store_gap",
  "unserved_sections",
  "view_permissions",
  "report_surfaces",
  "segregation_of_duties",
  "jobs",
  "at_rest",
] as const;
export type TenantSurveyFindingKind = (typeof TENANT_SURVEY_FINDING_KINDS)[number];

const FINDING_HOLDS: Readonly<Record<TenantSurveyFindingKind, (r: TenantManifestSurveyReport) => boolean>> = {
  // The four conditions ADR-0339 and ADR-0357 measured as live defects — a field no role can read,
  // a field no role can write, a field writable by somebody who cannot read it (the blind overwrite),
  // and an entity no role can create — not `totalSensitive > 0`, which is the healthy state.
  sensitive_fields: ({ sensitive }) =>
    sensitive.uncreatable.length > 0 ||
    sensitive.findings.some(
      (f) =>
        f.readableBy.length === 0 ||
        f.writableBy.length === 0 ||
        f.writableBy.some((role) => !f.readableBy.includes(role)),
    ),
  cursor_disclosure: (r) => CURSOR_DISCLOSURE_IS_FINDING[r.cursorDisclosure.verdict],
  served_from: (r) => SERVED_FROM_IS_FINDING[r.servedFrom],
  list_surfaces: (r) => contributes(r, "list_surfaces"),
  unique_enforcement: (r) => contributes(r, "unique_enforcement"),
  document_store_gap: (r) =>
    r.documentStoreGap !== null &&
    (r.documentStoreGap.unindexedUnique.length > 0 || r.documentStoreGap.uncheckedReferences.length > 0),
  unserved_sections: (r) => contributes(r, "unserved_sections"),
  view_permissions: (r) => contributes(r, "view_permissions"),
  report_surfaces: (r) => contributes(r, "report_surfaces"),
  segregation_of_duties: (r) => r.sod.differs,
  jobs: (r) => r.jobs.unserved.length > 0 || r.jobs.divergent.length > 0,
  at_rest: (r) => AT_REST_IS_FINDING[r.atRest.verdict],
};

/** The kinds this report holds a finding of, in the census order. */
export function tenantSurveyFindings(report: TenantManifestSurveyReport): readonly TenantSurveyFindingKind[] {
  return TENANT_SURVEY_FINDING_KINDS.filter((k) => FINDING_HOLDS[k](report));
}

/** Whether a per-tenant survey found anything an operator should act on. */
export function tenantSurveyHasFinding(report: TenantManifestSurveyReport): boolean {
  return tenantSurveyFindings(report).length > 0;
}

function names(list: readonly string[]): string {
  const shown = list.slice(0, 8);
  return `${shown.join(", ")}${list.length > shown.length ? ` (+${(list.length - shown.length).toString()} more)` : ""}`;
}

function atRestSentence(report: TenantManifestSurveyReport): string {
  const fields = names(report.atRest.fields.map((f) => `${f.entity}.${f.field}`));
  const n = report.atRest.fields.length.toString();
  switch (report.atRest.verdict) {
    case "refused_plaintext_store":
      return report.servedFrom === "fallback"
        ? `[phi] ${n} phi/regulated field(s) (${fields}) are declared and this tenant is served from the` +
            " JSONB fallback, which encrypts nothing — so every request on those entities is refused until" +
            " its schema application succeeds"
        : `[phi] ${n} phi/regulated field(s) (${fields}) are declared and stored in the CLEAR: this deployment` +
            " serves tenants from a store that encrypts no column, and its at-rest refusal (ADR-0338) answers" +
            " for the boot manifest only — nothing refuses a tenant's. Serve PHI on --store pg-columns with" +
            " COLUMN_ENCRYPTION_SECRET set";
    case "refused_no_secret":
      return (
        `[phi] ${n} phi/regulated field(s) (${fields}) are declared and this deployment configures no column key,` +
        " so the tenant's column store cannot encrypt them; set COLUMN_ENCRYPTION_SECRET"
      );
    case "no_phi":
    case "encrypted":
    case "plaintext_accepted":
      return `[phi] ${report.atRest.detail}`;
  }
}

function servedFromSentence(servedFrom: TenantServedFrom): string {
  switch (servedFrom) {
    case "own_schema_retained":
      return (
        "[tenant-schema] the activated manifest's schema application was refused, so this tenant is served" +
        " the LAST APPLIED manifest over its own schema — every line here describes that manifest, not the" +
        " one activated"
      );
    case "fallback":
      return (
        "[tenant-schema] the schema application was refused and nothing was applied before, so this tenant" +
        " is served from the deployment's JSONB document store rather than its own schema (ADR-0314)"
      );
    case "own_schema":
    case "shared":
      return `[tenant-schema] served from ${servedFrom}`;
  }
}

export interface TenantSurveyReading {
  /** One line per finding, already prefixed. Empty when the tenant's manifest has nothing to say. */
  readonly lines: readonly string[];
  readonly level: "info" | "warn";
}

/**
 * Renders the per-tenant reading: silent when there is nothing to report, every line tagged with
 * the tenant when there is.
 */
export function formatTenantManifestSurvey(
  tenantId: string,
  report: TenantManifestSurveyReport,
): TenantSurveyReading {
  const findings = tenantSurveyFindings(report);
  if (findings.length === 0) return { lines: [], level: "info" };
  const tag = `[tenant-manifest] tenant ${tenantId}:`;
  const blocks: string[] = [];
  for (const kind of findings) {
    switch (kind) {
      case "sensitive_fields":
        blocks.push(formatSensitiveFieldSurvey(report.sensitive));
        break;
      case "cursor_disclosure":
        blocks.push(
          `${formatCursorDisclosure(report.cursorDisclosure)} — the remedy is the DEPLOYMENT's` +
            " CURSOR_ENCRYPTION_SECRET, not anything this tenant can change: one secret seals every tenant," +
            " because the key is derived per tenant inside the sealer",
        );
        break;
      case "served_from":
        blocks.push(servedFromSentence(report.servedFrom));
        break;
      case "list_surfaces":
        blocks.push(formatListSurfaceReport(report.listSurfaces));
        break;
      case "unique_enforcement":
        if (report.uniqueEnforcement !== null) blocks.push(formatUniqueEnforcementReport(report.uniqueEnforcement));
        break;
      case "document_store_gap": {
        const gap = report.documentStoreGap;
        if (gap === null) break;
        if (gap.unindexedUnique.length > 0) {
          blocks.push(
            `[unique] ${gap.unindexedUnique.length.toString()} declared unique field(s) have NO index on the shared` +
              ` document store: ${names(gap.unindexedUnique)} — its indexes are built by the owner's` +
              " document-indexes step from the deployment's manifest, which does not declare them, so a duplicate" +
              " is accepted",
          );
        }
        if (gap.uncheckedReferences.length > 0) {
          blocks.push(
            gap.referencesCheckedBy === "nothing"
              ? `[references] ${gap.uncheckedReferences.length.toString()} reference field(s) are checked by nothing:` +
                  ` ${names(gap.uncheckedReferences)} — the JSONB fallback this tenant is served from is built with no` +
                  " manifest and checks no reference, its inherited ones included, so a dangling id is accepted"
              : `[references] ${gap.uncheckedReferences.length.toString()} reference field(s) are checked by nothing on the` +
                  ` shared document store: ${names(gap.uncheckedReferences)} — the store checks the references of the` +
                  " deployment's manifest, so a dangling id is accepted",
          );
        }
        break;
      }
      case "unserved_sections":
        blocks.push(formatManifestSectionSurvey(report.sections));
        break;
      case "view_permissions":
        blocks.push(formatViewPermissionSurvey(report.viewPermissions));
        break;
      case "report_surfaces":
        blocks.push(formatReportSurfaceSurvey(report.reports));
        break;
      case "segregation_of_duties":
        blocks.push(
          `${report.sod.line} — this tenant's approve-class transitions differ from the deployment's` +
            (report.segregationEnabled ? "; the rule reads them per manifest, so these are the ones gated" : ""),
        );
        break;
      case "jobs": {
        const parts: string[] = [];
        if (report.jobs.unserved.length > 0) {
          parts.push(
            `${report.jobs.unserved.length.toString()} job declaration(s) are NOT served by this deployment —` +
              ` ${names(report.jobs.unserved)}: the scheduler, the event emitter and the invoke route all read` +
              " the deployment's manifest, so nothing enqueues these and no handler runs them",
          );
        }
        if (report.jobs.divergent.length > 0) {
          parts.push(
            `${report.jobs.divergent.length.toString()} job declaration(s) differ from the deployment's —` +
              ` ${names(report.jobs.divergent)}: the deployment's declaration is the one that runs`,
          );
        }
        blocks.push(`[jobs] ${parts.join("; ")}`);
        break;
      }
      case "at_rest":
        blocks.push(atRestSentence(report));
        break;
    }
  }
  // Split and prefix **every** line, not each block: several formatters return a `\n`-joined block
  // of already-prefixed lines, and tagging the block tags only the first.
  const lines = blocks.flatMap((block) => block.split("\n")).map((line) => `${tag} ${line}`);
  return { lines, level: "warn" };
}
