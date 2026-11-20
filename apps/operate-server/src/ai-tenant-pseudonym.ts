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

import type { AiProviderEndpoint, AiTenantPseudonymField } from "./ai-design.js";
import { CURSOR_ENCRYPTION_SECRET_VAR } from "./cursor-encryption.js";

/** The variable the pseudonym is keyed by. One spelling, shared with the cursor sealer. */
export const AI_TENANT_PSEUDONYM_SECRET_VAR = CURSOR_ENCRYPTION_SECRET_VAR;

/**
 * `--ai-tenant-pseudonym keyed|off` (ADR-0461). Until it existed, opting out of the pseudonym and
 * opting out of sealed cursors were one switch — both are keyed off `CURSOR_ENCRYPTION_SECRET` — so
 * a deployment unwilling to let a vendor link one tenant's requests had to give up sealed cursors,
 * which is the protection ADR-0357 measured as live on every pack. `off` separates them: the secret
 * goes on sealing cursors and is never read for this.
 */
export const AI_TENANT_PSEUDONYM_MODES = ["keyed", "off"] as const;
export type AiTenantPseudonymMode = (typeof AI_TENANT_PSEUDONYM_MODES)[number];
export const DEFAULT_AI_TENANT_PSEUDONYM_MODE: AiTenantPseudonymMode = "keyed";
export const AI_TENANT_PSEUDONYM_FLAG = "--ai-tenant-pseudonym";

export function isAiTenantPseudonymMode(value: string): value is AiTenantPseudonymMode {
  return (AI_TENANT_PSEUDONYM_MODES as readonly string[]).includes(value);
}

/**
 * `absent` and `off` both send nothing and are kept apart because they are different facts with
 * different remedies (ADR-0331's claim-versus-gap): `absent` is a deployment that has not set the
 * secret, whose remedy is to set it; `off` is a deployment that declined, whose remedy — if any —
 * is to drop the flag. Collapsing them would tell an operator who chose `off` to set a variable
 * they have already set.
 */
