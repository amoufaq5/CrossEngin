import { randomUUID } from "node:crypto";

import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import {
  READ_STATE_SOURCES,
  countUnread,
  markAllReadUpTo,
  partitionByRead,
  type InboxViewer,
  type ReadStateIndex,
  type ReadStateSource,
} from "@crossengin/notifications";

import type {
  ReadStateWriteResult,
  WatermarkWriteResult,
} from "./read-state-store.js";
import type { NotificationIdentityResolver } from "./notification-routes.js";

/**
 * The three routes an inbox needs to say "I have seen this".
 *
 * ADR-0309 modelled per-user read state and nothing stored one; ADR-0330 built the store
 * (`PostgresReadStateStore`) and nothing called it. So the tables were written, the rules were
 * enforced in SQL, and an inbox still could not mark a notice read over HTTP.
 *
 * Four properties the route layer owns, because the store below it is deliberately ignorant of who
 * called:
 *
 * - **The viewer is the credential.** Read state is keyed `(tenant, user, dispatch)`, and the user
 *   half comes from `principal.principalId` — never from the body, never from a path segment. This
 *   is stricter than most routes here: a `userId` the caller could name would let any principal mark
 *   *another person's* notices read, or read their unread count, which is both a write under someone
 *   else's name and a disclosure of what they have opened. A body that names one is **refused**, not
 *   quietly ignored: a client sending it believes it is acting for that user, and silently writing
 *   the caller's own read state instead would have them believe it worked.
 * - **`source` is not the caller's to choose freely.** A route caller may assert the source that
 *   describes the act it is performing and nothing else. `system_backfill` can mark an entire
 *   backlog read in one call, so it is its own fail-closed grant — ADR-0313's shape for
 *   non-suppressible categories — and `digest_rollup` is not assertable over HTTP at all.
 * - **The watermark position is clamped to the server's clock.** The body proposes; `markAllReadUpTo`
 *   clamps to `now` and the store's `GREATEST` refuses a retreat. ADR-0321's rule, where the Article
 *   12(3) deadline is computed from the deployment rather than accepted from the body.
 * - **An unread count consults the notices, not only the watermark.** `isUnread` fails *open* — a
 *   notice with an unparseable `queuedAt` is shown rather than hidden — and the only way to preserve
 *   that is to hand the real notices to the contract's own `countUnread`/`partitionByRead` rather
 *   than deriving a number from the watermark alone.
 *
 * **These reads are not themselves audited, deliberately.** ADR-0313 records an audit-trail read
 * before serving it and refuses one it cannot record, because that read crosses a boundary the
 * reader does not own. Here the reader, the subject and the tenant are the same principal by
 * construction — there is no `?scope=tenant` on an unread count, because "unread" is only ever a
 * fact about one viewer — so the only person a record would protect is the one who already knows.
 * The cost would be real and asymmetric: ADR-0313's refuse-if-unrecordable would make an inbox badge
 * 503 whenever the audit log is unavailable, i.e. stop telling people they have notifications because
 * the record of them *looking* could not be written. And the per-notice read state **is** the
 * reviewable record — `(tenant, user, dispatch, readAt, source)` with first-read-wins — so a second
 * audit row would be a weaker duplicate of it. The one exception is the privileged write: a granted
 * `system_backfill` is recorded before it lands and refused when it cannot be.
 */

export interface InboxNoticeLike {
  readonly dispatchId: string;
  readonly queuedAt: string;
}

export interface InboxNoticeQueryLike {
  readonly dispatchId?: string;
  readonly channel?: string;
  readonly limit?: number;
  readonly recipientAddressSha256?: readonly string[];
}

/** Structurally satisfied by `PostgresNotificationStore`; the inbox projection is all this needs. */
export interface InboxNoticeSourceLike {
  listForTenant(
    tenantId: string,
    query?: InboxNoticeQueryLike,
  ): Promise<{ data: readonly InboxNoticeLike[]; nextCursor: string | null }>;
}

/** Structurally satisfied by `PostgresReadStateStore`. */
export interface ReadStateStoreLike {
  markRead(
    viewer: InboxViewer,
    dispatchId: string,
    input: { readonly id: string; readonly at: string; readonly source: ReadStateSource },
  ): Promise<ReadStateWriteResult>;
  markAllReadUpTo(
    viewer: InboxViewer,
    input: {
      readonly readThroughAt: string;
      readonly at: string;
      readonly source: ReadStateSource;
    },
  ): Promise<WatermarkWriteResult>;
  indexFor(viewer: InboxViewer): Promise<ReadStateIndex>;
}

