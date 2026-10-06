import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import {
  CONTENT_CATEGORIES,
  NOTIFICATION_CHANNELS,
  isCategorySuppressible,
  type ContentCategory,
  type NotificationChannel,
  type UserPreferenceMatrix,
} from "@crossengin/notifications";

import {
  PREFERENCE_EXPECTATIONS,
  PreferenceRowUnreadableError,
  defaultOptedIn,
  resolveOptedIn,
  type PreferenceExpectation,
  type PreferenceSource,
  type PreferenceSubject,
  type PreferenceWriteResult,
} from "./preference-store.js";

/**
 * The routes a person needs to turn a notification category off.
 *
 * `meta.notification_preferences` has had a reader since the delivery drain was written and never a
 * writer (ADR-0334), so there has been no way — over HTTP or otherwise — to express a preference.
 * `PostgresNotificationPreferenceStore` is the writer; these are what reach it. The shape follows
 * ADR-0331's read-state routes closely, and the three rules that carry over are the ones below.
 * Where this surface differs from read state, it differs because **a preference is a consent record
 * and read state is not**.
 *
 * - **The subject is the credential.** Keyed `(tenant, user, category, channel)`, and the user half
 *   comes from `principal.principalId`. A body naming a `userId` is **refused**, not ignored: a
 *   client sending one believes it is acting for that person, and quietly writing the caller's own
 *   preference instead would have it report success for a change that did not happen. Same
 *   argument, same 400.
 * - **An admin override is a separate additive grant.** Unlike read state, where one person's
 *   backlog is the only thing a privileged write can touch, an admin preference write changes
 *   *somebody else's* consent — so `adminRoles` is its own grant on top of `allowedRoles`, and it
 *   is recorded **before** the write with a failure to record refusing it. ADR-0313's rule: an
 *   unrecordable privileged write is not served.
 * - **The self-service write IS audited, which is where this parts company with read state.**
 *   ADR-0331 reasoned that a per-notice mark needs no audit row because the row *is* the record and
 *   the reader, subject and tenant are one principal. The first half is true here and the second is
 *   not sufficient: the row holds only the *current* value, so a preference flipped off and on again
 *   leaves nothing saying it was ever off. A consent record whose history is unreconstructable is
 *   the state ADR-0302's rule exists to prevent — a safety record must never widen on an inference,
 *   and "they must have opted back in" is an inference. The asymmetry ADR-0331 relied on to refuse
 *   the audit does not hold either: an inbox badge 503ing when the audit log is down stops people
 *   being told they have mail, whereas a preference write 503ing costs one deferred click.
 *   So: recorded, and **best-effort for the self-service write** rather than refusing — the person
 *   is withdrawing consent and refusing to record it would leave them subscribed — but
 *   **refuse-if-unrecordable for the admin write**, which is the privileged one.
 *
 * ## The refusal the contract does not make
 *
 * `UserPreferenceMatrixSchema` refuses `optedIn: false` on a non-suppressible category only when
 * `source === "user_set"`. So a stored row with `source: "admin_set"` and
 * `category: "security_alert"`, `optedIn: false` parses — and `computeDispatchEligibility` then
 * answers `not_opted_in`, because the non-suppressible override in that function covers *suppression*
 * and not preference. **A security alert would be silently withheld.** That is a contract gap, left
 * for its owner (see the lane report), and closed here at the route: `optedOutOfNonSuppressible`
 * refuses an opt-out of `transactional` or `security_alert` under **every** source. Third layer for
 * one rule — the habit ADR-0313 named — and here it is the only layer that holds.
 */

export interface PreferenceStoreLike {
  put(
    subject: PreferenceSubject,
    write: {
      readonly category: ContentCategory;
      readonly channel: NotificationChannel;
      readonly optedIn: boolean;
      readonly source: PreferenceSource;
      readonly at: string;
      readonly updatedBy: string | null;
      readonly expect?: PreferenceExpectation;
    },
  ): Promise<PreferenceWriteResult>;
  clear(
    subject: PreferenceSubject,
    key: { readonly category: ContentCategory; readonly channel: NotificationChannel },
  ): Promise<boolean>;
  matrixFor(subject: PreferenceSubject): Promise<UserPreferenceMatrix>;
}

