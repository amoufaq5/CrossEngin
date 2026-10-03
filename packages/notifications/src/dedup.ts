import type { NotificationChannel } from "./channels.js";
import { isCategorySuppressible, type ContentCategory } from "./templates.js";
import type { NotificationDispatch } from "./delivery.js";
import type { DigestFrequency } from "./throttling.js";

/**
 * Deterministic JSON, the same shape `canonicalAuditEntryPayload` uses in `@crossengin/auth`: object
 * keys sorted, `undefined` dropped, array order preserved. Copied rather than imported — a contracts
 * package does not take a dependency to borrow eight lines — and it must stay byte-identical in
 * behaviour, because the same reasoning applies: a dedup hash computed before an insert has to match
 * one recomputed from the `JSONB` audience read back, and `JSONB` does not preserve key order.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Injected, because this package is contracts: it may not reach for `node:crypto`. The caller passes
 * the same SHA-256 the rest of the platform uses (`@crossengin/crypto`).
 */
export type DedupHasher = (payload: string) => string;

export interface DispatchDedupInput {
  readonly tenantId: string;
  readonly templateId: string;
  readonly locale: string;
  readonly channel: NotificationChannel;
  readonly category: ContentCategory;
  readonly audience: Readonly<Record<string, unknown>>;
  readonly variablesSha256: string;
}

/**
 * The bytes a dedup hash commits to: what the recipient would actually receive.
 *
 * **In**, and why each is load-bearing:
 * - `tenantId` — two tenants sending the same notice are two notices. Without it one tenant's send
 *   could suppress another's, across the RLS boundary, which is the worst bug available here.
 * - `templateId`, `locale`, `channel` — together these pick the rendered message. The same notice in
 *   two languages or on two channels is two messages a recipient can see, so they are two keys.
 * - `category` — a marketing blast and a security alert built from one template id are not the same
 *   notice, and the category is what the suppression and quiet-hours rules read.
 * - `variablesSha256` — the content. Already a hash on the record, so nothing is widened.
 * - `audience` — who it is for. Canonicalised, so `JSONB` key order cannot change the key.
 *
 * **Out**, and why each would break it:
 * - `queuedAt`, `startedAt`, `completedAt` — any timestamp makes every dispatch unique, which is
 *   exactly the thing a dedup key must not do.
 * - `idempotencyKey` — the caller's own anti-retry token, unique per call by construction. Including
 *   it turns dedup into a no-op. The two mechanisms answer different questions: idempotency catches
 *   *this request* twice, dedup catches *this notice* twice.
 * - `templateVersion` — a patch bump that fixes a typo must not resend yesterday's notice.
 * - `priority` — the same notice escalated is still the same notice.
 * - `requestedBy`, `requestingSystem`, `correlationId` — provenance, not content. One notice raised
 *   by two schedulers is one notice.
 * - `id`, `status` and the counters — identity and progress, not content.
 */
export const canonicalDispatchDedupPayload = (
  input: DispatchDedupInput,
): string =>
  canonicalJson({
    audience: input.audience,
    category: input.category,
    channel: input.channel,
    locale: input.locale,
    templateId: input.templateId,
    tenantId: input.tenantId,
    variablesSha256: input.variablesSha256,
  });

export const dispatchDedupInputFrom = (
  dispatch: NotificationDispatch,
): DispatchDedupInput => ({
  tenantId: dispatch.tenantId,
  templateId: dispatch.templateId,
  locale: dispatch.locale,
  channel: dispatch.channel,
  category: dispatch.category,
  audience: dispatch.audienceJson,
  variablesSha256: dispatch.variablesSha256,
});

const checkedDigest = (digest: string, what: string): string => {
  if (!SHA256_HEX.test(digest)) {
    // The column's CHECK constraint should not be the first thing to notice a hasher returning
    // base64, or an uppercase hex digest that would never match a stored lowercase one.
    throw new RangeError(
      `${what} hasher must return lowercase 64-hex SHA-256, got: ${digest}`,
    );
  }
  return digest;
};

export const computeDispatchDedupSha256 = (
  input: DispatchDedupInput,
  hash: DedupHasher,
): string =>
  checkedDigest(hash(canonicalDispatchDedupPayload(input)), "dispatch dedup");

export interface DigestDedupInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly channel: NotificationChannel;
  readonly frequency: DigestFrequency;
  readonly memberDedupSha256: readonly string[];
}