export interface BackfillAuditEvent {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly principalId: string | null;
  readonly roles: readonly string[];
  /** Whether the caller's role actually carried the backfill grant. */
  readonly granted: boolean;
  /** The position asked for, after clamping — the figure that says how much was marked read. */
  readonly readThroughAt: string;
  readonly at: string;
}

export type BackfillAuditor = (event: BackfillAuditEvent) => Promise<void>;

export const BACKFILL_GRANTED_OPERATION = "notifications.read_state_backfill";
export const BACKFILL_DENIED_OPERATION = "notifications.read_state_backfill_denied";

export interface ReadStateRoutesContext {
  readonly store: ReadStateStoreLike;
  readonly notices: InboxNoticeSourceLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /**
   * Roles permitted to record their own read state. Fail-closed: empty ⇒ nobody. Reading one's own
   * inbox is not privileged, but an unconfigured grant must still not read as an open one.
   */
  readonly allowedRoles: ReadonlySet<string>;
  /**
   * Roles permitted to assert `system_backfill`, which marks a whole backlog read in one call.
   * Fail-closed: absent or empty ⇒ nobody. `buildReadStateRoutes` refuses to construct a non-empty
   * grant with no `auditBackfill`, because a bulk read-state write nothing can account for is the
   * one surface here in ADR-0313's class.
   */
  readonly backfillRoles?: ReadonlySet<string>;
  readonly auditBackfill?: BackfillAuditor;
  /**
   * Turns the calling principal into the address hashes the delivery ledger recorded for them.
   * Wiring it scopes the unread count to the viewer's own notices; leaving it unwired counts the
   * tenant's, exactly as the inbox listing behaves without it.
   */
  readonly resolveIdentity?: NotificationIdentityResolver;
  /** How many notices one unread answer may examine. The count is reported with `truncated`. */
  readonly unreadScanLimit?: number;
  readonly newReadStateId?: () => string;
  readonly clock?: () => Date;
}

/** Enough for any real inbox, and bounded because an exact count would need a store-side anti-join. */
export const DEFAULT_UNREAD_SCAN_LIMIT = 200;

/**
 * The most a deployment may raise the scan to.
 *
 * The ceiling exists because the page is read to answer a **badge**, which is polled on every page
 * load: a count that examines ten thousand rows per poll is a self-inflicted load problem, and it
 * still would not be exact. Raising the number buys a larger floor under `unread`, never certainty —
 * the honest fix is the anti-join nobody has written, not a bigger page.
 */
export const MAX_UNREAD_SCAN_LIMIT = 1000;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DISPATCH_ID_RE = /^disp_[A-Za-z0-9_-]{8,40}$/;

/** Body keys that would name a viewer. Present ⇒ 400, because the viewer is the credential. */
export const VIEWER_BODY_KEYS = ["userId", "tenantId", "viewer", "user_id", "tenant_id"] as const;

/**
 * The sources a route caller may assert, per surface.
 *
 * `user_action` is the single-notice act and `bulk_mark_read` the watermark act; those are what
 * actually happened when a person clicks. `digest_rollup` appears on neither, because it means "a
 * digest carried this, so it counts as read" — an attribution only the digest assembler is in a
 * position to make, and an HTTP client claiming it would file a human click as a system rollup.
 * `system_backfill` is watermark-only by nature: ADR-0309's whole reason for a watermark is that the
 * backfill is unbounded as rows, so a per-notice backfill is not a thing to permit.
 */
export const ASSERTABLE_READ_SOURCES: Readonly<Record<ReadStateRouteKind, readonly ReadStateSource[]>> = {
  one: ["user_action"],
  through: ["bulk_mark_read", "system_backfill"],
};

export type ReadStateRouteKind = "one" | "through";

/** The sources whose assertion needs its own grant, whatever the surface. */
export const PRIVILEGED_READ_SOURCES: readonly ReadStateSource[] = ["system_backfill"];

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: ReadStateRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function hasAnyRole(roles: readonly string[], allowed: ReadonlySet<string> | undefined): boolean {
  if (allowed === undefined || allowed.size === 0) return false;
  return roles.some((r) => allowed.has(r));
}

