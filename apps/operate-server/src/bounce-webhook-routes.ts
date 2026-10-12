import {
  BOUNCE_WEBHOOK_SOURCES,
  handleBounceWebhook,
  planFaxSuppression,
  windowMsOf,
  type BounceWebhookRefusal,
  type BounceWebhookSource,
  type FaxObservationDisposition,
  type VoiceReachabilityObservation,
  type VoiceReachabilitySignal,
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

/**
 * The counter a voice reachability observation is applied to (ADR-0310's open `fax` verdict).
 *
 * Structural, like `SuppressionWriterLike`, so this module does not depend on the Postgres store and
 * a test can hand it a recorder. The contract is the whole of what the route needs: count a fax
 * verdict and report where the run stands, stamp a crossing, and delete a run outright when
 * something answered that can hear speech.
 */
export interface FaxObservationCounterLike {
  observe(
    tenantId: string,
    observation: VoiceReachabilityObservation,
    at: Date,
    windowHours: number,
  ): Promise<{
    readonly consecutiveCount: number;
    readonly disposition: FaxObservationDisposition;
    readonly suppressedAt: string | null;
  }>;
  markSuppressed(tenantId: string, address: string, at: Date): Promise<void>;
  clearRun(tenantId: string, address: string): Promise<boolean>;
}

export interface BounceWebhookObservedInfo {
  readonly tenantId: string;
  readonly signal: VoiceReachabilitySignal;
  readonly disposition: FaxObservationDisposition | "cleared" | "no_run";
  readonly consecutiveCount: number;
  /** True when this observation is the one that crossed the threshold. */
  readonly suppressionPlanned: boolean;
}

export interface BounceWebhookRoutesContext {
  readonly store: SuppressionWriterLike;
  readonly secretForTenant: BounceWebhookSecretResolver;
  readonly clock?: () => Date;
  readonly toleranceSeconds?: number;
  readonly transientSuppressionHours?: number;
  readonly signatureHeaderName?: string;
  /**
   * Where a voice reachability observation is counted. Omitted ⇒ nothing counts, and a `fax` verdict
   * is the refusal it has always been — so this is additive for every deployment that does not
   * configure it.
   */
  readonly faxObservations?: FaxObservationCounterLike;
  /**
   * Consecutive `fax` verdicts before a suppression is planned. Omitted ⇒ **never**: the run is
   * counted and reported and nothing is written. Opt-in because this is the one suppression in the
   * stack derived from a detector's inference rather than from a provider's own verdict, which is
   * `transientSuppressionHours`' precedent one source over. `planFaxSuppression` refuses a threshold
   * below `MIN_FAX_SUPPRESSION_THRESHOLD` rather than clamping it.
   */
  readonly faxSuppressAfter?: number;
  readonly faxObservationWindowHours?: number;
  readonly onRefusal?: (info: BounceWebhookRefusalInfo) => void;
  readonly onRecorded?: (info: BounceWebhookRecordedInfo) => void;
  readonly onObserved?: (info: BounceWebhookObservedInfo) => void;
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

/** An error an observer must not be able to turn into a different outcome. */
function report(
  ctx: BounceWebhookRoutesContext,
  err: unknown,
  target: BounceWebhookTarget,
): void {
  try {
    ctx.onError?.(err, target);
  } catch {
    // As with `notify`: an observer cannot change the outcome.
  }
}

/** What applying one voice reachability observation did. */
interface ObservationApplication {
  readonly observation: VoiceReachabilityObservation;
  readonly disposition: FaxObservationDisposition | "cleared" | "no_run";
  readonly consecutiveCount: number;
  /** The record a crossed threshold justifies, or null — which is the normal answer. */
  readonly suppression: SuppressionRecord | null;
}

/**
 * Counts a `fax_detected`, or clears the run on a `voice_answered`, and plans only if a threshold
 * was crossed.
 *
 * The two signals are not two shapes of one write and the asymmetry is the decision. A fax verdict
 * *accumulates* — one is never enough, because `AnsweredBy` is a detector's guess — while a single
 * answered call *refutes* the inference outright and deletes the run. Evidence for a block is
 * required to be consistent and repeated; evidence against one is believed immediately. That is
 * ADR-0302's rule about which direction a safety record may move on an inference, applied to the
 * input of the record rather than to the record.
 */
async function applyObservation(
  ctx: BounceWebhookRoutesContext,
  tenantId: string,
  observation: VoiceReachabilityObservation,
  now: Date,
): Promise<ObservationApplication> {
  const counter = ctx.faxObservations;
  if (counter === undefined) throw new Error("applyObservation called with no counter");
  if (observation.signal === "voice_answered") {
    const had = await counter.clearRun(tenantId, observation.address);
    return {
      observation,
      disposition: had ? "cleared" : "no_run",
      consecutiveCount: 0,
      suppression: null,
    };
  }
  const windowHours = windowMsOf(ctx.faxObservationWindowHours) / 3_600_000;
  const run = await counter.observe(tenantId, observation, now, windowHours);
  const suppression = planFaxSuppression({
    tenantId,
    observation,
    consecutiveCount: run.consecutiveCount,
    policy: {
      consecutiveThreshold: ctx.faxSuppressAfter ?? null,
      windowHours,
    },
    observedAt: now,
  });
  return {
    observation,
    disposition: run.disposition,
    consecutiveCount: run.consecutiveCount,
    suppression,
  };
}

/**
 * The observation as it travels back out.
 *
 * No address and no `CallSid`. The address is a telephone number, which is pii under this repo's
 * classification rules and is the one field the rest of this module is careful never to return; the
 * `CallSid` is the caller's own and they already have it. What is useful to whoever wired the edge
 * up is the arithmetic: which signal, what it did to the run, how long the run is, and whether a
 * threshold was crossed.
 */
function observationBody(
  applied: ObservationApplication,
  suppressed: boolean,
): Record<string, unknown> {
  return {
    signal: applied.observation.signal,
    disposition: applied.disposition,
    consecutive: applied.consecutiveCount,
    suppressed,
  };
}

function announce(
  ctx: BounceWebhookRoutesContext,
  tenantId: string,
  applied: ObservationApplication,
  suppressed: boolean,
): void {
  try {
    ctx.onObserved?.({
      tenantId,
      signal: applied.observation.signal,
      disposition: applied.disposition,
      consecutiveCount: applied.consecutiveCount,
      suppressionPlanned: suppressed,
    });
  } catch {
    // An observer must not be able to turn a recorded observation into a failure.
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

  /*
   * The observation path, which runs *before* anything is written and only ever on a refusal.
   *
   * The ordering matters: a verdict that crosses a threshold has to be counted before the
   * suppression it justifies can be planned, and the count is the only thing that makes the plan
   * legitimate. An observation that cannot be stored therefore refuses the request rather than
   * falling back to "no suppression": a run whose length is unknown is not a run.
   */
  if (!planned.accepted) {
    const status = statusForRefusal(planned.refusal);
    if (status === 401) return unauthorized(ctx, planned.refusal, target);
    if (planned.observation === undefined || ctx.faxObservations === undefined) {
      notify(ctx, {
        status,
        reason: planned.refusal,
        source: target.source,
        tenantId: target.tenantId,
      });
      // `planned.reason` is the planner's own prose about shape — it names no address, by
      // construction of that module — so it is safe to return and genuinely useful to whoever wired
      // the edge up.
      return { status, body: { error: planned.refusal, detail: planned.reason } };
    }
    let observed: ObservationApplication;
    try {
      observed = await applyObservation(ctx, target.tenantId, planned.observation, now);
    } catch (err) {
      report(ctx, err, target);
      // A 5xx so the provider retries, which is safe *because* the counter's dedup key is the
      // `CallSid`: a retried callback is recognised as the same call and does not advance the run.
      // Answering the refusal's 422 instead would drop the evidence in silence, which is the
      // failure this path exists to end.
      return { status: 503, body: { error: "fax_observation_write_failed" } };
    }
    const channel = observed.observation.channel;
    if (observed.suppression === null) {
      // Counted, nothing planned: the overwhelmingly common case, and the whole of what an answered
      // call or a short run does.
      announce(ctx, target.tenantId, observed, false);
      return {
        // 200 and not the refusal's 422, because something **was** durably recorded. A 2xx from
        // this route means "verified and recorded"; it was 422 only while nothing here recorded
        // anything, and every provider in scope retries a non-2xx indefinitely — so a 422 would
        // have Twilio redeliver every answered call forever.
        status: 200,
        body: {
          ok: true,
          source: target.source,
          channel,
          recorded: 0,
          duplicates: 0,
          suppressions: [],
          observation: observationBody(observed, false),
        },
      };
    }
    // The threshold was crossed. One planned record, through the same idempotent store a
    // provider-reported bounce goes through — so re-crossing on a longer run presents the identical
    // row and `applied_at` does not move.
    const written = await writeSuppressions(ctx, target, [observed.suppression]);
    if (!written.ok) return written.response;
    /*
     * Stamped **after** the suppression lands, and never before it.
     *
     * `suppressed_at` is the observation row's claim that this run produced a block, and a claim
     * made before the write would survive a failed one — leaving a row saying an address was
     * suppressed when it was not, which is the shape ADR-0317 refused for a deletion proof. A stamp
     * that fails *after* a successful write is the harmless direction: the run keeps counting, the
     * next verdict re-plans the identical row, and the store declines it.
     */
    try {
      await ctx.faxObservations.markSuppressed(target.tenantId, observed.observation.address, now);
    } catch (err) {
      report(ctx, err, target);
    }
    announce(ctx, target.tenantId, observed, true);
    recorded(ctx, target, channel, written.batch);
    return {
      status: 200,
      body: {
        ...responseBody(target.source, channel, "voice_fax_threshold", written.batch),
        observation: observationBody(observed, true),
      },
    };
  }

  const written = await writeSuppressions(ctx, target, planned.suppressions);
  if (!written.ok) return written.response;
  recorded(ctx, target, planned.event.channel, written.batch);
  return {
    status: 200,
    body: responseBody(
      planned.event.source,
      planned.event.channel,
      planned.event.kind,
      written.batch,
    ),
  };
}

type SuppressionWriteOutcome =
  | { readonly ok: true; readonly batch: SuppressionWriteBatch }
  | { readonly ok: false; readonly response: BounceWebhookHttpResponse };

/**
 * The one write path, shared by a provider-reported bounce and a crossed fax threshold.
 *
 * Shared rather than duplicated because the error mapping is the load-bearing part: both failures
 * are a 5xx **on purpose**, so the provider retries — the write is idempotent, so a retry either
 * records what this attempt failed to or reports it as already present. No `err.message` reaches the
 * response; a Postgres constraint error carries the address.
 */
async function writeSuppressions(
  ctx: BounceWebhookRoutesContext,
  target: BounceWebhookTarget,
  records: readonly SuppressionRecord[],
): Promise<SuppressionWriteOutcome> {
  try {
    return { ok: true, batch: await ctx.store.writeAll(target.tenantId, records) };
  } catch (err) {
    report(ctx, err, target);
    if (err instanceof SuppressionWriteConflictError) {
      return { ok: false, response: { status: 503, body: { error: "suppression_write_conflict" } } };
    }
    return { ok: false, response: { status: 500, body: { error: "suppression_write_failed" } } };
  }
}

function recorded(
  ctx: BounceWebhookRoutesContext,
  target: BounceWebhookTarget,
  channel: string,
  batch: SuppressionWriteBatch,
): void {
  try {
    ctx.onRecorded?.({
      source: target.source,
      tenantId: target.tenantId,
      channel,
      inserted: batch.inserted,
      duplicates: batch.alreadyPresent + batch.addressAlreadySuppressed,
    });
  } catch {
    // Recording happened; an observer throwing must not turn it into a failure the provider retries.
  }
}

function responseBody(
  source: BounceWebhookSource,
  channel: string,
  kind: string,
  batch: SuppressionWriteBatch,
): Record<string, unknown> {
  return {
    ok: true,
    source,
    channel,
    kind,
    recorded: batch.inserted,
    duplicates: batch.alreadyPresent + batch.addressAlreadySuppressed,
    // Ids only. A suppression's address is the one field that must not travel back out, and the id
    // is a digest of it, not the thing itself.
    suppressions: batch.results.map((r) => ({
      suppressionId: r.suppressionId,
      outcome: r.outcome,
    })),
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
