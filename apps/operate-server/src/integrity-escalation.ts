import { randomUUID } from "node:crypto";

import type { IncidentRecord } from "@crossengin/incident-response";
import type { AlertChannelTarget, AlertPolicy } from "@crossengin/observability";
import {
  formatIncidentId,
  planIncidentDeclaration,
  planPageDirective,
  type PageDirective,
} from "@crossengin/observability-runtime";

import { auditActor, auditEntry, type PostgresAuditEmitter } from "./audit-log-store.js";
import type { IntegrityEscalationConfig } from "./integrity-escalation-config.js";
import { formatIntegrityProof, type IntegrityProofReport } from "./integrity-proof.js";

export const INTEGRITY_INCIDENT_OPERATION = "audit.integrity_compromised";
export const INTEGRITY_RECOVERY_OPERATION = "audit.integrity_recovered";

export {
  IntegrityEscalationConfigSchema,
  type IntegrityEscalationConfig,
} from "./integrity-escalation-config.js";

/** What the escalator decided for one scope on one pass. */
export const INTEGRITY_ESCALATIONS = ["opened", "ongoing", "recovered", "none"] as const;
export type IntegrityEscalationKind = (typeof INTEGRITY_ESCALATIONS)[number];

export interface IntegrityEscalation {
  readonly scope: string | null;
  readonly kind: IntegrityEscalationKind;
  readonly incidentId: string | null;
  /** Only on `opened` — the declared record. Nothing persists `IncidentRecord`s platform-wide. */
  readonly incident?: IncidentRecord;
  readonly page?: PageDirective | null;
  /** True when the escalation was written to `meta.audit_log` (and so anchored). */
  readonly audited: boolean;
}

export interface IntegrityEscalationPlan {
  readonly incident: IncidentRecord;
  readonly page: PageDirective | null;
}

/**
 * Turns a compromised verdict into a declared incident and a page directive, reusing the same
 * pure planners the SLO enforcement loop uses so an auto-declared integrity incident is
 * indistinguishable in shape from an auto-declared availability one.
 */
export function planIntegrityEscalation(
  report: IntegrityProofReport,
  opts: {
    readonly incidentId: string;
    readonly severity: IntegrityEscalationConfig["severity"];
    readonly category: IntegrityEscalationConfig["category"];
    readonly declaredBy: string;
    readonly alertPolicy: AlertPolicy;
  },
): IntegrityEscalationPlan {
  const scope = report.scope ?? "platform";
  const incident = planIncidentDeclaration({
    incidentId: opts.incidentId,
    title: `Audit integrity compromised for ${scope}`,
    severity: opts.severity,
    category: opts.category,
    surface: `audit-integrity/${scope}`,
    nowIso: report.verifiedAt,
    declaredBy: opts.declaredBy,
    // Empty for the platform chain: `affectedTenantIds` names tenants, and the platform
    // scope is not one.
    affectedTenantIds: report.scope === null ? [] : [report.scope],
    detail: formatIntegrityProof(report),
  });
  return { incident, page: planPageDirective(opts.alertPolicy, opts.severity, opts.incidentId) };
}

/** Where a page goes. Left to the caller — this app has no pager integration of its own. */
export type PageSink = (page: PageDirective, incident: IncidentRecord) => void | Promise<void>;

export interface IntegrityEscalatorOptions {
  readonly config: IntegrityEscalationConfig;
  /**
   * Records the escalation in `meta.audit_log`, which the anchoring emitter commits to the
   * chain (ADR-0286) — so the record of the escalation is itself tamper-evident. Omitted ⇒
   * escalations page but leave no readable row.
   */
  readonly audit?: PostgresAuditEmitter;
  readonly page?: PageSink;
  readonly now?: () => Date;
  readonly onError?: (err: unknown) => void;
}

/**
 * Escalates a compromised audit-integrity verdict once, not every pass.
 *
 * The scheduler runs hourly and a tampered row stays tampered, so declaring on every
 * `compromised` verdict would turn one tamper into twenty-four incidents a day and train
 * everyone to ignore the alert. This mirrors the SLO engine's `breach_opened` /
 * `breach_ongoing` / `recovered` shape: the first finding for a scope declares and pages,
 * subsequent findings are `ongoing` and silent, and a scope returning to
 * `verified`/`unproven` closes out and is eligible to declare again.
 *
 * Open state is per-process and in memory, like the SLO engine's incident sequence. A restart
 * re-declares a still-present tamper, which is the safe direction: it risks a duplicate
 * incident, never a missed one.
 */