export interface PreferenceAuditEvent {
  readonly tenantId: string;
  /** The person whose consent changed — not necessarily the caller. */
  readonly subjectUserId: string;
  readonly principalId: string | null;
  readonly roles: readonly string[];
  /** True when the caller was acting on somebody else under the admin grant. */
  readonly onBehalf: boolean;
  /** False when the grant was refused; the row is still written, so a probe leaves a trail. */
  readonly granted: boolean;
  readonly category: ContentCategory;
  readonly channel: NotificationChannel;
  /** Null on a clear, which removes the row rather than setting a value. */
  readonly optedIn: boolean | null;
  readonly source: PreferenceSource | null;
  readonly outcome: string;
  readonly at: string;
}

export type PreferenceAuditor = (event: PreferenceAuditEvent) => Promise<void>;

export const PREFERENCE_SET_OPERATION = "notifications.preference_set";
export const PREFERENCE_CLEARED_OPERATION = "notifications.preference_cleared";
export const PREFERENCE_ADMIN_OPERATION = "notifications.preference_set_on_behalf";
export const PREFERENCE_DENIED_OPERATION = "notifications.preference_denied";

export interface PreferenceRoutesContext {
  readonly store: PreferenceStoreLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /**
   * Roles permitted to read and set their **own** preferences. Fail-closed: empty ⇒ nobody.
   * Managing one's own consent is not privileged, but an unconfigured grant must not read as open.
   */
  readonly allowedRoles: ReadonlySet<string>;
  /**
   * Roles permitted to set another user's preference (`?userId=` on the admin surface) and to
   * assert `source: "admin_set"`. Fail-closed: absent or empty ⇒ nobody, and the admin routes are
   * not mounted at all.
   */
  readonly adminRoles?: ReadonlySet<string>;
  readonly audit?: PreferenceAuditor;
  readonly clock?: () => Date;
}

/**
 * The sources a route caller may assert.
 *
 * `user_set` is the self-service act and `admin_set` the delegated one; those are what actually
 * happen over HTTP. The other three are refused, and each for its own reason rather than as a
 * blanket narrowing:
 *
 *  - `default_policy` is the **absence** of a preference, which this surface expresses by deleting
 *    the row. A stored row claiming it would pin the user to today's default for ever.
 *  - `import` describes a migration, which does not arrive one HTTP request at a time.
 *  - `regulatory_requirement` is the dangerous one. It is the one source under which the contract
 *    permits an opt-out of a non-suppressible category, so a client able to assert it could switch
 *    off its own security alerts under a label asserting the law required it. A regulatory block is
 *    a suppression (`regulatory_block`, which `UNCONDITIONAL_SUPPRESSION_REASONS` already handles),
 *    not a preference, and it is not a client's to declare.
 */
export const ASSERTABLE_PREFERENCE_SOURCES: readonly PreferenceSource[] = [
  "user_set",
  "admin_set",
];

/** The source whose assertion needs the admin grant. */
export const PRIVILEGED_PREFERENCE_SOURCES: readonly PreferenceSource[] = ["admin_set"];

/** Which surface a write arrived on. The two differ in who the subject is, and in nothing else. */
export type PreferenceSurface = "self" | "on_behalf";

/**
 * What `source` means when the body does not say, per surface.
 *
 * A total map rather than a conditional, so a third surface is a compile error instead of a surface
 * inheriting whichever branch the chain ended on — ADR-0334's habit.
 *
 * **Keyed on the surface and never on the grant**, which is the correction: defaulting from
 * `mayAdmin` recorded an ordinary person's own click as `admin_set` whenever that person also held
 * the administrator role, which is most administrators changing their own preferences. `source` is
 * read back and the contract branches on `user_set`, so the misattribution is not cosmetic — it is
 * an access review being told somebody's own choice was imposed on them.
 */
