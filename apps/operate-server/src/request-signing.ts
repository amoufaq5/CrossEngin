/**
 * Where an HMAC signing key comes from, and why the id may sit on argv while the secret may not.
 *
 * ADR-0301's rule is that a secret arrives by environment and never argv, because argv is readable
 * via `ps`. This scheme splits cleanly along that line and is the first credential here that does:
 * `--hmac-key keyId:role:tenant[:principalId]` carries **no secret** — a key id travels in the
 * clear in every signed request's `CrossEngin-Request-Signature` header, so publishing it on a
 * command line discloses nothing — while the one secret, `REQUEST_SIGNING_SECRET`, is read from the
 * environment and has no flag at all. So `api-key-source.ts`'s whole apparatus (an environment
 * route beside the flag, a four-value source verdict, an argv-exposure map, a boot warning) is
 * **not reproduced here**, because the thing it exists to move is not on the flag.
 *
 * Per-key secrets are **derived and stored nowhere**:
 * `deriveRequestSigningKey(secret, keyId)` is HKDF-SHA256 under its own info tag, which is
 * ADR-0302's shape and ADR-0338's and ADR-0347's — one deployment secret, derived per scope, store
 * nothing. A store was refused on measurement rather than on preference: `KeyStore` is **sign-only**
 * (`getPublicMaterial` throws for a MAC key and `KeyRecord` has no secret field), so a *verifier*
 * cannot get bytes out of it; `meta.crypto_keys` has no private-material column and its `algorithm`
 * CHECK names only the two signing algorithms; and `meta.api_keys` is declared storeless. Four
 * derivation precedents already exist and no storage route does.
 *
 * The cost is stated rather than discovered: **a key cannot be revoked without a restart**, because
 * the key set is the flag set. Revoking one means removing its `--hmac-key` and restarting, or
 * rotating `REQUEST_SIGNING_SECRET`, which invalidates every key at once. A per-key revocation
 * surface needs a store, which is the open end rather than this module's omission.
 */
import type { IncomingRequest } from "@crossengin/api-gateway";
import type { HmacKeyLookup, HmacKeyLookupResult } from "@crossengin/api-gateway-runtime";
import { deriveRequestSigningKey, parseRequestSigningSecret } from "@crossengin/crypto";

import type { HmacKeySpec } from "./principals.js";

export const REQUEST_SIGNING_SECRET_VAR = "REQUEST_SIGNING_SECRET";

/**
 * Why this deployment is not verifying request signatures, when it is not.
 *
 * Three states and not a boolean, because the two absences have different remedies and the third is
 * a refusal: `no_keys` is an operator who set a secret and declared no key, `secret_absent` is the
 * reverse, and `secret_refused` is a secret present and too weak to derive from. A single
 * "unconfigured" would send the first operator to look for a variable they already set.
 */
export const REQUEST_SIGNING_ABSENCES = ["no_keys", "secret_absent", "secret_refused"] as const;
export type RequestSigningAbsence = (typeof REQUEST_SIGNING_ABSENCES)[number];

export type RequestSigningResolution =
  | { readonly kind: "configured"; readonly lookup: HmacKeyLookup; readonly keyIds: readonly string[] }
  | { readonly kind: "absent"; readonly absence: RequestSigningAbsence; readonly detail: string };

/**
 * Builds the lookup, or says why it could not.
 *
 * It returns an **absence rather than throwing** for a missing secret or a missing key set, and
 * throws for neither — which is the opposite of `resolveCredentialAuth`'s treatment of its pepper
 * and is decided by whether the capability is opt-in. A deployment that declares no `--hmac-key` has
 * not asked for this scheme, so refusing its boot would refuse a deployment that works
 * (ADR-0338's premise read the other way). A deployment that *did* declare keys and whose secret is
 * absent or weak is the case worth being loud about, and `node.ts` is where that choice is made
 * because only it knows whether anything else is wrong too.
 *
 * `secret_refused` carries `refuseWeakSecret`'s own message, which names the floor and never the
 * value — the same rule `parseCredentialPepper` follows.
 */
