import type { Severity } from "@crossengin/incident-response";
import type { PageDirective } from "@crossengin/observability-runtime";

/** Why a page is being delivered: the incident was just declared, or its severity rose. */
export type PageReason = "declared" | "escalated";

export interface PageContext {
  readonly incidentId: string;
  readonly severity: Severity;
  readonly reason: PageReason;
}

/**
 * Delivers a resolved `PageDirective` to on-call. The real transport (PagerDuty /
 * Opsgenie / Slack) implements this seam; `LoggingPageDeliverer` is the default a
 * deployment without a wired transport gets. The monitor produces the directives
 * (from the alert policy at the current severity); this delivers them.
 */
export interface PageDeliverer {
  deliver(directive: PageDirective, context: PageContext): void | Promise<void>;
}

/** A single human-readable line describing a page directive + its delivery reason. */
export function formatPageLine(directive: PageDirective, context: PageContext): string {
  const channels = directive.channels.map((c) => c.kind).join(", ");
  return `[workflow-worker] PAGE (${context.reason}) ${context.incidentId} ${directive.severity}/${directive.alertSeverity} → ${channels.length > 0 ? channels : "(no channels)"}`;
}

/** Default `PageDeliverer` — writes one line per directive to a sink (stdout by default). */
export class LoggingPageDeliverer implements PageDeliverer {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`)) {
    this.write = write;
  }

  deliver(directive: PageDirective, context: PageContext): void {
    this.write(formatPageLine(directive, context));
  }
}

/** Delivers every directive resolved for one incident lifecycle event, in order. */
export async function deliverPages(
  deliverer: PageDeliverer,
  directives: readonly PageDirective[],
  context: PageContext,
): Promise<void> {
  for (const directive of directives) {
    await deliverer.deliver(directive, context);
  }
}

/** The JSON body a `WebhookPageDeliverer` POSTs — a normalized, transport-neutral page. */
export interface PagePayload {
  readonly incidentId: string;
  readonly severity: Severity;
  readonly alertSeverity: PageDirective["alertSeverity"];
  readonly reason: PageReason;
  readonly channels: PageDirective["channels"];
  readonly deliveredAt: string;
}

/** Builds the webhook payload for one page directive. Pure. */
export function pagePayload(directive: PageDirective, context: PageContext, deliveredAt: string): PagePayload {
  return {
    incidentId: context.incidentId,
    severity: directive.severity,
    alertSeverity: directive.alertSeverity,
    reason: context.reason,
    channels: directive.channels,
    deliveredAt,
  };
}

/** The minimal `fetch` surface the webhook deliverer needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ readonly ok: boolean; readonly status: number }>;

/** Bounded retry config for `WebhookPageDeliverer` on transient failures (5xx / network). */
export interface WebhookRetryConfig {
  /** Total attempts including the first; 1 disables retry. Default 4. */
  readonly maxAttempts?: number;
  /** Base delay before the first retry (ms); each next doubles, with jitter. Default 200. */
  readonly baseDelayMs?: number;
  /** Cap on a single backoff delay (ms). Default 5000. */
  readonly maxDelayMs?: number;
}

/** Resolved retry config (defaults filled in). */
export interface ResolvedWebhookRetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Defaults: 4 attempts, 200ms base, 5s cap — ≈200/400/800ms backoff between attempts. */
export const DEFAULT_WEBHOOK_RETRY: ResolvedWebhookRetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 5000,
};

export interface WebhookPageDelivererOptions {
  readonly url: string;
  /** Extra headers (e.g. an auth token) merged onto `content-type: application/json`. */
  readonly headers?: Record<string, string>;
  /** Injectable `fetch` (defaults to the global). */
  readonly fetchImpl?: FetchLike;
  /** Injectable clock for the `deliveredAt` stamp. */
  readonly now?: () => Date;
  /** Bounded retry on 5xx / network errors (4xx is non-retryable). */
  readonly retry?: WebhookRetryConfig;
  /** Injectable sleeper (defaults to a real `setTimeout` promise). */
  readonly sleepMs?: (ms: number) => Promise<void>;
  /** Injectable RNG for jitter (defaults to Math.random). */
  readonly random?: () => number;
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function resolveRetryConfig(retry: WebhookRetryConfig | undefined): ResolvedWebhookRetryConfig {
  const maxAttempts = retry?.maxAttempts ?? DEFAULT_WEBHOOK_RETRY.maxAttempts;
  const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_WEBHOOK_RETRY.baseDelayMs;
  const maxDelayMs = retry?.maxDelayMs ?? DEFAULT_WEBHOOK_RETRY.maxDelayMs;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`WebhookPageDeliverer.retry.maxAttempts must be an integer >= 1 (got ${String(maxAttempts)})`);
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error(`WebhookPageDeliverer.retry.baseDelayMs must be >= 0 (got ${String(baseDelayMs)})`);
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new Error(`WebhookPageDeliverer.retry.maxDelayMs must be >= 0 (got ${String(maxDelayMs)})`);
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

/**
 * Backoff for attempt `n` (1-indexed retry — n=1 is the first retry after the
 * initial attempt failed): `baseDelayMs * 2^(n-1)`, capped at `maxDelayMs`, with
 * full jitter in `[0.5, 1.0]` so workers don't synchronize. Pure for testability.
 */
export function computeWebhookBackoffMs(
  attempt: number,
  config: ResolvedWebhookRetryConfig,
  random: () => number,
): number {
  const exp = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** (attempt - 1));
  const jitter = 0.5 + random() * 0.5;
  return Math.round(exp * jitter);
}

/** A 5xx response or a thrown network error is transient; 4xx is auth/config and won't recover. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * A real page transport: POSTs the normalized `PagePayload` as JSON to an
 * operator-configured webhook (PagerDuty Events API / Slack incoming webhook /
 * Opsgenie / any HTTP sink). On a 5xx response or a thrown network error it
 * retries with exponential backoff + jitter, up to `retry.maxAttempts` total
 * attempts; on a 4xx (auth/config — won't recover) it throws immediately. After
 * all retries are exhausted it throws so the caller's `onError` routes a failed
 * page (the incident is already persisted by then). Swap-in behind the
 * `PageDeliverer` seam — no other wiring changes.
 */
export class WebhookPageDeliverer implements PageDeliverer {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly retry: ResolvedWebhookRetryConfig;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: WebhookPageDelivererOptions) {
    this.url = opts.url;
    this.headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.now = opts.now ?? (() => new Date());
    this.retry = resolveRetryConfig(opts.retry);
    this.sleepMs = opts.sleepMs ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  async deliver(directive: PageDirective, context: PageContext): Promise<void> {
    const body = JSON.stringify(pagePayload(directive, context, this.now().toISOString()));
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        const res = await this.fetchImpl(this.url, { method: "POST", headers: this.headers, body });
        if (res.ok) return;
        if (!isRetryableStatus(res.status)) {
          throw new Error(
            `page webhook POST ${this.url} failed: HTTP ${res.status.toString()} (${context.incidentId}, non-retryable)`,
          );
        }
        lastError = new Error(
          `page webhook POST ${this.url} failed: HTTP ${res.status.toString()} (${context.incidentId})`,
        );
      } catch (err) {
        if (err instanceof Error && /non-retryable/.test(err.message)) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < this.retry.maxAttempts) {
        await this.sleepMs(computeWebhookBackoffMs(attempt, this.retry, this.random));
      }
    }
    throw new Error(
      `page webhook POST ${this.url} failed after ${this.retry.maxAttempts.toString()} attempts (${context.incidentId}): ${lastError?.message ?? "unknown"}`,
    );
  }
}
