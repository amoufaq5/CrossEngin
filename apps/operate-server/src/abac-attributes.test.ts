import { principalAbacAttributes, type ResolvedPrincipal } from "@crossengin/api-gateway";
import type { PrincipalResolver, PrincipalResolverInput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  ACTIVE_MEMBERSHIP_STATUS,
  CachedAbacAttributeDirectory,
  DEFAULT_ABAC_ABSENCE_TTL_MS,
  DEFAULT_ABAC_MAX_STALE_MS,
  DEFAULT_ABAC_TTL_MS,
  PRINCIPAL_KIND_NAMES_A_PERSON,
  abacAttributeDirectoryFromStore,
  principalNamesAPerson,
  withAbacAttributes,
  type AbacAttributeDirectory,
  type MembershipAttributeReader,
  type PrincipalWithAbacAttributes,
} from "./abac-attributes.js";
import type { MembershipRecord } from "./platform-users.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "33333333-3333-4333-8333-333333333333";
const USER = "22222222-2222-4222-8222-222222222222";

type Membership = NonNullable<Awaited<ReturnType<MembershipAttributeReader["membershipFor"]>>>;

interface FakeReader extends MembershipAttributeReader {
  readonly calls: { readonly tenantId: string; readonly userId: string }[];
}

/**
 * A hand-written reader recording its calls. No `PgConnection` fake is needed, because this module
 * writes no SQL — `PostgresUserStore.membershipFor` is the one read and it already carries its own
 * `withTenantContext` and scope predicate.
 */
function fakeReader(
  rows: Readonly<Record<string, Membership | null>>,
  behaviour: { readonly throwOn?: (tenantId: string, userId: string) => unknown } = {},
): FakeReader {
  const calls: { tenantId: string; userId: string }[] = [];
  return {
    calls,
    async membershipFor(tenantId: string, userId: string): Promise<Membership | null> {
      calls.push({ tenantId, userId });
      const thrown = behaviour.throwOn?.(tenantId, userId);
      if (thrown !== undefined) throw thrown;
      return rows[`${tenantId}|${userId}`] ?? null;
    },
  };
}

function membership(
  status: string,
  abacAttributes: Readonly<Record<string, unknown>> = {},
): Membership {
  return { status, abacAttributes };
}

function principal(
  overrides: Partial<ResolvedPrincipal> = {},
): ResolvedPrincipal {
  return {
    principalId: USER,
    tenantId: TENANT_A,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: ["erp_admin"],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function resolverFor(value: ResolvedPrincipal | null): PrincipalResolver {
  return {
    async resolve(_input: PrincipalResolverInput): Promise<ResolvedPrincipal | null> {
      return value;
    },
  };
}

const RESOLVER_INPUT: PrincipalResolverInput = {
  tenantId: TENANT_A,
  principalRef: "k1",
  scopes: ["erp_admin"],
  authScheme: "api_key_header",
};

/** A clock the tests advance by hand — no real timers anywhere in this file. */
function fakeClock(startMs = 1_000_000): { now: () => Date; advance: (ms: number) => void } {
  let ms = startMs;
  return {
    now: () => new Date(ms),
    advance: (by: number) => {
      ms += by;
    },
  };
}

function directoryOf(
  answers: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>,
): AbacAttributeDirectory & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async attributesFor(tenantId: string, userId: string) {
      calls.push(`${tenantId}|${userId}`);
      return answers[`${tenantId}|${userId}`] ?? null;
    },
  };
}

describe("constants", () => {
  it("names the one membership status that grants access now", () => {
    expect(ACTIVE_MEMBERSHIP_STATUS).toBe("active");
  });

  it("defaults the resolved TTL to 30s", () => {
    expect(DEFAULT_ABAC_TTL_MS).toBe(30_000);
  });

  it("gives an absence a shorter TTL than a resolved record", () => {
    expect(DEFAULT_ABAC_ABSENCE_TTL_MS).toBe(5_000);
    expect(DEFAULT_ABAC_ABSENCE_TTL_MS).toBeLessThan(DEFAULT_ABAC_TTL_MS);
  });

  it("matches tenant-status-gate's stale bound, which is longer than either TTL", () => {
    expect(DEFAULT_ABAC_MAX_STALE_MS).toBe(300_000);
    expect(DEFAULT_ABAC_MAX_STALE_MS).toBeGreaterThan(DEFAULT_ABAC_TTL_MS);
  });

  it("names a person only for the `user` kind", () => {
    expect(PRINCIPAL_KIND_NAMES_A_PERSON).toEqual({
      user: true,
      service_account: false,
      ai_architect: false,
      system: false,
    });
  });

  it("reads the map through a predicate", () => {
    expect(principalNamesAPerson(principal())).toBe(true);
    expect(principalNamesAPerson(principal({ principalKind: "service_account" }))).toBe(false);
    expect(principalNamesAPerson(principal({ principalKind: "ai_architect" }))).toBe(false);
    expect(principalNamesAPerson(principal({ principalKind: "system" }))).toBe(false);
  });
});

