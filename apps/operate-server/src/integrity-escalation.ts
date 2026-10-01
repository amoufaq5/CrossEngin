import { randomUUID } from "node:crypto";

import { autoDeclaredForKey, type IncidentRecord } from "@crossengin/incident-response";
import {
  CountingIncidentDeclarer,
  FallbackIncidentDeclarer,
  SystemClock,
  type Clock,
  type IncidentCloseOut,
  type IncidentDeclarationRequest,
  type IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import type { AlertChannelTarget, AlertPolicy } from "@crossengin/observability";
import {
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

/**
 * What state the escalation's incident record is in — the escalation's own reporting vocabulary,
 * three quarters of which is `IncidentCloseOut` spelled the same way.
 *
 * The one value with no close-out counterpart is `declared`, and the reason is that the two
 * vocabularies answer different questions. An `IncidentCloseOut` says what became of a *recovery*;
 * `declared` is the disposition of an incident that is still **open** — reported on an `opened` or
 * `ongoing` pass, where no recovery has been attempted and so there is no close-out to derive it
 * from. See `dispositionFromCloseOut` for the derivation in the other direction.
 */
export const INCIDENT_DISPOSITIONS = [
  "unpersisted",
  "declared",
  "cancelled",
  "human_owned",
] as const;
export type IncidentDisposition = (typeof INCIDENT_DISPOSITIONS)[number];

/**
 * The escalation's disposition for a close-out the declarer reported.
 *
 * `failed` becomes `declared` rather than losing the distinction: the store refused the close-out,
 * so the row is still open and still declared — which is exactly what a human needs to know, and
 * what `listOpen` will keep showing them.
 */
export function dispositionFromCloseOut(closeOut: IncidentCloseOut): IncidentDisposition {
  switch (closeOut) {
    case "cancelled":
      return "cancelled";
    case "human_owned":
      return "human_owned";
    case "unpersisted":
      return "unpersisted";
    case "failed":
      return "declared";
  }
}

export interface IntegrityEscalation {
  readonly scope: string | null;
  readonly kind: IntegrityEscalationKind;
  readonly incidentId: string | null;
  /** Only on `opened` — the declared record, persisted when a store-backed declarer is wired. */
  readonly incident?: IncidentRecord;
  readonly page?: PageDirective | null;
  /** True when the escalation was written to `meta.audit_log` (and so anchored). */
  readonly audited: boolean;
  /**
   * What state the incident record is in. `unpersisted` when nothing stored it; `declared` while it
   * is open; on recovery, `cancelled` when it was closed out and `human_owned` when it had been
   * triaged and was therefore left alone.
   */
  readonly disposition: IncidentDisposition;
}

/** The signal an integrity escalation declares under. Scoped, and namespaced like every other. */
export function integrityIncidentKey(scope: string | null): string {
  return autoDeclaredForKey("audit-integrity", scope ?? "platform");
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
    autoDeclaredFor: integrityIncidentKey(report.scope),
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
  /**
   * Chooses the declared incident's id, answers which incident this scope already has open, and
   * closes the record out on recovery — the same seam the SLO enforcement loop declares through,
   * so an auto-declared integrity incident is allocated and closed by the same rules as an
   * auto-declared availability one.
   *
   * Omitted ⇒ `CountingIncidentDeclarer`: ids from a per-process counter that restarts at `0001`,
   * nothing to adopt after a restart, and nothing to close out. Safe only because nothing stores
   * what it names.
   */
  readonly declarer?: IncidentDeclarer;
  readonly page?: PageSink;
  /** Clock for the fallback declarer. Declarations are stamped with the proof's verification time. */
  readonly now?: () => Date;
  readonly onError?: (err: unknown) => void;
}

function escalatorClock(now: (() => Date) | undefined): Clock {
  if (now === undefined) return new SystemClock();
  return {
    now: (): Date => now(),
    nowMs: (): number => now().getTime(),
    nowIso: (): string => now().toISOString(),
  };
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
 * Open state is per-process and in memory, so a restart asks the declarer which incident this
 * scope already has open rather than declaring a second for one episode.
 */
export class IntegrityEscalator {
  private readonly open = new Map<string, string>();
  /**
   * Every declaration, lookup and close-out goes through this one wrapper.
   *
   * "A page naming nothing is not a page, so a refused declaration still gets a record" used to be
   * an inline try/catch here plus a second declarer held alongside the wired one.
   * `FallbackIncidentDeclarer` is that rule with one implementation, shared with anything else that
   * declares, and it fixes what the inline copy got wrong: a close-out for a fallback-minted id now
   * goes back to the fallback instead of asking the store to cancel an id it never issued — which,
   * since the counter can collide, could have cancelled a different incident.
   *
   * With nothing wired, the primary *is* the fallback: there is no store to fail over from, and one
   * instance keeps the counter single so ids stay in declaration order.
   */
  private readonly declarer: FallbackIncidentDeclarer;
  /** Whether the wired declarer is expected to outlive this process. */
  private readonly persists: boolean;

  constructor(private readonly opts: IntegrityEscalatorOptions) {
    const fallback = new CountingIncidentDeclarer({ clock: escalatorClock(opts.now) });
    this.persists = opts.declarer !== undefined;
    this.declarer = new FallbackIncidentDeclarer({
      primary: opts.declarer ?? fallback,
      fallback,
      ...(opts.onError !== undefined ? { onPrimaryFailure: opts.onError } : {}),
    });
  }

  /** Never rejects — an audit or page failure is routed to `onError`, not thrown at the pass. */
  async observe(report: IntegrityProofReport): Promise<IntegrityEscalation> {
    const key = report.scope ?? "\u0000platform";
    const openId = this.open.get(key);

    if (report.verdict !== "compromised") {
      if (openId === undefined) {
        return {
          scope: report.scope,
          kind: "none",
          incidentId: null,
          audited: false,
          disposition: "unpersisted",
        };
      }
      this.open.delete(key);
      const disposition = await this.closeOut(openId);
      const audited = await this.record(report, openId, INTEGRITY_RECOVERY_OPERATION);
      return {
        scope: report.scope,
        kind: "recovered",
        incidentId: openId,
        audited,
        disposition,
      };
    }

    if (openId !== undefined) {
      return {
        scope: report.scope,
        kind: "ongoing",
        incidentId: openId,
        audited: false,
        disposition: this.dispositionFor(openId),
      };
    }

    // A restart has an empty `open` map and a tamper that is still present, so without this the
    // next pass declares a second incident for one episode. An adopted incident is `ongoing`, and
    // deliberately does not page again: the page went out when it was declared.
    const adopted = await this.adopt(report);
    if (adopted !== null) {
      this.open.set(key, adopted);
      return {
        scope: report.scope,
        kind: "ongoing",
        incidentId: adopted,
        audited: false,
        disposition: this.dispositionFor(adopted),
      };
    }

    const declared = await this.declare(report);
    // Marked open before paging, so a failing pager cannot cause a re-declare next pass.
    this.open.set(key, declared.incident.id);
    const audited = await this.record(
      report,
      declared.incident.id,
      INTEGRITY_INCIDENT_OPERATION,
    );
    await this.emitPage({ incident: declared.incident, page: declared.page });
    return {
      scope: report.scope,
      kind: "opened",
      incidentId: declared.incident.id,
      incident: declared.incident,
      page: declared.page,
      audited,
      disposition: this.dispositionFor(declared.incident.id),
    };
  }

  /**
   * Whether the record behind an id is durable, which is what `disposition` reports.
   *
   * Two things must hold: a store-backed declarer was wired at all, and it is the one that actually
   * served this id — the wrapper's `servedBy` answers the second, where the inline fallback used to
   * return a boolean alongside the record. `unknown` reads as durable: the only ids this escalator
   * holds that the wrapper did not issue are ones `findOpen` returned, and `findOpen` only ever
   * reads stored rows.
   */
  private dispositionFor(incidentId: string): IncidentDisposition {
    if (!this.persists) return "unpersisted";
    return this.declarer.servedBy(incidentId) === "fallback" ? "unpersisted" : "declared";
  }

  /**
   * The id of the incident this scope already has open, when the declarer remembers one this
   * process does not.
   *
   * A lookup that fails is read as "nothing open": that risks a duplicate incident, never a missed
   * tamper, and `idx_incidents_auto_declared_open` refuses the duplicate anyway. A declarer with no
   * store answers null for the same reason — nothing it declared outlived the process.
   */
  private async adopt(report: IntegrityProofReport): Promise<string | null> {
    try {
      const open = await this.declarer.findOpen(integrityIncidentKey(report.scope));
      return open === null ? null : open.id;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /** The declaration this report warrants, minus the id, which is the declarer's to choose. */
  private declarationRequest(report: IntegrityProofReport): IncidentDeclarationRequest {
    const scope = report.scope ?? "platform";
    return {
      title: `Audit integrity compromised for ${scope}`,
      autoDeclaredFor: integrityIncidentKey(report.scope),
      severity: this.opts.config.severity,
      category: this.opts.config.category,
      declaredBy: this.opts.config.declaredBy,
      detail: formatIntegrityProof(report),
      declaredAt: report.verifiedAt,
      // Empty for the platform chain: `affectedTenantIds` names tenants, and the platform
      // scope is not one.
      affectedTenantIds: report.scope === null ? [] : [report.scope],
      metadata: { surface: `audit-integrity/${scope}`, autoDeclared: true },
    };
  }

  /**
   * Declares, and builds the page from whatever id came back.
   *
   * With a store-backed declarer the id is allocated from the rows that exist, so a restart
   * continues the year's sequence instead of reusing `INC-YYYY-0001`. A declarer that cannot be
   * reached must not swallow the page, for the same reason an unwritable audit log must not —
   * losing the alert is the worse failure. That fail-over is no longer written out here: the
   * wrapper does it, reports the store's error through `onError`, and `dispositionFor` reads back
   * which declarer served.
   */
  private async declare(report: IntegrityProofReport): Promise<IntegrityEscalationPlan> {
    const record = await this.declarer.declare(this.declarationRequest(report));
    return { incident: record, page: this.pageFor(record) };
  }

  private pageFor(incident: IncidentRecord): PageDirective | null {
    return planPageDirective(
      this.opts.config.alertPolicy,
      this.opts.config.severity,
      incident.id,
    );
  }

  /**
   * Closes the record out and says what became of it.
   *
   * Cancelling rather than resolving is the declarer's rule, not a shortcut here: `triaged`
   * requires the on-call roles to be assigned — five of them at sev1 — so no automated recovery can
   * reach a resolved state, and recording one would claim a response that never happened. A
   * declarer that throws is reported as `failed`, which reads as `declared`: the row is still open.
   *
   * An episode whose record only ever existed in this process closes out as `unpersisted` — the
   * wrapper routes it back to the declarer that minted it rather than asking the store to cancel an
   * id it never issued.
   */
  private async closeOut(incidentId: string): Promise<IncidentDisposition> {
    let closeOut: IncidentCloseOut;
    try {
      closeOut = await this.declarer.closeOut(incidentId, {
        reason: "audit-integrity proof no longer finds the trail altered",
        actorUserId: this.opts.config.declaredBy,
      });
    } catch (err) {
      this.opts.onError?.(err);
      closeOut = "failed";
    }
    return dispositionFromCloseOut(closeOut);
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
  const outcome =
    escalation.disposition === "human_owned"
      ? "left to its responders"
      : escalation.disposition === "cancelled"
        ? "cancelled"
        : "closing";
  return (
    `audit integrity for ${scope}: recovered, ${outcome} ${escalation.incidentId ?? "?"}`
  );
}

function channelLabel(target: AlertChannelTarget): string {
  return target.kind;
}