export const DEFAULT_PREFERENCE_SOURCE: Readonly<Record<PreferenceSurface, PreferenceSource>> = {
  self: "user_set",
  on_behalf: "admin_set",
};

/** Body keys that would name a subject. Present ⇒ 400 on the self surface. */
export const SUBJECT_BODY_KEYS = ["userId", "tenantId", "user_id", "tenant_id", "subject"] as const;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: PreferenceRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function hasAnyRole(roles: readonly string[], allowed: ReadonlySet<string> | undefined): boolean {
  if (allowed === undefined || allowed.size === 0) return false;
  return roles.some((r) => allowed.has(r));
}

export interface SubjectResolution {
  readonly ok: boolean;
  readonly subject?: PreferenceSubject;
  readonly denial?: HandlerOutput;
}

/**
 * The subject, from the credential and nothing else.
 *
 * Both refusals are 403 and not 400, for ADR-0331's reason: there is nothing in the request to fix.
 * A preference is keyed on a person, the person comes from the credential, and a credential that
 * resolves no user cannot hold one.
 *
 * A non-`user` principal is refused on the same hard ground ADR-0331 named: `principalId` is a UUID
 * for a service account too, `user_id` here is a `NOT NULL` foreign key into `meta.users`, and
 * ADR-0331 established that a bare `--api-key 'key:role:tenant'` gives *every* such key one shared
 * placeholder id. Admitting one would either violate the constraint or — if the id collided with a
 * real user — file a machine's choice as that person's consent, and two keys in one tenant would
 * share it.
 */
export function resolveSubject(
  ctx: PreferenceRoutesContext,
  principal: ResolvedPrincipal | null,
): SubjectResolution {
  if (principal === null) {
    return { ok: false, denial: json(401, { error: "authentication_required" }) };
  }
  if (!hasAnyRole(rolesOf(ctx, principal), ctx.allowedRoles)) {
    return {
      ok: false,
      denial: json(403, {
        error: "forbidden",
        detail: "notification preferences are not granted to this role",
      }),
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
        detail: "no subject resolves for this principal; a preference is per user",
      }),
    };
  }
  return { ok: true, subject: { tenantId, userId: principal.principalId } };
}

export function bodyNamesASubject(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  for (const key of SUBJECT_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) return key;
  }
  return null;
}

export type KeyDecision =
  | {
      readonly kind: "ok";
      readonly category: ContentCategory;
      readonly channel: NotificationChannel;
    }
  | { readonly kind: "invalid"; readonly detail: string };

/** The (category, channel) pair, from path segments, checked against the contract's own enums. */
export function decideKey(rawCategory: unknown, rawChannel: unknown): KeyDecision {
  if (typeof rawCategory !== "string" || !(CONTENT_CATEGORIES as readonly string[]).includes(rawCategory)) {
    return { kind: "invalid", detail: `category must be one of ${CONTENT_CATEGORIES.join(", ")}` };
  }
  if (typeof rawChannel !== "string" || !(NOTIFICATION_CHANNELS as readonly string[]).includes(rawChannel)) {
    return { kind: "invalid", detail: `channel must be one of ${NOTIFICATION_CHANNELS.join(", ")}` };
  }
  return {
    kind: "ok",
    category: rawCategory as ContentCategory,
    channel: rawChannel as NotificationChannel,
  };
}

export type SourceDecision =
  | { readonly kind: "ok"; readonly source: PreferenceSource }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "ungranted"; readonly detail: string };

/**
 * Which source this request may record under.
 *
 * Two refusals, two statuses, exactly as ADR-0331 split them: a source no caller of this surface may
 * ever assert is **400**, because the request is malformed whoever sends it and a 403 would imply
 * some role could be given it. A source that is assertable but not by this role is **403**.
 */
