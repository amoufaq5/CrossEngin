import { hashPassword } from "@crossengin/crypto";
import { describe, expect, it, vi } from "vitest";

import {
  AUTH_TOKEN_PATH,
  AuthTokenRequestSchema,
  DEFAULT_LOGIN_LOCKOUT,
  LOGIN_REFUSALS,
  LOGIN_REFUSED_PROBLEM,
  MIN_LOGIN_LOCKOUT_ATTEMPTS,
  MIN_LOGIN_LOCKOUT_SECONDS,
  REFUSAL_COUNTS_AGAINST_LOCKOUT,
  buildAuthTokenInterceptor,
  isAuthTokenPath,
  parseLoginLockout,
  verifyLogin,
  type LoginOutcome,
} from "./auth-token-route.js";
import type { CredentialRecord, PostgresCredentialStore, TenantRef } from "./credential-store.js";

const PEPPER = "a-deployment-pepper-with-plenty-of-distinct-bytes-0123456789";
const PASSWORD = "correct horse battery staple";
const CHEAP = { n: 1024, r: 8, p: 1 };
const USER = "22222222-2222-4222-8222-222222222222";
const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-11T12:00:00.000Z");

interface StubState {
  readonly tenant?: TenantRef | null;
  readonly record?: CredentialRecord | null;
  readonly role?: string | null;
}

function stubStore(state: StubState): PostgresCredentialStore {
  return {
    // `in` rather than `??`, because an explicit `null` is one of the cases under test and `??`
    // would quietly replace it with the default -- the stub would then prove the opposite.
    resolveTenant: async () =>
      "tenant" in state ? state.tenant! : { tenantId: TENANT, status: "active" },
    findByEmail: async () => ("record" in state ? state.record! : null),
  } as unknown as PostgresCredentialStore;
}

async function activeRecord(over: Partial<CredentialRecord> = {}): Promise<CredentialRecord> {
  return {
    userId: USER,
    status: "active",
    credentialHash: await hashPassword(PASSWORD, PEPPER, { params: CHEAP }),
    failedAttempts: 0,
    lockedUntil: null,
    ...over,
  };
}

function run(state: StubState, password = PASSWORD): Promise<LoginOutcome> {
  return verifyLogin({
    request: { tenant: "acme", email: "a@example.test", password },
    store: stubStore(state),
    pepper: PEPPER,
    roleFor: async () => (state.role === undefined ? "erp_admin" : state.role),
    lockout: DEFAULT_LOGIN_LOCKOUT,
    now: NOW,
    scryptParams: CHEAP,
    tenantBlocksAccess: (status) => status !== "active",
  });
}

