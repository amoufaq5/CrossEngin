import {
  BOUNCE_WEBHOOK_SOURCES,
  handleBounceWebhook,
  type BounceWebhookRefusal,
  type BounceWebhookSource,
} from "@crossengin/notification-providers";
import type { SuppressionRecord } from "@crossengin/notifications";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import {
  SuppressionWriteConflictError,
  type SuppressionWriteBatch,
} from "./suppression-store.js";

/**
 * The public end of ADR-0274's suppression loop: a provider POSTs a bounce, `handleBounceWebhook`
 * verifies and plans, and this module persists the plan.
 *
 * This route is **unauthenticated and attacker-reachable**. A provider holds no API key and resolves
 * to no principal, so there is no tenant session to trust: HMAC verification *is* the authorisation,
 * and it is the only thing standing between an anonymous POST and a write that stops a tenant's mail
 * reaching an address. Three rules follow, and all three are load-bearing.
 *
 *   1. **Nothing is written before the signature verifies.** The planner is called first and the
 *      store only ever sees `result.suppressions`; every refusal path returns a 4xx having issued no
 *      SQL at all.
 *   2. **The tenant id in the URL is untrusted input until the signature checks out.** It has to be
 *      read early, because it selects which secret to verify against — but that is *all* it is used
 *      for before verification. It is never used to read a tenant's data, and the planned records'
 *      own `tenantId` (which the store re-checks against the write context) is what scopes the write.
 *   3. **Neither the body nor any address is ever logged above debug, or returned.** A bounce payload
 *      names a recipient, which is pii under the repo's classification rules; the observer hooks here
 *      carry a refusal code, a source and a tenant id, and nothing else. That extends to error
 *      messages: a Postgres unique-violation `detail` contains the address, which is why the store
 *      converts one into a `SuppressionWriteConflictError` and why no `err.message` is echoed here.
 */

export const BOUNCE_WEBHOOK_PATH_PREFIX = "/v1/notifications/bounces";

/** Lowercased, because `RawHttpRequest` headers arrive lowercased from Node. */
export const DEFAULT_BOUNCE_SIGNATURE_HEADER = "crossengin-signature";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const SOURCE_SET: ReadonlySet<string> = new Set(BOUNCE_WEBHOOK_SOURCES);

/**
 * Refusals that must not be told apart by the caller.
 *
 * A bad signature, a signature replayed outside the tolerance window, a missing header and a tenant
 * with no configured secret all answer `401 unauthorized` with no detail. Distinguishing the last one
 * would turn this route into a tenant-existence oracle for anyone who can POST to it; an operator
 * debugging a misconfiguration reads the real reason from `onRefusal`, server-side.
 */
const OPAQUE_REFUSALS: ReadonlySet<BounceWebhookRefusal> = new Set<BounceWebhookRefusal>([
  "signature_malformed",
  "signature_invalid",
  "timestamp_outside_tolerance",
]);

/** Refusals that mean "we cannot read this as a provider event at all". */
const MALFORMED_REFUSALS: ReadonlySet<BounceWebhookRefusal> = new Set<BounceWebhookRefusal>([
  "body_unparseable",
  "payload_unrecognized",
]);

export interface BounceWebhookTarget {
  readonly tenantId: string;
  readonly source: BounceWebhookSource;
}

/**
 * The suppression write this route needs — structural, so the route layer does not depend on the
 * Postgres store (and a test can hand it a recorder).
 */
export interface SuppressionWriterLike {
  writeAll(
    tenantId: string,
    records: readonly SuppressionRecord[],
  ): Promise<SuppressionWriteBatch>;
}

/**
 * Resolves the HMAC secret for one tenant, or null when that tenant has none configured.
 *
 * Per-tenant, not global, and that is the whole point: with a single shared secret, anyone able to
 * sign one tenant's bounces could suppress any address for *every* tenant simply by changing the
 * tenant id in the URL — the signature would still verify, because it would be the same key. A
 * per-tenant secret makes the signature prove which tenant's bounces the sender is authorised to
 * report. Returning null fails closed: no secret, no verification, no write.
 */
export type BounceWebhookSecretResolver = (
  tenantId: string,
) => Uint8Array | null | Promise<Uint8Array | null>;

export interface BounceWebhookRefusalInfo {
  readonly status: number;
  /** A short code, never a message that could carry payload text. */
  readonly reason: string;
  readonly source: BounceWebhookSource | null;
  readonly tenantId: string | null;
}

export interface BounceWebhookRecordedInfo {
  readonly source: BounceWebhookSource;
  readonly tenantId: string;
  readonly channel: string;
  readonly inserted: number;
  readonly duplicates: number;
}