export function decideSource(
  raw: unknown,
  mayAdmin: boolean,
  surface: PreferenceSurface,
): SourceDecision {
  if (raw === undefined || raw === null) {
    return { kind: "ok", source: DEFAULT_PREFERENCE_SOURCE[surface] };
  }
  if (typeof raw !== "string") return { kind: "invalid", detail: "source must be a string" };
  if (!(ASSERTABLE_PREFERENCE_SOURCES as readonly string[]).includes(raw)) {
    return {
      kind: "invalid",
      detail: `source ${raw} cannot be asserted over HTTP; assertable: ${ASSERTABLE_PREFERENCE_SOURCES.join(", ")}`,
    };
  }
  const source = raw as PreferenceSource;
  if (surface === "on_behalf" && source === "user_set") {
    // The one asymmetry worth stating: an administrator may not file their own act as the subject's
    // own choice. It would launder an imposed change into consent, in the field an access review
    // reads to tell those two apart — and `user_set` is also the only source under which the
    // contract refuses an opt-out of a non-suppressible category, so permitting it here would hand
    // the admin surface a second way to look like something it is not.
    return {
      kind: "invalid",
      detail: "source user_set cannot be asserted when acting on another user",
    };
  }
  if (PRIVILEGED_PREFERENCE_SOURCES.includes(source) && !mayAdmin) {
    return { kind: "ungranted", detail: `asserting source ${source} is not granted to this role` };
  }
  return { kind: "ok", source };
}

export type ExpectationDecision =
  | { readonly kind: "ok"; readonly expect?: PreferenceExpectation }
  | { readonly kind: "invalid"; readonly detail: string };

/**
 * The precondition, required for an opt-in and optional for an opt-out.
 *
 * The asymmetry is the store's rule surfaced, and the reason is ADR-0302's: an opt-out is monotonic
 * in the safe direction, so landing it over a stale read still ends in "do not send" and needs no
 * premise. An opt-in *widens* delivery, and a write with no precondition is an inference about what
 * the stored value was — which is the inference a safety record may not widen on. A person
 * re-subscribing has a page in front of them showing the current value, so naming it costs nothing;
 * a person unsubscribing may be clicking a link in an email and has nothing to name.
 */
export function decideExpectation(raw: unknown, optedIn: boolean): ExpectationDecision {
  if (raw === undefined || raw === null) {
    if (optedIn) {
      return {
        kind: "invalid",
        detail:
          "expect is required when optedIn is true: an opt-in must name the value it replaces" +
          ` (one of ${PREFERENCE_EXPECTATIONS.join(", ")})`,
      };
    }
    return { kind: "ok" };
  }
  if (typeof raw !== "string" || !(PREFERENCE_EXPECTATIONS as readonly string[]).includes(raw)) {
    return { kind: "invalid", detail: `expect must be one of ${PREFERENCE_EXPECTATIONS.join(", ")}` };
  }
  return { kind: "ok", expect: raw as PreferenceExpectation };
}

export function decideOptedIn(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * Whether this write would switch off a category a preference may not switch off.
 *
 * The contract only refuses this for `source === "user_set"`, so `admin_set` would store it and
 * `computeDispatchEligibility` would answer `not_opted_in` for a security alert. Refused here under
 * every source — see the class comment.
 */
export function optedOutOfNonSuppressible(
  category: ContentCategory,
  optedIn: boolean,
): boolean {
  return !optedIn && !isCategorySuppressible(category);
}

/** The full matrix plus the default for every pair the subject has not stored one for. */
export function matrixResponse(matrix: UserPreferenceMatrix): Record<string, unknown> {
  const resolved: Record<string, unknown>[] = [];
  for (const category of CONTENT_CATEGORIES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const answer = resolveOptedIn(matrix, category, channel);
      resolved.push({
        category,
        channel,
        optedIn: answer.optedIn,
        // The provenance a UI needs to render "default" differently from "you chose this", and the
        // reason this route reports the whole grid rather than only the stored rows: a client that
        // saw only stored rows would have to reimplement `requiresExplicitOptIn` to fill the gaps,
        // which is the second spelling of the default this store exists not to create.
        from: answer.from,
        default: defaultOptedIn(category),
        suppressible: isCategorySuppressible(category),
      });
    }
  }
  return {
    subject: { tenantId: matrix.tenantId, userId: matrix.userId },
    updatedAt: matrix.updatedAt,
    stored: matrix.entries,
    resolved,
  };
}