/**
 * The digest's own key — what `meta.notification_digests.dedup_sha256` was declared for and what
 * ADR-0276 called "where 'you already saw this' would live".
 *
 * Membership is **sorted and de-duplicated** before hashing, which is the one place this diverges
 * from `canonicalJson`'s array handling. A pool is a set: the order two notices happened to land in
 * it is an artefact of the drain, and the same two notices pooled in either order are the same
 * digest. `canonicalAuditEntryPayload` keeps array order because an audit `after` array is a value;
 * here it is a membership list.
 */
export const canonicalDigestDedupPayload = (input: DigestDedupInput): string =>
  canonicalJson({
    channel: input.channel,
    frequency: input.frequency,
    memberDedupSha256: [...new Set(input.memberDedupSha256)].sort(),
    tenantId: input.tenantId,
    userId: input.userId,
  });

export const computeDigestDedupSha256 = (
  input: DigestDedupInput,
  hash: DedupHasher,
): string =>
  checkedDigest(hash(canonicalDigestDedupPayload(input)), "digest dedup");

export const DEDUP_REASONS = [
  "unique",
  "duplicate_within_window",
  "window_not_configured",
  "no_prior_dispatches",
] as const;
export type DedupReason = (typeof DEDUP_REASONS)[number];

export interface DedupCandidate {
  readonly dispatchId: string;
  readonly dedupSha256: string;
  readonly queuedAt: string;
}

export interface DedupDecision {
  readonly duplicate: boolean;
  readonly reason: DedupReason;
  readonly ofDispatchId: string | null;
  readonly ageSeconds: number | null;
}

export const dedupCandidateFrom = (
  dispatch: NotificationDispatch,
  dedupSha256: string,
): DedupCandidate => ({
  dispatchId: dispatch.id,
  dedupSha256,
  queuedAt: dispatch.queuedAt,
});

/**
 * Does this notice duplicate one already sent inside the window?
 *
 * The match is the **most recent** prior with the same hash, so the reported age is the smallest
 * one, which is what a window is asked about. A prior whose `queuedAt` is ahead of `now` still
 * counts: that is clock skew between two writers, not a notice from the future, and ignoring it
 * would let a skewed pair through as two sends.
 */
export const decideDispatchDedup = (input: {
  readonly dedupSha256: string;
  readonly recent: readonly DedupCandidate[];
  readonly windowSeconds: number;
  readonly now: Date;
}): DedupDecision => {
  if (!Number.isFinite(input.windowSeconds) || input.windowSeconds <= 0) {
    return {
      duplicate: false,
      reason: "window_not_configured",
      ofDispatchId: null,
      ageSeconds: null,
    };
  }
  if (input.recent.length === 0) {
    return {
      duplicate: false,
      reason: "no_prior_dispatches",
      ofDispatchId: null,
      ageSeconds: null,
    };
  }
  const nowMs = input.now.getTime();
  const floorMs = nowMs - input.windowSeconds * 1000;
  let best: { readonly id: string; readonly ms: number } | null = null;
  for (const candidate of input.recent) {
    if (candidate.dedupSha256 !== input.dedupSha256) continue;
    const ms = Date.parse(candidate.queuedAt);
    if (Number.isNaN(ms)) continue;
    if (ms < floorMs) continue;
    if (best === null || ms > best.ms) best = { id: candidate.dispatchId, ms };
  }
  if (best === null) {
    return {
      duplicate: false,
      reason: "unique",
      ofDispatchId: null,
      ageSeconds: null,
    };
  }
  return {
    duplicate: true,
    reason: "duplicate_within_window",
    ofDispatchId: best.id,
    ageSeconds: Math.max(0, Math.round((nowMs - best.ms) / 1000)),
  };
};

/**
 * Whether a duplicate should actually be withheld.
 *
 * Dedup is a courtesy, not consent, so it stops at the same line suppression does: a
 * `security_alert` or `transactional` notice is **never** withheld as a duplicate. A second receipt
 * is noise; a missing one is a defect, and a security alert that was swallowed because an earlier
 * one looked the same is the failure this rule exists to prevent. Deciding and withholding are kept
 * apart so a caller can record "this was a duplicate" on a notice it sent anyway.
 */
export const shouldWithholdDuplicate = (
  decision: DedupDecision,
  category: ContentCategory,
): boolean => decision.duplicate && isCategorySuppressible(category);
