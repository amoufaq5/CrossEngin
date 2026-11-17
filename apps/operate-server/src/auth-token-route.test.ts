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
import { LoginAdmission } from "./login-admission.js";
import type { SessionRoles } from "./token-mint.js";

const PEPPER = "a-deployment-pepper-with-plenty-of-distinct-bytes-0123456789";
const PASSWORD = "correct horse battery staple";
const CHEAP = { n: 1024, r: 8, p: 1 };
const USER = "22222222-2222-4222-8222-222222222222";
const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-11T12:00:00.000Z");

interface StubState {
  readonly tenant?: TenantRef | null;
  readonly record?: CredentialRecord | null;
  readonly roles?: SessionRoles | null;
  /** What `reserveAttempt` answers. Defaults to reserved. */
  readonly reserve?: boolean;
  /** Every reservation call and release call, in order. */
  readonly calls?: string[];
  readonly releaseThrows?: boolean;
}

function stubStore(state: StubState): PostgresCredentialStore {
  return {
    // `in` rather than `??`, because an explicit `null` is one of the cases under test and `??`
    // would quietly replace it with the default -- the stub would then prove the opposite.
    resolveTenant: async () =>
      "tenant" in state ? state.tenant! : { tenantId: TENANT, status: "active" },
    findByEmail: async () => ("record" in state ? state.record! : null),
    reserveAttempt: async () => {
      state.calls?.push("reserve");
      return state.reserve === false
        ? { reserved: false }
        : { reserved: true, failedAttempts: 1, lockedUntil: null };
    },
    releaseAttempt: async () => {
      state.calls?.push("release");
      if (state.releaseThrows === true) throw new Error("update failed");
    },
  } as unknown as PostgresCredentialStore;
}

/**
 * A store whose reservation behaves as the SQL does: one atomic step per call, admitting only while
 * unlocked, restarting the count once a lock has expired. Used to test `verifyLogin`'s ordering --
 * the store's own atomicity is the live run's subject, not this fake's.
 */
