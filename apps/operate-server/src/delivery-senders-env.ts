import { SesEmailSender, TwilioSmsSender } from "@crossengin/notification-providers";

import { InAppSender, SenderRegistry, type ChannelSender } from "./delivery-senders.js";

/**
 * Builds the channel senders from the environment.
 *
 * From the environment and not from CLI flags, because every one of these values but the sender
 * identity is a credential, and a process's argv is readable by anyone who can run `ps`. The AI
 * providers already resolve this way (`buildDesignProviderFromEnv`); `--stripe-api-key` does not,
 * which is a weakness this does not copy.
 *
 * Absent configuration is not an error. A deployment that wants only in-app notices is the default,
 * and `in_app` is always registered — so the registry never comes back empty and a delivery for an
 * unconfigured channel is refused by `UnroutableChannelSender` with `no_sender_configured`, which
 * the drain already treats as retryable so that configuring the channel and re-draining delivers.
 */
export interface SenderWiringReport {
  readonly channels: readonly string[];
  /** Why a channel the operator plainly meant to configure was not registered. */
  readonly skipped: readonly string[];
}

export interface BuiltSenderRegistry {
  readonly registry: SenderRegistry;
  readonly report: SenderWiringReport;
}

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * True when the operator has clearly started configuring a channel. Used to tell "not wanted" from
 * "wanted but incomplete" — the second deserves a warning, because silently sending nothing is how a
 * notification stack looks healthy while reaching no one.
 */
function anyPresent(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
  return names.some((n) => value(env, n) !== null);
}

const SES_VARS = [
  "SES_REGION",
  "SES_FROM_ADDRESS",
  "SES_CONFIGURATION_SET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

const TWILIO_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_FROM_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
] as const;

/**
 * Constructs a sender, turning a rejected option set into a skipped channel.
 *
 * The providers validate in their constructors — a secret too short to derive a signing key, a
 * sender identity that is ambiguous — and throw. Letting that escape would mean a typo in one
 * credential takes down the whole API at boot, when the notification stack is not what the API is
 * for. So a refused sender costs that channel and nothing else, and the reason is reported.
 */
function construct(
  label: string,
  skipped: string[],
  build: () => ChannelSender,
): ChannelSender | null {
  try {
    return build();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    skipped.push(`${label}: refused its configuration: ${reason}`);
    return null;
  }
}

function buildSes(env: NodeJS.ProcessEnv, skipped: string[]): ChannelSender | null {
  const region = value(env, "SES_REGION");
  const accessKeyId = value(env, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = value(env, "AWS_SECRET_ACCESS_KEY");
  const fromAddress = value(env, "SES_FROM_ADDRESS");
  if (region === null || accessKeyId === null || secretAccessKey === null || fromAddress === null) {
    if (anyPresent(env, SES_VARS)) {
      skipped.push(
        "email (SES): needs SES_REGION, SES_FROM_ADDRESS, AWS_ACCESS_KEY_ID and " +
          "AWS_SECRET_ACCESS_KEY; partial configuration is ignored rather than guessed",
      );
    }
    return null;
  }
  // An endpoint override is a deployment concern, not a credential: SES is reachable through a VPC
  // interface endpoint and some networks only allow egress via a proxy. Same reasoning as the AI
  // providers' custom base URL (ADR-0280), and it is what makes this path verifiable against a local
  // endpoint instead of only against a fake.
  const baseUrl = value(env, "SES_ENDPOINT_URL");
  const sessionToken = value(env, "AWS_SESSION_TOKEN");
  const fromName = value(env, "SES_FROM_NAME");
  const configurationSetName = value(env, "SES_CONFIGURATION_SET");
  if (configurationSetName === null) {
    // Not fatal, but without a configuration set SES has no event destination, so no bounce ever
    // reaches the webhook and a hard-bounced address is retried forever.
    skipped.push(
      "email (SES): no SES_CONFIGURATION_SET, so bounces will not reach /v1/notifications/bounces",
    );
  }
  return construct(
    "email (SES)",
    skipped,
    () =>
      new SesEmailSender({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken !== null ? { sessionToken } : {}),
        },
        fromAddress,
        ...(fromName !== null ? { fromName } : {}),
        ...(configurationSetName !== null ? { configurationSetName } : {}),
        ...(baseUrl !== null ? { baseUrl } : {}),
      }),
  );
}

