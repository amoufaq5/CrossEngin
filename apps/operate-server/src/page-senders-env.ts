import {
  DEFAULT_PAGE_BACKOFF_FACTOR,
  EmailPageSender,
  DEFAULT_PAGE_JITTER_RATIO,
  DEFAULT_PAGE_RETRY_BUDGET_MS,
  JITTERED_PAGE_RETRY,
  MAX_PAGE_RETRY_BUDGET_MS,
  PageDispatcher,
  PagerDutyPageSender,
  SlackPageSender,
  SmsPageSender,
  WebhookPageSender,
  pageRetryBudgetMs,
  type PageChannelSender,
  type PageDeliveryReport,
  type PageRetryPolicy,
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
export const PAGE_SMS_ENDPOINT_VAR = "PAGE_SMS_ENDPOINT";
/**
 * SMS paging credentials, deliberately **separate** from the notification stack's `TWILIO_*`.
 *
 * The same Twilio account would work, and reusing those vars would save an operator some typing —
 * but a deployment should be able to page from a different number, or a different subaccount, than
 * the one its tenants' notifications come from, and silently borrowing credentials configured for
 * another purpose is the implicit coupling ADR-0325 refused at the transport level. A partially
 * configured set is reported, not guessed.
 */
export const PAGE_SMS_VARS = [
  "PAGE_SMS_ACCOUNT_SID",
  "PAGE_SMS_AUTH_TOKEN",
  "PAGE_SMS_API_KEY_SID",
  "PAGE_SMS_API_KEY_SECRET",
  "PAGE_SMS_FROM_NUMBER",
  "PAGE_SMS_MESSAGING_SERVICE_SID",
] as const;

/**
 * Email paging credentials, separate from `SES_*` for `PAGE_SMS_*`'s reason (ADR-0329).
 *
 * The same SES account would work and reusing `SES_REGION` / `SES_FROM_ADDRESS` would save an
 * operator some typing — but a deployment should be able to page from a different sender identity,
 * or a different AWS account, than the one its tenants' notifications come from, and silently
 * borrowing credentials configured for another purpose is the implicit coupling ADR-0325 refused at
 * the transport level. The `AWS_*` keys are *not* duplicated: a page-specific pair is accepted and
 * the notification stack's is the fallback, because unlike the sender identity an access key is a
 * credential for the whole account and a deployment that wants one set should not have to write it
 * twice.
 */
export const PAGE_EMAIL_VARS = [
  "PAGE_EMAIL_REGION",
  "PAGE_EMAIL_FROM_ADDRESS",
  "PAGE_EMAIL_ACCESS_KEY_ID",
  "PAGE_EMAIL_SECRET_ACCESS_KEY",
  "PAGE_EMAIL_SESSION_TOKEN",
] as const;
export const PAGE_EMAIL_ENDPOINT_VAR = "PAGE_EMAIL_ENDPOINT";

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

  // SMS. `SmsPageSender` refuses an incomplete credential pair or a missing/ambiguous sender
  // identity at construction, so a half-configured set surfaces here as a skip with its reason
  // rather than as a page that fails at 3am.
  if (PAGE_SMS_VARS.some((n) => value(env, n) !== null)) {
    try {
      const accountSid = value(env, "PAGE_SMS_ACCOUNT_SID");
      if (accountSid === null) throw new Error("PAGE_SMS_ACCOUNT_SID is required");
      const apiKeySid = value(env, "PAGE_SMS_API_KEY_SID");
      const apiKeySecret = value(env, "PAGE_SMS_API_KEY_SECRET");
      const authToken = value(env, "PAGE_SMS_AUTH_TOKEN");
      const fromNumber = value(env, "PAGE_SMS_FROM_NUMBER");
      const messagingServiceSid = value(env, "PAGE_SMS_MESSAGING_SERVICE_SID");
      const smsEndpoint = value(env, PAGE_SMS_ENDPOINT_VAR);
      senders["sms"] = new SmsPageSender({
        accountSid,
        ...(smsEndpoint === null ? {} : { endpoint: smsEndpoint }),
        ...(apiKeySid === null ? {} : { apiKeySid }),
        ...(apiKeySecret === null ? {} : { apiKeySecret }),
        ...(authToken === null ? {} : { authToken }),
        ...(fromNumber === null ? {} : { fromNumber }),
        ...(messagingServiceSid === null ? {} : { messagingServiceSid }),
      });
    } catch (err) {
      skipped.push(`sms (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Email. ADR-0329 closed the one kind in `PAGE_CHANNEL_KINDS` that had no transport at all: a
  // deployment whose only configured channel was email had its policy name `email_digest`, the
  // dispatcher report `unroutable`, and nobody woken. The access key falls back to the
  // notification stack's because it is an account credential rather than a sender identity; the
  // *identity* never falls back, for the reason `TWILIO_VOICE_FROM_NUMBER` does not.
  if (PAGE_EMAIL_VARS.some((n) => value(env, n) !== null)) {
    try {
      const region = value(env, "PAGE_EMAIL_REGION");
      if (region === null) throw new Error("PAGE_EMAIL_REGION is required");
      const fromAddress = value(env, "PAGE_EMAIL_FROM_ADDRESS");
      if (fromAddress === null) throw new Error("PAGE_EMAIL_FROM_ADDRESS is required");
      const accessKeyId =
        value(env, "PAGE_EMAIL_ACCESS_KEY_ID") ?? value(env, "AWS_ACCESS_KEY_ID");
      const secretAccessKey =
        value(env, "PAGE_EMAIL_SECRET_ACCESS_KEY") ?? value(env, "AWS_SECRET_ACCESS_KEY");
      if (accessKeyId === null || secretAccessKey === null) {
        throw new Error(
          "needs PAGE_EMAIL_ACCESS_KEY_ID and PAGE_EMAIL_SECRET_ACCESS_KEY," +
            " or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
        );
      }
      const sessionToken =
        value(env, "PAGE_EMAIL_SESSION_TOKEN") ?? value(env, "AWS_SESSION_TOKEN");
      const emailEndpoint = value(env, PAGE_EMAIL_ENDPOINT_VAR);
      senders["email_digest"] = new EmailPageSender({
        region,
        fromAddress,
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken === null ? {} : { sessionToken }),
        },
        ...(emailEndpoint === null ? {} : { endpoint: emailEndpoint }),
      });
    } catch (err) {
      skipped.push(`email_digest (${err instanceof Error ? err.message : String(err)})`);
    }
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
  /** Overrides for the retry budget and the delay between attempts. Used by tests. */
  overrides: {
    readonly retry?: PageRetryPolicy;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): PageDispatcher {
  return new PageDispatcher({
    senders: built.senders,
    signal,
    onReport,
    ...(overrides.sleep !== undefined ? { sleep: overrides.sleep } : {}),
    // ADR-0325 left "nothing retries a failed page" open, and it is not equally survivable across
    // the three escalators: the deletion and SLO loops re-derive their finding every tick, so a
    // dropped page is delayed, while the integrity escalator's compromise finding is one-shot — it
    // declares once, pages once, and the next pass reports `ongoing` and deliberately does not page
    // again. For that one a transport blip is the whole alarm. So retry is on by default rather
    // than opt-in, and `DEFAULT_PAGE_RETRY` explains the two numbers.
    retry: overrides.retry ?? pageRetryFromEnv(),
  });
}

/**
 * The default page retry: three calls, growing and jittered, bounded in total.
 *
 * Three because a single transient failure is the common case and a third attempt costs nothing
 * against a provider that is up. The gap starts at two seconds because the dispatcher's fan-out is
 * sequential and a page is the most latency-sensitive thing this process does — and it **grows and
 * jitters** from there (ADR-0328), because the provider a page retries against is degraded for
 * everyone, so every replica of this process used to retry at the same two offsets and arrive as a
 * spike precisely when the provider could least take it. Bounded by a total budget rather than by
 * the attempt count alone, so the worst case is a number: under 12s unjittered, 30s with a
 * provider instruction, against `sev1`'s five-minute ack target. `failed` is the only retryable
 * disposition (`page-dispatch.ts` reasons through the rest), so a provider that *refused* the page
 * is never called again.
 */
export const DEFAULT_PAGE_RETRY = JITTERED_PAGE_RETRY;
export const PAGE_RETRY_ATTEMPTS_VAR = "PAGE_RETRY_ATTEMPTS";
export const PAGE_RETRY_DELAY_MS_VAR = "PAGE_RETRY_DELAY_MS";
export const PAGE_RETRY_BUDGET_MS_VAR = "PAGE_RETRY_BUDGET_MS";

/**
 * Overrides from the environment, for a deployment whose provider is slower or flakier than ours.
 *
 * An unparseable or out-of-range value falls back to the default rather than refusing the
 * dispatcher: this is a tuning knob, and the failure mode of being strict here is a process that
 * will not boot and therefore cannot page at all. `attempts` is clamped at 1 (no retry) and 10, and
 * the delay at 60s, because the retry budget is spent in front of a human waiting to be woken.
 */
export function pageRetryFromEnv(env: NodeJS.ProcessEnv = process.env): PageRetryPolicy {
  const attempts = clampedInt(env[PAGE_RETRY_ATTEMPTS_VAR], DEFAULT_PAGE_RETRY.attempts, 1, 10);
  const delayMs = clampedInt(env[PAGE_RETRY_DELAY_MS_VAR], DEFAULT_PAGE_RETRY.delayMs, 0, 60_000);
  // The budget is what makes the two knobs above safe. `PAGE_RETRY_ATTEMPTS=10` with
  // `PAGE_RETRY_DELAY_MS=60000` are both inside the ranges this function already accepted, and
  // together they would have held a `sev1` for nine minutes — past the ack target the whole retry
  // is sized against. Overridable, and clamped by `pageRetryBudgetMs` to a ceiling the override
  // cannot cross (ADR-0328).
  const totalBudgetMs = pageRetryBudgetMs(
    clampedInt(env[PAGE_RETRY_BUDGET_MS_VAR], DEFAULT_PAGE_RETRY_BUDGET_MS, 0, MAX_PAGE_RETRY_BUDGET_MS),
  );
  return {
    attempts,
    delayMs,
    // Growth and jitter are the platform's, not a deployment's: the failure they answer is several
    // replicas of *this* process retrying one degraded provider in lockstep, which no single
    // deployment can see and so none would think to configure.
    backoffFactor: DEFAULT_PAGE_RETRY.backoffFactor ?? DEFAULT_PAGE_BACKOFF_FACTOR,
    jitterRatio: DEFAULT_PAGE_RETRY.jitterRatio ?? DEFAULT_PAGE_JITTER_RATIO,
    totalBudgetMs,
  };
}

function clampedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const truncated = Math.trunc(parsed);
  if (truncated < min || truncated > max) return fallback;
  return truncated;
}
