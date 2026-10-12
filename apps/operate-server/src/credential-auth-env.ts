import {
  type ColumnSecretRefused,
  ed25519PublicKeyFromSeed,
  isEd25519PrivateSeedBase64,
  parseCredentialPepper,
} from "@crossengin/crypto";

/**
 * The deployment half of password login: where the two secrets come from, and what a deployment is
 * told -- or refused -- when it mounts the surface without them.
 *
 * It performs no hashing, mints no token and issues no SQL. `@crossengin/crypto`'s `password.ts`
 * holds the KDF, `token-mint.ts` holds the JWT, and `credential-store.ts` holds the statements.
 *
 * Both secrets arrive by **environment and never argv** (ADR-0301): argv is readable by anyone who
 * can run `ps`, and `cli.ts` reads `process.env` nowhere by design, so each variable needs a module
 * that owns its own name and its own decision -- the shape `column-encryption.ts`,
 * `cursor-encryption.ts`, `bounce-webhook-env.ts` and `api-key-source.ts` each take.
 */

/** HMAC'd into a password before scrypt stretches it. */
export const CREDENTIAL_PEPPER_VAR = "CREDENTIAL_PEPPER";

/**
 * The raw base64 Ed25519 **seed** this deployment signs session tokens with.
 *
 * One variable and not two, which is the whole of why `ed25519PublicKeyFromSeed` exists: the
 * gateway verifies against a JWKS of public keys, so a signer would otherwise have to be
 * configured beside a matching `--jwks-key <kid>:<pub>` -- and a pair that can be stated twice can
 * be stated inconsistently, which is a class this repository keeps finding. Derived, the two
 * cannot disagree, and there is nothing for an operator to keep in step.
 */
export const TOKEN_SIGNING_KEY_VAR = "OPERATE_TOKEN_SIGNING_KEY";

/**
 * The `kid` the minted tokens carry and the derived public key is registered under.
 *
 * Fixed rather than configurable: it names *this deployment's own* key, there is exactly one, and
 * a configurable kid is a second thing to keep in step with the key itself. Versioned so a future
 * rotation can add `login-v2` beside it rather than redefining what `login-v1` means.
 */
export const TOKEN_SIGNING_KID = "login-v1";

/** Why a deployment cannot mount password login. */
export const CREDENTIAL_AUTH_REFUSALS = [
  "pepper_absent",
  "pepper_refused",
  "signing_key_absent",
  "signing_key_malformed",
  "jwks_url_would_discard_it",
] as const;
export type CredentialAuthRefusal = (typeof CREDENTIAL_AUTH_REFUSALS)[number];

export interface CredentialAuthMaterial {
  readonly pepper: string;
  readonly signingSeedBase64: string;
  /** Derived from the seed, never configured. Registered in the JWKS under `TOKEN_SIGNING_KID`. */
  readonly publicKeyBase64: string;
  readonly kid: typeof TOKEN_SIGNING_KID;
}

export type CredentialAuthResolution =
  | { readonly ok: true; readonly material: CredentialAuthMaterial }
  | { readonly ok: false; readonly refusal: CredentialAuthRefusal; readonly detail: string };

export interface ResolveCredentialAuthInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Whether the deployment also passed `--jwks-url`. Measured: `node.ts` branches on the URL and
   * **discards** the parsed static key specs, so a derived key registered beside one would be
   * silently ignored -- the deployment would mint tokens no request can use, and the failure lands
   * at the gateway rather than at the mint, so the mint looks fine in testing. Refused by name
   * rather than warned, because there is no degraded behaviour to protect: every login would 401.
   */
  readonly jwksUrlConfigured: boolean;
}

/**
 * Resolves both secrets, or says exactly which one is missing and what to do about it.
 *
 * Neither refusal detail may contain any part of either secret -- only the measured figures and the
 * variable's name, which is what an operator needs to fix it. `parseCredentialPepper`'s own
 * refusals already obey that rule and their message is passed through unchanged.
 */
export function resolveCredentialAuth(
  input: ResolveCredentialAuthInput,
): CredentialAuthResolution {
  const pepper = (input.env[CREDENTIAL_PEPPER_VAR] ?? "").trim();
  if (pepper === "") {
    return {
      ok: false,
      refusal: "pepper_absent",
      detail: `${CREDENTIAL_PEPPER_VAR} is unset or empty`,
    };
  }
  try {
    // Validated for its own sake and the result discarded: `hashPassword` takes the pepper as a
    // string and keys the HMAC on exactly these bytes, so parsing here and passing the original
    // string is the same key. What the call buys is the refusal.
    parseCredentialPepper(pepper);
  } catch (err) {
    return {
      ok: false,
      refusal: "pepper_refused",
      detail: (err as ColumnSecretRefused).message,
    };
  }

  const seed = (input.env[TOKEN_SIGNING_KEY_VAR] ?? "").trim();
  if (seed === "") {
    return {
      ok: false,
      refusal: "signing_key_absent",
      detail: `${TOKEN_SIGNING_KEY_VAR} is unset or empty`,
    };
  }
  if (!isEd25519PrivateSeedBase64(seed)) {
    // The length is named and the value is not. A seed of the wrong width is the overwhelmingly
    // likely mistake -- a pasted PEM, a base64url variant, a truncated copy -- and saying "32
    // bytes of base64" is the whole remedy.
    return {
      ok: false,
      refusal: "signing_key_malformed",
      detail: `${TOKEN_SIGNING_KEY_VAR} must be 32 bytes of standard base64 (an Ed25519 seed)`,
    };
  }

  if (input.jwksUrlConfigured) {
    return {
      ok: false,
      refusal: "jwks_url_would_discard_it",
      detail:
        `--jwks-url replaces the static JWKS, so the key derived from ${TOKEN_SIGNING_KEY_VAR}` +
        " would not be registered and every minted token would be refused invalid_signature",
    };
  }

  return {
    ok: true,
    material: {
      pepper,
      signingSeedBase64: seed,
      publicKeyBase64: ed25519PublicKeyFromSeed(seed),
      kid: TOKEN_SIGNING_KID,
    },
  };
}

/** The boot line. Never prints a secret, and says the fingerprint of the key it will verify with. */
export function formatCredentialAuth(resolution: CredentialAuthResolution): string {
  if (!resolution.ok) {
    return `credential login: refused ${resolution.refusal} — ${resolution.detail}`;
  }
  // The public key, not the seed: it is public by construction and it is what an operator compares
  // against a `--jwks-key` line if they ever need to configure a second verifier.
  return (
    `credential login: enabled (kid ${resolution.material.kid}, ` +
    `public key ${resolution.material.publicKeyBase64})`
  );
}