function buildTwilio(env: NodeJS.ProcessEnv, skipped: string[]): ChannelSender | null {
  const accountSid = value(env, "TWILIO_ACCOUNT_SID");
  const apiKeySid = value(env, "TWILIO_API_KEY_SID");
  const apiKeySecret = value(env, "TWILIO_API_KEY_SECRET");
  const authToken = value(env, "TWILIO_AUTH_TOKEN");
  const fromNumber = value(env, "TWILIO_FROM_NUMBER");
  const messagingServiceSid = value(env, "TWILIO_MESSAGING_SERVICE_SID");

  const hasCredential = (apiKeySid !== null && apiKeySecret !== null) || authToken !== null;
  const hasSender = fromNumber !== null || messagingServiceSid !== null;
  if (accountSid === null || !hasCredential || !hasSender) {
    if (anyPresent(env, TWILIO_VARS)) {
      skipped.push(
        "sms (Twilio): needs TWILIO_ACCOUNT_SID, a credential (TWILIO_API_KEY_SID + " +
          "TWILIO_API_KEY_SECRET, or TWILIO_AUTH_TOKEN) and a sender (TWILIO_FROM_NUMBER or " +
          "TWILIO_MESSAGING_SERVICE_SID)",
      );
    }
    return null;
  }
  // The provider takes exactly one sender identity, so two configured values have to be resolved
  // here rather than passed on. The messaging service wins: it is a pool that may contain this very
  // number, Twilio's own guidance for production traffic, and the one an operator adds *after*
  // starting with a single number — so it is the later intent of the two.
  const preferService = fromNumber !== null && messagingServiceSid !== null;
  if (preferService) {
    skipped.push(
      "sms (Twilio): both TWILIO_MESSAGING_SERVICE_SID and TWILIO_FROM_NUMBER are set; using the " +
        "messaging service and ignoring the number",
    );
  }

  const baseUrl = value(env, "TWILIO_BASE_URL");
  const statusCallbackUrl = value(env, "TWILIO_STATUS_CALLBACK_URL");
  if (statusCallbackUrl === null) {
    // Twilio reports delivery and carrier failure only to a status callback, so without one a
    // number that has stopped accepting messages never produces a suppression.
    skipped.push(
      "sms (Twilio): no TWILIO_STATUS_CALLBACK_URL, so carrier failures will not reach " +
        "/v1/notifications/bounces",
    );
  }
  return construct(
    "sms (Twilio)",
    skipped,
    () =>
      new TwilioSmsSender({
        accountSid,
        // An API key pair is preferred over the account's auth token: it is revocable on its own and
        // scoped, where the auth token is the account's root credential.
        ...(apiKeySid !== null && apiKeySecret !== null
          ? { apiKeySid, apiKeySecret }
          : { authToken: authToken as string }),
        ...(messagingServiceSid !== null
          ? { messagingServiceSid }
          : { fromNumber: fromNumber as string }),
        ...(statusCallbackUrl !== null ? { statusCallbackUrl } : {}),
        ...(baseUrl !== null ? { baseUrl } : {}),
      }),
  );
}

/**
 * The registry the server actually delivers through: in-app always, plus whichever real channels the
 * environment fully configures.
 */
export function buildSenderRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BuiltSenderRegistry {
  const skipped: string[] = [];
  const senders: ChannelSender[] = [new InAppSender()];
  const ses = buildSes(env, skipped);
  if (ses !== null) senders.push(ses);
  const twilio = buildTwilio(env, skipped);
  if (twilio !== null) senders.push(twilio);
  const registry = new SenderRegistry(senders);
  return { registry, report: { channels: registry.channels(), skipped } };
}
