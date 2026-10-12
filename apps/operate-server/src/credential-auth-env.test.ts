import { ed25519PublicKeyFromSeed, generateEd25519Keypair } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_AUTH_REFUSALS,
  CREDENTIAL_PEPPER_VAR,
  TOKEN_SIGNING_KEY_VAR,
  TOKEN_SIGNING_KID,
  formatCredentialAuth,
  resolveCredentialAuth,
} from "./credential-auth-env.js";

const KP = generateEd25519Keypair();
const PEPPER = "a-deployment-pepper-with-plenty-of-distinct-bytes-0123456789";

const env = (over: Record<string, string | undefined> = {}) => ({
  [CREDENTIAL_PEPPER_VAR]: PEPPER,
  [TOKEN_SIGNING_KEY_VAR]: KP.privateKeyBase64,
  ...over,
});

describe("resolveCredentialAuth", () => {
  it("derives the public key rather than taking one", () => {
    // The property the whole module exists for: one secret in, a verifiable pair out, and nothing
    // for an operator to keep in step. A configured pair can be stated inconsistently -- and
    // `signEd25519` SILENTLY IGNORES a public key that disagrees with its seed (measured in
    // `token-mint.test.ts`), so the failure would land as `invalid_signature` on every login
    // rather than at the point of misconfiguration.
    const resolved = resolveCredentialAuth({ env: env(), jwksUrlConfigured: false });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.material.publicKeyBase64).toBe(KP.publicKeyBase64);
      expect(resolved.material.publicKeyBase64).toBe(
        ed25519PublicKeyFromSeed(KP.privateKeyBase64),
      );
      expect(resolved.material.kid).toBe(TOKEN_SIGNING_KID);
      expect(resolved.material.pepper).toBe(PEPPER);
    }
  });

  it("refuses an absent pepper, and names the variable", () => {
    for (const value of [undefined, "", "   "]) {
      const r = resolveCredentialAuth({
        env: env({ [CREDENTIAL_PEPPER_VAR]: value }),
        jwksUrlConfigured: false,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refusal).toBe("pepper_absent");
        expect(r.detail).toContain(CREDENTIAL_PEPPER_VAR);
      }
    }
  });

  it("refuses a weak pepper through the shared validator", () => {
    // Same floor as the column and cursor secrets, by the same `refuseWeakSecret`. The floor is on
    // the DEPLOYMENT's secret and deliberately not on a user's password.
    const r = resolveCredentialAuth({
      env: env({ [CREDENTIAL_PEPPER_VAR]: "short" }),
      jwksUrlConfigured: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("pepper_refused");
      expect(r.detail).toContain("credential pepper refused");
    }
  });

  it("refuses an absent or malformed signing key", () => {
    const absent = resolveCredentialAuth({
      env: env({ [TOKEN_SIGNING_KEY_VAR]: "" }),
      jwksUrlConfigured: false,
    });
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.refusal).toBe("signing_key_absent");

    for (const bad of ["not-base64!", Buffer.alloc(31).toString("base64"), "AAAA"]) {
      const r = resolveCredentialAuth({
        env: env({ [TOKEN_SIGNING_KEY_VAR]: bad }),
        jwksUrlConfigured: false,
      });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) {
        expect(r.refusal).toBe("signing_key_malformed");
        expect(r.detail).toContain("32 bytes");
      }
    }
  });

  it("refuses a --jwks-url that would discard the derived key", () => {
    // `node.ts` branches on the URL and *discards* the static specs, so the derived key would
    // never be registered and every minted token would come back `invalid_signature` -- a failure
    // at the gateway rather than at the mint, so the mint looks fine in testing.
    const r = resolveCredentialAuth({ env: env(), jwksUrlConfigured: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("jwks_url_would_discard_it");
      expect(r.detail).toContain("invalid_signature");
    }
  });

  it("never names either secret in any refusal or in the boot line", () => {
    const secrets = [PEPPER, KP.privateKeyBase64];
    const resolutions = [
      resolveCredentialAuth({ env: env(), jwksUrlConfigured: false }),
      resolveCredentialAuth({ env: env(), jwksUrlConfigured: true }),
      resolveCredentialAuth({
        env: env({ [CREDENTIAL_PEPPER_VAR]: "short" }),
        jwksUrlConfigured: false,
      }),
      resolveCredentialAuth({
        env: env({ [TOKEN_SIGNING_KEY_VAR]: "zzzz" }),
        jwksUrlConfigured: false,
      }),
    ];
    for (const r of resolutions) {
      const line = formatCredentialAuth(r);
      for (const secret of secrets) {
        expect(line, line).not.toContain(secret);
      }
      if (!r.ok) {
        for (const secret of secrets) expect(r.detail).not.toContain(secret);
      }
    }
  });

  it("the boot line names the PUBLIC key, which discloses nothing", () => {
    const r = resolveCredentialAuth({ env: env(), jwksUrlConfigured: false });
    const line = formatCredentialAuth(r);
    expect(line).toContain(KP.publicKeyBase64);
    expect(line).toContain(TOKEN_SIGNING_KID);
    expect(line).toContain("enabled");
  });

  it("checks the pepper before the key, so the first remedy named is the first one owed", () => {
    // Both wrong: the operator is sent to the pepper, fixes it, and is then sent to the key. The
    // other order would have them fix the key and be told the pepper was the problem all along.
    const r = resolveCredentialAuth({
      env: { [CREDENTIAL_PEPPER_VAR]: "", [TOKEN_SIGNING_KEY_VAR]: "" },
      jwksUrlConfigured: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("pepper_absent");
  });

  it("every refusal reason is a declared member", () => {
    const seen = new Set<string>();
    for (const e of [
      { [CREDENTIAL_PEPPER_VAR]: "" },
      { [CREDENTIAL_PEPPER_VAR]: "short" },
      { [TOKEN_SIGNING_KEY_VAR]: "" },
      { [TOKEN_SIGNING_KEY_VAR]: "zz" },
    ]) {
      const r = resolveCredentialAuth({ env: env(e), jwksUrlConfigured: false });
      if (!r.ok) seen.add(r.refusal);
    }
    const urlCase = resolveCredentialAuth({ env: env(), jwksUrlConfigured: true });
    if (!urlCase.ok) seen.add(urlCase.refusal);
    expect([...seen].sort()).toEqual([...CREDENTIAL_AUTH_REFUSALS].sort());
  });
});
