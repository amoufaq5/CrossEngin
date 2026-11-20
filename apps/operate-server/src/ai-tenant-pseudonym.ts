/**
 * The per-tenant pseudonym an AI provider is sent in place of the tenant id (ADR-0456).
 *
 * Until this, the tenant id reached the internal `CompletionRequest` only and nothing on the
 * provider wire named the tenant at all (ADR-0450's open question): a vendor's abuse detection saw
 * one undifferentiated deployment, so one abusive tenant could get the whole deployment's key
 * throttled or revoked, and there was nothing to hand the vendor to say which tenant a flagged
 * request came from. Sending the raw id fixes that and discloses an internal identifier to a third
 * party; sending `sha256(tenantId)` looks opaque and is not, because a UUIDv7 is a millisecond
 * timestamp plus 74 random bits and anyone holding a candidate id can hash it. So the value is a
 * keyed derivation the provider cannot reverse or confirm a guess against.
 *
 * **The key is `CURSOR_ENCRYPTION_SECRET`, through its own HKDF label.** Not a new variable: the
 * repo's precedent for a second purpose on one deployment secret is a derivation separated by info
 * (the column key and the KEK already share one), and a new variable would leave every deployment
 * that does not set it sending no pseudonym — while the cursor secret is the one `deploy/.env.example`
 * already uncomments with a generator line and `README.md` lists as required. Not the column secret,
 * which is commented out on the shipped pack (it declares no PHI field), and not the credential
 * pepper or the token signing key, whose compromise model is a database read and a forged session
 * respectively — a value published to a third party should sit beside the secret whose own outputs
 * are already handed to clients (a sealed cursor), not beside one whose outputs never leave.
 *
 * Absent secret → **no pseudonym, said at boot**, and never a fallback to the id or an unkeyed hash:
 * the honest degraded state is "the provider cannot tell tenants apart", which is the state every
 * deployment was in before this.
 */

import { deriveAiTenantPseudonym, parseCursorEncryptionSecret } from "@crossengin/crypto";

import type { AiProviderEndpoint } from "./ai-design.js";
import { CURSOR_ENCRYPTION_SECRET_VAR } from "./cursor-encryption.js";

/** The variable the pseudonym is keyed by. One spelling, shared with the cursor sealer. */
export const AI_TENANT_PSEUDONYM_SECRET_VAR = CURSOR_ENCRYPTION_SECRET_VAR;

export type AiTenantPseudonymSource =
  | { readonly kind: "keyed"; readonly pseudonymFor: (tenantId: string) => string }
  | { readonly kind: "absent" };

/**
 * Reads the secret exactly as `resolveCursorSealing` does — present means non-blank, and the raw
 * value (untrimmed) is what is keyed on — so the two cannot disagree about whether this deployment
 * has the secret. Parsed eagerly: a secret too weak to key with throws `ColumnSecretRefused` here,
 * at boot, rather than on the first design; in practice the cursor sealer has already refused it.
 */
export function resolveAiTenantPseudonymSource(
  env: Readonly<Record<string, string | undefined>>,
): AiTenantPseudonymSource {
  const raw = env[AI_TENANT_PSEUDONYM_SECRET_VAR];
  if (raw === undefined || raw.trim().length === 0) return { kind: "absent" };
  const secret = parseCursorEncryptionSecret(raw);
  return {
    kind: "keyed",
    pseudonymFor: (tenantId: string) => deriveAiTenantPseudonym(secret, tenantId),
  };
}

/** The source's mapping for `buildDesignDesigner`, `null` when there is none. */
export function tenantPseudonymForOf(
  source: AiTenantPseudonymSource,
): ((tenantId: string) => string) | null {
  return source.kind === "keyed" ? source.pseudonymFor : null;
}

/**
 * The boot line, said either way. It names the secret's **variable** and never the secret, a
 * derived key or any tenant's pseudonym: a pseudonym in a log line beside the tenant id it was
 * derived for is the join the derivation exists to deny the provider.
 *
 * The absent arm's consequence is keyed on where the requests go, because it is a claim about a
 * vendor: a self-hosted model has no abuse detection and no API key to revoke, so telling its
 * operator that the provider "throttles the deployment's key as a whole" asserts a cost that does
 * not exist (and at warning level). An OpenAI custom base URL may be either, so it says so.
 */
export function formatAiTenantPseudonym(
  source: AiTenantPseudonymSource,
  provider: { readonly providerLabel: string; readonly endpoint: AiProviderEndpoint },
): { readonly level: "info" | "warn"; readonly line: string } {
  const label = provider.providerLabel;
  if (source.kind === "keyed") {
    return {
      level: "info",
      line:
        `tenant pseudonym: keyed — requests to ${label} carry an opaque per-tenant id ` +
        `(ctp_<32 hex>, HKDF of ${AI_TENANT_PSEUDONYM_SECRET_VAR}) as Anthropic metadata.user_id ` +
        "or the OpenAI-compatible user field; the tenant id itself is never sent",
    };
  }
  const notSent =
    `tenant pseudonym: absent — ${AI_TENANT_PSEUDONYM_SECRET_VAR} is not set, so requests to ` +
    `${label} carry no tenant identifier`;
  const neverRaw = "the raw tenant id is never sent in its place.";
  switch (provider.endpoint) {
    case "self_hosted":
      return {
        level: "info",
        line:
          `${notSent}. None is needed: ${label} runs on this deployment's own hardware, so there ` +
          `is no vendor abuse detection to attribute to a tenant and no API key to revoke; ${neverRaw}`,
      };
    case "unknown":
      return {
        level: "warn",
        line:
          `${notSent}. If this custom base URL is a vendor or a proxy to one, it cannot attribute ` +
          "abuse to one tenant and acts on the deployment's key as a whole; set the variable to " +
          `send an opaque per-tenant id. ${neverRaw[0]!.toUpperCase()}${neverRaw.slice(1)}`,
      };
    case "vendor":
      return {
        level: "warn",
        line:
          `${notSent}: the provider cannot attribute abuse to one tenant, and throttles or ` +
          "revokes the deployment's key as a whole. Set the variable to send an opaque per-tenant " +
          `id; ${neverRaw}`,
      };
  }
}
