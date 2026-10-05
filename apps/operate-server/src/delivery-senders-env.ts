import {
  FcmPushSender,
  MACHINE_DETECTION_MODES,
  MAX_VOICE_REPEAT_COUNT,
  MetadataServerFcmTokenProvider,
  SesEmailSender,
  ServiceAccountFcmTokenProvider,
  TwilioSmsSender,
  TwilioVoiceSender,
  normalizePrivateKeyPem,
  parseServiceAccountJson,
  type MachineDetectionMode,
} from "@crossengin/notification-providers";

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

const FCM_VARS = [
  "FCM_PROJECT_ID",
  "FCM_CREDENTIAL_SOURCE",
  "FCM_SERVICE_ACCOUNT_JSON",
  "FCM_SERVICE_ACCOUNT_CLIENT_EMAIL",
  "FCM_SERVICE_ACCOUNT_PRIVATE_KEY",
  "FCM_METADATA_ENDPOINT",
  "FCM_METADATA_SERVICE_ACCOUNT",
] as const;

/**
 * Where an FCM access token comes from. Two routes, named rather than probed for.
 *
 * `service_account` is a key file; `metadata_server` is the GCE/GKE instance metadata server, which
 * is the configuration Google recommends and the one where there *is* no key file — with workload
 * identity the platform holds the credential and the network position is the credential.
 */
const FCM_CREDENTIAL_SOURCES = ["service_account", "metadata_server"] as const;
type FcmCredentialSource = (typeof FCM_CREDENTIAL_SOURCES)[number];

/**
 * Voice's **own** variables, and only its own, so a deployment that configures SMS alone stays
 * silent about voice (`anyPresent` below is what makes "not wanted" differ from "wanted but
 * incomplete", and a shared name here would collapse the two).
 */
