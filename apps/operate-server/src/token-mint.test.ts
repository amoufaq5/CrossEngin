import { ed25519PublicKeyFromSeed, generateEd25519Keypair, verifyEd25519 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { principalRolesFromScopes } from "./principals.js";
import {
  DEFAULT_SESSION_TOKEN_SECONDS,
  MAX_SESSION_TOKEN_SECONDS,
  MIN_SESSION_TOKEN_SECONDS,
  SCOPE_DELIMITER,
  TOKEN_NOT_BEFORE_SKEW_SECONDS,
  dedupedSessionRoles,
  mintSessionToken,
  roleNameHasNoWhitespace,
  roleNameIsScopeSafe,
  sessionScope,
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
    roles: { primaryRole: "erp_admin", secondaryRoles: [] },
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

  it("carries the membership's whole role list, primary first", () => {
    // This test used to assert the opposite — "carries exactly one scope, because only the first
    // is read" — which was a true statement about `principalRoles` and the producer half of
    // ADR-0369's defect. Both halves moved together: the reader returns the tail as
    // `secondaryRoles` and the claim carries it.
    const claims = decodeSegment(
      mint({ roles: { primaryRole: "ap_clerk", secondaryRoles: ["hr_manager", "controller"] } })
        .token.split(".")[1]!,
    );
    expect(claims["scope"]).toBe("ap_clerk hr_manager controller");
    // Primary first is the property every reader depends on, so it is asserted as a position and
    // not only as membership.
    expect(String(claims["scope"]).split(" ")[0]).toBe("ap_clerk");
  });

  it("still carries one scope for a membership that grants no secondary role", () => {
    const claims = decodeSegment(mint().token.split(".")[1]!);
    expect(claims["scope"]).toBe("erp_admin");
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

describe("sessionScope", () => {
  it("joins primary first and preserves secondary order", () => {
    expect(
      sessionScope({ primaryRole: "ap_clerk", secondaryRoles: ["hr_manager", "controller"] }),
    ).toBe("ap_clerk hr_manager controller");
  });

  it("de-duplicates, because a membership may name its primary in secondary_roles", () => {
    // Every downstream reader already treats the list as a set — `resolveEffectiveRoles` visits a
    // `Set`, `UiViewer.roles` de-dupes, the platform gates are `.some` — so the duplicate would
    // change no answer. It would only make the token say the same thing twice.
    expect(
      sessionScope({ primaryRole: "erp_admin", secondaryRoles: ["erp_admin", "hr_manager"] }),
    ).toBe("erp_admin hr_manager");
    expect(sessionScope({ primaryRole: "a", secondaryRoles: ["b", "b", "c", "b"] })).toBe("a b c");
  });

  it("joins on the one character the gateway splits on", () => {
    // The fence below and the join must be about the same character: a refusal against a delimiter
    // spelled separately from the delimiter is a refusal against a different one.
    expect(SCOPE_DELIMITER).toBe(" ");
    expect(sessionScope({ primaryRole: "a", secondaryRoles: ["b"] }).split(SCOPE_DELIMITER)).toEqual(
      ["a", "b"],
    );
  });

  it("REFUSES a role name carrying whitespace, in either position", () => {
    // `RoleNameSchema` is `z.string().min(1)` and `ManifestSchema.roles` is keyed by `z.string()`,
    // so "hr manager" is a legal role name — and the claim is space-delimited, so it would arrive
    // as ["hr", "manager"]: two roles, neither declared, in place of the one that was granted.
    for (const roles of [
      { primaryRole: "hr manager", secondaryRoles: [] },
      { primaryRole: "ap_clerk", secondaryRoles: ["hr manager"] },
      { primaryRole: "ap_clerk", secondaryRoles: ["ok", "with\ttab"] },
      { primaryRole: " leading", secondaryRoles: [] },
      { primaryRole: "trailing ", secondaryRoles: [] },
      { primaryRole: "\n", secondaryRoles: [] },
    ]) {
      expect(() => sessionScope(roles), JSON.stringify(roles)).toThrow(/space-delimited/);
    }
  });

  it("REFUSES an empty role name, which would vanish from the claim rather than be read wrongly", () => {
    // `split(" ").filter(s => s.length > 0)` drops it, so an empty primary would silently promote
    // the first secondary — a role nobody granted as the primary.
    expect(() => sessionScope({ primaryRole: "", secondaryRoles: ["hr_manager"] })).toThrow(
      /cannot be carried by a session/,
    );
    expect(() => sessionScope({ primaryRole: "ap_clerk", secondaryRoles: [""] })).toThrow(
      /cannot be carried by a session/,
    );
  });

  it("names the offending role in the refusal and nothing else", () => {
    expect(() => sessionScope({ primaryRole: "hr manager", secondaryRoles: [] })).toThrow(
      /"hr manager"/,
    );
  });

  it("round-trips through the reader: what the mint composes is what principalRoles decomposes", () => {
    // The property the two halves of ADR-0369 share, asserted across them rather than within
    // either. `sessionScope` composes the claim and `principalRolesFromScopes` reads it back; a
    // change to one that the other does not follow fails here.
    for (const roles of [
      { primaryRole: "erp_admin", secondaryRoles: [] },
      { primaryRole: "ap_clerk", secondaryRoles: ["hr_manager"] },
      { primaryRole: "ap_clerk", secondaryRoles: ["hr_manager", "controller", "erp_viewer"] },
    ]) {
      const scopes = sessionScope(roles).split(SCOPE_DELIMITER);
      expect(principalRolesFromScopes(scopes), JSON.stringify(roles)).toEqual(roles);
    }
  });

  it("round-trips a de-duplicated list to the de-duplicated reading, not to the input", () => {
    // The one case where the round trip is deliberately not the identity: the claim is the set,
    // so reading it back answers the set and not the list that was handed in.
    const scopes = sessionScope({
      primaryRole: "erp_admin",
      secondaryRoles: ["erp_admin", "hr_manager"],
    }).split(SCOPE_DELIMITER);
    expect(principalRolesFromScopes(scopes)).toEqual({
      primaryRole: "erp_admin",
      secondaryRoles: ["hr_manager"],
    });
  });
});

describe("the fence against the gateway's own reader", () => {
  it("pins the delimiter against the expression runtime.ts actually splits on", () => {
    // ADR-0362's rule: a test comparing a rule against a derivation of itself written in the test
    // asserts agreement with nothing. The round-trip tests above split with
    // `.split(SCOPE_DELIMITER)` and omit the `.filter((s) => s.length > 0)` the gateway applies, so
    // they would not notice the gateway moving to `/\s+/` or to `scp`. The agreement that matters
    // is with `packages/api-gateway-runtime/src/runtime.ts`, which this package cannot import
    // without a cycle — so it is pinned by reading that file as text, which is
    // `manifest-event-names.ts`' relationship to `META_TABLES`.
    const runtime = readFileSync(
      resolve(import.meta.dirname, "../../../packages/api-gateway-runtime/src/runtime.ts"),
      "utf8",
    );
    expect(runtime).toContain('scope.split(" ").filter((s: string) => s.length > 0)');
    // And the constant this module joins on is that same character, so the two agree today.
    expect(SCOPE_DELIMITER).toBe(" ");
  });

  it("refuses only what that expression would break, and errs wide deliberately", () => {
    // U+0020 is the ONLY character that breaks the round trip, so the `/\s/` fence is a
    // conservative superset: a tab, an NBSP, an ideographic space and a BOM all survive
    // `split(" ")` and are refused anyway. Measured and stated, because the comment on
    // SCOPE_DELIMITER used to claim the fence was derived from the delimiter — it is not.
    const breaksTheRoundTrip = (name: string): boolean =>
      `a${SCOPE_DELIMITER}${name}`.split(" ").filter((s) => s.length > 0).length !== 2;
    for (const name of ["hr manager"]) {
      expect(breaksTheRoundTrip(name), name).toBe(true);
      expect(roleNameHasNoWhitespace(name), name).toBe(false);
    }
    for (const name of ["hr\tmanager", "hr manager", "hr　manager", "hr﻿manager"]) {
      // Would have survived; refused anyway. Wide, and wide is the safe direction.
      expect(breaksTheRoundTrip(name), name).toBe(false);
      expect(roleNameHasNoWhitespace(name), name).toBe(false);
    }
    // And the fence is not so wide that it catches an ordinary name: `+` needs no escaping here,
    // because the claim is a JSON string rather than a form body.
    for (const name of ["hr+manager", "hr-manager", "hr.manager", "HR_Manager"]) {
      expect(roleNameHasNoWhitespace(name), name).toBe(true);
    }
  });

  it("splits the predicate so a zod field does not answer emptiness twice", () => {
    // `roleNameIsScopeSafe` is total for the mint, which has no `.min(1)` in front of it;
    // `roleNameHasNoWhitespace` is what a zod field refines on, because a failing `.min(1)` marks
    // the result dirty rather than aborting it and the total form made `""` come back carrying a
    // sentence about whitespace it does not contain.
    expect(roleNameIsScopeSafe("")).toBe(false);
    expect(roleNameHasNoWhitespace("")).toBe(true);
    expect(roleNameIsScopeSafe("ok")).toBe(true);
  });
});

describe("dedupedSessionRoles", () => {
  it("answers what the claim will carry, so the login body cannot misstate the session", () => {
    // The one case where the row and the claim diverge, which was live on the first pass: the body
    // echoed the row and claimed a secondary role the token does not carry.
    expect(
      dedupedSessionRoles({ primaryRole: "erp_admin", secondaryRoles: ["erp_admin", "hr_manager"] }),
    ).toEqual({ primaryRole: "erp_admin", secondaryRoles: ["hr_manager"] });
  });

  it("agrees with sessionScope by construction", () => {
    for (const roles of [
      { primaryRole: "a", secondaryRoles: [] },
      { primaryRole: "a", secondaryRoles: ["a", "b", "b", "c"] },
    ]) {
      const d = dedupedSessionRoles(roles);
      expect(sessionScope(roles)).toBe([d.primaryRole, ...d.secondaryRoles].join(SCOPE_DELIMITER));
    }
  });

  it("carries the same refusal, because the fence and the dedup are one pass", () => {
    expect(() => dedupedSessionRoles({ primaryRole: "hr manager", secondaryRoles: [] })).toThrow(
      /space-delimited/,
    );
  });
});
