import {
  PageDispatcher,
  PagerDutyPageSender,
  SlackPageSender,
  WebhookPageSender,
  type PageChannelSender,
  type PageDeliveryReport,
} from "@crossengin/notification-providers";

/**
 * Builds the page transports from the environment (ADR-0325).
 *
 * From the environment and not from CLI flags, for `delivery-senders-env.ts`'s reason: a bot token
 * and a signing secret are credentials, and a process's argv is readable by anyone who can run `ps`.
 *
 * The asymmetry with notification senders is deliberate. There, absent configuration is not an
 * error — a deployment that wants only in-app notices is the default. Here, a channel the alert
 * policy *names* and the environment cannot serve is a `sev1` that will not arrive, so the
 * dispatcher reports it `unroutable` and the report is logged at error. Nothing is silently skipped.
 *
 * `pagerduty_*` is always wired because it needs nothing: the Events API authenticates on the
 * `routing_key`, which the alert policy already carries as `serviceKey`. So a deployment that writes
 * a PagerDuty route into its policy pages correctly with no environment at all — which is the
 * configuration most likely to be right when it matters.
 */

export const PAGE_SLACK_TOKEN_VAR = "PAGE_SLACK_BOT_TOKEN";
export const PAGE_WEBHOOK_SECRET_VAR = "PAGE_WEBHOOK_SECRET";
/**
 * Endpoint overrides, for the reason the notification senders have them: a VPC endpoint, an egress
 * proxy, or a staging deployment that must not page the real rotation.
 */
export const PAGE_PAGERDUTY_ENDPOINT_VAR = "PAGE_PAGERDUTY_ENDPOINT";
export const PAGE_SLACK_ENDPOINT_VAR = "PAGE_SLACK_ENDPOINT";

export interface PageWiringReport {
  /** Channel kinds a page can actually be delivered on. */
  readonly kinds: readonly string[];
  /** Why a channel the operator plainly started configuring was not wired. */
  readonly skipped: readonly string[];
}

export interface BuiltPageSenders {
  readonly senders: Partial<Record<string, PageChannelSender>>;
  readonly report: PageWiringReport;
}

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function buildPageSendersFromEnv(env: NodeJS.ProcessEnv = process.env): BuiltPageSenders {
  const senders: Partial<Record<string, PageChannelSender>> = {};
  const skipped: string[] = [];

  // Needs nothing: the routing key is in the policy.
  const pdEndpoint = value(env, PAGE_PAGERDUTY_ENDPOINT_VAR);
  const pagerduty = new PagerDutyPageSender(
    pdEndpoint === null ? {} : { endpoint: pdEndpoint },
  );
  senders["pagerduty_phone"] = pagerduty;
  senders["pagerduty_business_hours"] = pagerduty;

  const slackToken = value(env, PAGE_SLACK_TOKEN_VAR);
  if (slackToken !== null) {
    const slackEndpoint = value(env, PAGE_SLACK_ENDPOINT_VAR);
    senders["slack"] = new SlackPageSender({
      botToken: slackToken,
      ...(slackEndpoint === null ? {} : { endpoint: slackEndpoint }),
    });
  }

  const webhookSecret = value(env, PAGE_WEBHOOK_SECRET_VAR);
  try {
    senders["webhook"] = new WebhookPageSender(
      webhookSecret === null ? {} : { signingSecret: webhookSecret },
    );
  } catch (err) {
    // A secret too short to sign with. The webhook transport is left unwired rather than wired
    // unsigned: a receiver that expects a signature would reject every page anyway, and silently
    // dropping to unsigned is a downgrade nobody asked for.
    skipped.push(
      `webhook (${PAGE_WEBHOOK_SECRET_VAR}: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  return { senders, report: { kinds: Object.keys(senders).sort(), skipped } };
}

/**
 * One dispatcher per signal, so the label in the page names what fired (ADR-0325).
 *
 * The report goes to `onReport` already formatted, and an **undelivered** one is the caller's cue to
 * log at error: the incident is declared and durable, but nobody has been told about it.
 */
export function buildPageDispatcher(
  signal: string,
  built: BuiltPageSenders,
  onReport: (report: PageDeliveryReport) => void,
): PageDispatcher {
  return new PageDispatcher({ senders: built.senders, signal, onReport });
}
