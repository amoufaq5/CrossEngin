/**
 * The two probe surfaces an orchestrator needs to tell a running process from a serving one.
 *
 * Until this module there was no `/health` and no `/readyz` anywhere in the workspace, and
 * `deploy/docker-compose.yml` declared no healthcheck on any service. That matters here more than it
 * would elsewhere, because this binary's boot is full of **deliberate refusals** — a classified pack
 * with no `COLUMN_ENCRYPTION_SECRET`, an ABAC obligation no declared policy can discharge, a view
 * whose default sort names a classified field, `envelope` on a deployment that encrypts nothing —
 * every one of which is a considered design decision and every one of which exits the process. With
 * no probe declared, Docker reports the container `started` the moment it is spawned, Caddy's
 * `reverse_proxy` is pointed at it regardless, and the public domain serves 502 while nothing in the
 * stack holds the opinion that anything is wrong. The refusals were made loud in the log and
 * invisible to the thing that decides whether to route traffic.
 *
 * ## Liveness and readiness are different questions, and the split is the whole design
 *
 * **`/health` answers "is this process up, and did its event loop turn?" and touches nothing else.**
 * A failed liveness probe gets the container **killed and restarted**. So a liveness probe that
 * checked Postgres would, during a database outage, fail on every replica at once — and the
 * orchestrator would respond by restarting all of them, repeatedly, destroying the warm capacity
 * that was about to be useful and turning a recoverable dependency outage into a total one with a
 * thundering herd of reconnecting processes on top. A process whose database is down is not a
 * process that needs restarting; restarting it does not fix the database. So liveness asks only
 * about *itself*, and it is the one surface here that issues no query, acquires no lock and awaits
 * nothing.
 *
 * **`/readyz` answers "can this process serve a request right now?" and does check its
 * dependencies.** A failed readiness probe takes the instance **out of rotation** and leaves it
 * running, which is the correct response to a dependency it cannot reach: traffic stops arriving,
 * the process keeps its connections and its caches, and the moment the dependency returns the next
 * probe puts it straight back. Readiness is therefore allowed to fail — and must fail — exactly
 * where liveness must not.
 *
 * Getting those two the wrong way round is the classic operational defect this file exists to avoid,
 * and it is invisible until the first outage.
 *
 * ## Both are unauthenticated, so the body is a closed vocabulary
 *
 * A probe holds no credential — a Docker healthcheck is a `curl` in the container and a load
 * balancer's check is an HTTP GET with nothing attached — so these two paths are matched **in front
 * of the gateway**, exactly as the bounce webhook is, and never reach an auth stage. What they
 * disclose is therefore bounded by construction rather than by a grant:
 *
 * - **No version string, no build id, no commit, no uptime.** A version identifies which published
 *   advisories apply to this process, and an uptime says how recently it restarted, which is when a
 *   boot is least defended. Neither is any use to a probe, which only ever reads the status code.
 * - **No tenant data, no tenant count, no configuration and no flag state.** Nothing here reads a
 *   manifest, a credential or a row.
 * - **No dependency error text, ever.** A `pg` failure carries the host, the database, the role and
 *   sometimes a constraint `detail`. The response carries a check's **declared name** and one of
 *   three enumerated outcomes; the real failure goes to `onNotReady`, server-side. That is why
 *   `ReadinessCheckNameSchema` constrains a name to a lowercase identifier instead of accepting
 *   prose: the name is the only caller-visible string in the body, so it may not be a sentence
 *   somebody later interpolates a connection string into.
 * - **No timing.** `durationMs` is on the report and deliberately *not* in the response body, so an
 *   anonymous caller cannot measure the database's load from outside.
 *
 * What is left — that this process exists, and that a dependency it calls `postgres` is or is not
 * answering — is what an operator reading a 503 needs, and is already implied by the product being
 * what it is.
 *
 * ## Cheap and bounded, with one mechanism rather than two
 *
 * `/readyz` is an unauthenticated endpoint that issues a database query, so the rate at which it can
 * make the database work has to be bounded by something other than the caller's manners. It is
 * bounded by **in-flight collapse**: a check's probe is held in a slot while it runs and every
 * concurrent request joins that one promise, so there is at most **one `SELECT 1` in flight per
 * check at any instant** no matter how many requests arrive. That is the whole of the answer — there
 * is deliberately no success cache beside it, because a cache introduces a window in which a 200
 * asserts a dependency is reachable on the evidence of a round trip that has already finished, and
 * a stale *ready* is the one direction that must not happen. Freshness is cheap here; staleness is
 * the thing with a cost.
 *
 * The timeout is a **race, not a cancellation**: `PgConnection` offers no way to cancel a statement,
 * so a request's budget running out ends the *request*, not the query. The slot is therefore cleared
 * when the **probe** settles and never when a budget expires — see `probeSlotFor`, where that is the
 * load-bearing line. Released at the budget instead, a wedged database would get a fresh connection
 * checked out on every probe while the previous queries still held theirs, which is one stuck
 * connection per probe: the pool exhaustion the collapse exists to prevent, caused by the surface
 * meant to report it.
 *
 * ## What it does not do
 *
 * It exports no metric. Nothing in this workspace produces one — there is no registry, no exporter
 * and no scrape format — so a `/metrics` path here would either be empty or would be the first half
 * of a subsystem invented in a probe module.
 */

