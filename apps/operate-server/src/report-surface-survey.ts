/**
 * What the server-side reports read, whom they admit, and where that disagrees with the manifest.
 *
 * Two reports are compiled into every deployment whose manifest models their entities —
 * `meta.aging.read` and `meta.whtReconciliation.read` — and each admits a **role list fixed when
 * the server was compiled** (`OperateRuntimeOptions.financeRoles`, defaulting to four finance roles),
 * which is a different vocabulary from the manifest's per-entity grants. The report's own check is
 * the only one on that route: it reads Invoice, Bill, Payment and WhtCertificate records directly
 * from the store, so a role it admits sees those records whatever the entity grants say. Measured on
 * resolved `erp-core`: `controller` and `ap_clerk` are 403 on `GET /v1/invoices` and 200 on the
 * aging report, whose AR section carries each open invoice's number, total and due date.
 *
 * This survey states that disagreement and **takes no side**. Which vocabulary is authoritative is a
 * product decision — ADR-0126 names the four roles on purpose, while the pack's `Invoice.list`
 * grant predates `FIN_READERS` and is plausibly the stale one for `controller` — so the line names
 * both vocabularies, counts in both units the disagreement has, and offers no remedy, because the
 * remedies (a flag, a pack grant, a per-section gate) are each a decision rather than an act an
 * operator can take (ADR-0334: a remedy that cannot work is worse than none).
 *
 * It reads the surfaces off `CompiledOperateServer.reportSurfaces`, which carries the very set
 * object each handler enforces, and never re-derives `financeRoles ?? DEFAULT_FINANCE_ROLES`: a
 * second spelling of that `??` here would describe the handler only until the option gained a
 * producer (ADR-0386's dropped-field class, and ADR-0361's rule that a boot line reads the live
 * object). The entity answer is the real `rbacCheck` over the manifest's own permissions and roles,
 * so inheritance and the manifest's own spelling of each grant are honoured rather than restated.
 *
 * Info level, said either way including when nothing disagrees: its audience is the next
 * increment's author as much as an operator, and "we compared and they agree" cannot be read off the
 * absence of a line.
 */

import {
  rbacCheck,
  type Principal,
  type RoleDefinition,
  type RoleName,
} from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { ReportSurface } from "@crossengin/operate-runtime";

/** One admitted role that the manifest does not let `list` an entity the report reads. */
export interface ReportListGap {
  readonly role: string;
  readonly entity: string;
}

export interface ReportSurfaceFinding {
  readonly operationId: string;
  readonly reads: readonly string[];
  /** Sorted, so two boots over one configuration print one line. */
  readonly admittedRoles: readonly string[];
  /** Admitted roles `manifest.roles` does not declare. */
  readonly undeclaredRoles: readonly string[];
  /** Per (admitted role, read entity) where `rbacCheck` refuses `list`, in read order then role order. */
  readonly listGaps: readonly ReportListGap[];
  /**
   * Pairs `rbacCheck` could not answer — it throws on a role inheritance cycle. Reported rather than
   * counted as a gap, because a throw establishes nothing about the grant (ADR-0331).
   */
  readonly unanswered: readonly ReportListGap[];
}

export interface ReportSurfaceSurvey {
  readonly reports: readonly ReportSurfaceFinding[];
  /** (report, role, entity) disagreements — the per-report unit. */
  readonly gapCount: number;
  /** Distinct (role, entity) pairs across all reports — the unit an entity grant is written in. */
  readonly distinctGapPairs: number;
}

/**
 * The survey principal for a role: a question about roles, not rows, so no tenant is consulted and
 * no attribute was resolved (`null`, never `{}`, which would assert the role has none).
 */
function principalFor(role: RoleName): Principal {
  return {
    kind: "user",
    tenantId: "00000000-0000-0000-0000-000000000000" as Principal["tenantId"],
    userId: null,
    primaryRole: role,
    secondaryRoles: [],
    abacAttributes: null,
    mfaProofAgeSeconds: null,
  };
}

/** Pure: a function of the compiled report surfaces and the manifest they were compiled from. */
export function surveyReportSurfaces(
  surfaces: readonly ReportSurface[],
  manifest: Manifest,
): ReportSurfaceSurvey {
  const declared = new Set(Object.keys(manifest.roles ?? {}));
  const roles = new Map<RoleName, RoleDefinition>(Object.entries(manifest.roles ?? {}));
  const permissions = manifest.permissions ?? {};
  const reports: ReportSurfaceFinding[] = [];
  const distinct = new Set<string>();
  let gapCount = 0;
  for (const surface of surfaces) {
    const admittedRoles = [...surface.viewerRoles].sort();
    const listGaps: ReportListGap[] = [];
    const unanswered: ReportListGap[] = [];
    for (const entity of surface.reads) {
      for (const role of admittedRoles) {
        let allowed: boolean;
        try {
          allowed = rbacCheck({
            principal: principalFor(role),
            permissions,
            roles,
            entity,
            operation: "list",
          }).allowed;
        } catch {
          unanswered.push({ role, entity });
          continue;
        }
        if (allowed) continue;
        listGaps.push({ role, entity });
        distinct.add(`${role}\u0000${entity}`);
      }
    }
    gapCount += listGaps.length;
    reports.push({
      operationId: surface.operationId,
      reads: surface.reads,
      admittedRoles,
      undeclaredRoles: admittedRoles.filter((r) => !declared.has(r)),
      listGaps,
      unanswered,
    });
  }
  return { reports, gapCount, distinctGapPairs: distinct.size };
}

/** The `[reports]` boot block. Every line is prefixed so one grep finds the whole block. */
export function formatReportSurfaceSurvey(survey: ReportSurfaceSurvey): string {
  if (survey.reports.length === 0) {
    return (
      "[reports] server-side reports mounted: 0 — this manifest models none of the entity sets a" +
      " built-in report reads, so no report route admits anyone"
    );
  }
  const lines = [
    `[reports] server-side reports mounted: ${survey.reports.length}. Each admits a role list fixed` +
      " when this server was compiled, which is a different vocabulary from the manifest's" +
      " per-entity grants and is the only check on the route; the two are compared here, not ranked." +
      ` Admitted roles the entity grants do not let list an entity the report reads:` +
      ` ${survey.gapCount} (report, role, entity) over ${survey.distinctGapPairs} distinct` +
      " (role, entity) pair(s)",
  ];
  for (const r of survey.reports) {
    const gaps =
      r.listGaps.length === 0
        ? "every admitted role may also list every entity it reads"
        : `admitted without list: ${r.listGaps.map((g) => `${g.role}→${g.entity}`).join(", ")}`;
    const undeclared =
      r.undeclaredRoles.length === 0
        ? ""
        : `; admits role(s) this manifest does not declare: ${r.undeclaredRoles.join(", ")}`;
    const unanswered =
      r.unanswered.length === 0
        ? ""
        : `; could not be asked for: ${r.unanswered.map((g) => `${g.role}→${g.entity}`).join(", ")}`;
    lines.push(
      `[reports]   ${r.operationId} reads ${r.reads.join(", ")}; admits ${r.admittedRoles.join(", ")};` +
        ` ${gaps}${undeclared}${unanswered}`,
    );
  }
  return lines.join("\n");
}
