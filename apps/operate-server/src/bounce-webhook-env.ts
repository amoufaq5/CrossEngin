import { createHmac } from "node:crypto";

import type { BounceWebhookSecretResolver } from "./bounce-webhook-routes.js";

export const BOUNCE_SECRET_ENV_VAR = "NOTIFICATION_BOUNCE_SECRET";

/** Short enough to type by mistake is the thing to refuse; 32 bytes of hex is the intended shape. */
const MIN_SECRET_LENGTH = 32;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface BounceSecretWiring {
  readonly resolver: BounceWebhookSecretResolver | null;
  /** Why no resolver was built, for the boot log. Null when one was. */
  readonly skipped: string | null;
}

/**
 * The per-tenant HMAC secret the bounce webhook verifies against.
 *
 * What signs these requests is the platform's own edge, not the tenant: a provider signs with its own
 * scheme (an SNS message signature, a Twilio `X-Twilio-Signature`), and the edge that terminates it
 * re-signs the byte-identical body with `signWebhookPayload`. So the secret is a platform secret, held
 * in one environment variable rather than per tenant.
 *
 * It is still **derived per tenant**, as `HMAC-SHA256(platform_secret, "bounce-webhook:" || tenantId)`.
 * Deriving costs one hash and buys a real property: a signature captured for one tenant cannot be
 * replayed against another, which a single shared secret would allow for anyone who could reach the
 * route. The edge must derive the same way — that is the deployment contract, and it is why the
 * derivation string is a constant here rather than a configurable.
 */
export function buildBounceSecretResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BounceSecretWiring {
  const raw = env[BOUNCE_SECRET_ENV_VAR];
  const secret = raw === undefined ? "" : raw.trim();
  if (secret.length === 0) {
    return {
      resolver: null,
      skipped: `${BOUNCE_SECRET_ENV_VAR} is not set, so the bounce webhook is not served`,
    };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    // Refused rather than accepted with a warning: a weak secret on a route that writes suppressions
    // lets anyone who guesses it silence a tenant's mail, and the route not existing is the safer
    // failure.
    return {
      resolver: null,
      skipped:
        `${BOUNCE_SECRET_ENV_VAR} is shorter than ${MIN_SECRET_LENGTH.toString()} characters; ` +
        "the bounce webhook is not served",
    };
  }
  const key = Buffer.from(secret, "utf8");
  return {
    resolver: (tenantId: string): Uint8Array | null => {
      // A malformed tenant id cannot name a row, and answering with a derived secret for one would
      // make the route verify a request whose write must then fail on the tenant foreign key.
      if (!UUID_RE.test(tenantId)) return null;
      return new Uint8Array(
        createHmac("sha256", key).update(`bounce-webhook:${tenantId.toLowerCase()}`).digest(),
      );
    },
    skipped: null,
  };
}