import type { PgConnection } from "@crossengin/kernel-pg";
import { z } from "zod";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";

/* ------------------------------------------------------------------ the two paths */

export const HEALTH_PROBE_KINDS = ["liveness", "readiness"] as const;

export const HealthProbeKindSchema = z.enum(HEALTH_PROBE_KINDS);
export type HealthProbeKind = z.infer<typeof HealthProbeKindSchema>;

/**
 * The path each probe answers on, as a total map so a third kind cannot be added without a path.
 *
 * `/health` and `/readyz` rather than one path with a query parameter, because the two are consumed
 * by different things with different consequences — a `livenessProbe` and a `readinessProbe` in a
 * pod spec, `healthcheck:` and a load balancer's check in the compose stack — and a surface whose
 * meaning depends on a query string somebody has to remember to add would answer *liveness* when
 * they forgot it, which is the permissive direction.
 */
export const HEALTH_PATHS: Readonly<Record<HealthProbeKind, string>> = Object.freeze({
  liveness: "/health",
  readiness: "/readyz",
});

/** Strips a query string and one trailing slash, so `/readyz/?x=1` is the readiness path. */
function pathOnly(target: string): string {
  const cut = target.indexOf("?");
  const path = cut < 0 ? target : target.slice(0, cut);
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/**
 * Which probe this request target is, or `null` for anything else.
 *
 * Matched as an **exact** path and not a prefix, unlike the bounce webhook, which needs a prefix
 * because its tenant and source ride in the path. Nothing rides in a probe's path, so a prefix match
 * would hand `/readyz/../v1/vendors` and every other suffix to this module — a surface that
 * swallows requests the gateway was meant to serve, and answers 200 for them.
 */
export function healthProbeKindFor(target: string): HealthProbeKind | null {
  const path = pathOnly(target);
  for (const kind of HEALTH_PROBE_KINDS) {
    if (HEALTH_PATHS[kind] === path) return kind;
  }
  return null;
}

/** Whether this request belongs here at all, so a caller can fall through to the gateway. */
export function isHealthPath(target: string): boolean {
  return healthProbeKindFor(target) !== null;
}

/** The methods a probe may use. A probe reads a status code; it never sends a body. */
export const HEALTH_METHODS: readonly string[] = Object.freeze(["GET", "HEAD"]);

/* ------------------------------------------------------------------ outcomes */

export const READINESS_OUTCOMES = ["ready", "unreachable", "timed_out"] as const;

export const ReadinessOutcomeSchema = z.enum(READINESS_OUTCOMES);
export type ReadinessOutcome = z.infer<typeof ReadinessOutcomeSchema>;

/**
 * An outcome that takes this instance out of rotation — by subtraction, so the set cannot drift
 * from {@link READINESS_OUTCOME_SERVES}.
 */
export type NonServingOutcome = Exclude<ReadinessOutcome, "ready">;

/**
 * Which outcomes let this instance stay in rotation — a total map, so a fourth outcome is a compile
 * error here rather than a value that inherits whichever branch an `if` chain happened to end on.
 *
 * Only `ready` serves. `unreachable` and `timed_out` are different facts an operator acts on
 * differently (a refused connection versus a database that answers too slowly to serve behind), and
 * neither is a reason to keep taking traffic.
 *
 * The value type is **per member and not `boolean`**, which is what keeps this map and
 * `NonServingOutcome` from being two spellings of one judgement that can disagree: flipping
 * `unreachable` to `true` is a compile error *here* rather than a silent contradiction of the type
 * the failure report is declared with. A fourth outcome must be `false`, which is the fail-closed
 * default — making a new outcome serve means editing this type too, and that edit is where the
 * decision belongs.
 */
export const READINESS_OUTCOME_SERVES: Readonly<
  Record<"ready", true> & Record<NonServingOutcome, false>
> = Object.freeze({
  ready: true,
  unreachable: false,
  timed_out: false,
});

/**
 * Whether this outcome takes the instance out of rotation, read off the map above rather than
 * compared against `"ready"` — one judgement, one reader. A type predicate because the map's own
 * value types prove the correspondence a predicate cannot: with `ready: true` and every other
 * member `false`, `!serves` is exactly `NonServingOutcome`.
 */
function isNonServing(outcome: ReadinessOutcome): outcome is NonServingOutcome {
  return !READINESS_OUTCOME_SERVES[outcome];
}

/**
 * The outcomes a probe itself can produce.
 *
 * `timed_out` is excluded by subtraction rather than by a second list: it is produced by the
 * request's budget and never by the probe, which has not answered at all when it is reported — so
 * nothing that settles a probe may construct it, and the type says so.
 */
export type ProbeAnswer = Exclude<ReadinessOutcome, "timed_out">;

/* ------------------------------------------------------------------ checks */

/**
 * A readiness check's name, which is the one string an unauthenticated caller reads out of this
 * surface — hence a declared lowercase identifier and not free text.
 */
export const READINESS_CHECK_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const ReadinessCheckNameSchema = z.string().regex(READINESS_CHECK_NAME_RE);

export const MIN_READINESS_TIMEOUT_MS = 50;
export const MAX_READINESS_TIMEOUT_MS = 10_000;

/**
 * One second.
 *
 * A `SELECT 1` that has not come back inside a second is not a slow query, it is a saturated pool or
 * a database in trouble — which is precisely a reason to stop sending this instance traffic, so the
 * budget is set where it answers the question rather than where it avoids answering it.
 */
export const DEFAULT_READINESS_TIMEOUT_MS = 1_000;

/**
 * Range-checked and **refused rather than clamped**, following `--max-request-body`: silently
 * raising a 5 ms budget to 50 ms leaves an operator believing a figure the process is not using, and
 * a readiness budget is one of the numbers whose wrongness only shows up during an incident.
 */
export const ReadinessTimeoutMsSchema = z
  .number()
  .int()
  .min(MIN_READINESS_TIMEOUT_MS)
  .max(MAX_READINESS_TIMEOUT_MS);

/** A boot-time refusal: the surface is misconfigured, so no probe is built. */
export class HealthConfigRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthConfigRefused";
  }
}