async function record(
  ctx: PreferenceRoutesContext,
  event: PreferenceAuditEvent,
): Promise<boolean> {
  if (ctx.audit === undefined) return false;
  try {
    await ctx.audit(event);
    return true;
  } catch {
    return false;
  }
}

function adminSubjectFrom(
  ctx: PreferenceRoutesContext,
  principal: ResolvedPrincipal | null,
  raw: unknown,
): PreferenceSubject | HandlerOutput {
  const roles = rolesOf(ctx, principal);
  if (!hasAnyRole(roles, ctx.adminRoles)) {
    return json(403, {
      error: "forbidden",
      detail: "setting another user's preference is not granted to this role",
    });
  }
  const tenantId = principal?.tenantId ?? "";
  if (!UUID_RE.test(tenantId)) {
    return json(403, { error: "forbidden", detail: "no tenant resolves for this principal" });
  }
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    return json(400, { error: "invalid_request", detail: "userId must be a uuid" });
  }
  // The subject's tenant is the caller's, never the body's. A tenant id the caller could name would
  // be a cross-tenant write, which `scopeFilter` would refuse at the predicate — but refusing it
  // here names the field instead of surfacing as a write that mysteriously touched nothing.
  return { tenantId, userId: raw };
}

function unreadableResponse(err: unknown): HandlerOutput | null {
  if (!(err instanceof PreferenceRowUnreadableError)) return null;
  // 503 and not 500: the stored row is a finding for an operator, and the caller's own request was
  // well-formed. Named without quoting the row, because the defect is in data this response is not
  // the place to disclose.
  return json(503, {
    error: "preferences_unreadable",
    detail: `a stored preference row could not be read (${err.defect}); refusing rather than treating it as consent`,
    ...(err.category !== null ? { category: err.category } : {}),
  });
}

function buildGetHandler(ctx: PreferenceRoutesContext): Handler {
  return async (input) => {
    const resolved = resolveSubject(ctx, input.principal);
    if (!resolved.ok || resolved.subject === undefined) {
      return resolved.denial ?? json(403, { error: "forbidden" });
    }
    try {
      return json(200, matrixResponse(await ctx.store.matrixFor(resolved.subject)));
    } catch (err) {
      return (
        unreadableResponse(err) ??
        json(503, {
          error: "preferences_unavailable",
          detail: "the preferences could not be read",
        })
      );
    }
  };
}

interface WriteAttempt {
  readonly subject: PreferenceSubject;
  readonly onBehalf: boolean;
}