const TWILIO_VOICE_VARS = [
  "TWILIO_VOICE_FROM_NUMBER",
  "TWILIO_VOICE_ACCOUNT_SID",
  "TWILIO_VOICE_AUTH_TOKEN",
  "TWILIO_VOICE_API_KEY_SID",
  "TWILIO_VOICE_API_KEY_SECRET",
  "TWILIO_VOICE_STATUS_CALLBACK_URL",
  "TWILIO_VOICE_MACHINE_DETECTION",
  "TWILIO_VOICE_REPEAT_COUNT",
  "TWILIO_VOICE_LANGUAGE",
  "TWILIO_VOICE_BASE_URL",
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

/*
 * Voice, which ADR-0310 built and nothing constructed (ADR-0328). `voice_call` had a sender, a
 * contract, templates and a dispatch ledger, and every delivery for it was refused
 * `no_sender_configured`.
 *
 * **The credential-sharing decision.** Voice shares the SMS sender's Twilio *account* and
 * credential by default, and takes its own caller id, which it never inherits. Both halves of that
 * are deliberate.
 *
 * Why it shares where ADR-0326's `PAGE_SMS_*` deliberately did not: that separation is about
 * *purpose*, not about Twilio. `SmsPageSender` exists to bypass preferences, suppressions and quiet
 * hours — a different job from delivering a tenant's notification, on a transport that must not be
 * able to acquire a reason not to arrive — so borrowing credentials configured for the notification
 * stack would have been exactly the implicit coupling ADR-0325 refused. `TwilioVoiceSender` is the
 * opposite case: it is a `ChannelSender` in that same notification stack, subject to the same
 * preferences, the same suppressions and the same drain, differing from `TwilioSmsSender` only in
 * the medium. Making an operator restate the same account sid and the same API key under a second
 * prefix would buy nothing and would add a second copy of a credential to rotate.
 *
 * Why the number is never inherited, and is required: `TWILIO_FROM_NUMBER` may legitimately be
 * unable to place a call. A short code, an alphanumeric sender id and a 10DLC number registered for
 * messaging are all valid SMS identities with no voice capability, and `TWILIO_FROM_NUMBER` may be
 * absent entirely because SMS is configured with a messaging service instead — which Calls has no
 * analogue for, so `TwilioVoiceSenderOptions.fromNumber` is required rather than one of two
 * identities. Defaulting it would produce a channel that registers at boot, looks healthy, and
 * fails on every call at the provider.
 *
 * And a deployment that *does* want a separate subaccount for voice can have one, per-variable. The
 * one thing that is refused is borrowing across accounts: if `TWILIO_VOICE_ACCOUNT_SID` names an
 * account other than the one SMS uses, a voice credential is required, because quietly presenting
 * one account's API key to another is a configuration mistake that only Twilio would catch.
 */
function buildTwilioVoice(
  env: NodeJS.ProcessEnv,
  skipped: string[],
): ChannelSender | null {
  const fromNumber = value(env, "TWILIO_VOICE_FROM_NUMBER");
  const smsAccountSid = value(env, "TWILIO_ACCOUNT_SID");
  const voiceAccountSid = value(env, "TWILIO_VOICE_ACCOUNT_SID");
  const accountSid = voiceAccountSid ?? smsAccountSid;

  if (fromNumber === null || accountSid === null) {
    if (anyPresent(env, TWILIO_VOICE_VARS)) {
      skipped.push(
        "voice (Twilio): needs TWILIO_VOICE_FROM_NUMBER (a voice-capable caller id in E.164, " +
          "never inherited from TWILIO_FROM_NUMBER, which may be messaging-only) and an account " +
          "(TWILIO_ACCOUNT_SID, or TWILIO_VOICE_ACCOUNT_SID for a separate subaccount); partial " +
          "configuration is ignored rather than guessed",
      );
    }
    return null;
  }

  const credential = resolveVoiceCredential(env, {
    accountSid,
    sharesSmsAccount: smsAccountSid !== null && accountSid === smsAccountSid,
  });
  if (typeof credential === "string") {
    skipped.push(`voice (Twilio): ${credential}`);
    return null;
  }

  // Every one of these is refused rather than defaulted when it is malformed. A `repeatCount` of
  // `two` silently becoming 2, or an unknown detection mode silently becoming off, is a deployment
  // believing something about an automated phone call that is not true.
  const rawRepeatCount = value(env, "TWILIO_VOICE_REPEAT_COUNT");
  let repeatCount: number | null = null;
  if (rawRepeatCount !== null) {
    if (!/^\d+$/.test(rawRepeatCount)) {
      skipped.push(
        `voice (Twilio): TWILIO_VOICE_REPEAT_COUNT must be a whole number in 1..${String(MAX_VOICE_REPEAT_COUNT)}`,
      );
      return null;
    }
    repeatCount = Number.parseInt(rawRepeatCount, 10);
  }

  const rawMachineDetection = value(env, "TWILIO_VOICE_MACHINE_DETECTION");
  let machineDetection: MachineDetectionMode | null = null;
  if (rawMachineDetection !== null) {
    const mode = MACHINE_DETECTION_MODES.find((m) => m === rawMachineDetection);
    if (mode === undefined) {
      skipped.push(
        `voice (Twilio): TWILIO_VOICE_MACHINE_DETECTION must be one of ${MACHINE_DETECTION_MODES.join(", ")}`,
      );
      return null;
    }
    machineDetection = mode;
  }

  /*
   * Twilio reports a call's real outcome only to a status callback — the terminal `CallStatus`, its
   * `ErrorCode`, and `AnsweredBy` when machine detection is on. **Something consumes it now**
   * (ADR-0329): `twilio_voice` is the bounce webhook's third source, so a permanently undialable
   * number produces a real suppression, and this comment used to say the opposite because ADR-0310
   * left voice with no source at all.
   *
   * So it warns, like SMS's does, and for the same reason: without a callback URL no voice bounce
   * can ever arrive, and a channel that registers at boot and silently never suppresses is worse
   * than one that was skipped. What the warning names is the **path segment**, because the source
   * is declared by the URL the deployment configures rather than sniffed from the payload — posting
   * a call callback to `/twilio` would have it parsed as a *messaging* callback.
   */
  const statusCallbackUrl = value(env, "TWILIO_VOICE_STATUS_CALLBACK_URL");
  if (statusCallbackUrl === null) {
    skipped.push(
      "voice (Twilio): no TWILIO_VOICE_STATUS_CALLBACK_URL, so carrier failures will not reach " +
        "/v1/notifications/bounces/twilio_voice",
    );
  }
  const language = value(env, "TWILIO_VOICE_LANGUAGE");
  // The endpoint override falls back to SMS's: Calls and Messages are the same `api.twilio.com`
  // host, so a deployment behind one egress proxy should configure it once. Inheriting it is safe
  // in the way inheriting a credential across accounts is not — it is a route, not a secret.
  const baseUrl = value(env, "TWILIO_VOICE_BASE_URL") ?? value(env, "TWILIO_BASE_URL");

  return construct(
    "voice (Twilio)",
    skipped,
    () =>
      new TwilioVoiceSender({
        accountSid,
        ...credential,
        fromNumber,
        ...(statusCallbackUrl !== null ? { statusCallbackUrl } : {}),
        ...(machineDetection !== null ? { machineDetection } : {}),
        ...(repeatCount !== null ? { repeatCount } : {}),
        ...(language !== null ? { language } : {}),
        ...(baseUrl !== null ? { baseUrl } : {}),
      }),
  );
}

type TwilioCredential =
  | { readonly apiKeySid: string; readonly apiKeySecret: string }
  | { readonly authToken: string };

/**
 * Resolves voice's Twilio credential, or returns the reason it could not be.
 *
 * An API key pair is preferred over the account's auth token wherever both exist, for `buildTwilio`'s
 * reason: it is revocable on its own and scoped, where the auth token is the account's root
 * credential. Half a pair is refused rather than falling back to the auth token — the same rule and
 * the same reason, that silently substituting the root credential is a privilege escalation nobody
 * asked for.
 */
function resolveVoiceCredential(
  env: NodeJS.ProcessEnv,
  ctx: { readonly accountSid: string; readonly sharesSmsAccount: boolean },
): TwilioCredential | string {
  const apiKeySid = value(env, "TWILIO_VOICE_API_KEY_SID");
  const apiKeySecret = value(env, "TWILIO_VOICE_API_KEY_SECRET");
  const authToken = value(env, "TWILIO_VOICE_AUTH_TOKEN");

  if (apiKeySid !== null || apiKeySecret !== null) {
    return apiKeySid !== null && apiKeySecret !== null
      ? { apiKeySid, apiKeySecret }
      : "TWILIO_VOICE_API_KEY_SID and TWILIO_VOICE_API_KEY_SECRET go together; half a pair is " +
          "refused rather than falling back to an account auth token";
  }
  if (authToken !== null) return { authToken };

  if (!ctx.sharesSmsAccount) {
    return (
      "TWILIO_VOICE_ACCOUNT_SID names an account other than TWILIO_ACCOUNT_SID, so it needs its " +
      "own credential (TWILIO_VOICE_API_KEY_SID + TWILIO_VOICE_API_KEY_SECRET, or " +
      "TWILIO_VOICE_AUTH_TOKEN); one account's credential is never presented to another"
    );
  }

  const sharedKeySid = value(env, "TWILIO_API_KEY_SID");
  const sharedKeySecret = value(env, "TWILIO_API_KEY_SECRET");
  if (sharedKeySid !== null && sharedKeySecret !== null) {
    return { apiKeySid: sharedKeySid, apiKeySecret: sharedKeySecret };
  }
  const sharedAuthToken = value(env, "TWILIO_AUTH_TOKEN");
  if (sharedAuthToken !== null) return { authToken: sharedAuthToken };

  return (
    "no credential for the Twilio account; set TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (shared " +
    "with sms) or TWILIO_VOICE_API_KEY_SID + TWILIO_VOICE_API_KEY_SECRET"
  );
}

/**
 * Mobile push, which ADR-0310 built and could not wire (ADR-0327).
 *
 * `FcmPushSender` has existed and been tested since ADR-0310 and `buildSenderRegistryFromEnv` never
 * constructed it, for one reason: FCM HTTP v1 wants a short-lived OAuth2 access token, and minting
 * one is a private key, a second endpoint and a refresh cache — "env vars cannot express an
 * `FcmAccessTokenProvider`". They can express the *credential*, and the provider is now a real
 * implementation, so this is the wiring that was missing rather than a guess.
 *
 * The service account arrives as the key file **verbatim** in one variable. Splitting it into three
 * is what produces the classic literal-`\n` private key that OpenSSL then refuses; a deployment that
 * does keep them in separate secrets can use the pair instead, and the provider normalises the PEM.
 * Either way it is a private key, which is the strongest case there is for ADR-0301's rule that
 * these come from the environment and never from argv.
 */
function buildFcm(env: NodeJS.ProcessEnv, skipped: string[]): ChannelSender | null {
  const projectId = value(env, "FCM_PROJECT_ID");
  const json = value(env, "FCM_SERVICE_ACCOUNT_JSON");
  const clientEmail = value(env, "FCM_SERVICE_ACCOUNT_CLIENT_EMAIL");
  const privateKeyPem = value(env, "FCM_SERVICE_ACCOUNT_PRIVATE_KEY");
  const hasKey = json !== null || (clientEmail !== null && privateKeyPem !== null);

  const declared = value(env, "FCM_CREDENTIAL_SOURCE");
  if (declared !== null && !isFcmCredentialSource(declared)) {
    skipped.push(
      `push_mobile (FCM): FCM_CREDENTIAL_SOURCE must be one of ${FCM_CREDENTIAL_SOURCES.join(", ")}`,
    );
    return null;
  }
  /*
   * The selection, and why it is asymmetric.
   *
   * A key file is unambiguous evidence of intent: there is no reason to set
   * `FCM_SERVICE_ACCOUNT_JSON` other than to use it, so that route stays inferred from its own
   * presence and existing deployments are unaffected. The metadata route is configured by
   * **nothing** — the network position is the credential — so there is no evidence to infer from,
   * and its absence of configuration is indistinguishable from "push was never wanted". That is the
   * one route that has to be *declared*, which is also why nothing here probes the metadata server
   * to find out: a boot-time link-local request would add this module's timeout to every start and
   * answer a question the deployment is better placed to answer than we are.
   */
  const source: FcmCredentialSource | null =
    declared ?? (hasKey ? "service_account" : null);
  const configured = source === "metadata_server" || hasKey;
  if (projectId === null || source === null || !configured) {
    if (anyPresent(env, FCM_VARS)) {
      skipped.push(
        "push_mobile (FCM): needs FCM_PROJECT_ID and a credential source — either " +
          "FCM_SERVICE_ACCOUNT_JSON, or both FCM_SERVICE_ACCOUNT_CLIENT_EMAIL and " +
          "FCM_SERVICE_ACCOUNT_PRIVATE_KEY, or FCM_CREDENTIAL_SOURCE=metadata_server on " +
          "GCE/GKE; partial configuration is ignored rather than guessed",
      );
    }
    return null;
  }
  if (source === "metadata_server" && hasKey) {
    // Two plausible configurations, resolved here rather than refused — `buildTwilio`'s rule for
    // two sender identities. The explicit declaration wins over inferred evidence, and the one that
    // lost is named, because a key left beside a metadata deployment is usually a stale secret.
    skipped.push(
      "push_mobile (FCM): FCM_CREDENTIAL_SOURCE=metadata_server, so the service-account key " +
        "configured beside it is ignored",
    );
  }

  const tokenEndpoint = value(env, "FCM_TOKEN_ENDPOINT");
  const metadataEndpoint = value(env, "FCM_METADATA_ENDPOINT");
  const metadataServiceAccount = value(env, "FCM_METADATA_SERVICE_ACCOUNT");
  const baseUrl = value(env, "FCM_BASE_URL");
  return construct("push_mobile (FCM)", skipped, () => {
    // Built here, inside `construct`, so a malformed key or a bad endpoint override costs this
    // channel and not the boot — both providers refuse at construction (an EC key, a non-https
    // token endpoint, a plaintext metadata endpoint off the instance) rather than at 3am, and
    // neither echoes credential material into the reason.
    const tokens: FcmTokenSource =
      source === "metadata_server"
        ? new MetadataServerFcmTokenProvider({
            ...(metadataEndpoint !== null ? { endpoint: metadataEndpoint } : {}),
            ...(metadataServiceAccount !== null
              ? { serviceAccount: metadataServiceAccount }
              : {}),
          })
        : buildServiceAccountTokens({
            json,
            clientEmail,
            privateKeyPem,
            tokenEndpoint,
          });
    return new FcmPushSender({
      projectId,
      accessToken: tokens.asProvider(),
      // So a credential FCM refuses is not re-presented on every send for the rest of its cached
      // lifetime (ADR-0327). Both routes answer it, which is what makes them interchangeable here.
      invalidateToken: () => tokens.invalidate(),
      ...(baseUrl !== null ? { baseUrl } : {}),
    });
  });
}

function isFcmCredentialSource(raw: string): raw is FcmCredentialSource {
  return (FCM_CREDENTIAL_SOURCES as readonly string[]).includes(raw);
}

/**
 * What this wiring needs of a token provider, which is all the two routes have in common.
 *
 * Structural on purpose: ADR-0310's seam is the bare function type `() => Promise<string>`, so
 * neither provider class can `implements` it, and naming the pair here keeps the selection above a
 * choice of constructor rather than a branch repeated at every use.
 */
interface FcmTokenSource {
  asProvider(): () => Promise<string>;
  invalidate(): void;
}

function buildServiceAccountTokens(input: {
  readonly json: string | null;
  readonly clientEmail: string | null;
  readonly privateKeyPem: string | null;
  readonly tokenEndpoint: string | null;
}): FcmTokenSource {
  const credentials =
    input.json !== null
      ? parseServiceAccountJson(input.json)
      : {
          clientEmail: input.clientEmail as string,
          // `parseServiceAccountJson` normalises the key it reads; the split form has to do the
          // same, or the literal-`\n` key an env var or Kubernetes secret produces — the most
          // common way this configuration goes wrong — is refused as undecodable.
          privateKeyPem: normalizePrivateKeyPem(input.privateKeyPem as string),
        };
  return new ServiceAccountFcmTokenProvider({
    credentials: {
      ...credentials,
      ...(input.tokenEndpoint !== null ? { tokenUri: input.tokenEndpoint } : {}),
    },
  });
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
  const voice = buildTwilioVoice(env, skipped);
  if (voice !== null) senders.push(voice);
  const fcm = buildFcm(env, skipped);
  if (fcm !== null) senders.push(fcm);
  const registry = new SenderRegistry(senders);
  return { registry, report: { channels: registry.channels(), skipped } };
}
