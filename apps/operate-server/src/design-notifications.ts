import { sha256 } from "@crossengin/crypto";
import type { NotificationDispatch } from "@crossengin/notifications";

export const DESIGN_NOTIFICATION_TEMPLATES: {
  readonly approved: string;
  readonly rejected: string;
} = {
  approved: "design_review.approved",
  rejected: "design_review.rejected",
};

export const DESIGN_NOTIFICATION_TEMPLATE_VERSION = "1.0.0";

export type DesignDecision = "approved" | "rejected";

export interface DesignDecisionNotice {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly proposalName: string;
  readonly decision: DesignDecision;
  readonly reviewedBy: string | null;
  readonly notes: string | null;
  readonly decidedAt: string;
  readonly locale?: string;
}

export type DesignNotificationDispatch = NotificationDispatch;

const REQUESTING_SYSTEM = "operate-server.design-review";
const DEFAULT_LOCALE = "en";
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const DISPATCH_ID_HEX_LENGTH = 32;
const MAX_CORRELATION_ID_LENGTH = 128;

// The audience is structural, not a resolved recipient list: delivery fans this out to every
// admin principal of the tenant at send time, so the dispatch row never stores addresses.
const AUDIENCE_KIND = "tenant_admins";

// One dispatch row per audience — recipient identities are resolved (and counted per delivery
// attempt) downstream, so the queued dispatch counts the single audience it addresses.
const AUDIENCE_RECIPIENT_COUNT = 1;

function normalizeLocale(locale: string | undefined): string {
  if (typeof locale === "string" && LOCALE_PATTERN.test(locale)) return locale;
  return DEFAULT_LOCALE;
}

function canonicalJson(variables: Record<string, string>): string {
  const keys = Object.keys(variables).sort();
  const entries = keys.map((key) => [key, variables[key] ?? ""] as const);
  return JSON.stringify(Object.fromEntries(entries));
}

// Deterministic by construction: the table carries a UNIQUE (tenant_id, idempotency_key), so
// re-deciding a proposal the same way twice collapses onto the one notification already queued.
export function designDecisionIdempotencyKey(
  proposalId: string,
  decision: DesignDecision,
): string {
  return `design_review:${proposalId}:${decision}`;
}

export function designNotificationVariables(
  notice: DesignDecisionNotice,
): Record<string, string> {
  return {
    decidedAt: notice.decidedAt,
    decision: notice.decision,
    notes: notice.notes ?? "",
    proposalId: notice.proposalId,
    proposalName: notice.proposalName,
    reviewedBy: notice.reviewedBy ?? "",
    tenantId: notice.tenantId,
  };
}

export function buildDesignDecisionDispatch(
  notice: DesignDecisionNotice,
): DesignNotificationDispatch {
  const idempotencyKey = designDecisionIdempotencyKey(
    notice.proposalId,
    notice.decision,
  );
  const variablesSha256 = sha256(canonicalJson(designNotificationVariables(notice)));

  return {
    id: `disp_${sha256(idempotencyKey).slice(0, DISPATCH_ID_HEX_LENGTH)}`,
    tenantId: notice.tenantId,
    templateId: DESIGN_NOTIFICATION_TEMPLATES[notice.decision],
    templateVersion: DESIGN_NOTIFICATION_TEMPLATE_VERSION,
    locale: normalizeLocale(notice.locale),
    channel: "in_app",
    category: "transactional",
    priority: "high",
    audienceJson: { kind: AUDIENCE_KIND, tenantId: notice.tenantId },
    variablesSha256,
    correlationId: notice.proposalId.slice(0, MAX_CORRELATION_ID_LENGTH),
    idempotencyKey,
    status: "queued",
    queuedAt: notice.decidedAt,
    startedAt: null,
    completedAt: null,
    recipientCount: AUDIENCE_RECIPIENT_COUNT,
    deliveredCount: 0,
    failedCount: 0,
    suppressedCount: 0,
    cancelledReason: null,
    // Always null: requested_by is a RESTRICT foreign key into meta.users, and the reviewer is
    // a platform operator with no row there — attributing them would fail the insert. Their
    // identity also stays deliberately out of a ledger the tenant itself can read.
    requestedBy: null,
    requestingSystem: REQUESTING_SYSTEM,
  };
}