function buildSetHandler(ctx: PreferenceRoutesContext, onBehalf: boolean): Handler {
  return async (input) => {
    const resolved = resolveSubject(ctx, input.principal);
    if (!resolved.ok || resolved.subject === undefined) {
      return resolved.denial ?? json(403, { error: "forbidden" });
    }
    const roles = rolesOf(ctx, input.principal);
    const mayAdmin = hasAnyRole(roles, ctx.adminRoles);

    let attempt: WriteAttempt;
    if (onBehalf) {
      const target = adminSubjectFrom(ctx, input.principal, input.params["userId"]);
      if (!("tenantId" in target)) return target;
      attempt = { subject: target, onBehalf: true };
    } else {
      const named = bodyNamesASubject(input.parsedBody);
      if (named !== null) {
        return json(400, {
          error: "invalid_request",
          detail: `${named} is not accepted here; the subject is taken from the credential`,
        });
      }
      attempt = { subject: resolved.subject, onBehalf: false };
    }

    const key = decideKey(input.params["category"], input.params["channel"]);
    if (key.kind === "invalid") return json(400, { error: "invalid_request", detail: key.detail });

    const optedIn = decideOptedIn(input.parsedBody?.["optedIn"]);
    if (optedIn === null) {
      // Required rather than defaulted, ADR-0328's rule: a default is applied to silence, and
      // silence must not decide whether somebody is subscribed.
      return json(400, { error: "invalid_request", detail: "optedIn is required and must be a boolean" });
    }
    if (optedOutOfNonSuppressible(key.category, optedIn)) {
      return json(400, {
        error: "invalid_request",
        detail: `${key.category} is not suppressible; a preference cannot switch it off`,
      });
    }

    const source = decideSource(
      input.parsedBody?.["source"],
      mayAdmin,
      attempt.onBehalf ? "on_behalf" : "self",
    );
    const now = (ctx.clock ?? ((): Date => new Date()))();
    const baseEvent = {
      tenantId: attempt.subject.tenantId,
      subjectUserId: attempt.subject.userId,
      principalId: input.principal?.principalId ?? null,
      roles,
      onBehalf: attempt.onBehalf,
      category: key.category,
      channel: key.channel,
      optedIn,
      at: now.toISOString(),
    };
    if (source.kind === "invalid") {
      return json(400, { error: "invalid_request", detail: source.detail });
    }
    if (source.kind === "ungranted") {
      // A refused escalation is recorded best-effort and never turns into a 503: it is not itself
      // privileged access, and failing the request because the recorder is down would tell a prober
      // that it is. ADR-0313's rule, as ADR-0331 applied it.
      await record(ctx, {
        ...baseEvent,
        granted: false,
        source: null,
        outcome: PREFERENCE_DENIED_OPERATION,
      });
      return json(403, { error: "forbidden", detail: source.detail });
    }

    const expectation = decideExpectation(input.parsedBody?.["expect"], optedIn);
    if (expectation.kind === "invalid") {
      return json(400, { error: "invalid_request", detail: expectation.detail });
    }

    if (attempt.onBehalf) {
      if (ctx.audit === undefined) {
        return json(503, {
          error: "audit_unavailable",
          detail: "another user's consent cannot be changed while the change cannot be recorded",
        });
      }
      // Recorded BEFORE the write, and a failed record refuses it. This write changes somebody
      // else's consent; unaudited, nothing could later say who changed it or when.
      const recorded = await record(ctx, {
        ...baseEvent,
        granted: true,
        source: source.source,
        outcome: PREFERENCE_ADMIN_OPERATION,
      });
      if (!recorded) {
        return json(503, {
          error: "audit_unavailable",
          detail: "another user's consent cannot be changed while the change cannot be recorded",
        });
      }
    }

    let result: PreferenceWriteResult;
    try {
      result = await ctx.store.put(attempt.subject, {
        category: key.category,
        channel: key.channel,
        optedIn,
        source: source.source,
        at: now.toISOString(),
        // `meta.users.id`, which is the calling principal for a self write and still the *caller*
        // for an admin one: the column says who changed it, not whose it is.
        updatedBy: input.principal?.principalId ?? null,
        ...(expectation.expect !== undefined ? { expect: expectation.expect } : {}),
      });
    } catch (err) {
      return (
        unreadableResponse(err) ??
        json(503, {
          error: "preferences_unavailable",
          detail: "the preference could not be recorded",
        })
      );
    }

    if (!attempt.onBehalf) {
      // Best-effort, and after the write rather than before. A person withdrawing consent must not
      // be left subscribed because the audit log is down — the row they just wrote is the operative
      // record either way, and the audit entry is the *history* this table cannot hold.
      await record(ctx, {
        ...baseEvent,
        granted: true,
        source: source.source,
        outcome: PREFERENCE_SET_OPERATION,
      });
    }

    // 409 rather than 200, because `conflict` means the stored value is not what the caller aimed
    // at and the write did not happen. The stored entry rides along so a UI can re-render without a
    // second round trip.
    return json(result.outcome === "conflict" ? 409 : 200, {
      subject: attempt.subject,
      category: key.category,
      channel: key.channel,
      outcome: result.outcome,
      entry: result.entry,
    });
  };
}