export interface BounceWebhookRoutesContext {
  readonly store: SuppressionWriterLike;
  readonly secretForTenant: BounceWebhookSecretResolver;
  readonly clock?: () => Date;
  readonly toleranceSeconds?: number;
  readonly transientSuppressionHours?: number;
  readonly signatureHeaderName?: string;
  readonly onRefusal?: (info: BounceWebhookRefusalInfo) => void;
  readonly onRecorded?: (info: BounceWebhookRecordedInfo) => void;
  readonly onError?: (err: unknown, target: BounceWebhookTarget) => void;
}

export interface BounceWebhookHttpRequest {
  readonly method: string;
  /** The request target; a query string is ignored. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /**
   * The body exactly as received. The signature covers these bytes, so this must be the raw body and
   * not a re-serialization of a parsed one — `JSON.stringify(parse(body))` is not byte-identical, and
   * a Twilio status callback is form-encoded and would not survive a JSON round-trip at all.
   */
  readonly rawBody: string;
}

export interface BounceWebhookHttpResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
}

function headerValue(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | null {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct === undefined) return null;
  if (typeof direct === "string") return direct;
  return direct[0] ?? null;
}

function pathOnly(target: string): string {
  const cut = target.indexOf("?");
  const path = cut < 0 ? target : target.slice(0, cut);
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/** Whether this request belongs to this module at all, so a caller can fall through to the gateway. */
export function isBounceWebhookPath(target: string): boolean {
  const path = pathOnly(target);
  return path === BOUNCE_WEBHOOK_PATH_PREFIX || path.startsWith(`${BOUNCE_WEBHOOK_PATH_PREFIX}/`);
}

/**
 * `/v1/notifications/bounces/{tenantId}/{source}`.
 *
 * The tenant rides in the path because no provider payload names it: SES reports its own account and
 * Twilio its own account SID, neither of which is a CrossEngin tenant. The edge that re-signs the
 * body (an SNS-subscribed Lambda, or the proxy fronting Twilio) chooses the URL, so it is the
 * component that knows which tenant the mailbox belongs to.
 */
export function parseBounceWebhookTarget(target: string): BounceWebhookTarget | null {
  const path = pathOnly(target);
  if (!isBounceWebhookPath(path)) return null;
  const rest = path.slice(BOUNCE_WEBHOOK_PATH_PREFIX.length).replace(/^\//, "");
  if (rest.length === 0) return null;
  const segments = rest.split("/");
  if (segments.length !== 2) return null;
  const [tenantId, source] = segments;
  if (tenantId === undefined || source === undefined) return null;
  if (!UUID_RE.test(tenantId)) return null;
  if (!SOURCE_SET.has(source)) return null;
  return { tenantId, source: source as BounceWebhookSource };
}

function statusForRefusal(refusal: BounceWebhookRefusal): number {
  if (OPAQUE_REFUSALS.has(refusal)) return 401;
  if (MALFORMED_REFUSALS.has(refusal)) return 400;
  // Verified, but it describes nothing to suppress — a `Delivery` event, a `delivered` status
  // callback, an error code this platform will not act on. 422 rather than 200, because a 2xx from
  // this route means "recorded" and nothing was.
  return 422;
}

function notify(ctx: BounceWebhookRoutesContext, info: BounceWebhookRefusalInfo): void {
  try {
    ctx.onRefusal?.(info);
  } catch {
    // An observer must not be able to turn a clean refusal into a 500.
  }
}

function unauthorized(
  ctx: BounceWebhookRoutesContext,
  reason: string,
  target: BounceWebhookTarget | null,
): BounceWebhookHttpResponse {
  notify(ctx, {
    status: 401,
    reason,
    source: target?.source ?? null,
    tenantId: target?.tenantId ?? null,
  });
  return { status: 401, body: { error: "unauthorized" } };
}

/**
 * Accepts one provider bounce POST and persists exactly what the webhook planned.
 *
 * Transport-pure: it takes a parsed request plus its collaborators and returns a status and a body,
 * so the listener can register it without this module knowing anything about Node or the gateway.
 *
 * A 200 from here means **verified and recorded** — the signature checked out against this tenant's
 * secret and the planned suppressions are in the table. It does not mean the platform agrees with
 * the provider's verdict, and it is not an endorsement of the address being dead; it is a receipt.
 * It is a 200 rather than anything else because every provider in scope retries a non-2xx
 * indefinitely, and a verified, recorded bounce must not be redelivered forever.
 */
export async function handleBounceWebhookRequest(
  request: BounceWebhookHttpRequest,
  ctx: BounceWebhookRoutesContext,
): Promise<BounceWebhookHttpResponse> {
  if (!isBounceWebhookPath(request.path)) {
    return { status: 404, body: { error: "not_found" } };
  }
  if (request.method.toUpperCase() !== "POST") {
    return {
      status: 405,
      body: { error: "method_not_allowed" },
      headers: { allow: "POST" },
    };
  }
  const target = parseBounceWebhookTarget(request.path);
  if (target === null) {
    notify(ctx, { status: 404, reason: "unknown_target", source: null, tenantId: null });
    return {
      status: 404,
      body: {
        error: "not_found",
        detail: `expected ${BOUNCE_WEBHOOK_PATH_PREFIX}/{tenantId}/{source}`,
      },
    };
  }

  const headerName = (ctx.signatureHeaderName ?? DEFAULT_BOUNCE_SIGNATURE_HEADER).toLowerCase();
  const signatureHeader = headerValue(request.headers, headerName);
  if (signatureHeader === null) {
    return unauthorized(ctx, "signature_header_missing", target);
  }

  // Resolved before verification because it is the key verification needs — and used for nothing
  // else. An unknown tenant is refused with the same opaque 401 a forged signature gets.
  const secretBytes = await ctx.secretForTenant(target.tenantId);
  if (secretBytes === null) {
    return unauthorized(ctx, "secret_unresolved", target);
  }

  const now = (ctx.clock ?? ((): Date => new Date()))();
  const planned = handleBounceWebhook(
    {
      source: target.source,
      tenantId: target.tenantId,
      body: request.rawBody,
      signatureHeader,
      now,
    },
    {
      secretBytes,
      ...(ctx.toleranceSeconds === undefined ? {} : { toleranceSeconds: ctx.toleranceSeconds }),
      ...(ctx.transientSuppressionHours === undefined
        ? {}
        : { transientSuppressionHours: ctx.transientSuppressionHours }),
    },
  );

  if (!planned.accepted) {
    const status = statusForRefusal(planned.refusal);
    if (status === 401) return unauthorized(ctx, planned.refusal, target);
    notify(ctx, {
      status,
      reason: planned.refusal,
      source: target.source,
      tenantId: target.tenantId,
    });
    // `planned.reason` is the planner's own prose about shape — it names no address, by construction
    // of that module — so it is safe to return and genuinely useful to whoever wired the edge up.
    return { status, body: { error: planned.refusal, detail: planned.reason } };
  }

  let batch: SuppressionWriteBatch;
  try {
    batch = await ctx.store.writeAll(target.tenantId, planned.suppressions);
  } catch (err) {
    try {
      ctx.onError?.(err, target);
    } catch {
      // As with `notify`: an observer cannot change the outcome.
    }
    // Both of these are a 5xx on purpose, so the provider retries: the write is idempotent, so a
    // retry either records what this attempt failed to or reports it as already present. No
    // `err.message` reaches the response — a Postgres constraint error carries the address.
    if (err instanceof SuppressionWriteConflictError) {
      return { status: 503, body: { error: "suppression_write_conflict" } };
    }
    return { status: 500, body: { error: "suppression_write_failed" } };
  }

  const duplicates = batch.alreadyPresent + batch.addressAlreadySuppressed;
  try {
    ctx.onRecorded?.({
      source: target.source,
      tenantId: target.tenantId,
      channel: planned.event.channel,
      inserted: batch.inserted,
      duplicates,
    });
  } catch {
    // Recording happened; an observer throwing must not turn it into a failure the provider retries.
  }

  return {
    status: 200,
    body: {
      ok: true,
      source: planned.event.source,
      channel: planned.event.channel,
      kind: planned.event.kind,
      recorded: batch.inserted,
      duplicates,
      // Ids only. A suppression's address is the one field that must not travel back out, and the id
      // is a digest of it, not the thing itself.
      suppressions: batch.results.map((r) => ({
        suppressionId: r.suppressionId,
        outcome: r.outcome,
      })),
    },
  };
}

/**
 * Adapter for the Node listener: returns a `RawHttpResponse` for a bounce POST, or **null** when the
 * request is not ours so the caller falls through to the gateway.
 *
 * It sits in front of the gateway rather than inside it because a gateway `Handler` cannot see the
 * raw body — `HandlerInput` carries `parsedBody`, and `IncomingRequest` carries only `bodyBytes` (a
 * count) and `bodySha256`. An HMAC over the received bytes cannot be checked against a
 * re-serialization of a parsed object, and a form-encoded Twilio callback has no parsed form at all.
 */
export function buildBounceWebhookInterceptor(
  ctx: BounceWebhookRoutesContext,
): (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse | null> {
  return async (raw, body) => {
    if (!isBounceWebhookPath(raw.url)) return null;
    const response = await handleBounceWebhookRequest(
      {
        method: raw.method,
        path: raw.url,
        headers: raw.headers,
        rawBody: body === null ? "" : new TextDecoder().decode(body),
      },
      ctx,
    );
    const bytes = new TextEncoder().encode(JSON.stringify(response.body));
    return {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "content-length": bytes.byteLength.toString(),
        ...(response.headers ?? {}),
      },
      body: bytes,
    };
  };
}
