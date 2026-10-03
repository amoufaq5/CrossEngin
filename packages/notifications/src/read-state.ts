import { z } from "zod";
import type { NotificationDispatch } from "./delivery.js";

/**
 * Per-user notification read state.
 *
 * Until now "unread" was a recency approximation (ADR-0273, ADR-0278): the inbox showed the newest
 * N delivered notices and called them unread. That answers "what is new" and not "what have you
 * seen", and the two diverge the moment a person reads something and reloads.
 *
 * Read state is recorded two ways, because the two questions a reader asks have different shapes:
 *
 * - a `NotificationReadState` row per notice actually opened, and
 * - one `NotificationReadWatermark` per viewer for "I have read everything up to here".
 *
 * A watermark rather than N rows for mark-all-read is not an optimisation. It is the only form that
 * can answer for notices the reader has not been shown — a deployment that turns this on sets a
 * watermark at go-live, and the entire backlog reads as read, which is the truth: nobody is going
 * to open three months of receipts. Written as rows, that backfill is unbounded and has to be
 * repeated for every notice that was delivered before the feature existed.
 */
export const READ_STATE_SOURCES = [
  "user_action",
  "bulk_mark_read",
  "digest_rollup",
  "system_backfill",
] as const;
export type ReadStateSource = (typeof READ_STATE_SOURCES)[number];

const DISPATCH_ID_PATTERN = /^disp_[A-Za-z0-9_-]{8,40}$/;

export const NotificationReadStateSchema = z.object({
  id: z.string().regex(/^nrs_[A-Za-z0-9_-]{8,40}$/),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  dispatchId: z.string().regex(DISPATCH_ID_PATTERN),
  readAt: z.string().datetime({ offset: true }),
  source: z.enum(READ_STATE_SOURCES),
});
export type NotificationReadState = z.infer<typeof NotificationReadStateSchema>;

export const NotificationReadWatermarkSchema = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    readThroughAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    source: z.enum(READ_STATE_SOURCES),
  })
  .superRefine((w, ctx) => {
    if (Date.parse(w.readThroughAt) > Date.parse(w.updatedAt)) {
      // "I have read everything up to here" is a claim about the past. A watermark reaching past
      // the moment it was written would mark notices read before they were even queued.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readThroughAt"],
        message: "readThroughAt cannot be after updatedAt",
      });
    }
  });
export type NotificationReadWatermark = z.infer<
  typeof NotificationReadWatermarkSchema
>;

export interface InboxViewer {
  readonly tenantId: string;
  readonly userId: string;
}

export interface ReadStateIndex {
  readonly readDispatchIds: ReadonlySet<string>;
  readonly readThroughMs: number | null;
}

export const EMPTY_READ_STATE_INDEX: ReadStateIndex = {
  readDispatchIds: new Set<string>(),
  readThroughMs: null,
};

export const readStateKey = (
  tenantId: string,
  userId: string,
  dispatchId: string,
): string => `${tenantId}|${userId}|${dispatchId}`;

export const indexReadState = (
  viewer: InboxViewer,
  states: readonly NotificationReadState[],
  watermarks: readonly NotificationReadWatermark[],
): ReadStateIndex => {
  const readDispatchIds = new Set<string>();
  for (const state of states) {
    // Both halves of the key are checked. A row carrying this user id under another tenant must
    // never mark this tenant's notice read — the same id can exist in two tenants.
    if (state.tenantId !== viewer.tenantId) continue;
    if (state.userId !== viewer.userId) continue;
    readDispatchIds.add(state.dispatchId);
  }
  let readThroughMs: number | null = null;
  for (const mark of watermarks) {
    if (mark.tenantId !== viewer.tenantId) continue;
    if (mark.userId !== viewer.userId) continue;
    const ms = Date.parse(mark.readThroughAt);
    if (Number.isNaN(ms)) continue;
    if (readThroughMs === null || ms > readThroughMs) readThroughMs = ms;
  }
  return { readDispatchIds, readThroughMs };
};

export const isUnread = (
  dispatch: NotificationDispatch,
  index: ReadStateIndex,
): boolean => {
  if (index.readDispatchIds.has(dispatch.id)) return false;
  if (index.readThroughMs === null) return true;
  const queuedMs = Date.parse(dispatch.queuedAt);
  // An unreadable timestamp shows the notice rather than hiding it. Fail-closed here means
  // withholding nothing from the reader: the cost of a stray unread badge is noise, the cost of
  // silently filing a notice as read is a notice nobody ever sees.
  if (Number.isNaN(queuedMs)) return true;
  return queuedMs > index.readThroughMs;
};

export interface ReadPartition {
  readonly read: readonly NotificationDispatch[];
  readonly unread: readonly NotificationDispatch[];
}