export interface ViewerResolution {
  readonly ok: boolean;
  readonly viewer?: InboxViewer;
  readonly denial?: HandlerOutput;
}

/**
 * The viewer, from the credential and nothing else.
 *
 * Both failures are **403 and not 400**. A 400 tells the caller to fix the request, and there is
 * nothing in the request to fix: read state is keyed on a viewer, the viewer comes from the
 * credential, and a credential that resolves no tenant or no user simply cannot hold read state.
 * That is a property of who is calling — which is what 403 means — and it is the same answer
 * `job-cancel-routes` gives for a principal with no resolvable tenant.
 *
 * A non-`user` principal is refused for the same reason and not as a formality: `principalId` is a
 * UUID for a service account too, and `meta.notification_read_states.user_id` is a foreign key into
 * `meta.users`, so admitting one would either violate the constraint or — worse, if the id happened
 * to collide with a user row — file a machine's fetch as that person having read their mail.
 */
export function resolveViewer(
  ctx: ReadStateRoutesContext,
  principal: ResolvedPrincipal | null,
): ViewerResolution {
  if (principal === null) {
    return { ok: false, denial: json(401, { error: "authentication_required" }) };
  }
  if (!hasAnyRole(rolesOf(ctx, principal), ctx.allowedRoles)) {
    return {
      ok: false,
      denial: json(403, { error: "forbidden", detail: "notification read state is not granted to this role" }),
    };
  }
  const tenantId = principal.tenantId ?? "";
  if (!UUID_RE.test(tenantId)) {
    return {
      ok: false,
      denial: json(403, { error: "forbidden", detail: "no tenant resolves for this principal" }),
    };
  }
  if (principal.principalKind !== "user" || !UUID_RE.test(principal.principalId)) {
    return {
      ok: false,
      denial: json(403, {
        error: "forbidden",
        detail: "no viewer resolves for this principal; read state is per user",
      }),
    };
  }
  return { ok: true, viewer: { tenantId, userId: principal.principalId } };
}

export function bodyNamesAViewer(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  for (const key of VIEWER_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) return key;
  }
  return null;
}

export type SourceDecision =
  | { readonly kind: "ok"; readonly source: ReadStateSource }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "ungranted"; readonly detail: string };

/**
 * Which source this request may record under.
 *
 * The two refusals are different facts and get different statuses. A source no caller of this
 * surface may ever assert is **400**: the request is malformed whoever sends it, and a 403 would
 * imply some role could be given it. A source that is assertable but not by this role is **403** —
 * exactly the shape ADR-0313 gave authoring a non-suppressible category.
 */
export function decideSource(
  raw: unknown,
  kind: ReadStateRouteKind,
  mayBackfill: boolean,
): SourceDecision {
  const assertable = ASSERTABLE_READ_SOURCES[kind];
  if (raw === undefined || raw === null) {
    const fallback = assertable[0];
    if (fallback === undefined) return { kind: "invalid", detail: "no source is assertable here" };
    return { kind: "ok", source: fallback };
  }
  if (typeof raw !== "string") return { kind: "invalid", detail: "source must be a string" };
  if (!(READ_STATE_SOURCES as readonly string[]).includes(raw)) {
    return { kind: "invalid", detail: `source must be one of ${READ_STATE_SOURCES.join(", ")}` };
  }
  const source = raw as ReadStateSource;
  if (!assertable.includes(source)) {
    return {
      kind: "invalid",
      detail: `source ${source} cannot be asserted over HTTP on this route`,
    };
  }
  if (PRIVILEGED_READ_SOURCES.includes(source) && !mayBackfill) {
    return { kind: "ungranted", detail: `asserting source ${source} is not granted to this role` };
  }
  return { kind: "ok", source };
}

export type PositionDecision =
  | { readonly kind: "ok"; readonly upTo: Date }
  | { readonly kind: "invalid"; readonly detail: string };

/**
 * The requested watermark position, parsed and nothing more — the clamp is `markAllReadUpTo`'s.
 *
 * Required rather than defaulted to `now`, because silence would resolve to the *maximal* position:
 * a body that forgot the field would mark everything read. ADR-0328's rule — a default is applied to
 * silence, and silence must not decide how much is covered — in a smaller place.
 */