function reservingStore(
  record: CredentialRecord,
  clock: { ms: number },
): { store: PostgresCredentialStore; state: { count: number; lockedUntilMs: number | null } } {
  const state = { count: 0, lockedUntilMs: null as number | null };
  const store = {
    resolveTenant: async () => ({ tenantId: TENANT, status: "active" }),
    findByEmail: async () => ({
      ...record,
      failedAttempts: state.count,
      lockedUntil: state.lockedUntilMs === null ? null : new Date(state.lockedUntilMs).toISOString(),
    }),
    reserveAttempt: async (_u: string, attempts: number, seconds: number) => {
      if (state.lockedUntilMs !== null && state.lockedUntilMs > clock.ms) return { reserved: false };
      state.count = state.lockedUntilMs === null ? state.count + 1 : 1;
      state.lockedUntilMs = state.count >= attempts ? clock.ms + seconds * 1000 : null;
      return { reserved: true, failedAttempts: state.count, lockedUntil: null };
    },
    releaseAttempt: async (_u: string, attempts: number) => {
      state.count = Math.max(state.count - 1, 0);
      if (state.count < attempts) state.lockedUntilMs = null;
    },
  } as unknown as PostgresCredentialStore;
  return { store, state };
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
    roleFor: async () =>
      state.roles === undefined ? { primaryRole: "erp_admin", secondaryRoles: [] } : state.roles,
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
  it("admits a correct password and reports the membership's roles", async () => {
    const outcome = await run({ record: await activeRecord() });
    expect(outcome).toMatchObject({
      ok: true,
      userId: USER,
      tenantId: TENANT,
      roles: { primaryRole: "erp_admin", secondaryRoles: [] },
    });
  });

  it("carries the membership's secondary roles through to the outcome", async () => {
    // ADR-0369's producer half. This returned `membership.primaryRole` alone, so a secondary role
    // an operator had granted was dropped here and could reach no authorization decision however
    // many readers downstream were ready to spread it.
    const outcome = await run({
      record: await activeRecord(),
      roles: { primaryRole: "ap_clerk", secondaryRoles: ["hr_manager", "controller"] },
    });
    expect(outcome).toMatchObject({
      ok: true,
      roles: { primaryRole: "ap_clerk", secondaryRoles: ["hr_manager", "controller"] },
    });
  });

  it("refuses a role the scope claim cannot carry, rather than letting the mint throw", async () => {
    // The backstop was worse than the fault: `sessionScope`'s throw escaped `ctx.mint(outcome)`
    // uncaught and the login answered a 500 carrying the exception's message — on the one route
    // whose design is that every refusal looks identical, with a status clients retry for a
    // condition no retry fixes. Found by the live run, because every other test supplies a
    // well-formed list.
    for (const roles of [
      { primaryRole: "hr manager", secondaryRoles: [] },
      { primaryRole: "erp_admin", secondaryRoles: ["hr manager"] },
      { primaryRole: "erp_admin", secondaryRoles: ["ok", "\tbad"] },
    ]) {
      const outcome = await run({ record: await activeRecord(), roles });
      expect(outcome, JSON.stringify(roles)).toMatchObject({
        ok: false,
        refusal: "membership_role_unusable",
      });
      // The detail names the role for the operator and nothing about the credential.
      if (!outcome.ok) expect(outcome.detail).toMatch(/scope claim cannot carry/);
    }
  });

  it("does not count an unusable membership role against the lockout", () => {
    // The password was correct, so counting it would lock a user out of an account whose
    // credential they hold for a defect they cannot fix.
    expect(REFUSAL_COUNTS_AGAINST_LOCKOUT["membership_role_unusable"]).toBe(false);
  });

  it("refuses a membership whose primary role is empty, secondary roles notwithstanding", async () => {
    // The primary is what makes a membership a session: with none, the mint has nothing to put
    // first and `principalRoles` would read the first secondary as the primary — promoting a role
    // nobody granted as such.
    const outcome = await run({
      record: await activeRecord(),
      roles: { primaryRole: "", secondaryRoles: ["hr_manager"] },
    });
    expect(outcome).toMatchObject({ ok: false, refusal: "no_active_membership" });
  });

  it("refuses a wrong password", async () => {
    const outcome = await run({ record: await activeRecord() }, "wrong");
    expect(outcome).toMatchObject({ ok: false, refusal: "password_mismatch" });
  });

  it("carries the counted attempt on a wrong password, and on no other refusal", async () => {
    const mismatch = await run({ record: await activeRecord() }, "wrong");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.countedAttempt?.tenantId).toBe(TENANT);
      expect(mismatch.countedAttempt?.failedAttempts).toBeGreaterThan(0);
    }
    const noMembership = await run({ record: await activeRecord(), roles: null });
    expect(noMembership).toMatchObject({ ok: false, refusal: "no_active_membership" });
    if (!noMembership.ok) expect(noMembership.countedAttempt).toBeUndefined();
    const unknownUser = await run({ record: null });
    expect(unknownUser).toMatchObject({ ok: false, refusal: "user_unknown" });
    if (!unknownUser.ok) expect(unknownUser.countedAttempt).toBeUndefined();
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
    const outcome = await run({ record: await activeRecord(), roles: null });
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
    const roleFor = vi.fn(async () => ({ primaryRole: "erp_admin", secondaryRoles: [] }));
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

  it("spends password work on every refusal, including the one that follows a verification", async () => {
    // The timing equaliser. Each of these paths could answer in under a millisecond and would then
    // be an account enumerator; the derivation is what makes them cost what a real account costs.
    //
    // The title said "every refusal that **precedes** a verification" until ADR-0398, and that
    // scoping is exactly how the gap survived: `credential_unreadable` *follows* the verification,
    // because `verifyPassword` answers `unreadable_hash` out of `parsePasswordHash` before deriving
    // anything, so it was the one refusal on this route that answered instantly. A test whose title
    // names a subset covers a subset.
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
      // `credential_unreadable`, both causes. The first is a shape the parse has always refused
      // (N is not a power of two); the second is one ADR-0398 added to that arm, which is why the
      // oracle had to close in the same change rather than be left wider than it was found.
      { record: await activeRecord({ credentialHash: `scrypt$1000$8$1$${"a".repeat(32)}$${"b".repeat(128)}` }) },
      { record: await activeRecord({ credentialHash: `scrypt$32768$8$512$${"a".repeat(32)}$${"b".repeat(128)}` }) },
      // Locked by a concurrent attempt between the read and the reservation.
      { record: await activeRecord(), reserve: false },
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

  describe("the reservation", () => {
    it("is taken BEFORE the password is verified, and kept for a wrong one", async () => {
      const calls: string[] = [];
      const outcome = await run({ record: await activeRecord(), calls }, "wrong");
      expect(outcome).toMatchObject({ refusal: "password_mismatch" });
      expect(calls).toEqual(["reserve"]);
    });

    it("is given back for a correct password the login then refuses", async () => {
      // `REFUSAL_COUNTS_AGAINST_LOCKOUT` answers false for both, and it is the map that decides.
      for (const roles of [null, { primaryRole: "hr manager", secondaryRoles: [] }]) {
        const calls: string[] = [];
        const outcome = await run({ record: await activeRecord(), roles, calls });
        expect(outcome.ok, JSON.stringify(roles)).toBe(false);
        expect(calls, JSON.stringify(roles)).toEqual(["reserve", "release"]);
      }
    });

    it("is not released on success, which the caller's onSuccess clears outright", async () => {
      const calls: string[] = [];
      expect((await run({ record: await activeRecord(), calls })).ok).toBe(true);
      expect(calls).toEqual(["reserve"]);
    });

    it("is never taken for an unreadable hash, a locked account or an unknown user", async () => {
      for (const state of [
        { record: await activeRecord({ credentialHash: "a".repeat(64) }) },
        { record: await activeRecord({ lockedUntil: new Date(NOW.getTime() + 60_000).toISOString() }) },
        { record: null },
        { record: await activeRecord({ status: "suspended" }) },
      ] as const) {
        const calls: string[] = [];
        await run({ ...state, calls });
        expect(calls, JSON.stringify(state.record?.credentialHash ?? state.record)).toEqual([]);
      }
    });

    it("refuses as locked, without verifying, when the reservation is refused", async () => {
      // A wrong password here would answer `password_mismatch` if it were verified; a correct one
      // would answer ok. Both answer locked, so neither was evaluated.
      for (const password of [PASSWORD, "wrong"]) {
        const outcome = await run({ record: await activeRecord(), reserve: false }, password);
        expect(outcome, password).toMatchObject({ ok: false, refusal: "account_locked" });
      }
    });

    it("still refuses, and does not throw, when giving a reservation back fails", async () => {
      const outcome = await run({ record: await activeRecord(), roles: null, releaseThrows: true });
      expect(outcome).toMatchObject({ ok: false, refusal: "no_active_membership" });
    });

    it("bounds CONCURRENT wrong guesses at the threshold", async () => {
      // L25. Counted after the verification, all 40 were evaluated whatever the threshold; counted
      // before it, at most `attempts` are, and the rest are refused as locked without a derivation.
      const clock = { ms: NOW.getTime() };
      const { store } = reservingStore(await activeRecord(), clock);
      const lockout = { attempts: 10, seconds: 900 };
      const outcomes = await Promise.all(
        Array.from({ length: 40 }, () =>
          verifyLogin({
            request: { tenant: "acme", email: "a@example.test", password: "wrong" },
            store,
            pepper: PEPPER,
            roleFor: async () => ({ primaryRole: "erp_admin", secondaryRoles: [] }),
            lockout,
            now: NOW,
            scryptParams: CHEAP,
            tenantBlocksAccess: () => false,
          }),
        ),
      );
      const evaluated = outcomes.filter((o) => !o.ok && o.refusal === "password_mismatch").length;
      expect(evaluated).toBe(10);
      expect(outcomes.filter((o) => !o.ok && o.refusal === "account_locked")).toHaveLength(30);
    });

    it("does not let one wrong guess after the window re-lock the account", async () => {
      // L26. The count continued across windows, so after a lock lapsed a single wrong guess put it
      // back over the threshold and the correct password was refused -- for ever, at one guess per
      // window.
      const clock = { ms: NOW.getTime() };
      const { store, state } = reservingStore(await activeRecord(), clock);
      const lockout = { attempts: 10, seconds: 900 };
      const attempt = (password: string): Promise<LoginOutcome> =>
        verifyLogin({
          request: { tenant: "acme", email: "a@example.test", password },
          store,
          pepper: PEPPER,
          roleFor: async () => ({ primaryRole: "erp_admin", secondaryRoles: [] }),
          lockout,
          now: new Date(clock.ms),
          scryptParams: CHEAP,
          tenantBlocksAccess: () => false,
        });
      for (let i = 0; i < 10; i++) await attempt("wrong");
      expect(state.lockedUntilMs).not.toBeNull();
      expect(await attempt(PASSWORD)).toMatchObject({ refusal: "account_locked" });
      clock.ms += 901_000;
      expect(await attempt("wrong-again")).toMatchObject({ refusal: "password_mismatch" });
      expect(state).toEqual({ count: 1, lockedUntilMs: null });
      expect((await attempt(PASSWORD)).ok).toBe(true);
    });
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
      verify: async () => ({
        ok: true,
        userId: USER,
        tenantId: TENANT,
        roles: { primaryRole: "erp_admin", secondaryRoles: [] },
        rehashTo: null,
      }),
      mint: () => minted,
      onSuccess: async () => undefined,
      admission: new LoginAdmission({ concurrency: 4, queue: 4, perAccount: 4, retryAfterSeconds: 1 }),
      audit: null,
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
      secondaryRoles: [],
    });
  });

  it("names the session's secondary roles beside the primary, so the body does not understate it", async () => {
    // `role` keeps its name and its meaning. Since ADR-0369 a session carries more than one role,
    // so a body naming only the primary would understate what it had just minted.
    const res = await interceptor({
      verify: async () => ({
        ok: true,
        userId: USER,
        tenantId: TENANT,
        roles: { primaryRole: "ap_clerk", secondaryRoles: ["hr_manager"] },
        rehashTo: null,
      }),
    })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    expect(parse(res!)).toMatchObject({ role: "ap_clerk", secondaryRoles: ["hr_manager"] });
  });

  it("reports the roles the TOKEN carries, not the row, where the two differ", async () => {
    // The one case they diverge, and it was live on the first pass: `sessionScope` de-duplicates
    // and the row does not, so echoing the row claimed a secondary role the token does not carry.
    // A field added so the body would not understate the session must not misstate it.
    const res = await interceptor({
      verify: async () => ({
        ok: true,
        userId: USER,
        tenantId: TENANT,
        roles: { primaryRole: "erp_admin", secondaryRoles: ["erp_admin", "hr_manager"] },
        rehashTo: null,
      }),
    })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    expect(parse(res!)).toMatchObject({ role: "erp_admin", secondaryRoles: ["hr_manager"] });
  });

  it("answers 503 and discloses nothing when the mint throws", async () => {
    // The channel, not just the one traveller through it. `ctx.verify` was wrapped and `ctx.mint`
    // was not, so a throw there escaped to the listener's generic catch, which puts `err.message`
    // in a 500 — the disclosure-plus-retryable-status pair this route exists not to have. Found by
    // review after the one reachable thrower had already been refused upstream.
    const res = await interceptor({
      mint: () => {
        throw new Error("a secret-shaped internal detail");
      },
    })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    expect(res?.status).toBe(503);
    const parsed = parse(res!);
    expect(JSON.stringify(parsed)).not.toContain("secret-shaped");
    expect(parsed["detail"]).toBe("The session token could not be minted. Retry shortly.");
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

  it("sheds past the cap BEFORE verifying, with a retryable status and Retry-After", async () => {
    // Pre-auth CPU exhaustion: 80 concurrent logins for unknown addresses took 2.17 s and an fs read
    // issued during them waited 2,095 ms for a libuv thread. A shed request does no password work.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const verify = vi.fn(async (): Promise<LoginOutcome> => {
      await gate;
      return { ok: false, refusal: "password_mismatch", userId: USER, detail: "" };
    });
    const shedSeen: string[] = [];
    const icpt = interceptor({
      verify,
      admission: new LoginAdmission({ concurrency: 1, queue: 1, perAccount: 2, retryAfterSeconds: 3 }),
      onShed: (r) => shedSeen.push(r),
    });
    const send = (email: string) =>
      icpt(req, body({ tenant: "acme", email, password: "x" }));
    const running = send("one@b.test");
    const queued = send("two@b.test");
    const shedRes = await send("three@b.test");
    expect(shedRes?.status).toBe(503);
    expect(shedRes?.headers["retry-after"]).toBe("3");
    expect(shedRes?.headers["cache-control"]).toBe("no-store");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(shedSeen).toEqual(["saturated"]);
    release();
    expect((await running)?.status).toBe(401);
    expect((await queued)?.status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("caps one email's requests in flight, folding case, whether or not the account exists", async () => {
    // Keyed on the normalised string the caller typed and decided before any lookup, so the 429 is
    // the same answer for an address that exists and one that does not.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const verify = vi.fn(async (): Promise<LoginOutcome> => {
      await gate;
      return { ok: false, refusal: "user_unknown", userId: null, detail: "" };
    });
    const icpt = interceptor({
      verify,
      admission: new LoginAdmission({ concurrency: 8, queue: 8, perAccount: 1, retryAfterSeconds: 1 }),
    });
    const first = icpt(req, body({ tenant: "acme", email: "Ann@Example.test", password: "x" }));
    const second = await icpt(req, body({ tenant: "acme", email: " ann@example.TEST ", password: "x" }));
    expect(second?.status).toBe(429);
    expect(second?.headers["retry-after"]).toBe("1");
    const other = icpt(req, body({ tenant: "acme", email: "bob@example.test", password: "x" }));
    release();
    expect((await first)?.status).toBe(401);
    expect((await other)?.status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("gives the slot back when verify throws", async () => {
    const admission = new LoginAdmission({ concurrency: 1, queue: 0, perAccount: 1, retryAfterSeconds: 1 });
    const icpt = interceptor({
      admission,
      verify: async () => {
        throw new Error("db down");
      },
    });
    expect((await icpt(req, body({ tenant: "acme", email: "a@b.test", password: "x" })))?.status).toBe(503);
    expect(admission.snapshot()).toEqual({ active: 0, queued: 0 });
    expect((await icpt(req, body({ tenant: "acme", email: "a@b.test", password: "x" })))?.status).toBe(503);
  });

  it("does not admit a malformed body at all", async () => {
    const admission = new LoginAdmission({ concurrency: 1, queue: 0, perAccount: 1, retryAfterSeconds: 1 });
    const enter = vi.spyOn(admission, "enter");
    expect((await interceptor({ admission })(req, body({ tenant: "acme" })))?.status).toBe(400);
    expect(enter).not.toHaveBeenCalled();
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

  it("records a success in the session's tenant BEFORE returning the token", async () => {
    const order: string[] = [];
    const succeeded = vi.fn(async () => {
      order.push("audit");
    });
    const res = await interceptor({
      audit: { succeeded, failed: vi.fn() },
      onSuccess: async () => {
        order.push("onSuccess");
      },
    })(req, body({ tenant: "acme", email: "a@b.test", password: "correct horse" }));
    expect(res?.status).toBe(200);
    expect(succeeded).toHaveBeenCalledWith({ userId: USER, tenantId: TENANT, roles: ["erp_admin"] });
    expect(order).toEqual(["audit", "onSuccess"]);
    expect(JSON.stringify(succeeded.mock.calls)).not.toContain("correct horse");
  });

  it("refuses the login with 503 and returns no token when the success cannot be recorded", async () => {
    const onSuccess = vi.fn(async () => undefined);
    const onError = vi.fn();
    const res = await interceptor({
      audit: {
        succeeded: async () => {
          throw new Error("audit_log unreachable");
        },
        failed: vi.fn(),
      },
      onSuccess,
      onError,
    })(req, body({ tenant: "acme", email: "a@b.test", password: "x" }));
    expect(res?.status).toBe(503);
    expect(JSON.stringify(parse(res as { body: Uint8Array | null }))).not.toContain(minted.token);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it("records a counted wrong password AFTER answering, and never makes the answer differ", async () => {
    const attempt = { tenantId: TENANT, failedAttempts: 3, lockedUntil: null };
    const failed = vi.fn(async () => undefined);
    const login = interceptor({
      verify: async () => ({
        ok: false,
        refusal: "password_mismatch",
        userId: USER,
        detail: "password did not match (3 consecutive)",
        countedAttempt: attempt,
      }),
      audit: { succeeded: vi.fn(), failed },
    });
    const res = await login(req, body({ tenant: "acme", email: "a@b.test", password: "nope" }));
    // Not yet: the record is scheduled behind the response so it cannot slow it.
    expect(failed).not.toHaveBeenCalled();
    expect(res?.status).toBe(401);
    await new Promise((r) => setImmediate(r));
    expect(failed).toHaveBeenCalledWith({ userId: USER, attempt });
    const unknown = await interceptor({
      verify: async () => ({ ok: false, refusal: "user_unknown", userId: null, detail: "no user" }),
    })(req, body({ tenant: "acme", email: "a@b.test", password: "nope" }));
    expect(new TextDecoder().decode(res?.body ?? new Uint8Array())).toBe(
      new TextDecoder().decode(unknown?.body ?? new Uint8Array()),
    );
  });

  it("records no refusal that compared no password, and reports a failed record without changing the 401", async () => {
    const failed = vi.fn(async () => undefined);
    for (const refusal of ["user_unknown", "account_locked", "tenant_unknown"] as const) {
      await interceptor({
        verify: async () => ({ ok: false, refusal, userId: refusal === "account_locked" ? USER : null, detail: "d" }),
        audit: { succeeded: vi.fn(), failed },
      })(req, body({ tenant: "acme", email: "a@b.test", password: "nope" }));
    }
    await new Promise((r) => setImmediate(r));
    expect(failed).not.toHaveBeenCalled();
    const onError = vi.fn();
    const res = await interceptor({
      verify: async () => ({
        ok: false,
        refusal: "password_mismatch",
        userId: USER,
        detail: "d",
        countedAttempt: { tenantId: TENANT, failedAttempts: 1, lockedUntil: null },
      }),
      audit: {
        succeeded: vi.fn(),
        failed: async () => {
          throw new Error("platform write refused");
        },
      },
      onError,
    })(req, body({ tenant: "acme", email: "a@b.test", password: "nope" }));
    expect(res?.status).toBe(401);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
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
});
