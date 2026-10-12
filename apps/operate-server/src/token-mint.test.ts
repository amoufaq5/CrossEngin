import { ed25519PublicKeyFromSeed, generateEd25519Keypair, verifyEd25519 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_TOKEN_SECONDS,
  MAX_SESSION_TOKEN_SECONDS,
  MIN_SESSION_TOKEN_SECONDS,
  TOKEN_NOT_BEFORE_SKEW_SECONDS,
  mintSessionToken,
} from "./token-mint.js";

const KP = generateEd25519Keypair();
const NOW = new Date("2026-10-11T12:00:00.000Z");
const USER = "22222222-2222-4222-8222-222222222222";
const TENANT = "11111111-1111-4111-8111-111111111111";

function mint(over: Partial<Parameters<typeof mintSessionToken>[0]> = {}) {
  return mintSessionToken({
    issuer: "https://operate.example.test",
    audience: "crossengin-operate",
    userId: USER,
    tenantId: TENANT,
    role: "erp_admin",
    now: NOW,
    lifetimeSeconds: DEFAULT_SESSION_TOKEN_SECONDS,
    kid: "login-v1",
    signingSeedBase64: KP.privateKeyBase64,
    publicKeyBase64: KP.publicKeyBase64,
    ...over,
  });
}

function decodeSegment(seg: string): Record<string, unknown> {
  const padded = seg.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("mintSessionToken", () => {
  it("emits three base64url segments with an EdDSA header carrying the kid", () => {
    const parts = mint().token.split(".");
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSegment(parts[0]!)).toEqual({ alg: "EdDSA", typ: "JWT", kid: "login-v1" });
  });

  it("signs the exact bytes it transmits", () => {
    // The verifier reconstructs the signing input from the token's own first two segments, so the
    // claims must not be serialized a second time. Proved by verifying against the substrings.
    const token = mint().token;
    const [h, p, s] = token.split(".");
    const sigStd = Buffer.from(s!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "base64",
    );
    expect(verifyEd25519(KP.publicKeyBase64, sigStd, `${h!}.${p!}`)).toBe(true);
  });

  it("verifies under a public key DERIVED from the seed", () => {
    // This is the property that lets a deployment hold one secret: the key registered in the JWKS
    // is computed from the signing seed, so there is no second declaration to get wrong.
    const derived = ed25519PublicKeyFromSeed(KP.privateKeyBase64);
    const token = mint({ publicKeyBase64: derived }).token;
    const [h, p, s] = token.split(".");
    const sigStd = Buffer.from(s!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "base64",
    );
    expect(verifyEd25519(derived, sigStd, `${h!}.${p!}`)).toBe(true);
  });

  // The next three fence the three claims whose ABSENCE the verifier silently tolerates. Measured
  // on the committed gateway: a correctly-signed token with the payload `{}` verifies as
  // `authenticated`, because every payload claim is checked only when present. So the safety of
  // these tokens rests entirely on the minter, and these are the tests that make a claim going
  // missing a failure here rather than a privilege escalation in production.

  it("always carries exp, nbf and iat as NUMBERS", () => {
    // Not merely present: `exp` is honoured only when `typeof === "number"`, so a stringified one
    // is ignored entirely and a token 10,000 seconds expired reads as authenticated. A JSON
    // round-trip through a schema that typed it as a string would do exactly that.
    const claims = decodeSegment(mint().token.split(".")[1]!);
    for (const key of ["exp", "nbf", "iat"]) {
      expect(typeof claims[key], key).toBe("number");
    }
    expect(claims["iat"]).toBe(Math.floor(NOW.getTime() / 1000));
    expect(claims["exp"]).toBe(Math.floor(NOW.getTime() / 1000) + DEFAULT_SESSION_TOKEN_SECONDS);
  });

  it("always carries a tenant_id", () => {
    // A verified JWT with no `tenant_id` is bound to the caller's `x-tenant-id` header instead,
    // which is spoofable and needs no cooperation from the web proxy. Every per-tenant control in
    // the system -- the RLS context, the status gate, row filtering -- reads that value.
    const claims = decodeSegment(mint().token.split(".")[1]!);
    expect(claims["tenant_id"]).toBe(TENANT);
  });

  it("puts the user's row id in sub, unhashed", () => {
    // `subjectToUuid` passes a UUID through and sha256-hashes anything else into a v5 shape that
    // exists in no table, which would leave `principalId` pointing at nothing.
    const claims = decodeSegment(mint().token.split(".")[1]!);
    expect(claims["sub"]).toBe(USER);
  });

  it("carries exactly one scope, because only the first is read", () => {
    const claims = decodeSegment(mint({ role: "ap_clerk" }).token.split(".")[1]!);
    expect(claims["scope"]).toBe("ap_clerk");
    expect(String(claims["scope"]).split(" ")).toHaveLength(1);
  });

  it("backdates nbf, because clock skew is fixed at 30s and reachable by no flag", () => {
    const claims = decodeSegment(mint().token.split(".")[1]!);
    expect(Number(claims["iat"]) - Number(claims["nbf"])).toBe(TOKEN_NOT_BEFORE_SKEW_SECONDS);
    // 60 > 30, so a replica a few seconds ahead of the gateway cannot mint a token the gateway
    // immediately answers `not_yet_valid_token` for.
    expect(TOKEN_NOT_BEFORE_SKEW_SECONDS).toBeGreaterThan(30);
  });

  it("reports expiresAt as the ISO form of exp", () => {
    const minted = mint();
    expect(minted.expiresAt).toBe(new Date(minted.claims.exp * 1000).toISOString());
  });

  it("refuses a lifetime outside the bounds rather than clamping it", () => {
    for (const bad of [0, -1, MIN_SESSION_TOKEN_SECONDS - 1, MAX_SESSION_TOKEN_SECONDS + 1, 1.5]) {
      expect(() => mint({ lifetimeSeconds: bad }), String(bad)).toThrow(/lifetime must be/);
    }
    expect(() => mint({ lifetimeSeconds: MIN_SESSION_TOKEN_SECONDS })).not.toThrow();
    expect(() => mint({ lifetimeSeconds: MAX_SESSION_TOKEN_SECONDS })).not.toThrow();
  });

  it("signs with the SEED when the declared public key disagrees, which is why we derive", () => {
    // Measured: `signEd25519(seedA, pubB, m)` does not throw. Node builds the key from `d` and the
    // inconsistent `x` is silently discarded, so the signature verifies under A and not under B.
    // Left unchecked in the primitive on a measurement -- deriving the public half costs 0.099 ms
    // against a 0.133 ms signature, a 75% overhead on a function the forensic chain calls for every
    // audit append -- and unreachable here for a better reason than a check: `credential-auth-env`
    // DERIVES the public key from the seed, so the pair cannot be inconsistent in the first place.
    // This is the test that says so, rather than an assertion that it throws.
    const other = generateEd25519Keypair();
    const token = mint({ publicKeyBase64: other.publicKeyBase64 }).token;
    const [h, p, s] = token.split(".");
    const sigStd = Buffer.from(s!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "base64",
    );
    expect(verifyEd25519(KP.publicKeyBase64, sigStd, `${h!}.${p!}`)).toBe(true);
    expect(verifyEd25519(other.publicKeyBase64, sigStd, `${h!}.${p!}`)).toBe(false);
  });
});