export const partitionByRead = (
  dispatches: readonly NotificationDispatch[],
  index: ReadStateIndex,
): ReadPartition => {
  const read: NotificationDispatch[] = [];
  const unread: NotificationDispatch[] = [];
  for (const dispatch of dispatches) {
    if (isUnread(dispatch, index)) unread.push(dispatch);
    else read.push(dispatch);
  }
  return { read, unread };
};

export const countUnread = (
  dispatches: readonly NotificationDispatch[],
  index: ReadStateIndex,
): number => {
  let count = 0;
  for (const dispatch of dispatches) if (isUnread(dispatch, index)) count += 1;
  return count;
};

export interface MarkReadInput {
  readonly viewer: InboxViewer;
  readonly dispatch: NotificationDispatch;
  readonly id: string;
  readonly now: Date;
  readonly source: ReadStateSource;
  readonly existing?: NotificationReadState | undefined;
}

export const markRead = (input: MarkReadInput): NotificationReadState => {
  // First read wins. Re-opening a notice must not move `readAt`, or the field stops answering
  // "when did you first see this" and starts answering "when did you last look", which is not what
  // a read receipt is for and not what an access review can rely on.
  if (input.existing !== undefined) return input.existing;
  return NotificationReadStateSchema.parse({
    id: input.id,
    tenantId: input.viewer.tenantId,
    userId: input.viewer.userId,
    dispatchId: input.dispatch.id,
    readAt: input.now.toISOString(),
    source: input.source,
  });
};

export interface MarkAllReadInput {
  readonly viewer: InboxViewer;
  readonly upTo: Date;
  readonly now: Date;
  readonly source: ReadStateSource;
  readonly existing?: NotificationReadWatermark | undefined;
}

export const markAllReadUpTo = (
  input: MarkAllReadInput,
): NotificationReadWatermark => {
  // Clamped to `now`, because a reader cannot have read a notice that has not been queued yet, and
  // never moved backwards, because a stale client replaying an older position would otherwise
  // un-read everything between the two.
  const requestedMs = Math.min(input.upTo.getTime(), input.now.getTime());
  const existingMs =
    input.existing === undefined
      ? Number.NaN
      : Date.parse(input.existing.readThroughAt);
  const resolvedMs =
    !Number.isNaN(existingMs) && existingMs > requestedMs
      ? existingMs
      : requestedMs;
  return NotificationReadWatermarkSchema.parse({
    tenantId: input.viewer.tenantId,
    userId: input.viewer.userId,
    readThroughAt: new Date(resolvedMs).toISOString(),
    updatedAt: input.now.toISOString(),
    source: input.source,
  });
};

/**
 * Why a row and a dispatch disagree, or an empty list. The schema validates one record; only a
 * caller holding both can see that a read state names the wrong notice or predates it.
 */
export const readStateBlockers = (
  state: NotificationReadState,
  dispatch: NotificationDispatch,
): readonly string[] => {
  const blockers: string[] = [];
  if (state.dispatchId !== dispatch.id) {
    blockers.push(
      `read state names dispatch ${state.dispatchId}, not ${dispatch.id}`,
    );
  }
  if (state.tenantId !== dispatch.tenantId) {
    blockers.push(
      `read state tenant ${state.tenantId} does not match dispatch tenant ${dispatch.tenantId}`,
    );
  }
  const readMs = Date.parse(state.readAt);
  const queuedMs = Date.parse(dispatch.queuedAt);
  if (!Number.isNaN(readMs) && !Number.isNaN(queuedMs) && readMs < queuedMs) {
    blockers.push(`readAt ${state.readAt} precedes queuedAt ${dispatch.queuedAt}`);
  }
  return blockers;
};

/**
 * The rows a watermark has made redundant, so a store can delete them. Keeping both is not wrong,
 * only unbounded — the per-notice row is the finer record and the watermark already covers it.
 */
export const supersededReadStates = (
  states: readonly NotificationReadState[],
  watermark: NotificationReadWatermark,
  dispatchQueuedAt: ReadonlyMap<string, string>,
): readonly NotificationReadState[] => {
  const throughMs = Date.parse(watermark.readThroughAt);
  if (Number.isNaN(throughMs)) return [];
  const superseded: NotificationReadState[] = [];
  for (const state of states) {
    if (state.tenantId !== watermark.tenantId) continue;
    if (state.userId !== watermark.userId) continue;
    const queuedAt = dispatchQueuedAt.get(state.dispatchId);
    // A row whose notice the caller could not supply is kept. Deleting on an unknown position
    // would drop the only record that the notice was opened.
    if (queuedAt === undefined) continue;
    const queuedMs = Date.parse(queuedAt);
    if (Number.isNaN(queuedMs)) continue;
    if (queuedMs <= throughMs) superseded.push(state);
  }
  return superseded;
};