describe("abacAttributeDirectoryFromStore", () => {
  it("supplies the attributes of an active membership", async () => {
    const reader = fakeReader({
      [`${TENANT_A}|${USER}`]: membership("active", { department: "oncology", level: 3 }),
    });
    const directory = abacAttributeDirectoryFromStore(reader);
    await expect(directory.attributesFor(TENANT_A, USER)).resolves.toEqual({
      department: "oncology",
      level: 3,
    });
  });

  it("passes a populated attribute record through unchanged", async () => {
    const attributes = { region: "eu", wards: ["a", "b"], nested: { k: 1 } };
    const reader = fakeReader({ [`${TENANT_A}|${USER}`]: membership("active", attributes) });
    const resolved = await abacAttributeDirectoryFromStore(reader).attributesFor(TENANT_A, USER);
    expect(resolved).toBe(attributes);
  });

  it("resolves an empty record as `{}` and not as null, because that is a real answer", async () => {
    const reader = fakeReader({ [`${TENANT_A}|${USER}`]: membership("active", {}) });
    await expect(
      abacAttributeDirectoryFromStore(reader).attributesFor(TENANT_A, USER),
    ).resolves.toEqual({});
  });

  it("resolves null for an `invited` membership", async () => {
    const reader = fakeReader({
      [`${TENANT_A}|${USER}`]: membership("invited", { department: "oncology" }),
    });
    await expect(
      abacAttributeDirectoryFromStore(reader).attributesFor(TENANT_A, USER),
    ).resolves.toBeNull();
  });

  it("resolves null for a `revoked` membership", async () => {
    const reader = fakeReader({
      [`${TENANT_A}|${USER}`]: membership("revoked", { department: "oncology" }),
    });
    await expect(
      abacAttributeDirectoryFromStore(reader).attributesFor(TENANT_A, USER),
    ).resolves.toBeNull();
  });

  it("resolves null for a status the CHECK does not declare", async () => {
    const reader = fakeReader({ [`${TENANT_A}|${USER}`]: membership("pending", { a: 1 }) });
    await expect(
      abacAttributeDirectoryFromStore(reader).attributesFor(TENANT_A, USER),
    ).resolves.toBeNull();
  });

  it("resolves null when there is no membership at all", async () => {
    const reader = fakeReader({});
    await expect(
      abacAttributeDirectoryFromStore(reader).attributesFor(TENANT_A, USER),
    ).resolves.toBeNull();
  });

  it("reads exactly one row per lookup, with both ids", async () => {
    const reader = fakeReader({ [`${TENANT_A}|${USER}`]: membership("active") });
    await abacAttributeDirectoryFromStore(reader).attributesFor(TENANT_A, USER);
    expect(reader.calls).toEqual([{ tenantId: TENANT_A, userId: USER }]);
  });

  it("propagates a reader failure rather than reporting an absence", async () => {
    const reader = fakeReader({}, { throwOn: () => new Error("42501") });
    await expect(
      abacAttributeDirectoryFromStore(reader).attributesFor(TENANT_A, USER),
    ).rejects.toThrow("42501");
  });

  it("accepts the real store's record shape", async () => {
    // `MembershipRecord` is what `PostgresUserStore.membershipFor` returns, so this pins that the
    // real store structurally satisfies `MembershipAttributeReader` — the point of the narrow
    // interface is that it needs no adapter.
    const record: MembershipRecord = {
      id: "44444444-4444-4444-8444-444444444444",
      userId: USER,
      tenantId: TENANT_A,
      primaryRole: "clinician",
      secondaryRoles: [],
      status: "active",
      abacAttributes: { department: "oncology" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const store: MembershipAttributeReader = {
      async membershipFor(): Promise<MembershipRecord | null> {
        return record;
      },
    };
    await expect(
      abacAttributeDirectoryFromStore(store).attributesFor(TENANT_A, USER),
    ).resolves.toEqual({ department: "oncology" });
  });
});

describe("CachedAbacAttributeDirectory", () => {
  it("serves a cache hit within the TTL from one read", async () => {
    const clock = fakeClock();
    const inner = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now });
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toEqual({ a: 1 });
    clock.advance(DEFAULT_ABAC_TTL_MS - 1);
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toEqual({ a: 1 });
    expect(inner.calls).toHaveLength(1);
  });

  it("re-reads once the TTL has elapsed", async () => {
    const clock = fakeClock();
    const inner = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now });
    await cached.attributesFor(TENANT_A, USER);
    clock.advance(DEFAULT_ABAC_TTL_MS);
    await cached.attributesFor(TENANT_A, USER);
    expect(inner.calls).toHaveLength(2);
  });

  it("gives an absence the shorter TTL, measured distinctly from ttlMs", async () => {
    const clock = fakeClock();
    const inner = directoryOf({});
    const cached = new CachedAbacAttributeDirectory(inner, {
      now: clock.now,
      ttlMs: 30_000,
      absenceTtlMs: 5_000,
    });
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toBeNull();
    clock.advance(4_999);
    await cached.attributesFor(TENANT_A, USER);
    expect(inner.calls).toHaveLength(1);
    // Past the absence TTL and well inside `ttlMs`: a resolved record would still be cached here.
    clock.advance(2);
    await cached.attributesFor(TENANT_A, USER);
    expect(inner.calls).toHaveLength(2);
  });

  it("keys on both ids, so one person in two tenants gets two answers and two reads", async () => {
    const clock = fakeClock();
    const inner = directoryOf({
      [`${TENANT_A}|${USER}`]: { ward: "a" },
      [`${TENANT_B}|${USER}`]: { ward: "b" },
    });
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now });
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toEqual({ ward: "a" });
    await expect(cached.attributesFor(TENANT_B, USER)).resolves.toEqual({ ward: "b" });
    expect(inner.calls).toEqual([`${TENANT_A}|${USER}`, `${TENANT_B}|${USER}`]);
  });

  it("does not let one pair of ids compose another pair's key", async () => {
    // Asserted through the cache rather than through a fixture map, because a fixture's own key is
    // not the cache's: the inner answer differs per call, so a collision would show up as the
    // second ask getting the first's value from one read.
    const clock = fakeClock();
    let nth = 0;
    const inner: AbacAttributeDirectory = {
      async attributesFor(): Promise<Readonly<Record<string, unknown>> | null> {
        nth += 1;
        return { nth };
      },
    };
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now });
    await expect(cached.attributesFor("a", "b")).resolves.toEqual({ nth: 1 });
    await expect(cached.attributesFor("a\u0000b", "")).resolves.toEqual({ nth: 2 });
    expect(nth).toBe(2);
  });

  it("propagates a first lookup that throws, with nothing ever known", async () => {
    const clock = fakeClock();
    const inner: AbacAttributeDirectory = {
      async attributesFor(): Promise<never> {
        throw new Error("connection refused");
      },
    };
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now });
    await expect(cached.attributesFor(TENANT_A, USER)).rejects.toThrow("connection refused");
  });

  it("serves the last known value when a refresh throws", async () => {
    const clock = fakeClock();
    let fail = false;
    const inner: AbacAttributeDirectory = {
      async attributesFor(): Promise<Readonly<Record<string, unknown>> | null> {
        if (fail) throw new Error("blip");
        return { a: 1 };
      },
    };
    const onRefreshError = vi.fn();
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now, onRefreshError });
    await cached.attributesFor(TENANT_A, USER);
    fail = true;
    clock.advance(DEFAULT_ABAC_TTL_MS + 1);
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toEqual({ a: 1 });
    expect(onRefreshError).toHaveBeenCalledWith(TENANT_A, USER, expect.any(Error), true);
  });

  it("propagates once the stale value is past maxStaleMs", async () => {
    const clock = fakeClock();
    let fail = false;
    const inner: AbacAttributeDirectory = {
      async attributesFor(): Promise<Readonly<Record<string, unknown>> | null> {
        if (fail) throw new Error("blip");
        return { a: 1 };
      },
    };
    const onRefreshError = vi.fn();
    const cached = new CachedAbacAttributeDirectory(inner, {
      now: clock.now,
      maxStaleMs: 100_000,
      onRefreshError,
    });
    await cached.attributesFor(TENANT_A, USER);
    fail = true;
    clock.advance(100_001);
    await expect(cached.attributesFor(TENANT_A, USER)).rejects.toThrow("blip");
    expect(onRefreshError).toHaveBeenCalledWith(TENANT_A, USER, expect.any(Error), false);
  });

  it("serves a stale absence through a blip too", async () => {
    const clock = fakeClock();
    let fail = false;
    const inner: AbacAttributeDirectory = {
      async attributesFor(): Promise<Readonly<Record<string, unknown>> | null> {
        if (fail) throw new Error("blip");
        return null;
      },
    };
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now });
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toBeNull();
    fail = true;
    clock.advance(DEFAULT_ABAC_ABSENCE_TTL_MS + 1);
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toBeNull();
  });

  it("shares one in-flight read between concurrent askers", async () => {
    const clock = fakeClock();
    // Held on an object rather than in a `let`: the assignment happens inside a callback tsc cannot
    // see, so a `let` narrows to `never` at the release below.
    const gate: { release: (() => void) | null } = { release: null };
    let reads = 0;
    const inner: AbacAttributeDirectory = {
      async attributesFor(): Promise<Readonly<Record<string, unknown>> | null> {
        reads += 1;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return { a: 1 };
      },
    };
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now });
    const first = cached.attributesFor(TENANT_A, USER);
    const second = cached.attributesFor(TENANT_A, USER);
    await Promise.resolve();
    gate.release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([{ a: 1 }, { a: 1 }]);
    expect(reads).toBe(1);
  });

  it("re-reads after clear()", async () => {
    const clock = fakeClock();
    const inner = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    const cached = new CachedAbacAttributeDirectory(inner, { now: clock.now });
    await cached.attributesFor(TENANT_A, USER);
    cached.clear();
    await cached.attributesFor(TENANT_A, USER);
    expect(inner.calls).toHaveLength(2);
  });

  it("uses the real clock when none is injected", async () => {
    const inner = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    const cached = new CachedAbacAttributeDirectory(inner);
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toEqual({ a: 1 });
    await expect(cached.attributesFor(TENANT_A, USER)).resolves.toEqual({ a: 1 });
    expect(inner.calls).toHaveLength(1);
  });
});

