import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { PrincipalResolver, PrincipalResolverInput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import type { SessionStanding } from "./credential-store.js";
import {
  CachedSessionStandingDirectory,
  formatSessionStanding,
  sessionStandingRefusal,
  tokenSessionEpoch,
  withSessionStandingCheck,
  type SessionStandingDirectory,
  type SessionStandingRefusal,
} from "./session-standing.js";

const USER = "22222222-2222-4222-8222-222222222222";
const TENANT = "11111111-1111-4111-8111-111111111111";
const KID = "login-v1";

function person(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    principalId: USER,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "bearer_jwt",
    grantedScopes: ["erp_admin"],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-11-18T00:00:00.000Z",
    ...over,
  };
}

function inner(p: ResolvedPrincipal | null): PrincipalResolver {
  return { resolve: async () => p };
}

function directory(standing: SessionStanding | null, calls: string[] = []): SessionStandingDirectory {
  return {
    standingOf: async (userId: string) => {
      calls.push(userId);
      return standing;
    },
  };
}

function bearerInput(claims: Record<string, unknown>, kid = KID): PrincipalResolverInput {
  return {
    tenantId: TENANT,
    principalRef: USER,
    scopes: ["erp_admin"],
    authScheme: "bearer_jwt",
    bearer: { kid, claims },
  };
}

describe("tokenSessionEpoch", () => {
  it("reads an absent claim as zero, the generation every pre-claim token was minted against", () => {
    expect(tokenSessionEpoch({})).toBe(0);
    expect(tokenSessionEpoch({ sep: 4 })).toBe(4);
  });

  it("refuses a malformed claim rather than reading it leniently", () => {
    for (const bad of [-1, 1.5, "3", null, true]) expect(tokenSessionEpoch({ sep: bad })).toBeNull();
  });
});

describe("sessionStandingRefusal", () => {
  const active: SessionStanding = { status: "active", sessionEpoch: 2 };

  it("admits an active person whose token carries the current generation", () => {
    expect(sessionStandingRefusal({ standing: active, mintedHere: true, tokenEpoch: 2 })).toBeNull();
  });

  it("refuses a person whose meta.users.status is not active, whatever minted the token", () => {
    for (const status of ["suspended", "deleted"]) {
      for (const mintedHere of [true, false]) {
        expect(
          sessionStandingRefusal({ standing: { status, sessionEpoch: 2 }, mintedHere, tokenEpoch: 2 }),
        ).toBe("user_not_active");
      }
    }
  });

  it("refuses a session minted under an older generation, and under a newer one", () => {
    expect(sessionStandingRefusal({ standing: active, mintedHere: true, tokenEpoch: 1 })).toBe(
      "session_superseded",
    );
    expect(sessionStandingRefusal({ standing: active, mintedHere: true, tokenEpoch: 3 })).toBe(
      "session_superseded",
    );
    expect(sessionStandingRefusal({ standing: active, mintedHere: true, tokenEpoch: null })).toBe(
      "session_superseded",
    );
  });

  it("does not read the generation of a token this deployment did not mint", () => {
    expect(sessionStandingRefusal({ standing: active, mintedHere: false, tokenEpoch: null })).toBeNull();
  });

  it("refuses a session minted here whose user row is gone, and leaves a foreign one to the membership check", () => {
    expect(sessionStandingRefusal({ standing: null, mintedHere: true, tokenEpoch: 0 })).toBe(
      "user_unknown",
    );
    expect(sessionStandingRefusal({ standing: null, mintedHere: false, tokenEpoch: null })).toBeNull();
  });
});