function buildClearHandler(ctx: PreferenceRoutesContext): Handler {
  return async (input) => {
    const resolved = resolveSubject(ctx, input.principal);
    if (!resolved.ok || resolved.subject === undefined) {
      return resolved.denial ?? json(403, { error: "forbidden" });
    }
    const key = decideKey(input.params["category"], input.params["channel"]);
    if (key.kind === "invalid") return json(400, { error: "invalid_request", detail: key.detail });
    const now = (ctx.clock ?? ((): Date => new Date()))();
    let removed: boolean;
    try {
      removed = await ctx.store.clear(resolved.subject, key);
    } catch {
      return json(503, {
        error: "preferences_unavailable",
        detail: "the preference could not be cleared",
      });
    }
    await record(ctx, {
      tenantId: resolved.subject.tenantId,
      subjectUserId: resolved.subject.userId,
      principalId: input.principal?.principalId ?? null,
      roles: rolesOf(ctx, input.principal),
      onBehalf: false,
      granted: true,
      category: key.category,
      channel: key.channel,
      // Null, because a clear sets no value: it restores the default, and recording the default as
      // though it had been chosen is the same confusion the store refuses to write as a row.
      optedIn: null,
      source: null,
      outcome: PREFERENCE_CLEARED_OPERATION,
      at: now.toISOString(),
    });
    return json(200, {
      subject: resolved.subject,
      category: key.category,
      channel: key.channel,
      outcome: removed ? "cleared" : "absent",
      // What governs now that nothing is stored — the honest answer to "what did I just do".
      optedIn: defaultOptedIn(key.category),
      from: "default",
    });
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
    // No idempotency key: the natural key is `(tenant, user, category, channel)` and the write is
    // one `ON CONFLICT` statement, so a retry restates exactly what the first request did. A retried
    // *opt-in* is the one that could differ — its `expect` no longer holds after the first succeeded
    // — and that answers 409, which is the correct answer to "I retried a write that landed".
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

/**
 * The preference routes: read the grid, set one, clear one, and — under its own grant — set
 * another user's.
 *
 * Refuses to construct an admin grant with no auditor, for ADR-0331's reason in a sharper form: the
 * grant exists so one call can change somebody else's consent, and a privileged write nothing can
 * account for is the state ADR-0313 refused to serve. Loud at boot beats a 503 the first time an
 * administrator uses it.
 */
export function buildPreferenceRoutes(
  ctx: PreferenceRoutesContext,
): readonly ExtraGatewayRoute[] {
  if ((ctx.adminRoles?.size ?? 0) > 0 && ctx.audit === undefined) {
    throw new Error(
      "preference admin roles are configured but no audit is wired; changing another user's consent must be recordable",
    );
  }
  const routes: ExtraGatewayRoute[] = [
    {
      route: route("notifications.preferences.read", "GET", [
        "v1",
        "notifications",
        "preferences",
      ]),
      handler: buildGetHandler(ctx),
    },
    {
      route: route("notifications.preferences.set", "PUT", [
        "v1",
        "notifications",
        "preferences",
        { param: "category" },
        { param: "channel" },
      ]),
      handler: buildSetHandler(ctx, false),
    },
    {
      route: route("notifications.preferences.clear", "DELETE", [
        "v1",
        "notifications",
        "preferences",
        { param: "category" },
        { param: "channel" },
      ]),
      handler: buildClearHandler(ctx),
    },
  ];
  if ((ctx.adminRoles?.size ?? 0) > 0) {
    routes.push({
      route: route("notifications.preferences.set_on_behalf", "PUT", [
        "v1",
        "notifications",
        "preferences",
        "users",
        { param: "userId" },
        { param: "category" },
        { param: "channel" },
      ]),
      handler: buildSetHandler(ctx, true),
    });
  }
  return routes;
}
