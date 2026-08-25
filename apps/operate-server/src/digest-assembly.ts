import { sha256 } from "@crossengin/crypto";
import {
  type ContentCategory,
  type DigestBatch,
  type NotificationDispatch,
  type PriorityLevel,
} from "@crossengin/notifications";

export const DIGEST_TEMPLATE_ID = "notification.digest";
export const DIGEST_TEMPLATE_VERSION = "1.0.0";
export const DIGEST_REQUESTING_SYSTEM = "operate-server.digest-assembly";

/**
 * A digest summary is the *product* of the quiet-hours policy, so the policy must not be applied
 * to it again: batching a digest would pool it into another digest, forever. Its release time is
 * already decided — it is sent as soon as it is claimed.
 */
export function isDigestSummary(dispatch: {
  readonly templateId: string;
  readonly requestingSystem: string;
}): boolean {
  return (
    dispatch.templateId === DIGEST_TEMPLATE_ID &&
    dispatch.requestingSystem === DIGEST_REQUESTING_SYSTEM
  );
}

export interface DigestMember {
  readonly dispatchId: string;
  readonly rowId: string;
  readonly templateId: string;
  readonly category: ContentCategory;
  readonly priority: PriorityLevel;
  readonly locale: string;
  readonly correlationId: string | null;
  readonly queuedAt: string;
}

export interface DigestSummary {
  readonly digestId: string;
  readonly itemCount: number;
  readonly templateCounts: Readonly<Record<string, number>>;
  readonly earliestQueuedAt: string;
  readonly latestQueuedAt: string;
}

// Ordered most to least urgent. The load-bearing consequence is at the top of the list:
// `transactional` and `security_alert` are the NON_SUPPRESSIBLE_CATEGORIES, so a pool holding
// even one of them summarises to a non-suppressible category. Summarising must never make a
// notice easier to suppress than the notices it replaces — a digest that pooled a security
// alert has to survive every preference and quiet-hours check the alert itself would have.
export const CATEGORY_PRECEDENCE: readonly ContentCategory[] = [
  "security_alert",
  "transactional",
  "system_notice",
  "operational_digest",
  "marketing",
];

export const PRIORITY_PRECEDENCE: readonly PriorityLevel[] = [
  "critical",
  "high",
  "normal",
  "low",
  "background",
];

const DEFAULT_LOCALE = "en";
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const DISPATCH_ID_HEX_LENGTH = 32;
const AUDIENCE_KIND = "specific_user";
const DIGEST_RECIPIENT_COUNT = 1;

const LEAST_URGENT_CATEGORY: ContentCategory =
  CATEGORY_PRECEDENCE[CATEGORY_PRECEDENCE.length - 1] as ContentCategory;
const LEAST_URGENT_PRIORITY: PriorityLevel =
  PRIORITY_PRECEDENCE[PRIORITY_PRECEDENCE.length - 1] as PriorityLevel;

function normalizeLocale(locale: string): string {
  return LOCALE_PATTERN.test(locale) ? locale : DEFAULT_LOCALE;
}

function mostUrgent<T extends string>(
  precedence: readonly T[],
  present: readonly T[],
  fallback: T,
): T {
  for (const candidate of precedence) {
    if (present.includes(candidate)) return candidate;
  }
  return fallback;
}

export function digestCategory(
  members: readonly DigestMember[],
): ContentCategory {
  return mostUrgent(
    CATEGORY_PRECEDENCE,
    members.map((m) => m.category),
    LEAST_URGENT_CATEGORY,
  );
}

export function digestPriority(
  members: readonly DigestMember[],
): PriorityLevel {
  return mostUrgent(
    PRIORITY_PRECEDENCE,
    members.map((m) => m.priority),
    LEAST_URGENT_PRIORITY,
  );
}

export function digestLocale(members: readonly DigestMember[]): string {
  if (members.length === 0) return DEFAULT_LOCALE;
  const counts = new Map<string, number>();
  for (const member of members) {
    counts.set(member.locale, (counts.get(member.locale) ?? 0) + 1);
  }
  let winner = members[0]?.locale ?? DEFAULT_LOCALE;
  let best = counts.get(winner) ?? 0;
  for (const member of members) {
    const count = counts.get(member.locale) ?? 0;
    if (count > best) {
      winner = member.locale;
      best = count;
    }
  }
  return winner;
}

export function summarizeDigest(
  digest: DigestBatch,
  members: readonly DigestMember[],
): DigestSummary {
  const templateCounts: Record<string, number> = {};
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const member of members) {
    templateCounts[member.templateId] =
      (templateCounts[member.templateId] ?? 0) + 1;
    const at = Date.parse(member.queuedAt);
    if (earliest === null || at < Date.parse(earliest)) earliest = member.queuedAt;
    if (latest === null || at > Date.parse(latest)) latest = member.queuedAt;
  }

  return {
    digestId: digest.id,
    itemCount: members.length,
    templateCounts,
    earliestQueuedAt: earliest ?? digest.openedAt,
    latestQueuedAt: latest ?? digest.openedAt,
  };
}

// Canonical: object keys sorted and templateCounts re-emitted in sorted key order, so the
// hash depends only on the POOL, never on the order the members were read out of the store.
function canonicalSummaryJson(summary: DigestSummary): string {
  const templateIds = Object.keys(summary.templateCounts).sort();
  const templateCounts: Record<string, number> = {};
  for (const templateId of templateIds) {
    templateCounts[templateId] = summary.templateCounts[templateId] ?? 0;
  }
  return JSON.stringify({
    digestId: summary.digestId,
    earliestQueuedAt: summary.earliestQueuedAt,
    itemCount: summary.itemCount,
    latestQueuedAt: summary.latestQueuedAt,
    templateCounts,
  });
}

export function digestVariablesSha256(summary: DigestSummary): string {
  return sha256(canonicalSummaryJson(summary));
}

export function digestIdempotencyKey(digestId: string): string {
  return `digest:${digestId}`;
}

export function buildDigestDispatch(input: {
  readonly digest: DigestBatch;
  readonly members: readonly DigestMember[];
  readonly assembledAt: string;
}): NotificationDispatch {
  if (input.members.length === 0) {
    throw new Error(
      `digest ${input.digest.id} has no members to assemble; an empty digest is a bug, not a message`,
    );
  }

  const idempotencyKey = digestIdempotencyKey(input.digest.id);
  const summary = summarizeDigest(input.digest, input.members);

  return {
    id: `disp_${sha256(idempotencyKey).slice(0, DISPATCH_ID_HEX_LENGTH)}`,
    tenantId: input.digest.tenantId,
    templateId: DIGEST_TEMPLATE_ID,
    templateVersion: DIGEST_TEMPLATE_VERSION,
    locale: normalizeLocale(digestLocale(input.members)),
    channel: input.digest.channel,
    category: digestCategory(input.members),
    priority: digestPriority(input.members),
    audienceJson: { kind: AUDIENCE_KIND, userId: input.digest.userId },
    variablesSha256: digestVariablesSha256(summary),
    correlationId: input.digest.id,
    idempotencyKey,
    status: "queued",
    queuedAt: input.assembledAt,
    startedAt: null,
    completedAt: null,
    recipientCount: DIGEST_RECIPIENT_COUNT,
    deliveredCount: 0,
    failedCount: 0,
    suppressedCount: 0,
    cancelledReason: null,
    requestedBy: null,
    requestingSystem: DIGEST_REQUESTING_SYSTEM,
  };
}