export function resolveRequestSigning(
  specs: readonly HmacKeySpec[],
  env: NodeJS.ProcessEnv = process.env,
): RequestSigningResolution {
  if (specs.length === 0) {
    return {
      kind: "absent",
      absence: "no_keys",
      detail: "no --hmac-key was declared, so no signing key id can be resolved",
    };
  }
  const raw = env[REQUEST_SIGNING_SECRET_VAR]?.trim() ?? "";
  if (raw.length === 0) {
    return {
      kind: "absent",
      absence: "secret_absent",
      detail: `${REQUEST_SIGNING_SECRET_VAR} is not set, so no per-key secret can be derived`,
    };
  }
  let secret: Uint8Array;
  try {
    secret = parseRequestSigningSecret(raw);
  } catch (err) {
    return {
      kind: "absent",
      absence: "secret_refused",
      detail: `${REQUEST_SIGNING_SECRET_VAR}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Derived **once per key at build time** and not per request. A per-request HKDF would be ~1 µs,
  // so this is not the reason: the reason is that a derivation failure must happen at boot, where
  // an operator reads it, rather than as a 500 on one request — and the key set is fixed at boot
  // because it is the flag set, so there is nothing to derive later.
  const byKeyId = new Map<string, HmacKeyLookupResult>();
  for (const spec of specs) {
    byKeyId.set(spec.keyId, {
      keyBytes: deriveRequestSigningKey(secret, spec.keyId),
      principalRef: spec.principalId,
      scopes: [spec.role],
      tenantId: spec.tenantId,
    });
  }
  return {
    kind: "configured",
    lookup: {
      // `_req` is unread, and deliberately so: the seam passes the request so a deployment *can*
      // scope a key per host, and this one does not, because a key id already names a tenant. It
      // must not read the signature header — the facts the signature covers are assembled by the
      // stage, so a lookup reading the credential would be a second reading of it.
      async lookup(_req: IncomingRequest, keyId: string): Promise<HmacKeyLookupResult | null> {
        return byKeyId.get(keyId) ?? null;
      },
    },
    // Sorted so a boot line is stable across argv order, and ids only — never a derived key.
    keyIds: [...byKeyId.keys()].sort(),
  };
}

/**
 * The boot line, said **either way**.
 *
 * Including when nothing is configured, which is ADR-0376's rule: a capability an operator cannot
 * confirm from the log is the one they disbelieve, and what wants confirming here is that a signed
 * request will be *accepted* — harder to confirm by trying it than a refusal is, because before this
 * increment trying it answered 201 as the anonymous principal.
 *
 * The **key ids are named** and the derived keys never are. A key id is not a secret (that is the
 * whole premise of the argv split above), and naming them is what lets an operator check the set
 * against what they issued to a client.
 */
export function formatRequestSigningSurvey(resolution: RequestSigningResolution): string {
  if (resolution.kind === "configured") {
    return `request signatures: verifying ${resolution.keyIds.length} key id(s) — ${resolution.keyIds.join(", ")}`;
  }
  return `request signatures: not verified — ${resolution.detail}`;
}

/**
 * Whether an absence should stop the boot.
 *
 * A total map so a fourth absence must say which side of it falls on, and the split is *did the
 * operator ask for this*: `no_keys` is a deployment that did not, so it is reported; the other two
 * are a deployment that declared keys and cannot verify a single signature, which is a
 * configuration error whose only symptom would otherwise be a 401 per request recorded as
 * `scheme_not_supported` — ADR-0334's conversion of a per-request failure into a boot refusal.
 */
export const REQUEST_SIGNING_ABSENCE_REFUSES_BOOT: Readonly<
  Record<RequestSigningAbsence, boolean>
> = Object.freeze({
  no_keys: false,
  secret_absent: true,
  secret_refused: true,
});