export class IntegrityEscalator {
  private readonly open = new Map<string, string>();
  private incidentSeq = 0;

  constructor(private readonly opts: IntegrityEscalatorOptions) {}

  /** Never rejects — an audit or page failure is routed to `onError`, not thrown at the pass. */
  async observe(report: IntegrityProofReport): Promise<IntegrityEscalation> {
    const key = report.scope ?? "\u0000platform";
    const openId = this.open.get(key);

    if (report.verdict !== "compromised") {
      if (openId === undefined) return { scope: report.scope, kind: "none", incidentId: null, audited: false };
      this.open.delete(key);
      const audited = await this.record(report, openId, INTEGRITY_RECOVERY_OPERATION);
      return { scope: report.scope, kind: "recovered", incidentId: openId, audited };
    }

    if (openId !== undefined) {
      return { scope: report.scope, kind: "ongoing", incidentId: openId, audited: false };
    }

    const now = (this.opts.now ?? ((): Date => new Date()))();
    this.incidentSeq += 1;
    const incidentId = formatIncidentId(now.getUTCFullYear(), this.incidentSeq);
    const plan = planIntegrityEscalation(report, {
      incidentId,
      severity: this.opts.config.severity,
      category: this.opts.config.category,
      declaredBy: this.opts.config.declaredBy,
      alertPolicy: this.opts.config.alertPolicy,
    });
    // Marked open before paging, so a failing pager cannot cause a re-declare next pass.
    this.open.set(key, incidentId);
    const audited = await this.record(report, incidentId, INTEGRITY_INCIDENT_OPERATION);
    await this.emitPage(plan);
    return {
      scope: report.scope,
      kind: "opened",
      incidentId,
      incident: plan.incident,
      page: plan.page,
      audited,
    };
  }

  /** Whether a scope currently has an open integrity incident (for tests / metrics). */
  openIncidentFor(scope: string | null): string | null {
    return this.open.get(scope ?? "\u0000platform") ?? null;
  }

  private async emitPage(plan: IntegrityEscalationPlan): Promise<void> {
    if (plan.page === null || this.opts.page === undefined) return;
    try {
      await this.opts.page(plan.page, plan.incident);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private async record(
    report: IntegrityProofReport,
    incidentId: string,
    operation: string,
  ): Promise<boolean> {
    // The platform chain has no tenant, and `audit_log.tenant_id` is NOT NULL — so a
    // platform-scope escalation pages but cannot leave a tenant-scoped audit row. Reported
    // via `audited: false` rather than silently dropped.
    if (this.opts.audit === undefined || report.scope === null) return false;
    try {
      await this.opts.audit.emit(
        auditEntry({
          id: randomUUID(),
          tenantId: report.scope,
          occurredAt: report.verifiedAt,
          actor: auditActor({ kind: "system", userId: null }),
          operation,
          entity: "audit_log",
          after: {
            incidentId,
            severity: this.opts.config.severity,
            category: this.opts.config.category,
            verdict: report.verdict,
            truncated: report.truncation.truncated,
            tampered: (report.anchors?.tampered ?? []).map((t) => ({
              auditId: t.auditId,
              verdict: t.verdict,
            })),
          },
          reason:
            operation === INTEGRITY_INCIDENT_OPERATION
              ? "audit-integrity proof found the trail provably altered"
              : "audit-integrity proof no longer finds the trail altered",
        }),
      );
      return true;
    } catch (err) {
      // The audit log being unwritable is exactly the condition under which we are escalating,
      // so a failure here must not swallow the page.
      this.opts.onError?.(err);
      return false;
    }
  }
}

export function formatIntegrityEscalation(escalation: IntegrityEscalation): string {
  const scope = escalation.scope ?? "platform";
  if (escalation.kind === "none") return `audit integrity for ${scope}: no escalation`;
  const channels = escalation.page?.channels ?? [];
  const paged = channels.length === 0 ? "no route" : channels.map(channelLabel).join(", ");
  if (escalation.kind === "opened") {
    return (
      `audit integrity for ${scope}: DECLARED ${escalation.incidentId ?? "?"}` +
      ` severity=${escalation.incident?.severity ?? "?"} paged=${paged}` +
      ` audited=${String(escalation.audited)}`
    );
  }
  if (escalation.kind === "ongoing") {
    return `audit integrity for ${scope}: still compromised under ${escalation.incidentId ?? "?"}`;
  }
  return `audit integrity for ${scope}: recovered, closing ${escalation.incidentId ?? "?"}`;
}

function channelLabel(target: AlertChannelTarget): string {
  return target.kind;
}
