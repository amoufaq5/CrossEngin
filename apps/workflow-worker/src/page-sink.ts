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

export interface WebhookPageDelivererOptions {
  readonly url: string;
  /** Extra headers (e.g. an auth token) merged onto `content-type: application/json`. */
  readonly headers?: Record<string, string>;
  /** Injectable `fetch` (defaults to the global). */
  readonly fetchImpl?: FetchLike;
  /** Injectable clock for the `deliveredAt` stamp. */
  readonly now?: () => Date;
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

/**
 * A real page transport: POSTs the normalized `PagePayload` as JSON to an
 * operator-configured webhook (PagerDuty Events API / Slack incoming webhook /
 * Opsgenie / any HTTP sink). Throws on a non-2xx response or network error so the
 * caller's `onError` routes a failed page (the incident is already persisted by
 * then). Swap-in behind the `PageDeliverer` seam — no other wiring changes.
 */
export class WebhookPageDeliverer implements PageDeliverer {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(opts: WebhookPageDelivererOptions) {
    this.url = opts.url;
    this.headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.now = opts.now ?? (() => new Date());
  }

  async deliver(directive: PageDirective, context: PageContext): Promise<void> {
    const body = JSON.stringify(pagePayload(directive, context, this.now().toISOString()));
    const res = await this.fetchImpl(this.url, { method: "POST", headers: this.headers, body });
    if (!res.ok) {
      throw new Error(`page webhook POST ${this.url} failed: HTTP ${res.status.toString()} (${context.incidentId})`);
    }
  }
}