export type AiTenantPseudonymSource =
  | { readonly kind: "keyed"; readonly pseudonymFor: (tenantId: string) => string }
  | { readonly kind: "absent" }
  | {
      readonly kind: "off";
      /**
       * Whether `CURSOR_ENCRYPTION_SECRET` is set — a presence check, never a parse, so `off` still
       * does not key on it. Read only so the boot line's remedy is true: dropping the flag sends a
       * pseudonym only when the secret is there, and saying otherwise would name a remedy that
       * cannot work on its own (ADR-0334).
       */
      readonly secretPresent: boolean;
    };

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant id a pseudonym is derived over. A uuid-shaped id is lowercased; anything else passes
 * through unchanged.
 *
 * HKDF's salt is the exact string, while every place the platform *stores* a tenant id is a `uuid`
 * column, which compares case-insensitively and renders lowercase. A credential naming its tenant
 * in uppercase (`--api-key k:role:0196F2A8-…`, or a foreign JWT's `tenant_id` claim) passes every
 * tenant check — and, derived verbatim, would carry a pseudonym `ai-pseudonym-lookup` can never
 * reproduce from `meta.tenants.id::text`. So one tenant would have two pseudonyms depending on how a
 * credential spelled it, and the lookup would answer a real report `no_match`. Canonicalising here,
 * inside the one mapping the server and the lookup both use, makes the derivation a function of the
 * tenant rather than of its spelling (ADR-0461).
 */
export function canonicalTenantIdForPseudonym(tenantId: string): string {
  return UUID_SHAPE.test(tenantId) ? tenantId.toLowerCase() : tenantId;
}

/**
 * Reads the secret exactly as `resolveCursorSealing` does — present means non-blank, and the raw
 * value (untrimmed) is what is keyed on — so the two cannot disagree about whether this deployment
 * has the secret. Parsed eagerly: a secret too weak to key with throws `ColumnSecretRefused` here,
 * at boot, rather than on the first design; in practice the cursor sealer has already refused it.
 *
 * `mode` is required rather than defaulted, so no call site can reach the keyed arm by forgetting
 * the operator's `off` (ADR-0386). Under `off` the variable is never parsed or keyed on; only its
 * presence is recorded, for the boot line's remedy.
 */
export function resolveAiTenantPseudonymSource(
  env: Readonly<Record<string, string | undefined>>,
  mode: AiTenantPseudonymMode,
): AiTenantPseudonymSource {
  const raw = env[AI_TENANT_PSEUDONYM_SECRET_VAR];
  const present = raw !== undefined && raw.trim().length > 0;
  if (mode === "off") return { kind: "off", secretPresent: present };
  if (!present) return { kind: "absent" };
  const secret = parseCursorEncryptionSecret(raw);
  return {
    kind: "keyed",
    pseudonymFor: (tenantId: string) =>
      deriveAiTenantPseudonym(secret, canonicalTenantIdForPseudonym(tenantId)),
  };
}

/** The source's mapping for `buildDesignDesigner`, `null` when there is none. */
export function tenantPseudonymForOf(
  source: AiTenantPseudonymSource,
): ((tenantId: string) => string) | null {
  return source.kind === "keyed" ? source.pseudonymFor : null;
}

/**
 * The boot line, said either way. It names the secret's **variable** and the body **field**, and
 * never the secret, a derived key or any tenant's pseudonym: a pseudonym in a log line beside the
 * tenant id it was derived for is the join the derivation exists to deny the provider.
 *
 * The field is read off the built provider (`DesignProviderBuild.pseudonymField`), so on OpenAI the
 * line says `safety_identifier` for `api.openai.com` and `user` for a custom base URL — the field
 * the requests actually carry, not a re-derivation of it from the environment.
 *
 * The two not-sent arms' consequence is keyed on where the requests go, because it is a claim about
 * a vendor: a self-hosted model has no abuse detection and no API key to revoke, so telling its
 * operator that the provider "throttles the deployment's key as a whole" asserts a cost that does
 * not exist. An OpenAI custom base URL may be either, so it says so. The consequence is the same
 * whether nothing is sent because the secret is unset or because the operator chose `off` — the
 * vendor cannot tell the difference — so the level follows the endpoint in both, and only the cause
 * and the remedy differ.
 */
export function formatAiTenantPseudonym(
  source: AiTenantPseudonymSource,
  provider: {
    readonly providerLabel: string;
    readonly endpoint: AiProviderEndpoint;
    readonly pseudonymField: AiTenantPseudonymField;
  },
): { readonly level: "info" | "warn"; readonly line: string } {
  const label = provider.providerLabel;
  if (source.kind === "keyed") {
    return {
      level: "info",
      line:
        `tenant pseudonym: keyed — requests to ${label} carry an opaque per-tenant id ` +
        `(ctp_<32 hex>, HKDF of ${AI_TENANT_PSEUDONYM_SECRET_VAR}) in the ${provider.pseudonymField} ` +
        `field; the tenant id itself is never sent (${AI_TENANT_PSEUDONYM_FLAG} off sends none)`,
    };
  }
  const notSent =
    source.kind === "absent"
      ? `tenant pseudonym: absent — ${AI_TENANT_PSEUDONYM_SECRET_VAR} is not set, so requests to ` +
        `${label} carry no tenant identifier`
      : `tenant pseudonym: off — ${AI_TENANT_PSEUDONYM_FLAG} off, so requests to ${label} carry no ` +
        `tenant identifier and ${AI_TENANT_PSEUDONYM_SECRET_VAR} is not keyed on for one` +
        (source.secretPresent ? " (it still seals list cursors)" : " (it is also unset)");
  const remedy =
    source.kind === "absent"
      ? "set the variable to send an opaque per-tenant id"
      : source.secretPresent
        ? `drop ${AI_TENANT_PSEUDONYM_FLAG} off to send an opaque per-tenant id`
        : `drop ${AI_TENANT_PSEUDONYM_FLAG} off and set ${AI_TENANT_PSEUDONYM_SECRET_VAR} to send an ` +
          "opaque per-tenant id";
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
          `abuse to one tenant and acts on the deployment's key as a whole; ${remedy}. ` +
          `${neverRaw[0]!.toUpperCase()}${neverRaw.slice(1)}`,
      };
    case "vendor":
      return {
        level: "warn",
        line:
          `${notSent}: the provider cannot attribute abuse to one tenant, and throttles or ` +
          `revokes the deployment's key as a whole. ${remedy[0]!.toUpperCase()}${remedy.slice(1)}; ` +
          neverRaw,
      };
  }
}