describe("withAbacAttributes", () => {
  it("attaches the resolved attributes to a user principal", async () => {
    const directory = directoryOf({ [`${TENANT_A}|${USER}`]: { department: "oncology" } });
    const resolved = await withAbacAttributes(resolverFor(principal()), directory).resolve(
      RESOLVER_INPUT,
    );
    expect(principalAbacAttributes(resolved)).toEqual({ department: "oncology" });
  });

  it("attaches a genuinely empty record, which is not the same as absent", async () => {
    const directory = directoryOf({ [`${TENANT_A}|${USER}`]: {} });
    const resolved = await withAbacAttributes(resolverFor(principal()), directory).resolve(
      RESOLVER_INPUT,
    );
    expect(principalAbacAttributes(resolved)).toEqual({});
  });

  it("leaves the field absent when no active membership resolves", async () => {
    const directory = directoryOf({});
    const resolved = await withAbacAttributes(resolverFor(principal()), directory).resolve(
      RESOLVER_INPUT,
    );
    expect(resolved).not.toBeNull();
    expect("abacAttributes" in (resolved as object)).toBe(false);
    expect(principalAbacAttributes(resolved)).toBeNull();
  });

  it("never looks a service_account up, because every bare api key shares one id", async () => {
    const directory = directoryOf({ [`${TENANT_A}|${USER}`]: { department: "oncology" } });
    const resolved = await withAbacAttributes(
      resolverFor(principal({ principalKind: "service_account" })),
      directory,
    ).resolve(RESOLVER_INPUT);
    expect(directory.calls).toEqual([]);
    expect(principalAbacAttributes(resolved)).toBeNull();
  });

  it("never looks an ai_architect or system principal up either", async () => {
    const directory = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    const decorated = withAbacAttributes(
      resolverFor(principal({ principalKind: "ai_architect" })),
      directory,
    );
    await decorated.resolve(RESOLVER_INPUT);
    const systemDirectory = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    await withAbacAttributes(
      resolverFor(principal({ principalKind: "system" })),
      systemDirectory,
    ).resolve(RESOLVER_INPUT);
    expect(directory.calls).toEqual([]);
    expect(systemDirectory.calls).toEqual([]);
  });

  it("never looks a principal with no tenant up", async () => {
    const directory = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    const resolved = await withAbacAttributes(
      resolverFor(principal({ tenantId: null })),
      directory,
    ).resolve(RESOLVER_INPUT);
    expect(directory.calls).toEqual([]);
    expect(principalAbacAttributes(resolved)).toBeNull();
  });

  it("returns null unchanged when the wrapped resolver resolves nothing", async () => {
    const directory = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    await expect(
      withAbacAttributes(resolverFor(null), directory).resolve(RESOLVER_INPUT),
    ).resolves.toBeNull();
    expect(directory.calls).toEqual([]);
  });

  it("propagates a directory failure rather than attaching nothing", async () => {
    const directory: AbacAttributeDirectory = {
      async attributesFor(): Promise<never> {
        throw new Error("42501");
      },
    };
    await expect(
      withAbacAttributes(resolverFor(principal()), directory).resolve(RESOLVER_INPUT),
    ).rejects.toThrow("42501");
  });

  it("does not mutate the principal the wrapped resolver handed out", async () => {
    const shared = principal();
    const directory = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    const decorated = withAbacAttributes(resolverFor(shared), directory);
    const first = await decorated.resolve(RESOLVER_INPUT);
    expect("abacAttributes" in (shared as object)).toBe(false);
    expect(first).not.toBe(shared);
    expect(principalAbacAttributes(shared)).toBeNull();
  });

  it("carries every other field of the principal through untouched", async () => {
    const directory = directoryOf({ [`${TENANT_A}|${USER}`]: { a: 1 } });
    const source = principal();
    const resolved = await withAbacAttributes(resolverFor(source), directory).resolve(
      RESOLVER_INPUT,
    );
    expect(resolved).toEqual({ ...source, abacAttributes: { a: 1 } });
  });

  it("looks the principal up by the principal's own ids, not the input's", async () => {
    const directory = directoryOf({ [`${TENANT_B}|${USER}`]: { ward: "b" } });
    const resolved = await withAbacAttributes(
      resolverFor(principal({ tenantId: TENANT_B })),
      directory,
    ).resolve(RESOLVER_INPUT);
    expect(directory.calls).toEqual([`${TENANT_B}|${USER}`]);
    expect(principalAbacAttributes(resolved)).toEqual({ ward: "b" });
  });

  it("composes over the store directory and its cache end to end", async () => {
    const clock = fakeClock();
    const reader = fakeReader({
      [`${TENANT_A}|${USER}`]: membership("active", { department: "oncology" }),
    });
    const directory = new CachedAbacAttributeDirectory(abacAttributeDirectoryFromStore(reader), {
      now: clock.now,
    });
    const decorated = withAbacAttributes(resolverFor(principal()), directory);
    await expect(decorated.resolve(RESOLVER_INPUT).then(principalAbacAttributes)).resolves.toEqual({
      department: "oncology",
    });
    await decorated.resolve(RESOLVER_INPUT);
    expect(reader.calls).toHaveLength(1);
  });
});

describe("principalAbacAttributes", () => {
  it("answers null for a null principal", () => {
    expect(principalAbacAttributes(null)).toBeNull();
  });

  it("answers null for an undecorated principal", () => {
    expect(principalAbacAttributes(principal())).toBeNull();
  });

  it("answers the carried record for a decorated one", () => {
    const decorated: PrincipalWithAbacAttributes = { ...principal(), abacAttributes: { a: 1 } };
    expect(principalAbacAttributes(decorated)).toEqual({ a: 1 });
  });

  it("answers `{}` rather than null for a carried empty record", () => {
    // The distinction the whole module exists to keep: `{}` is "we asked and there are none", which
    // an evaluator may answer from, while null is "nobody asked" and refuses the obligation.
    const decorated: PrincipalWithAbacAttributes = { ...principal(), abacAttributes: {} };
    expect(principalAbacAttributes(decorated)).toEqual({});
    expect(principalAbacAttributes(decorated)).not.toBeNull();
  });
});