/**
 * One dependency this process needs in order to serve.
 *
 * `probe` resolves when the dependency answered and rejects otherwise; its resolved value is
 * discarded, because a readiness check asks whether the dependency *answered* and never what it
 * said. A plain interface rather than a zod schema: it carries a function, and parsing it would
 * assert a shape the function's own type already states.
 */
export interface ReadinessCheck {
  readonly name: string;
  probe(): Promise<unknown>;
}

export const ReadinessCheckResultSchema = z.object({
  name: ReadinessCheckNameSchema,
  outcome: ReadinessOutcomeSchema,
  /**
   * How long the **probe** has been running, not how long this request waited for it.
   *
   * The two differ for a request that joined a probe already in flight, and the probe's own elapsed
   * time is the honest figure because the figure is about the dependency rather than about this
   * caller. For `timed_out` it is the time the probe has run *so far*, which may exceed the budget.
   */
  durationMs: z.number().int().nonnegative(),
});
export type ReadinessCheckResult = z.infer<typeof ReadinessCheckResultSchema>;

export const ReadinessReportSchema = z.object({
  ready: z.boolean(),
  checks: z.array(ReadinessCheckResultSchema),
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

/**
 * What a failing check is reported as, server-side.
 *
 * This is where the dependency's own failure goes, and it is the reason the response body does not
 * need it. `error` is `null` for `timed_out` and that is a fact rather than a gap: the probe has not
 * failed, it has not answered — ADR-0331's distinction between *nothing happened* and *nobody
 * looked*, in the one field an operator would otherwise read as "no error, so no problem".
 */
export interface ReadinessFailureInfo {
  readonly name: string;
  readonly outcome: NonServingOutcome;
  readonly durationMs: number;
  readonly error: unknown;
}

export interface HealthRoutesContext {
  /**
   * The dependencies this process needs, which **may be empty** and is deliberately required.
   *
   * `[]` is a signed assertion that this process needs nothing to serve — true of `--store memory`,
   * which holds its records in the heap — where an omitted field would mean nobody decided. The same
   * rule `UNREACHABLE_STORES.tables` is required-but-emptiable for, and the reason this is not
   * `checks?`: an optional list can be forgotten with the type still valid, and forgetting it here
   * makes every readiness probe answer 200 for a process whose database is gone.
   */
  readonly checks: readonly ReadinessCheck[];
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
  readonly onNotReady?: (info: ReadinessFailureInfo) => void;
}

/* ------------------------------------------------------------------ the postgres check */

export const POSTGRES_READINESS_CHECK_NAME = "postgres";

/**
 * The cheapest statement that proves a usable connection, and the reason it is this one.
 *
 * It reads **no table**, which is what makes it the right question: a probe that selected from
 * `meta.tenants` would be answered by RLS, by ownership and by a privilege grant as much as by the
 * database's health, so a correctly-serving deployment whose probe role lacks a grant would report
 * itself unready for ever. `SELECT 1` answers exactly "there is a connection and the server is
 * processing statements on it", which is the whole of what readiness needs to know.
 *
 * It is also the one statement in this app that legitimately carries **no tenant context and no
 * scope predicate**. ADR-0333 swept fourteen store classes for want of a `tenant_id` predicate, and
 * the rule behind that sweep is that a read whose answer depends on the scope must name it. This
 * read has no scope: it names no relation, so there is no row for an owner to over-see or for a
 * policy to hide, and setting a tenant context would be a second statement and a transaction in
 * front of a probe whose point is to be cheap.
 */
export const READINESS_PROBE_SQL = "SELECT 1";

/**
 * The Postgres readiness check.
 *
 * A bare `conn.query` and **not** `conn.transaction`: a transaction is a `BEGIN`, the statement and
 * a `COMMIT` on a connection held for all three, which is three round trips and a longer checkout to
 * answer a question one round trip answers. Nothing here needs atomicity — there is nothing to be
 * atomic about.
 */
export function buildPostgresReadinessCheck(conn: PgConnection): ReadinessCheck {
  return {
    name: POSTGRES_READINESS_CHECK_NAME,
    probe: () => conn.query(READINESS_PROBE_SQL),
  };
}

/* ------------------------------------------------------------------ the probe */

/** How a probe settled, with the failure kept for the log and out of the response. */
interface ProbeSettlement {
  readonly outcome: ProbeAnswer;
  readonly error: unknown;
}

/** One probe in flight: when it started, and the promise every concurrent request joins. */
interface ProbeSlot {
  readonly startedAt: number;
  /** Never rejects — `probe()`'s rejection is absorbed into `outcome: "unreachable"`. */
  readonly settled: Promise<ProbeSettlement>;
}

export type ReadinessProbe = () => Promise<ReadinessReport>;

/**
 * Builds the readiness evaluation, holding the in-flight slots that bound its cost.
 *
 * Validated here rather than per request, for `createNodeRequestListener`'s reason: a misconfigured
 * budget or a duplicate check name must fail the boot and not every probe after it.
 */
export function buildReadinessProbe(ctx: HealthRoutesContext): ReadinessProbe {
  const timeoutMs = resolveTimeoutMs(ctx.timeoutMs);
  const checks = validateChecks(ctx.checks);
  const clock = ctx.clock ?? ((): Date => new Date());
  // Keyed by name, which is why `validateChecks` refuses a duplicate: two checks sharing a slot
  // would mean one probe's answer reported under both names, with the second dependency never asked.
  const slots = new Map<string, ProbeSlot>();

  return async (): Promise<ReadinessReport> => {
    const results = await Promise.all(
      checks.map((check) => evaluateCheck(check, slots, timeoutMs, clock, ctx.onNotReady)),
    );
    return {
      // Read through the total map rather than compared against the string, so adding an outcome
      // forces a decision about whether it serves instead of defaulting to one. With no checks this
      // is vacuously true, which is correct: a process with no declared dependency is ready, and the
      // empty list is a declaration rather than a silence.
      ready: results.every((r) => READINESS_OUTCOME_SERVES[r.outcome]),
      checks: results,
    };
  };
}

function resolveTimeoutMs(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_READINESS_TIMEOUT_MS;
  const parsed = ReadinessTimeoutMsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HealthConfigRefused(
      `readiness timeout must be an integer between ${MIN_READINESS_TIMEOUT_MS.toString()} and ` +
        `${MAX_READINESS_TIMEOUT_MS.toString()} ms, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

function validateChecks(checks: readonly ReadinessCheck[]): readonly ReadinessCheck[] {
  const seen = new Set<string>();
  for (const check of checks) {
    if (!ReadinessCheckNameSchema.safeParse(check.name).success) {
      throw new HealthConfigRefused(
        `readiness check name must match ${READINESS_CHECK_NAME_RE.source}, got ` +
          `${JSON.stringify(check.name)} — the name is the only string an unauthenticated caller` +
          ` reads out of /readyz`,
      );
    }
    if (seen.has(check.name)) {
      throw new HealthConfigRefused(`duplicate readiness check name ${JSON.stringify(check.name)}`);
    }
    seen.add(check.name);
  }
  return checks;
}

/**
 * The slot for this check, starting a probe only if none is running.
 *
 * **The slot is released when the probe settles and never when a request's budget expires**, and
 * that is the line the whole cost argument rests on. A timeout here is a race and not a
 * cancellation — `PgConnection` cannot cancel a statement — so a budget that released the slot would
 * leave the previous query still holding its connection while the next probe checked out another,
 * once per probe, until the pool was gone. Holding the slot until the query really finishes means a
 * wedged database costs exactly one connection however long it stays wedged.
 */
function probeSlotFor(
  check: ReadinessCheck,
  slots: Map<string, ProbeSlot>,
  clock: () => Date,
): ProbeSlot {
  const running = slots.get(check.name);
  if (running !== undefined) return running;
  let slot: ProbeSlot | undefined;
  // Released **inside** the settle handlers rather than in a second `.then` on `settled`, which is
  // one microtask later and therefore a window in which the slot holds an answer the probe has
  // already finished giving. A request arriving in that window joins it and is served `ready` on
  // the evidence of a round trip that is already over — the stale *ready* this surface has no cache
  // precisely to avoid. The slot's lifetime is now exactly "the probe is in flight".
  const release = (): void => {
    // The identity check is defensive rather than reachable: a slot is removed only by its own
    // release, so nothing can have replaced it. It stays because the cost is a map lookup and the
    // failure it guards against — an earlier probe deleting a live successor's slot, leaving that
    // probe unjoinable and invisible to the collapse — is silent.
    if (slots.get(check.name) === slot) slots.delete(check.name);
  };
  // `.then(onFulfilled, onRejected)` rather than `await`+`catch` at the call site: the resulting
  // promise never rejects, so a probe that fails *after* a request's budget has expired — and whose
  // promise therefore has no awaiter left — cannot surface as an unhandled rejection and take the
  // process down. That is the failure mode of the surface whose job is to say the process is alive.
  const settled = probeOnce(check).then(
    (): ProbeSettlement => {
      release();
      return { outcome: "ready", error: null };
    },
    (error: unknown): ProbeSettlement => {
      release();
      return { outcome: "unreachable", error };
    },
  );
  slot = { startedAt: clock().getTime(), settled };
  slots.set(check.name, slot);
  return slot;
}

/**
 * `check.probe()`, with a **synchronous** throw turned into a rejection.
 *
 * A probe is a caller-supplied function and nothing stops it throwing before it returns a promise.
 * Unconverted, that throw escapes `probeSlotFor` and the whole readiness evaluation, so the
 * interceptor rejects and the request becomes a **500** — the surface whose job is to report that a
 * dependency is unreachable instead reporting that the request itself failed, which is not
 * retryable and does not take the instance out of rotation. Converted, it is an `unreachable` 503
 * like any other refused connection.
 */
function probeOnce(check: ReadinessCheck): Promise<unknown> {
  try {
    return check.probe();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

async function evaluateCheck(
  check: ReadinessCheck,
  slots: Map<string, ProbeSlot>,
  timeoutMs: number,
  clock: () => Date,
  onNotReady: ((info: ReadinessFailureInfo) => void) | undefined,
): Promise<ReadinessCheckResult> {
  const slot = probeSlotFor(check, slots, clock);
  const settlement = await raceBudget(slot.settled, timeoutMs);
  // Clamped because the clock is injected and wall-clock: an NTP step backwards during a probe must
  // not put a negative figure in a log line or fail the report's own schema.
  const durationMs = Math.max(0, clock().getTime() - slot.startedAt);
  const outcome: ReadinessOutcome = settlement === null ? "timed_out" : settlement.outcome;
  if (isNonServing(outcome)) {
    report(onNotReady, {
      name: check.name,
      outcome,
      durationMs,
      error: settlement === null ? null : settlement.error,
    });
  }
  return { name: check.name, outcome, durationMs };
}

/**
 * The probe's settlement, or `null` when the budget ran out first.
 *
 * `null` for the timeout rather than a sentinel settlement, so the budget cannot construct a
 * `ProbeSettlement` and claim an outcome the probe never gave.
 */
async function raceBudget(
  settled: Promise<ProbeSettlement>,
  timeoutMs: number,
): Promise<ProbeSettlement | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    // Cleared on both arms. A pending timer holds the event loop open, so a probe that answered
    // quickly would still keep the process alive for the rest of its budget — which in a test suite
    // is a hang and in a shutdown is a delay per probe served.
    if (timer !== undefined) clearTimeout(timer);
  }
}

function report(
  onNotReady: ((info: ReadinessFailureInfo) => void) | undefined,
  info: ReadinessFailureInfo,
): void {
  try {
    onNotReady?.(info);
  } catch {
    // An observer must not be able to turn a clean 503 into a 500. The instance is already out of
    // rotation; a throw here would replace a readable refusal with an unhandled error.
  }
}

/* ------------------------------------------------------------------ http */

export interface HealthHttpRequest {
  readonly method: string;
  /** The request target; a query string is ignored. */
  readonly path: string;
}

export interface HealthHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The JSON body, or null where there is none to send. */
  readonly body: Record<string, unknown> | null;
}

/**
 * `no-store`, because a cached 200 is a lie about the present.
 *
 * A readiness answer describes this instance at this instant; an intermediary or a sidecar that
 * reused one for even a few seconds would keep an unready instance in rotation on the strength of an
 * answer it has already contradicted. The same header on liveness for one reason: a cached liveness
 * 200 would make a wedged process unkillable by the orchestrator.
 */
const PROBE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json",
  "cache-control": "no-store",
});

/**
 * The readiness response body: check **names and outcomes only**.
 *
 * `durationMs` is dropped here rather than left off the report, because the figure is wanted by
 * `onNotReady` and not by an anonymous caller — a timing an unauthenticated client can poll is a
 * measurement of the database's load from outside the perimeter.
 */
export function readinessResponseBody(report_: ReadinessReport): Record<string, unknown> {
  return {
    status: report_.ready ? "ready" : "not_ready",
    checks: report_.checks.map((c) => ({ name: c.name, outcome: c.outcome })),
  };
}

/**
 * Answers one probe request, or reports that it is not ours.
 *
 * Transport-pure, like `handleBounceWebhookRequest`: it takes a parsed request plus the readiness
 * probe and returns a status and a body, so this module knows nothing about Node or the gateway.
 *
 * Liveness returns without awaiting anything at all. That is not an optimisation — it is the
 * guarantee: the fact that this function returned *is* the fact that the event loop is turning, and
 * anything awaited here would make the liveness answer depend on something other than this process.
 */
export async function handleHealthRequest(
  request: HealthHttpRequest,
  probe: ReadinessProbe,
): Promise<HealthHttpResponse> {
  const kind = healthProbeKindFor(request.path);
  if (kind === null) {
    return { status: 404, headers: PROBE_HEADERS, body: { error: "not_found" } };
  }
  const method = request.method.toUpperCase();
  if (!HEALTH_METHODS.includes(method)) {
    return {
      status: 405,
      headers: { ...PROBE_HEADERS, allow: HEALTH_METHODS.join(", ") },
      body: { error: "method_not_allowed" },
    };
  }
  if (kind === "liveness") {
    return { status: 200, headers: PROBE_HEADERS, body: { status: "ok" } };
  }
  const result = await probe();
  return {
    // 503 and not 500: unready is a statement that this instance cannot serve *now*, which is
    // retryable and is what takes it out of rotation, where a 500 claims the request itself failed.
    status: result.ready ? 200 : 503,
    headers: PROBE_HEADERS,
    body: readinessResponseBody(result),
  };
}

/**
 * Serialises a probe answer, suppressing the body for `HEAD` while keeping its `content-length`.
 *
 * Kept out of `handleHealthRequest` so there is one place the bytes exist and one place that decides
 * whether to send them: a `HEAD` whose `content-length` disagreed with the `GET` it stands for is
 * the kind of thing a health-check client reads as a transport error.
 */
export function toRawHealthResponse(
  method: string,
  response: HealthHttpResponse,
): RawHttpResponse {
  const bytes =
    response.body === null
      ? new Uint8Array(0)
      : new TextEncoder().encode(JSON.stringify(response.body));
  return {
    status: response.status,
    headers: {
      ...response.headers,
      "content-length": bytes.byteLength.toString(),
    },
    body: method.toUpperCase() === "HEAD" ? null : bytes,
  };
}

/**
 * The adapter the server wires in: a `RawHttpResponse` for a probe, or **null** when the request is
 * not ours so the caller falls through to the gateway.
 *
 * It wraps the dispatch target rather than registering as a gateway route, for the bounce webhook's
 * reason read the other way round: that route cannot be a gateway `Handler` because the gateway
 * never sees the raw body, and this one cannot be a gateway route because a probe carries **no
 * credential** and every gateway route runs the auth stage. Wrapping the dispatch target rather than
 * the Node listener keeps both paths available to the Fetch/Workers adapter, which dispatches
 * through the same target.
 *
 * One probe is built per interceptor, so the in-flight collapse is shared by every request this
 * interceptor serves. A caller wanting the report for itself — a boot line, say — should call this
 * interceptor's `buildReadinessProbe` sibling with the same context and accept that it holds its own
 * slots; two probes mean at most two concurrent `SELECT 1`s, which is the bound either way.
 */
export function buildHealthInterceptor(
  ctx: HealthRoutesContext,
): (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse | null> {
  const probe = buildReadinessProbe(ctx);
  return async (raw) => {
    if (!isHealthPath(raw.url)) return null;
    const response = await handleHealthRequest({ method: raw.method, path: raw.url }, probe);
    return toRawHealthResponse(raw.method, response);
  };
}