describe("withSessionStandingCheck", () => {
  it("refuses a suspended person's session as principal_disabled and names why to the operator", async () => {
    const refused: [string, SessionStandingRefusal][] = [];
    const resolver = withSessionStandingCheck(inner(person()), {
      directory: directory({ status: "suspended", sessionEpoch: 0 }),
      loginKid: KID,
      onRefused: (u, r) => refused.push([u, r]),
    });
    expect(await resolver.resolve(bearerInput({ sep: 0 }))).toEqual({ refusedAs: "principal_disabled" });
    expect(refused).toEqual([[USER, "user_not_active"]]);
  });

  it("ends a session once its generation is superseded, and admits the next one", async () => {
    const standing: SessionStanding = { status: "active", sessionEpoch: 1 };
    const resolver = withSessionStandingCheck(inner(person()), {
      directory: directory(standing),
      loginKid: KID,
    });
    expect(await resolver.resolve(bearerInput({ sep: 0 }))).toEqual({ refusedAs: "principal_disabled" });
    expect(await resolver.resolve(bearerInput({ sep: 1 }))).toEqual(person());
  });

  it("reads the generation only from a token the deployment's own key signed", async () => {
    const resolver = withSessionStandingCheck(inner(person()), {
      directory: directory({ status: "active", sessionEpoch: 9 }),
      loginKid: KID,
    });
    expect(await resolver.resolve(bearerInput({}, "idp-key-1"))).toEqual(person());
    const noLogin = withSessionStandingCheck(inner(person()), {
      directory: directory({ status: "active", sessionEpoch: 9 }),
      loginKid: null,
    });
    expect(await noLogin.resolve(bearerInput({}, KID))).toEqual(person());
  });

  it("asks nothing about a credential that names no person", async () => {
    const calls: string[] = [];
    const resolver = withSessionStandingCheck(
      inner(person({ principalKind: "service_account", authScheme: "api_key_header" })),
      { directory: directory({ status: "suspended", sessionEpoch: 0 }, calls), loginKid: KID },
    );
    const input: PrincipalResolverInput = {
      tenantId: TENANT,
      principalRef: "k",
      scopes: ["erp_admin"],
      authScheme: "api_key_header",
    };
    expect((await resolver.resolve(input)) !== null).toBe(true);
    expect(calls).toEqual([]);
  });

  it("checks the status of an api-key that names a person", async () => {
    const resolver = withSessionStandingCheck(inner(person({ authScheme: "api_key_header" })), {
      directory: directory({ status: "suspended", sessionEpoch: 0 }),
      loginKid: KID,
    });
    const input: PrincipalResolverInput = {
      tenantId: TENANT,
      principalRef: "k",
      scopes: ["erp_admin"],
      authScheme: "api_key_header",
    };
    expect(await resolver.resolve(input)).toEqual({ refusedAs: "principal_disabled" });
  });

  it("propagates a directory failure rather than admitting", async () => {
    const resolver = withSessionStandingCheck(inner(person()), {
      directory: {
        standingOf: async () => {
          throw new Error("db down");
        },
      },
      loginKid: KID,
    });
    await expect(resolver.resolve(bearerInput({ sep: 0 }))).rejects.toThrow("db down");
  });

  it("passes an inner refusal and an unknown principal through untouched", async () => {
    const calls: string[] = [];
    for (const answer of [null, { refusedAs: "principal_locked" as const }]) {
      const resolver = withSessionStandingCheck({ resolve: async () => answer }, {
        directory: directory({ status: "active", sessionEpoch: 0 }, calls),
        loginKid: KID,
      });
      expect(await resolver.resolve(bearerInput({}))).toEqual(answer);
    }
    expect(calls).toEqual([]);
  });
});

describe("CachedSessionStandingDirectory", () => {
  it("serves within the TTL, re-reads after it, and forgets on demand", async () => {
    let ms = 0;
    const calls: string[] = [];
    const cache = new CachedSessionStandingDirectory(directory({ status: "active", sessionEpoch: 0 }, calls), {
      now: () => new Date(ms),
    });
    await cache.standingOf(USER);
    await cache.standingOf(USER.toUpperCase());
    expect(calls).toHaveLength(1);
    cache.forget(USER);
    await cache.standingOf(USER);
    expect(calls).toHaveLength(2);
    ms += 30_000;
    await cache.standingOf(USER);
    expect(calls).toHaveLength(3);
  });

  it("does not re-cache a read that was in flight when the act forgot the user", async () => {
    // The race the generation counter closes: a request reads the row, a sign-out commits and
    // forgets, and then the request's read lands. Its answer predates the sign-out, so caching it
    // would admit the ended session on this replica for a whole TTL.
    let epoch = 0;
    let release: (() => void) | null = null;
    let calls = 0;
    const cache = new CachedSessionStandingDirectory(
      {
        standingOf: async () => {
          calls += 1;
          const seen = epoch;
          if (calls === 1) await new Promise<void>((r) => (release = r));
          return { status: "active", sessionEpoch: seen };
        },
      },
      { now: () => new Date(0) },
    );
    const stale = cache.standingOf(USER);
    await Promise.resolve();
    epoch = 1;
    cache.forget(USER);
    (release as unknown as () => void)();
    expect(await stale).toEqual({ status: "active", sessionEpoch: 0 });
    expect(await cache.standingOf(USER)).toEqual({ status: "active", sessionEpoch: 1 });
    expect(calls).toBe(2);
  });

  it("propagates a first failure and serves the last answer through a later one, within the bound", async () => {
    let ms = 0;
    let fail = true;
    const errors: boolean[] = [];
    const cache = new CachedSessionStandingDirectory(
      {
        standingOf: async () => {
          if (fail) throw new Error("db down");
          return { status: "active", sessionEpoch: 0 };
        },
      },
      { now: () => new Date(ms), onRefreshError: (_u, _e, stale) => errors.push(stale) },
    );
    await expect(cache.standingOf(USER)).rejects.toThrow("db down");
    fail = false;
    await cache.standingOf(USER);
    fail = true;
    ms += 31_000;
    expect(await cache.standingOf(USER)).toEqual({ status: "active", sessionEpoch: 0 });
    ms += 10 * 60_000;
    await expect(cache.standingOf(USER)).rejects.toThrow("db down");
    expect(errors).toEqual([false, true, false]);
  });
});

describe("formatSessionStanding", () => {
  it("names the bound on another replica and, with a login, what ends a session", () => {
    const line = formatSessionStanding(30_000, KID);
    expect(line).toContain("within 30s on any other");
    expect(line).toContain("POST /v1/account/logout");
    expect(formatSessionStanding(30_000, null)).not.toContain("logout");
  });
});