export function decidePosition(raw: unknown): PositionDecision {
  if (raw === undefined || raw === null) {
    return { kind: "invalid", detail: "readThroughAt is required" };
  }
  if (typeof raw !== "string") return { kind: "invalid", detail: "readThroughAt must be a string" };
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return { kind: "invalid", detail: "readThroughAt must be an ISO-8601 timestamp" };
  }
  return { kind: "ok", upTo: new Date(ms) };
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function queryOf(input: Parameters<Handler>[0]): Record<string, string | string[]> {
  return (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
}

/**
 * The viewer's own address hashes, or null for "no filter".
 *
 * An identity that cannot be resolved yields an **empty** list, which the notice source reads as no
 * addresses and so no notices. That is the inbox listing's own rule (`recipientFilterFor`): widening
 * it back to the tenant would count somebody else's notices into this viewer's badge.
 */
export async function selfNoticeFilter(
  ctx: ReadStateRoutesContext,
  principal: ResolvedPrincipal | null,
  tenantId: string,
): Promise<readonly string[] | null> {
  if (ctx.resolveIdentity === undefined) return null;
  const principalId = principal?.principalId ?? null;
  if (principalId === null) return [];
  try {
    const identity = await ctx.resolveIdentity(tenantId, principalId);
    return identity?.addressHashes ?? [];
  } catch {
    return [];
  }
}

export function newReadStateId(): string {
  return `nrs_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function buildMarkReadHandler(ctx: ReadStateRoutesContext): Handler {
  return async (input) => {
    const resolved = resolveViewer(ctx, input.principal);
    if (!resolved.ok || resolved.viewer === undefined) {
      return resolved.denial ?? json(403, { error: "forbidden" });
    }
    const viewer = resolved.viewer;
    const named = bodyNamesAViewer(input.parsedBody);
    if (named !== null) {
      return json(400, {
        error: "invalid_request",
        detail: `${named} is not accepted; the viewer is taken from the credential`,
      });
    }
    const dispatchId = input.params["dispatchId"] ?? "";
    if (!DISPATCH_ID_RE.test(dispatchId)) {
      return json(400, { error: "invalid_request", detail: "dispatchId must be a disp_… identifier" });
    }
    const mayBackfill = hasAnyRole(rolesOf(ctx, input.principal), ctx.backfillRoles);
    const source = decideSource(input.parsedBody?.["source"], "one", mayBackfill);
    if (source.kind === "invalid") return json(400, { error: "invalid_request", detail: source.detail });
    if (source.kind === "ungranted") return json(403, { error: "forbidden", detail: source.detail });

    const hashes = await selfNoticeFilter(ctx, input.principal, viewer.tenantId);
    let notice: InboxNoticeLike | undefined;
    try {
      // The notice is looked up **before** the write, and this does not undo either SQL write rule:
      // first-read-wins and the watermark's monotonicity are still decided by the statement. What
      // this answers is ownership, which the foreign key cannot — `dispatch_id` references
      // `notification_dispatches.dispatch_id` alone, so another tenant's dispatch would satisfy it
      // and leave a row whose read state and notice disagree about whose it is (exactly
      // `readStateBlockers`' second finding), while telling the caller that id exists.
      const page = await ctx.notices.listForTenant(viewer.tenantId, {
        dispatchId,
        limit: 1,
        ...(hashes !== null ? { recipientAddressSha256: hashes } : {}),
      });
      notice = page.data[0];
    } catch {
      return json(503, { error: "inbox_unavailable", detail: "the notice could not be read" });
    }
    if (notice === undefined) {
      // A dispatch outside this viewer's inbox reads as absent rather than as forbidden: a dispatch
      // id is not a capability, and distinguishing the two would confirm it exists elsewhere.
      return json(404, { error: "not_found", detail: "no such notice in this inbox" });
    }

    const now = (ctx.clock ?? ((): Date => new Date()))();
    let result: ReadStateWriteResult;
    try {
      result = await ctx.store.markRead(viewer, dispatchId, {
        id: (ctx.newReadStateId ?? newReadStateId)(),
        at: now.toISOString(),
        source: source.source,
      });
    } catch {
      return json(503, {
        error: "read_state_unavailable",
        detail: "the read state could not be recorded",
      });
    }
    return json(200, {
      dispatchId,
      outcome: result.outcome,
      readState: result.state,
    });
  };
}

function buildReadThroughHandler(ctx: ReadStateRoutesContext): Handler {
  return async (input) => {
    const resolved = resolveViewer(ctx, input.principal);
    if (!resolved.ok || resolved.viewer === undefined) {
      return resolved.denial ?? json(403, { error: "forbidden" });
    }
    const viewer = resolved.viewer;
    const named = bodyNamesAViewer(input.parsedBody);
    if (named !== null) {
      return json(400, {
        error: "invalid_request",
        detail: `${named} is not accepted; the viewer is taken from the credential`,
      });
    }
    const roles = rolesOf(ctx, input.principal);
    const mayBackfill = hasAnyRole(roles, ctx.backfillRoles);
    const source = decideSource(input.parsedBody?.["source"], "through", mayBackfill);
    if (source.kind === "invalid") return json(400, { error: "invalid_request", detail: source.detail });
    const position = decidePosition(input.parsedBody?.["readThroughAt"]);
    if (position.kind === "invalid") {
      return json(400, { error: "invalid_request", detail: position.detail });
    }
    const now = (ctx.clock ?? ((): Date => new Date()))();

    if (source.kind === "ungranted") {
      // A refused escalation is worth recording and is not itself privileged access, so a failure
      // to record it must not become a 503 — ADR-0313's rule, which also keeps a prober from
      // learning that the recorder is down.
      if (ctx.auditBackfill !== undefined) {
        try {
          await ctx.auditBackfill(
            backfillEvent(input.principal, viewer, roles, false, position.upTo, now),
          );
        } catch {
          /* best effort */
        }
      }
      return json(403, { error: "forbidden", detail: source.detail });
    }

    // Clamped by the contract's own `markAllReadUpTo`, not by arithmetic here: it takes
    // `min(upTo, now)` and the schema refuses a position past the write time. A body asking to read
    // through next week gets this instant instead, and the store's `GREATEST` is what stops a stale
    // client from walking it backwards.
    const proposed = markAllReadUpTo({ viewer, upTo: position.upTo, now, source: source.source });
    const clamped = Date.parse(proposed.readThroughAt) !== position.upTo.getTime();

    if (source.source === "system_backfill") {
      if (ctx.auditBackfill === undefined) {
        return json(503, {
          error: "audit_unavailable",
          detail: "a backfill cannot be granted while it cannot be recorded",
        });
      }
      try {
        // Recorded BEFORE the write, and a failed record refuses it. One call here marks an entire
        // backlog read for somebody; unaudited, nothing could later say how much.
        await ctx.auditBackfill(
          backfillEvent(
            input.principal,
            viewer,
            roles,
            true,
            new Date(Date.parse(proposed.readThroughAt)),
            now,
          ),
        );
      } catch {
        return json(503, {
          error: "audit_unavailable",
          detail: "a backfill cannot be granted while it cannot be recorded",
        });
      }
    }

    let result: WatermarkWriteResult;
    try {
      result = await ctx.store.markAllReadUpTo(viewer, {
        readThroughAt: proposed.readThroughAt,
        at: proposed.updatedAt,
        source: source.source,
      });
    } catch {
      return json(503, {
        error: "read_state_unavailable",
        detail: "the watermark could not be recorded",
      });
    }
    return json(200, {
      outcome: result.outcome,
      // Reported, because a client whose position was not taken literally would otherwise believe it
      // was: `advanced` on a clamped position means something different from `advanced` on the one
      // that was asked for.
      clamped,
      requestedReadThroughAt: position.upTo.toISOString(),
      watermark: result.watermark,
    });
  };
}

export function backfillEvent(
  principal: ResolvedPrincipal | null,
  viewer: InboxViewer,
  roles: readonly string[],
  granted: boolean,
  readThrough: Date,
  now: Date,
): BackfillAuditEvent {
  return {
    tenantId: viewer.tenantId,
    userId: viewer.userId,
    principalId: principal?.principalId ?? null,
    roles,
    granted,
    readThroughAt: readThrough.toISOString(),
    at: now.toISOString(),
  };
}

export const UNREAD_DETAILS = ["count", "partition"] as const;
export type UnreadDetail = (typeof UNREAD_DETAILS)[number];

export function requestedDetail(raw: string | undefined): UnreadDetail {
  return raw === "partition" ? "partition" : "count";
}

function buildUnreadHandler(ctx: ReadStateRoutesContext): Handler {
  return async (input) => {
    const resolved = resolveViewer(ctx, input.principal);
    if (!resolved.ok || resolved.viewer === undefined) {
      return resolved.denial ?? json(403, { error: "forbidden" });
    }
    const viewer = resolved.viewer;
    const query = queryOf(input);
    const detail = requestedDetail(firstQueryValue(query["detail"]));
    // A channel narrows the count to the surface asking for it — an in-app badge should not be
    // moved by an email nobody opened in a browser. Unrecognised values are the notice source's
    // to reject, not this route's to enumerate.
    const channelRaw = firstQueryValue(query["channel"]);
    const channel = channelRaw === undefined || channelRaw.length === 0 ? undefined : channelRaw;
    const limit = ctx.unreadScanLimit ?? DEFAULT_UNREAD_SCAN_LIMIT;
    const hashes = await selfNoticeFilter(ctx, input.principal, viewer.tenantId);

    let index: ReadStateIndex;
    let notices: readonly InboxNoticeLike[];
    let truncated: boolean;
    try {
      // Both halves, because neither answers alone: the notices say what exists for this viewer and
      // the index says what they have seen. Deriving the badge from the watermark alone would lose
      // every notice marked read individually *and* lose `isUnread`'s fail-open, which shows a
      // notice whose `queuedAt` cannot be parsed rather than hiding it.
      index = await ctx.store.indexFor(viewer);
      const page = await ctx.notices.listForTenant(viewer.tenantId, {
        limit,
        ...(channel !== undefined ? { channel } : {}),
        ...(hashes !== null ? { recipientAddressSha256: hashes } : {}),
      });
      notices = page.data;
      truncated = page.nextCursor !== null;
    } catch {
      return json(503, { error: "read_state_unavailable", detail: "the unread count could not be read" });
    }

    const probes = notices.map((n) => ({ id: n.dispatchId, queuedAt: n.queuedAt }));
    const body: Record<string, unknown> = {
      viewer: { tenantId: viewer.tenantId, userId: viewer.userId },
      scope: hashes === null ? "tenant" : "self",
      channel: channel ?? null,
      unread: countUnread(probes, index),
      examined: probes.length,
      // An exact count would need a store-side anti-join; this one examined a page. Said out loud so
      // a client renders "200+" rather than a number that is quietly wrong.
      truncated,
      readThroughAt:
        index.readThroughMs === null ? null : new Date(index.readThroughMs).toISOString(),
    };
    if (detail === "partition") {
      const split = partitionByRead(probes, index);
      body["notices"] = {
        read: split.read.map((p) => p.id),
        unread: split.unread.map((p) => p.id),
      };
    }
    return json(200, body);
  };
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string"
      ? { kind: "literal", value: s }
      : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method,
    pathSegments,
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    // Neither write needs an idempotency key: `ON CONFLICT DO NOTHING` and `GREATEST` make a
    // retried request restate exactly what the first one did.
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

/**
 * The three inbox read-state routes.
 *
 * Refuses to construct a backfill grant with no auditor: the grant exists so one call can mark a
 * whole backlog read, and a privileged write that nothing can account for is the state ADR-0313
 * refused to serve. Loud at boot beats a 503 at the moment somebody uses it.
 */
export function buildReadStateRoutes(
  ctx: ReadStateRoutesContext,
): readonly ExtraGatewayRoute[] {
  if ((ctx.backfillRoles?.size ?? 0) > 0 && ctx.auditBackfill === undefined) {
    throw new Error(
      "read-state backfill roles are configured but no auditBackfill is wired; a bulk read-state write must be recordable",
    );
  }
  return [
    {
      route: route("notifications.read_state.mark", "POST", [
        "v1",
        "notifications",
        { param: "dispatchId" },
        "read",
      ]),
      handler: buildMarkReadHandler(ctx),
    },
    {
      route: route("notifications.read_state.read_through", "POST", [
        "v1",
        "notifications",
        "read-through",
      ]),
      handler: buildReadThroughHandler(ctx),
    },
    {
      route: route("notifications.read_state.unread", "GET", ["v1", "notifications", "unread"]),
      handler: buildUnreadHandler(ctx),
    },
  ];
}
