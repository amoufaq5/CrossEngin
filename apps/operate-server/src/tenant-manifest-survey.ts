import { formatCursorDisclosure, type CursorDisclosureDecision } from "./cursor-encryption.js";
import {
  formatSensitiveFieldSurvey,
  type SensitiveFieldSurvey,
} from "./sensitive-field-policy.js";

/**
 * How a **tenant's own activated manifest** reports the two surveys that used to run only at boot.
 *
 * `serve()` surveys the boot pack and prints `[fields] …` and `[cursor] …`; a tenant serving its
 * own manifest (ADR-0314) is compiled inside `buildOperateHttpServer` and was surveyed by nothing,
 * so ADR-0339's write-open/read-closed asymmetry and ADR-0357's cursor disclosure were both
 * unmeasured for exactly the input the AI Architect produces. This renders the per-tenant answer.
 *
 * Three decisions:
 *
 *   - **The sentences have one producer each.** This calls `formatSensitiveFieldSurvey` and
 *     `formatCursorDisclosure` rather than restating them, so the boot line and the per-tenant
 *     line cannot come to describe the same finding differently — the recurring defect this
 *     repository keeps finding in its own prose.
 *   - **The tenant is named and the manifest is not.** A finding names the entity and field, which
 *     the survey's own formatter already withholds nothing of; what this adds is `tenant <uuid>`,
 *     because an operator reading one log for every tenant cannot otherwise act. No manifest
 *     content beyond what the boot line already prints.
 *   - **The level is derived from the findings, not from the verdict's name**, which is
 *     `formatSettlementCoverageReport`'s rule: a level keyed on the verdict string would have to
 *     be kept in step with the verdict enum, and the question an operator wants answered is
 *     whether *this* tenant has a finding.
 */
export interface TenantManifestSurveyReport {
  readonly sensitive: SensitiveFieldSurvey;
  readonly cursorDisclosure: CursorDisclosureDecision;
}

export interface TenantSurveyReading {
  /** One line per finding, already prefixed. Empty when the tenant's manifest has nothing to say. */
  readonly lines: readonly string[];
  readonly level: "info" | "warn";
}

/**
 * Whether a per-tenant survey found something an operator should act on.
 *
 * Deliberately **not** `totalSensitive > 0`: a manifest declaring classified fields that are
 * readable and writable by the roles it intends is the healthy state, and reporting it as a finding
 * is how a warning becomes noise an operator mutes. The three conditions are the ones ADR-0339 and
 * ADR-0357 measured as live defects — a field no role can read, a field no role can write, a field
 * writable by somebody who cannot read it (the blind overwrite), and a cursor carrying a classified
 * value in the clear.
 */
export function tenantSurveyHasFinding(report: TenantManifestSurveyReport): boolean {
  const { sensitive, cursorDisclosure } = report;
  const unreadable = sensitive.findings.some((f) => f.readableBy.length === 0);
  const unwritable = sensitive.findings.some((f) => f.writableBy.length === 0);
  const asymmetric = sensitive.findings.some((f) =>
    f.writableBy.some((role) => !f.readableBy.includes(role)),
  );
  return (
    unreadable ||
    unwritable ||
    asymmetric ||
    sensitive.uncreatable.length > 0 ||
    cursorDisclosure.verdict === "plaintext_disclosing"
  );
}

/**
 * Renders the per-tenant reading.
 *
 * Silent when there is nothing to report, which is the one place this departs from the boot lines'
 * say-it-either-way rule — and the departure is argued rather than assumed. At boot, *"we checked
 * and found nothing"* is worth a line because there is one deployment and an operator reads its
 * boot once; here there is a line per tenant per activation, so an affirmative clean line scales
 * with the tenant count and is the thing that gets filtered out, taking the findings with it. The
 * fact that the check *ran* is said once, at boot, by the surface that mounts it.
 */
export function formatTenantManifestSurvey(
  tenantId: string,
  report: TenantManifestSurveyReport,
): TenantSurveyReading {
  if (!tenantSurveyHasFinding(report)) return { lines: [], level: "info" };
  const tag = `[tenant-manifest] tenant ${tenantId}:`;
  // Split and prefix **every** line, not the whole string. `formatSensitiveFieldSurvey` returns a
  // `\n`-joined block of up to five already-prefixed lines, so tagging the block tags only the
  // first — and lines 2..N would reach a multi-tenant log reading `[fields] …` with no tenant on
  // them, which is unattributable and worse than not reporting at all. The double tag
  // (`[tenant-manifest] … [fields] …`) is the cost, and it is the right one: a reader greps either.
  const lines = formatSensitiveFieldSurvey(report.sensitive)
    .split("\n")
    .map((line) => `${tag} ${line}`);
  if (report.cursorDisclosure.verdict === "plaintext_disclosing") {
    lines.push(
      `${tag} ${formatCursorDisclosure(report.cursorDisclosure)}` +
        ` — the remedy is the DEPLOYMENT's CURSOR_ENCRYPTION_SECRET, not anything this tenant can` +
        ` change: one secret seals every tenant, because the key is derived per tenant inside the` +
        ` sealer`,
    );
  }
  return { lines, level: "warn" };
}