describe("AuthTokenRequestSchema", () => {
  it("accepts exactly the three fields", () => {
    expect(
      AuthTokenRequestSchema.safeParse({ tenant: "acme", email: "a@b.test", password: "x" })
        .success,
    ).toBe(true);
  });

  it("REFUSES a body naming a role", () => {
    // The sharpest thing `.strict()` buys here. The gateway takes a session's role from the
    // token's `scope` claim verbatim and consults no directory at request time, so a login route
    // that let a caller influence the role would hand them their own authorization. A silently
    // ignored extra field would be a one-line edit away from honouring it.
    const parsed = AuthTokenRequestSchema.safeParse({
      tenant: "acme",
      email: "a@b.test",
      password: "x",
      role: "platform_admin",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a tenant_id or scope smuggled into the body", () => {
    for (const extra of [{ tenant_id: TENANT }, { scope: "erp_admin" }, { sub: USER }]) {
      expect(
        AuthTokenRequestSchema.safeParse({
          tenant: "acme",
          email: "a@b.test",
          password: "x",
          ...extra,
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe("REFUSAL_COUNTS_AGAINST_LOCKOUT", () => {
  it("is total over the refusals", () => {
    expect(Object.keys(REFUSAL_COUNTS_AGAINST_LOCKOUT).sort()).toEqual([...LOGIN_REFUSALS].sort());
  });

  it("counts a wrong password and nothing else", () => {
    const counted = LOGIN_REFUSALS.filter((r) => REFUSAL_COUNTS_AGAINST_LOCKOUT[r]);
    expect(counted).toEqual(["password_mismatch"]);
  });

  it("does not count an unreadable hash, which would lock out a correct password", () => {
    expect(REFUSAL_COUNTS_AGAINST_LOCKOUT.credential_unreadable).toBe(false);
  });

  it("does not count an already-locked attempt, which would extend its own lock forever", () => {
    expect(REFUSAL_COUNTS_AGAINST_LOCKOUT.account_locked).toBe(false);
  });
});

describe("parseLoginLockout", () => {
  it("refuses below the floor rather than raising it", () => {
    // ADR-0332's rule. A threshold of 1 locks a real user out on one typo, and silently clamping
    // would leave the deployment believing it configured something it did not.
    for (const bad of [0, 1, 2, -1, 1.5]) {
      expect(() => parseLoginLockout(bad, 900), String(bad)).toThrow(/>= 3/);
    }
    expect(parseLoginLockout(MIN_LOGIN_LOCKOUT_ATTEMPTS, MIN_LOGIN_LOCKOUT_SECONDS)).toEqual({
      attempts: MIN_LOGIN_LOCKOUT_ATTEMPTS,
      seconds: MIN_LOGIN_LOCKOUT_SECONDS,
    });
  });

  it("refuses a window below the floor", () => {
    expect(() => parseLoginLockout(10, 5)).toThrow(/>= 30/);
  });

  it("defaults to a BOUNDED lock", () => {
    // Bounded and not permanent, which is the difference from the fax counter: that one is
    // permanent for a mechanical reason (its store only ever DO NOTHINGs), and a lockout keyed on
    // an attacker-supplied email is a denial-of-service weapon they aim. A window that lapses is
    // what keeps "anyone can lock out any known user" from meaning "forever".
    expect(DEFAULT_LOGIN_LOCKOUT.seconds).toBeGreaterThan(0);
    expect(DEFAULT_LOGIN_LOCKOUT.seconds).toBeLessThanOrEqual(3600);
  });
});

describe("verifyLogin", () => {
  it("admits a correct password and reports the membership's role", async () => {
    const outcome = await run({ record: await activeRecord() });
    expect(outcome).toMatchObject({ ok: true, userId: USER, tenantId: TENANT, role: "erp_admin" });
  });

  it("refuses a wrong password", async () => {
    const outcome = await run({ record: await activeRecord() }, "wrong");
    expect(outcome).toMatchObject({ ok: false, refusal: "password_mismatch" });
  });

  it("a null credential hash is NOT a pass", async () => {
    // Every existing row on every deployment is in this state, so an `if` that ended on the wrong
    // branch would log in every user with any password.
    const outcome = await run({ record: await activeRecord({ credentialHash: null }) });
    expect(outcome).toMatchObject({ ok: false, refusal: "no_credential_set" });
  });

  it("an empty-string hash is NOT a pass either", async () => {
    const outcome = await run({ record: await activeRecord({ credentialHash: "" }) });
    expect(outcome.ok).toBe(false);
  });

  it("reports an unreadable hash as its own refusal", async () => {
    const outcome = await run({ record: await activeRecord({ credentialHash: "a".repeat(64) }) });
    expect(outcome).toMatchObject({ ok: false, refusal: "credential_unreadable" });
  });

  it("refuses a suspended user, an unknown tenant and a blocked tenant", async () => {
    expect(await run({ record: await activeRecord({ status: "suspended" }) })).toMatchObject({
      refusal: "user_not_active",
    });
    expect(await run({ tenant: null, record: await activeRecord() })).toMatchObject({
      refusal: "tenant_unknown",
    });
    expect(
      await run({ tenant: { tenantId: TENANT, status: "suspended" }, record: await activeRecord() }),
    ).toMatchObject({ refusal: "tenant_blocks_access" });
  });

  it("refuses a correct password with no active membership", async () => {
    const outcome = await run({ record: await activeRecord(), role: null });
    expect(outcome).toMatchObject({ ok: false, refusal: "no_active_membership" });
  });

  it("refuses while locked, and treats an unparseable lock as locked", async () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(await run({ record: await activeRecord({ lockedUntil: future }) })).toMatchObject({
      refusal: "account_locked",
    });
    // Fail closed: the column is written by one statement from the database clock, so a value this
    // cannot read means something unexpected wrote it.
    expect(await run({ record: await activeRecord({ lockedUntil: "not-a-date" }) })).toMatchObject({
      refusal: "account_locked",
    });
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    expect(await run({ record: await activeRecord({ lockedUntil: past }) })).toMatchObject({
      ok: true,
    });
  });

  it("verifies the password BEFORE reading the membership", async () => {
    // Ordering is the whole point: the other way round, a caller holding no password could learn
    // whether a user is a member of a named tenant, which is a directory oracle on an
    // unauthenticated route.
    const roleFor = vi.fn(async () => "erp_admin");
    await verifyLogin({
      request: { tenant: "acme", email: "a@example.test", password: "wrong" },
      store: stubStore({ record: await activeRecord() }),
      pepper: PEPPER,
      roleFor,
      lockout: DEFAULT_LOGIN_LOCKOUT,
      now: NOW,
      scryptParams: CHEAP,
      tenantBlocksAccess: () => false,
    });
    expect(roleFor).not.toHaveBeenCalled();
  });

  it("spends password work on every refusal that precedes a verification", async () => {
    // The timing equaliser. Each of these paths could answer in under a millisecond and would then
    // be an account enumerator; the derivation is what makes them cost what a real account costs.
    const cases: readonly StubState[] = [
      { tenant: null, record: null },
      { tenant: { tenantId: TENANT, status: "suspended" } },
      { record: null },
      { record: await activeRecord({ status: "suspended" }) },
      { record: await activeRecord({ credentialHash: null }) },
      {
        record: await activeRecord({
          lockedUntil: new Date(NOW.getTime() + 60_000).toISOString(),
        }),
      },
    ];
    // A real verification at these parameters is the baseline; every refusal must be of the same
    // order rather than instant. Measured as a floor, not an equality -- a tight equality would be
    // a flaky test on a shared vCPU.
    const t0 = process.hrtime.bigint();
    await run({ record: await activeRecord() }, "wrong");
    const verifyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    for (const [i, state] of cases.entries()) {
      const t = process.hrtime.bigint();
      await run(state);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      expect(ms, `case ${i.toString()} answered in ${ms.toFixed(2)}ms vs ${verifyMs.toFixed(2)}ms`)
        .toBeGreaterThan(verifyMs / 10);
    }
  });

  it("re-hashes on success when the stored hash is below the current parameters", async () => {
    const stale = await hashPassword(PASSWORD, PEPPER, { params: { n: 512, r: 8, p: 1 } });
    const outcome = await run({ record: await activeRecord({ credentialHash: stale }) });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.rehashTo).not.toBeNull();
      // Upgraded to the parameters the equaliser derives under, which is what keeps
      // `spendPasswordWork`'s assumption true as a deployment raises its cost.
      expect(outcome.rehashTo).toMatch(/^scrypt\$1024\$/);
    }
  });

  it("does not re-hash a hash already at the current parameters", async () => {
    const outcome = await run({ record: await activeRecord() });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.rehashTo).toBeNull();
  });
});

describe("buildAuthTokenInterceptor", () => {
  const minted = { token: "tok", expiresAt: "2026-10-11T13:00:00.000Z" };

  function interceptor(over: Partial<Parameters<typeof buildAuthTokenInterceptor>[0]> = {}) {
    return buildAuthTokenInterceptor({
      verify: async () => ({ ok: true, userId: USER, tenantId: TENANT, role: "erp_admin", rehashTo: null }),
      mint: () => minted,
      onSuccess: async () => undefined,
      onFailure: async () => undefined,
      ...over,
    });
  }

  const body = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
  const req = { method: "POST", url: AUTH_TOKEN_PATH, headers: {} };
  const parse = (r: { body: Uint8Array | null }): Record<string, unknown> =>
    JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array())) as Record<string, unknown>;

  it("matches only its own path", () => {
    expect(isAuthTokenPath(AUTH_TOKEN_PATH)).toBe(true);
    expect(isAuthTokenPath(`${AUTH_TOKEN_PATH}?x=1`)).toBe(true);
    expect(isAuthTokenPath("/v1/auth/tokens")).toBe(false);
    expect(isAuthTokenPath("/v1/employees")).toBe(false);
  });

  it("falls through for a path that is not ours", async () => {
    const res = await interceptor()({ ...req, url: "/v1/employees" }, null);
    expect(res).toBeNull();
  });

  it("mints on success and never caches", async () => {
    const res = await interceptor()(
      req,
      body({ tenant: "acme", email: "a@b.test", password: "x" }),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers["cache-control"]).toBe("no-store");
    expect(parse(res!)).toEqual({
      token: "tok",
      expiresAt: minted.expiresAt,
      tenantId: TENANT,
      role: "erp_admin",
    });
  });

  it("answers ONE body for every refusal", async () => {
    // The property the whole module is built around: the caller cannot tell an unknown email from
    // a wrong password from a suspended tenant.
    for (const refusal of LOGIN_REFUSALS) {
      if (refusal === "malformed_request") continue;
      const res = await interceptor({
        verify: async () => ({ ok: false, refusal, userId: USER, detail: `internal: ${refusal}` }),
      })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
      expect(res?.status, refusal).toBe(401);
      expect(parse(res!), refusal).toEqual(LOGIN_REFUSED_PROBLEM);
    }
  });

  it("never puts the internal detail in the response", async () => {
    const res = await interceptor({
      verify: async () => ({
        ok: false,
        refusal: "no_active_membership",
        userId: USER,
        detail: `user ${USER} has no active membership in tenant ${TENANT}`,
      }),
    })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    const text = new TextDecoder().decode(res?.body ?? new Uint8Array());
    expect(text).not.toContain(USER);
    expect(text).not.toContain(TENANT);
  });

  it("counts a wrong password and nothing else", async () => {
    const onFailure = vi.fn(async () => undefined);
    for (const refusal of ["password_mismatch", "credential_unreadable", "account_locked"] as const) {
      await interceptor({
        onFailure,
        verify: async () => ({ ok: false, refusal, userId: USER, detail: "" }),
      })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    }
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(USER, "password_mismatch");
  });

  it("400s a malformed body without naming which field was wrong", async () => {
    const res = await interceptor()(req, body({ tenant: "acme" }));
    expect(res?.status).toBe(400);
    const text = new TextDecoder().decode(res?.body ?? new Uint8Array());
    // The body names the EXPECTED SHAPE, which is public API documentation, and must not name
    // which field was wrong. A 422 carrying zod's issue list is right on an authenticated write
    // surface and a probe here: "password: too_big" and "email: invalid_type" are different
    // answers to the same unauthenticated request.
    expect(text).toContain("expects {tenant, email, password}");
    expect(text).not.toContain("invalid_type");
    expect(text).not.toContain("too_big");
    expect(text).not.toContain("Required");
    expect(text).not.toContain("issues");
    // And the same body for two different malformations, so neither can be told from the other.
    const other = await interceptor()(req, body({ tenant: "a", email: "b@c.test", password: "x".repeat(2000) }));
    expect(new TextDecoder().decode(other?.body ?? new Uint8Array())).toBe(text);
  });

  it("405s a GET rather than falling through to the gateway", async () => {
    const res = await interceptor()({ ...req, method: "GET" }, null);
    expect(res?.status).toBe(405);
  });

  it("answers 503 and not 401 when the store throws", async () => {
    // 503 because a store failure is not a statement about the credential, and because a 401
    // would send a correct password away for good while a 503 invites the retry that will work.
    const onError = vi.fn();
    const res = await interceptor({
      onError,
      verify: async () => {
        throw new Error("connection refused to db-host-1 as app_user");
      },
    })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    expect(res?.status).toBe(503);
    const text = new TextDecoder().decode(res?.body ?? new Uint8Array());
    // The dispatch stage would otherwise echo up to 480 characters of this upstream.
    expect(text).not.toContain("db-host-1");
    expect(text).not.toContain("app_user");
    expect(onError).toHaveBeenCalled();
  });

  it("still mints when recording the success fails", async () => {
    // The password was correct. Refusing now would deny a legitimate login to protect a counter
    // reset.
    const onError = vi.fn();
    const res = await interceptor({
      onError,
      onSuccess: async () => {
        throw new Error("update failed");
      },
    })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    expect(res?.status).toBe(200);
    expect(onError).toHaveBeenCalled();
  });

  it("still refuses when recording the failure fails", async () => {
    const onError = vi.fn();
    const res = await interceptor({
      onError,
      verify: async () => ({
        ok: false,
        refusal: "password_mismatch",
        userId: USER,
        detail: "",
      }),
      onFailure: async () => {
        throw new Error("update failed");
      },
    })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    expect(res?.status).toBe(401);
    expect(onError).toHaveBeenCalled();
  });
});
