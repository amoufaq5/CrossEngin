import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_USER_IDENTITY_ABSENCE_TTL_MS,
  DEFAULT_USER_IDENTITY_TTL_MS,
  userIdentityFromStore,
  type UserIdentityReader,
} from "./user-identity.js";

const ADA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

interface Recorded {
  readonly userId: string;
  readonly servedStale: boolean;
}

function fakeClock(): { now: () => Date; advance: (ms: number) => void } {
  let ms = 1_700_000_000_000;
  return {
    now: (): Date => new Date(ms),
    advance: (by: number): void => {
      ms += by;
    },
  };
}

describe("userIdentityFromStore", () => {
  let reads: string[];
  let errors: Recorded[];

  beforeEach(() => {
    reads = [];
    errors = [];
  });

  function readerOf(
    answer: (id: string) => Promise<{ readonly displayName: string | null; readonly email: string } | null>,
  ): UserIdentityReader {
    return {
      getById: async (id) => {
        reads.push(id);
        return answer(id);
      },
    };
  }

  const record = (userId: string, _e: unknown, servedStale: boolean): void => {
    errors.push({ userId, servedStale });
  };

  it("resolves a row and reports the name and email", async () => {
    const resolve = userIdentityFromStore(
      readerOf(async () => ({ displayName: "Ada Lovelace", email: "ada@example.test" })),
      { onError: record },
    );
    expect(await resolve(ADA)).toEqual({ displayName: "Ada Lovelace", email: "ada@example.test" });
    expect(reads).toEqual([ADA]);
    expect(errors).toEqual([]);
  });

  it("serves a cached identity inside the TTL and re-reads past it", async () => {
    const clock = fakeClock();
    const resolve = userIdentityFromStore(
      readerOf(async () => ({ displayName: "Ada", email: "ada@example.test" })),
      { onError: record, now: clock.now },
    );
    await resolve(ADA);
    clock.advance(DEFAULT_USER_IDENTITY_TTL_MS - 1);
    await resolve(ADA);
    expect(reads).toHaveLength(1);
    clock.advance(2);
    await resolve(ADA);
    expect(reads).toHaveLength(2);
  });

  it("re-reads an ABSENT row sooner than a present one, because the two mistakes are not symmetric", async () => {
    // A stale name is cosmetic for a minute. A stale absence keeps a person anonymous to their own
    // console after an operator has just provisioned them — `CachedAbacAttributeDirectory`'s
    // reasoning, which this copies.
    const clock = fakeClock();
    const resolve = userIdentityFromStore(readerOf(async () => null), {
      onError: record,
      now: clock.now,
    });
    expect(await resolve(ADA)).toBeNull();
    clock.advance(DEFAULT_USER_IDENTITY_ABSENCE_TTL_MS - 1);
    await resolve(ADA);
    expect(reads).toHaveLength(1);
    clock.advance(2);
    await resolve(ADA);
    expect(reads).toHaveLength(2);
    // And the absence TTL really is the shorter of the two, so this test is not vacuous.
    expect(DEFAULT_USER_IDENTITY_ABSENCE_TTL_MS).toBeLessThan(DEFAULT_USER_IDENTITY_TTL_MS);
  });

  it("collapses concurrent cold reads for one person into a single query", async () => {
    // This resolver runs on `meta.schema.read`, which every console page fetches, so without the
    // collapse a cold cache costs one query per page load per person.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolve = userIdentityFromStore(
      readerOf(async () => {
        await gate;
        return { displayName: "Ada", email: "ada@example.test" };
      }),
      { onError: record },
    );
    const all = Promise.all([resolve(ADA), resolve(ADA), resolve(ADA), resolve(ADA)]);
    release?.();
    const answers = await all;
    expect(reads).toEqual([ADA]);
    expect(answers.every((a) => a?.email === "ada@example.test")).toBe(true);
  });

  it("does not collapse two different people, the key being the user id alone", async () => {
    // Keyed on the user id and not `(tenantId, userId)`: `meta.users` has no `tenant_id` column
    // and no RLS, so a person's name and email are the same fact in every tenant they hold a
    // membership in — sharing the ABAC directory's key would have meant N reads of one row.
    const resolve = userIdentityFromStore(
      readerOf(async (id) => ({ displayName: null, email: `${id}@example.test` })),
      { onError: record },
    );
    await Promise.all([resolve(ADA), resolve(BOB)]);
    expect([...reads].sort()).toEqual([ADA, BOB].sort());
  });

  it("never throws on a failed read, answers absent, and reports it as not-stale", async () => {
    // The one place this diverges from `CachedAbacAttributeDirectory`, whose first lookup
    // propagates because its answer feeds an authorization decision. This answer feeds a label,
    // and `meta.schema.read` is the route every console page loads first.
    const resolve = userIdentityFromStore(
      readerOf(async () => {
        throw new Error("connection refused");
      }),
      { onError: record },
    );
    await expect(resolve(ADA)).resolves.toBeNull();
    expect(errors).toEqual([{ userId: ADA, servedStale: false }]);
  });

  it("serves the last known answer when a refresh fails, and says it served stale", async () => {
    const clock = fakeClock();
    let fail = false;
    const resolve = userIdentityFromStore(
      readerOf(async () => {
        if (fail) throw new Error("connection refused");
        return { displayName: "Ada", email: "ada@example.test" };
      }),
      { onError: record, now: clock.now },
    );
    expect(await resolve(ADA)).toEqual({ displayName: "Ada", email: "ada@example.test" });
    fail = true;
    clock.advance(DEFAULT_USER_IDENTITY_TTL_MS + 1);
    expect(await resolve(ADA)).toEqual({ displayName: "Ada", email: "ada@example.test" });
    expect(errors).toEqual([{ userId: ADA, servedStale: true }]);
  });

  it("reports every failed refresh rather than once, because the failure mode is a silence", async () => {
    // ADR-0372's rule: a computed fact reaching nobody is this repository's most-found shape, so a
    // deployment whose identity reads are failing must not discover it by noticing that every page
    // says "Signed in as erp_admin" again.
    const clock = fakeClock();
    const resolve = userIdentityFromStore(
      readerOf(async () => {
        throw new Error("down");
      }),
      { onError: record, now: clock.now },
    );
    await resolve(ADA);
    clock.advance(DEFAULT_USER_IDENTITY_ABSENCE_TTL_MS + 1);
    await resolve(ADA);
    clock.advance(DEFAULT_USER_IDENTITY_ABSENCE_TTL_MS + 1);
    await resolve(ADA);
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.userId === ADA && !e.servedStale)).toBe(true);
  });

  it("does not remember a rejection, so a recovered database is picked up on the next call", async () => {
    let fail = true;
    const resolve = userIdentityFromStore(
      readerOf(async () => {
        if (fail) throw new Error("down");
        return { displayName: "Ada", email: "ada@example.test" };
      }),
      { onError: record },
    );
    expect(await resolve(ADA)).toBeNull();
    fail = false;
    // No clock advance: the failed read wrote no entry, so there is nothing to wait out.
    expect(await resolve(ADA)).toEqual({ displayName: "Ada", email: "ada@example.test" });
    expect(reads).toHaveLength(2);
  });

  it("honours overridden TTLs", async () => {
    const clock = fakeClock();
    const resolve = userIdentityFromStore(
      readerOf(async () => ({ displayName: "Ada", email: "ada@example.test" })),
      { onError: record, now: clock.now, ttlMs: 10, absenceTtlMs: 1 },
    );
    await resolve(ADA);
    clock.advance(9);
    await resolve(ADA);
    expect(reads).toHaveLength(1);
    clock.advance(2);
    await resolve(ADA);
    expect(reads).toHaveLength(2);
  });
  describe("evict", () => {
    it("drops a cached identity so the next call reads the row again", async () => {
      let name = "Ada";
      const resolve = userIdentityFromStore(
        readerOf(async () => ({ displayName: name, email: "ada@example.test" })),
        { onError: record },
      );
      expect((await resolve(ADA))?.displayName).toBe("Ada");
      name = "Ada Lovelace";
      // Without the eviction the old name is served for the whole TTL.
      expect((await resolve(ADA))?.displayName).toBe("Ada");
      resolve.evict(ADA);
      expect((await resolve(ADA))?.displayName).toBe("Ada Lovelace");
      expect(reads).toEqual([ADA, ADA]);
    });

    it("drops a cached absence, which is the provisioning case", async () => {
      let provisioned = false;
      const resolve = userIdentityFromStore(
        readerOf(async () => (provisioned ? { displayName: null, email: "bob@example.test" } : null)),
        { onError: record },
      );
      expect(await resolve(BOB)).toBeNull();
      provisioned = true;
      resolve.evict(BOB);
      expect(await resolve(BOB)).toEqual({ displayName: null, email: "bob@example.test" });
    });

    it("touches only the person evicted", async () => {
      const resolve = userIdentityFromStore(
        readerOf(async (id) => ({ displayName: id, email: `${id}@example.test` })),
        { onError: record },
      );
      await resolve(ADA);
      await resolve(BOB);
      resolve.evict(ADA);
      await resolve(ADA);
      await resolve(BOB);
      expect(reads).toEqual([ADA, BOB, ADA]);
    });

    it("does not let a read that began before the eviction repopulate the entry", async () => {
      let release: (() => void) | undefined;
      let name = "before";
      const resolve = userIdentityFromStore(
        {
          getById: async (id) => {
            reads.push(id);
            const seen = name;
            if (reads.length === 1) await new Promise<void>((r) => (release = r));
            return { displayName: seen, email: "ada@example.test" };
          },
        },
        { onError: record },
      );
      const racing = resolve(ADA);
      // The write lands and evicts while the first read is still in flight.
      name = "after";
      resolve.evict(ADA);
      const fresh = await resolve(ADA);
      expect(fresh?.displayName).toBe("after");
      release?.();
      expect((await racing)?.displayName).toBe("before");
      // The racing read's pre-write answer was not stored over the fresh one.
      expect((await resolve(ADA))?.displayName).toBe("after");
      expect(reads).toEqual([ADA, ADA]);
    });

    it("keeps the post-eviction read's in-flight slot when the pre-eviction read settles", async () => {
      // The pre-eviction read settling must not delete the slot a newer read holds, or a third
      // caller starts a second concurrent read instead of joining the one already in flight.
      const gates: (() => void)[] = [];
      const resolve = userIdentityFromStore(
        {
          getById: async (id) => {
            reads.push(id);
            await new Promise<void>((r) => gates.push(r));
            return { displayName: "Ada", email: "ada@example.test" };
          },
        },
        { onError: record },
      );
      const first = resolve(ADA);
      await Promise.resolve();
      resolve.evict(ADA);
      const second = resolve(ADA);
      await Promise.resolve();
      gates[0]?.();
      await first;
      const third = resolve(ADA);
      await Promise.resolve();
      // Every gate opened, so a regression reads a third time rather than hanging.
      for (const open of gates) open();
      await Promise.all([second, third]);
      expect(reads).toEqual([ADA, ADA]);
    });

    it("does not serve the pre-eviction entry stale when a read in flight at the eviction fails", async () => {
      let fail = false;
      let release: (() => void) | undefined;
      const clock = fakeClock();
      const resolve = userIdentityFromStore(
        {
          getById: async (id) => {
            reads.push(id);
            if (!fail) return { displayName: "Ada", email: "ada@example.test" };
            await new Promise<void>((r) => (release = r));
            throw new Error("down");
          },
        },
        { onError: record, now: clock.now, ttlMs: 1_000 },
      );
      await resolve(ADA);
      // The entry has lapsed, so the next read carries it as the stale fallback.
      clock.advance(1_001);
      fail = true;
      const racing = resolve(ADA);
      await Promise.resolve();
      resolve.evict(ADA);
      release?.();
      expect(await racing).toBeNull();
      expect(errors).toEqual([{ userId: ADA, servedStale: false }]);
    });

    it("does not serve the pre-eviction answer stale when the next read fails", async () => {
      let fail = false;
      const resolve = userIdentityFromStore(
        readerOf(async () => {
          if (fail) throw new Error("down");
          return { displayName: "Ada", email: "ada@example.test" };
        }),
        { onError: record },
      );
      await resolve(ADA);
      fail = true;
      resolve.evict(ADA);
      expect(await resolve(ADA)).toBeNull();
      expect(errors).toEqual([{ userId: ADA, servedStale: false }]);
    });
  });
});
